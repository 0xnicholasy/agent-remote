import type { CommandResponse } from "@agentremote/protocol";

import { JsonlJournal } from "./journal";

/** How long a command identity is remembered, per docs/durability-v0.md. A retry older than
 * this is treated as a fresh command, which is safe because every decision the watch can send
 * also carries its own shorter expiry. */
export const COMMAND_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Appends since the last compaction that trigger a rewrite of the journal file. */
const COMPACT_AFTER_APPENDS = 512;

/** Hard ceiling on retained command ids, oldest dropped first. Retention alone is a time bound,
 * not a size bound: an authenticated device can mint command ids as fast as it can sign
 * requests, and every one of them would otherwise sit in memory and on disk for a full day. The
 * cap is what makes the journal's size independent of request volume, the same way `EventLog`
 * caps events and `NonceCache` caps nonces per device. */
export const MAX_COMMANDS = 5_000;

/** How often `prune` actually scans. Scanning on every request is O(entries) per request; the
 * only thing a scan can discover is that an entry aged past a 24 hour window, so once a minute
 * is as timely as it needs to be. */
const PRUNE_INTERVAL_MS = 60_000;

/**
 * What the bridge knows about one `commandId`.
 *
 * - `in_flight`: execution started in this process and has not finished yet.
 * - `completed`: the provider applied it; `response` is the answer every retry must receive.
 * - `abandoned`: the provider refused it before applying anything (a mapped 4xx), so the same
 *   command id may be tried again.
 * - `indeterminate`: execution started and the process died before it finished. Whether the
 *   provider applied the side effect is unknown, so a retry is refused rather than replayed.
 */
export type CommandStatus = "in_flight" | "completed" | "abandoned" | "indeterminate";

export interface CommandEntry {
  commandId: string;
  /** The device that sent it, or `null` when auth is off. A different device reusing a command
   * id is a conflict, exactly as it was when this map lived in process memory. */
  deviceId: string | null;
  /** SHA-256 of the exact request body, so a reused command id with a different body conflicts. */
  digest: string;
  status: CommandStatus;
  /** Present only for `completed`. */
  response?: CommandResponse;
  /** Epoch milliseconds of the last write for this command id; drives retention. */
  at: number;
}

/**
 * Durable command identity and idempotency, per the "Command identity" section of
 * docs/durability-v0.md. Replaces the process-memory map that slice 1 used: a retry that
 * arrives after a bridge restart still gets the recorded answer instead of re-applying a
 * decision, and a command the bridge died in the middle of is reported as indeterminate rather
 * than silently replayed.
 */
export class CommandJournal {
  private readonly journal: JsonlJournal<CommandEntry>;
  private readonly entries = new Map<string, CommandEntry>();
  private readonly retentionMs: number;
  private appendsSinceCompaction = 0;
  private lastPruneMs = 0;

  constructor(filePath?: string, options: { now?: Date; retentionMs?: number } = {}) {
    this.journal = new JsonlJournal<CommandEntry>(filePath);
    this.retentionMs = options.retentionMs ?? COMMAND_RETENTION_MS;

    const now = (options.now ?? new Date()).getTime();
    for (const record of this.journal.load()) {
      if (typeof record?.commandId !== "string") {
        continue;
      }
      // Later lines for one command id supersede earlier ones.
      this.entries.set(record.commandId, record);
    }

    this.lastPruneMs = now;
    let changed = false;
    for (const [commandId, entry] of this.entries) {
      if (now - entry.at > this.retentionMs) {
        this.entries.delete(commandId);
        changed = true;
        continue;
      }
      if (entry.status === "in_flight") {
        // Nothing in this process is executing it, so it was cut short by the previous run.
        this.entries.set(commandId, { ...entry, status: "indeterminate" });
        changed = true;
      }
    }
    changed = this.enforceCap() || changed;
    if (changed) {
      this.compact();
    }
  }

  get(commandId: string): CommandEntry | undefined {
    return this.entries.get(commandId);
  }

  /** Records that execution is starting. */
  begin(commandId: string, deviceId: string | null, digest: string, now: Date): void {
    this.write({ commandId, deviceId, digest, status: "in_flight", at: now.getTime() });
  }

  /** Records the answer every later retry of `commandId` must receive. */
  complete(commandId: string, response: CommandResponse, now: Date): void {
    const previous = this.entries.get(commandId);
    this.write({
      commandId,
      deviceId: previous?.deviceId ?? null,
      digest: previous?.digest ?? "",
      status: "completed",
      response,
      at: now.getTime(),
    });
  }

  /** Records that the provider refused the command without applying anything. */
  abandon(commandId: string, now: Date): void {
    const previous = this.entries.get(commandId);
    this.write({
      commandId,
      deviceId: previous?.deviceId ?? null,
      digest: previous?.digest ?? "",
      status: "abandoned",
      at: now.getTime(),
    });
  }

  /** Drops entries past retention and rewrites the file to one line per surviving command.
   * Throttled to `PRUNE_INTERVAL_MS`, so a burst of commands does not rescan the whole map per
   * request. */
  prune(now: Date): void {
    if (now.getTime() - this.lastPruneMs < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneMs = now.getTime();
    let changed = false;
    for (const [commandId, entry] of this.entries) {
      if (now.getTime() - entry.at > this.retentionMs) {
        this.entries.delete(commandId);
        changed = true;
      }
    }
    if (changed) {
      this.compact();
    }
  }

  /** Command ids currently known, for tests and operator inspection. */
  size(): number {
    return this.entries.size;
  }

  private write(entry: CommandEntry): void {
    this.entries.delete(entry.commandId); // re-insert so Map order stays oldest-write-first
    this.entries.set(entry.commandId, entry);
    this.journal.append(entry);
    if (this.enforceCap()) {
      this.compact();
      return;
    }
    this.appendsSinceCompaction += 1;
    if (this.appendsSinceCompaction >= COMPACT_AFTER_APPENDS) {
      this.compact();
    }
  }

  /** Drops the oldest entries until the map is within `MAX_COMMANDS`. Returns whether anything
   * was dropped, so the caller can decide to compact. */
  private enforceCap(): boolean {
    let dropped = false;
    while (this.entries.size > MAX_COMMANDS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
      dropped = true;
    }
    return dropped;
  }

  private compact(): void {
    this.journal.rewrite([...this.entries.values()]);
    this.appendsSinceCompaction = 0;
  }
}
