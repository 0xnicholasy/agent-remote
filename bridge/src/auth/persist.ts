import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
  writeFileSync(tmpPath, data, { mode: 0o600 });
  renameSync(tmpPath, filePath); // atomic on the same filesystem
}
