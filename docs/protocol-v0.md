# Protocol v0

This document defines the wire contract between Apple clients and the Mac Agent Bridge, and
the in-process contract between the bridge and a coding agent provider. Version 0 is a draft
and nothing here is stable yet. The JSON Schemas in `protocol/schema/` are the normative form
of the envelopes below; where a schema and this document disagree, the schema is correct.

Updated 2026-09-16. This document separates the current prototype from the guarantees required
before release. The prototype has a mock provider and keeps events, command outcomes and its
event counter in memory. Restarting it loses all three. Requirements below do not imply that
the current bridge implements persistence, authentication, recovery or schema validation.

## AgentProvider interface

A provider adapts one coding agent (Claude Code, OpenAI Codex, or another) to a single
interface. The bridge talks only to this interface, so adding an agent means writing an adapter.

```ts
interface AgentProvider {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  listProjects(): Promise<Project[]>;
  listSessions(projectId?: string): Promise<Session[]>;
  createSession(projectId: string, options?: CreateSessionOptions): Promise<Session>;
  sendPrompt(sessionId: string, text: string): Promise<void>;
  approve(sessionId: string, binding: ApprovalBinding): Promise<void>;
  reject(sessionId: string, binding: ApprovalBinding, reason?: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  answerQuestion(sessionId: string, answer: QuestionAnswerPayload): Promise<void>;
  subscribe(sessionId: string, afterEvent?: number): AsyncIterable<AgentEvent>;
}
```

### Capability flags

Providers differ in what they support, so clients feature-detect rather than assume.

```ts
interface AgentCapabilities {
  approvals: boolean;     // can pause and ask before a sensitive action
  questions: boolean;     // can ask a free-form question mid-turn
  resumeSession: boolean; // a previous session can be resumed by id
  streaming: boolean;     // partial output arrives before a turn completes
  usage: boolean;         // token or cost usage is reported
}
```

## Event envelope

Every event the bridge publishes uses the same envelope.

```ts
interface AgentEvent {
  eventId: number;   // monotonically increasing integer, assigned per bridge
  sessionId: string;
  provider: string;
  type: AgentEventType;
  timestamp: string; // ISO 8601, UTC
  payload: object;   // shape determined by type
}
```

`eventId` is assigned by the bridge and is ordered across all sessions in one bridge identity.
Providers do not choose event ids; the bridge injects an id allocator into each provider. For
an `eventId` to be a durable resume cursor, the released bridge must either preserve the global
sequence across restart or pair it with a bridge identity or generation that lets clients
detect invalidation. The current prototype resets the counter on restart and has no identity or
generation field, so its cursor is valid only for the lifetime of one process.

### Event types

Lifecycle events are `session.started`, `session.completed`, `turn.started` and
`turn.completed`. Progress events are `agent.thinking` (reasoning or status text short enough
for a watch face), `agent.message` (the assistant's visible reply text, distinct from
`agent.thinking`), `file.read`, `file.modified`, `command.started`, `command.output` (a chunk
of stdout or stderr) and `command.completed`. Interaction events are `approval.requested`,
`approval.resolved` (accepted, rejected or expired), `question.requested` and
`question.answered`. The remaining two are `error` for recoverable or fatal failures and
`usage.updated` for token or cost counters.

### `agent.message` payload

```ts
interface AgentMessagePayload {
  messageId: string;
  role: "assistant";
  text: string;
  final: boolean; // false for a streamed partial chunk, true for the last chunk
}
```

Before conversation recovery can be claimed, the protocol must define whether streamed
`agent.message` payloads append chunks or replace the text previously seen for `messageId`, how
the final payload relates to earlier partial payloads, and which representation is retained for
replay. The retained history must also include the user's prompt. `turn.started.prompt` is
currently optional, so replay alone is not guaranteed to reconstruct both sides of a
conversation. These are protocol requirements still to be resolved; they do not change the v0
schema in this document update.

### `question.requested` payload

The Watch's choice card renders directly from this payload: `text` is the question, `options`
are 2-4 tappable choices, and `allowFreeText` says whether a "dictate other" button should also
be offered.

```ts
interface QuestionOption {
  id: string;
  label: string;
}

interface QuestionRequestedPayload {
  questionId: string;
  turnId: string;
  text: string;
  options: QuestionOption[];
  allowFreeText: boolean;
  spokenSummary?: string; // short plain sentence for text-to-speech
}
```

