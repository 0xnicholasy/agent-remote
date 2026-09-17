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

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                statePill
                                if !store.connected || store.statusKind == .skippedEvents {
                                    Text(store.statusLine)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button {
                                store.speaker.muted.toggle()
                            } label: {
                                Image(systemName: store.speaker.muted ? "speaker.slash" : "speaker.wave.2")
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(store.transcript) { item in
                            TranscriptRow(item: item).id(item.id)
                        }
                        if let approval = store.pendingApproval {
                            ChoiceCardView(approval: approval).id("choice-\(approval.binding.approvalId)")
                        } else if let question = store.pendingQuestion {
                            ChoiceCardView(question: question, onOther: { dictating = true })
                                .id("choice-\(question.questionId)")
                        }
                        Button("Reply") { dictating = true }
                            .buttonStyle(.bordered)
                            .id("reply-\(store.transcript.count)")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: scrollAnchor) { _, anchor in
                    withAnimation { proxy.scrollTo(anchor, anchor: .center) }
                }
            }
            .navigationTitle("Agent Remote")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $dictating) { DictateView() }
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
