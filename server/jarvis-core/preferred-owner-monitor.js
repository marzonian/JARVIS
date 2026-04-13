'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  toText,
} = require('./data-foundation-storage');

const LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM = Object.freeze([
  'healthy_natural_win',
  'healthy_manual_only',
  'healthy_waiting_next_day',
  'warning_verifier_failed',
  'warning_watcher_not_fired',
  'warning_bundle_missing',
  'warning_counter_mismatch',
]);

const LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_SET = new Set(
  LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM
);

const LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM = Object.freeze([
  'watcher_missing_for_resolved_day',
  'verifier_missing_for_resolved_day',
  'bundle_missing_for_resolved_day',
  'natural_win_missing_for_verified_pass',
  'counter_rollup_mismatch',
  'target_day_alignment_mismatch',
]);

const LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_SET = new Set(
  LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM
);

const MONITOR_CONSISTENCY_HARD_FAILURE_REASON_SET = new Set([
  'counter_rollup_mismatch',
  'target_day_alignment_mismatch',
]);

const RUN_ORIGIN_SET = new Set(['natural', 'manual']);
const RUNTIME_SOURCE_SET = new Set([
  'startup_reconciliation',
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
const VERIFIER_STATUS_SET = new Set(['pass', 'fail']);
const WATCHER_STATUS_SET = new Set([
  'waiting_for_resolution',
  'triggered_and_executed',
  'already_executed_for_target_day',
  'resolved_but_not_close_complete_source',
  'resolved_but_drill_failed',
]);

function normalizeFromSet(value, set, fallback) {
  const key = String(value || '').trim().toLowerCase();
  if (key && set.has(key)) return key;
  return fallback;
}

function toBool(value) {
  if (value === true || value === 1) return true;
  const key = String(value || '').trim().toLowerCase();
  return key === '1' || key === 'true' || key === 'yes';
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE = Object.freeze([
  'first_autonomous_insert_by_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_reconciliation',
  'first_autonomous_insert_by_recovery_path',
  'first_manual_insert_of_day',
  'target_day_not_inserted_yet',
  'insert_not_required_missing_context',
  'insert_not_required_missing_market_data',
  'insert_not_required_invalid_day',
  'ownership_source_unknown',
]);

const OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE_MAP = OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE
  .reduce((acc, key, idx) => {
    acc[key] = idx;
    return acc;
  }, Object.create(null));

function inferOwnershipSourceSpecificOutcomeFromPersistedTruth({
  preferredOwnerWon = false,
  actualSource = null,
}) {
  const source = normalizeFromSet(actualSource || '', RUNTIME_SOURCE_SET, '');
  if (preferredOwnerWon !== true || !source) return 'ownership_source_unknown';
  if (source === 'close_complete_checkpoint') {
    return 'first_autonomous_insert_by_close_complete_checkpoint';
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
  return 'ownership_source_unknown';
}

function resolveMostPreciseOwnershipSourceSpecificOutcome(candidates = [], fallbackContext = {}) {
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((value) => normalizeFromSet(value, OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET, 'ownership_source_unknown'))
    .filter((value) => !!value);
  const inferred = inferOwnershipSourceSpecificOutcomeFromPersistedTruth(fallbackContext);
  normalizedCandidates.push(inferred);
  if (!normalizedCandidates.length) return 'ownership_source_unknown';
  let winner = 'ownership_source_unknown';
  let winnerScore = Number.MAX_SAFE_INTEGER;
  for (const value of normalizedCandidates) {
    const score = Number(OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE_MAP[value]);
    const bounded = Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER;
    if (bounded < winnerScore) {
      winner = value;
      winnerScore = bounded;
    }
  }
  return normalizeFromSet(winner, OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET, 'ownership_source_unknown');
}

function addDays(isoDate = '', days = 0) {
  const normalized = normalizeDate(isoDate);
  if (!normalized) return null;
  const [y, m, d] = normalized.split('-').map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(Date.UTC(y, m - 1, d) + (Math.round(days) * 86400000)).toISOString().slice(0, 10);
}

function maxIsoDate(dates = []) {
  const valid = dates
    .map((d) => normalizeDate(d || ''))
    .filter(Boolean);
  if (valid.length === 0) return null;
  valid.sort();
  return valid[valid.length - 1] || null;
}

function readLatestTargetDay(db, tableName, columnName = 'target_trading_day') {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT ${columnName} AS target_day
      FROM ${tableName}
      ORDER BY ${columnName} DESC
      LIMIT 1
    `).get();
    return normalizeDate(row?.target_day || '') || null;
  } catch {
    return null;
  }
}

function readLatestResolvedTargetDay(db, tableName, checkpointColumnName = 'checkpoint_status') {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day AS target_day
      FROM ${tableName}
      WHERE lower(${checkpointColumnName}) != 'waiting_valid'
      ORDER BY target_trading_day DESC
      LIMIT 1
    `).get();
    return normalizeDate(row?.target_day || '') || null;
  } catch {
    return null;
  }
}

function readProofRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT
        target_trading_day,
        preferred_owner_expected_source,
        first_creator_source,
        preferred_owner_won,
        preferred_owner_failure_reason,
        first_creation_ownership_source_specific_outcome
      FROM jarvis_live_preferred_owner_proof
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readVerifierRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT
        target_trading_day,
        run_id,
        run_origin,
        runtime_source,
        checkpoint_status,
        verifier_status,
        verifier_pass,
        failure_reasons_json
      FROM jarvis_preferred_owner_post_close_verifier
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readNaturalWinRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        target_trading_day,
        run_id,
        run_origin,
        first_creator_source,
        reservation_state
      FROM jarvis_preferred_owner_natural_wins
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readDeferralCount(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_preferred_owner_deferrals
      WHERE target_trading_day = ?
    `).get(target);
    return toNumber(row?.c, 0);
  } catch {
    return 0;
  }
}

function readVerdictRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        target_trading_day,
        run_origin,
        runtime_checkpoint_source,
        checkpoint_status,
        preferred_owner_expected_source,
        preferred_owner_actual_source,
        verifier_status,
        verifier_pass,
        natural_preferred_owner_wins_last5d,
        natural_preferred_owner_wins_total,
        natural_preferred_owner_verifier_passes_last5d,
        natural_preferred_owner_verifier_fails_last5d
      FROM jarvis_preferred_owner_operational_verdicts
      WHERE target_trading_day = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readProofBundleRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        target_trading_day,
        run_origin,
        runtime_checkpoint_source,
        checkpoint_status,
        preferred_owner_expected_source,
        preferred_owner_actual_source,
        ownership_source_specific_outcome,
        verifier_status,
        verifier_pass,
        natural_preferred_owner_wins_last5d,
        natural_preferred_owner_wins_total,
        natural_preferred_owner_verifier_passes_last5d,
        natural_preferred_owner_verifier_fails_last5d
      FROM jarvis_preferred_owner_operational_proof_bundles
      WHERE target_trading_day = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readWatcherRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        target_trading_day,
        trigger_run_id,
        trigger_run_origin,
        trigger_runtime_source,
        post_transition_checkpoint_status,
        drill_outcome,
        executed,
        executed_at
      FROM jarvis_preferred_owner_natural_drill_watch_runs
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function readCounterSnapshot(db, anchorDate = '') {
  const normalizedAnchor = normalizeDate(anchorDate || new Date().toISOString())
    || normalizeDate(new Date().toISOString());
  const sinceDate = addDays(normalizedAnchor, -4) || normalizedAnchor;
  let winsTotal = 0;
  let winsLast5d = 0;
  let verifierPassesLast5d = 0;
  let verifierFailsLast5d = 0;
  let lastWinDay = null;
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS wins_total,
        SUM(CASE WHEN target_trading_day >= ? THEN 1 ELSE 0 END) AS wins_last_5d
      FROM jarvis_preferred_owner_natural_wins
      WHERE lower(run_origin) = 'natural'
    `).get(sinceDate);
    winsTotal = toNumber(row?.wins_total, 0);
    winsLast5d = toNumber(row?.wins_last_5d, 0);
  } catch {}
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_natural_wins
      WHERE lower(run_origin) = 'natural'
      ORDER BY target_trading_day DESC
      LIMIT 1
    `).get();
    lastWinDay = normalizeDate(row?.target_trading_day || '') || null;
  } catch {}
  try {
    const row = db.prepare(`
      SELECT
        SUM(
          CASE
            WHEN target_trading_day >= ?
              AND lower(run_origin) = 'natural'
              AND lower(runtime_source) = 'close_complete_checkpoint'
              AND lower(verifier_status) = 'pass'
            THEN 1 ELSE 0
          END
        ) AS pass_count,
        SUM(
          CASE
            WHEN target_trading_day >= ?
              AND lower(run_origin) = 'natural'
              AND lower(runtime_source) = 'close_complete_checkpoint'
              AND lower(verifier_status) = 'fail'
            THEN 1 ELSE 0
          END
        ) AS fail_count
      FROM jarvis_preferred_owner_post_close_verifier
    `).get(sinceDate, sinceDate);
    verifierPassesLast5d = toNumber(row?.pass_count, 0);
    verifierFailsLast5d = toNumber(row?.fail_count, 0);
  } catch {}
  return {
    naturalPreferredOwnerWinsLast5d: winsLast5d,
    naturalPreferredOwnerWinsTotal: winsTotal,
    naturalPreferredOwnerVerifierPassesLast5d: verifierPassesLast5d,
    naturalPreferredOwnerVerifierFailsLast5d: verifierFailsLast5d,
    lastNaturalPreferredOwnerWinDay: lastWinDay,
  };
}

function parseFailureReasons(value) {
  let parsed = [];
  if (Array.isArray(value)) {
    parsed = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed)
    ? parsed
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter((entry, idx, arr) => !!entry && entry !== 'none' && arr.indexOf(entry) === idx)
    : [];
}

function readLatestAuditedNaturalResolvedTargetDay(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_post_close_verifier
      WHERE lower(run_origin) = 'natural'
        AND lower(runtime_source) = 'close_complete_checkpoint'
        AND lower(checkpoint_status) != 'waiting_valid'
      ORDER BY target_trading_day DESC, verified_at DESC
      LIMIT 1
    `).get();
    return normalizeDate(row?.target_trading_day || '') || null;
  } catch {
    return null;
  }
}

