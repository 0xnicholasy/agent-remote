# Contributing

Updated 2026-09-16.

Agent Remote is in Phase 0, so the design documents move faster than the code. Reading
`docs/architecture.md` and `docs/protocol-v0.md` first will save time.

## Building

The TypeScript packages are a Bun workspace. From the repository root:

```
bun install
bun test          # protocol and bridge suites
bun run dev       # starts the mock bridge on http://localhost:8787
```

The shared Swift protocol package is separate and is built with Swift Package Manager:

```
cd protocol/swift
swift build
swift test
```

The Watch prototype is a standalone XcodeGen project described by
[`apps/watchos/project.yml`](apps/watchos/project.yml). Generate and build it with a compatible
Xcode/watchOS toolchain; the presence of generated project files is not evidence that it has
run on a simulator or physical Watch. See the [Watch prototype README](apps/watchos/README.md)
for its verified scope and current limitations.

## Code style

Apple clients and shared Apple code are written in Swift. The current bridge prototype and mock
provider are written in TypeScript and run on Bun. Bun remains the proposed production runtime
until ADR 005 is decided using real-provider and packaging evidence. The protocol itself is
defined by JSON Schema.

The JSON Schemas in `protocol/schema/` are the source of truth for the wire format. A wire-contract
change to an envelope or payload constraint starts there, then updates `docs/protocol-v0.md`, the
Swift and TypeScript bindings, and conformance tests in the same change. If a binding has drifted
from an already-correct schema, fix the binding and its tests without making an artificial schema
edit. A docs-only planning requirement does not change the wire contract.

TypeScript is strict. Do not use `any` or `unknown` unless there is genuinely no alternative,
and leave a comment explaining why when there is not. Do not silence a type error with a lint
disable comment; fix the type.

Do not put emoji in code, documentation, schemas or commit messages. Some of the environments
this runs in render them badly or not at all.

## Pull requests

Keep a pull request to one change. Say what it does and why in the description, and mention
which documents or schemas it affects.

Every change should come with the evidence that it works: a test, a log, or a description of
what was run and what it printed. New behaviour in the bridge or the protocol packages needs a
test in the same style as the existing ones, sized to the behaviour rather than to a coverage
target.

Run the checks that exist for the area you changed: `bun run check` at the repository root
(`bun run lint` with Biome, `bun run typecheck` across every TypeScript workspace, then
`bun test`), and `swift test` from
`protocol/swift` when the Swift package changes. Watch changes need an Xcode build or test with
a compatible installed watchOS destination, and networking/background claims require a physical
Watch result. Record the exact checks and any unavailable toolchain or destination in the pull
request.

Biome lints the TypeScript workspaces with its recommended rules (`biome.json`); formatting is
not enforced. `style/noNonNullAssertion` is off because the code asserts array elements it has
already bounds-checked. A `biome-ignore` comment needs a reason, as a type-check suppression
does. Swift has no linter configured. Do not invent a command or substitute generated-project
existence for a build result.

A change to an accepted decision in `docs/adr/` needs a new ADR rather than an edit to the old
one. Proposed ADRs may be refined while their evidence gates remain open; record the evidence
that supports acceptance when changing their status.
