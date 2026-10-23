# Ski Talk — 滑雪用的轻量对讲（Push-to-Talk, PTT）

> 口袋里的手机 + 手套上的蓝牙按钮 + 头盔音响/耳机 = 一台不用再多带的对讲机。

**它是什么**：一个半双工（Half-duplex）、存储转发（Store-and-forward）的群组语音对讲。按住说，松开发；别人说话自动在耳机或扬声器播放；不维持通话连接，所以省电。思路和 Zello 一致（协议形状也借鉴了 Zello 公开的 Channel API），但只保留滑雪需要的东西：提前建群、一个频道码、一个大按钮、外设触发。

**它不是什么**：不是无网对讲。走手机网络（4G/5G/Wi-Fi），雪场没信号就没法用，这点和 Zello、国内插卡公网对讲机（PoC）一样。

## 架构 Architecture

```
 手套上的蓝牙 PTT 键 / 耳机键 / Action Button / 屏幕大按钮
                      │  (iOS: PushToTalk 框架接管按键、锁屏按钮、音频会话)
                      ▼
 ┌───────────────┐  按住: Opus 包 (WebSocket 二进制帧)  ┌──────────────────┐
 │  手机 App     │ ───────────────────────────────────▶ │  中继服务器 relay  │
 │ iOS / 浏览器  │ ◀─────────────────────────────────── │  Node.js, 1 进程  │
 └───────────────┘  在线队友: 实时转发 (≈ 150 ms 延迟)   │  · 话语权 1 人/频道 │
        ▲                                               │  · 消息落盘 24 h   │
        │  不在线/后台的 iPhone: APNs push-to-talk 推送  │  · APNs 唤醒推送   │
        └───────────── 唤醒后 HTTP 拉取整条消息播放 ───── └──────────────────┘
```

为什么这样设计（和你最初的需求一一对应）：

| 需求 | 实现 |
|---|---|
| 不一直开着、省电 | 前台只有一条空闲 WebSocket；进后台就断开，靠系统推送唤醒。发送只在按住的几秒钟占用网络。 |
| 一人发完立刻关通道 | 服务器做话语权控制（Floor control）：一个频道同一时刻只有一个 `stream`，松开即结束并落盘。 |
| 一有接收就自动播放 | 在线时直接播流；睡着的 iPhone 被 APNs `pushtotalk` 推送唤醒，拉取后自动播放，播完回去睡。 |
| 手机扬声器或蓝牙设备播放 | iOS 用系统音频路由（App 内有路由选择按钮）；蓝牙头盔音响、AirPods 都走系统。 |
| 不掏手机触发 | iOS PushToTalk 框架：锁屏/灵动岛按钮、耳机播放键、蓝牙 PTT 按钮（`setAccessoryButtonEventsEnabled`）；Action Button 通过「Toggle Talk」快捷指令。浏览器端用媒体键。 |
| 提前建群 | 一人 `POST /api/channels` 得到 6 位频道码，发给大家；雪场上只需打开 App 点加入。 |

## 目录 Layout

```
server/   Node.js 中继：WebSocket + HTTP + 存储 + APNs。有集成测试。
web/      浏览器客户端（Chrome/Edge/安卓 Chrome；WebCodecs Opus）。用于联调和安卓。
ios/      iOS 原生 App 源码（SwiftUI + PushToTalk 框架 + AVAudioConverter Opus），
          以及 Apple Watch 配套 App（SkiTalkWatch：Double Tap、运动会话、录音上传）。
tools/    e2e-web.mjs：两个无头 Chromium 互相对讲的端到端测试。
PROTOCOL.md  线上协议。
```

## 快速开始 Quick start

```bash
cd server && npm install && npm start          # http://localhost:8080
# 另开两个浏览器窗口打开 http://localhost:8080 ，填同一个频道码，按住大按钮说话
```

自动化验证（本仓库已在 Linux 容器里跑通）：

```bash
cd server && npm test                 # 协议 / 话语权 / 存储转发 / 重启恢复
node tools/e2e-web.mjs                # 两个无头 Chromium 真实录音编码、互收、重放历史
```

## 部署 Deploy

浏览器端的麦克风和 WebCodecs 都要求 HTTPS，iOS 也应走 `wss://`。最省事的是一个带自动证书的反向代理（Caddy）+ 这个 Node 进程，或者 Docker：

