'use strict';

const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');
const {
  buildRegimePersistenceTrustOverrideSummary,
} = require('./regime-persistence-trust-override');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const ALLOWED_OVERRIDE_LABELS = new Set([
  'suppressed',
  'cautious',
  'enabled',
]);

const ALLOWED_CONFIDENCE_POLICIES = new Set([
  'suppress_confidence',
  'allow_cautious_confidence',
  'allow_structured_confidence',
]);

const ALLOWED_DELTA_DIRECTIONS = new Set([
  'improving',
  'flat',
  'regressing',
]);

const ALLOWED_DELTA_STRENGTH = new Set([
  'strong',
  'moderate',
  'weak',
]);

const ALLOWED_MOMENTUM_LABELS = new Set([
  'accelerating',
  'steady_improvement',
  'stalled',
  'oscillating',
  'deteriorating',
]);

const ALLOWED_BLOCKERS = new Set([
  'credibility_blocked',
  'credibility_not_strong_enough',
  'reconstructed_dominant',
  'mixed_history_constraint',
  'durability_unconfirmed',
  'quality_not_live_ready',
  'readiness_not_ready',
  'graduation_not_ready',
  'delta_not_supportive',
  'live_depth_insufficient',
  'coverage_insufficient',
]);

const ALLOWED_SUPPORTS = new Set([
  'credibility_cautious',
  'credibility_operational',
  'durability_confirmed',
  'quality_live_ready',
  'readiness_ready',
  'graduation_progressing',
  'delta_supportive',
  'blockers_reducing',
  'live_depth_sufficient',
  'coverage_sufficient',
]);

const ALLOWED_WARNINGS = new Set([
  'no_prior_override_snapshot',
  'thin_override_history',
  'reconstructed_dominant_history',
  'mixed_history_only',
  'current_policy_still_suppressed',
  'current_regime_not_operationally_ready',
]);

const OVERRIDE_POLICY_RANK = new Map([
  ['suppress_confidence', 0],
  ['allow_cautious_confidence', 1],
  ['allow_structured_confidence', 2],
]);

const OVERRIDE_LABEL_RANK = new Map([
  ['suppressed', 0],
  ['cautious', 1],
  ['enabled', 2],
]);

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeDate(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function normalizePerformanceSource(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live' || txt === 'backfill') return txt;
  return 'all';
}

function safeCanonicalRegimeLabel(value) {
  const label = normalizeRegimeLabel(value || 'unknown');
  return SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
}

function normalizeOverrideLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_OVERRIDE_LABELS.has(txt) ? txt : 'suppressed';
}

function normalizeConfidencePolicy(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_CONFIDENCE_POLICIES.has(txt) ? txt : 'suppress_confidence';
}

function normalizeDeltaDirection(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_DELTA_DIRECTIONS.has(txt) ? txt : 'flat';
}

function normalizeDeltaStrength(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_DELTA_STRENGTH.has(txt) ? txt : 'weak';
}

function normalizeMomentumLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_MOMENTUM_LABELS.has(txt) ? txt : 'stalled';
}

function normalizeBlockers(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_BLOCKERS.has(item));
}

function normalizeSupports(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_SUPPORTS.has(item));
}

function normalizeWarnings(list = []) {
  return Array.from(new Set((Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_WARNINGS.has(item))));
}

function normalizePersistenceProvenance(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'live_captured'
    || txt === 'reconstructed_from_historical_sources'
    || txt === 'mixed'
  ) {
    return txt;
  }
  return 'reconstructed_from_historical_sources';
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
}

function normalizeTrustBiasLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_confirmed') return 'live_confirmed';
  if (txt === 'mixed_support') return 'mixed_support';
  if (txt === 'retrospective_led') return 'retrospective_led';
  return 'insufficient_live_confirmation';
}

function normalizeEvidenceQuality(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong_live' || txt === 'mixed' || txt === 'retrospective_heavy' || txt === 'thin') return txt;
  return 'thin';
}

function normalizePromotionState(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'no_live_support'
    || txt === 'emerging_live_support'
    || txt === 'near_live_confirmation'
    || txt === 'live_confirmed'
    || txt === 'stalled_live_support'
  ) {
    return txt;
  }
  return 'no_live_support';
}

function normalizePersistenceSource(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'persisted_live_history'
    || txt === 'mixed_persisted_history'
    || txt === 'persisted_reconstructed_history'
    || txt === 'proxy_only'
  ) {
    return txt;
  }
  return 'proxy_only';
}

function normalizeConfidenceOverrideAction(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'increase_confidence') return 'increase_confidence';
  if (txt === 'no_material_change') return 'no_material_change';
  return 'decrease_confidence';
}

function normalizeOverrideRowShape(row = {}) {
  const regimeLabel = safeCanonicalRegimeLabel(row.regimeLabel || row.regime_label || row.regime || 'unknown');
  return {
    snapshot_date: normalizeDate(row.snapshot_date || row.snapshotDate || ''),
    regimeLabel,
    currentOverrideLabel: normalizeOverrideLabel(row.currentOverrideLabel || row.overrideLabel || row.override_label || 'suppressed'),
    currentConfidencePolicy: normalizeConfidencePolicy(row.currentConfidencePolicy || row.confidencePolicy || row.confidence_policy || 'suppress_confidence'),
    currentOverrideScore: round2(clamp(Number(row.currentOverrideScore != null ? row.currentOverrideScore : row.overrideScore || row.override_score || 0), 0, 100)),
    currentOverridePoints: clampInt(
      row.currentOverridePoints != null ? row.currentOverridePoints : row.confidenceOverridePoints != null ? row.confidenceOverridePoints : row.confidence_override_points,
      -12,
      6,
      0
    ),
    policyBlockers: normalizeBlockers(row.policyBlockers || row.policy_blockers || []),
    policySupports: normalizeSupports(row.policySupports || row.policy_supports || []),
    readyForOperationalUse: row.readyForOperationalUse === true || row.ready_for_operational_use === true || Number(row.ready_for_operational_use || 0) === 1,
    advisoryOnly: true,
  };
}

function normalizeOverrideHistoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeOverrideRowShape(row))
    .filter((row) => row.snapshot_date && SUPPORTED_REGIME_LABELS.includes(row.regimeLabel));
}

function normalizeConfirmationHistoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      snapshot_date: normalizeDate(row.snapshot_date || row.snapshotDate || ''),
      window_sessions: clampInt(row.window_sessions != null ? row.window_sessions : row.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS),
      performance_source: normalizePerformanceSource(row.performance_source || row.performanceSource || 'all'),
      regime_label: safeCanonicalRegimeLabel(row.regime_label || row.regimeLabel || row.regime || 'unknown'),
      promotion_state: normalizePromotionState(row.promotion_state || row.promotionState || 'no_live_support'),
      confirmation_progress_pct: clamp(toNumber(row.confirmation_progress_pct != null ? row.confirmation_progress_pct : row.confirmationProgressPct, 0), 0, 100),
      live_sample_size: Math.max(0, Number(row.live_sample_size != null ? row.live_sample_size : row.liveSampleSize || 0)),
      required_sample_for_promotion: Math.max(1, Number(row.required_sample_for_promotion != null ? row.required_sample_for_promotion : row.requiredSampleForPromotion || 15)),
      trust_bias_label: normalizeTrustBiasLabel(row.trust_bias_label || row.trustBiasLabel || 'insufficient_live_confirmation'),
      trust_consumption_label: normalizeTrustConsumptionLabel(row.trust_consumption_label || row.trustConsumptionLabel || 'suppress_regime_bias'),
      confidence_adjustment_override: toNumber(row.confidence_adjustment_override != null ? row.confidence_adjustment_override : row.confidenceAdjustmentOverride, 0),
      evidence_quality: normalizeEvidenceQuality(row.evidence_quality || row.evidenceQuality || 'thin'),
      persistence_provenance: normalizePersistenceProvenance(row.persistence_provenance || row.persistenceProvenance || 'reconstructed_from_historical_sources'),
      live_capture_count: Math.max(0, Number(row.live_capture_count != null ? row.live_capture_count : row.liveCaptureCount || 0)),
    }))
    .filter((row) => row.snapshot_date && SUPPORTED_REGIME_LABELS.includes(row.regime_label));
}

function rowHasLiveCapturedEvidence(row = {}) {
  const count = Math.max(0, Number(row.live_capture_count || 0));
  if (count > 0) return true;
  const provenance = normalizePersistenceProvenance(row.persistence_provenance || 'reconstructed_from_historical_sources');
  return provenance === 'live_captured' || provenance === 'mixed';
}

function derivePersistenceSourceFromCounts(counts = {}) {
  const liveCapturedDays = Math.max(0, Number(counts.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(counts.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(counts.mixedDays || 0));

  if (mixedDays > 0 || (liveCapturedDays > 0 && reconstructedDays > 0)) return 'mixed_persisted_history';
  if (liveCapturedDays > 0 && reconstructedDays <= 0) return 'persisted_live_history';
  if (reconstructedDays > 0) return 'persisted_reconstructed_history';
  return 'proxy_only';
}

function daysBetween(leftDate = '', rightDate = '') {
  const left = normalizeDate(leftDate);
  const right = normalizeDate(rightDate);
  if (!left || !right) return null;
  const a = new Date(`${left}T00:00:00.000Z`);
  const b = new Date(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return null;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

function collectDistinctRecentDates(rows = [], windowSessions = DEFAULT_WINDOW_SESSIONS) {
  const unique = Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => normalizeDate(row.snapshot_date || ''))
    .filter(Boolean)));
  unique.sort((a, b) => a.localeCompare(b));
  if (unique.length <= windowSessions) return unique;
  return unique.slice(unique.length - windowSessions);
}

function buildAggregateMeta(rowsUpToDate = [], targetDate = '') {
  const rows = Array.isArray(rowsUpToDate) ? rowsUpToDate : [];
  const liveCapturedDays = rows.filter((row) => normalizePersistenceProvenance(row.persistence_provenance) === 'live_captured').length;
  const reconstructedDays = rows.filter((row) => normalizePersistenceProvenance(row.persistence_provenance) === 'reconstructed_from_historical_sources').length;
  const mixedDays = rows.filter((row) => normalizePersistenceProvenance(row.persistence_provenance) === 'mixed').length;
  const totalSnapshots = rows.length;

  let liveCapturedTenureDays = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rowHasLiveCapturedEvidence(rows[i])) liveCapturedTenureDays += 1;
    else break;
  }

  let lastLiveCapturedDate = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rowHasLiveCapturedEvidence(rows[i])) {
      lastLiveCapturedDate = normalizeDate(rows[i].snapshot_date || '');
      break;
    }
  }

  const liveCoveragePct = totalSnapshots > 0
    ? round2(clamp(((liveCapturedDays + mixedDays) / totalSnapshots) * 100, 0, 100))
    : 0;

  return {
    totalSnapshots,
    liveCapturedDays,
    reconstructedDays,
    mixedDays,
    liveCapturedTenureDays,
    liveCoveragePct,
    hasLiveCapturedHistory: liveCapturedTenureDays > 0 || liveCapturedDays > 0 || mixedDays > 0,
    persistenceSource: derivePersistenceSourceFromCounts({
      liveCapturedDays,
      reconstructedDays,
      mixedDays,
    }),
    lastLiveCapturedDate,
    captureGapDays: daysBetween(lastLiveCapturedDate, targetDate),
  };
}

