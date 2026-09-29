# Agent Remote task board

Last updated: 2026-09-29

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
- [x] 2026-09-25 (branch `chore/root-lint-typecheck`): root `bun run typecheck` runs every TypeScript workspace's `typecheck` (exits non-zero on a type error), and `bun run check` runs it then `bun test`. CONTRIBUTING points at them.
- [x] 2026-09-25 (branch `chore/biome-lint`): Biome 2.5.14 lints the TypeScript workspaces with its recommended preset; `bun run lint` runs it and `bun run check` runs lint, typecheck, then tests. `noNonNullAssertion` is off (103 bounds-checked assertions); formatting is not enforced.
- [ ] Keep related-project research (claude-watch, agent-watcher, codex-apple-watch, iOS-vibebuddy, and mimi-remote) bounded to concrete reuse or contribution questions. It does not block the release path.

## Next tasks (planned 2026-09-29)

Priority order A-F. Each task is independently mergeable. "Inferred" marks a claim taken from reading code or docs rather than running anything; "Unverified" marks an Apple platform claim not checked against a current source. Planned by fable; not yet critiqued by a second reviewer.

Verified facts behind the plan:
- `GET /v1/projects` and `GET /v1/sessions` already exist and are narrowed per device (`bridge/src/server.ts:1081-1094`). No endpoint reports the bridge's provider; `/v1/health` returns only `{ok, bridgeId}`. The Watch client has `sessions()` but no `projects()` (`apps/watchos/Sources/BridgeClient.swift:380`).
- `GET /v1/events` already returns events for every session the device's `allowedProjects` covers (`server.ts:955-1009`), so multi-session needs no bridge change.
- The Claude provider serializes `canUseTool`/`AskUserQuestion` per conversation through `interactionLock` (`providers/claude/src/index.ts:112-116`): one pending approval OR question per session. Several pending interactions only arise across sessions; ceiling `DEFAULT_MAX_SESSIONS = 8` (`index.ts:179`).
- Blocker for A: with the claude provider the bridge seeds `ses_seed` without `session.started`, so the Watch's first Reply calls `createSession()` with `prj_demo`/`mock` and gets 400 `unknown provider: mock` (`server.ts:686`).
- `apps/watchos/project.yml` sets `CODE_SIGNING_ALLOWED: NO` outside the simulator SDK, so there is no device build path today.

### A. Watch drives real Claude (project choice + provider from the bridge)

Goal: a paired Watch learns the bridge's provider and its authorized projects, the user picks a project, and `session.create` goes out with real values. Removes `SessionStore.projectId`/`provider`.
Dependencies: none. Size: 1.5-2 days.
Files: `protocol/typescript/src/index.ts`, `protocol/swift/Sources/AgentRemoteProtocol/*`, `bridge/src/server.ts`, `bridge/src/server.test.ts`, `apps/watchos/Sources/BridgeClient.swift`, `SessionStore.swift`, `SettingsView.swift`, `OnboardingView.swift`, new `ProjectPickerView.swift`, `apps/watchos/Tests/*`, `docs/protocol-v0.md`, `docs/onboarding.md`.

