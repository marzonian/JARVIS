'use strict';
/**
 * EXPRESS-V2 glance card — sticky lock-screen notification that shows
 * current EXPRESS-V2 position state. READ-ONLY. JARVIS does NOT trade
 * on this account (denylist + regex both enforce that).
 *
 * Refreshes every ~30s during RTH, every ~5min off-hours.
 * Uses ADB direct-post for the notification (Web Push works too but ADB
 * lets us update by tag to refresh the same notification cell, avoiding
 * notification spam in the shade).
 *
 * Architecture:
 *   1. Pull latest fills for EXPRESS-V2 from topstep_fills
 *   2. Derive current open position (entry + opposite-side close pair logic)
 *   3. Pull last close price from candle/quote cache for unrealized P&L
 *   4. Format as title + body
 *   5. Post via ADB with stable tag 'jarvis_express_glance' (replaces prior)
 *
 * Env:
 *   JARVIS_EXPRESS_GLANCE_ACCOUNT_ID  default 19108624 (EXPRESS-V2)
 *   JARVIS_EXPRESS_GLANCE_INTERVAL_SECONDS_RTH    default 30
 *   JARVIS_EXPRESS_GLANCE_INTERVAL_SECONDS_OFF    default 300
 *   JARVIS_EXPRESS_GLANCE_ENABLED   default false (opt-in)
 */

const { adbPushNotification } = require('./adb-push');

const EXPRESS_ACCOUNT_ID = String(process.env.JARVIS_EXPRESS_GLANCE_ACCOUNT_ID || '19108624');
const ENABLED = String(process.env.JARVIS_EXPRESS_GLANCE_ENABLED || 'false').toLowerCase() === 'true';
const INTERVAL_RTH = Math.max(15, parseInt(process.env.JARVIS_EXPRESS_GLANCE_INTERVAL_SECONDS_RTH || '30', 10));
const INTERVAL_OFF = Math.max(60, parseInt(process.env.JARVIS_EXPRESS_GLANCE_INTERVAL_SECONDS_OFF || '300', 10));
const TAG = 'jarvis_express_glance';

/**
 * Derive current open position from fills.
 * Topstep semantics: side='long' = BUY action, side='short' = SELL action.
 * Net qty across fills tells us open position direction + size.
 */
function deriveOpenPosition(fills) {
  let netQty = 0;       // positive = long, negative = short
  let lastEntryPrice = null;
  let lastFillTime = null;
  let totalRealized = 0;
  for (const f of fills) {
    const q = Number(f.qty || 0);
    const sign = f.side === 'long' ? +1 : (f.side === 'short' ? -1 : 0);
    netQty += sign * q;
    if (Number(f.realized_pnl || 0) === 0 && lastEntryPrice === null) {
      lastEntryPrice = Number(f.price);
      lastFillTime = String(f.fill_time);
    }
    totalRealized += Number(f.realized_pnl || 0);
  }
  return {
    netQty,
    direction: netQty > 0 ? 'long' : (netQty < 0 ? 'short' : 'flat'),
    qty: Math.abs(netQty),
    lastEntryPrice,
    lastFillTime,
    totalRealizedToday: Math.round(totalRealized * 100) / 100,
  };
}

/**
 * Build the notification title + body for the current EXPRESS-V2 state.
 * Format optimized for lock-screen glance — title fits in one row, body
 * uses BigTextStyle for expanded view.
 */
