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
                // A desk-only approval (M4): the exact action was not shown, so Allow is omitted
                // entirely rather than shown disabled — there is nothing on this card the user
                // could be authorizing.
                if approval?.requiresDeskReview == false {
                    Button("Allow") { Task { await store.approve() } }
                        .tint(.green)
                }
            }
            if let approval, approval.requiresDeskReview {
                Text(deskReviewCaption(for: approval))
                    .font(.caption2)
                    .foregroundStyle(.orange)
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
            if let outcome = store.outcome(forCard: cardId) {
                Text(outcome.label)
                    .font(.caption2)
                    .foregroundStyle(outcome == .sending ? Color.secondary : Color.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
        .disabled(store.isSending)
    }

    private var cardId: String {
        approval?.binding.approvalId ?? question?.questionId ?? ""
    }

    private var prompt: String {
        if let approval { return approval.title }
        return question?.text ?? ""
    }

    /// "Review at the Mac before allowing", with a "(N chars, M shown)" suffix when the request
    /// carries `fullLength`, so a truncated card also says how much of the action is hidden.
    private func deskReviewCaption(for approval: ApprovalRequest) -> String {
        let base = "Review at the Mac before allowing"
        guard let fullLength = approval.fullLength else { return base }
        return "\(base) (\(fullLength) chars, \(approval.title.count) shown)"
    }
}
