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

/**
 * Per-device nonce set with a 300s TTL and a 10,000-entry cap per device, oldest dropped first.
 * A `Map`'s keys iterate in insertion order, and since every entry's TTL is the same fixed
 * duration, insertion order and expiry order coincide as long as `now` does not go backwards.
 */
export class NonceCache {
  private readonly perDevice = new Map<string, Map<string, number>>();

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
    if (nonces.size >= MAX_NONCES_PER_DEVICE) {
      const oldest = nonces.keys().next();
      if (!oldest.done) {
        nonces.delete(oldest.value);
      }
    }
    nonces.set(nonce, now.getTime() + NONCE_TTL_MS);
  }

  private pruneExpired(nonces: Map<string, number>, now: Date): void {
    for (const [key, expiresAt] of nonces) {
      if (expiresAt > now.getTime()) {
        break; // insertion order == expiry order (see class comment)
      }
      nonces.delete(key);
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
