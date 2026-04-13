#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  HISTORICAL_PREFERRED_OWNER_DAY_CLASSIFICATION_ENUM,
  HISTORICAL_PREFERRED_OWNER_AUDIT_RESULT_ENUM,
  evaluateDayIntegrity,
  runPreferredOwnerHistoricalIntegrityAudit,
} = require('../server/jarvis-core/preferred-owner-historical-audit');

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  return db;
}

function insertOwnershipRow(db, {
  targetTradingDay,
  rowId = null,
  firstRunId = 1,
  firstRunMode = 'scheduled_close_complete_checkpoint',
  firstRunSource = 'close_complete_checkpoint',
  firstInsertedAutonomous = 1,
}) {
  db.prepare(`
    INSERT INTO jarvis_live_outcome_ownership (
      target_trading_day,
      created_row_id,
      first_run_id,
      first_run_mode,
      first_run_source,
      first_insert_sla_outcome,
      first_inserted_at,
      first_inserted_autonomous
    ) VALUES (?, ?, ?, ?, ?, 'insert_required_success_on_time', ?, ?)
  `).run(
    targetTradingDay,
    rowId,
    firstRunId,
    firstRunMode,
    firstRunSource,
    `${targetTradingDay}T22:00:00.000Z`,
    firstInsertedAutonomous ? 1 : 0
  );
}

function insertProofRow(db, {
  targetTradingDay,
  firstCreatorSource = 'close_complete_checkpoint',
  preferredOwnerWon = 1,
  failureReason = 'none',
  sourceSpecific = 'first_autonomous_insert_by_close_complete_checkpoint',
  runId = 1,
}) {
  db.prepare(`
    INSERT INTO jarvis_live_preferred_owner_proof (
      target_trading_day,
      preferred_owner_expected_source,
      first_row_id,
      first_creator_run_id,
      first_creator_mode,
      first_creator_source,
      first_creator_autonomous,
      first_creation_timestamp,
      first_creation_checkpoint_status,
      first_creation_attempt_result,
      first_creation_proof_outcome,
      first_creation_ownership_outcome,
      first_creation_ownership_source_specific_outcome,
      preferred_owner_won,
      preferred_owner_won_first_eligible_cycle,
      preferred_owner_failure_reason,
      preferred_owner_proof_captured_at
    ) VALUES (
      ?, 'close_complete_checkpoint', ?, ?, 'scheduled_close_complete_checkpoint', ?, 1, ?,
      'success_inserted', 'attempt_executed_success', 'proof_attempted_success',
      'first_autonomous_insert_of_day', ?, ?, ?, ?, ?
    )
  `).run(
    targetTradingDay,
    runId + 100,
    runId,
    firstCreatorSource,
    `${targetTradingDay}T22:00:00.000Z`,
    sourceSpecific,
    preferredOwnerWon ? 1 : 0,
    preferredOwnerWon ? 1 : 0,
    failureReason,
    `${targetTradingDay}T22:01:00.000Z`
  );
}

