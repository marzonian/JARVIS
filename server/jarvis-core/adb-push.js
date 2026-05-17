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

const { spawn } = require('child_process');

const ADB_PATH = process.env.JARVIS_ADB_PATH || '/opt/homebrew/bin/adb';
const ADB_DEVICE = process.env.JARVIS_ADB_DEVICE || '192.168.1.12:5555';
const ADB_TIMEOUT_MS = Math.max(1000, Math.min(15_000, parseInt(process.env.JARVIS_ADB_TIMEOUT_MS || '5000', 10)));

/**
 * Sanitize a string for ADB arg transport. Even with spawn (no Mac shell),
 * ADB joins args with spaces and re-parses on Android, so we still need to
 * remove shell-meaningful chars from the inner content.
 */
function sanitizeForAdbArg(s) {
  // ADB strips outer quoting and Android sh re-parses, so any sh-meaningful
  // chars in args get mis-interpreted as operators. Replace them with
  // Unicode equivalents that LOOK the same but carry no shell meaning.
  return String(s || '')
    .replace(/'/g, '’')        // apostrophe → typographic right single quote
    .replace(/"/g, '”')        // double quote → typographic
    .replace(/`/g, '‘')        // backtick → typographic left single quote
    .replace(/\$/g, '＄')       // dollar → fullwidth (U+FF04) so Android sh won't var-expand
    .replace(/\|/g, '∣')       // pipe → divides sign (U+2223)
    .replace(/&/g, '＆')        // ampersand → fullwidth (U+FF06)
    .replace(/;/g, '；')        // semicolon → fullwidth (U+FF1B)
    .replace(/</g, '＜')        // < → fullwidth (U+FF1C)
    .replace(/>/g, '＞')        // > → fullwidth (U+FF1E)
    .replace(/\r/g, '')        // strip CR
    .replace(/\n/g, ' • ');    // newlines → bullet separator
}

/**
 * Run adb with arg array (no shell). Each arg goes through the spawn boundary
 * cleanly. ADB itself wraps each arg in single quotes when forwarding to the
 * Android shell, so spaces and pipes inside an arg are preserved as part of
 * that one arg.
 */
function runAdb(argv, timeoutMs = ADB_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const fullArgs = ['-s', ADB_DEVICE, ...argv];
    const child = spawn(ADB_PATH, fullArgs);
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !killed && code === 0,
        error: killed ? 'timeout' : (code !== 0 ? `exit_${code}` : null),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(err?.message || err), stdout, stderr });
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
  // ADB joins all spawn args with spaces before sending to Android, then
  // Android sh re-parses. To preserve spaces inside title/body, we have to
  // wrap each arg in literal double quotes that survive into Android sh.
  // After sanitize-for-adb-arg, no internal quotes remain, so wrapping is safe.
  const wrap = (s) => `"${sanitizeForAdbArg(s)}"`;
  const argv = ['shell', 'cmd', 'notification', 'post'];
  if (bigtext) argv.push('-S', 'bigtext');
  argv.push('-t', wrap(title));
  argv.push(wrap(tag));
  argv.push(wrap(body));
  const result = await runAdb(argv);
  return { ok: result.ok && !/error/i.test(result.stderr), error: result.error, stderr: result.stderr };
}

/**
 * Cancel a previously-posted notification by tag.
 */
async function adbCancelNotification(tag) {
  if (!tag) return { ok: false, error: 'missing_tag' };
  return await runAdb(['shell', 'cmd', 'notification', 'cancel', sanitizeForAdbArg(tag)]);
}

/**
 * Health check — is the phone reachable via ADB right now?
 */
async function adbHealthCheck() {
  const r = await runAdb(['shell', 'echo', 'ok'], 2500);
  return { ok: r.ok && r.stdout === 'ok', device: ADB_DEVICE, error: r.error };
}

module.exports = { adbPushNotification, adbCancelNotification, adbHealthCheck, ADB_DEVICE };
