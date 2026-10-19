import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const events = [];
  const waiters = [];
  const bins = [];
  let seq = 0;
  ws.on('message', (d, isBin) => {
    if (isBin) { bins.push(Buffer.from(d)); return; }
    const o = JSON.parse(d.toString());
    events.push(o);
    for (const w of [...waiters]) if (w.pred(o)) { waiters.splice(waiters.indexOf(w), 1); w.res(o); }
  });
  const wait = (pred, ms = 3000) => new Promise((res, rej) => {
    const hit = events.find(pred);
    if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error('timeout waiting: ' + pred)), ms);
    waiters.push({ pred, res: (o) => { clearTimeout(t); res(o); } });
  });
  const cmd = (o) => { const s = ++seq; ws.send(JSON.stringify({ seq: s, ...o })); return wait((e) => e.seq === s); };
  const open = new Promise((res) => ws.on('open', res));
  return { ws, open, cmd, wait, events, bins, close: () => ws.close() };
}

const pkt = (streamId, payload) => {
  const b = Buffer.alloc(9 + payload.length);
  b[0] = 1; b.writeUInt32BE(streamId, 1); b.writeUInt32BE(0, 5); payload.copy(b, 9);
  return b;
};

test('join, talk, floor control, store-and-forward, HTTP fetch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skitalk-'));
  const srv = await createServer({ port: 0, dataDir, log: () => {} });
  try {
    const a = client(srv.port), b = client(srv.port);
    await Promise.all([a.open, b.open]);
    const ja = await a.cmd({ cmd: 'join', channel: 'test01', name: 'Anna' });
    assert.equal(ja.ok, true); assert.equal(ja.channel, 'TEST01');
    const jb = await b.cmd({ cmd: 'join', channel: 'TEST01', name: 'Bo', client: { platform: 'ios' } });
    assert.equal(jb.members.length, 2);

    // A takes the floor
    const st = await a.cmd({ cmd: 'start', codec: { sample_rate: 48000, frame_ms: 20 } });
    assert.equal(st.ok, true);
    const onStart = await b.wait((e) => e.event === 'on_start');
    assert.equal(onStart.from.name, 'Anna');

    // B cannot talk while A holds it
    const busy = await b.cmd({ cmd: 'start' });
    assert.equal(busy.ok, false); assert.equal(busy.error, 'busy'); assert.equal(busy.from, 'Anna');

    // A sends 10 fake Opus packets; B receives them with increasing packet ids
    for (let i = 0; i < 10; i++) a.ws.send(pkt(st.stream_id, Buffer.from([0xf8, i, i, i])));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.bins.length, 10);
    assert.equal(b.bins[0][0], 1);
    assert.equal(b.bins[9].readUInt32BE(1), st.stream_id);
    assert.equal(b.bins[9].readUInt32BE(5), 10);
    assert.deepEqual([...b.bins[3].subarray(9)], [0xf8, 3, 3, 3]);

    // A releases; everyone gets on_stop with the stored message
    a.ws.send(JSON.stringify({ cmd: 'stop', stream_id: st.stream_id }));
    const stop = await b.wait((e) => e.event === 'on_stop');
    assert.equal(stop.message.from.name, 'Anna');
    assert.equal(stop.message.packets, 10);
    assert.equal(stop.message.duration_ms, 200);

    // now B can talk
    const st2 = await b.cmd({ cmd: 'start' });
    assert.equal(st2.ok, true);
    b.ws.send(JSON.stringify({ cmd: 'stop', stream_id: st2.stream_id }));
    const stop2 = await a.wait((e) => e.event === 'on_stop' && e.stream_id === st2.stream_id);
    assert.equal(stop2.message, null, 'empty transmissions are discarded');

    // Late joiner C sees the history and can fetch the packets over HTTP
    const c = client(srv.port); await c.open;
    const jc = await c.cmd({ cmd: 'join', channel: 'TEST01', name: 'Cui' });
    assert.equal(jc.history.length, 1);
    const id = jc.history[0].id;
    const res = await fetch(`http://localhost:${srv.port}/api/messages/${id}/packets`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-codec'), /^opus;sr=48000;ch=1;frame_ms=20$/);
    const buf = Buffer.from(await res.arrayBuffer());
    let o = 0, n = 0;
    while (o < buf.length) { const len = buf.readUInt16BE(o); o += 2 + len; n++; }
    assert.equal(n, 10);
    const list = await (await fetch(`http://localhost:${srv.port}/api/channels/test01/messages`)).json();
    assert.equal(list.messages.length, 1);

    // device registration + background presence are accepted
    const reg = await b.cmd({ cmd: 'register_device', platform: 'ios', token: 'ab'.repeat(32), name: 'Bo' });
    assert.equal(reg.ok, true);
    b.ws.send(JSON.stringify({ cmd: 'presence', state: 'background' }));
    const mem = await a.wait((e) => e.event === 'members' && e.members.some((m) => m.name === 'Bo' && m.background));
    assert.ok(mem);

    a.close(); b.close(); c.close();
  } finally {
    await srv.close();
  }
});

test('messages survive a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skitalk-'));
  let srv = await createServer({ port: 0, dataDir, log: () => {} });
  const a = client(srv.port); await a.open;
  await a.cmd({ cmd: 'join', channel: 'KEEP', name: 'A' });
  const st = await a.cmd({ cmd: 'start' });
  a.ws.send(pkt(st.stream_id, Buffer.from([1, 2, 3])));
  await new Promise((r) => setTimeout(r, 50));
  a.ws.send(JSON.stringify({ cmd: 'stop', stream_id: st.stream_id }));
  await a.wait((e) => e.event === 'on_stop');
  a.close();
  await srv.close();

  srv = await createServer({ port: 0, dataDir, log: () => {} });
  try {
    const list = await (await fetch(`http://localhost:${srv.port}/api/channels/KEEP/messages`)).json();
    assert.equal(list.messages.length, 1);
    assert.equal(list.messages[0].packets, 1);
  } finally { await srv.close(); }
});
