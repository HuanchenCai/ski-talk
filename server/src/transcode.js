// Turn an uploaded recording (AAC/M4A from the watch, or anything ffmpeg reads)
// into the same raw Opus packets the live path produces, so every client plays
// uploads and live messages the same way.
//
// ffmpeg → Ogg/Opus on stdout → tiny Ogg demuxer → [packet, packet, ...]

import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';

export function transcodeToOpusPackets(input, { frameMs = 20, bitrate = 16000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', String(bitrate),
      '-frame_duration', String(frameMs), '-application', 'voip', '-vbr', 'on',
      '-f', 'ogg', 'pipe:1'];
    const p = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
      try { resolve(oggOpusPackets(Buffer.concat(out))); } catch (e) { reject(e); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Extract Opus audio packets from an Ogg stream, skipping OpusHead/OpusTags. */
export function oggOpusPackets(buf) {
  const packets = [];
  let o = 0, partial = null, index = 0;
  while (o + 27 <= buf.length) {
    if (buf.toString('latin1', o, o + 4) !== 'OggS') throw new Error('bad ogg page');
    const nsegs = buf[o + 26];
    const segs = buf.subarray(o + 27, o + 27 + nsegs);
    let d = o + 27 + nsegs;
    for (const len of segs) {
      const chunk = buf.subarray(d, d + len); d += len;
      partial = partial ? Buffer.concat([partial, chunk]) : Buffer.from(chunk);
      if (len < 255) {                    // packet ends here
        if (index >= 2) packets.push(partial);   // 0 = OpusHead, 1 = OpusTags
        index++; partial = null;
      }
    }
    o = d;
  }
  return packets;
}
