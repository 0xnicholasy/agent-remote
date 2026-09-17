# Codex provider

Last updated: 2026-09-16

Not implemented. Codex is a candidate for the first real provider, which will be chosen only after the M2 controlled loopback experiment demonstrates the required interactive fidelity.

The planned `AgentProvider` adapter will spawn and own Codex sessions and translate them into [Agent Remote protocol events](../../docs/protocol-v0.md). It will not attach to a terminal the user already has open.

## Candidate integration surface

`codex app-server` is the primary candidate. The locally installed Codex 0.154.0 identifies app-server as experimental and can generate TypeScript bindings and JSON Schema for its own protocol version. The adapter must pin the Codex version, generate or inspect that version's schema, and validate behavior against it rather than copying a method or decision list into this README.

M2 must prove session and turn lifecycle, prompt and mid-turn input, approval and rejection, provider questions, agent responses, interrupt behavior, request resolution, timeout, and process failure through the local harness. The adapter must preserve every decision and scope offered by the tested server; it must not silently map cancel to rejection or a session-scoped grant to a single-action allow.

`codex exec --json` remains a possible bounded, non-interactive fallback. Because it does not provide the required interactive approval loop, it cannot count as the completed MVP provider.

The mock remains available during M2. Passing the experiment selects a provider for later authenticated work; it does not complete the remote Watch MVP.

Authoritative references:

- [Codex App Server documentation](https://developers.openai.com/codex/app-server/)
- [OpenAI Codex app-server source documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
