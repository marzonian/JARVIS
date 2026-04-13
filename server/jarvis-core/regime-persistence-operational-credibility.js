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

const ALLOWED_CREDIBILITY_LABELS = new Set([
  'not_credible',
  'limited',
  'credible',
]);

const ALLOWED_OPERATIONAL_TRUST_GATES = new Set([
  'blocked',
  'cautious_use',
  'operationally_credible',
]);

const ALLOWED_TRUST_PERMISSION_LEVELS = new Set([
  'suppress_persistence_confidence',
  'allow_persistence_with_caution',
  'allow_persistence_confidence',
]);

const ALLOWED_PRIMARY_SECONDARY_BLOCKERS = new Set([
  'no_live_base',
  'insufficient_live_tenure',
  'insufficient_live_coverage',
  'reconstructed_history_dominant',
  'mixed_persistence_history',
  'durability_not_confirmed',
  'persistence_quality_not_live_ready',
  'graduation_not_ready',
  'delta_not_progressing',
  'live_capture_depth_too_thin',
  'cadence_not_reliable',
]);

const ALLOWED_SUPPORTING_SIGNALS = new Set([
  'live_base_present',
  'live_tenure_building',
  'live_coverage_improving',
  'durability_building',
  'durability_confirmed',
  'quality_improving',
  'graduation_progressing',
  'blockers_reducing',
  'cadence_healthy',
  'cadence_improving',
]);

const ALLOWED_READINESS_LABELS = new Set([
  'ready',
  'near_ready',
  'early',
  'not_ready',
]);

const ALLOWED_GRADUATION_STATES = new Set([
  'live_persistence_ready',
  'nearing_live_persistence',
  'accumulating_live_depth',
  'reconstructed_dominant',
]);

const ALLOWED_DURABILITY_STATES = new Set([
  'unconfirmed',
  'building_durability',
  'durable_confirmed',
  'fragile_confirmation',
  'decaying_confirmation',
  'recovering_confirmation',
]);

const ALLOWED_PERSISTENCE_QUALITY_LABELS = new Set([
  'live_ready',
  'partially_live_supported',
  'mostly_reconstructed',
  'insufficient_live_depth',
]);

const ALLOWED_CADENCE_LABELS = new Set([
  'healthy',
  'improving',
  'sparse',
  'stale',
]);

const ALLOWED_PERSISTENCE_SOURCES = new Set([
  'persisted_live_history',
  'persisted_reconstructed_history',
  'mixed_persisted_history',
  'proxy_only',
]);

const ALLOWED_DELTA_DIRECTIONS = new Set([
  'improving',
  'flat',
  'regressing',
]);

const ALLOWED_DELTA_STRENGTHS = new Set([
  'strong',
  'moderate',
  'weak',
]);

const ALLOWED_MOMENTUM_LABELS = new Set([
  'accelerating',
  'steady_progress',
  'stalled',
  'oscillating',
  'slipping',
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

function normalizePerformanceSource(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live' || txt === 'backfill') return txt;
  return 'all';
}

function safeCanonicalRegimeLabel(value) {
  const label = normalizeRegimeLabel(value || 'unknown');
  return SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
}

function normalizePersistenceSource(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_PERSISTENCE_SOURCES.has(txt) ? txt : 'proxy_only';
}

function normalizeReadinessLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_READINESS_LABELS.has(txt) ? txt : 'not_ready';
}

function normalizeGraduationState(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_GRADUATION_STATES.has(txt) ? txt : 'reconstructed_dominant';
}

function normalizeDurabilityState(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_DURABILITY_STATES.has(txt) ? txt : 'unconfirmed';
}

function normalizePersistenceQualityLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_PERSISTENCE_QUALITY_LABELS.has(txt) ? txt : 'insufficient_live_depth';
}

function normalizeCadenceLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_CADENCE_LABELS.has(txt) ? txt : 'stale';
}

function normalizeDeltaDirection(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_DELTA_DIRECTIONS.has(txt) ? txt : 'flat';
}

function normalizeDeltaStrength(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_DELTA_STRENGTHS.has(txt) ? txt : 'weak';
}

function normalizeMomentumLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_MOMENTUM_LABELS.has(txt) ? txt : 'stalled';
}

function normalizeBreakdown(input = {}) {
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(input.mixedDays || 0));
  return {
    liveCapturedDays,
    reconstructedDays,
    mixedDays,
    totalDays: liveCapturedDays + reconstructedDays + mixedDays,
  };
}

