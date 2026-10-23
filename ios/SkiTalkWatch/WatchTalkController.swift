import Foundation
import AVFoundation
import WatchKit
import HealthKit
import WatchConnectivity
import Combine

@MainActor
final class WatchTalkController: NSObject, ObservableObject {
    static let shared = WatchTalkController()

    enum Route { case phone, watch }

    @Published var transmitting = false
    @Published var status = "准备中"
    @Published var channel = ""
    @Published var route: Route = .phone
    @Published var workoutRunning = false
    @Published var pendingUploads = 0

    private var server = ""
    private var name = "watch"
    private var phoneJoined = false

    private let health = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var recordStart: Date?
    private let maxSeconds: TimeInterval = 30

    private lazy var uploads: URLSession = {
        // Background session: an upload started with the wrist up finishes with the wrist down.
        let cfg = URLSessionConfiguration.background(withIdentifier: "skitalk.watch.uploads")
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()
    private var queueDir: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("queue", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private override init() {
        super.init()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
        pendingUploads = (try? FileManager.default.contentsOfDirectory(atPath: queueDir.path).count) ?? 0
        retryQueue()
    }

    // MARK: - Primary action (Double Tap / screen button)

    func toggle() {
        guard !channel.isEmpty, !server.isEmpty else { status = "先在 iPhone 上加入频道"; return }
        if transmitting { stopTalk() } else { startTalk() }
    }

    private func startTalk() {
        // Prefer the phone (AirPods mic, live stream). Fall back to the watch mic.
        if WCSession.default.isReachable && phoneJoined {
            route = .phone
            WCSession.default.sendMessage(["cmd": "begin"], replyHandler: { [weak self] r in
                Task { @MainActor in
                    if r["ok"] as? Bool == true { self?.transmitting = true; self?.status = "🎙️ 通过 iPhone 发送中"; WKInterfaceDevice.current().play(.start) }
                    else { self?.startRecording() }
                }
            }, errorHandler: { [weak self] _ in Task { @MainActor in self?.startRecording() } })
        } else {
            startRecording()
        }
    }

    private func stopTalk() {
        if route == .phone {
            WCSession.default.sendMessage(["cmd": "end"], replyHandler: nil, errorHandler: nil)
            transmitting = false; status = "已发送"
            WKInterfaceDevice.current().play(.stop)
        } else {
            stopRecordingAndUpload()
        }
    }

    // MARK: - Watch microphone path

    private func startRecording() {
        route = .watch
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.record, mode: .spokenAudio, options: [])
            try s.setActive(true)
        } catch { status = "麦克风不可用"; return }
        s.requestRecordPermission { [weak self] ok in
            Task { @MainActor in
                guard let self else { return }
                guard ok else { self.status = "请允许麦克风"; return }
                let url = self.queueDir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000)).m4a")
                // AAC 16 kHz mono ≈ 4 KB/s; the relay transcodes to Opus.
                let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000]
                do {
                    let r = try AVAudioRecorder(url: url, settings: settings)
                    r.record(forDuration: self.maxSeconds)
                    self.recorder = r; self.recordingURL = url; self.recordStart = Date()
                    self.transmitting = true
                    self.status = "🎙️ 手表录音中，抬腕靠近嘴"
                    WKInterfaceDevice.current().play(.start)
                    DispatchQueue.main.asyncAfter(deadline: .now() + self.maxSeconds + 0.5) { [weak self] in
                        if self?.transmitting == true && self?.route == .watch { self?.stopRecordingAndUpload() }
                    }
                } catch { self.status = "录音失败" }
            }
        }
    }

    private func stopRecordingAndUpload() {
        recorder?.stop(); recorder = nil
        transmitting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        WKInterfaceDevice.current().play(.stop)
        guard let url = recordingURL else { return }
        recordingURL = nil
        if let start = recordStart, Date().timeIntervalSince(start) < 0.4 { try? FileManager.default.removeItem(at: url); status = "太短，已丢弃"; return }
        enqueueUpload(url)
    }

    private func enqueueUpload(_ file: URL) {
        guard let base = URL(string: server) else { return }
        var req = URLRequest(url: base.appendingPathComponent("api/channels/\(channel)/upload"))
        req.httpMethod = "POST"
        req.setValue("audio/mp4", forHTTPHeaderField: "content-type")
        req.setValue(name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "watch", forHTTPHeaderField: "x-from")
        req.setValue("watchos", forHTTPHeaderField: "x-platform")
        let task = uploads.uploadTask(with: req, fromFile: file)
        task.taskDescription = file.lastPathComponent
        task.resume()
        pendingUploads = (try? FileManager.default.contentsOfDirectory(atPath: queueDir.path).count) ?? 0
        status = "上传中…"
    }

    /// Re-post anything left in the queue (no network earlier, app relaunch).
    private func retryQueue() {
        guard !server.isEmpty, !channel.isEmpty else { return }
        uploads.getAllTasks { [weak self] tasks in
            Task { @MainActor in
                guard let self else { return }
                let inFlight = Set(tasks.compactMap { $0.taskDescription })
                for f in (try? FileManager.default.contentsOfDirectory(at: self.queueDir, includingPropertiesForKeys: nil)) ?? [] where !inFlight.contains(f.lastPathComponent) {
                    self.enqueueUpload(f)
                }
            }
        }
    }

    // MARK: - Workout session keeps the app frontmost and running

    func startSession() {
        guard session == nil else { return }
        let cfg = HKWorkoutConfiguration()
        cfg.activityType = .downhillSkiing
        cfg.locationType = .outdoor
        health.requestAuthorization(toShare: [HKObjectType.workoutType()], read: []) { [weak self] ok, _ in
            Task { @MainActor in
                guard let self, ok else { self?.status = "需要健身权限以保持前台"; return }
                do {
                    let s = try HKWorkoutSession(healthStore: self.health, configuration: cfg)
                    let b = s.associatedWorkoutBuilder()
                    b.dataSource = HKLiveWorkoutDataSource(healthStore: self.health, workoutConfiguration: cfg)
                    s.startActivity(with: Date())
                    try await b.beginCollection(at: Date())
                    self.session = s; self.builder = b
                    self.workoutRunning = true
                    self.status = self.channel.isEmpty ? "等 iPhone 同步频道…" : "就绪：抬腕捏两下"
                } catch { self.status = "运动会话失败" }
            }
        }
    }

    func endSession() {
        session?.end()
        Task { try? await builder?.endCollection(at: Date()); try? await builder?.finishWorkout() }
        session = nil; builder = nil
        workoutRunning = false
        status = "已结束"
    }

    private func apply(settings: [String: Any]) {
        server = settings["server"] as? String ?? server
        channel = (settings["channel"] as? String ?? channel).uppercased()
        name = settings["name"] as? String ?? name
        phoneJoined = settings["joined"] as? Bool ?? phoneJoined
        if workoutRunning && !channel.isEmpty { status = "就绪：抬腕捏两下" }
        retryQueue()
    }
}

