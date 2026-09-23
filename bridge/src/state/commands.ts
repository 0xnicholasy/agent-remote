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
    changed = this.enforceCap(now) || changed;
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
    // Capture the prior record (if any) before overwriting, so a failed append can restore the
    // map to its exact previous state instead of blindly deleting: `complete`/`abandon` call this
    // with a commandId that already has a durably-persisted in_flight record, and losing that
    // record from memory (while it still sits on disk) would make a retry re-execute the command.
    const previous = this.entries.get(entry.commandId);
    this.entries.delete(entry.commandId); // re-insert so Map order stays oldest-write-first
    this.entries.set(entry.commandId, entry);
    try {
      this.journal.append(entry);
    } catch (error) {
      // journal.ts now propagates append failures instead of swallowing them. The caller (e.g.
      // `begin`) needs this to reach it so it can refuse to execute a command whose idempotency
      // record was never durably persisted, so it must rethrow rather than be absorbed here. Roll
      // back the in-memory record too: it must not claim durability the journal does not have,
      // restoring the previous entry (if there was one) rather than deleting it outright.
      console.error(`Agent Remote bridge: command journal append failed for ${entry.commandId}`, error);
      this.entries.delete(entry.commandId);
      if (previous !== undefined) {
        this.entries.set(entry.commandId, previous);
      }
      throw error;
    }
    if (this.enforceCap(entry.at)) {
      this.compact();
      return;
    }
    this.appendsSinceCompaction += 1;
    if (this.appendsSinceCompaction >= COMPACT_AFTER_APPENDS) {
      this.compact();
    }
  }

  /** Drops the oldest evictable entries until the map is within `MAX_COMMANDS`. An entry is
   * evictable only when it is terminal (not `in_flight`) *and* already past `retentionMs`, the
   * same window `prune` uses. Both conditions protect the guarantee this journal exists for:
   * evicting an `in_flight` record loses the identity of a command that is still executing, and
   * evicting a `completed`/`indeterminate` record still inside its retention window means a
   * legitimate retry no longer finds the recorded outcome and the command is re-executed. When
   * nothing is evictable the cap is exceeded with a logged warning naming why, rather than
   * dropping live idempotency state or rejecting new work — the same precedent the in-flight case
   * already set. Returns whether anything was dropped, so the caller can decide to compact. */
  private enforceCap(nowMs: number): boolean {
    let dropped = false;
    while (this.entries.size > MAX_COMMANDS) {
      let oldestEvictableId: string | undefined;
      let inFlight = 0;
      let withinRetention = 0;
      for (const [commandId, entry] of this.entries) {
        if (entry.status === "in_flight") {
          inFlight += 1;
          continue;
        }
        if (nowMs - entry.at <= this.retentionMs) {
          withinRetention += 1;
          continue;
        }
        oldestEvictableId = commandId;
        break;
      }
      if (oldestEvictableId === undefined) {
        console.warn(
          `Agent Remote bridge: command journal has ${this.entries.size} entries, exceeding MAX_COMMANDS (${MAX_COMMANDS}), and none are evictable (${inFlight} in flight, ${withinRetention} terminal but within retention); growing past cap rather than dropping live idempotency records`,
        );
        break;
      }
      this.entries.delete(oldestEvictableId);
      dropped = true;
    }
    return dropped;
  }

  private compact(): void {
    try {
      this.journal.rewrite([...this.entries.values()]);
    } catch (error) {
      // Same rationale as the append catch above: a rewrite failure is a durability concern,
      // not a correctness one, since `entries` in memory is unaffected.
      console.error(`Agent Remote bridge: command journal rewrite failed`, error);
    }
    this.appendsSinceCompaction = 0;
  }
}
