#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  LATEST_NATURAL_DAY_GAP_AUDIT_RESULT_ENUM,
  runLatestNaturalDayGapAudit,
} = require('../server/jarvis-core/preferred-owner-latest-natural-day-gap-audit');

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      timeframe TEXT NOT NULL DEFAULT '5m',
      timestamp TEXT NOT NULL,
      open REAL NOT NULL DEFAULT 0,
      high REAL NOT NULL DEFAULT 0,
      low REAL NOT NULL DEFAULT 0,
      close REAL NOT NULL DEFAULT 0,
      volume REAL NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertSessionWithCandles(db, day) {
  const sessionId = db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(day).lastInsertRowid;
  for (let i = 0; i < 3; i += 1) {
    const hh = String(14 + i).padStart(2, '0');
    db.prepare(`
      INSERT INTO candles (
        session_id, timeframe, timestamp, open, high, low, close, volume
      ) VALUES (?, '5m', ?, 100, 101, 99, 100.5, 10)
    `).run(sessionId, `${day} ${hh}:00:00`);
  }
}

function insertScoringRun(db, {
  targetDay,
  status = 'success_inserted',
  runtimeSource = 'close_complete_checkpoint',
  runOrigin = 'natural',
  idHint = 1,
}) {
  const details = {
    liveCheckpoint: {
      targetTradingDay: targetDay,
      checkpointStatus: status,
      runtimeCheckpointSource: runtimeSource,
    },
  };
  db.prepare(`
    INSERT INTO jarvis_daily_scoring_runs (
      run_date,
      mode,
      run_origin,
      details_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    targetDay,
    runtimeSource === 'close_complete_checkpoint'
      ? 'scheduled_live_finalization_close_window'
      : 'integration_manual',
    runOrigin,
    JSON.stringify(details),
    `${targetDay}T22:${String(10 + idHint).padStart(2, '0')}:00.000Z`
  );
}

function insertFullChain(db, day, runId = 42) {
  db.prepare(`
    INSERT INTO jarvis_live_outcome_ownership (
      target_trading_day, created_row_id, first_run_id, first_run_mode, first_run_source,
      first_insert_sla_outcome, first_inserted_at, first_inserted_autonomous
    ) VALUES (?, ?, ?, 'scheduled_live_finalization_close_window', 'close_complete_checkpoint',
              'insert_required_success_on_time', ?, 1)
  `).run(day, runId + 500, runId, `${day} 22:05:00`);

  db.prepare(`
    INSERT INTO jarvis_live_preferred_owner_proof (
      target_trading_day, preferred_owner_expected_source, first_row_id, first_creator_run_id,
      first_creator_mode, first_creator_source, first_creator_autonomous, first_creation_timestamp,
      first_creation_checkpoint_status, first_creation_attempt_result, first_creation_proof_outcome,
      first_creation_ownership_outcome, first_creation_ownership_source_specific_outcome,
      preferred_owner_won, preferred_owner_won_first_eligible_cycle, preferred_owner_failure_reason,
      preferred_owner_proof_captured_at
    ) VALUES (
      ?, 'close_complete_checkpoint', ?, ?, 'scheduled_live_finalization_close_window',
      'close_complete_checkpoint', 1, ?, 'success_inserted', 'attempt_executed_success',
      'proof_attempted_success', 'first_autonomous_insert_of_day',
      'first_autonomous_insert_by_close_complete_checkpoint', 1, 1, 'none', ?
    )
  `).run(day, runId + 500, runId, `${day} 22:05:00`, `${day}T22:06:00.000Z`);

  db.prepare(`
    INSERT INTO jarvis_preferred_owner_post_close_verifier (
      target_trading_day, run_id, run_origin, runtime_source, checkpoint_status,
      verifier_status, verifier_pass, failure_reasons_json, summary_json, verified_at
    ) VALUES (?, ?, 'natural', 'close_complete_checkpoint', 'success_inserted',
              'pass', 1, '[]', '{}', ?)
  `).run(day, runId, `${day}T22:06:00.000Z`);

  db.prepare(`
    INSERT INTO jarvis_preferred_owner_natural_wins (
      target_trading_day, run_id, first_creator_source, reservation_state,
      reservation_blocked_fallback, proof_row_id, run_origin, timestamp
    ) VALUES (?, ?, 'close_complete_checkpoint', 'reservation_released_after_preferred_owner_win',
              1, ?, 'natural', ?)
  `).run(day, runId, runId, `${day}T22:06:30.000Z`);

  db.prepare(`
    INSERT INTO jarvis_preferred_owner_operational_verdicts (
      target_trading_day, run_id, run_origin, runtime_checkpoint_source, checkpoint_status,
      preferred_owner_expected_source, preferred_owner_actual_source, verifier_status, verifier_pass,
      verifier_failure_reasons_json, ownership_source_specific_outcome,
      natural_preferred_owner_wins_last5d, natural_preferred_owner_wins_total,
      natural_preferred_owner_verifier_passes_last5d, natural_preferred_owner_verifier_fails_last5d, reported_at
    ) VALUES (?, ?, 'natural', 'close_complete_checkpoint', 'success_inserted',
              'close_complete_checkpoint', 'close_complete_checkpoint', 'pass', 1, '[]',
              'first_autonomous_insert_by_close_complete_checkpoint', 1, 1, 1, 0, ?)
  `).run(day, runId, `${day}T22:07:00.000Z`);

  db.prepare(`
    INSERT INTO jarvis_preferred_owner_operational_proof_bundles (
      target_trading_day, run_id, run_origin, checkpoint_status, checkpoint_reason, runtime_checkpoint_source,
      preferred_owner_expected_source, preferred_owner_actual_source, preferred_owner_won,
      preferred_owner_failure_reason, ownership_source_specific_outcome, verifier_status, verifier_pass,
      verifier_failure_reasons_json, natural_preferred_owner_wins_last5d, natural_preferred_owner_wins_total,
      natural_preferred_owner_verifier_passes_last5d, natural_preferred_owner_verifier_fails_last5d, captured_at
    ) VALUES (?, ?, 'natural', 'success_inserted', 'inserted_new_live_outcome', 'close_complete_checkpoint',
              'close_complete_checkpoint', 'close_complete_checkpoint', 1, 'none',
              'first_autonomous_insert_by_close_complete_checkpoint', 'pass', 1, '[]',
              1, 1, 1, 0, ?)
  `).run(day, runId, `${day}T22:07:10.000Z`);

  db.prepare(`
    INSERT INTO jarvis_preferred_owner_natural_drill_watch_runs (
      target_trading_day, trigger_run_id, trigger_run_origin, trigger_runtime_source,
      pre_transition_checkpoint_status, post_transition_checkpoint_status,
      drill_outcome, executed, executed_at
    ) VALUES (?, ?, 'natural', 'close_complete_checkpoint', 'waiting_valid',
              'success_inserted', 'resolved_and_captured', 1, ?)
  `).run(day, runId, `${day}T22:07:20.000Z`);
}

function runTests() {
  assert(
    LATEST_NATURAL_DAY_GAP_AUDIT_RESULT_ENUM.includes('latest_natural_day_fully_completed'),
    'result enum should include fully completed state'
  );

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'success_inserted', runtimeSource: 'close_complete_checkpoint', runOrigin: 'natural', idHint: 1 });
    insertFullChain(db, day, 101);
    const result = runLatestNaturalDayGapAudit({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.latestActualNaturalTradingDayInData, day);
    assert.strictEqual(result.latestNaturalTradingDayAfterBaselineFound, true);
    assert.strictEqual(result.result, 'latest_natural_day_fully_completed');
    assert.strictEqual(result.firstMissingLayer, 'none');
    assert.strictEqual(result.exists.closeCompleteScoringRan, true);
    assert.strictEqual(result.exists.watcher, true);
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    const result = runLatestNaturalDayGapAudit({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'latest_natural_day_not_seen_in_scoring');
    assert.strictEqual(result.firstMissingLayer, 'jarvis_daily_scoring_runs');
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'waiting_valid', runtimeSource: 'close_complete_checkpoint', runOrigin: 'natural', idHint: 2 });
    const result = runLatestNaturalDayGapAudit({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'latest_natural_day_seen_but_not_resolved');
    assert.strictEqual(result.firstMissingLayer, 'checkpoint_resolution');
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'success_inserted', runtimeSource: 'close_complete_checkpoint', runOrigin: 'natural', idHint: 3 });
    db.prepare(`
      INSERT INTO jarvis_live_outcome_ownership (
        target_trading_day, created_row_id, first_run_id, first_run_mode, first_run_source,
        first_insert_sla_outcome, first_inserted_at, first_inserted_autonomous
      ) VALUES (?, 900, 3, 'scheduled_live_finalization_close_window', 'close_complete_checkpoint',
                'insert_required_success_on_time', ?, 1)
    `).run(day, `${day} 22:05:00`);
    db.prepare(`
      INSERT INTO jarvis_live_preferred_owner_proof (
        target_trading_day, preferred_owner_expected_source, first_row_id, first_creator_run_id,
        first_creator_mode, first_creator_source, first_creator_autonomous, first_creation_timestamp,
        first_creation_checkpoint_status, first_creation_attempt_result, first_creation_proof_outcome,
        first_creation_ownership_outcome, first_creation_ownership_source_specific_outcome,
        preferred_owner_won, preferred_owner_won_first_eligible_cycle, preferred_owner_failure_reason,
        preferred_owner_proof_captured_at
      ) VALUES (?, 'close_complete_checkpoint', 900, 3, 'scheduled_live_finalization_close_window',
                'close_complete_checkpoint', 1, ?, 'success_inserted', 'attempt_executed_success',
                'proof_attempted_success', 'first_autonomous_insert_of_day',
                'first_autonomous_insert_by_close_complete_checkpoint', 1, 1, 'none', ?)
    `).run(day, `${day} 22:05:00`, `${day}T22:06:00.000Z`);
    const result = runLatestNaturalDayGapAudit({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'latest_natural_day_missing_verifier');
    assert.strictEqual(result.firstMissingLayer, 'jarvis_preferred_owner_post_close_verifier');
  }

  {
    const db = makeDb();
    insertSessionWithCandles(db, '2026-03-13');
    insertScoringRun(db, { targetDay: '2026-03-13', status: 'success_inserted', runtimeSource: 'close_complete_checkpoint', runOrigin: 'natural', idHint: 5 });
    insertFullChain(db, '2026-03-13', 201);
    const result = runLatestNaturalDayGapAudit({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.latestNaturalTradingDayAfterBaselineFound, false);
    assert.strictEqual(result.latestActualNaturalTradingDayInData, '2026-03-13');
    assert.strictEqual(result.result, 'latest_natural_day_fully_completed');
    assert.strictEqual(result.pipelineState, 'merely_lagging');
  }

  console.log('✅ preferred-owner latest natural day gap audit deterministic tests passed');
}

runTests();

