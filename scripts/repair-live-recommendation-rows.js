'use strict';
/**
 * One-time repair script for historical live recommendation rows
 * that have wrong posture due to two now-fixed bugs:
 *
 * Bug 1 (toNumber): `toNumber(null, 50)` returned 0 → projectedWinChance=0 → stand_down
 *   Affected rows: all live rows before the Apr 22 test-regen, with pwc=0
 *
 * Bug 2 (execution gate): execution_disabled + kill_switch_active (automation defaults)
 *   were treated as hard NO_TRADE blockers → overrode classifyPosture → stand_down
 *   Affected rows: Apr 21 and Apr 22 (Apr 22 already fixed by test-regen)
 *
 * Repair strategy:
 *   - Run buildBackfillRecommendationContextForDate for each bad date
 *   - Update the live row with the corrected posture and recommendation JSON
 */

const path = require('path');
const { getDB } = require(path.join(__dirname, '../server/db/database.js'));

// Load index.js for access to buildBackfillRecommendationContextForDate
// We do this selectively via requiring the recommendation-backfill module
const { runRecommendationBackfill } = require(
  path.join(__dirname, '../server/jarvis-core/recommendation-backfill.js')
);
const {
  upsertTodayRecommendationContext,
  evaluateRecommendationOutcomeDay,
} = require(
  path.join(__dirname, '../server/jarvis-core/recommendation-outcome.js')
);

const SESSIONS_PATH = path.join(__dirname, '../data/sessions.json');
const fs = require('fs');

function loadAllSessions() {
  if (!fs.existsSync(SESSIONS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function main() {
  const db = getDB();

  // Find all live rows with stand_down posture
  const badRows = db.prepare(
    "SELECT rec_date, posture, json_extract(recommendation_json, '$.projectedWinChance') as pwc FROM jarvis_recommendation_context_history WHERE source_type='live' AND posture='stand_down' ORDER BY rec_date"
  ).all();

  console.log(`Found ${badRows.length} live rows with stand_down posture to repair`);
  if (!badRows.length) {
    console.log('Nothing to repair.');
    return;
  }

  const sessions = loadAllSessions();
  const allDates = Object.keys(sessions).sort();
  console.log(`Loaded ${allDates.length} session dates`);

  let repaired = 0;
  let failed = 0;

  // Run backfill for the bad dates with force=true so existing rows are overwritten
  // sourceType stays 'backfill' in backfill engine — we then re-upsert as live
  const badDates = badRows.map(r => r.rec_date);

  const result = await runRecommendationBackfill({
    db,
    sessions,
    windowSessions: 90,
    force: true,
    sourceType: 'backfill',    // run as backfill to get corrected recommendations
    reconstructionPhase: 'pre_orb',
    reconstructionVersion: 'v1',
    targetDates: badDates,     // only repair the bad dates
    deps: {
      getRecommendationContextRow: (d, src, phase) => {
        const row = db.prepare(
          "SELECT * FROM jarvis_recommendation_context_history WHERE rec_date=? AND source_type=? AND reconstruction_phase=? LIMIT 1"
        ).get(d, src, phase);
        return row || null;
      },
      upsertTodayRecommendationContext,
      evaluateRecommendationOutcomeDay,
      // Minimal stubs — we just need the posture from the backfill result
      runTradeMechanicsVariantTool: () => null,
    },
  }).catch(err => {
    console.error('Backfill run failed:', err.message);
    return null;
  });

  if (!result) {
    console.error('Backfill returned null — checking individual approach');
  } else {
    console.log('Backfill result summary:', {
      processed: result.processed,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  // Now for each bad date, copy the backfill recommendation into the live row
  for (const rec_date of badDates) {
    const backfillRow = db.prepare(
      "SELECT posture, recommended_strategy_key, recommended_strategy_name, recommended_tp_mode, confidence_label, confidence_score, recommendation_json FROM jarvis_recommendation_context_history WHERE rec_date=? AND source_type='backfill' ORDER BY updated_at DESC LIMIT 1"
    ).get(rec_date);

    if (!backfillRow) {
      console.warn(`  [${rec_date}] No backfill row found — skipping`);
      failed++;
      continue;
    }

    // Update the live row with corrected data from backfill
    const updated = db.prepare(`
      UPDATE jarvis_recommendation_context_history
      SET posture = ?,
          recommended_strategy_key = ?,
          recommended_strategy_name = ?,
          recommended_tp_mode = ?,
          confidence_label = ?,
          confidence_score = ?,
          recommendation_json = json_patch(recommendation_json, json_object(
            'posture', ?,
            'postureReason', ?,
            'frontLineBlockerGateApplied', null,
            'frontLineBlockerGateSignal', null,
            'frontLineBlockerGateBlockers', null,
            'blockers', json('[]')
          )),
          updated_at = datetime('now')
      WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    `).run(
      backfillRow.posture,
      backfillRow.recommended_strategy_key,
      backfillRow.recommended_strategy_name,
      backfillRow.recommended_tp_mode,
      backfillRow.confidence_label,
      backfillRow.confidence_score,
      backfillRow.posture,
      (() => {
        try {
          const rec = JSON.parse(backfillRow.recommendation_json || '{}');
          return rec.postureReason || '';
        } catch { return ''; }
      })(),
      rec_date
    );

    if (updated.changes > 0) {
      console.log(`  [${rec_date}] Repaired: stand_down → ${backfillRow.posture}`);
      repaired++;
    } else {
      console.warn(`  [${rec_date}] No live row found to update`);
      failed++;
    }
  }

  console.log(`\nRepair complete: ${repaired} repaired, ${failed} failed`);

  // Show updated distribution
  const dist = db.prepare(
    "SELECT posture, COUNT(*) as n FROM jarvis_recommendation_context_history WHERE source_type='live' GROUP BY posture ORDER BY n DESC"
  ).all();
  console.log('Live row posture distribution after repair:', dist);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