function derivePersistenceSourceFromBreakdown(breakdown = {}) {
  const safe = normalizeBreakdown(breakdown);
  if (safe.mixedDays > 0 || (safe.liveCapturedDays > 0 && safe.reconstructedDays > 0)) return 'mixed_persisted_history';
  if (safe.liveCapturedDays > 0 && safe.reconstructedDays <= 0) return 'persisted_live_history';
  if (safe.reconstructedDays > 0) return 'persisted_reconstructed_history';
  return 'proxy_only';
}

function deriveCoveragePctFromBreakdown(breakdown = {}) {
  const safe = normalizeBreakdown(breakdown);
  if (safe.totalDays <= 0) return 0;
  return round2(clamp(((safe.liveCapturedDays + safe.mixedDays) / safe.totalDays) * 100, 0, 100));
}

function inferPersistenceQualityLabel(input = {}) {
  const source = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const breakdown = normalizeBreakdown(input.breakdown);

  if (source === 'persisted_live_history' && hasLive && liveTenure >= 5) return 'live_ready';
  if (!hasLive || liveTenure < 3) return 'insufficient_live_depth';
  if (
    (source === 'persisted_reconstructed_history' || source === 'mixed_persisted_history')
    && breakdown.reconstructedDays > breakdown.liveCapturedDays
  ) {
    return 'mostly_reconstructed';
  }
  if (source === 'persisted_reconstructed_history') return 'mostly_reconstructed';
  return 'partially_live_supported';
}

function inferCadenceLabel(input = {}) {
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  if (!hasLive || liveTenure <= 0) return 'stale';
  if (liveCoveragePct >= 50 && liveTenure >= 3) return 'healthy';
  if (liveCoveragePct >= 20 && liveTenure >= 2) return 'improving';
  return 'sparse';
}

function normalizePrimarySecondaryBlockers(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_PRIMARY_SECONDARY_BLOCKERS.has(item));
}

function normalizeSupportingSignals(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_SUPPORTING_SIGNALS.has(item));
}

function mapPermissionForGate(gate = 'blocked') {
  if (gate === 'operationally_credible') return 'allow_persistence_confidence';
  if (gate === 'cautious_use') return 'allow_persistence_with_caution';
  return 'suppress_persistence_confidence';
}

function mapLabelForGate(gate = 'blocked') {
  if (gate === 'operationally_credible') return 'credible';
  if (gate === 'cautious_use') return 'limited';
  return 'not_credible';
}

function buildBlockers(input = {}) {
  const primary = [];
  const secondary = [];

  function addPrimary(blocker) {
    if (!ALLOWED_PRIMARY_SECONDARY_BLOCKERS.has(blocker)) return;
    if (!primary.includes(blocker)) primary.push(blocker);
  }

  function addSecondary(blocker) {
    if (!ALLOWED_PRIMARY_SECONDARY_BLOCKERS.has(blocker)) return;
    if (primary.includes(blocker)) return;
    if (!secondary.includes(blocker)) secondary.push(blocker);
  }

  const source = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const quality = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const graduationState = normalizeGraduationState(input.graduationState);
  const deltaDirection = normalizeDeltaDirection(input.deltaDirection);
  const momentumLabel = normalizeMomentumLabel(input.momentumLabel);
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel);
  const readyForOperationalUse = input.readyForOperationalUse === true;

  if (!hasLive || liveTenure <= 0) addPrimary('no_live_base');
  if (liveTenure < 3) addPrimary('live_capture_depth_too_thin');
  if (liveTenure < 5) addSecondary('insufficient_live_tenure');

  if (liveCoveragePct < 35) addPrimary('insufficient_live_coverage');
  else if (liveCoveragePct < 50) addSecondary('insufficient_live_coverage');

  if (source === 'persisted_reconstructed_history' || source === 'proxy_only') {
    addPrimary('reconstructed_history_dominant');
  } else if (source === 'mixed_persisted_history') {
    addSecondary('mixed_persistence_history');
  }

  if (durabilityState === 'unconfirmed') addPrimary('durability_not_confirmed');
  if (quality === 'insufficient_live_depth') addPrimary('persistence_quality_not_live_ready');

  if (readinessLabel !== 'ready' || graduationState !== 'live_persistence_ready' || readyForOperationalUse !== true) {
    addSecondary('graduation_not_ready');
  }

  if (
    deltaDirection !== 'improving'
    || momentumLabel === 'stalled'
    || momentumLabel === 'oscillating'
    || momentumLabel === 'slipping'
  ) {
    addSecondary('delta_not_progressing');
  }

  if (cadenceLabel === 'sparse' || cadenceLabel === 'stale') {
    addSecondary('cadence_not_reliable');
  }

  return {
    primaryBlockers: normalizePrimarySecondaryBlockers(primary),
    secondaryBlockers: normalizePrimarySecondaryBlockers(secondary),
  };
}

