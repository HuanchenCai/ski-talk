import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { oggOpusPackets } from '../src/transcode.js';

const haveFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('ogg demuxer skips the two header packets', () => {
  // one page, three packets: "OpusHead", "OpusTags", "audio"
  const seg = (b) => Buffer.from(b);
  const pk = [seg(Buffer.from('OpusHead')), seg(Buffer.from('OpusTags')), seg(Buffer.from([0xf8, 1, 2, 3]))];
  const head = Buffer.alloc(27); head.write('OggS', 0, 'latin1'); head[26] = pk.length;
  const table = Buffer.from(pk.map((p) => p.length));
  const page = Buffer.concat([head, table, ...pk]);
  const out = oggOpusPackets(page);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0]], [0xf8, 1, 2, 3]);
});

test('watch-style upload is transcoded, stored, broadcast and fetchable', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skitalk-up-'));
  // 2 s 440 Hz tone as AAC in an .m4a container, like AVAudioRecorder produces
  const m4a = path.join(dataDir, 'in.m4a');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', '-c:a', 'aac', '-b:a', '32k', m4a]);
  const srv = await createServer({ port: 0, dataDir, log: () => {} });
  try {
    // a live listener should be told about the new message
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const events = [];
    ws.on('message', (d, bin) => { if (!bin) events.push(JSON.parse(d.toString())); });
    ws.send(JSON.stringify({ seq: 1, cmd: 'join', channel: 'WATCH1', name: 'Bo' }));
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${srv.port}/api/channels/watch1/upload`, {
      method: 'POST', headers: { 'content-type': 'audio/mp4', 'x-from': encodeURIComponent('Huanchen ⌚') }, body: fs.readFileSync(m4a),
    });
    assert.equal(res.status, 200);
    const meta = await res.json();
    assert.equal(meta.from.name, 'Huanchen ⌚');
    assert.equal(meta.codec.frame_ms, 20);
    assert.ok(meta.packets >= 95 && meta.packets <= 105, `2 s @ 20 ms ≈ 100 packets, got ${meta.packets}`);
    assert.ok(meta.duration_ms >= 1900 && meta.duration_ms <= 2100);

    await new Promise((r) => setTimeout(r, 100));
    const ev = events.find((e) => e.event === 'on_message');
    assert.ok(ev, 'live listener received on_message');
    assert.equal(ev.message.id, meta.id);

    const pk = await fetch(`http://localhost:${srv.port}/api/messages/${meta.id}/packets`);
    assert.equal(pk.status, 200);
    const buf = Buffer.from(await pk.arrayBuffer());
    let o = 0, n = 0; while (o < buf.length) { o += 2 + buf.readUInt16BE(o); n++; }
    assert.equal(n, meta.packets);
    // every stored packet must be a valid Opus packet: TOC byte config for 20 ms SILK/hybrid/CELT
    assert.ok(buf.readUInt16BE(0) > 0);

    const bad = await fetch(`http://localhost:${srv.port}/api/channels/watch1/upload`, { method: 'POST', body: Buffer.from('not audio') });
    assert.equal(bad.status, 415);
    ws.close();
  } finally { await srv.close(); }
});

test('pre-encoded packet upload (offline queue) is stored without ffmpeg, deduped, and refused while busy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skitalk-pk-'));
  const srv = await createServer({ port: 0, dataDir, log: () => {} });
  const base = `http://localhost:${srv.port}`;
  // three fake 60 ms Opus packets in our own framing: [u16 BE len][packet]…
  const pk = [Buffer.from([0xf8, 1, 2, 3]), Buffer.from([0xf8, 4, 5]), Buffer.from([0xf8, 6, 7, 8, 9])];
  const body = Buffer.concat(pk.map((p) => Buffer.concat([Buffer.from([p.length >> 8, p.length & 255]), p])));
  const headers = { 'content-type': 'application/x-skitalk-packets', 'x-codec': 'opus;sr=48000;ch=1;frame_ms=60', 'x-from': encodeURIComponent('Dan'), 'x-ts': String(Date.now() - 60_000), 'x-client-id': 'q-1' };
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const events = [];
    ws.on('message', (d, bin) => { if (!bin) events.push(JSON.parse(d.toString())); });
    ws.send(JSON.stringify({ seq: 1, cmd: 'join', channel: 'QUEUE1', name: 'Bo' }));
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`${base}/api/channels/queue1/upload`, { method: 'POST', headers, body });
    assert.equal(res.status, 200);
    const meta = await res.json();
    assert.equal(meta.from.name, 'Dan');
    assert.equal(meta.packets, 3);
    assert.equal(meta.duration_ms, 180);
    assert.deepEqual(meta.codec, { name: 'opus', sample_rate: 48000, channels: 1, frame_ms: 60 });
    assert.ok(meta.ts < Date.now() - 50_000, 'x-ts is kept as the message time');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.some((e) => e.event === 'on_message' && e.message.id === meta.id), 'live listener told about it');

    // the stored packets are byte-identical
    const got = Buffer.from(await (await fetch(`${base}/api/messages/${meta.id}/packets`)).arrayBuffer());
    assert.deepEqual(got, body);

    // a retry with the same client id (lost response) does not duplicate
    const again = await (await fetch(`${base}/api/channels/queue1/upload`, { method: 'POST', headers, body })).json();
    assert.equal(again.id, meta.id);
    const list = await (await fetch(`${base}/api/channels/queue1/messages`)).json();
    assert.equal(list.messages.length, 1);

    // bad codec header / empty packet list are rejected
    assert.equal((await fetch(`${base}/api/channels/queue1/upload`, { method: 'POST', headers: { ...headers, 'x-codec': 'mp3', 'x-client-id': 'q-2' }, body })).status, 400);
    assert.equal((await fetch(`${base}/api/channels/queue1/upload`, { method: 'POST', headers: { ...headers, 'x-client-id': 'q-3' }, body: Buffer.from([0, 0]) })).status, 400);

    // while someone holds the floor the upload is refused with 409 (the client retries later)
    ws.send(JSON.stringify({ seq: 2, cmd: 'start', codec: { sample_rate: 48000, frame_ms: 20 } }));
    await new Promise((r) => setTimeout(r, 100));
    const busy = await fetch(`${base}/api/channels/queue1/upload`, { method: 'POST', headers: { ...headers, 'x-client-id': 'q-4' }, body });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).from, 'Bo');
    ws.close();
  } finally {
    await srv.close();
  }
});
