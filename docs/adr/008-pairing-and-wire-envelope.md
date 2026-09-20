# ADR 008: Pairing and the authenticated wire envelope

## Status

Accepted for v0.

Decided 2026-09-20.

## Context

The bridge accepted every HTTP request from anyone who could reach the port. With the mock
provider that was a demo toy; with the `claude` provider it is a remote code-execution surface,
which is why the bridge currently defaults to binding loopback and warns when it does not. Binding
loopback is not a product: the Watch has to reach the Mac across the LAN.

[ADR 003](003-local-first-networking.md) already committed to putting authentication and replay
protection in a versioned application envelope rather than leaning on transport security, because
the transport order (LAN HTTP, WatchConnectivity relay, BLE, internet relay) means the same
command will eventually arrive over paths with very different protection. An envelope that travels
with the message survives that; TLS on one hop does not.

Three options were weighed for how a paired Watch proves who it is.

1. **Bearer device token.** A pairing exchange issues an opaque token; every request carries it.
   Half the work of anything else. The token is the whole secret and it crosses the wire on every
   request, so anyone who can read one request on the LAN owns the device forever, and replay
   protection has to be bolted on separately.
2. **HMAC-signed envelope from a paired device key.** Per-request MAC over method, path, timestamp,
   nonce and body digest. The secret never travels after enrollment; replay protection falls out of
   the nonce and skew window rather than being a second mechanism.
3. **mTLS or pinned self-signed certificates.** The strongest transport story, but it protects one
   hop rather than the message, and client-certificate handling on watchOS plus certificate
   generation and rotation on the Mac is a large amount of machinery for this stage. It also gives
   no command idempotency or authorization by itself.

## Decision

Option 2. The full contract is [pairing-v0.md](../pairing-v0.md); this ADR records why, not how.

- A 12-character Crockford base32 pairing code (60 bits) is printed on the Mac and typed on the
  Watch. It is used as an HMAC key for an enrollment proof and as HKDF input material. It is never
  transmitted.
- Both sides derive the same 32-byte device key from the code, the device id and a per-enrollment
  nonce. The key is never transmitted either, so the enrollment response carries no secret.
- Every subsequent request carries device, timestamp, nonce and signature headers, and the bridge
  rejects in a fixed order: unknown device, revoked device, clock skew beyond 120 seconds, replayed
  nonce, bad signature.
- Authorization is a separate layer on top of authentication: per-device allowed actions and
  allowed projects, a hard expiry check on approval bindings before they reach the provider, and a
  `commandId` that is now bound to the issuing device and to a digest of the command body.
- The device registry persists to disk so pairing survives a bridge restart. Revocation keeps the
  record, which is what lets a revoked device be told apart from a device that was never paired.
- `AGENTREMOTE_AUTH=off` keeps the simulator loop and the loopback harness usable, and the bridge
  refuses that combination with the `claude` provider on a non-loopback address.

## Consequences

The bridge stops being an open endpoint, the first release gains a real pairing step, and the
Watch gains a Keychain-stored credential and a screen to enter a code on. Every client of the
bridge now has to implement the signing string byte for byte, which is why it is specified as
literal lines with a fixed test vector rather than described in prose.

Three limitations are accepted deliberately and are written into the spec rather than left
implicit.

The first is that there is **no confidentiality**. Prompts, file paths, approval text and agent
replies still travel in clear HTTP on the LAN. This ADR authenticates the sender and blocks
replays; it hides nothing. Any claim about privacy on the wire is unsupported until a transport
with encryption lands.

The second is that an attacker who **captures the enrollment request** holds an HMAC over known
plaintext and can attack the 60-bit code offline. Recovering it yields the device key, and because
the key is derived rather than rotated, re-pairing does not invalidate the stolen one — the device
has to be revoked. A PAKE, or enrollment over an encrypted channel, removes this and is deferred.

The third is that the **bridge is not authenticated to the client** during enrollment. A client
that has not yet paired can be talked to by anything answering on that address.

These are acceptable for a local-first v0 whose threat model is "another machine on the same
network", and unacceptable for the internet relay listed as deferred in ADR 003. That relay must
not be built on this envelope alone.
