import SwiftUI

/// First-run pairing walkthrough. RootView shows this in place of the TabView until
/// `store.paired` flips true. Four steps, one idea per screen, kept in a single NavigationStack
/// with a step counter rather than a NavigationLink chain: the current step is then one piece of
/// state this view already owns, not something a push/pop stack has to be read back out of.
struct OnboardingView: View {
    /// Internal (not private) so OnboardingViewTests can drive `previousStep(_:)` via
    /// `@testable import`.
    enum Step { case macSetup, findingMac, hostAddress, matchCode }

    @Environment(SessionStore.self) private var store
    @State private var step: Step = .macSetup
    @State private var isConnecting = false
    @State private var sweepSelection: BridgeSelection?

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
    /// `defaultBaseURL` and still passes here, and skips the LAN sweep (findingMac) entirely.
    static func canAdvanceFromHostStep(host: String) -> Bool {
        guard let parsed = BridgeClient.parseBaseURL(host) else { return false }
        return parsed.absoluteString != BridgeClient.defaultBaseURL.absoluteString
    }

    private var canAdvanceFromHostStep: Bool {
        Self.canAdvanceFromHostStep(host: store.hostText)
    }

    /// Whether `hostText`'s current value came from the launch-argument domain
    /// (`-dev.agentremote.watch.host`, as CoreScreensUITests launches with) rather than merely
    /// being persisted in UserDefaults from an earlier run. A pure function over the argument
    /// domain dictionary so it is testable without touching `ProcessInfo`/`UserDefaults` from a
    /// test target.
    ///
    /// Bug fixed here: step 1's "Next" used to skip `findingMac` whenever `hostText` differed
    /// from `BridgeClient.defaultBaseURL`, which is also true of any host merely left over from
    /// an earlier, now-dead pairing attempt (e.g. a bridge that moved from one LAN port to
    /// another). That skipped discovery and onboarding tried to connect straight to the stale
    /// host. Only a launch-argument host (the UI test's own override) should skip discovery.
    static func hostIsFromLaunchArgument(argumentDomain: [String: Any]) -> Bool {
        argumentDomain[SessionStore.hostKey] != nil
    }

    private var hostIsFromLaunchArgument: Bool {
        Self.hostIsFromLaunchArgument(
            argumentDomain: UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        )
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
        case .findingMac: return .macSetup
        case .hostAddress: return .findingMac
        case .matchCode: return .findingMac
        }
    }

    var body: some View {
        NavigationStack {
            switch step {
            case .macSetup: macSetupStep
            case .findingMac: findingMacStep
                .toolbar { backButton { step = Self.previousStep(step) } }
            case .hostAddress: hostAddressStep
                .toolbar { backButton { step = Self.previousStep(step) } }
            case .matchCode:
                // Reused as-is: a successful pair flips store.paired and RootView swaps this
                // whole view out for the TabView, so PairingView has nothing left to dismiss.
                PairingView(onFindMyMac: { step = .findingMac })
                    .toolbar { backButton { step = Self.previousStep(step) } }
            }
        }
    }

    @ToolbarContentBuilder
    private func backButton(action: @escaping () -> Void) -> some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Back", action: action)
                .accessibilityIdentifier("onboarding-back")
        }
    }

    private var macSetupStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("On your Mac, run:")
                    .font(.footnote)
                Text("bun run bridge pair")
                    .font(.system(.caption, design: .monospaced))
                Text("It opens a pairing window and shows a code.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("Then tap Next.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Button("Next") {
                    // Only a host injected via launch argument (the UI test path) skips the LAN
                    // sweep. A host merely persisted from an earlier run -- even a valid,
                    // non-default one -- must still go through discovery, since the bridge it
                    // names may no longer be running there.
                    step = hostIsFromLaunchArgument ? .matchCode : .findingMac
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("onboarding-next-1")
                Text(BuildInfo.versionLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("app-build-version")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Set up on your Mac")
    }

    private var findingMacStep: some View {
        VStack(spacing: 8) {
            switch sweepSelection {
            case .none:
                ProgressView()
                Text("Finding your Mac...").font(.footnote)

            case .some(.none):
                Text("Mac not found").font(.headline)
                Text("Make sure your Watch and Mac are on the same network.")
                    .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Retry") { Task { await sweep() } }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("onboarding-sweep-retry")
                Button("Enter address") { step = .hostAddress }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityIdentifier("onboarding-enter-address")

            case .some(.one(let bridge)):
                ProgressView()
                Text("Connecting to \(bridge.name)").font(.footnote)

            case .some(.many(let bridges)):
                Text("Choose your Mac").font(.headline)
                ForEach(bridges) { bridge in
                    Button(bridge.name) { Task { await choose(bridge) } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("onboarding-mac-\(bridge.id)")
                }
            }
        }
        .padding()
        .navigationTitle("Finding your Mac")
        .task { await sweep() }
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
                        // Back during a slow reconnect wins; do not jump forward over it (C4-002).
                        guard step == .hostAddress else { return }
                        step = .matchCode
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

    private func sweep() async {
        sweepSelection = nil
        let lastKnownURL = BridgeClient.parseBaseURL(store.hostText)
        let found = await HealthSweepFinder.sweep(lastKnownHost: lastKnownURL?.host, lastKnownPort: lastKnownURL?.port)
        let selection = BridgeSelection.select(found)
        guard step == .findingMac else { return }
        sweepSelection = selection
        if case .one(let bridge) = selection {
            await choose(bridge)
        }
    }

    private func choose(_ bridge: FoundBridge) async {
        store.hostText = "http://\(bridge.host):\(bridge.port)"
        await store.reconnect()
        guard step == .findingMac else { return }
        step = .matchCode
    }
}
