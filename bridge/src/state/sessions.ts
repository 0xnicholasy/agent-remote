import { JsonlJournal } from "./journal";

/** What the bridge remembers about a session that may no longer exist in the provider. */
export interface SessionIndexEntry {
  sessionId: string;
  projectId: string;
  at: number;
}

/** How long a session's project binding is remembered. Matches the event retention window:
 * the only reason to keep it is to authorize a retained event. */
export const SESSION_INDEX_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Hard ceiling on retained session bindings, oldest dropped first. Retention alone is a time
 * bound, not a size bound: a paired device can start sessions as fast as the provider accepts
 * them, and every one would otherwise sit in memory and on disk for a full day. The cap is what
 * makes the index's size independent of session volume, the same way `CommandJournal` caps
 * commands and `NonceCache` caps nonces per device. */
export const MAX_SESSIONS = 5_000;

/** Appends since the last compaction that trigger a rewrite of the journal file. */
const COMPACT_AFTER_APPENDS = 512;

/** How often `prune` actually scans. Scanning on every request is O(entries) per request; the
 * only thing a scan can discover is that an entry aged past the retention window, so once a
 * minute is as timely as it needs to be. */
const PRUNE_INTERVAL_MS = 60_000;

/**
 * Maps a session id to the project it belongs to, across restarts.
 *
 * Providers hold sessions in memory, so after a restart `listSessions()` no longer knows the
 * project of a session that retained events still refer to. Without this index those events
 * would fail the per-device project check in `GET /v1/events` and be filtered away silently —
 * a paired device would reconnect to an empty history rather than to its own conversation.
 */
export class SessionIndex {
  private readonly journal: JsonlJournal<SessionIndexEntry>;
  private readonly entries = new Map<string, SessionIndexEntry>();
  private readonly retentionMs: number;
  private appendsSinceCompaction = 0;
  private lastPruneMs = 0;

  constructor(filePath?: string, options: { now?: Date; retentionMs?: number } = {}) {
    this.journal = new JsonlJournal<SessionIndexEntry>(filePath);
    this.retentionMs = options.retentionMs ?? SESSION_INDEX_RETENTION_MS;

    const nowMs = (options.now ?? new Date()).getTime();
    let dropped = false;
    for (const entry of this.journal.load()) {
      if (typeof entry?.sessionId !== "string" || typeof entry.projectId !== "string") {
        dropped = true;
        continue;
      }
      if (nowMs - entry.at > this.retentionMs) {
        dropped = true;
        continue;
      }
      this.entries.set(entry.sessionId, entry);
    }
    this.lastPruneMs = nowMs;
    dropped = this.enforceCap() || dropped;
    if (dropped) {
      this.compact();
    }
  }

  /** Looks up the project a session is bound to, and refreshes its recency: a session still
   * being read is still live, so this re-inserts the entry to keep Map insertion order a true
   * LRU rather than a bind-time-only order (see `enforceCap`). In-memory only — this never
   * touches the journal, so a lookup never costs a disk write. */
  projectOf(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry.projectId;
  }

  /** Binds a session to a project. The first binding wins: re-binding an existing session to a
   * different project would silently re-scope every retained event of that session, which is an
   * authorization decision, so a conflicting rebind is reported and ignored instead. */
  record(sessionId: string, projectId: string, now: Date): void {
    this.prune(now);
    const existing = this.entries.get(sessionId);
    if (existing !== undefined) {
      if (existing.projectId !== projectId) {
        console.error(
          `Agent Remote bridge: refusing to rebind session ${sessionId} from project ` +
            `${existing.projectId} to ${projectId}`,
        );
      }
      return;
    }
    const entry: SessionIndexEntry = { sessionId, projectId, at: now.getTime() };
    this.entries.set(sessionId, entry);
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

  /** Drops entries past retention and rewrites the file to one line per surviving binding.
   * Throttled to `PRUNE_INTERVAL_MS`, so a burst of session starts does not rescan the whole map
   * per request. */
  prune(now: Date): void {
    if (now.getTime() - this.lastPruneMs < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneMs = now.getTime();
    let changed = false;
    for (const [sessionId, entry] of this.entries) {
      if (now.getTime() - entry.at > this.retentionMs) {
        this.entries.delete(sessionId);
        changed = true;
      }
    }
    if (changed) {
      this.compact();
    }
  }

  /** Session ids currently known, for tests and operator inspection. */
  size(): number {
    return this.entries.size;
  }

  /** Drops the oldest bindings until the map is within `MAX_SESSIONS`. A binding is written once
   * at bind time (see `record`'s first-bind-wins rule) but re-inserted on every `projectOf`
   * lookup, so Map insertion order tracks last-used, not just last-bound: a session still being
   * read to authorize retained events sorts back to the end and is not the one evicted here.
   * Returns whether anything was dropped, so the caller can decide to compact. */
  private enforceCap(): boolean {
    let dropped = false;
    while (this.entries.size > MAX_SESSIONS) {
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
