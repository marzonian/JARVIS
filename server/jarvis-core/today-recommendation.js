'use strict';

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  if (value == null) return fallback;
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

function normalizeToken(value) {
  return toText(value).toLowerCase().replace(/\s+/g, '_');
}

function isHighRiskStructure(input = {}) {
  const trend = normalizeToken(input.trend || input.regimeTrend);
  const volatility = normalizeToken(input.volatility || input.regimeVolatility);
  const orbProfile = normalizeToken(input.orbProfile || input.regimeOrbSize);
  const orbRangeTicks = toNumber(
    input.orbRangeTicks
    ?? input.orb_range_ticks,
    null
  );
  const wideOrb = orbProfile === 'wide'
    || (Number.isFinite(orbRangeTicks) && orbRangeTicks >= 240);
  return trend === 'ranging' && volatility === 'extreme' && wideOrb;
}

function normalizeImpactRank(impactText = '') {
  const txt = toText(impactText).toLowerCase();
  if (txt.includes('high')) return 3;
  if (txt.includes('medium')) return 2;
  if (txt.includes('low')) return 1;
  return 0;
}

function deriveNewsImpactStatus(news = {}) {
  const qualifier = toText(news.qualifier);
  const recommendationAdjustment = toText(news.recommendationAdjustment).toLowerCase();
  const events = Array.isArray(news.normalizedEvents) ? news.normalizedEvents : [];
  const imminentHighImpact = events.find((evt) =>
    normalizeImpactRank(evt?.impact) >= 3
    && Number.isFinite(Number(evt?.deltaMinutes))
    && Number(evt.deltaMinutes) >= 0
    && Number(evt.deltaMinutes) <= 15
  ) || null;

  if (imminentHighImpact) {
    return {
      status: 'high_impact_imminent',
      reason: `High-impact news in ${Number(imminentHighImpact.deltaMinutes)} minutes (${toText(imminentHighImpact.time) || 'ET'}).`,
      recommendationAdjustment: 'delay_or_downgrade',
      imminentHighImpact: true,
    };
  }
  if (recommendationAdjustment === 'delay_or_downgrade') {
    return {
      status: 'high_impact_nearby',
      reason: qualifier || 'High-impact news is nearby and can distort execution quality.',
      recommendationAdjustment,
      imminentHighImpact: false,
    };
  }
  if (recommendationAdjustment === 'qualify') {
    return {
      status: 'qualify_for_news',
      reason: qualifier || 'News timing suggests qualifying entries until structure confirms.',
      recommendationAdjustment,
      imminentHighImpact: false,
    };
  }
  return {
    status: 'normal',
    reason: qualifier || 'No near-term news distortion detected.',
    recommendationAdjustment: 'normal',
    imminentHighImpact: false,
  };
}

function classifyPosture(input = {}) {
  const projectedWinChance = toNumber(input.projectedWinChance, 50);
  const historicalStance = toText(input.historicalStance).toLowerCase();
  const sessionPhase = toText(input.sessionPhase).toLowerCase();
  const newsImpact = input.newsImpact || deriveNewsImpactStatus(input.news);
  const reliability = input.reliabilityContext && typeof input.reliabilityContext === 'object'
    ? input.reliabilityContext
    : {};
  const fallbackLevel = normalizeToken(reliability.fallbackLevel);
  const fallbackDriven = !!fallbackLevel && fallbackLevel !== 'exact_context';
  const highRiskStructure = isHighRiskStructure(reliability);
  const weakOrMixedConfirmation = reliability.weakLiveConfirmation === true
    || historicalStance === 'mixed'
    || historicalStance === 'unfavorable'
    || historicalStance === 'unknown';
  const shouldApplyReliabilityGate = fallbackDriven
    && highRiskStructure
    && weakOrMixedConfirmation
    && projectedWinChance < 60;

  if (newsImpact.imminentHighImpact) {
    return {
      posture: 'wait_for_news',
      postureReason: `${newsImpact.reason} Wait for post-release structure before engaging.`,
    };
  }

  if (projectedWinChance < 45) {
    return {
      posture: 'stand_down',
      postureReason: `Projected win chance is ${round2(projectedWinChance)}%, which is below the risk-adjusted threshold for normal participation.`,
    };
  }

  if (newsImpact.recommendationAdjustment === 'delay_or_downgrade') {
    return {
      posture: 'wait_for_news',
      postureReason: newsImpact.reason || 'High-impact news risk is elevated; delay aggressive entries.',
    };
  }

  if (newsImpact.recommendationAdjustment === 'qualify') {
    return {
      posture: 'trade_selectively',
      postureReason: newsImpact.reason || 'News-adjacent structure warrants selective entries only.',
    };
  }

  if (shouldApplyReliabilityGate) {
    return {
      posture: 'wait_for_clearance',
      postureReason: `Evidence precision is limited (${fallbackLevel.replace(/_/g, ' ')} fallback) in ranging + extreme + wide conditions with mixed confirmation; wait for cleaner structure before committing.`,
    };
  }

  if (projectedWinChance >= 60 && historicalStance === 'favorable') {
    return {
      posture: 'trade_normally',
      postureReason: `Projected win chance (${round2(projectedWinChance)}%) and historical context are aligned for normal plan execution.`,
    };
  }

  if (sessionPhase === 'pre_open' && projectedWinChance >= 52) {
    return {
      posture: 'trade_selectively',
      postureReason: `Pre-open context is constructive (${round2(projectedWinChance)}%), but structure is not confirmed yet.`,
    };
  }

  return {
    posture: 'trade_selectively',
    postureReason: `Conditions are mixed (${round2(projectedWinChance)}% projected edge); prioritize confirmation quality and risk discipline.`,
  };
}

