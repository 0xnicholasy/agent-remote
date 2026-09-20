# ADR 009: Durable bridge state as append-only JSON Lines journals

## Status

Accepted for v0.

Decided 2026-09-20.

## Context

[ADR 008](008-pairing-and-wire-envelope.md) made every command authenticated, authorized, expiry
checked and replay protected, but all of that state lived in the bridge process's memory. A
restart therefore lost the event log, the nonce cache and the command identity map. Three
consequences follow directly, and all three are named in the M3 exit gate: a retry after a restart
could re-apply a decision, a replayed envelope could be accepted a second time, and a reconnecting
watch could not tell a gap in its history from an empty history.

[ADR 004](004-event-log.md) already committed to an append-only event log with integer cursors and
listed restart recovery as its acceptance evidence. This record decides how that state is stored.

ADR 005 — bridge runtime, TypeScript and Bun versus Swift — is still open, which constrains
the choice: a storage decision that only works under Bun would quietly decide ADR 005 as a side
effect.

Three options were weighed.

1. **Append-only JSON Lines journals, compacted.** One record per line, appended as it happens,
   rewritten in full only to compact. No new dependency, the same atomic-write path the device
   registry already uses, readable with `tail` during debugging, and portable to any runtime that
   can write a file — including a Swift bridge.
2. **SQLite (`bun:sqlite`).** Transactional, indexed, and retention becomes a `DELETE` with a
   `WHERE`. It is also the better answer at a scale this project does not have: the durable set is
   at most a few thousand events and a day of command ids. It ties the durable format to Bun's
   bundled SQLite before ADR 005 decides the runtime, and it makes an operator reach for a tool to
   read state that today they can read with `cat`.
3. **Periodic whole-file JSON snapshots**, the shape `devices.json` already uses. Simplest of the
   three, and wrong for this data: a crash between snapshots loses the most recent decisions,
   which are precisely the ones the exit gate is about.

## Decision

Option 1. The full contract is [durability-v0.md](../durability-v0.md); this ADR records why.

- Four new journals in the existing state dir — `events.jsonl`, `commands.jsonl`, `nonces.jsonl`,
  `sessions.jsonl` — written 0600 in a 0700 directory, compacted through a temp file and a rename.
- An unparseable line is skipped on load rather than failing the file, so the one torn line a
  crash can leave costs one record.
- Every journal bounds itself twice: retention (24 hours) plus a size cap (2000 events, 5000
  command ids, 10,000 nonces per device), with compaction after a fixed number of appends.
- Every append is fsynced, so the durability claims survive a crash and not only a clean
  shutdown; a failed journal write is logged and swallowed rather than thrown, because appends
  run inside event emission where a throw would be an availability failure.
- Command outcomes are recorded with a status, and a command whose execution was cut short by a
  crash is `indeterminate`: a retry is refused with `409 command_indeterminate` rather than
  replayed or answered with an invented success.
- Event ids are never reused, even for pruned events, and `GET /v1/events` reports `firstEventId`
  and `truncated` so a client below the retained window learns it has a gap.

## Consequences

- Restart recovery is testable without a database: the tests construct a second bridge over the
  same state dir, which is exactly what a restart is.
- A JSON Lines file is not transactional. Two bridge processes sharing one state dir would
  interleave appends and clobber each other's compactions. One bridge per state dir is already the
  assumption (the pairing code and the bridge id share it); this makes the cost of breaking that
  assumption higher, and enforcing it is not yet implemented.
- Retention is a product decision disguised as a storage constant: 24 hours and 2000 events mean
  the watch can recover the recent conversation, not the full history. Reading a full transcript
  stays a Mac task.
- `truncated` and `firstEventId` are on the wire but not yet read by the Watch client, so today a
  gap is detectable by the protocol and not yet surfaced in the UI. That is M4 work.
- Provider sessions are still not restored. The events survive; the session does not.
- Two known and accepted leaks, both carried over from slice 1's shape rather than introduced by
  the storage choice: `firstEventId` and `lastEventId` are global maxima, so a device narrowed to
  one project can infer the total event volume of projects it cannot read; and the state dir's
  permissions are only set when the bridge creates it, so pointing `AGENTREMOTE_STATE_DIR` at a
  pre-existing world-writable directory exposes prompt text and live nonces.
