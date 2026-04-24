'use strict';
/**
 * Regenerate the 78-session backfill recommendation history with the newly
 * installed baseline guard (strategy-layers.js: chooseRecommendedStrategy).
 *
 * Before the guard, the engine was recommending variant_nearest_tp on 17
 * historical dates because its WR/PF composite score was higher than the
 * original plan's — even though the variant netted less total dollar P&L.
 *
 * After the guard, only variants with strictly higher dollar P&L AND
 * sufficient trade sample size can displace original. This script re-runs
 * the backfill for the entire covered date range and reports how many dates
 * changed recommendation + the cumulative dollar impact.
 */

const path = require('path');
const { getDB } = require(path.join(__dirname, '../server/db/database.js'));
const {
  runRecommendationBackfill,
} = require(path.join(__dirname, '../server/jarvis-core/recommendation-backfill.js'));
const {
  upsertTodayRecommendationContext,
  evaluateRecommendationOutcomeDay,
} = require(path.join(__dirname, '../server/jarvis-core/recommendation-outcome.js'));

function loadSessionsFromDb(db) {
  const rows = db.prepare(`
    SELECT s.date AS session_date, c.timestamp, c.open, c.high, c.low, c.close, c.volume
    FROM candles c
    JOIN sessions s ON s.id = c.session_id
    WHERE c.timeframe = '5m'
    ORDER BY s.date ASC, c.timestamp ASC
  `).all();
  const result = {};
  for (const r of rows) {
    const d = r.session_date;
    if (!result[d]) result[d] = [];
    const ts = String(r.timestamp || '');
    let timePart = '00:00:00';
    if (ts.includes(' ')) timePart = ts.split(' ')[1] || '00:00:00';
    else if (ts.includes('T')) timePart = ((ts.split('T')[1] || '').replace(/Z$/i, '').replace(/[+-]\d{2}:?\d{2}$/i, '') || '00:00:00').split('.')[0];
    result[d].push({ timestamp: ts, date: d, time: timePart, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  }
  return result;
}

async function main() {
  const db = getDB();
  const sessions = loadSessionsFromDb(db);
  console.log(`Loaded ${Object.keys(sessions).length} session dates`);

  // Snapshot pre-fix recommendation distribution
  const preRows = db.prepare(`
    SELECT recommended_strategy_key, COUNT(*) AS n
    FROM jarvis_recommendation_context_history
    WHERE source_type='backfill'
    GROUP BY recommended_strategy_key
  `).all();
  console.log('\n[PRE-FIX] backfill strategy distribution:', preRows);

  // Regenerate all backfill dates with force=true so the guard-aware
  // recommendation overwrites the old rows.
  const result = await runRecommendationBackfill({
    db,
    sessions,
    windowSessions: 200,
    force: true,
    sourceType: 'backfill',
    reconstructionPhase: 'pre_orb',
    reconstructionVersion: 'v1',
    deps: {
      getRecommendationContextRow: (d, src, phase) => db.prepare(
        "SELECT * FROM jarvis_recommendation_context_history WHERE rec_date=? AND source_type=? AND reconstruction_phase=? LIMIT 1"
      ).get(d, src, phase) || null,
      upsertTodayRecommendationContext,
      evaluateRecommendationOutcomeDay,
      runTradeMechanicsVariantTool: () => null,
    },
  });

  console.log('\n[BACKFILL RUN]', {
    processed: result?.processed,
    inserted: result?.inserted,
    updated: result?.updated,
    skipped: result?.skipped,
    errors: result?.errors,
  });

  const postRows = db.prepare(`
    SELECT recommended_strategy_key, COUNT(*) AS n
    FROM jarvis_recommendation_context_history
    WHERE source_type='backfill'
    GROUP BY recommended_strategy_key
  `).all();
  console.log('\n[POST-FIX] backfill strategy distribution:', postRows);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
