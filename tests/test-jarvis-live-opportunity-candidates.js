#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildStrategyLayerSnapshot,
  buildCommandCenterPanels,
} = require('../server/jarvis-core/strategy-layers');

function candle(date, time, open, high, low, close, volume = 1000) {
  return { timestamp: `${date} ${time}`, time, open, high, low, close, volume };
}

function buildSession(date) {
  return [
    candle(date, '09:30', 22100, 22122, 22096, 22114),
    candle(date, '09:35', 22114, 22128, 22108, 22124),
    candle(date, '09:40', 22124, 22135, 22110, 22118),
    candle(date, '09:45', 22118, 22133, 22114, 22130),
    candle(date, '09:50', 22130, 22142, 22120, 22136),
    candle(date, '09:55', 22136, 22149, 22129, 22144),
    candle(date, '10:00', 22144, 22154, 22135, 22140),
    candle(date, '10:05', 22140, 22155, 22133, 22150),
    candle(date, '10:10', 22150, 22166, 22145, 22158),
    candle(date, '10:15', 22158, 22174, 22152, 22166),
    candle(date, '10:20', 22166, 22182, 22160, 22174),
    candle(date, '10:25', 22174, 22190, 22169, 22183),
    candle(date, '10:30', 22183, 22200, 22177, 22194),
    candle(date, '10:35', 22194, 22212, 22188, 22205),
  ];
}