function buildSupportingSignals(input = {}) {
  const signals = [];

  function addSignal(signal) {
    if (!ALLOWED_SUPPORTING_SIGNALS.has(signal)) return;
    if (!signals.includes(signal)) signals.push(signal);
  }

  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const quality = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const deltaDirection = normalizeDeltaDirection(input.deltaDirection);
  const momentumLabel = normalizeMomentumLabel(input.momentumLabel);
  const blockersAdded = Math.max(0, Number(input.blockersAddedCount || 0));
  const blockersRemoved = Math.max(0, Number(input.blockersRemovedCount || 0));
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel);

  if (hasLive) addSignal('live_base_present');
  if (liveTenure >= 2) addSignal('live_tenure_building');
  if (liveCoveragePct >= 35) addSignal('live_coverage_improving');

  if (durabilityState === 'building_durability' || durabilityState === 'recovering_confirmation') {
    addSignal('durability_building');
  }
  if (durabilityState === 'durable_confirmed') addSignal('durability_confirmed');

  if (quality === 'partially_live_supported' || quality === 'live_ready') {
    addSignal('quality_improving');
  }

  if (deltaDirection === 'improving' && momentumLabel !== 'slipping') addSignal('graduation_progressing');
  if (blockersRemoved > blockersAdded) addSignal('blockers_reducing');

  if (cadenceLabel === 'healthy') addSignal('cadence_healthy');
  else if (cadenceLabel === 'improving') addSignal('cadence_improving');

  return normalizeSupportingSignals(signals);
}

function computeCredibilityScore(input = {}) {
  const source = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const quality = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const graduationState = normalizeGraduationState(input.graduationState);
  const deltaDirection = normalizeDeltaDirection(input.deltaDirection);
  const deltaStrength = normalizeDeltaStrength(input.deltaStrength);
  const momentumLabel = normalizeMomentumLabel(input.momentumLabel);
  const readyForOperationalUse = input.readyForOperationalUse === true;
  const primaryCount = Math.max(0, Number(input.primaryBlockerCount || 0));
  const secondaryCount = Math.max(0, Number(input.secondaryBlockerCount || 0));

  const sourceScore = (
    source === 'persisted_live_history' ? 30
      : source === 'mixed_persisted_history' ? 15
        : source === 'persisted_reconstructed_history' ? 5
          : 0
  );
  const durabilityScore = (
    durabilityState === 'durable_confirmed' ? 16
      : durabilityState === 'building_durability' ? 10
        : durabilityState === 'recovering_confirmation' ? 9
          : durabilityState === 'fragile_confirmation' ? 5
            : durabilityState === 'decaying_confirmation' ? 3
              : 0
  );
  const qualityScore = (
    quality === 'live_ready' ? 12
      : quality === 'partially_live_supported' ? 8
        : quality === 'mostly_reconstructed' ? 3
          : 0
  );
  const readinessScore = (
    readinessLabel === 'ready' ? 10
      : readinessLabel === 'near_ready' ? 7
        : readinessLabel === 'early' ? 4
          : 0
  );
  const deltaDirectionScore = (
    deltaDirection === 'improving' ? 6
      : deltaDirection === 'flat' ? 1
        : -8
  );
  const deltaStrengthScore = (
    deltaStrength === 'strong' ? 4
      : deltaStrength === 'moderate' ? 2
        : 0
  );
  const momentumScore = (
    momentumLabel === 'accelerating' ? 5
      : momentumLabel === 'steady_progress' ? 3
        : momentumLabel === 'stalled' ? 0
          : momentumLabel === 'oscillating' ? -2
            : -6
  );

  let score = 0;
  score += sourceScore;
  score += Math.min(20, liveTenure * 2.5);
  score += Math.min(20, liveCoveragePct * 0.2);
  score += durabilityScore;
  score += qualityScore;
  score += readinessScore;
  score += deltaDirectionScore;
  score += deltaStrengthScore;
  score += momentumScore;
  if (readyForOperationalUse) score += 8;
  score -= (primaryCount * 9);
  score -= (secondaryCount * 3);

  score = clamp(score, 0, 100);

  if (!hasLive) score = Math.min(score, 20);
  if (source === 'persisted_reconstructed_history' || source === 'proxy_only') score = Math.min(score, 44);
  if (source === 'mixed_persisted_history') score = Math.min(score, 74);
  if (durabilityState === 'unconfirmed') score = Math.min(score, 69);
  if (quality === 'insufficient_live_depth') score = Math.min(score, 69);
  if (graduationState === 'reconstructed_dominant') score = Math.min(score, 64);
  if (deltaDirection === 'regressing' || momentumLabel === 'slipping') score = Math.min(score, 49);
  if (deltaDirection === 'flat' && deltaStrength === 'weak') score = Math.min(score, 59);
  if (liveTenure < 3) score = Math.min(score, 49);
  if (liveCoveragePct < 35) score = Math.min(score, 54);

  return round2(clamp(score, 0, 100));
}

