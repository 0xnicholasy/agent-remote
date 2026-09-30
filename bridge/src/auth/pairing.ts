import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";

// Fixed 12-byte SubjectPublicKeyInfo DER prefix for a raw 32-byte X25519 public key
// (`302a300506032b656e032100`, i.e. algorithm X25519 + a 32-byte BIT STRING). Concatenating it
// with the 32 raw bytes we send on the wire is what lets `node:crypto` (which only speaks DER/PEM
// for asymmetric keys, not raw bytes) import a peer's public key.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
// Fixed 16-byte PKCS8 prefix for a raw 32-byte X25519 private scalar. Only used to reconstruct a
// deterministic key pair from a fixed raw scalar for the cross-language test vector below --
// production key pairs are always freshly random, from `generateX25519KeyPair`.
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

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

export interface X25519KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The public half, raw 32 bytes, lowercase hex -- what goes on the wire. */
  publicKeyHex: string;
}

/** Generates a fresh X25519 key pair for one pairing session (the bridge mints one per process
 * start; nothing here is ever persisted -- see the "Timing" section of docs/pairing-v0.md). */
export function generateX25519KeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey, publicKeyHex: rawPublicKeyHex(publicKey) };
}

/** Encodes an X25519 public key as its raw 32 bytes, lowercase hex. */
export function rawPublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32).toString("hex");
}

/** Imports a peer's raw 32-byte X25519 public key (as sent on the wire) into a `KeyObject`. */
export function publicKeyFromHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) {
    throw new Error(`expected a 32-byte X25519 public key, got ${raw.length} bytes`);
  }
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Imports a raw 32-byte X25519 private scalar (as used by the fixed test vector) into a
 * `KeyObject`. Not used by production pairing, which always generates a fresh random key pair. */
export function privateKeyFromRawScalar(hex: string): KeyObject {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) {
    throw new Error(`expected a 32-byte X25519 private scalar, got ${raw.length} bytes`);
  }
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** `X25519(ownPrivate, peerPublic)`, per the pairing v2 derivation. */
export function sharedSecret(privateKey: KeyObject, peerPublicKeyHex: string): Buffer {
  return diffieHellman({ privateKey, publicKey: publicKeyFromHex(peerPublicKeyHex) });
}

/** `commit = hex(SHA256("agentremote-pair-commit-v2\n" + watchNonce))`. */
export function commitment(watchNonceHex: string): string {
  return createHash("sha256").update(`agentremote-pair-commit-v2\n${watchNonceHex}`, "utf8").digest("hex");
}

/** Constant-time check of a claimed commitment against the (now revealed) `watchNonceHex`. */
export function checkCommitment(commit: string, watchNonceHex: string): boolean {
  return constantTimeEqual(commitment(watchNonceHex), commit);
}

/**
 * `"agentremote-pair-confirm-v2\n" + bridgeId + "\n" + bridgePublicKey + "\n" + devicePublicKey +
 * "\n" + bridgeNonce + "\n" + watchNonce`, per the pairing v2 derivation. Both sides must compute
 * this identically (see protocol/swift/Sources/AgentRemoteProtocol/RequestSigning.swift) since it
 * feeds both the displayed confirmation code and the device key.
 */
export function pairTranscript(params: {
  bridgeId: string;
  bridgePublicKeyHex: string;
  devicePublicKeyHex: string;
  bridgeNonceHex: string;
  watchNonceHex: string;
}): string {
  return (
    `agentremote-pair-confirm-v2\n${params.bridgeId}\n${params.bridgePublicKeyHex}\n` +
    `${params.devicePublicKeyHex}\n${params.bridgeNonceHex}\n${params.watchNonceHex}`
  );
}

/** `uint32be(SHA256(transcript)[0..4]) mod 900 + 100` -- a 3-digit code, 100..999. */
export function confirmCode(transcript: string): number {
  const digest = createHash("sha256").update(transcript, "utf8").digest();
  return (digest.readUInt32BE(0) % 900) + 100;
}

/**
 * `deviceKey = HKDF-SHA256(ikm=shared, salt=SHA256(transcript), info="agentremote-device-key-v2",
 * length 32)`.
 */
export function deriveDeviceKeyV2(shared: Buffer, transcript: string): Buffer {
  const salt = createHash("sha256").update(transcript, "utf8").digest();
  const okm = hkdfSync("sha256", shared, salt, Buffer.from("agentremote-device-key-v2", "utf8"), 32);
  return Buffer.from(okm);
}

/** `keyId = "key_" + first 8 hex characters of SHA-256(deviceKey)`. Unchanged from pairing v1. */
export function keyIdFor(deviceKey: Buffer): string {
  const hash = createHash("sha256").update(deviceKey).digest("hex");
  return `key_${hash.slice(0, 8)}`;
}
