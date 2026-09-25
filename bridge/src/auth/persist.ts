import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCK_RETRY_INTERVAL_MS = 5;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Thrown by `withFileLock` when the lock stays held by a live process for `timeoutMs`. */
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
 * Runs `fn` while holding an exclusive cross-process lock file at `lockPath` (containing the
 * holder's pid), so two processes doing reload -> mutate -> persist on the same file (the bridge's
 * DeviceRegistry and the admin CLI on devices.json) cannot interleave and have the later rename
 * silently undo the earlier write. Synchronous, like every caller of `atomicWriteFileSync`.
 *
 * A lock whose holder pid is dead, or whose mtime is older than `staleMs`, is taken over using
 * the same rename-claim sequence as the bridge.lock takeover in server.ts: rename the stale file
 * to a unique claim path (only one contender's rename can consume it), check the claimed content
 * is the stale holder we probed (else put it back), then re-create the lock with `wx` so a third
 * process that slipped in wins instead of being overwritten. A contender that loses any step just
 * retries until `timeoutMs`, after which `FileLockTimeoutError` is thrown.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { timeoutMs: number; staleMs: number } = { timeoutMs: 2000, staleMs: 10_000 },
): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownPid = String(process.pid);
  const deadline = Date.now() + opts.timeoutMs;
  let lastHolder = "unknown";
  let lockFd: number | null = null;

  for (;;) {
    lockFd = tryCreateLock(lockPath, ownPid);
    if (lockFd !== null) {
      break;
    }
    const holder = readLockHolder(lockPath);
    if (holder !== null) {
      lastHolder = holder.raw.length > 0 ? holder.raw : "unknown";
      if (isLockStale(holder, opts.staleMs)) {
        lockFd = tryTakeOver(lockPath, holder.raw, ownPid);
        if (lockFd !== null) {
          break;
        }
      }
    }
    // holder === null: the lock vanished between our create and read; retry immediately-ish.
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(`devices.json is locked by pid ${lastHolder} at ${lockPath}`);
    }
    Atomics.wait(sleepCell, 0, 0, LOCK_RETRY_INTERVAL_MS);
  }

  const heldFd = lockFd;
  try {
    return fn();
  } finally {
    // Only release a lock that is still ours: if it was taken over as stale while fn ran, the
    // name now belongs to another holder and unlinking it would let a third process in. Compared
    // by inode against the fd we still hold open (so the inode cannot have been reused), which
    // also keeps the release free of any readFileSync call.
    try {
      const held = fstatSync(heldFd);
      const current = statSync(lockPath);
      if (held.ino === current.ino && held.dev === current.dev) {
        unlinkSync(lockPath);
      }
    } catch {
      // ignore: already gone; a leftover lock is recovered by the stale check.
    } finally {
      closeSync(heldFd);
    }
  }
}

/** Exclusive-creates the lock holding `ownPid`; returns its open fd, or null if it exists. */
function tryCreateLock(lockPath: string, ownPid: string): number | null {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }
  try {
    writeSync(fd, ownPid);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
    throw error;
  }
  return fd;
}

interface LockHolder {
  raw: string;
  mtimeMs: number;
}

function readLockHolder(lockPath: string): LockHolder | null {
  try {
    const mtimeMs = statSync(lockPath).mtimeMs;
    return { raw: readFileSync(lockPath, "utf8").trim(), mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isLockStale(holder: LockHolder, staleMs: number): boolean {
  if (Date.now() - holder.mtimeMs > staleMs) {
    return true;
  }
  const pid = Number.parseInt(holder.raw, 10);
  // An empty/unparseable file is a holder between its `wx` create and its pid write: not stale
  // until the mtime check above says so.
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: alive, not stale.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Rename-claim takeover of a stale lock; returns the new lock's fd, or null (caller retries)
 * whenever another contender won any step. */
function tryTakeOver(lockPath: string, staleRaw: string, ownPid: string): number | null {
  const claimPath = `${lockPath}.claim.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, claimPath);
  } catch {
    return null; // another contender consumed the stale lock first
  }
  let claimedRaw: string;
  try {
    claimedRaw = readFileSync(claimPath, "utf8").trim();
  } catch {
    return null;
  }
  if (claimedRaw !== staleRaw) {
    // Not the stale lock we probed (someone re-created it first): put it back. link() rather
    // than rename() so that if a third contender has already re-created the lock, theirs is not
    // overwritten (link fails EEXIST; rename would silently replace it).
    try {
      linkSync(claimPath, lockPath);
    } catch {
      // ignore: another holder already owns the lock name.
    }
    try {
      unlinkSync(claimPath);
    } catch {
      // ignore
    }
    return null;
  }
  try {
    unlinkSync(claimPath);
  } catch {
    // ignore: the claim file is ours alone and harmless if left behind.
  }
  return tryCreateLock(lockPath, ownPid);
}
