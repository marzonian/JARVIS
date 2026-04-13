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

const ALLOWED_GRADUATION_MILESTONES = new Set([
  'no_live_base',
  'live_base_established',
  'live_depth_building',
  'durability_building',
  'nearing_operational_readiness',
  'operationally_ready',
]);

const ALLOWED_PROGRESS_DIRECTIONS = new Set([
  'improving',
  'flat',
  'regressing',
]);

const ALLOWED_REMAINING_REQUIREMENTS = new Set([
  'add_live_tenure',
  'increase_live_coverage',
  'reduce_reconstructed_share',
  'improve_durability',
  'improve_persistence_quality',
  'confirm_live_cadence',
  'establish_live_base',
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

function normalizeReadinessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'ready' || txt === 'near_ready' || txt === 'early' || txt === 'not_ready') return txt;
  return 'not_ready';
}

function normalizeGraduationState(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'live_persistence_ready'
    || txt === 'nearing_live_persistence'
    || txt === 'accumulating_live_depth'
    || txt === 'reconstructed_dominant'
  ) {
    return txt;
  }
  return 'reconstructed_dominant';
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

function normalizePersistenceQualityLabel(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'live_ready'
    || txt === 'partially_live_supported'
    || txt === 'mostly_reconstructed'
    || txt === 'insufficient_live_depth'
  ) {
    return txt;
  }
  return 'insufficient_live_depth';
}

function normalizeCadenceLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'healthy' || txt === 'improving' || txt === 'sparse' || txt === 'stale') return txt;
  return 'stale';
}

function normalizeDurabilityState(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'unconfirmed'
    || txt === 'building_durability'
    || txt === 'durable_confirmed'
    || txt === 'fragile_confirmation'
    || txt === 'decaying_confirmation'
    || txt === 'recovering_confirmation'
  ) {
    return txt;
  }
  return 'unconfirmed';
}

function normalizeDurabilityConstraint(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'capture_cadence_limited'
    || txt === 'live_depth_limited'
    || txt === 'regime_quality_limited'
    || txt === 'mixed_constraints'
  ) {
    return txt;
  }
  return 'mixed_constraints';
}

function findByRegime(rows = [], regimeLabel = '') {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    normalizeRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
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
    totalDays: liveCapturedDays + reconstructedDays + mixedDays,
  };
}

function deriveCoveragePctFromBreakdown(breakdown = {}) {
  const safe = normalizeBreakdown(breakdown);
  if (safe.totalDays <= 0) return 0;
  const liveLike = safe.liveCapturedDays + safe.mixedDays;
  return round2(clamp((liveLike / safe.totalDays) * 100, 0, 100));
}

function derivePersistenceSourceFromBreakdown(breakdown = {}) {
  const safe = normalizeBreakdown(breakdown);
  if (safe.mixedDays > 0 || (safe.liveCapturedDays > 0 && safe.reconstructedDays > 0)) {
    return 'mixed_persisted_history';
  }
  if (safe.liveCapturedDays > 0 && safe.reconstructedDays <= 0) {
    return 'persisted_live_history';
  }
  if (safe.reconstructedDays > 0) {
    return 'persisted_reconstructed_history';
  }
  return 'proxy_only';
}

function deriveQualityLabel(input = {}) {
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const breakdown = normalizeBreakdown(input.breakdown);

  if (persistenceSource === 'persisted_live_history' && hasLive && liveTenure >= 5) {
    return 'live_ready';
  }
  if (!hasLive || liveTenure < 3) {
    return 'insufficient_live_depth';
  }
  if (
    (persistenceSource === 'persisted_reconstructed_history' || persistenceSource === 'mixed_persisted_history')
    && breakdown.reconstructedDays > breakdown.liveCapturedDays
  ) {
    return 'mostly_reconstructed';
  }
  if (persistenceSource === 'persisted_reconstructed_history') return 'mostly_reconstructed';
  if (persistenceSource === 'mixed_persisted_history') return 'partially_live_supported';
  return 'partially_live_supported';
}

function scoreSourceQuality(persistenceSource = 'proxy_only') {
  if (persistenceSource === 'persisted_live_history') return 100;
  if (persistenceSource === 'mixed_persisted_history') return 55;
  if (persistenceSource === 'persisted_reconstructed_history') return 25;
  return 10;
}

