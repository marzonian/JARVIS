#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  buildPreferredOwnerMonitorSummary,
  LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM,
  LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM,
} = require('../server/jarvis-core/preferred-owner-monitor');

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  return db;
}

function insertProofRow(db, {
  targetTradingDay,
  firstCreatorSource = 'close_complete_checkpoint',
  ownershipSourceSpecificOutcome = 'first_autonomous_insert_by_close_complete_checkpoint',
  preferredOwnerWon = 1,
  preferredOwnerFailureReason = 'none',
}) {
  db.prepare(`
    INSERT INTO jarvis_live_preferred_owner_proof (
      target_trading_day,
      preferred_owner_expected_source,
      first_creator_source,
      first_creation_ownership_source_specific_outcome,
      preferred_owner_won,
      preferred_owner_failure_reason
    ) VALUES (?, 'close_complete_checkpoint', ?, ?, ?, ?)
  `).run(
    targetTradingDay,
    firstCreatorSource,
    ownershipSourceSpecificOutcome,
    preferredOwnerWon ? 1 : 0,
    preferredOwnerFailureReason
  );
}

function insertVerifierRow(db, {
  targetTradingDay,
  runId = 1,
  runOrigin = 'natural',
  runtimeSource = 'close_complete_checkpoint',
  checkpointStatus = 'success_inserted',
  verifierStatus = 'pass',
  verifierPass = true,
}) {
  db.prepare(`
    INSERT INTO jarvis_preferred_owner_post_close_verifier (
      target_trading_day,
      run_id,
      run_origin,
      runtime_source,
      checkpoint_status,
      verifier_status,
      verifier_pass,
      failure_reasons_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]')
  `).run(
    targetTradingDay,
    runId,
    runOrigin,
    runtimeSource,
    checkpointStatus,
    verifierStatus,
    verifierPass ? 1 : 0
  );
}

function insertNaturalWinRow(db, {
  targetTradingDay,
  runId = 1,
  runOrigin = 'natural',
  firstCreatorSource = 'close_complete_checkpoint',
}) {
  db.prepare(`
    INSERT INTO jarvis_preferred_owner_natural_wins (
      target_trading_day,
      run_id,
      first_creator_source,
      reservation_state,
      reservation_blocked_fallback,
      proof_row_id,
      run_origin,
      timestamp
    ) VALUES (?, ?, ?, 'reservation_released_after_preferred_owner_win', 0, NULL, ?, ?)
  `).run(
    targetTradingDay,
    runId,
    firstCreatorSource,
    runOrigin,
    `${targetTradingDay}T22:05:00.000Z`
  );
}

function insertWatcherRow(db, {
  targetTradingDay,
  triggerRunId = 1,
  runOrigin = 'natural',
  runtimeSource = 'close_complete_checkpoint',
  postStatus = 'success_inserted',
  drillOutcome = 'resolved_and_captured',
  executed = 1,
}) {
  db.prepare(`
    INSERT INTO jarvis_preferred_owner_natural_drill_watch_runs (
      target_trading_day,
      trigger_run_id,
      trigger_run_origin,
      trigger_runtime_source,
      pre_transition_checkpoint_status,
      post_transition_checkpoint_status,
      drill_outcome,
      executed,
      executed_at
    ) VALUES (?, ?, ?, ?, 'waiting_valid', ?, ?, ?, ?)
  `).run(
    targetTradingDay,
    triggerRunId,
    runOrigin,
    runtimeSource,
    postStatus,
    drillOutcome,
    executed,
    `${targetTradingDay}T22:10:00.000Z`
  );
}

function insertBundleRow(db, {
  targetTradingDay,
  runId = 1,
  runOrigin = 'natural',
  runtimeSource = 'close_complete_checkpoint',
  checkpointStatus = 'success_inserted',
  ownershipSourceSpecificOutcome = 'first_autonomous_insert_by_close_complete_checkpoint',
  verifierStatus = 'pass',
  verifierPass = true,
  naturalWinsLast5d = 1,
  naturalWinsTotal = 1,
  verifierPassesLast5d = 1,
  verifierFailsLast5d = 0,
}) {
  db.prepare(`
    INSERT INTO jarvis_preferred_owner_operational_proof_bundles (
      target_trading_day,
      run_id,
      run_origin,
      checkpoint_status,
      checkpoint_reason,
      runtime_checkpoint_source,
      preferred_owner_expected_source,
      preferred_owner_actual_source,
      preferred_owner_won,
      preferred_owner_failure_reason,
      ownership_source_specific_outcome,
      verifier_status,
      verifier_pass,
      verifier_failure_reasons_json,
      natural_preferred_owner_wins_last5d,
      natural_preferred_owner_wins_total,
      natural_preferred_owner_verifier_passes_last5d,
      natural_preferred_owner_verifier_fails_last5d,
      captured_at
    ) VALUES (?, ?, ?, ?, 'inserted_new_live_outcome', ?, 'close_complete_checkpoint', ?, ?, 'none', ?, ?, ?, '[]', ?, ?, ?, ?, ?)
  `).run(
    targetTradingDay,
    runId,
    runOrigin,
    checkpointStatus,
    runtimeSource,
    runtimeSource,
    verifierPass ? 1 : 0,
    ownershipSourceSpecificOutcome,
    verifierStatus,
    verifierPass ? 1 : 0,
    naturalWinsLast5d,
    naturalWinsTotal,
    verifierPassesLast5d,
    verifierFailsLast5d,
    `${targetTradingDay}T22:11:00.000Z`
  );
}

