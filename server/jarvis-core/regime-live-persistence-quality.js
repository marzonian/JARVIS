'use strict';

const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const ALLOWED_CADENCE_LABELS = new Set([
  'healthy',
  'improving',
  'sparse',
  'stale',
]);

const ALLOWED_PERSISTENCE_QUALITY_LABELS = new Set([
  'live_ready',
  'partially_live_supported',
  'mostly_reconstructed',
  'insufficient_live_depth',
]);

const ALLOWED_DURABILITY_CONSTRAINTS = new Set([
  'capture_cadence_limited',
  'live_depth_limited',
  'regime_quality_limited',
  'mixed_constraints',
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

function normalizePersistenceSource(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'persisted_live_history'
    || txt === 'persisted_reconstructed_history'
    || txt === 'mixed_persisted_history'
    || txt === 'proxy_only'
  ) {
    return txt;
  }
  return 'proxy_only';
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
}

function normalizeCadenceLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_CADENCE_LABELS.has(txt)) return txt;
  return 'stale';
}

function normalizePersistenceQualityLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_PERSISTENCE_QUALITY_LABELS.has(txt)) return txt;
  return 'insufficient_live_depth';
}

function normalizeDurabilityConstraint(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_DURABILITY_CONSTRAINTS.has(txt)) return txt;
  return 'mixed_constraints';
}

function parseDateToUtc(value = '') {
  const iso = normalizeDate(value);
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function daysBetween(leftDate = '', rightDate = '') {
  const left = parseDateToUtc(leftDate);
  const right = parseDateToUtc(rightDate);
  if (!left || !right) return null;
  return Math.max(0, Math.floor((right.getTime() - left.getTime()) / 86_400_000));
}

function findByRegime(rows = [], regimeLabel = '') {
  const target = normalizeRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    normalizeRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === target
  )) || null;
}

function normalizeBreakdown(input = {}) {
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(input.mixedDays || 0));
  return {
    liveCapturedDays,
    reconstructedDays,
    mixedDays,
  };
}

function classifyCadenceLabel(input = {}) {
  const hasLive = input.currentRegimeHasLiveCapturedHistory === true;
  const gapDays = Number.isFinite(Number(input.currentRegimeCaptureGapDays))
    ? Math.max(0, Number(input.currentRegimeCaptureGapDays))
    : null;
  const coveragePct = Math.max(0, Number(input.liveCaptureCoveragePct || 0));
  const tenure = Math.max(0, Number(input.currentRegimeLiveCapturedTenureDays || 0));
  const materiallyLargeGap = Number.isFinite(gapDays) && gapDays > 7;

  if (!hasLive || materiallyLargeGap || !Number.isFinite(gapDays)) return 'stale';
  if (gapDays <= 1 && coveragePct >= 50) return 'healthy';
  if (tenure >= 2 && coveragePct >= 20) return 'improving';
  return 'sparse';
}

function classifyPersistenceQualityLabel(input = {}) {
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.currentRegimeHasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.currentRegimeLiveCapturedTenureDays || 0));
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));

  if (persistenceSource === 'persisted_live_history' && hasLive && liveTenure >= 5) {
    return 'live_ready';
  }
  if (!hasLive || liveTenure < 3) {
    return 'insufficient_live_depth';
  }
  if (
    (persistenceSource === 'persisted_reconstructed_history' || persistenceSource === 'mixed_persisted_history')
    && reconstructedDays > liveCapturedDays
  ) {
    return 'mostly_reconstructed';
  }
  if (persistenceSource === 'persisted_reconstructed_history') {
    return 'mostly_reconstructed';
  }
  if (persistenceSource === 'mixed_persisted_history' && hasLive) {
    return 'partially_live_supported';
  }
  if (reconstructedDays > liveCapturedDays) {
    return 'mostly_reconstructed';
  }
  return hasLive ? 'partially_live_supported' : 'insufficient_live_depth';
}

