# Durability v0 (M3 slice 2)

Status: implemented 2026-09-20. Companion to `docs/pairing-v0.md`, which defines the
authenticated envelope this document makes durable.

Slice 1 made every command authenticated, authorized and replay protected, but all of that state
lived in the bridge process's memory. A restart therefore lost the event log, the nonce cache and
the command identity map, which meant a retry after a restart could re-apply a decision, a
replayed envelope could be accepted a second time, and a reconnecting watch could not tell a gap
in its history from an empty one. This document defines what the bridge now persists, where, for
how long, and what a client is told when recovery cannot be seamless.

Encryption is still deliberately out of scope, for the reasons ADR 008 records: the wire is
authenticated and replay protected, not confidential. Nothing here changes that.

## Where state lives

All of it sits in the state dir (`$AGENTREMOTE_STATE_DIR`, default `~/.agentremote`), beside the
device registry, written with the same guarantees the registry already had: the directory is
created 0700, files are 0600, and a full rewrite goes through a temp file and a rename.

| File | Holds | Retention |
| --- | --- | --- |
| `devices.json` | Paired devices (slice 1) | Until revoked |
| `pairing.json` | The live pairing code (slice 1) | 5 minutes |
| `bridge-id.json` | This bridge's identity (slice 1) | Forever |
| `events.jsonl` | The event log | 24 hours, at most 2000 events |
| `events.jsonl.watermark` | Highest reserved event id | Forever |
| `commands.jsonl` | Command identity and outcome | 24 hours, at most 5000 commands |
| `nonces.jsonl` | Seen request nonces | 300 seconds (the nonce TTL) |
| `sessions.jsonl` | Session to project bindings | 24 hours |

The four journals are JSON Lines: one record per line, appended as it happens, and rewritten in
full only to compact. Every append is a single line written and fsynced, so a crash can leave at
most one torn line, and a line that does not parse is skipped on load rather than failing the
file — one lost record instead of a lost journal. The fsync is what makes these guarantees hold
across a crash rather than only across a graceful shutdown; a nonce accepted immediately before a
power loss must not become replayable afterwards.

A journal write that fails (full disk, read-only state dir) is reported to the console and
swallowed. Appends happen inside event emission, outside any route's error handling, so throwing
would turn a durability failure into an availability failure.

Two bounds keep the files finite. Retention drops records past their window, and a size cap drops
the oldest beyond it: 2000 events, 5000 command ids, 10,000 nonces per device. Each journal
rewrites itself to its live set on load and again after a fixed number of appends. This is the
"unbounded across a long run" gap slice 1 left open; the size caps matter because retention alone
is a time bound, and an authenticated device can mint command ids as fast as it can sign.

## Replay protection

The per-device nonce cache is unchanged in behavior — 300 second TTL, 10,000 entries per device,
oldest evicted first — but it now writes through to `nonces.jsonl` and rehydrates from it on
startup, dropping anything already expired. A request replayed across a bridge restart is still
refused with `401 replayed_request`.

**Known limits.** Two replay edges are intentionally left open here and tracked as follow-up
work, not fixed in this change:

- **Nonce capacity eviction.** When a device's nonce set hits `MAX_NONCES_PER_DEVICE`
  (`bridge/src/auth/verify.ts`), the oldest recorded nonce is evicted even if it is still inside
  its 300 second validity window, so that specific nonce becomes replayable. Reaching the cap
  requires the attacker to already hold the device key, since a nonce is only recorded after its
  signature verifies.
- **Clock rollback.** Nonce expiry and pruning trust the bridge's wall clock. If the host clock
  jumps forward and then back, nonces can be pruned early and replayed within what should still be
  their TTL. This requires control of the host, and the envelope's timestamp skew check trusts the
  same wall clock, so this is not closed by switching the nonce cache alone to a monotonic clock.

## Command identity

`commandId` remains the idempotency key, and the bridge still stores the SHA-256 of the exact body
and the issuing device alongside it. That record is now durable, and it carries a status:

| Status | Meaning | A retry gets |
| --- | --- | --- |
| `in_flight` | Executing in this process right now | `200` with `accepted: false, duplicate: true` |
| `completed` | The provider applied it | `200` with the recorded response and `duplicate: true` |
| `abandoned` | The provider refused it before applying anything (a mapped 4xx) | Executed again |
| `indeterminate` | Execution started, then the process died | `409 command_indeterminate` |

An `in_flight` record with nothing executing it is treated as `indeterminate` too, which covers
the same-process case: a provider call that throws an unmapped error leaves the bridge unable to
say whether the side effect landed, so the retry is refused rather than run a second time.

A repeat of a known `commandId` with a different body digest or from a different device is still
`409 command_id_conflict`, now across restarts too.

`indeterminate` is the honest answer to the case the exit gate names: the bridge started handing a
command to a provider and does not know whether the side effect landed. Replaying it could apply a
decision twice, and inventing a success could hide one that never happened, so the client is told
to reconcile against the event log instead. Only an unmapped throw leaves a command in this state;
a provider refusal (a stale binding, a turn already running, an unknown session) is recorded as
`abandoned`, because nothing was applied and the same command id is safe to retry.

## Event log and cursors

Events are appended to `events.jsonl` as they are emitted and reloaded on startup, so a client's
`after` cursor still resolves after a restart. Two rules make that safe:

- **Event ids are never reused.** The next id is one past the highest id ever written, even when
  that event has since been pruned, and ids are reserved in blocks of 100 recorded in
  `events.jsonl.watermark` before any id in the block is used. A deleted or fully corrupt log
  therefore costs a gap in the id space, never a repeat: a client holding an old cursor can never
  be served different events under ids it already consumed.
- **A cursor below the retained window is reported, not papered over.** `GET /v1/events` now
  returns `firstEventId` (the oldest retained id, 0 when empty) and `truncated` (true when the
  requested cursor sits below `firstEventId - 1`). `truncated` means events between the cursor and
  the page were dropped by retention and can never be fetched again: the client must resync from
  what it was given rather than treat the page as a continuation. The response also carries
  `bridgeId`, so a client can tell "same bridge, restarted" from "different bridge" without a
  separate health call.

All three fields are optional in the protocol types, so an older client that ignores them keeps
working exactly as before.

## Session bindings

Providers hold sessions in memory, so after a restart `listSessions()` no longer knows the project
of a session that retained events still refer to. `sessions.jsonl` records the session-to-project
binding when a session is seeded or created, and `GET /v1/events` consults it when the provider
cannot answer. The first binding wins: a later attempt to rebind a session to a different project
is reported and ignored, because it would silently re-scope every retained event of that session. Without it, a device narrowed to a project would fail the authorization check on
its own retained events and reconnect to an empty history. Live sessions still take precedence;
the index only fills gaps, and an event whose project cannot be resolved either way is still
dropped for a narrowed device rather than shown.

## What this does not cover

- Provider sessions themselves are not restored. After a restart the conversation is readable but
  the session is gone; resuming a provider session is M4 work.
- Interaction lifecycle, expiry and cancel isolation across concurrent sessions are still open
  (the next M3 item).
- The watch client does not yet read `truncated` or `firstEventId`; it will need to surface the
  gap as an explicit state rather than silently continuing.
