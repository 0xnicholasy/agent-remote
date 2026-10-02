import CryptoKit
import XCTest
import AgentRemoteProtocol
#if canImport(Darwin)
import Darwin
#endif

/// A one-shot loopback HTTP/1.1 server bound to 127.0.0.1 on an OS-assigned port. `BridgeClient`
/// builds its own `URLSession` internally with no injection point for a stub protocol, so this
/// gives `pair()` tests a real socket to talk to instead of a fake in-process client.
private final class LoopbackHTTPServer: @unchecked Sendable {
    let port: UInt16
    private let listenSocket: Int32
    private let queue = DispatchQueue(label: "loopback-http-server")

    init() {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        var reuse: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0 // ask the OS for an ephemeral port
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(sock, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        precondition(bindResult == 0, "LoopbackHTTPServer failed to bind to 127.0.0.1")
        precondition(listen(sock, 1) == 0, "LoopbackHTTPServer failed to listen")

        var boundAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &boundAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                _ = getsockname(sock, sockaddrPtr, &len)
            }
        }
        listenSocket = sock
        port = UInt16(bigEndian: boundAddr.sin_port)
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// Accepts exactly one connection, reads until the header terminator, then replies with
    /// `statusLine` (e.g. "HTTP/1.1 200 OK") and a JSON `body`. Runs on a background queue so
    /// the test's `await client.pair(...)` call can be issued concurrently.
    func respondOnce(statusLine: String, body: String) {
        queue.async { [listenSocket] in
            let clientSocket = accept(listenSocket, nil, nil)
            guard clientSocket >= 0 else { return }
            defer { close(clientSocket) }

            var requestData = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            let terminator = Data("\r\n\r\n".utf8)
            while requestData.range(of: terminator) == nil {
                let n = read(clientSocket, &buffer, buffer.count)
                if n <= 0 { break }
                requestData.append(contentsOf: buffer[0..<n])
            }

            let response = "\(statusLine)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            _ = response.withCString { write(clientSocket, $0, strlen($0)) }
        }
    }

    func stop() {
        close(listenSocket)
    }

    /// Same as `respondOnce`, but also hands the raw request bytes (headers + body) to
    /// `onRequest` before replying, so a test can inspect exactly what the client sent.
    func respondOnce(statusLine: String, body: String, onRequest: @escaping @Sendable (Data) -> Void) {
        queue.async { [listenSocket] in
            guard let clientSocket = Self.acceptAndReadRequest(listenSocket: listenSocket, onRequest: onRequest) else { return }
            defer { close(clientSocket) }
            let response = "\(statusLine)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            _ = response.withCString { write(clientSocket, $0, strlen($0)) }
        }
    }

    /// Accepts one connection, captures its request, then closes without ever writing a
    /// response -- simulating the connection-lost failure mode a retry has to survive, as
    /// opposed to a decoded HTTP error response.
    func dropConnectionOnce(onRequest: @escaping @Sendable (Data) -> Void) {
        queue.async { [listenSocket] in
            guard let clientSocket = Self.acceptAndReadRequest(listenSocket: listenSocket, onRequest: onRequest) else { return }
            close(clientSocket)
        }
    }

    private static func acceptAndReadRequest(listenSocket: Int32, onRequest: (Data) -> Void) -> Int32? {
        let clientSocket = accept(listenSocket, nil, nil)
        guard clientSocket >= 0 else { return nil }

        var requestData = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        let terminator = Data("\r\n\r\n".utf8)
        while requestData.range(of: terminator) == nil {
            let n = read(clientSocket, &buffer, buffer.count)
            if n <= 0 { break }
            requestData.append(contentsOf: buffer[0..<n])
        }

        // Headers are in hand; keep reading until the declared Content-Length worth of
        // body has arrived too, so the caller sees the whole request, not just headers.
        if let headerEnd = requestData.range(of: terminator) {
            let headerText = String(decoding: requestData[..<headerEnd.lowerBound], as: UTF8.self)
            let contentLength = headerText
                .split(separator: "\r\n")
                .first { $0.lowercased().hasPrefix("content-length:") }
                .flatMap { line -> Int? in
                    let parts = line.split(separator: ":", maxSplits: 1)
                    guard parts.count == 2 else { return nil }
                    return Int(parts[1].trimmingCharacters(in: .whitespaces))
                } ?? 0
            var bodyBytesSoFar = requestData.count - headerEnd.upperBound
            while bodyBytesSoFar < contentLength {
                let n = read(clientSocket, &buffer, buffer.count)
                if n <= 0 { break }
                requestData.append(contentsOf: buffer[0..<n])
                bodyBytesSoFar += n
            }
        }

        onRequest(requestData)
        return clientSocket
    }
}

