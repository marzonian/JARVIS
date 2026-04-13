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

const ALLOWED_OVERRIDE_ACTIONS = new Set([
  'decrease_confidence',
  'no_material_change',
  'increase_confidence',
]);

const ALLOWED_POLICY_BLOCKERS = new Set([
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

const ALLOWED_POLICY_SUPPORTS = new Set([
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

const ALLOWED_PERSISTENCE_SOURCES = new Set([
  'persisted_live_history',
  'persisted_reconstructed_history',
  'mixed_persisted_history',
  'proxy_only',
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

const ALLOWED_OPERATIONAL_GATES = new Set([
  'blocked',
  'cautious_use',
  'operationally_credible',
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

function normalizeReadinessLabel(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_READINESS_LABELS.has(txt) ? txt : 'not_ready';
}

function normalizeGraduationState(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_GRADUATION_STATES.has(txt) ? txt : 'reconstructed_dominant';
}

function normalizeOperationalTrustGate(value) {
  const txt = toText(value).toLowerCase();
  return ALLOWED_OPERATIONAL_GATES.has(txt) ? txt : 'blocked';
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
    .filter((item) => ALLOWED_POLICY_BLOCKERS.has(item));
}

function normalizeSupports(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_POLICY_SUPPORTS.has(item));
}

function normalizeBreakdown(input = {}) {
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || input.live || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || input.backfill || 0));
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
  if (safe.mixedDays > 0 || (safe.liveCapturedDays > 0 && safe.reconstructedDays > 0)) {
    return 'mixed_persisted_history';
  }
  if (safe.liveCapturedDays > 0 && safe.reconstructedDays <= 0) return 'persisted_live_history';
  if (safe.reconstructedDays > 0) return 'persisted_reconstructed_history';
  return 'proxy_only';
}

function deriveCoveragePctFromBreakdown(breakdown = {}) {
  const safe = normalizeBreakdown(breakdown);
  if (safe.totalDays <= 0) return 0;
  return round2(clamp(((safe.liveCapturedDays + safe.mixedDays) / safe.totalDays) * 100, 0, 100));
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

function inferReadinessLabel(regimeLabel, readinessSummary = {}, graduationSummary = {}) {
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

function inferGraduationState(regimeLabel, readinessSummary = {}, graduationSummary = {}) {
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
  const readiness = inferReadinessLabel(safeRegime, readinessSummary, graduationSummary);
  if (readiness === 'ready') return 'live_persistence_ready';
  if (readiness === 'near_ready') return 'nearing_live_persistence';
  if (readiness === 'early') return 'accumulating_live_depth';
  return 'reconstructed_dominant';
}

function mapReadinessLabelToScore(label) {
  const txt = normalizeReadinessLabel(label);
  if (txt === 'ready') return 90;
  if (txt === 'near_ready') return 65;
  if (txt === 'early') return 42;
  return 20;
}

function mapDurabilityStateToScore(label) {
  const txt = normalizeDurabilityState(label);
  if (txt === 'durable_confirmed') return 90;
  if (txt === 'recovering_confirmation') return 70;
  if (txt === 'building_durability') return 58;
  if (txt === 'fragile_confirmation') return 45;
  if (txt === 'decaying_confirmation') return 30;
  return 20;
}

function mapQualityToScore(label) {
  const txt = normalizePersistenceQualityLabel(label);
  if (txt === 'live_ready') return 88;
  if (txt === 'partially_live_supported') return 62;
  if (txt === 'mostly_reconstructed') return 34;
  return 18;
}

function mapDeltaToScore(direction, strength, momentum) {
  const d = normalizeDeltaDirection(direction);
  const s = normalizeDeltaStrength(strength);
  const m = normalizeMomentumLabel(momentum);
  let score = d === 'improving' ? 66 : (d === 'flat' ? 45 : 22);
  score += s === 'strong' ? 8 : (s === 'moderate' ? 4 : 0);
  score += m === 'accelerating' ? 10 : (m === 'steady_progress' ? 5 : (m === 'stalled' ? -2 : (m === 'oscillating' ? -6 : -12)));
  return clamp(score, 0, 100);
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
}

function findByRegime(rows = [], regimeLabel = '') {
  const safe = safeCanonicalRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    safeCanonicalRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
  )) || null;
}

function buildRowSignals(row = {}) {
  const blockers = new Set();
  const supports = new Set();

  const gate = normalizeOperationalTrustGate(row.operationalTrustGate);
  const source = normalizePersistenceSource(row.persistenceSource);
  const durability = normalizeDurabilityState(row.durabilityState);
  const quality = normalizePersistenceQualityLabel(row.persistenceQualityLabel);
  const readiness = normalizeReadinessLabel(row.readinessLabel);
  const graduationState = normalizeGraduationState(row.graduationState);
  const deltaDirection = normalizeDeltaDirection(row.deltaDirection);
  const momentum = normalizeMomentumLabel(row.momentumLabel);
  const liveTenure = Math.max(0, Number(row.liveCapturedTenureDays || 0));
  const coverage = clamp(Number(row.liveCaptureCoveragePct || 0), 0, 100);

  if (gate === 'blocked') blockers.add('credibility_blocked');
  if (gate !== 'operationally_credible') blockers.add('credibility_not_strong_enough');
  if (source === 'persisted_reconstructed_history' || source === 'proxy_only') blockers.add('reconstructed_dominant');
  if (source === 'mixed_persisted_history') blockers.add('mixed_history_constraint');
  if (durability === 'unconfirmed') blockers.add('durability_unconfirmed');
  if (quality === 'insufficient_live_depth') blockers.add('quality_not_live_ready');
  if (readiness !== 'ready') blockers.add('readiness_not_ready');
  if (graduationState !== 'live_persistence_ready' || row.readyForOperationalUse !== true) blockers.add('graduation_not_ready');
  if (deltaDirection !== 'improving' || momentum === 'stalled' || momentum === 'oscillating' || momentum === 'slipping') {
    blockers.add('delta_not_supportive');
  }
  if (liveTenure < 3) blockers.add('live_depth_insufficient');
  if (coverage < 35) blockers.add('coverage_insufficient');

  if (gate === 'cautious_use') supports.add('credibility_cautious');
  if (gate === 'operationally_credible') supports.add('credibility_operational');
  if (durability === 'durable_confirmed') supports.add('durability_confirmed');
  if (quality === 'live_ready') supports.add('quality_live_ready');
  if (readiness === 'ready') supports.add('readiness_ready');
  if (deltaDirection === 'improving' || momentum === 'accelerating' || momentum === 'steady_progress') {
    supports.add('graduation_progressing');
    supports.add('delta_supportive');
  }
  if (Math.max(0, Number(row.blockersRemovedCount || 0)) > Math.max(0, Number(row.blockersAddedCount || 0))) {
    supports.add('blockers_reducing');
  }
  if (liveTenure >= 5) supports.add('live_depth_sufficient');
  if (coverage >= 50) supports.add('coverage_sufficient');

  return {
    policyBlockers: normalizeBlockers(Array.from(blockers)),
    policySupports: normalizeSupports(Array.from(supports)),
  };
}

function computeOverrideScore(row = {}, signals = {}) {
  const credibilityScore = clamp(Number(row.credibilityScore || 0), 0, 100);
  const readinessScore = clamp(Number(row.readinessScore || mapReadinessLabelToScore(row.readinessLabel)), 0, 100);
  const graduationProgress = clamp(Number(row.graduationProgressScore || 0), 0, 100);
  const durabilityScore = mapDurabilityStateToScore(row.durabilityState);
  const qualityScore = mapQualityToScore(row.persistenceQualityLabel);
  const deltaScore = mapDeltaToScore(row.deltaDirection, row.deltaStrength, row.momentumLabel);
  const trustConsumption = normalizeTrustConsumptionLabel(row.trustConsumptionLabel);

  let score = (
    credibilityScore * 0.40
    + readinessScore * 0.18
    + graduationProgress * 0.14
    + durabilityScore * 0.10
    + qualityScore * 0.10
    + deltaScore * 0.08
  );

  score -= (normalizeBlockers(signals.policyBlockers).length * 2.5);
  score += (normalizeSupports(signals.policySupports).length * 1.5);
  if (trustConsumption === 'reduce_regime_weight') score -= 5;
  if (trustConsumption === 'suppress_regime_bias') score -= 8;

  score = clamp(score, 0, 100);

  const gate = normalizeOperationalTrustGate(row.operationalTrustGate);
  const source = normalizePersistenceSource(row.persistenceSource);
  const durability = normalizeDurabilityState(row.durabilityState);
  const quality = normalizePersistenceQualityLabel(row.persistenceQualityLabel);
  const readiness = normalizeReadinessLabel(row.readinessLabel);
  const graduation = normalizeGraduationState(row.graduationState);
  const deltaDirection = normalizeDeltaDirection(row.deltaDirection);
  const momentum = normalizeMomentumLabel(row.momentumLabel);
  const hasLive = row.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(row.liveCapturedTenureDays || 0));
  const coverage = clamp(Number(row.liveCaptureCoveragePct || 0), 0, 100);

  if (gate === 'blocked') score = Math.min(score, 34);
  if (gate === 'cautious_use') score = Math.min(score, 69);
  if (source !== 'persisted_live_history') score = Math.min(score, 69);
  if (source === 'persisted_reconstructed_history' || source === 'proxy_only') score = Math.min(score, 39);
  if (durability === 'unconfirmed') score = Math.min(score, 64);
  if (quality === 'insufficient_live_depth') score = Math.min(score, 59);
  if (readiness !== 'ready') score = Math.min(score, 69);
  if (graduation !== 'live_persistence_ready' || row.readyForOperationalUse !== true) score = Math.min(score, 69);
  if (deltaDirection === 'regressing' || momentum === 'slipping') score = Math.min(score, 49);
  if (!hasLive) score = Math.min(score, 39);
  if (liveTenure < 3) score = Math.min(score, 54);
  if (coverage < 35) score = Math.min(score, 59);

  return round2(clamp(score, 0, 100));
}

function classifyPolicy(row = {}, signals = {}, overrideScore = 0) {
  const gate = normalizeOperationalTrustGate(row.operationalTrustGate);
  const source = normalizePersistenceSource(row.persistenceSource);
  const durability = normalizeDurabilityState(row.durabilityState);
  const quality = normalizePersistenceQualityLabel(row.persistenceQualityLabel);
  const readiness = normalizeReadinessLabel(row.readinessLabel);
  const graduation = normalizeGraduationState(row.graduationState);
  const deltaDirection = normalizeDeltaDirection(row.deltaDirection);
  const momentum = normalizeMomentumLabel(row.momentumLabel);
  const hasLive = row.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(row.liveCapturedTenureDays || 0));
  const coverage = clamp(Number(row.liveCaptureCoveragePct || 0), 0, 100);
  const blockerCount = normalizeBlockers(signals.policyBlockers).length;

  const structuredAllowed = (
    gate === 'operationally_credible'
    && source === 'persisted_live_history'
    && durability !== 'unconfirmed'
    && quality !== 'insufficient_live_depth'
    && readiness === 'ready'
    && graduation === 'live_persistence_ready'
    && row.readyForOperationalUse === true
    && hasLive
    && liveTenure >= 5
    && coverage >= 50
    && deltaDirection !== 'regressing'
    && momentum !== 'slipping'
    && blockerCount <= 2
  );

  let confidencePolicy = 'suppress_confidence';
  let overrideLabel = 'suppressed';
  let confidenceOverrideAction = 'decrease_confidence';

  if (gate !== 'blocked' && overrideScore >= 45) {
    confidencePolicy = 'allow_cautious_confidence';
    overrideLabel = 'cautious';
    confidenceOverrideAction = 'no_material_change';
  }

  if (structuredAllowed && overrideScore >= 72) {
    confidencePolicy = 'allow_structured_confidence';
    overrideLabel = 'enabled';
    confidenceOverrideAction = 'increase_confidence';
  }

  if (gate === 'blocked') {
    confidencePolicy = 'suppress_confidence';
    overrideLabel = 'suppressed';
    confidenceOverrideAction = 'decrease_confidence';
  }
  if (gate === 'cautious_use' && confidencePolicy === 'allow_structured_confidence') {
    confidencePolicy = 'allow_cautious_confidence';
    overrideLabel = 'cautious';
    confidenceOverrideAction = 'no_material_change';
  }
  if (
    source !== 'persisted_live_history'
    || durability === 'unconfirmed'
    || quality === 'insufficient_live_depth'
    || readiness !== 'ready'
    || graduation !== 'live_persistence_ready'
  ) {
    if (confidencePolicy === 'allow_structured_confidence') {
      confidencePolicy = 'allow_cautious_confidence';
      overrideLabel = 'cautious';
      confidenceOverrideAction = 'no_material_change';
    }
  }

  if (deltaDirection === 'regressing' || momentum === 'slipping') {
    if (confidencePolicy === 'allow_structured_confidence') {
      confidencePolicy = 'allow_cautious_confidence';
      overrideLabel = 'cautious';
      confidenceOverrideAction = 'no_material_change';
    } else if (confidencePolicy === 'allow_cautious_confidence') {
      confidencePolicy = 'suppress_confidence';
      overrideLabel = 'suppressed';
      confidenceOverrideAction = 'decrease_confidence';
    }
  }

  if (
    confidencePolicy === 'allow_cautious_confidence'
    && (
      !hasLive
      || liveTenure < 2
      || coverage < 20
      || blockerCount >= 5
    )
  ) {
    confidencePolicy = 'suppress_confidence';
    overrideLabel = 'suppressed';
    confidenceOverrideAction = 'decrease_confidence';
  }

  if (!ALLOWED_CONFIDENCE_POLICIES.has(confidencePolicy)) confidencePolicy = 'suppress_confidence';
  if (!ALLOWED_OVERRIDE_LABELS.has(overrideLabel)) overrideLabel = 'suppressed';
  if (!ALLOWED_OVERRIDE_ACTIONS.has(confidenceOverrideAction)) confidenceOverrideAction = 'decrease_confidence';

  return {
    overrideLabel,
    confidencePolicy,
    confidenceOverrideAction,
  };
}

function computeOverridePoints(row = {}, signals = {}, policy = {}) {
  const label = ALLOWED_OVERRIDE_LABELS.has(policy.overrideLabel) ? policy.overrideLabel : 'suppressed';
  const gate = normalizeOperationalTrustGate(row.operationalTrustGate);
  const deltaDirection = normalizeDeltaDirection(row.deltaDirection);
  const momentum = normalizeMomentumLabel(row.momentumLabel);
  const liveTenure = Math.max(0, Number(row.liveCapturedTenureDays || 0));
  const coverage = clamp(Number(row.liveCaptureCoveragePct || 0), 0, 100);
  const blockerCount = normalizeBlockers(signals.policyBlockers).length;
  const supportCount = normalizeSupports(signals.policySupports).length;
  const trustConsumption = normalizeTrustConsumptionLabel(row.trustConsumptionLabel);

  if (label === 'suppressed') {
    let points = -3 - blockerCount;
    if (gate === 'blocked') points -= 2;
    if (deltaDirection === 'regressing' || momentum === 'slipping') points -= 2;
    if (liveTenure < 3) points -= 1;
    if (coverage < 35) points -= 1;
    if (trustConsumption === 'suppress_regime_bias') points -= 1;
    return clamp(Math.round(points), -12, -1);
  }

  if (label === 'cautious') {
    let points = 0;
    if (supportCount > blockerCount + 1) points += 1;
    if (blockerCount > supportCount + 1) points -= 1;
    if (trustConsumption === 'reduce_regime_weight' || trustConsumption === 'suppress_regime_bias') points -= 1;
    if (deltaDirection === 'regressing' || momentum === 'slipping') points -= 1;
    return clamp(Math.round(points), -3, 2);
  }

  let points = 2 + Math.floor((clamp(Number(row.overrideScore || 0), 0, 100) - 75) / 10);
  if (supportCount > blockerCount) points += 1;
  if (deltaDirection === 'improving' && (momentum === 'accelerating' || momentum === 'steady_progress')) points += 1;
  if (trustConsumption === 'allow_regime_confidence') points += 1;
  return clamp(Math.round(points), 1, 6);
}

function buildPolicyReason(row = {}, signals = {}, policy = {}) {
  const regimeLabel = safeCanonicalRegimeLabel(row.regimeLabel || 'unknown');
  const blockers = normalizeBlockers(signals.policyBlockers);
  const supports = normalizeSupports(signals.policySupports);
  if (policy.confidencePolicy === 'allow_structured_confidence') {
    return `${regimeLabel} persistence evidence is live-dominant and operationally credible, so structured confidence can be allowed advisory-only.`;
  }
  if (policy.confidencePolicy === 'allow_cautious_confidence') {
    return `${regimeLabel} persistence evidence is partially supportive but still bounded by ${blockers.slice(0, 2).join(', ') || 'residual blockers'}.`;
  }
  if (supports.length > 0) {
    return `${regimeLabel} persistence confidence should stay suppressed because blocker burden still outweighs partial supports (${supports.slice(0, 2).join(', ')}).`;
  }
  return `${regimeLabel} persistence confidence should be suppressed until live depth, coverage, and durability signals materially improve.`;
}

function buildTrustOverrideInsight(row = {}, signals = {}, policy = {}) {
  const regimeLabel = safeCanonicalRegimeLabel(row.regimeLabel || 'unknown');
  const blockers = normalizeBlockers(signals.policyBlockers);
  if (policy.confidencePolicy === 'allow_structured_confidence') {
    return `${regimeLabel} persistence trust override is enabled with bounded positive confidence support.`;
  }
  if (policy.confidencePolicy === 'allow_cautious_confidence') {
    return `${regimeLabel} persistence trust override remains cautious; keep confidence contribution limited while blockers clear.`;
  }
  return `${regimeLabel} persistence trust override suppresses confidence due to ${blockers.slice(0, 2).join(', ') || 'insufficient operational credibility'}.`;
}

function buildWarnings(row = {}, signals = {}, policy = {}) {
  const warnings = [];
  const source = normalizePersistenceSource(row.persistenceSource);
  const durability = normalizeDurabilityState(row.durabilityState);
  const quality = normalizePersistenceQualityLabel(row.persistenceQualityLabel);
  const deltaDirection = normalizeDeltaDirection(row.deltaDirection);
  const momentum = normalizeMomentumLabel(row.momentumLabel);

  if (normalizeOperationalTrustGate(row.operationalTrustGate) === 'blocked') warnings.push('blocked_operational_credibility');
  if (source === 'mixed_persisted_history') warnings.push('mixed_history_constraint');
  if (source === 'persisted_reconstructed_history' || source === 'proxy_only') warnings.push('reconstructed_dominant_inputs');
  if (quality === 'insufficient_live_depth') warnings.push('insufficient_live_depth');
  if (durability === 'unconfirmed') warnings.push('durability_unconfirmed');
  if (deltaDirection !== 'improving' || momentum === 'slipping' || momentum === 'stalled') warnings.push('delta_not_supportive');
  if (policy.confidencePolicy !== 'allow_structured_confidence') warnings.push('not_ready_for_structured_confidence');

  return Array.from(new Set(warnings));
}

function buildPerRegimeInput(regimeLabel, context = {}) {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel || 'unknown');
  const isCurrent = safeRegime === context.currentRegimeLabel;

  const operationalRow = findByRegime(context.operationalRows, safeRegime) || {};
  const deltaRow = findByRegime(context.deltaRows, safeRegime) || {};
  const durabilityRow = findByRegime(context.durabilityRows, safeRegime) || {};
  const historyRow = findByRegime(context.historyRows, safeRegime) || {};

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
        || context.durabilitySummary?.persistenceSource
        || durabilityRow?.persistenceSource
        || derivePersistenceSourceFromBreakdown(breakdown))
      : (durabilityRow?.persistenceSource || derivePersistenceSourceFromBreakdown(breakdown))
  );

  const hasLiveCapturedHistory = isCurrent
    ? (
      context.readinessSummary?.currentRegimeHasLiveCapturedHistory === true
      || context.historySummary?.currentRegimeHasLiveCapturedHistory === true
      || context.durabilitySummary?.currentRegimeHasLiveCapturedHistory === true
      || durabilityRow?.hasLiveCapturedHistory === true
      || historyRow?.hasLiveCapturedHistory === true
    )
    : (
      durabilityRow?.hasLiveCapturedHistory === true
      || historyRow?.hasLiveCapturedHistory === true
      || breakdown.liveCapturedDays > 0
      || breakdown.mixedDays > 0
    );

  const liveCapturedTenureDays = Math.max(0, Number(
    isCurrent
      ? (
        context.readinessSummary?.currentRegimeLiveCapturedTenureDays
        || context.historySummary?.currentRegimeLiveCapturedTenureDays
        || context.durabilitySummary?.currentRegimeLiveCapturedTenureDays
        || durabilityRow?.liveCapturedTenureDays
        || historyRow?.liveCapturedTenureDays
        || 0
      )
      : (durabilityRow?.liveCapturedTenureDays || historyRow?.liveCapturedTenureDays || 0)
  ));

  const liveCaptureCoveragePct = clamp(
    Number(
      isCurrent
        ? (
          context.liveQualitySummary?.liveCaptureCoveragePct != null
            ? context.liveQualitySummary.liveCaptureCoveragePct
            : (
              context.readinessSummary?.currentRegimeLiveCaptureCoveragePct != null
                ? context.readinessSummary.currentRegimeLiveCaptureCoveragePct
                : deriveCoveragePctFromBreakdown(breakdown)
            )
        )
        : deriveCoveragePctFromBreakdown(breakdown)
    ),
    0,
    100
  );

  const readinessLabel = inferReadinessLabel(safeRegime, context.readinessSummary, context.graduationSummary);
  const graduationState = inferGraduationState(safeRegime, context.readinessSummary, context.graduationSummary);
  const readinessScore = clamp(
    Number(
      isCurrent
        ? (context.readinessSummary?.readinessScore != null
          ? context.readinessSummary.readinessScore
          : mapReadinessLabelToScore(readinessLabel))
        : mapReadinessLabelToScore(readinessLabel)
    ),
    0,
    100
  );
  const graduationProgressScore = clamp(
    Number(
      isCurrent
        ? (context.graduationSummary?.graduationProgressScore || deltaRow?.currentGraduationProgressScore || 0)
        : (deltaRow?.currentGraduationProgressScore || 0)
    ),
    0,
    100
  );

  const durabilityState = normalizeDurabilityState(
    isCurrent
      ? (context.durabilitySummary?.currentRegimeDurabilityState
        || context.readinessSummary?.currentRegimeDurabilityState
        || durabilityRow?.durabilityState
        || 'unconfirmed')
      : (durabilityRow?.durabilityState || 'unconfirmed')
  );

  const persistenceQualityLabel = normalizePersistenceQualityLabel(
    isCurrent
      ? (
        context.liveQualitySummary?.currentRegimePersistenceQualityLabel
        || context.readinessSummary?.currentRegimePersistenceQualityLabel
        || inferPersistenceQualityLabel({
          persistenceSource,
          hasLiveCapturedHistory,
          liveCapturedTenureDays,
          breakdown,
        })
      )
      : inferPersistenceQualityLabel({
        persistenceSource,
        hasLiveCapturedHistory,
        liveCapturedTenureDays,
        breakdown,
      })
  );

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

  const operationalTrustGate = normalizeOperationalTrustGate(
    isCurrent
      ? (context.operationalSummary?.operationalTrustGate || operationalRow?.operationalTrustGate || 'blocked')
      : (operationalRow?.operationalTrustGate || 'blocked')
  );
  const credibilityScore = clamp(
    Number(
      isCurrent
        ? (context.operationalSummary?.credibilityScore != null ? context.operationalSummary.credibilityScore : operationalRow?.credibilityScore || 0)
        : (operationalRow?.credibilityScore || 0)
    ),
    0,
    100
  );

  const deltaDirection = normalizeDeltaDirection(
    isCurrent
      ? (context.deltaSummary?.deltaDirection || deltaRow?.deltaDirection || 'flat')
      : (deltaRow?.deltaDirection || 'flat')
  );
  const deltaStrength = normalizeDeltaStrength(
    isCurrent
      ? (context.deltaSummary?.deltaStrength || deltaRow?.deltaStrength || 'weak')
      : (deltaRow?.deltaStrength || 'weak')
  );
  const momentumLabel = normalizeMomentumLabel(
    isCurrent
      ? (context.deltaSummary?.momentumLabel || deltaRow?.momentumLabel || 'stalled')
      : (deltaRow?.momentumLabel || 'stalled')
  );

  const readyForOperationalUse = isCurrent
    ? (
      context.graduationSummary?.readyForOperationalUse === true
      || context.readinessSummary?.readinessLabel === 'ready'
    )
    : (
      (Array.isArray(context.graduationSummary?.graduatedRegimeLabels) && context.graduationSummary.graduatedRegimeLabels.includes(safeRegime))
      || operationalRow?.readyForOperationalUse === true
    );

  const trustConsumptionLabel = normalizeTrustConsumptionLabel(
    isCurrent
      ? context.trustConsumptionSummary?.trustConsumptionLabel
      : (deltaDirection === 'improving' && hasLiveCapturedHistory ? 'allow_with_caution' : 'suppress_regime_bias')
  );

  return {
    regimeLabel: safeRegime,
    isCurrent,
    persistenceSource,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct: round2(liveCaptureCoveragePct),
    readinessLabel,
    readinessScore: round2(readinessScore),
    graduationState,
    graduationProgressScore: round2(graduationProgressScore),
    durabilityState,
    persistenceQualityLabel,
    cadenceLabel,
    operationalTrustGate,
    credibilityScore: round2(credibilityScore),
    deltaDirection,
    deltaStrength,
    momentumLabel,
    blockersAddedCount: Math.max(0, Number((deltaRow?.blockersAdded || []).length)),
    blockersRemovedCount: Math.max(0, Number((deltaRow?.blockersRemoved || []).length)),
    readyForOperationalUse,
    trustConsumptionLabel,
    breakdown,
  };
}