function run() {
  const sessions = {
    '2026-04-10': buildSession('2026-04-10'),
    '2026-04-13': buildSession('2026-04-13'),
    '2026-04-14': buildSession('2026-04-14'),
    '2026-04-15': buildSession('2026-04-15'),
    '2026-04-16': buildSession('2026-04-16'),
  };
  const strategyLayers = buildStrategyLayerSnapshot(sessions, {
    includeDiscovery: false,
    context: {
      nowEt: '2026-04-16 14:35',
      sessionPhase: 'outside_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 182,
    },
  });
  const commandCenter = buildCommandCenterPanels({
    strategyLayers,
    decision: {
      signal: 'WAIT',
      signalLabel: 'WAIT',
      blockers: [],
      entryConditions: ['Need clean retest and re-break confirmation.'],
      topSetups: [
        {
          setupId: 'orb_retest_long',
          name: 'ORB Retest Long',
          probability: 0.61,
          expectedValueDollars: 52.5,
          annualizedTrades: 188,
        },
      ],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    commandSnapshot: {
      elite: {
        winModel: { point: 57.2, confidencePct: 68 },
      },
    },
    todayContext: {
      nowEt: '2026-04-16 14:35',
      sessionPhase: 'outside_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 182,
      dayName: 'Thursday',
      timeBucket: 'late_window',
    },
  });

  assert(commandCenter.liveOpportunityCandidates && typeof commandCenter.liveOpportunityCandidates === 'object', 'liveOpportunityCandidates missing');
  assert(Array.isArray(commandCenter.liveOpportunityCandidates.candidates), 'liveOpportunityCandidates.candidates missing');
  assert(commandCenter.liveOpportunityCandidates.candidates.length >= 2, 'liveOpportunityCandidates should include rows for visible strategies');
  assert(typeof commandCenter.liveOpportunityCandidates.topCandidateKey === 'string' && commandCenter.liveOpportunityCandidates.topCandidateKey.length > 0, 'topCandidateKey missing');
  assert(commandCenter.liveOpportunityCandidates.topCandidateOverall && typeof commandCenter.liveOpportunityCandidates.topCandidateOverall === 'object', 'topCandidateOverall missing');
  assert(commandCenter.liveOpportunityCandidates.topCandidateActionableNow === null || typeof commandCenter.liveOpportunityCandidates.topCandidateActionableNow === 'object', 'topCandidateActionableNow should be object|null');
  assert(typeof commandCenter.liveOpportunityCandidates.hasActionableCandidateNow === 'boolean', 'hasActionableCandidateNow missing');
  assert(typeof commandCenter.liveOpportunityCandidates.actionableNowSummaryLine === 'string' && commandCenter.liveOpportunityCandidates.actionableNowSummaryLine.length > 0, 'actionableNowSummaryLine missing');
  assert(Object.prototype.hasOwnProperty.call(commandCenter.liveOpportunityCandidates, 'noActionableReasonCode'), 'noActionableReasonCode missing');
  assert(Object.prototype.hasOwnProperty.call(commandCenter.liveOpportunityCandidates, 'noActionableReasonLine'), 'noActionableReasonLine missing');
  assert(commandCenter.liveOpportunityCandidates.candidateSourceCounts && typeof commandCenter.liveOpportunityCandidates.candidateSourceCounts === 'object', 'candidateSourceCounts missing');
  assert(typeof commandCenter.liveOpportunityCandidates.candidateDiversitySummaryLine === 'string' && commandCenter.liveOpportunityCandidates.candidateDiversitySummaryLine.length > 0, 'candidateDiversitySummaryLine missing');
  assert(typeof commandCenter.liveOpportunityCandidates.summaryLine === 'string' && commandCenter.liveOpportunityCandidates.summaryLine.length > 0, 'liveOpportunityCandidates summaryLine missing');

  const topCandidate = commandCenter.liveOpportunityCandidates.candidates[0];
  assert(topCandidate && typeof topCandidate === 'object', 'top candidate missing');
  assert(typeof topCandidate.candidateSource === 'string' && topCandidate.candidateSource.length > 0, 'candidateSource missing on top candidate');
  assert(topCandidate.timeBucket === 'next_session_setup', 'outside_window should map to next_session_setup instead of stale late_window');
  assert(typeof topCandidate.candidateSummaryLine === 'string' && topCandidate.candidateSummaryLine.length > 0, 'candidateSummaryLine missing');
  assert(Object.prototype.hasOwnProperty.call(topCandidate, 'structureQualityScore'), 'structureQualityScore missing');
  assert(typeof topCandidate.structureQualityLabel === 'string' && topCandidate.structureQualityLabel.length > 0, 'structureQualityLabel missing');
  assert(Array.isArray(topCandidate.structureQualityReasonCodes), 'structureQualityReasonCodes missing');
  assert(typeof topCandidate.structureQualitySummaryLine === 'string' && topCandidate.structureQualitySummaryLine.length > 0, 'structureQualitySummaryLine missing');
  assert(Object.prototype.hasOwnProperty.call(topCandidate, 'candidateWinProb'), 'candidateWinProb missing');
  assert(Object.prototype.hasOwnProperty.call(topCandidate, 'candidateExpectedValue'), 'candidateExpectedValue missing');
  assert(typeof topCandidate.candidateCalibrationBand === 'string' && topCandidate.candidateCalibrationBand.length > 0, 'candidateCalibrationBand missing');
  assert(topCandidate.candidateFeatureVector && typeof topCandidate.candidateFeatureVector === 'object', 'candidateFeatureVector missing');
  assert(typeof topCandidate.candidateScoreSummaryLine === 'string' && topCandidate.candidateScoreSummaryLine.length > 0, 'candidateScoreSummaryLine missing');
  assert(Object.prototype.hasOwnProperty.call(topCandidate, 'candidateQualityPenalty'), 'candidateQualityPenalty missing');
  assert(Array.isArray(topCandidate.candidateQualityReasonCodes), 'candidateQualityReasonCodes missing');
  assert(commandCenter.liveOpportunityCandidates.topCandidateActionableNow === null, 'outside_window should not expose actionable now candidate');
  assert(commandCenter.liveOpportunityCandidates.hasActionableCandidateNow === false, 'outside_window should report hasActionableCandidateNow=false');
  assert(
    ['outside_actionable_window', 'blocked_context', 'weak_expected_value', 'no_clean_trigger', 'bad_market_structure', 'no_strong_live_candidate', 'poor_structure', 'overextended_move', 'no_clean_retest', 'weak_follow_through'].includes(String(commandCenter.liveOpportunityCandidates.noActionableReasonCode || '')),
    'outside_window should provide an honest no-actionable reason code'
  );

  const sourceSet = new Set(commandCenter.liveOpportunityCandidates.candidates.map((row) => String(row?.candidateSource || '').trim()));
  assert(sourceSet.has('strategy_stack'), 'candidate list should include strategy_stack source');
  assert(sourceSet.has('decision_top_setup'), 'candidate list should include decision_top_setup source');
  assert(sourceSet.has('live_structure'), 'candidate list should include live_structure source');
  const hasStructureFieldsOnAll = commandCenter.liveOpportunityCandidates.candidates.every((row) => (
    Object.prototype.hasOwnProperty.call(row, 'structureQualityScore')
    && typeof row.structureQualityLabel === 'string'
    && Array.isArray(row.structureQualityReasonCodes)
    && typeof row.structureQualitySummaryLine === 'string'
  ));
  assert(hasStructureFieldsOnAll, 'all candidates should expose structure quality fields');

  assert(commandCenter.strategyCandidateOpportunityBridge && typeof commandCenter.strategyCandidateOpportunityBridge === 'object', 'strategyCandidateOpportunityBridge missing');
  assert(['agree', 'disagree'].includes(String(commandCenter.strategyCandidateOpportunityBridge.status || '')), 'strategyCandidateOpportunityBridge status invalid');
  assert(commandCenter.liveCandidateStateMonitor && typeof commandCenter.liveCandidateStateMonitor === 'object', 'liveCandidateStateMonitor missing');
  assert(Array.isArray(commandCenter.liveCandidateStateMonitor.monitoredCandidates), 'liveCandidateStateMonitor.monitoredCandidates missing');
  assert(typeof commandCenter.liveCandidateStateMonitor.actionableTransitionDetected === 'boolean', 'liveCandidateStateMonitor.actionableTransitionDetected missing');
  assert(typeof commandCenter.liveCandidateStateMonitor.actionableTransitionReason === 'string' && commandCenter.liveCandidateStateMonitor.actionableTransitionReason.length > 0, 'liveCandidateStateMonitor.actionableTransitionReason missing');
  assert(typeof commandCenter.liveCandidateStateMonitor.summaryLine === 'string' && commandCenter.liveCandidateStateMonitor.summaryLine.length > 0, 'liveCandidateStateMonitor.summaryLine missing');
  assert(commandCenter.liveCandidateTransitionHistory && typeof commandCenter.liveCandidateTransitionHistory === 'object', 'liveCandidateTransitionHistory missing');
  assert(Array.isArray(commandCenter.liveCandidateTransitionHistory.recentTransitions), 'liveCandidateTransitionHistory.recentTransitions missing');
  assert(Object.prototype.hasOwnProperty.call(commandCenter.liveCandidateTransitionHistory, 'latestTransition'), 'liveCandidateTransitionHistory.latestTransition missing');
  assert(typeof commandCenter.liveCandidateTransitionHistory.summaryLine === 'string' && commandCenter.liveCandidateTransitionHistory.summaryLine.length > 0, 'liveCandidateTransitionHistory.summaryLine missing');
  assert(commandCenter.shadowMockTradeDecision && typeof commandCenter.shadowMockTradeDecision === 'object', 'shadowMockTradeDecision missing');
  assert(commandCenter.shadowMockTradeLedger && typeof commandCenter.shadowMockTradeLedger === 'object', 'shadowMockTradeLedger missing');
  assert(typeof commandCenter.shadowMockTradeDecision.tradePlanSummaryLine === 'string' && commandCenter.shadowMockTradeDecision.tradePlanSummaryLine.length > 0, 'shadowMockTradeDecision tradePlanSummaryLine missing');
  assert(typeof commandCenter.shadowMockTradeLedger.summaryLine === 'string' && commandCenter.shadowMockTradeLedger.summaryLine.length > 0, 'shadowMockTradeLedger summaryLine missing');
  assert(commandCenter.todayRecommendation.liveOpportunityCandidates && typeof commandCenter.todayRecommendation.liveOpportunityCandidates === 'object', 'todayRecommendation mirror missing liveOpportunityCandidates');
  assert(commandCenter.decisionBoard.liveOpportunityCandidates && typeof commandCenter.decisionBoard.liveOpportunityCandidates === 'object', 'decisionBoard mirror missing liveOpportunityCandidates');
  assert(commandCenter.todayRecommendation.liveCandidateStateMonitor && typeof commandCenter.todayRecommendation.liveCandidateStateMonitor === 'object', 'todayRecommendation mirror missing liveCandidateStateMonitor');
  assert(commandCenter.decisionBoard.liveCandidateStateMonitor && typeof commandCenter.decisionBoard.liveCandidateStateMonitor === 'object', 'decisionBoard mirror missing liveCandidateStateMonitor');
  assert(commandCenter.todayRecommendation.liveCandidateTransitionHistory && typeof commandCenter.todayRecommendation.liveCandidateTransitionHistory === 'object', 'todayRecommendation mirror missing liveCandidateTransitionHistory');
  assert(commandCenter.decisionBoard.liveCandidateTransitionHistory && typeof commandCenter.decisionBoard.liveCandidateTransitionHistory === 'object', 'decisionBoard mirror missing liveCandidateTransitionHistory');
  assert(commandCenter.todayRecommendation.shadowMockTradeDecision && typeof commandCenter.todayRecommendation.shadowMockTradeDecision === 'object', 'todayRecommendation mirror missing shadowMockTradeDecision');
  assert(commandCenter.decisionBoard.shadowMockTradeLedger && typeof commandCenter.decisionBoard.shadowMockTradeLedger === 'object', 'decisionBoard mirror missing shadowMockTradeLedger');

  console.log('Jarvis live opportunity candidates test passed.');
}

run();
