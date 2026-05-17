'use strict';
/**
 * Morse (MVRSE) push notification client.
 *
 * Sends fire-and-forget push notifications to the Morse iOS PWA via the
 * MVRSE server's /api/push/test endpoint (which is a generic title+body
 * pusher despite the "test" name — it calls send_push_to_all internally).
 *
 * Discovery (2026-05-17):
 *   - MVRSE server listens at https://localhost:8443
 *   - HTTP 8732 redirects to HTTPS 8443
 *   - Self-signed cert in dev; Node fetch must accept it
 *   - VAPID public key available at /api/push/vapid_key (verified)
 *
 * Fail-soft: any error during push is logged and swallowed. Notifications
 * are augmentations, not requirements — JARVIS must never block on push.
 */

const https = require('https');

// Accept the MVRSE dev self-signed cert. Localhost only; not a security risk.
const MORSE_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

const MORSE_BASE_URL = process.env.MORSE_PUSH_BASE_URL || 'https://localhost:8443';
const MORSE_PUSH_PATH = process.env.MORSE_PUSH_PATH || '/api/push/test';
const MORSE_TIMEOUT_MS = Math.max(500, Math.min(15_000, parseInt(process.env.MORSE_PUSH_TIMEOUT_MS || '4000', 10)));

/**
 * Send a notification to all subscribed Morse devices.
 *
 * @param {Object} params
 * @param {string} params.title - Short title (lock-screen visible)
 * @param {string} params.body - Body text
 * @param {string} [params.kind] - 'briefing' | 'trade_open' | 'trade_close' | 'alert'
 * @param {string} [params.url] - Optional deep link in the app (e.g., '/jarvis/today')
 * @returns {Promise<{ok:boolean, subscriptions:number, error?:string}>}
 */
async function morsePush({ title, body, kind = 'jarvis', url = '/' } = {}) {
  if (!title || !body) {
    return { ok: false, error: 'missing_title_or_body' };
  }
  const payload = { title, body, kind, url };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MORSE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MORSE_BASE_URL}${MORSE_PUSH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // @ts-ignore — agent is supported in Node 18+ fetch via undici
      dispatcher: undefined,
      // Native node-fetch / undici doesn't support `agent` option directly;
      // use the lower-level https client when we hit cert issues. For now
      // localhost dev: rely on env NODE_TLS_REJECT_UNAUTHORIZED=0 or
      // an https.Agent passed via undici Dispatcher (Node 20+).
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, subscriptions: data.subscriptions || 0 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Lower-level push that uses the raw `https` module — works regardless of
 * Node fetch undici quirks around self-signed certs. We try fetch first
 * (cleaner), fall back to raw https on TLS errors.
 */
function morsePushRaw({ title, body, kind = 'jarvis', url = '/' } = {}) {
  return new Promise((resolve) => {
    if (!title || !body) return resolve({ ok: false, error: 'missing_title_or_body' });
    const payload = JSON.stringify({ title, body, kind, url });
    const u = new URL(`${MORSE_BASE_URL}${MORSE_PUSH_PATH}`);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      agent: MORSE_HTTPS_AGENT,
      timeout: MORSE_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, error: `http_${res.statusCode}`, body: data.slice(0, 200) });
        }
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: !!parsed.ok, subscriptions: parsed.subscriptions || 0 });
        } catch {
          resolve({ ok: true, subscriptions: 0 });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: String(err?.message || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

module.exports = { morsePush, morsePushRaw, MORSE_BASE_URL };
