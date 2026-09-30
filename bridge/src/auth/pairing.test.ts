import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";

import {
  checkCommitment,
  commitment,
  confirmCode,
  deriveDeviceKeyV2,
  generateX25519KeyPair,
  keyIdFor,
  pairTranscript,
  privateKeyFromRawScalar,
  publicKeyFromHex,
  rawPublicKeyHex,
  sharedSecret,
} from "./pairing";

describe("generateX25519KeyPair / rawPublicKeyHex / publicKeyFromHex", () => {
  test("generates a fresh, 32-byte raw public key every call", () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    expect(a.publicKeyHex).toHaveLength(64);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });

  test("round-trips a raw public key through hex", () => {
    const pair = generateX25519KeyPair();
    const imported = publicKeyFromHex(pair.publicKeyHex);
    expect(rawPublicKeyHex(imported)).toBe(pair.publicKeyHex);
  });

  test("rejects a public key that isn't 32 raw bytes", () => {
    expect(() => publicKeyFromHex("aa")).toThrow(/32-byte/);
  });
});

describe("sharedSecret", () => {
  test("X25519(a.private, b.public) equals X25519(b.private, a.public)", () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const fromA = sharedSecret(a.privateKey, b.publicKeyHex);
    const fromB = sharedSecret(b.privateKey, a.publicKeyHex);
    expect(fromA.equals(fromB)).toBe(true);
    expect(fromA).toHaveLength(32);
  });

  test("two different key pairs on the attacker's side produce different shared secrets against the same peer, so a relaying MITM cannot make its two legs agree", () => {
    const watch = generateX25519KeyPair();
    const mitmLegToWatch = generateX25519KeyPair();
    const mitmLegToBridge = generateX25519KeyPair();
    const bridge = generateX25519KeyPair();

    const watchSharedWithMitm = sharedSecret(watch.privateKey, mitmLegToWatch.publicKeyHex);
    const bridgeSharedWithMitm = sharedSecret(bridge.privateKey, mitmLegToBridge.publicKeyHex);
    expect(watchSharedWithMitm.equals(bridgeSharedWithMitm)).toBe(false);

    const watchNonce = "aa".repeat(16);
    const bridgeNonce = "bb".repeat(16);
    const transcriptToWatch = pairTranscript({
      bridgeId: "brg_00000000",
      bridgePublicKeyHex: mitmLegToWatch.publicKeyHex,
      devicePublicKeyHex: watch.publicKeyHex,
      bridgeNonceHex: bridgeNonce,
      watchNonceHex: watchNonce,
    });
    const transcriptToBridge = pairTranscript({
      bridgeId: "brg_00000000",
      bridgePublicKeyHex: bridge.publicKeyHex,
      devicePublicKeyHex: mitmLegToBridge.publicKeyHex,
      bridgeNonceHex: bridgeNonce,
      watchNonceHex: watchNonce,
    });
    // Different transcripts (different public keys on each leg) mean different codes on the two
    // legs the MITM is relaying between, so the operator's Mac and the Watch disagree.
    expect(confirmCode(transcriptToWatch)).not.toBe(confirmCode(transcriptToBridge));
    const keyToWatch = deriveDeviceKeyV2(watchSharedWithMitm, transcriptToWatch);
    const keyToBridge = deriveDeviceKeyV2(bridgeSharedWithMitm, transcriptToBridge);
    expect(keyToWatch.equals(keyToBridge)).toBe(false);
  });
});

describe("commitment / checkCommitment", () => {
  test("checkCommitment accepts the nonce that produced the commit and rejects any other", () => {
    const nonce = "cc".repeat(16);
    const otherNonce = "dd".repeat(16);
    const commit = commitment(nonce);
    expect(checkCommitment(commit, nonce)).toBe(true);
    expect(checkCommitment(commit, otherNonce)).toBe(false);
  });
});

describe("confirmCode", () => {
  test("is always a 3-digit code between 100 and 999", () => {
    for (let i = 0; i < 50; i++) {
      const transcript = `t-${i}`;
      const code = confirmCode(transcript);
      expect(code).toBeGreaterThanOrEqual(100);
      expect(code).toBeLessThanOrEqual(999);
    }
  });

  test("a different transcript almost always yields a different code (not a constant function)", () => {
    const codes = new Set(Array.from({ length: 20 }, (_, i) => confirmCode(`transcript-${i}`)));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("deriveDeviceKeyV2 / keyIdFor", () => {
  test("both sides derive the same device key and keyId from the same shared secret and transcript", () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const transcript = pairTranscript({
      bridgeId: "brg_11111111",
      bridgePublicKeyHex: a.publicKeyHex,
      devicePublicKeyHex: b.publicKeyHex,
      bridgeNonceHex: "11".repeat(16),
      watchNonceHex: "22".repeat(16),
    });
    const sharedFromA = sharedSecret(a.privateKey, b.publicKeyHex);
    const sharedFromB = sharedSecret(b.privateKey, a.publicKeyHex);
    const keyFromA = deriveDeviceKeyV2(sharedFromA, transcript);
    const keyFromB = deriveDeviceKeyV2(sharedFromB, transcript);
    expect(keyFromA.equals(keyFromB)).toBe(true);
    expect(keyIdFor(keyFromA)).toBe(keyIdFor(keyFromB));
    expect(keyIdFor(keyFromA)).toMatch(/^key_[0-9a-f]{8}$/);
  });
});

describe("privateKeyFromRawScalar", () => {
  test("reconstructs the same public key deterministically for a fixed scalar", () => {
    const key = privateKeyFromRawScalar("11".repeat(32));
    expect(rawPublicKeyHex(createPublicKey(key))).toBe(
      "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
    );
  });

  test("rejects a scalar that isn't 32 raw bytes", () => {
    expect(() => privateKeyFromRawScalar("aa")).toThrow(/32-byte/);
  });
});
