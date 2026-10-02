import SwiftUI

/// Every session this Watch can see, newest activity first, with how many requests each is
/// waiting on. Tapping a row opens it on the conversation page.
struct SessionListView: View {
    @Environment(SessionStore.self) private var store
    let open: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Button("New session") {
                    Task {
                        if await store.createSession() != nil { open() }
                    }
                }
                .disabled(store.selectedProject == nil)
                if store.sessionList.isEmpty {
                    Text("No sessions yet")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(store.sessionList) { session in
                    Button {
                        store.selectSession(session.id)
                        open()
                    } label: {
                        SessionRow(
                            session: session,
                            projectName: store.projectName(session.projectId),
                            selected: session.id == store.selectedSessionId
                        )
                    }
                    .accessibilityIdentifier("session-\(session.id)")
                }
            }
            .navigationTitle("Sessions")
        }
    }
}

private struct SessionRow: View {
    let session: SessionModel
    let projectName: String
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(projectName)
                    .font(.footnote)
                    .lineLimit(1)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption2)
                }
            }
            HStack(spacing: 4) {
                Text(session.ended ? "Ended" : session.turnState.label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if session.waitingCount > 0 {
                    Text("\(session.waitingCount) waiting")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
        }
    }
}
