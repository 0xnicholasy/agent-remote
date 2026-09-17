# Product vision

Last updated: 2026-09-16

## Core loop

Agent Remote handles the short interruptions that stop a coding agent while its user is away from the Mac. The Watch shows an approval or question, the user taps a choice or sends reviewed dictation, and the agent continues. The Watch can read short replies aloud while the app is in the foreground. The Mac remains the authority for the agent, repository, session, and security policy.

The proposed first release supports one real provider, one paired Mac, and a local-network control path. Its P0 capabilities are:

- approve, deny, or answer a multiple-choice question with a tap;
- dictate a new prompt or free-text answer and review the text before sending;
- hear short replies with on-device speech synthesis while the app is active;
- see a glanceable session and connection state, including current, syncing, and disconnected; and
- cancel a run that has gone wrong.

Agent Remote creates and controls sessions through its own bridge. It does not attach to arbitrary coding-agent processes that were already started in a terminal. Background alerts or speech are release capabilities only if physical-device testing proves a reliable, acceptable delivery path.

## The problem

A coding agent can work independently for minutes and then stop for a brief decision. It may need permission to run a command, an answer between two approaches, or a follow-up prompt. Clearing that interruption can take seconds, but today it often requires returning to the Mac. The user either remains at the desk while the agent is mostly independent or discovers later that it has been blocked for a long time.

The Watch is suited to these bounded decisions. Large diffs, merge conflicts, architecture work, and actions whose risk cannot be understood from exact compact context still belong on the Mac. A spoken summary helps with awareness; it is not sufficient authorization context for a risky or long action.

## Product boundaries

The bridge runs on the user's Mac and the default transport stays on the local network. The control protocol is provider-neutral even though the first release implements only one provider. Structured events describe agent state and decisions; the product does not stream a terminal UI to the Watch.

The first release defers a full iPhone client, BLE transport, internet relay, a second provider, and extensive history. Whether delivery requires an iPhone component is an open physical-device experiment rather than a preassigned later priority.

## Target users

The initial users are developers who already use a coding agent on a Mac and own an Apple Watch. Their agent, repository, and toolchain are already configured. Agent Remote supplies the away-from-desk control loop rather than becoming the first place they configure or run an agent.

A secondary audience is provider-adapter authors. Adding a provider should require implementing the bridge interface and capability mapping, without coupling a client to provider-specific events.

## What success looks like

The first version succeeds when a user can create a real session on the Mac, leave the desk, and complete a real task that includes an approval or rejection, a question, reviewed dictation, and cancel when needed. The Watch always exposes whether its view is current, syncing, or disconnected, and validation prevents an expired, duplicated, conflicting, or otherwise stale decision from being applied.

Release evaluation covers alert delivery latency and reliability, command outcome latency, time the agent remains blocked, desk returns avoided, reconnection behavior, and battery cost. Acceptance thresholds will be chosen after feasibility measurement; prototype observations are not release measurements.

The acceptance scenarios include approval and rejection, question choice, reviewed dictation, cancel, dropped responses, duplicate commands, reconnect, client relaunch, bridge restart, expired decisions, isolation between multiple sessions, and conflicting decisions from devices. Reliable user-visible background delivery must pass its own gate before the product promises an unattended wrist loop.
