'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  toText,
} = require('./data-foundation-storage');
const {
  ensureDailyScoringTables,
  runAutomaticDailyScoring,
  buildDailyScoringStatus,
  LIVE_FINALIZATION_SWEEP_SOURCE_ENUM,
  LIVE_CHECKPOINT_STATUS_ENUM,
  LIVE_CHECKPOINT_REASON_ENUM,
  DAILY_SCORING_RUN_ORIGIN_ENUM,
  PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM,
  PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM,
  LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM,
  LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM,
  LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM,
} = require('./daily-evidence-scoring');

const PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_ENUM = Object.freeze([
  'not_ready_checkpoint_unresolved',
  'resolved_and_captured',
  'resolved_already_captured',
  'resolved_but_verifier_failed',
  'resolved_but_bundle_missing_bug',
]);

const PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_SET = new Set(
  PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_ENUM
);

const FINALIZATION_SWEEP_SOURCE_SET = new Set(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM || []);
const CHECKPOINT_STATUS_SET = new Set(LIVE_CHECKPOINT_STATUS_ENUM || []);
const CHECKPOINT_REASON_SET = new Set(LIVE_CHECKPOINT_REASON_ENUM || []);
const RUN_ORIGIN_SET = new Set(DAILY_SCORING_RUN_ORIGIN_ENUM || []);
const VERIFIER_STATUS_SET = new Set(PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM || []);
const VERIFIER_FAIL_REASON_SET = new Set(PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM || []);
const OWNERSHIP_OUTCOME_SET = new Set(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM || []);
const OWNERSHIP_SOURCE_SPECIFIC_SET = new Set(LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM || []);
const PREFERRED_OWNER_FAILURE_REASON_SET = new Set(LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM || []);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isoDateOnly(value = '') {
  const parsed = normalizeDate(value);
  return parsed || null;
}

function addDays(isoDate = '', days = 0) {
  const base = isoDateOnly(isoDate);
  if (!base) return null;
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(Number(days || 0)));
  return d.toISOString().slice(0, 10);
}

function isResolvedCheckpointStatus(status = '') {
  return normalizeCheckpointStatus(status) !== 'waiting_valid';
}

function normalizeFromSet(value, set, fallback) {
  const key = toText(value || '').trim().toLowerCase();
  if (key && set.has(key)) return key;
  return fallback;
}

function normalizeFinalizationSweepSource(value = '') {
  return normalizeFromSet(value, FINALIZATION_SWEEP_SOURCE_SET, 'manual_api_run');
}

function normalizeCheckpointStatus(value = '') {
  return normalizeFromSet(value, CHECKPOINT_STATUS_SET, 'waiting_valid');
}

function normalizeCheckpointReason(value = '') {
  return normalizeFromSet(value, CHECKPOINT_REASON_SET, 'unknown_checkpoint_state');
}

function normalizeDailyScoringRunOrigin(value = '') {
  return normalizeFromSet(value, RUN_ORIGIN_SET, 'manual');
}

function normalizePreferredOwnerPostCloseProofStatus(value = '') {
  return normalizeFromSet(value, VERIFIER_STATUS_SET, 'fail');
}

function normalizePreferredOwnerPostCloseProofFailReason(value = '') {
  return normalizeFromSet(value, VERIFIER_FAIL_REASON_SET, 'none');
}

function normalizeLiveInsertionOwnershipOutcome(value = '') {
  return normalizeFromSet(value, OWNERSHIP_OUTCOME_SET, 'target_day_not_inserted_yet');
}

function normalizeLiveInsertionOwnershipSourceSpecificOutcome(value = '') {
  return normalizeFromSet(value, OWNERSHIP_SOURCE_SPECIFIC_SET, 'ownership_source_unknown');
}

function normalizeLivePreferredOwnerFailureReason(value = '') {
  return normalizeFromSet(value, PREFERRED_OWNER_FAILURE_REASON_SET, 'none');
}

function parseJsonArray(raw, normalizer) {
  let rows = [];
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (Array.isArray(parsed)) rows = parsed;
  } catch {}
  return rows
    .map((value) => (typeof normalizer === 'function' ? normalizer(value) : toText(value).toLowerCase()))
    .filter((value, idx, arr) => !!value && arr.indexOf(value) === idx);
}

