import Foundation

/// Wire protocol with the relay (see ../../PROTOCOL.md).
///   text frame   = JSON {cmd:…} / {event:…}
///   binary frame = [0x01][stream_id u32 BE][packet_id u32 BE][opus packet]
///
/// Connection policy: the socket is opened only when needed (joined + foreground,
/// or while transmitting from the background) and closed otherwise. Incoming talk
/// in the background comes through APNs, not through this socket.
final class RelayClient: NSObject {
    struct Codec: Codable { var name = "opus"; var sample_rate = 48_000; var channels = 1; var frame_ms = 20 }
    struct Member: Codable, Identifiable { var id: String; var name: String; var talking: Bool?; var background: Bool? }
    struct MessageMeta: Codable, Identifiable {
        struct From: Codable { var id: String; var name: String }
        var id: String; var channel: String; var from: From; var codec: Codec
        var ts: Double; var seq: Int; var duration_ms: Int; var packets: Int
    }

    var onEvent: ((Event) -> Void)?
    enum Event {
        case connected(members: [Member], history: [MessageMeta], talking: StartInfo?)
        case disconnected(Error?)
        case members([Member])
        case start(StartInfo)
        case packet(streamID: UInt32, packetID: UInt32, opus: Data)
        case stop(streamID: UInt32, message: MessageMeta?)
    }
    struct StartInfo: Codable { var stream_id: UInt32; var from: MessageMeta.From; var codec: Codec; var message_id: String }

    private var task: URLSessionWebSocketTask?
    private lazy var session = URLSession(configuration: .default, delegate: nil, delegateQueue: nil)
    private var seq = 0
    private var pending: [Int: (Data) -> Void] = [:]
    private let queue = DispatchQueue(label: "ptt.relay")
    private(set) var isConnected = false
    var lastSeq = 0

