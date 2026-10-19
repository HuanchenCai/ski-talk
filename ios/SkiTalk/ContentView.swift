import SwiftUI
import AVKit

struct ContentView: View {
    @EnvironmentObject var ptt: PTTController
    @EnvironmentObject var settings: Settings
    @State private var pressing = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if !ptt.joined { setupCard } else { talkCard }
                if let e = ptt.lastError { Text(e).font(.footnote).foregroundStyle(.red) }
            }
            .padding()
            .navigationTitle("Ski Talk")
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
        }
    }

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("提前建好群，雪场上只需打开一次。").font(.footnote).foregroundStyle(.secondary)
            TextField("服务器 https://…", text: $settings.serverURL).textFieldStyle(.roundedBorder).keyboardType(.URL).textInputAutocapitalization(.never)
            TextField("频道码 (如 SNOW42)", text: $settings.channelCode).textFieldStyle(.roundedBorder).textInputAutocapitalization(.characters)
            TextField("你的名字", text: $settings.displayName).textFieldStyle(.roundedBorder)
            Button { ptt.join() } label: { Text("加入 Join").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
            Text(ptt.statusText).font(.footnote).foregroundStyle(.secondary)
        }
        .padding().background(.background, in: RoundedRectangle(cornerRadius: 16))
    }

    private var talkCard: some View {
        VStack(spacing: 14) {
            Text(ptt.nowPlayingFrom.map { "🔊 \($0) 正在说话" } ?? ptt.statusText)
                .font(.headline).foregroundStyle(ptt.transmitting ? .red : (ptt.nowPlayingFrom != nil ? .green : .primary))

            // The big button. Hold to talk, or tap in toggle mode.
            ZStack {
                Circle().fill(ptt.transmitting ? Color.red : Color.accentColor)
                    .shadow(color: (ptt.transmitting ? Color.red : Color.accentColor).opacity(0.4), radius: 20)
                VStack { Text(settings.toggleMode ? (ptt.transmitting ? "再按结束" : "按一下说话") : "按住说话").font(.title2.bold()); Text("Push to talk").font(.caption) }
                    .foregroundStyle(.white)
            }
            .frame(width: 260, height: 260)
            .scaleEffect(ptt.transmitting ? 0.96 : 1)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressing else { return }
                        pressing = true
                        if settings.toggleMode { ptt.toggleTalk() } else { ptt.beginTalk() }
                    }
                    .onEnded { _ in
                        pressing = false
                        if !settings.toggleMode { ptt.endTalk() }
                    }
            )
            .animation(.easeOut(duration: 0.1), value: ptt.transmitting)

            Toggle("切换模式 Toggle（蓝牙按钮 / Action Button 用）", isOn: $settings.toggleMode).font(.footnote)
            Toggle("播放前提示音", isOn: $settings.chimeBeforePlayback).font(.footnote)

            HStack {
                Text("输出：").font(.footnote).foregroundStyle(.secondary)
                RoutePicker().frame(width: 36, height: 36)   // speaker ↔ Bluetooth helmet speakers / earbuds
                Spacer()
                Text(ptt.members.map { $0.name + ($0.talking == true ? "🎙️" : "") }.joined(separator: "，")).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }

            if !ptt.history.isEmpty {
                List(ptt.history.prefix(20)) { m in
                    Button { ptt.replay(m) } label: {
                        HStack { Text(m.from.name); Spacer(); Text(String(format: "%.1fs", Double(m.duration_ms) / 1000)).foregroundStyle(.secondary); Text(Date(timeIntervalSince1970: m.ts / 1000), style: .time).foregroundStyle(.secondary) }
                    }
                }
                .listStyle(.plain).frame(maxHeight: 220)
            }

            Button("离开频道 Leave", role: .destructive) { ptt.leave() }.font(.footnote)
        }
        .padding().background(.background, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// System output picker: lets the skier choose phone speaker vs. Bluetooth helmet audio.
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView { let v = AVRoutePickerView(); v.prioritizesVideoDevices = false; return v }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
