# ADR 002: The Mac is the source of truth

## Status

Proposed.

Updated 2026-09-16.

## Context

State has to live somewhere. The candidates are the Mac running the agent, the clients, or a
shared service. Clients are the worst option: a watch is frequently offline, is wiped and
reinstalled casually, and cannot be trusted to hold anything another device depends on. A
shared service contradicts the local-first goal. That leaves the Mac, but saying so is not
enough, because the interesting question is what happens when two clients disagree or when one
has been disconnected for an hour.

There is also a correctness hazard specific to approvals. If a watch holds a pending approval
locally and the user taps accept two minutes later, the agent may have moved on, the tool call
may have been abandoned, or the action text may have changed. An approval that is only checked
against an identifier can approve something the user never saw.

## Decision

The Mac is authoritative for projects, sessions, turns, events, tool calls, approval requests
and their decisions, connection state, and device registrations. Clients are views and
controllers. A client persists `lastSeenEvent` as a resume hint, but a cursor by itself is not
enough to restore a view after client relaunch or cache loss, even when the bridge has not
restarted or compacted its log. It is also insufficient after bridge restart or log compaction.

The released system must provide a recoverable authoritative state. It may retain enough event
history to rebuild every client view, provide a snapshot followed by an event tail, or persist
derived state atomically with its matching cursor. That choice remains open. Whichever model is
chosen must define bridge identity or generation, restart behavior, retained ranges and an
explicit stale-cursor response so that missing history cannot look like an up-to-date client.

Commands are identified by `commandId`. Safe retry requires the bridge to retain the original
eventual outcome durably for a documented window, reject reuse of the identity with a different
command, and return the same outcome without executing twice. Whether identities are global or
scoped to an authenticated device remains an explicit protocol decision. A crash after a
provider side effect but before recording its outcome requires provider reconciliation or an
explicit indeterminate result; the bridge must not blindly replay a possibly completed action.

Approvals carry a binding of session, turn, approval, tool call and a digest of the action
text, plus an expiry. The Mac refuses a decision whose binding no longer matches the current
pending request. Questions require the same session, turn and request lifecycle even if their
wire payload differs. The first valid terminal answer from concurrent clients wins; later
answers are reported as resolved or stale and have no effect. Cancellation is isolated to one
session and invalidates its pending interactions. Expiry and invalidation are observable so all
clients can converge rather than retain actionable stale UI.

The current mock bridge does not satisfy this complete decision. Its event log, sequence,
session registry and command outcomes exist only in memory; restart invalidates its cursors and
retry knowledge. It also lacks the released recovery and invalidation behavior described above.

## Consequences

Clients become simpler because they do not arbitrate shared state. Once restart, retention and
stale-cursor rules are implemented, a disconnected client can be either current or visibly
behind rather than quietly wrong. Multi-device convergence still requires the bridge to apply
interaction lifecycle rules atomically; sharing an event log alone does not make conflicting
answers safe.

The Mac becomes a single point of failure, which is acceptable because it is also the machine
doing the work. If it is off, there is nothing to control.

The recovery representation, bounded retention, compaction, durable command outcomes and
pending-interaction restart policy do not exist yet. Conversation recovery additionally
requires retained user prompts and defined streamed-message replay semantics. These are
pre-release requirements recorded in `protocol-v0.md`, not guarantees of the prototype.
