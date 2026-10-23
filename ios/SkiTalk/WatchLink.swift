import Foundation
import WatchConnectivity

/// iPhone side of the Apple Watch link.
///
/// The watch never needs typing: it asks for server / channel / name here.
/// A Double Tap on the watch arrives as {"cmd":"toggle"} and flips transmission
/// through the same entry point as the Action Button shortcut. If the phone
/// path is unavailable, the watch records and uploads on its own (see
/// SkiTalkWatch/WatchTalkController.swift) and this class is not involved.
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()

    /// Name the watch uses when it uploads on its own, so we don't replay our own voice.
    var watchName: String { Settings.shared.displayName + " ⌚" }

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private var settingsPayload: [String: Any] {
        ["server": Settings.shared.serverURL, "channel": Settings.shared.channelCode,
         "name": watchName, "joined": PTTController.shared.joined]
    }

    /// Push current settings to the watch (call after the user edits them).
    func syncSettings() {
        guard WCSession.default.activationState == .activated else { return }
        try? WCSession.default.updateApplicationContext(settingsPayload)
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.syncSettings() }
    }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        Task { @MainActor in
            switch message["cmd"] as? String {
            case "toggle":
                PTTController.shared.toggleTalk()
                replyHandler(["ok": true, "transmitting": PTTController.shared.transmitting])
            case "begin":
                PTTController.shared.beginTalk()
                replyHandler(["ok": true])
            case "end":
                PTTController.shared.endTalk()
                replyHandler(["ok": true])
            case "settings":
                replyHandler(self.settingsPayload)
            default:
                replyHandler(["ok": false, "error": "unknown"])
            }
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        session.delegate?.session?(session, didReceiveMessage: message, replyHandler: { _ in })
    }
}
