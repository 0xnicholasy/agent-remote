# ADR 003: Local-first networking

## Status

Proposed.

Updated 2026-09-16.

## Context

The clients need to reach the bridge. The obvious engineering answer is a cloud relay with
push notifications: it works from anywhere and offers a system push path, subject to platform
delivery limits. It is also a well-trodden path. It means every prompt, file path and approval passes
through infrastructure somebody has to run and users have to trust, and it adds a dependency
that turns a working local setup into a broken one when the service is down.

The devices are usually a few metres apart on the same network. Optimising the common case for
the rare one would be the wrong trade.

A separate constraint comes from watchOS, which restricts low-level networking: no assumption
of raw sockets or of a stream surviving suspension. Whatever is chosen has to work through
ordinary HTTP.

## Decision

The target connectivity order is direct LAN HTTP first, then relaying through the paired iPhone
over WatchConnectivity, then Bluetooth Low Energy for the nearby case, and an internet relay
last and later. This is a priority order, not a list of implemented transports. The current
prototype has direct HTTP only.

HTTP long polling is the baseline while a watchOS app is able to execute. It is supported by the
platform networking API, but it does not wake or keep alive a suspended app and therefore does
not guarantee background approval delivery. WebSocket and server-sent events may be optional
upgrades for the iPhone and Mac, and no core feature may require them.

The target security model puts authentication and replay protection in a versioned application
envelope rather than relying only on transport security. Confidentiality requirements must also
be defined for each transport. Current v0 schemas do not contain signatures, key identities,
nonces or encryption metadata, so authenticated or encrypted envelopes are design work rather
than current behavior. See [Protocol v0](../protocol-v0.md#validation-and-authenticated-envelopes).

Milestone 1 must decide whether a paired iPhone is a required part of the usable Watch product.
That decision follows a physical-device experiment covering a suspended Watch, approval
delivery, foreground recovery and speech behavior. Direct LAN control remains useful while the
Watch app is active, but it cannot by itself satisfy a promise that the user will be alerted
when the Watch is asleep.

## Consequences

The intended common case is fast and local, and core bridge control should work without an
Agent Remote cloud service. This does not mean every dependency is offline: coding-agent
providers may use their own services, and watchOS dictation may use Apple services depending on
device support and settings. Those boundaries must be stated separately from Agent Remote's
transport design.

Transport-independent event and command semantics should allow another transport without
changing provider adapters or client rendering, once the authenticated wrapper is defined.

The cost is real complexity: four code paths to the same bridge, and a discovery and fallback
policy that has to be debugged on actual hardware rather than reasoned about. Plain HTTP to a
LAN host also needs the platform- and OS-specific App Transport Security and supported local
network privacy configuration described in [networking.md](../networking.md), which can fail
silently when it is wrong.

There is no guaranteed delivery path to a sleeping Watch today. The Milestone 1 experiment must
produce an explicit product outcome: require the paired iPhone path, narrow the promise to
foreground or manually refreshed control, adopt a notification service with documented privacy
boundaries, or stop. This is a feasibility gate for the core experience, not a later transport
enhancement. Details are tracked in [networking.md](../networking.md).