function scoreDurabilityState(durabilityState = 'unconfirmed') {
  if (durabilityState === 'durable_confirmed') return 85;
  if (durabilityState === 'building_durability') return 65;
  if (durabilityState === 'recovering_confirmation') return 60;
  if (durabilityState === 'fragile_confirmation') return 45;
  if (durabilityState === 'decaying_confirmation') return 30;
  return 20;
}

function mapReadinessLabelToScore(readinessLabel = 'not_ready') {
  if (readinessLabel === 'ready') return 82;
  if (readinessLabel === 'near_ready') return 62;
  if (readinessLabel === 'early') return 38;
  return 18;
}

function mapReadinessLabelToState(readinessLabel = 'not_ready', persistenceSource = 'proxy_only') {
  if (readinessLabel === 'ready') return 'live_persistence_ready';
  if (readinessLabel === 'near_ready') return 'nearing_live_persistence';
  if (readinessLabel === 'early') return 'accumulating_live_depth';
  return persistenceSource === 'persisted_live_history'
    ? 'accumulating_live_depth'
    : 'reconstructed_dominant';
}

function buildRemainingRequirements(input = {}) {
  const requirements = new Set();
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel);

  if (!hasLive || liveTenure <= 0) {
    requirements.add('establish_live_base');
  }
  if (liveTenure < 5) {
    requirements.add('add_live_tenure');
  }
  if (liveCoveragePct < 50) {
    requirements.add('increase_live_coverage');
  }
  if (persistenceSource === 'mixed_persisted_history' || persistenceSource === 'persisted_reconstructed_history' || persistenceSource === 'proxy_only') {
    requirements.add('reduce_reconstructed_share');
  }
  if (durabilityState === 'unconfirmed' || durabilityState === 'fragile_confirmation' || durabilityState === 'decaying_confirmation' || durabilityState === 'building_durability') {
    requirements.add('improve_durability');
  }
  if (persistenceQualityLabel !== 'live_ready') {
    requirements.add('improve_persistence_quality');
  }
  if (cadenceLabel === 'sparse' || cadenceLabel === 'stale') {
    requirements.add('confirm_live_cadence');
  }

  return Array.from(requirements).filter((item) => ALLOWED_REMAINING_REQUIREMENTS.has(item));
}

function computeGraduationProgressScore(input = {}) {
  const readinessScore = clamp(Number(input.readinessScore || 0), 0, 100);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const graduationState = normalizeGraduationState(input.graduationState);

  const tenureScore = clamp(liveTenure * 10, 0, 100);
  const sourceScore = scoreSourceQuality(persistenceSource);
  const durabilityScore = scoreDurabilityState(durabilityState);
  const qualityScore = (
    persistenceQualityLabel === 'live_ready' ? 95
      : persistenceQualityLabel === 'partially_live_supported' ? 70
        : persistenceQualityLabel === 'mostly_reconstructed' ? 40
          : 20
  );

  let score = (
    readinessScore * 0.6
    + tenureScore * 0.15
    + liveCoveragePct * 0.15
    + sourceScore * 0.05
    + durabilityScore * 0.05
  );

  score += (qualityScore - 50) * 0.05;

  if (!hasLive) score = Math.min(score, 20);
  if (persistenceSource === 'mixed_persisted_history') score = Math.min(score, 74);
  if (persistenceSource === 'persisted_reconstructed_history' || persistenceSource === 'proxy_only') score = Math.min(score, 54);
  if (persistenceQualityLabel === 'insufficient_live_depth') score = Math.min(score, 59);
  if (durabilityState === 'unconfirmed') score = Math.min(score, 69);
  if (liveTenure < 3) score = Math.min(score, 49);
  if (liveCoveragePct < 35) score = Math.min(score, 54);
  if (graduationState === 'reconstructed_dominant') score = Math.min(score, 64);
  if (readinessLabel === 'not_ready') score = Math.min(score, 44);

  return round2(clamp(score, 0, 100));
}

function classifyMilestone(input = {}) {
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const graduationState = normalizeGraduationState(input.graduationState);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const progressScore = clamp(Number(input.graduationProgressScore || 0), 0, 100);
  const remainingRequirements = Array.isArray(input.remainingRequirements) ? input.remainingRequirements : [];

  const operationalReady = (
    readinessLabel === 'ready'
    && graduationState === 'live_persistence_ready'
    && persistenceSource === 'persisted_live_history'
    && durabilityState !== 'unconfirmed'
    && liveTenure >= 5
    && liveCoveragePct >= 50
    && persistenceQualityLabel === 'live_ready'
  );
  if (operationalReady) return 'operationally_ready';

  if (!hasLive || liveTenure <= 0) {
    return 'no_live_base';
  }

  if (liveTenure < 3 || liveCoveragePct < 20) {
    return 'live_base_established';
  }

  if (
    readinessLabel === 'near_ready'
    || (progressScore >= 68 && remainingRequirements.length <= 2)
  ) {
    return 'nearing_operational_readiness';
  }

  if (
    persistenceQualityLabel === 'insufficient_live_depth'
    || readinessLabel === 'early'
    || liveTenure < 5
    || liveCoveragePct < 35
  ) {
    return 'live_depth_building';
  }

  return 'durability_building';
}

