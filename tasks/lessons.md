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

## 2026-09-20 M3 pairing and wire envelope

- Two bugs in the auth work were invisible to the test suite and only showed up in a live run against a started bridge: `AGENTREMOTE_PAIR=1` minted a code in a one-shot process that the running bridge had never heard of, and `AGENTREMOTE_REVOKE` wrote a revocation the running bridge never re-read. Both were "process A writes state, process B holds it in memory" — a class the unit tests could not see because every test built one object. For any operator command that mutates state a long-lived process caches, write the test as two instances over the same file, not one instance.
- A signed wire format needs one fixed vector asserted as a literal on BOTH sides. Recomputing the expected value inside the assertion tests nothing; the TypeScript and Swift implementations agreed only because a shared vector proved it.
