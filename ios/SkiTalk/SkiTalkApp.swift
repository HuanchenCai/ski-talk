import SwiftUI

/// Ski Talk — a lightweight half-duplex walkie-talkie for the slopes.
///
/// Architecture (see ../../README.md):
///   * Apple's PushToTalk framework owns the audio session, the lock-screen /
///     Dynamic Island talk button, Bluetooth headset buttons and background
///     wake-ups. We never keep a socket open in the background.
///   * While the user holds the button we stream Opus packets to the relay
///     over a WebSocket; when they let go the socket can be dropped.
///   * Incoming talk arrives as an APNs push-to-talk push; we fetch the stored
///     message over HTTP and play it, then go back to sleep.
@main
struct SkiTalkApp: App {
    // The channel manager must exist as early as possible after launch, otherwise
    // the system tears down restored channels. Creating the controller here does that.
    @StateObject private var ptt = PTTController.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(ptt)
                .environmentObject(Settings.shared)
        }
    }
}
