import { requiresDeskReview, type AgentEvent } from "@agentremote/protocol";

/** Hard ceiling on tracked interaction records, oldest terminal record dropped first. A pending
 * record is never evicted (an interaction still awaiting a decision must stay resolvable), the
 * same precedent `CommandJournal.enforceCap` sets for `in_flight` entries: growing past the cap
 * beats losing live state. This bounds the registry's size independent of how many approvals and
 * questions a long-running bridge accumulates, the same way `EventLog` caps events and
 * `CommandJournal` caps commands. */
export const MAX_INTERACTIONS = 5_000;

export type InteractionKind = "approval" | "question";

/**
 * `pending`: requested, no decision yet.
 * `resolved`: the requester's own decision landed (accepted/rejected for an approval, or
 * `question.answered` with outcome "answered"/absent for a question).
 * `expired`: the TTL passed before a decision landed (`ApprovalDecision`'s "expired", or
 * `QuestionOutcome`'s "expired").
 * `cancelled`: the owning session ended or was cancelled while this interaction was still
 * pending (`session.completed`'s fallback for any still-pending record, or an explicit
 * "cancelled" decision/outcome).
 * `superseded`: the agent withdrew or replaced the request before it was decided
 * (`ApprovalDecision`/`QuestionOutcome`'s "superseded").
 */
export type InteractionState = "pending" | "resolved" | "expired" | "cancelled" | "superseded";

export interface InteractionRecord {
  id: string;
  kind: InteractionKind;
  sessionId: string;
  state: InteractionState;
  /** Set for an approval from its binding's `expiresAt`, and for a question that carries a TTL
   * in `question.requested.payload.expiresAt`. Absent when the request carried no deadline. */
  expiresAt?: string;
  /** True for an approval whose `approval.requested` requires desk review (anything but an
   * exact `titleFidelity`, per `requiresDeskReview`, fail closed). Derived from the logged event
   * rather than stored independently, so it is restored correctly by `rebuild`. Absent for a
   * question, and for an approval seen only via a later event (no `approval.requested` observed
   * for it), since desk-only-ness can only be read off the request itself. */
  deskOnly?: boolean;
}

/**
 * Tracks every approval and question the bridge has seen, keyed by its own id
 * (`approvalId`/`questionId`), so the bridge can refuse a decision aimed at another session's
 * interaction or at one that already reached a terminal state — the cross-session bug this
 * registry exists to close (mock.ts's `answerQuestion` never checked `pending.sessionId` against
 * the caller's `sessionId`; `approve`/`reject` already did via `take`).
 *
 * Pure and synchronous: it only reacts to events the bridge has already durably appended, so it
 * carries no journal of its own and is rebuilt from the event log on startup via `rebuild`.
 */
export class InteractionRegistry {
  private readonly records = new Map<string, InteractionRecord>();

  /** Looks up a tracked interaction by its own id. */
  get(id: string): InteractionRecord | undefined {
    return this.records.get(id);
  }

  /** Every interaction still pending for a session, in the order it was requested. */
  pendingFor(sessionId: string): InteractionRecord[] {
    return [...this.records.values()].filter(
      (record) => record.sessionId === sessionId && record.state === "pending",
    );
  }

  /** Feeds one event into the registry. Safe to call for every event type; anything not listed
   * below is ignored. Terminal is terminal: an event that would move an already-terminal record
   * (including moving it to a different terminal state) is ignored, so an out-of-order replay or
   * a duplicate event can never resurrect or relabel a decided interaction. */
  observe(event: AgentEvent): void {
    switch (event.type) {
      case "approval.requested": {
        const { approvalId, expiresAt } = event.payload.binding;
        this.setIfAbsentOrPending({
          id: approvalId,
          kind: "approval",
          sessionId: event.sessionId,
          state: "pending",
          expiresAt,
          deskOnly: requiresDeskReview(event.payload),
        });
        return;
      }
      case "approval.resolved": {
        const state: InteractionState =
          event.payload.decision === "accepted" || event.payload.decision === "rejected"
            ? "resolved"
            : event.payload.decision;
        this.resolve(event.payload.approvalId, event.sessionId, "approval", state);
        return;
      }
      case "question.requested": {
        this.setIfAbsentOrPending({
          id: event.payload.questionId,
          kind: "question",
          sessionId: event.sessionId,
          state: "pending",
          ...(event.payload.expiresAt === undefined ? {} : { expiresAt: event.payload.expiresAt }),
        });
        return;
      }
      case "question.answered": {
        const outcome = event.payload.outcome;
        const state: InteractionState = outcome === undefined || outcome === "answered" ? "resolved" : outcome;
        this.resolve(event.payload.questionId, event.sessionId, "question", state);
        return;
      }
      case "session.completed": {
        for (const record of this.pendingFor(event.sessionId)) {
          this.records.set(record.id, { ...record, state: "cancelled" });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Replaces the current state with what replaying `events` in order produces. Used at startup
   * to restore the pending set from the durable event log, since the registry itself is not
   * persisted. */
  rebuild(events: readonly AgentEvent[]): void {
    this.records.clear();
    for (const event of events) {
      this.observe(event);
    }
  }

  /** Number of tracked interactions, for tests and operator inspection. */
  size(): number {
    return this.records.size;
  }

  /** Inserts a freshly requested interaction, or replays one already known — a record already
   * present here is either the same request seen twice (rebuild, or a duplicate event) or, if
   * terminal, must stay terminal per the class doc. Either way a second `*.requested` for the
   * same id is never a reason to move a terminal record back to pending. */
  private setIfAbsentOrPending(record: InteractionRecord): void {
    const existing = this.records.get(record.id);
    if (existing !== undefined && existing.state !== "pending") {
      return;
    }
    this.records.set(record.id, record);
    this.enforceCap();
  }

  private resolve(id: string, sessionId: string, kind: InteractionKind, state: InteractionState): void {
    const existing = this.records.get(id);
    if (existing !== undefined) {
      if (existing.state !== "pending") {
        return; // terminal is terminal
      }
      this.records.set(id, { ...existing, state });
      return;
    }
    // No `*.requested` was observed for this id (e.g. the event log's retention window already
    // dropped it). The resolution event itself is still authoritative, so a record is created
    // directly from it rather than silently dropping the outcome.
    this.records.set(id, { id, kind, sessionId, state });
    this.enforceCap();
  }

  /** Drops the oldest terminal records until the map is within `MAX_INTERACTIONS`. A pending
   * record is never evicted (see the constant's doc). */
  private enforceCap(): void {
    if (this.records.size <= MAX_INTERACTIONS) {
      return;
    }
    for (const [id, record] of this.records) {
      if (this.records.size <= MAX_INTERACTIONS) {
        return;
      }
      if (record.state !== "pending") {
        this.records.delete(id);
      }
    }
  }
}