function insertVerifierRow(db, {
  targetTradingDay,
  runId = 1,
  runOrigin = 'natural',
  runtimeSource = 'close_complete_checkpoint',
  checkpointStatus = 'success_inserted',
  verifierStatus = 'pass',
  verifierPass = 1,
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
      failure_reasons_json,
      summary_json,
      verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?)
  `).run(
    targetTradingDay,
    runId,
    runOrigin,
    runtimeSource,
    checkpointStatus,
    verifierStatus,
    verifierPass ? 1 : 0,
    `${targetTradingDay}T22:05:00.000Z`
  );
}

function insertVerdictRow(db, {
  targetTradingDay,
  runId = 1,
  runOrigin = 'natural',
  runtimeSource = 'close_complete_checkpoint',
  checkpointStatus = 'success_inserted',
  verifierPass = 1,
  verifierStatus = 'pass',
  ownershipSourceSpecific = 'first_autonomous_insert_by_close_complete_checkpoint',
}) {
  db.prepare(`
    INSERT INTO jarvis_preferred_owner_operational_verdicts (
      target_trading_day,
      run_id,
      run_origin,
      runtime_checkpoint_source,
      checkpoint_status,
      preferred_owner_expected_source,
      preferred_owner_actual_source,
      verifier_status,
      verifier_pass,
      verifier_failure_reasons_json,
      ownership_source_specific_outcome,
      natural_preferred_owner_wins_last5d,
      natural_preferred_owner_wins_total,
      natural_preferred_owner_verifier_passes_last5d,
      natural_preferred_owner_verifier_fails_last5d,
      reported_at
    ) VALUES (?, ?, ?, ?, ?, 'close_complete_checkpoint', ?, ?, ?, '[]', ?, 1, 1, ?, ?, ?)
  `).run(
    targetTradingDay,
    runId,
    runOrigin,
    runtimeSource,
    checkpointStatus,
    runtimeSource,
    verifierStatus,
    verifierPass ? 1 : 0,
    ownershipSourceSpecific,
    verifierPass ? 1 : 0,
    verifierPass ? 0 : 1,
    `${targetTradingDay}T22:08:00.000Z`
  );
}

function insertBundleRow(db, {
  targetTradingDay,
  runId = 1,
  runOrigin = 'natural',
  runtimeSource = 'close_complete_checkpoint',
  checkpointStatus = 'success_inserted',
  preferredOwnerWon = 1,
  verifierPass = 1,
  verifierStatus = 'pass',
  ownershipSourceSpecific = 'first_autonomous_insert_by_close_complete_checkpoint',
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
    ) VALUES (?, ?, ?, ?, 'inserted_new_live_outcome', ?, 'close_complete_checkpoint', ?, ?, 'none', ?, ?, ?, '[]', 1, 1, ?, ?, ?)
  `).run(
    targetTradingDay,
    runId,
    runOrigin,
    checkpointStatus,
    runtimeSource,
    runtimeSource,
    preferredOwnerWon ? 1 : 0,
    ownershipSourceSpecific,
    verifierStatus,
    verifierPass ? 1 : 0,
    verifierPass ? 1 : 0,
    verifierPass ? 0 : 1,
    `${targetTradingDay}T22:09:00.000Z`
  );
}