function classifyGate(input = {}) {
  const source = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const quality = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const graduationState = normalizeGraduationState(input.graduationState);
  const readyForOperationalUse = input.readyForOperationalUse === true;
  const deltaDirection = normalizeDeltaDirection(input.deltaDirection);
  const momentumLabel = normalizeMomentumLabel(input.momentumLabel);
  const primaryBlockers = normalizePrimarySecondaryBlockers(input.primaryBlockers || []);
  const secondaryBlockers = normalizePrimarySecondaryBlockers(input.secondaryBlockers || []);
  const score = clamp(Number(input.credibilityScore || 0), 0, 100);

  const blockerBurdenLow = primaryBlockers.length === 0 && secondaryBlockers.length <= 2;

  const operationallyCredible = (
    source === 'persisted_live_history'
    && readyForOperationalUse === true
    && hasLive
    && liveTenure >= 5
    && liveCoveragePct >= 50
    && durabilityState !== 'unconfirmed'
    && quality !== 'insufficient_live_depth'
    && graduationState !== 'reconstructed_dominant'
    && deltaDirection !== 'regressing'
    && momentumLabel !== 'slipping'
    && blockerBurdenLow
  );
  if (operationallyCredible) {
    return {
      operationalTrustGate: 'operationally_credible',
      trustPermissionLevel: 'allow_persistence_confidence',
      credibilityLabel: 'credible',
    };
  }

  const blocked = (
    !hasLive
    || source === 'proxy_only'
    || source === 'persisted_reconstructed_history'
    || primaryBlockers.includes('no_live_base')
    || primaryBlockers.includes('reconstructed_history_dominant')
    || primaryBlockers.includes('durability_not_confirmed')
    || primaryBlockers.includes('persistence_quality_not_live_ready')
    || primaryBlockers.includes('live_capture_depth_too_thin')
    || score < 35
  );

  if (blocked) {
    return {
      operationalTrustGate: 'blocked',
      trustPermissionLevel: 'suppress_persistence_confidence',
      credibilityLabel: 'not_credible',
    };
  }

  return {
    operationalTrustGate: 'cautious_use',
    trustPermissionLevel: 'allow_persistence_with_caution',
    credibilityLabel: 'limited',
  };
}

function findByRegime(rows = [], regimeLabel = '') {
  const safe = safeCanonicalRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    safeCanonicalRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
  )) || null;
}

function inferRowReadinessLabel(regimeLabel, readinessSummary = {}, graduationSummary = {}) {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel || 'unknown');
  if (safeRegime === safeCanonicalRegimeLabel(readinessSummary.currentRegimeLabel || 'unknown')) {
    return normalizeReadinessLabel(readinessSummary.readinessLabel || 'not_ready');
  }
  if (Array.isArray(readinessSummary.liveReadyRegimeLabels) && readinessSummary.liveReadyRegimeLabels.includes(safeRegime)) {
    return 'ready';
  }
  if (Array.isArray(readinessSummary.nearReadyRegimeLabels) && readinessSummary.nearReadyRegimeLabels.includes(safeRegime)) {
    return 'near_ready';
  }
  if (Array.isArray(readinessSummary.notReadyRegimeLabels) && readinessSummary.notReadyRegimeLabels.includes(safeRegime)) {
    return 'not_ready';
  }
  if (Array.isArray(graduationSummary.progressingRegimeLabels) && graduationSummary.progressingRegimeLabels.includes(safeRegime)) {
    return 'early';
  }
  return 'not_ready';
}

