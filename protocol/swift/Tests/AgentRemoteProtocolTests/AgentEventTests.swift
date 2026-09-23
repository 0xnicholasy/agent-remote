import Foundation
import Testing

@testable import AgentRemoteProtocol

/// The same sample payloads that the TypeScript package validates against the JSON Schemas.
private let approvalRequestedJSON = """
{
  "eventId": 42,
  "sessionId": "ses_01",
  "provider": "mock",
  "type": "approval.requested",
  "timestamp": "2026-09-14T10:15:00.000Z",
  "payload": {
    "binding": {
      "approvalId": "apr_01",
      "sessionId": "ses_01",
      "turnId": "trn_01",
      "toolCallId": "tc_01",
      "actionDigest": "sha256:6f1c0b1e6b4f0a2d",
      "expiresAt": "2026-09-14T10:20:00.000Z"
    },
    "kind": "command",
    "title": "Run git push origin main",
    "detail": "Pushes 3 commits to origin/main."
  }
}
"""

private let approvalAcceptJSON = """
{
  "commandId": "9f3a1d54-3b1e-4a0c-9d58-2f0f1d7c9a11",
  "sessionId": "ses_01",
  "type": "approval.accept",
  "timestamp": "2026-09-14T10:15:30.000Z",
  "payload": {
    "binding": {
      "approvalId": "apr_01",
      "sessionId": "ses_01",
      "turnId": "trn_01",
      "toolCallId": "tc_01",
      "actionDigest": "sha256:6f1c0b1e6b4f0a2d",
      "expiresAt": "2026-09-14T10:20:00.000Z"
    }
  }
}
"""

@Test func decodesApprovalRequestedEvent() throws {
    let event = try JSONDecoder().decode(AgentEvent.self, from: Data(approvalRequestedJSON.utf8))

    #expect(event.eventId == 42)
    #expect(event.sessionId == "ses_01")
    #expect(event.provider == "mock")
    #expect(event.type == .approvalRequested)

    guard case .approvalRequested(let request) = event.payload else {
        Issue.record("expected an approval.requested payload")
        return
    }
    #expect(request.kind == .command)
    #expect(request.title == "Run git push origin main")
    #expect(request.binding.approvalId == "apr_01")
    #expect(request.binding.actionDigest == "sha256:6f1c0b1e6b4f0a2d")
}

@Test func roundTripsApprovalRequestedEvent() throws {
    let event = try JSONDecoder().decode(AgentEvent.self, from: Data(approvalRequestedJSON.utf8))
    let encoded = try JSONEncoder().encode(event)
    let again = try JSONDecoder().decode(AgentEvent.self, from: encoded)
    #expect(again == event)
}

@Test func decodesTheProjectStampAndLeavesItNilWhenAbsent() throws {
    // The bridge stamps the project an event was emitted under; a log written before the field
    // existed has no stamp at all, and both shapes have to decode.
    let stamped = approvalRequestedJSON.replacingOccurrences(
        of: "\"sessionId\": \"ses_01\",\n  \"provider\"",
        with: "\"sessionId\": \"ses_01\",\n  \"projectId\": \"prj_01\",\n  \"provider\"")
    let withStamp = try JSONDecoder().decode(AgentEvent.self, from: Data(stamped.utf8))
    #expect(withStamp.projectId == "prj_01")

    let withoutStamp = try JSONDecoder().decode(AgentEvent.self, from: Data(approvalRequestedJSON.utf8))
    #expect(withoutStamp.projectId == nil)

    let encoded = try JSONEncoder().encode(withStamp)
    #expect(try JSONDecoder().decode(AgentEvent.self, from: encoded) == withStamp)
}

@Test func decodesApprovalAcceptCommand() throws {
    let command = try JSONDecoder().decode(Command.self, from: Data(approvalAcceptJSON.utf8))

    #expect(command.type == .approvalAccept)
    #expect(command.commandId == "9f3a1d54-3b1e-4a0c-9d58-2f0f1d7c9a11")

    guard case .approvalAccept(let payload) = command.payload else {
        Issue.record("expected an approval.accept payload")
        return
    }
    #expect(payload.binding.turnId == "trn_01")
}

@Test func rejectsAPayloadThatDoesNotMatchItsType() {
    let mismatched = approvalAcceptJSON.replacingOccurrences(
        of: "\"approval.accept\"", with: "\"question.answer\"")
    #expect(throws: (any Error).self) {
        _ = try JSONDecoder().decode(Command.self, from: Data(mismatched.utf8))
    }
}
