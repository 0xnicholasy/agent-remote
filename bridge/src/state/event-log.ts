import { existsSync, readFileSync } from "node:fs";

import type { AgentEvent } from "@agentremote/protocol";

import { atomicWriteFileSync } from "../auth/persist";
import { JsonlJournal } from "./journal";

/** Events kept across a restart, per docs/durability-v0.md. A watch that reconnects wants the
 * recent conversation, not the whole history, and the Mac stays the place to read a full
 * transcript. */
export const MAX_RETAINED_EVENTS = 2_000;

/** Events older than this are dropped on load even when the count is under the cap. */
export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Appends since the last compaction that trigger a rewrite of the journal file. */
const COMPACT_AFTER_APPENDS = 1_000;

/** Event ids are handed out in blocks of this size, and the end of the current block is
 * persisted before any id in it is used. Deriving the next id from the log file alone is not
 * enough: if the log is deleted, emptied or fully corrupt, ids would restart at 1 and be reused
 * for different events while clients still hold old cursors. Reserving ahead means a lost log
 * costs a gap in the id space, never a repeat. */
const ID_BLOCK_SIZE = 100;

/**
 * The bridge's event log, held in memory and written through to a JSON Lines journal so a
 * client's cursor still resolves after the bridge restarts.
 *
 * Retention is what makes the file bounded, and it is also why `firstEventId` exists: a client
 * whose cursor is below the oldest retained event has a gap it cannot poll its way out of, and
 * must be told so rather than handed a silently truncated page.
 */
export class EventLog {
  private readonly journal: JsonlJournal<AgentEvent>;
  private readonly watermarkFilePath: string | undefined;
  private events: AgentEvent[] = [];
  private nextId = 1;
  private reservedThrough = 0;
  private appendsSinceCompaction = 0;

  constructor(filePath?: string, options: { now?: Date; retentionMs?: number; maxEvents?: number } = {}) {
    this.journal = new JsonlJournal<AgentEvent>(filePath);
    this.watermarkFilePath = filePath === undefined ? undefined : `${filePath}.watermark`;

    const nowMs = (options.now ?? new Date()).getTime();
    const retentionMs = options.retentionMs ?? EVENT_RETENTION_MS;
    const maxEvents = options.maxEvents ?? MAX_RETAINED_EVENTS;

    const loaded = this.journal.load().filter((event) => typeof event?.eventId === "number");
    // The highest id ever issued must never be reused, even when that event is then pruned:
    // a client holding an old cursor would otherwise be handed different events under ids it
    // already consumed.
    const highest = loaded.reduce((max, event) => Math.max(max, event.eventId), 0);
    this.nextId = Math.max(highest, this.loadWatermark()) + 1;
    this.reservedThrough = this.nextId - 1;

    const kept = loaded.filter((event) => {
      const at = Date.parse(event.timestamp);
      return Number.isNaN(at) || nowMs - at <= retentionMs;
    });
    this.events = kept.slice(-maxEvents);
    if (this.events.length !== loaded.length) {
      this.compact();
    }
  }

  /** The id the next appended event will carry. */
  get nextEventId(): number {
    return this.nextId;
  }

  /** The oldest event id still retained, or 0 when the log is empty. A cursor below
   * `firstEventId - 1` has missed events that no longer exist. */
  get firstEventId(): number {
    return this.events[0]?.eventId ?? 0;
  }

  get lastEventId(): number {
    return this.events.at(-1)?.eventId ?? 0;
  }

  /** Issues the next event id. The caller builds the event; `append` records it. */
  takeEventId(): number {
    if (this.nextId > this.reservedThrough) {
      this.reserveIds(this.nextId + ID_BLOCK_SIZE - 1);
    }
    return this.nextId++;
  }

  /** Persists first, then records in memory. A durable append that throws must leave no trace in
   * memory: serving a client an event that will not exist after a restart puts a permanent,
   * undetectable gap in its cursor sequence, which is worse than the caller seeing the failure. */
  append(event: AgentEvent): void {
    this.journal.append(event);
    this.events.push(event);
    this.appendsSinceCompaction += 1;
    if (this.events.length > MAX_RETAINED_EVENTS) {
      this.events = this.events.slice(-MAX_RETAINED_EVENTS);
      this.compact();
      return;
    }
    if (this.appendsSinceCompaction >= COMPACT_AFTER_APPENDS) {
      this.compact();
    }
  }

  after(cursor: number): AgentEvent[] {
    return this.events.filter((event) => event.eventId > cursor);
  }

  all(): readonly AgentEvent[] {
    return this.events;
  }

  private compact(): void {
    this.journal.rewrite(this.events);
    this.appendsSinceCompaction = 0;
  }

  /**
   * Highest id any previous process may have issued, from the persisted watermark.
   *
   * Absent means a legitimately fresh bridge and reads as 0. Present but unreadable is a real
   * failure and throws: the watermark reserves ids ahead of the log, so it can legitimately sit
   * above the log's highest id, and there is no floor recoverable from the log that is
   * guaranteed safe. Failing to start beats silently reissuing ids clients already hold.
   */
  private loadWatermark(): number {
    if (this.watermarkFilePath === undefined || !existsSync(this.watermarkFilePath)) {
      return 0;
    }

    let raw: string;
    try {
      raw = readFileSync(this.watermarkFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0; // removed between the check and the read: still an absent watermark
      }
      console.error(`Agent Remote bridge: failed to read watermark ${this.watermarkFilePath}`, error);
      throw error;
    }

    let parsed: unknown; // JSON.parse is untyped by construction; validated before it is trusted.
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Agent Remote bridge: event id watermark ${this.watermarkFilePath} is corrupt and cannot be parsed; refusing to start rather than reuse event ids`,
        { cause: error },
      );
    }

    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as Record<string, unknown>).reservedThrough;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
      }
    }
    throw new Error(
      `Agent Remote bridge: event id watermark ${this.watermarkFilePath} holds no usable reservation; refusing to start rather than reuse event ids`,
    );
  }

  /** Persists the watermark before any id in the new block is handed out. Reservation must not
   * advance in memory unless the write actually landed: a swallowed failure here is exactly how
   * ids get reused after a crash, so the error is rethrown and takeEventId hands out nothing for
   * this call. */
  private reserveIds(through: number): void {
    if (this.watermarkFilePath === undefined) {
      this.reservedThrough = through;
      return;
    }
    atomicWriteFileSync(this.watermarkFilePath, JSON.stringify({ reservedThrough: through }));
    this.reservedThrough = through;
  }
}