    // MARK: connect / join
    func connect(url: URL, channel: String, name: String, completion: @escaping (Result<Void, Error>) -> Void) {
        disconnect()
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop(t)
        send(cmd: ["cmd": "join", "channel": channel, "name": name,
                   "client": ["platform": "ios", "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "0"],
                   "after_seq": lastSeq]) { [weak self] data in
            guard let self else { return }
            struct R: Codable { var ok: Bool; var error: String?; var members: [Member]?; var history: [MessageMeta]?; var talking: StartInfo? }
            if let r = try? JSONDecoder().decode(R.self, from: data), r.ok {
                self.isConnected = true
                self.lastSeq = max(self.lastSeq, r.history?.last?.seq ?? 0)
                self.onEvent?(.connected(members: r.members ?? [], history: r.history ?? [], talking: r.talking))
                completion(.success(()))
            } else {
                completion(.failure(NSError(domain: "relay", code: 1, userInfo: [NSLocalizedDescriptionKey: "join failed"])))
            }
        }
    }

    func disconnect() {
        isConnected = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    // MARK: talk
    func startStream(codec: Codec, completion: @escaping (Result<UInt32, String>) -> Void) {
        send(cmd: ["cmd": "start", "codec": ["name": codec.name, "sample_rate": codec.sample_rate, "channels": codec.channels, "frame_ms": codec.frame_ms]]) { data in
            struct R: Codable { var ok: Bool; var stream_id: UInt32?; var error: String?; var from: String? }
            if let r = try? JSONDecoder().decode(R.self, from: data), r.ok, let id = r.stream_id { completion(.success(id)) }
            else if let r = try? JSONDecoder().decode(R.self, from: data), r.error == "busy" { completion(.failure("busy:\(r.from ?? "")")) }
            else { completion(.failure("start failed")) }
        }
    }

    func sendPacket(streamID: UInt32, opus: Data) {
        var d = Data(capacity: 9 + opus.count)
        d.append(0x01)
        d.append(contentsOf: withUnsafeBytes(of: streamID.bigEndian, Array.init))
        d.append(contentsOf: [0, 0, 0, 0])
        d.append(opus)
        task?.send(.data(d)) { _ in }
    }

    func stopStream(streamID: UInt32) {
        send(cmd: ["cmd": "stop", "stream_id": streamID], completion: nil)
    }

    func setPresence(background: Bool) {
        send(cmd: ["cmd": "presence", "state": background ? "background" : "foreground"], completion: nil)
    }

    func registerDevice(token: Data, name: String) {
        send(cmd: ["cmd": "register_device", "platform": "ios", "token": token.map { String(format: "%02x", $0) }.joined(), "name": name], completion: nil)
    }

    // MARK: HTTP (works without a socket; used after an APNs wake-up)
    static func fetchMessage(base: URL, id: String, completion: @escaping (Result<(meta: Codec, from: String, packets: [Data]), Error>) -> Void) {
        let url = base.appendingPathComponent("api/messages/\(id)/packets")
        URLSession.shared.dataTask(with: url) { data, resp, err in
            guard let data, let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                return completion(.failure(err ?? NSError(domain: "relay", code: 404)))
            }
            // x-codec: opus;sr=48000;ch=1;frame_ms=20
            var codec = Codec()
            if let hdr = http.value(forHTTPHeaderField: "x-codec") {
                for part in hdr.split(separator: ";") {
                    let kv = part.split(separator: "=")
                    if kv.count == 2, let v = Int(kv[1]) {
                        switch kv[0] { case "sr": codec.sample_rate = v; case "ch": codec.channels = v; case "frame_ms": codec.frame_ms = v; default: break }
                    }
                }
            }
            let from = (http.value(forHTTPHeaderField: "x-from") ?? "").removingPercentEncoding ?? ""
            // framing: repeated [u16 BE length][opus packet]
            var packets: [Data] = []
            var o = 0
            let bytes = [UInt8](data)
            while o + 2 <= bytes.count {
                let len = Int(bytes[o]) << 8 | Int(bytes[o + 1]); o += 2
                guard o + len <= bytes.count else { break }
                packets.append(Data(bytes[o..<o + len])); o += len
            }
            completion(.success((codec, from, packets)))
        }.resume()
    }

    static func registerDeviceHTTP(base: URL, channel: String, name: String, token: Data) {
        var req = URLRequest(url: base.appendingPathComponent("api/devices"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let hex = token.map { String(format: "%02x", $0) }.joined()
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["channel": channel, "name": name, "platform": "ios", "token": hex])
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: internals
    private func send(cmd: [String: Any], completion: ((Data) -> Void)?) {
        queue.async {
            var obj = cmd
            if let completion {
                self.seq += 1
                obj["seq"] = self.seq
                self.pending[self.seq] = completion
            }
            guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
            self.task?.send(.string(s)) { _ in }
        }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, self.task === t else { return }
            switch result {
            case .failure(let e):
                self.isConnected = false
                self.onEvent?(.disconnected(e))
            case .success(let msg):
                switch msg {
                case .data(let d): self.handleBinary(d)
                case .string(let s): self.handleText(Data(s.utf8))
                @unknown default: break
                }
                self.receiveLoop(t)
            }
        }
    }

    private func handleBinary(_ d: Data) {
        guard d.count >= 9, d[d.startIndex] == 0x01 else { return }
        let b = [UInt8](d)
        let sid = UInt32(b[1]) << 24 | UInt32(b[2]) << 16 | UInt32(b[3]) << 8 | UInt32(b[4])
        let pid = UInt32(b[5]) << 24 | UInt32(b[6]) << 16 | UInt32(b[7]) << 8 | UInt32(b[8])
        onEvent?(.packet(streamID: sid, packetID: pid, opus: Data(b[9...])))
    }

    private func handleText(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let s = obj["seq"] as? Int {
            queue.async { if let cb = self.pending.removeValue(forKey: s) { cb(data) } }
            return
        }
        let dec = JSONDecoder()
        switch obj["event"] as? String {
        case "members":
            struct E: Codable { var members: [Member] }
            if let e = try? dec.decode(E.self, from: data) { onEvent?(.members(e.members)) }
        case "on_start":
            if let e = try? dec.decode(StartInfo.self, from: data) { onEvent?(.start(e)) }
        case "on_stop":
            struct E: Codable { var stream_id: UInt32; var message: MessageMeta? }
            if let e = try? dec.decode(E.self, from: data) {
                if let m = e.message { lastSeq = max(lastSeq, m.seq) }
                onEvent?(.stop(streamID: e.stream_id, message: e.message))
            }
        default: break
        }
    }
}

extension String: Error {}
