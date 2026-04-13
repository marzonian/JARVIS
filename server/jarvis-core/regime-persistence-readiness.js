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

const ALLOWED_BLOCKERS = new Set([
  'insufficient_live_tenure',
  'insufficient_live_coverage',
  'reconstructed_history_dominant',
  'durability_not_confirmed',
  'cadence_too_sparse',
  'live_depth_too_thin',
  'mixed_constraints',
  'no_live_history',
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

function normalizeCadenceLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'healthy' || txt === 'improving' || txt === 'sparse' || txt === 'stale') return txt;
  return 'stale';
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

function deriveCoveragePctFromBreakdown(breakdown = {}) {
  const liveCapturedDays = Math.max(0, Number(breakdown.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(breakdown.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(breakdown.mixedDays || 0));
  const total = Math.max(0, liveCapturedDays + reconstructedDays + mixedDays);
  const livePresence = Math.max(0, liveCapturedDays + mixedDays);
  if (total <= 0) return 0;
  return round2(clamp((livePresence / total) * 100, 0, 100));
}

function derivePersistenceSourceFromRow(input = {}) {
  const explicit = normalizePersistenceSource(input.persistenceSource || '');
  if (explicit !== 'proxy_only') return explicit;
  const breakdown = input.provenanceBreakdown && typeof input.provenanceBreakdown === 'object'
    ? input.provenanceBreakdown
    : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 };
  const liveCapturedDays = Math.max(0, Number(breakdown.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(breakdown.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(breakdown.mixedDays || 0));
  if (mixedDays > 0 || (liveCapturedDays > 0 && reconstructedDays > 0)) return 'mixed_persisted_history';
  if (liveCapturedDays > 0 && reconstructedDays <= 0) return 'persisted_live_history';
  if (reconstructedDays > 0 || mixedDays > 0) return 'persisted_reconstructed_history';
  return 'proxy_only';
}

function derivePersistenceQualityLabel(input = {}) {
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));

  if (persistenceSource === 'persisted_live_history' && hasLive && liveTenure >= 5) return 'live_ready';
  if (!hasLive || liveTenure < 3) return 'insufficient_live_depth';
  if (
    (persistenceSource === 'persisted_reconstructed_history' || persistenceSource === 'mixed_persisted_history')
    && reconstructedDays > liveCapturedDays
  ) {
    return 'mostly_reconstructed';
  }
  if (persistenceSource === 'persisted_reconstructed_history') return 'mostly_reconstructed';
  if (persistenceSource === 'mixed_persisted_history' && hasLive) return 'partially_live_supported';
  if (reconstructedDays > liveCapturedDays) return 'mostly_reconstructed';
  return hasLive ? 'partially_live_supported' : 'insufficient_live_depth';
}

function computeReadinessScore(input = {}) {
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoverage = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const durabilityState = normalizeDurabilityState(input.durabilityState);

  const tenureScore = clamp((liveTenure / 8) * 30, 0, 30);
  const coverageScore = clamp(liveCoverage * 0.25, 0, 25);
  const sourceScore = (
    persistenceSource === 'persisted_live_history' ? 20
      : persistenceSource === 'mixed_persisted_history' ? 10
        : persistenceSource === 'persisted_reconstructed_history' ? 4
          : 0
  );
  const qualityScore = (
    persistenceQualityLabel === 'live_ready' ? 15
      : persistenceQualityLabel === 'partially_live_supported' ? 10
        : persistenceQualityLabel === 'mostly_reconstructed' ? 5
          : 2
  );
  const durabilityScore = (
    durabilityState === 'durable_confirmed' ? 10
      : durabilityState === 'building_durability' ? 7
        : durabilityState === 'recovering_confirmation' ? 6
          : durabilityState === 'fragile_confirmation' ? 5
            : durabilityState === 'decaying_confirmation' ? 2
              : 1
  );

  let score = tenureScore + coverageScore + sourceScore + qualityScore + durabilityScore;

  if (!hasLive) score = Math.min(score, 20);
  if (persistenceSource === 'mixed_persisted_history') score = Math.min(score, 74);
  if (persistenceSource === 'persisted_reconstructed_history') score = Math.min(score, 54);
  if (persistenceQualityLabel === 'insufficient_live_depth') score = Math.min(score, 69);
  if (durabilityState === 'unconfirmed') score = Math.min(score, 69);
  if (liveTenure < 3) score = Math.min(score, 49);
  if (liveCoverage < 35) score = Math.min(score, 54);

  return round2(clamp(score, 0, 100));
}

function classifyReadinessLabel(input = {}) {
  const score = clamp(Number(input.readinessScore || 0), 0, 100);
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoverage = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);

  if (
    score >= 75
    && hasLive
    && liveTenure >= 5
    && liveCoverage >= 50
    && durabilityState !== 'unconfirmed'
    && persistenceSource === 'persisted_live_history'
    && persistenceQualityLabel !== 'insufficient_live_depth'
  ) {
    return 'ready';
  }
  if (hasLive && score >= 55 && liveTenure >= 3) return 'near_ready';
  if (hasLive && (liveTenure > 0 || score >= 30)) return 'early';
  return 'not_ready';
}

function classifyGraduationState(input = {}) {
  const readinessLabel = ALLOWED_READINESS_LABELS.has(toText(input.readinessLabel).toLowerCase())
    ? toText(input.readinessLabel).toLowerCase()
    : 'not_ready';
  const hasLive = input.hasLiveCapturedHistory === true;
  const persistenceSource = normalizePersistenceSource(input.persistenceSource);
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));

  const reconstructedDominant = (
    persistenceSource === 'persisted_reconstructed_history'
    || (persistenceSource === 'mixed_persisted_history' && reconstructedDays > liveCapturedDays)
    || (!hasLive && reconstructedDays > 0)
  );

  if (readinessLabel === 'ready') return 'live_persistence_ready';
  if (readinessLabel === 'near_ready') return 'nearing_live_persistence';
  if (reconstructedDominant) return 'reconstructed_dominant';
  if (hasLive) return 'accumulating_live_depth';
  return 'reconstructed_dominant';
}

