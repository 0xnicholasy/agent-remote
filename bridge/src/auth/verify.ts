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
 * The latest bridge time the cache has ever acted on, persisted so it survives compaction and a
 * restart. Written as the first line of every compaction; a nonce record carries its own lower
 * bound (`expiresAt - NONCE_TTL_MS`), so appends never need to write one. If the host clock was
 * far ahead and then corrected, requests are refused as stale until real time reaches the
 * watermark; recovery is to stop the bridge and delete `nonces.jsonl`.
 */
export interface NonceWatermarkRecord {
  watermarkMs: number;
}

/** One line of `nonces.jsonl`: a spent nonce, or the watermark a compaction leaves behind. */
export type NonceJournalRecord = NonceRecord | NonceWatermarkRecord;

/**
 * Storage a `NonceCache` writes through to so replay protection survives a bridge restart.
 * Deliberately an interface rather than a file path: this module stays free of `node:fs`, and
 * the bridge supplies the JSON Lines implementation from `src/state/nonces.ts`.
 */
export interface NonceJournal {
  load(): NonceJournalRecord[];
  append(record: NonceRecord): void;
  rewrite(records: readonly NonceJournalRecord[]): void;
}

/** Appends since the last compaction that trigger a rewrite of the journal file. */
const COMPACT_AFTER_APPENDS = 1_000;

/**
 * Per-device nonce set with a 300s TTL and a 10,000-entry cap per device.
 *
 * Every time the cache reads is `max(now, watermark)`, where the watermark is the latest time it
 * has ever acted on. A host clock that moves backwards therefore cannot make an entry look
 * unexpired-then-expired twice, and `verifyEnvelope` judges timestamp freshness against the same
 * reference (see `referenceTime`), so a nonce pruned while the clock was ahead can never come
 * back into the freshness window after the clock is corrected. It also keeps insertion order and
 * expiry order identical, which `pruneExpired` relies on.
 *
 * A full device is refused, never evicted: dropping a nonce that is still inside its validity
 * window would make that exact envelope replayable. `record` returns false instead and the
 * request is rejected with `rate_limited`. Only a holder of the device key can fill the set,
 * since nothing is recorded before the signature verifies.
 *
 * With a `NonceJournal` the same set is written through to disk and rehydrated on construction,
 * so a request replayed across a bridge restart is still refused. Entries already expired at
 * load time are dropped and never rehydrated.
 */
export class NonceCache {
  private readonly perDevice = new Map<string, Map<string, number>>();
  private readonly journal: NonceJournal | undefined;
  private appendsSinceCompaction = 0;
  private watermarkMs = Number.NEGATIVE_INFINITY;

  constructor(options: { journal?: NonceJournal; now?: Date } = {}) {
    this.journal = options.journal;
    if (this.journal === undefined) {
      return;
    }

    // `load` throws on a filesystem failure (see JsonlJournal). Let it propagate rather than
    // treating an unreadable journal as an empty one: the latter would silently accept every
    // nonce this device has ever used, defeating replay protection after a restart.
    const persistedRecords = this.journal.load();
    for (const record of persistedRecords) {
      if (typeof (record as NonceWatermarkRecord | undefined)?.watermarkMs === "number") {
        this.advanceWatermark((record as NonceWatermarkRecord).watermarkMs);
      } else if (isNonceRecord(record)) {
        this.advanceWatermark(record.expiresAt - NONCE_TTL_MS);
      }
    }

    let dropped = false;
    const nowMs = this.referenceTime(options.now ?? new Date());
    this.advanceWatermark(nowMs);

    const cappedDevices = new Set<string>();
    for (const record of persistedRecords) {
      if (!isNonceRecord(record) || record.expiresAt <= nowMs) {
        dropped = true;
        continue;
      }
      let nonces = this.perDevice.get(record.deviceId);
      if (nonces === undefined) {
        nonces = new Map<string, number>();
        this.perDevice.set(record.deviceId, nonces);
      }
      if (nonces.size >= MAX_NONCES_PER_DEVICE) {
        dropped = true;
        if (!cappedDevices.has(record.deviceId)) {
          cappedDevices.add(record.deviceId);
          console.error(
            `Agent Remote bridge: nonces.jsonl held more than ${MAX_NONCES_PER_DEVICE} unexpired nonces for device ${record.deviceId}; extra entries dropped`,
          );
        }
        continue;
      }
      nonces.set(record.nonce, record.expiresAt);
    }
    if (dropped) {
      this.compact();
    }
  }

  /**
   * `max(now, watermark)` in epoch milliseconds: the time this cache, and the freshness check in
   * `verifyEnvelope`, treat as current. Equal to `now` unless the host clock has moved backwards.
   */
  referenceTime(now: Date): number {
    return Math.max(now.getTime(), this.watermarkMs);
  }

