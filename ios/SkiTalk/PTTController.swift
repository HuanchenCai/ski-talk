import Foundation
import AVFoundation
import PushToTalk
import UIKit
import Combine

/// Glue between Apple's PushToTalk framework, the relay and the audio pipeline.
///
/// Lifecycle on the mountain:
///   1. Open the app once, join → PTT channel joined; a system talk button now lives
///      on the lock screen / Dynamic Island. The app may be backgrounded.
///   2. Press (screen button, lock-screen button, headset/Bluetooth PTT key, Action
///      Button via the Toggle Talk shortcut) → system calls didBeginTransmitting →
///      we open the socket, start a stream and push Opus packets until release.
///   3. Someone else talks → relay sends an APNs push → incomingPushResult → we fetch
///      the stored message over HTTP and play it once the session is activated.
@MainActor
final class PTTController: NSObject, ObservableObject {
    static let shared = PTTController()

    // UI state
    @Published var joined = false
    @Published var transmitting = false
    @Published var statusText = "未加入 not joined"
    @Published var members: [RelayClient.Member] = []
    @Published var history: [RelayClient.MessageMeta] = []
    @Published var nowPlayingFrom: String?
    @Published var lastError: String?

    private var manager: PTChannelManager?
    private let relay = RelayClient()
    private var capture: OpusCapture?
    private var playback: OpusPlayback?
    private var streamID: UInt32?
    private var pendingPackets: [Data] = []           // encoded before the stream was granted
    private var liveStreamID: UInt32?
    private var pushToken: Data?
    private var pendingPlayback: (packets: [Data], from: String)?
    private var wantsCaptureOnActivate = false

    /// Stable UUID per channel code so the system can restore the channel after relaunch.
    private var channelUUID: UUID {
        let key = "channelUUID:" + Settings.shared.channelCode
        if let s = UserDefaults.standard.string(forKey: key), let u = UUID(uuidString: s) { return u }
        let u = UUID(); UserDefaults.standard.set(u.uuidString, forKey: key); return u
    }
    private var descriptor: PTChannelDescriptor {
        PTChannelDescriptor(name: "Ski Talk · \(Settings.shared.channelCode)", image: UIImage(named: "AppIcon"))
    }

