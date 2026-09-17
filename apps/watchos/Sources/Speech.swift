import AVFoundation
import Foundation
import Observation

/// Reads agent text aloud with on-device speech synthesis. Nothing leaves the Watch.
@MainActor
@Observable
final class Speaker {
    private static let mutedKey = "dev.agentremote.watch.muted"

    var muted: Bool {
        didSet {
            UserDefaults.standard.set(muted, forKey: Speaker.mutedKey)
            if muted { synthesizer.stopSpeaking(at: .immediate) }
        }
    }

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()

    init() {
        muted = UserDefaults.standard.bool(forKey: Speaker.mutedKey)
    }

    func speak(_ text: String) {
        guard !muted else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playback, mode: .spokenAudio)
        try? audioSession.setActive(true)
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }
}
