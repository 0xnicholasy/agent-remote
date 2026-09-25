import SwiftUI

/// First-run pairing walkthrough. RootView shows this in place of the TabView until
/// `store.paired` flips true. Three short steps, one idea per screen, kept in a single
/// NavigationStack with a step counter rather than a NavigationLink chain: the current step is
/// then one piece of state this view already owns, not something a push/pop stack has to be
/// read back out of.
struct OnboardingView: View {
    private enum Step { case macSetup, hostAddress, pairingCode }

    @Environment(SessionStore.self) private var store
    @State private var step: Step = .macSetup
    @State private var isConnecting = false

    var body: some View {
        NavigationStack {
            switch step {
            case .macSetup: macSetupStep
            case .hostAddress: hostAddressStep
            case .pairingCode:
                // Reused as-is: a successful pair() flips store.paired and RootView swaps this
                // whole view out for the TabView, so PairingView's own dismiss() has nothing
                // left to dismiss.
                PairingView()
            }
        }
    }

    private var macSetupStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("On your Mac, run:")
                    .font(.footnote)
                Text("bun run bridge pair")
                    .font(.system(.caption, design: .monospaced))
                Text("It shows an address and a code.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Button("Next") { step = .hostAddress }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("onboarding-next-1")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Set up on your Mac")
    }

    private var hostAddressStep: some View {
        Form {
            Section {
                TextField("192.168.1.20:8787", text: Bindable(store).hostText)
                    .accessibilityIdentifier("onboarding-host")
                Text("Enter the address shown on your Mac.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Section {
                Button("Next") {
                    Task {
                        isConnecting = true
                        await store.reconnect()
                        isConnecting = false
                        step = .pairingCode
                    }
                }
                .disabled(isConnecting || store.hostText.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("onboarding-next-2")
                if isConnecting {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Mac address")
    }
}
