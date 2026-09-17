# ADR 004: An append-only event log with integer cursors

## Status

Proposed.

Updated 2026-09-16.

## Context

Clients disconnect constantly. A watch loses the network when an arm drops, an app is
suspended, a phone moves between access points. Every one of those is an ordinary event, not
an error, and the client has to come back and find out what it missed without showing the user
a wrong or duplicated view.

Timestamp cursors are worse than they look: clocks are not monotonic, two events can share a
millisecond, and a cursor of "everything after this instant" is ambiguous at the boundary.
Snapshots are not a substitute for the event tail, but they may be the bounded starting point
needed after restart or compaction.

## Decision

The bridge exposes an ordered event log. Each event gets an integer `eventId` assigned by the
bridge across all sessions in one bridge identity. Clients persist the highest id they have
processed and resume with `GET /v1/events?after=N&wait=S` while that cursor remains valid.

The released bridge must either persist the sequence across restart or pair cursors with a
bridge identity or generation. It must expose the retained range and return an explicit stale
or invalid cursor response when history needed by the client is unavailable. An empty event
list must mean "current," never "the bridge forgot the history you requested."

Providers do not assign ids; the bridge hands them an emitter. A single sequence across all
sessions means a client can hold one cursor rather than one per session, which matters on a
watch.

Commands are the mirror image: each carries a client-generated `commandId` used as an
idempotency key. Re-sending the same command returns the same eventual outcome rather than
acting twice, including when retries overlap the original execution. Reusing an id with a
different command is rejected. Accepted commands and their outcomes are retained durably for a
documented retry window; device scoping of command ids must be decided with authentication.
If a crash occurs after a provider side effect but before its outcome is recorded, the bridge
must reconcile with the provider or expose an indeterminate result; it must not assume that a
durable id makes blindly replaying the action safe.

The log does not by itself define recovery. Before release, the project must choose complete
retained replay, snapshot plus tail, or atomic persisted derived state plus cursor. Pending
approvals and questions, resolved decisions and command outcomes must recover consistently or
be explicitly invalidated with observable terminal results.

## Consequences

Within a valid bridge generation and retained range, integer cursors avoid timestamp ordering
ambiguity and clock synchronisation. Resume and retry become reliable only after the persistence,
range, invalidation and durable-outcome rules above are implemented.

The event log becomes the product's real interface, and every feature has to be expressible as
events. That is a discipline rather than a cost, but it does mean a feature that cannot be
described as a sequence of events needs a design change rather than a special case.

The log cannot grow without bound. Retention, compaction of verbose `command.output` streams,
partial replay and the recovery baseline are unresolved and recorded in `protocol-v0.md`.
Conversation replay also needs retained user prompts and defined semantics for streamed message
chunks, replacements and final values.

The current prototype's log, counter and idempotency maps live only for the bridge process.
Restart resets their guarantees, overlapping in-flight retries do not yet receive the original
eventual outcome, and no retained-range or stale-cursor response exists. These are known gaps,
not supported behavior under this proposed ADR.
