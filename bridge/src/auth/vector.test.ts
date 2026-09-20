import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { deriveDeviceKey, keyIdFor, normalizePairingCode, pairingProof } from "./pairing";
import { signRequest, signingString } from "./verify";

/**
 * The cross-language vector from docs/pairing-v0.md. The Swift client asserts the same literals
 * in `RequestSigningTests`, so a change that breaks wire compatibility between the two
 * implementations fails here instead of failing on a watch at pairing time. Every expected value
 * below is a literal on purpose: recomputing them would make the test agree with whatever the
 * code currently does.
 */
describe("pairing-v0 fixed vector", () => {
  const code = normalizePairingCode("ABCD-EFGH-JKMN");
  const deviceId = "dev_9f2c4a1b7d3e5061";
  const deviceName = "Test Watch";
  const nonce = "00112233445566778899aabbccddeeff";
  const body = '{"a":1}';
  const bodySha256 = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";

  test("normalises the displayed code to its canonical form", () => {
    expect(code).toBe("ABCDEFGHJKMN");
  });

  test("hashes the body to the documented digest", () => {
    expect(createHash("sha256").update(body).digest("hex")).toBe(bodySha256);
  });

  test("produces the documented enrollment proof", () => {
    expect(pairingProof(code, deviceId, deviceName, nonce)).toBe(
      "7a7c4223ee9042311a66a05098b446d4db027b9c498f2dff2acdef6b88e925ae",
    );
  });

  test("derives the documented device key and key id", () => {
    const key = deriveDeviceKey(code, deviceId, nonce);
    expect(key.toString("hex")).toBe(
      "ca9dcc8f90e9c298f6027ce885a8235519206cb03314cc36c5a60c8556bacfd8",
    );
    expect(keyIdFor(key)).toBe("key_cd7749ef");
  });

  test("signs the documented request to the documented MAC", () => {
    const parts = {
      method: "POST",
      pathWithQuery: "/v1/commands",
      timestamp: "2026-09-20T10:15:00.000Z",
      nonce,
      bodySha256,
    };
    expect(signingString(parts)).toBe(
      [
        "v1",
        "POST",
        "/v1/commands",
        "2026-09-20T10:15:00.000Z",
        "00112233445566778899aabbccddeeff",
        bodySha256,
      ].join("\n"),
    );
    expect(signRequest(deriveDeviceKey(code, deviceId, nonce), parts)).toBe(
      "v1=e1702c4ff741df5df3e1dd59f0819a1a9f4bf56ee2dee410aa6dfac763b13032",
    );
  });
});
