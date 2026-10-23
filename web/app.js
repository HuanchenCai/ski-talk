// Ski Talk browser client.
// Hold the big button (or a Bluetooth/headset play-pause key in toggle mode):
//   mic → AudioWorklet (60 ms frames) → WebCodecs Opus encoder → WebSocket binary frames
// Incoming: WebSocket binary frames → WebCodecs Opus decoder → scheduled playback.
// Everything is half-duplex: the server lets one person talk at a time.

const SR = 48000;            // Opus native rate; WebCodecs requires it for opus
const FRAME_MS = 60;         // Zello uses 60 ms frames too: fewer packets, less overhead
const FRAME_SAMPLES = SR * FRAME_MS / 1000;
const BITRATE = 16000;       // ~2 KB/s; voice stays intelligible on bad signal
// iOS stops routing headset/AirPods media keys to a page while it holds the microphone, so on iOS
// the mic is opened only for the duration of a transmission (and never prewarmed at join).
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const LEAD_MS = 120;         // playout buffer before the first packet is played

const $ = (id) => document.getElementById(id);
const ui = {
  server: $('server'), channel: $('channel'), name: $('name'), join: $('join'), newChannel: $('newChannel'),
  setup: $('setup'), talk: $('talk'), status: $('status'), ptt: $('ptt'), toggleMode: $('toggleMode'), keepAwake: $('keepAwake'),
  members: $('members'), history: $('history'), leave: $('leave'), conn: $('conn'), log: $('log'), outbox: $('outbox'), outbox: $('outbox'),
};
const log = (...a) => {
  const line = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  ui.log.textContent = (line + '\n' + ui.log.textContent).slice(0, 4000); console.log('[ptt]', ...a);
  try { if (DEBUG && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ cmd: 'debug', line })); } catch {}   // ?debug=1: mirror to the relay's console for field debugging
};

// Stats for automated tests and debugging
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const stats = window.__ptt = { sentPackets: 0, receivedPackets: 0, decodedSamples: 0, playedMessages: 0, state: 'idle', micReady: false, queued: 0, uploaded: 0, lastError: null };

// ----------------------------------------------------------------- settings
const qs = new URLSearchParams(location.search);
const saved = JSON.parse(localStorage.getItem('skitalk') || '{}');
ui.server.value = qs.get('server') || saved.server || '';
ui.channel.value = (qs.get('ch') || saved.channel || '').toUpperCase();
ui.name.value = qs.get('name') || saved.name || '';
ui.toggleMode.checked = Boolean(saved.toggle);
const persist = () => localStorage.setItem('skitalk', JSON.stringify({ server: ui.server.value, channel: ui.channel.value, name: ui.name.value, toggle: ui.toggleMode.checked }));

const httpBase = () => (ui.server.value.trim() || location.origin).replace(/\/$/, '');
const wsUrl = () => httpBase().replace(/^http/, 'ws') + '/ws';

// ----------------------------------------------------------------- audio out
let actx = null;
const player = {
  nextTime: 0, decoder: null, activeStream: null,
  ensure() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR, latencyHint: 'interactive' });
    if (actx.state === 'suspended') actx.resume();
    return actx;
  },
  newDecoder() {
    if (this.decoder) { try { this.decoder.close(); } catch {} }
    this.decoder = new AudioDecoder({
      output: (ad) => this.playAudioData(ad),
      error: (e) => { stats.lastError = String(e); log('decoder error', String(e)); },
    });
    this.decoder.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 });
    this.nextTime = 0;
  },
  chime(freq = 880, ms = 70) {
    const c = this.ensure();
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g).connect(c.destination);
    const t = Math.max(c.currentTime, this.nextTime);
    o.start(t); o.stop(t + ms / 1000);
    this.nextTime = t + ms / 1000 + 0.03;
  },
  feed(opusBytes, ts) {
    if (!this.decoder || this.decoder.state !== 'configured') this.newDecoder();
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: opusBytes }));
  },
  playAudioData(ad) {
    const c = this.ensure();
    const buf = c.createBuffer(1, ad.numberOfFrames, ad.sampleRate);
    const f32 = new Float32Array(ad.numberOfFrames);
    ad.copyTo(f32, { planeIndex: 0, format: 'f32-planar' });
    ad.close();
    buf.copyToChannel(f32, 0);
    stats.decodedSamples += f32.length;
    const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
    const now = c.currentTime;
    if (this.nextTime < now) this.nextTime = now + LEAD_MS / 1000;   // (re)prime the playout buffer
    src.start(this.nextTime);
    this.nextTime += buf.duration;
  },
  async flush() { try { await this.decoder?.flush(); } catch {} },
};

