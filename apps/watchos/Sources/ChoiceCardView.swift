import SwiftUI
import AgentRemoteProtocol

/// Renders whichever request is pending: an approval shows Deny and Allow, a question shows
/// its options plus an "Other" button when the bridge allows free text.
struct ChoiceCardView: View {
    @Environment(SessionStore.self) private var store

    private let approval: ApprovalRequest?
    private let question: QuestionRequestedPayload?
    private let onOther: (() -> Void)?

    init(approval: ApprovalRequest) {
        self.approval = approval
        self.question = nil
        self.onOther = nil
    }

    init(question: QuestionRequestedPayload, onOther: @escaping () -> Void) {
        self.approval = nil
        self.question = question
        self.onOther = onOther
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(prompt)
                .font(.footnote.weight(.semibold))
            if let detail = approval?.detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
            if approval != nil {
                Button("Deny", role: .destructive) { Task { await store.reject() } }
                Button("Allow") { Task { await store.approve() } }
                    .tint(.green)
            }
            if let question {
                ForEach(question.options, id: \.id) { option in
                    Button(option.label) { Task { await store.answer(optionId: option.id) } }
                }
                if question.allowFreeText {
                    Button("Other...") { onOther?() }
                        .buttonStyle(.bordered)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
        .disabled(store.isSending)
    }

    private var prompt: String {
        if let approval { return "Agent wants to run: \(approval.title)" }
        return question?.text ?? ""
    }
}
