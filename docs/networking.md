# Networking

Last updated: 2026-09-16

Networking feasibility, especially background notification behavior, is a first-release gate. The
current prototype implements an HTTP loop against a mock bridge; it does not prove continuous
Watch reachability, an end-to-end app run, or timely alerts.

## Active-app baseline

Apple's [TN3135: Low-level networking on
watchOS](https://developer.apple.com/documentation/Technotes/tn3135-low-level-networking-on-watchOS)
(latest recorded revision 2024-02-27) distinguishes high-level `URLSession` networking from
constrained low-level APIs on watchOS. HTTP through `URLSession` is the supported baseline while
the app has execution time. It is not a guarantee that an app remains active, polls continuously,
or receives data while suspended.

For the prototype, the Watch calls `GET /v1/events?after=N&wait=S`. The bridge returns newer events
or holds the request briefly, and the client reconnects with its cursor. This tolerates an ordinary
connection drop during active execution. It does not by itself solve durable replay, bridge
restart, background execution, or alert delivery.

TN3135 constrains low-level networking such as WebSocket and Bonjour browsing on watchOS, with
limited specialized exceptions that are irrelevant to this product. Simulator success therefore
does not establish real-device support. WebSocket or server-sent events may later optimize iPhone
and Mac clients, but Watch features must not depend on them.

## Discovery and local-network configuration

The practical discovery order is a remembered paired bridge, a manual address, and Bonjour on
platforms where it is supported and useful. The Watch should not rely on Bonjour browsing; a
paired phone could provision an address later.

Apple's [TN3179: Understanding local network
privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
states that local-network privacy is not supported on watchOS. Requirements such as
`NSLocalNetworkUsageDescription` and `NSBonjourServices` apply to relevant iOS/macOS cases and
should not be copied to watchOS as a blanket guarantee.

Plain HTTP is also subject to App Transport Security. Apple's
[`NSAllowsLocalNetworking`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
documentation must be checked for the minimum OS and address types used by the product. The
current Watch project includes an ATS local-network exception as a prototype setting; that does
not prove every host name, numeric address, OS version, or deployment configuration will work.
Release configuration must be verified on the chosen support matrix.

## Background delivery is the release gate

The direct-LAN Watch path works only while watchOS grants the app execution time. Apple's
[background execution guidance](https://developer.apple.com/documentation/watchkit/background-execution)
does not provide a general continuously running network client.

A paired-iPhone path is a candidate, not a settled solution. In
[WatchConnectivity data transfer](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity),
`sendMessage` is immediate only when the counterpart is reachable. `transferUserInfo` queues
background transfer and can be delivered while apps are suspended, but it does not guarantee a
timely visible Watch alert. The iPhone also cannot assume it will continuously receive LAN events
while backgrounded.

[Notification forwarding on watchOS](https://developer.apple.com/documentation/watchos-apps/taking-advantage-of-notification-forwarding)
can choose the phone or Watch based on device state. A local notification raised by the phone does
not guarantee that both devices alert, or that the Watch is always the destination.

Before choosing the first supported topology, test a physical-device matrix:

| Dimension | Cases |
| --- | --- |
| Watch app | foreground, suspended |
| iPhone app | foreground, background |
| iPhone state | unlocked, locked, offline |
| Network | normal, lost, restored |
| Mac | awake, sleeping, wakes/reconnects |

For each case, record bridge-event-to-visible-alert latency, alert destination, whether opening the
Watch restores current state, and whether a response reaches the correct still-pending request.
The evidence will determine whether the supported first release is foreground-only, requires the
paired iPhone, or can treat the phone as optional with a separate push path. No final background
solution is claimed today.

## Pairing and wire protection: target requirements

Pairing is design work, not an implemented feature. Before real LAN control, the protocol and
bridge must define authenticated enrollment, a short-lived pairing code with attempt limits,
device/key identity and revocation, replay protection and idempotency, per-project authorization,
a confidentiality policy, and a signed and/or encrypted wire envelope. The initial key exchange
must itself be authenticated and protected against substitution.

The current event and command envelopes do not carry a complete security envelope or signature
metadata, and the mock bridge accepts unauthenticated HTTP. Transport-independent semantics do not
make an unauthenticated transport safe. TLS or another transport protection may be useful, but the
product still needs an explicit trust and authorization model for direct and forwarded paths.

## Delivery order

1. Keep direct LAN HTTP as the active-app prototype path.
2. Run the physical-device background and alert matrix.
3. Choose foreground-only, phone-required, or optional-push MVP behavior from those results.
4. Implement authenticated pairing, authorization, durable recovery, and runtime validation.
5. Add a full iPhone client, BLE, or an internet relay only after the MVP behavior is measured.

This ordering keeps the remote-control path local-first without promising that watchOS, system
dictation, or an agent provider operates offline.
