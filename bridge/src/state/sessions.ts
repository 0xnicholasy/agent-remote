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
    if (dropped) {
      this.journal.rewrite([...this.entries.values()]);
    }
  }

  projectOf(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.projectId;
  }

  /** Binds a session to a project. The first binding wins: re-binding an existing session to a
   * different project would silently re-scope every retained event of that session, which is an
   * authorization decision, so a conflicting rebind is reported and ignored instead. */
  record(sessionId: string, projectId: string, now: Date): void {
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
  }
}
