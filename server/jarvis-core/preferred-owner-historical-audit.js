'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
} = require('./data-foundation-storage');
const {
  buildPreferredOwnerOperatorSnapshot,
} = require('./preferred-owner-monitor');

const HISTORICAL_PREFERRED_OWNER_DAY_CLASSIFICATION_ENUM = Object.freeze([
  'historical_day_fully_consistent',
  'historical_day_upgradeable_weak_truth',
  'historical_day_inconsistent_proof_chain',
  'historical_day_missing_required_layer',
]);

const HISTORICAL_PREFERRED_OWNER_AUDIT_RESULT_ENUM = Object.freeze([
  'historical_preferred_owner_audit_clean',
  'historical_preferred_owner_audit_repaired',
  'historical_preferred_owner_audit_found_manual_review_days',
]);

const CLASSIFICATION_SET = new Set(HISTORICAL_PREFERRED_OWNER_DAY_CLASSIFICATION_ENUM);
const AUDIT_RESULT_SET = new Set(HISTORICAL_PREFERRED_OWNER_AUDIT_RESULT_ENUM);

const RUNTIME_SOURCE_SET = new Set([
  'startup_reconciliation',
  'startup_close_complete_checkpoint',
  'post_close_checkpoint',
  'close_complete_checkpoint',
  'late_data_recovery',
  'next_morning_recovery',
  'manual_api_run',
]);

const OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET = new Set([
  'first_autonomous_insert_by_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_reconciliation',
  'first_autonomous_insert_by_recovery_path',
  'first_manual_insert_of_day',
  'target_day_not_inserted_yet',
  'insert_not_required_invalid_day',
  'insert_not_required_missing_context',
  'insert_not_required_missing_market_data',
  'ownership_source_unknown',
]);

const OWNERSHIP_SOURCE_SPECIFIC_STRENGTH = Object.freeze({
  first_autonomous_insert_by_close_complete_checkpoint: 100,
  first_autonomous_insert_by_startup_close_complete_checkpoint: 95,
  first_autonomous_insert_by_startup_reconciliation: 90,
  first_autonomous_insert_by_recovery_path: 85,
  first_manual_insert_of_day: 80,
  target_day_not_inserted_yet: 40,
  insert_not_required_missing_context: 30,
  insert_not_required_missing_market_data: 30,
  insert_not_required_invalid_day: 20,
  ownership_source_unknown: 0,
});

const CHECKPOINT_STATUS_SET = new Set([
  'success_inserted',
  'success_already_finalized',
  'blocked_invalid_day',
  'failure_missing_context',
  'failure_missing_market_data',
  'failure_scheduler_miss',
  'failure_duplicate_state',
  'failure_unknown',
  'waiting_valid',
]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeFromSet(value, set, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized && set.has(normalized)) return normalized;
  return fallback;
}

function normalizeRuntimeSource(value = '') {
  return normalizeFromSet(value, RUNTIME_SOURCE_SET, 'manual_api_run');
}

function normalizeOwnershipSourceSpecificOutcome(value = '') {
  return normalizeFromSet(value, OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET, 'ownership_source_unknown');
}

function normalizeCheckpointStatus(value = '') {
  return normalizeFromSet(value, CHECKPOINT_STATUS_SET, 'waiting_valid');
}

function normalizeClassification(value = '') {
  return normalizeFromSet(
    value,
    CLASSIFICATION_SET,
    'historical_day_missing_required_layer'
  );
}

function normalizeAuditResult(value = '') {
  return normalizeFromSet(
    value,
    AUDIT_RESULT_SET,
    'historical_preferred_owner_audit_found_manual_review_days'
  );
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value || '').trim())
      .filter((value) => !!value);
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
        .map((value) => String(value || '').trim())
        .filter((value) => !!value)
      : [];
  } catch {
    return [];
  }
}

