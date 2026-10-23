# Ski Talk 线上协议 Wire protocol (v0.1)

借鉴 Zello 公开的 Channel API 的形状（JSON 控制帧 + 二进制音频帧），字段按我们自己的需要精简。

## 连接 Connection
- WebSocket：`wss://<host>/ws`（本地开发 `ws://localhost:8080/ws`）
- 文本帧 = JSON；二进制帧 = 音频包
- 服务器每 30 s 发 WebSocket ping，客户端需回 pong，否则被断开

## 客户端 → 服务器 命令 Commands
| cmd | 字段 | 回复 |
|---|---|---|
| `join` | `seq, channel, name, client:{platform,version}, after_seq?` | `{seq, ok, channel, you:{id,name}, members:[…], talking:StartInfo\|null, history:[MessageMeta…]}` |
| `leave` | – | – |
| `start` | `seq, codec:{name:"opus", sample_rate, channels, frame_ms}` | `{seq, ok:true, stream_id}` 或 `{seq, ok:false, error:"busy", from}` |
| `stop` | `stream_id` | 广播 `on_stop` |
| `presence` | `state:"background"\|"foreground"` | – （后台成员不再收直播包，改收推送） |
| `register_device` | `platform:"ios", token(hex), name` | `{seq, ok}` |
| `ping` | – | `{event:"pong"}` |

## 服务器 → 客户端 事件 Events
| event | 字段 |
|---|---|
| `members` | `members:[{id,name,platform,background,talking}]` |
| `on_start` | `stream_id, from:{id,name}, codec, message_id` |
| `on_stop` | `stream_id, message:MessageMeta\|null, reason` （空消息为 null） |
| `on_message` | `message:MessageMeta`，一条没有经过直播、已经完整落盘的消息（来自上传）。在线客户端应拉取并自动播放 |
| `error` | `error` |

`MessageMeta = {id, channel, from:{id,name}, codec, ts, seq, duration_ms, packets}`

## 二进制音频帧 Binary audio frame（双向）
```
+--------+---------------------+---------------------+------------------+
| 0x01   | stream_id (u32 BE)  | packet_id (u32 BE)  | Opus packet      |
+--------+---------------------+---------------------+------------------+
```
客户端发送时 `packet_id` 填 0，服务器转发时重写为递增序号。每包是一个完整的 Opus 包（自描述，解码器不需要帧长）。

## 话语权 Floor control（半双工）
- 每个频道同一时刻只允许一个 `stream`，第二个人 `start` 得到 `busy`
- 单次最长 30 s（`MAX_TALK_MS`），4 s 没有包视为松开
- 松开后消息落盘，`on_stop.message` 带元数据

## 存储转发 Store-and-forward（HTTP）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/channels` | 新建频道 → `{code}` |
| GET | `/api/channels/:code/messages?after=<seq>&limit=` | 最近消息元数据 |
| GET | `/api/messages/:id` | 单条元数据 |
| GET | `/api/messages/:id/packets` | 二进制：重复 `[u16 BE 长度][Opus 包]`；响应头 `x-codec: opus;sr=48000;ch=1;frame_ms=20`、`x-from`、`x-duration-ms` |
| POST | `/api/channels/:code/upload` | 整段录音上传。头 `x-from`（发送者名，URL 编码）、`x-platform`，可选 `x-ts`（录音时刻，毫秒，48 h 内有效，作为消息时间）、`x-client-id`（客户端生成的唯一 id；因响应丢失而重试时，同一 id 直接返回首次存下的消息，不会重复）。两种请求体：(a) 音频文件（m4a/aac/wav/ogg 等 ffmpeg 能读的，`content-type` 写文件类型；Apple Watch 用），服务器用 ffmpeg 转成 48 kHz/20 ms/16 kbps 的 Opus 包；(b) `content-type: application/x-skitalk-packets`，请求体就是下面 GET `/packets` 的框格式 `[u16 BE 长度][Opus 包]…`，头 `x-codec: opus;sr=48000;ch=1;frame_ms=60` 描述这些包（客户端离线录好的 Opus 直接上传，不经 ffmpeg）。成功后向在线成员广播 `on_message`，向睡着的设备发推送。频道占线返回 409 `{error:"busy", from}`（客户端稍后重试），无法解码返回 415，`x-codec` 非法或没有包返回 400。 |
| POST | `/api/devices` | `{channel, name, platform, token}` 注册推送设备 |

消息保留 24 h，每频道最多 200 条。

### 客户端离线排队 Client outbox
按下说话时如果连不上中继（或 `start` 超时、连接中途断开），客户端照常录音编码，把 Opus 包攒在本地（网页端存 IndexedDB，刷新也不丢），松开后排队；网络恢复（重新 `join` 成功、系统 online 事件、或定时重试）后按录音时间顺序用上面的 (b) 方式整条上传，带 `x-ts` 和 `x-client-id`。对方收到的是一条 `on_message`，和手表上传一样自动播放。连接在发送中途断开时，中继保留已收到的部分为一条消息，剩余部分作为第二条排队上传。

## 唤醒推送 Wake-up push（iOS）
消息完成后，服务器向频道内未在前台联机的 iOS 设备发 APNs：
- `apns-push-type: pushtotalk`，`apns-topic: <bundle id>.voip-ptt`，`apns-priority: 10`
- payload：`{"message_id","channel","from","duration_ms"}`
iOS 端在 `incomingPushResult` 里返回说话人，随后用 HTTP 拉取包并播放。

## 编码参数 Codec
- Opus，单声道，48 kHz（WebCodecs 要求）；iOS 20 ms/帧，Web 60 ms/帧；16 kbit/s（约 2 KB/s）
- Zello 的选择作对照：16 kHz、60 ms/帧、1 帧/包、码率自动（公开 SDK 源码）