function inferRowGraduationState(regimeLabel, readinessSummary = {}, graduationSummary = {}) {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel || 'unknown');
  if (safeRegime === safeCanonicalRegimeLabel(graduationSummary.currentRegimeLabel || 'unknown')) {
    return normalizeGraduationState(graduationSummary.graduationState || 'reconstructed_dominant');
  }
  if (Array.isArray(graduationSummary.graduatedRegimeLabels) && graduationSummary.graduatedRegimeLabels.includes(safeRegime)) {
    return 'live_persistence_ready';
  }
  if (Array.isArray(graduationSummary.progressingRegimeLabels) && graduationSummary.progressingRegimeLabels.includes(safeRegime)) {
    return 'accumulating_live_depth';
  }
  if (Array.isArray(graduationSummary.stalledGraduationRegimeLabels) && graduationSummary.stalledGraduationRegimeLabels.includes(safeRegime)) {
    return 'reconstructed_dominant';
  }
  return 'reconstructed_dominant';
}

function deriveRowInput(regimeLabel, context = {}) {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel || 'unknown');
  const isCurrent = safeRegime === context.currentRegimeLabel;

  const historyRow = findByRegime(context.historyRows, safeRegime) || {};
  const durabilityRow = findByRegime(context.durabilityRows, safeRegime) || {};
  const deltaRow = findByRegime(context.deltaRows, safeRegime) || {};

  const breakdown = normalizeBreakdown(
    durabilityRow?.provenanceBreakdown && typeof durabilityRow.provenanceBreakdown === 'object'
      ? durabilityRow.provenanceBreakdown
      : (historyRow?.provenanceBreakdown && typeof historyRow.provenanceBreakdown === 'object'
        ? historyRow.provenanceBreakdown
        : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 })
  );

  const persistenceSource = normalizePersistenceSource(
    isCurrent
      ? (context.readinessSummary?.persistenceSource
        || context.graduationSummary?.persistenceSource
        || context.durabilitySummary?.persistenceSource
        || durabilityRow?.persistenceSource
        || derivePersistenceSourceFromBreakdown(breakdown))
      : (durabilityRow?.persistenceSource || derivePersistenceSourceFromBreakdown(breakdown))
  );

  const hasLiveCapturedHistory = isCurrent
    ? (context.historySummary?.currentRegimeHasLiveCapturedHistory === true
      || context.durabilitySummary?.currentRegimeHasLiveCapturedHistory === true
      || historyRow?.hasLiveCapturedHistory === true
      || durabilityRow?.hasLiveCapturedHistory === true)
    : (historyRow?.hasLiveCapturedHistory === true || durabilityRow?.hasLiveCapturedHistory === true);

  const liveCapturedTenureDays = Math.max(0, Number(
    isCurrent
      ? (context.historySummary?.currentRegimeLiveCapturedTenureDays
        || context.durabilitySummary?.currentRegimeLiveCapturedTenureDays
        || historyRow?.liveCapturedTenureDays
        || durabilityRow?.liveCapturedTenureDays
        || 0)
      : (historyRow?.liveCapturedTenureDays || durabilityRow?.liveCapturedTenureDays || 0)
  ));

  const liveCaptureCoveragePct = clamp(
    Number(
      isCurrent
        ? (context.liveQualitySummary?.liveCaptureCoveragePct != null
          ? context.liveQualitySummary.liveCaptureCoveragePct
          : deriveCoveragePctFromBreakdown(breakdown))
        : deriveCoveragePctFromBreakdown(breakdown)
    ),
    0,
    100
  );

  const durabilityState = normalizeDurabilityState(
    isCurrent
      ? (context.durabilitySummary?.currentRegimeDurabilityState || durabilityRow?.durabilityState || 'unconfirmed')
      : (durabilityRow?.durabilityState || 'unconfirmed')
  );

  const persistenceQualityLabel = normalizePersistenceQualityLabel(
    isCurrent
      ? (context.liveQualitySummary?.currentRegimePersistenceQualityLabel || inferPersistenceQualityLabel({
        persistenceSource,
        hasLiveCapturedHistory,
        liveCapturedTenureDays,
        breakdown,
      }))
      : inferPersistenceQualityLabel({
        persistenceSource,
        hasLiveCapturedHistory,
        liveCapturedTenureDays,
        breakdown,
      })
  );

  const readinessLabel = inferRowReadinessLabel(safeRegime, context.readinessSummary, context.graduationSummary);
  const graduationState = inferRowGraduationState(safeRegime, context.readinessSummary, context.graduationSummary);

  const readyForOperationalUse = isCurrent
    ? context.graduationSummary?.readyForOperationalUse === true
    : (Array.isArray(context.graduationSummary?.graduatedRegimeLabels)
      && context.graduationSummary.graduatedRegimeLabels.includes(safeRegime));

  const deltaDirection = normalizeDeltaDirection(deltaRow?.deltaDirection || (isCurrent ? context.deltaSummary?.deltaDirection : 'flat'));
  const deltaStrength = normalizeDeltaStrength(deltaRow?.deltaStrength || (isCurrent ? context.deltaSummary?.deltaStrength : 'weak'));
  const momentumLabel = normalizeMomentumLabel(deltaRow?.momentumLabel || (isCurrent ? context.deltaSummary?.momentumLabel : 'stalled'));
  const blockersAddedCount = Math.max(0, Number((deltaRow?.blockersAdded || []).length));
  const blockersRemovedCount = Math.max(0, Number((deltaRow?.blockersRemoved || []).length));

  const cadenceLabel = normalizeCadenceLabel(
    isCurrent
      ? (context.liveQualitySummary?.currentRegimeLiveCadenceLabel || inferCadenceLabel({
        hasLiveCapturedHistory,
        liveCapturedTenureDays,
        liveCaptureCoveragePct,
      }))
      : inferCadenceLabel({
        hasLiveCapturedHistory,
        liveCapturedTenureDays,
        liveCaptureCoveragePct,
      })
  );

  return {
    regimeLabel: safeRegime,
    isCurrent,
    persistenceSource,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    durabilityState,
    persistenceQualityLabel,
    readinessLabel,
    graduationState,
    readyForOperationalUse,
    deltaDirection,
    deltaStrength,
    momentumLabel,
    cadenceLabel,
    blockersAddedCount,
    blockersRemovedCount,
    breakdown,
  };
}

