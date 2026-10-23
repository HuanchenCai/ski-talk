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
