#!/usr/bin/env node
/**
 * McNair Mindset by 3130
 * Standalone Databento DB seeder
 *
 * Step 1 — Fetches raw 1-minute bars from Databento API into jarvis_market_bars_raw
 * Step 2 — Bridges jarvis_market_bars_raw → sessions + candles tables
 *           (same logic as persistTopstepBarsIntoSessions in index.js, but
 *            driven from the raw bar store rather than a live Topstep snapshot)
 *
 * Usage:
 *   node scripts/seed-databento.js [--lookback <days>] [--symbol <sym>] [--force]
 *   node scripts/seed-databento.js --bridge-only          # skip fetch, only bridge
 *   node scripts/seed-databento.js --skip-bridge          # only fetch, do not bridge
 *
 * API key is read from macOS Keychain (3130_databento_api_key) or
 * DATABENTO_API_KEY env var.  No .env file required.
 */

'use strict';

const { execSync } = require('child_process');
const { getDB } = require('../server/db/database');
const { runDatabentoIngestion } = require('../server/jarvis-core/databento-ingestion');

// ─── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lookback'    && argv[i + 1]) { args.lookback    = Number(argv[++i]); }
    if (argv[i] === '--symbol'      && argv[i + 1]) { args.symbol      = argv[++i]; }
    if (argv[i] === '--force')                       { args.force       = true; }
    if (argv[i] === '--mode'        && argv[i + 1]) { args.mode        = argv[++i]; }
    if (argv[i] === '--bridge-only')                 { args.bridgeOnly  = true; }
    if (argv[i] === '--skip-bridge')                 { args.skipBridge  = true; }
  }
  return args;
}

// ─── Keychain ──────────────────────────────────────────────────────────────────