function mapStrongestProvableSourceSpecificOutcome({
  preferredOwnerWon = false,
  firstCreatorSource = '',
} = {}) {
  if (preferredOwnerWon !== true) return null;
  const source = normalizeRuntimeSource(firstCreatorSource || '');
  if (source === 'close_complete_checkpoint') {
    return 'first_autonomous_insert_by_close_complete_checkpoint';
  }
  if (source === 'startup_close_complete_checkpoint') {
    return 'first_autonomous_insert_by_startup_close_complete_checkpoint';
  }
  if (source === 'startup_reconciliation') {
    return 'first_autonomous_insert_by_startup_reconciliation';
  }
  if (
    source === 'post_close_checkpoint'
    || source === 'late_data_recovery'
    || source === 'next_morning_recovery'
  ) {
    return 'first_autonomous_insert_by_recovery_path';
  }
  if (source === 'manual_api_run') {
    return 'first_manual_insert_of_day';
  }
  return null;
}

function strongestOutcomeValue(values = []) {
  let best = 'ownership_source_unknown';
  let bestScore = OWNERSHIP_SOURCE_SPECIFIC_STRENGTH.ownership_source_unknown;
  for (const value of values) {
    const normalized = normalizeOwnershipSourceSpecificOutcome(value || '');
    const score = toNumber(OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[normalized], 0);
    if (score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }
  return best;
}

function readSingleRow(db, tableName, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT *
      FROM ${tableName}
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readRows(db, tableName, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!target) return [];
  try {
    return db.prepare(`
      SELECT *
      FROM ${tableName}
      WHERE target_trading_day = ?
      ORDER BY id ASC
    `).all(target) || [];
  } catch {
    return [];
  }
}

function collectTargetTradingDays(db) {
  if (!db || typeof db.prepare !== 'function') return [];
  const rows = db.prepare(`
    SELECT target_trading_day AS target_day FROM jarvis_live_preferred_owner_proof
    UNION
    SELECT target_trading_day AS target_day FROM jarvis_preferred_owner_post_close_verifier
    UNION
    SELECT target_trading_day AS target_day FROM jarvis_preferred_owner_natural_wins
    UNION
    SELECT target_trading_day AS target_day FROM jarvis_preferred_owner_deferrals
    UNION
    SELECT target_trading_day AS target_day FROM jarvis_preferred_owner_operational_verdicts
    UNION
    SELECT target_trading_day AS target_day FROM jarvis_preferred_owner_operational_proof_bundles
    UNION
    SELECT target_trading_day AS target_day FROM jarvis_live_outcome_ownership
    ORDER BY target_day ASC
  `).all();
  return rows
    .map((row) => normalizeDate(row?.target_day || ''))
    .filter(Boolean);
}

function isResolvedDay(verifierRow, verdictRow, bundleRow) {
  const statuses = [
    normalizeCheckpointStatus(verifierRow?.checkpoint_status || ''),
    normalizeCheckpointStatus(verdictRow?.checkpoint_status || ''),
    normalizeCheckpointStatus(bundleRow?.checkpoint_status || ''),
  ];
  return statuses.some((status) => status !== 'waiting_valid');
}

function buildExpectedMonitorSummary({
  resolved = false,
  verifierExists = false,
  verifierPass = false,
  bundleExists = false,
  bundlePass = false,
  preferredOwnerWon = false,
  runOrigin = 'manual',
  runtimeSource = 'manual_api_run',
} = {}) {
  if (!resolved || verifierExists !== true) return 'healthy_waiting_next_day';
  if (verifierPass !== true) return 'warning_verifier_failed';
  if (bundleExists !== true) return 'warning_bundle_missing';
  if (
    runOrigin === 'natural'
    && runtimeSource === 'close_complete_checkpoint'
    && preferredOwnerWon === true
    && bundlePass === true
  ) {
    return 'healthy_natural_win';
  }
  return 'healthy_manual_only';
}

function getRunOriginPriority(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'natural') return 2;
  if (normalized === 'manual') return 1;
  return 0;
}

function getRuntimeSourcePriority(value = '') {
  const normalized = normalizeRuntimeSource(value || '');
  if (normalized === 'close_complete_checkpoint') return 3;
  if (normalized === 'post_close_checkpoint') return 2;
  if (normalized === 'next_morning_recovery' || normalized === 'late_data_recovery') return 1;
  return 0;
}