function classifyDurabilityConstraint(input = {}) {
  const durabilityState = toText(input.currentRegimeDurabilityState).toLowerCase();
  const durabilityScore = Math.max(0, Number(input.currentRegimeDurabilityScore || 0));
  const cadenceLabel = normalizeCadenceLabel(input.currentRegimeLiveCadenceLabel || 'stale');
  const qualityLabel = normalizePersistenceQualityLabel(input.currentRegimePersistenceQualityLabel || 'insufficient_live_depth');
  const hasLive = input.currentRegimeHasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.currentRegimeLiveCapturedTenureDays || 0));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const promotionState = toText(input.currentRegimePromotionState).toLowerCase();
  const weakDurability = (
    durabilityState === 'unconfirmed'
    || durabilityState === 'building_durability'
    || durabilityState === 'fragile_confirmation'
    || durabilityState === 'decaying_confirmation'
  );

  const captureLimited = weakDurability && (cadenceLabel === 'sparse' || cadenceLabel === 'stale');
  const depthLimited = weakDurability && (!hasLive || liveTenure < 3 || qualityLabel === 'insufficient_live_depth');
  const qualityLimited = weakDurability && (
    trustConsumptionLabel === 'reduce_regime_weight'
    || trustConsumptionLabel === 'suppress_regime_bias'
    || promotionState === 'stalled_live_support'
    || durabilityScore < 55
  );

  const factors = [captureLimited, depthLimited, qualityLimited].filter(Boolean).length;
  if (factors >= 2) return 'mixed_constraints';
  if (captureLimited) return 'capture_cadence_limited';
  if (depthLimited) return 'live_depth_limited';
  if (qualityLimited) return 'regime_quality_limited';

  if (cadenceLabel === 'sparse' || cadenceLabel === 'stale') return 'capture_cadence_limited';
  if (!hasLive || liveTenure < 3) return 'live_depth_limited';
  return 'regime_quality_limited';
}

function buildPersistenceInsight(input = {}) {
  const currentRegimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const qualityLabel = normalizePersistenceQualityLabel(input.currentRegimePersistenceQualityLabel || 'insufficient_live_depth');
  const cadenceLabel = normalizeCadenceLabel(input.currentRegimeLiveCadenceLabel || 'stale');
  const constraint = normalizeDurabilityConstraint(input.currentRegimeDurabilityConstraint || 'mixed_constraints');
  const recentWindowDays = Math.max(0, Number(input.recentWindowDays || 0));
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));
  const liveTenure = Math.max(0, Number(input.currentRegimeLiveCapturedTenureDays || 0));
  const gapDays = Number.isFinite(Number(input.currentRegimeCaptureGapDays))
    ? Math.max(0, Number(input.currentRegimeCaptureGapDays))
    : null;

  if (recentWindowDays <= 0) {
    return 'Regime persistence quality is unavailable because persisted history coverage is still empty.';
  }
  if (qualityLabel === 'live_ready' && cadenceLabel === 'healthy') {
    return `${currentRegimeLabel} live-capture cadence is healthy and persistence is live-ready for durability interpretation.`;
  }
  if (qualityLabel === 'mostly_reconstructed') {
    return `Reconstructed persistence still dominates (${reconstructedDays}/${recentWindowDays} days), so durability interpretation remains conservative.`;
  }
  if (qualityLabel === 'insufficient_live_depth') {
    return `${currentRegimeLabel} live-captured tenure remains thin (${liveTenure} day${liveTenure === 1 ? '' : 's'}), so persistence quality is still conservative.`;
  }
  if (constraint === 'capture_cadence_limited') {
    if (Number.isFinite(gapDays)) {
      return `${currentRegimeLabel} durability is cadence-limited; live capture gap is ${gapDays} day${gapDays === 1 ? '' : 's'}.`;
    }
    return `${currentRegimeLabel} durability is cadence-limited because live capture remains sparse.`;
  }
  if (constraint === 'live_depth_limited') {
    return `${currentRegimeLabel} has some live capture (${liveCapturedDays} day${liveCapturedDays === 1 ? '' : 's'}) but not enough depth for stronger persistence trust.`;
  }
  if (constraint === 'regime_quality_limited') {
    return `${currentRegimeLabel} has live persistence support, but durability remains constrained by weak regime quality signals.`;
  }
  return `${currentRegimeLabel} persistence quality has mixed constraints; both live cadence and regime quality need more evidence.`;
}

function buildRegimeLivePersistenceQualitySummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const regimeConfirmationHistory = input.regimeConfirmationHistory && typeof input.regimeConfirmationHistory === 'object'
    ? input.regimeConfirmationHistory
    : {};
  const regimeConfirmationDurability = input.regimeConfirmationDurability && typeof input.regimeConfirmationDurability === 'object'
    ? input.regimeConfirmationDurability
    : {};
  const liveRegimeConfirmation = input.liveRegimeConfirmation && typeof input.liveRegimeConfirmation === 'object'
    ? input.liveRegimeConfirmation
    : {};
  const regimeTrustConsumption = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};
  const recommendationPerformanceSummary = input.recommendationPerformanceSummary && typeof input.recommendationPerformanceSummary === 'object'
    ? input.recommendationPerformanceSummary
    : (input.recommendationPerformance?.summary && typeof input.recommendationPerformance.summary === 'object'
      ? input.recommendationPerformance.summary
      : {});

  const currentRegimeLabel = normalizeRegimeLabel(
    regimeConfirmationHistory?.currentRegimeLabel
      || regimeConfirmationDurability?.currentRegimeLabel
      || liveRegimeConfirmation?.currentRegimeLabel
      || regimeTrustConsumption?.currentRegimeLabel
      || 'unknown'
  );

  const historyBreakdown = normalizeBreakdown(
    regimeConfirmationHistory?.historyProvenanceBreakdown
      || regimeConfirmationDurability?.historyProvenanceBreakdown
      || {}
  );
  const liveCapturedDays = historyBreakdown.liveCapturedDays;
  const reconstructedDays = historyBreakdown.reconstructedDays;
  const mixedDays = historyBreakdown.mixedDays;
  const recentWindowDays = Math.max(0, liveCapturedDays + reconstructedDays + mixedDays);
  const livePresenceDays = Math.max(0, liveCapturedDays + mixedDays);
  const missingExpectedLiveDays = Math.max(0, recentWindowDays - livePresenceDays);
  const liveCaptureCoveragePct = recentWindowDays > 0
    ? round2(clamp((livePresenceDays / recentWindowDays) * 100, 0, 100))
    : 0;

  const currentRegimeHistoryRow = findByRegime(regimeConfirmationHistory?.byRegime || [], currentRegimeLabel);
  const currentRegimeTenureDays = Math.max(0, Number(
    regimeConfirmationHistory?.currentRegimeTenureDays
      || currentRegimeHistoryRow?.currentStateTenureDays
      || 0
  ));
  const currentRegimeHasLiveCapturedHistory = (
    regimeConfirmationHistory?.currentRegimeHasLiveCapturedHistory === true
    || regimeConfirmationDurability?.currentRegimeHasLiveCapturedHistory === true
    || currentRegimeHistoryRow?.hasLiveCapturedHistory === true
  );
  const currentRegimeLiveCapturedTenureDays = Math.max(0, Number(
    regimeConfirmationHistory?.currentRegimeLiveCapturedTenureDays
      || regimeConfirmationDurability?.currentRegimeLiveCapturedTenureDays
      || currentRegimeHistoryRow?.liveCapturedTenureDays
      || 0
  ));
  const currentRegimeLastLiveCapturedDate = normalizeDate(
    regimeConfirmationHistory?.currentRegimeLastLiveCapturedDate
      || regimeConfirmationDurability?.currentRegimeLastLiveCapturedDate
      || currentRegimeHistoryRow?.lastLiveCapturedAt
      || ''
  ) || null;

  const referenceDate = normalizeDate(
    input.snapshotDate
      || input?.nowEt?.date
      || input?.context?.nowEt?.date
      || currentRegimeHistoryRow?.lastSeenAt
      || new Date().toISOString()
  );
  const currentRegimeCaptureGapDays = currentRegimeLastLiveCapturedDate
    ? daysBetween(currentRegimeLastLiveCapturedDate, referenceDate)
    : null;
  const currentRegimeLiveTenureSharePct = round2(clamp(
    (currentRegimeLiveCapturedTenureDays / Math.max(1, currentRegimeTenureDays)) * 100,
    0,
    100
  ));

  const currentRegimeDurabilityState = toText(
    regimeConfirmationDurability?.currentRegimeDurabilityState || 'unconfirmed'
  ).toLowerCase() || 'unconfirmed';
  const currentRegimeDurabilityScore = round2(clamp(
    Number(regimeConfirmationDurability?.currentRegimeDurabilityScore || 0),
    0,
    100
  ));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(
    regimeTrustConsumption?.trustConsumptionLabel || 'suppress_regime_bias'
  );
  const currentRegimePromotionState = toText(
    liveRegimeConfirmation?.currentRegimePromotionState || 'no_live_support'
  ).toLowerCase() || 'no_live_support';

  const currentRegimeLiveCadenceLabel = normalizeCadenceLabel(classifyCadenceLabel({
    currentRegimeHasLiveCapturedHistory,
    currentRegimeCaptureGapDays,
    liveCaptureCoveragePct,
    currentRegimeLiveCapturedTenureDays,
  }));

  const persistenceSource = normalizePersistenceSource(
    regimeConfirmationDurability?.persistenceSource
      || regimeConfirmationHistory?.persistenceSource
      || 'proxy_only'
  );
  const currentRegimePersistenceQualityLabel = normalizePersistenceQualityLabel(classifyPersistenceQualityLabel({
    persistenceSource,
    currentRegimeHasLiveCapturedHistory,
    currentRegimeLiveCapturedTenureDays,
    liveCapturedDays,
    reconstructedDays,
  }));

  const currentRegimeDurabilityConstraint = normalizeDurabilityConstraint(classifyDurabilityConstraint({
    currentRegimeDurabilityState,
    currentRegimeDurabilityScore,
    currentRegimeLiveCadenceLabel,
    currentRegimePersistenceQualityLabel,
    currentRegimeHasLiveCapturedHistory,
    currentRegimeLiveCapturedTenureDays,
    trustConsumptionLabel,
    currentRegimePromotionState,
  }));

  const warnings = [];
  if (recentWindowDays <= 0) warnings.push('no_recent_persisted_history');
  if (livePresenceDays <= 0) warnings.push('no_live_capture_days_in_recent_window');
  if (missingExpectedLiveDays > 0) warnings.push('missing_live_capture_days_detected');
  if (reconstructedDays > liveCapturedDays) warnings.push('reconstructed_history_dominates_recent_window');
  if (currentRegimeHasLiveCapturedHistory !== true) warnings.push('current_regime_no_live_captured_history');
  if (Number.isFinite(currentRegimeCaptureGapDays) && Number(currentRegimeCaptureGapDays) > 3) {
    warnings.push('current_regime_live_capture_gap_large');
  }
  if (currentRegimeLiveCapturedTenureDays < 3) warnings.push('current_regime_live_depth_thin');
  const sourceBreakdown = recommendationPerformanceSummary?.sourceBreakdown && typeof recommendationPerformanceSummary.sourceBreakdown === 'object'
    ? recommendationPerformanceSummary.sourceBreakdown
    : { live: 0, backfill: 0, total: 0 };
  if (Number(sourceBreakdown.backfill || 0) > Number(sourceBreakdown.live || 0)) {
    warnings.push('recommendation_source_backfill_dominant');
  }

  const persistenceQualityInsight = buildPersistenceInsight({
    currentRegimeLabel,
    currentRegimePersistenceQualityLabel,
    currentRegimeLiveCadenceLabel,
    currentRegimeDurabilityConstraint,
    recentWindowDays,
    liveCapturedDays,
    reconstructedDays,
    currentRegimeLiveCapturedTenureDays,
    currentRegimeCaptureGapDays,
  });

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    recentWindowDays,
    liveCapturedDays,
    reconstructedDays,
    mixedDays,
    missingExpectedLiveDays,
    liveCaptureCoveragePct,
    currentRegimeHasLiveCapturedHistory,
    currentRegimeLiveCapturedTenureDays,
    currentRegimeLastLiveCapturedDate,
    currentRegimeCaptureGapDays: Number.isFinite(currentRegimeCaptureGapDays)
      ? Number(currentRegimeCaptureGapDays)
      : null,
    currentRegimeLiveTenureSharePct,
    currentRegimeLiveCadenceLabel,
    currentRegimePersistenceQualityLabel,
    currentRegimeDurabilityConstraint,
    persistenceQualityInsight,
    warnings: Array.from(new Set(warnings)),
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimeLivePersistenceQualitySummary,
};
