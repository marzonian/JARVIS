#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { buildCommandCenterPanels } = require('../server/jarvis-core/strategy-layers');

function strategyEntry({ key, layer, name, score, suitability, winRate, profitFactor, maxDrawdownDollars }) {
  return {
    key,
    layer,
    name,
    score,
    suitability,
    metrics: {
      winRate,
      profitFactor,
      totalTrades: 120,
    },
    drawdown: {
      maxDrawdownDollars,
    },
    rules: { maxEntryHour: 11, tpMode: 'skip2' },
    pineScript: '//@version=6\nstrategy("x")',
  };
}

function opportunityRow({ key, name, layer, heuristicCompositeScore, opportunityCompositeScore, opportunityWinProb, opportunityExpectedValue }) {
  return {
    key,
    name,
    layer,
    heuristicCompositeScore,
    opportunityCompositeScore,
    opportunityWinProb,
    opportunityExpectedValue,
    opportunityCalibrationBand: 'medium',
    opportunityFeatureVector: {
      temporalContextSamples: 12,
      strategyKey: key,
    },
    opportunityScoreSummaryLine: `Win ${opportunityWinProb}% | EV $${opportunityExpectedValue}`,
  };
}

function run() {
  const bad = strategyEntry({
    key: 'bad_high_score_negative_ev',
    layer: 'original',
    name: 'Bad High Score',
    score: 95,
    suitability: 91,
    winRate: 67,
    profitFactor: 1.62,
    maxDrawdownDollars: 1200,
  });
  const good = strategyEntry({
    key: 'good_balanced_positive_ev',
    layer: 'variant',
    name: 'Good Balanced',
    score: 74,
    suitability: 76,
    winRate: 58,
    profitFactor: 1.75,
    maxDrawdownDollars: 940,
  });
  const alt = strategyEntry({
    key: 'alt_moderate_positive_ev',
    layer: 'discovery',
    name: 'Alternative Moderate',
    score: 63,
    suitability: 64,
    winRate: 53,
    profitFactor: 1.42,
    maxDrawdownDollars: 1010,
  });

  const strategyLayers = {
    strategyStack: [bad, good, alt],
    originalPlan: bad,
    bestVariant: good,
    bestAlternative: alt,
    recommendation: {
      strategyKey: bad.key,
      layer: bad.layer,
      name: bad.name,
      recommendationScore: 91,
      reason: 'High heuristic score',
    },
    recommendationBasis: {
      basisType: 'baseline',
      recommendedStrategyKey: bad.key,
      recommendedStrategyName: bad.name,
    },
    opportunityScoring: {
      comparisonRows: [
        opportunityRow({
          key: bad.key,
          name: bad.name,
          layer: bad.layer,
          heuristicCompositeScore: 93,
          opportunityCompositeScore: 88,
          opportunityWinProb: 74,
          opportunityExpectedValue: -220,
        }),
        opportunityRow({
          key: good.key,
          name: good.name,
          layer: good.layer,
          heuristicCompositeScore: 76,
          opportunityCompositeScore: 72,
          opportunityWinProb: 58,
          opportunityExpectedValue: 28,
        }),
        opportunityRow({
          key: alt.key,
          name: alt.name,
          layer: alt.layer,
          heuristicCompositeScore: 62,
          opportunityCompositeScore: 60,
          opportunityWinProb: 52,
          opportunityExpectedValue: 12,
        }),
      ],
      recommendedByOpportunityKey: bad.key,
      recommendedByOpportunityName: bad.name,
      summaryLine: 'Synthetic opportunity rows for actionability test.',
    },
  };

  const commandCenter = buildCommandCenterPanels({
    strategyLayers,
    decision: {
      signal: 'TRADE',
      signalLabel: 'TRADE',
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability: 0.62,
        expectedValueDollars: 0,
        annualizedTrades: 120,
      }],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    todayContext: {
      nowEt: '2026-04-16 10:25',
      sessionPhase: 'entry_window',
      timeBucket: 'entry_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
    commandSnapshot: {
      elite: {
        winModel: { point: 56.1, confidencePct: 66 },
      },
    },
  });

  const liveCandidates = commandCenter.liveOpportunityCandidates;
  assert(liveCandidates && typeof liveCandidates === 'object', 'liveOpportunityCandidates missing');
  assert(liveCandidates.topCandidateOverall && typeof liveCandidates.topCandidateOverall === 'object', 'topCandidateOverall missing');
  assert(liveCandidates.topCandidateActionableNow && typeof liveCandidates.topCandidateActionableNow === 'object', 'topCandidateActionableNow missing');
  assert(liveCandidates.hasActionableCandidateNow === true, 'hasActionableCandidateNow should be true');

  const topOverall = liveCandidates.topCandidateOverall;
  const topActionableNow = liveCandidates.topCandidateActionableNow;
  assert(topActionableNow.strategyKey !== bad.key, 'negative-EV candidate should not dominate actionable-now ranking');
  assert(topOverall.strategyKey !== bad.key, 'quality penalty should demote deep negative-EV candidate from overall top slot');
  assert(topOverall.candidateExpectedValue > -50, 'overall top should avoid deep negative EV where better options exist');
  assert(typeof liveCandidates.actionableNowSummaryLine === 'string' && liveCandidates.actionableNowSummaryLine.length > 0, 'actionableNowSummaryLine missing');
  assert(typeof liveCandidates.summaryLine === 'string' && liveCandidates.summaryLine.length > 0, 'summaryLine missing');

  console.log('Jarvis live opportunity actionability ranking test passed.');
}

run();
