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

  append(event: AgentEvent): void {
    this.events.push(event);
    this.journal.append(event);
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

  /** Highest id any previous process may have issued, from the persisted watermark. */
  private loadWatermark(): number {
    if (this.watermarkFilePath === undefined || !existsSync(this.watermarkFilePath)) {
      return 0;
    }
    try {
      // JSON.parse is untyped by construction; validated before it is trusted.
      const parsed: unknown = JSON.parse(readFileSync(this.watermarkFilePath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const value = (parsed as Record<string, unknown>).reservedThrough;
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
      }
    } catch {
      // A corrupt watermark falls back to the log's own highest id.
    }
    return 0;
  }

  private reserveIds(through: number): void {
    this.reservedThrough = through;
    if (this.watermarkFilePath === undefined) {
      return;
    }
    try {
      atomicWriteFileSync(this.watermarkFilePath, JSON.stringify({ reservedThrough: through }));
    } catch (error) {
      console.error(`Agent Remote bridge: failed to persist the event id watermark`, error);
    }
  }
}