```bash
docker build -f server/Dockerfile -t ski-talk .
docker run -d -p 8080:8080 -v ski-talk-data:/data \
  -e APNS_TEAM_ID=… -e APNS_KEY_ID=… -e APNS_KEY=/data/AuthKey.p8 \
  -e APNS_BUNDLE_ID=com.example.skitalk -e APNS_SANDBOX=1 ski-talk
```

不配置 `APNS_*` 时服务器照常工作，只是不发 iOS 唤醒推送（网页端不受影响）。

## iOS 端 Build

1. `brew install xcodegen && cd ios && xcodegen generate`，打开 `SkiTalk.xcodeproj`（或新建 iOS App 工程，把 `ios/SkiTalk/*.swift` 拖进去，替换 Info.plist）。
2. Signing & Capabilities：加 **Push to Talk**、**Push Notifications**、Background Modes 勾选 *Push to Talk* 和 *Audio*。Push to Talk 能力需要在 Apple Developer 后台对 App ID 开启。
3. 改 Bundle ID（与服务器 `APNS_BUNDLE_ID` 一致）；在 Developer 后台建一个 APNs Auth Key（.p8）给服务器。
4. 真机运行（PushToTalk 框架在模拟器上不可用），填服务器地址、频道码、名字，加入。
5. 不掏手机的几种接法：
   - 蓝牙 PTT 按钮 / 耳机键：配对后直接用，系统把播放/暂停键当作开始/结束发送。注意只支持标准媒体键的按钮；Zello 私有协议的按钮不行。
   - Action Button：设置 → 操作按钮 → 快捷指令 → 「Toggle Talk (Ski Talk)」。只能切换，不能按住。
   - 锁屏 / 灵动岛：加入频道后系统自动提供。

**诚实说明**：这里没有 Mac 和真机，iOS 代码经过人工核对但**没有编译和真机测试**。PushToTalk 框架的回调顺序、`AVAudioConverter` 的 Opus 编解码在真机上需要验证；服务器和网页端是真跑通的。

## Apple Watch 端：抬腕捏两下就说话

`ios/SkiTalkWatch/` 是 watchOS 配套 App，目标是**全程不摸手机、不摸耳机、不摸表盘**：AirPods 戴在头盔里，抬腕捏两下（Double Tap）开始说，再捏两下发出。

- **Double Tap**：主按钮带 `handGestureShortcut(.primaryAction)`，watchOS 11 起捏两下即触发。需要 Series 9 / Ultra 2 以后的手表。
- **保持前台**：App 启动一个"高山滑雪"运动会话（HKWorkoutSession），watchOS 对运动类 App 抬腕即显示、不切回表盘、手垂下后仍在后台运行，顺带记录滑雪数据。
- **两条发送路径，自动选择**：
  1. 手机路径：通过 WatchConnectivity 让 iPhone 用 PushToTalk 框架发送，AirPods 麦克风收音（`ios/SkiTalk/WatchLink.swift`）。
  2. 手表路径：iPhone 不可达或拒绝时，手表自己录 AAC（16 kHz 单声道），后台 URLSession 上传到 `/api/channels/:code/upload`，服务器 ffmpeg 转 Opus。没网先排队，有网自动补发；手机锁在柜子里、手表开蜂窝也能用。
- **不用输入**：频道码、服务器、名字全部从 iPhone 同步过来。
- **接收**：仍由 iPhone 收推送、AirPods 播放，和不戴手表时一样。

要在真机上验证的三点：运动会话中手腕放下后录音是否持续；Ultra 的操作按钮能否在运动中转为对讲键；戴厚手套时捏两下的识别率。

## 和 Zello 的关系

| | Zello | Ski Talk |
|---|---|---|
| 协议 | WebSocket JSON + 二进制 Opus 帧（公开 Channel API） | 同形状，字段精简，见 PROTOCOL.md |
| 音频 | Opus 16 kHz、60 ms 帧、码率自动 | Opus 48 kHz、16 kbps；iOS 20 ms、Web 60 ms |
| iOS 后台 | PushToTalk 框架 + APNs（iOS 16+，iOS 26 起强制） | 同 |
| 离线消息 | 1:1 存两周；频道消息需 Zello Work 开启 Message Recovery | 频道消息默认存 24 h，所有人可重放 |
| 建群 | 注册账号、加联系人 | 一个频道码 |
| 账号 / 隐私 | Zello 云 | 自己的服务器 |

## 下一步 Roadmap

- watchOS 端真机验证与操作按钮接入。
- Action Button 切换模式下的自动静音检测关麦（VAD）。
- Android 原生（FCM 高优先级数据推送 + 前台服务）。
- 位置共享（上传最后位置，随消息显示“谁在哪”）。
