import XCTest

/// Drives the app against a running bridge started with AGENTREMOTE_AUTH=off and captures the
/// core screens: idle conversation, a pending approval, the conversation after a decision, and
/// Settings. Skips unless AGENTREMOTE_UI_BRIDGE (e.g. http://localhost:8799) and
/// AGENTREMOTE_UI_PAIR_CODE are set; xcodebuild passes them through as
/// TEST_RUNNER_AGENTREMOTE_UI_BRIDGE and TEST_RUNNER_AGENTREMOTE_UI_PAIR_CODE. Screenshots are
/// kept as test attachments, and also written as PNGs to AGENTREMOTE_UI_SHOT_DIR when that is
/// set.
private struct SessionTimeout: Error, CustomStringConvertible {
    var description: String { "bridge never reported a new session within 15s" }
}

@MainActor
final class CoreScreensUITests: XCTestCase {
    private var bridge: URL!
    private var app: XCUIApplication!

    override func setUp() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["AGENTREMOTE_UI_BRIDGE"], let url = URL(string: raw),
              env["AGENTREMOTE_UI_PAIR_CODE"] != nil else {
            throw XCTSkip("AGENTREMOTE_UI_BRIDGE and AGENTREMOTE_UI_PAIR_CODE are not set")
        }
        bridge = url
        continueAfterFailure = false
        app = XCUIApplication()
        // The argument domain overrides the stored bridge address without touching the app's
        // persisted defaults.
        app.launchArguments = ["-dev.agentremote.watch.host", raw]
        app.launch()
    }

    func testCoreScreens() async throws {
        try pairIfNeeded()
        let before = try await sessionIds()
        reveal(button("Create session"))
        button("Create session").tap()
        let sessionId = try await waitForSession(notIn: before)
        app.swipeDown()
        shot("1-idle")

        try await sendPrompt("run the tests and push", sessionId: sessionId)
        XCTAssertTrue(button("Allow").waitForExistence(timeout: 15))
        shot("2-approval")

        button("Deny").tap()
        XCTAssertTrue(button("Allow").waitForNonExistence(timeout: 15))
        // The mock provider's approval title is always "Run git push origin main", so the
        // resolution line SessionStore.resolutionLine renders is deterministic regardless of
        // the prompt text sent above.
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label == %@", "Denied: Run git push origin main")).firstMatch
                .waitForExistence(timeout: 5),
            "expected the transcript to show the deny resolution line"
        )
        shot("3-after-deny")

        app.swipeUp()
        shot("4-settings")
    }

    /// The simulator's pairing state carries over from a prior run, so this cannot assume a
    /// fresh install. It detects which of the two states it is in, takes the matching path, and
    /// asserts the postcondition for that path explicitly rather than assuming success.
    private func pairIfNeeded() throws {
        app.swipeUp()
        XCTAssertTrue(button("Create session").waitForExistence(timeout: 10))
        let pairLink = labeled("Pair Watch")
        reveal(pairLink)
        let pairedIndicator = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Paired' OR value == 'Paired'")).firstMatch
        if pairedIndicator.exists {
            XCTContext.runActivity(named: "already paired from a prior simulator run") { _ in }
            relaunchToSettings()
            reveal(pairLink)
            XCTAssertTrue(pairedIndicator.exists, "expected pairing to remain intact across relaunch")
            return
        }
        XCTContext.runActivity(named: "pairing for the first time") { _ in }
        pairLink.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        // The field opens the system input sheet; the text goes into its focused text view.
        let input = app.textViews.matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.typeText(ProcessInfo.processInfo.environment["AGENTREMOTE_UI_PAIR_CODE"]!)
        button("Done").tap()
        shot("p1-code-entered")
        button("Pair").tap()
        // A successful pair pops back to Settings; a failed one stays on the pairing form.
        XCTAssertTrue(button("Pair").waitForNonExistence(timeout: 15), "pairing did not complete")
        relaunchToSettings()
        reveal(pairLink)
        XCTAssertTrue(pairedIndicator.exists, "expected pairing to have completed")
    }

    /// Scrolling the form back up can overshoot onto the previous page, so start Settings fresh.
    private func relaunchToSettings() {
        app.terminate()
        app.launch()
        app.swipeUp()
        XCTAssertTrue(button("Create session").waitForExistence(timeout: 10))
    }

    private func button(_ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Matches by accessibility label; SwiftUI rows here carry no identifier.
    private func labeled(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Scrolls the Settings form in short drags until `element` can be tapped. A full swipe skips
    /// rows, and the form only keeps rows near the screen in the accessibility tree.
    private func reveal(_ element: XCUIElement) {
        let low = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        let high = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        for _ in 0..<12 where !(element.exists && element.isHittable) {
            low.press(forDuration: 0.05, thenDragTo: high)
        }
    }

    private struct SessionList: Decodable {
        struct Session: Decodable { var id: String }
        var sessions: [Session]
    }

    private func sessionIds() async throws -> Set<String> {
        let (data, _) = try await URLSession.shared.data(from: bridge.appending(path: "v1/sessions"))
        return Set(try JSONDecoder().decode(SessionList.self, from: data).sessions.map(\.id))
    }

    private func waitForSession(notIn existing: Set<String>) async throws -> String {
        for _ in 0..<30 {
            if let id = try await sessionIds().subtracting(existing).first {
                return id
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        // The bridge and pair code are already confirmed reachable by setUp; a session that
        // never appears here is a real regression, not an environment gap, so this must fail
        // the test rather than skip it.
        XCTFail("bridge never reported a new session within 15s")
        throw SessionTimeout()
    }

    private func sendPrompt(_ text: String, sessionId: String) async throws {
        var request = URLRequest(url: bridge.appending(path: "v1/commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = [
            "commandId": UUID().uuidString.lowercased(),
            "sessionId": sessionId,
            "type": "prompt.send",
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "payload": ["text": text],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func shot(_ name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["AGENTREMOTE_UI_SHOT_DIR"] {
            let path = URL(fileURLWithPath: dir).appending(path: "\(name).png")
            do {
                try screenshot.pngRepresentation.write(to: path)
            } catch {
                XCTFail("failed to write screenshot to \(path.path): \(error)")
            }
        }
    }
}
