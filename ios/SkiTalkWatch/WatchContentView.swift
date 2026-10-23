import SwiftUI

struct WatchContentView: View {
    @EnvironmentObject var talk: WatchTalkController

    var body: some View {
        VStack(spacing: 8) {
            Text(talk.channel.isEmpty ? "等 iPhone 同步频道…" : talk.channel)
                .font(.caption2).foregroundStyle(.secondary)

            Button {
                talk.toggle()
            } label: {
                VStack(spacing: 2) {
                    Image(systemName: talk.transmitting ? "waveform" : "mic.fill").font(.title2)
                    Text(talk.transmitting ? "再捏两下发送" : "捏两下说话").font(.footnote.bold())
                }
                .frame(maxWidth: .infinity, minHeight: 84)
            }
            .buttonStyle(.borderedProminent)
            .tint(talk.transmitting ? .red : .blue)
            // watchOS 11: Double Tap (pinch twice) performs the primary action while this
            // view is frontmost. The workout session keeps it frontmost all day.
            .handGestureShortcut(.primaryAction)

            Text(talk.status).font(.caption2).lineLimit(2).multilineTextAlignment(.center)

            HStack {
                Label(talk.route == .phone ? "手机" : "手表", systemImage: talk.route == .phone ? "iphone" : "applewatch")
                Spacer()
                if talk.pendingUploads > 0 { Label("\(talk.pendingUploads)", systemImage: "arrow.up.circle") }
                Button(talk.workoutRunning ? "结束" : "开始") { talk.workoutRunning ? talk.endSession() : talk.startSession() }
                    .buttonStyle(.bordered).controlSize(.mini)
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .onAppear { talk.startSession() }
    }
}
