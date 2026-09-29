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

/// Thrown after XCTFail records a non-2xx bridge response, so the request helper cannot
/// continue on into decoding with an unusable body.
private struct BridgeRequestFailed: Error, CustomStringConvertible {
    var context: String
    /// Nil when the response was not HTTP at all.
    var statusCode: Int?
    var body: String
    var description: String {
        guard let statusCode else { return "\(context): response was not an HTTPURLResponse" }
        return "\(context) failed with status \(statusCode): \(body)"
    }
}

@MainActor
final class CoreScreensUITests: XCTestCase {
    private var bridge: URL!
    private var app: XCUIApplication!

    private var stateDir: URL!

    override func setUp() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["AGENTREMOTE_UI_BRIDGE"], let url = URL(string: raw),
              let stateDirRaw = env["AGENTREMOTE_UI_STATE_DIR"] else {
            throw XCTSkip("AGENTREMOTE_UI_BRIDGE and AGENTREMOTE_UI_STATE_DIR are not set")
        }
        bridge = url
        stateDir = URL(fileURLWithPath: stateDirRaw)
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
        // pairIfNeeded() ends scrolled down to the pairing row, and reveal() only scrolls down,
        // so start Settings again from the top where Create session sits.
        relaunchToSettings()
        button("Create session").tap()
        let sessionId = try await waitForSession(notIn: before)
        app.swipeDown()
        XCTAssertTrue(button("Reply").waitForExistence(timeout: 10), "expected the idle conversation's Reply button to render")
        shot("1-idle")

        try await sendPrompt("run the tests and push", sessionId: sessionId)
        XCTAssertTrue(button("Allow").waitForExistence(timeout: 15))
        shot("2-approval")
        // While the turn waits on the approval, Stop turn sits on the conversation page itself.
        // exists, not isHittable: scrolling to it here would move Deny off screen for the tap below.
        let stop = button("Stop turn")
        XCTAssertTrue(stop.exists && stop.isEnabled, "expected Stop turn on the conversation page during a turn")

