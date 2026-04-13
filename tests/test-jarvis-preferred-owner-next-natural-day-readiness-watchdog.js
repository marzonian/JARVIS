#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  NEXT_NATURAL_DAY_READINESS_RESULT_ENUM,
  runNextNaturalDayReadinessWatchdog,
  runNextNaturalDayReadinessWatchdogMonitor,
} = require('../server/jarvis-core/preferred-owner-next-natural-day-readiness-watchdog');

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
    db.prepare(`
      INSERT INTO candles (session_id, timeframe, timestamp, open, high, low, close, volume)
      VALUES (?, '5m', ?, 100, 101, 99, 100.5, 10)
    `).run(sessionId, `${day} ${String(14 + i).padStart(2, '0')}:00:00`);
  }
}

function insertScoringRun(db, {
  targetDay,
  status = 'success_inserted',
  runtimeSource = 'close_complete_checkpoint',
  runOrigin = 'natural',
  createdAt = null,
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
    createdAt || `${targetDay}T22:10:00.000Z`
  );
}

function insertFullChain(db, day, runId = 700) {
  db.prepare(`
    INSERT INTO jarvis_live_outcome_ownership (
      target_trading_day, created_row_id, first_run_id, first_run_mode, first_run_source,
      first_insert_sla_outcome, first_inserted_at, first_inserted_autonomous
    ) VALUES (?, ?, ?, 'scheduled_live_finalization_close_window', 'close_complete_checkpoint',
              'insert_required_success_on_time', ?, 1)
  `).run(day, runId + 1000, runId, `${day} 22:05:00`);

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
  `).run(day, runId + 1000, runId, `${day} 22:05:00`, `${day}T22:06:00.000Z`);

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
              'first_autonomous_insert_by_close_complete_checkpoint', 'pass', 1, '[]', 1, 1, 1, 0, ?)
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
    NEXT_NATURAL_DAY_READINESS_RESULT_ENUM.includes('next_natural_day_not_in_data_yet'),
    'watchdog enum should include next_natural_day_not_in_data_yet'
  );

  {
    const db = makeDb();
    insertSessionWithCandles(db, '2026-03-13');
    const result = runNextNaturalDayReadinessWatchdog({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'next_natural_day_not_in_data_yet');
    assert.strictEqual(result.systemState, 'waiting_for_next_day');
  }

  {
    const db = makeDb();
    insertSessionWithCandles(db, '2026-03-13');
    const monitor = runNextNaturalDayReadinessWatchdogMonitor({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(monitor.result, 'next_natural_day_not_in_data_yet');
    assert.strictEqual(monitor.completed, false);
    assert.strictEqual(monitor.alertEmitted, false);
    assert.strictEqual(monitor.nextNaturalDayDiscoveredInPersistedData, false);
    assert.strictEqual(monitor.terminalAlertEmittedForDiscoveredDay, false);
    assert.strictEqual(monitor.watchdogStateRow, null);
    assert.strictEqual(monitor.watchdogTerminalAlertRow, null);
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    const result = runNextNaturalDayReadinessWatchdog({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.nextNaturalTradingDayAfterBaseline, day);
    assert.strictEqual(result.result, 'next_natural_day_in_data_not_seen_in_scoring');
    assert.strictEqual(result.firstMissingLayer, 'jarvis_daily_scoring_runs');
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    const monitor = runNextNaturalDayReadinessWatchdogMonitor({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(monitor.result, 'next_natural_day_in_data_not_seen_in_scoring');
    assert.strictEqual(monitor.pipelineState, 'waiting');
    assert.strictEqual(monitor.completed, false);
    assert.strictEqual(monitor.alertEmitted, false);
    assert.strictEqual(monitor.nextNaturalDayDiscoveredInPersistedData, true);
    assert.strictEqual(monitor.terminalAlertEmittedForDiscoveredDay, false);
    assert(monitor.watchdogStateRow, 'watchdog state row should persist once next day appears');
    assert.strictEqual(monitor.watchdogStateRow.targetTradingDay, day);
    assert.strictEqual(monitor.watchdogStateRow.currentResult, 'next_natural_day_in_data_not_seen_in_scoring');
    assert.strictEqual(monitor.watchdogStateRow.completed, false);
    assert.strictEqual(monitor.watchdogStateRow.alertEmitted, false);
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'waiting_valid' });
    const result = runNextNaturalDayReadinessWatchdog({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'next_natural_day_seen_but_not_resolved');
    assert.strictEqual(result.firstMissingLayer, 'checkpoint_resolution');
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'success_inserted' });
    const result = runNextNaturalDayReadinessWatchdog({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'next_natural_day_resolved_but_missing_ownership');
    assert.strictEqual(result.firstMissingLayer, 'jarvis_live_outcome_ownership');
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'success_inserted' });
    db.prepare(`
      INSERT INTO jarvis_live_outcome_ownership (
        target_trading_day, created_row_id, first_run_id, first_run_mode, first_run_source,
        first_insert_sla_outcome, first_inserted_at, first_inserted_autonomous
      ) VALUES (?, 999, 1, 'scheduled_live_finalization_close_window', 'close_complete_checkpoint',
                'insert_required_success_on_time', ?, 1)
    `).run(day, `${day} 22:05:00`);
    const result = runNextNaturalDayReadinessWatchdog({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.result, 'next_natural_day_missing_preferred_owner_proof');
    assert.strictEqual(result.firstMissingLayer, 'jarvis_live_preferred_owner_proof');
  }

  {
    const db = makeDb();
    insertSessionWithCandles(db, '2026-03-13');
    insertScoringRun(db, { targetDay: '2026-03-13', status: 'success_inserted' });
    insertFullChain(db, '2026-03-13', 901);
    insertSessionWithCandles(db, '2026-03-16');
    insertScoringRun(db, { targetDay: '2026-03-16', status: 'success_inserted' });
    insertFullChain(db, '2026-03-16', 902);
    const result = runNextNaturalDayReadinessWatchdog({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(result.nextNaturalTradingDayAfterBaseline, '2026-03-16');
    assert.strictEqual(result.latestActualNaturalTradingDayInData, '2026-03-16');
    assert.strictEqual(result.result, 'next_natural_day_fully_completed');
    assert.strictEqual(result.systemState, 'healthy_on_next_day');
    assert.strictEqual(result.exists.watcher, true);
  }

  {
    const db = makeDb();
    insertSessionWithCandles(db, '2026-03-13');
    insertScoringRun(db, { targetDay: '2026-03-13', status: 'success_inserted' });
    insertFullChain(db, '2026-03-13', 1001);
    insertSessionWithCandles(db, '2026-03-16');
    insertScoringRun(db, { targetDay: '2026-03-16', status: 'success_inserted' });
    insertFullChain(db, '2026-03-16', 1002);

    const first = runNextNaturalDayReadinessWatchdogMonitor({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(first.result, 'next_natural_day_fully_completed');
    assert.strictEqual(first.pipelineState, 'healthy');
    assert.strictEqual(first.completed, true);
    assert.strictEqual(first.alertEmitted, true);
    assert.strictEqual(first.alertPersistedThisRun, true);
    assert.strictEqual(first.nextNaturalDayDiscoveredInPersistedData, true);
    assert.strictEqual(first.terminalAlertEmittedForDiscoveredDay, true);
    assert(first.watchdogTerminalAlertRow, 'terminal alert row should persist for completed day');
    assert.strictEqual(first.watchdogTerminalAlertRow.alertType, 'success');

    const second = runNextNaturalDayReadinessWatchdogMonitor({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(second.result, 'next_natural_day_fully_completed');
    assert.strictEqual(second.alertEmitted, true);
    assert.strictEqual(second.alertPersistedThisRun, false);
    assert.strictEqual(second.nextNaturalDayDiscoveredInPersistedData, true);
    assert.strictEqual(second.terminalAlertEmittedForDiscoveredDay, true);
    const alertCount = Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_preferred_owner_next_natural_day_watchdog_alerts
      WHERE baseline_date = '2026-03-13'
        AND target_trading_day = '2026-03-16'
    `).get()?.c || 0);
    assert.strictEqual(alertCount, 1, 'terminal alert rows must dedupe per target day');
  }

  {
    const db = makeDb();
    const day = '2026-03-16';
    insertSessionWithCandles(db, day);
    insertScoringRun(db, { targetDay: day, status: 'success_inserted' });
    const failure = runNextNaturalDayReadinessWatchdogMonitor({ db, baselineDate: '2026-03-13' });
    assert.strictEqual(failure.result, 'next_natural_day_resolved_but_missing_ownership');
    assert.strictEqual(failure.pipelineState, 'broken');
    assert.strictEqual(failure.completed, true);
    assert.strictEqual(failure.alertEmitted, true);
    assert.strictEqual(failure.nextNaturalDayDiscoveredInPersistedData, true);
    assert.strictEqual(failure.terminalAlertEmittedForDiscoveredDay, true);
    assert(failure.watchdogTerminalAlertRow, 'failure should still persist one terminal alert row');
    assert.strictEqual(failure.watchdogTerminalAlertRow.alertType, 'failure');
  }

  console.log('✅ preferred-owner next natural day readiness watchdog deterministic tests passed');
}

runTests();