function evaluateDayIntegrity(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!target) return null;

  const proofRow = readSingleRow(db, 'jarvis_live_preferred_owner_proof', target);
  const verifierRow = readSingleRow(db, 'jarvis_preferred_owner_post_close_verifier', target);
  const naturalWinRow = readSingleRow(db, 'jarvis_preferred_owner_natural_wins', target);
  const deferralRows = readRows(db, 'jarvis_preferred_owner_deferrals', target);
  const verdictRow = readSingleRow(db, 'jarvis_preferred_owner_operational_verdicts', target);
  const bundleRow = readSingleRow(db, 'jarvis_preferred_owner_operational_proof_bundles', target);
  const ownershipRow = readSingleRow(db, 'jarvis_live_outcome_ownership', target);
  const snapshot = buildPreferredOwnerOperatorSnapshot({ db, targetTradingDay: target });

  const resolved = isResolvedDay(verifierRow, verdictRow, bundleRow);
  const proofExists = !!proofRow;
  const verifierExists = !!verifierRow;
  const verdictExists = !!verdictRow;
  const bundleExists = !!bundleRow;
  const naturalWinExists = !!naturalWinRow;
  const ownershipExists = !!ownershipRow;
  const preferredOwnerWon = toBool(proofRow?.preferred_owner_won);
  const verifierPass = toBool(verifierRow?.verifier_pass);
  const bundlePass = toBool(bundleRow?.verifier_pass);
  const runOrigin = normalizeFromSet(
    verifierRow?.run_origin || bundleRow?.run_origin || verdictRow?.run_origin || 'manual',
    new Set(['natural', 'manual']),
    'manual'
  );
  const runtimeSource = normalizeRuntimeSource(
    verifierRow?.runtime_source
      || bundleRow?.runtime_checkpoint_source
      || verdictRow?.runtime_checkpoint_source
      || proofRow?.first_creator_source
      || 'manual_api_run'
  );
  const expectedSource = normalizeRuntimeSource(
    proofRow?.preferred_owner_expected_source
      || verdictRow?.preferred_owner_expected_source
      || bundleRow?.preferred_owner_expected_source
      || 'close_complete_checkpoint'
  );
  const actualSource = normalizeRuntimeSource(
    proofRow?.first_creator_source
      || ownershipRow?.first_run_source
      || verdictRow?.preferred_owner_actual_source
      || bundleRow?.preferred_owner_actual_source
      || 'manual_api_run'
  );

  const proofSourceSpecific = normalizeOwnershipSourceSpecificOutcome(
    proofRow?.first_creation_ownership_source_specific_outcome || ''
  );
  const verdictSourceSpecific = normalizeOwnershipSourceSpecificOutcome(
    verdictRow?.ownership_source_specific_outcome || ''
  );
  const bundleSourceSpecific = normalizeOwnershipSourceSpecificOutcome(
    bundleRow?.ownership_source_specific_outcome || ''
  );
  const strongestPersistedSourceSpecific = strongestOutcomeValue([
    proofSourceSpecific,
    verdictSourceSpecific,
    bundleSourceSpecific,
  ]);
  const strongestProvableSourceSpecific = mapStrongestProvableSourceSpecificOutcome({
    preferredOwnerWon,
    firstCreatorSource: proofRow?.first_creator_source || ownershipRow?.first_run_source || '',
  });

  const missingRequiredLayers = [];
  if (!proofExists) missingRequiredLayers.push('preferred_owner_proof');
  if (!ownershipExists) missingRequiredLayers.push('live_outcome_ownership');
  if (!verifierExists) missingRequiredLayers.push('verifier');
  if (!verdictExists) missingRequiredLayers.push('operational_verdict');
  if (!bundleExists) missingRequiredLayers.push('proof_bundle');
  if (
    verifierExists
    && runOrigin === 'natural'
    && runtimeSource === 'close_complete_checkpoint'
    && verifierPass === true
    && preferredOwnerWon === true
    && !naturalWinExists
  ) {
    missingRequiredLayers.push('natural_win_row');
  }

  const inconsistencyReasons = [];
  if (verifierExists && proofExists && verifierPass === true && preferredOwnerWon !== true) {
    inconsistencyReasons.push('verifier_pass_proof_not_won');
  }
  if (verifierExists && bundleExists && verifierPass !== bundlePass) {
    inconsistencyReasons.push('verifier_bundle_pass_mismatch');
  }
  if (bundleExists && proofExists && toBool(bundleRow?.preferred_owner_won) !== preferredOwnerWon) {
    inconsistencyReasons.push('bundle_proof_preferred_owner_won_mismatch');
  }
  if (
    verdictExists
    && verifierExists
    && toBool(verdictRow?.verifier_pass) !== verifierPass
  ) {
    inconsistencyReasons.push('verdict_verifier_pass_mismatch');
  }
  if (
    verdictExists
    && proofExists
    && normalizeRuntimeSource(verdictRow?.preferred_owner_actual_source || '')
      !== normalizeRuntimeSource(proofRow?.first_creator_source || '')
  ) {
    inconsistencyReasons.push('verdict_proof_actual_source_mismatch');
  }
  if (
    bundleExists
    && proofExists
    && normalizeRuntimeSource(bundleRow?.preferred_owner_actual_source || '')
      !== normalizeRuntimeSource(proofRow?.first_creator_source || '')
  ) {
    inconsistencyReasons.push('bundle_proof_actual_source_mismatch');
  }
  if (
    naturalWinExists
    && normalizeRuntimeSource(naturalWinRow?.first_creator_source || '')
      !== normalizeRuntimeSource(proofRow?.first_creator_source || '')
  ) {
    inconsistencyReasons.push('natural_win_proof_first_creator_source_mismatch');
  }
  if (parseJsonArray(verifierRow?.failure_reasons_json || '[]').includes('target_day_mismatch')) {
    inconsistencyReasons.push('verifier_target_day_mismatch');
  }
  if (parseJsonArray(verifierRow?.failure_reasons_json || '[]').includes('kpi_table_mismatch')) {
    inconsistencyReasons.push('verifier_kpi_table_mismatch');
  }

  const repairCandidates = [];
  if (
    strongestProvableSourceSpecific
    && proofExists
    && OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[proofSourceSpecific]
      < OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[strongestProvableSourceSpecific]
  ) {
    repairCandidates.push({
      table: 'jarvis_live_preferred_owner_proof',
      column: 'first_creation_ownership_source_specific_outcome',
      before: proofSourceSpecific,
      after: strongestProvableSourceSpecific,
    });
  }
  if (
    strongestProvableSourceSpecific
    && verdictExists
    && OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[verdictSourceSpecific]
      < OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[strongestProvableSourceSpecific]
  ) {
    repairCandidates.push({
      table: 'jarvis_preferred_owner_operational_verdicts',
      column: 'ownership_source_specific_outcome',
      before: verdictSourceSpecific,
      after: strongestProvableSourceSpecific,
    });
  }
  if (
    strongestProvableSourceSpecific
    && bundleExists
    && OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[bundleSourceSpecific]
      < OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[strongestProvableSourceSpecific]
  ) {
    repairCandidates.push({
      table: 'jarvis_preferred_owner_operational_proof_bundles',
      column: 'ownership_source_specific_outcome',
      before: bundleSourceSpecific,
      after: strongestProvableSourceSpecific,
    });
  }

  const expectedSummaryLabel = buildExpectedMonitorSummary({
    resolved,
    verifierExists,
    verifierPass,
    bundleExists,
    bundlePass,
    preferredOwnerWon,
    runOrigin,
    runtimeSource,
  });
  const snapshotSummaryLabel = String(snapshot?.monitorSummaryLabel || 'healthy_waiting_next_day');
  const monitorSummaryLabelMatchesPersistedTruth = expectedSummaryLabel === snapshotSummaryLabel;

  const canonicalSnapshotMismatchReasons = [];
  if (snapshot?.targetTradingDay !== target) {
    canonicalSnapshotMismatchReasons.push('target_day_mismatch');
  }
  if (snapshot?.expectedSource !== expectedSource) {
    canonicalSnapshotMismatchReasons.push('expected_source_mismatch');
  }
  if (normalizeRuntimeSource(snapshot?.actualSource || '') !== actualSource) {
    canonicalSnapshotMismatchReasons.push('actual_source_mismatch');
  }
  if (toBool(snapshot?.preferredOwnerWon) !== preferredOwnerWon) {
    canonicalSnapshotMismatchReasons.push('preferred_owner_won_mismatch');
  }
  if (
    strongestProvableSourceSpecific
    && normalizeOwnershipSourceSpecificOutcome(snapshot?.ownershipSourceSpecificOutcome || '')
      !== normalizeOwnershipSourceSpecificOutcome(strongestProvableSourceSpecific)
  ) {
    canonicalSnapshotMismatchReasons.push('source_specific_outcome_mismatch');
  }
  if (!monitorSummaryLabelMatchesPersistedTruth) {
    canonicalSnapshotMismatchReasons.push('monitor_summary_label_mismatch');
  }

  const canonicalSnapshotCorrect = canonicalSnapshotMismatchReasons.length === 0;
  let classification = 'historical_day_fully_consistent';
  if (inconsistencyReasons.length > 0) {
    classification = 'historical_day_inconsistent_proof_chain';
  } else if (missingRequiredLayers.length > 0) {
    classification = 'historical_day_missing_required_layer';
  } else if (repairCandidates.length > 0) {
    classification = 'historical_day_upgradeable_weak_truth';
  }

  return {
    targetTradingDay: target,
    classification: normalizeClassification(classification),
    preferredOwnerWon,
    firstCreatorSource: proofRow?.first_creator_source || ownershipRow?.first_run_source || null,
    strongestProvableSourceSpecificOutcome: strongestProvableSourceSpecific || 'ownership_source_unknown',
    strongestPersistedSourceSpecificOutcome: strongestPersistedSourceSpecific,
    verifierAgreesWithProof: (
      !verifierExists
      || (
        (verifierPass === preferredOwnerWon)
        || (preferredOwnerWon === true && verifierPass === true)
      )
    ),
    proofBundleAgreesWithProofAndVerifier: (
      !bundleExists
      || (
        bundlePass === verifierPass
        && toBool(bundleRow?.preferred_owner_won) === preferredOwnerWon
      )
    ),
    monitorSummaryLabelMatchesPersistedTruth,
    expectedMonitorSummaryLabel: expectedSummaryLabel,
    actualMonitorSummaryLabel: snapshotSummaryLabel,
    canonicalSnapshotCorrect,
    canonicalSnapshotMismatchReasons,
    repairable: repairCandidates.length > 0,
    repairCandidates,
    inconsistencyReasons,
    missingRequiredLayers,
    resolved,
    rows: {
      jarvis_live_preferred_owner_proof: proofRow,
      jarvis_preferred_owner_post_close_verifier: verifierRow,
      jarvis_preferred_owner_natural_wins: naturalWinRow,
      jarvis_preferred_owner_deferrals: deferralRows,
      jarvis_preferred_owner_operational_verdicts: verdictRow,
      jarvis_preferred_owner_operational_proof_bundles: bundleRow,
      jarvis_live_outcome_ownership: ownershipRow,
    },
    snapshot,
    advisoryOnly: true,
  };
}