function buildPreferredOwnerOperatorSnapshot(input = {}) {
  const db = input.db;
  const fallback = {
    targetTradingDay: null,
    runOrigin: 'manual',
    runtimeSource: 'manual_api_run',
    expectedSource: 'close_complete_checkpoint',
    actualSource: null,
    preferredOwnerWon: false,
    ownershipSourceSpecificOutcome: 'ownership_source_unknown',
    verifierStatus: 'missing',
    verifierPass: false,
    verifierRunId: null,
    verifierFailureReasons: [],
    watcherStatus: 'waiting_for_resolution',
    watcherExecuted: false,
    watcherOutcome: 'waiting_for_resolution',
    proofBundleStatus: 'missing',
    proofBundlePass: false,
    monitorSummaryLabel: 'healthy_waiting_next_day',
    monitorResolvedSuccess: false,
    monitorConsistent: true,
    monitorMismatchReasons: [],
    advisoryOnly: true,
  };
  if (!db || typeof db.prepare !== 'function') return fallback;

  ensureDataFoundationTables(db);

  const explicitTargetTradingDay = normalizeDate(input.targetTradingDay || '') || null;
  const auditedNaturalResolvedTargetDay = readLatestAuditedNaturalResolvedTargetDay(db);
  const targetTradingDay = explicitTargetTradingDay
    || auditedNaturalResolvedTargetDay
    || null;
  if (!targetTradingDay) return fallback;

  const proofRow = readProofRow(db, targetTradingDay);
  const verifierRow = readVerifierRow(db, targetTradingDay);
  const naturalWinRow = readNaturalWinRow(db, targetTradingDay);
  const verdictRow = readVerdictRow(db, targetTradingDay);
  const bundleRow = readProofBundleRow(db, targetTradingDay);
  const watcherRow = readWatcherRow(db, targetTradingDay);
  const counterSnapshot = readCounterSnapshot(db, targetTradingDay);

  const runOrigin = normalizeFromSet(
    verifierRow?.run_origin
      || bundleRow?.run_origin
      || verdictRow?.run_origin
      || watcherRow?.trigger_run_origin
      || naturalWinRow?.run_origin
      || 'manual',
    RUN_ORIGIN_SET,
    'manual'
  );
  const runtimeSource = normalizeFromSet(
    verifierRow?.runtime_source
      || bundleRow?.runtime_checkpoint_source
      || verdictRow?.runtime_checkpoint_source
      || watcherRow?.trigger_runtime_source
      || naturalWinRow?.first_creator_source
      || 'manual_api_run',
    RUNTIME_SOURCE_SET,
    'manual_api_run'
  );
  const expectedSource = normalizeFromSet(
    proofRow?.preferred_owner_expected_source
      || verdictRow?.preferred_owner_expected_source
      || bundleRow?.preferred_owner_expected_source
      || 'close_complete_checkpoint',
    RUNTIME_SOURCE_SET,
    'close_complete_checkpoint'
  );
  const actualSourceRaw = (
    proofRow?.first_creator_source
    || verdictRow?.preferred_owner_actual_source
    || bundleRow?.preferred_owner_actual_source
    || naturalWinRow?.first_creator_source
    || ''
  );
  const actualSource = actualSourceRaw
    ? normalizeFromSet(actualSourceRaw, RUNTIME_SOURCE_SET, 'manual_api_run')
    : null;
  const preferredOwnerWon = (
    toBool(
      proofRow?.preferred_owner_won
        ?? verdictRow?.preferred_owner_won
        ?? bundleRow?.preferred_owner_won
        ?? 0
    ) === true
  );
  const ownershipSourceSpecificOutcome = resolveMostPreciseOwnershipSourceSpecificOutcome(
    [
      proofRow?.first_creation_ownership_source_specific_outcome,
      bundleRow?.ownership_source_specific_outcome,
      verdictRow?.ownership_source_specific_outcome,
    ],
    {
      preferredOwnerWon,
      actualSource,
    }
  );
  const verifierStatus = normalizeFromSet(
    verifierRow?.verifier_status
      || verdictRow?.verifier_status
      || bundleRow?.verifier_status
      || 'missing',
    VERIFIER_STATUS_SET,
    'missing'
  );
  const verifierPass = (
    toBool(
      verifierRow?.verifier_pass
        ?? verdictRow?.verifier_pass
        ?? bundleRow?.verifier_pass
        ?? 0
    ) === true
  );
  const verifierRunId = Number(verifierRow?.run_id || 0) || null;
  const verifierFailureReasons = parseFailureReasons(verifierRow?.failure_reasons_json || '[]');
  const watcherStatus = resolveWatcherStatus(
    watcherRow,
    resolveCheckpointStatus(verifierRow, verdictRow, bundleRow) !== 'waiting_valid',
    runtimeSource
  );
  const watcherExecuted = watcherRow ? toBool(watcherRow.executed) : false;
  const watcherOutcome = watcherRow
    ? normalizeFromSet(watcherRow.drill_outcome || 'already_executed_for_target_day', WATCHER_STATUS_SET, 'already_executed_for_target_day')
    : watcherStatus;
  const proofBundleStatus = bundleRow
    ? normalizeFromSet(bundleRow.verifier_status || 'fail', VERIFIER_STATUS_SET, 'fail')
    : 'missing';
  const proofBundlePass = bundleRow ? toBool(bundleRow.verifier_pass) === true : false;

  const checkpointStatus = resolveCheckpointStatus(verifierRow, verdictRow, bundleRow);
  const verifierResolvedStatus = normalizeFromSet(
    verifierRow?.checkpoint_status || checkpointStatus || 'waiting_valid',
    new Set([
      'success_inserted',
      'success_already_finalized',
      'blocked_invalid_day',
      'failure_missing_context',
      'failure_missing_market_data',
      'failure_scheduler_miss',
      'failure_duplicate_state',
      'failure_unknown',
      'waiting_valid',
    ]),
    'waiting_valid'
  );
  const verifierResolvedExists = !!verifierRow && verifierResolvedStatus !== 'waiting_valid';
  const verifierResolvedPass = verifierResolvedExists && verifierPass === true;
  const verifierResolvedFail = verifierResolvedExists && verifierPass !== true;
  const resolvedNaturalCloseCompleteSuccess = (
    verifierResolvedPass
    && runOrigin === 'natural'
    && runtimeSource === 'close_complete_checkpoint'
    && preferredOwnerWon === true
  );

  const mismatchReasons = [];
  if (explicitTargetTradingDay && explicitTargetTradingDay !== targetTradingDay) {
    mismatchReasons.push('target_day_alignment_mismatch');
  }
  if (resolveCheckpointStatus(verifierRow, verdictRow, bundleRow) !== 'waiting_valid' && !verifierRow) {
    mismatchReasons.push('verifier_missing_for_resolved_day');
  }
  if (verifierResolvedPass && !bundleRow) {
    mismatchReasons.push('bundle_missing_for_resolved_day');
  }
  if (resolvedNaturalCloseCompleteSuccess && !watcherRow) {
    mismatchReasons.push('watcher_missing_for_resolved_day');
  }
  if (resolvedNaturalCloseCompleteSuccess && !naturalWinRow) {
    mismatchReasons.push('natural_win_missing_for_verified_pass');
  }
  const expected = counterSnapshot;
  const reportedSources = [verdictRow, bundleRow].filter(Boolean);
  const counterMismatch = reportedSources.some((row) => (
    toNumber(row.natural_preferred_owner_wins_last5d, 0) !== expected.naturalPreferredOwnerWinsLast5d
    || toNumber(row.natural_preferred_owner_wins_total, 0) !== expected.naturalPreferredOwnerWinsTotal
    || toNumber(row.natural_preferred_owner_verifier_passes_last5d, 0)
      !== expected.naturalPreferredOwnerVerifierPassesLast5d
    || toNumber(row.natural_preferred_owner_verifier_fails_last5d, 0)
      !== expected.naturalPreferredOwnerVerifierFailsLast5d
  ));
  if (counterMismatch) mismatchReasons.push('counter_rollup_mismatch');
  const monitorMismatchReasons = normalizeMismatchReasons(mismatchReasons);
  const monitorConsistent = monitorMismatchReasons.every((reason) => (
    !MONITOR_CONSISTENCY_HARD_FAILURE_REASON_SET.has(reason)
  ));

  let monitorSummaryLabel = 'healthy_waiting_next_day';
  if (!monitorConsistent) {
    monitorSummaryLabel = 'warning_counter_mismatch';
  } else if (verifierResolvedFail) {
    monitorSummaryLabel = 'warning_verifier_failed';
  } else if (verifierResolvedPass && !bundleRow) {
    monitorSummaryLabel = 'warning_bundle_missing';
  } else if (resolvedNaturalCloseCompleteSuccess && !watcherRow) {
    monitorSummaryLabel = 'warning_watcher_not_fired';
  } else if (resolvedNaturalCloseCompleteSuccess && proofBundlePass) {
    monitorSummaryLabel = 'healthy_natural_win';
  } else if (verifierResolvedPass) {
    monitorSummaryLabel = 'healthy_manual_only';
  }

  return {
    targetTradingDay,
    runOrigin,
    runtimeSource,
    expectedSource,
    actualSource,
    preferredOwnerWon,
    ownershipSourceSpecificOutcome,
    verifierStatus,
    verifierPass,
    verifierRunId,
    verifierFailureReasons,
    watcherStatus,
    watcherExecuted,
    watcherOutcome,
    proofBundleStatus,
    proofBundlePass,
    monitorSummaryLabel: normalizeSummaryLabel(monitorSummaryLabel),
    monitorResolvedSuccess: (
      monitorSummaryLabel === 'healthy_natural_win'
      || monitorSummaryLabel === 'healthy_manual_only'
    ),
    monitorConsistent,
    monitorMismatchReasons,
    advisoryOnly: true,
  };
}

