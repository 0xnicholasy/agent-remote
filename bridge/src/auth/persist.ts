import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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