function buildBlockers(input = {}) {
  const blockers = new Set();
  const hasLive = input.hasLiveCapturedHistory === true;
  const liveTenure = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoverage = clamp(Number(input.liveCaptureCoveragePct || 0), 0, 100);
  const reconstructedDays = Math.max(0, Number(input.reconstructedDays || 0));
  const liveCapturedDays = Math.max(0, Number(input.liveCapturedDays || 0));
  const durabilityState = normalizeDurabilityState(input.durabilityState);
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel);
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel);
  const durabilityConstraint = normalizeDurabilityConstraint(input.durabilityConstraint);

  if (!hasLive) blockers.add('no_live_history');
  if (liveTenure < 5) blockers.add('insufficient_live_tenure');
  if (liveCoverage < 50) blockers.add('insufficient_live_coverage');
  if (reconstructedDays > liveCapturedDays) blockers.add('reconstructed_history_dominant');
  if (durabilityState === 'unconfirmed') blockers.add('durability_not_confirmed');
  if (cadenceLabel === 'sparse' || cadenceLabel === 'stale') blockers.add('cadence_too_sparse');
  if (persistenceQualityLabel === 'insufficient_live_depth') blockers.add('live_depth_too_thin');
  if (durabilityConstraint === 'mixed_constraints') blockers.add('mixed_constraints');

  return Array.from(blockers).filter((x) => ALLOWED_BLOCKERS.has(x));
}

