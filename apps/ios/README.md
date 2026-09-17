# iOS app

Last updated: 2026-09-16

No iOS app is implemented. A full iPhone client with session history, diffs, and detailed command output is deferred beyond the first release.

M1 physical-device testing will determine whether the Watch can deliver the required foreground, inactive, and reconnect behavior directly. If it cannot, the first release may need a minimal iPhone companion for pairing, transport assistance, or notification delivery. That dependency is a feasibility outcome, not an assumed later feature or a commitment to build the full client.

`WCSession` may help exchange commands and events between paired apps, but transport alone does not guarantee a timely, user-visible Watch alert. Any companion design must separately prove delivery latency and reliability while the Watch app is inactive, along with reconnect behavior and battery cost, before the product promises unattended wrist operation.

See the [task board](../../tasks/todo.md) and [product vision](../../docs/product-vision.md).
