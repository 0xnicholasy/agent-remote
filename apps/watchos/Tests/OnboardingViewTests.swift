import XCTest

/// Covers the two pieces of OnboardingView pulled out as pure static functions specifically so
/// they can be exercised here without driving the view through SwiftUI:
/// `canAdvanceFromHostStep(host:)` (the step-2 gate, including the C2-001 default-host case) and
/// `previousStep(_:)` (Back button transitions).
final class OnboardingViewTests: XCTestCase {
    // MARK: - canAdvanceFromHostStep

    func testCanAdvanceFromHostStep_invalidHost_isFalse() {
        XCTAssertFalse(OnboardingView.canAdvanceFromHostStep(host: "not a url"))
        XCTAssertFalse(OnboardingView.canAdvanceFromHostStep(host: ""))
    }

    func testCanAdvanceFromHostStep_validEditedHost_isTrue() {
        XCTAssertTrue(OnboardingView.canAdvanceFromHostStep(host: "192.168.1.20:8787"))
        XCTAssertTrue(OnboardingView.canAdvanceFromHostStep(host: "http://192.168.1.20:8787"))
    }

    /// C2-001: the unedited default (SessionStore.hostText's initial value, which mirrors
    /// BridgeClient.defaultBaseURL) parses as valid but must not be allowed to advance --
    /// on a physical Watch, localhost is the Watch itself, not the user's Mac.
    func testCanAdvanceFromHostStep_untouchedDefault_isFalse() {
        XCTAssertFalse(OnboardingView.canAdvanceFromHostStep(host: BridgeClient.defaultBaseURL.absoluteString))
        XCTAssertFalse(OnboardingView.canAdvanceFromHostStep(host: "localhost:8787"))
    }

    /// CoreScreensUITests launches with `-dev.agentremote.watch.host <AGENTREMOTE_UI_BRIDGE>`,
    /// which overrides SessionStore's stored default via the UserDefaults argument domain before
    /// onboarding renders. That value is often itself a loopback address (e.g.
    /// "http://localhost:8799") but a *different* one from the hardcoded default
    /// ("http://localhost:8787"), so it must still be allowed to advance without the user typing
    /// anything -- the UI test asserts "Next must be enabled once the host field is prefilled".
    func testCanAdvanceFromHostStep_launchArgumentPrefilledLoopback_isTrue() {
        XCTAssertTrue(OnboardingView.canAdvanceFromHostStep(host: "http://localhost:8799"))
    }

    // MARK: - previousStep

    func testPreviousStep_fromPairingCode_isHostAddress() {
        XCTAssertEqual(OnboardingView.previousStep(.pairingCode), .hostAddress)
    }

    func testPreviousStep_fromHostAddress_isMacSetup() {
        XCTAssertEqual(OnboardingView.previousStep(.hostAddress), .macSetup)
    }

    func testPreviousStep_fromMacSetup_staysMacSetup() {
        XCTAssertEqual(OnboardingView.previousStep(.macSetup), .macSetup)
    }
}
