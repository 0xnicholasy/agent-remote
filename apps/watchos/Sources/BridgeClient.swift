import CryptoKit
import Foundation
import AgentRemoteProtocol

/// The body of `GET /v1/events`, decoded leniently: an event that fails to decode (for
/// example one missing `sessionId`) is skipped instead of failing the whole page, but its
/// `eventId` still advances the cursor so the poll loop does not retry it forever.
///
/// `firstEventId`, `truncated` and `bridgeId` are optional on the wire (docs/durability-v0.md);
/// a bridge that predates them decodes as nil / false.
struct EventsPage: Sendable {
    var events: [AgentEvent]
    var lastEventId: Int
    var skipped: Int
    /// Oldest event id the bridge still retains, 0 when its log is empty.
    var firstEventId: Int? = nil
    /// The requested cursor sits below the retained window: events between it and this page
    /// were pruned and can never be fetched, so the page is not a continuation.
    var truncated = false
    /// Identifies the bridge's state dir, so a changed value means a different bridge (or one
    /// whose state was wiped) rather than a restart of the same one.
    var bridgeId: String? = nil
}

/// Decodes an events page leniently: `lastEventId` and the raw `events` array are parsed
/// first, then each element is decoded into `AgentEvent` individually.
enum EventsPageDecoder {
    static func decode(_ data: Data, using decoder: JSONDecoder) throws -> EventsPage {
        guard
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let lastEventId = root["lastEventId"] as? Int,
            let rawEvents = root["events"] as? [[String: Any]]
        else {
            throw BridgeError.malformedResponse("expected an object with lastEventId and events")
        }

        var events: [AgentEvent] = []
        var skipped = 0
        var maxEventId = lastEventId
        for raw in rawEvents {
            if let eventData = try? JSONSerialization.data(withJSONObject: raw),
                let event = try? decoder.decode(AgentEvent.self, from: eventData) {
                events.append(event)
                maxEventId = max(maxEventId, event.eventId)
            } else {
                skipped += 1
                if let eventId = raw["eventId"] as? Int {
                    maxEventId = max(maxEventId, eventId)
                }
            }
        }
        let firstEventId: Int?
        if let raw = root["firstEventId"], !(raw is NSNull) {
            guard let value = raw as? Int else {
                throw BridgeError.malformedResponse("firstEventId has the wrong type")
            }
            firstEventId = value
        } else {
            firstEventId = nil
        }

        let truncated: Bool
        if let raw = root["truncated"], !(raw is NSNull) {
            guard let value = raw as? Bool else {
                throw BridgeError.malformedResponse("truncated has the wrong type")
            }
            truncated = value
        } else {
            truncated = false
        }

        let bridgeId: String?
        if let raw = root["bridgeId"], !(raw is NSNull) {
            guard let value = raw as? String else {
                throw BridgeError.malformedResponse("bridgeId has the wrong type")
            }
            bridgeId = value
        } else {
            bridgeId = nil
        }

        return EventsPage(
            events: events,
            lastEventId: maxEventId,
            skipped: skipped,
            firstEventId: firstEventId,
            truncated: truncated,
            bridgeId: bridgeId
        )
    }
}

/// The body of `POST /v1/commands`. A rejected command carries `error` instead of `accepted`.
struct CommandResponse: Decodable, Sendable {
    var accepted: Bool? = nil
    var commandId: String? = nil
    var duplicate: Bool? = nil
    var sessionId: String? = nil
    var error: String? = nil
}

struct SessionsResponse: Decodable, Sendable {
    var sessions: [Session]
}

enum BridgeError: Error, CustomStringConvertible, Sendable, Equatable {
    case invalidHost(String)
    case http(status: Int, message: String)
    case malformedResponse(String)
    /// No device credential is stored yet; the request was never sent unsigned.
    case notPaired
    case unauthenticated
    case deviceRevoked
    case staleRequest
    case replayedRequest
    case actionNotAllowed
    case projectNotAllowed
    case decisionExpired
    case commandIdConflict
    case rateLimited
    /// The bridge stopped while this command was running and cannot say whether it took effect.
    case commandIndeterminate
    /// The approval or question is no longer waiting for an answer (already decided, expired,
    /// cancelled or superseded).
    case interactionNotPending

