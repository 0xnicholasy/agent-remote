# Agent Remote task board

Last updated: 2026-09-16

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
  3. `approve()` / `reject()` / `answer()` clear the pending card before the POST, so a 409 drops the card with no retry.
  4. Mock allows a new prompt while an approval is still pending; the old approval is orphaned (event 19). Decide whether the bridge should reject or auto-cancel.
  5. Speech on simulator unconfirmed; nav title overlaps card; approval title repeats the verb; mock reject path has no follow-up question; SessionStore not scoped to a session.
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

- [ ] Keep the mock provider available while evaluating real-provider candidates.
- [ ] Use a controlled loopback-only harness to prove prompt, approval, rejection, provider question, supplied-text answer or follow-up, agent response, and interrupt behavior.
- [ ] Verify mid-turn question and follow-up semantics without depending on Watch dictation, pairing, or remote authorization.
- [ ] Measure provider interaction fidelity and command outcome latency, then choose the first provider based on the evidence.

Exit gate: one real provider demonstrates the required interactive semantics through the controlled local harness. This is feasibility evidence only; it does not authorize remote use or count as a task completed away from the Mac.

### M3 - Authenticated, validated, durable control

Dependencies: M2 protocol behavior and M1 connectivity findings.

- [ ] Define the authenticated and encrypted wire envelope, pairing enrollment, device revocation, and project authorization policy.
- [ ] Enforce normative schema validation at every trust boundary and run shared TypeScript/Swift conformance fixtures.
- [ ] Validate every command against device, session, request, project, expiry, and allowed action.
- [ ] Add replay protection and durable idempotency reconciliation so retries cannot apply a decision twice or blindly replay an indeterminate provider side effect.
- [ ] Define interaction lifecycle, expiry, and cancel isolation across concurrent sessions.
- [ ] Recover safely after client and bridge restarts using a defined snapshot, replay, or materialized-state design; specify storage, rehydration, retention, and history policy.

Exit gate: dropped responses, duplicate commands, expired decisions, reconnects, client relaunches, bridge restarts, conflicting device decisions, and multiple simultaneous sessions cannot apply an invalid or stale action. Recovery produces an explicit current, syncing, or disconnected state.

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
