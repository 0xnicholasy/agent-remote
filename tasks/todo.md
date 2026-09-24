# Agent Remote task board

Last updated: 2026-09-24

Agent Remote lets a user steer short coding-agent interruptions from an Apple Watch while the Mac remains the authority. The first release targets one real provider and one paired Mac on the local network: tap answers, approve or deny, send reviewed dictation, hear short foreground replies, see current/syncing/disconnected state, and cancel. It controls only sessions created through its bridge, not arbitrary terminal sessions that were already running.

## Completed foundation

- [x] 2026-09-14: scaffolded docs, ADR 001-004, JSON Schema protocol, TypeScript and Swift protocol packages, Bun bridge with mock provider, and passing foundation tests.
- [x] 2026-09-16: installed the watchOS 26.5 runtime.

## Current active work

- [x] 2026-09-16: XcodeGen standalone Watch prototype builds and runs on the watchOS 26.5 simulator, renders the mock approval and question cards from live bridge events, and the Swift client loop test completes session.create through turn.completed against the running bridge.
- [x] 2026-09-17: manual simulator run proved app-originated commands. Bridge log shows approval.resolved (accepted and rejected), question.answered with an option id and with free text typed through the Other... sheet, agent.message, turn.completed.
- [ ] Prototype follow-ups, ranked:
  1. Done 2026-09-17: bridge validates commands with ajv and rejects unknown session ids (400). 10 bridge tests pass.
  2. Done 2026-09-17: Watch decodes events one by one, skips unreadable ones, advances the cursor, shows the status line under the state pill. Two smells left: RootView keys visibility off the "Skipped" string prefix, and a malformed page root throws BridgeError.http with status 0.
  3. Done 2026-09-17 (PR #2): `approve()` / `reject()` / `answer()` keep the card until the bridge acknowledges; 409 (stale binding) clears it with a status line, any other failure keeps it for retry; buttons disabled while sending.
  4. Done 2026-09-17 (PR #3): mock refuses a new prompt while an approval or question is pending (409); cancel clears only that session's pending state.
  5. Speech on simulator unconfirmed; nav title overlaps card; approval title repeats the verb; mock reject path has no follow-up question; SessionStore has no client protocol seam so the 409-vs-retry path is untested; SessionStore not scoped to a session.
- [ ] Security review of the first commits (2026-09-17). Cancel route session check landed in PR #1 on 2026-09-17. Bridge authentication landed 2026-09-20 in the M3 slice 1 work, which also closed two gaps found reviewing it: the cancel route was authenticated but not authorized, and the session/event reads ignored per-device project narrowing. The mock provider let a `question.answer` for one session touch another session's question state (not approvals, which were already checked); fixed 2026-09-24 in M3 slice 3b.
- [x] 2026-09-25 (branch `feat/watch-ui-polish`): Watch UI/UX prototype polish. The conversation page drops the navigation title that covered a pending card, and a new card scrolls to sit just below the clock. A resolved approval reads "Denied: Run git push origin main" instead of "Approval rejected". The header mute button is gone (mute stays in Settings) so the page indicator has the right edge. The Watch maps `429 rate_limited` to its own message. Simulator builds are signed ad hoc so pairing can store its keychain credential (was `-34018`). A new `AgentRemoteWatchUITests` target pairs against a local bridge started with `AGENTREMOTE_AUTH=off` and screenshots the idle, approval, post-decision and Settings screens; it skips unless the bridge env vars are set. Status-line visibility already used `statusKind`, and the card title no longer repeats the verb. Full M4 experience stays in M4.
- [ ] Add explicit root lint and typecheck entry points so documentation and CI can invoke the available package checks consistently.
- [ ] Keep related-project research (claude-watch, agent-watcher, codex-apple-watch, iOS-vibebuddy, and mimi-remote) bounded to concrete reuse or contribution questions. It does not block the release path.

## Delivery milestones

### M1 - Physical Watch feasibility

Dependency: foundation only.

- [ ] Measure direct Watch-to-Mac connectivity in foreground and after suspend/wake on the minimum candidate device and OS matrix.
- [ ] Measure user-visible approval/question delivery while the app is inactive. Do not promise unattended wrist operation until this gate passes.
- [ ] Verify reviewed system dictation and short foreground on-device speech on physical hardware.
- [ ] Record alert delivery latency and reliability, reconnection behavior, and battery cost. Choose acceptance thresholds after this feasibility measurement rather than treating prototype observations as release data.

Exit gate: a written feasibility result identifies what works in foreground, what works while inactive, the measured tradeoffs, and whether the release needs an iPhone dependency. Failed background delivery changes the product promise before further UI work.

### M2 - Real-provider loopback feasibility

Dependencies: foundation; may overlap M1 where it does not assume an unproven delivery path.

- [x] 2026-09-19: the mock provider stays available; `AGENTREMOTE_PROVIDER` selects mock or claude.
- [x] 2026-09-19: `providers/claude/loopback.ts` runs six scenarios against the real SDK (approve, reject, question, freetext, bash, interrupt), all passing. Evidence in `providers/claude/README.md`.
- [x] 2026-09-19: mid-turn question and follow-up verified without Watch dictation, pairing, or remote authorization: the `freetext` scenario answers with supplied text mid-turn and a second prompt in the same session recalls it.
- [ ] Measure provider interaction fidelity and command outcome latency, then choose the first provider based on the evidence.
- [ ] Found while running the harness (2026-09-19, fixed in the same change): three SDK defaults resolved a tool call before `canUseTool`, so the command never reached the watch - filesystem settings (`settingSources`), the sandbox Bash auto-allow, and the CLI safety classifier. The fix forces all three back through the permission path; a future provider must be checked for the same class of bypass.

Exit gate: one real provider demonstrates the required interactive semantics through the controlled local harness. This is feasibility evidence only; it does not authorize remote use or count as a task completed away from the Mac.

### M3 - Authenticated, validated, durable control

Dependencies: M2 protocol behavior and M1 connectivity findings.

- [x] 2026-09-20 (slice 1): authenticated wire envelope, pairing enrollment, device revocation, and project authorization policy. Contract in `docs/pairing-v0.md`, reasoning in ADR 008. Encryption is deliberately NOT part of this: the wire is authenticated and replay protected, not confidential, and ADR 008 records why.
- [x] 2026-09-20 (slice 1): shared TypeScript/Swift conformance is a fixed signing vector asserted as literals on both sides (`bridge/src/auth/vector.test.ts`, `RequestSigningTests.swift`). Command schema validation at the bridge boundary landed 2026-09-17; the Swift side still has no runtime schema check of its own.
- [x] 2026-09-20 (slice 1): every command is validated against device, session, request identity, project, expiry, and allowed action. `commandId` is now bound to one device and one body digest; an approval past `expiresAt` is refused with 410 before it reaches a provider.
- [x] 2026-09-20 (slice 2): replay protection and command identity are durable and bounded. Nonces, command identity/outcome, the event log and session-to-project bindings are append-only JSON Lines journals in the state dir, each with retention plus compaction. A retry of a command the previous process applied gets that command's recorded response; one the bridge died in the middle of is refused with `409 command_indeterminate` instead of being replayed. Contract in `docs/durability-v0.md`, reasoning in ADR 009.
- [ ] Define interaction lifecycle, expiry, and cancel isolation across concurrent sessions. This is slice 3b, the next piece of work.
  Slice 3b plan (2026-09-24, branch `feat/m3-slice-3b-interaction-lifecycle`):
  - [x] 2026-09-24: Phase 1 implemented, pending review. Bridge `InteractionRegistry` (`bridge/src/state/interactions.ts`) derived from the event log; gate in `handleCommand` refuses wrong-session or non-pending decisions with `409 interaction_not_pending`; expiry check applies with auth off and to questions; per-session lock around gate + execute; mock `answerQuestion` checks the session id.
  - [x] 2026-09-24: Phase 2 implemented, pending review. Wire change - `ApprovalDecision` gains `cancelled`/`superseded`, `question.answered` gains optional `outcome`, `question.requested` gains optional `expiresAt` (schema, TS, Swift); Claude and mock providers emit the right terminal state on cancel/abort/expiry; Watch removes the card on every terminal state.
  - [x] 2026-09-24: Phase 3 implemented, pending review. Docs - `protocol-v0.md` interaction lifecycle section, `durability-v0.md`, ADR 010.
  - Out of scope: Watch truncated-cursor UI, provider session restore, the four pr-10 auth findings.
- [x] 2026-09-20 (slice 2): bridge-restart recovery is replay from the persisted event log. Event ids are never reused (not even for pruned events), `GET /v1/events` reports `firstEventId` and `truncated` so a cursor below the retained window is explicit rather than silently continued, and the response carries `bridgeId`. Retention: 24 hours and at most 2000 events. Six restart tests in `bridge/src/server.test.ts` plus unit tests in `bridge/src/state/state.test.ts`; 130 bridge tests pass.
- [ ] Slice 4 plan (2026-09-24, branch `feat/m3-slice-4-client-recovery`): Watch client recovery. Auth backlog stays a separate PR.
  - [x] 2026-09-24: `EventsPage` decodes `firstEventId`, `truncated`, `bridgeId`.
  - [x] 2026-09-24: `SessionStore` exposes `syncState` (current / syncing / disconnected); polls with `wait=0` until a page lands, then long-polls.
  - [x] 2026-09-24: A changed `bridgeId` resets cursor, session and transcript (replaces the `lastEventId < cursor` heuristic, kept only as a fallback for a bridge that sends no `bridgeId`).
  - [x] 2026-09-24: `truncated` drops the transcript and pending card, rebuilds from the returned page, and adds a transcript line saying earlier events were lost.
  - [x] 2026-09-24: Watch shows the sync state; tests for each path; docs updated.
- [ ] Client-side recovery landed in slice 4 (2026-09-24): the Watch reads `truncated`/`firstEventId`/`bridgeId` and shows current / syncing / disconnected; 43 Watch tests pass on 5 consecutive runs, the live bridge loop test was skipped (port 8787 was taken by another process). Still open: provider sessions are not restored - after a restart the conversation is readable but the session is gone.

- [x] 2026-09-23 (slice 3a): every `AgentEvent` carries the `projectId` it was emitted under, and `GET /v1/events` authorizes an event against that stamp instead of its session's current binding, so reusing a session id neither exposes nor hides an earlier project's retained events. Events persisted before the field existed still resolve through `sessions.jsonl`. Also in the slice: a partial journal append is truncated back to the previous record boundary, and `SessionIndex.compact` / `EventLog.compact` report a rewrite failure instead of throwing it at the caller. Contract in `docs/durability-v0.md`. 156 bridge tests and 17 Swift protocol tests pass.
- [x] 2026-09-24 (slice 5, branch `feat/m3-slice-5-auth-backlog`): the four pre-existing auth findings from the PR #10 review run. A full device is refused with `429 rate_limited` instead of evicting a still-valid nonce (M-8); nonce expiry and timestamp freshness use a persisted clock watermark, so a clock rolled back after a forward jump cannot replay a pruned envelope (M-9); a retry that lands while the original runs waits for it and gets its outcome (M-11); every journal is opened at startup and an unwritable one stops the bridge with its path (M-15). R2-1 was fixed in slice 3a; R2-3, R2-6 and the ses_seed item were superseded by the per-event project stamp. Low-severity items stay in `tasks/harden-pr/pr-10/deferred.md`. Follow-up: the Watch maps `rate_limited` to a generic HTTP error.
- [x] 2026-09-23: the two accepted risks in `tasks/harden-pr/pr-10/accepted-risk.md` (stale-lock takeover TOCTOU, command map soft cap) are signed off as written.

Exit gate: dropped responses, duplicate commands, expired decisions, reconnects, client relaunches, bridge restarts, conflicting device decisions, and multiple simultaneous sessions cannot apply an invalid or stale action. Recovery produces an explicit current, syncing, or disconnected state.

Slice 2 status (2026-09-20): duplicate commands, expired decisions, unauthorized or unauthenticated commands, and replays across a restart are all refused, and the event log, command outcomes and pairing survive a bridge restart. The gate is still NOT met: interaction lifecycle and cancel isolation across concurrent sessions are unspecified (the remaining M3 item), the Watch client does not surface a truncated cursor, and conflicting-device decisions have no test. That is slice 3.

### M4 - Real Watch experience

Dependencies: M1 delivery decision and M3 control guarantees.

- [ ] Build onboarding, Mac pairing, project authorization, and a Mac control surface.
- [ ] Present clear sending, acknowledged, rejected, expired, and offline outcomes.
- [ ] Provide sufficient exact context for a risky or long action, or direct the user to review it at the desk. A spoken summary alone is not authorization context.
- [ ] Finish the glanceable conversation/status experience, reviewed dictation, foreground speech, and prominent cancel behavior.

Exit gate: a new user can pair one Watch with one Mac, start an authorized session, understand connection and command state, and complete the core loop without setup knowledge from the developer.

### M5 - Recovery tests and pilot acceptance

Dependencies: M1-M4.

- [ ] Run real-device scenarios for approval, rejection, question choice, reviewed dictation, cancel, dropped response, duplicate command, reconnect, client relaunch, bridge restart, expired decision, multi-session isolation, and conflicting device decisions.
- [ ] Verify no invalid or stale decision is applied and that uncertainty is shown explicitly instead of guessed away.
- [ ] Compare measured delivery, outcome latency, blocked time, desk returns avoided, reconnection behavior, and battery cost with thresholds selected from the feasibility data.

Exit gate: all release scenarios pass on the supported device and OS matrix, the pilot completes real tasks away from the Mac, and background user-visible delivery meets its gate before unattended wrist operation is advertised.

## Decisions still required

- ADR 005: bridge runtime (TypeScript/Bun or Swift).
- ADR 006: Watch-first delivery and whether physical-device findings require an iPhone component. A full iPhone client remains deferred.
- ADR 007: background user-visible delivery when the Watch is inactive.
- Minimum supported OS and physical-device matrix.
- License.

Deferred beyond the first release: BLE transport, an internet relay, a second provider, extensive history, and a full iPhone client.
