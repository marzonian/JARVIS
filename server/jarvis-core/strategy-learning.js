'use strict';

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const PRIORITY_RANK = Object.freeze({
  increase_attention: 1,
  maintain_attention: 2,
  reduce_attention: 3,
  retire_research_focus: 4,
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

function isThinSample(sampleQuality = '') {
  const txt = toText(sampleQuality).toLowerCase();
  return txt === 'very_thin' || txt === 'thin' || txt === 'unknown';
}

function normalizeEvidenceStrength(summary = {}, options = {}) {
  const src = summary?.sourceBreakdown && typeof summary.sourceBreakdown === 'object'
    ? summary.sourceBreakdown
    : { live: 0, backfill: 0, total: 0 };
  const rowCountUsed = toNumber(summary?.rowCountUsed, toNumber(src.total, 0));
  const sample30 = toNumber(summary?.sampleSize30d, 0);
  const sample90 = toNumber(summary?.sampleSize90d, 0);
  const liveCount = toNumber(src.live, 0);
  const backfillCount = toNumber(src.backfill, 0);
  const warnings = [];

  if (rowCountUsed < 10 || sample30 < 8) warnings.push('thin_recommendation_history');
  if (liveCount === 0 && backfillCount > 0) warnings.push('retrospective_only_evidence');
  if (liveCount > 0 && backfillCount > 0) warnings.push('mixed_live_and_backfill_evidence');
  if (backfillCount > liveCount * 2 && backfillCount > 0) warnings.push('backfill_dominant_evidence');

  let level = 'weak';
  if (rowCountUsed >= 90 && liveCount >= 30) level = 'strong';
  else if (rowCountUsed >= 40) level = 'moderate';

  return {
    level,
    performanceSource: toText(options.performanceSource || 'all').toLowerCase() || 'all',
    rowCountUsed,
    sampleSize30d: sample30,
    sampleSize90d: sample90,
    liveCount,
    backfillCount,
    warnings,
  };
}

function buildTrackingLookup(strategyTracking = {}, strategyPortfolio = {}, strategyExperiments = {}, strategyDiscovery = {}) {
  const tracked = Array.isArray(strategyTracking?.trackedStrategies) ? strategyTracking.trackedStrategies : [];
  const portfolioRows = Array.isArray(strategyPortfolio?.strategies) ? strategyPortfolio.strategies : [];
  const experimentRows = Array.isArray(strategyExperiments?.candidates) ? strategyExperiments.candidates : [];
  const discoveryRows = Array.isArray(strategyDiscovery?.candidates) ? strategyDiscovery.candidates : [];

  const portfolioByKey = new Map(portfolioRows.map((row) => [toText(row?.strategyKey), row]));
  const experimentsByKey = new Map(experimentRows.map((row) => [toText(row?.strategyKey), row]));
  const discoveryByKey = new Map(discoveryRows.map((row) => [toText(row?.strategyKey || row?.key), row]));

  return tracked
    .map((row) => {
      const strategyKey = toText(row?.strategyKey);
      const portfolio = portfolioByKey.get(strategyKey) || null;
      const experiment = experimentsByKey.get(strategyKey) || null;
      const discovery = discoveryByKey.get(strategyKey) || null;
      return {
        strategyKey,
        strategyName: toText(row?.strategyName || strategyKey),
        strategyType: toText(row?.strategyType || 'unknown').toLowerCase(),
        sourceLayer: toText(row?.sourceLayer || 'unknown').toLowerCase(),
        availability: toText(row?.availability || 'available').toLowerCase(),
        trackingStatus: toText(row?.trackingStatus || '').toLowerCase(),
        momentumOfPerformance: toText(row?.momentumOfPerformance || '').toLowerCase(),
        sampleQuality: toText(row?.primaryMetrics?.sampleQuality || '').toLowerCase(),
        stabilityScore: round2(toNumber(row?.stabilityScore, 0)),
        relPf: round2(toNumber(row?.vsOriginal?.relativeProfitFactor, 0)),
        relWr: round2(toNumber(row?.vsOriginal?.relativeWinRate, 0)),
        relTradeFreq: round2(toNumber(row?.vsOriginal?.relativeTradeFrequency, 0)),
        tradeCount: toNumber(row?.primaryMetrics?.tradeCount, 0),
        portfolioState: toText(portfolio?.portfolioState || '').toLowerCase(),
        demotionRisk: toText(portfolio?.demotionRisk || '').toLowerCase(),
        experimentState: toText(experiment?.experimentState || '').toLowerCase(),
        promotionReadiness: toText(experiment?.promotionReadiness || '').toLowerCase(),
        discoveryRobustness: toText(discovery?.robustnessLabel || '').toLowerCase(),
      };
    })
    .filter((row) => row.strategyKey);
}

function buildImprovingStrategies(rows = [], evidenceStrength = {}) {
  const improving = [];
  for (const row of rows) {
    if (row.strategyType === 'original_plan') continue;
    if (row.availability !== 'available') continue;
    if (isThinSample(row.sampleQuality)) continue;

    const improvingSignal = (
      row.momentumOfPerformance === 'improving'
      || row.trackingStatus === 'strong_alternative'
      || (row.relPf >= 0.08 && row.relWr >= 0)
      || (row.relPf > 0.04 && row.stabilityScore >= 60 && row.trackingStatus === 'context_specific_alternative')
    );
    const weakeningSignal = (
      row.trackingStatus === 'weakening_candidate'
      || row.momentumOfPerformance === 'weakening'
      || row.relPf <= -0.06
      || row.portfolioState === 'deprioritized'
    );
    if (!improvingSignal || weakeningSignal) continue;

    const reason = row.trackingStatus === 'strong_alternative'
      ? `${row.strategyName} is tracking as a strong alternative with positive edge vs baseline.`
      : row.trackingStatus === 'context_specific_alternative'
        ? `${row.strategyName} remains context-strong with positive relative PF.`
        : `${row.strategyName} shows improving relative PF (${round2(row.relPf)}) and stability (${round2(row.stabilityScore)}).`;

    improving.push({
      strategyKey: row.strategyKey,
      strategyName: row.strategyName,
      strategyType: row.strategyType,
      sourceLayer: row.sourceLayer,
      learningSignal: 'improving',
      confidence: evidenceStrength.level,
      evidenceQuality: row.sampleQuality,
      reason,
      relativeProfitFactor: round2(row.relPf),
      relativeWinRate: round2(row.relWr),
      stabilityScore: round2(row.stabilityScore),
      advisoryOnly: true,
    });
  }

  return improving
    .sort((a, b) => {
      const pf = toNumber(b.relativeProfitFactor, 0) - toNumber(a.relativeProfitFactor, 0);
      if (pf !== 0) return pf;
      return toNumber(b.stabilityScore, 0) - toNumber(a.stabilityScore, 0);
    })
    .slice(0, 4);
}

function buildWeakeningStrategies(rows = [], evidenceStrength = {}) {
  const weakening = [];
  for (const row of rows) {
    if (row.strategyType === 'original_plan') continue;
    if (row.availability !== 'available') continue;

    const weakeningSignal = (
      row.trackingStatus === 'weakening_candidate'
      || row.momentumOfPerformance === 'weakening'
      || row.portfolioState === 'deprioritized'
      || (row.relPf <= -0.08 && row.relWr <= -1)
      || row.experimentState === 'shadow_weakening'
      || row.experimentState === 'retired_candidate'
    );
    if (!weakeningSignal) continue;

    const reason = row.portfolioState === 'deprioritized'
      ? `${row.strategyName} is deprioritized due to persistent relative underperformance.`
      : row.experimentState === 'retired_candidate'
        ? `${row.strategyName} moved to retired candidate status from repeated weak shadow evidence.`
        : `${row.strategyName} is weakening with relative PF ${round2(row.relPf)} and momentum ${row.momentumOfPerformance || 'weak'}.`;

    weakening.push({
      strategyKey: row.strategyKey,
      strategyName: row.strategyName,
      strategyType: row.strategyType,
      sourceLayer: row.sourceLayer,
      learningSignal: 'weakening',
      confidence: evidenceStrength.level,
      evidenceQuality: row.sampleQuality || 'unknown',
      reason,
      relativeProfitFactor: round2(row.relPf),
      relativeWinRate: round2(row.relWr),
      stabilityScore: round2(row.stabilityScore),
      advisoryOnly: true,
    });
  }

  return weakening
    .sort((a, b) => {
      const pf = toNumber(a.relativeProfitFactor, 0) - toNumber(b.relativeProfitFactor, 0);
      if (pf !== 0) return pf;
      return toNumber(a.stabilityScore, 0) - toNumber(b.stabilityScore, 0);
    })
    .slice(0, 4);
}

function classifyResearchPriority(row = {}, evidenceStrength = {}) {
  const thin = isThinSample(row.sampleQuality);
  if (row.availability !== 'available') {
    return {
      researchPriority: 'retire_research_focus',
      researchReason: 'Strategy lane is unavailable; retire from active research queue.',
      candidateAttentionLevel: 'minimal',
    };
  }

  if (row.portfolioState === 'deprioritized' || row.experimentState === 'retired_candidate') {
    return {
      researchPriority: 'retire_research_focus',
      researchReason: 'Repeated weak evidence suggests retiring this candidate from active research focus.',
      candidateAttentionLevel: 'minimal',
    };
  }

  if (row.trackingStatus === 'weakening_candidate' || row.experimentState === 'shadow_weakening' || row.relPf <= -0.08) {
    return {
      researchPriority: 'reduce_attention',
      researchReason: 'Recent weakening trend suggests reducing analytical focus until stability recovers.',
      candidateAttentionLevel: 'low',
    };
  }

  if (!thin && row.portfolioState === 'active_candidate' && row.relPf > 0 && row.stabilityScore >= 60) {
    return {
      researchPriority: 'increase_attention',
      researchReason: 'Strong side-by-side signal and stability justify increased research attention.',
      candidateAttentionLevel: 'high',
    };
  }

  if (!thin && row.portfolioState === 'context_only_candidate') {
    return {
      researchPriority: 'maintain_attention',
      researchReason: 'Context-specific edge remains useful; continue targeted monitoring without global promotion.',
      candidateAttentionLevel: 'medium',
    };
  }

  if (thin || row.trackingStatus === 'low_confidence') {
    return {
      researchPriority: 'reduce_attention',
      researchReason: 'Thin sample confidence limits value of further near-term optimization.',
      candidateAttentionLevel: 'low',
    };
  }

  if (evidenceStrength.level === 'weak') {
    return {
      researchPriority: 'maintain_attention',
      researchReason: 'Evidence history is still weak; maintain watch without aggressive reprioritization.',
      candidateAttentionLevel: 'medium',
    };
  }

  return {
    researchPriority: 'maintain_attention',
    researchReason: 'Candidate remains in monitor mode with mixed but non-degrading evidence.',
    candidateAttentionLevel: 'medium',
  };
}

function buildResearchPriorityList(rows = [], evidenceStrength = {}) {
  return rows
    .filter((row) => row.strategyType !== 'original_plan')
    .map((row) => {
      const decision = classifyResearchPriority(row, evidenceStrength);
      return {
        strategyKey: row.strategyKey,
        strategyName: row.strategyName,
        strategyType: row.strategyType,
        sourceLayer: row.sourceLayer,
        researchPriority: decision.researchPriority,
        researchReason: decision.researchReason,
        evidenceQuality: row.sampleQuality || 'unknown',
        candidateAttentionLevel: decision.candidateAttentionLevel,
        stabilityScore: row.stabilityScore,
        relativeProfitFactor: row.relPf,
        relativeWinRate: row.relWr,
        advisoryOnly: true,
      };
    })
    .sort((a, b) => {
      const p = (PRIORITY_RANK[a.researchPriority] || 99) - (PRIORITY_RANK[b.researchPriority] || 99);
      if (p !== 0) return p;
      const pf = Math.abs(toNumber(b.relativeProfitFactor, 0)) - Math.abs(toNumber(a.relativeProfitFactor, 0));
      if (pf !== 0) return pf;
      return toNumber(b.stabilityScore, 0) - toNumber(a.stabilityScore, 0);
    })
    .slice(0, 8);
}

function buildMechanicsLearningInsights(mechanicsSummary = {}) {
  const out = [];
  if (!mechanicsSummary || typeof mechanicsSummary !== 'object') {
    out.push({
      insight: 'Mechanics learning is unavailable because mechanics research summary is missing.',
      evidenceQuality: 'unknown',
      advisoryOnly: true,
    });
    return out;
  }

  const rec = toText(mechanicsSummary.recommendedTpMode || '');
  const wr = toText(mechanicsSummary.bestTpModeByWinRate || '');
  const pf = toText(mechanicsSummary.bestTpModeByProfitFactor || '');
  const windowSize = toNumber(mechanicsSummary.windowSize, 0);
  const contextual = mechanicsSummary.contextualRecommendation && typeof mechanicsSummary.contextualRecommendation === 'object'
    ? mechanicsSummary.contextualRecommendation
    : null;

  if (rec) {
    out.push({
      insight: `${rec} remains the practical TP recommendation over ${windowSize || 'recent'} eligible trades.`,
      evidenceQuality: mechanicsSummary?.dataQuality?.isThinSample === true ? 'thin' : 'moderate',
      advisoryOnly: true,
    });
  }

  if (wr && pf && wr !== pf) {
    out.push({
      insight: `${wr} leads win rate while ${pf} leads profit factor; TP choice remains context-sensitive.`,
      evidenceQuality: 'moderate',
      advisoryOnly: true,
    });
  }

  if (contextual && toText(contextual.contextualRecommendedTpMode)) {
    const conf = toText(contextual.confidenceLabel || 'low').toLowerCase() || 'low';
    const sample = toNumber(contextual.sampleSize, 0);
    const fallback = toText(contextual.fallbackLevel || 'exact_context').replace(/_/g, ' ');
    out.push({
      insight: `Contextual TP recommendation is ${contextual.contextualRecommendedTpMode} (confidence ${conf}, sample ${sample}, fallback ${fallback}).`,
      evidenceQuality: conf,
      advisoryOnly: true,
    });
  }

  if (out.length === 0) {
    out.push({
      insight: 'Mechanics learning is active, but evidence is too thin for a directional TP insight.',
      evidenceQuality: 'thin',
      advisoryOnly: true,
    });
  }

  return out.slice(0, 4);
}

function buildRecommendationLearningInsights(summary = {}, evidenceStrength = {}) {
  const out = [];
  const posture30 = toNumber(summary?.postureAccuracy30d, null);
  const strategy30 = toNumber(summary?.strategyAccuracy30d, null);
  const tp30 = toNumber(summary?.tpAccuracy30d, null);
  const delta = toNumber(summary?.avgRecommendationDelta, null);

  if (Number.isFinite(posture30)) {
    const stance = posture30 >= 60
      ? 'Posture guidance has been constructive recently.'
      : posture30 >= 48
        ? 'Posture guidance is mixed and should stay selective.'
        : 'Posture guidance has underperformed and needs caution.';
    out.push({
      insight: `${stance} 30-session posture accuracy is ${round2(posture30)}%.`,
      evidenceQuality: evidenceStrength.level,
      advisoryOnly: true,
    });
  }

  if (Number.isFinite(strategy30)) {
    out.push({
      insight: `Strategy recommendation accuracy is ${round2(strategy30)}% over the last scored window.`,
      evidenceQuality: evidenceStrength.level,
      advisoryOnly: true,
    });
  }

  if (Number.isFinite(tp30)) {
    const tpLine = tp30 >= 55
      ? 'TP recommendation alignment is improving.'
      : 'TP recommendation alignment remains inconsistent.';
    out.push({
      insight: `${tpLine} TP accuracy is ${round2(tp30)}%.`,
      evidenceQuality: evidenceStrength.level,
      advisoryOnly: true,
    });
  }

  if (Number.isFinite(delta)) {
    const deltaLine = delta >= 0
      ? `Average recommendation delta is +${round2(delta)} (favorable).`
      : `Average recommendation delta is ${round2(delta)} (negative).`;
    out.push({
      insight: deltaLine,
      evidenceQuality: evidenceStrength.level,
      advisoryOnly: true,
    });
  }

  if (!out.length) {
    out.push({
      insight: 'Recommendation learning is active, but scored history is still too thin for directional conclusions.',
      evidenceQuality: 'thin',
      advisoryOnly: true,
    });
  }

  return out.slice(0, 4);
}

function buildLearningInsight(summary = {}) {
  const improving = Array.isArray(summary.improvingStrategies) ? summary.improvingStrategies : [];
  const weakening = Array.isArray(summary.weakeningStrategies) ? summary.weakeningStrategies : [];
  const evidence = summary.evidenceStrength || {};

  if (!improving.length && !weakening.length) {
    return 'Learning loop is active, but current evidence is too thin for strong directional strategy learning conclusions.';
  }
  if (improving.length && !weakening.length) {
    return `${improving[0].strategyName} is currently the strongest improving research signal.`;
  }
  if (!improving.length && weakening.length) {
    return `${weakening[0].strategyName} is weakening; Jarvis currently favors baseline discipline over candidate expansion.`;
  }
  const conf = toText(evidence.level || 'weak');
  return `${improving[0].strategyName} is improving while ${weakening[0].strategyName} is weakening; learning confidence is ${conf}.`;
}

function buildStrategyLearningSummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const includeContext = input.includeContext !== false;
  const performanceSource = toText(input.performanceSource || 'all').toLowerCase() || 'all';

  const recommendationPerformance = input.recommendationPerformance && typeof input.recommendationPerformance === 'object'
    ? input.recommendationPerformance
    : {};
  const recommendationSummary = recommendationPerformance.summary && typeof recommendationPerformance.summary === 'object'
    ? recommendationPerformance.summary
    : {};

  const evidenceStrength = normalizeEvidenceStrength(recommendationSummary, {
    performanceSource,
  });

  const rows = buildTrackingLookup(
    input.strategyTracking,
    input.strategyPortfolio,
    input.strategyExperiments,
    input.strategyDiscovery
  );

  const improvingStrategies = buildImprovingStrategies(rows, evidenceStrength);
  const weakeningStrategies = buildWeakeningStrategies(rows, evidenceStrength);
  const researchPriorityList = buildResearchPriorityList(rows, evidenceStrength);

  const mechanicsLearningInsights = buildMechanicsLearningInsights(input.mechanicsResearchSummary || null);
  const recommendationLearningInsights = buildRecommendationLearningInsights(recommendationSummary, evidenceStrength);

  const topImprovingStrategy = improvingStrategies[0] || null;
  const topWeakeningStrategy = weakeningStrategies[0] || null;
  const topPriority = researchPriorityList[0] || null;

  const researchPrioritySummary = topPriority
    ? `${topPriority.strategyName}: ${toText(topPriority.researchPriority).replace(/_/g, ' ')} (${topPriority.researchReason})`
    : 'No non-baseline candidates currently qualify for focused research prioritization.';

  const learningInsight = buildLearningInsight({
    improvingStrategies,
    weakeningStrategies,
    evidenceStrength,
  });

  const warnings = Array.from(new Set([
    ...toText(input?.strategyTracking?.dataQuality?.warnings || '').split(',').map((x) => x.trim()).filter(Boolean),
    ...toText(input?.strategyDiscovery?.dataQuality?.warnings || '').split(',').map((x) => x.trim()).filter(Boolean),
    ...toText(input?.strategyPortfolio?.governanceSummary?.dataWarnings || '').split(',').map((x) => x.trim()).filter(Boolean),
    ...toText(input?.strategyExperiments?.experimentSummary?.warnings || '').split(',').map((x) => x.trim()).filter(Boolean),
    ...(Array.isArray(evidenceStrength.warnings) ? evidenceStrength.warnings : []),
  ]));

  return {
    generatedAt: new Date().toISOString(),
    advisoryOnly: true,
    windowSessions,
    includeContext,
    performanceSource,
    improvingStrategies,
    weakeningStrategies,
    researchPriorityList,
    mechanicsLearningInsights,
    recommendationLearningInsights,
    evidenceStrength: {
      ...evidenceStrength,
      warnings,
    },
    topImprovingStrategy,
    topWeakeningStrategy,
    learningInsight,
    researchPrioritySummary,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildStrategyLearningSummary,
};
