import SwiftUI

/// Free text entry. Tapping the field opens the system watchOS input sheet, which offers
/// dictation, scribble and the keyboard; the app never touches raw audio.
struct DictateView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        VStack(spacing: 8) {
            TextField("Say something", text: $text)
            Button("Send") {
                let outgoing = text
                text = ""
                dismiss()
                Task { await store.submitDictation(outgoing) }
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending)
        }
        .padding(.horizontal, 4)
    }
}
