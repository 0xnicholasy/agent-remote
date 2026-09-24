import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { JsonlJournal } from "../state/journal";
import { createNonceJournal } from "../state/nonces";
import { DeviceRegistry, type DeviceRecord } from "./devices";
import {
  NonceCache,
  signingString,
  signRequest,
  verifyEnvelope,
  type NonceJournalRecord,
  type VerifyEnvelopeParams,
} from "./verify";

const DEVICE_KEY = Buffer.from("bb".repeat(32), "hex");
const SKEW_MS = 120_000;
const NONCE_TTL_MS = 300_000; // mirrors auth/verify.ts's TTL, which is not exported

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agentremote-verify-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function sampleRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: "dev_9f2c4a1b7d3e5061",
    deviceName: "Ting's Apple Watch",
    keyId: "key_deadbeef",
    deviceKeyHex: DEVICE_KEY.toString("hex"),
    pairedAt: "2026-09-20T10:15:00.000Z",
    allowedProjects: ["prj_demo"],
    allowedActions: ["prompt.send"],
    revokedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

function baseParams(overrides: Partial<VerifyEnvelopeParams> = {}): VerifyEnvelopeParams {
  const registry = new DeviceRegistry();
  registry.register(sampleRecord());
  const now = new Date("2026-09-20T10:15:00.000Z");

  const headers: Record<string, string> = {
    "X-AgentRemote-Device": "dev_9f2c4a1b7d3e5061",
    "X-AgentRemote-Timestamp": now.toISOString(),
    "X-AgentRemote-Nonce": "n0nce",
    "X-AgentRemote-Signature": signRequest(DEVICE_KEY, {
      method: "GET",
      pathWithQuery: "/v1/events?after=0",
      timestamp: now.toISOString(),
      nonce: "n0nce",
      bodySha256: createHash("sha256").update("").digest("hex"),
    }),
  };

  return {
    headers,
    method: "GET",
    pathWithQuery: "/v1/events?after=0",
    rawBody: "",
    registry,
    nonces: new NonceCache(),
    now,
    skewMs: SKEW_MS,
    ...overrides,
  };
}

describe("signingString", () => {
  test("is the exact six-line string with no trailing newline", () => {
    const result = signingString({
      method: "post",
      pathWithQuery: "/v1/events?after=3&wait=25",
      timestamp: "2026-09-20T10:15:00.000Z",
      nonce: "abc123",
      bodySha256: "deadbeef",
    });
    expect(result).toBe(
      "v1\nPOST\n/v1/events?after=3&wait=25\n2026-09-20T10:15:00.000Z\nabc123\ndeadbeef",
    );
  });
});

describe("signRequest", () => {
  test("matches an independently computed HMAC", () => {
    const parts = {
      method: "GET",
      pathWithQuery: "/v1/health",
      timestamp: "2026-09-20T10:15:00.000Z",
      nonce: "abc123",
      bodySha256: createHash("sha256").update("").digest("hex"),
    };
    const expected =
      "v1=" +
      createHmac("sha256", DEVICE_KEY).update(signingString(parts), "utf8").digest("hex");
    expect(signRequest(DEVICE_KEY, parts)).toBe(expected);
  });
});