/// Thread-safe box for values written from `LoopbackHTTPServer`'s background queue and read
/// back on the test's task after the corresponding `await` completes.
private final class RequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [Data] = []

    func record(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        bodies.append(data)
    }

    func requestBody(at index: Int) -> [String: Any]? {
        lock.lock()
        let raw = bodies[safe: index]
        lock.unlock()
        guard let raw, let range = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let bodyData = raw[range.upperBound...]
        return (try? JSONSerialization.jsonObject(with: Data(bodyData))) as? [String: Any]
    }

    /// The HTTP request line (`POST /path HTTP/1.1`) of the captured request.
    func requestLine(at index: Int) -> String? {
        lock.lock()
        let raw = bodies[safe: index]
        lock.unlock()
        guard let raw else { return nil }
        return String(decoding: raw, as: UTF8.self).split(separator: "\r\n").first.map(String.init)
    }

    /// Lowercased header name -> value, parsed from the same captured raw request bytes.
    func requestHeaders(at index: Int) -> [String: String]? {
        lock.lock()
        let raw = bodies[safe: index]
        lock.unlock()
        guard let raw, let range = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerText = String(decoding: raw[..<range.lowerBound], as: UTF8.self)
        var headers: [String: String] = [:]
        for line in headerText.split(separator: "\r\n").dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            headers[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        return headers
    }
}

/// A store whose `save` always throws, to drive the Keychain-failure path of `pollPairing`.
private final class FailingSaveCredentialStore: CredentialStore, @unchecked Sendable {
    struct SaveFailed: Error {}
    func loadResult() -> CredentialLoadResult { .notFound }
    func save(_ credential: DeviceCredential) throws { throw SaveFailed() }
    func clear() throws {}
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

/// Covers the client-side pieces of M3 slice 1 that do not need a live bridge: signed-request
/// header construction, the unpaired failure mode, and the bridge error-code mapping. See
/// docs/pairing-v0.md.
final class BridgeClientAuthTests: XCTestCase {
    private func makeCredential() -> DeviceCredential {
        // Any fixed 32-byte key works here: these tests exercise header construction and error
        // mapping, not the pairing v2 derivation itself (covered separately in RequestSigning's
        // own tests and testPairSuccessEnrollsAndYieldsAUsableCredential).
        let key = SymmetricKey(size: .bits256)
        return DeviceCredential(
            deviceId: "dev_9f2c4a1b7d3e5061",
            keyId: "key_cd7749ef",
            deviceKeyData: key.withUnsafeBytes { Data($0) },
            bridgeId: "brg_12345678",
            baseURL: URL(string: "http://localhost:8787")!
        )
    }