// ----------------------------------------------------------------- audio in
const mic = {
  stream: null, src: null, node: null, encoder: null, ts: 0, running: false, ready: null, worklet: null,
  // The worklet module is fetched once at join on every platform, so recording still works when the
  // network is gone later (the device itself is opened by prepare()).
  loadWorklet() {
    if (!this.worklet) this.worklet = player.ensure().audioWorklet.addModule('worklet.js').catch((e) => { this.worklet = null; throw e; });
    return this.worklet;
  },
  // Open the microphone once (prompts for permission the first time). Called when joining a channel
  // (not on iOS, see IOS) so the first press does not lose its first half second, and again before
  // every transmission in case the join-time attempt failed or the device went away.
  prepare() {
    if (this.ready && this.stream && this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) { this.ready = null; this.stream = null; stats.micReady = false; }
    if (!this.ready) {
      this.ready = (async () => {
        await this.loadWorklet();
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        stats.micReady = true;
        log('麦克风已打开');
      })().catch((e) => { this.ready = null; this.stream = null; stats.micReady = false; throw e; });
    }
    return this.ready;
  },
  // Synchronous: requires prepare() to have resolved. Capture begins on the next audio render quantum.
  // Every encoded Opus packet is handed to sink(payload); the caller decides whether it goes out live
  // or into the offline buffer.
  start(sink) {
    if (!this.stream) throw new Error('mic not prepared');
    const c = player.ensure();
    this.ts = 0; this.running = true;
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        if (!this.running) return;
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        sink(payload);
      },
      error: (e) => { stats.lastError = String(e); log('encoder error', String(e)); },
    });
    this.encoder.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1, bitrate: BITRATE, opus: { frameDuration: FRAME_MS * 1000, application: 'voip' } });
    const src = c.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(c, 'capture-processor', { processorOptions: { frameSamples: FRAME_SAMPLES } });
    this.node.port.onmessage = (e) => {
      if (!this.running || this.encoder.state !== 'configured') return;
      const data = e.data;
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: data.length, numberOfChannels: 1, timestamp: this.ts, data });
      this.ts += Math.round(data.length / SR * 1e6);
      this.encoder.encode(ad); ad.close();
    };
    src.connect(this.node);        // worklet has no output; nothing reaches the speaker
    this.src = src;
  },
  async stop() {
    if (!this.running) return;
    this.running = false;
    try { this.node?.port.postMessage('stop'); this.src?.disconnect(); this.node?.disconnect(); } catch {}
    try { await this.encoder?.flush(); this.encoder?.close(); } catch {}
    this.encoder = null;
    if (IOS) this.release();
  },
  // Let go of the microphone entirely; the next prepare() asks for it again.
  release() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    this.stream = null; this.ready = null; stats.micReady = false;
    log('麦克风已释放');
  },
};

