#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildStrategyStackCardSection,
  buildStrategyRecommendationWhyBlock,
  buildStrategyComparisonReadout,
} = require('../server/jarvis-core/strategy-card-surfacing');

function run() {
  const cards = buildStrategyStackCardSection({
    originalPlan: {
      key: 'original_plan_orb_3130',
      layer: 'original',
      name: 'Original Trading Plan',
      recommendationStatus: 'recommended_now',
      pineAccess: {
        available: true,
        endpoint: '/api/jarvis/strategy/pine?key=original_plan_orb_3130&layer=original',
        copyReady: true,
        format: 'pine_v6',
      },
    },
    bestVariant: {
      key: 'variant_orb_80_220_skip_monday',
      layer: 'variant',
      name: 'ORB 80-220 + Skip Monday',
      suitability: 49.89,
      metrics: { winRate: 55.4, profitFactor: 1.16 },
      drawdown: { maxDrawdownDollars: 996.5 },
      recommendationStatus: 'overlay_candidate',
      pineAccess: {
        available: true,
        endpoint: '/api/jarvis/strategy/pine?key=variant_orb_80_220_skip_monday&layer=variant',
        copyReady: true,
        format: 'pine_v6',
      },
    },
    bestAlternative: {
      key: 'fhm_1005_70_80_60_rr_tp0sp10',
      layer: 'discovery',
      name: 'First-Hour Momentum 10:05',
      recommendationStatus: 'alternative_candidate',
      pineAccess: {
        available: true,
        endpoint: '/api/jarvis/strategy/pine?key=fhm_1005_70_80_60_rr_tp0sp10&layer=discovery',
        copyReady: true,
        format: 'pine_v6',
      },
    },
  });

  assert(cards && typeof cards === 'object', 'strategy card section missing');
  assert(Array.isArray(cards.cards) && cards.cards.length === 3, 'expected three strategy cards');

  const originalPlanCard = cards.originalPlan;
  assert(originalPlanCard.strategyName === 'Original Trading Plan', 'original plan card name mismatch');
  assert(originalPlanCard.pineAccess.endpoint.includes('/api/jarvis/strategy/pine?'), 'pine endpoint missing on original card');
  assert(originalPlanCard.pineContractRef === originalPlanCard.pineAccess.endpoint, 'pine contract reference mismatch');

  const bestAlternativeCard = cards.bestAlternative;
  assert(bestAlternativeCard.suitability === null, 'missing suitability should degrade to null');
  assert(bestAlternativeCard.score === null, 'missing score should degrade to null');
  assert(bestAlternativeCard.winRate === null, 'missing win rate should degrade to null');
  assert(bestAlternativeCard.profitFactor === null, 'missing profit factor should degrade to null');
  assert(bestAlternativeCard.maxDrawdownDollars === null, 'missing drawdown should degrade to null');

  const whyBlock = buildStrategyRecommendationWhyBlock({
    recommendationBasis: {
      basisType: 'baseline',
      basisLabel: 'Original Trading Plan',
      recommendedStrategyKey: 'original_plan_orb_3130',
      recommendedStrategyName: 'Original Trading Plan',
      recommendationScore: 55.15,
      recommendationAdjustedForNews: false,
    },
    assistantDecisionBrief: {
      actionNow: 'Wait for clearance.',
      why: 'Confidence support is below the line right now.',
      assistantText: 'Action now: Wait for clearance.',
    },
    executionStance: {
      stance: 'Skip',
      reason: 'Blockers are still active; avoid engagement until clearance.',
      executionAdjustment: 'avoid',
      summaryLine: 'Stance Skip: Blockers are still active; avoid engagement until clearance.',
    },
    stackCards: cards,
  });

  assert(whyBlock && typeof whyBlock === 'object', 'strategy why block missing');
  assert(typeof whyBlock.recommendationSummaryLine === 'string' && whyBlock.recommendationSummaryLine.length > 0, 'recommendation summary line missing');
  assert(typeof whyBlock.stanceSummaryLine === 'string' && whyBlock.stanceSummaryLine.length > 0, 'stance summary line missing');
  assert(typeof whyBlock.voiceSummaryLine === 'string' && whyBlock.voiceSummaryLine.length > 0, 'voice summary line missing');
  assert(/Original Plan/i.test(whyBlock.recommendationSummaryLine), 'recommendation summary should mention Original Plan');
  assert(/Execution stance:/i.test(whyBlock.stanceSummaryLine), 'stance summary should expose execution stance language');

  const comparison = buildStrategyComparisonReadout({
    strategyStack: cards.cards.map((card) => ({
      key: card.key,
      layer: card.layer,
      name: card.strategyName,
      suitability: card.suitability,
      score: card.score,
      metrics: { winRate: card.winRate, profitFactor: card.profitFactor },
      drawdown: { maxDrawdownDollars: card.maxDrawdownDollars },
      recommendationStatus: card.recommendationStatus,
      pineAccess: card.pineAccess,
    })),
    recommendationBasis: {
      basisType: 'baseline',
      recommendedStrategyKey: 'original_plan_orb_3130',
      recommendedStrategyName: 'Original Trading Plan',
    },
    executionStance: {
      stance: 'Skip',
      reason: 'Blockers are still active; avoid engagement until clearance.',
    },
  });

  assert(comparison && typeof comparison === 'object', 'strategy comparison readout missing');
  assert(comparison.recommendedKey === 'original_plan_orb_3130', 'strategy comparison recommended key mismatch');
  assert(Array.isArray(comparison.comparisonRows) && comparison.comparisonRows.length === 3, 'strategy comparison rows should expose all three strategies');
  const recommendedRows = comparison.comparisonRows.filter((row) => row.isRecommended === true);
  assert(recommendedRows.length === 1, 'strategy comparison should mark exactly one recommended row');
  assert(recommendedRows[0].key === 'original_plan_orb_3130', 'recommended row key mismatch');
  const nonRecommendedRows = comparison.comparisonRows.filter((row) => row.isRecommended !== true);
  assert(nonRecommendedRows.length === 2, 'expected two non-recommended rows');
  assert(nonRecommendedRows.every((row) => typeof row.whyChosenOrNot === 'string' && row.whyChosenOrNot.length > 0), 'non-recommended rows should include whyChosenOrNot');
  assert(nonRecommendedRows.every((row) => typeof row.tradeoffLine === 'string' && row.tradeoffLine.length > 0), 'non-recommended rows should include tradeoffLine');
  const nullMetricRow = comparison.comparisonRows.find((row) => row.key === 'fhm_1005_70_80_60_rr_tp0sp10');
  assert(nullMetricRow && nullMetricRow.score === null, 'missing score must stay null');
  assert(nullMetricRow && nullMetricRow.suitability === null, 'missing suitability must stay null');
  assert(nullMetricRow && nullMetricRow.winRate === null, 'missing winRate must stay null');
  assert(nullMetricRow && nullMetricRow.profitFactor === null, 'missing profitFactor must stay null');
  assert(typeof comparison.summaryLine === 'string' && comparison.summaryLine.length > 0, 'strategy comparison summary line missing');
  assert(typeof comparison.voiceSummaryLine === 'string' && comparison.voiceSummaryLine.length > 0, 'strategy comparison voice summary missing');

  console.log('Jarvis strategy card readout tests passed.');
}

run();