    func testUnpairedRequestsFailWithoutHittingTheNetwork() async {
        let client = BridgeClient(credentialStore: InMemoryCredentialStore())

        do {
            _ = try await client.events(after: 0, wait: 0)
            XCTFail("expected .notPaired")
        } catch BridgeError.notPaired {
            // expected
        } catch {
            XCTFail("expected .notPaired, got \(error)")
        }

        do {
            try await client.send(.sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")), sessionId: "s")
            XCTFail("expected .notPaired")
        } catch BridgeError.notPaired {
            // expected
        } catch {
            XCTFail("expected .notPaired, got \(error)")
        }
    }

    func testSignedRequestCarriesTheFourHeadersAndAVerifiableSignature() async throws {
        let credential = makeCredential()
        let client = BridgeClient(credentialStore: InMemoryCredentialStore(credential))

        let url = URL(string: "http://localhost:8787/v1/events?after=3&wait=25")!
        let request = try await client.signedRequest(method: "GET", url: url, body: nil)

        let device = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Device"))
        let timestamp = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Timestamp"))
        let nonce = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Nonce"))
        let signature = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Signature"))

        XCTAssertEqual(device, credential.deviceId)
        XCTAssertEqual(nonce.count, 32)
        XCTAssertTrue(signature.hasPrefix("v1="))
        XCTAssertEqual(signature.count, 3 + 64)

        // The path line must be the request target exactly as sent, including the query string.
        let expectedSigningString = RequestSigning.signingString(
            method: "GET",
            pathWithQuery: "/v1/events?after=3&wait=25",
            timestamp: timestamp,
            nonce: nonce,
            bodySHA256: RequestSigning.bodySHA256(nil)
        )
        let expectedSignature = RequestSigning.signature(deviceKey: credential.deviceKey, signingString: expectedSigningString)
        XCTAssertEqual(signature, expectedSignature)
    }

    func testSigningIsFreshPerRequest() async throws {
        let client = BridgeClient(credentialStore: InMemoryCredentialStore(makeCredential()))
        let url = URL(string: "http://localhost:8787/v1/sessions")!

        let first = try await client.signedRequest(method: "GET", url: url, body: nil)
        let second = try await client.signedRequest(method: "GET", url: url, body: nil)

        XCTAssertNotEqual(
            first.value(forHTTPHeaderField: "X-AgentRemote-Nonce"),
            second.value(forHTTPHeaderField: "X-AgentRemote-Nonce")
        )
    }

    func testErrorCodeMapping() {
        XCTAssertEqual(BridgeError.from(status: 401, code: "unauthenticated", message: ""), .unauthenticated)
        XCTAssertEqual(BridgeError.from(status: 403, code: "device_revoked", message: ""), .deviceRevoked)
        XCTAssertEqual(BridgeError.from(status: 401, code: "stale_request", message: ""), .staleRequest)
        XCTAssertEqual(BridgeError.from(status: 401, code: "replayed_request", message: ""), .replayedRequest)
        XCTAssertEqual(BridgeError.from(status: 403, code: "action_not_allowed", message: ""), .actionNotAllowed)
        XCTAssertEqual(BridgeError.from(status: 403, code: "project_not_allowed", message: ""), .projectNotAllowed)
        XCTAssertEqual(BridgeError.from(status: 410, code: "decision_expired", message: ""), .decisionExpired)
        XCTAssertEqual(BridgeError.from(status: 409, code: "command_id_conflict", message: ""), .commandIdConflict)
        XCTAssertEqual(BridgeError.from(status: 429, code: "rate_limited", message: ""), .rateLimited)
        // Same status as rate_limited, but retrying later does not help: a session must stop first.
        XCTAssertEqual(BridgeError.from(status: 429, code: "session_limit", message: ""), .sessionLimit)
        XCTAssertEqual(BridgeError.from(status: 409, code: "command_indeterminate", message: ""), .commandIndeterminate)
        XCTAssertEqual(BridgeError.from(status: 409, code: "interaction_not_pending", message: ""), .interactionNotPending)
        // The user-facing copy must not promise a wait the poll loop's ~15s
        // backoff (SessionStore) does not actually do -- no "minutes" language here.
        XCTAssertEqual(
            BridgeError.rateLimited.description,
            "The bridge is rate limiting requests from this Watch; it will retry shortly."
        )
        // Unknown/pre-existing codes fall back to the generic case so old 409 handling still works.
        XCTAssertEqual(BridgeError.from(status: 409, code: nil, message: "stale binding"), .http(status: 409, message: "stale binding"))
    }

    private static let testBridgeId = "brg_87654321"
    private static let testBridgeNonce = "00112233445566778899aabbccddeeff"

    private func startResponseBody(bridgePublicKey: String, bridgeId: String = testBridgeId) -> String {
        #"{"requestId":"par_test01","bridgeId":"\#(bridgeId)","bridgePublicKey":"\#(bridgePublicKey)","bridgeNonce":"\#(Self.testBridgeNonce)","expiresAt":"2026-09-20T10:15:00.000Z"}"#
    }

    private func approvedBody(deviceId: String, keyId: String, bridgeId: String = testBridgeId) -> String {
        #"{"status":"approved","deviceId":"\#(deviceId)","keyId":"\#(keyId)","pairedAt":"2026-09-20T10:15:00.000Z","bridgeId":"\#(bridgeId)","allowedProjects":[],"allowedActions":[]}"#
    }

    /// Answers start and reveal on `server`, runs `beginPairing`, and returns what the bridge
    /// side needs to answer the approval honestly: the deviceId the Watch sent and the keyId the
    /// bridge would derive from its own private key and the transcript.
    private func runHandshake(
        server: LoopbackHTTPServer,
        capture: RequestCapture,
        client: BridgeClient,
        bridgeKey: Curve25519.KeyAgreement.PrivateKey
    ) async throws -> (handshake: PairingHandshake, deviceId: String, keyId: String) {
        let bridgePublicKey = bridgeKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: startResponseBody(bridgePublicKey: bridgePublicKey), onRequest: capture.record)
        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"ok":true}"#, onRequest: capture.record)

