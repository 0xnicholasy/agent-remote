import XCTest
import AgentRemoteProtocol

/// Verifies the lenient events-page decoder skips one malformed event without failing the
/// whole page, and still advances the cursor past it. Needs no running bridge.
final class EventsPageDecoderTests: XCTestCase {
    func testSkipsEventMissingSessionId() throws {
        let json = """
        {
            "lastEventId": 5,
            "events": [
                {
                    "eventId": 5,
                    "sessionId": "sess_1",
                    "provider": "mock",
                    "timestamp": "2026-09-17T00:00:00.000Z",
                    "type": "turn.completed",
                    "payload": { "turnId": "t1" }
                },
                {
                    "eventId": 7,
                    "provider": "mock",
                    "timestamp": "2026-09-17T00:00:01.000Z",
                    "type": "turn.completed",
                    "payload": { "turnId": "t2" }
                }
            ]
        }
        """
        let page = try EventsPageDecoder.decode(Data(json.utf8), using: JSONDecoder())

        XCTAssertEqual(page.events.count, 1)
        XCTAssertEqual(page.events.first?.eventId, 5)
        XCTAssertEqual(page.skipped, 1)
        XCTAssertEqual(page.lastEventId, 7)
        XCTAssertFalse(page.truncated, "a bridge that predates the field must read as not truncated")
        XCTAssertNil(page.bridgeId)
    }

    func testDecodesRecoveryFields() throws {
        let json = """
        { "lastEventId": 9, "events": [], "firstEventId": 4, "truncated": true, "bridgeId": "brg_1a2b3c4d" }
        """
        let page = try EventsPageDecoder.decode(Data(json.utf8), using: JSONDecoder())

        XCTAssertEqual(page.firstEventId, 4)
        XCTAssertTrue(page.truncated)
        XCTAssertEqual(page.bridgeId, "brg_1a2b3c4d")
    }
}
