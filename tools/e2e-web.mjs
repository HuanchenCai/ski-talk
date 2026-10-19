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
  await a.waitForFunction(() => window.__ptt.state === 'tx', null, { timeout: 5000 });
  check(true, 'Anna took the floor (state=tx)');

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
} catch (e) {
  console.log('FAIL exception', e);
  failures.push(String(e));
} finally {
  await browser.close();
  await srv.close();
}
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