        let handshake = try await client.beginPairing(deviceName: "Test Watch")

        let startBody = try XCTUnwrap(capture.requestBody(at: 0))
        let revealBody = try XCTUnwrap(capture.requestBody(at: 1))
        let deviceId = try XCTUnwrap(startBody["deviceId"] as? String)
        let devicePublicKey = try XCTUnwrap(startBody["devicePublicKey"] as? String)
        let watchNonce = try XCTUnwrap(revealBody["watchNonce"] as? String)
        XCTAssertEqual(startBody["commit"] as? String, RequestSigning.commitment(watchNonce: watchNonce))

        let transcript = RequestSigning.pairTranscript(
            bridgeId: Self.testBridgeId,
            bridgePublicKeyHex: bridgePublicKey,
            devicePublicKeyHex: devicePublicKey,
            bridgeNonceHex: Self.testBridgeNonce,
            watchNonceHex: watchNonce
        )
        XCTAssertEqual(handshake.code, RequestSigning.confirmCode(transcript: transcript))
        let shared = try RequestSigning.sharedSecret(privateKey: bridgeKey, peerPublicKeyHex: devicePublicKey)
        let deviceKey = RequestSigning.deriveDeviceKey(shared: shared, transcript: transcript)
        return (handshake, deviceId, RequestSigning.keyId(for: deviceKey))
    }

