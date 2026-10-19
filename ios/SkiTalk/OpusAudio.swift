import AVFoundation

/// Opus on iOS without third-party code: AudioToolbox has had an Opus codec since
/// iOS 11, reachable through AVAudioConverter. 48 kHz mono, 20 ms frames (960 samples),
/// 16 kbit/s — about 2 KB per second of speech.
enum OpusFormat {
    static let sampleRate: Double = 48_000
    static let frameMs = 20
    static let framesPerPacket: UInt32 = 960
    static let bitrate = 16_000

    static var opus: AVAudioFormat {
        var asbd = AudioStreamBasicDescription()
        asbd.mFormatID = kAudioFormatOpus
        asbd.mSampleRate = sampleRate
        asbd.mChannelsPerFrame = 1
        asbd.mFramesPerPacket = framesPerPacket
        return AVAudioFormat(streamDescription: &asbd)!
    }
    static var pcm: AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    }
}

/// Microphone → Opus packets. Start only after the PushToTalk framework has
/// activated the audio session (channelManager(_:didActivate:)).
final class OpusCapture {
    private let engine = AVAudioEngine()
    private var toPCM: AVAudioConverter?
    private var toOpus: AVAudioConverter?
    var onPacket: ((Data) -> Void)?
    private(set) var isRunning = false

    func start() throws {
        let input = engine.inputNode
        let hw = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0 else { throw NSError(domain: "audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input"]) }
        toPCM = AVAudioConverter(from: hw, to: OpusFormat.pcm)
        toOpus = AVAudioConverter(from: OpusFormat.pcm, to: OpusFormat.opus)
        toOpus?.bitRate = OpusFormat.bitrate
        toOpus?.bitRateStrategy = AVAudioBitRateStrategy_Variable
        // ~40 ms of hardware audio per tap → about two Opus packets per callback.
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(hw.sampleRate * 0.04), format: hw) { [weak self] buf, _ in
            self?.encode(buf)
        }
        engine.prepare()
        try engine.start()
        isRunning = true
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        toPCM = nil; toOpus = nil
    }

    private func encode(_ hwBuffer: AVAudioPCMBuffer) {
        guard let toPCM, let toOpus else { return }
        // 1) resample / downmix to 48 kHz mono float
        let ratio = OpusFormat.sampleRate / hwBuffer.format.sampleRate
        let pcm = AVAudioPCMBuffer(pcmFormat: OpusFormat.pcm, frameCapacity: AVAudioFrameCount(Double(hwBuffer.frameLength) * ratio) + 64)!
        var fed = false
        var err: NSError?
        toPCM.convert(to: pcm, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return hwBuffer
        }
        guard err == nil, pcm.frameLength > 0 else { return }

        // 2) encode; the converter buffers partial frames between calls
        let out = AVAudioCompressedBuffer(format: OpusFormat.opus, packetCapacity: 8, maximumPacketSize: toOpus.maximumOutputPacketSize)
        var fed2 = false
        let status = toOpus.convert(to: out, error: &err) { _, st in
            if fed2 { st.pointee = .noDataNow; return nil }
            fed2 = true; st.pointee = .haveData; return pcm
        }
        guard status != .error, let descs = out.packetDescriptions else { return }
        for i in 0..<Int(out.packetCount) {
            let d = descs[i]
            let bytes = Data(bytes: out.data.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize))
            if !bytes.isEmpty { onPacket?(bytes) }
        }
    }
}

/// Opus packets → speaker / Bluetooth. One instance plays one message or live stream
/// at a time; packets are decoded as they arrive and queued on an AVAudioPlayerNode,
/// so a slow network only causes a pause, never a crash.
final class OpusPlayback {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var decoder: AVAudioConverter?
    private var scheduled = 0
    private var finishedScheduling = false
    var onFinished: (() -> Void)?

    init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: OpusFormat.pcm)
    }

    func start() throws {
        decoder = AVAudioConverter(from: OpusFormat.opus, to: OpusFormat.pcm)
        scheduled = 0; finishedScheduling = false
        engine.prepare()
        try engine.start()
        player.play()
    }

    /// Short attention tone before a message, like a radio squelch tail in reverse.
    func chime() {
        let n = Int(OpusFormat.sampleRate * 0.07)
        let buf = AVAudioPCMBuffer(pcmFormat: OpusFormat.pcm, frameCapacity: AVAudioFrameCount(n))!
        buf.frameLength = AVAudioFrameCount(n)
        let p = buf.floatChannelData![0]
        for i in 0..<n { p[i] = Float(sin(2 * .pi * 880 * Double(i) / OpusFormat.sampleRate)) * 0.15 * Float(1 - Double(i) / Double(n)) }
        schedule(buf)
    }

    func feed(_ packet: Data) {
        guard let decoder else { return }
        let inBuf = AVAudioCompressedBuffer(format: OpusFormat.opus, packetCapacity: 1, maximumPacketSize: max(packet.count, 1))
        packet.withUnsafeBytes { raw in inBuf.data.copyMemory(from: raw.baseAddress!, byteCount: packet.count) }
        inBuf.byteLength = UInt32(packet.count)
        inBuf.packetCount = 1
        inBuf.packetDescriptions?.pointee = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
        let out = AVAudioPCMBuffer(pcmFormat: OpusFormat.pcm, frameCapacity: 5760)!   // up to 120 ms per packet
        var fed = false
        var err: NSError?
        decoder.convert(to: out, error: &err) { _, st in
            if fed { st.pointee = .noDataNow; return nil }
            fed = true; st.pointee = .haveData; return inBuf
        }
        if err == nil, out.frameLength > 0 { schedule(out) }
    }

    /// Call after the last packet; onFinished fires when playback actually ends.
    func finish() {
        finishedScheduling = true
        if scheduled == 0 { onFinished?() }
    }

    func stop() {
        player.stop()
        engine.stop()
        decoder = nil
    }

    private func schedule(_ buf: AVAudioPCMBuffer) {
        scheduled += 1
        player.scheduleBuffer(buf) { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.scheduled -= 1
                if self.finishedScheduling && self.scheduled == 0 { self.onFinished?() }
            }
        }
    }
}
