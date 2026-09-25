# Onboarding

Last updated: 2026-09-25

Pairing a Watch to a Mac bridge, end to end.

## 1. Install

```sh
bun install
```

## 2. Start the bridge

```sh
bun run dev
```

For the `claude` provider, set `AGENTREMOTE_PROJECT_DIRS` to a comma-separated list of absolute
project directories before starting; it defaults to `cwd`. See [Pairing and request
authentication](pairing-v0.md) for `AGENTREMOTE_AUTH`, `AGENTREMOTE_STATE_DIR` and the other
startup env vars, and [Networking](networking.md) for what binding a non-loopback address implies
(local network privacy, App Transport Security) before setting `AGENTREMOTE_HOST` to anything
other than the default loopback address.

## 3. Pair the Watch

The bridge must already be running (step 2) before minting a code — the CLI mints into
`pairing.json` and a running bridge picks it up without a restart, but there is nothing for the
code to authenticate against otherwise.

```sh
bun run bridge pair
```

This prints the host:port to enter on the Watch, a dashed pairing code, and its expiry, then waits
for the Watch to pair.

An unpaired Watch opens straight into a three-step onboarding flow instead of the conversation
page: "Set up on your Mac" (repeats the `bun run bridge pair` command), "Mac address" (a text
field for the host:port above), then "Pairing code" (the same form as Settings' Pair Watch, for
the dashed code). Once pairing succeeds the Watch swaps onboarding for the normal conversation and
Settings pages on its own. Re-pairing (a new Mac, a revoked device) still goes through Settings'
"Pair Watch" as before.

## 4. Manage devices and projects

```sh
bun run bridge devices                              # list paired devices
bun run bridge revoke <deviceId>                     # revoke a device
bun run bridge projects list                         # current projects and each device's allowedProjects
bun run bridge projects allow <deviceId> <prj_id|/abs/path>
bun run bridge projects deny <deviceId> <prj_id|/abs/path>
```

An empty `allowedProjects` means the device is allowed no project at all, not "allow everything."

`projects list` and `projects allow` read the project list of the running bridge (or, if none is
running, the last bridge started against this state dir), not this shell's own environment.

## What is not here yet

A project picker (choosing which authorized project a session targets) is not built. See
[Roadmap](../tasks/todo.md) (M4).