function buildReadinessInsight(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const readinessLabel = ALLOWED_READINESS_LABELS.has(toText(input.readinessLabel).toLowerCase())
    ? toText(input.readinessLabel).toLowerCase()
    : 'not_ready';
  const graduationState = ALLOWED_GRADUATION_STATES.has(toText(input.graduationState).toLowerCase())
    ? toText(input.graduationState).toLowerCase()
    : 'reconstructed_dominant';
  const score = round2(Number(input.readinessScore || 0));
  const blockers = Array.isArray(input.blockers) ? input.blockers : [];
  const liveTenure = Math.max(0, Number(input.currentRegimeLiveCapturedTenureDays || 0));
  const coverage = round2(clamp(Number(input.currentRegimeLiveCaptureCoveragePct || 0), 0, 100));

  if (readinessLabel === 'ready') {
    return `${regimeLabel} is live persistence ready with sustained live tenure and coverage support.`;
  }
  if (graduationState === 'reconstructed_dominant') {
    return `${regimeLabel} remains reconstruction-dominant (score ${score}); live persistence is not yet operationally credible.`;
  }
  if (readinessLabel === 'near_ready') {
    return `${regimeLabel} is nearing live persistence readiness (score ${score}) but still blocked by ${blockers.slice(0, 2).join(', ') || 'remaining quality constraints'}.`;
  }
  if (readinessLabel === 'early') {
    return `${regimeLabel} is still in early live persistence accumulation (${liveTenure} live day${liveTenure === 1 ? '' : 's'}, ${coverage}% coverage).`;
  }
  return `${regimeLabel} is not ready for live persistence graduation; blockers remain explicit and conservative.`;
}

