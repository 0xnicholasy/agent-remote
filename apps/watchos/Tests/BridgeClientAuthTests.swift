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
        let key = RequestSigning.deriveDeviceKey(
            code: "ABCDEFGHJKMN", deviceId: "dev_9f2c4a1b7d3e5061", nonce: "00112233445566778899aabbccddeeff"
        )
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

    /// Covers R-004: a well-formed `POST /v1/pair` response must enroll the device and leave
    /// behind a credential that subsequent requests can actually sign with -- specifically the
    /// server's own `deviceId`, not whatever id the client generated locally before it knew
    /// what the bridge would assign.
    func testPairSuccessEnrollsAndYieldsAUsableCredential() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        server.respondOnce(
            statusLine: "HTTP/1.1 200 OK",
            body: #"{"deviceId":"dev_serverassigned01","keyId":"key_aaaa1111","bridgeId":"brg_87654321"}"#
        )

        let credentialStore = InMemoryCredentialStore()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)

        let pairedBefore = await client.isPaired()
        XCTAssertFalse(pairedBefore, "must not be paired before pair() runs")
        try await client.pair(code: "ABCDEFGHJKMN", deviceName: "Test Watch")

        let pairedAfter = await client.isPaired()
        XCTAssertTrue(pairedAfter)
        let stored = try XCTUnwrap(credentialStore.load(), "pair() must persist a credential")
        XCTAssertEqual(stored.deviceId, "dev_serverassigned01", "the stored credential must use the bridge's assigned deviceId")
        XCTAssertEqual(stored.keyId, "key_aaaa1111")
        XCTAssertEqual(stored.bridgeId, "brg_87654321")

        // The credential must actually be usable: a subsequent signed request carries the
        // server-assigned deviceId, not the locally generated one from before pairing.
        let url = server.baseURL.appending(path: "/v1/sessions")
        let request = try await client.signedRequest(method: "GET", url: url, body: nil)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-AgentRemote-Device"), "dev_serverassigned01")
    }

    /// Covers R-004: when the bridge rejects the pairing code, `pair()` must throw rather than
    /// silently leaving the caller thinking it enrolled, and no credential may be persisted.
    func testPairFailureSurfacesErrorAndDoesNotEnroll() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        // The real bridge answers every rejected pairing code the same way -- "pairing_rejected"
        // at 401 -- per bridge/src/server.ts's handlePair (malformed body, wrong/expired/exhausted
        // code, and malformed proof all share this response so an attacker can't distinguish them).
        server.respondOnce(
            statusLine: "HTTP/1.1 401 Unauthorized",
            body: #"{"error":"pairing_rejected"}"#
        )

        let credentialStore = InMemoryCredentialStore()
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: credentialStore)

        do {
            try await client.pair(code: "000000000000", deviceName: "Test Watch")
            XCTFail("expected pair() to throw when the bridge rejects the pairing code")
        } catch BridgeError.http(let status, let message) {
            // "pairing_rejected" has no dedicated BridgeError case today, so BridgeError.from
            // falls back to .http -- the failure still surfaces instead of being swallowed.
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "pairing_rejected")
        } catch {
            XCTFail("expected .http(401, \"pairing_rejected\"), got \(error)")
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
            commandId: "cmd_fixed_1234"
        )

        let sent = try XCTUnwrap(capture.requestBody(at: 0), "expected a captured JSON request body")
        XCTAssertEqual(sent["commandId"] as? String, "cmd_fixed_1234")
    }

    /// Covers E-04: a retry that resends the same commandId must resend the same timestamp too,
    /// not a fresh one -- the bridge's idempotency check hashes the whole request body
    /// (bridge/src/server.ts: `bodyDigest = sha256(rawBody)`), so a differing timestamp on retry
    /// would change the digest and get rejected as `command_id_conflict` even though it is the
    /// same logical command.
    func testRetryOfTheSameCommandIdReusesTheSameTimestamp() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()

        // First attempt: the connection drops before any HTTP response arrives -- the "offline"
        // failure mode (ActionOutcome.classify / SessionStore.decide) that makes the caller
        // retry with the same commandId, as opposed to a decoded HTTP error response.
        server.dropConnectionOnce(onRequest: capture.record)
        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_retry_5678"
            )
            XCTFail("expected the dropped connection to throw")
        } catch {
            // expected: no response was ever sent
        }

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)
        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_retry_5678"
        )

        let first = try XCTUnwrap(capture.requestBody(at: 0))
        let second = try XCTUnwrap(capture.requestBody(at: 1))
        XCTAssertEqual(first["commandId"] as? String, "cmd_retry_5678")
        XCTAssertEqual(second["commandId"] as? String, "cmd_retry_5678")
        XCTAssertEqual(
            first["timestamp"] as? String,
            second["timestamp"] as? String,
            "a same-commandId retry must resend the original timestamp, not mint a new one"
        )
    }

    /// Covers E-04 (re-fix): a decoded HTTP error (as opposed to a dropped connection) that
    /// SessionStore.decide retries with the same commandId -- e.g. a generic 500, or a 429
    /// "rate_limited" -- must also reuse the cached timestamp on retry. The old code removed
    /// `commandTimestamps[commandId]` right after `decoder.decode` succeeded and before checking
    /// `status >= 300`, so this case minted a fresh timestamp even though the caller resends the
    /// same commandId.
    func testRetryAfterDecodedHTTPErrorReusesTheSameTimestamp() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()

        server.respondOnce(
            statusLine: "HTTP/1.1 500 Internal Server Error",
            body: #"{"error":"internal"}"#,
            onRequest: capture.record
        )
        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_retry_5xx"
            )
            XCTFail("expected the decoded 500 response to throw")
        } catch BridgeError.http(let status, _) {
            XCTAssertEqual(status, 500)
        }

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)
        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_retry_5xx"
        )

        let first = try XCTUnwrap(capture.requestBody(at: 0))
        let second = try XCTUnwrap(capture.requestBody(at: 1))
        XCTAssertEqual(first["commandId"] as? String, "cmd_retry_5xx")
        XCTAssertEqual(second["commandId"] as? String, "cmd_retry_5xx")
        XCTAssertEqual(
            first["timestamp"] as? String,
            second["timestamp"] as? String,
            "a same-commandId retry after a decoded HTTP error must resend the original timestamp"
        )
    }

    /// Investigates E-15: a `stale_request` (401) is rejected by `verifyEnvelope`
    /// (bridge/src/auth/verify.ts:341-343) purely on the `X-AgentRemote-Timestamp` *header*,
    /// checked before the command idempotency store is ever consulted (bridge/src/server.ts:714).
    /// `signedRequest` mints that header's timestamp fresh on every call (see
    /// `testSigningIsFreshPerRequest` above) independently of `commandTimestamps[commandId]`,
    /// which only feeds the request *body*'s redundant `timestamp` field used solely to keep the
    /// idempotency digest stable (bridge/src/server.ts:710, `bodyDigest = sha256(rawBody)`). Since
    /// a stale_request rejection never reaches that digest check, retrying with the same
    /// commandId cannot resend "the same stale timestamp" to the check that produced the 401: the
    /// header is rebuilt fresh, and the retry succeeds once it is back inside the skew window.
    func testRetryAfterStaleRequestGetsAFreshHeaderTimestampAndSucceeds() async throws {
        let server = LoopbackHTTPServer()
        defer { server.stop() }
        let client = BridgeClient(baseURL: server.baseURL, credentialStore: InMemoryCredentialStore(makeCredential()))
        let capture = RequestCapture()

        server.respondOnce(
            statusLine: "HTTP/1.1 401 Unauthorized",
            body: #"{"error":"stale_request"}"#,
            onRequest: capture.record
        )
        do {
            _ = try await client.send(
                .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
                sessionId: "sess_demo",
                commandId: "cmd_stale_9012"
            )
            XCTFail("expected the decoded stale_request response to throw")
        } catch BridgeError.staleRequest {
            // expected
        }

        server.respondOnce(statusLine: "HTTP/1.1 200 OK", body: #"{"accepted":true}"#, onRequest: capture.record)
        _ = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: "sess_demo",
            commandId: "cmd_stale_9012"
        )

        let firstHeaders = try XCTUnwrap(capture.requestHeaders(at: 0))
        let secondHeaders = try XCTUnwrap(capture.requestHeaders(at: 1))
        XCTAssertNotEqual(
            firstHeaders["x-agentremote-timestamp"],
            secondHeaders["x-agentremote-timestamp"],
            "a retry after stale_request must carry a freshly minted header timestamp, not the rejected one"
        )
    }
}
