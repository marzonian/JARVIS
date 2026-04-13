'use strict';

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const STATE_PRIORITY = Object.freeze({
  baseline: 1,
  active_candidate: 2,
  context_only_candidate: 3,
  watchlist: 4,
  weakening: 5,
  low_confidence: 6,
  deprioritized: 7,
});

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isThinSample(sampleQuality) {
  const txt = toText(sampleQuality).toLowerCase();
  return txt === 'very_thin' || txt === 'thin';
}

function makeDemotionRisk(row = {}) {
  const status = toText(row.trackingStatus).toLowerCase();
  const sampleQuality = toText(row?.primaryMetrics?.sampleQuality).toLowerCase();
  if (status === 'weakening_candidate') return 'high';
  if (sampleQuality === 'very_thin') return 'high';
  if (sampleQuality === 'thin') return 'medium';
  if (toText(row.momentumOfPerformance).toLowerCase() === 'volatile') return 'medium';
  if (toNumber(row.stabilityScore, 0) < 45) return 'medium';
  return 'low';
}

function findDiscoveryCandidate(discovery = {}, strategyKey = '') {
  if (!discovery || typeof discovery !== 'object') return null;
  const rows = Array.isArray(discovery.candidates) ? discovery.candidates : [];
  return rows.find((row) => toText(row?.strategyKey || row?.key) === strategyKey) || null;
}

function deriveStateFromTracking(row = {}, discoveryCandidate = null) {
  if (row.strategyType === 'original_plan') {
    return {
      portfolioState: 'baseline',
      governanceReason: 'Original plan remains the explicit baseline reference.',
      promotionEligible: false,
    };
  }

  if (toText(row.availability).toLowerCase() !== 'available') {
    return {
      portfolioState: 'deprioritized',
      governanceReason: toText(row.unavailableReason || 'Strategy lane unavailable for current dataset.'),
      promotionEligible: false,
    };
  }

  const trackingStatus = toText(row.trackingStatus).toLowerCase();
  const sampleQuality = toText(row?.primaryMetrics?.sampleQuality).toLowerCase();
  const relPf = toNumber(row?.vsOriginal?.relativeProfitFactor, 0);
  const relWr = toNumber(row?.vsOriginal?.relativeWinRate, 0);
  const stability = toNumber(row.stabilityScore, 0);
  const momentum = toText(row.momentumOfPerformance).toLowerCase();
  const discoveryRobustness = toText(discoveryCandidate?.robustnessLabel).toLowerCase();

  if (trackingStatus === 'low_confidence' || sampleQuality === 'very_thin') {
    return {
      portfolioState: 'low_confidence',
      governanceReason: `Sample quality is ${sampleQuality || 'very thin'}; promotion is blocked.`,
      promotionEligible: false,
    };
  }

  if (trackingStatus === 'weakening_candidate' || (momentum === 'weakening' && relPf < 0)) {
    if (relPf < 0 && relWr < 0) {
      return {
        portfolioState: 'deprioritized',
        governanceReason: 'Candidate is weakening with negative PF and win-rate deltas vs baseline.',
        promotionEligible: false,
      };
    }
    return {
      portfolioState: 'weakening',
      governanceReason: 'Candidate momentum is weakening and needs close monitoring before use.',
      promotionEligible: false,
    };
  }

  if (trackingStatus === 'strong_alternative' && relPf > 0 && stability >= 60 && discoveryRobustness !== 'low_confidence') {
    return {
      portfolioState: 'active_candidate',
      governanceReason: 'Candidate shows strong side-by-side evidence versus baseline with acceptable stability.',
      promotionEligible: true,
    };
  }

  if (trackingStatus === 'context_specific_alternative' || toText(row.contextDominanceLabel).toLowerCase() === 'context_specific_dominant') {
    return {
      portfolioState: 'context_only_candidate',
      governanceReason: 'Candidate edge appears context-specific and should not override global baseline.',
      promotionEligible: false,
    };
  }

  if (trackingStatus === 'monitor_closely') {
    return {
      portfolioState: 'watchlist',
      governanceReason: 'Candidate is interesting but not yet strong enough for active priority.',
      promotionEligible: false,
    };
  }

  return {
    portfolioState: 'watchlist',
    governanceReason: 'Candidate remains advisory on watchlist pending stronger evidence.',
    promotionEligible: false,
  };
}

function buildGovernanceInsight(summary = {}) {
  const baseline = summary?.baselineStrategy;
  const candidate = summary?.highestPriorityCandidate;
  if (!baseline) return 'No baseline strategy is currently available; portfolio governance is in degraded mode.';
  if (!candidate) return 'Original plan remains baseline. No candidate has enough evidence to influence today.';
  const state = toText(candidate.portfolioState).replace(/_/g, ' ');
  if (candidate.portfolioState === 'active_candidate') {
    return `Original plan remains baseline. ${candidate.strategyName} is an active candidate for side-by-side tracking.`;
  }
  if (candidate.portfolioState === 'context_only_candidate') {
    return `Original plan remains baseline. ${candidate.strategyName} is context-only and should not override baseline.`;
  }
  if (candidate.portfolioState === 'weakening' || candidate.portfolioState === 'deprioritized') {
    return `Original plan remains baseline. ${candidate.strategyName} is ${state} and has been deprioritized.`;
  }
  if (candidate.portfolioState === 'low_confidence') {
    return `Original plan remains baseline. ${candidate.strategyName} is low-confidence due to thin evidence.`;
  }
  return `Original plan remains baseline. ${candidate.strategyName} is on watchlist only (${state}).`;
}