    var description: String {
        switch self {
        case .invalidHost(let value): "Not a usable bridge address: \(value)"
        case .http(let status, let message): "Bridge returned \(status): \(message)"
        case .malformedResponse(let message): "Bridge sent a response the client could not parse: \(message)"
        case .notPaired: "This Watch is not paired with a bridge yet."
        case .unauthenticated: "The bridge did not accept this device's credentials."
        case .deviceRevoked: "This Watch's pairing was revoked."
        case .staleRequest: "This request's timestamp is too far from the bridge's clock."
        case .replayedRequest: "The bridge rejected this request as a replay."
        case .actionNotAllowed: "This Watch is not allowed to do that."
        case .projectNotAllowed: "This Watch is not allowed to use that project."
        case .decisionExpired: "That approval or question already expired."
        case .commandIdConflict: "That command was already sent with different contents."
        case .rateLimited: "The bridge is rate limiting requests from this Watch; it will retry shortly."
        case .commandIndeterminate: "The bridge cannot tell whether that command took effect."
        case .interactionNotPending: "That request is no longer waiting for an answer."
        }
    }

    /// Maps a bridge JSON error code (docs/pairing-v0.md, "Verification order" and "Command
    /// authorization") to a specific case, falling back to `.http` for anything else --
    /// including pre-existing, non-auth error bodies such as a stale approval binding.
    static func from(status: Int, code: String?, message: String) -> BridgeError {
        switch code {
        case "unauthenticated": .unauthenticated
        case "device_revoked": .deviceRevoked
        case "stale_request": .staleRequest
        case "replayed_request": .replayedRequest
        case "action_not_allowed": .actionNotAllowed
        case "project_not_allowed": .projectNotAllowed
        case "decision_expired": .decisionExpired
        case "command_id_conflict": .commandIdConflict
        case "rate_limited": .rateLimited
        case "command_indeterminate": .commandIndeterminate
        case "interaction_not_pending": .interactionNotPending
        default: .http(status: status, message: message)
        }
    }
}

private struct ErrorBody: Decodable {
    var error: String?
}

/// The calls `SessionStore` makes on the bridge client. Lets tests substitute a fake client
/// without opening a real network connection.
protocol BridgeClientProtocol: Sendable {
    func setBaseURL(_ url: URL) async
    func pair(code: String, deviceName: String) async throws
    func isPaired() async -> Bool
    func events(after: Int, wait: Int) async throws -> EventsPage
    /// `commandId` is the idempotency key: resending the same payload with the same id gets the
    /// bridge's recorded outcome instead of running the command again.
    @discardableResult
    func send(_ payload: CommandPayload, sessionId: String, commandId: String) async throws -> CommandResponse
}

extension BridgeClientProtocol {
    @discardableResult
    func send(_ payload: CommandPayload, sessionId: String) async throws -> CommandResponse {
        try await send(payload, sessionId: sessionId, commandId: UUID().uuidString)
    }
}

