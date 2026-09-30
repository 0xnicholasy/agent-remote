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
                    if store.authorizedProjects.count > 1 {
                        Picker(
                            "Project",
                            selection: Binding(
                                get: { store.selectedProjectId },
                                set: { store.selectProject($0) }
                            )
                        ) {
                            Text("Choose project").tag(String?.none)
                            ForEach(store.authorizedProjects) { project in
                                Text(project.name).tag(Optional(project.id))
                            }
                        }
                    } else if let project = store.authorizedProjects.first {
                        LabeledContent("Project", value: project.name)
                    } else {
                        LabeledContent("Project", value: "None authorized")
                    }
                    if let error = store.configurationError {
                        Text(error).font(.caption2).foregroundStyle(.secondary)
                    }
                    Button("Refresh projects") { Task { await store.refreshBridgeConfiguration() } }
                    Button("Create session") { Task { await store.createSession() } }
                        .disabled(store.isRefreshingConfiguration || store.selectedProjectId == nil || store.canCancelTurn)
                }
                Section("Pairing") {
                    LabeledContent("Device", value: store.paired ? "Paired" : "Not paired")
                    NavigationLink("Pair Watch") { PairingView(resetsOnDismiss: true) }
                }
                Section("Speech") {
                    Toggle("Mute", isOn: Bindable(store.speaker).muted)
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
