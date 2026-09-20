import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "./persist";

// touch() coalesces persists to at most once per this interval; see the comment on touch() for
// why an on-disk lastSeenAt lagging by up to this much is safe.
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

/** `mtimeMs`+`size` of the backing file as last observed by this registry, or `null` when the
 * file did not exist at that observation. Cheap to compare against a fresh `statSync` without
 * re-reading or re-parsing the file. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * A paired device, per the "Device registry" section of docs/pairing-v0.md. `deviceKeyHex` is
 * the device key encoded as hex for JSON persistence; callers turn it back into a `Buffer` with
 * `Buffer.from(record.deviceKeyHex, "hex")` before signing or verifying.
 */
export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  keyId: string;
  deviceKeyHex: string;
  pairedAt: string;
  allowedProjects: string[];
  allowedActions: string[];
  revokedAt: string | null;
  lastSeenAt: string | null;
}

/** `$AGENTREMOTE_STATE_DIR`, defaulting to `~/.agentremote`. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTREMOTE_STATE_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), ".agentremote");
}

/**
 * Persists devices as a JSON array at a configurable path, written atomically (temp file then
 * rename) with mode 0600 in a directory created 0700, per the "Device registry" section. A
 * registry constructed without a path stays in memory only, which keeps unit tests file-free.
 */
export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly filePath: string | undefined;
  // Last-seen stamp of the backing file, so a read path can tell "someone else wrote this since
  // we last looked" from "nothing changed" with one statSync, per the "Device registry" section:
  // a separate `AGENTREMOTE_REVOKE` process writes devices.json directly, and a long-running
  // bridge must notice that write without a restart. undefined means "never checked yet".
  private knownStamp: FileStamp | null | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
  }

  /** Loads from `filePath`, creating an empty registry when the file does not exist. */
  static load(filePath: string): DeviceRegistry {
    const registry = new DeviceRegistry(filePath);
    registry.reloadIfChanged();
    return registry;
  }

  /** Re-reads the backing file only when its `statSync` stamp differs from `knownStamp`, i.e.
   * only when this registry did not itself just write that stamp. Cheap on the common path: one
   * `statSync`, no read, no parse. Swallows a missing file (revoked-from-under-us is not a crash;
   * an empty registry is), matching the "creating an empty registry" behavior of `load`. */
  private reloadIfChanged(): void {
    const filePath = this.filePath;
    if (filePath === undefined) {
      return;
    }

    const stamp = statFile(filePath);
    if (stampsEqual(stamp, this.knownStamp)) {
      return;
    }

    if (stamp === null) {
      this.devices.clear();
      this.knownStamp = stamp;
      return;
    }

    const raw = readFileSync(filePath, "utf8");
    // JSON.parse is untyped by construction; validated below before anything is trusted.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`corrupt device registry at ${filePath}: not valid JSON`, { cause });
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`corrupt device registry at ${filePath}: expected a JSON array of device records`);
    }
    // Validate every entry before mutating this.devices, so a corrupt file throws without
    // leaving the registry half-replaced.
    for (const entry of parsed) {
      if (!isDeviceRecord(entry)) {
        throw new Error(`corrupt device registry at ${filePath}: malformed device record`);
      }
    }
    this.devices.clear();
    for (const entry of parsed as DeviceRecord[]) {
      this.devices.set(entry.deviceId, entry);
    }
    this.knownStamp = stamp;
  }

  register(record: DeviceRecord): void {
    this.devices.set(record.deviceId, record);
    this.persist();
  }

  get(deviceId: string): DeviceRecord | undefined {
    this.reloadIfChanged();
    return this.devices.get(deviceId);
  }

  list(): DeviceRecord[] {
    this.reloadIfChanged();
    return [...this.devices.values()];
  }

  /** Sets `revokedAt`; keeps the record (a revoked device still reports `device_revoked`). */
  revoke(deviceId: string, now: Date): void {
    const record = this.devices.get(deviceId);
    if (record === undefined) {
      return;
    }
    record.revokedAt = now.toISOString();
    this.persist();
  }

  touch(deviceId: string, now: Date): void {
    // Deliberately no reloadIfChanged() here beyond the statSync `get`/callers already paid for
    // on this request: touch runs once per authenticated request right after verifyEnvelope's
    // own registry.get, so the stamp is already current and a second stat would be pure waste.
    const record = this.devices.get(deviceId);
    if (record === undefined) {
      return;
    }
    // lastSeenAt is operator-visible information only: it is read solely by the operator
    // device-list command (server.ts:~817) and the record shape check above, and it feeds no
    // authorization or replay decision. So an on-disk value lagging by up to
    // LAST_SEEN_PERSIST_INTERVAL_MS is purely cosmetic, and we skip the full atomic rewrite most
    // requests would otherwise pay for. Security-relevant state (registration, revocation) still
    // writes synchronously via register()/revoke() above.
    const previousLastSeenAt = record.lastSeenAt;
    record.lastSeenAt = now.toISOString();
    if (
      previousLastSeenAt === null ||
      previousLastSeenAt === undefined ||
      now.getTime() - new Date(previousLastSeenAt).getTime() >= LAST_SEEN_PERSIST_INTERVAL_MS
    ) {
      this.persist();
    }
  }

  private persist(): void {
    const filePath = this.filePath;
    if (filePath === undefined) {
      return;
    }

    // Serializes the in-memory map directly rather than via list(), which would itself run
    // reloadIfChanged() and stat the file a second time for no reason mid-write.
    atomicWriteFileSync(filePath, JSON.stringify([...this.devices.values()], null, 2));
    // Record the stamp of what we just wrote so the next read sees "unchanged" and skips a
    // redundant reparse of the file we are the ones who wrote.
    this.knownStamp = statFile(filePath);
  }
}

function statFile(filePath: string): FileStamp | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const stats = statSync(filePath);
  return { mtimeMs: stats.mtimeMs, size: stats.size };
}

function stampsEqual(a: FileStamp | null, b: FileStamp | null | undefined): boolean {
  if (b === undefined) {
    return false;
  }
  if (a === null || b === null) {
    return a === b;
  }
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.deviceName === "string" &&
    typeof record.keyId === "string" &&
    typeof record.deviceKeyHex === "string" &&
    typeof record.pairedAt === "string" &&
    Array.isArray(record.allowedProjects) &&
    Array.isArray(record.allowedActions) &&
    (record.revokedAt === null || typeof record.revokedAt === "string") &&
    (record.lastSeenAt === null || typeof record.lastSeenAt === "string")
  );
}