/// Talks to the Mac Agent Bridge over the HTTP long-poll baseline. One instance per app.
actor BridgeClient: BridgeClientProtocol {
    static let defaultBaseURL = URL(string: "http://localhost:8787")!

    private var baseURL: URL
    private let urlSession: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let credentialStore: any CredentialStore
    private var credential: DeviceCredential?

    init(baseURL: URL = BridgeClient.defaultBaseURL, credentialStore: any CredentialStore = KeychainCredentialStore()) {
        self.baseURL = baseURL
        self.credentialStore = credentialStore
        self.credential = credentialStore.load()
        let configuration = URLSessionConfiguration.ephemeral
        // Long polls hold the connection open for up to 30 seconds, so the request
        // timeout has to sit comfortably above the bridge's own ceiling.
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 120
        configuration.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: configuration)
    }

    func setBaseURL(_ url: URL) {
        baseURL = url
    }

    func currentBaseURL() -> URL {
        baseURL
    }

    func isPaired() -> Bool {
        credential != nil
    }

    /// `POST /v1/pair`: the only signed-off route. Derives the device key locally from the
    /// pairing code and the bridge's response, and never sends the code or the key over the
    /// wire (docs/pairing-v0.md, "Enrollment").
    func pair(code: String, deviceName: String) async throws {
        struct PairRequestBody: Encodable {
            var deviceId: String
            var deviceName: String
            var nonce: String
            var proof: String
        }
        struct PairResponseBody: Decodable {
            var deviceId: String
            var keyId: String
            var bridgeId: String
        }

        let normalizedCode = PairingCode.normalize(code)
        let deviceId = "dev_" + RequestSigning.randomHex(bytes: 8)
        let nonce = RequestSigning.randomHex(bytes: 16)
        let proof = RequestSigning.pairingProof(
            code: normalizedCode, deviceId: deviceId, deviceName: deviceName, nonce: nonce
        )

        var request = URLRequest(url: baseURL.appending(path: "/v1/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(
            PairRequestBody(deviceId: deviceId, deviceName: deviceName, nonce: nonce, proof: proof)
        )

        let (data, response) = try await urlSession.data(for: request)
        try Self.checkStatus(response, data: data)
        let decoded = try decoder.decode(PairResponseBody.self, from: data)

        let deviceKey = RequestSigning.deriveDeviceKey(code: normalizedCode, deviceId: deviceId, nonce: nonce)
        let newCredential = DeviceCredential(
            deviceId: decoded.deviceId,
            keyId: decoded.keyId,
            deviceKeyData: deviceKey.withUnsafeBytes { Data($0) },
            bridgeId: decoded.bridgeId,
            baseURL: baseURL
        )
        try credentialStore.save(newCredential)
        credential = newCredential
    }

    /// Long polls for events newer than `after`, waiting up to `wait` seconds for the first one.
    func events(after: Int, wait: Int) async throws -> EventsPage {
        var components = URLComponents(url: baseURL.appending(path: "/v1/events"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "after", value: String(after)),
            URLQueryItem(name: "wait", value: String(wait)),
        ]
        guard let url = components?.url else { throw BridgeError.invalidHost(baseURL.absoluteString) }
        let data = try await get(url)
        return try EventsPageDecoder.decode(data, using: decoder)
    }

    func sessions() async throws -> [Session] {
        let data = try await get(baseURL.appending(path: "/v1/sessions"))
        return try decoder.decode(SessionsResponse.self, from: data).sessions
    }

    /// Submits one command, minting a fresh idempotency key for it.
    @discardableResult
    func send(_ payload: CommandPayload, sessionId: String, commandId: String) async throws -> CommandResponse {
        let command = Command(
            commandId: commandId,
            sessionId: sessionId,
            timestamp: BridgeClient.timestamp(),
            payload: payload
        )
        let body = try encoder.encode(command)
        var request = try signedRequest(method: "POST", url: baseURL.appending(path: "/v1/commands"), body: body)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let (data, response) = try await urlSession.data(for: request)
        let decoded = try decoder.decode(CommandResponse.self, from: data)
        if let status = (response as? HTTPURLResponse)?.statusCode, status >= 300 {
            throw BridgeError.from(status: status, code: decoded.error, message: decoded.error ?? "unknown error")
        }
        return decoded
    }

    private func get(_ url: URL) async throws -> Data {
        let request = try signedRequest(method: "GET", url: url, body: nil)
        let (data, response) = try await urlSession.data(for: request)
        try Self.checkStatus(response, data: data)
        return data
    }

    /// Builds a request carrying the four `X-AgentRemote-*` headers, signed over the method,
    /// path-and-query exactly as sent, timestamp, nonce and body digest (docs/pairing-v0.md,
    /// "Signed request envelope"). Throws `.notPaired` instead of ever sending a request unsigned.
    func signedRequest(method: String, url: URL, body: Data?) throws -> URLRequest {
        guard let credential else { throw BridgeError.notPaired }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body

        let nonce = RequestSigning.randomHex(bytes: 16)
        let timestamp = BridgeClient.timestamp()
        let bodyHash = RequestSigning.bodySHA256(body)
        let pathWithQuery = url.path + (url.query.map { "?\($0)" } ?? "")
        let signingString = RequestSigning.signingString(
            method: method, pathWithQuery: pathWithQuery, timestamp: timestamp, nonce: nonce, bodySHA256: bodyHash
        )
        let signature = RequestSigning.signature(deviceKey: credential.deviceKey, signingString: signingString)

        request.setValue(credential.deviceId, forHTTPHeaderField: "X-AgentRemote-Device")
        request.setValue(timestamp, forHTTPHeaderField: "X-AgentRemote-Timestamp")
        request.setValue(nonce, forHTTPHeaderField: "X-AgentRemote-Nonce")
        request.setValue(signature, forHTTPHeaderField: "X-AgentRemote-Signature")
        return request
    }

    private static func checkStatus(_ response: URLResponse, data: Data) throws {
        guard let status = (response as? HTTPURLResponse)?.statusCode, status >= 300 else { return }
        let code = try? JSONDecoder().decode(ErrorBody.self, from: data).error
        let message = code ?? String(decoding: data, as: UTF8.self)
        throw BridgeError.from(status: status, code: code, message: message)
    }

    static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date())
    }

    /// Parses a host the user typed in Settings. A bare host or `host:port` gets `http://`.
    static func parseBaseURL(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains("://") { return URL(string: trimmed) }
        return URL(string: "http://\(trimmed)")
    }
}
