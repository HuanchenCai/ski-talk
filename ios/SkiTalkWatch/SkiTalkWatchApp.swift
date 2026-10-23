import SwiftUI

/// Ski Talk for Apple Watch.
///
/// Raise the wrist, Double Tap (pinch twice) → talk. Pinch twice again → send.
/// Nothing on the wrist, the phone or the earbuds is touched.
///
/// Two ways to send, chosen automatically:
///   1. Phone path: ask the iPhone over WatchConnectivity to start a PushToTalk
///      transmission; the AirPods inside the helmet pick up the voice.
///   2. Watch path: record on the watch's own microphone and upload the clip
///      straight to the relay (works with the phone in a locker, over the
///      watch's cellular or the phone's proxy). The relay transcodes to Opus.
@main
struct SkiTalkWatchApp: App {
    @StateObject private var talk = WatchTalkController.shared
    var body: some Scene {
        WindowGroup { WatchContentView().environmentObject(talk) }
    }
}
