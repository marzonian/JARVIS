/**
 * McNair Mindset by 3130
 * Startup preflight checks.
 */

const { getDB } = require('./db/database');
const { calcTPSL } = require('./engine/psych-levels');

function runPreflight(options = {}) {
  const settings = {
    strict: true,
    log: true,
    ...options,
  };

  const report = {
    ok: true,
    timestamp: new Date().toISOString(),
    stats: {},
    checks: {},
    warnings: [],
    errors: [],
  };

  try {
    const db = getDB();

    const requiredTables = ['sessions', 'candles', 'trades', 'imports'];
    const existing = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','candles','trades','imports')"
    ).all().map(r => r.name);
    const missing = requiredTables.filter(t => !existing.includes(t));
    if (missing.length > 0) {
      report.errors.push(`Missing required tables: ${missing.join(', ')}`);
    }

    report.stats.sessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
    report.stats.candles = db.prepare('SELECT COUNT(*) AS c FROM candles').get().c;
    report.stats.trades = db.prepare("SELECT COUNT(*) AS c FROM trades WHERE source = 'backtest'").get().c;

    if (report.stats.sessions === 0 || report.stats.candles === 0) {
      report.warnings.push('No imported session/candle data yet.');
    }

    if (report.stats.trades === 0) {
      report.warnings.push('No backtest trades yet.');
    } else {
      report.checks.shortCount = db.prepare(
        "SELECT COUNT(*) AS c FROM trades WHERE source = 'backtest' AND direction <> 'long'"
      ).get().c;

      report.checks.mondayCount = db.prepare(`
        SELECT COUNT(*) AS c
        FROM trades
        WHERE source = 'backtest'
          AND strftime('%w', COALESCE(date, substr(replace(entry_time,'T',' '), 1, 10))) = '1'
      `).get().c;

      report.checks.lateEntryCount = db.prepare(`
        SELECT COUNT(*) AS c
        FROM trades
        WHERE source = 'backtest'
          AND CAST(substr(replace(entry_time,'T',' '), 12, 2) AS INTEGER) >= 11
      `).get().c;

      report.checks.rrViolations = db.prepare(`
        SELECT COUNT(*) AS c
        FROM trades
        WHERE source = 'backtest'
          AND ABS(COALESCE(tp_distance_ticks, 0) - COALESCE(sl_distance_ticks, 0)) > 0
      `).get().c;

      report.checks.nullCritical = db.prepare(`
        SELECT COUNT(*) AS c
        FROM trades
        WHERE source = 'backtest'
          AND (
            entry_price IS NULL OR
            entry_time IS NULL OR
            tp_price IS NULL OR
            sl_price IS NULL OR
            direction IS NULL OR
            result IS NULL
          )
      `).get().c;

      const btTrades = db.prepare(`
        SELECT id, direction, entry_price, tp_price, sl_price
        FROM trades
        WHERE source = 'backtest'
      `).all();

      let tpModeViolations = 0;
      for (const t of btTrades) {
        const expected = calcTPSL(t.entry_price, t.direction, { tpMode: 'skip2', skipLevels: 2 });
        const tpMatch = Math.abs(expected.tp.price - t.tp_price) < 1e-9;
        const slMatch = Math.abs(expected.sl.price - t.sl_price) < 1e-9;
        if (!tpMatch || !slMatch) tpModeViolations++;
      }
      report.checks.tpModeViolations = tpModeViolations;

      const failing = Object.entries(report.checks).filter(([, v]) => v > 0);
      for (const [name, count] of failing) {
        report.errors.push(`${name}=${count}`);
      }
    }
  } catch (err) {
    report.errors.push(`Preflight exception: ${err.message}`);
  }

  report.ok = report.errors.length === 0;

  if (settings.log) {
    console.log('[3130] Preflight');
    console.log(`  ok: ${report.ok}`);
    if (Object.keys(report.stats).length > 0) {
      console.log(`  sessions: ${report.stats.sessions}, candles: ${report.stats.candles}, backtestTrades: ${report.stats.trades}`);
    }
    for (const [k, v] of Object.entries(report.checks)) {
      console.log(`  ${k}: ${v}`);
    }
    for (const w of report.warnings) console.log(`  warning: ${w}`);
    for (const e of report.errors) console.log(`  error: ${e}`);
  }

  if (settings.strict && !report.ok) {
    const msg = report.errors.join('; ') || 'unknown preflight failure';
    throw new Error(msg);
  }

  return report;
}

module.exports = { runPreflight };
