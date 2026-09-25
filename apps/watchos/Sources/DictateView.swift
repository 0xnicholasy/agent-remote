import SwiftUI

/// Free text entry with a review step. Tapping the field opens the system watchOS input sheet,
/// which offers dictation, scribble and the keyboard; the app never touches raw audio. The
/// transcribed text is shown in full, with where it will go, before Send is possible, so a
/// misheard dictation is caught on the Watch rather than acted on by the agent.
struct DictateView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(store.dictationDestination)
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
                Button("Send") {
                    let outgoing = text
                    text = ""
                    dismiss()
                    Task { await store.submitDictation(outgoing) }
                }
                .disabled(trimmed.isEmpty || store.isSending)
            }
            .padding(.horizontal, 4)
        }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
