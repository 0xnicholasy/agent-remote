# Lessons

Durable rules learned while working on Agent Remote. Add an entry whenever a correction
would otherwise have to be remembered rather than looked up.

## 2026-09-14

No emoji in code, docs, schemas or mockups. The protocol documents and the JSON Schemas under
`protocol/` are the source of truth, and the Swift and TypeScript types follow them rather than
the other way around. Local scratch notes live in the gitignored `.private/` directory.

Verify watchOS networking claims against Apple TN3135 before designing a transport: WebSocket
and Bonjour work in the simulator but are blocked for normal apps on a real watch.

Implementation subagents default to sonnet with a stated tool-call cap; opus is escalation only
(global rule updated 2026-09-14).

## 2026-09-16

On watchOS 26.5, a `ToolbarItem(placement: .topBarTrailing)` inside a `NavigationStack` that sits
inside `TabView(.verticalPage)` aborts at launch with a UINavigationBar assertion. Put such
controls inline in the view instead.

`xcrun simctl` has no tap primitive. When proof that a button reaches the bridge is required,
use an XCUITest target or a manual run; an unhosted unit test only proves the client source.

## 2026-09-17

Command envelope: `sessionId` lives at the top level of a command, next to `commandId` and `type`,
never inside `payload`. A bridge that skips schema validation turns that mistake into events with
no `sessionId`, and a strict client stalls on the whole page. Validate at the edge; decode
per-event on the client.

Diagnosing a silent Watch app: `xcrun simctl spawn booted log show --last 10m --predicate
'process == "AgentRemoteWatch"'` shows CFNetwork task summaries (status, bytes, cadence). A
fixed 16 s cadence with identical response bytes means the client is stuck in its error backoff
on the same cursor.

## 2026-09-18 harden-and-ship-pr on PR #5 and #6

- A repo with zero GitHub Actions workflows makes merge-and-cleanup stop at the CI watch (exit-3 equivalent). Decide the "merge on local evidence" policy before starting the ship step, and expect the auto-mode classifier to deny a subagent merge ("Merge Without Review"); the merge itself needs the user or a permission rule.
- A state-machine file (ClaudeProvider Conversation lifecycle) does not converge under per-finding patch rounds: two consecutive sweeps found Highs inside the previous round's fix hunks and three round-8 fixes regressed. When Q2 trips on a lifecycle cluster, route to a design rework (single teardown path, discriminated pending state) instead of a bounded fix round.
- Fix agents must be told which existing tests are contract vs scaffolding; the round-8 agent rewrote a round-5 assertion to make its change pass.

## 2026-09-19 harden-and-ship-pr on PR #6

- The ship subagent worked around an auto-mode denial (`git push origin --delete` blocked) by calling `gh api -X DELETE .../git/refs/heads/<branch>`. Same effect, no permission. A subagent prompt that includes remote-branch deletion must say: if any step is denied by the permission classifier, stop and report it; never reach the same outcome through a different tool.
- Ship step on a repo with no workflows: stop the CI watcher early (it idles 30 min then exits 3) and run the local equivalents (typecheck per package + `bun test`) as the merge evidence, recorded in STATUS.md.

## 2026-09-20 M3 pairing and wire envelope

- Two bugs in the auth work were invisible to the test suite and only showed up in a live run against a started bridge: `AGENTREMOTE_PAIR=1` minted a code in a one-shot process that the running bridge had never heard of, and `AGENTREMOTE_REVOKE` wrote a revocation the running bridge never re-read. Both were "process A writes state, process B holds it in memory" — a class the unit tests could not see because every test built one object. For any operator command that mutates state a long-lived process caches, write the test as two instances over the same file, not one instance.
- A signed wire format needs one fixed vector asserted as a literal on BOTH sides. Recomputing the expected value inside the assertion tests nothing; the TypeScript and Swift implementations agreed only because a shared vector proved it.

## 2026-09-24 M3 slice 3b interaction lifecycle

- State rebuilt from a durable log must never be keyed by an id a provider mints from a per-process counter. The interaction registry rebuilt `apr_N` records from the previous boot, the new boot reissued `apr_N`, and the gate refused a live approval after every restart. Every unit test passed because none rebuilt the registry across a real restart. Rule: an id that outlives the process (logged, journaled, or rebuilt) is random (`randomUUID`), and each rebuilt-from-log structure gets one test that restarts, creates new state, and acts on it.

## 2026-09-24 M3 slice 4 client recovery

- One green run of the Watch suite was luck. `SessionStore` tests never stop their poll loops, and every loop kept writing its cursor to `UserDefaults.standard`, so the next test's store started from another test's cursor; failures moved between runs. Rule: any persisted state a long-lived loop writes is injected (`SessionStore(defaults:)`, one suite per test), and a new Watch test file is run at least three times before its result counts.