function buildGovernanceSummary(strategies = []) {
  const counts = {
    baseline: 0,
    active_candidate: 0,
    context_only_candidate: 0,
    watchlist: 0,
    weakening: 0,
    low_confidence: 0,
    deprioritized: 0,
  };
  for (const row of strategies) {
    const state = toText(row.portfolioState);
    if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
  }
  return {
    counts,
    priorityOrder: [
      'baseline',
      'active_candidate',
      'context_only_candidate',
      'watchlist',
      'weakening',
      'low_confidence',
      'deprioritized',
    ],
    recommendationGuardrail: 'Portfolio governance is advisory-only and never auto-switches execution.',
  };
}

function buildStrategyPortfolioSummary(input = {}) {
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const includeContext = input.includeContext !== false;
  const strategyTracking = input.strategyTracking && typeof input.strategyTracking === 'object'
    ? input.strategyTracking
    : {};
  const strategyDiscovery = input.strategyDiscovery && typeof input.strategyDiscovery === 'object'
    ? input.strategyDiscovery
    : {};
  const strategyLayers = input.strategyLayers && typeof input.strategyLayers === 'object'
    ? input.strategyLayers
    : {};
  const tracked = Array.isArray(strategyTracking.trackedStrategies) ? strategyTracking.trackedStrategies : [];

  const strategies = tracked.map((row) => {
    const strategyKey = toText(row?.strategyKey);
    const discoveryCandidate = findDiscoveryCandidate(strategyDiscovery, strategyKey);
    const derived = deriveStateFromTracking(row, discoveryCandidate);
    const portfolioState = derived.portfolioState;
    const portfolioPriority = STATE_PRIORITY[portfolioState] || 99;
    const demotionRisk = makeDemotionRisk(row);
    return {
      strategyKey,
      strategyName: toText(row?.strategyName || strategyKey),
      strategyType: toText(row?.strategyType || 'unknown'),
      sourceLayer: toText(row?.sourceLayer || 'unknown'),
      trackingStatus: toText(row?.trackingStatus || ''),
      portfolioState,
      portfolioPriority,
      governanceReason: derived.governanceReason,
      promotionEligible: derived.promotionEligible === true,
      demotionRisk,
      sampleQuality: toText(row?.primaryMetrics?.sampleQuality || ''),
      stabilityScore: round2(toNumber(row?.stabilityScore, 0)),
      momentumOfPerformance: toText(row?.momentumOfPerformance || ''),
      relativeProfitFactorVsOriginal: round2(toNumber(row?.vsOriginal?.relativeProfitFactor, 0)),
      relativeWinRateVsOriginal: round2(toNumber(row?.vsOriginal?.relativeWinRate, 0)),
      advisoryOnly: true,
    };
  }).sort((a, b) => {
    if (a.portfolioPriority !== b.portfolioPriority) return a.portfolioPriority - b.portfolioPriority;
    return toText(a.strategyName).localeCompare(toText(b.strategyName));
  });

  const baselineStrategy = strategies.find((row) => row.portfolioState === 'baseline') || null;
  const highestPriorityCandidate = strategies.find((row) => row.portfolioState !== 'baseline') || null;
  const dataWarnings = [];
  if (!strategies.length) dataWarnings.push('no_tracked_strategies');
  if (!baselineStrategy) dataWarnings.push('baseline_missing');
  if (strategies.some((row) => isThinSample(row.sampleQuality))) dataWarnings.push('thin_sample_present');
  if (strategies.some((row) => row.portfolioState === 'deprioritized')) dataWarnings.push('deprioritized_candidate_present');

  const governanceSummary = {
    ...buildGovernanceSummary(strategies),
    strategyCount: strategies.length,
    baselineKey: baselineStrategy?.strategyKey || null,
    recommendationBasis: toText(strategyLayers?.recommendationBasis?.basisType || 'baseline') || 'baseline',
    dataWarnings,
    includeContext,
    windowSessions,
  };

  return {
    generatedAt: new Date().toISOString(),
    advisoryOnly: true,
    windowSessions,
    includeContext,
    baselineStrategy,
    highestPriorityCandidate,
    governanceSummary,
    portfolioInsight: buildGovernanceInsight({
      baselineStrategy,
      highestPriorityCandidate,
    }),
    strategies,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  STATE_PRIORITY,
  buildStrategyPortfolioSummary,
};
