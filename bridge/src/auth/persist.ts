import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCK_RETRY_INTERVAL_MS = 5;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Thrown when `lockPath` stays held for `timeoutMs`. Message says whether the holder pid is running. */
export class FileLockTimeoutError extends Error {}

/**
 * Writes `data` to `filePath` atomically (temp file then rename), with the file left at mode
 * 0600 and its parent directory created 0700 if missing. Shared by every piece of persisted
 * auth state (`DeviceRegistry`, `PairingCodeStore`) so they agree on the same on-disk safety
 * properties instead of each reimplementing it.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, data, { mode: 0o600 });

    // fsync the temp file's contents before rename so the rename can't outrace the data hitting disk.
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpPath, filePath); // atomic on the same filesystem

    // fsync the directory entry too: without this, a crash can lose the rename even though
    // the file itself was fsynced, leaving "atomic" not actually crash-durable.
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; the original error below is what matters.
    }
    throw err;
  }
}

/**
 * Runs `fn` while holding `lockPath`, created exclusively (`wx`) with this pid inside. The lock is
 * never taken over: a lock that exists is held. This is what makes release trivially correct (the
 * name is ours until we unlink it) and keeps every contention branch out of this file. The only
 * recovery from a lock orphaned by a crash mid-write is `clearLockIfHolderDead` at bridge startup,
 * which is race-free because that process holds bridge.lock and a live CLI's pid is left alone.
 * `timeoutMs: 0` makes exactly one attempt and never sleeps.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs: number): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(describeHeldLock(lockPath));
    }
    Atomics.wait(sleepCell, 0, 0, Math.max(1, Math.min(LOCK_RETRY_INTERVAL_MS, deadline - Date.now())));
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      // ENOENT: someone removed our lock by hand; nothing left to release. Anything else means a
      // lock we cannot remove, which would wedge every later writer, so it must surface.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function readLockPid(lockPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: exists, another user
  }
}

function describeHeldLock(lockPath: string): string {
  const pid = readLockPid(lockPath);
  if (pid === null) {
    return `${lockPath} is held but names no pid (a writer was killed before recording it); if no agent-remote process is writing devices.json, remove it and re-run`;
  }
  return isPidAlive(pid)
    ? `${lockPath} is held by running pid ${pid}; re-run`
    : `${lockPath} is held by pid ${pid}, which is not running (writer crashed mid-write); remove it and re-run, or restart the bridge`;
}

/**
 * Removes `lockPath` when it names a pid that is not running. ONLY safe from a process that already
 * holds bridge.lock: that rules out a second bridge, and a live CLI's lock names a live pid. An
 * empty lock is left alone (a CLI may be between create and pid write).
 */
export function clearLockIfHolderDead(lockPath: string): boolean {
  const pid = readLockPid(lockPath);
  if (pid === null || isPidAlive(pid)) {
    return false;
  }
  unlinkSync(lockPath);
  return true;
}
