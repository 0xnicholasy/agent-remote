import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";

import {
  checkCommitment,
  commitment,
  confirmCode,
  deriveDeviceKeyV2,
  keyIdFor,
  pairTranscript,
  privateKeyFromRawScalar,
  rawPublicKeyHex,
  sharedSecret,
} from "./pairing";
import { signRequest, signingString } from "./verify";

/**
 * The cross-language vector for pairing v2 (docs/pairing-v0.md). The Swift client asserts the
 * same literals in `RequestSigningTests`, so a change that breaks wire compatibility between the
 * two implementations fails here instead of failing on a watch at pairing time. Every expected
 * value below is a literal on purpose: recomputing them would make the test agree with whatever
 * the code currently does.
 *
 * The two X25519 key pairs are reconstructed from fixed raw private scalars
 * (`0x11`/`0x22` repeated) purely so this vector is deterministic; production key pairs are
 * always freshly random.
 */
describe("pairing v2 fixed vector", () => {
  const bridgeId = "brg_9f2c4a1b";
  const bridgeNonceHex = "00112233445566778899aabbccddeeff".slice(0, 32);
  const watchNonceHex = "aabbccddeeff00112233445566778899".slice(0, 32);

  const bridgePrivateKey = privateKeyFromRawScalar("11".repeat(32));
  const devicePrivateKey = privateKeyFromRawScalar("22".repeat(32));
  const bridgePublicKeyHex = rawPublicKeyHex(createPublicKey(bridgePrivateKey));
  const devicePublicKeyHex = rawPublicKeyHex(createPublicKey(devicePrivateKey));

  test("the fixed scalars produce the documented raw public keys", () => {
    expect(bridgeNonceHex).toBe("00112233445566778899aabbccddeeff");
    expect(watchNonceHex).toBe("aabbccddeeff00112233445566778899");
    expect(bridgePublicKeyHex).toBe("7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13");
    expect(devicePublicKeyHex).toBe("0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20");
  });

  test("commit = hex(SHA256(commit-transcript)) matches, and verifies against the revealed nonce", () => {
    const commit = commitment(watchNonceHex);
    expect(commit).toBe("44451b47ea1548fd1831d57eaedcda2cdbf53014acf86792e29b0b9459938068");
    expect(checkCommitment(commit, watchNonceHex)).toBe(true);
    expect(checkCommitment(commit, bridgeNonceHex)).toBe(false);
  });

  test("the confirmation code and device key match the documented literals", () => {
    const transcript = pairTranscript({
      bridgeId,
      bridgePublicKeyHex,
      devicePublicKeyHex,
      bridgeNonceHex,
      watchNonceHex,
    });
    expect(transcript).toBe(
      `agentremote-pair-confirm-v2\n${bridgeId}\n${bridgePublicKeyHex}\n${devicePublicKeyHex}\n` +
        `${bridgeNonceHex}\n${watchNonceHex}`,
    );

    expect(confirmCode(transcript)).toBe(487);

    const shared = sharedSecret(bridgePrivateKey, devicePublicKeyHex);
    const sharedFromOtherSide = sharedSecret(devicePrivateKey, bridgePublicKeyHex);
    expect(shared.equals(sharedFromOtherSide)).toBe(true);

    const deviceKey = deriveDeviceKeyV2(shared, transcript);
    expect(deviceKey.toString("hex")).toBe("bc6bd2bbeea0b02933e110b3082774c163d7574cd28a17650e4b6c4c4c35c781");
    expect(keyIdFor(deviceKey)).toBe("key_4217872d");
  });

  test("the derived device key signs a request the same way pairing v1 did", () => {
    const shared = sharedSecret(bridgePrivateKey, devicePublicKeyHex);
    const transcript = pairTranscript({
      bridgeId,
      bridgePublicKeyHex,
      devicePublicKeyHex,
      bridgeNonceHex,
      watchNonceHex,
    });
    const deviceKey = deriveDeviceKeyV2(shared, transcript);
    const parts = {
      method: "POST",
      pathWithQuery: "/v1/commands",
      timestamp: "2026-09-20T10:15:00.000Z",
      nonce: "00112233445566778899aabbccddeeff",
      bodySha256: "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    };
    expect(signingString(parts)).toBe(
      ["v1", "POST", "/v1/commands", parts.timestamp, parts.nonce, parts.bodySha256].join("\n"),
    );
    // Not a documented literal (it depends on the deviceKey above, which already is one); this
    // just confirms the v2 device key plugs into the unchanged request-signing path.
    expect(signRequest(deviceKey, parts)).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});
