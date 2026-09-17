# Architecture

Last updated: 2026-09-16

This document separates the intended product architecture from the prototype that exists today.
The core direction remains sound: transport carries bytes, provider adapters translate agent
behavior, and the Mac bridge is the authority for sessions it starts.

## Target architecture

```text
+---------------------------------------------------------------+
| Apple clients: Watch first; iPhone and macOS later             |
+---------------------------------------------------------------+
                              |
                  versioned command/event protocol
                              |
+---------------------------------------------------------------+
| Transports: LAN HTTP | paired iPhone | BLE | internet relay    |
+---------------------------------------------------------------+
                              |
+---------------------------------------------------------------+
| Mac bridge: API | durable state | authorization | providers    |
+---------------------------------------------------------------+
                              |
+---------------------------------------------------------------+
| AgentProvider adapters: first provider, then additional ones   |
+---------------------------------------------------------------+
                              |
+---------------------------------------------------------------+
| Bridge-started agent process working in an authorized project  |
+---------------------------------------------------------------+
```

Agent semantics must remain independent from transport. Security objectives are also
transport-independent, but that does not remove the need to authenticate pairing, protect the
initial key exchange, and define confidentiality and integrity for each transport.

## Current prototype

The repository currently has:

- JSON Schemas and handwritten Swift and TypeScript protocol bindings;
- an HTTP bridge with one seeded project/session, an ordered in-memory event array, in-memory
  command idempotency tracking, and a mock provider;
- a standalone watchOS prototype that long polls the bridge and renders a conversation, inline
  choices, reviewed system dictation input, status, settings, speech, and Cancel; and
- a Watch integration test that skips when the mock bridge is not running.

The bridge loses events, command outcomes, pending interactions, sessions, and idempotency records
when it restarts. It has no authentication or runtime JSON Schema validation, and it does not
launch a real coding agent. The Watch stores a host and event cursor in `UserDefaults`; it detects
one simple bridge-reset case when the reported last event id moves backwards. That is useful for a
prototype, but is not recovery or identity handling.

Hardware behavior, background delivery, and an end-to-end Watch app build have not been verified.
The iOS and macOS clients, real providers, BLE, WatchConnectivity relay, and internet relay remain
future work.

## Client responsibilities

Clients render bridge state and submit commands. They may cache data for responsive UI, but they
are not authoritative. They must show connection and freshness state and must not present cached
state as current after connectivity is lost. The bridge must reject stale commands, including
answers that no longer bind to an active interaction.

A durable event cursor is necessary but insufficient. After a reinstall, cache loss, retention
window expiry, bridge restart, or partial write, a client needs one of these consistent restore
contracts:

1. replay from a durable log that still contains all required events; or
2. an atomic materialized-state snapshot paired with the cursor from which replay continues.

The bridge must identify itself across connections and define what a restart or replacement means.
A client cannot infer that safely from a counter alone. Views also need enough retained prompt and
response data to reconstruct the conversation; which event payloads provide that complete record
is not settled yet.

## Mac bridge responsibilities

The production bridge will start and own agent sessions, authorize projects, sequence events,
validate commands, bind approvals and questions to active requests, and expose consistent restore
state. It will not attach to an arbitrary existing terminal or recover a session that it did not
start unless a provider later supplies a trustworthy supported attachment API.

Before a real provider or real LAN control ships, the design must settle and implement:

- durable event storage and retention;
- atomic snapshots or a complete replay contract;
- durable command outcomes and idempotency records;
- durable pending approvals/questions, or explicit invalidation after restart;
- bridge identity, restart epochs, and client resynchronization behavior;
- runtime protocol validation and version negotiation;
- authenticated device enrollment, revocation, and per-project authorization; and
- stale-command and multi-client concurrency rules.

Having one authority makes conflicts decidable; it does not make conflict handling automatic. The
bridge must serialize or reject competing commands and return an outcome that lets every client
refresh its view.

## Provider adapters

One adapter translates protocol commands into a provider's supported API and provider output into
protocol events. The bridge assigns ordering and durability. An adapter also reports capabilities
so clients can distinguish an unsupported interaction from one that has not occurred.

The MVP should implement one real provider before adding a second. Provider-specific cloud access,
authentication, permissions, and sandboxing remain the responsibility of that provider; Agent
Remote adds a remote control boundary and audit trail rather than replacing those controls.

## Security boundary

The current schemas describe application events and commands. They do not yet contain a complete
security envelope, handshake, signature metadata, encryption metadata, or protocol negotiation.
No existing field should be treated as proof that a message is authenticated or confidential.

The required decisions are documented at the product level rather than choosing cryptographic
primitives prematurely: authenticated enrollment, short-lived pairing codes with attempt limits,
device/key identity and revocation, replay protection and idempotency, per-project authorization,
confidentiality policy, and signed and/or encrypted wire envelopes. These decisions must include a
protected initial key exchange. Transport security may add protection, but cannot substitute for a
defined application trust model across forwarded transports.

## Relationship to first-party remote features

Anthropic documents [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
for controlling a local session from its web and mobile surfaces, with optional heuristic push
notifications. OpenAI announced [mobile Codex steering and approvals via a secure
relay](https://openai.com/index/work-with-codex-from-anywhere/) on May 14, 2026.

Agent Remote's intended distinction is a Watch-first interaction, a provider-neutral protocol, and
a local direct-control path that does not require an added Agent Remote cloud relay. Those goals do
not imply that the underlying agent model service or Apple's system dictation is offline.

## MVP boundary

The recommended first slice is one provider, one paired Mac, Watch tap responses, reviewed
dictation, short foreground speech, visible freshness/status, and Cancel. Whether a paired iPhone
is required depends on the physical alert experiment in [Networking](networking.md). A full iPhone
client, BLE, internet relay, and a second provider come later. See the
[roadmap](../tasks/todo.md) for milestone ordering.