### `question.answer` command payload

An answer is either a tap on one of the offered options or dictated free text. Exactly one of
`optionId` or `text` is present. This exclusivity must be enforced by the JSON Schema and both
language bindings, and checked when the bridge accepts a command.

```ts
type QuestionAnswerPayload =
  | { questionId: string; optionId: string }
  | { questionId: string; text: string };
```

### Speaking a request aloud

`approval.requested` and `question.requested` both carry an optional `spokenSummary`: a short
plain sentence the bridge composes so the Watch can read the request aloud with on-device
speech synthesis instead of speaking the full title, detail or option list verbatim. A client
that ignores `spokenSummary` can still fall back to composing something from `title`/`text`.

## Command envelope

Clients send commands. The envelope mirrors the event envelope so both directions look alike.

```ts
interface Command {
  commandId: string;  // UUID, generated by the client, used as the idempotency key
  sessionId: string;
  type: CommandType;
  timestamp: string;  // ISO 8601, UTC
  payload: object;    // shape determined by type
}
```

The required idempotency guarantee is that a retry with the same command identity and the same
payload returns the same eventual outcome without executing the command twice. A response may
mark the request as a duplicate, but that marker does not replace or change the original
outcome. If the first request is still running, retries must wait for or refer to that same
outcome; a temporary `accepted: false` response is not equivalent to the eventual result.

Reusing a command identity with a different type, session or payload must be rejected. The
protocol must decide whether command identity is global to a bridge or scoped to an authenticated
device. The released bridge must durably retain accepted commands and their outcomes for its
documented retry window, including across restart. The current prototype keeps completed and
in-flight command ids only in process memory, and its overlapping in-flight response does not
yet satisfy the required eventual-outcome behavior.

Durable ids alone cannot promise exactly-once provider side effects. If the bridge crashes after
a provider acts but before the outcome is recorded, recovery must reconcile with the provider or
report an explicit indeterminate outcome. It must not blindly replay a potentially completed
sensitive action.

Command types are `prompt.send`, `approval.accept`, `approval.reject`, `session.cancel`,
`question.answer` and `session.create`. The two approval commands carry the full binding
described below.

`session.create` carries a `projectId` and a `provider` and asks the bridge to start a new
session. Its envelope still has a `sessionId` field, because the envelope is uniform, but no
session exists yet when the command is sent: the client puts a fresh identifier there and the
bridge does not route on it. The real identifier comes back in the command response as
`sessionId`, and the same identifier appears on the `session.started` event the new session
emits.

### Mapping provider decisions onto approval commands

Each provider expresses an approval decision in its own vocabulary. The adapter translates in
both directions, and the mapping is not lossless.

| Provider vocabulary | Protocol command | Note |
| --- | --- | --- |
| Codex `accept` | `approval.accept` | Direct equivalent. |
| Codex `acceptForSession` | Unsupported | A standing session grant cannot be represented as a single approval. |
| Codex `decline` | `approval.reject` | Direct equivalent. |
| Codex `cancel` | Unsupported | Cancelling a turn is not equivalent to rejecting one action. |
| Claude `canUseTool` allow | `approval.accept` | Direct equivalent. |
| Claude `canUseTool` allow with `updatedInput` | Unsupported | The modified action cannot satisfy a binding to the original action. |
| Claude `canUseTool` deny with a message | `approval.reject` | The message maps to `reason`. |

These distinctions must not be translated lossily. `acceptForSession` needs an explicit grant
scope, `updatedInput` needs a payload and binding model for the modified action, and provider
`cancel` needs turn-cancellation semantics distinct from rejecting a tool call. Until the
protocol represents them, adapters must report them as unsupported rather than silently
downgrading them to an existing command.

## HTTP API v1

- `POST /v1/commands` submits one command envelope.
- `GET /v1/events?after=N&wait=S` long polls for events with `eventId > N`, waiting up to `S` seconds.
- `GET /v1/sessions` lists known sessions.
- `GET /v1/projects` lists known projects.
- `POST /v1/sessions/:id/cancel` is a convenience form of `session.cancel`.

`GET /v1/events` returns immediately when events newer than `N` already exist. Otherwise it
holds the request open until an event arrives or `wait` seconds elapse, then returns an empty
list. The bridge caps `wait` at 30 seconds.

## Reconnect semantics

