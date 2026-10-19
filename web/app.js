// Ski Talk browser client.
// Hold the big button (or a Bluetooth/headset play-pause key in toggle mode):
//   mic → AudioWorklet (60 ms frames) → WebCodecs Opus encoder → WebSocket binary frames
// Incoming: WebSocket binary frames → WebCodecs Opus decoder → scheduled playback.
// Everything is half-duplex: the server lets one person talk at a time.

const SR = 48000;            // Opus native rate; WebCodecs requires it for opus
const FRAME_MS = 60;         // Zello uses 60 ms frames too: fewer packets, less overhead
const FRAME_SAMPLES = SR * FRAME_MS / 1000;
const BITRATE = 16000;       // ~2 KB/s; voice stays intelligible on bad signal
const LEAD_MS = 120;         // playout buffer before the first packet is played

const $ = (id) => document.getElementById(id);
const ui = {
  server: $('server'), channel: $('channel'), name: $('name'), join: $('join'), newChannel: $('newChannel'),
  setup: $('setup'), talk: $('talk'), status: $('status'), ptt: $('ptt'), toggleMode: $('toggleMode'), keepAwake: $('keepAwake'),
  members: $('members'), history: $('history'), leave: $('leave'), conn: $('conn'), log: $('log'),
};
const log = (...a) => { const line = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); ui.log.textContent = (line + '\n' + ui.log.textContent).slice(0, 4000); console.log('[ptt]', ...a); };

// Stats for automated tests and debugging
const stats = window.__ptt = { sentPackets: 0, receivedPackets: 0, decodedSamples: 0, playedMessages: 0, state: 'idle', lastError: null };

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
  stream: null, node: null, encoder: null, ts: 0, streamId: 0, running: false,
  async start(streamId) {
    const c = player.ensure();
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await c.audioWorklet.addModule('worklet.js');
    }
    this.streamId = streamId; this.ts = 0; this.running = true;
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        if (!this.running) return;
        const out = new Uint8Array(9 + chunk.byteLength);
        const dv = new DataView(out.buffer);
        out[0] = 0x01; dv.setUint32(1, this.streamId); dv.setUint32(5, 0);
        chunk.copyTo(out.subarray(9));
        if (net.ws?.readyState === 1) { net.ws.send(out); stats.sentPackets++; }
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
        case 'error': return log('server error', o);
      }
    };
    ws.onclose = () => {
      setConn('off', '已断开');
      if (talk.active) talk.stop();
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

// ----------------------------------------------------------------- talk
const talk = {
  active: false, streamId: 0, starting: false,
  async start() {
    if (this.active || this.starting || !net.ws || net.ws.readyState !== 1) return;
    this.starting = true;
    player.ensure();
    const r = await net.cmd({ cmd: 'start', codec: { name: 'opus', sample_rate: SR, channels: 1, frame_ms: FRAME_MS } });
    this.starting = false;
    if (!r.ok) { setStatus('busy', r.error === 'busy' ? `${r.from} 占线，等一下` : r.error); player.chime(330, 120); return; }
    this.active = true; this.streamId = r.stream_id; stats.state = 'tx';
    ui.ptt.classList.add('tx'); setStatus('tx', '🎙️ 发送中… 松开结束');
    player.chime(1320, 50);
    try { await mic.start(r.stream_id); } catch (e) { log('mic failed', String(e)); this.stop(); }
  },
  async stop() {
    if (!this.active) return;
    this.active = false;
    await mic.stop();
    net.ws?.readyState === 1 && net.ws.send(JSON.stringify({ cmd: 'stop', stream_id: this.streamId }));
    ui.ptt.classList.remove('tx'); stats.state = 'idle';
    setStatus('', '空闲 idle');
  },
  toggle() { this.active ? this.stop() : this.start(); },
};

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
  silent.play().catch(() => {});
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Ski Talk', artist: ui.channel.value });
  const onKey = () => { talk.toggle(); try { navigator.mediaSession.playbackState = 'playing'; } catch {} };
  for (const a of ['play', 'pause', 'nexttrack', 'previoustrack']) { try { navigator.mediaSession.setActionHandler(a, onKey); } catch {} }
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