function loadConfirmationHistoryRowsFromDb(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return [];

  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const dates = db.prepare(`
    SELECT DISTINCT snapshot_date
    FROM jarvis_regime_confirmation_history
    WHERE performance_source = ?
      AND window_sessions = ?
    ORDER BY snapshot_date DESC
    LIMIT ?
  `).all(performanceSource, windowSessions, windowSessions)
    .map((row) => normalizeDate(row.snapshot_date))
    .filter(Boolean);

  if (!dates.length) return [];

  const placeholders = dates.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM jarvis_regime_confirmation_history
    WHERE performance_source = ?
      AND window_sessions = ?
      AND snapshot_date IN (${placeholders})
    ORDER BY snapshot_date ASC, regime_label ASC
  `).all(performanceSource, windowSessions, ...dates);

  return normalizeConfirmationHistoryRows(rows);
}

function deriveSupportsFromSignals(input = {}) {
  const supports = [];
  if (input.operationalTrustGate === 'cautious_use') supports.push('credibility_cautious');
  if (input.operationalTrustGate === 'operationally_credible') supports.push('credibility_operational');
  if (input.promotionState === 'live_confirmed' && input.trustConsumptionLabel !== 'suppress_regime_bias') supports.push('durability_confirmed');
  if (input.persistenceQualityLabel === 'live_ready') supports.push('quality_live_ready');
  if (input.readyForOperationalUse) supports.push('readiness_ready');
  if (input.deltaDirection === 'improving') supports.push('graduation_progressing');
  if (input.deltaDirection === 'improving' || input.trustBiasLabel === 'live_confirmed') supports.push('delta_supportive');
  if (input.liveCapturedTenureDays >= 5) supports.push('live_depth_sufficient');
  if (input.liveCaptureCoveragePct >= 50) supports.push('coverage_sufficient');
  return normalizeSupports(supports);
}

function deriveBlockersFromSignals(input = {}) {
  const blockers = [];

  if (input.operationalTrustGate === 'blocked') blockers.push('credibility_blocked');
  if (input.operationalTrustGate !== 'operationally_credible') blockers.push('credibility_not_strong_enough');
  if (input.persistenceSource === 'persisted_reconstructed_history' || input.persistenceSource === 'proxy_only') blockers.push('reconstructed_dominant');
  if (input.persistenceSource === 'mixed_persisted_history') blockers.push('mixed_history_constraint');
  if (input.durabilityState === 'unconfirmed') blockers.push('durability_unconfirmed');
  if (input.persistenceQualityLabel === 'insufficient_live_depth') blockers.push('quality_not_live_ready');
  if (!input.readinessReady) blockers.push('readiness_not_ready');
  if (!input.readyForOperationalUse) blockers.push('graduation_not_ready');
  if (input.deltaDirection !== 'improving') blockers.push('delta_not_supportive');
  if (input.liveCapturedTenureDays < 3) blockers.push('live_depth_insufficient');
  if (input.liveCaptureCoveragePct < 35) blockers.push('coverage_insufficient');

  return normalizeBlockers(blockers);
}

function deriveOverridePolicyFromSignals(input = {}) {
  let overrideLabel = 'suppressed';
  let confidencePolicy = 'suppress_confidence';
  let confidenceOverrideAction = 'decrease_confidence';

  if (input.overrideScore >= 45 && input.operationalTrustGate !== 'blocked') {
    overrideLabel = 'cautious';
    confidencePolicy = 'allow_cautious_confidence';
    confidenceOverrideAction = 'no_material_change';
  }

  const structuredEligible = (
    input.operationalTrustGate === 'operationally_credible'
    && input.persistenceSource === 'persisted_live_history'
    && input.durabilityState !== 'unconfirmed'
    && input.persistenceQualityLabel !== 'insufficient_live_depth'
    && input.readinessReady
    && input.readyForOperationalUse
    && input.liveCapturedTenureDays >= 5
    && input.liveCaptureCoveragePct >= 50
    && input.deltaDirection !== 'regressing'
  );

  if (structuredEligible && input.overrideScore >= 72) {
    overrideLabel = 'enabled';
    confidencePolicy = 'allow_structured_confidence';
    confidenceOverrideAction = 'increase_confidence';
  }

  if (input.operationalTrustGate === 'blocked') {
    overrideLabel = 'suppressed';
    confidencePolicy = 'suppress_confidence';
    confidenceOverrideAction = 'decrease_confidence';
  }

  if (input.operationalTrustGate === 'cautious_use' && confidencePolicy === 'allow_structured_confidence') {
    overrideLabel = 'cautious';
    confidencePolicy = 'allow_cautious_confidence';
    confidenceOverrideAction = 'no_material_change';
  }

  if (
    input.persistenceSource !== 'persisted_live_history'
    || input.durabilityState === 'unconfirmed'
    || input.persistenceQualityLabel === 'insufficient_live_depth'
    || !input.readinessReady
    || !input.readyForOperationalUse
  ) {
    if (confidencePolicy === 'allow_structured_confidence') {
      overrideLabel = 'cautious';
      confidencePolicy = 'allow_cautious_confidence';
      confidenceOverrideAction = 'no_material_change';
    }
  }

  if (input.deltaDirection === 'regressing') {
    overrideLabel = 'suppressed';
    confidencePolicy = 'suppress_confidence';
    confidenceOverrideAction = 'decrease_confidence';
  }

  if (
    confidencePolicy === 'allow_cautious_confidence'
    && (
      input.liveCapturedTenureDays < 2
      || input.liveCaptureCoveragePct < 20
      || input.persistenceSource === 'persisted_reconstructed_history'
      || input.persistenceSource === 'proxy_only'
    )
  ) {
    overrideLabel = 'suppressed';
    confidencePolicy = 'suppress_confidence';
    confidenceOverrideAction = 'decrease_confidence';
  }

  return {
    overrideLabel: normalizeOverrideLabel(overrideLabel),
    confidencePolicy: normalizeConfidencePolicy(confidencePolicy),
    confidenceOverrideAction: normalizeConfidenceOverrideAction(confidenceOverrideAction),
  };
}

function deriveOverridePoints(policy = {}, blockerCount = 0, supportCount = 0) {
  const label = normalizeOverrideLabel(policy.overrideLabel);
  if (label === 'suppressed') return clampInt(-4 - blockerCount, -12, -1, -4);
  if (label === 'cautious') return clampInt(supportCount - blockerCount, -3, 2, 0);
  return clampInt(2 + supportCount - Math.floor(blockerCount / 2), 1, 6, 2);
}

function derivePriorOverrideFromConfirmationRow(regimeLabel, row = {}, aggregate = {}) {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel);
  const promotionState = normalizePromotionState(row.promotion_state || 'no_live_support');
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(row.trust_consumption_label || 'suppress_regime_bias');
  const trustBiasLabel = normalizeTrustBiasLabel(row.trust_bias_label || 'insufficient_live_confirmation');
  const evidenceQuality = normalizeEvidenceQuality(row.evidence_quality || 'thin');
  const liveSampleSize = Math.max(0, Number(row.live_sample_size || 0));
  const requiredSample = Math.max(1, Number(row.required_sample_for_promotion || 15));
  const confirmationProgressPct = clamp(Number(row.confirmation_progress_pct || 0), 0, 100);

  const persistenceSource = normalizePersistenceSource(aggregate.persistenceSource || 'proxy_only');
  const liveCapturedTenureDays = Math.max(0, Number(aggregate.liveCapturedTenureDays || 0));
  const liveCaptureCoveragePct = clamp(Number(aggregate.liveCoveragePct || 0), 0, 100);
  const hasLiveCapturedHistory = aggregate.hasLiveCapturedHistory === true;

  const durabilityState = (
    promotionState === 'live_confirmed' && trustConsumptionLabel !== 'suppress_regime_bias'
      ? (trustConsumptionLabel === 'allow_regime_confidence' ? 'durable_confirmed' : 'building_durability')
      : (promotionState === 'near_live_confirmation' || promotionState === 'emerging_live_support')
        ? 'building_durability'
        : 'unconfirmed'
  );

  const persistenceQualityLabel = (
    persistenceSource === 'persisted_live_history' && liveCapturedTenureDays >= 5 && liveCaptureCoveragePct >= 50
      ? 'live_ready'
      : (!hasLiveCapturedHistory || liveCapturedTenureDays < 3 || liveSampleSize < 5)
        ? 'insufficient_live_depth'
        : ((persistenceSource === 'mixed_persisted_history' || persistenceSource === 'persisted_reconstructed_history')
          && Number(aggregate.reconstructedDays || 0) > Number(aggregate.liveCapturedDays || 0))
          ? 'mostly_reconstructed'
          : 'partially_live_supported'
  );

  const readinessReady = (
    promotionState === 'live_confirmed'
    && liveSampleSize >= requiredSample
    && trustConsumptionLabel !== 'suppress_regime_bias'
    && persistenceQualityLabel !== 'insufficient_live_depth'
  );

  const readyForOperationalUse = (
    readinessReady
    && persistenceSource === 'persisted_live_history'
    && liveCapturedTenureDays >= 5
    && liveCaptureCoveragePct >= 50
    && evidenceQuality !== 'retrospective_heavy'
  );

  let operationalTrustGate = 'blocked';
  if (readyForOperationalUse) operationalTrustGate = 'operationally_credible';
  else if (hasLiveCapturedHistory && trustConsumptionLabel !== 'suppress_regime_bias' && promotionState !== 'no_live_support') operationalTrustGate = 'cautious_use';

  let overrideScore = 20;
  overrideScore += confirmationProgressPct * 0.45;
  overrideScore += Math.min(20, liveSampleSize * 1.5);
  if (trustConsumptionLabel === 'allow_regime_confidence') overrideScore += 10;
  else if (trustConsumptionLabel === 'allow_with_caution') overrideScore += 4;
  else if (trustConsumptionLabel === 'reduce_regime_weight') overrideScore -= 4;
  else overrideScore -= 10;

  if (persistenceSource === 'persisted_live_history') overrideScore += 12;
  else if (persistenceSource === 'mixed_persisted_history') overrideScore -= 5;
  else if (persistenceSource === 'persisted_reconstructed_history') overrideScore -= 12;
  else overrideScore -= 15;

  if (evidenceQuality === 'strong_live') overrideScore += 8;
  else if (evidenceQuality === 'mixed') overrideScore += 2;
  else if (evidenceQuality === 'retrospective_heavy') overrideScore -= 8;
  else overrideScore -= 10;

  if (promotionState === 'live_confirmed') overrideScore += 10;
  else if (promotionState === 'near_live_confirmation') overrideScore += 5;
  else if (promotionState === 'emerging_live_support') overrideScore += 2;
  else if (promotionState === 'stalled_live_support') overrideScore -= 5;
  else overrideScore -= 10;

  overrideScore = clamp(overrideScore, 0, 100);

  if (operationalTrustGate === 'blocked') overrideScore = Math.min(overrideScore, 34);
  if (operationalTrustGate === 'cautious_use') overrideScore = Math.min(overrideScore, 69);
  if (persistenceSource !== 'persisted_live_history') overrideScore = Math.min(overrideScore, 69);
  if (persistenceSource === 'persisted_reconstructed_history' || persistenceSource === 'proxy_only') overrideScore = Math.min(overrideScore, 39);
  if (durabilityState === 'unconfirmed') overrideScore = Math.min(overrideScore, 64);
  if (persistenceQualityLabel === 'insufficient_live_depth') overrideScore = Math.min(overrideScore, 59);
  if (!readinessReady || !readyForOperationalUse) overrideScore = Math.min(overrideScore, 69);
  if (!hasLiveCapturedHistory) overrideScore = Math.min(overrideScore, 39);
  if (liveCapturedTenureDays < 3) overrideScore = Math.min(overrideScore, 54);
  if (liveCaptureCoveragePct < 35) overrideScore = Math.min(overrideScore, 59);

  const deltaDirection = (
    trustBiasLabel === 'live_confirmed' || trustBiasLabel === 'mixed_support'
      ? 'improving'
      : 'flat'
  );

  const blockers = deriveBlockersFromSignals({
    operationalTrustGate,
    persistenceSource,
    durabilityState,
    persistenceQualityLabel,
    readinessReady,
    readyForOperationalUse,
    deltaDirection,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
  });

  const supports = deriveSupportsFromSignals({
    operationalTrustGate,
    promotionState,
    trustConsumptionLabel,
    persistenceQualityLabel,
    readyForOperationalUse,
    deltaDirection,
    trustBiasLabel,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
  });

  const policy = deriveOverridePolicyFromSignals({
    overrideScore,
    operationalTrustGate,
    persistenceSource,
    durabilityState,
    persistenceQualityLabel,
    readinessReady,
    readyForOperationalUse,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    deltaDirection,
  });

  const confidenceOverridePoints = deriveOverridePoints(policy, blockers.length, supports.length);

  return {
    snapshot_date: normalizeDate(row.snapshot_date || ''),
    regimeLabel: safeRegime,
    currentOverrideLabel: policy.overrideLabel,
    currentConfidencePolicy: policy.confidencePolicy,
    currentOverrideScore: round2(overrideScore),
    currentOverridePoints: confidenceOverridePoints,
    policyBlockers: blockers,
    policySupports: supports,
    readyForOperationalUse,
    advisoryOnly: true,
  };
}

function reconstructOverrideHistoryRowsFromConfirmationRows(rows = []) {
  const safeRows = normalizeConfirmationHistoryRows(rows);
  if (!safeRows.length) return [];

  const byRegime = new Map();
  for (const label of SUPPORTED_REGIME_LABELS) byRegime.set(label, []);
  for (const row of safeRows) {
    const label = safeCanonicalRegimeLabel(row.regime_label || 'unknown');
    if (!byRegime.has(label)) byRegime.set(label, []);
    byRegime.get(label).push(row);
  }
  for (const list of byRegime.values()) {
    list.sort((a, b) => normalizeDate(a.snapshot_date).localeCompare(normalizeDate(b.snapshot_date)));
  }

  const output = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const rowsForRegime = byRegime.get(regimeLabel) || [];
    for (let idx = 0; idx < rowsForRegime.length; idx += 1) {
      const row = rowsForRegime[idx];
      const upto = rowsForRegime.slice(0, idx + 1);
      const aggregate = buildAggregateMeta(upto, row.snapshot_date);
      output.push(derivePriorOverrideFromConfirmationRow(regimeLabel, row, aggregate));
    }
  }

  return output
    .map((row) => normalizeOverrideRowShape(row))
    .filter((row) => row.snapshot_date && SUPPORTED_REGIME_LABELS.includes(row.regimeLabel));
}

function findCurrentRowFromSummary(summary = {}, regimeLabel = 'unknown') {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel);
  const rows = Array.isArray(summary?.trustOverrideByRegime) ? summary.trustOverrideByRegime : [];
  const found = rows.find((row) => safeCanonicalRegimeLabel(row?.regimeLabel || 'unknown') === safeRegime);
  if (found) {
    return normalizeOverrideRowShape({
      ...found,
      regimeLabel: safeRegime,
      currentOverrideLabel: found.overrideLabel,
      currentConfidencePolicy: found.confidencePolicy,
      currentOverrideScore: found.overrideScore,
      currentOverridePoints: found.confidenceOverridePoints,
    });
  }
  if (safeRegime === safeCanonicalRegimeLabel(summary?.currentRegimeLabel || 'unknown')) {
    return normalizeOverrideRowShape({
      regimeLabel: safeRegime,
      currentOverrideLabel: summary.overrideLabel,
      currentConfidencePolicy: summary.confidencePolicy,
      currentOverrideScore: summary.overrideScore,
      currentOverridePoints: summary.confidenceOverridePoints,
      policyBlockers: summary.policyBlockers,
      policySupports: summary.policySupports,
      readyForOperationalUse: summary.readyForOperationalUse === true,
    });
  }
  return normalizeOverrideRowShape({ regimeLabel: safeRegime });
}

function findPriorRow(historyRows = [], regimeLabel = 'unknown') {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel);
  const rows = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => safeCanonicalRegimeLabel(row.regimeLabel || row.regime_label || row.regime || 'unknown') === safeRegime)
    .sort((a, b) => normalizeDate(a.snapshot_date).localeCompare(normalizeDate(b.snapshot_date)));

  if (rows.length < 2) return null;
  return normalizeOverrideRowShape(rows[rows.length - 2]);
}

function diffLists(currentList = [], priorList = [], normalizer) {
  const current = normalizer(currentList || []);
  const prior = normalizer(priorList || []);
  const currentSet = new Set(current);
  const priorSet = new Set(prior);
  return {
    added: current.filter((item) => !priorSet.has(item)),
    removed: prior.filter((item) => !currentSet.has(item)),
    unchanged: current.filter((item) => priorSet.has(item)),
  };
}

function classifyDeltaDirection(delta = 0, hasPrior = false) {
  if (!hasPrior) return 'flat';
  const safe = Number(delta || 0);
  if (safe > 5) return 'improving';
  if (safe < -5) return 'regressing';
  return 'flat';
}

function classifyDeltaStrength(delta = 0, hasPrior = false) {
  if (!hasPrior) return 'weak';
  const absDelta = Math.abs(Number(delta || 0));
  if (absDelta >= 15) return 'strong';
  if (absDelta >= 7) return 'moderate';
  return 'weak';
}

function classifyMomentum(input = {}) {
  const hasPrior = input.hasPrior === true;
  if (!hasPrior) return 'stalled';

  const deltaDirection = normalizeDeltaDirection(input.deltaDirection);
  const blockersAdded = Math.max(0, Number(input.blockersAdded || 0));
  const blockersRemoved = Math.max(0, Number(input.blockersRemoved || 0));
  const supportsAdded = Math.max(0, Number(input.supportsAdded || 0));
  const supportsRemoved = Math.max(0, Number(input.supportsRemoved || 0));
  const policyMoreRestrictive = input.policyMoreRestrictive === true;
  const labelMoreRestrictive = input.labelMoreRestrictive === true;
  const reconstructedDominant = input.reconstructedDominant === true;
  const thinHistory = input.thinHistory === true;
  const currentSuppressed = normalizeOverrideLabel(input.currentOverrideLabel) === 'suppressed';

  if (deltaDirection === 'regressing' || policyMoreRestrictive || labelMoreRestrictive) {
    return 'deteriorating';
  }

  if (deltaDirection === 'improving') {
    const blockersNetPositive = blockersRemoved > blockersAdded;
    const supportsNetPositive = supportsAdded >= supportsRemoved;
    if (
      blockersNetPositive
      && supportsNetPositive
      && !reconstructedDominant
      && !thinHistory
      && !currentSuppressed
    ) {
      return 'accelerating';
    }
    return 'steady_improvement';
  }

  if (deltaDirection === 'flat') {
    const mixedBlockerChange = blockersAdded > 0 && blockersRemoved > 0;
    const mixedSupportChange = supportsAdded > 0 && supportsRemoved > 0;
    if (mixedBlockerChange || mixedSupportChange) return 'oscillating';
    return 'stalled';
  }

  return 'deteriorating';
}

function buildInsight(input = {}) {
  const regimeLabel = safeCanonicalRegimeLabel(input.regimeLabel || 'unknown');
  const hasPrior = input.hasPrior === true;
  const momentum = normalizeMomentumLabel(input.momentumLabel);
  const delta = round2(Number(input.overrideScoreDelta || 0));
  const direction = normalizeDeltaDirection(input.deltaDirection);
  const blockersAdded = Math.max(0, Number(input.blockersAdded || 0));
  const blockersRemoved = Math.max(0, Number(input.blockersRemoved || 0));

  if (!hasPrior) {
    return `${regimeLabel} trust-override delta is conservative because no prior comparable policy snapshot is available.`;
  }
  if (momentum === 'accelerating') {
    return `${regimeLabel} trust-override momentum is accelerating (${delta} ${direction}) with net blocker removal.`;
  }
  if (momentum === 'steady_improvement') {
    return `${regimeLabel} trust-override movement is improving (${delta} ${direction}) but remains bounded by conservative gates.`;
  }
  if (momentum === 'oscillating') {
    return `${regimeLabel} trust-override movement is oscillating (${blockersAdded} blockers added, ${blockersRemoved} removed).`;
  }
  if (momentum === 'deteriorating') {
    return `${regimeLabel} trust-override movement is deteriorating (${delta} ${direction}) with tighter policy posture.`;
  }
  return `${regimeLabel} trust-override movement is stalled with limited net blocker/support change.`;
}

function buildCurrentSummaryFallback(input = {}) {
  return buildRegimePersistenceTrustOverrideSummary({
    windowSessions: clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS),
    performanceSource: normalizePerformanceSource(input.performanceSource || input.source || 'all'),
    regimePersistenceOperationalCredibility: input.regimePersistenceOperationalCredibility,
    regimePersistenceGraduationDelta: input.regimePersistenceGraduationDelta,
    regimePersistenceGraduation: input.regimePersistenceGraduation,
    regimePersistenceReadiness: input.regimePersistenceReadiness,
    regimeLivePersistenceQuality: input.regimeLivePersistenceQuality,
    regimeConfirmationDurability: input.regimeConfirmationDurability,
    regimeConfirmationHistory: input.regimeConfirmationHistory,
    regimeTrustConsumption: input.regimeTrustConsumption,
  });
}

function buildRegimePersistenceTrustOverrideDeltaSummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const currentOverrideSummary = input.regimePersistenceTrustOverride && typeof input.regimePersistenceTrustOverride === 'object'
    ? input.regimePersistenceTrustOverride
    : buildCurrentSummaryFallback({
      windowSessions,
      performanceSource,
      ...input,
    });

  const regimePersistenceReadiness = input.regimePersistenceReadiness && typeof input.regimePersistenceReadiness === 'object'
    ? input.regimePersistenceReadiness
    : {};
  const regimeConfirmationHistory = input.regimeConfirmationHistory && typeof input.regimeConfirmationHistory === 'object'
    ? input.regimeConfirmationHistory
    : {};

  const currentRegimeLabel = safeCanonicalRegimeLabel(
    currentOverrideSummary.currentRegimeLabel
      || regimePersistenceReadiness.currentRegimeLabel
      || regimeConfirmationHistory.currentRegimeLabel
      || 'unknown'
  );

  const providedOverrideHistoryRows = normalizeOverrideHistoryRows(input.overrideHistoryRows || []);
  const confirmationHistoryRows = normalizeConfirmationHistoryRows(input.historyRows || []);

  let effectiveConfirmationRows = confirmationHistoryRows;
  if (!effectiveConfirmationRows.length) {
    effectiveConfirmationRows = loadConfirmationHistoryRowsFromDb({
      db: input.db,
      windowSessions,
      performanceSource,
    });
  }

  const reconstructedOverrideRows = reconstructOverrideHistoryRowsFromConfirmationRows(effectiveConfirmationRows);
  const overrideHistoryRows = providedOverrideHistoryRows.length
    ? providedOverrideHistoryRows
    : reconstructedOverrideRows;

  const historyDates = collectDistinctRecentDates(
    providedOverrideHistoryRows.length
      ? providedOverrideHistoryRows
      : effectiveConfirmationRows,
    windowSessions
  );

  const historyCoverageDays = Number.isFinite(Number(regimeConfirmationHistory?.historyCoverageDays))
    ? Number(regimeConfirmationHistory.historyCoverageDays)
    : historyDates.length;

  const persistenceSource = normalizePersistenceSource(
    regimePersistenceReadiness?.persistenceSource
      || input.regimeConfirmationDurability?.persistenceSource
      || 'proxy_only'
  );

  const historyProvenanceBreakdown = regimeConfirmationHistory?.historyProvenanceBreakdown && typeof regimeConfirmationHistory.historyProvenanceBreakdown === 'object'
    ? regimeConfirmationHistory.historyProvenanceBreakdown
    : {
      liveCapturedDays: 0,
      reconstructedDays: 0,
      mixedDays: 0,
    };

  const reconstructedDominantHistory = (
    persistenceSource === 'persisted_reconstructed_history'
    || persistenceSource === 'proxy_only'
    || Number(historyProvenanceBreakdown.reconstructedDays || 0) > Number(historyProvenanceBreakdown.liveCapturedDays || 0)
  );

  const mixedHistoryOnly = persistenceSource === 'mixed_persisted_history';

  const trustOverrideDeltaByRegime = [];

  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const currentRow = findCurrentRowFromSummary(currentOverrideSummary, regimeLabel);
    const priorRow = findPriorRow(overrideHistoryRows, regimeLabel);
    const hasPrior = !!priorRow;

    const currentScore = round2(clamp(Number(currentRow.currentOverrideScore || 0), 0, 100));
    const priorScore = hasPrior ? round2(clamp(Number(priorRow.currentOverrideScore || 0), 0, 100)) : null;
    const overrideScoreDelta = hasPrior ? round2(currentScore - Number(priorScore || 0)) : 0;

    const currentPoints = clampInt(currentRow.currentOverridePoints, -12, 6, 0);
    const priorPoints = hasPrior ? clampInt(priorRow.currentOverridePoints, -12, 6, 0) : null;
    const overridePointsDelta = hasPrior ? round2(currentPoints - Number(priorPoints || 0)) : 0;

    const deltaDirection = classifyDeltaDirection(overrideScoreDelta, hasPrior);
    const deltaStrength = classifyDeltaStrength(overrideScoreDelta, hasPrior);

    const blockerDiff = diffLists(
      currentRow.policyBlockers,
      priorRow?.policyBlockers || [],
      normalizeBlockers
    );
    const supportDiff = diffLists(
      currentRow.policySupports,
      priorRow?.policySupports || [],
      normalizeSupports
    );

    const currentLabel = normalizeOverrideLabel(currentRow.currentOverrideLabel);
    const priorLabel = hasPrior ? normalizeOverrideLabel(priorRow.currentOverrideLabel) : null;
    const currentPolicy = normalizeConfidencePolicy(currentRow.currentConfidencePolicy);
    const priorPolicy = hasPrior ? normalizeConfidencePolicy(priorRow.currentConfidencePolicy) : null;

    const labelChanged = hasPrior ? currentLabel !== priorLabel : false;
    const policyChanged = hasPrior ? currentPolicy !== priorPolicy : false;

    const policyMoreRestrictive = hasPrior
      ? (OVERRIDE_POLICY_RANK.get(currentPolicy) || 0) < (OVERRIDE_POLICY_RANK.get(priorPolicy) || 0)
      : false;
    const labelMoreRestrictive = hasPrior
      ? (OVERRIDE_LABEL_RANK.get(currentLabel) || 0) < (OVERRIDE_LABEL_RANK.get(priorLabel) || 0)
      : false;

    const momentumLabel = classifyMomentum({
      hasPrior,
      deltaDirection,
      blockersAdded: blockerDiff.added.length,
      blockersRemoved: blockerDiff.removed.length,
      supportsAdded: supportDiff.added.length,
      supportsRemoved: supportDiff.removed.length,
      policyMoreRestrictive,
      labelMoreRestrictive,
      reconstructedDominant: reconstructedDominantHistory,
      thinHistory: historyCoverageDays < 3,
      currentOverrideLabel: currentLabel,
    });

    trustOverrideDeltaByRegime.push({
      regimeLabel,
      currentOverrideLabel: currentLabel,
      priorOverrideLabel: priorLabel,
      currentConfidencePolicy: currentPolicy,
      priorConfidencePolicy: priorPolicy,
      currentOverrideScore: currentScore,
      priorOverrideScore: hasPrior ? priorScore : null,
      overrideScoreDelta,
      overridePointsDelta,
      deltaDirection: normalizeDeltaDirection(deltaDirection),
      deltaStrength: normalizeDeltaStrength(deltaStrength),
      momentumLabel: normalizeMomentumLabel(momentumLabel),
      blockersAdded: blockerDiff.added,
      blockersRemoved: blockerDiff.removed,
      supportsAdded: supportDiff.added,
      supportsRemoved: supportDiff.removed,
      labelChanged,
      policyChanged,
      readyForOperationalUse: currentRow.readyForOperationalUse === true,
      advisoryOnly: true,
    });
  }

  const currentDeltaRow = trustOverrideDeltaByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || {
      regimeLabel: currentRegimeLabel,
      currentOverrideLabel: normalizeOverrideLabel(currentOverrideSummary.overrideLabel || 'suppressed'),
      priorOverrideLabel: null,
      currentConfidencePolicy: normalizeConfidencePolicy(currentOverrideSummary.confidencePolicy || 'suppress_confidence'),
      priorConfidencePolicy: null,
      currentOverrideScore: round2(clamp(Number(currentOverrideSummary.overrideScore || 0), 0, 100)),
      priorOverrideScore: null,
      overrideScoreDelta: 0,
      overridePointsDelta: 0,
      deltaDirection: 'flat',
      deltaStrength: 'weak',
      momentumLabel: 'stalled',
      blockersAdded: normalizeBlockers(currentOverrideSummary.policyBlockers || []),
      blockersRemoved: [],
      supportsAdded: normalizeSupports(currentOverrideSummary.policySupports || []),
      supportsRemoved: [],
      labelChanged: false,
      policyChanged: false,
      readyForOperationalUse: currentOverrideSummary.readyForOperationalUse === true,
      advisoryOnly: true,
    };

  const hasPriorCurrent = currentDeltaRow.priorOverrideScore != null
    && Number.isFinite(Number(currentDeltaRow.priorOverrideScore));

  const improvingOverrideRegimeLabels = trustOverrideDeltaByRegime
    .filter((row) => row.momentumLabel === 'accelerating' || row.momentumLabel === 'steady_improvement')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const regressingOverrideRegimeLabels = trustOverrideDeltaByRegime
    .filter((row) => row.momentumLabel === 'deteriorating' || row.deltaDirection === 'regressing')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const stalledOverrideRegimeLabels = trustOverrideDeltaByRegime
    .filter((row) => row.momentumLabel === 'stalled')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const oscillatingOverrideRegimeLabels = trustOverrideDeltaByRegime
    .filter((row) => row.momentumLabel === 'oscillating')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const warnings = [];
  if (!hasPriorCurrent) warnings.push('no_prior_override_snapshot');
  if (historyCoverageDays < 3) warnings.push('thin_override_history');
  if (reconstructedDominantHistory) warnings.push('reconstructed_dominant_history');
  if (mixedHistoryOnly) warnings.push('mixed_history_only');
  if (normalizeOverrideLabel(currentDeltaRow.currentOverrideLabel) === 'suppressed') warnings.push('current_policy_still_suppressed');
  if (currentDeltaRow.readyForOperationalUse !== true) warnings.push('current_regime_not_operationally_ready');

  const trustOverrideDeltaInsight = buildInsight({
    regimeLabel: currentRegimeLabel,
    hasPrior: hasPriorCurrent,
    momentumLabel: currentDeltaRow.momentumLabel,
    overrideScoreDelta: currentDeltaRow.overrideScoreDelta,
    deltaDirection: currentDeltaRow.deltaDirection,
    blockersAdded: Array.isArray(currentDeltaRow.blockersAdded) ? currentDeltaRow.blockersAdded.length : 0,
    blockersRemoved: Array.isArray(currentDeltaRow.blockersRemoved) ? currentDeltaRow.blockersRemoved.length : 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    currentOverrideLabel: normalizeOverrideLabel(currentDeltaRow.currentOverrideLabel),
    priorOverrideLabel: currentDeltaRow.priorOverrideLabel ? normalizeOverrideLabel(currentDeltaRow.priorOverrideLabel) : null,
    currentConfidencePolicy: normalizeConfidencePolicy(currentDeltaRow.currentConfidencePolicy),
    priorConfidencePolicy: currentDeltaRow.priorConfidencePolicy ? normalizeConfidencePolicy(currentDeltaRow.priorConfidencePolicy) : null,
    currentOverrideScore: round2(Number(currentDeltaRow.currentOverrideScore || 0)),
    priorOverrideScore: hasPriorCurrent
      ? round2(Number(currentDeltaRow.priorOverrideScore))
      : null,
    overrideScoreDelta: round2(Number(currentDeltaRow.overrideScoreDelta || 0)),
    overridePointsDelta: round2(Number(currentDeltaRow.overridePointsDelta || 0)),
    deltaDirection: normalizeDeltaDirection(currentDeltaRow.deltaDirection),
    deltaStrength: normalizeDeltaStrength(currentDeltaRow.deltaStrength),
    momentumLabel: normalizeMomentumLabel(currentDeltaRow.momentumLabel),
    blockersAdded: normalizeBlockers(currentDeltaRow.blockersAdded || []),
    blockersRemoved: normalizeBlockers(currentDeltaRow.blockersRemoved || []),
    supportsAdded: normalizeSupports(currentDeltaRow.supportsAdded || []),
    supportsRemoved: normalizeSupports(currentDeltaRow.supportsRemoved || []),
    labelChanged: currentDeltaRow.labelChanged === true,
    policyChanged: currentDeltaRow.policyChanged === true,
    trustOverrideDeltaInsight,
    readyForOperationalUse: currentDeltaRow.readyForOperationalUse === true,
    improvingOverrideRegimeLabels,
    regressingOverrideRegimeLabels,
    stalledOverrideRegimeLabels,
    oscillatingOverrideRegimeLabels,
    trustOverrideDeltaByRegime,
    warnings: normalizeWarnings(warnings),
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePersistenceTrustOverrideDeltaSummary,
};
