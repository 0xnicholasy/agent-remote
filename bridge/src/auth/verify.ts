import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { DeviceRecord, DeviceRegistry } from "./devices";

const NONCE_TTL_MS = 300_000;
const MAX_NONCES_PER_DEVICE = 10_000;

export interface SigningParts {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

/** The six-line signing string from the "Signed request envelope" section, no trailing newline. */
export function signingString(parts: SigningParts): string {
  return ["v1", parts.method.toUpperCase(), parts.pathWithQuery, parts.timestamp, parts.nonce, parts.bodySha256].join(
    "\n",
  );
}

/** `"v1=" + HMAC(deviceKey, signingString)`, hex-encoded. */
export function signRequest(deviceKey: Buffer, parts: SigningParts): string {
  const mac = createHmac("sha256", deviceKey).update(signingString(parts), "utf8").digest("hex");
  return `v1=${mac}`;
}

function bodyDigest(rawBody: string | Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Accepts a real `Headers` object or a plain record, matched case-insensitively either way. */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/** One persisted nonce. `expiresAt` is epoch milliseconds. */
export interface NonceRecord {
  deviceId: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Storage a `NonceCache` writes through to so replay protection survives a bridge restart.
 * Deliberately an interface rather than a file path: this module stays free of `node:fs`, and
 * the bridge supplies the JSON Lines implementation from `src/state/nonces.ts`.
 */
export interface NonceJournal {
  load(): NonceRecord[];
  append(record: NonceRecord): void;
  rewrite(records: readonly NonceRecord[]): void;
}

/** Appends since the last compaction that trigger a rewrite of the journal file. */
const COMPACT_AFTER_APPENDS = 1_000;

/**
 * Per-device nonce set with a 300s TTL and a 10,000-entry cap per device, oldest dropped first.
 * A `Map`'s keys iterate in insertion order, and since every entry's TTL is the same fixed
 * duration, insertion order and expiry order coincide as long as `now` does not go backwards.
 *
 * With a `NonceJournal` the same set is written through to disk and rehydrated on construction,
 * so a request replayed across a bridge restart is still refused. Entries already expired at
 * load time are dropped and never rehydrated.
 */
export class NonceCache {
  private readonly perDevice = new Map<string, Map<string, number>>();
  private readonly journal: NonceJournal | undefined;
  private appendsSinceCompaction = 0;

  constructor(options: { journal?: NonceJournal; now?: Date } = {}) {
    this.journal = options.journal;
    if (this.journal === undefined) {
      return;
    }

    const nowMs = (options.now ?? new Date()).getTime();
    // `load` throws on a filesystem failure (see JsonlJournal). Let it propagate rather than
    // treating an unreadable journal as an empty one: the latter would silently accept every
    // nonce this device has ever used, defeating replay protection after a restart.
    const persistedRecords = this.journal.load();
    let dropped = false;
    for (const record of persistedRecords) {
      if (typeof record?.deviceId !== "string" || typeof record.nonce !== "string" || typeof record.expiresAt !== "number") {
        dropped = true;
        continue;
      }
      if (record.expiresAt <= nowMs) {
        dropped = true;
        continue;
      }
      let nonces = this.perDevice.get(record.deviceId);
      if (nonces === undefined) {
        nonces = new Map<string, number>();
        this.perDevice.set(record.deviceId, nonces);
      }
      nonces.set(record.nonce, record.expiresAt);
    }
    for (const nonces of this.perDevice.values()) {
      if (this.evictOverflow(nonces)) {
        dropped = true;
      }
    }
    if (dropped) {
      this.compact();
    }
  }

  has(deviceId: string, nonce: string, now: Date): boolean {
    const nonces = this.perDevice.get(deviceId);
    if (nonces === undefined) {
      return false;
    }
    const expiresAt = nonces.get(nonce);
    return expiresAt !== undefined && expiresAt > now.getTime();
  }

  record(deviceId: string, nonce: string, now: Date): void {
    let nonces = this.perDevice.get(deviceId);
    if (nonces === undefined) {
      nonces = new Map<string, number>();
      this.perDevice.set(deviceId, nonces);
    }

    this.pruneExpired(nonces, now);
    const expiresAt = now.getTime() + NONCE_TTL_MS;
    nonces.set(nonce, expiresAt);
    this.evictOverflow(nonces);

    if (this.journal === undefined) {
      return;
    }
    // `append` throws on a filesystem failure (see JsonlJournal). Let it propagate out of
    // `record` and in turn out of `verifyEnvelope`: a nonce that is not durably recorded must
    // not be treated as a successfully verified request, or the same envelope replays cleanly
    // across a bridge restart.
    this.journal.append({ deviceId, nonce, expiresAt });
    this.appendsSinceCompaction += 1;
    if (this.appendsSinceCompaction >= COMPACT_AFTER_APPENDS) {
      this.compact();
    }
  }

  private pruneExpired(nonces: Map<string, number>, now: Date): void {
    for (const [key, expiresAt] of nonces) {
      if (expiresAt > now.getTime()) {
        break; // insertion order == expiry order (see class comment)
      }
      nonces.delete(key);
    }
  }

  /**
   * Evicts oldest-first while over the per-device cap. Shared by `record` (evicts at most one,
   * since insertion happens one nonce at a time) and the constructor's rehydrate path (may evict
   * many at once), so the cap and its ordering can never drift between the live and reload paths.
   * Returns whether anything was evicted.
   */
  private evictOverflow(nonces: Map<string, number>): boolean {
    let evicted = false;
    while (nonces.size > MAX_NONCES_PER_DEVICE) {
      const oldest = nonces.keys().next();
      if (oldest.done) {
        break;
      }
      nonces.delete(oldest.value);
      evicted = true;
    }
    return evicted;
  }

  /** Rewrites the journal to exactly the live set, dropping expired and evicted entries. */
  private compact(): void {
    if (this.journal === undefined) {
      return;
    }
    const records: NonceRecord[] = [];
    for (const [deviceId, nonces] of this.perDevice) {
      for (const [nonce, expiresAt] of nonces) {
        records.push({ deviceId, nonce, expiresAt });
      }
    }
    // Unlike `append`, a failed compaction is tolerated: every entry in `records` was already
    // durably appended one at a time, so the journal on disk is still a correct (just uncompacted)
    // superset of the live set. Log and retry at the next compaction threshold instead of failing
    // the request that happened to trigger this compaction.
    try {
      this.journal.rewrite(records);
      this.appendsSinceCompaction = 0;
    } catch (error) {
      console.error("Agent Remote bridge: failed to compact nonce journal, will retry later", error);
    }
  }
}

export type VerifyRejectionCode = "unauthenticated" | "device_revoked" | "stale_request" | "replayed_request";

export type VerifyEnvelopeResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; status: 401 | 403; code: VerifyRejectionCode };

export interface VerifyEnvelopeParams {
  headers: HeaderSource;
  method: string;
  pathWithQuery: string;
  rawBody: string | Uint8Array;
  registry: DeviceRegistry;
  nonces: NonceCache;
  now: Date;
  skewMs: number;
}

/**
 * Runs the "Verification order" checks from docs/pairing-v0.md, rejecting on the first failure.
 * The nonce is only recorded once the signature verifies (checked last), so an unsigned flood of
 * distinct nonces cannot evict genuine entries from the cache.
 */
export function verifyEnvelope(params: VerifyEnvelopeParams): VerifyEnvelopeResult {
  const deviceId = readHeader(params.headers, "X-AgentRemote-Device");
  const timestamp = readHeader(params.headers, "X-AgentRemote-Timestamp");
  const nonce = readHeader(params.headers, "X-AgentRemote-Nonce");
  const signature = readHeader(params.headers, "X-AgentRemote-Signature");

  // 1. All four headers present and well formed.
  if (
    deviceId === undefined ||
    deviceId.length === 0 ||
    timestamp === undefined ||
    timestamp.length === 0 ||
    nonce === undefined ||
    nonce.length === 0 ||
    signature === undefined ||
    !signature.startsWith("v1=")
  ) {
    return { ok: false, status: 401, code: "unauthenticated" };
  }

  // 2. Device known.
  const device = params.registry.get(deviceId);
  if (device === undefined) {
    return { ok: false, status: 401, code: "unauthenticated" };
  }

  // 3. Device not revoked.
  if (device.revokedAt !== null) {
    return { ok: false, status: 403, code: "device_revoked" };
  }

  // 4. Timestamp parses and is within skew of the bridge clock.
  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(timestampMs) || Math.abs(params.now.getTime() - timestampMs) > params.skewMs) {
    return { ok: false, status: 401, code: "stale_request" };
  }

  // 5. Nonce not seen before from this device.
  if (params.nonces.has(deviceId, nonce, params.now)) {
    return { ok: false, status: 401, code: "replayed_request" };
  }

  // 6. Signature matches, compared in constant time.
  const deviceKey = Buffer.from(device.deviceKeyHex, "hex");
  const expected = signRequest(deviceKey, {
    method: params.method,
    pathWithQuery: params.pathWithQuery,
    timestamp,
    nonce,
    bodySha256: bodyDigest(params.rawBody),
  });
  if (!constantTimeEqual(expected, signature)) {
    return { ok: false, status: 401, code: "unauthenticated" };
  }

  params.nonces.record(deviceId, nonce, params.now);
  return { ok: true, device };
}