function applyRepairCandidate(db, targetTradingDay, candidate) {
  const target = normalizeDate(targetTradingDay || '');
  if (!target || !candidate || !candidate.table || !candidate.column) return null;
  const table = String(candidate.table);
  const column = String(candidate.column);
  const before = normalizeOwnershipSourceSpecificOutcome(candidate.before || '');
  const after = normalizeOwnershipSourceSpecificOutcome(candidate.after || '');
  if (
    !OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET.has(after)
    || OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[after] <= OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[before]
  ) {
    return null;
  }
  let rowBefore = null;
  let rowAfter = null;
  try {
    rowBefore = db.prepare(`
      SELECT *
      FROM ${table}
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target);
  } catch {
    return null;
  }
  const beforeValue = normalizeOwnershipSourceSpecificOutcome(rowBefore?.[column] || '');
  if (
    OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[beforeValue]
      >= OWNERSHIP_SOURCE_SPECIFIC_STRENGTH[after]
  ) {
    return null;
  }

  try {
    db.prepare(`
      UPDATE ${table}
      SET ${column} = ?
      WHERE target_trading_day = ?
    `).run(after, target);
    rowAfter = db.prepare(`
      SELECT *
      FROM ${table}
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target);
  } catch {
    return null;
  }
  return {
    targetTradingDay: target,
    table,
    column,
    before: beforeValue,
    after: normalizeOwnershipSourceSpecificOutcome(rowAfter?.[column] || ''),
    beforeRow: rowBefore,
    afterRow: rowAfter,
  };
}