describe("NonceCache", () => {
  test("has() is false until record()", () => {
    const cache = new NonceCache();
    const now = new Date();
    expect(cache.has("dev_1", "n1", now)).toBe(false);
    cache.record("dev_1", "n1", now);
    expect(cache.has("dev_1", "n1", now)).toBe(true);
  });

  test("a full device is refused instead of evicting a nonce that is still valid", () => {
    const cache = new NonceCache();
    const now = new Date();
    for (let i = 0; i < 10_000; i++) {
      expect(cache.record("dev_1", `n${i}`, now)).toBe(true);
    }
    // Evicting n0 here would let its captured envelope replay inside its validity window.
    expect(cache.record("dev_1", "n10000", now)).toBe(false);
    expect(cache.has("dev_1", "n0", now)).toBe(true);
    expect(cache.has("dev_1", "n10000", now)).toBe(false);
    // Another device has its own budget.
    expect(cache.record("dev_2", "n0", now)).toBe(true);
    // Room comes back only as entries actually expire.
    expect(cache.record("dev_1", "n10000", new Date(now.getTime() + 300_000))).toBe(true);
  });

  test("a clock that moves backwards cannot make a pruned nonce's timestamp fresh again", () => {
    const cache = new NonceCache();
    const recordedAt = new Date("2026-09-20T10:15:00.000Z");
    cache.record("dev_1", "n1", recordedAt);

    // The host clock jumps forward past the TTL, a new request prunes n1, then the clock is set
    // back to where n1 was recorded.
    const jumpedAhead = new Date(recordedAt.getTime() + 600_000);
    cache.record("dev_1", "n2", jumpedAhead);
    expect(cache.referenceTime(recordedAt)).toBe(jumpedAhead.getTime());
    expect(cache.has("dev_1", "n2", recordedAt)).toBe(true);
  });

  // NONCE_TTL_MS is 300_000 (5 minutes). The accepted timestamp-skew window used in production
  // (SKEW_MS, 120_000 = 2 minutes) is narrower than the nonce TTL, so a nonce cannot become
  // reusable within any pair of timestamps `verifyEnvelope` would both accept: the oldest and
  // newest accepted timestamps are at most 2 * SKEW_MS = 240_000ms apart, which is still inside
  // the 300_000ms TTL. If the TTL were ever shortened below 2 * SKEW_MS, this relationship — and
  // this test's premise that expiry-then-reuse is safe rather than a replay hole — would break.
  test("has() reports a nonce as reusable once its 300s TTL has elapsed, and record() prunes it", () => {
    const cache = new NonceCache();
    const recordedAt = new Date("2026-09-20T10:15:00.000Z");
    cache.record("dev_1", "n1", recordedAt);

    const atExpiry = new Date(recordedAt.getTime() + 300_000);
    expect(cache.has("dev_1", "n1", atExpiry)).toBe(false);

    // record() is the only place pruning happens (has() only reads); driving a second record()
    // call at the TTL boundary exercises the actual eviction path, not just the boundary
    // arithmetic in has(). "n1" must actually be gone from the underlying map afterward, not
    // merely reported as expired.
    cache.record("dev_1", "n2", atExpiry);

    // Re-using "n1" at/after its TTL elapsed must succeed exactly like a first-time nonce: this
    // is the by-design "expiry, not permanent memory" behavior documented on the class, safe
    // only because SKEW_MS < NONCE_TTL_MS as explained above.
    cache.record("dev_1", "n1", atExpiry);
    expect(cache.has("dev_1", "n1", atExpiry)).toBe(true);
  });

  test("a journal holding more than the per-device cap loads to exactly the cap, and the drop is persisted", () => {
    const filePath = join(stateDir, "nonces.jsonl");
    const CAP = 10_000;
    const now = new Date("2026-09-20T10:15:00.000Z");

    // Bypass record()'s own cap check by writing the raw journal directly, as if it had
    // accumulated one entry over the cap some other way (e.g. an old build without the check).
    const rawJournal = new JsonlJournal<NonceJournalRecord>(filePath);
    for (let index = 0; index <= CAP; index += 1) {
      rawJournal.append({ deviceId: "dev_a", nonce: `nonce-${index}`, expiresAt: now.getTime() + NONCE_TTL_MS });
    }

    const cache = new NonceCache({ journal: createNonceJournal(filePath), now });
    expect(cache.has("dev_a", "nonce-0", now)).toBe(true);
    // Insertion order == expiry order, so the kept set is the oldest CAP entries; the (CAP+1)th
    // (the one over budget) is the one dropped.
    expect(cache.has("dev_a", `nonce-${CAP}`, now)).toBe(false);

    // The drop must be persisted, not just held in memory: a reload sees the same capped set,
    // which only holds if the constructor rewrote the journal.
    const reloaded = new NonceCache({ journal: createNonceJournal(filePath), now });
    expect(reloaded.has("dev_a", "nonce-0", now)).toBe(true);
    expect(reloaded.has("dev_a", `nonce-${CAP - 1}`, now)).toBe(true);
    expect(reloaded.has("dev_a", `nonce-${CAP}`, now)).toBe(false);
  });
});

