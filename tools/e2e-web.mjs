// End-to-end test: two headless Chromium pages talk through the relay.
// Chromium's fake microphone produces a tone, so real Opus packets flow.
// Run: node tools/e2e-web.mjs
import { createServer } from '../server/src/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// playwright may be installed globally (e.g. /opt/node-tools) rather than locally
const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skitalk-e2e-'));
const srv = await createServer({ port: 0, dataDir, log: () => {} });
const base = `http://localhost:${srv.port}`;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chromium', dumpio: Boolean(process.env.PW_DUMPIO), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const failures = [];
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg); };

async function page(name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  p.on('crash', () => console.log(`[${name}] PAGE CRASHED`));
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console]`, m.text()); });
  ctx.on('close', () => console.log(`[${name}] context closed`));
  await p.goto(`${base}/?ch=E2E01&name=${name}&autojoin=1`);
  await p.waitForFunction(() => document.getElementById('conn').classList.contains('on'), null, { timeout: 10000 });
  return p;
}
const stats = (p) => p.evaluate(() => ({ ...window.__ptt }));

try {
  const a = await page('Anna');
  const b = await page('Bo');
  await a.waitForFunction(() => document.getElementById('members').textContent.includes('Bo'));
  check(true, 'both clients joined channel E2E01');

  // Anna holds the button for ~1.5 s
  const btn = await a.$('#ptt');
  const box = await btn.boundingBox();
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.mouse.down();
  // 'tx' is only entered once the microphone is open, so the 1.5 s below is all captured audio
  await a.waitForFunction(() => window.__ptt.state === 'tx' && window.__ptt.micReady, null, { timeout: 10000 });
  check(true, 'Anna took the floor with the mic ready (state=tx, micReady)');

  // Bo is blocked while Anna talks
  await b.waitForFunction(() => window.__ptt.state === 'rx', null, { timeout: 5000 });
  check(true, 'Bo sees incoming stream (state=rx)');
  await a.waitForTimeout(1500);
  await a.mouse.up();
  await a.waitForFunction(() => window.__ptt.state === 'idle', null, { timeout: 5000 });
  await b.waitForFunction(() => window.__ptt.state === 'idle', null, { timeout: 5000 });

  const sa = await stats(a), sb = await stats(b);
  console.log('Anna', sa); console.log('Bo', sb);
  check(sa.sentPackets >= 15, `Anna sent ${sa.sentPackets} Opus packets (>=15 expected for 1.5 s @ 60 ms)`);
  check(sb.receivedPackets >= 15 && sb.receivedPackets <= sa.sentPackets, `Bo received ${sb.receivedPackets} packets`);
  check(sb.decodedSamples >= 15 * 2880, `Bo decoded ${sb.decodedSamples} PCM samples`);
  check(!sa.lastError && !sb.lastError, `no codec errors (${sa.lastError || ''}${sb.lastError || ''})`);
  const hist = await b.$$eval('#history li', (els) => els.map((e) => e.textContent));
  check(hist.length === 1 && hist[0].includes('Anna'), `Bo's history lists Anna's message: ${hist[0]}`);

  // Floor control: both press; only one gets the floor
  await a.mouse.down();
  await a.waitForFunction(() => window.__ptt.state === 'tx');
  const bbtn = await b.$('#ptt'); const bb = await bbtn.boundingBox();
  await b.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await b.mouse.down();
  await b.waitForTimeout(400);
  const busyText = await b.$eval('#status', (e) => e.textContent);
  check(/占线/.test(busyText), `Bo is told the channel is busy: "${busyText}"`);
  await b.mouse.up(); await a.mouse.up();
  await a.waitForFunction(() => window.__ptt.state === 'idle');

  // Late joiner replays from history (store-and-forward over HTTP)
  const c = await page('Cui');
  const n = await c.$$eval('#history li', (els) => els.length);
  check(n === 2, `late joiner sees ${n} stored messages`);
  await c.click('#talk summary');            // history list lives in a collapsed <details>
  await c.click('#history li:first-child');  // oldest = Anna's 1.5 s message
  await c.waitForFunction(() => window.__ptt.playedMessages >= 1 && window.__ptt.decodedSamples > 0, null, { timeout: 5000 });
  const sc = await stats(c);
  check(sc.decodedSamples >= 15 * 2880, `late joiner decoded ${sc.decodedSamples} samples from stored message`);

  // Watch path: a whole recording is uploaded; online clients fetch and auto-play it
  const { execFileSync } = await import('node:child_process');
  let haveFfmpeg = true; try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { haveFfmpeg = false; }
  if (haveFfmpeg) {
    const m4a = path.join(dataDir, 'watch.m4a');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-ar', '16000', '-ac', '1', '-c:a', 'aac', m4a]);
    const before = (await stats(b)).playedMessages;
    const up = await fetch(`${base}/api/channels/E2E01/upload`, { method: 'POST', headers: { 'content-type': 'audio/mp4', 'x-from': 'Watch' }, body: fs.readFileSync(m4a) });
    check(up.status === 200, `watch upload accepted (${up.status})`);
    await b.waitForFunction((n) => window.__ptt.playedMessages > n, before, { timeout: 8000 });
    const sb2 = await stats(b);
    check(sb2.playedMessages === before + 1, `Bo auto-played the uploaded message (played=${sb2.playedMessages})`);
    const hist2 = await b.$$eval('#history li', (els) => els.map((e) => e.textContent));
    check(hist2[0].startsWith('Watch'), `upload is first in Bo's history: ${hist2[0]}`);
  } else {
    console.log('skip upload test: ffmpeg not installed');
  }

  // Offline queue: Dan loses the network, holds the button anyway, gets it back; the recording is
  // uploaded whole and Bo hears it like any other message.
  const dctx = await browser.newContext({ permissions: ['microphone'] });
  const d = await dctx.newPage();
  d.on('pageerror', (e) => console.log('[Dan pageerror]', e.message));
  await d.goto(`${base}/?ch=E2E01&name=Dan&autojoin=1`);
  await d.waitForFunction(() => document.getElementById('conn').classList.contains('on') && window.__ptt.micReady, null, { timeout: 10000 });
  await dctx.setOffline(true);
  await d.waitForFunction(() => !document.getElementById('conn').classList.contains('on'), null, { timeout: 10000 });
  check(true, 'Dan went offline (relay connection dropped)');
  const dbtn = await d.$('#ptt'); const db = await dbtn.boundingBox();
  await d.mouse.move(db.x + db.width / 2, db.y + db.height / 2); await d.mouse.down();
  await d.waitForFunction(() => window.__ptt.state === 'tx', null, { timeout: 5000 });
  const offlineStatus = await d.$eval('#status', (e) => e.textContent);
  check(/离线/.test(offlineStatus), `Dan is told he is recording offline: "${offlineStatus}"`);
  await d.waitForTimeout(1200);
  await d.mouse.up();
  await d.waitForFunction(() => window.__ptt.queued === 1, null, { timeout: 5000 });
  check(true, 'the offline recording is queued in the outbox');
  const beforeDan = (await stats(b)).playedMessages;
  await dctx.setOffline(false);
  await d.waitForFunction(() => window.__ptt.uploaded === 1 && window.__ptt.queued === 0, null, { timeout: 15000 });
  check(true, 'Dan reconnected and the queued recording was uploaded');
  await b.waitForFunction((n) => window.__ptt.playedMessages > n, beforeDan, { timeout: 8000 });
  const histDan = await b.$$eval('#history li', (els) => els.map((e) => e.textContent));
  check(histDan[0].startsWith('Dan'), `Bo auto-played Dan's offline recording: ${histDan[0]}`);
  const danMeta = (await (await fetch(`${base}/api/channels/E2E01/messages`)).json()).messages.find((m) => m.from.name === 'Dan');
  check(danMeta && danMeta.packets >= 15, `Dan's upload holds ${danMeta?.packets} packets (>=15 for 1.2 s @ 60 ms)`);
} catch (e) {
  console.log('FAIL exception', e);
  failures.push(String(e));
} finally {
  await browser.close();
  await srv.close();
}
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
