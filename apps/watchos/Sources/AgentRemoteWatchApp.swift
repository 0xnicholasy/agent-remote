import SwiftUI

@main
struct AgentRemoteWatchApp: App {
    @State private var store = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task { store.start() }
        }
    }
}
