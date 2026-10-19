import Foundation
import Combine
import UIKit

/// User settings, persisted in UserDefaults. Groups are created *before* the ski day,
/// so on the mountain the app only needs to be opened once to join.
final class Settings: ObservableObject {
    static let shared = Settings()
    private let d = UserDefaults.standard

    @Published var serverURL: String { didSet { d.set(serverURL, forKey: "serverURL") } }
    @Published var channelCode: String { didSet { d.set(channelCode, forKey: "channelCode") } }
    @Published var displayName: String { didSet { d.set(displayName, forKey: "displayName") } }
    @Published var toggleMode: Bool { didSet { d.set(toggleMode, forKey: "toggleMode") } }
    @Published var chimeBeforePlayback: Bool { didSet { d.set(chimeBeforePlayback, forKey: "chime") } }

    private init() {
        serverURL = d.string(forKey: "serverURL") ?? "https://ptt.example.com"
        channelCode = d.string(forKey: "channelCode") ?? ""
        displayName = d.string(forKey: "displayName") ?? (UIDevice.current.name)
        toggleMode = d.object(forKey: "toggleMode") as? Bool ?? false
        chimeBeforePlayback = d.object(forKey: "chime") as? Bool ?? true
    }

    var httpBase: URL? { URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) }
    var wsURL: URL? {
        guard var c = httpBase.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else { return nil }
        c.scheme = (c.scheme == "https") ? "wss" : "ws"
        c.path = "/ws"
        return c.url
    }
}