function formatGlanceCard(accountId, fillsToday, accountBalance, latestQuote) {
  const pos = deriveOpenPosition(fillsToday);
  const balanceStr = Number.isFinite(accountBalance) ? `$${Math.round(accountBalance).toLocaleString()}` : '—';
  const dayPnl = pos.totalRealizedToday;
  const dayPnlStr = `${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)}`;
  let title, body;

  // Title: short — Samsung cuts off after ~30 chars due to timestamp on right
  // Body: single line with • separators — renders cleanly without newline issues
  if (pos.direction === 'flat') {
    title = `EXPRESS-V2 FLAT ${dayPnlStr}`;
    const lastFillStr = pos.lastFillTime ? String(pos.lastFillTime).slice(11, 16) : '—';
    body = `Bal ${balanceStr} | Realized ${dayPnlStr} | Last fill ${lastFillStr} ET${latestQuote ? ` | MNQ ${latestQuote}` : ''}`;
  } else {
    const dir = pos.direction.toUpperCase();
    const entry = pos.lastEntryPrice ? pos.lastEntryPrice : '?';
    let unrealizedStr = '';
    if (latestQuote && pos.lastEntryPrice) {
      const pts = (latestQuote - pos.lastEntryPrice) * (pos.direction === 'long' ? 1 : -1);
      const unr = pts * 2 * pos.qty;
      unrealizedStr = ` ${unr >= 0 ? '+' : ''}$${unr.toFixed(0)}`;
    }
    title = `EXPRESS-V2 ${dir} ${pos.qty}@${entry}${unrealizedStr}`;
    body = `${dir} ${pos.qty}x | Entry ${entry}${latestQuote ? ` | Now ${latestQuote}` : ''} | Day ${dayPnlStr} | Bal ${balanceStr}`;
  }
  return { title, body };
}

/**
 * Read EXPRESS-V2 state from DB + push to phone.
 * Returns the card that was posted (for logging / debugging).
 */
async function pushExpressGlance(db, options = {}) {
  if (!ENABLED && !options.force) return { ok: false, reason: 'disabled_via_env' };
  const today = new Date().toISOString().slice(0, 10);
  const fillsToday = db.prepare(`
    SELECT * FROM topstep_fills
    WHERE account_id = ? AND substr(fill_time, 1, 10) = ?
    ORDER BY fill_time ASC
  `).all(EXPRESS_ACCOUNT_ID, today);

  // Latest quote cache lookup — JARVIS already caches MNQ quotes from the bar feed.
  // For now, pull the last 5m close as a proxy.
  let latestQuote = null;
  try {
    const lastBar = db.prepare(`
      SELECT close FROM candles c JOIN sessions s ON s.id = c.session_id
      WHERE c.timeframe = '5m' AND s.date >= date('now', '-1 day')
      ORDER BY c.timestamp DESC LIMIT 1
    `).get();
    if (lastBar && Number.isFinite(Number(lastBar.close))) latestQuote = Number(lastBar.close);
  } catch {}

  // Account balance from latest topstep_account_daily_snapshot
  let accountBalance = null;
  try {
    const acc = db.prepare(`
      SELECT balance FROM topstep_account_daily_snapshot
      WHERE account_id = ? ORDER BY snapshot_date DESC LIMIT 1
    `).get(EXPRESS_ACCOUNT_ID);
    if (acc && Number.isFinite(Number(acc.balance))) accountBalance = Number(acc.balance);
  } catch {}

  const card = formatGlanceCard(EXPRESS_ACCOUNT_ID, fillsToday, accountBalance, latestQuote);

  const result = await adbPushNotification({
    title: card.title,
    body: card.body,
    tag: TAG,
    bigtext: true,
  });
  return { ok: result.ok, error: result.error || null, card, fillsCount: fillsToday.length };
}

/**
 * Is the current ET time inside RTH (9:30 AM - 4:00 PM ET)?
 * Used to pick refresh cadence — fast during RTH, slow off-hours.
 */
function isRthNowEt() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
    weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const h = parseInt(get('hour'), 10);
  const m = parseInt(get('minute'), 10);
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960;  // 9:30 AM - 4:00 PM ET
}

module.exports = {
  pushExpressGlance,
  isRthNowEt,
  INTERVAL_RTH,
  INTERVAL_OFF,
  ENABLED,
  EXPRESS_ACCOUNT_ID,
  TAG,
};
