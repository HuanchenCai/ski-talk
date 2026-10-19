// Store-and-forward message store.
// Every finished transmission becomes a "message": metadata + the raw Opus packets.
// Messages are kept in memory and mirrored to disk so a restart does not lose
// the last 24 h of traffic. Receivers that were asleep fetch them by id.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_CHANNEL = 200;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    /** @type {Map<string, {code:string, created:number, seq:number, messages: Map<string, Msg>}>} */
    this.channels = new Map();
    this.nextId = 1;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  async load() {
    const files = await fsp.readdir(this.dataDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dataDir, f), 'utf8'));
        if (Date.now() - meta.ts > TTL_MS) { await this._unlink(meta.id); continue; }
        const pk = await fsp.readFile(path.join(this.dataDir, meta.id + '.pkts'));
        const msg = { ...meta, packets: unframe(pk), complete: true };
        this.channel(meta.channel).messages.set(meta.id, msg);
        const n = Number(meta.id.split('-')[1]);
        if (n >= this.nextId) this.nextId = n + 1;
        if (meta.seq >= this.channel(meta.channel).seq) this.channel(meta.channel).seq = meta.seq;
      } catch { /* corrupt file: ignore */ }
    }
  }

  channel(code) {
    code = normalizeCode(code);
    let ch = this.channels.get(code);
    if (!ch) {
      ch = { code, created: Date.now(), seq: 0, messages: new Map() };
      this.channels.set(code, ch);
    }
    return ch;
  }

  /** Start a message; packets are appended while the sender holds the button. */
  begin(code, from, codec) {
    const ch = this.channel(code);
    const id = `m-${this.nextId++}`;
    const msg = {
      id, channel: ch.code, from, codec,
      ts: Date.now(), seq: ++ch.seq, duration_ms: 0, packets: [], complete: false,
    };
    ch.messages.set(id, msg);
    return msg;
  }

  append(msg, packet) {
    msg.packets.push(packet);
  }

  async finish(msg, duration_ms) {
    msg.complete = true;
    msg.duration_ms = duration_ms;
    this._trim(this.channel(msg.channel));
    await this._persist(msg);
    return msg;
  }

  /** Drop an aborted/empty transmission. */
  discard(msg) {
    this.channel(msg.channel).messages.delete(msg.id);
  }

  get(id) {
    for (const ch of this.channels.values()) {
      const m = ch.messages.get(id);
      if (m) return m;
    }
    return null;
  }

  /** Messages in a channel newer than `afterSeq`, oldest first. */
  list(code, afterSeq = 0, limit = 50) {
    const ch = this.channel(code);
    return [...ch.messages.values()]
      .filter((m) => m.complete && m.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(-limit)
      .map(publicMeta);
  }

  sweep() {
    const cutoff = Date.now() - TTL_MS;
    for (const ch of this.channels.values()) {
      for (const [id, m] of ch.messages) {
        if (m.ts < cutoff) { ch.messages.delete(id); this._unlink(id); }
      }
    }
  }

  _trim(ch) {
    if (ch.messages.size <= MAX_PER_CHANNEL) return;
    const sorted = [...ch.messages.values()].sort((a, b) => a.seq - b.seq);
    for (const m of sorted.slice(0, ch.messages.size - MAX_PER_CHANNEL)) {
      ch.messages.delete(m.id); this._unlink(m.id);
    }
  }

  async _persist(msg) {
    const meta = publicMeta(msg);
    await fsp.writeFile(path.join(this.dataDir, msg.id + '.pkts'), frame(msg.packets));
    await fsp.writeFile(path.join(this.dataDir, msg.id + '.json'), JSON.stringify(meta));
  }

  async _unlink(id) {
    await fsp.rm(path.join(this.dataDir, id + '.json'), { force: true });
    await fsp.rm(path.join(this.dataDir, id + '.pkts'), { force: true });
  }
}

export function publicMeta(m) {
  return {
    id: m.id, channel: m.channel, from: m.from, codec: m.codec,
    ts: m.ts, seq: m.seq, duration_ms: m.duration_ms, packets: m.packets.length,
  };
}

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/**
 * On-disk / HTTP framing for a packet list: repeated [u16 BE length][opus packet].
 * Simple enough for Swift, JS and curl.
 */
export function frame(packets) {
  const total = packets.reduce((n, p) => n + 2 + p.length, 0);
  const out = Buffer.alloc(total);
  let o = 0;
  for (const p of packets) { out.writeUInt16BE(p.length, o); o += 2; p.copy(out, o); o += p.length; }
  return out;
}

export function unframe(buf) {
  const packets = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const len = buf.readUInt16BE(o); o += 2;
    packets.push(Buffer.from(buf.subarray(o, o + len))); o += len;
  }
  return packets;
}