function normalizeSummaryLabel(value = 'healthy_waiting_next_day') {
  return normalizeFromSet(value, LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_SET, 'healthy_waiting_next_day');
}

function normalizeMismatchReasons(values = []) {
  return Array.isArray(values)
    ? values
      .map((value) => normalizeFromSet(value, LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_SET, null))
      .filter((value, idx, arr) => !!value && arr.indexOf(value) === idx)
    : [];
}

function resolveWatcherStatus(row = null, resolved = false, runtimeSource = 'manual_api_run') {
  if (row) {
    return normalizeFromSet('already_executed_for_target_day', WATCHER_STATUS_SET, 'waiting_for_resolution');
  }
  if (resolved && runtimeSource !== 'close_complete_checkpoint') {
    return normalizeFromSet('resolved_but_not_close_complete_source', WATCHER_STATUS_SET, 'waiting_for_resolution');
  }
  return normalizeFromSet('waiting_for_resolution', WATCHER_STATUS_SET, 'waiting_for_resolution');
}

function resolveCheckpointStatus(verifierRow, verdictRow, bundleRow) {
  return normalizeFromSet(
    verifierRow?.checkpoint_status
      || verdictRow?.checkpoint_status
      || bundleRow?.checkpoint_status
      || 'waiting_valid',
    new Set([
      'success_inserted',
      'success_already_finalized',
      'waiting_valid',
      'blocked_invalid_day',
      'failure_missing_context',
      'failure_missing_market_data',
      'failure_scheduler_miss',
      'failure_duplicate_state',
      'failure_unknown',
    ]),
    'waiting_valid'
  );
}