describe("verifyEnvelope", () => {
  test("accepts a correctly signed request", () => {
    const result = verifyEnvelope(baseParams());
    expect(result.ok).toBe(true);
  });

  test("headers are read case-insensitively", () => {
    const params = baseParams();
    const lower: Record<string, string> = {};
    for (const [key, value] of Object.entries(params.headers as Record<string, string>)) {
      lower[key.toLowerCase()] = value;
    }
    const result = verifyEnvelope({ ...params, headers: lower });
    expect(result.ok).toBe(true);
  });

  test("missing header -> unauthenticated", () => {
    const params = baseParams();
    const headers = { ...(params.headers as Record<string, string>) };
    delete headers["X-AgentRemote-Nonce"];
    const result = verifyEnvelope({ ...params, headers });
    expect(result).toEqual({ ok: false, status: 401, code: "unauthenticated" });
  });

  test("unknown device -> unauthenticated", () => {
    const params = baseParams();
    const headers = { ...(params.headers as Record<string, string>), "X-AgentRemote-Device": "dev_unknown" };
    const result = verifyEnvelope({ ...params, headers });
    expect(result).toEqual({ ok: false, status: 401, code: "unauthenticated" });
  });

  test("revoked device -> device_revoked, even with a bad signature", () => {
    const registry = new DeviceRegistry();
    registry.register(sampleRecord({ revokedAt: "2026-09-20T09:00:00.000Z" }));
    const now = new Date("2026-09-20T10:15:00.000Z");
    const headers: Record<string, string> = {
      "X-AgentRemote-Device": "dev_9f2c4a1b7d3e5061",
      "X-AgentRemote-Timestamp": now.toISOString(),
      "X-AgentRemote-Nonce": "n0nce",
      "X-AgentRemote-Signature": "v1=" + "0".repeat(64),
    };
    const result = verifyEnvelope({
      headers,
      method: "GET",
      pathWithQuery: "/v1/events?after=0",
      rawBody: "",
      registry,
      nonces: new NonceCache(),
      now,
      skewMs: SKEW_MS,
    });
    expect(result).toEqual({ ok: false, status: 403, code: "device_revoked" });
  });

  test("stale timestamp -> stale_request, even with a replayed nonce", () => {
    const params = baseParams();
    const nonces = new NonceCache();
    nonces.record("dev_9f2c4a1b7d3e5061", "n0nce", params.now);

    const staleTimestamp = new Date(params.now.getTime() - SKEW_MS - 1).toISOString();
    const headers = {
      ...(params.headers as Record<string, string>),
      "X-AgentRemote-Timestamp": staleTimestamp,
    };
    const result = verifyEnvelope({ ...params, headers, nonces });
    expect(result).toEqual({ ok: false, status: 401, code: "stale_request" });
  });

  test("replayed nonce -> replayed_request", () => {
    const params = baseParams();
    params.nonces.record("dev_9f2c4a1b7d3e5061", "n0nce", params.now);
    const result = verifyEnvelope(params);
    expect(result).toEqual({ ok: false, status: 401, code: "replayed_request" });
  });

  test("an envelope replayed after the host clock jumps ahead and back is refused", () => {
    const params = baseParams();
    expect(verifyEnvelope(params).ok).toBe(true);

    // A later request while the clock is 10 minutes ahead prunes the first envelope's nonce.
    const ahead = new Date(params.now.getTime() + 600_000);
    const laterNonce = "n0nce-later";
    const laterHeaders = {
      "X-AgentRemote-Device": "dev_9f2c4a1b7d3e5061",
      "X-AgentRemote-Timestamp": ahead.toISOString(),
      "X-AgentRemote-Nonce": laterNonce,
      "X-AgentRemote-Signature": signRequest(DEVICE_KEY, {
        method: "GET",
        pathWithQuery: "/v1/events?after=0",
        timestamp: ahead.toISOString(),
        nonce: laterNonce,
        bodySha256: createHash("sha256").update("").digest("hex"),
      }),
    };
    expect(verifyEnvelope({ ...params, headers: laterHeaders, now: ahead }).ok).toBe(true);
    expect(params.nonces.has("dev_9f2c4a1b7d3e5061", "n0nce", ahead)).toBe(false);

    // The clock is corrected back; the captured first envelope is inside skew of raw `now` again.
    expect(verifyEnvelope(params)).toEqual({ ok: false, status: 401, code: "stale_request" });
  });

  test("a device whose nonce set is full -> 429 rate_limited, and nothing is evicted", () => {
    const params = baseParams();
    for (let i = 0; i < 10_000; i++) {
      params.nonces.record("dev_9f2c4a1b7d3e5061", `filler-${i}`, params.now);
    }
    expect(verifyEnvelope(params)).toEqual({ ok: false, status: 429, code: "rate_limited" });
    expect(params.nonces.has("dev_9f2c4a1b7d3e5061", "filler-0", params.now)).toBe(true);
  });

  test("bad signature -> unauthenticated", () => {
    const params = baseParams();
    const headers = {
      ...(params.headers as Record<string, string>),
      "X-AgentRemote-Signature": "v1=" + "0".repeat(64),
    };
    const result = verifyEnvelope({ ...params, headers });
    expect(result).toEqual({ ok: false, status: 401, code: "unauthenticated" });
  });

  test("a signature captured for one (method, path) is rejected for a different method or path", () => {
    const params = baseParams();

    const differentMethod = verifyEnvelope({ ...params, method: "POST" });
    expect(differentMethod).toEqual({ ok: false, status: 401, code: "unauthenticated" });

    const differentPath = verifyEnvelope({ ...params, pathWithQuery: "/v1/sessions" });
    expect(differentPath).toEqual({ ok: false, status: 401, code: "unauthenticated" });
  });

  test("a nonce is NOT recorded when the signature is bad", () => {
    const params = baseParams();
    const headers = {
      ...(params.headers as Record<string, string>),
      "X-AgentRemote-Signature": "v1=" + "0".repeat(64),
    };
    verifyEnvelope({ ...params, headers });
    expect(params.nonces.has("dev_9f2c4a1b7d3e5061", "n0nce", params.now)).toBe(false);
  });
});
