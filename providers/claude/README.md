# Claude Code provider

Last updated: 2026-09-17

`@agentremote/provider-claude` implements `AgentProvider` for Claude Code, using the Claude
Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned at `0.3.274`). It is registered in the
bridge behind `AGENTREMOTE_PROVIDER=claude` and passed M2's controlled loopback experiment: see
the event log below, produced by a real Claude Code session writing a real file.

The adapter keeps one SDK conversation (a streaming-input `query()` call) alive per Agent
Remote session, so `sendPrompt` calls append to the same conversation instead of spawning a
process per turn. It never attaches to a terminal the user already has open.

## Configuration

- `AGENTREMOTE_PROVIDER` — `mock` (default) or `claude`, read by `bridge/src/server.ts`.
- `AGENTREMOTE_PROJECT_DIRS` — comma-separated absolute paths, one per project. Each project's
  id is derived from the directory's basename plus a digest of the full path, so ids are stable
  across restarts and collision-free when two projects share a basename. Defaults to
  `process.cwd()` when unset.
- Claude Code's own auth (`claude login` / an API key in the environment) must already be
  configured; the adapter does not manage authentication.
- `AGENTREMOTE_HOST` — the hostname `bridge/src/server.ts` binds to. When unset and
  `AGENTREMOTE_PROVIDER=claude`, the bridge defaults to `127.0.0.1` (loopback only), because
  the claude provider executes real tool calls on this host and the bridge itself has no
  authentication. Set `AGENTREMOTE_HOST` explicitly to bind elsewhere; binding the claude
  provider to a non-loopback address logs a startup warning. The mock provider is left on
  Bun's own default (all interfaces) when `AGENTREMOTE_HOST` is unset, unchanged from before.

## `canUseTool` mapping

- `AskUserQuestion` → `question.requested`/`question.answered`. Only the first question in the
  tool call's `questions` array is surfaced (the protocol's `QuestionRequestedPayload` carries
  one question); `allowFreeText` is always `true` since the SDK adds an "Other" choice to every
  `AskUserQuestion` call automatically. An answer resolves the tool call via `canUseTool`'s
  `allow` result with `updatedInput` shaped as the SDK's `AskUserQuestionOutput`
  (`questions`, `answers`, and `response` for free text) — this is the SDK's only channel for
  returning a question's answer, and is a different mechanism from an approval's `updatedInput`.
- Any other tool → `approval.requested` with a full `ApprovalBinding` (`approvalId`,
  `sessionId`, `turnId`, `toolCallId`, `actionDigest` over the exact title shown to the user,
  `expiresAt` five minutes out). `approve()` verifies every binding field and expiry before
  resolving `canUseTool` with `{ behavior: "allow" }` — **never** `updatedInput`, since the
  protocol marks a modified action as unsupported for approvals (the modified action cannot
  satisfy the binding the user saw). `reject(reason)` resolves with
  `{ behavior: "deny", message: reason }`.
- While an approval or question is pending, `sendPrompt` throws `InteractionPendingError`.
- `cancel()` denies any pending approval/question (so the blocked `canUseTool` call does not
  hang), calls the SDK query's `interrupt()`, and emits `session.completed` with
  `reason: "cancelled"`. Cancelling one session never touches another session's pending
  approval or question — each session owns its own conversation state.

## Unsupported (per docs/protocol-v0.md's mapping table)

- `canUseTool` allow with `updatedInput` on an **approval** — the adapter never returns it for
  approvals; the protocol has no binding model for a modified action.
- Turn-cancellation as a substitute for rejecting one tool call — `cancel()` ends the turn, it
  does not reject a specific pending tool call as if the user had declined only that one.
- `resumeSession` — capability is `false`. The adapter keeps one long-lived streaming-input
  conversation per session instead of resuming by SDK session id, so there is nothing to resume
  across bridge restarts yet.

## Tests

```sh
bun run --cwd providers/claude typecheck
bun test providers/claude/src/index.test.ts
```

`src/index.test.ts` uses a scripted fake `QueryFn` (no network or Claude Code process involved)
covering: a prompt producing an `agent.message` and `turn.completed`; an approval accepted and
rejected; a mismatched binding; an expired binding (via the test-only `approvalTtlMs` override);
a question answered by option and by free text; `sendPrompt` refused while an interaction is
pending; and `cancel` interrupting the query, invalidating its own session's pending approval,
and leaving a second session's pending approval untouched.

## Loopback harness (M2 evidence)

```sh
bun run providers/claude/loopback.ts
```

Starts the bridge components in-process with a real `ClaudeProvider` (the real SDK `query`,
not the test fake) against a fresh temp directory, sends "Create a file named hello.txt
containing the word hello", auto-approves the first `approval.requested`, prints every event as
one JSON line, and exits on `turn.completed` or after 120 seconds. A real run (2026-09-17, with
Claude Code already authenticated in this environment) produced:

```
{"eventId":1,...,"type":"session.started","payload":{"projectId":"prj_loopback","resumed":false}}
{"eventId":2,...,"type":"turn.started","payload":{"turnId":"trn_2","prompt":"Create a file named hello.txt containing the word hello"}}
{"eventId":3,...,"type":"approval.requested","payload":{"binding":{...},"kind":"other","title":"Run Write","detail":"hello.txt"}}
{"eventId":4,...,"type":"approval.resolved","payload":{"approvalId":"apr_3","decision":"accepted"}}
{"eventId":5,...,"type":"agent.message","payload":{"text":"`hello.txt` created at `.../hello.txt`, content `hello` (read back, confirmed).","final":true}}
{"eventId":6,...,"type":"turn.completed","payload":{"turnId":"trn_2","durationMs":19455,"summary":"..."}}
{"eventId":7,...,"type":"usage.updated","payload":{"inputTokens":34,"outputTokens":437,"costUsd":0.99167055}}
```

`hello.txt` was written to the temp directory with the expected content, confirming the
approval → tool-execution → completion path works end to end against the real SDK.

Authoritative references:

- [Claude Agent SDK: TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK: handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