  has(deviceId: string, nonce: string, now: Date): boolean {
    const nonces = this.perDevice.get(deviceId);
    if (nonces === undefined) {
      return false;
    }
    const expiresAt = nonces.get(nonce);
    return expiresAt !== undefined && expiresAt > this.referenceTime(now);
  }

  /**
   * Marks `nonce` spent. Returns false, recording nothing, when the device already holds the
   * maximum number of unexpired nonces; the caller must refuse the request.
   */
  record(deviceId: string, nonce: string, now: Date): boolean {
    let nonces = this.perDevice.get(deviceId);
    if (nonces === undefined) {
      nonces = new Map<string, number>();
      this.perDevice.set(deviceId, nonces);
    }

    const nowMs = this.referenceTime(now);
    this.pruneExpired(nonces, nowMs);
    if (nonces.size >= MAX_NONCES_PER_DEVICE) {
      return false;
    }
    const expiresAt = nowMs + NONCE_TTL_MS;

    // Persist before marking the nonce used in memory, so the two can never disagree. `append`
    // throws on a filesystem failure (see JsonlJournal); letting it propagate out of `record`
    // and in turn out of `verifyEnvelope` is what makes an unpersistable nonce fail closed, and
    // appending first means the throw leaves the in-memory set (and the watermark) untouched
    // rather than holding a nonce the journal never recorded (which would look spent now and
    // replay cleanly after a restart).
    this.journal?.append({ deviceId, nonce, expiresAt });
    nonces.set(nonce, expiresAt);
    this.advanceWatermark(nowMs);
    if (this.journal === undefined) {
      return true;
    }
    this.appendsSinceCompaction += 1;
    if (this.appendsSinceCompaction >= COMPACT_AFTER_APPENDS) {
      this.compact();
    }
    return true;
  }

  private advanceWatermark(ms: number): void {
    if (ms > this.watermarkMs) {
      this.watermarkMs = ms;
    }
  }

  private pruneExpired(nonces: Map<string, number>, nowMs: number): void {
    for (const [key, expiresAt] of nonces) {
      if (expiresAt > nowMs) {
        break; // insertion order == expiry order (see class comment)
      }
      nonces.delete(key);
    }
  }

  /**
   * Rewrites the journal to the watermark plus exactly the live set, dropping expired entries.
   * The watermark line is what keeps the clock-rollback guarantee across a restart once every
   * nonce has expired and there is no record left to derive it from.
   */
  private compact(): void {
    if (this.journal === undefined) {
      return;
    }
    const records: NonceJournalRecord[] = [];
    if (Number.isFinite(this.watermarkMs)) {
      records.push({ watermarkMs: this.watermarkMs });
    }
    for (const [deviceId, nonces] of this.perDevice) {
      for (const [nonce, expiresAt] of nonces) {
        records.push({ deviceId, nonce, expiresAt });
      }
    }
    // Unlike `append`, a failed compaction is tolerated: every entry in `records` was already
    // durably appended one at a time, so the journal on disk is still a correct (just uncompacted)
    // superset of the live set, and the watermark is still derivable from it. Log and retry at the
    // next compaction threshold instead of failing the request that happened to trigger this
    // compaction.
    try {
      this.journal.rewrite(records);
      this.appendsSinceCompaction = 0;
    } catch (error) {
      console.error("Agent Remote bridge: failed to compact nonce journal, will retry later", error);
    }
  }
}

function isNonceRecord(record: NonceJournalRecord | undefined): record is NonceRecord {
  const candidate = record as Partial<NonceRecord> | undefined;
  return (
    typeof candidate?.deviceId === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

export type VerifyRejectionCode =
  | "unauthenticated"
  | "device_revoked"
  | "stale_request"
  | "replayed_request"
  | "rate_limited";

export type VerifyEnvelopeResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; status: 401 | 403 | 429; code: VerifyRejectionCode };

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

  // 4. Timestamp parses and is within skew of the bridge clock. The clock read is the nonce
  // cache's reference time, not raw `now`: after the host clock moves backwards, a timestamp is
  // still judged against the latest time the cache has acted on, so an envelope whose nonce was
  // already pruned cannot become fresh again (see NonceCache).
  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(timestampMs) || Math.abs(params.nonces.referenceTime(params.now) - timestampMs) > params.skewMs) {
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

  // 7. Room left in this device's nonce set. Only reachable with a valid signature, so only a
  // holder of the device key can hit it; refusing keeps every recorded nonce spent until it
  // expires instead of evicting one that could then be replayed.
  if (!params.nonces.record(deviceId, nonce, params.now)) {
    return { ok: false, status: 429, code: "rate_limited" };
  }
  return { ok: true, device };
}
