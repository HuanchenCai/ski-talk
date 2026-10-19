// Ski-Talk relay server.
//
// One process does everything a group needs:
//   * WebSocket (JSON control + binary Opus packets) for live half-duplex talk
//   * floor control: one talker per channel at a time, like a real radio
//   * store-and-forward: every finished transmission is kept 24 h and can be
//     fetched over HTTP by phones that were asleep
//   * wake-up pushes (APNs push-to-talk) for iOS clients in the background
//   * serves the browser client from ../web
//
// Wire format (same idea as Zello's public Channel API):
//   text frame  = JSON {cmd:...} / {event:...}
//   binary frame = [0x01][stream_id u32 BE][packet_id u32 BE][opus packet]

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store, publicMeta, normalizeCode, frame } from './store.js';
import { Pusher } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../../web');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');

const MAX_TALK_MS = Number(process.env.MAX_TALK_MS || 30_000);   // hard cap per transmission
const IDLE_STOP_MS = 4_000;                                       // no packets → treat as released
const MAX_PACKET = 4_000;                                         // bytes; Opus voice packets are < 400

export async function createServer({ port = Number(process.env.PORT || 8080), dataDir = DATA_DIR, log = console.log } = {}) {
  const store = new Store(dataDir);
  await store.load();
  const pusher = new Pusher();
  log(`[push] APNs ${pusher.enabled ? 'enabled' : 'disabled (set APNS_* env to enable)'}`);

  /** channel code → runtime state */
  const rooms = new Map();
  const room = (code) => {
    code = normalizeCode(code);
    let r = rooms.get(code);
    if (!r) { r = { code, clients: new Set(), talking: null, devices: new Map() }; rooms.set(code, r); }
    return r;
  };
  const devicesFile = path.join(dataDir, 'devices.json');
  try {
    for (const [code, list] of Object.entries(JSON.parse(fs.readFileSync(devicesFile, 'utf8')))) {
      for (const d of list) room(code).devices.set(d.token, d);
    }
  } catch { /* first run */ }
  const saveDevices = () => {
    const o = {};
    for (const r of rooms.values()) if (r.devices.size) o[r.code] = [...r.devices.values()];
    return fsp.writeFile(devicesFile, JSON.stringify(o));
  };

  // ---------------------------------------------------------------- HTTP
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      res.writeHead(code, {
        'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(isBuf ? body : JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
        return res.end();
      }
      if (url.pathname === '/healthz') return send(200, { ok: true, channels: rooms.size });

      if (url.pathname === '/api/channels' && req.method === 'POST') {
        const code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
        store.channel(code);
        return send(200, { code });
      }
      let m;
      if ((m = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/))) {
        const after = Number(url.searchParams.get('after') || 0);
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        return send(200, { channel: normalizeCode(m[1]), messages: store.list(m[1], after, limit) });
      }
      if ((m = url.pathname.match(/^\/api\/messages\/([^/]+)\/packets$/))) {
        const msg = store.get(m[1]);
        if (!msg) return send(404, { error: 'not found' });
        return send(200, frame(msg.packets), {
          'x-codec': `${msg.codec.name};sr=${msg.codec.sample_rate};ch=${msg.codec.channels};frame_ms=${msg.codec.frame_ms}`,
          'x-from': encodeURIComponent(msg.from.name),
          'x-duration-ms': String(msg.duration_ms),
        });
      }
      if ((m = url.pathname.match(/^\/api\/messages\/([^/]+)$/))) {
        const msg = store.get(m[1]);
        return msg ? send(200, publicMeta(msg)) : send(404, { error: 'not found' });
      }
      if (url.pathname === '/api/devices' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const ok = registerDevice(body.channel, body);
        return send(ok ? 200 : 400, { ok });
      }
      if (url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });

      // static web client
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(WEB_DIR, file);
      if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(404, { error: 'not found' });
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(full)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      log('[http] error', e);
      send(500, { error: 'internal' });
    }
  });

  function registerDevice(code, d) {
    if (!code || !d?.token || !d?.platform) return false;
    const r = room(code);
    r.devices.set(d.token, { token: d.token, platform: d.platform, name: d.name || '', seen: Date.now() });
    saveDevices().catch(() => {});
    return true;
  }

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws) => {
    const c = { id: crypto.randomBytes(3).toString('hex'), ws, room: null, name: '', platform: '', background: false, deviceToken: null, alive: true };
    const send = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    ws.on('pong', () => { c.alive = true; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return onAudio(c, data);
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return send({ event: 'error', error: 'invalid json' }); }
      const reply = (o) => send({ seq: msg.seq, ...o });
      switch (msg.cmd) {
        case 'join': return onJoin(c, msg, reply);
        case 'leave': return leave(c);
        case 'start': return onStart(c, msg, reply);
        case 'stop': return onStop(c, msg.stream_id, 'released');
        case 'presence': c.background = msg.state === 'background'; return broadcastMembers(c.room);
        case 'register_device':
          if (c.room && registerDevice(c.room.code, msg)) { c.deviceToken = msg.token; return reply({ ok: true }); }
          return reply({ ok: false, error: 'not joined or bad token' });
        case 'ping': return send({ event: 'pong', t: Date.now() });
        default: return reply({ ok: false, error: 'unknown command' });
      }
    });
    ws.on('close', () => leave(c));
    ws.on('error', () => leave(c));
  });

  function onJoin(c, msg, reply) {
    const code = normalizeCode(msg.channel);
    if (code.length < 3) return reply({ ok: false, error: 'bad channel code' });
    leave(c);
    c.name = String(msg.name || 'anon').slice(0, 24);
    c.platform = String(msg.client?.platform || 'web');
    c.room = room(code);
    c.room.clients.add(c);
    store.channel(code);
    reply({
      ok: true, channel: code, you: { id: c.id, name: c.name },
      members: members(c.room),
      talking: c.room.talking ? talkingInfo(c.room.talking) : null,
      history: store.list(code, Number(msg.after_seq || 0), 20),
    });
    broadcastMembers(c.room, c);
  }

  function leave(c) {
    const r = c.room;
    if (!r) return;
    if (r.talking && r.talking.client === c) onStop(c, r.talking.stream_id, 'disconnected');
    r.clients.delete(c);
    c.room = null;
    broadcastMembers(r);
  }

  function onStart(c, msg, reply) {
    const r = c.room;
    if (!r) return reply({ ok: false, error: 'not joined' });
    if (r.talking) {
      // Half-duplex: the channel is busy. Tell the client who holds the floor.
      return reply({ ok: false, error: 'busy', from: r.talking.client.name });
    }
    const codec = {
      name: 'opus',
      sample_rate: Number(msg.codec?.sample_rate || 48000),
      channels: 1,
      frame_ms: Number(msg.codec?.frame_ms || 20),
    };
    const stream_id = (crypto.randomBytes(4).readUInt32BE() % 0x7fffffff) + 1;
    const message = store.begin(r.code, { id: c.id, name: c.name }, codec);
    r.talking = { stream_id, client: c, message, codec, startedAt: Date.now(), lastPacketAt: Date.now(), packetId: 0, idle: null, cap: null };
    r.talking.cap = setTimeout(() => onStop(c, stream_id, 'max length'), MAX_TALK_MS);
    r.talking.idle = setInterval(() => {
      if (Date.now() - r.talking.lastPacketAt > IDLE_STOP_MS) onStop(c, stream_id, 'idle');
    }, 1000);
    reply({ ok: true, stream_id });
    broadcast(r, { event: 'on_start', stream_id, from: { id: c.id, name: c.name }, codec, message_id: message.id }, c);
  }

  function onAudio(c, data) {
    const r = c.room;
    const t = r?.talking;
    if (!t || t.client !== c || data.length < 9 || data.length > MAX_PACKET + 9) return;
    if (data[0] !== 0x01 || data.readUInt32BE(1) !== t.stream_id) return;
    const opus = Buffer.from(data.subarray(9));
    t.lastPacketAt = Date.now();
    t.packetId += 1;
    store.append(t.message, opus);
    // Rewrite packet_id so receivers can detect loss/order.
    const out = Buffer.allocUnsafe(9 + opus.length);
    out[0] = 0x01; out.writeUInt32BE(t.stream_id, 1); out.writeUInt32BE(t.packetId, 5); opus.copy(out, 9);
    for (const o of r.clients) {
      if (o === c || o.background) continue;           // background phones get a push instead
      if (o.ws.readyState === o.ws.OPEN && o.ws.bufferedAmount < 256 * 1024) o.ws.send(out, { binary: true });
    }
  }

  async function onStop(c, stream_id, reason) {
    const r = c.room;
    const t = r?.talking;
    if (!t || t.stream_id !== Number(stream_id)) return;
    clearTimeout(t.cap); clearInterval(t.idle);
    r.talking = null;
    const duration_ms = t.packetId * t.codec.frame_ms;
    if (t.packetId === 0) {
      store.discard(t.message);
      broadcast(r, { event: 'on_stop', stream_id, message: null, reason });
      return;
    }
    const msg = await store.finish(t.message, duration_ms);
    const meta = publicMeta(msg);
    broadcast(r, { event: 'on_stop', stream_id, message: meta, reason });
    wakeSleepers(r, meta);
  }

  // Phones with no live socket (or that told us they are in the background)
  // get a wake-up push and fetch the message over HTTP.
  function wakeSleepers(r, meta) {
    const awake = new Set([...r.clients].filter((c) => !c.background && c.deviceToken).map((c) => c.deviceToken));
    for (const d of r.devices.values()) {
      if (awake.has(d.token)) continue;
      if (meta.from.name === d.name) continue;
      pusher.pttPush(d, { message_id: meta.id, channel: r.code, from: meta.from.name, duration_ms: meta.duration_ms })
        .then((res) => { if (!res.ok && pusher.enabled) log('[push] failed', d.token.slice(0, 8), res); });
    }
  }

  const members = (r) => [...r.clients].map((c) => ({ id: c.id, name: c.name, platform: c.platform, background: c.background, talking: r.talking?.client === c }));
  const talkingInfo = (t) => ({ stream_id: t.stream_id, from: { id: t.client.id, name: t.client.name }, codec: t.codec, message_id: t.message.id });
  function broadcast(r, o, except) {
    const s = JSON.stringify(o);
    for (const c of r.clients) if (c !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(s);
  }
  const broadcastMembers = (r, except) => r && broadcast(r, { event: 'members', members: members(r) }, except);

  // Keepalive + sweep
  const timers = [
    setInterval(() => {
      for (const ws of wss.clients) {
        const c = [...rooms.values()].flatMap((r) => [...r.clients]).find((x) => x.ws === ws);
        if (c && !c.alive) return ws.terminate();
        if (c) c.alive = false;
        ws.ping();
      }
    }, 30_000),
    setInterval(() => store.sweep(), 10 * 60_000),
  ];

  await new Promise((res) => server.listen(port, res));
  const addr = server.address();
  log(`[ski-talk] listening on http://localhost:${addr.port}  (ws: /ws, web client: /)`);

  return {
    port: addr.port,
    store,
    close: () => new Promise((res) => { timers.forEach(clearInterval); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(() => res()); }),
  };
}

function readBody(req) {
  return new Promise((res, rej) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); }); req.on('end', () => res(s)); req.on('error', rej); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createServer().catch((e) => { console.error(e); process.exit(1); });
}