// ----------------------------------------------------------------- network
const net = {
  ws: null, seq: 0, pending: new Map(), me: null, channel: null, lastSeq: 0, talking: null, reconnectTimer: null, wantConnected: false,
  connect() {
    this.wantConnected = true;
    clearTimeout(this.reconnectTimer);
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    setConn('busy', '连接中…');
    ws.onopen = async () => {
      const r = await this.cmd({ cmd: 'join', channel: ui.channel.value, name: ui.name.value || 'anon', client: { platform: 'web', ua: navigator.userAgent.slice(0, 40) }, after_seq: this.lastSeq });
      if (!r.ok) { setConn('off', r.error); log('join failed', r); return; }
      this.me = r.you; this.channel = r.channel;
      setConn('on', `${r.channel} · ${this.me.name}`);
      renderMembers(r.members); renderHistory(r.history);
      if (r.talking) onStart(r.talking);
      ui.setup.classList.add('hidden'); ui.talk.classList.remove('hidden');
      persist();
      mic.loadWorklet().catch((e) => log('worklet 加载失败', String(e)));
      if (!IOS) mic.prepare().catch((e) => log('麦克风暂不可用，按下时再试', String(e)));   // prewarm the device (not on iOS, see IOS)
      outbox.flush();                                                                        // anything recorded while we were away
      history.replaceState(null, '', `?ch=${encodeURIComponent(r.channel)}&name=${encodeURIComponent(this.me.name)}${ui.server.value ? '&server=' + encodeURIComponent(ui.server.value) : ''}`);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) return onPacket(new Uint8Array(ev.data));
      const o = JSON.parse(ev.data);
      if (o.seq && this.pending.has(o.seq)) { this.pending.get(o.seq)(o); this.pending.delete(o.seq); return; }
      switch (o.event) {
        case 'members': return renderMembers(o.members);
        case 'on_start': return onStart(o);
        case 'on_stop': return onStop(o);
        case 'on_message': return onMessage(o.message);   // whole-message upload (e.g. from an Apple Watch)
        case 'error': return log('server error', o);
      }
    };
    ws.onclose = () => {
      setConn('off', '已断开');
      if (talk.active) setStatus('tx', '📵 连接断开，离线录音中… 松开后排队发送');
      if (this.wantConnected) this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => { stats.lastError = 'ws error'; };
  },
  disconnect() { this.wantConnected = false; this.ws?.close(); this.ws = null; },
  cmd(o) {
    return new Promise((res) => {
      const seq = ++this.seq; this.pending.set(seq, res);
      this.ws.send(JSON.stringify({ seq, ...o }));
      setTimeout(() => { if (this.pending.has(seq)) { this.pending.delete(seq); res({ ok: false, error: 'timeout' }); } }, 5000);
    });
  },
};

function onPacket(u8) {
  if (u8[0] !== 0x01 || u8.length < 9) return;
  const dv = new DataView(u8.buffer, u8.byteOffset);
  const streamId = dv.getUint32(1), packetId = dv.getUint32(5);
  if (!net.talking || net.talking.stream_id !== streamId) return;
  stats.receivedPackets++;
  player.feed(u8.slice(9), packetId * FRAME_MS * 1000);
}
function onStart(o) {
  net.talking = o;
  stats.state = 'rx';
  player.newDecoder();
  player.chime(880);
  setStatus('rx', `🔊 ${o.from.name} 正在说话…`);
  ui.ptt.classList.add('busy'); ui.ptt.disabled = !talk.active;
}
async function onStop(o) {
  const wasMine = talk.active && talk.streamId === o.stream_id;
  if (net.talking?.stream_id === o.stream_id) { net.talking = null; await player.flush(); }
  if (o.message) { net.lastSeq = Math.max(net.lastSeq, o.message.seq); addHistory(o.message, true); if (!wasMine) stats.playedMessages++; }
  stats.state = 'idle';
  ui.ptt.classList.remove('busy'); ui.ptt.disabled = false;
  if (!talk.active) setStatus('', '空闲 idle');
}

// A message that arrived complete (watch upload): list it and play it like live talk.
async function onMessage(m) {
  if (!m) return;
  net.lastSeq = Math.max(net.lastSeq, m.seq);
  addHistory(m, true);
  if (m.from.name === net.me?.name) return;
  setStatus('rx', `🔊 ${m.from.name}（录音）`);
  await replay(m);
  if (!talk.active) setStatus('', '空闲 idle');
}