function runPreferredOwnerHistoricalIntegrityAudit(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      finalResult: normalizeAuditResult('historical_preferred_owner_audit_found_manual_review_days'),
      totalAuditedTargetDays: 0,
      dayClassifications: [],
      bucketCounts: {
        historical_day_fully_consistent: 0,
        historical_day_upgradeable_weak_truth: 0,
        historical_day_inconsistent_proof_chain: 0,
        historical_day_missing_required_layer: 0,
      },
      noActionTargetDays: [],
      safelyRepairableTargetDays: [],
      repairedTargetDays: [],
      manualReviewTargetDays: [],
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);
  const applyRepairs = input.applyRepairs === true;
  const targetDays = collectTargetTradingDays(db);

  const beforeEvaluations = targetDays
    .map((day) => evaluateDayIntegrity(db, day))
    .filter(Boolean);
  const safelyRepairableTargetDays = beforeEvaluations
    .filter((evaluation) => evaluation.repairable === true)
    .map((evaluation) => evaluation.targetTradingDay);

  const repairedTargetDays = [];
  if (applyRepairs) {
    db.exec('BEGIN');
    try {
      for (const evaluation of beforeEvaluations) {
        if (!Array.isArray(evaluation.repairCandidates) || evaluation.repairCandidates.length === 0) continue;
        const rowRepairs = [];
        for (const candidate of evaluation.repairCandidates) {
          const repaired = applyRepairCandidate(db, evaluation.targetTradingDay, candidate);
          if (repaired) rowRepairs.push(repaired);
        }
        if (rowRepairs.length > 0) {
          repairedTargetDays.push({
            targetTradingDay: evaluation.targetTradingDay,
            repairs: rowRepairs,
            before: evaluation.rows,
          });
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const dayClassifications = targetDays
    .map((day) => evaluateDayIntegrity(db, day))
    .filter(Boolean);

  for (const repaired of repairedTargetDays) {
    const afterEvaluation = dayClassifications.find(
      (entry) => entry.targetTradingDay === repaired.targetTradingDay
    );
    repaired.after = afterEvaluation?.rows || null;
  }

  const bucketCounts = {
    historical_day_fully_consistent: 0,
    historical_day_upgradeable_weak_truth: 0,
    historical_day_inconsistent_proof_chain: 0,
    historical_day_missing_required_layer: 0,
  };
  for (const day of dayClassifications) {
    const key = normalizeClassification(day.classification);
    bucketCounts[key] = toNumber(bucketCounts[key], 0) + 1;
  }

  const noActionTargetDays = dayClassifications
    .filter((day) => day.classification === 'historical_day_fully_consistent')
    .map((day) => day.targetTradingDay);
  const manualReviewTargetDays = dayClassifications
    .filter((day) => (
      day.classification === 'historical_day_inconsistent_proof_chain'
      || day.classification === 'historical_day_missing_required_layer'
    ))
    .map((day) => day.targetTradingDay);

  let finalResult = 'historical_preferred_owner_audit_clean';
  if (manualReviewTargetDays.length > 0) {
    finalResult = 'historical_preferred_owner_audit_found_manual_review_days';
  } else if (repairedTargetDays.length > 0) {
    finalResult = 'historical_preferred_owner_audit_repaired';
  }

  return {
    generatedAt: new Date().toISOString(),
    applyRepairs,
    finalResult: normalizeAuditResult(finalResult),
    totalAuditedTargetDays: dayClassifications.length,
    bucketCounts,
    dayClassifications,
    noActionTargetDays,
    safelyRepairableTargetDays,
    repairedTargetDays,
    manualReviewTargetDays,
    advisoryOnly: true,
  };
}

module.exports = {
  HISTORICAL_PREFERRED_OWNER_DAY_CLASSIFICATION_ENUM,
  HISTORICAL_PREFERRED_OWNER_AUDIT_RESULT_ENUM,
  mapStrongestProvableSourceSpecificOutcome,
  evaluateDayIntegrity,
  runPreferredOwnerHistoricalIntegrityAudit,
};