function applyMilestoneGuardrails(input = {}) {
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const graduationState = normalizeGraduationState(input.graduationState);

  let milestone = ALLOWED_GRADUATION_MILESTONES.has(input.graduationMilestone)
    ? input.graduationMilestone
    : 'no_live_base';

  if (!hasLive || liveTenure <= 0) {
    milestone = 'no_live_base';
  }

  if (milestone !== 'no_live_base' && (liveTenure < 3 || liveCoveragePct < 20)) {
    milestone = 'live_base_established';
  }

  if (
    (persistenceQualityLabel === 'insufficient_live_depth' || (liveTenure < 5 && liveCoveragePct < 35))
    && (milestone === 'durability_building' || milestone === 'nearing_operational_readiness' || milestone === 'operationally_ready')
  ) {
    milestone = 'live_depth_building';
  }

  if (
    durabilityState === 'unconfirmed'
    && readinessLabel !== 'near_ready'
    && (milestone === 'nearing_operational_readiness' || milestone === 'operationally_ready')
  ) {
    milestone = 'durability_building';
  }

  if (
    (persistenceSource === 'mixed_persisted_history' || persistenceSource === 'persisted_reconstructed_history' || graduationState === 'reconstructed_dominant')
    && (milestone === 'nearing_operational_readiness' || milestone === 'operationally_ready')
  ) {
    milestone = 'durability_building';
  }

  if (milestone === 'operationally_ready') {
    if (
      persistenceSource !== 'persisted_live_history'
      || readinessLabel !== 'ready'
      || graduationState !== 'live_persistence_ready'
      || durabilityState === 'unconfirmed'
      || liveTenure < 5
      || liveCoveragePct < 50
      || persistenceQualityLabel !== 'live_ready'
    ) {
      milestone = 'nearing_operational_readiness';
    }
  }

  if (!ALLOWED_GRADUATION_MILESTONES.has(milestone)) {
    milestone = 'no_live_base';
  }
  return milestone;
}

function classifyProgressDirection(input = {}) {
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const durabilityConstraint = normalizeDurabilityConstraint(input.durabilityConstraint);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const captureGapDays = toNumber(input.captureGapDays, null);

  const regressing = (
    durabilityState === 'decaying_confirmation'
    || (Number.isFinite(captureGapDays) && captureGapDays >= 5)
    || (cadenceLabel === 'stale' && (durabilityConstraint === 'capture_cadence_limited' || durabilityConstraint === 'mixed_constraints'))
    || (persistenceQualityLabel === 'mostly_reconstructed' && readinessLabel !== 'near_ready' && readinessLabel !== 'ready')
  );

  if (regressing) return 'regressing';

  const improving = (
    hasLive
    && liveTenure > 0
    && liveCoveragePct > 0
    && (cadenceLabel === 'healthy' || cadenceLabel === 'improving')
    && (readinessLabel === 'near_ready' || readinessLabel === 'early' || persistenceQualityLabel === 'partially_live_supported' || persistenceQualityLabel === 'live_ready')
  );
  if (improving) return 'improving';

  return 'flat';
}