function buildTrustOverrideRow(input = {}) {
  const signals = buildRowSignals(input);
  const overrideScore = computeOverrideScore(input, signals);
  const policy = classifyPolicy(input, signals, overrideScore);
  const confidenceOverridePoints = computeOverridePoints(
    { ...input, overrideScore },
    signals,
    policy
  );
  return {
    regimeLabel: input.regimeLabel,
    overrideScore: round2(overrideScore),
    overrideLabel: ALLOWED_OVERRIDE_LABELS.has(policy.overrideLabel) ? policy.overrideLabel : 'suppressed',
    confidencePolicy: ALLOWED_CONFIDENCE_POLICIES.has(policy.confidencePolicy) ? policy.confidencePolicy : 'suppress_confidence',
    confidenceOverrideAction: ALLOWED_OVERRIDE_ACTIONS.has(policy.confidenceOverrideAction)
      ? policy.confidenceOverrideAction
      : 'decrease_confidence',
    confidenceOverridePoints: clamp(Math.round(Number(confidenceOverridePoints || 0)), -12, 6),
    readyForOperationalUse: input.readyForOperationalUse === true,
    policyBlockers: normalizeBlockers(signals.policyBlockers),
    policySupports: normalizeSupports(signals.policySupports),
    policyReason: buildPolicyReason(input, signals, policy),
    trustOverrideInsight: buildTrustOverrideInsight(input, signals, policy),
    warnings: buildWarnings(input, signals, policy),
    advisoryOnly: true,
  };
}

function buildRegimePersistenceTrustOverrideSummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const operationalSummary = input.regimePersistenceOperationalCredibility && typeof input.regimePersistenceOperationalCredibility === 'object'
    ? input.regimePersistenceOperationalCredibility
    : {};
  const deltaSummary = input.regimePersistenceGraduationDelta && typeof input.regimePersistenceGraduationDelta === 'object'
    ? input.regimePersistenceGraduationDelta
    : {};
  const graduationSummary = input.regimePersistenceGraduation && typeof input.regimePersistenceGraduation === 'object'
    ? input.regimePersistenceGraduation
    : {};
  const readinessSummary = input.regimePersistenceReadiness && typeof input.regimePersistenceReadiness === 'object'
    ? input.regimePersistenceReadiness
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
  const trustConsumptionSummary = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};

  const currentRegimeLabel = safeCanonicalRegimeLabel(
    operationalSummary.currentRegimeLabel
      || deltaSummary.currentRegimeLabel
      || graduationSummary.currentRegimeLabel
      || readinessSummary.currentRegimeLabel
      || liveQualitySummary.currentRegimeLabel
      || durabilitySummary.currentRegimeLabel
      || historySummary.currentRegimeLabel
      || trustConsumptionSummary.currentRegimeLabel
      || 'unknown'
  );

  const context = {
    currentRegimeLabel,
    operationalSummary,
    deltaSummary,
    graduationSummary,
    readinessSummary,
    liveQualitySummary,
    durabilitySummary,
    historySummary,
    trustConsumptionSummary,
    operationalRows: Array.isArray(operationalSummary.credibilityByRegime) ? operationalSummary.credibilityByRegime : [],
    deltaRows: Array.isArray(deltaSummary.graduationDeltaByRegime) ? deltaSummary.graduationDeltaByRegime : [],
    durabilityRows: Array.isArray(durabilitySummary.durabilityByRegime) ? durabilitySummary.durabilityByRegime : [],
    historyRows: Array.isArray(historySummary.byRegime) ? historySummary.byRegime : [],
  };

  const trustOverrideByRegime = SUPPORTED_REGIME_LABELS.map((regimeLabel) => {
    const rowInput = buildPerRegimeInput(regimeLabel, context);
    const row = buildTrustOverrideRow(rowInput);
    return {
      regimeLabel: row.regimeLabel,
      overrideScore: row.overrideScore,
      overrideLabel: row.overrideLabel,
      confidencePolicy: row.confidencePolicy,
      confidenceOverrideAction: row.confidenceOverrideAction,
      confidenceOverridePoints: row.confidenceOverridePoints,
      readyForOperationalUse: row.readyForOperationalUse,
      policyBlockers: row.policyBlockers,
      policySupports: row.policySupports,
      advisoryOnly: true,
      _meta: {
        policyReason: row.policyReason,
        trustOverrideInsight: row.trustOverrideInsight,
        warnings: row.warnings,
      },
    };
  });

  const currentRow = trustOverrideByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || trustOverrideByRegime[0]
    || {
      regimeLabel: currentRegimeLabel,
      overrideScore: 0,
      overrideLabel: 'suppressed',
      confidencePolicy: 'suppress_confidence',
      confidenceOverrideAction: 'decrease_confidence',
      confidenceOverridePoints: -4,
      readyForOperationalUse: false,
      policyBlockers: ['credibility_blocked'],
      policySupports: [],
      advisoryOnly: true,
      _meta: {
        policyReason: `${currentRegimeLabel} persistence confidence is suppressed due to missing credible inputs.`,
        trustOverrideInsight: `${currentRegimeLabel} persistence trust override is conservative because upstream evidence is missing.`,
        warnings: ['thin_credibility_inputs'],
      },
    };

  const suppressOverrideRegimeLabels = trustOverrideByRegime
    .filter((row) => row.overrideLabel === 'suppressed')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));
  const cautiousOverrideRegimeLabels = trustOverrideByRegime
    .filter((row) => row.overrideLabel === 'cautious')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));
  const enabledOverrideRegimeLabels = trustOverrideByRegime
    .filter((row) => row.overrideLabel === 'enabled')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const warnings = Array.from(new Set(
    (currentRow?._meta?.warnings || []).filter(Boolean)
  ));

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    overrideScore: round2(Number(currentRow.overrideScore || 0)),
    overrideLabel: ALLOWED_OVERRIDE_LABELS.has(currentRow.overrideLabel) ? currentRow.overrideLabel : 'suppressed',
    confidencePolicy: ALLOWED_CONFIDENCE_POLICIES.has(currentRow.confidencePolicy)
      ? currentRow.confidencePolicy
      : 'suppress_confidence',
    confidenceOverrideAction: ALLOWED_OVERRIDE_ACTIONS.has(currentRow.confidenceOverrideAction)
      ? currentRow.confidenceOverrideAction
      : 'decrease_confidence',
    confidenceOverridePoints: clamp(Math.round(Number(currentRow.confidenceOverridePoints || 0)), -12, 6),
    policyReason: currentRow?._meta?.policyReason || `${currentRegimeLabel} persistence policy remains conservative.`,
    policyBlockers: normalizeBlockers(currentRow.policyBlockers || []),
    policySupports: normalizeSupports(currentRow.policySupports || []),
    trustOverrideInsight: currentRow?._meta?.trustOverrideInsight || `${currentRegimeLabel} persistence trust override remains conservative.`,
    readyForOperationalUse: currentRow.readyForOperationalUse === true,
    suppressOverrideRegimeLabels,
    cautiousOverrideRegimeLabels,
    enabledOverrideRegimeLabels,
    trustOverrideByRegime: trustOverrideByRegime.map((row) => ({
      regimeLabel: row.regimeLabel,
      overrideScore: row.overrideScore,
      overrideLabel: row.overrideLabel,
      confidencePolicy: row.confidencePolicy,
      confidenceOverrideAction: row.confidenceOverrideAction,
      confidenceOverridePoints: row.confidenceOverridePoints,
      readyForOperationalUse: row.readyForOperationalUse === true,
      policyBlockers: normalizeBlockers(row.policyBlockers || []),
      policySupports: normalizeSupports(row.policySupports || []),
      advisoryOnly: true,
    })),
    warnings,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePersistenceTrustOverrideSummary,
};
