# Pairing and request authentication, version 0

Last updated: 2026-09-25

This document is the normative contract for M3 slice 1: how a device enrolls with a bridge, and
how every subsequent request proves it came from an enrolled device. The bridge (TypeScript) and
the Watch client (Swift) are independent implementations of what is written here, so a change to
any byte string below is a protocol change and must be made in both.

Scope: authentication, authorization and replay protection for direct LAN HTTP. Confidentiality
is explicitly out of scope for v0 (see [Limitations](#limitations)). Durable restart recovery and
interaction lifecycle expiry are M3 slice 2.

## Terms

| Term | Meaning |
| --- | --- |
| Confirmation code | A 3-digit number (100-999) both sides independently derive from the pairing handshake. Never sent over the network; only compared by eye. |
| Device key | A 32-byte secret both sides derive from an X25519 shared secret and the handshake transcript. Never sent over the network. |
| Device id | `dev_` followed by 16 lowercase hex characters, chosen by the client. |

All HMACs are HMAC-SHA256. All comparisons of secrets or MACs are constant time. Hex output is
lowercase.

## Pairing

Pairing v2 has no typed code. The Watch sends its X25519 public key; the Mac terminal
(`bun run bridge pair`) and the Watch each show a 3-digit code derived from the handshake; the
Watch shows four options and the user taps the one matching the Mac's code (or "None match" to
cancel and retry); the operator then presses `y` at the `bun run bridge pair` prompt. Nothing is
ever typed on the Watch.

Every route below is unauthenticated, hex encodings are lowercase, and every nonce is 16 random
bytes hex encoded (32 hex characters):

1. **`POST /v1/pair/start`**

   ```json
   { "deviceId": "dev_9f2c4a1b7d3e5061", "deviceName": "Ting's Apple Watch",
     "devicePublicKey": "<64 lowercase hex characters, raw X25519 public key>",
     "commit": "<64 lowercase hex characters>" }
   ```

   `commit = hex(SHA256("agentremote-pair-commit-v2\n" + watchNonce))`, where `watchNonce` is 16
   random bytes the Watch keeps to itself until `/v1/pair/reveal`. Answers:
   - `403 {"error":"pairing_closed"}` when no pairing window is open (see
     [Timing](#timing)).
   - `409 {"error":"pairing_busy"}` when a request is already pending.
   - `429 {"error":"rate_limited"}` above 6 starts per minute, bridge-wide.
   - `401 {"error":"pairing_rejected"}` for a malformed body.
   - `200`:
     ```json
     { "requestId": "par_<16 hex>", "bridgeId": "brg_<8 hex>",
       "bridgePublicKey": "<64 hex>", "bridgeNonce": "<32 hex>",
       "expiresAt": "2026-09-20T10:15:00.000Z" }
     ```

2. **`POST /v1/pair/reveal`**

   ```json
   { "requestId": "par_...", "watchNonce": "<32 hex>" }
   ```

   Must arrive within 30 seconds of `start`. The bridge checks `commit` against the now-revealed
   `watchNonce` in constant time; a mismatch, an unknown `requestId`, or a late reveal all answer
   `401 {"error":"pairing_rejected"}` and drop the request. On a match the bridge computes the
   confirmation code (below), writes `pending-pair.json`, and answers
   `200 {"status":"pending","expiresAt":"..."}`.

3. **`GET /v1/pair/status?requestId=`**, polled by the Watch about once a second:
   `{"status":"pending"|"approved"|"denied"|"expired"}`. On `approved` the body also carries the
   enrollment response fields: `deviceId`, `keyId`, `pairedAt`, `bridgeId`, `allowedProjects`,
   `allowedActions`. An unknown `requestId` answers `expired`.

4. **`POST /v1/pair/cancel`** `{"requestId": "par_..."}` — the Watch's "None match" or
   wrong-pick path. The bridge marks the request cancelled and frees the slot for a new `start`.
   Always answers `200`.

### Derivation

Identical in TypeScript (`bridge/src/auth/pairing.ts`) and Swift
(`protocol/swift/Sources/AgentRemoteProtocol/RequestSigning.swift`):

```
transcript = "agentremote-pair-confirm-v2\n" + bridgeId + "\n" + bridgePublicKey + "\n"
             + devicePublicKey + "\n" + bridgeNonce + "\n" + watchNonce
code       = uint32be(SHA256(transcript)[0..4]) mod 900 + 100   (3 digits, 100..999)
shared     = X25519(ownPrivate, peerPublic)
deviceKey  = HKDF-SHA256(ikm=shared, salt=SHA256(transcript), info="agentremote-device-key-v2", length 32)
keyId      = "key_" + first 8 hex characters of SHA-256(deviceKey)
```

`bridgePublicKey` and `devicePublicKey` are each the raw 32-byte X25519 public key, hex encoded.
The bridge generates a fresh X25519 key pair every process start; it is never persisted (see
[Timing](#timing)). Both sides derive `deviceKey` independently; it never appears on the wire. The
client stores `deviceId`, `keyId` and `deviceKey` in the Keychain. The bridge stores everything
except `deviceKey`'s derivation inputs, and persists the registry (see
[Device registry](#device-registry)).

### Why this is safe

The commit-then-reveal handshake stops a relaying attacker from choosing its own keys after seeing
the other side's nonce: `commit` binds the Watch to `watchNonce` before it ever learns the bridge's
nonce or public key. So the Mac's code and the Watch's *correct* option among its four choices
match by chance only 1 in 900 for an attacker who does not hold the real bridge's private key. The
Watch always knows its own correct code (it computed the same transcript the bridge did), so
tapping a decoy aborts on the Watch itself, before the operator is ever asked anything. A rogue
device that completes its own handshake and gets its own valid code is still stopped by the `y`
prompt: the operator only presses `y` after their own Watch showed the matching code, so a device
they did not initiate pairing from gets no confirmation. Net: roughly 1/900 odds per attempt, and
exactly one attempt per `y` press — see [Limitations](#limitations) for what this does and does not
protect against.

### Timing

`bun run bridge pair` opens a pairing window of 120 seconds, recorded in `pairing-window.json`
(`{openedAt, expiresAt}`) under the state directory. `/v1/pair/start` is refused outside that
window. Approval must land within 120 seconds of `/v1/pair/reveal` (tracked in
`pending-pair.json`'s own `expiresAt`). Only one request may be pending at a time (`start` while
another is mid-flight, or awaiting approval, answers `pairing_busy`). The bridge's X25519 key pair
and both nonces live in the bridge process's memory only, never on disk; a bridge restart deletes
any stale `pending-pair.json`/`pairing-window.json` it finds at startup, since the material needed
to finish that handshake no longer exists anywhere.

## Signed request envelope

Every request to `/v1/commands`, `/v1/events`, `/v1/sessions`, `/v1/projects` and
`/v1/sessions/:id/cancel` carries four headers:

| Header | Value |
| --- | --- |
| `X-AgentRemote-Device` | the device id |
| `X-AgentRemote-Timestamp` | ISO 8601 UTC with milliseconds, for example `2026-09-20T10:15:00.000Z` |
| `X-AgentRemote-Nonce` | 16 random bytes, 32 lowercase hex characters, fresh per request |
| `X-AgentRemote-Signature` | `v1=` followed by the MAC as 64 lowercase hex characters |

The signing string is exactly these six lines joined by `\n`, with no trailing newline:

```
v1
<HTTP method, uppercase>
<path and query exactly as sent, including the leading slash and any "?">
<timestamp header value>
<nonce header value>
<SHA-256 of the raw request body, lowercase hex; SHA-256 of the empty string when there is no body>
```

```
signature = "v1=" + HMAC(deviceKey, signingString)
```

The path line is the request target as written on the wire, not a re-encoded or re-ordered form:
a client that sends `?after=3&wait=25` signs `/v1/events?after=3&wait=25`.

### Verification order

The bridge rejects on the first failure, and every rejection below is
`401 {"error":"<code>"}` unless stated otherwise.

1. All four headers present and well formed, else `unauthenticated`.
2. Device known, else `unauthenticated`.
3. Device not revoked, else `403 {"error":"device_revoked"}`.
4. Timestamp parses and is within 120 seconds of the bridge clock in either direction, else
   `stale_request`. The bridge clock here never runs backwards: it is the later of the current time
   and the latest time the nonce cache has acted on (docs/durability-v0.md, "Replay protection").
5. Nonce not seen before from this device, else `replayed_request`. The bridge keeps seen nonces
   for 300 seconds (longer than the skew window in both directions).
6. Signature matches, compared in constant time, else `unauthenticated`.
7. The device holds fewer than 10,000 unexpired nonces, else `429 {"error":"rate_limited"}`. A
   nonce still inside its validity window is never evicted to make room.

A nonce is only recorded once the signature verifies, so an unsigned flood cannot fill a device's
nonce set.

### Test vector

Every implementation must reproduce these exact values. The bridge asserts them in
`bridge/src/auth/vector.test.ts` and the Watch client in
`protocol/swift/Tests/AgentRemoteProtocolTests/RequestSigningTests.swift`, both as literals.

Inputs: code `ABCD-EFGH-JKMN` (normalised `ABCDEFGHJKMN`), deviceId `dev_9f2c4a1b7d3e5061`,
deviceName `Test Watch`, nonce `00112233445566778899aabbccddeeff`, `POST /v1/commands`, timestamp
`2026-09-20T10:15:00.000Z`, body `{"a":1}`.

| Value | Expected |
| --- | --- |
| proof | `7a7c4223ee9042311a66a05098b446d4db027b9c498f2dff2acdef6b88e925ae` |
| deviceKey | `ca9dcc8f90e9c298f6027ce885a8235519206cb03314cc36c5a60c8556bacfd8` |
| keyId | `key_cd7749ef` |
| body SHA-256 | `015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862` |
| signature | `v1=e1702c4ff741df5df3e1dd59f0819a1a9f4bf56ee2dee410aa6dfac763b13032` |

The signing string for that request is the six lines `v1`, `POST`, `/v1/commands`, the timestamp,
the nonce, and the body digest, joined by `\n` with no trailing newline.

## Command authorization

After the envelope verifies, `POST /v1/commands` applies these checks in order, before the
existing schema validation reaches the provider:

1. **Allowed action.** `command.type` must be in the device's `allowedActions`, else
   `403 {"error":"action_not_allowed"}`.
2. **Project.** For `session.create`, `payload.projectId` must be in the device's
   `allowedProjects`, else `403 {"error":"project_not_allowed"}`. For every other command type,
   the session's project must be in `allowedProjects`, so revoking a project also cuts off
   sessions already running in it.
3. **Session.** Unchanged from today: an unknown `sessionId` is `400 invalid_command`.
4. **Expiry.** `approval.accept` and `approval.reject` carry `payload.binding.expiresAt`. A
   binding whose `expiresAt` is already past the bridge clock is `410 {"error":"decision_expired"}`
   and never reaches the provider. The provider's own binding check still runs for a live binding.
5. **Request identity.** `commandId` stays the idempotency key, and the bridge now also stores the
   SHA-256 of the canonical command body and the issuing device with it. A repeat of a known
   `commandId` with a matching digest from the same device replays the stored response, exactly as
   today. A repeat with a different digest, or from a different device, is
   `409 {"error":"command_id_conflict"}` and is not executed.

### Known gaps

The `commandId` identity map (device + body digest) and the processed-response map it backs are
both plain in-memory maps with no eviction: every distinct `commandId` a bridge process has ever
seen stays resident for the life of the process. This is accepted for M3 slice 1 and is bounded as
part of M3 slice 2 (durable recovery), not here.

## Device registry

The bridge persists devices as JSON at `$AGENTREMOTE_STATE_DIR/devices.json`, defaulting to
`~/.agentremote/devices.json`, written with mode `0600` in a directory created `0700`. Each record
holds `deviceId`, `deviceName`, `keyId`, the device key as hex, `pairedAt`, `allowedProjects`,
`allowedActions`, `revokedAt` and `lastSeenAt`.

The file holds live credentials. It is written atomically (temp file then rename) so a crash
mid-write cannot truncate the registry.

Every reload -> mutate -> write of `devices.json` (register, revoke, project allow/deny, the
throttled `lastSeenAt` write) runs under an exclusive `devices.json.lock` holding the writer's pid;
the bridge and the operator CLI both honour it, so neither can overwrite the other's write with a
stale copy. The lock is never taken over: a lock that exists is held, full stop. The CLI waits up
to 2 s and the bridge up to 250 ms, then fails; the `lastSeenAt` write does not wait and just
skips. A lock left behind by a writer that crashed mid-write is removed automatically the next
time the bridge starts, if the pid it names is no longer running; otherwise remove it by hand — the
error names the pid and says whether that pid is still running.

A newly paired device is granted every action, and every project the bridge currently exposes. The
registry format carries per-device narrowing so a Mac control surface can tighten it later (M4)
without another protocol change.

Revocation sets `revokedAt` and keeps the record: a revoked device gets `403 device_revoked` rather
than the `401 unauthenticated` that an unknown device gets, which is what lets a user tell "I
revoked this" apart from "this Watch was never paired".

The in-process registry checks the backing file's modification time and size on every lookup
(`get`, `list`) and re-reads the file only when that stamp has changed since it was last observed
— one cheap `statSync`, no re-parse, unless something else actually wrote the file. This is what
lets `bun run bridge revoke` (below) take effect on a bridge that is already running: the operator
command is a separate one-shot process writing `devices.json` directly, and the running bridge
picks up that write on its next authenticated request instead of needing a restart, which would
otherwise kill every live session.

### Live pairing code storage

The bridge's one live pairing code is also persisted as JSON at
`$AGENTREMOTE_STATE_DIR/pairing.json`, alongside `devices.json`, with the same `0600` file / `0700`
directory / atomic-write handling described above. The file holds `{ code, mintedAt, expiresAt,
failedAttempts }` — a live, 5-minute credential in clear text, not a hash — so it inherits the
registry's threat model: anything that can read the state directory can enroll a device until the
code expires or burns.

This is what lets `bun run bridge pair` (below) work against a bridge that is already running: the
operator command and the bridge process both read and write the same file, instead of the operator
command minting a code only its own one-shot process ever knew about.

### Operator commands

The bridge process reads no interactive input, so operator actions are a separate CLI
(`bun run bridge <command>`, bridge/src/cli.ts) that edits `devices.json`/`pairing.json` in the
state directory directly, the same files the running bridge reads. It never opens a journal or
takes `bridge.lock`, so it is safe to run alongside a live bridge process, and works against an
already-running bridge — no restart, so no live sessions are killed — because state is shared
through those files rather than held in one process's memory:

- `bun run bridge pair` opens a 120-second pairing window (pairing v2, see
  [Timing](#timing)) and tells the operator to open Agent Remote on the Watch and tap Next --
  there is no address to enter, since the Watch finds the Mac on its own. Once the Watch reaches
  `/v1/pair/reveal`, it prints the code prominently with the order spelled out ("1. On your
  Watch, tap `<code>`. 2. Then confirm here.") and prompts `[y/N]`; either order works. On `y` it
  waits until the pending request's own `expiresAt` (not a fixed timeout) for the Watch to finish
  pairing, printing "Approved. Waiting for the Watch..." once.
- `bun run bridge devices` prints the registry (no key material); `--json` for machine-readable
  output.
- `bun run bridge revoke <deviceId>` marks that device revoked and exits.
- `bun run bridge projects list` prints the current project ids (from `AGENTREMOTE_PROJECT_DIRS`
  or `cwd`) and each device's `allowedProjects`.
- `bun run bridge projects allow <deviceId> <prj_id|/abs/path>` adds a project to a device's
  `allowedProjects` (accepts an absolute path in place of a `prj_` id); refuses an id that is not
  a current project unless `--force`.
- `bun run bridge projects deny <deviceId> <prj_id|/abs/path>` removes a project from a device's
  `allowedProjects`. An empty `allowedProjects` means the device is allowed no project at all — the
  command-authorization check in the "Device registry" section above treats "not in the list" as a
  403 regardless of whether the list is empty or just missing the one project asked for.

## Development bypass

`AGENTREMOTE_AUTH=off` disables the envelope check for the whole bridge. It exists so the existing
mock-provider simulator loop and the loopback harness keep working without pairing. The bridge
refuses to start with `AGENTREMOTE_AUTH=off` when the provider is `claude` and the bind host is not
loopback, because that combination is an unauthenticated endpoint executing real tool calls on a
reachable address. The mock provider is exempt from this refusal because it serves fixed demo
data and executes nothing on the host, and that exemption is the only reason `AGENTREMOTE_AUTH=off`
may bind a non-loopback address. Every startup with auth off logs a warning.

## Limitations

These are accepted for v0 and are the reason this document is versioned.

- **No confidentiality.** Prompts, file paths, approval text and agent replies travel in clear
  HTTP on the LAN. The envelope proves who sent a request and stops a replay; it hides nothing.
- **Offline guessing of a captured enrollment.** An attacker who captures the `POST /v1/pair`
  exchange holds `proof` over known plaintext and can attack the 60-bit code offline. The code is
  live for 5 minutes, and a successful offline recovery after that window still yields the device
  key, so a capture at enrollment time is not recoverable by re-pairing alone — the device must be
  revoked. A PAKE or a transport with forward secrecy removes this; both are out of scope here.
- **One shared secret per device, no rotation.** There is no rekey path short of revoke and
  re-pair.
- **Bridge identity is asserted, not proven.** `bridgeId` lets a client notice it is talking to a
  different bridge; it does not stop an attacker from impersonating the bridge to a client that has
  not yet paired.
