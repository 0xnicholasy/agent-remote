import SwiftUI

/// Lists the projects the bridge lets this Watch use; the chosen one is where new sessions start.
struct ProjectPickerView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var isLoading = false

    var body: some View {
        List {
            if store.projects.isEmpty {
                Text(isLoading ? "Loading..." : "No projects. Allow one on the Mac with `bun run bridge projects allow`.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            ForEach(store.projects) { project in
                Button {
                    store.selectProject(project.id)
                    dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(project.name)
                            Text(project.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if project.id == store.selectedProjectId {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                .accessibilityIdentifier("project-\(project.id)")
            }
        }
        .navigationTitle("Project")
        .task {
            isLoading = true
            await store.loadProjects()
            isLoading = false
        }
    }
}
