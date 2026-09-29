import SwiftUI

/// Pairing v2: no text field. The Watch shows four 3-digit options -- the code it derived from
/// the handshake plus three decoys -- and the user taps the one matching what the Mac's terminal
/// shows. Kept watch-sized: one line of instruction, a 2x2 grid of large buttons, one status
/// line beneath.
struct PairingView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    /// Set only when this view is reached from onboarding's `findingMac` step, so
    /// `.connectionFailure` can offer a way back to discovery. Settings' standalone "Pair Watch"
    /// link has no such step, so it leaves this nil and falls back to "Start again".
    var onFindMyMac: (() -> Void)?

    var body: some View {
        ScrollView {
            content
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
        }
        .navigationTitle("Pair Watch")
        .task { await start() }
        .onChange(of: scenePhase) {
            if scenePhase == .active {
                store.resumePairingPollingIfNeeded()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.pairingPhase {
        case .idle, .starting:
            VStack(spacing: 8) {
                ProgressView()
                Text("Starting pairing...").font(.caption2).foregroundStyle(.secondary)
            }

        case .choosing(let options, _):
            VStack(spacing: 8) {
                Text("Which code is on your Mac?").font(.footnote)
                Text("Tap the same number").font(.caption2).foregroundStyle(.secondary)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(options, id: \.self) { option in
                        Button(String(option)) { Task { await store.pick(option) } }
                            .buttonStyle(.bordered)
                            .font(.system(.title3, design: .rounded))
                            .accessibilityIdentifier("pairing-option-\(option)")
                    }
                }
                Button("None match") { Task { await store.cancelPairing() } }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityIdentifier("pairing-none-match")
            }

        case .waitingForMac(let code):
            VStack(spacing: 8) {
                Text(String(code)).font(.system(.largeTitle, design: .rounded))
                Text("Now press y on your Mac").font(.footnote)
                ProgressView()
                Text("Waiting for your Mac...").font(.caption2).foregroundStyle(.secondary)
            }

        case .approved:
            VStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Paired").font(.headline)
            }

        case .denied:
            statusView(title: "Not approved", message: "Pairing was denied on the Mac.")

        case .expired:
            statusView(title: "Timed out", message: "Pairing took too long. Start again on your Mac.")

        case .cancelled:
            statusView(title: "Didn't match", message: "Codes didn't match. Start pairing again on your Mac.")

        case .failed(let message):
            statusView(title: "Couldn't pair", message: message)

        case .connectionFailure(let host):
            VStack(spacing: 8) {
                Text("Couldn't pair").font(.headline)
                Text("Can't reach your Mac at \(host).")
                    .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if let onFindMyMac {
                    Button("Find my Mac", action: onFindMyMac)
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("pairing-find-my-mac")
                }
                Button("Start again") { Task { await start() } }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityIdentifier("pairing-start-again")
            }
        }
    }

    private func statusView(title: String, message: String) -> some View {
        VStack(spacing: 8) {
            Text(title).font(.headline)
            Text(message).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Start again") { Task { await start() } }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("pairing-start-again")
        }
    }

    private func start() async {
        guard store.pairingPhase.canRestart else { return }
        await store.beginPairing()
    }
}
