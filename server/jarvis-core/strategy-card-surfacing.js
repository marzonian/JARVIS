'use strict';

function asText(value) {
  return String(value == null ? '' : value).trim();
}

function asNullableText(value) {
  const text = asText(value);
  return text || null;
}

function asLowerText(value) {
  return asText(value).toLowerCase();
}

function asFiniteOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function toRoundedOrNull(value) {
  const num = asFiniteOrNull(value);
  return Number.isFinite(num) ? round2(num) : null;
}

function normalizeCardRow(input = {}, defaults = {}) {
  const row = input && typeof input === 'object' ? input : {};
  const pineAccess = row?.pineAccess && typeof row.pineAccess === 'object' ? row.pineAccess : {};
  const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  const drawdown = row?.drawdown && typeof row.drawdown === 'object' ? row.drawdown : {};

  return {
    slot: asLowerText(defaults.slot || row.slot || row.tier || row.layer || ''),
    title: asNullableText(defaults.title || row.title || ''),
    strategyName: asNullableText(row.name || defaults.name || ''),
    key: asNullableText(row.key || defaults.key || ''),
    layer: asNullableText(row.layer || defaults.layer || ''),
    suitability: toRoundedOrNull(row.suitability),
    score: toRoundedOrNull(row.score),
    winRate: toRoundedOrNull(metrics.winRate != null ? metrics.winRate : row.winRate),
    profitFactor: toRoundedOrNull(metrics.profitFactor != null ? metrics.profitFactor : row.profitFactor),
    maxDrawdownDollars: toRoundedOrNull(
      drawdown.maxDrawdownDollars != null ? drawdown.maxDrawdownDollars : row.maxDrawdownDollars
    ),
    recommendationStatus: asNullableText(row.recommendationStatus || defaults.recommendationStatus || ''),
    pineAvailable: pineAccess.available === true,
    pineContractRef: asNullableText(pineAccess.endpoint || ''),
    pineAccess: {
      available: pineAccess.available === true,
      endpoint: asNullableText(pineAccess.endpoint || ''),
      copyReady: pineAccess.copyReady === true,
      format: asNullableText(pineAccess.format || '') || 'pine_v6',
    },
    advisoryOnly: true,
  };
}

function buildStrategyStackCardSection({
  originalPlan = null,
  bestVariant = null,
  bestAlternative = null,
} = {}) {
  const originalPlanCard = normalizeCardRow(originalPlan, {
    slot: 'original_plan',
    title: 'Original Plan',
    recommendationStatus: 'baseline_reference',
  });
  const bestVariantCard = normalizeCardRow(bestVariant, {
    slot: 'best_variant',
    title: 'Best Variant',
    recommendationStatus: 'overlay_candidate',
  });
  const bestAlternativeCard = normalizeCardRow(bestAlternative, {
    slot: 'best_alternative',
    title: 'Best Alternative',
    recommendationStatus: 'alternative_candidate',
  });

  const cards = [originalPlanCard, bestVariantCard, bestAlternativeCard];
  const summaryLine = cards
    .map((card) => `${card.title || card.slot || 'Strategy'}: ${card.strategyName || 'N/A'} (${card.recommendationStatus || 'status_unavailable'})`)
    .join(' | ');

  return {
    originalPlan: originalPlanCard,
    bestVariant: bestVariantCard,
    bestAlternative: bestAlternativeCard,
    cards,
    summaryLine,
    advisoryOnly: true,
  };
}

function buildRecommendationSummaryLine({ recommendationBasis = {}, stackCards = {} } = {}) {
  const basisType = asLowerText(recommendationBasis.basisType || 'baseline') || 'baseline';
  const strategyName = asText(recommendationBasis.recommendedStrategyName || 'Original Trading Plan') || 'Original Trading Plan';
  const basisLabel = asText(recommendationBasis.basisLabel || '') || null;

  if (basisType === 'overlay') {
    return `Jarvis is on Best Variant (${strategyName}) because overlay evidence currently outranks the baseline plan.`;
  }
  if (basisType === 'alternative') {
    return `Jarvis is on Best Alternative (${strategyName}) because the alternative stack currently leads the baseline and variant.`;
  }

  const variantName = asText(stackCards?.bestVariant?.strategyName || 'Best Variant');
  const altName = asText(stackCards?.bestAlternative?.strategyName || 'Best Alternative');
  if (basisLabel) {
    return `Jarvis is on Original Plan (${strategyName}) under ${basisLabel}, keeping ${variantName} and ${altName} as overlays.`;
  }
  return `Jarvis is on Original Plan (${strategyName}) while keeping ${variantName} and ${altName} as alternatives.`;
}

function buildStanceSummaryLine({ executionStance = {}, assistantDecisionBrief = {} } = {}) {
  const stance = asText(executionStance.stance || 'Skip') || 'Skip';
  const stanceReason = asText(executionStance.reason || executionStance.summaryLine || '');
  const briefWhy = asText(assistantDecisionBrief.why || '');

  if (stanceReason) {
    return `Execution stance: ${stance}. ${stanceReason}`;
  }
  if (briefWhy) {
    return `Execution stance: ${stance}. ${briefWhy}`;
  }
  return `Execution stance: ${stance}.`;
}

function buildStrategyRecommendationWhyBlock({
  recommendationBasis = {},
  assistantDecisionBrief = {},
  executionStance = {},
  stackCards = {},
} = {}) {
  const recommendationSummaryLine = buildRecommendationSummaryLine({ recommendationBasis, stackCards });
  const stanceSummaryLine = buildStanceSummaryLine({ executionStance, assistantDecisionBrief });
  const voiceSummaryLine = `${recommendationSummaryLine} ${stanceSummaryLine}`.trim();

  return {
    recommendationBasis: {
      basisType: asNullableText(recommendationBasis.basisType || ''),
      basisLabel: asNullableText(recommendationBasis.basisLabel || ''),
      recommendedStrategyKey: asNullableText(recommendationBasis.recommendedStrategyKey || ''),
      recommendedStrategyName: asNullableText(recommendationBasis.recommendedStrategyName || ''),
      recommendationScore: toRoundedOrNull(recommendationBasis.recommendationScore),
      recommendationAdjustedForNews: recommendationBasis.recommendationAdjustedForNews === true,
    },
    assistantDecisionBrief: {
      actionNow: asNullableText(assistantDecisionBrief.actionNow || ''),
      why: asNullableText(assistantDecisionBrief.why || ''),
      assistantText: asNullableText(assistantDecisionBrief.assistantText || ''),
    },
    executionStance: {
      stance: asNullableText(executionStance.stance || ''),
      reason: asNullableText(executionStance.reason || executionStance.summaryLine || ''),
      executionAdjustment: asNullableText(executionStance.executionAdjustment || ''),
      summaryLine: asNullableText(executionStance.summaryLine || ''),
    },
    recommendationSummaryLine,
    stanceSummaryLine,
    voiceSummaryLine,
    summaryLine: voiceSummaryLine,
    advisoryOnly: true,
  };
}

module.exports = {
  buildStrategyStackCardSection,
  buildStrategyRecommendationWhyBlock,
  normalizeCardRow,
};
