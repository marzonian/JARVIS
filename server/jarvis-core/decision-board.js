'use strict';

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeKey(value) {
  return toText(value).toLowerCase();
}

function pickFirstText(values = []) {
  for (const value of values) {
    const txt = toText(value);
    if (txt) return txt;
  }
  return '';
}

function dedupeText(value, seen = new Set()) {
  const txt = toText(value);
  if (!txt) return '';
  const key = normalizeKey(txt);
  if (seen.has(key)) return '';
  seen.add(key);
  return txt;
}

function resolveRegimeContext(todayContext = {}) {
  const detection = todayContext.regimeDetection && typeof todayContext.regimeDetection === 'object'
    ? todayContext.regimeDetection
    : {};
  const regimeLabel = toText(detection.regimeLabel || todayContext.regime || todayContext.marketRegime);
  const regimeReason = toText(detection.regimeReason || todayContext.regimeReason || '');
  const confidenceLabel = toText(detection.confidenceLabel || todayContext.regimeConfidence || '').toLowerCase() || null;
  const confidenceScore = toNumber(
    detection.confidenceScore != null ? detection.confidenceScore : todayContext.regimeConfidenceScore,
    null
  );
  return {
    label: regimeLabel || null,
    reason: regimeReason || null,
    confidenceLabel,
    confidenceScore,
  };
}

function asStrategyRef(input = {}, fallbackLabel = '') {
  const strategyKey = pickFirstText([input.strategyKey, input.key]);
  const strategyName = pickFirstText([input.strategyName, input.name, fallbackLabel]);
  if (!strategyKey && !strategyName) return null;
  return {
    strategyKey: strategyKey || null,
    strategyName: strategyName || null,
    strategyType: pickFirstText([input.strategyType, input.layer]) || null,
    state: pickFirstText([input.portfolioState, input.experimentState, input.trackingStatus]) || null,
    advisoryOnly: input.advisoryOnly === true,
  };
}

function buildContextSummary(todayContext = {}) {
  const parts = [];
  const phase = toText(todayContext.sessionPhase).replace(/_/g, ' ');
  const regimeContext = resolveRegimeContext(todayContext);
  const regime = toText(regimeContext.label);
  const trend = toText(todayContext.trend || todayContext.marketTrend);
  const nowEt = toText(todayContext.nowEt);
  if (nowEt) parts.push(nowEt);
  if (phase) parts.push(`phase ${phase}`);
  if (regime) parts.push(`regime ${regime}`);
  if (trend) parts.push(`trend ${trend}`);
  return parts.join(' | ');
}

function buildSummaryLine(input = {}) {
  const baselineName = toText(input.baseline?.strategyName || 'Original Trading Plan');
  const posture = toText(input.posture || 'trade_selectively').replace(/_/g, ' ');
  const tpMode = toText(input.tpRecommendation || 'unchanged');
  const confidenceLabel = toText(input.confidence?.label || 'medium');
  const projected = toNumber(input.projectedWinChance, null);
  const projectedText = Number.isFinite(projected) ? `; projected ${round2(projected)}%` : '';
  return `${baselineName} baseline; posture ${posture}; TP ${tpMode}; confidence ${confidenceLabel}${projectedText}.`;
}

