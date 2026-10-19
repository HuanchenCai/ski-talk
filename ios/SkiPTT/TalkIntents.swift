import AppIntents

/// "Toggle Talk" shows up in Shortcuts, so it can be bound to:
///   * the iPhone Action Button (iPhone 15 Pro / 16 series) — like Zello's TogglePTT
///   * an Apple Watch Ultra Action Button or a watch-face Shortcut complication
///   * Back Tap (Settings → Accessibility → Touch → Back Tap)
/// The Action Button cannot do hold-to-talk, so this is a toggle: press to start,
/// press again to stop (the relay also auto-stops after 30 s of silence/limit).
struct ToggleTalkIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Talk (Ski PTT)"
    static var description = IntentDescription("开始/结束对讲 Start or stop transmitting on the current Ski PTT channel.")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult {
        PTTController.shared.toggleTalk()
        return .result()
    }
}

struct SkiPTTShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ToggleTalkIntent(), phrases: ["Talk with \(.applicationName)", "用 \(.applicationName) 对讲"], shortTitle: "Toggle Talk", systemImageName: "mic.fill")
    }
}
