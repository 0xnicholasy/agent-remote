import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { DeviceRegistry, type DeviceRecord } from "./devices";
import { NonceCache, signingString, signRequest, verifyEnvelope, type VerifyEnvelopeParams } from "./verify";

const DEVICE_KEY = Buffer.from("bb".repeat(32), "hex");
const SKEW_MS = 120_000;

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

  test("evicts the oldest entry once a device hits the 10,000 cap", () => {
    const cache = new NonceCache();
    const now = new Date();
    for (let i = 0; i < 10_000; i++) {
      cache.record("dev_1", `n${i}`, now);
    }
    expect(cache.has("dev_1", "n0", now)).toBe(true);
    cache.record("dev_1", "n10000", now);
    expect(cache.has("dev_1", "n0", now)).toBe(false);
    expect(cache.has("dev_1", "n10000", now)).toBe(true);
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
