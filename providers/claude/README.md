# Claude Code provider

Last updated: 2026-09-16

Not implemented. Claude Code is a candidate for the first real provider, which will be chosen only after the M2 controlled loopback experiment demonstrates the required interactive fidelity.

The planned `AgentProvider` adapter will spawn and own headless Claude Code sessions and translate them into [Agent Remote protocol events](../../docs/protocol-v0.md). It will not attach to a terminal the user already has open.

## Candidate integration surfaces

The Claude Agent SDK is the primary candidate. Its current official guide routes tool approvals and `AskUserQuestion` through `canUseTool`, while noting that permission configuration determines whether a request reaches that callback. Headless CLI streaming is an alternative candidate. Neither route is guaranteed until it is pinned to a tested version and exercised with the intended permission configuration.

M2 must prove prompt input, approval, rejection, provider questions, supplied-text answers and follow-ups, agent responses, interrupt behavior, timeout, and process failure through the local harness. The adapter must keep rejection distinct from interrupt or cancel, preserve any provider scope attached to an approval, and report unsupported distinctions as capability limits instead of silently changing their meaning.

The mock remains available during M2. Passing the experiment selects a provider for later authenticated work; it does not complete the remote Watch MVP.

Authoritative references:

- [Claude Agent SDK: handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