function buildRowCredibility(rowInput = {}) {
  const blockerState = buildBlockers(rowInput);
  const supportingSignals = buildSupportingSignals({
    ...rowInput,
    ...blockerState,
  });

  const credibilityScore = computeCredibilityScore({
    ...rowInput,
    primaryBlockerCount: blockerState.primaryBlockers.length,
    secondaryBlockerCount: blockerState.secondaryBlockers.length,
  });

  const gateState = classifyGate({
    ...rowInput,
    credibilityScore,
    primaryBlockers: blockerState.primaryBlockers,
    secondaryBlockers: blockerState.secondaryBlockers,
  });

  return {
    regimeLabel: rowInput.regimeLabel,
    credibilityScore,
    credibilityLabel: ALLOWED_CREDIBILITY_LABELS.has(gateState.credibilityLabel)
      ? gateState.credibilityLabel
      : 'not_credible',
    operationalTrustGate: ALLOWED_OPERATIONAL_TRUST_GATES.has(gateState.operationalTrustGate)
      ? gateState.operationalTrustGate
      : 'blocked',
    trustPermissionLevel: ALLOWED_TRUST_PERMISSION_LEVELS.has(gateState.trustPermissionLevel)
      ? gateState.trustPermissionLevel
      : mapPermissionForGate('blocked'),
    readyForOperationalUse: rowInput.readyForOperationalUse === true,
    primaryBlockers: blockerState.primaryBlockers,
    secondaryBlockers: blockerState.secondaryBlockers,
    supportingSignals,
    advisoryOnly: true,
  };
}

