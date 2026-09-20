import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../auth/persist";

/** Fsyncs a directory so a crash cannot lose an already-fsynced file's directory entry. */
function fsyncDirSync(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append-only JSON Lines store for bridge state that must survive a restart, per
 * docs/durability-v0.md. One JSON object per line; a line that does not parse is skipped on
 * load rather than failing the whole file, so a torn final write (the only partial line a
 * crash can leave behind, since every append is a single write of one line) costs one record
 * instead of the journal.
 *
 * Compaction is the caller's job: it decides which records still matter and hands the survivors
 * to `rewrite`, which replaces the file atomically through the same temp-file-then-rename path
 * the device registry uses.
 *
 * A journal constructed without a path stays in memory only (`load` returns nothing, `append`
 * and `rewrite` do nothing), which is what keeps unit tests and in-memory bridges file-free.
 */
export class JsonlJournal<T> {
  private readonly filePath: string | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
  }

  /** True when this journal is backed by a file. */
  get persistent(): boolean {
    return this.filePath !== undefined;
  }

  /** Every record still readable in the file, oldest first. Unreadable lines are skipped. */
  load(): T[] {
    if (this.filePath === undefined || !existsSync(this.filePath)) {
      return [];
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      // NodeJS.ErrnoException, not `unknown`/`any`: the only fields read are its own `code`.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Legitimately absent (e.g. removed between the existsSync check and this read).
        return [];
      }
      console.error(`Agent Remote bridge: failed to read journal ${this.filePath}`, error);
      throw error;
    }

    const records: T[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        // A torn or corrupt line costs that record only.
      }
    }
    return records;
  }

  /**
   * Appends one record and fsyncs it. The fsync is what makes the durability claims true across
   * a crash rather than only across a graceful restart: a nonce accepted just before a power
   * loss must not be replayable afterwards. Volumes here are a handful of records per turn, so
   * the cost is not worth trading for that guarantee.
   *
   * A failed write is reported, then rethrown: a caller believing an unpersisted record made it
   * to durable storage is worse than a caller that has to decide what to do about the failure.
   */
  append(record: T): void {
    if (this.filePath === undefined) {
      return;
    }
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      fd = openSync(this.filePath, "a", 0o600);
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
      fsyncDirSync(dirname(this.filePath));
    } catch (error) {
      console.error(`Agent Remote bridge: failed to append to ${this.filePath}`, error);
      throw error;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already reported above if the write itself failed; a close failure adds nothing.
        }
      }
    }
  }

  /** Replaces the file with exactly `records`, atomically (temp file then rename, so a failure
   * before the rename leaves the original journal untouched). Failures are reported, then
   * rethrown, for the same reason `append` no longer swallows them. */
  rewrite(records: readonly T[]): void {
    if (this.filePath === undefined) {
      return;
    }
    const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    try {
      atomicWriteFileSync(this.filePath, body);
      fsyncDirSync(dirname(this.filePath));
    } catch (error) {
      console.error(`Agent Remote bridge: failed to rewrite ${this.filePath}`, error);
      throw error;
    }
  }
}