function buildRowReadiness(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const provenanceBreakdown = input.provenanceBreakdown && typeof input.provenanceBreakdown === 'object'
    ? input.provenanceBreakdown
    : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 };
  const liveCapturedDays = Math.max(0, Number(provenanceBreakdown.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(provenanceBreakdown.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(provenanceBreakdown.mixedDays || 0));
  const hasLiveCapturedHistory = input.hasLiveCapturedHistory === true;
  const liveCapturedTenureDays = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const persistenceSource = derivePersistenceSourceFromRow({
    persistenceSource: input.persistenceSource,
    provenanceBreakdown,
  });
  const liveCaptureCoveragePct = round2(clamp(
    Number(input.liveCaptureCoveragePct != null ? input.liveCaptureCoveragePct : deriveCoveragePctFromBreakdown(provenanceBreakdown)),
    0,
    100
  ));
  const durabilityState = normalizeDurabilityState(input.durabilityState || 'unconfirmed');
  const persistenceQualityLabel = normalizePersistenceQualityLabel(input.persistenceQualityLabel || derivePersistenceQualityLabel({
    persistenceSource,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCapturedDays,
    reconstructedDays,
  }));
  const cadenceLabel = normalizeCadenceLabel(input.cadenceLabel || 'stale');
  const durabilityConstraint = normalizeDurabilityConstraint(input.durabilityConstraint || 'mixed_constraints');
  const readinessScore = computeReadinessScore({
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    persistenceSource,
    persistenceQualityLabel,
    durabilityState,
  });
  const readinessLabel = classifyReadinessLabel({
    readinessScore,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    durabilityState,
    persistenceSource,
    persistenceQualityLabel,
  });
  const graduationState = classifyGraduationState({
    readinessLabel,
    hasLiveCapturedHistory,
    persistenceSource,
    liveCapturedDays,
    reconstructedDays,
  });
  const blockers = buildBlockers({
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    reconstructedDays,
    liveCapturedDays,
    durabilityState,
    cadenceLabel,
    persistenceQualityLabel,
    durabilityConstraint,
  });

  return {
    regimeLabel,
    persistenceSource,
    hasLiveCapturedHistory,
    liveCapturedTenureDays,
    liveCaptureCoveragePct,
    durabilityState,
    persistenceQualityLabel,
    readinessScore,
    readinessLabel,
    graduationState,
    blockers,
    breakdown: {
      liveCapturedDays,
      reconstructedDays,
      mixedDays,
    },
  };
}

function buildRegimePersistenceReadinessSummary(input = {}) {
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
  const regimeLivePersistenceQuality = input.regimeLivePersistenceQuality && typeof input.regimeLivePersistenceQuality === 'object'
    ? input.regimeLivePersistenceQuality
    : {};
  const liveRegimeConfirmation = input.liveRegimeConfirmation && typeof input.liveRegimeConfirmation === 'object'
    ? input.liveRegimeConfirmation
    : {};
  const regimeTrustConsumption = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};

  const currentRegimeLabel = normalizeRegimeLabel(
    regimeLivePersistenceQuality?.currentRegimeLabel
      || regimeConfirmationHistory?.currentRegimeLabel
      || regimeConfirmationDurability?.currentRegimeLabel
      || liveRegimeConfirmation?.currentRegimeLabel
      || regimeTrustConsumption?.currentRegimeLabel
      || 'unknown'
  );

  const historyRows = Array.isArray(regimeConfirmationHistory?.byRegime)
    ? regimeConfirmationHistory.byRegime
    : [];
  const durabilityRows = Array.isArray(regimeConfirmationDurability?.durabilityByRegime)
    ? regimeConfirmationDurability.durabilityByRegime
    : [];

  const perRegime = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const historyRow = findByRegime(historyRows, regimeLabel) || {};
    const durabilityRow = findByRegime(durabilityRows, regimeLabel) || {};
    const provenanceBreakdown = durabilityRow?.provenanceBreakdown && typeof durabilityRow.provenanceBreakdown === 'object'
      ? durabilityRow.provenanceBreakdown
      : (historyRow?.provenanceBreakdown && typeof historyRow.provenanceBreakdown === 'object'
        ? historyRow.provenanceBreakdown
        : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 });
    const row = buildRowReadiness({
      regimeLabel,
      persistenceSource: durabilityRow?.persistenceSource || null,
      hasLiveCapturedHistory: durabilityRow?.hasLiveCapturedHistory === true || historyRow?.hasLiveCapturedHistory === true,
      liveCapturedTenureDays: Number.isFinite(Number(durabilityRow?.liveCapturedTenureDays))
        ? Number(durabilityRow.liveCapturedTenureDays)
        : Number(historyRow?.liveCapturedTenureDays || 0),
      liveCaptureCoveragePct: null,
      durabilityState: durabilityRow?.durabilityState || 'unconfirmed',
      persistenceQualityLabel: null,
      cadenceLabel: 'stale',
      durabilityConstraint: 'mixed_constraints',
      provenanceBreakdown,
    });
    perRegime.push(row);
  }

  const currentHistoryRow = findByRegime(historyRows, currentRegimeLabel) || {};
  const currentDurabilityRow = findByRegime(durabilityRows, currentRegimeLabel) || {};
  const currentBreakdown = currentDurabilityRow?.provenanceBreakdown && typeof currentDurabilityRow.provenanceBreakdown === 'object'
    ? currentDurabilityRow.provenanceBreakdown
    : (currentHistoryRow?.provenanceBreakdown && typeof currentHistoryRow.provenanceBreakdown === 'object'
      ? currentHistoryRow.provenanceBreakdown
      : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 });

  const currentRow = buildRowReadiness({
    regimeLabel: currentRegimeLabel,
    persistenceSource: regimeConfirmationDurability?.persistenceSource || currentDurabilityRow?.persistenceSource || null,
    hasLiveCapturedHistory: (
      regimeConfirmationHistory?.currentRegimeHasLiveCapturedHistory === true
      || regimeConfirmationDurability?.currentRegimeHasLiveCapturedHistory === true
      || currentDurabilityRow?.hasLiveCapturedHistory === true
      || currentHistoryRow?.hasLiveCapturedHistory === true
    ),
    liveCapturedTenureDays: Number.isFinite(Number(regimeConfirmationHistory?.currentRegimeLiveCapturedTenureDays))
      ? Number(regimeConfirmationHistory.currentRegimeLiveCapturedTenureDays)
      : (Number.isFinite(Number(regimeConfirmationDurability?.currentRegimeLiveCapturedTenureDays))
        ? Number(regimeConfirmationDurability.currentRegimeLiveCapturedTenureDays)
        : (Number.isFinite(Number(currentDurabilityRow?.liveCapturedTenureDays))
          ? Number(currentDurabilityRow.liveCapturedTenureDays)
          : Number(currentHistoryRow?.liveCapturedTenureDays || 0))),
    liveCaptureCoveragePct: Number.isFinite(Number(regimeLivePersistenceQuality?.liveCaptureCoveragePct))
      ? Number(regimeLivePersistenceQuality.liveCaptureCoveragePct)
      : deriveCoveragePctFromBreakdown(currentBreakdown),
    durabilityState: regimeConfirmationDurability?.currentRegimeDurabilityState || currentDurabilityRow?.durabilityState || 'unconfirmed',
    persistenceQualityLabel: regimeLivePersistenceQuality?.currentRegimePersistenceQualityLabel || null,
    cadenceLabel: regimeLivePersistenceQuality?.currentRegimeLiveCadenceLabel || 'stale',
    durabilityConstraint: regimeLivePersistenceQuality?.currentRegimeDurabilityConstraint || 'mixed_constraints',
    provenanceBreakdown: currentBreakdown,
  });

  const liveReadyRegimeLabels = [];
  const nearReadyRegimeLabels = [];
  const notReadyRegimeLabels = [];
  for (const row of perRegime) {
    if (row.readinessLabel === 'ready') liveReadyRegimeLabels.push(row.regimeLabel);
    else if (row.readinessLabel === 'near_ready') nearReadyRegimeLabels.push(row.regimeLabel);
    else if (row.readinessLabel === 'not_ready') notReadyRegimeLabels.push(row.regimeLabel);
  }
  if (!liveReadyRegimeLabels.includes(currentRow.regimeLabel) && currentRow.readinessLabel === 'ready') {
    liveReadyRegimeLabels.push(currentRow.regimeLabel);
  }
  if (!nearReadyRegimeLabels.includes(currentRow.regimeLabel) && currentRow.readinessLabel === 'near_ready') {
    nearReadyRegimeLabels.push(currentRow.regimeLabel);
  }
  if (!notReadyRegimeLabels.includes(currentRow.regimeLabel) && currentRow.readinessLabel === 'not_ready') {
    notReadyRegimeLabels.push(currentRow.regimeLabel);
  }

  const readinessInsight = buildReadinessInsight({
    currentRegimeLabel,
    readinessLabel: currentRow.readinessLabel,
    graduationState: currentRow.graduationState,
    readinessScore: currentRow.readinessScore,
    blockers: currentRow.blockers,
    currentRegimeLiveCapturedTenureDays: currentRow.liveCapturedTenureDays,
    currentRegimeLiveCaptureCoveragePct: currentRow.liveCaptureCoveragePct,
  });

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    persistenceSource: currentRow.persistenceSource,
    currentRegimeHasLiveCapturedHistory: currentRow.hasLiveCapturedHistory === true,
    currentRegimeLiveCapturedTenureDays: Number(currentRow.liveCapturedTenureDays || 0),
    currentRegimeLiveCaptureCoveragePct: Number(currentRow.liveCaptureCoveragePct || 0),
    currentRegimeDurabilityState: currentRow.durabilityState,
    currentRegimePersistenceQualityLabel: currentRow.persistenceQualityLabel,
    readinessScore: Number(currentRow.readinessScore || 0),
    readinessLabel: ALLOWED_READINESS_LABELS.has(currentRow.readinessLabel) ? currentRow.readinessLabel : 'not_ready',
    graduationState: ALLOWED_GRADUATION_STATES.has(currentRow.graduationState) ? currentRow.graduationState : 'reconstructed_dominant',
    blockers: currentRow.blockers.filter((b) => ALLOWED_BLOCKERS.has(b)),
    readinessInsight,
    liveReadyRegimeLabels: liveReadyRegimeLabels.filter((label) => SUPPORTED_REGIME_LABELS.includes(label)),
    nearReadyRegimeLabels: nearReadyRegimeLabels.filter((label) => SUPPORTED_REGIME_LABELS.includes(label)),
    notReadyRegimeLabels: notReadyRegimeLabels.filter((label) => SUPPORTED_REGIME_LABELS.includes(label)),
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePersistenceReadinessSummary,
};
