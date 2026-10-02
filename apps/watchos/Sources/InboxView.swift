import SwiftUI

/// Every approval and question waiting across sessions, soonest to expire first. Tapping a row
/// opens that session's conversation page, where the card is.
struct InboxView: View {
    @Environment(SessionStore.self) private var store
    let open: () -> Void

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                List {
                    if store.pendingInteractions.isEmpty {
                        Text("Nothing waiting")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.pendingInteractions) { item in
                        Button {
                            store.selectSession(item.sessionId)
                            open()
                        } label: {
                            InboxRow(item: item, projectName: store.projectName(item.projectId), now: context.date)
                        }
                        .accessibilityIdentifier("inbox-\(item.id)")
                    }
                }
            }
            .navigationTitle("Waiting")
        }
    }
}

private struct InboxRow: View {
    let item: PendingInteraction
    let projectName: String
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(projectName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                if let countdown = PendingInteraction.countdown(to: item.expiresAt, now: now) {
                    Text(countdown)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.orange)
                }
            }
            Text(item.title)
                .font(.footnote)
                .lineLimit(2)
            Text(item.kind == .approval ? "Approval" : "Question")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }
}