    /// Covers R-004 and E-11 for pairing v2: a real X25519 derivation. The bridge side of the
    /// test derives the keyId from its own private key and the transcript, so the Watch only
    /// enrolls when its independently derived key matches, and the stored credential carries the
    /// deviceId the Watch itself sent at start.
    func testPairSuccessEnrollsAndYieldsAUsableCredential() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let capture = RequestCapture()
        let credentialStore = InMemoryCredentialStore()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)

        let pairedBefore = await client.isPaired()
        XCTAssertFalse(pairedBefore, "must not be paired before pairing runs")
        let (handshake, deviceId, keyId) = try await runHandshake(
            server: server, capture: capture, client: client, bridgeKey: Curve25519.KeyAgreement.PrivateKey()
        )
        XCTAssertEqual(handshake.requestId, "par_test01")

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"status":"pending","expiresAt":"2026-09-20T10:15:00.000Z"}"#)
        let pending = try await client.pollPairing(requestId: handshake.requestId)
        XCTAssertEqual(pending, .pending)
        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: approvedBody(deviceId: deviceId, keyId: keyId))
        let result = try await client.pollPairing(requestId: handshake.requestId)
        XCTAssertEqual(result, .approved)

        let pairedAfter = await client.isPaired()
        XCTAssertTrue(pairedAfter)
        let stored = try XCTUnwrap(credentialStore.load(), "an approved pairing must persist a credential")
        XCTAssertEqual(stored.deviceId, deviceId, "the stored credential must use the deviceId the Watch sent at start")
        XCTAssertEqual(stored.keyId, keyId)
        XCTAssertEqual(stored.bridgeId, Self.testBridgeId)

        let url = server.baseURL.appending(path: "/v1/sessions")
        let request = try await client.signedRequest(method: "GET", url: url, body: nil)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-AgentRemote-Device"), deviceId)
    }

    /// E-11: an approval whose keyId does not match the key the Watch derived is rejected and
    /// nothing is stored.
    func testApprovedWithMismatchedKeyIdIsRejected() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let capture = RequestCapture()
        let credentialStore = InMemoryCredentialStore()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)
        let (handshake, deviceId, _) = try await runHandshake(
            server: server, capture: capture, client: client, bridgeKey: Curve25519.KeyAgreement.PrivateKey()
        )

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: approvedBody(deviceId: deviceId, keyId: "key_aaaa1111"))
        do {
            _ = try await client.pollPairing(requestId: handshake.requestId)
            XCTFail("expected a keyId mismatch to throw")
        } catch BridgeError.malformedResponse {
            // expected
        } catch {
            XCTFail("expected .malformedResponse, got \(error)")
        }
        XCTAssertNil(credentialStore.load())
        let paired = await client.isPaired()
        XCTAssertFalse(paired)
    }

    /// E-11: an approval naming a different bridge than the one that answered start is rejected.
    func testApprovedWithDifferentBridgeIdIsRejected() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let capture = RequestCapture()
        let credentialStore = InMemoryCredentialStore()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)
        let (handshake, deviceId, keyId) = try await runHandshake(
            server: server, capture: capture, client: client, bridgeKey: Curve25519.KeyAgreement.PrivateKey()
        )

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: approvedBody(deviceId: deviceId, keyId: keyId, bridgeId: "brg_other000"))
        do {
            _ = try await client.pollPairing(requestId: handshake.requestId)
            XCTFail("expected a bridgeId mismatch to throw")
        } catch BridgeError.malformedResponse {
            // expected
        } catch {
            XCTFail("expected .malformedResponse, got \(error)")
        }
        XCTAssertNil(credentialStore.load())
    }

    /// E-12: a start response whose bridgePublicKey or bridgeNonce is not lowercase hex of the
    /// right length is rejected before any key material is used.
    func testStartResponseWithMalformedBridgeKeyIsRejected() async throws {
        for badKey in [String(repeating: "1", count: 63), String(repeating: "zz", count: 32)] {
            let server = LoopbackHTTPServer()
            defer { server.stop() }
            server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: startResponseBody(bridgePublicKey: badKey))
            let credentialStore = InMemoryCredentialStore()
            let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)
            do {
                _ = try await client.beginPairing(deviceName: "Test Watch")
                XCTFail("expected beginPairing to throw for bridgePublicKey \(badKey)")
            } catch BridgeError.malformedResponse {
                // expected
            } catch {
                XCTFail("expected .malformedResponse, got \(error)")
            }
            let paired = await client.isPaired()
            XCTAssertFalse(paired)
        }
    }

    /// E-13: when reveal fails, the Watch tells the bridge to drop the pending request.
    func testRevealFailureSendsCancel() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let capture = RequestCapture()
        let bridgePublicKey = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: startResponseBody(bridgePublicKey: bridgePublicKey), onRequest: capture.record)
        server.respondOnce(statusLine: "HTTP/1.1 500 Internal Server Error", body: #"{"error":"boom"}"#, onRequest: capture.record)
        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"ok":true}"#, onRequest: capture.record)
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore())

        do {
            _ = try await client.beginPairing(deviceName: "Test Watch")
            XCTFail("expected beginPairing to throw when reveal fails")
        } catch {
            // expected
        }

        let cancelBody = try XCTUnwrap(capture.requestBody(at: 2), "a cancel request must follow the failed reveal")
        XCTAssertEqual(cancelBody["requestId"] as? String, "par_test01")
        let requestLine = try XCTUnwrap(capture.requestLine(at: 2))
        XCTAssertTrue(requestLine.contains("/v1/pair/cancel"), "unexpected request line: \(requestLine)")
    }

    /// E-03: a Keychain save failure after a valid approval surfaces as a BridgeError, not a
    /// transport error, and leaves the client unpaired.
    func testKeychainSaveFailureAfterApprovalThrowsBridgeError() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let capture = RequestCapture()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: FailingSaveCredentialStore())
        let (handshake, deviceId, keyId) = try await runHandshake(
            server: server, capture: capture, client: client, bridgeKey: Curve25519.KeyAgreement.PrivateKey()
        )

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: approvedBody(deviceId: deviceId, keyId: keyId))
        do {
            _ = try await client.pollPairing(requestId: handshake.requestId)
            XCTFail("expected a save failure to throw")
        } catch is BridgeError {
            // expected
        } catch {
            XCTFail("expected a BridgeError, got \(error)")
        }
        let paired = await client.isPaired()
        XCTAssertFalse(paired)
    }

    /// Covers R-004 for pairing v2: when the bridge refuses `/v1/pair/start` outside a pairing
    /// window, `beginPairing()` must throw `.pairingClosed` rather than silently leaving the
    /// caller thinking it enrolled, and no credential may be persisted.
    func testPairFailureSurfacesErrorAndDoesNotEnroll() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        server.respondOnce(
            statusLine: "HTTP/1.1 403 Forbidden",
            body: #"{"error":"pairing_closed"}"#
        )

        let credentialStore = InMemoryCredentialStore()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)

        do {
            _ = try await client.beginPairing(deviceName: "Test Watch")
            XCTFail("expected beginPairing() to throw when the bridge refuses /v1/pair/start")
        } catch BridgeError.pairingClosed {
            // Expected: no pairing window is open on the bridge.
        } catch {
            XCTFail("expected .pairingClosed, got \(error)")
        }

        let pairedAfterFailure = await client.isPaired()
        XCTAssertFalse(pairedAfterFailure, "a rejected pairing code must not enroll the device")
        XCTAssertNil(credentialStore.load(), "no credential may be persisted on a failed pair()")
    }

    /// Covers E-12: `send()` must forward the caller-supplied commandId in the request body
    /// verbatim -- the bridge keys its idempotency check on this exact field
    /// (bridge/src/state/commands.ts / bridge/src/server.ts).
    func testSendForwardsTheCallersCommandId() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()
        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)

        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_fixed_1234",
            timestamp: "2026-09-25T00:00:00.000Z"
        )

        let sent = try XCTUnwrap(capture.requestBody(at: 0), "expected a captured JSON request body")
        XCTAssertEqual(sent["commandId"] as? String, "cmd_fixed_1234")
        XCTAssertEqual(sent["timestamp"] as? String, "2026-09-25T00:00:00.000Z")
    }

    /// Covers E-04 / E-20: a retry that resends the same commandId must resend the same body
    /// timestamp too -- the bridge's idempotency check hashes the whole request body
    /// (bridge/src/server.ts: `bodyDigest = sha256(rawBody)`), so a differing timestamp on retry
    /// would change the digest and get rejected as `command_id_conflict` even though it is the
    /// same logical command. The caller owns the timestamp (SessionStore keeps it alongside the
    /// commandId in `unconfirmedSend`); `send()` must put exactly what it was given in the body.
    func testRetryOfTheSameCommandIdReusesTheSameTimestamp() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()
        let timestamp = BridgeClient.timestamp()

        // First attempt: the connection drops before any HTTP response arrives -- the "offline"
        // failure mode (ActionOutcome.classify / SessionStore.decide) that makes the caller
        // retry with the same commandId, as opposed to a decoded HTTP error response.
        server.dropConnectionOnce(onRequest: capture.record)
        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_retry_5678",
                timestamp: timestamp
            )
            XCTFail("expected the dropped connection to throw")
        } catch {
            // expected: no response was ever sent
        }

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)
        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_retry_5678",
            timestamp: timestamp
        )

        let first = try XCTUnwrap(capture.requestBody(at: 0))
        let second = try XCTUnwrap(capture.requestBody(at: 1))
        XCTAssertEqual(first["commandId"] as? String, "cmd_retry_5678")
        XCTAssertEqual(second["commandId"] as? String, "cmd_retry_5678")
        XCTAssertEqual(first["timestamp"] as? String, timestamp, "the body timestamp must be the one passed in")
        XCTAssertEqual(
            second["timestamp"] as? String,
            timestamp,
            "a same-commandId retry must resend the original timestamp, not mint a new one"
        )
    }

    /// Covers E-04 (re-fix): a decoded HTTP error (as opposed to a dropped connection) that
    /// SessionStore.decide retries with the same commandId -- e.g. a generic 500, or a 429
    /// "rate_limited" -- must also carry the same body timestamp on retry; `send()` must not
    /// rewrite it on either the failed or the retried attempt.
    func testRetryAfterDecodedHTTPErrorReusesTheSameTimestamp() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()
        let timestamp = BridgeClient.timestamp()

        server.respondOnce(
            statusLine: "HTTP/1.1 500 Internal Server Error",
            body: #"{"error":"internal"}"#,
            onRequest: capture.record
        )
        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_retry_5xx",
                timestamp: timestamp
            )
            XCTFail("expected the decoded 500 response to throw")
        } catch BridgeError.http(let status, _) {
            XCTAssertEqual(status, 500)
        }

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)
        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_retry_5xx",
            timestamp: timestamp
        )

        let first = try XCTUnwrap(capture.requestBody(at: 0))
        let second = try XCTUnwrap(capture.requestBody(at: 1))
        XCTAssertEqual(first["commandId"] as? String, "cmd_retry_5xx")
        XCTAssertEqual(second["commandId"] as? String, "cmd_retry_5xx")
        XCTAssertEqual(first["timestamp"] as? String, timestamp, "the body timestamp must be the one passed in")
        XCTAssertEqual(
            second["timestamp"] as? String,
            timestamp,
            "a same-commandId retry after a decoded HTTP error must resend the original timestamp"
        )
    }

    /// Covers E-30: a proxy-level failure (a 502 with an HTML body, not the bridge's own JSON
    /// error shape) must still classify on the HTTP status. Before the fix, `send()` decoded the
    /// response body into `CommandResponse` before ever looking at the status code, so a non-JSON
    /// body on a >=300 response threw a raw `DecodingError` instead of `BridgeError.http`, losing
    /// the status entirely.
    func testSendOnNonJSONErrorBodySurfacesTheHTTPStatus() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()

        server.respondOnce(
            statusLine: "HTTP/1.1 502 Bad Gateway",
            body: "<html><body>502 Bad Gateway</body></html>",
            onRequest: capture.record
        )

        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_bad_gateway",
                timestamp: BridgeClient.timestamp()
            )
            XCTFail("expected the non-JSON 502 body to throw a status-based error")
        } catch BridgeError.http(let status, _) {
            XCTAssertEqual(status, 502)
        } catch {
            XCTFail("expected BridgeError.http(502, _), got \(error)")
        }
    }

    /// Investigates E-15: a `stale_request` (401) is rejected by `verifyEnvelope`
    /// (bridge/src/auth/verify.ts:341-343) purely on the `X-AgentRemote-Timestamp` *header*,
    /// checked before the command idempotency store is ever consulted (bridge/src/server.ts:714).
    /// `signedRequest` mints that header's timestamp fresh on every call (see
    /// `testSigningIsFreshPerRequest` above) independently of the caller-supplied body
    /// `timestamp`, which only feeds the request *body*'s redundant field used solely to keep the
    /// idempotency digest stable (bridge/src/server.ts:710, `bodyDigest = sha256(rawBody)`). Since
    /// a stale_request rejection never reaches that digest check, retrying with the same
    /// commandId cannot resend "the same stale timestamp" to the check that produced the 401: the
    /// header is rebuilt fresh, and the retry succeeds once it is back inside the skew window.
    func testRetryAfterStaleRequestGetsAFreshHeaderTimestampAndSucceeds() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()
        let timestamp = BridgeClient.timestamp()

        server.respondOnce(
            statusLine: "HTTP/1.1 401 Unauthorized",
            body: #"{"error":"stale_request"}"#,
            onRequest: capture.record
        )
        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_stale_9012",
                timestamp: timestamp
            )
            XCTFail("expected the decoded stale_request response to throw")
        } catch BridgeError.staleRequest {
            // expected
        }

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)
        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_stale_9012",
            timestamp: timestamp
        )

        let firstHeaders = try XCTUnwrap(capture.requestHeaders(at: 0))
        let secondHeaders = try XCTUnwrap(capture.requestHeaders(at: 1))
        XCTAssertNotEqual(
            firstHeaders["x-agentremote-timestamp"],
            secondHeaders["x-agentremote-timestamp"],
            "a retry after stale_request must carry a freshly minted header timestamp, not the rejected one"
        )
        let secondBody = try XCTUnwrap(capture.requestBody(at: 1))
        XCTAssertEqual(secondBody["timestamp"] as? String, timestamp, "the body timestamp stays the one passed in")
    }

    /// C3-06: a 2xx reply whose body is not a CommandResponse means the bridge accepted the
    /// command, so it must surface as `commandResponseUnreadable`, not a raw DecodingError that
    /// the Watch would label "Not sent".
    func testSendOnUnreadableSuccessBodyThrowsCommandResponseUnreadable() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: "not json")

        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_unreadable",
                timestamp: BridgeClient.timestamp()
            )
            XCTFail("expected an unreadable 200 body to throw")
        } catch BridgeError.commandResponseUnreadable {
        } catch {
            XCTFail("expected BridgeError.commandResponseUnreadable, got \(error)")
        }
    }

    // MARK: - Credential load failure (C2-004)
    //
    // `InMemoryCredentialStore` previously could not produce `.error`, so these paths were only
    // ever exercised against `FakeBridgeClient` in SessionStoreDecisionTests, never against the
    // real `BridgeClient` actor.

    func testPairingLookupReportsCheckFailedOnCredentialLoadError() async {
        let credentialStore = InMemoryCredentialStore()
        credentialStore.setLoadError("Keychain read failed (OSStatus -25300).")
        let client = BridgeClient(credentialStore: credentialStore)

        let lookup = await client.pairingLookup()

        XCTAssertEqual(lookup, PairingLookup.checkFailed("Keychain read failed (OSStatus -25300)."))
    }

    /// A Retry (`reloadCredential()`) after the store's read recovers must clear `.checkFailed`
    /// and report `.paired`, not keep replaying the cached failure.
    func testReloadCredentialClearsCheckFailedOnceStoreRecovers() async {
        let credentialStore = InMemoryCredentialStore()
        credentialStore.setLoadError("Keychain read failed (OSStatus -25300).")
        let client = BridgeClient(credentialStore: credentialStore)

        let initialLookup = await client.pairingLookup()
        XCTAssertEqual(initialLookup, .checkFailed("Keychain read failed (OSStatus -25300)."))

        credentialStore.setLoadError(nil)
        credentialStore.save(makeCredential())

        let reloaded = await client.reloadCredential()
        XCTAssertEqual(reloaded, .paired, "reloadCredential() must re-read the store, not just recheck the cached failure")

        let followUpLookup = await client.pairingLookup()
        XCTAssertEqual(followUpLookup, .paired)
    }

    /// A keychain-delete failure during `clearCredential()` must surface to the caller (V2-001)
    /// rather than be silently swallowed, so `SessionStore.clearPairing()` can keep the user on
    /// `PairingCheckFailedView` instead of reporting a clear that never happened.
    func testClearCredentialThrowsOnStoreDeleteFailure() async {
        struct DeleteFailed: Error, Equatable {}
        let credentialStore = InMemoryCredentialStore(makeCredential())
        credentialStore.setClearError(DeleteFailed())
        let client = BridgeClient(credentialStore: credentialStore)

        do {
            try await client.clearCredential()
            XCTFail("expected clearCredential() to throw when the store's delete fails")
        } catch is DeleteFailed {
            // expected
        } catch {
            XCTFail("expected DeleteFailed, got \(error)")
        }
    }
}