// ----------------------------------------------------------------- talk
// Capture starts as soon as the microphone is open; the relay's floor is asked for in parallel.
// Packets go out live once the floor is granted. Until then — and whenever the connection is gone —
// they collect in `buffer`, and whatever is still buffered at release is queued in the outbox and
// uploaded as a whole message when the network is back. So a press always records something.
const CODEC = { name: 'opus', sample_rate: SR, channels: 1, frame_ms: FRAME_MS };
const packetFrame = (streamId, payload) => {
  const out = new Uint8Array(9 + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x01; dv.setUint32(1, streamId); dv.setUint32(5, 0);
  out.set(payload, 9);
  return out;
};
const talk = {
  active: false, starting: false, abort: false,
  live: false, streamId: 0, buffer: [], rec: null, floorPending: false,
  async start() {
    if (this.active || this.starting) return;
    this.starting = true; this.abort = false;
    player.ensure();
    try { await mic.prepare(); }
    catch (e) { this.starting = false; log('mic failed', String(e)); setStatus('busy', '麦克风不可用'); player.chime(330, 120); return; }
    if (this.abort) { this.starting = false; return; }           // button was let go before the mic was ready
    const connected = net.ws?.readyState === 1 && !!net.me;
    this.live = false; this.streamId = 0; this.buffer = []; this.rec = { ts: Date.now(), channel: ui.channel.value, name: net.me?.name || ui.name.value || 'anon', codec: CODEC };
    try { mic.start((payload) => this.onPayload(payload)); }
    catch (e) { this.starting = false; log('mic failed', String(e)); return; }
    this.starting = false; this.active = true; stats.state = 'tx';
    ui.ptt.classList.add('tx');
    if (connected) { setStatus('tx', '🎙️ 发送中… 松开结束'); player.chime(1320, 50); this.requestFloor(); }
    else { setStatus('tx', '📵 离线录音中… 松开后排队发送'); player.chime(990, 50); }
  },
  onPayload(payload) {
    if (this.live && net.ws?.readyState === 1) { net.ws.send(packetFrame(this.streamId, payload)); stats.sentPackets++; }
    else this.buffer.push(payload);
  },
  async requestFloor() {
    this.floorPending = true;
    const r = await net.cmd({ cmd: 'start', codec: CODEC });
    this.floorPending = false;
    if (r.ok) {
      this.streamId = r.stream_id; this.live = true;
      for (const p of this.buffer.splice(0)) this.onPayload(p);   // what was said while the relay was deciding
      if (!this.active) this.finish();                            // already released: deliver, then close the stream
      return;
    }
    if (r.error === 'busy') {                                     // someone else holds the floor: this press is void
      this.buffer = []; this.rec = null;
      if (this.active) { this.active = false; await mic.stop(); ui.ptt.classList.remove('tx'); stats.state = 'idle'; }
      setStatus('busy', `${r.from} 占线，等一下`); player.chime(330, 120);
      return;
    }
    // timeout or other failure: the network is not there; keep recording, deliver later
    if (this.active) setStatus('tx', '📵 网络不通，离线录音中… 松开后排队发送');
    else this.finish();
  },
  async stop() {
    if (this.starting) { this.abort = true; return; }
    if (!this.active) return;
    this.active = false;
    await mic.stop();                                   // flushes the encoder: the last packets reach onPayload first
    ui.ptt.classList.remove('tx'); stats.state = 'idle';
    setStatus('', '空闲 idle');
    if (this.floorPending) return;                      // requestFloor() calls finish() when the reply lands
    this.finish();
  },
  finish() {
    if (this.live && net.ws?.readyState === 1) {
      for (const p of this.buffer.splice(0)) this.onPayload(p);
      net.ws.send(JSON.stringify({ cmd: 'stop', stream_id: this.streamId }));
    }
    // Not live (never got the floor), or the connection died mid-stream (the relay keeps what it
    // received; the rest goes out as a second message): queue what is buffered.
    const left = this.buffer.splice(0);
    if (left.length >= 2 && this.rec) outbox.add({ ...this.rec, packets: left });
    this.live = false; this.rec = null;
  },
  toggle() { this.active ? this.stop() : this.start(); },
};

// ----------------------------------------------------------------- outbox
// Messages recorded without the relay, persisted in IndexedDB so they survive a reload or a
// crash, and uploaded whole (POST …/upload, our own packet framing) once the network is back.
const outbox = {
  db: null, flushing: false, timer: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('skitalk', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
      r.onsuccess = () => res(this.db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return this.open().then((db) => new Promise((res, rej) => {
      const t = db.transaction('outbox', mode); const req = fn(t.objectStore('outbox'));
      t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error);
    }));
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  remove(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  async add(rec) {
    rec.id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { await this.tx('readwrite', (s) => s.put(rec)); }
    catch (e) { log('离线消息无法保存', String(e)); return; }
    log(`离线消息已排队：${(rec.packets.length * FRAME_MS / 1000).toFixed(1)} s`);
    await this.refresh();
    this.flush();
  },
  async refresh() {
    let n = 0;
    try { n = (await this.all()).length; } catch {}
    stats.queued = n;
    ui.outbox.textContent = n ? `📵 ${n} 条离线录音待发送，有网后自动补发` : '';
    ui.outbox.classList.toggle('hidden', !n);
  },
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    clearTimeout(this.timer);
    try {
      const list = (await this.all()).sort((a, b) => a.ts - b.ts);
      for (const rec of list) {
        let res;
        try {
          res = await fetch(`${httpBase()}/api/channels/${encodeURIComponent(rec.channel)}/upload`, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-skitalk-packets',
              'x-codec': `opus;sr=${rec.codec.sample_rate};ch=${rec.codec.channels};frame_ms=${rec.codec.frame_ms}`,
              'x-from': encodeURIComponent(rec.name), 'x-platform': 'web', 'x-ts': String(rec.ts), 'x-client-id': rec.id,
            },
            body: framePackets(rec.packets),
          });
        } catch { this.later(10000); break; }                 // still no network
        if (res.status === 409) { this.later(3000); break; }  // channel busy right now; try again shortly
        if (res.ok) { await this.remove(rec.id); stats.uploaded++; log(`离线消息已补发：${(rec.packets.length * FRAME_MS / 1000).toFixed(1)} s`); continue; }
        log('离线消息被服务器拒绝，已丢弃', res.status); await this.remove(rec.id);
      }
    } catch (e) { log('outbox', String(e)); }
    finally { this.flushing = false; await this.refresh(); }
  },
  later(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), ms); },
};
// [u16 BE length][opus packet]… — the same framing GET …/packets returns
function framePackets(packets) {
  const out = new Uint8Array(packets.reduce((n, p) => n + 2 + p.length, 0));
  let o = 0;
  for (const p of packets) { out[o] = p.length >> 8; out[o + 1] = p.length & 255; out.set(p, o + 2); o += 2 + p.length; }
  return out;
}
window.addEventListener('online', () => outbox.flush());
// The OS says the network is gone: don't wait for the relay's 30 s heartbeat to notice. Closing the
// socket flips the UI to offline recording at once; the reconnect loop brings it back when it can.
window.addEventListener('offline', () => { if (net.wantConnected) { log('系统报告离线'); net.ws?.close(); } });
outbox.refresh();

