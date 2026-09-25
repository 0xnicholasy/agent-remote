# Agent Remote

Last updated: 2026-09-16

Agent Remote is a local-first remote control for coding-agent sessions started and owned by a
bridge on your Mac. The intended first experience is deliberately small: read a short update on
an Apple Watch, tap an answer or review dictated text before sending it, hear a short foreground
reply, check status, and cancel a run.

The direct-control path does not require an additional Agent Remote cloud relay. That does not
mean every dependency is offline: an underlying agent may call its vendor's model service, and
Apple's system dictation may use network services depending on the device, language, and system
configuration.

## Product direction

The recommended MVP supports one agent provider, one paired Mac, Watch tap responses, reviewed
dictation, short foreground speech, status, and Cancel. A physical-device alert experiment will
decide whether the first supported configuration requires a paired iPhone. A full iPhone client,
Bluetooth transport, internet relay, and a second provider follow later.

The bridge controls only sessions that it starts through a provider interface. It does not attach
to arbitrary terminals, scrape an existing TUI, or inject keystrokes into another process.

## Architectural rules

> Agent semantics are independent from network transport.

> The Mac bridge is the authority for sessions, events, commands, and approvals.

The first rule keeps an event or command meaningful whether it travels over LAN HTTP, through a
paired iPhone, or through a later transport. The second makes Apple clients views and controllers.
It also creates a persistence requirement: a cursor alone cannot restore a view after relaunch, so
the production bridge must provide replay or a consistent state snapshot plus cursor. The current
prototype does not provide durable recovery.

## Connectivity order

1. Direct LAN HTTP while the Watch app has execution time.
2. A paired-iPhone path if physical alert testing shows it is needed.
3. Nearby Bluetooth as a later fallback.
4. An optional end-to-end protected internet relay later.

HTTP long polling is the portable baseline for an active app, not a promise that watchOS will keep
the app running in the background. See [Networking](docs/networking.md) for platform constraints
and the release-gating physical-device matrix.

## Current state

This repository contains protocol schemas and Swift/TypeScript bindings, an in-memory Mac bridge
with a mock provider, and a standalone watchOS prototype. The Watch prototype has a conversation
view with inline approval and question choices, status, reviewed system dictation input, settings,
short speech output, and Cancel. Its integration test skips when a mock bridge is unavailable.

The Watch source targets watchOS 26.0 and Swift 6.0 as prototype build settings. They are not a
published support matrix. Hardware behavior, background delivery, and a successful end-to-end app
build remain unverified. Authentication, runtime schema validation, durable bridge state, and real
agent providers are not implemented. The iOS and macOS clients and later transports have not
started.

## Repository layout

| Path | Contents |
| --- | --- |
| `docs/` | Product direction, architecture, protocol, networking, and ADRs. |
| `protocol/schema/` | JSON Schemas for the current event and command envelopes. |
| `protocol/typescript/` | Handwritten TypeScript protocol bindings. |
| `protocol/swift/` | Handwritten Swift protocol bindings. |
| `bridge/` | In-memory HTTP prototype with a mock provider. |
| `apps/watchos/` | Standalone Watch prototype source and integration test. |
| `apps/ios/` | Placeholder for a possible paired-iPhone client or relay. |
| `apps/macos/` | Placeholder for the Mac app. |
| `providers/` | Planned real-agent adapters; not started. |
| `transports/` | Planned transports beyond direct HTTP; not started. |
| `relay/` | Planned optional internet relay; not started. |

## Running the prototypes

```sh
bun install
bun run check   # typecheck every TypeScript workspace, then bun test
bun run dev
```

The protocol Swift package can be tested separately:

```sh
cd protocol/swift && swift test
```

The Watch project is defined in `apps/watchos/project.yml`; its deployment target is a prototype
choice rather than a compatibility commitment.

To pair a Watch to a running bridge, manage paired devices, and authorize projects, see
[Onboarding](docs/onboarding.md).

## Documentation

- [Product direction](docs/product-vision.md)
- [Architecture](docs/architecture.md)
- [Protocol v0](docs/protocol-v0.md)
- [Networking](docs/networking.md)
- [Roadmap](tasks/todo.md)
- [Architecture decision records](docs/adr/README.md)
- [Contributing](CONTRIBUTING.md)

## Related remote products

Anthropic's [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) lets its
web and mobile surfaces control a local Claude Code session and can use heuristic push
notifications. OpenAI announced [Codex steering and approvals from mobile via a secure
relay](https://openai.com/index/work-with-codex-from-anywhere/) on May 14, 2026. Agent Remote's
distinct target is a Watch-first, provider-neutral, local-control experience; it should not be
described as the only remote-control option.

## License

Apache License 2.0. See [LICENSE](LICENSE).