function readPreferredOwnerPostCloseVerifierRow(db, targetTradingDay = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const day = isoDateOnly(targetTradingDay);
  if (!day) return null;
  try {
    const row = db.prepare(`
      SELECT id, target_trading_day, run_id, run_origin, runtime_source, checkpoint_status, verifier_status, verifier_pass, failure_reasons_json, verified_at
      FROM jarvis_preferred_owner_post_close_verifier
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(day);
    if (!row) return null;
    return {
      id: toNumber(row.id, null),
      targetTradingDay: isoDateOnly(row.target_trading_day),
      runId: toNumber(row.run_id, null),
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      runtimeSource: normalizeFinalizationSweepSource(row.runtime_source || 'manual_api_run'),
      checkpointStatus: normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid'),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(row.verifier_status || 'fail'),
      verifierPass: Number(row.verifier_pass || 0) === 1,
      verifierFailureReasons: parseJsonArray(
        row.failure_reasons_json,
        normalizePreferredOwnerPostCloseProofFailReason
      ),
      verifiedAt: toText(row.verified_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readPreferredOwnerNaturalWinRow(db, targetTradingDay = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const day = isoDateOnly(targetTradingDay);
  if (!day) return null;
  try {
    const row = db.prepare(`
      SELECT id, target_trading_day, run_id, first_creator_source, reservation_state, reservation_blocked_fallback, proof_row_id, run_origin, timestamp
      FROM jarvis_preferred_owner_natural_wins
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(day);
    if (!row) return null;
    return {
      id: toNumber(row.id, null),
      targetTradingDay: isoDateOnly(row.target_trading_day),
      runId: toNumber(row.run_id, null),
      firstCreatorSource: normalizeFinalizationSweepSource(row.first_creator_source || 'manual_api_run'),
      reservationState: toText(row.reservation_state || '').toLowerCase() || 'reservation_not_applicable',
      reservationBlockedFallback: Number(row.reservation_blocked_fallback || 0) === 1,
      proofRowId: toNumber(row.proof_row_id, null),
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      timestamp: toText(row.timestamp || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function countPreferredOwnerDeferralsByTargetDay(db, targetTradingDay = '') {
  if (!db || typeof db.prepare !== 'function') return 0;
  const day = isoDateOnly(targetTradingDay);
  if (!day) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_preferred_owner_deferrals
      WHERE target_trading_day = ?
    `).get(day);
    return toNumber(row?.c || 0, 0);
  } catch {
    return 0;
  }
}

function readPreferredOwnerOperationalVerdictRow(db, targetTradingDay = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const day = isoDateOnly(targetTradingDay);
  if (!day) return null;
  try {
    const row = db.prepare(`
      SELECT id, target_trading_day, run_id, run_origin, runtime_checkpoint_source, checkpoint_status, verifier_status, verifier_pass, verifier_failure_reasons_json, reported_at
      FROM jarvis_preferred_owner_operational_verdicts
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(day);
    if (!row) return null;
    return {
      id: toNumber(row.id, null),
      targetTradingDay: isoDateOnly(row.target_trading_day),
      runId: toNumber(row.run_id, null),
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(row.runtime_checkpoint_source || 'manual_api_run'),
      checkpointStatus: normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid'),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(row.verifier_status || 'fail'),
      verifierPass: Number(row.verifier_pass || 0) === 1,
      verifierFailureReasons: parseJsonArray(
        row.verifier_failure_reasons_json,
        normalizePreferredOwnerPostCloseProofFailReason
      ),
      reportedAt: toText(row.reported_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readPreferredOwnerOperationalProofBundleRow(db, targetTradingDay = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const day = isoDateOnly(targetTradingDay);
  if (!day) return null;
  try {
    const row = db.prepare(`
      SELECT id, target_trading_day, run_id, run_origin, checkpoint_status, checkpoint_reason, runtime_checkpoint_source,
             preferred_owner_expected_source, preferred_owner_actual_source, preferred_owner_won, preferred_owner_failure_reason,
             ownership_source_specific_outcome, verifier_status, verifier_pass, verifier_failure_reasons_json,
             natural_preferred_owner_wins_last5d, natural_preferred_owner_wins_total,
             natural_preferred_owner_verifier_passes_last5d, natural_preferred_owner_verifier_fails_last5d,
             captured_at
      FROM jarvis_preferred_owner_operational_proof_bundles
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(day);
    if (!row) return null;
    return {
      id: toNumber(row.id, null),
      targetTradingDay: isoDateOnly(row.target_trading_day),
      runId: toNumber(row.run_id, null),
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      checkpointStatus: normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid'),
      checkpointReason: normalizeCheckpointReason(row.checkpoint_reason || 'unknown_checkpoint_state'),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(row.runtime_checkpoint_source || 'manual_api_run'),
      preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
        row.preferred_owner_expected_source || 'close_complete_checkpoint'
      ),
      preferredOwnerActualSource: row.preferred_owner_actual_source
        ? normalizeFinalizationSweepSource(row.preferred_owner_actual_source)
        : null,
      preferredOwnerWon: Number(row.preferred_owner_won || 0) === 1,
      preferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
        row.preferred_owner_failure_reason || 'none'
      ),
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        row.ownership_source_specific_outcome || 'ownership_source_unknown'
      ),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(row.verifier_status || 'fail'),
      verifierPass: Number(row.verifier_pass || 0) === 1,
      verifierFailureReasons: parseJsonArray(
        row.verifier_failure_reasons_json,
        normalizePreferredOwnerPostCloseProofFailReason
      ),
      naturalPreferredOwnerWinsLast5d: toNumber(row.natural_preferred_owner_wins_last5d, 0),
      naturalPreferredOwnerWinsTotal: toNumber(row.natural_preferred_owner_wins_total, 0),
      naturalPreferredOwnerVerifierPassesLast5d: toNumber(row.natural_preferred_owner_verifier_passes_last5d, 0),
      naturalPreferredOwnerVerifierFailsLast5d: toNumber(row.natural_preferred_owner_verifier_fails_last5d, 0),
      capturedAt: toText(row.captured_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readNaturalPreferredOwnerCounterSnapshot(db, nowDate = '') {
  const targetDate = isoDateOnly(nowDate) || new Date().toISOString().slice(0, 10);
  const sinceDate = addDays(targetDate, -4) || targetDate;
  if (!db || typeof db.prepare !== 'function') {
    return {
      naturalPreferredOwnerWinsLast5d: 0,
      naturalPreferredOwnerWinsTotal: 0,
      naturalPreferredOwnerVerifierPassesLast5d: 0,
      naturalPreferredOwnerVerifierFailsLast5d: 0,
      lastNaturalPreferredOwnerWinDay: null,
      advisoryOnly: true,
    };
  }
  try {
    const winsLast5d = toNumber(db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_preferred_owner_natural_wins
      WHERE target_trading_day BETWEEN ? AND ?
        AND lower(run_origin) = 'natural'
    `).get(sinceDate, targetDate)?.c || 0, 0);
    const winsTotal = toNumber(db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_preferred_owner_natural_wins
      WHERE lower(run_origin) = 'natural'
    `).get()?.c || 0, 0);
    const lastNaturalPreferredOwnerWinDay = isoDateOnly(db.prepare(`
      SELECT MAX(target_trading_day) AS d
      FROM jarvis_preferred_owner_natural_wins
      WHERE lower(run_origin) = 'natural'
    `).get()?.d || '');
    const verifierWindow = db.prepare(`
      SELECT
        SUM(CASE WHEN verifier_pass = 1 THEN 1 ELSE 0 END) AS passes,
        SUM(CASE WHEN verifier_pass = 0 THEN 1 ELSE 0 END) AS fails
      FROM jarvis_preferred_owner_post_close_verifier
      WHERE target_trading_day BETWEEN ? AND ?
        AND lower(run_origin) = 'natural'
        AND lower(runtime_source) = 'close_complete_checkpoint'
        AND lower(checkpoint_status) != 'waiting_valid'
    `).get(sinceDate, targetDate) || {};
    return {
      naturalPreferredOwnerWinsLast5d: winsLast5d,
      naturalPreferredOwnerWinsTotal: winsTotal,
      naturalPreferredOwnerVerifierPassesLast5d: toNumber(verifierWindow.passes || 0, 0),
      naturalPreferredOwnerVerifierFailsLast5d: toNumber(verifierWindow.fails || 0, 0),
      lastNaturalPreferredOwnerWinDay,
      advisoryOnly: true,
    };
  } catch {
    return {
      naturalPreferredOwnerWinsLast5d: 0,
      naturalPreferredOwnerWinsTotal: 0,
      naturalPreferredOwnerVerifierPassesLast5d: 0,
      naturalPreferredOwnerVerifierFailsLast5d: 0,
      lastNaturalPreferredOwnerWinDay: null,
      advisoryOnly: true,
    };
  }
}

function resolveDrillOutcome(input = {}) {
  const resolved = input.resolved === true;
  const bundleBefore = input.bundleExistsBefore === true;
  const bundleAfter = input.bundleExistsAfter === true;
  const verifierPass = input.verifierPass === true;

  if (!resolved) return 'not_ready_checkpoint_unresolved';
  if (bundleBefore) return 'resolved_already_captured';
  if (!bundleAfter) return 'resolved_but_bundle_missing_bug';
  return verifierPass ? 'resolved_and_captured' : 'resolved_but_verifier_failed';
}

function buildDrillSummary(input = {}) {
  const checkpoint = input.checkpoint && typeof input.checkpoint === 'object'
    ? input.checkpoint
    : {};
  const ownership = input.ownership && typeof input.ownership === 'object'
    ? input.ownership
    : {};
  const verifier = input.verifier && typeof input.verifier === 'object'
    ? input.verifier
    : {};
  const artifacts = input.operationalArtifacts && typeof input.operationalArtifacts === 'object'
    ? input.operationalArtifacts
    : {};
  const counters = input.counters && typeof input.counters === 'object'
    ? input.counters
    : {};
  return {
    drillOutcome: PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_SET.has(input.drillOutcome)
      ? input.drillOutcome
      : 'resolved_but_bundle_missing_bug',
    checkpoint: {
      targetTradingDay: checkpoint.targetTradingDay || null,
      checkpointStatus: normalizeCheckpointStatus(checkpoint.checkpointStatus || 'waiting_valid'),
      checkpointReason: normalizeCheckpointReason(checkpoint.checkpointReason || 'unknown_checkpoint_state'),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(
        checkpoint.runtimeCheckpointSource || checkpoint.runtimeSource || 'manual_api_run'
      ),
      runtimeCheckpointWasAutonomous: checkpoint.runtimeCheckpointWasAutonomous === true,
    },
    ownership: {
      liveInsertionOwnershipOutcome: normalizeLiveInsertionOwnershipOutcome(
        ownership.liveInsertionOwnershipOutcome || 'target_day_not_inserted_yet'
      ),
      liveInsertionOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        ownership.liveInsertionOwnershipSourceSpecificOutcome || 'ownership_source_unknown'
      ),
      preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
        ownership.preferredOwnerExpectedSource || 'close_complete_checkpoint'
      ),
      preferredOwnerActualSource: ownership.preferredOwnerActualSource
        ? normalizeFinalizationSweepSource(ownership.preferredOwnerActualSource)
        : null,
      preferredOwnerWon: ownership.preferredOwnerWon === true,
      preferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
        ownership.preferredOwnerFailureReason || 'none'
      ),
    },
    verifier: {
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(verifier.verifierStatus || 'fail'),
      verifierPass: verifier.verifierPass === true,
      verifierFailureReasons: Array.isArray(verifier.verifierFailureReasons)
        ? verifier.verifierFailureReasons
          .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
          .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx)
        : [],
      verifierRunOrigin: normalizeDailyScoringRunOrigin(verifier.verifierRunOrigin || verifier.runOrigin || 'manual'),
      verifierResolvedNaturally: verifier.verifierResolvedNaturally === true,
      verifierVerifiedAt: toText(verifier.verifierVerifiedAt || verifier.verifiedAt || '') || null,
    },
    operationalArtifacts: {
      naturalWinRowCreated: artifacts.naturalWinRowCreated === true,
      deferralRowCreated: artifacts.deferralRowCreated === true,
      operationalVerdictRowCreated: artifacts.operationalVerdictRowCreated === true,
      operationalProofBundleRowCreated: artifacts.operationalProofBundleRowCreated === true,
      proofBundleCapturedThisRun: artifacts.proofBundleCapturedThisRun === true,
      proofBundleSkipReason: toText(artifacts.proofBundleSkipReason || '') || null,
    },
    counters: {
      naturalPreferredOwnerWinsLast5d: toNumber(counters.naturalPreferredOwnerWinsLast5d, 0),
      naturalPreferredOwnerWinsTotal: toNumber(counters.naturalPreferredOwnerWinsTotal, 0),
      naturalPreferredOwnerVerifierPassesLast5d: toNumber(counters.naturalPreferredOwnerVerifierPassesLast5d, 0),
      naturalPreferredOwnerVerifierFailsLast5d: toNumber(counters.naturalPreferredOwnerVerifierFailsLast5d, 0),
      lastNaturalPreferredOwnerWinDay: isoDateOnly(counters.lastNaturalPreferredOwnerWinDay || ''),
    },
    advisoryOnly: true,
  };
}

function readTargetDayArtifacts(db, targetTradingDay = '', nowDate = '') {
  const verifierRow = readPreferredOwnerPostCloseVerifierRow(db, targetTradingDay);
  const naturalWinRow = readPreferredOwnerNaturalWinRow(db, targetTradingDay);
  const deferralCount = countPreferredOwnerDeferralsByTargetDay(db, targetTradingDay);
  const operationalVerdictRow = readPreferredOwnerOperationalVerdictRow(db, targetTradingDay);
  const proofBundleRow = readPreferredOwnerOperationalProofBundleRow(db, targetTradingDay);
  const counters = readNaturalPreferredOwnerCounterSnapshot(db, nowDate || targetTradingDay || '');
  return {
    verifierRow,
    naturalWinRow,
    deferralCount,
    operationalVerdictRow,
    proofBundleRow,
    counters,
  };
}

function toCheckpointSnapshot(status = {}) {
  const liveCheckpoint = status.liveCheckpoint && typeof status.liveCheckpoint === 'object'
    ? status.liveCheckpoint
    : {};
  return {
    targetTradingDay: isoDateOnly(
      liveCheckpoint.targetTradingDay
      || status.liveCheckpointTargetTradingDay
      || status.livePreferredOwnerPostCloseProofVerifierTargetTradingDay
      || status.livePreferredOwnerOperationalProofBundleTargetTradingDay
      || ''
    ),
    checkpointStatus: normalizeCheckpointStatus(
      liveCheckpoint.checkpointStatus
      || status.liveCheckpointStatus
      || 'waiting_valid'
    ),
    checkpointReason: normalizeCheckpointReason(
      liveCheckpoint.checkpointReason
      || status.liveCheckpointReason
      || 'unknown_checkpoint_state'
    ),
    runtimeCheckpointSource: normalizeFinalizationSweepSource(
      liveCheckpoint.runtimeCheckpointSource
      || liveCheckpoint.sweepSource
      || status.liveCheckpointRuntimeSource
      || 'manual_api_run'
    ),
    runtimeCheckpointWasAutonomous: (
      liveCheckpoint.runtimeCheckpointWasAutonomous === true
      || status.liveRuntimeCheckpointWasAutonomous === true
    ),
    advisoryOnly: true,
  };
}

function toOwnershipSnapshot(status = {}, proofBundleRow = null) {
  return {
    liveInsertionOwnershipOutcome: normalizeLiveInsertionOwnershipOutcome(
      status?.liveInsertionOwnership?.liveInsertionOwnershipOutcome
      || status?.liveInsertionOwnershipOutcome
      || 'target_day_not_inserted_yet'
    ),
    liveInsertionOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
      status?.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome
      || status?.liveInsertionOwnershipSourceSpecificOutcome
      || proofBundleRow?.ownershipSourceSpecificOutcome
      || 'ownership_source_unknown'
    ),
    preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
      status?.livePreferredOwnerProof?.livePreferredOwnerExpectedSource
      || status?.livePreferredOwnerExpectedSource
      || proofBundleRow?.preferredOwnerExpectedSource
      || 'close_complete_checkpoint'
    ),
    preferredOwnerActualSource: status?.livePreferredOwnerProof?.livePreferredOwnerActualSource
      || status?.livePreferredOwnerActualSource
      || proofBundleRow?.preferredOwnerActualSource
      || null,
    preferredOwnerWon: (
      status?.livePreferredOwnerProof?.livePreferredOwnerWon === true
      || status?.livePreferredOwnerWon === true
      || proofBundleRow?.preferredOwnerWon === true
    ),
    preferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
      status?.livePreferredOwnerProof?.livePreferredOwnerFailureReason
      || status?.livePreferredOwnerFailureReason
      || proofBundleRow?.preferredOwnerFailureReason
      || 'none'
    ),
    advisoryOnly: true,
  };
}

function toVerifierSnapshot(status = {}, verifierRow = null, proofBundleRow = null) {
  const statusVerifier = status?.livePreferredOwnerPostCloseProofVerifier
    && typeof status.livePreferredOwnerPostCloseProofVerifier === 'object'
    ? status.livePreferredOwnerPostCloseProofVerifier
    : {};
  const fallbackReasons = Array.isArray(status?.livePreferredOwnerPostCloseProofVerifierFailureReasons)
    ? status.livePreferredOwnerPostCloseProofVerifierFailureReasons
    : [];
  const verifierFailureReasons = Array.isArray(statusVerifier.failureReasons)
    ? statusVerifier.failureReasons
    : (
      verifierRow?.verifierFailureReasons
      || proofBundleRow?.verifierFailureReasons
      || fallbackReasons
    );
  return {
    verifierStatus: normalizePreferredOwnerPostCloseProofStatus(
      statusVerifier.verifierStatus
      || status?.livePreferredOwnerPostCloseProofVerifierStatus
      || verifierRow?.verifierStatus
      || proofBundleRow?.verifierStatus
      || 'fail'
    ),
    verifierPass: (
      statusVerifier.verifierPass === true
      || status?.livePreferredOwnerPostCloseProofVerifierPass === true
      || verifierRow?.verifierPass === true
      || proofBundleRow?.verifierPass === true
    ),
    verifierFailureReasons,
    verifierRunOrigin: normalizeDailyScoringRunOrigin(
      statusVerifier.livePreferredOwnerPostCloseProofVerifierRunOrigin
      || statusVerifier.runOrigin
      || status?.livePreferredOwnerPostCloseProofVerifierRunOrigin
      || verifierRow?.runOrigin
      || proofBundleRow?.runOrigin
      || 'manual'
    ),
    verifierResolvedNaturally: (
      statusVerifier.livePreferredOwnerPostCloseProofResolvedNaturally === true
      || status?.livePreferredOwnerPostCloseProofResolvedNaturally === true
      || (
        normalizeDailyScoringRunOrigin(verifierRow?.runOrigin || 'manual') === 'natural'
        && normalizeFinalizationSweepSource(verifierRow?.runtimeSource || 'manual_api_run') === 'close_complete_checkpoint'
        && normalizeCheckpointStatus(verifierRow?.checkpointStatus || 'waiting_valid') !== 'waiting_valid'
      )
    ),
    verifierVerifiedAt: (
      statusVerifier.verifiedAt
      || status?.livePreferredOwnerPostCloseProofVerifierVerifiedAt
      || verifierRow?.verifiedAt
      || proofBundleRow?.capturedAt
      || null
    ),
    advisoryOnly: true,
  };
}

function runPreferredOwnerNaturalDrill(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      drillOutcome: 'resolved_but_bundle_missing_bug',
      error: 'db_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDataFoundationTables(db);
  ensureDailyScoringTables(db);
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const nowDate = isoDateOnly(input.nowDate || new Date().toISOString().slice(0, 10)) || new Date().toISOString().slice(0, 10);
  const nowTime = toText(input.nowTime || '18:00') || '18:00';
  const windowDays = Math.max(1, Math.min(60, toNumber(input.windowDays, 5)));
  const force = input.force === true;

  const statusBefore = (
    input.statusBefore
    && typeof input.statusBefore === 'object'
    && input.statusBefore.status
  )
    ? input.statusBefore
    : buildDailyScoringStatus({
      db,
      sessions,
      nowDate,
      windowDays,
    });
  const checkpointBefore = toCheckpointSnapshot(statusBefore);
  const targetTradingDay = isoDateOnly(
    input.targetTradingDay
    || checkpointBefore.targetTradingDay
    || nowDate
  ) || nowDate;
  const artifactsBefore = readTargetDayArtifacts(db, targetTradingDay, nowDate);
  const resolvedBefore = isResolvedCheckpointStatus(checkpointBefore.checkpointStatus);
  const proofBundleExistsBefore = !!artifactsBefore.proofBundleRow;

  let scoringRun = null;
  let statusAfter = statusBefore;
  if (resolvedBefore && !proofBundleExistsBefore) {
    scoringRun = runAutomaticDailyScoring({
      db,
      sessions,
      mode: toText(input.mode || 'preferred_owner_natural_drill') || 'preferred_owner_natural_drill',
      nowDate,
      nowTime,
      windowDays,
      force,
      finalizationOnly: true,
      liveBridgeLookbackDays: Math.max(7, Math.min(60, toNumber(input.liveBridgeLookbackDays, 21))),
      finalizationSweepSource: 'close_complete_checkpoint',
      checkpointTargetTradingDay: targetTradingDay,
      runOrigin: 'natural',
      runtimeTriggered: true,
    });
    statusAfter = buildDailyScoringStatus({
      db,
      sessions,
      nowDate,
      windowDays,
    });
  }

  const checkpointAfter = toCheckpointSnapshot(statusAfter);
  const artifactsAfter = readTargetDayArtifacts(db, targetTradingDay, nowDate);
  const proofBundleExistsAfter = !!artifactsAfter.proofBundleRow;
  const resolvedAfter = isResolvedCheckpointStatus(checkpointAfter.checkpointStatus);
  const resolvedForOutcome = resolvedBefore || resolvedAfter;
  const verifierSnapshot = toVerifierSnapshot(
    statusAfter,
    artifactsAfter.verifierRow,
    artifactsAfter.proofBundleRow
  );
  const drillOutcome = resolveDrillOutcome({
    resolved: resolvedForOutcome,
    bundleExistsBefore: proofBundleExistsBefore,
    bundleExistsAfter: proofBundleExistsAfter,
    verifierPass: verifierSnapshot.verifierPass === true,
  });
  const operationalArtifacts = {
    naturalWinRowCreated: !artifactsBefore.naturalWinRow && !!artifactsAfter.naturalWinRow,
    deferralRowCreated: artifactsAfter.deferralCount > artifactsBefore.deferralCount,
    operationalVerdictRowCreated: !artifactsBefore.operationalVerdictRow && !!artifactsAfter.operationalVerdictRow,
    operationalProofBundleRowCreated: !artifactsBefore.proofBundleRow && !!artifactsAfter.proofBundleRow,
    proofBundleCapturedThisRun: (
      scoringRun?.livePreferredOwnerOperationalProofBundleCapturedThisRun === true
      || (!artifactsBefore.proofBundleRow && !!artifactsAfter.proofBundleRow)
    ),
    proofBundleSkipReason: toText(
      scoringRun?.livePreferredOwnerOperationalProofBundleSkipReason
      || statusAfter?.livePreferredOwnerOperationalProofBundleSkipReason
      || statusBefore?.livePreferredOwnerOperationalProofBundleSkipReason
      || (
        !resolvedForOutcome
          ? checkpointAfter.checkpointReason
          : (proofBundleExistsAfter ? 'already_captured_or_created' : 'proof_bundle_missing_after_resolved_cycle')
      )
      || ''
    ) || null,
    advisoryOnly: true,
  };

  const summary = buildDrillSummary({
    drillOutcome,
    checkpoint: checkpointAfter,
    ownership: toOwnershipSnapshot(statusAfter, artifactsAfter.proofBundleRow),
    verifier: verifierSnapshot,
    operationalArtifacts,
    counters: artifactsAfter.counters,
  });

  return {
    ...summary,
    targetTradingDay,
    statusBefore,
    statusAfter,
    scoringRun,
    verifierRow: artifactsAfter.verifierRow,
    naturalWinRow: artifactsAfter.naturalWinRow,
    deferralCount: artifactsAfter.deferralCount,
    operationalVerdictRow: artifactsAfter.operationalVerdictRow,
    operationalProofBundleRow: artifactsAfter.proofBundleRow,
    advisoryOnly: true,
  };
}

module.exports = {
  PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_ENUM,
  runPreferredOwnerNaturalDrill,
  resolveDrillOutcome,
  readPreferredOwnerPostCloseVerifierRow,
  readPreferredOwnerNaturalWinRow,
  countPreferredOwnerDeferralsByTargetDay,
  readPreferredOwnerOperationalVerdictRow,
  readPreferredOwnerOperationalProofBundleRow,
  readNaturalPreferredOwnerCounterSnapshot,
};