function selectTpRecommendation(input = {}) {
  const globalTp = toText(input.globalRecommendedTpMode);
  const contextual = input.contextualRecommendation && typeof input.contextualRecommendation === 'object'
    ? input.contextualRecommendation
    : {};
  const contextualTp = toText(contextual.contextualRecommendedTpMode);
  const contextConfidence = toText(contextual.confidenceLabel).toLowerCase() || 'low';
  const contextSampleSize = toNumber(contextual.sampleSize, 0);
  const fallbackLevel = toText(contextual.fallbackLevel) || 'global';
  const contextUsed = contextual.contextUsed && typeof contextual.contextUsed === 'object'
    ? contextual.contextUsed
    : {};
  const tpGuardContext = input.tpGuardContext && typeof input.tpGuardContext === 'object'
    ? input.tpGuardContext
    : {};
  const trend = normalizeToken(
    tpGuardContext.trend
    || tpGuardContext.regimeTrend
    || contextUsed.regimeTrend
  );
  const volatility = normalizeToken(
    tpGuardContext.volatility
    || tpGuardContext.regimeVolatility
    || contextUsed.regimeVolatility
  );
  const orbProfile = normalizeToken(
    tpGuardContext.orbProfile
    || tpGuardContext.regimeOrbSize
    || contextUsed.regimeOrbSize
  );
  const orbRangeTicks = toNumber(
    tpGuardContext.orbRangeTicks
    ?? tpGuardContext.orb_range_ticks
    ?? contextUsed.orbRangeTicks
    ?? contextUsed.orb_range_ticks,
    null
  );

  let recommendedTpMode = globalTp || contextualTp || null;
  let recommendationBasis = globalTp ? 'global_mechanics' : 'contextual_mechanics';
  let tpRecommendationReason = globalTp
    ? `Global mechanics research favors ${globalTp} TP in the current evidence window.`
    : 'TP recommendation is unavailable due to insufficient mechanics research.';

  const contextStrongEnough = contextualTp
    && contextConfidence !== 'low'
    && contextSampleSize >= 15;

  if (contextStrongEnough) {
    recommendedTpMode = contextualTp;
    recommendationBasis = 'contextual_mechanics';
    const weekday = toText(contextUsed.weekday);
    const timeBucket = toText(contextUsed.timeBucket).replace(/_/g, ' ');
    const regime = toText(contextUsed.regime);
    const contextLabel = [weekday, timeBucket, regime].filter(Boolean).join(' ').trim() || 'current context';
    const fallbackNote = fallbackLevel !== 'exact_context'
      ? ` (fallback: ${fallbackLevel.replace(/_/g, ' ')})`
      : '';
    tpRecommendationReason = `Contextual mechanics research suggests ${contextualTp} TP for ${contextLabel}, confidence ${contextConfidence}, sample ${contextSampleSize}${fallbackNote}.`;
  } else if (globalTp && contextualTp && contextualTp !== globalTp) {
    tpRecommendationReason = `Global mechanics leans ${globalTp}; contextual signal (${contextualTp}) is low-confidence, so baseline mechanics stay advisory preference.`;
  }

  const fallbackDriven = fallbackLevel !== 'exact_context';
  const aggressiveTp = ['skip_1', 'skip_2'].includes(normalizeToken(recommendedTpMode));
  const wideOrb = orbProfile === 'wide'
    || (Number.isFinite(orbRangeTicks) && orbRangeTicks >= 240);
  const shouldCapToNearest = fallbackDriven
    && trend === 'ranging'
    && volatility === 'extreme'
    && wideOrb
    && aggressiveTp;

  if (shouldCapToNearest) {
    recommendedTpMode = 'Nearest';
    tpRecommendationReason = `${tpRecommendationReason} Guardrail override: fallback/global TP in ranging + extreme + wide ORB context is capped to Nearest.`;
  }

  return {
    recommendedTpMode: recommendedTpMode || null,
    recommendationBasis,
    confidenceLevel: contextConfidence || 'low',
    tpRecommendationReason,
  };
}

