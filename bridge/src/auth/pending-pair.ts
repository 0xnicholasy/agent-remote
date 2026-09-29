import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync, withFileLock } from "./persist";

/** Default lock-wait bound for the bridge's own reads/writes; the CLI passes its own longer
 * bound (2 s), matching `BRIDGE_LOCK_TIMEOUT_MS`/`DEFAULT_LOCK_TIMEOUT_MS` in devices.ts. */
export const PENDING_PAIR_BRIDGE_LOCK_TIMEOUT_MS = 250;
export const PENDING_PAIR_CLI_LOCK_TIMEOUT_MS = 2000;

/** `bun run bridge pair` opens a 120 s window during which the bridge will accept
 * `POST /v1/pair/start`, per the "Timing" section of docs/pairing-v0.md. */
export interface PairingWindow {
  openedAt: string;
  expiresAt: string;
}

/** One in-flight pairing request, written by the bridge on a successful `/v1/pair/reveal` and
 * read/updated by both the bridge (status polls, decision) and the CLI (prints the code, writes
 * the operator's decision), per the "Files" section of the pairing v2 spec. */
export interface PendingPairRecord {
  requestId: string;
  deviceId: string;
  deviceName: string;
  code: number;
  revealedAt: string;
  expiresAt: string;
  decision: "approved" | "denied" | null;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
}

export function pairingWindowFilePath(stateDir: string): string {
  return join(stateDir, "pairing-window.json");
}

export function pendingPairFilePath(stateDir: string): string {
  return join(stateDir, "pending-pair.json");
}

function isPairingWindow(value: unknown): value is PairingWindow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.openedAt === "string" && typeof record.expiresAt === "string";
}

function isPendingPairRecord(value: unknown): value is PendingPairRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === "string" &&
    typeof record.deviceId === "string" &&
    typeof record.deviceName === "string" &&
    typeof record.code === "number" &&
    typeof record.revealedAt === "string" &&
    typeof record.expiresAt === "string" &&
    (record.decision === null || record.decision === "approved" || record.decision === "denied") &&
    (record.status === "pending" ||
      record.status === "approved" ||
      record.status === "denied" ||
      record.status === "expired" ||
      record.status === "cancelled")
  );
}

function readJson(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`corrupt ${filePath}: not valid JSON`, { cause });
  }
}

/** Opens a fresh pairing window, overwriting any previous one. */
export function openPairingWindow(
  stateDir: string,
  now: Date,
  ttlMs: number,
  lockTimeoutMs: number,
): PairingWindow {
  const filePath = pairingWindowFilePath(stateDir);
  const window: PairingWindow = {
    openedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  withFileLock(`${filePath}.lock`, () => atomicWriteFileSync(filePath, JSON.stringify(window, null, 2)), lockTimeoutMs);
  return window;
}

/** Reads the current pairing window, or `undefined` when none is open. Throws (naming the path)
 * on a malformed file, matching `DeviceRegistry`'s corrupt-file handling. */
export function readPairingWindow(stateDir: string): PairingWindow | undefined {
  const filePath = pairingWindowFilePath(stateDir);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const parsed = readJson(filePath);
  if (!isPairingWindow(parsed)) {
    throw new Error(`corrupt ${filePath}: malformed pairing window`);
  }
  return parsed;
}

export function clearPairingWindow(stateDir: string, lockTimeoutMs: number): void {
  const filePath = pairingWindowFilePath(stateDir);
  withFileLock(
    `${filePath}.lock`,
    () => {
      if (existsSync(filePath)) {
        rmSync(filePath);
      }
    },
    lockTimeoutMs,
  );
}

/** Reads the current pending pairing request, or `undefined` when there is none. Throws (naming
 * the path) on a malformed file. */
export function readPendingPair(stateDir: string): PendingPairRecord | undefined {
  const filePath = pendingPairFilePath(stateDir);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const parsed = readJson(filePath);
  if (!isPendingPairRecord(parsed)) {
    throw new Error(`corrupt ${filePath}: malformed pending pair record`);
  }
  return parsed;
}

/** Written by the bridge on a successful `/v1/pair/reveal`: only one request may be pending at a
 * time, so callers check `readPendingPair` first (the "pairing_busy" 409). */
export function writePendingPair(stateDir: string, record: PendingPairRecord, lockTimeoutMs: number): void {
  const filePath = pendingPairFilePath(stateDir);
  withFileLock(`${filePath}.lock`, () => atomicWriteFileSync(filePath, JSON.stringify(record, null, 2)), lockTimeoutMs);
}

export function clearPendingPair(stateDir: string, lockTimeoutMs: number): void {
  const filePath = pendingPairFilePath(stateDir);
  withFileLock(
    `${filePath}.lock`,
    () => {
      if (existsSync(filePath)) {
        rmSync(filePath);
      }
    },
    lockTimeoutMs,
  );
}

/**
 * Read-modify-write of `decision`, under the file lock: the CLI's y/N answer. A no-op (returns
 * `false`) when there is no pending record, or its `requestId` no longer matches (a bridge
 * restart, expiry, or cancellation replaced/removed it while the operator was answering the
 * prompt), so the CLI can tell "recorded" from "too late" without racing the bridge's own reads.
 */
export function setPendingPairDecision(
  stateDir: string,
  requestId: string,
  decision: "approved" | "denied",
  lockTimeoutMs: number,
): boolean {
  const filePath = pendingPairFilePath(stateDir);
  return withFileLock(
    `${filePath}.lock`,
    () => {
      if (!existsSync(filePath)) {
        return false;
      }
      const parsed = readJson(filePath);
      if (!isPendingPairRecord(parsed) || parsed.requestId !== requestId) {
        return false;
      }
      parsed.decision = decision;
      atomicWriteFileSync(filePath, JSON.stringify(parsed, null, 2));
      return true;
    },
    lockTimeoutMs,
  );
}
