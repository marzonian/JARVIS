'use strict';
/**
 * ADB-based Android notification push.
 *
 * Discovered 2026-05-17: the Morse Android app receives proactive_msg over
 * WebSocket and adds it to the in-app chat, but does NOT call
 * notificationManager.notify() to post a system notification. So Web Push
 * (morse-push.js) lands in the chat but never as a banner / lock-screen
 * notification.
 *
 * Workaround that works today: JARVIS shells out to `adb shell cmd
 * notification post` on the local Mac. ADB has a wireless connection to
 * the phone at 192.168.1.12:5555. This delivers real Android system
 * notifications that show in the status bar + notification shade.
 *
 * Limitations vs proper Web Push:
 *   - Requires the phone to be on the LAN with ADB-over-Wi-Fi enabled
 *   - Requires ADB to remain authorized (occasional reauth needed)
 *   - Notification appears under "shell_cmd" channel, not a Morse-styled
 *     channel. Cosmetic only.
 *
 * Long-term fix is to add NotificationCompat.Builder calls in
 * ListeningService.kt (proactive_msg handler). Until then, this is the
 * pragmatic bridge.
 *
 * All failures swallowed — push is augmentation, not blocking.
 */

const { exec } = require('child_process');

const ADB_PATH = process.env.JARVIS_ADB_PATH || '/opt/homebrew/bin/adb';
const ADB_DEVICE = process.env.JARVIS_ADB_DEVICE || '192.168.1.12:5555';
const ADB_TIMEOUT_MS = Math.max(1000, Math.min(15_000, parseInt(process.env.JARVIS_ADB_TIMEOUT_MS || '5000', 10)));

function shellEscape(s) {
  // Wrap in single quotes and escape any internal single quotes.
  return `'${String(s || '').replace(/'/g, `'\\''`)}'`;
}

function runAdb(argsString, timeoutMs = ADB_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const cmd = `${ADB_PATH} -s ${ADB_DEVICE} ${argsString}`;
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        error: err ? String(err.message || err) : null,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

/**
 * Post an Android system notification via ADB.
 *
 * @param {Object} params
 * @param {string} params.title       Notification title (lock-screen visible).
 * @param {string} params.body        Notification body text.
 * @param {string} [params.tag]       Notification tag — same tag replaces
 *                                    previous; different tag = new entry.
 *                                    Default 'jarvis_default'.
 * @param {boolean} [params.bigtext]  If true, body shown in expanded
 *                                    NotificationCompat.BigTextStyle.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function adbPushNotification({ title, body, tag = 'jarvis_default', bigtext = true } = {}) {
  if (!title || !body) return { ok: false, error: 'missing_title_or_body' };
  const flag = bigtext ? '-S bigtext ' : '';
  const cmd = `shell cmd notification post ${flag}-t ${shellEscape(title)} ${shellEscape(tag)} ${shellEscape(body)}`;
  const result = await runAdb(cmd);
  return { ok: result.ok && !/error/i.test(result.stderr), error: result.error, stderr: result.stderr };
}

/**
 * Cancel a previously-posted notification by tag.
 */
async function adbCancelNotification(tag) {
  if (!tag) return { ok: false, error: 'missing_tag' };
  return await runAdb(`shell cmd notification cancel ${shellEscape(tag)}`);
}

/**
 * Health check — is the phone reachable via ADB right now?
 */
async function adbHealthCheck() {
  const r = await runAdb('shell echo ok', 2500);
  return { ok: r.ok && r.stdout === 'ok', device: ADB_DEVICE, error: r.error };
}

module.exports = { adbPushNotification, adbCancelNotification, adbHealthCheck, ADB_DEVICE };