function buildGraduationInsight(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const milestone = ALLOWED_GRADUATION_MILESTONES.has(input.graduationMilestone)
    ? input.graduationMilestone
    : 'no_live_base';
  const score = round2(Number(input.graduationProgressScore || 0));
  const direction = ALLOWED_PROGRESS_DIRECTIONS.has(input.progressDirection)
    ? input.progressDirection
    : 'flat';
  const remainingRequirements = Array.isArray(input.remainingRequirements) ? input.remainingRequirements : [];
  const readyForOperationalUse = input.readyForOperationalUse === true;

  if (readyForOperationalUse) {
    return `${regimeLabel} has reached operational live persistence readiness with bounded durability support.`;
  }
  if (milestone === 'no_live_base') {
    return `${regimeLabel} has no live persistence base yet; graduation remains blocked until live capture begins.`;
  }
  if (milestone === 'live_base_established') {
    return `${regimeLabel} has established a live base, but tenure/coverage are still too thin for stronger graduation confidence.`;
  }
  if (milestone === 'live_depth_building') {
    return `${regimeLabel} is building live depth (score ${score}) and still needs ${remainingRequirements.slice(0, 2).join(', ') || 'additional live evidence'}.`;
  }
  if (milestone === 'durability_building') {
    return `${regimeLabel} is in durability-building stage; persistence remains conservative while ${remainingRequirements.slice(0, 2).join(', ') || 'durability constraints'} are unresolved.`;
  }
  if (milestone === 'nearing_operational_readiness') {
    return `${regimeLabel} is nearing operational readiness (score ${score}) with ${direction} graduation momentum.`;
  }
  return `${regimeLabel} graduation progress is ${direction} (score ${score}) with bounded advisory-only interpretation.`;
}

function buildRegimeRow(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const isCurrentRegime = input.isCurrentRegime === true;

  const breakdown = normalizeBreakdown(input.breakdown);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource || derivePersistenceSourceFromBreakdown(breakdown));
  const hasLiveCapturedHistory = input.hasLiveCapturedHistory === true;
  const liveCapturedTenureDays = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCaptureCoveragePct = clamp(
    Number(input.liveCaptureCoveragePct != null ? input.liveCaptureCoveragePct : deriveCoveragePctFromBreakdown(breakdown)),
    0,
    100
  );
  const readinessLabel = normalizeReadinessLabel(input.readinessLabel);
  const readinessScore = clamp(
    Number(input.readinessScore != null ? input.readinessScore : mapReadinessLabelToScore(readinessLabel)),
    0,
    100
  );
  const graduationState = normalizeGraduationState(
    input.graduationState || mapReadinessLabelToState(readinessLabel, persistenceSource)
  );
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(
    input.persistenceQualityLabel || deriveQualityLabel({
      persistenceSource,
      hasLiveCapturedHistory,
      liveCapturedTenureDays,
      breakdown,
    })
  );
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel);
  const durabilityConstraint = normalizeDurabilityConstraint(input.durabilityConstraint);

  const graduationProgressScore = computeGraduationProgressScore({
    readinessScore,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    persistenceSource,
    persistenceQualityLabel,
    durabilityState,
    readinessLabel,
    graduationState,
  });
  const remainingRequirements = buildRemainingRequirements({
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    persistenceSource,
    durabilityState,
    persistenceQualityLabel,
    cadenceLabel,
  });
  const initialMilestone = classifyMilestone({
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    readinessLabel,
    graduationState,
    persistenceSource,
    durabilityState,
    persistenceQualityLabel,
    graduationProgressScore,
    remainingRequirements,
  });
  const graduationMilestone = applyMilestoneGuardrails({
    graduationMilestone: initialMilestone,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    persistenceSource,
    durabilityState,
    persistenceQualityLabel,
    readinessLabel,
    graduationState,
  });

  const progressDirection = classifyProgressDirection({
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    readinessLabel,
    cadenceLabel,
    durabilityState,
    durabilityConstraint,
    persistenceQualityLabel,
    captureGapDays: input.captureGapDays,
  });

  const readyForOperationalUse = (
    graduationMilestone === 'operationally_ready'
    && readinessLabel === 'ready'
    && graduationState === 'live_persistence_ready'
    && persistenceSource === 'persisted_live_history'
    && durabilityState !== 'unconfirmed'
    && liveCapturedTenureDays >= 5
    && liveCaptureCoveragePct >= 50
  );

  return {
    regimeLabel,
    isCurrentRegime,
    persistenceSource,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct: round2(liveCaptureCoveragePct),
    readinessLabel,
    readinessScore: round2(readinessScore),
    graduationState,
    durabilityState,
    persistenceQualityLabel,
    cadenceLabel,
    durabilityConstraint,
    graduationMilestone,
    graduationProgressScore: round2(graduationProgressScore),
    graduationProgressPct: round2(graduationProgressScore),
    progressDirection,
    remainingRequirements,
    readyForOperationalUse,
    breakdown,
  };
}

function buildRegimePersistenceGraduationSummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const regimePersistenceReadiness = input.regimePersistenceReadiness && typeof input.regimePersistenceReadiness === 'object'
    ? input.regimePersistenceReadiness
    : {};
  const regimeLivePersistenceQuality = input.regimeLivePersistenceQuality && typeof input.regimeLivePersistenceQuality === 'object'
    ? input.regimeLivePersistenceQuality
    : {};
  const regimeConfirmationDurability = input.regimeConfirmationDurability && typeof input.regimeConfirmationDurability === 'object'
    ? input.regimeConfirmationDurability
    : {};
  const regimeConfirmationHistory = input.regimeConfirmationHistory && typeof input.regimeConfirmationHistory === 'object'
    ? input.regimeConfirmationHistory
    : {};

  const currentRegimeLabel = normalizeRegimeLabel(
    regimePersistenceReadiness?.currentRegimeLabel
      || regimeLivePersistenceQuality?.currentRegimeLabel
      || regimeConfirmationDurability?.currentRegimeLabel
      || regimeConfirmationHistory?.currentRegimeLabel
      || 'unknown'
  );

  const historyRows = Array.isArray(regimeConfirmationHistory.byRegime)
    ? regimeConfirmationHistory.byRegime
    : [];
  const durabilityRows = Array.isArray(regimeConfirmationDurability.durabilityByRegime)
    ? regimeConfirmationDurability.durabilityByRegime
    : [];
  const readyLabels = new Set((Array.isArray(regimePersistenceReadiness.liveReadyRegimeLabels) ? regimePersistenceReadiness.liveReadyRegimeLabels : []).map((label) => normalizeRegimeLabel(label)));
  const nearLabels = new Set((Array.isArray(regimePersistenceReadiness.nearReadyRegimeLabels) ? regimePersistenceReadiness.nearReadyRegimeLabels : []).map((label) => normalizeRegimeLabel(label)));
  const notReadyLabels = new Set((Array.isArray(regimePersistenceReadiness.notReadyRegimeLabels) ? regimePersistenceReadiness.notReadyRegimeLabels : []).map((label) => normalizeRegimeLabel(label)));

  const rows = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const historyRow = findByRegime(historyRows, regimeLabel) || {};
    const durabilityRow = findByRegime(durabilityRows, regimeLabel) || {};
    const breakdown = durabilityRow?.provenanceBreakdown && typeof durabilityRow.provenanceBreakdown === 'object'
      ? durabilityRow.provenanceBreakdown
      : (historyRow?.provenanceBreakdown && typeof historyRow.provenanceBreakdown === 'object'
        ? historyRow.provenanceBreakdown
        : {
          liveCapturedDays: Number(historyRow.liveCapturedDays || 0),
          reconstructedDays: Number(historyRow.reconstructedDays || 0),
          mixedDays: Number(historyRow.mixedDays || 0),
        });

    const isCurrentRegime = regimeLabel === currentRegimeLabel;
    const rowReadinessLabel = isCurrentRegime
      ? normalizeReadinessLabel(regimePersistenceReadiness?.readinessLabel)
      : (readyLabels.has(regimeLabel)
        ? 'ready'
        : (nearLabels.has(regimeLabel)
          ? 'near_ready'
          : (notReadyLabels.has(regimeLabel)
            ? 'not_ready'
            : ((historyRow?.hasLiveCapturedHistory === true || durabilityRow?.hasLiveCapturedHistory === true) ? 'early' : 'not_ready'))));

    const row = buildRegimeRow({
      regimeLabel,
      isCurrentRegime,
      breakdown,
      persistenceSource: isCurrentRegime
        ? regimePersistenceReadiness?.persistenceSource
        : durabilityRow?.persistenceSource,
      hasLiveCapturedHistory: isCurrentRegime
        ? regimePersistenceReadiness?.currentRegimeHasLiveCapturedHistory === true
        : (historyRow?.hasLiveCapturedHistory === true || durabilityRow?.hasLiveCapturedHistory === true),
      liveCapturedTenureDays: isCurrentRegime
        ? Number(regimePersistenceReadiness?.currentRegimeLiveCapturedTenureDays || 0)
        : Number(historyRow?.liveCapturedTenureDays || durabilityRow?.liveCapturedTenureDays || 0),
      liveCaptureCoveragePct: isCurrentRegime
        ? toNumber(regimePersistenceReadiness?.currentRegimeLiveCaptureCoveragePct, null)
        : null,
      readinessLabel: rowReadinessLabel,
      readinessScore: isCurrentRegime
        ? toNumber(regimePersistenceReadiness?.readinessScore, null)
        : null,
      graduationState: isCurrentRegime
        ? regimePersistenceReadiness?.graduationState
        : null,
      durabilityState: isCurrentRegime
        ? regimePersistenceReadiness?.currentRegimeDurabilityState
        : durabilityRow?.durabilityState,
      persistenceQualityLabel: isCurrentRegime
        ? regimePersistenceReadiness?.currentRegimePersistenceQualityLabel
        : null,
      cadenceLabel: isCurrentRegime
        ? regimeLivePersistenceQuality?.currentRegimeLiveCadenceLabel
        : 'stale',
      durabilityConstraint: isCurrentRegime
        ? regimeLivePersistenceQuality?.currentRegimeDurabilityConstraint
        : 'mixed_constraints',
      captureGapDays: isCurrentRegime
        ? toNumber(regimeLivePersistenceQuality?.currentRegimeCaptureGapDays, null)
        : null,
    });

    rows.push(row);
  }

  const currentRow = rows.find((row) => row.regimeLabel === currentRegimeLabel) || buildRegimeRow({
    regimeLabel: currentRegimeLabel,
    isCurrentRegime: true,
    breakdown: {
      liveCapturedDays: Number(regimeConfirmationHistory?.historyProvenanceBreakdown?.liveCapturedDays || 0),
      reconstructedDays: Number(regimeConfirmationHistory?.historyProvenanceBreakdown?.reconstructedDays || 0),
      mixedDays: Number(regimeConfirmationHistory?.historyProvenanceBreakdown?.mixedDays || 0),
    },
    persistenceSource: regimePersistenceReadiness?.persistenceSource,
    hasLiveCapturedHistory: regimePersistenceReadiness?.currentRegimeHasLiveCapturedHistory === true,
    liveCapturedTenureDays: Number(regimePersistenceReadiness?.currentRegimeLiveCapturedTenureDays || 0),
    liveCaptureCoveragePct: Number(regimePersistenceReadiness?.currentRegimeLiveCaptureCoveragePct || 0),
    readinessLabel: regimePersistenceReadiness?.readinessLabel,
    readinessScore: Number(regimePersistenceReadiness?.readinessScore || 0),
    graduationState: regimePersistenceReadiness?.graduationState,
    durabilityState: regimePersistenceReadiness?.currentRegimeDurabilityState,
    persistenceQualityLabel: regimePersistenceReadiness?.currentRegimePersistenceQualityLabel,
    cadenceLabel: regimeLivePersistenceQuality?.currentRegimeLiveCadenceLabel,
    durabilityConstraint: regimeLivePersistenceQuality?.currentRegimeDurabilityConstraint,
    captureGapDays: toNumber(regimeLivePersistenceQuality?.currentRegimeCaptureGapDays, null),
  });

  const graduatedRegimeLabels = rows
    .filter((row) => row.readyForOperationalUse === true)
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const stalledGraduationRegimeLabels = rows
    .filter((row) => (
      row.progressDirection === 'regressing'
      || row.graduationMilestone === 'no_live_base'
      || row.readinessLabel === 'not_ready'
    ))
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const progressingRegimeLabels = rows
    .filter((row) => (
      row.readyForOperationalUse !== true
      && stalledGraduationRegimeLabels.includes(row.regimeLabel) === false
      && (
        row.graduationMilestone === 'live_base_established'
        || row.graduationMilestone === 'live_depth_building'
        || row.graduationMilestone === 'durability_building'
        || row.graduationMilestone === 'nearing_operational_readiness'
      )
    ))
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const graduationInsight = buildGraduationInsight({
    currentRegimeLabel,
    graduationMilestone: currentRow.graduationMilestone,
    graduationProgressScore: currentRow.graduationProgressScore,
    progressDirection: currentRow.progressDirection,
    remainingRequirements: currentRow.remainingRequirements,
    readyForOperationalUse: currentRow.readyForOperationalUse,
  });

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    readinessLabel: currentRow.readinessLabel,
    graduationState: currentRow.graduationState,
    graduationMilestone: currentRow.graduationMilestone,
    graduationProgressScore: currentRow.graduationProgressScore,
    graduationProgressPct: currentRow.graduationProgressPct,
    progressDirection: currentRow.progressDirection,
    remainingRequirements: currentRow.remainingRequirements,
    graduationInsight,
    readyForOperationalUse: currentRow.readyForOperationalUse === true,
    graduatedRegimeLabels,
    progressingRegimeLabels,
    stalledGraduationRegimeLabels,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePersistenceGraduationSummary,
};