- [ ] 1. Design `GET /v1/bridge` (authenticated, same envelope as `/v1/projects`) returning `{ bridgeId, provider, capabilities, maxSessions }`. Add `BridgeInfoResponse` next to `ProjectsResponse`. A new route rather than widening `/v1/health` (unauthenticated, must stay minimal) or the pair response (seen once). `provider` stays required on `SessionCreatePayload`, so no command schema change.
- [ ] 2. Add a schema file only if HTTP response schemas already live in `protocol/schema` (inferred: only command/event schemas exist; if so, add the shared JSON vector to the TS and Swift decode tests instead).
- [ ] 3. Bridge: route after `/v1/projects`; add optional `readonly maxSessions?: number` to `AgentProvider` (claude returns its ceiling, mock omits it). Tests: unauthenticated 401, paired returns body, claude provider reports `provider: "claude"`.
- [ ] 4. Swift protocol: confirm `Project` and `Session` decode; add `BridgeInfo`. Shared vector test on both sides.
- [ ] 5. `BridgeClient`: add `bridgeInfo()` and `projects()` (signed GETs like `sessions()`); add both to `BridgeClientProtocol` and every test fake.
- [ ] 6. `SessionStore`: replace the static constants with `bridgeInfo`, `projects`, `selectedProjectId` (persisted under `dev.agentremote.watch.projectId`, cleared when `bridgeId` changes). Load in `start()` after pairing check and in `reconnect()`. `createSession()` uses `bridgeInfo.provider` and `selectedProjectId`; one project auto-selects, otherwise status line "Pick a project".
- [ ] 7. Map `session_limit` (429) in `BridgeError.from` and `ActionOutcome.classify` as a retryable failure with its own text.
- [ ] 8. UI: `ProjectPickerView` (list, checkmark, name + last path component), linked from a Settings "Project" row and an onboarding step after pairing when `projects.count > 1`. "Create session" disabled until a project is selected. Settings shows `Agent: <provider>`.
- [ ] 9. Tests (XCTest): single project auto-selects; multi-project requires a selection; bridge id change clears the selection; `createSession` sends the provider from `bridgeInfo`. Bun: one `session.create` round trip with the claude provider fake asserting the real project id.
- [ ] 10. Docs: `/v1/bridge` row in `protocol-v0.md`; project step in `onboarding.md`.

Finish line: simulator Watch paired to a bridge started with `AGENTREMOTE_PROVIDER=claude AGENTREMOTE_PROJECT_DIRS=/abs/a,/abs/b` picks project b, sends a prompt, and the bridge log shows `session.started` with `prj_b_<hash>` then a real `approval.requested`. `bun run check` and Watch unit tests pass.
Risks: the `AgentProvider` change touches mock, claude and every test fake (Medium); auto-select hides the picker on first use, so Settings must still show the active project (Low).

### B. Multi-session and multiple pending interactions on the Watch

Goal: the Watch tracks every session visible to the device, keeps a pending queue keyed by approval/question id, resolves cards only by id, and offers an inbox first page plus a session list.
Dependencies: A. Size: 3-4 days, in 4 PRs. No bridge change for B1-B3.
Files: `SessionStore.swift` (split into `SessionStore.swift` + new `SessionModel.swift` + `PendingInteraction.swift`), `RootView.swift`, new `InboxView.swift`, `SessionListView.swift`, `ChoiceCardView` call sites, `apps/watchos/Tests/SessionStoreTests*.swift`, `docs/protocol-v0.md` (client rules).

B1. Pending queue + id-checked resolution (1 day, no UI change)
- [ ] 1. `struct PendingInteraction: Identifiable { id, sessionId, projectId, kind, payload, receivedAt, expiresAt: Date? }` from `approval.requested` (binding.expiresAt) and `question.requested` (optional `expiresAt`, nil sorts last).
- [ ] 2. `SessionStore.pending: [PendingInteraction]` becomes the source; keep computed `pendingApproval`/`pendingQuestion` for the selected session so views compile unchanged.
- [ ] 3. `apply()`: `approvalResolved`/`questionAnswered` remove by id only (fixes the unconditional clear at `SessionStore.swift:646/660`); `sessionCompleted` and fatal `error` remove that session's entries; a 1 s tick drops entries past `expiresAt` and writes "Expired" to the transcript.
- [ ] 4. `decide()`/`isCurrent(card)`/`clearCard` look up by id; `answer(...)` takes the session id from the entry.
- [ ] 5. Tests: two sessions each raise an approval, resolving one leaves the other; resolving a non-pending id is a no-op; expiry removes only the expired entry.

B2. Per-session state (1 day)
- [ ] 6. Move per-session fields (transcript, turnState, currentTurnId, awaitingLocalTurnStart, localResolvedTurnId, unconfirmedSend, unconfirmedCancel, lastApproval, lastQuestion) into `@Observable final class SessionModel` in `SessionStore.sessions: [String: SessionModel]`; `selectedSessionId` replaces `sessionId`. Remove the "Ignored session" branch (`apply()` ~592-596) and the bind-on-first-event fallback (~610).
- [ ] 7. `discardLocalView`/`resetSessionState`/`truncated` clear the dictionary; the gap line goes into every surviving model. `session.completed` keeps the model readable but hides Reply/Stop.
- [ ] 8. Tests: interleaved events for two sessions give two transcripts; cancel on A leaves B's pending entry; reconnect clears both.

