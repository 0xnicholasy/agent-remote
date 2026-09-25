import SwiftUI

/// Free text entry with a review step. Tapping the field opens the system watchOS input sheet,
/// which offers dictation, scribble and the keyboard; the app never touches raw audio. The
/// transcribed text is shown in full, with where it will go, before Send is possible, so a
/// misheard dictation is caught on the Watch rather than acted on by the agent.
struct DictateView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    /// Captured once, the first time the sheet appears, so the review screen keeps naming the
    /// destination the user actually reviewed even if the store's live state moves on.
    @State private var destination: SessionStore.DictationDestination?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(destination?.label ?? store.dictationDestination.label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                TextField(trimmed.isEmpty ? "Say something" : "Edit", text: $text)
                if !trimmed.isEmpty {
                    Text(trimmed)
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("dictation-review")
                }
                if destinationChanged {
                    Text("Question changed")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Button("Review again") { destination = store.dictationDestination }
                } else if isNewPromptBlockedByRunningTurn {
                    Text("Turn in progress. Stop it or wait.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Button("Send") {
                    guard let destination else { return }
                    let outgoing = trimmed
                    Task {
                        // Only clear the text and dismiss once submitDictation confirms the
                        // send succeeded (R-018): a failed or refused submit must leave the
                        // dictated text in place so the user can retry instead of losing it.
                        let sent = await store.submitDictation(outgoing, expecting: destination)
                        if sent {
                            text = ""
                            dismiss()
                        }
                    }
                }
                .disabled(sendDisabled)
            }
            .padding(.horizontal, 4)
        }
        .onAppear {
            if destination == nil { destination = store.dictationDestination }
        }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var destinationChanged: Bool {
        guard let destination else { return false }
        return store.dictationDestination != destination
    }

    private var isNewPromptBlockedByRunningTurn: Bool {
        destination == .newPrompt && store.canCancelTurn
    }

    private var sendDisabled: Bool {
        trimmed.isEmpty || store.isSending || destination == nil || destinationChanged || isNewPromptBlockedByRunningTurn
    }
}