// Big button: hold (default) or toggle
let holdPointer = null;
ui.ptt.addEventListener('pointerdown', (e) => {
  e.preventDefault(); ui.ptt.setPointerCapture(e.pointerId);
  if (ui.toggleMode.checked) return talk.toggle();
  holdPointer = e.pointerId; talk.start();
});
const release = (e) => { if (holdPointer !== null && (!e || e.pointerId === holdPointer)) { holdPointer = null; talk.stop(); } };
ui.ptt.addEventListener('pointerup', release);
ui.ptt.addEventListener('pointercancel', release);
window.addEventListener('blur', () => release());
// Space bar as PTT key
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && !ui.talk.classList.contains('hidden') && e.target.tagName !== 'INPUT') { e.preventDefault(); ui.toggleMode.checked ? talk.toggle() : talk.start(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && !ui.toggleMode.checked) talk.stop(); });

// Bluetooth PTT button / headset button: they send media play/pause.
// Keeping a silent track "playing" makes the browser hand those keys to us.
let silent = null;
function armMediaKeys() {
  if (!('mediaSession' in navigator) || silent) return;
  silent = new Audio(silentWavURL(1)); silent.loop = true; silent.volume = 0.01;
  silent.play().then(() => log('静音音轨播放中（媒体会话已持有）')).catch((e) => log('静音音轨播放失败，媒体键可能收不到', String(e)));
  silent.addEventListener('playing', () => { if (!silent.__loggedPlaying) { silent.__loggedPlaying = true; log('静音音轨 playing'); } });
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Ski Talk', artist: ui.channel.value });
  // One physical press can arrive as several actions: iOS pauses our silent track when the
  // microphone opens and reports that as a 'pause', then a 'play' when it resumes. Treat
  // everything inside the guard window as the same press, and keep the silent track playing
  // so the media session (and the next press) stays ours.
  const GUARD_MS = 800;
  let lastKey = 0;
  const keepAlive = () => { try { navigator.mediaSession.playbackState = 'playing'; } catch {} if (silent.paused) silent.play().catch(() => {}); };
  const onKey = (d) => {
    const now = performance.now();
    const action = d?.action || '?';
    if (now - lastKey < GUARD_MS) { log(`媒体键 ${action} 忽略（${Math.round(now - lastKey)} ms 内重复）`); keepAlive(); return; }
    lastKey = now;
    log(`媒体键 ${action} → ${talk.active ? '结束' : '开始'}`);
    talk.toggle(); keepAlive();
  };
  for (const a of ['play', 'pause', 'nexttrack', 'previoustrack']) { try { navigator.mediaSession.setActionHandler(a, onKey); } catch {} }
  // iOS also pauses the element itself when the audio session changes; restart it without toggling.
  silent.addEventListener('pause', () => setTimeout(() => { if (silent && silent.paused) silent.play().catch(() => {}); }, 300));
  log('媒体键已接管：蓝牙按钮/耳机键 = 对讲开关');
}

