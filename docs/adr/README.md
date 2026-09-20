# Architecture decision records

Updated 2026-09-20.

Each record states the context that forced a decision, the decision itself, and the
consequences we are accepting. The four earliest records remain Proposed while their evidence
gates are open; ADR 008 is accepted for v0 because its evidence is the implementation and its
tests rather than a device experiment. Acceptance does not require waiting for a shipped
release: it requires the relevant experiment or implementation evidence, the resulting decision
to be recorded, and a reviewer to confirm that the record matches that evidence. Three further records are planned
and not yet written; their rows reserve the numbers and expose the open decisions.

| ADR | Title | Status |
| --- | --- | --- |
| [001](001-provider-abstraction.md) | Provider abstraction | Proposed |
| [002](002-mac-source-of-truth.md) | The Mac is the source of truth | Proposed |
| [003](003-local-first-networking.md) | Local-first networking | Proposed |
| [004](004-event-log.md) | An append-only event log with integer cursors | Proposed |
| 005 | Bridge runtime: TypeScript and Bun versus Swift | Planned, not written |
| 006 | MVP client: Watch-first versus iPhone-first | Planned, not written |
| 007 | Approval delivery when the Watch is asleep; voice output while backgrounded | Planned, not written |
| [008](008-pairing-and-wire-envelope.md) | Pairing and the authenticated wire envelope | Accepted for v0 |

## Acceptance evidence for proposed records

- **ADR 001, provider abstraction:** one real provider adapter emits representative lifecycle,
  interaction and failure sequences; transcript-based adapter tests expose any lossy mapping;
  capability gaps are recorded and reviewed.
- **ADR 002, Mac source of truth:** restart and multi-client experiments demonstrate one
  authoritative recovery model, stale-client detection, first-terminal-decision behavior and
  session-isolated cancellation; the persistence and invalidation policy is reviewed.
- **ADR 003, local-first networking:** a physical-Watch experiment records foreground LAN
  behavior, suspension and wake behavior, paired-iPhone behavior and the resulting Milestone 1
  product boundary; the authenticated-envelope design is reviewed before real LAN control.
- **ADR 004, event log:** restart, retention-boundary and overlapping-retry tests demonstrate
  cursor invalidation or recovery, bounded history, durable outcomes and explicit indeterminate
  provider results; the chosen replay or snapshot model is reviewed.

## Reserved decisions

- **ADR 005:** Bun is the current prototype runtime, not yet the settled production platform.
  Decide after a real-provider integration and packaging/lifecycle experiment provide evidence
  for TypeScript/Bun versus Swift.
- **ADR 006:** The Watch is the primary Milestone 1 client. The decision must state whether an
  iPhone companion is required after the background-delivery experiment rather than reopening
  the product's primary surface without evidence.
- **ADR 007:** Milestone 1 must record an explicit outcome for sleeping-Watch approval delivery
  and speech while inactive, including any narrower product promise or companion dependency.

A new record is added when a decision is hard to reverse or when its reasoning would otherwise
be lost. Records are not edited once accepted; a decision that changes gets a new record that
supersedes the old one.