function buildPreferredOwnerMonitorSummary(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      livePreferredOwnerMonitorLatestTargetTradingDay: null,
      livePreferredOwnerMonitorLatestRunOrigin: 'manual',
      livePreferredOwnerMonitorLatestRuntimeSource: 'manual_api_run',
      livePreferredOwnerMonitorLatestOwnershipSourceSpecificOutcome: 'ownership_source_unknown',
      livePreferredOwnerMonitorLatestVerifierStatus: 'missing',
      livePreferredOwnerMonitorLatestVerifierPass: false,
      livePreferredOwnerMonitorLatestWatcherStatus: 'waiting_for_resolution',
      livePreferredOwnerMonitorLatestWatcherExecuted: false,
      livePreferredOwnerMonitorLatestProofBundleStatus: 'missing',
      livePreferredOwnerMonitorLatestProofBundlePass: false,
      livePreferredOwnerMonitorLatestSummaryLabel: 'healthy_waiting_next_day',
      livePreferredOwnerMonitorConsistent: true,
      livePreferredOwnerMonitorMismatchReasons: [],
      naturalPreferredOwnerWinsLast5d: 0,
      naturalPreferredOwnerWinsTotal: 0,
      naturalPreferredOwnerVerifierPassesLast5d: 0,
      naturalPreferredOwnerVerifierFailsLast5d: 0,
      lastNaturalPreferredOwnerWinDay: null,
      livePreferredOwnerMonitorResolvedSuccess: false,
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);

  const latestDays = {
    proof: readLatestTargetDay(db, 'jarvis_live_preferred_owner_proof'),
    verifier: readLatestTargetDay(db, 'jarvis_preferred_owner_post_close_verifier'),
    naturalWin: readLatestTargetDay(db, 'jarvis_preferred_owner_natural_wins'),
    deferral: readLatestTargetDay(db, 'jarvis_preferred_owner_deferrals'),
    verdict: readLatestTargetDay(db, 'jarvis_preferred_owner_operational_verdicts'),
    bundle: readLatestTargetDay(db, 'jarvis_preferred_owner_operational_proof_bundles'),
    watcher: readLatestTargetDay(db, 'jarvis_preferred_owner_natural_drill_watch_runs'),
  };

  let targetTradingDay = maxIsoDate(Object.values(latestDays));
  let proofRow = readProofRow(db, targetTradingDay);
  let verifierRow = readVerifierRow(db, targetTradingDay);
  let naturalWinRow = readNaturalWinRow(db, targetTradingDay);
  let deferralCount = readDeferralCount(db, targetTradingDay);
  let verdictRow = readVerdictRow(db, targetTradingDay);
  let bundleRow = readProofBundleRow(db, targetTradingDay);
  let watcherRow = readWatcherRow(db, targetTradingDay);
  let latestCheckpointStatus = resolveCheckpointStatus(verifierRow, verdictRow, bundleRow);
  let resolvedDay = latestCheckpointStatus !== 'waiting_valid';

  if (!resolvedDay) {
    const resolvedTargetTradingDay = maxIsoDate([
      readLatestResolvedTargetDay(db, 'jarvis_preferred_owner_post_close_verifier'),
      readLatestResolvedTargetDay(db, 'jarvis_preferred_owner_operational_verdicts'),
      readLatestResolvedTargetDay(db, 'jarvis_preferred_owner_operational_proof_bundles'),
    ]);
    if (resolvedTargetTradingDay) {
      targetTradingDay = resolvedTargetTradingDay;
      proofRow = readProofRow(db, targetTradingDay);
      verifierRow = readVerifierRow(db, targetTradingDay);
      naturalWinRow = readNaturalWinRow(db, targetTradingDay);
      deferralCount = readDeferralCount(db, targetTradingDay);
      verdictRow = readVerdictRow(db, targetTradingDay);
      bundleRow = readProofBundleRow(db, targetTradingDay);
      watcherRow = readWatcherRow(db, targetTradingDay);
      latestCheckpointStatus = resolveCheckpointStatus(verifierRow, verdictRow, bundleRow);
      resolvedDay = latestCheckpointStatus !== 'waiting_valid';
    }
  }

  const latestRunOrigin = normalizeFromSet(
    verifierRow?.run_origin
      || bundleRow?.run_origin
      || verdictRow?.run_origin
      || watcherRow?.trigger_run_origin
      || naturalWinRow?.run_origin
      || 'manual',
    RUN_ORIGIN_SET,
    'manual'
  );

  const latestRuntimeSource = normalizeFromSet(
    verifierRow?.runtime_source
      || bundleRow?.runtime_checkpoint_source
      || verdictRow?.runtime_checkpoint_source
      || watcherRow?.trigger_runtime_source
      || naturalWinRow?.first_creator_source
      || 'manual_api_run',
    RUNTIME_SOURCE_SET,
    'manual_api_run'
  );
  const proofRowExists = !!proofRow;

  const latestOwnershipSourceSpecificOutcome = resolveMostPreciseOwnershipSourceSpecificOutcome(
    [
      bundleRow?.ownership_source_specific_outcome,
      proofRow?.first_creation_ownership_source_specific_outcome,
      verdictRow?.ownership_source_specific_outcome,
    ],
    {
      preferredOwnerWon: proofRowExists && toBool(proofRow?.preferred_owner_won) === true,
      actualSource: proofRow?.first_creator_source || verdictRow?.preferred_owner_actual_source || null,
    }
  );

  const latestVerifierStatus = normalizeFromSet(
    verifierRow?.verifier_status
      || verdictRow?.verifier_status
      || bundleRow?.verifier_status
      || 'missing',
    VERIFIER_STATUS_SET,
    'missing'
  );
  const latestVerifierPass = toBool(
    verifierRow?.verifier_pass
      ?? verdictRow?.verifier_pass
      ?? bundleRow?.verifier_pass
      ?? 0
  );

  const latestWatcherStatus = resolveWatcherStatus(
    watcherRow,
    resolvedDay,
    latestRuntimeSource
  );
  const latestWatcherExecuted = watcherRow ? toBool(watcherRow.executed) : false;

  const latestProofBundleStatus = bundleRow
    ? normalizeFromSet(bundleRow.verifier_status || 'fail', VERIFIER_STATUS_SET, 'fail')
    : 'missing';
  const latestProofBundlePass = bundleRow ? toBool(bundleRow.verifier_pass) : false;

  const verifierResolvedStatus = normalizeFromSet(
    verifierRow?.checkpoint_status || '',
    new Set([
      'success_inserted',
      'success_already_finalized',
      'blocked_invalid_day',
      'failure_missing_context',
      'failure_missing_market_data',
      'failure_scheduler_miss',
      'failure_duplicate_state',
      'failure_unknown',
      'waiting_valid',
    ]),
    'waiting_valid'
  );
  const verifierResolvedExists = !!verifierRow && verifierResolvedStatus !== 'waiting_valid';
  const verifierResolvedPass = verifierResolvedExists && toBool(verifierRow?.verifier_pass) === true;
  const verifierResolvedFail = verifierResolvedExists && toBool(verifierRow?.verifier_pass) !== true;
  const naturalCloseCompleteRun = (
    normalizeFromSet(verifierRow?.run_origin || '', RUN_ORIGIN_SET, 'manual') === 'natural'
    && normalizeFromSet(verifierRow?.runtime_source || '', RUNTIME_SOURCE_SET, 'manual_api_run')
      === 'close_complete_checkpoint'
  );
  const preferredOwnerWon = proofRowExists && toBool(proofRow?.preferred_owner_won) === true;
  const proofBundlePassExists = !!bundleRow && latestProofBundlePass === true;
  const resolvedNaturalCloseCompleteSuccess = (
    verifierResolvedPass
    && naturalCloseCompleteRun
    && preferredOwnerWon
  );
  const resolvedNaturalWinFullyProven = (
    resolvedNaturalCloseCompleteSuccess
    && proofBundlePassExists
  );
  const resolvedManualSuccess = verifierResolvedPass && !resolvedNaturalWinFullyProven;

  const counterSnapshot = readCounterSnapshot(db, targetTradingDay || input.nowDate || '');
  const mismatchReasons = [];

  if (resolvedDay && !verifierRow) mismatchReasons.push('verifier_missing_for_resolved_day');
  if (verifierResolvedPass && !bundleRow) mismatchReasons.push('bundle_missing_for_resolved_day');
  if (
    resolvedNaturalCloseCompleteSuccess
    && !watcherRow
  ) {
    mismatchReasons.push('watcher_missing_for_resolved_day');
  }
  if (
    resolvedNaturalCloseCompleteSuccess
    && !naturalWinRow
  ) {
    mismatchReasons.push('natural_win_missing_for_verified_pass');
  }

  const alignmentDays = [
    latestDays.verifier,
    latestDays.verdict,
    latestDays.bundle,
    latestDays.watcher,
  ].filter(Boolean);
  if (resolvedDay && alignmentDays.length >= 2 && new Set(alignmentDays).size > 1) {
    mismatchReasons.push('target_day_alignment_mismatch');
  }

  const expected = counterSnapshot;
  const reportedSources = [verdictRow, bundleRow].filter(Boolean);
  const counterMismatch = reportedSources.some((row) => (
    toNumber(row.natural_preferred_owner_wins_last5d, 0) !== expected.naturalPreferredOwnerWinsLast5d
    || toNumber(row.natural_preferred_owner_wins_total, 0) !== expected.naturalPreferredOwnerWinsTotal
    || toNumber(row.natural_preferred_owner_verifier_passes_last5d, 0)
      !== expected.naturalPreferredOwnerVerifierPassesLast5d
    || toNumber(row.natural_preferred_owner_verifier_fails_last5d, 0)
      !== expected.naturalPreferredOwnerVerifierFailsLast5d
  ));
  if (counterMismatch) mismatchReasons.push('counter_rollup_mismatch');

  const normalizedMismatchReasons = normalizeMismatchReasons(mismatchReasons);
  const monitorConsistent = normalizedMismatchReasons.every((reason) => (
    !MONITOR_CONSISTENCY_HARD_FAILURE_REASON_SET.has(reason)
  ));
  let summaryLabel = 'healthy_waiting_next_day';
  if (!monitorConsistent) {
    summaryLabel = 'warning_counter_mismatch';
  } else if (verifierResolvedFail) {
    summaryLabel = 'warning_verifier_failed';
  } else if (verifierResolvedPass && !bundleRow) {
    summaryLabel = 'warning_bundle_missing';
  } else if (resolvedNaturalCloseCompleteSuccess && !watcherRow) {
    summaryLabel = 'warning_watcher_not_fired';
  } else if (
    proofRowExists
    && preferredOwnerWon
    && verifierResolvedPass
    && proofBundlePassExists
    && naturalCloseCompleteRun
  ) {
    summaryLabel = 'healthy_natural_win';
  } else if (
    verifierResolvedPass
  ) {
    summaryLabel = 'healthy_manual_only';
  }

  const resolvedSuccess = (
    summaryLabel === 'healthy_natural_win'
    || summaryLabel === 'healthy_manual_only'
  );
  const livePreferredOwnerOperatorSnapshot = buildPreferredOwnerOperatorSnapshot({
    db,
    nowDate: input.nowDate || targetTradingDay || undefined,
  });
  const operatorSnapshot = (
    livePreferredOwnerOperatorSnapshot
    && typeof livePreferredOwnerOperatorSnapshot === 'object'
    && normalizeDate(livePreferredOwnerOperatorSnapshot.targetTradingDay || '')
  )
    ? livePreferredOwnerOperatorSnapshot
    : null;

  return {
    livePreferredOwnerMonitorLatestTargetTradingDay: operatorSnapshot?.targetTradingDay || targetTradingDay,
    livePreferredOwnerMonitorLatestRunOrigin: operatorSnapshot?.runOrigin || latestRunOrigin,
    livePreferredOwnerMonitorLatestRuntimeSource: operatorSnapshot?.runtimeSource || latestRuntimeSource,
    livePreferredOwnerMonitorLatestOwnershipSourceSpecificOutcome: (
      operatorSnapshot?.ownershipSourceSpecificOutcome || latestOwnershipSourceSpecificOutcome
    ),
    livePreferredOwnerMonitorLatestVerifierStatus: (
      operatorSnapshot?.verifierStatus || latestVerifierStatus
    ),
    livePreferredOwnerMonitorLatestVerifierPass: (
      operatorSnapshot ? operatorSnapshot.verifierPass === true : latestVerifierPass === true
    ),
    livePreferredOwnerMonitorLatestWatcherStatus: (
      operatorSnapshot?.watcherStatus || latestWatcherStatus
    ),
    livePreferredOwnerMonitorLatestWatcherExecuted: (
      operatorSnapshot ? operatorSnapshot.watcherExecuted === true : latestWatcherExecuted === true
    ),
    livePreferredOwnerMonitorLatestProofBundleStatus: (
      operatorSnapshot?.proofBundleStatus || latestProofBundleStatus
    ),
    livePreferredOwnerMonitorLatestProofBundlePass: (
      operatorSnapshot ? operatorSnapshot.proofBundlePass === true : latestProofBundlePass === true
    ),
    livePreferredOwnerMonitorLatestSummaryLabel: (
      operatorSnapshot?.monitorSummaryLabel || normalizeSummaryLabel(summaryLabel)
    ),
    livePreferredOwnerMonitorConsistent: (
      operatorSnapshot ? operatorSnapshot.monitorConsistent !== false : monitorConsistent
    ),
    livePreferredOwnerMonitorMismatchReasons: (
      operatorSnapshot
        ? normalizeMismatchReasons(operatorSnapshot.monitorMismatchReasons || [])
        : normalizedMismatchReasons
    ),
    naturalPreferredOwnerWinsLast5d: Number(counterSnapshot.naturalPreferredOwnerWinsLast5d || 0),
    naturalPreferredOwnerWinsTotal: Number(counterSnapshot.naturalPreferredOwnerWinsTotal || 0),
    naturalPreferredOwnerVerifierPassesLast5d: Number(counterSnapshot.naturalPreferredOwnerVerifierPassesLast5d || 0),
    naturalPreferredOwnerVerifierFailsLast5d: Number(counterSnapshot.naturalPreferredOwnerVerifierFailsLast5d || 0),
    lastNaturalPreferredOwnerWinDay: toText(counterSnapshot.lastNaturalPreferredOwnerWinDay || '') || null,
    livePreferredOwnerMonitorResolvedSuccess: (
      operatorSnapshot ? operatorSnapshot.monitorResolvedSuccess === true : resolvedSuccess
    ),
    livePreferredOwnerMonitorResolvedDay: resolvedDay === true,
    livePreferredOwnerMonitorDeferralCountForTargetDay: Number(deferralCount || 0),
    livePreferredOwnerOperatorSnapshot: operatorSnapshot,
    advisoryOnly: true,
  };
}

module.exports = {
  LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM,
  LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM,
  buildPreferredOwnerOperatorSnapshot,
  buildPreferredOwnerMonitorSummary,
};
