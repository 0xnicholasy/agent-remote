import Foundation

/// Shown on the Watch itself (onboarding's first step, the paired home screen, and Settings) so
/// the user can read back which build actually got installed. `CFBundleVersion` is stamped from
/// CURRENT_PROJECT_VERSION at build time (see the xcodebuild invocation used to install on
/// device); "?" only if the plist lookup ever fails.
enum BuildInfo {
    static var versionLabel: String {
        let info = Bundle.main.infoDictionary
        let shortVersion = (info?["CFBundleShortVersionString"] as? String) ?? "?"
        let buildVersion = (info?["CFBundleVersion"] as? String) ?? "?"
        return "v\(shortVersion) (\(buildVersion))"
    }
}