A client stores the highest `eventId` it has processed as `lastSeenEvent` and persists it
across launches, then issues `GET /v1/events?after=<lastSeenEvent>` and replays newer events.
As of 2026-09-20 that cursor survives a bridge restart: the event log is persisted, event ids
are never reused, and the response carries three further fields.

```ts
interface EventsResponse {
  events: AgentEvent[];
  lastEventId: number;
  firstEventId?: number; // oldest retained event id, 0 when the log is empty
  truncated?: boolean;   // the requested cursor sits below firstEventId - 1
  bridgeId?: string;     // same bridge restarted, or a different bridge
}
```

`truncated` is the stale-cursor answer: events between the cursor and this page were dropped by
retention and can never be fetched again, so the client resyncs from the page it was given
rather than treating it as a continuation. An empty list with `truncated: false` genuinely means
current. Command outcomes recover with the same guarantee: a retry of a `commandId` the previous
process applied gets that command's recorded response, and one the bridge died in the middle of
is refused with `409 command_indeterminate` rather than replayed. The contract is
[durability-v0.md](durability-v0.md) and the reasoning is
[ADR 009](adr/009-durable-bridge-state.md).

Still open: provider sessions themselves are not restored, so a restart leaves the conversation
readable but the session gone, and pending interactions do not yet recover or emit an explicit
terminal event on restart.

## Approval binding

An approval decision made on a watch may arrive long after the request, by which time the agent
may have moved on. To make a stale tap harmless, every approval carries a binding.

```ts
interface ApprovalBinding {
  approvalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  actionDigest: string; // hash of the exact action text shown to the user
  expiresAt: string;
}
```

The required behavior is that the Mac rejects an `approval.accept` or `approval.reject` whose
binding does not match the current session, turn, approval, tool call and action digest, or
whose `expiresAt` has passed. `actionDigest` ensures that the decision applies to the action the
user saw, rather than a different action sharing an id.

Questions have the same lifecycle requirement even though their current payload has a smaller
binding: an answer must apply only to the currently pending question in that session and turn.
For approvals and questions, the first valid terminal decision from concurrent clients wins;
later decisions receive an already-resolved or stale result and have no provider-side effect.
Cancelling one session affects only that session and invalidates its pending interactions.
Expiry must be observable, normally through `approval.resolved` or an equivalent terminal
event, so every client can remove stale UI. The current mock behavior is not evidence that all
of these cross-session and concurrent-client invariants are implemented.

## Validation and authenticated envelopes

The bridge must validate every command against the normative JSON Schema before routing it to a
provider. TypeScript and Swift bindings must remain conformant with that schema, including
discriminated payload shapes and the exactly-one rule for question answers. The bridge validates
with ajv against `protocol/schema/command.schema.json` as of 2026-09-17.

Authentication lives beside the command document rather than inside it. The command and event
schemas still contain no signature, key identity or nonce field; those travel as
`X-AgentRemote-*` request headers over a canonical signing string, which is what lets the same
signed envelope wrap a request on a transport that is not HTTP. The contract is
[pairing-v0.md](pairing-v0.md) and the reasoning is [ADR 008](adr/008-pairing-and-wire-envelope.md).

What that buys, and what it does not: a request is attributable to an enrolled device, a replayed
request is rejected, an approval decision past its expiry never reaches a provider, and a
`commandId` is bound to one device and one command body. The wire is still not confidential, the
device key is derived once and never rotated, and the bridge does not authenticate itself to a
client that has not yet paired. v0 must not be described as confidential on the wire, and key
rotation and pairing recovery remain open.

## Open questions

Session creation now has a command type and a route, so the mechanism is settled, but the policy
is not. It is still undecided whether a watch should be able to start a session in any project
the bridge can see or only in a project the Mac has explicitly offered, and the `session.create`
command does not currently carry anything that would let the bridge tell those cases apart. The
placeholder `sessionId` on a `session.create` envelope is a wart that a later version may remove
by making the field optional for that one type.

The unsupported approval mappings above need explicit protocol representation before adapters
may expose them. The recovery model, bridge identity, stale-cursor response, bounded log
retention, durable command-outcome window and authenticated envelope format are now settled
(see [durability-v0.md](durability-v0.md) and [pairing-v0.md](pairing-v0.md)). Compaction of
long `command.output` streams, partial replay, pending-interaction restart policy, conversation
reconstruction rules and runtime schema validation on the Swift side remain open.
