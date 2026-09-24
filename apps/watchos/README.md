# watchOS app

Last updated: 2026-09-25

This directory contains an XcodeGen standalone Watch prototype targeting watchOS 26.0 with Swift 6.0. Source exists, but a generated project is not evidence that the app has built, run, or passed on a simulator or physical Watch. Background delivery, speech while inactive, reconnection, and end-to-end device behavior remain unverified.

The current prototype is conversation-first. Its root view shows a transcript, an inline approval or question card, a turn-state pill, and a reply button. A settings page holds the speech mute toggle, accepts a Mac bridge address, reports connection details, creates a mock session, and exposes cancel. The client long-polls the bridge, sends choices and reviewed text, and stores the bridge address, mute setting, and last event cursor locally. Its bridge-loop test skips when no bridge is listening.

`AgentRemoteWatchUITests` pairs the app with a local bridge and screenshots the idle conversation, a pending approval, the conversation after a decision, and Settings. Start the bridge from the repo's `bridge/` directory with `AGENTREMOTE_AUTH=off PORT=8799 bun run src/server.ts`, then export `TEST_RUNNER_AGENTREMOTE_UI_BRIDGE=http://localhost:8799` and `TEST_RUNNER_AGENTREMOTE_UI_PAIR_CODE=<code the bridge printed>` (and optionally `TEST_RUNNER_AGENTREMOTE_UI_SHOT_DIR`) before running `xcodebuild test`. Without them the test skips.

## Current limitations

- The prototype uses the mock provider and a hard-coded demo project. It does not yet pair with or authenticate a Mac, authorize projects, or control a real provider.
- Connection state is currently coarse. The release UI must distinguish current, syncing, and disconnected, and each outgoing action must visibly progress through sending to acknowledged, rejected, expired, or offline.
- A stored event cursor is not session restoration. Snapshot/replay or materialized-state recovery, storage, rehydration, retention, and history policy are still design work.
- The transcript is built from received events in memory. Full conversation replay requires the protocol and bridge to retain or reproduce user prompts as well as agent events; it is a future requirement, not implemented behavior.
- Cancel is wired to the current prototype session, but durable lifecycle and isolation across concurrent sessions are not complete.
- The app controls only sessions created through the Agent Remote bridge. It does not attach to arbitrary agent processes already running in a terminal.

## Planned release experience

The first release centers on one conversation surface with inline choices and explicit outcomes:

- show enough exact question or approval context for a safe tap decision;
- send allow, deny, or a question choice and show sending, acknowledged, rejected, expired, or offline;
- accept a new prompt or free-text answer through system text input, then require review before sending;
- speak short agent messages in the foreground with on-device text-to-speech;
- show current, syncing, and disconnected session state at a glance; and
- keep cancel available for the active bridge-created session.

Risky or long actions must include sufficient exact context for authorization or direct the user to review them at the desk. A spoken summary alone does not authorize an action.

## Dictation and speech privacy

The app receives the text the user reviews and does not itself capture, store, or transmit raw dictation audio. System dictation is managed by watchOS and may use Apple servers depending on device support and settings; see [Apple's Siri, Dictation & Privacy notice](https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/).

Text-to-speech is a separate path. The prototype uses `AVSpeechSynthesizer` for on-device speech output. Foreground speech must be verified on physical hardware, and no background speech or alert behavior is promised until the background-delivery experiment is complete.

See the [product vision](../../docs/product-vision.md), [networking design](../../docs/networking.md), and [task board](../../tasks/todo.md) for the release scope and unresolved ADR 005, ADR 006, and ADR 007 decisions.
