import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            ConversationView()
            SettingsView()
        }
        .tabViewStyle(.verticalPage)
    }
}

/// The transcript of the current session, oldest first, with the pending choice card and a
/// Reply button pinned under it.
struct ConversationView: View {
    @Environment(SessionStore.self) private var store
    @State private var dictating = false
    @State private var confirmingStop = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        // No trailing controls on this row: the page indicator sits at the right
                        // edge, and mute lives in Settings.
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 4) {
                                statePill
                                syncLabel
                            }
                            if !store.connected
                                || [.skippedEvents, .requestInvalid, .error, .authFailed].contains(store.statusKind) {
                                Text(store.statusLine)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        ForEach(store.transcript) { item in
                            TranscriptRow(item: item).id(item.id)
                        }
                        if let approval = store.pendingApproval {
                            ChoiceCardView(approval: approval).id("choice-\(approval.binding.approvalId)")
                        } else if let question = store.pendingQuestion {
                            ChoiceCardView(question: question, onOther: { dictating = true })
                                .id("choice-\(question.questionId)")
                        } else if store.actionOutcome == .acknowledged {
                            // The card that was just approved/denied/answered is already gone;
                            // this is the only place its "Sent" outcome is still visible. Clears
                            // itself as soon as the next card arrives or the outcome changes.
                            Text(ActionOutcome.acknowledged.label)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        if store.canCancelTurn {
                            // Named "Stop turn" so it is not confused with Settings' "Cancel turn";
                            // both send the same session.cancel. Confirmed first because a stray
                            // tap on a small screen would end the agent's work.
                            Button("Stop turn", role: .destructive) { confirmingStop = true }
                                .disabled(store.isSending)
                        }
                        Button("Reply") { dictating = true }
                            .buttonStyle(.bordered)
                            .id("reply-\(store.transcript.count)")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: scrollAnchor) { _, anchor in
                    // Top-aligned so a card's title sits just below the clock instead of in the
                    // blurred edge under it.
                    withAnimation { proxy.scrollTo(anchor, anchor: .top) }
                }
            }
            // No navigation title: on this page it only covered the top of a pending card.
            .sheet(isPresented: $dictating) { DictateView() }
            .confirmationDialog("Stop this turn?", isPresented: $confirmingStop) {
                Button("Stop turn", role: .destructive) { Task { await store.cancel() } }
            }
        }
    }

    /// A pending choice pulls focus; otherwise the newest transcript line does.
    private var scrollAnchor: String {
        if let approval = store.pendingApproval { return "choice-\(approval.binding.approvalId)" }
        if let question = store.pendingQuestion { return "choice-\(question.questionId)" }
        return "reply-\(store.transcript.count)"
    }

    private var statePill: some View {
        Text(store.turnState.label)
            .font(.caption2)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(pillColor.opacity(0.3), in: Capsule())
    }

    /// Always shown, so "up to date" is something the Watch states rather than something the
    /// user infers from the absence of an error.
    private var syncLabel: some View {
        Text(store.syncState.label)
            .font(.caption2)
            .foregroundStyle(syncColor)
    }

    private var syncColor: Color {
        switch store.syncState {
        case .current: .green
        case .syncing: .yellow
        case .disconnected: .red
        }
    }

    private var pillColor: Color {
        switch store.turnState {
        case .idle: .gray
        case .thinking, .running: .blue
        case .waiting: .orange
        case .completed: .green
        case .error: .red
        }
    }
}

struct TranscriptRow: View {
    let item: TranscriptItem

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(item.text)
                .font(item.role == .system ? .caption2 : .footnote)
                .foregroundStyle(item.role == .system ? .secondary : .primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var label: String {
        switch item.role {
        case .user: "You"
        case .agent: "Agent"
        case .system: "Activity"
        }
    }
}
