import SwiftUI

/// The user types the 12-character code shown on the Mac and taps Pair. Kept watch-sized: one
/// field, one button, one status line.
struct PairingView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var code = ""
    @State private var isPairing = false

    var body: some View {
        Form {
            Section("Pairing code") {
                TextField("ABCD-EFGH-JKMN", text: $code)
                    #if os(watchOS)
                    .textInputAutocapitalization(.characters)
                    #endif
            }
            Section {
                Button("Pair") { Task { await pair() } }
                    .disabled(isPairing || code.trimmingCharacters(in: .whitespaces).isEmpty)
                if isPairing {
                    ProgressView()
                }
                if let error = store.pairingError {
                    Text(error).font(.caption2).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Pair Watch")
    }

    private func pair() async {
        isPairing = true
        defer { isPairing = false }
        await store.pair(code: code, deviceName: "Apple Watch")
        if store.paired {
            dismiss()
        }
    }
}