    private override init() {
        super.init()
        relay.onEvent = { [weak self] e in Task { @MainActor in self?.handle(e) } }
        Task { await setupManager() }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.enteredBackground() }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.enteringForeground() }
    }

    private func setupManager() async {
        do {
            manager = try await PTChannelManager.channelManager(delegate: self, restorationDelegate: self)
        } catch {
            lastError = "PTT framework unavailable: \(error.localizedDescription)"
        }
    }

    // MARK: - Public actions

    func join() {
        guard !Settings.shared.channelCode.isEmpty else { lastError = "先填频道码"; return }
        statusText = "加入中…"
        manager?.requestJoinChannel(channelUUID: channelUUID, descriptor: descriptor)
    }

    func leave() {
        manager?.leaveChannel(channelUUID: channelUUID)
        relay.disconnect()
    }

    func beginTalk() {
        guard joined else { join(); return }
        manager?.requestBeginTransmitting(channelUUID: channelUUID)
    }

    func endTalk() {
        manager?.stopTransmitting(channelUUID: channelUUID)
    }

    func toggleTalk() { transmitting ? endTalk() : beginTalk() }

    /// Replay a stored message (history tap). Routed through the PTT framework as a
    /// "remote participant" so the system activates the audio session for us.
    func replay(_ m: RelayClient.MessageMeta) {
        guard let base = Settings.shared.httpBase else { return }
        RelayClient.fetchMessage(base: base, id: m.id) { [weak self] r in
            Task { @MainActor in
                guard let self, case .success(let msg) = r else { return }
                self.pendingPlayback = (msg.packets, msg.from)
                self.manager?.setActiveRemoteParticipant(PTParticipant(name: msg.from, image: nil), channelUUID: self.channelUUID) { _ in }
            }
        }
    }

    // MARK: - Relay connection (foreground live listening)

    private func connectRelay(then: (() -> Void)? = nil) {
        guard let url = Settings.shared.wsURL else { lastError = "服务器地址无效"; return }
        relay.connect(url: url, channel: Settings.shared.channelCode, name: Settings.shared.displayName) { [weak self] r in
            Task { @MainActor in
                guard let self else { return }
                if case .failure(let e) = r { self.lastError = e.localizedDescription; return }
                if let t = self.pushToken { self.relay.registerDevice(token: t, name: Settings.shared.displayName) }
                then?()
            }
        }
    }

    private func enteredBackground() {
        // No socket in the background: the PTT push wakes us when someone talks.
        guard joined, !transmitting else { return }
        relay.setPresence(background: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, !self.transmitting else { return }
            self.relay.disconnect()
        }
    }

    private func enteringForeground() {
        guard joined, !relay.isConnected else { return }
        connectRelay()
    }

    private func handle(_ e: RelayClient.Event) {
        switch e {
        case .connected(let members, let history, let talking):
            self.members = members
            self.history = history.reversed()
            if let t = talking { startLive(t) }
            statusText = "已加入 \(Settings.shared.channelCode)"
        case .disconnected:
            if transmitting { endTalk() }
        case .members(let m):
            members = m
        case .start(let info):
            startLive(info)
        case .packet(let sid, _, let opus):
            if sid == liveStreamID { playback?.feed(opus) }
        case .stop(let sid, let message):
            if let message { history.insert(message, at: 0) }
            if sid == liveStreamID { liveStreamID = nil; playback?.finish() }
        case .message(let m):
            history.insert(m, at: 0)
            if m.from.name != Settings.shared.displayName && m.from.name != WatchLink.shared.watchName { replay(m) }
        }
    }

    private func startLive(_ info: RelayClient.StartInfo) {
        guard info.from.name != Settings.shared.displayName else { return }
        liveStreamID = info.stream_id
        pendingPlayback = ([], info.from.name)
        // Ask the system for the audio session; playback starts in didActivate.
        manager?.setActiveRemoteParticipant(PTParticipant(name: info.from.name, image: nil), channelUUID: channelUUID) { _ in }
    }

    // MARK: - Audio

    private func configureSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
    }

    private func startCapture() {
        guard capture == nil else { return }
        let c = OpusCapture()
        c.onPacket = { [weak self] pkt in
            Task { @MainActor in
                guard let self else { return }
                if let sid = self.streamID { self.relay.sendPacket(streamID: sid, opus: pkt) }
                else { self.pendingPackets.append(pkt) }
            }
        }
        do { try c.start(); capture = c } catch { lastError = "麦克风启动失败: \(error.localizedDescription)" }
    }

    private func stopCapture() {
        capture?.stop(); capture = nil
    }

    private func startPlayback(from: String, packets: [Data]) {
        playback?.stop()
        let p = OpusPlayback()
        p.onFinished = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.nowPlayingFrom = nil
                self.playback?.stop(); self.playback = nil
                self.manager?.setActiveRemoteParticipant(nil, channelUUID: self.channelUUID) { _ in }
            }
        }
        do {
            try p.start()
            playback = p
            nowPlayingFrom = from
            if Settings.shared.chimeBeforePlayback { p.chime() }
            packets.forEach(p.feed)
            if liveStreamID == nil { p.finish() }      // stored message: all packets already queued
        } catch { lastError = "播放失败: \(error.localizedDescription)" }
    }
}