function buildConfidenceModel(input = {}) {
  const projectedWinChance = toNumber(input.projectedWinChance, 50);
  const contextConfidenceScore = toNumber(input.contextConfidenceScore, null);
  const contextSampleSize = toNumber(input.contextSampleSize, 0);
  const historicalStance = toText(input.historicalStance).toLowerCase();
  const strategyConfidence = toNumber(input.strategyConfidence, 50);
  const systemsAgree = input.systemsAgree === true;

  const winScore = clamp((projectedWinChance - 40) / 30, 0, 1) * 100;
  const strategyScore = clamp(strategyConfidence / 100, 0, 1) * 100;
  const contextScore = Number.isFinite(contextConfidenceScore)
    ? clamp(contextConfidenceScore, 0, 100)
    : clamp(contextSampleSize / 60, 0, 1) * 100;
  const historicalScore = historicalStance === 'favorable'
    ? 80
    : historicalStance === 'mixed'
      ? 55
      : historicalStance === 'unfavorable'
        ? 35
        : 45;
  const agreementScore = systemsAgree ? 80 : 50;

  const confidenceScore = round2(
    (winScore * 0.3)
    + (strategyScore * 0.2)
    + (contextScore * 0.25)
    + (historicalScore * 0.15)
    + (agreementScore * 0.1)
  );
  const confidenceLabel = confidenceScore >= 72 ? 'high' : confidenceScore >= 50 ? 'medium' : 'low';

  return {
    confidenceScore,
    confidenceLabel,
  };
}

function buildTodayRecommendation(input = {}) {
  const recommendedStrategy = toText(input.recommendedStrategy || 'Original Trading Plan');
  const strategyConfidence = toNumber(input.strategyConfidence, 50);
  const projectedWinChance = toNumber(input.projectedWinChance, null);
  const historicalContext = input.historicalContext && typeof input.historicalContext === 'object'
    ? input.historicalContext
    : {};
  const historicalStance = toText(historicalContext.stance).toLowerCase() || 'unknown';
  const contextMatchSummary = toText(historicalContext.narrative) || 'Historical context is limited.';
  const newsImpact = deriveNewsImpactStatus(input.news || {});
  const posture = classifyPosture({
    projectedWinChance,
    historicalStance,
    sessionPhase: input.sessionPhase,
    newsImpact,
    reliabilityContext: {
      fallbackLevel: input.contextualRecommendation?.fallbackLevel,
      trend: input.tpGuardContext?.trend || input.tpGuardContext?.regimeTrend,
      volatility: input.tpGuardContext?.volatility || input.tpGuardContext?.regimeVolatility,
      orbProfile: input.tpGuardContext?.orbProfile || input.tpGuardContext?.regimeOrbSize,
      orbRangeTicks: input.tpGuardContext?.orbRangeTicks ?? input.tpGuardContext?.orb_range_ticks,
      weakLiveConfirmation: input.liveConfirmationWeak === true,
    },
  });

  const tpRec = selectTpRecommendation({
    globalRecommendedTpMode: input.globalRecommendedTpMode,
    contextualRecommendation: input.contextualRecommendation,
    tpGuardContext: input.tpGuardContext,
  });
  const globalTp = toText(input.globalRecommendedTpMode);
  const contextualTp = toText(input.contextualRecommendation?.contextualRecommendedTpMode);
  const systemsAgree = !!globalTp && !!contextualTp && globalTp === contextualTp;

  const confidence = buildConfidenceModel({
    projectedWinChance,
    strategyConfidence,
    contextConfidenceScore: input.contextualRecommendation?.confidenceScore,
    contextSampleSize: input.contextualRecommendation?.sampleSize,
    historicalStance,
    systemsAgree,
  });

  return {
    posture: posture.posture,
    postureReason: posture.postureReason,
    recommendedStrategy,
    strategyConfidence: round2(strategyConfidence),
    recommendedTpMode: tpRec.recommendedTpMode,
    recommendationBasis: tpRec.recommendationBasis,
    tpRecommendationReason: tpRec.tpRecommendationReason,
    projectedWinChance: Number.isFinite(projectedWinChance) ? round2(projectedWinChance) : null,
    newsImpactStatus: newsImpact.status,
    contextMatchSummary,
    confidenceScore: confidence.confidenceScore,
    confidenceLabel: confidence.confidenceLabel,
    advisoryOnly: true,
  };
}

module.exports = {
  deriveNewsImpactStatus,
  classifyPosture,
  selectTpRecommendation,
  buildConfidenceModel,
  buildTodayRecommendation,
};
