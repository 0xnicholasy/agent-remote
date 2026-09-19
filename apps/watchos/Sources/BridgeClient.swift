import Foundation
import AgentRemoteProtocol

/// The body of `GET /v1/events`, decoded leniently: an event that fails to decode (for
/// example one missing `sessionId`) is skipped instead of failing the whole page, but its
/// `eventId` still advances the cursor so the poll loop does not retry it forever.
struct EventsPage: Sendable {
    var events: [AgentEvent]
    var lastEventId: Int
    var skipped: Int
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
        return EventsPage(events: events, lastEventId: maxEventId, skipped: skipped)
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

enum BridgeError: Error, CustomStringConvertible, Sendable {
    case invalidHost(String)
    case http(status: Int, message: String)
    case malformedResponse(String)

    var description: String {
        switch self {
        case .invalidHost(let value): "Not a usable bridge address: \(value)"
        case .http(let status, let message): "Bridge returned \(status): \(message)"
        case .malformedResponse(let message): "Bridge sent a response the client could not parse: \(message)"
        }
    }
}

/// The calls `SessionStore` makes on the bridge client. Lets tests substitute a fake client
/// without opening a real network connection.
protocol BridgeClientProtocol: Sendable {
    func setBaseURL(_ url: URL) async
    func events(after: Int, wait: Int) async throws -> EventsPage
    @discardableResult
    func send(_ payload: CommandPayload, sessionId: String) async throws -> CommandResponse
}

/// Talks to the Mac Agent Bridge over the HTTP long-poll baseline. One instance per app.
actor BridgeClient: BridgeClientProtocol {
    static let defaultBaseURL = URL(string: "http://localhost:8787")!

    private var baseURL: URL
    private let urlSession: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL = BridgeClient.defaultBaseURL) {
        self.baseURL = baseURL
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
    func send(_ payload: CommandPayload, sessionId: String) async throws -> CommandResponse {
        let command = Command(
            commandId: UUID().uuidString,
            sessionId: sessionId,
            timestamp: BridgeClient.timestamp(),
            payload: payload
        )
        var request = URLRequest(url: baseURL.appending(path: "/v1/commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(command)
        let (data, response) = try await urlSession.data(for: request)
        let decoded = try decoder.decode(CommandResponse.self, from: data)
        if let status = (response as? HTTPURLResponse)?.statusCode, status >= 300 {
            throw BridgeError.http(status: status, message: decoded.error ?? "unknown error")
        }
        return decoded
    }

    private func get(_ url: URL) async throws -> Data {
        let (data, response) = try await urlSession.data(from: url)
        if let status = (response as? HTTPURLResponse)?.statusCode, status >= 300 {
            throw BridgeError.http(status: status, message: String(decoding: data, as: UTF8.self))
        }
        return data
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