// MARK: - PTChannelManagerDelegate
extension PTTController: PTChannelManagerDelegate {
    nonisolated func channelManager(_ channelManager: PTChannelManager, didJoinChannel channelUUID: UUID, reason: PTChannelJoinReason) {
        Task { @MainActor in
            joined = true
            statusText = "已加入 \(Settings.shared.channelCode)"
            WatchLink.shared.syncSettings()
            channelManager.setTransmissionMode(.halfDuplex, channelUUID: channelUUID) { _ in }
            channelManager.setAccessoryButtonEventsEnabled(true, channelUUID: channelUUID) { _ in }   // Bluetooth PTT buttons / headset keys
            channelManager.setServiceStatus(.ready, channelUUID: channelUUID) { _ in }
            if UIApplication.shared.applicationState == .active { connectRelay() }
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
        Task { @MainActor in
            joined = false; transmitting = false
            statusText = "已离开"
            relay.disconnect()
            WatchLink.shared.syncSettings()
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
        Task { @MainActor in
            transmitting = true
            statusText = "🎙️ 发送中…"
            wantsCaptureOnActivate = true
            pendingPackets.removeAll()
            let begin = { [weak self] in
                guard let self else { return }
                self.relay.startStream(codec: .init()) { r in
                    Task { @MainActor in
                        switch r {
                        case .success(let sid):
                            self.streamID = sid
                            self.pendingPackets.forEach { self.relay.sendPacket(streamID: sid, opus: $0) }
                            self.pendingPackets.removeAll()
                        case .failure(let why):
                            self.statusText = why.hasPrefix("busy") ? "占线：\(why.dropFirst(5)) 正在说" : why
                            self.endTalk()
                        }
                    }
                }
            }
            if relay.isConnected { begin() } else { connectRelay(then: begin) }
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
        Task { @MainActor in
            transmitting = false
            wantsCaptureOnActivate = false
            stopCapture()
            if let sid = streamID { relay.stopStream(streamID: sid) }
            streamID = nil
            statusText = "已加入 \(Settings.shared.channelCode)"
            if UIApplication.shared.applicationState != .active {
                // Transmission from the background is over; drop the socket again.
                relay.setPresence(background: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.relay.disconnect() }
            }
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
        Task { @MainActor in
            self.pushToken = pushToken
            if relay.isConnected { relay.registerDevice(token: pushToken, name: Settings.shared.displayName) }
            else if let base = Settings.shared.httpBase { RelayClient.registerDeviceHTTP(base: base, channel: Settings.shared.channelCode, name: Settings.shared.displayName, token: pushToken) }
        }
    }

    /// Someone talked while we were asleep. Must answer synchronously; the fetch runs
    /// in the background and playback starts once the system activates the session.
    nonisolated func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
        let from = pushPayload["from"] as? String ?? "队友"
        guard let id = pushPayload["message_id"] as? String, let base = Settings.shared.httpBase else { return .leaveChannel }
        Task { @MainActor in
            self.pendingPlayback = ([], from)
            RelayClient.fetchMessage(base: base, id: id) { r in
                Task { @MainActor in
                    guard case .success(let msg) = r else { self.manager?.setActiveRemoteParticipant(nil, channelUUID: channelUUID) { _ in }; return }
                    if self.playback != nil { msg.packets.forEach(self.playback!.feed); self.playback?.finish() }
                    else { self.pendingPlayback = (msg.packets, msg.from) }
                }
            }
        }
        return .activeRemoteParticipant(PTParticipant(name: from, image: nil))
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in
            configureSession()
            if wantsCaptureOnActivate { startCapture() }
            if let p = pendingPlayback {
                pendingPlayback = nil
                startPlayback(from: p.from, packets: p.packets)
                if liveStreamID == nil && p.packets.isEmpty { /* packets still downloading; finish() comes with them */ }
            }
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in
            stopCapture()
            playback?.stop(); playback = nil
            nowPlayingFrom = nil
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToJoinChannel channelUUID: UUID, error: Error) {
        Task { @MainActor in lastError = "加入失败: \(error.localizedDescription)"; statusText = "未加入" }
    }
    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToBeginTransmittingInChannel channelUUID: UUID, error: Error) {
        Task { @MainActor in lastError = "无法发送: \(error.localizedDescription)"; transmitting = false }
    }
    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToStopTransmittingInChannel channelUUID: UUID, error: Error) {}
}

// MARK: - PTChannelRestorationDelegate
extension PTTController: PTChannelRestorationDelegate {
    nonisolated func channelDescriptor(restoredChannelUUID: UUID) -> PTChannelDescriptor {
        PTChannelDescriptor(name: "Ski Talk · \(Settings.shared.channelCode)", image: UIImage(named: "AppIcon"))
    }
}