function assertSummaryLabel(result, expected) {
  assert.strictEqual(
    result.livePreferredOwnerMonitorLatestSummaryLabel,
    expected,
    `expected summary label ${expected} but got ${result.livePreferredOwnerMonitorLatestSummaryLabel}`
  );
  assert(
    LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM.includes(
      String(result.livePreferredOwnerMonitorLatestSummaryLabel || '')
    ),
    'summary label must be in bounded enum'
  );
  assert(
    Array.isArray(result.livePreferredOwnerMonitorMismatchReasons)
      && result.livePreferredOwnerMonitorMismatchReasons.every((reason) => (
        LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM.includes(String(reason || ''))
      )),
    'mismatch reasons must stay in bounded enum'
  );
}

function runTests() {
  {
    const db = makeDb();
    const target = '2026-03-13';
    insertProofRow(db, { targetTradingDay: target });
    insertVerifierRow(db, { targetTradingDay: target });
    insertNaturalWinRow(db, { targetTradingDay: target });
    insertWatcherRow(db, { targetTradingDay: target });
    insertBundleRow(db, { targetTradingDay: target });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'healthy_natural_win');
    assert.strictEqual(monitor.livePreferredOwnerMonitorConsistent, true);
    assert.strictEqual(monitor.livePreferredOwnerMonitorLatestVerifierPass, true);
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, true);
    assert(
      monitor.livePreferredOwnerOperatorSnapshot
        && typeof monitor.livePreferredOwnerOperatorSnapshot === 'object',
      'healthy natural win should expose canonical livePreferredOwnerOperatorSnapshot'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.targetTradingDay,
      target,
      'operator snapshot should use latest audited natural resolved target day'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.expectedSource,
      'close_complete_checkpoint',
      'operator snapshot expectedSource should stay close_complete_checkpoint'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.actualSource,
      'close_complete_checkpoint',
      'operator snapshot actualSource should resolve to close_complete_checkpoint'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.preferredOwnerWon,
      true,
      'operator snapshot should report preferredOwnerWon=true on healthy natural win'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.ownershipSourceSpecificOutcome,
      'first_autonomous_insert_by_close_complete_checkpoint',
      'operator snapshot should preserve ownershipSourceSpecificOutcome'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.verifierStatus,
      'pass',
      'operator snapshot should preserve verifierStatus'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.verifierPass,
      true,
      'operator snapshot should preserve verifierPass'
    );
    assert.strictEqual(
      Number(monitor.livePreferredOwnerOperatorSnapshot.verifierRunId || 0),
      1,
      'operator snapshot should preserve verifierRunId'
    );
    assert.deepStrictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.verifierFailureReasons,
      [],
      'operator snapshot should preserve verifierFailureReasons'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.watcherStatus,
      'already_executed_for_target_day',
      'operator snapshot watcherStatus should use persisted watcher truth'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.watcherExecuted,
      true,
      'operator snapshot watcherExecuted should use persisted watcher truth'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.watcherOutcome,
      'already_executed_for_target_day',
      'operator snapshot watcherOutcome should stay bounded to watcher outcome enum'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.proofBundleStatus,
      'pass',
      'operator snapshot proofBundleStatus should preserve bundle status'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.proofBundlePass,
      true,
      'operator snapshot proofBundlePass should preserve bundle pass'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.monitorSummaryLabel,
      'healthy_natural_win',
      'operator snapshot monitorSummaryLabel should align with healthy natural win'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.monitorResolvedSuccess,
      true,
      'operator snapshot monitorResolvedSuccess should align with healthy natural win'
    );
    assert.strictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.monitorConsistent,
      true,
      'operator snapshot monitorConsistent should remain true on healthy natural win'
    );
    assert.deepStrictEqual(
      monitor.livePreferredOwnerOperatorSnapshot.monitorMismatchReasons,
      [],
      'operator snapshot should keep monitorMismatchReasons empty on healthy natural win'
    );
  }

  {
    const db = makeDb();
    const target = '2026-03-13';
    insertProofRow(db, {
      targetTradingDay: target,
      ownershipSourceSpecificOutcome: 'ownership_source_unknown',
      preferredOwnerWon: 1,
    });
    insertVerifierRow(db, { targetTradingDay: target });
    insertNaturalWinRow(db, { targetTradingDay: target });
    insertWatcherRow(db, { targetTradingDay: target });
    insertBundleRow(db, {
      targetTradingDay: target,
      ownershipSourceSpecificOutcome: 'ownership_source_unknown',
      verifierStatus: 'pass',
      verifierPass: true,
    });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'healthy_natural_win');
    assert.strictEqual(
      monitor.livePreferredOwnerMonitorLatestOwnershipSourceSpecificOutcome,
      'first_autonomous_insert_by_close_complete_checkpoint',
      'healthy natural-win classification should derive strongest close_complete ownership source truth'
    );
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, true);
  }

  {
    const db = makeDb();
    const target = '2026-03-12';
    insertProofRow(db, {
      targetTradingDay: target,
      firstCreatorSource: 'manual_api_run',
      ownershipSourceSpecificOutcome: 'ownership_source_unknown',
      preferredOwnerWon: 0,
      preferredOwnerFailureReason: 'manual_owner_preempted',
    });
    insertVerifierRow(db, {
      targetTradingDay: target,
      runOrigin: 'manual',
      runtimeSource: 'manual_api_run',
      verifierStatus: 'pass',
      verifierPass: true,
    });
    insertBundleRow(db, {
      targetTradingDay: target,
      runOrigin: 'manual',
      runtimeSource: 'manual_api_run',
      ownershipSourceSpecificOutcome: 'ownership_source_unknown',
      verifierStatus: 'pass',
      verifierPass: true,
      naturalWinsLast5d: 0,
      naturalWinsTotal: 0,
      verifierPassesLast5d: 0,
      verifierFailsLast5d: 0,
    });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'healthy_manual_only');
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, true);
  }

  {
    const db = makeDb();
    const target = '2026-03-14';
    insertProofRow(db, {
      targetTradingDay: target,
      firstCreatorSource: 'manual_api_run',
      ownershipSourceSpecificOutcome: 'ownership_source_unknown',
      preferredOwnerWon: 0,
      preferredOwnerFailureReason: 'preferred_owner_not_yet_eligible',
    });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'healthy_waiting_next_day');
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, false);
  }

  {
    const db = makeDb();
    const target = '2026-03-15';
    insertProofRow(db, {
      targetTradingDay: target,
      preferredOwnerWon: 0,
      preferredOwnerFailureReason: 'preferred_owner_attempt_failed',
    });
    insertVerifierRow(db, {
      targetTradingDay: target,
      checkpointStatus: 'failure_missing_market_data',
      verifierStatus: 'fail',
      verifierPass: false,
    });
    insertWatcherRow(db, {
      targetTradingDay: target,
      postStatus: 'failure_missing_market_data',
      drillOutcome: 'resolved_but_verifier_failed',
    });
    insertBundleRow(db, {
      targetTradingDay: target,
      checkpointStatus: 'failure_missing_market_data',
      verifierStatus: 'fail',
      verifierPass: false,
      naturalWinsLast5d: 0,
      naturalWinsTotal: 0,
      verifierPassesLast5d: 0,
      verifierFailsLast5d: 1,
    });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'warning_verifier_failed');
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, false);
  }

  {
    const db = makeDb();
    const target = '2026-03-16';
    insertProofRow(db, { targetTradingDay: target });
    insertVerifierRow(db, { targetTradingDay: target });
    insertNaturalWinRow(db, { targetTradingDay: target });
    insertBundleRow(db, { targetTradingDay: target });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'warning_watcher_not_fired');
    assert(
      monitor.livePreferredOwnerMonitorMismatchReasons.includes('watcher_missing_for_resolved_day'),
      'missing watcher row should be surfaced as watcher_missing_for_resolved_day'
    );
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, false);
  }

  {
    const db = makeDb();
    const target = '2026-03-17';
    insertProofRow(db, { targetTradingDay: target });
    insertVerifierRow(db, { targetTradingDay: target });
    insertNaturalWinRow(db, { targetTradingDay: target });
    insertWatcherRow(db, { targetTradingDay: target });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'warning_bundle_missing');
    assert(
      monitor.livePreferredOwnerMonitorMismatchReasons.includes('bundle_missing_for_resolved_day'),
      'missing bundle row should be surfaced as bundle_missing_for_resolved_day'
    );
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, false);
  }

  {
    const db = makeDb();
    const target = '2026-03-18';
    insertProofRow(db, { targetTradingDay: target });
    insertVerifierRow(db, { targetTradingDay: target });
    insertNaturalWinRow(db, { targetTradingDay: target });
    insertWatcherRow(db, { targetTradingDay: target });
    insertBundleRow(db, {
      targetTradingDay: target,
      naturalWinsLast5d: 99,
      naturalWinsTotal: 99,
      verifierPassesLast5d: 99,
      verifierFailsLast5d: 99,
    });
    const monitor = buildPreferredOwnerMonitorSummary({ db, nowDate: target });
    assertSummaryLabel(monitor, 'warning_counter_mismatch');
    assert(
      monitor.livePreferredOwnerMonitorMismatchReasons.includes('counter_rollup_mismatch'),
      'counter disagreement should be surfaced as counter_rollup_mismatch'
    );
    assert.strictEqual(monitor.livePreferredOwnerMonitorConsistent, false);
    assert.strictEqual(monitor.livePreferredOwnerMonitorResolvedSuccess, false);
  }

  console.log('✅ preferred-owner monitor deterministic tests passed');
}

runTests();