function buildOperationalReason(input = {}) {
  const label = safeCanonicalRegimeLabel(input.currentRegimeLabel || 'unknown');
  const gate = toText(input.operationalTrustGate).toLowerCase();
  const score = round2(Number(input.credibilityScore || 0));
  const primaryBlockers = normalizePrimarySecondaryBlockers(input.primaryBlockers || []);

  if (gate === 'operationally_credible') {
    return `${label} persistence is operationally credible with sustained live-captured depth and low blocker burden.`;
  }
  if (gate === 'cautious_use') {
    return `${label} persistence can be used cautiously (score ${score}) but remains bounded by ${primaryBlockers.slice(0, 2).join(', ') || 'residual credibility blockers'}.`;
  }
  return `${label} persistence is blocked for operational trust (score ${score}) due to ${primaryBlockers.slice(0, 2).join(', ') || 'insufficient live credibility support'}.`;
}

function buildCredibilityInsight(input = {}) {
  const label = safeCanonicalRegimeLabel(input.currentRegimeLabel || 'unknown');
  const gate = toText(input.operationalTrustGate).toLowerCase();
  const permission = toText(input.trustPermissionLevel).toLowerCase();
  const signals = normalizeSupportingSignals(input.supportingSignals || []);
  const blockers = normalizePrimarySecondaryBlockers(input.primaryBlockers || []);

  if (gate === 'operationally_credible') {
    return `${label} persistence has crossed the operational credibility gate; persistence-backed advisory confidence is permitted.`;
  }
  if (gate === 'cautious_use') {
    return `${label} persistence is usable only with caution; keep advisory confidence bounded while blockers continue to clear.`;
  }
  if (permission === 'suppress_persistence_confidence') {
    return `${label} persistence credibility is insufficient for conviction. Suppress persistence-derived confidence until live depth and durability improve.`;
  }
  if (signals.length > 0) {
    return `${label} persistence remains blocked despite partial positives (${signals.slice(0, 2).join(', ')}); blocker burden is still too high.`;
  }
  if (blockers.length > 0) {
    return `${label} persistence remains blocked with explicit blockers (${blockers.slice(0, 2).join(', ')}).`;
  }
  return `${label} persistence credibility remains conservative due to thin operational support.`;
}

function buildWarnings(input = {}) {
  const warnings = [];
  const source = normalizePersistenceSource(input.persistenceSource);
  const ready = input.readyForOperationalUse === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const deltaDirection = normalizeDeltaDirection(input.deltaDirection);
  const momentumLabel = normalizeMomentumLabel(input.momentumLabel);
  const hasLive = input.hasLiveCapturedHistory === true;

  if (!ready) warnings.push('current_regime_not_operationally_ready');
  if (source === 'mixed_persisted_history') warnings.push('mixed_history_only');
  if (source === 'persisted_reconstructed_history' || source === 'proxy_only') warnings.push('reconstructed_dominant_inputs');
  if (deltaDirection !== 'improving' || momentumLabel === 'stalled' || momentumLabel === 'slipping') warnings.push('delta_not_supportive');
  if (durabilityState === 'unconfirmed') warnings.push('durability_unconfirmed');
  if (!hasLive || liveTenure < 3) warnings.push('live_capture_base_thin');
  if (Number(input.coverageDays || 0) < 3) warnings.push('thin_credibility_inputs');

  return Array.from(new Set(warnings));
}

function buildRegimePersistenceOperationalCredibilitySummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const readinessSummary = input.regimePersistenceReadiness && typeof input.regimePersistenceReadiness === 'object'
    ? input.regimePersistenceReadiness
    : {};
  const graduationSummary = input.regimePersistenceGraduation && typeof input.regimePersistenceGraduation === 'object'
    ? input.regimePersistenceGraduation
    : {};
  const deltaSummary = input.regimePersistenceGraduationDelta && typeof input.regimePersistenceGraduationDelta === 'object'
    ? input.regimePersistenceGraduationDelta
    : {};
  const liveQualitySummary = input.regimeLivePersistenceQuality && typeof input.regimeLivePersistenceQuality === 'object'
    ? input.regimeLivePersistenceQuality
    : {};
  const durabilitySummary = input.regimeConfirmationDurability && typeof input.regimeConfirmationDurability === 'object'
    ? input.regimeConfirmationDurability
    : {};
  const historySummary = input.regimeConfirmationHistory && typeof input.regimeConfirmationHistory === 'object'
    ? input.regimeConfirmationHistory
    : {};
  const trustSummary = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};

  const currentRegimeLabel = safeCanonicalRegimeLabel(
    deltaSummary.currentRegimeLabel
      || graduationSummary.currentRegimeLabel
      || readinessSummary.currentRegimeLabel
      || liveQualitySummary.currentRegimeLabel
      || durabilitySummary.currentRegimeLabel
      || historySummary.currentRegimeLabel
      || trustSummary.currentRegimeLabel
      || 'unknown'
  );

  const historyRows = Array.isArray(historySummary.byRegime) ? historySummary.byRegime : [];
  const durabilityRows = Array.isArray(durabilitySummary.durabilityByRegime) ? durabilitySummary.durabilityByRegime : [];
  const deltaRows = Array.isArray(deltaSummary.graduationDeltaByRegime) ? deltaSummary.graduationDeltaByRegime : [];

  const context = {
    currentRegimeLabel,
    readinessSummary,
    graduationSummary,
    deltaSummary,
    liveQualitySummary,
    durabilitySummary,
    historySummary,
    trustSummary,
    historyRows,
    durabilityRows,
    deltaRows,
  };

  const credibilityByRegime = SUPPORTED_REGIME_LABELS.map((regimeLabel) => {
    const rowInput = deriveRowInput(regimeLabel, context);
    return buildRowCredibility(rowInput);
  });

  const currentRow = credibilityByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || buildRowCredibility(deriveRowInput(currentRegimeLabel, context));

  const credibilityInsight = buildCredibilityInsight({
    currentRegimeLabel,
    operationalTrustGate: currentRow.operationalTrustGate,
    trustPermissionLevel: currentRow.trustPermissionLevel,
    supportingSignals: currentRow.supportingSignals,
    primaryBlockers: currentRow.primaryBlockers,
  });

  const operationalTrustReason = buildOperationalReason({
    currentRegimeLabel,
    operationalTrustGate: currentRow.operationalTrustGate,
    credibilityScore: currentRow.credibilityScore,
    primaryBlockers: currentRow.primaryBlockers,
  });

  const credibleRegimeLabels = credibilityByRegime
    .filter((row) => row.operationalTrustGate === 'operationally_credible')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const cautionaryRegimeLabels = credibilityByRegime
    .filter((row) => row.operationalTrustGate === 'cautious_use')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const blockedRegimeLabels = credibilityByRegime
    .filter((row) => row.operationalTrustGate === 'blocked')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const warnings = buildWarnings({
    persistenceSource: readinessSummary?.persistenceSource || durabilitySummary?.persistenceSource || 'proxy_only',
    readyForOperationalUse: graduationSummary?.readyForOperationalUse === true,
    liveCapturedTenureDays: readinessSummary?.currentRegimeLiveCapturedTenureDays || 0,
    durabilityState: readinessSummary?.currentRegimeDurabilityState || durabilitySummary?.currentRegimeDurabilityState || 'unconfirmed',
    deltaDirection: deltaSummary?.deltaDirection || 'flat',
    momentumLabel: deltaSummary?.momentumLabel || 'stalled',
    hasLiveCapturedHistory: readinessSummary?.currentRegimeHasLiveCapturedHistory === true
      || historySummary?.currentRegimeHasLiveCapturedHistory === true,
    coverageDays: historySummary?.historyCoverageDays || 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    credibilityScore: round2(Number(currentRow.credibilityScore || 0)),
    credibilityLabel: ALLOWED_CREDIBILITY_LABELS.has(currentRow.credibilityLabel)
      ? currentRow.credibilityLabel
      : 'not_credible',
    operationalTrustGate: ALLOWED_OPERATIONAL_TRUST_GATES.has(currentRow.operationalTrustGate)
      ? currentRow.operationalTrustGate
      : 'blocked',
    operationalTrustReason,
    trustPermissionLevel: ALLOWED_TRUST_PERMISSION_LEVELS.has(currentRow.trustPermissionLevel)
      ? currentRow.trustPermissionLevel
      : mapPermissionForGate('blocked'),
    primaryBlockers: normalizePrimarySecondaryBlockers(currentRow.primaryBlockers || []),
    secondaryBlockers: normalizePrimarySecondaryBlockers(currentRow.secondaryBlockers || []),
    supportingSignals: normalizeSupportingSignals(currentRow.supportingSignals || []),
    credibilityInsight,
    readyForOperationalUse: graduationSummary?.readyForOperationalUse === true,
    credibleRegimeLabels,
    cautionaryRegimeLabels,
    blockedRegimeLabels,
    credibilityByRegime,
    warnings,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePersistenceOperationalCredibilitySummary,
};