function insertNaturalWinRow(db, {
  targetTradingDay,
  runId = 1,
  firstCreatorSource = 'close_complete_checkpoint',
  runOrigin = 'natural',
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
    ) VALUES (?, ?, ?, 'reservation_released_after_preferred_owner_win', 1, ?, ?, ?)
  `).run(
    targetTradingDay,
    runId,
    firstCreatorSource,
    runId,
    runOrigin,
    `${targetTradingDay}T22:10:00.000Z`
  );
}

function setupHistory(db) {
  const fullyConsistent = '2026-03-13';
  insertOwnershipRow(db, { targetTradingDay: fullyConsistent, rowId: 501, firstRunId: 10 });
  insertProofRow(db, { targetTradingDay: fullyConsistent, runId: 10 });
  insertVerifierRow(db, { targetTradingDay: fullyConsistent, runId: 10 });
  insertVerdictRow(db, { targetTradingDay: fullyConsistent, runId: 10 });
  insertBundleRow(db, { targetTradingDay: fullyConsistent, runId: 10 });
  insertNaturalWinRow(db, { targetTradingDay: fullyConsistent, runId: 10 });

  const weakUpgradeable = '2026-03-12';
  insertOwnershipRow(db, { targetTradingDay: weakUpgradeable, rowId: 500, firstRunId: 9 });
  insertProofRow(db, {
    targetTradingDay: weakUpgradeable,
    runId: 9,
    sourceSpecific: 'ownership_source_unknown',
    preferredOwnerWon: 1,
  });
  insertVerifierRow(db, { targetTradingDay: weakUpgradeable, runId: 9 });
  insertVerdictRow(db, {
    targetTradingDay: weakUpgradeable,
    runId: 9,
    ownershipSourceSpecific: 'ownership_source_unknown',
  });
  insertBundleRow(db, {
    targetTradingDay: weakUpgradeable,
    runId: 9,
    ownershipSourceSpecific: 'ownership_source_unknown',
  });
  insertNaturalWinRow(db, { targetTradingDay: weakUpgradeable, runId: 9 });

  const inconsistent = '2026-03-11';
  insertOwnershipRow(db, { targetTradingDay: inconsistent, rowId: 499, firstRunId: 8 });
  insertProofRow(db, {
    targetTradingDay: inconsistent,
    runId: 8,
    preferredOwnerWon: 0,
    failureReason: 'startup_owner_preempted_before_close_complete',
    firstCreatorSource: 'startup_reconciliation',
    sourceSpecific: 'ownership_source_unknown',
  });
  insertVerifierRow(db, { targetTradingDay: inconsistent, runId: 8, verifierPass: 1, verifierStatus: 'pass' });
  insertVerdictRow(db, {
    targetTradingDay: inconsistent,
    runId: 8,
    runtimeSource: 'startup_reconciliation',
    verifierPass: 1,
    verifierStatus: 'pass',
    ownershipSourceSpecific: 'ownership_source_unknown',
  });
  insertBundleRow(db, {
    targetTradingDay: inconsistent,
    runId: 8,
    runtimeSource: 'startup_reconciliation',
    preferredOwnerWon: 0,
    verifierPass: 1,
    verifierStatus: 'pass',
    ownershipSourceSpecific: 'ownership_source_unknown',
  });

  const missingLayer = '2026-03-10';
  insertProofRow(db, {
    targetTradingDay: missingLayer,
    runId: 7,
    preferredOwnerWon: 1,
    sourceSpecific: 'ownership_source_unknown',
  });
}

function runTests() {
  assert(
    HISTORICAL_PREFERRED_OWNER_DAY_CLASSIFICATION_ENUM.includes('historical_day_upgradeable_weak_truth'),
    'classification enum should include historical_day_upgradeable_weak_truth'
  );
  assert(
    HISTORICAL_PREFERRED_OWNER_AUDIT_RESULT_ENUM.includes('historical_preferred_owner_audit_found_manual_review_days'),
    'audit result enum should include historical_preferred_owner_audit_found_manual_review_days'
  );

  const db = makeDb();
  setupHistory(db);

  const dayConsistent = evaluateDayIntegrity(db, '2026-03-13');
  assert(dayConsistent, 'fully-consistent day should evaluate');
  assert.strictEqual(
    dayConsistent.classification,
    'historical_day_fully_consistent',
    'natural close-complete pass day should classify as fully consistent'
  );

  const dayWeak = evaluateDayIntegrity(db, '2026-03-12');
  assert(dayWeak, 'weak day should evaluate');
  assert.strictEqual(
    dayWeak.classification,
    'historical_day_upgradeable_weak_truth',
    'weak source-specific day with full proof chain should classify as upgradeable weak truth'
  );
  assert(dayWeak.repairable === true, 'weak source-specific day should be repairable');

  const dayInconsistent = evaluateDayIntegrity(db, '2026-03-11');
  assert(dayInconsistent, 'inconsistent day should evaluate');
  assert.strictEqual(
    dayInconsistent.classification,
    'historical_day_inconsistent_proof_chain',
    'proof/verifier disagreement should classify as inconsistent proof chain'
  );

  const dayMissing = evaluateDayIntegrity(db, '2026-03-10');
  assert(dayMissing, 'missing-layer day should evaluate');
  assert.strictEqual(
    dayMissing.classification,
    'historical_day_missing_required_layer',
    'day missing required persisted layers should classify as missing required layer'
  );

  const auditReadOnly = runPreferredOwnerHistoricalIntegrityAudit({ db, applyRepairs: false });
  assert.strictEqual(auditReadOnly.applyRepairs, false, 'read-only audit should not apply repairs');
  assert.strictEqual(
    Number(auditReadOnly.totalAuditedTargetDays || 0),
    4,
    'audit should include four target days'
  );
  assert.strictEqual(
    Number(auditReadOnly.bucketCounts.historical_day_upgradeable_weak_truth || 0),
    1,
    'read-only audit should keep one upgradeable weak-truth day'
  );

  const auditRepaired = runPreferredOwnerHistoricalIntegrityAudit({ db, applyRepairs: true });
  assert.strictEqual(auditRepaired.applyRepairs, true, 'repair audit should run with applyRepairs=true');
  assert(
    Array.isArray(auditRepaired.repairedTargetDays)
      && auditRepaired.repairedTargetDays.some((row) => row.targetTradingDay === '2026-03-12'),
    'repair audit should repair the upgradeable weak-truth day'
  );
  assert.strictEqual(
    Number(auditRepaired.bucketCounts.historical_day_upgradeable_weak_truth || 0),
    0,
    'post-repair audit should remove upgradeable weak-truth classification'
  );
  assert.strictEqual(
    auditRepaired.finalResult,
    'historical_preferred_owner_audit_found_manual_review_days',
    'manual review days should keep bounded final result as found_manual_review_days'
  );

  const repairedProof = db.prepare(`
    SELECT first_creation_ownership_source_specific_outcome AS source_specific
    FROM jarvis_live_preferred_owner_proof
    WHERE target_trading_day = '2026-03-12'
  `).get();
  assert.strictEqual(
    String(repairedProof?.source_specific || ''),
    'first_autonomous_insert_by_close_complete_checkpoint',
    'repair audit should upgrade proof source-specific outcome deterministically'
  );

  console.log('✅ preferred-owner historical audit deterministic tests passed');
}

runTests();

