'use strict';

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const EXPERIMENT_STATE_PRIORITY = Object.freeze({
  shadow_stable: 1,
  shadow_promising: 2,
  shadow_trial: 3,
  new_candidate: 4,
  shadow_weakening: 5,
  retired_candidate: 6,
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

function normalizeEvidenceQuality(value = '') {
  const txt = toText(value).toLowerCase();
  if (txt === 'very_thin' || txt === 'thin' || txt === 'moderate' || txt === 'robust') return txt;
  return 'unknown';
}

function findPortfolioRow(rows = [], key = '') {
  if (!Array.isArray(rows)) return null;
  const k = toText(key);
  if (!k) return null;
  return rows.find((row) => toText(row?.strategyKey) === k) || null;
}

function findDiscoveryCandidate(discovery = {}, key = '') {
  const rows = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
  const k = toText(key);
  if (!k) return null;
  return rows.find((row) => toText(row?.strategyKey || row?.key) === k) || null;
}

function deriveShadowSessionsTracked(trackedRow = {}, fallbackWindow = DEFAULT_WINDOW_SESSIONS) {
  const rolling = Array.isArray(trackedRow?.rollingWindowSummary)
    ? trackedRow.rollingWindowSummary
    : [];
  const maxWindow = rolling.reduce((acc, row) => {
    const w = toNumber(row?.windowSessions, 0);
    return w > acc ? w : acc;
  }, 0);
  if (maxWindow > 0) return maxWindow;
  const primaryWindow = toNumber(trackedRow?.primaryWindow, 0);
  if (primaryWindow > 0) return primaryWindow;
  return fallbackWindow;
}

function deriveState(input = {}) {
  const availability = toText(input.availability).toLowerCase();
  const sampleQuality = normalizeEvidenceQuality(input.sampleQuality);
  const trackingStatus = toText(input.trackingStatus).toLowerCase();
  const portfolioState = toText(input.portfolioState).toLowerCase();
  const momentum = toText(input.momentum).toLowerCase();
  const demotionRisk = toText(input.demotionRisk).toLowerCase();
  const relPf = toNumber(input.relPf, 0);
  const relWr = toNumber(input.relWr, 0);
  const stability = toNumber(input.stability, 0);
  const shadowSessionsTracked = toNumber(input.shadowSessionsTracked, 0);
  const discoveryRobustness = toText(input.discoveryRobustness).toLowerCase();

  if (availability !== 'available') {
    return {
      experimentState: 'retired_candidate',
      promotionReadiness: 'none',
      retirementRisk: 'high',
      experimentReason: 'Candidate lane is unavailable, so experiment remains retired.',
    };
  }

  if (trackingStatus === 'weakening_candidate' || portfolioState === 'deprioritized') {
    if (shadowSessionsTracked >= 60 && relPf < -0.1 && relWr < -2) {
      return {
        experimentState: 'retired_candidate',
        promotionReadiness: 'none',
        retirementRisk: 'high',
        experimentReason: 'Candidate sustained weakening behavior and moved to retirement.',
      };
    }
    return {
      experimentState: 'shadow_weakening',
      promotionReadiness: 'none',
      retirementRisk: demotionRisk === 'high' ? 'high' : 'medium',
      experimentReason: 'Candidate trend has weakened and requires caution before any promotion.',
    };
  }

  if (sampleQuality === 'very_thin' || shadowSessionsTracked < 20) {
    return {
      experimentState: 'new_candidate',
      promotionReadiness: 'low',
      retirementRisk: 'medium',
      experimentReason: 'Candidate is new with very limited shadow evidence.',
    };
  }

  if (sampleQuality === 'thin' || trackingStatus === 'low_confidence') {
    return {
      experimentState: 'shadow_trial',
      promotionReadiness: 'low',
      retirementRisk: 'medium',
      experimentReason: 'Candidate is still in trial because evidence quality is limited.',
    };
  }

  if (
    (portfolioState === 'active_candidate' || trackingStatus === 'strong_alternative')
    && stability >= 70
    && momentum !== 'weakening'
    && relPf > 0
    && sampleQuality === 'robust'
    && discoveryRobustness !== 'low_confidence'
  ) {
    return {
      experimentState: 'shadow_stable',
      promotionReadiness: relPf >= 0.1 ? 'high' : 'medium',
      retirementRisk: 'low',
      experimentReason: 'Candidate shows sustained shadow stability and remains advisory for side-by-side tracking.',
    };
  }

  if (portfolioState === 'context_only_candidate') {
    return {
      experimentState: 'shadow_promising',
      promotionReadiness: 'medium',
      retirementRisk: 'medium',
      experimentReason: 'Candidate is promising in specific contexts but not globally dominant.',
    };
  }

  if (portfolioState === 'watchlist' || relPf > 0 || relWr > 0) {
    return {
      experimentState: 'shadow_promising',
      promotionReadiness: 'medium',
      retirementRisk: demotionRisk === 'high' ? 'high' : 'medium',
      experimentReason: 'Candidate remains promising and needs additional shadow duration.',
    };
  }

  return {
    experimentState: 'shadow_trial',
    promotionReadiness: 'low',
    retirementRisk: 'medium',
    experimentReason: 'Candidate remains under shadow trial pending stronger evidence.',
  };
}

function stateSortRank(value = '') {
  return EXPERIMENT_STATE_PRIORITY[toText(value)] || 99;
}

function buildExperimentInsight(summary = {}) {
  const top = summary?.highestPriorityExperiment;
  if (!top) return 'No strategy experiment is ready to challenge baseline guidance yet.';
  if (top.experimentState === 'shadow_stable') {
    return `${top.strategyName} is shadow-stable but remains advisory and does not override baseline execution.`;
  }
  if (top.experimentState === 'shadow_promising') {
    return `${top.strategyName} looks promising in shadow tracking but needs more evidence before stronger promotion.`;
  }
  if (top.experimentState === 'shadow_trial' || top.experimentState === 'new_candidate') {
    return `Top candidate remains in ${top.experimentState.replace(/_/g, ' ')} and is not ready to challenge baseline.`;
  }
  if (top.experimentState === 'shadow_weakening') {
    return `Previously promising candidate is weakening and may be retired if degradation persists.`;
  }
  return `Top candidate is currently retired from active shadow consideration.`;
}

function buildSummaryCounts(rows = []) {
  const counts = {
    new_candidate: 0,
    shadow_trial: 0,
    shadow_promising: 0,
    shadow_stable: 0,
    shadow_weakening: 0,
    retired_candidate: 0,
  };
  for (const row of rows) {
    const key = toText(row.experimentState);
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
  }
  return counts;
}

function buildStrategyExperimentsSummary(input = {}) {
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const includeContext = input.includeContext !== false;
  const strategyTracking = input.strategyTracking && typeof input.strategyTracking === 'object'
    ? input.strategyTracking
    : {};
  const strategyPortfolio = input.strategyPortfolio && typeof input.strategyPortfolio === 'object'
    ? input.strategyPortfolio
    : {};
  const strategyDiscovery = input.strategyDiscovery && typeof input.strategyDiscovery === 'object'
    ? input.strategyDiscovery
    : {};

  const trackedRows = Array.isArray(strategyTracking?.trackedStrategies)
    ? strategyTracking.trackedStrategies
    : [];
  const portfolioRows = Array.isArray(strategyPortfolio?.strategies)
    ? strategyPortfolio.strategies
    : [];

  const candidates = trackedRows
    .filter((row) => toText(row?.strategyType).toLowerCase() !== 'original_plan')
    .map((row) => {
      const strategyKey = toText(row?.strategyKey);
      const portfolioRow = findPortfolioRow(portfolioRows, strategyKey);
      const discoveryCandidate = findDiscoveryCandidate(strategyDiscovery, strategyKey);
      const shadowSessionsTracked = deriveShadowSessionsTracked(row, windowSessions);
      const sampleQuality = normalizeEvidenceQuality(row?.primaryMetrics?.sampleQuality);
      const derived = deriveState({
        availability: row?.availability,
        sampleQuality,
        trackingStatus: row?.trackingStatus,
        portfolioState: portfolioRow?.portfolioState,
        momentum: row?.momentumOfPerformance,
        demotionRisk: portfolioRow?.demotionRisk,
        relPf: row?.vsOriginal?.relativeProfitFactor,
        relWr: row?.vsOriginal?.relativeWinRate,
        stability: row?.stabilityScore,
        shadowSessionsTracked,
        discoveryRobustness: discoveryCandidate?.robustnessLabel,
      });
      return {
        strategyKey,
        strategyName: toText(row?.strategyName || strategyKey),
        strategyType: toText(row?.strategyType || 'unknown'),
        experimentState: derived.experimentState,
        shadowSessionsTracked,
        shadowEvidenceQuality: sampleQuality,
        promotionReadiness: derived.promotionReadiness,
        retirementRisk: derived.retirementRisk,
        experimentReason: derived.experimentReason,
        advisoryOnly: true,
      };
    })
    .sort((a, b) => {
      const stateDelta = stateSortRank(a.experimentState) - stateSortRank(b.experimentState);
      if (stateDelta !== 0) return stateDelta;
      const sessionDelta = toNumber(b.shadowSessionsTracked, 0) - toNumber(a.shadowSessionsTracked, 0);
      if (sessionDelta !== 0) return sessionDelta;
      return toText(a.strategyName).localeCompare(toText(b.strategyName));
    });

  const highestPriorityExperiment = candidates.length > 0 ? candidates[0] : null;
  const counts = buildSummaryCounts(candidates);
  const warnings = [];
  if (!candidates.length) warnings.push('no_shadow_candidates');
  if (candidates.some((row) => row.shadowEvidenceQuality === 'very_thin' || row.shadowEvidenceQuality === 'thin')) {
    warnings.push('thin_shadow_evidence_present');
  }
  if (candidates.some((row) => row.experimentState === 'shadow_weakening' || row.experimentState === 'retired_candidate')) {
    warnings.push('weakening_or_retired_candidate_present');
  }

  const experimentSummary = {
    counts,
    totalCandidates: candidates.length,
    highestState: highestPriorityExperiment?.experimentState || null,
    statePriorityOrder: [
      'shadow_stable',
      'shadow_promising',
      'shadow_trial',
      'new_candidate',
      'shadow_weakening',
      'retired_candidate',
    ],
    includeContext,
    windowSessions,
    warnings,
    guardrail: 'Shadow experiments are advisory-only and never mutate execution.',
  };

  return {
    generatedAt: new Date().toISOString(),
    advisoryOnly: true,
    candidates,
    highestPriorityExperiment,
    experimentSummary,
    experimentInsight: buildExperimentInsight({ highestPriorityExperiment }),
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  EXPERIMENT_STATE_PRIORITY,
  buildStrategyExperimentsSummary,
};
