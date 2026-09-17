# ADR 001: Provider abstraction

## Status

Proposed.

## Context

Agent Remote needs to drive at least two coding agents, Claude Code and OpenAI Codex, and
they do not agree on much. They differ in how a session is started, how prompts are sent, how
tool use is reported, whether a session can be resumed, whether the agent ever pauses to ask a
free-form question, and whether token usage is visible at all. They also move quickly, so any
assumption baked into the client layer about one of them is a future breakage.

The alternative to an abstraction is to let each agent's shape reach the clients, either by
passing through raw provider output or by writing a separate client path per agent. Both put
the cost of every future agent onto the watch app, which is the most expensive and least
flexible place in the system to change.

## Decision

Every agent sits behind one `AgentProvider` interface, defined in `docs/protocol-v0.md`. The
interface covers listing projects and sessions, creating a session, sending a prompt, making
approval decisions, cancelling, answering a question, and subscribing to events. Providers
emit only the event types the protocol defines.

Differences between agents are expressed as capability flags rather than as different
interfaces: `approvals`, `questions`, `resumeSession`, `streaming` and `usage`. A client
inspects the flags and adapts its interface, so an agent that cannot ask questions simply
never shows a question view, rather than requiring a separate client build.

Providers do not assign event ids. The bridge owns the id sequence and injects an emitter,
which keeps ids monotonic across the whole bridge rather than per provider.

## Consequences

Adding an agent means writing one adapter and touching nothing else, which is the property we
most want. The protocol documents are enough to write an adapter without reading client code.

The cost is that the interface is a lowest common denominator, and a capability unique to one
agent has nowhere to live until the protocol grows a place for it. We accept that: a feature
that only one provider can offer is a feature the watch client cannot rely on anyway.

A second cost is translation error. An adapter that maps an agent's output onto our event
types can map it wrongly, and the bridge has no way to tell. Adapter tests that assert the
emitted event sequence for a known agent transcript are the mitigation, and the mock provider
exists partly to pin down what a correct sequence looks like.
