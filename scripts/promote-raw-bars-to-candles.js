'use strict';
/**
 * Promote raw 1-min bars from jarvis_market_bars_raw → candles table
 * for any session date that has raw bars but no/few 5m candles.
 *
 * Necessary because the standard databento ingestion path stops at the
 * raw table on some days; the candles table (queried by the strategy
 * engine) doesn't get populated, so JARVIS goes blind for those sessions.
 *
 * Idempotent — uses INSERT OR IGNORE.
 */
const path = require('path');
const { getDB } = require(path.join(__dirname, '../server/db/database.js'));

const SYMBOL = 'MNQ.c.0';
const DATES_NEEDED = [
  '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-04', '2026-05-05',
];

function dayOfWeekAdj(dateStr) {
  // Stored as: 0 = Mon, 1 = Tue, ..., 5 = Sat, 6 = Sun (per import.js convention)
  const d = new Date(`${dateStr}T12:00:00`).getDay();
  return d === 0 ? 6 : d - 1;
}

function bucketTo5m(ts1m) {
  // ts1m looks like '2026-04-29 09:32:00' or ISO; preserve as 5-min boundary.
  const m = ts1m.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, date, hh, mm] = m;
  const minBucket = Math.floor(parseInt(mm, 10) / 5) * 5;
  return `${date} ${hh}:${String(minBucket).padStart(2, '0')}:00`;
}

function main() {
  const db = getDB();

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (date, candle_count, day_of_week)
    VALUES (?, ?, ?)
  `);
  const getSession = db.prepare('SELECT id FROM sessions WHERE date = ?');
  const insertCandle = db.prepare(`
    INSERT OR IGNORE INTO candles (session_id, timestamp, timeframe, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totals = { sessions: 0, c1m: 0, c5m: 0, dates: [] };

  for (const date of DATES_NEEDED) {
    // Pull raw bars for this date / symbol
    // ts_event in raw is ISO with 'T'; we want it in '2026-04-29 HH:MM:SS' for candles.
    const rawBars = db.prepare(`
      SELECT ts_event, open, high, low, close, volume
      FROM jarvis_market_bars_raw
      WHERE symbol = ? AND substr(ts_event, 1, 10) = ?
      ORDER BY ts_event ASC
    `).all(SYMBOL, date);

    if (!rawBars.length) {
      console.log(`  ${date}  no raw bars — skip`);
      continue;
    }

    // Make sure session exists
    insertSession.run(date, 0, dayOfWeekAdj(date));
    const session = getSession.get(date);
    if (!session) {
      console.log(`  ${date}  failed to create session — skip`);
      continue;
    }

    let written1m = 0;
    let written5m = 0;
    const buckets = new Map();

    // Databento ohlcv-1m stores prices scaled by 1e9 (e.g., 27384750000000 = 27384.75).
    // The standard ingestion path divides by 1e9 before persisting to `candles`;
    // we must do the same here.
    const PRICE_SCALE = 1e9;
    const scale = (v) => Number(v) / PRICE_SCALE;

    db.transaction(() => {
      for (const bar of rawBars) {
        // Normalize timestamp for candles table: use 'YYYY-MM-DD HH:MM:SS'
        const ts1m = String(bar.ts_event).replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '').slice(0, 19);
        const o = scale(bar.open), h = scale(bar.high), l = scale(bar.low), c = scale(bar.close);
        const r1 = insertCandle.run(session.id, ts1m, '1m', o, h, l, c, bar.volume || 0);
        if (r1.changes > 0) written1m += 1;

        // Aggregate to 5m
        const bucketTs = bucketTo5m(ts1m);
        if (!bucketTs) continue;
        if (!buckets.has(bucketTs)) {
          buckets.set(bucketTs, { open: o, high: h, low: l, close: c, volume: bar.volume || 0 });
        } else {
          const b = buckets.get(bucketTs);
          b.high = Math.max(b.high, h);
          b.low = Math.min(b.low, l);
          b.close = c; // last close for the bucket
          b.volume += (bar.volume || 0);
        }
      }

      // Insert 5m candles
      for (const [ts, agg] of buckets.entries()) {
        const r5 = insertCandle.run(session.id, ts, '5m', agg.open, agg.high, agg.low, agg.close, agg.volume);
        if (r5.changes > 0) written5m += 1;
      }
    })();

    console.log(`  ${date}  raw=${rawBars.length}  wrote 1m=${written1m}  5m=${written5m}`);
    totals.sessions += 1;
    totals.c1m += written1m;
    totals.c5m += written5m;
    totals.dates.push(date);
  }

  console.log('');
  console.log(`DONE. Sessions touched: ${totals.sessions}.  1m candles: ${totals.c1m}.  5m candles: ${totals.c5m}.`);
  console.log(`Dates promoted: ${totals.dates.join(', ')}`);
}

main();