        button("Deny").tap()
        XCTAssertTrue(button("Allow").waitForNonExistence(timeout: 15))
        // The mock provider's approval title is always "git push origin main", so the
        // resolution line SessionStore.resolutionLine renders is deterministic regardless of
        // the prompt text sent above.
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label == %@", "Denied: git push origin main")).firstMatch
                .waitForExistence(timeout: 5),
            "expected the transcript to show the deny resolution line"
        )
        shot("3-after-deny")

        // A prompt containing "desk" makes the mock provider script a long, truncated action,
        // which is desk-only: the card must offer Deny and the review line, never Allow.
        try await sendPrompt("desk: run the long action", sessionId: sessionId)
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Review at the Mac before allowing")).firstMatch
                .waitForExistence(timeout: 15),
            "expected the desk-only review line"
        )
        XCTAssertFalse(button("Allow").exists, "a desk-only card must not offer Allow")
        shot("3b-desk-only")
        button("Deny").tap()
        XCTAssertTrue(button("Deny").waitForNonExistence(timeout: 15))

        app.swipeUp()
        XCTAssertTrue(button("Create session").waitForExistence(timeout: 10), "expected Settings to render")
        // Cancel turn sits lower on the page; on a small Watch it starts off screen.
        let cancel = button("Cancel turn")
        reveal(cancel)
        XCTAssertTrue(cancel.exists && cancel.isHittable, "expected Cancel turn on Settings")
        // R-015: the button is disabled only while a send is in flight; with nothing sending it
        // must be tappable, so an inverted or stuck `.disabled` binding fails here.
        XCTAssertTrue(cancel.isEnabled, "Cancel turn must be enabled when nothing is sending")
        shot("4-settings")
    }

    /// The simulator's pairing state carries over from a prior run, so this cannot assume a
    /// fresh install. It detects which of the two states it is in by whether the onboarding
    /// flow's first step renders, takes the matching path, and asserts the postcondition for
    /// that path explicitly rather than assuming success.
    private func pairIfNeeded() throws {
        let onboardingNext1 = app.buttons["onboarding-next-1"]
        guard onboardingNext1.waitForExistence(timeout: 5) else {
            // Already paired from a prior simulator run: RootView goes straight to the
            // TabView, so this is the same path CoreScreensUITests always used.
            XCTContext.runActivity(named: "already paired from a prior simulator run") { _ in }
            app.swipeUp()
            XCTAssertTrue(button("Create session").waitForExistence(timeout: 10), "expected Settings to render for an already-paired launch")
            relaunchToSettings()
            XCTAssertFalse(app.buttons["onboarding-next-1"].exists, "a paired Watch must not show onboarding after relaunch")
            // Reveal the indicator itself, not the Pair Watch link below it -- Device and
            // Pair Watch share one Form section, and the form only keeps rows near the screen
            // in the accessibility tree, so scrolling to Pair Watch can scroll Device off it.
            let lowP = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            let highP = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            for i in 0..<12 {
                let deviceMatches = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Device' OR label CONTAINS 'aired'"))
                let n = deviceMatches.count
                print("DEBUG scan iter \(i): matchCount=\(n) labels=\((0..<min(n, 5)).map { deviceMatches.element(boundBy: $0).label })")
                if n > 0 { break }
                lowP.press(forDuration: 0.05, thenDragTo: highP)
            }
            XCTFail("DEBUG diagnostic stop -- see DEBUG scan iter lines above for Device/Paired matches")
            return
        }

        XCTContext.runActivity(named: "pairing for the first time through onboarding") { _ in }
        shot("o1-mac-setup")
        onboardingNext1.tap()
        // Launched with -dev.agentremote.watch.host, canAdvanceFromHostStep is already true, so
        // OnboardingView skips straight from macSetup to matchCode (no findingMac sweep, no
        // manual host entry) -- PairingView.task then starts pairing v2 on its own.

        // PairingView's .task calls beginPairing(), which runs start+reveal against the real
        // bridge; the bridge only writes pending-pair.json once reveal completes. Poll for it
        // instead of a fixed sleep.
        let pending = try waitForPendingPair()
        shot("o2-pairing-code")

        let option = app.buttons["pairing-option-\(pending.code)"]
        XCTAssertTrue(option.waitForExistence(timeout: 5), "expected an option button for the derived code \(pending.code)")
        option.tap()
        shot("o3-code-picked")

        // Stand in for the operator's `y` at `bun run bridge pair`: write the same decision the
        // CLI writes, through the same lock-file protocol (bridge/src/auth/pending-pair.ts).
        try approvePendingPair(requestId: pending.requestId)

        // A successful approval flips store.paired and RootView swaps onboarding out for the
        // TabView, landing on ConversationView (the TabView's first page). Wait for that page's
        // own Reply button first -- proof the swap happened -- then swipe up to SettingsView,
        // the second page, where Create session lives.
        XCTAssertTrue(button("Reply").waitForExistence(timeout: 15), "pairing did not complete")
        app.swipeUp()
        XCTAssertTrue(button("Create session").waitForExistence(timeout: 10), "expected Settings to render after pairing")
        relaunchToSettings()
        // Same reasoning as the already-paired branch above: reveal the indicator itself.
        reveal(pairedIndicator)
        print("DEBUG first-time-pairing branch hierarchy:\n\(app.debugDescription)")
        XCTAssertTrue(pairedIndicator.exists, "expected pairing to have completed")
    }

    private struct PendingPair: Decodable {
        var requestId: String
        var code: Int
        var status: String
    }

    /// Polls `pending-pair.json` under `AGENTREMOTE_UI_STATE_DIR` for the record the bridge
    /// writes on a successful `/v1/pair/reveal` (bridge/src/auth/pending-pair.ts). Fails the
    /// test rather than timing out silently if the Watch never got that far.
    private func waitForPendingPair() throws -> PendingPair {
        let path = stateDir.appending(path: "pending-pair.json")
        for _ in 0 ..< 30 {
            if let data = try? Data(contentsOf: path),
                let record = try? JSONDecoder().decode(PendingPair.self, from: data),
                record.status == "pending" {
                return record
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("bridge never wrote a pending pairing request within 15s")
        throw SessionTimeout()
    }

    /// Writes `decision: "approved"` into `pending-pair.json`, taking `pending-pair.json.lock`
    /// with `O_EXCL` first, exactly as `bun run bridge pair`'s own `y` prompt does
    /// (bridge/src/auth/pending-pair.ts: `setPendingPairDecision`) -- so this exercises the same
    /// file-based protocol the operator CLI uses, not a shortcut around it.
    private func approvePendingPair(requestId: String) throws {
        let path = stateDir.appending(path: "pending-pair.json")
        let lockPath = stateDir.appending(path: "pending-pair.json.lock")

        var acquired = false
        for _ in 0 ..< 40 {
            let fd = open(lockPath.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
            if fd >= 0 {
                let pid = "\(ProcessInfo.processInfo.processIdentifier)"
                _ = pid.withCString { write(fd, $0, strlen($0)) }
                close(fd)
                acquired = true
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        guard acquired else {
            XCTFail("could not acquire pending-pair.json.lock within 4s")
            return
        }
        defer { try? FileManager.default.removeItem(at: lockPath) }

        let data = try Data(contentsOf: path)
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["requestId"] as? String == requestId else {
            XCTFail("pending-pair.json requestId changed before the decision could be written")
            return
        }
        object["decision"] = "approved"
        let updated = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])
        let tempPath = path.appendingPathExtension("tmp")
        try updated.write(to: tempPath)
        _ = try FileManager.default.replaceItemAt(path, withItemAt: tempPath)
    }

    /// Matches Settings' "Device: Paired" row, on either path through pairIfNeeded().
    private var pairedIndicator: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Paired' OR value == 'Paired'")).firstMatch
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
        let (data, response) = try await URLSession.shared.data(from: bridge.appending(path: "v1/sessions"))
        try Self.requireSuccess(response, data: data, context: "GET v1/sessions")
        return Set(try JSONDecoder().decode(SessionList.self, from: data).sessions.map(\.id))
    }

    /// Fails fast on a non-2xx bridge response so the real status code and body surface instead
    /// of an opaque decode error (or, for polling call sites, a misleading timeout).
    private static func requireSuccess(_ response: URLResponse, data: Data, context: String) throws {
        guard let http = response as? HTTPURLResponse else {
            XCTFail("\(context): response was not an HTTPURLResponse")
            throw BridgeRequestFailed(context: context, statusCode: nil, body: "")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(decoding: data.prefix(500), as: UTF8.self)
            XCTFail("\(context) failed with status \(http.statusCode): \(body)")
            throw BridgeRequestFailed(context: context, statusCode: http.statusCode, body: body)
        }
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
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.requireSuccess(response, data: data, context: "POST v1/commands")
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
