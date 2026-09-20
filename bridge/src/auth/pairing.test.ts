import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveDeviceKey,
  formatPairingCode,
  generatePairingCode,
  keyIdFor,
  normalizePairingCode,
  PairingCodeStore,
  pairingProof,
} from "./pairing";

describe("generatePairingCode", () => {
  test("produces a 12-character Crockford base32 code", () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(12);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });
});

describe("normalizePairingCode", () => {
  test("uppercases and maps the Crockford aliases", () => {
    expect(normalizePairingCode("abcdil1o0O")).toBe("ABCD111000");
  });

  test("strips characters outside the alphabet", () => {
    expect(normalizePairingCode("ABCD-EFGH-JKMN")).toBe("ABCDEFGHJKMN");
  });
});

describe("formatPairingCode", () => {
  test("groups into 4-4-4 with dashes", () => {
    expect(formatPairingCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });
});

describe("pairingProof", () => {
  test("matches for identical inputs", () => {
    const a = pairingProof("ABCDEFGHJKMN", "dev_1", "Watch", "nonce1");
    const b = pairingProof("ABCDEFGHJKMN", "dev_1", "Watch", "nonce1");
    expect(a).toBe(b);
  });

  test("differs when any input changes", () => {
    const base = pairingProof("ABCDEFGHJKMN", "dev_1", "Watch", "nonce1");
    expect(pairingProof("ABCDEFGHJKMN", "dev_2", "Watch", "nonce1")).not.toBe(base);
    expect(pairingProof("ABCDEFGHJKMN", "dev_1", "Other", "nonce1")).not.toBe(base);
    expect(pairingProof("ABCDEFGHJKMN", "dev_1", "Watch", "nonce2")).not.toBe(base);
    expect(pairingProof("ZZZZEFGHJKMN", "dev_1", "Watch", "nonce1")).not.toBe(base);
  });
});

describe("deriveDeviceKey", () => {
  test("both sides deriving from the same inputs agree", () => {
    const a = deriveDeviceKey("ABCDEFGHJKMN", "dev_1", "nonce1");
    const b = deriveDeviceKey("ABCDEFGHJKMN", "dev_1", "nonce1");
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  test("a different nonce derives a different key", () => {
    const a = deriveDeviceKey("ABCDEFGHJKMN", "dev_1", "nonce1");
    const b = deriveDeviceKey("ABCDEFGHJKMN", "dev_1", "nonce2");
    expect(a.equals(b)).toBe(false);
  });
});

describe("keyIdFor", () => {
  test("is 'key_' plus 8 hex characters of SHA-256(deviceKey)", () => {
    const key = deriveDeviceKey("ABCDEFGHJKMN", "dev_1", "nonce1");
    const keyId = keyIdFor(key);
    expect(keyId).toMatch(/^key_[0-9a-f]{8}$/);
  });
});

describe("PairingCodeStore", () => {
  test("verify fails with no_code before any mint", () => {
    const store = new PairingCodeStore();
    const result = store.verify("deadbeef", "dev_1", "Watch", "nonce1", new Date());
    expect(result).toEqual({ ok: false, reason: "no_code" });
  });

  test("proof match enrolls and burns the code (single use)", () => {
    const store = new PairingCodeStore();
    const now = new Date("2026-09-20T10:00:00.000Z");
    const code = store.mint(now);
    const proof = pairingProof(code, "dev_1", "Watch", "nonce1");

    const first = store.verify(proof, "dev_1", "Watch", "nonce1", now);
    expect(first).toEqual({ ok: true, code });

    const second = store.verify(proof, "dev_1", "Watch", "nonce1", now);
    expect(second).toEqual({ ok: false, reason: "no_code" });
  });

  test("proof mismatch is rejected", () => {
    const store = new PairingCodeStore();
    const now = new Date("2026-09-20T10:00:00.000Z");
    store.mint(now);
    const result = store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now);
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  test("expires 5 minutes after mint", () => {
    const store = new PairingCodeStore();
    const mintedAt = new Date("2026-09-20T10:00:00.000Z");
    const code = store.mint(mintedAt);
    const proof = pairingProof(code, "dev_1", "Watch", "nonce1");

    const justBefore = new Date(mintedAt.getTime() + 5 * 60 * 1000);
    expect(store.verify(proof, "dev_1", "Watch", "nonce1", justBefore)).toEqual({ ok: true, code });

    const store2 = new PairingCodeStore();
    const code2 = store2.mint(mintedAt);
    const proof2 = pairingProof(code2, "dev_1", "Watch", "nonce1");
    const afterExpiry = new Date(mintedAt.getTime() + 5 * 60 * 1000 + 1);
    expect(store2.verify(proof2, "dev_1", "Watch", "nonce1", afterExpiry)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("5 failed attempts burn the code", () => {
    const store = new PairingCodeStore();
    const now = new Date("2026-09-20T10:00:00.000Z");
    store.mint(now);

    for (let i = 0; i < 4; i++) {
      expect(store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    }
    // 5th failure burns the code.
    expect(store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now)).toEqual({
      ok: false,
      reason: "exhausted",
    });
    // The code is gone now, even with a correct proof.
    expect(store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now)).toEqual({
      ok: false,
      reason: "no_code",
    });
  });
});

describe("PairingCodeStore file persistence", () => {
  let stateDir: string;
  let filePath: string;

  beforeEach(() => {
    // A fresh temp dir per test: this must never touch the real ~/.agentremote.
    stateDir = mkdtempSync(join(tmpdir(), "agentremote-pairing-test-"));
    filePath = join(stateDir, "pairing.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("a second store instance over the same file verifies a code the first one minted", () => {
    // This is the regression test for the defect: an operator one-shot process and an
    // already-running bridge must agree on the live code via the shared file.
    const now = new Date("2026-09-20T10:00:00.000Z");
    const first = new PairingCodeStore(filePath);
    const code = first.mint(now);
    const proof = pairingProof(code, "dev_1", "Watch", "nonce1");

    const second = new PairingCodeStore(filePath);
    expect(second.verify(proof, "dev_1", "Watch", "nonce1", now)).toEqual({ ok: true, code });
  });

  test("failed attempts persist across instances", () => {
    const now = new Date("2026-09-20T10:00:00.000Z");
    const first = new PairingCodeStore(filePath);
    first.mint(now);

    for (let i = 0; i < 4; i++) {
      const store = new PairingCodeStore(filePath);
      expect(store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    }

    const fifth = new PairingCodeStore(filePath);
    expect(fifth.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now)).toEqual({
      ok: false,
      reason: "exhausted",
    });

    const sixth = new PairingCodeStore(filePath);
    expect(sixth.verify("0".repeat(64), "dev_1", "Watch", "nonce1", now)).toEqual({
      ok: false,
      reason: "no_code",
    });
  });

  test("a successful enrollment burns the code for a later instance too", () => {
    const now = new Date("2026-09-20T10:00:00.000Z");
    const first = new PairingCodeStore(filePath);
    const code = first.mint(now);
    const proof = pairingProof(code, "dev_1", "Watch", "nonce1");

    const second = new PairingCodeStore(filePath);
    expect(second.verify(proof, "dev_1", "Watch", "nonce1", now)).toEqual({ ok: true, code });

    const third = new PairingCodeStore(filePath);
    expect(third.verify(proof, "dev_1", "Watch", "nonce1", now)).toEqual({ ok: false, reason: "no_code" });
  });

  test("expiry is enforced across instances", () => {
    const mintedAt = new Date("2026-09-20T10:00:00.000Z");
    const first = new PairingCodeStore(filePath);
    const code = first.mint(mintedAt);
    const proof = pairingProof(code, "dev_1", "Watch", "nonce1");

    const afterExpiry = new Date(mintedAt.getTime() + 5 * 60 * 1000 + 1);
    const second = new PairingCodeStore(filePath);
    expect(second.verify(proof, "dev_1", "Watch", "nonce1", afterExpiry)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a missing file means no live code", () => {
    const store = new PairingCodeStore(filePath);
    expect(store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", new Date())).toEqual({
      ok: false,
      reason: "no_code",
    });
  });

  test("a corrupt file throws a clear error naming the path", () => {
    writeFileSync(filePath, "not json");
    const store = new PairingCodeStore(filePath);
    expect(() => store.verify("0".repeat(64), "dev_1", "Watch", "nonce1", new Date())).toThrow(
      new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});
