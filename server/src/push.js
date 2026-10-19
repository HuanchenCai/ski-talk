// Wake-up pushes for clients that are asleep (no WebSocket).
//
// iOS: an APNs "pushtotalk" push wakes the app for a few seconds; the app then
// fetches the message over HTTP and plays it through the PushToTalk framework.
// This is the same mechanism Zello uses on iOS 16+.
//
// Configure with env vars (all required for APNs to be active):
//   APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY (PEM contents or path to .p8),
//   APNS_BUNDLE_ID (e.g. com.example.skiptt), APNS_SANDBOX=1 for dev builds.
// Without them, pushes are logged and dropped, which is fine for web-only testing.

import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';

export class Pusher {
  constructor(env = process.env) {
    this.teamId = env.APNS_TEAM_ID;
    this.keyId = env.APNS_KEY_ID;
    this.bundleId = env.APNS_BUNDLE_ID;
    this.host = env.APNS_SANDBOX ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    let key = env.APNS_KEY;
    if (key && !key.includes('BEGIN') && fs.existsSync(key)) key = fs.readFileSync(key, 'utf8');
    this.key = key;
    this.enabled = Boolean(this.teamId && this.keyId && this.bundleId && this.key);
    this._jwt = null; this._jwtAt = 0;
    this._session = null;
  }

  // APNs provider token (ES256 JWT), refreshed every 50 minutes.
  _token() {
    const now = Math.floor(Date.now() / 1000);
    if (this._jwt && now - this._jwtAt < 50 * 60) return this._jwt;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: this.keyId })}.${b64({ iss: this.teamId, iat: now })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: this.key, dsaEncoding: 'ieee-p1363' });
    this._jwt = `${unsigned}.${sig.toString('base64url')}`;
    this._jwtAt = now;
    return this._jwt;
  }

  _conn() {
    if (this._session && !this._session.closed && !this._session.destroyed) return this._session;
    this._session = http2.connect(this.host);
    this._session.on('error', () => { this._session = null; });
    return this._session;
  }

  /**
   * Send a PTT push. `device` = { platform:'ios', token:'<hex ptt token>' }.
   * Payload is what the iOS app needs to fetch and play: message id, sender, channel.
   */
  async pttPush(device, payload) {
    if (device.platform !== 'ios') return { ok: false, reason: 'unsupported platform' };
    if (!this.enabled) { console.log('[push] (disabled) would push', device.token.slice(0, 8), payload); return { ok: false, reason: 'apns not configured' }; }
    const body = JSON.stringify({ aps: {}, ...payload });
    return new Promise((resolve) => {
      const req = this._conn().request({
        ':method': 'POST',
        ':path': `/3/device/${device.token}`,
        'authorization': `bearer ${this._token()}`,
        'apns-push-type': 'pushtotalk',
        'apns-topic': `${this.bundleId}.voip-ptt`,
        'apns-priority': '10',
        'apns-expiration': '0',
        'content-type': 'application/json',
      });
      let status = 0; let data = '';
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (c) => { data += c; });
      req.on('end', () => resolve({ ok: status === 200, status, data }));
      req.on('error', (e) => resolve({ ok: false, reason: e.message }));
      req.end(body);
    });
  }
}
