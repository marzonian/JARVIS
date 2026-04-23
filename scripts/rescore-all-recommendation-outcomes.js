'use strict';
/**
 * Re-score every recommendation context row (live + backfill) into
 * jarvis_scored_trade_outcomes, using the current evaluateRecommendationOutcomeDay
 * logic. Needed after the execution-advisory fix corrected historical postures —
 * the scored_outcomes table still held pre-fix (stand_down) evaluations.
 *
 * What it does per row:
 *   - Builds a per-date strategy snapshot from the candle DB
 *   - Calls evaluateRecommendationOutcomeDay with the context row
 *   - Upserts the result into jarvis_scored_trade_outcomes
 *     keyed on (score_date, source_type, reconstruction_phase)
 *
 * Does NOT touch jarvis_recommendation_outcome_daily (UNIQUE(rec_date) there
 * means live/backfill would fight for the same row — scoped analysis uses
 * scored_trade_outcomes instead).
 */

const path = require('path');
const { getDB } = require(path.join(__dirname, '../server/db/database.js'));
const {
  evaluateRecommendationOutcomeDay,
} = require(path.join(__dirname, '../server/jarvis-core/recommendation-outcome.js'));
const {
  buildPerDateStrategySnapshotForScoring,
} = require(path.join(__dirname, '../server/jarvis-core/daily-evidence-scoring.js'));
const {
  upsertScoredTradeOutcome,
} = require(path.join(__dirname, '../server/jarvis-core/data-foundation-storage.js'));

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
    let datePart = d;
    let timePart = '00:00:00';
    if (ts.includes(' ')) {
      const split = ts.split(' ');
      datePart = split[0] || d;
      timePart = split[1] || '00:00:00';
    } else if (ts.includes('T')) {
      const split = ts.split('T');
      datePart = split[0] || d;
      timePart = ((split[1] || '').replace(/Z$/i, '').replace(/[+-]\d{2}:?\d{2}$/i, '') || '00:00:00').split('.')[0];
    }
    result[d].push({
      timestamp: ts,
      date: datePart,
      time: timePart,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    });
  }
  return result;
}

function main() {
  const db = getDB();
  const sessions = loadSessionsFromDb(db);
  console.log(`Loaded ${Object.keys(sessions).length} session dates from candles`);

  const rows = db.prepare(`
    SELECT * FROM jarvis_recommendation_context_history
    ORDER BY rec_date ASC, source_type ASC
  `).all();
  console.log(`Scoring ${rows.length} context rows`);

  const counts = { live: 0, backfill: 0, skipped: 0, errors: 0 };
  const byPosture = {};

  for (const row of rows) {
    const date = row.rec_date;
    try {
      const strategySnapshot = buildPerDateStrategySnapshotForScoring(date, sessions);
      const daily = evaluateRecommendationOutcomeDay({
        db,
        date,
        contextRow: row,
        strategySnapshot,
        sessions,
        runTradeMechanicsVariantTool: null,
      });

      if (!daily) {
        counts.skipped++;
        continue;
      }

      upsertScoredTradeOutcome(db, {
        scoreDate: date,
        sourceType: row.source_type,
        reconstructionPhase: row.reconstruction_phase,
        regimeLabel: daily.regimeLabel || row.regime_label || null,
        strategyKey: daily.recommendedStrategyKey,
        posture: daily.posture,
        confidenceLabel: row.confidence_label,
        confidenceScore: row.confidence_score,
        recommendation: JSON.parse(row.recommendation_json || '{}'),
        outcome: daily,
        scoreLabel: daily.postureEvaluation,
        recommendationDelta: daily.recommendationDelta,
        actualPnl: daily.actualPnl,
        bestPossiblePnl: daily.bestPossiblePnl,
      });

      counts[row.source_type] = (counts[row.source_type] || 0) + 1;
      const key = `${row.source_type}:${daily.postureEvaluation}`;
      byPosture[key] = (byPosture[key] || 0) + 1;
    } catch (err) {
      counts.errors++;
      console.warn(`  [${date}/${row.source_type}] error: ${err.message}`);
    }
  }

  console.log('\nRescore complete:', counts);
  console.log('Distribution (source_type:postureEvaluation):');
  for (const [k, v] of Object.entries(byPosture).sort()) {
    console.log(`  ${k}: ${v}`);
  }
}

try {
  main();
} catch (err) {
  console.error('Fatal:', err);
  process.exit(1);
}