B3. Inbox page (0.5-1 day)
- [ ] 9. `InboxView` becomes the first TabView page (Inbox, Conversation, Sessions, Settings). Sort by soonest `expiresAt` (nil last), then `receivedAt`. Row: project name, title/text, `m:ss` countdown. Tap selects the session and opens its card.
- [ ] 10. Empty state "Nothing waiting"; `"N more waiting"` badge under the active card when `pending.count > 1`.

B4. Session list, per-session Stop, auto-advance (0.5-1 day)
- [ ] 11. `SessionListView`: project, state pill, waiting count, "New session" (uses A's picker). Selecting a row switches `selectedSessionId`; Stop and `cancel()` act on the selected model.
- [ ] 12. Auto-advance: after an acknowledged decision, select the next pending entry's session and scroll to its card. Settings toggle "Advance to next request", default on.
- [ ] 13. Tests: sort with mixed nil/non-nil expiry; auto-advance picks the soonest-expiring entry; badge count.

Finish line: against the mock bridge with two sessions both raising approvals, the inbox lists two rows with countdowns, answering the first advances to the second, and the bridge log shows each `approval.resolved` with the right id. 60+ Watch tests green.
Risks: B2 extraction from a ~1000-line `SessionStore` is the highest-regression step; port the existing 43 tests first (High). Two cards arriving at once must not both speak; speak only the selected session's card (Medium). The mock may need a scripted second-session scenario (Low).

### C. Physical Watch on LAN (M1 feasibility run)

Goal: the app runs on a real Watch against the Mac bridge over home Wi-Fi with auth on, and the M1 numbers are recorded.
Dependencies: A. Size: 1 day setup + 1 day measurement.
Files: `apps/watchos/project.yml`, `docs/networking.md`, new `docs/m1-feasibility.md`, `docs/onboarding.md`.

- [ ] 1. Start the bridge with `AGENTREMOTE_PROVIDER=claude AGENTREMOTE_HOST=<Mac LAN IP>` (or `0.0.0.0`), auth ON. Fix the stale "no auth" wording of the `warnNoAuth` message (`server.ts:1247`) in the same PR. Accept the macOS firewall prompt for `bun`.
- [ ] 2. Device signing in `project.yml`: `CODE_SIGNING_ALLOWED: YES`, `CODE_SIGN_STYLE: Automatic`, `DEVELOPMENT_TEAM` from an untracked `Local.xcconfig`; keep the simulator ad-hoc path. Unverified: whether a free personal team can install a standalone `WKWatchOnly` app.
- [ ] 3. Install from Xcode with the Watch as run destination (inferred: via the paired iPhone); trust the developer profile on the Watch.
- [ ] 4. Enter `http://192.168.x.y:8787` in onboarding and pair with the printed code.
- [ ] 5. ATS: `NSAllowsLocalNetworking` is set; confirm a numeric RFC1918 IP is covered on watchOS 26 (Unverified). Record whether any local network prompt appears.
- [ ] 6. Measure into `docs/m1-feasibility.md`: approval-to-card latency (10 foreground samples); reconnect time after wrist-down at 30 s, 2 min, 10 min; whether the long poll survives screen off; battery % over 30 min; dictation and on-device speech on hardware.

Finish line: one real approve/deny/question/dictation/Stop loop completed on the physical Watch with auth on, and the feasibility table filled with numbers.
Risks: signing/provisioning eats the day (High); suspend/wake numbers will look bad, which is what M1 is for.

### D. Background alerts (ADR 007)

Goal: decide how an approval reaches the wrist when the app is not in the foreground.
Dependencies: C numbers. Size: 2-3 days of experiments, then the ADR.
Files: new `docs/adr/007-background-delivery.md`, `docs/networking.md`, experiment branches only.
Options (watchOS API details from memory, Unverified for watchOS 26):
1. Local notifications scheduled while foregrounded: cannot alert about a request that arrives after suspend. Keep only as an expiry warning for a card already shown.
2. Background app refresh + background `URLSession` fetch of `/v1/events`: system-budgeted, minutes-scale. Cheapest to try; likely too slow for a 5-minute approval TTL.
3. APNs push to the standalone Watch app, sent by the Mac bridge with a token-based key: no third-party server, needs a paid Apple developer key and internet on the Mac. Best latency; payload says only "1 request waiting", details fetched on open.
4. `WKExtendedRuntimeSession`: session types do not fit a dev tool (App Review risk) and are time-limited. Rejected.
5. iPhone companion (WatchConnectivity + phone notification forwarding): reintroduces the iPhone dependency; fallback only.

- [ ] 1. Spike options 2 and 3 behind `#if DEBUG` flags, one branch each.
- [ ] 2. Measure request-to-alert latency with wrist down for 1, 5 and 15 min, 10 samples each, plus battery.
- [ ] 3. Decision rule: cheapest option with p90 latency under 150 s (half the approval TTL); if none, the product stays foreground-only until a relay exists.

Finish line: ADR 007 accepted with the measurement table and the chosen option.
Risks: APNs needs a paid team and key (Medium); background refresh may be throttled on a dev-signed app (Medium).

### E. Away from home (ADR 006 + relay)

Goal: reach the bridge off the home LAN with the smallest first step.
Dependencies: C. Size: 0.5 day for option 1; others later.
Files: new `docs/adr/006-remote-reach.md`, `docs/networking.md`, `docs/onboarding.md`.
Ranked options:
1. User-managed public HTTPS tunnel to the loopback bridge (`tailscale funnel 8787` or `cloudflared tunnel`). Zero app code: the Watch takes the `https://` URL, TLS satisfies ATS and adds the confidentiality ADR 008 lacks, the signed envelope still authenticates. Inferred: watchOS has no third-party VPN, so a plain tailnet does not work from the Watch; only the public Funnel/Tunnel form does. Cost: the bridge becomes internet-reachable behind pairing + HMAC, so re-check pairing-code brute force and `rate_limited`; document as opt-in.
2. Paired-iPhone relay (iPhone on the tailnet, WatchConnectivity to the Watch). Needs an iOS target; only if D picks option 5.
3. Own E2E-encrypted relay (ADR 003 deferred): needs a key exchange the pairing envelope lacks; not before a wire-encryption ADR.

- [ ] 1. Verify `BridgeClient` accepts an https base URL (and a path prefix via `appending(path:)`).
- [ ] 2. Run the loop over cellular through option 1 and record latency.
- [ ] 3. Write ADR 006 with options 2 and 3 deferred.

Finish line: one approval answered from the Watch on cellular through option 1, latency recorded, ADR 006 written.

### F. Mac app: minimal menu bar surface

Goal: replace the CLI for daily use: start/stop the bridge, show the pairing code, list devices and projects, review desk-only approvals.
Dependencies: A, plus a bridge admin path for desk review. Size: 3-4 days.
Files: new `apps/macos/` (XcodeGen, SwiftUI `MenuBarExtra`), `bridge/src/server.ts` (admin routes), `bridge/src/auth/*`, `docs/onboarding.md`.

- [ ] 1. Decision needing sign-off: desk-review auth. Recommended: loopback-only `POST /v1/admin/approvals/:id/accept` gated by a bearer token written to `<stateDir>/admin-token` (0600). Alternative: pair the Mac app as a device with a `deskReview: true` flag bypassing the `deskOnly` gate (`server.ts:803`).
- [ ] 2. Bridge: `GET /v1/admin/interactions` (pending records with `deskOnly` and full action text) and the accept route; both refuse non-loopback peers. Bun tests for both.
- [ ] 3. Mac app skeleton: `MenuBarExtra` with status (running/stopped, bridge id, provider) and Start/Stop spawning `bun run bridge` via `Process` with the chosen env; reads `devices.json`, `pairing.json`, `projects.json` from the state dir.
- [ ] 4. Pairing code view: large text, expiry countdown, "New code" runs `bun run bridge pair`.
- [ ] 5. Devices list with Revoke; projects list with Allow/Deny per device (wraps the CLI).
- [ ] 6. Desk review list: polls `/v1/admin/interactions` every 2 s while open, shows full action text, Allow/Deny.

Finish line: from the menu bar, start the bridge, pair a simulator Watch with the displayed code, trigger a desk-only approval from the mock provider, accept it on the Mac; the Watch card resolves as "Allowed". `bun run check` green; Mac target builds.
Risks: spawning bun from a sandboxed app fails, ship unsandboxed for now (Medium); admin token readable by any process of the user, acceptable for v0, note in ADR (Low).

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
  - 2026-09-25 (branch `feat/bridge-admin-cli`): the operator env-var one-shots (`AGENTREMOTE_PAIR`/`AGENTREMOTE_REVOKE`/`AGENTREMOTE_LIST_DEVICES`) are replaced by a CLI (`bun run bridge pair|devices|revoke|projects list|allow|deny`, bridge/src/cli.ts) and `docs/onboarding.md` walks install through pairing. Watch-side onboarding screens (guided pairing UI, project picker) remain.
  - 2026-09-25 (branch `feat/watch-onboarding`): an unpaired Watch now opens into a first-run onboarding flow (`OnboardingView`) instead of the conversation page -- three steps (Mac setup command, host address, pairing code) reusing the existing `PairingView` form for the last step. `SessionStore.pairingChecked` gates RootView between a launch spinner, onboarding, and the paired TabView. Re-pairing from Settings is unchanged. Project picker remains.
- [x] 2026-09-25 (branch `feat/watch-action-outcomes`): every approve, deny or answer ends in one visible outcome on the Watch (`ActionOutcome`): sending, acknowledged, no longer valid (`interaction_not_pending`, stale 409, `command_id_conflict`), expired (`decision_expired`), offline (URL transport errors), outcome unknown (`command_indeterminate`, previously shown as "no longer valid"), or failed. Offline keeps the card and a repeat of the same choice reuses its `commandId`. Simulator and unit tests only; offline behaviour on a physical Watch is part of the M5 device scenarios.
- [x] 2026-09-25 (branch `fix/watch-outcome-followups`, PR #18 backlog C3-06 and C3-07): a success status with an unreadable command reply is `commandResponseUnreadable` and reads "Reply unreadable. Tap again to confirm." instead of "Not sent"; the card stays and the retry reuses the command id. `cancel()` now keeps the command id and body timestamp of a cancel whose outcome was lost, so tapping Cancel again replays the bridge's recorded outcome instead of sending a second cancel.
- [x] Provide sufficient exact context for a risky or long action, or direct the user to review it at the desk. A spoken summary alone is not authorization context.
  Plan (2026-09-25, branch `feat/watch-approval-context`):
  1. [x] Schema + TS + Swift bindings: optional `titleFidelity` (`exact` | `truncated` | `summary`) and `fullLength` on `approval.requested`; shared `requiresDeskReview` (anything but `exact` is desk-only). Same JSON vector tested on both sides.
  2. [x] Claude provider: `title` is always the exact action (Bash command, file path, or tool name + input) up to 200 chars; the SDK's own title moves to `spokenSummary`; set fidelity and `fullLength`.
  3. [x] Mock provider: `exact` on normal actions, plus one scripted long action for a desk-only card.
  4. [x] Bridge: interaction record carries `deskOnly`; `approval.accept` on a desk-only approval returns 403 `review_at_desk`; reject still works.
  5. [x] Watch: desk-only card shows Deny only and "Review at the Mac before allowing"; `approve()` refuses desk-only; `review_at_desk` maps to "Not allowed".
  6. [x] Docs, tests (bun + XCTest), simulator screenshot of a desk-only card. (desk-only simulator screenshot captured 2026-09-25 before PR #20 merged.)
- [ ] Finish the glanceable conversation/status experience, reviewed dictation, foreground speech, and prominent cancel behavior.
  - [x] 2026-09-25 (branch `feat/watch-reviewed-dictation-cancel`): dictated text is shown in full with its destination ("New prompt" or "Answer to: <question>") before Send; the conversation page shows a confirmed "Stop turn" button while a turn is thinking, running or waiting. Simulator only; dictation itself still needs physical hardware (M1).

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
