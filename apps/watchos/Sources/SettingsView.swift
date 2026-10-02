import SwiftUI

/// Bridge address, speech toggle, and the connection state the poll loop reports.
struct SettingsView: View {
    @Environment(SessionStore.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            Form {
                Section("Bridge") {
                    TextField("host:port", text: $store.hostText)
                    Button("Connect") { Task { await store.reconnect() } }
                    LabeledContent("Provider", value: store.bridgeInfo?.provider ?? "Unavailable")
                    NavigationLink {
                        ProjectPickerView()
                    } label: {
                        LabeledContent("Project", value: store.selectedProject?.name ?? (store.projects.isEmpty ? "None authorized" : "Choose"))
                    }
                    if let error = store.configurationError {
                        Text(error).font(.caption2).foregroundStyle(.secondary)
                    }
                    Button("Refresh projects") { Task { await store.refreshBridgeConfiguration() } }
                    Button("Create session") { Task { await store.createSession() } }
                        .disabled(store.isRefreshingConfiguration || store.selectedProjectId == nil)
                }
                Section("Pairing") {
                    LabeledContent("Device", value: store.paired ? "Paired" : "Not paired")
                    NavigationLink("Pair Watch") { PairingView(resetsOnDismiss: true) }
                }
                Section("Speech") {
                    Toggle("Mute", isOn: Bindable(store.speaker).muted)
                }
                Section("Requests") {
                    Toggle("Advance to next request", isOn: $store.advanceToNextRequest)
                }
                Section("Status") {
                    LabeledContent("State", value: store.syncState.label)
                    LabeledContent("Last event", value: String(store.lastSeenEventId))
                    LabeledContent("Session", value: store.sessionId ?? "none")
                    Text(store.statusLine).font(.caption2).foregroundStyle(.secondary)
                }
                Section {
                    Button("Cancel turn", role: .destructive) { Task { await store.cancel() } }
                        .disabled(store.isSending)
                }
                Section {
                    Text(BuildInfo.versionLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("app-build-version")
                }
            }
            .navigationTitle("Settings")
        }
    }
}
