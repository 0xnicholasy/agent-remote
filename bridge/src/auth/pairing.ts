import { createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

import { atomicWriteFileSync } from "./persist";

// Crockford base32 without the check symbol, per docs/pairing-v0.md.
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH = 12;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;

/**
 * Mints a 12-character pairing code. `randomInt` rejects and redraws internally so every
 * alphabet symbol is equally likely — a plain `byte % 32` would be fine here too since 256 is a
 * multiple of 32, but the caller asked for a selection method that stays unbiased even if the
 * alphabet size ever changes.
 */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  }
  return code;
}

/** Uppercases, maps the Crockford aliases (I/L -> 1, O -> 0), then drops anything else. */
export function normalizePairingCode(input: string): string {
  const upper = input.toUpperCase();
  const aliased = upper.replace(/[IL]/g, "1").replace(/O/g, "0");
  let out = "";
  for (const char of aliased) {
    if (PAIRING_ALPHABET.includes(char)) {
      out += char;
    }
  }
  return out;
}

/** Groups a normalised 12-character code for display: `ABCD-EFGH-JKMN`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/** `proof = HMAC(code, "agentremote-pair-v1\n" + deviceId + "\n" + deviceName + "\n" + nonce)`. */
export function pairingProof(code: string, deviceId: string, deviceName: string, nonce: string): string {
  const message = `agentremote-pair-v1\n${deviceId}\n${deviceName}\n${nonce}`;
  return createHmac("sha256", Buffer.from(code, "utf8")).update(message, "utf8").digest("hex");
}

/**
 * `deviceKey = HKDF-SHA256(ikm=code, salt=deviceId+"\n"+nonce, info="agentremote-device-key-v1", 32)`.
 * `hkdfSync` returns an `ArrayBuffer`; wrapping it in a `Buffer` keeps the return type consistent
 * with the rest of this module (device keys, HMAC keys) without copying.
 */
export function deriveDeviceKey(code: string, deviceId: string, nonce: string): Buffer {
  const okm = hkdfSync(
    "sha256",
    Buffer.from(code, "utf8"),
    Buffer.from(`${deviceId}\n${nonce}`, "utf8"),
    Buffer.from("agentremote-device-key-v1", "utf8"),
    32,
  );
  return Buffer.from(okm);
}

/** `keyId = "key_" + first 8 hex characters of SHA-256(deviceKey)`. */
export function keyIdFor(deviceKey: Buffer): string {
  const hash = createHash("sha256").update(deviceKey).digest("hex");
  return `key_${hash.slice(0, 8)}`;
}

/** Constant-time string compare, safe for attacker-controlled input of any length. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // timingSafeEqual requires equal-length buffers; unequal length is never a match.
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export type PairingVerifyResult =
  | { ok: true; code: string }
  | { ok: false; reason: "no_code" | "expired" | "exhausted" | "mismatch" };

/** On-disk shape for the live pairing code, per the "Device registry" section of
 * docs/pairing-v0.md. `mintedAt`/`expiresAt` are ISO timestamps so the file is human-readable;
 * `expiresAt` is redundant with `mintedAt` + the TTL but is written out for operators reading
 * the file directly. */
interface PersistedPairingState {
  code: string;
  mintedAt: string;
  expiresAt: string;
  failedAttempts: number;
}

function isPersistedPairingState(value: unknown): value is PersistedPairingState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.mintedAt === "string" &&
    typeof record.expiresAt === "string" &&
    typeof record.failedAttempts === "number"
  );
}

/**
 * Holds at most one live pairing code, per docs/pairing-v0.md: 5-minute TTL, 5 failed attempts
 * burn it, and a successful enrollment burns it too (one code enrolls exactly one device). `now`
 * is always caller-supplied so tests can move time without sleeping.
 *
 * A store constructed without `filePath` stays purely in memory, exactly as before, which keeps
 * existing tests and injection points valid. A store constructed with `filePath` persists the
 * live code to disk (atomic write, mode 0600) so a one-shot operator process (`AGENTREMOTE_PAIR`)
 * and the long-running bridge process agree on what the current code is.
 */
export class PairingCodeStore {
  private current: { code: string; mintedAt: Date; attempts: number } | undefined;
  private readonly filePath: string | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
  }

  mint(now: Date): string {
    const code = generatePairingCode();
    this.current = { code, mintedAt: now, attempts: 0 };
    this.persist();
    return code;
  }

  verify(proof: string, deviceId: string, deviceName: string, nonce: string, now: Date): PairingVerifyResult {
    // Re-read the file first: a bridge process that started before an operator minted a fresh
    // code (or before another bridge process burned the old one) must not act on stale
    // in-memory state.
    this.reload();

    const current = this.current;
    if (current === undefined) {
      return { ok: false, reason: "no_code" };
    }
    if (now.getTime() - current.mintedAt.getTime() > PAIRING_TTL_MS) {
      return { ok: false, reason: "expired" };
    }

    const expected = pairingProof(current.code, deviceId, deviceName, nonce);
    if (constantTimeEqual(expected, proof)) {
      this.current = undefined; // single use: success burns the code
      this.burn();
      return { ok: true, code: current.code };
    }

    current.attempts += 1;
    if (current.attempts >= MAX_PAIRING_ATTEMPTS) {
      this.current = undefined; // burned: the attempt limit was reached
      this.burn();
      return { ok: false, reason: "exhausted" };
    }
    this.persist();
    return { ok: false, reason: "mismatch" };
  }

  /** Loads the current code from `filePath`, mirroring `DeviceRegistry`'s corrupt-file
   * handling: a missing file means no live code, a malformed one throws naming the path. */
  private reload(): void {
    const filePath = this.filePath;
    if (filePath === undefined) {
      return;
    }
    if (!existsSync(filePath)) {
      this.current = undefined;
      return;
    }

    const raw = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`corrupt pairing code file at ${filePath}: not valid JSON`, { cause });
    }
    if (!isPersistedPairingState(parsed)) {
      throw new Error(`corrupt pairing code file at ${filePath}: malformed pairing state`);
    }

    this.current = {
      code: parsed.code,
      mintedAt: new Date(parsed.mintedAt),
      attempts: parsed.failedAttempts,
    };
  }

  private persist(): void {
    const filePath = this.filePath;
    const current = this.current;
    if (filePath === undefined || current === undefined) {
      return;
    }

    const state: PersistedPairingState = {
      code: current.code,
      mintedAt: current.mintedAt.toISOString(),
      expiresAt: new Date(current.mintedAt.getTime() + PAIRING_TTL_MS).toISOString(),
      failedAttempts: current.attempts,
    };
    atomicWriteFileSync(filePath, JSON.stringify(state, null, 2));
  }

  /** Clears the persisted code on success/exhaustion, per the single-use rule above. */
  private burn(): void {
    const filePath = this.filePath;
    if (filePath === undefined || !existsSync(filePath)) {
      return;
    }
    rmSync(filePath);
  }
}