// MARK: - WatchConnectivity (settings come from the phone; nothing is typed on the watch)
extension WatchTalkController: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            self.apply(settings: session.receivedApplicationContext)
            if session.isReachable {
                session.sendMessage(["cmd": "settings"], replyHandler: { r in Task { @MainActor in self.apply(settings: r) } }, errorHandler: nil)
            }
        }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        Task { @MainActor in self.apply(settings: ctx) }
    }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in
            if session.isReachable { session.sendMessage(["cmd": "settings"], replyHandler: { r in Task { @MainActor in self.apply(settings: r) } }, errorHandler: nil) }
        }
    }
}

// MARK: - Background upload results
extension WatchTalkController: URLSessionTaskDelegate, URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let file = task.taskDescription
        Task { @MainActor in
            if error == nil && (200..<300).contains(code), let file {
                try? FileManager.default.removeItem(at: self.queueDir.appendingPathComponent(file))
                self.status = "已发送"
                WKInterfaceDevice.current().play(.success)
            } else if code == 409 {
                self.status = "占线，稍后自动重发"
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.retryQueue() }
            } else {
                self.status = "没网，已排队"
            }
            self.pendingUploads = (try? FileManager.default.contentsOfDirectory(atPath: self.queueDir.path).count) ?? 0
        }
    }
}

