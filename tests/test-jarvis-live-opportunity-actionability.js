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
  assert(liveCandidates.candidateSourceCounts && typeof liveCandidates.candidateSourceCounts === 'object', 'candidateSourceCounts missing');
  assert(typeof liveCandidates.candidateDiversitySummaryLine === 'string' && liveCandidates.candidateDiversitySummaryLine.length > 0, 'candidateDiversitySummaryLine missing');

  const topOverall = liveCandidates.topCandidateOverall;
  const topActionableNow = liveCandidates.topCandidateActionableNow;
  assert(typeof topOverall.candidateSource === 'string' && topOverall.candidateSource.length > 0, 'topCandidateOverall candidateSource missing');
  assert(typeof topActionableNow.candidateSource === 'string' && topActionableNow.candidateSource.length > 0, 'topCandidateActionableNow candidateSource missing');
  assert(Object.prototype.hasOwnProperty.call(topOverall, 'structureQualityScore'), 'topCandidateOverall structureQualityScore missing');
  assert(typeof topOverall.structureQualityLabel === 'string' && topOverall.structureQualityLabel.length > 0, 'topCandidateOverall structureQualityLabel missing');
  assert(Array.isArray(topOverall.structureQualityReasonCodes), 'topCandidateOverall structureQualityReasonCodes missing');
  assert(typeof topOverall.structureQualitySummaryLine === 'string' && topOverall.structureQualitySummaryLine.length > 0, 'topCandidateOverall structureQualitySummaryLine missing');
  assert(Object.prototype.hasOwnProperty.call(topActionableNow, 'structureQualityScore'), 'topCandidateActionableNow structureQualityScore missing');
  assert(topActionableNow.strategyKey !== bad.key, 'negative-EV candidate should not dominate actionable-now ranking');
  assert(topOverall.strategyKey !== bad.key, 'quality penalty should demote deep negative-EV candidate from overall top slot');
  assert(topOverall.candidateExpectedValue > -50, 'overall top should avoid deep negative EV where better options exist');
  assert(Number(topActionableNow.structureQualityScore) >= 58, 'actionable-now candidate should satisfy minimum structure quality threshold');
  assert(typeof liveCandidates.actionableNowSummaryLine === 'string' && liveCandidates.actionableNowSummaryLine.length > 0, 'actionableNowSummaryLine missing');
  assert(typeof liveCandidates.summaryLine === 'string' && liveCandidates.summaryLine.length > 0, 'summaryLine missing');
  const sourceSet = new Set((Array.isArray(liveCandidates.candidates) ? liveCandidates.candidates : []).map((row) => String(row?.candidateSource || '').trim()));
  assert(sourceSet.has('strategy_stack'), 'expected strategy_stack candidate source');
  assert(sourceSet.has('decision_top_setup'), 'expected decision_top_setup candidate source');
  assert(sourceSet.has('live_structure'), 'expected live_structure candidate source');
  const goodRow = (Array.isArray(liveCandidates.candidates) ? liveCandidates.candidates : []).find((row) => String(row?.strategyKey || '') === good.key);
  const badRow = (Array.isArray(liveCandidates.candidates) ? liveCandidates.candidates : []).find((row) => String(row?.strategyKey || '') === bad.key);
  assert(goodRow && badRow, 'expected both good and bad strategy rows in candidate list');
  assert(typeof goodRow.structureQualitySummaryLine === 'string' && goodRow.structureQualitySummaryLine.length > 0, 'good row should expose structure quality summary');
  assert(typeof badRow.structureQualitySummaryLine === 'string' && badRow.structureQualitySummaryLine.length > 0, 'bad row should expose structure quality summary');

  const poorStructureCenter = buildCommandCenterPanels({
    strategyLayers,
    decision: {
      signal: 'WAIT',
      signalLabel: 'WAIT',
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability: 0.39,
        expectedValueDollars: -35,
        annualizedTrades: 120,
      }],
    },
    latestSession: {
      no_trade_reason: 'no_confirmation',
    },
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
  assert(poorStructureCenter.liveOpportunityCandidates && typeof poorStructureCenter.liveOpportunityCandidates === 'object', 'poor structure case candidates missing');
  assert(poorStructureCenter.liveOpportunityCandidates.hasActionableCandidateNow === false, 'poor structure case should block actionable-now candidate');
  assert(poorStructureCenter.liveOpportunityCandidates.topCandidateActionableNow === null, 'poor structure case should not expose actionable-now row');
  assert(['poor_structure', 'no_clean_retest', 'weak_follow_through', 'blocked_context'].includes(String(poorStructureCenter.liveOpportunityCandidates.noActionableReasonCode || '')), 'poor structure case should expose sharp structure-based no-actionable reason');
  assert(poorStructureCenter.shadowMockTradeDecision && poorStructureCenter.shadowMockTradeDecision.eligible === false, 'poor structure case should keep mock-trade ineligible');

  const transitionState = { candidateStates: Object.create(null), lastSnapshotAt: null, lastActionableTransition: null };
  const transitionPoor = buildCommandCenterPanels({
    strategyLayers,
    liveCandidateStateMonitorState: transitionState,
    decision: {
      signal: 'WAIT',
      signalLabel: 'WAIT',
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability: 0.4,
        expectedValueDollars: -20,
        annualizedTrades: 90,
      }],
    },
    latestSession: { no_trade_reason: 'no_confirmation' },
    todayContext: {
      nowEt: '2026-04-16 10:10',
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
  assert(transitionPoor.liveCandidateStateMonitor && transitionPoor.liveCandidateStateMonitor.actionableTransitionDetected === false, 'first poor snapshot should not fire actionable transition');
  assert(transitionPoor.liveOpportunityCandidates.hasActionableCandidateNow === false, 'first poor snapshot should remain non-actionable');
  assert(transitionPoor.liveCandidateTransitionHistory && typeof transitionPoor.liveCandidateTransitionHistory === 'object', 'first poor snapshot missing transition history');
  assert(Array.isArray(transitionPoor.liveCandidateTransitionHistory.recentTransitions) && transitionPoor.liveCandidateTransitionHistory.recentTransitions.length === 0, 'first poor snapshot should not emit transition rows');
  assert(transitionPoor.liveCandidateTransitionHistory.latestTransition === null, 'first poor snapshot latestTransition should be null');

  const transitionGood = buildCommandCenterPanels({
    strategyLayers,
    liveCandidateStateMonitorState: transitionState,
    decision: {
      signal: 'TRADE',
      signalLabel: 'TRADE',
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability: 0.79,
        expectedValueDollars: 72,
        annualizedTrades: 170,
      }],
    },
    latestSession: {
      trade: {
        direction: 'long',
        entry_price: 22140,
        sl_price: 22095,
        tp_price: 22200,
        entry_time: '2026-04-16 10:12',
      },
    },
    todayContext: {
      nowEt: '2026-04-16 10:12',
      sessionPhase: 'entry_window',
      timeBucket: 'entry_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
    commandSnapshot: {
      elite: {
        winModel: { point: 60.4, confidencePct: 71 },
      },
    },
  });
  assert(transitionGood.liveCandidateStateMonitor && transitionGood.liveCandidateStateMonitor.actionableTransitionDetected === true, 'improved structure snapshot should fire actionable transition');
  assert(typeof transitionGood.liveCandidateStateMonitor.candidateKey === 'string' && transitionGood.liveCandidateStateMonitor.candidateKey.length > 0, 'actionable transition should include candidate key');
  assert(transitionGood.liveCandidateTransitionHistory && typeof transitionGood.liveCandidateTransitionHistory === 'object', 'improved snapshot missing transition history');
  assert(Array.isArray(transitionGood.liveCandidateTransitionHistory.recentTransitions) && transitionGood.liveCandidateTransitionHistory.recentTransitions.length >= 1, 'improved snapshot should emit at least one transition row');
  const latestTransition = transitionGood.liveCandidateTransitionHistory.latestTransition;
  assert(latestTransition && typeof latestTransition === 'object', 'improved snapshot should include latest transition row');
  assert(latestTransition.transitionType === 'crossed_into_actionable', 'improved snapshot should classify crossed_into_actionable');
  assert(latestTransition.previousActionable === false && latestTransition.currentActionable === true, 'improved snapshot transition should capture actionable cross');
  assert(transitionGood.shadowMockTradeDecision && transitionGood.shadowMockTradeDecision.eligible === true, 'actionable transition should allow shadow mock trade');
  assert(transitionGood.shadowMockTradeDecision.triggeredByActionableTransition === true, 'mock trade should be marked as transition-triggered');
  assert(transitionGood.shadowMockTradeDecision.status === 'eligible_ready_transition', 'transition-triggered trade should use eligible_ready_transition status');

  const transitionPoorAgain = buildCommandCenterPanels({
    strategyLayers,
    liveCandidateStateMonitorState: transitionState,
    decision: {
      signal: 'WAIT',
      signalLabel: 'WAIT',
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability: 0.4,
        expectedValueDollars: -20,
        annualizedTrades: 90,
      }],
    },
    latestSession: { no_trade_reason: 'no_confirmation' },
    todayContext: {
      nowEt: '2026-04-16 10:18',
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
  assert(transitionPoorAgain.liveCandidateStateMonitor && transitionPoorAgain.liveCandidateStateMonitor.actionableTransitionDetected === false, 'poor structure should not create false actionable transition');
  assert(transitionPoorAgain.liveCandidateTransitionHistory && typeof transitionPoorAgain.liveCandidateTransitionHistory === 'object', 'third snapshot missing transition history');
  assert(Array.isArray(transitionPoorAgain.liveCandidateTransitionHistory.recentTransitions) && transitionPoorAgain.liveCandidateTransitionHistory.recentTransitions.length >= 2, 'third snapshot should retain persistent transition history');
  const latestAfterDrop = transitionPoorAgain.liveCandidateTransitionHistory.latestTransition;
  assert(latestAfterDrop && latestAfterDrop.transitionType === 'dropped_out_of_actionable', 'third snapshot should classify dropped_out_of_actionable');
  assert(latestAfterDrop.previousActionable === true && latestAfterDrop.currentActionable === false, 'third snapshot should capture actionable drop');

  console.log('Jarvis live opportunity actionability ranking test passed.');
}

run();
