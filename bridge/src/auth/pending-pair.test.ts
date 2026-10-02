import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPairingWindow,
  clearPendingPair,
  openPairingWindow,
  readPairingWindow,
  readPendingPair,
  setPendingPairDecision,
  writePendingPair,
  type PendingPairRecord,
} from "./pending-pair";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agentremote-pending-pair-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function sampleRecord(overrides: Partial<PendingPairRecord> = {}): PendingPairRecord {
  return {
    requestId: "par_0011223344556677",
    deviceId: "dev_9f2c4a1b7d3e5061",
    deviceName: "Ting's Apple Watch",
    code: 487,
    revealedAt: "2026-09-25T00:00:00.000Z",
    expiresAt: "2026-09-25T00:02:00.000Z",
    decision: null,
    status: "pending",
    ...overrides,
  };
}

describe("pairing window", () => {
  test("readPairingWindow reports undefined before any window is opened", () => {
    expect(readPairingWindow(stateDir)).toBeUndefined();
  });

  test("openPairingWindow persists openedAt/expiresAt exactly TTL apart", () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    openPairingWindow(stateDir, now, 120_000, 2000);
    const window = readPairingWindow(stateDir);
    expect(window?.openedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(window?.expiresAt).toBe("2026-09-25T00:02:00.000Z");
  });

  test("a second openPairingWindow replaces the first", () => {
    openPairingWindow(stateDir, new Date("2026-09-25T00:00:00.000Z"), 120_000, 2000);
    openPairingWindow(stateDir, new Date("2026-09-25T01:00:00.000Z"), 120_000, 2000);
    expect(readPairingWindow(stateDir)?.openedAt).toBe("2026-09-25T01:00:00.000Z");
  });

  test("clearPairingWindow removes the file and is a no-op when there is none", () => {
    openPairingWindow(stateDir, new Date(), 120_000, 2000);
    clearPairingWindow(stateDir, 2000);
    expect(readPairingWindow(stateDir)).toBeUndefined();
    expect(() => clearPairingWindow(stateDir, 2000)).not.toThrow();
  });

  test("a malformed pairing-window.json throws naming the path", () => {
    Bun.write(join(stateDir, "pairing-window.json"), "{not valid json");
    expect(() => readPairingWindow(stateDir)).toThrow(/pairing-window\.json/);
  });
});

describe("pending pair record", () => {
  test("readPendingPair reports undefined before anything is written", () => {
    expect(readPendingPair(stateDir)).toBeUndefined();
  });

  test("writePendingPair then readPendingPair round-trips every field", () => {
    const record = sampleRecord();
    writePendingPair(stateDir, record, 250);
    expect(readPendingPair(stateDir)).toEqual(record);
  });

  test("clearPendingPair removes the file", () => {
    writePendingPair(stateDir, sampleRecord(), 250);
    clearPendingPair(stateDir, 250);
    expect(readPendingPair(stateDir)).toBeUndefined();
  });

  test("setPendingPairDecision updates decision in place, leaving every other field untouched", () => {
    writePendingPair(stateDir, sampleRecord(), 250);
    const applied = setPendingPairDecision(stateDir, "par_0011223344556677", "approved", 2000);
    expect(applied).toBe(true);
    expect(readPendingPair(stateDir)).toEqual(sampleRecord({ decision: "approved" }));
  });

  test("setPendingPairDecision is a no-op when there is no pending record", () => {
    expect(setPendingPairDecision(stateDir, "par_missing", "approved", 2000)).toBe(false);
    expect(readPendingPair(stateDir)).toBeUndefined();
  });

  test("setPendingPairDecision is a no-op when the requestId does not match (superseded by a newer request)", () => {
    writePendingPair(stateDir, sampleRecord({ requestId: "par_new" }), 250);
    const applied = setPendingPairDecision(stateDir, "par_0011223344556677", "denied", 2000);
    expect(applied).toBe(false);
    // The newer record is left exactly as it was, not overwritten with a decision from a stale
    // requestId the operator was still answering for.
    expect(readPendingPair(stateDir)?.decision).toBeNull();
  });

  test("a malformed pending-pair.json throws naming the path", () => {
    Bun.write(join(stateDir, "pending-pair.json"), "{not valid json");
    expect(() => readPendingPair(stateDir)).toThrow(/pending-pair\.json/);
  });
});
