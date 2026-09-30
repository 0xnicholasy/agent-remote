import XCTest

/// Intercepts every request `sweep(...)` makes through the injected `URLSession`, so the
/// saved-host fast path can be exercised without a real network stack -- `.canInit` accepts
/// everything and `startLoading` answers from `responder`, `nil` meaning "fail as unreachable"
/// (the same outcome a real timed-out probe produces).
private final class StubURLProtocolResponder: @unchecked Sendable {
    // `URLProtocol` calls in and out on its own private queue, off any structured-concurrency
    // task, so there is no actor to isolate this to; the lock is the "external synchronization
    // mechanism" the compiler's [#MutableGlobalVariable] note points at.
    private let lock = NSLock()
    private var handler: (@Sendable (URLRequest) -> (Int, Data)?)?

    func set(_ handler: @escaping @Sendable (URLRequest) -> (Int, Data)?) {
        lock.lock()
        self.handler = handler
        lock.unlock()
    }

    func callAsFunction(_ request: URLRequest) -> (Int, Data)? {
        lock.lock()
        defer { lock.unlock() }
        return handler?(request)
    }
}

private let stubURLProtocolResponder = StubURLProtocolResponder()

private final class StubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let (status, data) = stubURLProtocolResponder(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// `BridgeSelection.select(_:)` is a pure function so it is covered here without any networking
/// (the full /24 sweep in `HealthSweepFinder.sweep(...)` needs a real network stack and is
/// exercised manually -- see docs/networking.md on why Bonjour/NWBrowser cannot stand in for it
/// on watchOS). The saved-host fast path is narrow enough to cover with a stubbed `URLSession`:
/// it never reaches the /24 sweep at all when the saved host answers.
final class BridgeDiscoveryTests: XCTestCase {
    private func bridge(_ host: String, port: Int = 8787) -> FoundBridge {
        FoundBridge(host: host, port: port, bridgeId: "brg_\(host)", name: host)
    }

    func testSelectNoneWhenNothingFound() {
        XCTAssertEqual(BridgeSelection.select([]), .none)
    }

    func testSelectOneWhenExactlyOneFound() {
        let found = bridge("192.168.1.20")
        XCTAssertEqual(BridgeSelection.select([found]), .one(found))
    }

    func testSelectManyWhenMultipleFound() {
        let a = bridge("192.168.1.20")
        let b = bridge("192.168.1.21")
        XCTAssertEqual(BridgeSelection.select([a, b]), .many([a, b]))
    }

    func testSweepReturnsSavedHostImmediatelyWithoutFullSweep() async {
        struct HealthBody: Encodable { var ok: Bool; var bridgeId: String }
        let savedBody = try! JSONEncoder().encode(HealthBody(ok: true, bridgeId: "brg_saved"))

        stubURLProtocolResponder.set { request in
            // Only the saved host answers; every /24 sweep address (had the sweep run at all)
            // would fail as unreachable via the `nil` fallback in `startLoading`.
            guard request.url?.host == "192.168.50.7", request.url?.port == 8787 else { return nil }
            return (200, savedBody)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: configuration)

        let found = await HealthSweepFinder.sweep(lastKnownHost: "192.168.50.7", lastKnownPort: 8787, session: session)

        XCTAssertEqual(found, [FoundBridge(host: "192.168.50.7", port: 8787, bridgeId: "brg_saved", name: "192.168.50.7:8787")])
    }

    /// Runs `sweep` with only the saved host `192.168.50.7:8787` answering, with `status`/`body`.
    /// Every other address fails as unreachable, so the /24 fallback resolves empty and fast.
    private func sweepWithSavedHostAnswering(status: Int, body: String) async -> [FoundBridge] {
        let data = Data(body.utf8)
        stubURLProtocolResponder.set { request in
            guard request.url?.host == "192.168.50.7", request.url?.port == 8787 else { return nil }
            return (status, data)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return await HealthSweepFinder.sweep(
            lastKnownHost: "192.168.50.7", lastKnownPort: 8787, session: URLSession(configuration: configuration)
        )
    }

    func testSweepRejectsSavedHostAnswering500WithValidBody() async {
        let found = await sweepWithSavedHostAnswering(status: 500, body: #"{"ok":true,"bridgeId":"brg_x"}"#)
        XCTAssertEqual(found, [])
    }

    func testSweepRejectsSavedHostReportingNotOk() async {
        let found = await sweepWithSavedHostAnswering(status: 200, body: #"{"ok":false,"bridgeId":"x"}"#)
        XCTAssertEqual(found, [])
    }

    func testSweepRejectsSavedHostReturningNonJSON() async {
        let found = await sweepWithSavedHostAnswering(status: 200, body: "not json")
        XCTAssertEqual(found, [])
    }

    func testSweepRejectsSavedHostWithoutBridgeId() async {
        let found = await sweepWithSavedHostAnswering(status: 200, body: #"{"ok":true}"#)
        XCTAssertEqual(found, [])
    }

    func testSweepUsesNameFromHealthBodyWhenPresent() async {
        let found = await sweepWithSavedHostAnswering(status: 200, body: #"{"ok":true,"bridgeId":"brg_x","name":"Studio Mac"}"#)
        XCTAssertEqual(found, [FoundBridge(host: "192.168.50.7", port: 8787, bridgeId: "brg_x", name: "Studio Mac")])
    }
}