// A real 1-second silent 8 kHz 16-bit mono WAV (an empty data chunk makes some browsers unhappy)
function silentWavURL(seconds) {
  const sr = 8000, n = sr * seconds, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// ----------------------------------------------------------------- UI glue
function setConn(cls, text) { ui.conn.className = 'pill ' + cls; ui.conn.textContent = text; }
function setStatus(cls, text) { ui.status.className = 'status ' + cls; ui.status.textContent = text; }
function renderMembers(list) { ui.members.textContent = list.map((m) => `${m.name}${m.talking ? '🎙️' : ''}${m.background ? '💤' : ''}`).join('，') || '–'; }
function renderHistory(list) { ui.history.innerHTML = ''; for (const m of list) addHistory(m, false); }
function addHistory(m, top) {
  const li = document.createElement('li');
  li.dataset.id = m.id;
  li.innerHTML = `<span>${escapeHtml(m.from.name)} · ${(m.duration_ms / 1000).toFixed(1)}s</span><span>${new Date(m.ts).toLocaleTimeString()}</span>`;
  li.onclick = () => replay(m);
  top ? ui.history.prepend(li) : ui.history.append(li);
  while (ui.history.children.length > 20) ui.history.lastChild.remove();
}
async function replay(m) {
  const res = await fetch(`${httpBase()}/api/messages/${m.id}/packets`);
  const buf = new Uint8Array(await res.arrayBuffer());
  player.newDecoder(); player.chime(660);
  let o = 0, i = 0;
  while (o + 2 <= buf.length) {
    const len = (buf[o] << 8) | buf[o + 1]; o += 2;
    player.feed(buf.slice(o, o + len), i++ * FRAME_MS * 1000); o += len;
  }
  await player.flush();
  stats.playedMessages++;
  log(`replayed ${m.id}: ${i} packets`);
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

ui.join.onclick = () => {
  if (!ui.channel.value.trim()) return alert('先填频道码');
  if (!('AudioEncoder' in window)) return alert('这个浏览器不支持 WebCodecs（需要 Chrome / Edge / Safari 16.4+）');
  ui.channel.value = ui.channel.value.trim().toUpperCase();
  player.ensure(); armMediaKeys(); net.connect();
};
ui.newChannel.onclick = async () => {
  const r = await (await fetch(httpBase() + '/api/channels', { method: 'POST' })).json();
  ui.channel.value = r.code; ui.channel.focus();
};
ui.leave.onclick = () => { talk.stop(); net.disconnect(); ui.talk.classList.add('hidden'); ui.setup.classList.remove('hidden'); setConn('off', '未连接'); };
ui.toggleMode.onchange = persist;
let wakeLock = null;
ui.keepAwake.onchange = async () => {
  try { if (ui.keepAwake.checked) wakeLock = await navigator.wakeLock.request('screen'); else { await wakeLock?.release(); wakeLock = null; } }
  catch (e) { log('wakeLock', String(e)); }
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ui.keepAwake.checked) ui.keepAwake.onchange(); });

if (qs.get('autojoin') === '1' && ui.channel.value) ui.join.click();
