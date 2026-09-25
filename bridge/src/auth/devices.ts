import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync, withFileLock } from "./persist";

// touch() coalesces persists to at most once per this interval; see the comment on touch() for
// why an on-disk lastSeenAt lagging by up to this much is safe.
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

// devices.json.lock defaults, per the "Device registry" section of docs/pairing-v0.md. The 2 s
// default suits the one-shot admin CLI. The bridge runs on a single event loop and the lock wait is
// synchronous, so it passes BRIDGE_LOCK_TIMEOUT_MS instead: the CLI holds the lock only for one
// reload + write (milliseconds), so a short bound is plenty and never stalls every other request.
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
export const BRIDGE_LOCK_TIMEOUT_MS = 250;
// Only consulted for an empty/unparseable lock file; a lock naming a live pid is never stale.
const LOCK_STALE_MS = 10_000;

export interface DeviceRegistryOptions {
  /** How long a mutating call waits for devices.json.lock before failing. */
  lockTimeoutMs?: number;
}

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
  // a separate `bun run bridge revoke` process writes devices.json directly, and a long-running
  // bridge must notice that write without a restart. undefined means "never checked yet".
  private knownStamp: FileStamp | null | undefined;
  // `lastSeenAt` as last actually written to (or read from) disk, in epoch milliseconds, keyed by
  // deviceId. touch() throttles against this rather than against the in-memory `lastSeenAt` it
  // just overwrote: comparing against the in-memory value freezes the on-disk value forever once
  // traffic is more frequent than LAST_SEEN_PERSIST_INTERVAL_MS. Rebuilt from `devices` on every
  // persist and reload, so it holds no entry for a device that is no longer in the registry and
  // cannot grow without bound. A device whose persisted `lastSeenAt` is null (or unparseable) has
  // no entry, which makes the next touch persist.
  private readonly persistedLastSeenAtMs = new Map<string, number>();

  private readonly lockTimeoutMs: number;

  constructor(filePath?: string, options: DeviceRegistryOptions = {}) {
    this.filePath = filePath;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** Loads from `filePath`, creating an empty registry when the file does not exist. */
  static load(filePath: string, options: DeviceRegistryOptions = {}): DeviceRegistry {
    const registry = new DeviceRegistry(filePath, options);
    registry.reloadIfChanged();
    return registry;
  }

  /**
   * Runs a reload -> mutate -> persist sequence under `${filePath}.lock`, the cross-process lock
   * the admin CLI also takes. The reload MUST happen inside `fn`: a reload done before the lock
   * could predate another process's rename, and our later rename would then silently undo that
   * write (resurrecting a revoked device or re-granting a denied project). In-memory registries
   * have no file to race on and run `fn` directly.
   */
  private locked<T>(fn: () => T, timeoutMs: number = this.lockTimeoutMs): T {
    if (this.filePath === undefined) {
      return fn();
    }
    return withFileLock(`${this.filePath}.lock`, fn, {
      timeoutMs,
      staleMs: LOCK_STALE_MS,
    });
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
      this.persistedLastSeenAtMs.clear();
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
    // What is on disk is by definition what was last persisted for these devices.
    this.snapshotPersistedLastSeen();
  }

  /**
   * Adds or replaces a device. Reloads first, because `persist` rewrites the whole file from the
   * in-memory map: without the reload, a registration made from a map that predates an
   * out-of-band write (the revoke CLI writing devices.json directly) would rewrite that file from
   * stale memory and resurrect a revoked device with `revokedAt` back to null.
   *
   * On a failed write the in-memory map is rolled back and the underlying error is rethrown, so a
   * caller observes: the exception, and a registry in which this device is exactly as it was
   * before the call (unknown to `get`/`list`, i.e. unauthorized, for a brand new device). The
   * process never serves a device as registered whose record did not reach disk.
   */
  register(record: DeviceRecord): void {
    this.locked(() => {
      this.reloadIfChanged();
      const previous = this.devices.get(record.deviceId);
      this.devices.set(record.deviceId, record);
      try {
        this.persist();
      } catch (cause) {
        if (previous === undefined) {
          this.devices.delete(record.deviceId);
        } else {
          this.devices.set(record.deviceId, previous);
        }
        throw cause;
      }
    });
  }

  get(deviceId: string): DeviceRecord | undefined {
    this.reloadIfChanged();
    return this.devices.get(deviceId);
  }

  list(): DeviceRecord[] {
    this.reloadIfChanged();
    return [...this.devices.values()];
  }

  /**
   * Sets `revokedAt`; keeps the record (a revoked device still reports `device_revoked`). Reloads
   * first for the same reason as `register`: the whole-map rewrite must land on top of whatever
   * another process wrote to devices.json since this registry last looked.
   *
   * On a failed write `revokedAt` is restored and the error is rethrown, so a caller observes: the
   * exception, and a device that is still not revoked here either. The alternative — keeping the
   * revocation in memory only — hides a failed revoke from the operator while every other process
   * (and this one after a restart) still treats the device as live.
   */
  revoke(deviceId: string, now: Date): void {
    this.locked(() => {
      this.reloadIfChanged();
      const record = this.devices.get(deviceId);
      if (record === undefined) {
        return;
      }
      const previousRevokedAt = record.revokedAt;
      record.revokedAt = now.toISOString();
      try {
        this.persist();
      } catch (cause) {
        record.revokedAt = previousRevokedAt;
        throw cause;
      }
    });
  }

  /**
   * Replaces `allowedProjects` with a deduped, sorted copy of `projects`. Reloads first and
   * rolls back on a failed persist, for the same reasons as `revoke` above: an operator command
   * (the CLI's `projects allow`/`projects deny`) writes devices.json directly, and a caller must
   * never observe a device as authorized for a project set that did not reach disk.
   *
   * The reload only protects *other* records from the whole-map rewrite; this device's array is
   * overwritten wholesale with `projects`. A caller that derives `projects` from a `get()` made
   * outside the lock races another writer and loses one of the two changes, so read-modify-write
   * callers (add one project, remove one project) must use `updateAllowedProjects` instead.
   */
  setAllowedProjects(deviceId: string, projects: string[]): void {
    this.updateAllowedProjects(deviceId, () => projects);
  }

  /**
   * Read-modify-write on `allowedProjects` under the file lock: `update` receives the array as
   * reloaded from disk inside the lock, and its result is stored deduped and sorted. Same
   * unknown-device no-op and rollback-on-failed-persist contract as `setAllowedProjects`.
   */
  updateAllowedProjects(deviceId: string, update: (current: readonly string[]) => string[]): void {
    this.locked(() => {
      this.reloadIfChanged();
      const record = this.devices.get(deviceId);
      if (record === undefined) {
        return;
      }
      const previousAllowedProjects = record.allowedProjects;
      record.allowedProjects = [...new Set(update(previousAllowedProjects))].sort();
      try {
        this.persist();
      } catch (cause) {
        record.allowedProjects = previousAllowedProjects;
        throw cause;
      }
    });
  }

  /**
   * Two-tier write policy for this class: security-relevant state (register/revoke, above) writes
   * synchronously and rethrows on failure, so a caller never observes a device as registered or
   * un-revoked whose record did not reach disk. `lastSeenAt` below is cosmetic only — it feeds no
   * authorization or replay decision — so it writes best-effort and swallows a persist failure.
   */
  touch(deviceId: string, now: Date): void {
    // No reloadIfChanged() on the non-persisting path beyond the statSync `get`/callers already
    // paid for on this request: touch runs once per authenticated request right after
    // verifyEnvelope's own registry.get, so the stamp is already current and a second stat would
    // be pure waste when we are not about to write. On the persisting path below, though, an
    // out-of-band write (the revoke CLI) could have landed on devices.json since that get, and the
    // whole-map rewrite in persist() must not clobber it — so that path reloads first.
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
    record.lastSeenAt = now.toISOString();
    // Throttle against the value last actually PERSISTED, not against the value the previous
    // touch wrote into memory: the latter never ages past the interval under traffic more
    // frequent than it, so the on-disk lastSeenAt would freeze at the first write forever.
    const persistedAtMs = this.persistedLastSeenAtMs.get(deviceId);
    if (persistedAtMs === undefined || now.getTime() - persistedAtMs >= LAST_SEEN_PERSIST_INTERVAL_MS) {
      // Best-effort and non-blocking: touch runs on every authenticated request, so it makes one
      // lock attempt (timeout 0, no wait) and a busy lock (an operator command mid-write) skips
      // this write rather than stalling the event loop; the next touch past the interval retries.
      let acquired = false;
      try {
        this.locked(() => {
          acquired = true;
          this.reloadIfChanged();
          const fresh = this.devices.get(deviceId);
          if (fresh === undefined) {
            return;
          }
          fresh.lastSeenAt = now.toISOString();
          try {
            this.persist();
          } catch (cause) {
            console.warn(`Agent Remote bridge: failed to persist lastSeenAt for device ${deviceId}`, cause);
          }
        }, 0);
      } catch (cause) {
        // Errors from inside the lock (a corrupt file on reload) propagate as before; failing to
        // take the lock at all (timeout, or an unwritable state dir) just skips this write.
        if (acquired) {
          throw cause;
        }
        console.warn(`Agent Remote bridge: skipped persisting lastSeenAt for device ${deviceId}`, cause);
      }
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
    this.snapshotPersistedLastSeen();
  }

  /** Rebuilds `persistedLastSeenAtMs` from the records now known to match the file. Rebuilding
   * (rather than accumulating) is what keeps it bounded by the current device set. */
  private snapshotPersistedLastSeen(): void {
    this.persistedLastSeenAtMs.clear();
    for (const [deviceId, record] of this.devices) {
      if (record.lastSeenAt === null) {
        continue;
      }
      const ms = Date.parse(record.lastSeenAt);
      if (!Number.isNaN(ms)) {
        this.persistedLastSeenAtMs.set(deviceId, ms);
      }
    }
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
