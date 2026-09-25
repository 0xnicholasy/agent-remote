import SwiftUI

/// First-run pairing walkthrough. RootView shows this in place of the TabView until
/// `store.paired` flips true. Three short steps, one idea per screen, kept in a single
/// NavigationStack with a step counter rather than a NavigationLink chain: the current step is
/// then one piece of state this view already owns, not something a push/pop stack has to be
/// read back out of.
struct OnboardingView: View {
    /// Internal (not private) so OnboardingViewTests can drive `previousStep(_:)` via
    /// `@testable import`.
    enum Step { case macSetup, hostAddress, pairingCode }

    @Environment(SessionStore.self) private var store
    @State private var step: Step = .macSetup
    @State private var isConnecting = false

    /// Same parser `reconnect()` feeds `hostText` through, so "valid" here means exactly what
    /// "valid" means once the value is actually used to connect.
    private var isHostValid: Bool {
        BridgeClient.parseBaseURL(store.hostText) != nil
    }

    /// C2-001: SessionStore.hostText defaults to `BridgeClient.defaultBaseURL`
    /// ("http://localhost:8787") until something else is stored under its UserDefaults key. On
    /// a physical Watch that default is never a real Mac, so it must not silently pass the
    /// gate as a valid host. Compares against the *default* value rather than rejecting
    /// loopback outright, because CoreScreensUITests launches with
    /// `-dev.agentremote.watch.host <AGENTREMOTE_UI_BRIDGE>` (often itself a loopback address,
    /// e.g. "http://localhost:8799") via the UserDefaults argument domain -- that value already
    /// overrides the stored default before onboarding ever renders, so it differs from
    /// `defaultBaseURL` and still passes here.
    static func canAdvanceFromHostStep(host: String) -> Bool {
        guard let parsed = BridgeClient.parseBaseURL(host) else { return false }
        return parsed.absoluteString != BridgeClient.defaultBaseURL.absoluteString
    }

    private var canAdvanceFromHostStep: Bool {
        Self.canAdvanceFromHostStep(host: store.hostText)
    }

    /// C3-005: on a real first launch `hostText` is the untouched default, so it parses as
    /// valid (no red error) but still fails `canAdvanceFromHostStep` because it equals
    /// `BridgeClient.defaultBaseURL`. Without this, Next is disabled with no visible reason.
    /// True only for that specific "valid but still the default" state.
    static func shouldShowDefaultHostHint(host: String) -> Bool {
        BridgeClient.parseBaseURL(host) != nil && !canAdvanceFromHostStep(host: host)
    }

    /// Back navigation from each step, extracted as a pure function so it can be unit tested
    /// without driving the view through SwiftUI.
    static func previousStep(_ step: Step) -> Step {
        switch step {
        case .macSetup: return .macSetup
        case .hostAddress: return .macSetup
        case .pairingCode: return .hostAddress
        }
    }

    var body: some View {
        NavigationStack {
            switch step {
            case .macSetup: macSetupStep
            case .hostAddress: hostAddressStep
                .toolbar { backButton { step = Self.previousStep(step) } }
            case .pairingCode:
                // Reused as-is: a successful pair() flips store.paired and RootView swaps this
                // whole view out for the TabView, so PairingView's own dismiss() has nothing
                // left to dismiss.
                PairingView()
                    .toolbar { backButton { step = Self.previousStep(step) } }
            }
        }
    }

    @ToolbarContentBuilder
    private func backButton(action: @escaping () -> Void) -> some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Back", action: action)
                .accessibilityIdentifier("onboarding-back-\(step == .hostAddress ? 2 : 3)")
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
                if store.hostText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("Enter the address shown on your Mac.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else if !isHostValid {
                    Text("That address doesn't look right.")
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("onboarding-host-error")
                } else if Self.shouldShowDefaultHostHint(host: store.hostText) {
                    Text("Replace the default with the address shown on your Mac.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("onboarding-host-default-hint")
                }
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
                .disabled(isConnecting || !canAdvanceFromHostStep)
                .accessibilityIdentifier("onboarding-next-2")
                if isConnecting {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Mac address")
    }
}