function readKeyFromKeychain(serviceName) {
  try {
    const user = process.env.USER || '';
    return execSync(
      `security find-generic-password -w -s "${serviceName}" -a "${user}" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim() || null;
  } catch {
    return null;
  }
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

const ET_TZ = 'America/New_York';

/** "YYYY-MM-DD" in ET for today */
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Given a UTC ISO timestamp string (any precision), return:
 *   { dateKey: "YYYY-MM-DD", hhmm: "HH:MM", localTs: "YYYY-MM-DD HH:MM" }
 * all in ET.  Returns null if invalid.
 */
function utcTsToET(rawTs) {
  if (!rawTs) return null;
  // Databento uses nanosecond precision ISO: "2026-01-15T15:00:00.000000000Z"
  // Date.parse can handle ISO 8601 but may choke on > 3 ms decimals — truncate.
  const s = String(rawTs).replace(/(\.\d{3})\d+Z$/, '$1Z').replace(' ', 'T');
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year:   'numeric', month:  '2-digit', day:    '2-digit',
    hour:   '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  const dateKey  = `${get('year')}-${get('month')}-${get('day')}`;
  const hhmm     = `${get('hour').replace('24', '00')}:${get('minute')}`;
  return { dateKey, hhmm, localTs: `${dateKey} ${hhmm}` };
}

// ─── 5-minute aggregation ─────────────────────────────────────────────────────

/**
 * Aggregate an array of 1-min candles { timestamp, open, high, low, close, volume }
 * into 5-minute candles anchored to 5-minute boundaries.
 * Each candle's timestamp is the start of its 5-minute bucket (ET local).
 */
function aggregateTo5m(candles1m) {
  const buckets = new Map(); // key: "YYYY-MM-DD HH:MM" of bucket start
  for (const c of candles1m) {
    const [datePart, timePart] = c.timestamp.split(' ');
    if (!datePart || !timePart) continue;
    const [hh, mm] = timePart.split(':').map(Number);
    const bucketMm = Math.floor(mm / 5) * 5;
    const bucketKey = `${datePart} ${String(hh).padStart(2, '0')}:${String(bucketMm).padStart(2, '0')}`;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        timestamp: bucketKey,
        open:  Number(c.open),
        high:  Number(c.open),
        low:   Number(c.open),
        close: Number(c.open),
        volume: 0,
      });
    }
    const b = buckets.get(bucketKey);
    b.high   = Math.max(b.high,   Number(c.high));
    b.low    = Math.min(b.low,    Number(c.low));
    b.close  = Number(c.close);
    b.volume = Number(b.volume) + Number(c.volume || 0);
  }
  return [...buckets.values()].sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp))
  );
}

// ─── Session/candle bridge ────────────────────────────────────────────────────

// Databento GLBX.MDP3 stores prices as fixed-point integers scaled by 1e9.
// Divide by DATABENTO_PRICE_SCALE to get actual futures price in points.
const DATABENTO_PRICE_SCALE = 1_000_000_000;

/**
 * Read all rows from jarvis_market_bars_raw for the primary symbol,
 * group by ET session date, and upsert into sessions + candles tables.
 *
 * Only one symbol at a time — the sessions table has no symbol column, so
 * mixing MNQ + MES bars would corrupt OHLCV data.
 *
 * Prices are divided by DATABENTO_PRICE_SCALE (10^9) to convert from
 * Databento's fixed-point representation to actual futures points.
 *
 * Mirrors persistTopstepBarsIntoSessions from index.js.
 */
function bridgeRawToSessions(db, primarySymbol = 'MNQ.c.0') {
  const rows = db.prepare(
    `SELECT ts_event, open, high, low, close, volume, symbol
     FROM jarvis_market_bars_raw
     WHERE symbol = ?
     ORDER BY ts_event ASC`
  ).all(primarySymbol);

  if (!rows.length) {
    console.log(`[bridge] No rows in jarvis_market_bars_raw for ${primarySymbol} — nothing to bridge`);
    return { sessionsTouched: 0, candles1m: 0, candles5m: 0 };
  }
  console.log(`  ${rows.length.toLocaleString()} raw bars for ${primarySymbol}`);

  // Group by ET session date
  const grouped = new Map(); // dateKey → candle[]
  let skipped = 0;
  for (const row of rows) {
    const et = utcTsToET(row.ts_event);
    if (!et) { skipped++; continue; }
    const { dateKey, localTs } = et;
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey).push({
      timestamp: localTs,
      open:   Number(row.open)   / DATABENTO_PRICE_SCALE,
      high:   Number(row.high)   / DATABENTO_PRICE_SCALE,
      low:    Number(row.low)    / DATABENTO_PRICE_SCALE,
      close:  Number(row.close)  / DATABENTO_PRICE_SCALE,
      volume: Number(row.volume  || 0),
    });
  }
  if (skipped) console.warn(`[bridge] Skipped ${skipped} rows with unparseable ts_event`);

  const insertSession = db.prepare(
    'INSERT OR IGNORE INTO sessions (date, candle_count, day_of_week) VALUES (?, ?, ?)'
  );
  const getSession    = db.prepare('SELECT id, candle_count FROM sessions WHERE date = ?');
  const updateCount   = db.prepare(
    'UPDATE sessions SET candle_count = CASE WHEN COALESCE(candle_count,0) < ? THEN ? ELSE candle_count END WHERE id = ?'
  );
  const upsertCandle  = db.prepare(`
    INSERT INTO candles (session_id, timestamp, timeframe, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, timestamp, timeframe) DO UPDATE SET
      open = excluded.open, high = excluded.high,
      low  = excluded.low,  close = excluded.close, volume = excluded.volume
    WHERE
      COALESCE(candles.open,  -1) != COALESCE(excluded.open,  -1) OR
      COALESCE(candles.high,  -1) != COALESCE(excluded.high,  -1) OR
      COALESCE(candles.low,   -1) != COALESCE(excluded.low,   -1) OR
      COALESCE(candles.close, -1) != COALESCE(excluded.close, -1) OR
      COALESCE(candles.volume,-1) != COALESCE(excluded.volume,-1)
  `);

  let sessionsTouched = 0;
  let candles1m       = 0;
  let candles5m       = 0;

  const dates = [...grouped.keys()].sort();

  db.transaction(() => {
    for (const dateKey of dates) {
      const dayCandlesRaw = grouped.get(dateKey);
      // Sort 1m candles by timestamp ascending
      dayCandlesRaw.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

      // day_of_week: Mon=0 … Sun=6  (matches persistTopstepBarsIntoSessions)
      const d   = new Date(`${dateKey}T12:00:00`);
      const dow = d.getDay();
      const adjDow = dow === 0 ? 6 : dow - 1;

      insertSession.run(dateKey, dayCandlesRaw.length, adjDow);
      const session = getSession.get(dateKey);
      if (!session?.id) continue;

      sessionsTouched++;
      updateCount.run(dayCandlesRaw.length, dayCandlesRaw.length, session.id);

      for (const c of dayCandlesRaw) {
        const w = upsertCandle.run(session.id, c.timestamp, '1m',
          c.open, c.high, c.low, c.close, c.volume);
        candles1m += Number(w?.changes || 0);
      }

      const five = aggregateTo5m(dayCandlesRaw);
      for (const c of five) {
        const w5 = upsertCandle.run(session.id, c.timestamp, '5m',
          c.open, c.high, c.low, c.close, c.volume);
        candles5m += Number(w5?.changes || 0);
      }
    }
  })();

  return { sessionsTouched, candles1m, candles5m };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = parseArgs(process.argv.slice(2));
  const db      = getDB();
  const symbols = args.symbol ? [args.symbol] : ['MNQ.c.0', 'MES.c.0'];

  // ── Step 1: Fetch from Databento (unless --bridge-only) ────────────────────
  if (!args.bridgeOnly) {
    const apiKey = process.env.DATABENTO_API_KEY || readKeyFromKeychain('3130_databento_api_key');
    if (!apiKey) {
      console.error('[seed-databento] No Databento API key found.');
      console.error('  Set DATABENTO_API_KEY env var, or use:');
      console.error('    security add-generic-password -s 3130_databento_api_key -a "$USER" -w "<key>"');
      process.exit(1);
    }

    const lookback = Number.isFinite(args.lookback) ? args.lookback : 120;
    const mode     = args.mode || 'auto';
    const now      = todayET();

    console.log('[seed-databento] Step 1 — Fetch from Databento API');
    console.log(`  mode:     ${mode}`);
    console.log(`  symbols:  ${symbols.join(', ')}`);
    console.log(`  lookback: ${lookback} days`);
    console.log(`  endDate:  ${now}`);
    console.log('');

    const t0     = Date.now();
    const result = await runDatabentoIngestion({
      db, apiKey, mode, symbols,
      lookbackDays: lookback,
      endDate: now, nowDate: now,
      force: args.force === true,
      timeoutMs: 90_000,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`  Done in ${elapsed}s — status: ${result.status}`);
    console.log(`  totalFetched:   ${result.totalFetched  ?? 0}`);
    console.log(`  totalInserted:  ${result.totalInserted ?? 0}`);
    if (Array.isArray(result.perSymbol)) {
      for (const s of result.perSymbol) {
        console.log(`  [${s.symbol}] ${s.status} fetched=${s.rowsFetched} inserted=${s.rowsInserted}${s.error ? ' err=' + s.error : ''}`);
      }
    }
    console.log('');
  }

  // ── Step 2: Bridge raw bars → sessions/candles (unless --skip-bridge) ──────
  if (!args.skipBridge) {
    const rawCount = db.prepare('SELECT COUNT(*) AS c FROM jarvis_market_bars_raw').get().c;
    if (rawCount === 0) {
      console.log('[seed-databento] Step 2 — jarvis_market_bars_raw is empty, skipping bridge');
    } else {
      const primarySymbol = symbols[0] || 'MNQ.c.0';
      console.log(`[seed-databento] Step 2 — Bridge raw bars → sessions/candles (${primarySymbol} only)`);
      const t1 = Date.now();
      const r  = bridgeRawToSessions(db, primarySymbol);
      const e  = ((Date.now() - t1) / 1000).toFixed(1);
      console.log(`  Done in ${e}s`);
      console.log(`  Sessions touched: ${r.sessionsTouched}`);
      console.log(`  1m candles written: ${r.candles1m}`);
      console.log(`  5m candles written: ${r.candles5m}`);
      console.log('');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const sessions   = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  const candles    = db.prepare('SELECT COUNT(*) AS c FROM candles').get().c;
  const dateRange  = db.prepare('SELECT MIN(date) AS first, MAX(date) AS last FROM sessions').get();
  const raw        = db.prepare('SELECT COUNT(*) AS c FROM jarvis_market_bars_raw').get().c;

  console.log('[seed-databento] Final DB state:');
  console.log(`  Raw bars       : ${raw.toLocaleString()}`);
  console.log(`  Sessions       : ${sessions.toLocaleString()}`);
  console.log(`  Candles        : ${candles.toLocaleString()}`);
  console.log(`  Date range     : ${dateRange.first || 'n/a'} → ${dateRange.last || 'n/a'}`);
}

main().catch((err) => {
  console.error('[seed-databento] Fatal error:', err.message);
  process.exit(1);
});
