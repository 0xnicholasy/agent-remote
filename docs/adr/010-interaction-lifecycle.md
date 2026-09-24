# ADR 010: Interaction lifecycle as derived bridge state

## Status

Accepted for v0.

Decided 2026-09-24.

## Context

[ADR 009](009-durable-bridge-state.md) made command identity, nonces, the event log and session
bindings durable, but left one gap named explicitly in both that record and the M3 exit gate:
interaction (approval and question) lifecycle, expiry and cancel isolation across concurrent
sessions were unspecified. Without them, a decision arriving after its interaction was already
resolved, expired, cancelled or superseded could still reach the provider, and a device deciding
another session's interaction could learn or change that session's state.

An interaction already has a state today, but only inside each provider adapter's own bookkeeping
of pending approvals and questions. That state is not visible to the HTTP layer, so the bridge had
no place to refuse a stale decision before calling into the provider, and no way to tell "unknown
interaction" apart from "interaction belongs to a different session" without asking the provider
to check across sessions itself.

Two options were weighed for where this state should live.

1. **Provider-only tracking, made stricter.** Keep the state inside each adapter and require every
   provider to enforce the same session, terminal-state and expiry checks before acting. Cheapest
   change, but it repeats the same logic per provider, and the mock provider had already shipped a
   cross-session leak (it accepted `question.answer` for a questionId belonging to another
   session) that this option does not structurally prevent — a second provider can reintroduce the
   same bug.
2. **A bridge-level registry derived from the event log.** One `InteractionRegistry` observes every
   event after it is durably appended and rebuilds itself by replaying the log on startup. The
   HTTP layer gates a decision against it before the provider ever sees the command, so the check
   is enforced once, in one place, for every provider.
3. **A new durable journal for interaction state**, following the `events.jsonl` /
   `commands.jsonl` shape ADR 009 established. Rejected because the state is fully recoverable from
   the event log already durable under ADR 009; a fifth journal would duplicate data that a replay
   already reconstructs, for no additional guarantee.

## Decision

Option 2, with provider-side checks kept as defense in depth rather than removed.

- Every approval and question is one interaction with states `pending`, `resolved`, `expired`,
  `cancelled`, `superseded`. `resolved` means a device accepted, rejected or answered it.
  `expired` is emitted only by a provider, when its own TTL timer fires — the registry never
  invents an expiry on its own. `cancelled` covers `session.cancel` and provider teardown.
  `superseded` is the agent or SDK withdrawing the request before a decision. All four are
  terminal; a terminal state never moves again.
- `bridge/src/state/interactions.ts` holds this as derived, in-memory state: it is built by
  observing each event as it is durably appended, and rebuilt from scratch by replaying
  `events.jsonl` on bridge startup. It introduces no new journal and no new durability guarantee
  beyond what ADR 009 already gives the event log. It is capped at 5000 records, evicting the
  oldest terminal records first, so a very long run cannot grow it without bound.
- `handleCommand` checks the registry before a decision command reaches the provider. An
  approval whose binding `expiresAt` has passed is refused first with `410 decision_expired`,
  since that reads only the caller's own payload. An interaction id that is unknown to the
  registry or bound to a different session is refused with `409 interaction_not_pending` and
  `state: "not_found"`, the same body for both, so a device probing ids learns nothing. A
  terminal interaction of this session gets the same error with its recorded state. A question
  past its recorded `expiresAt` gets `410 decision_expired`. All of this is enforced with
  `AGENTREMOTE_AUTH=off` too, closing a gap where the auth-off harness had no expiry check. None
  of these refusals create a command journal entry, because nothing was applied.
- Interaction ids are random (`apr_<uuid>`, `qst_<uuid>`) in both providers. A per-boot counter
  would reissue an id the rebuilt registry already holds as terminal, and the gate would then
  refuse a live interaction after every restart.
- Decision commands, `prompt.send`, `session.cancel` and the `POST /v1/sessions/:id/cancel` route
  are serialized per session: one command for a given session runs at a time, so the gate check
  and the provider call it guards cannot interleave within that session. Different sessions do
  not share a lock. `commandId` deduplication is unaffected and stays outside the per-session lock.
  Two devices deciding the same approval: the first to acquire the lock wins and resolves it; the
  second gets `409 interaction_not_pending` with `state: "resolved"`.
- The wire gains the vocabulary needed to express this. `ApprovalDecision` gains `cancelled` and
  `superseded` alongside the existing `accepted`, `rejected`, `expired`. `question.answered` gains
  an optional `outcome` field with the matching four terminal values plus `answered`; `answer`
  stays required and is an empty string when the question was not actually answered.
  `question.requested` gains an optional `expiresAt`. All three additions are additive to already
  optional or newly-added fields, so a client that ignores them keeps working. The Swift
  `ApprovalDecision` type is a strict `Codable` enum rather than a string with an unknown case
  fallback, so a client built before this change would fail to decode an event carrying
  `cancelled` or `superseded`. This is accepted because no client has shipped yet; there is no
  compatibility obligation to protect.
- The mock provider's cross-session `question.answer` bug — it accepted an answer for a
  questionId that belonged to a different session — is fixed in this change, independent of the
  registry gate, because the gate and the provider check are meant to be redundant, not the only
  line of defense.

## Consequences

- The registry is authoritative for the refusal codes above, and provider-side checks continue to
  run underneath it. Keeping both means a provider bug like the mock's cross-session leak is
  caught even if the registry itself has a gap, and the registry catches a provider that forgets
  the check entirely.
- Because the registry is derived rather than separately persisted, its correctness is bounded by
  what the event log already guarantees: an event lost to retention or a torn line under ADR 009
  is also lost to the registry. This is treated as acceptable, since a durable fifth journal would
  have the same retention and torn-line properties as the event log it would duplicate.
- A pending interaction survives a bridge restart as a *state*, because the registry rebuilds from
  the persisted log, but it does not survive as something a decision can still resolve: provider
  sessions are not restored (ADR 009's open item), so a decision arriving for a pending interaction
  after a restart has no live provider session to apply it to. Closing that gap is provider session
  restore, still open, not part of this record.
- The Watch UI response to a truncated event cursor, provider session restore after a restart, and
  the four outstanding pr-10 auth findings are explicitly out of scope for this change and remain
  open work.