function buildDecisionBoard(input = {}) {
  const seen = new Set();
  const todayRecommendation = input.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const strategyPortfolio = input.strategyPortfolio && typeof input.strategyPortfolio === 'object'
    ? input.strategyPortfolio
    : {};
  const strategyExperiments = input.strategyExperiments && typeof input.strategyExperiments === 'object'
    ? input.strategyExperiments
    : {};
  const strategyTracking = input.strategyTracking && typeof input.strategyTracking === 'object'
    ? input.strategyTracking
    : {};
  const originalPlan = input.originalPlan && typeof input.originalPlan === 'object'
    ? input.originalPlan
    : {};
  const bestAlternative = input.bestAlternative && typeof input.bestAlternative === 'object'
    ? input.bestAlternative
    : {};
  const todayContext = input.todayContext && typeof input.todayContext === 'object'
    ? input.todayContext
    : {};
  const regimeContext = resolveRegimeContext(todayContext);

  const baseline = asStrategyRef(
    strategyPortfolio?.baselineStrategy || originalPlan,
    'Original Trading Plan'
  );
  const topCandidate = asStrategyRef(
    strategyPortfolio?.highestPriorityCandidate
      || strategyExperiments?.highestPriorityExperiment
      || bestAlternative,
    ''
  );

  const posture = toText(todayRecommendation.posture || 'trade_selectively');
  const tpRecommendation = toText(todayRecommendation.recommendedTpMode);
  const projectedWinChance = toNumber(todayRecommendation.projectedWinChance, null);
  const confidence = {
    label: toText(todayRecommendation.confidenceLabel || 'low').toLowerCase(),
    score: toNumber(todayRecommendation.confidenceScore, null),
  };

  const newsCaution = toText(
    input.newsCaution
      || input.newsQualifier?.qualifier
      || todayRecommendation.newsImpactStatus
  );

  const confidenceReason = pickFirstText([
    input.confidenceReason,
    todayRecommendation.postureReason,
    todayRecommendation.tpRecommendationReason,
    'Confidence is derived from strategy alignment, mechanics evidence, and contextual quality.',
  ]);

  const candidateState = pickFirstText([
    strategyExperiments?.highestPriorityExperiment?.experimentState,
    strategyPortfolio?.highestPriorityCandidate?.portfolioState,
    strategyTracking?.bestTrackedStrategyNow?.trackingStatus,
  ]);

  const handoffState = toText(strategyTracking?.recommendationHandoffState || input.handoffState);

  let keyRisk = '';
  if (posture === 'stand_down') {
    keyRisk = toText(todayRecommendation.postureReason);
  } else if (newsCaution) {
    keyRisk = newsCaution;
  } else if (candidateState && /(weakening|retired|deprioritized|low_confidence)/i.test(candidateState)) {
    keyRisk = 'Top candidate quality is degraded and should not influence baseline decisions.';
  } else {
    keyRisk = toText(todayRecommendation.postureReason);
  }

  let keyOpportunity = '';
  if (Number.isFinite(projectedWinChance) && projectedWinChance >= 60) {
    keyOpportunity = `Projected edge is constructive at ${round2(projectedWinChance)}%.`;
  } else if (tpRecommendation) {
    keyOpportunity = `Mechanics guidance currently favors ${tpRecommendation} TP as an advisory target mode.`;
  } else if (topCandidate?.strategyName) {
    keyOpportunity = `${topCandidate.strategyName} is the highest-priority advisory candidate under shadow tracking.`;
  }

  const dedupedNewsCaution = dedupeText(newsCaution, seen);
  const dedupedKeyRisk = dedupeText(keyRisk, seen)
    || dedupeText('Risk remains elevated; keep strict confirmation and sizing discipline.', seen);
  const dedupedKeyOpportunity = dedupeText(keyOpportunity, seen);

  const contextSummary = buildContextSummary(todayContext);
  const summaryLine = buildSummaryLine({
    baseline,
    posture,
    tpRecommendation,
    confidence,
    projectedWinChance,
  });

  return {
    baseline,
    topCandidate,
    candidateState: candidateState || null,
    handoffState: handoffState || null,
    todayRecommendation: toText(todayRecommendation.recommendedStrategy || todayRecommendation.strategyName) || null,
    posture: posture || null,
    tpRecommendation: tpRecommendation || null,
    confidence,
    confidenceReason,
    newsCaution: dedupedNewsCaution || null,
    projectedWinChance: Number.isFinite(projectedWinChance) ? round2(projectedWinChance) : null,
    contextSummary: contextSummary || null,
    regimeLabel: regimeContext.label || null,
    regimeConfidence: regimeContext.confidenceLabel || null,
    regimeConfidenceScore: Number.isFinite(regimeContext.confidenceScore) ? round2(regimeContext.confidenceScore) : null,
    regimeReason: regimeContext.reason || null,
    keyRisk: dedupedKeyRisk || null,
    keyOpportunity: dedupedKeyOpportunity || null,
    summaryLine,
    advisoryOnly: true,
  };
}

module.exports = {
  buildDecisionBoard,
};
