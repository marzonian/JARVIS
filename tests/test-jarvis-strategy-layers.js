#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  ORIGINAL_PLAN_SPEC,
  buildStrategyLayerSnapshot,
  buildReplayVariantAssessment,
  buildCommandCenterPanels,
} = require('../server/jarvis-core/strategy-layers');

function candle(date, time, open, high, low, close, volume = 1000) {
  return { timestamp: `${date} ${time}`, open, high, low, close, volume, time };
}

function buildWinningSession(date) {
  return [
    candle(date, '09:30', 22100, 22120, 22095, 22115),
    candle(date, '09:35', 22115, 22130, 22110, 22125),
    candle(date, '09:40', 22125, 22135, 22105, 22120),
    candle(date, '09:45', 22120, 22132, 22118, 22130),
    candle(date, '09:50', 22130, 22142, 22128, 22138),
    candle(date, '09:55', 22138, 22145, 22136, 22142),
    candle(date, '10:00', 22142, 22143, 22134, 22140),
    candle(date, '10:05', 22140, 22141, 22137, 22139),
    candle(date, '10:10', 22139, 22150, 22138, 22148),
    candle(date, '10:15', 22148, 22160, 22146, 22158),
    candle(date, '10:20', 22158, 22170, 22155, 22168),
    candle(date, '10:25', 22168, 22180, 22165, 22178),
    candle(date, '10:30', 22178, 22190, 22176, 22188),
    candle(date, '10:35', 22188, 22205, 22185, 22198),
  ];
}

function run() {
  const sessions = {
    '2024-06-03': buildWinningSession('2024-06-03'), // Monday
    '2024-06-04': buildWinningSession('2024-06-04'),
    '2024-06-05': buildWinningSession('2024-06-05'),
  };

  const snapshot = buildStrategyLayerSnapshot(sessions, {
    includeDiscovery: false,
    context: {
      sessionPhase: 'entry_window',
      regime: 'moderate',
      volatility: 'normal',
    },
    mechanicsSummary: {
      bestTpModeRecent: 'Nearest',
      bestTpModeByWinRate: 'Nearest',
      bestTpModeByProfitFactor: 'Skip 2',
      recommendedTpMode: 'Nearest',
      recommendedTpModeReason: 'Nearest improves win rate while keeping PF in range.',
      evidenceWindowTrades: 120,
      tpModeComparisonAvailable: true,
      sampleQuality: { isThinSample: false, warnings: [] },
      originalPlanTpMode: 'Skip 2',
      originalPlanStopMode: 'rr_1_to_1_from_tp',
      advisoryOnly: true,
      contextualTpRecommendation: 'Nearest',
      contextConfidence: 'medium',
      contextConfidenceScore: 63.5,
      contextSampleSize: 26,
      contextFallbackLevel: 'drop_regime',
      contextUsed: { weekday: 'Wednesday', timeBucket: 'orb_window', regime: null },
    },
  });

  assert(snapshot && typeof snapshot === 'object', 'snapshot missing');
  assert(snapshot.layers && snapshot.layers.original, 'original layer missing');
  assert(snapshot.layers.original.key === ORIGINAL_PLAN_SPEC.key, 'original layer key mismatch');
  assert(snapshot.layers.original.rules.skipMonday === false, 'original layer must not skip Mondays');
  assert(!snapshot.layers.original.rules.filters.orbRange, 'original layer must not include ORB range filter');
  assert(snapshot.layers.original.metrics.totalTrades > 0, 'original layer should produce trades');
  assert(snapshot.originalPlan && snapshot.originalPlan.layer === 'original', 'originalPlan summary missing');
  assert(snapshot.bestVariant && snapshot.bestVariant.layer === 'variant', 'bestVariant summary missing');
  assert(snapshot.bestAlternative === null, 'bestAlternative should be null when discovery disabled');
  assert(snapshot.recommendationBasis && typeof snapshot.recommendationBasis === 'object', 'recommendationBasis missing');
  assert(['baseline', 'overlay', 'alternative'].includes(snapshot.recommendationBasis.basisType), 'invalid recommendationBasis type');
  assert(Array.isArray(snapshot.strategyStack) && snapshot.strategyStack.length >= 2, 'strategy stack should include original + variant');
  assert(snapshot.strategyStack.every((s) => typeof s.pineScript === 'string' && s.pineScript.includes('//@version=6')), 'pine export missing in strategy stack');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'bestTpModeRecent'), 'mechanicsSummary.bestTpModeRecent missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'tpModeComparisonAvailable'), 'mechanicsSummary.tpModeComparisonAvailable missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'bestTpModeByWinRate'), 'mechanicsSummary.bestTpModeByWinRate missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'bestTpModeByProfitFactor'), 'mechanicsSummary.bestTpModeByProfitFactor missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'recommendedTpMode'), 'mechanicsSummary.recommendedTpMode missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'recommendedTpModeReason'), 'mechanicsSummary.recommendedTpModeReason missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'evidenceWindowTrades'), 'mechanicsSummary.evidenceWindowTrades missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'sampleQuality'), 'mechanicsSummary.sampleQuality missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'originalPlanTpMode'), 'mechanicsSummary.originalPlanTpMode missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'originalPlanStopMode'), 'mechanicsSummary.originalPlanStopMode missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'advisoryOnly'), 'mechanicsSummary.advisoryOnly missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'contextualTpRecommendation'), 'mechanicsSummary.contextualTpRecommendation missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'contextConfidence'), 'mechanicsSummary.contextConfidence missing');
  assert(snapshot.mechanicsSummary && Object.prototype.hasOwnProperty.call(snapshot.mechanicsSummary, 'contextSampleSize'), 'mechanicsSummary.contextSampleSize missing');

  const replayAssessment = buildReplayVariantAssessment({
    replayDate: '2026-03-06',
    marketOutcome: 'win',
    strategyEligible: true,
    strategyOutcome: 'win',
    orbRangeTicks: 482,
  });
  assert(replayAssessment.originalPlanEligible === true, 'originalPlanEligible should mirror original-plan eligibility');
  assert(replayAssessment.originalPlanOutcome === 'win', 'originalPlanOutcome should mirror original outcome');
  assert(replayAssessment.variantAssessment && replayAssessment.variantAssessment.variantEligible === false, 'oversized ORB should fail variant filter');
  assert(replayAssessment.strategyVariantComparison && replayAssessment.strategyVariantComparison.changedDecision === true, 'comparison should detect changed decision');

  const commandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: { caution: 'Test caution line.', entryConditions: ['Confirm retest before entry.'] },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [{ time: '09:40', impact: 'high', title: 'CPI', country: 'US' }],
    commandSnapshot: {
      elite: {
        winModel: { point: 58.2, confidencePct: 72 },
      },
    },
    todayContext: {
      nowEt: '2026-03-07 09:35',
      sessionPhase: 'orb_window',
      regime: 'moderate volatility',
      trend: 'uptrend',
      volatility: 'normal',
      dayName: 'Wednesday',
      timeBucket: 'orb_window',
      historicalBehaviorHint: 'Wednesday session has stable follow-through.',
    },
    mechanicsResearchSummary: {
      windowSize: 120,
      bestTpModeRecent: 'Nearest',
      bestTpModeByWinRate: 'Nearest',
      bestTpModeByProfitFactor: 'Skip 2',
      mechanicsVariantTable: [
        { tpMode: 'Nearest', tradeCount: 120 },
        { tpMode: 'Skip 1', tradeCount: 120 },
        { tpMode: 'Skip 2', tradeCount: 120 },
      ],
      contextualRecommendation: {
        contextUsed: { weekday: 'Wednesday', timeBucket: 'orb_window', regime: null },
        fallbackLevel: 'drop_regime',
        sampleSize: 26,
        confidenceLabel: 'medium',
        contextualRecommendedTpMode: 'Nearest',
      },
    },
  });
  assert(commandCenter && commandCenter.jarvisBrief && commandCenter.strategyStack, 'command center panels missing');
  assert(commandCenter.layout && commandCenter.layout.decluttered === true, 'command center should expose decluttered layout');
  assert(commandCenter.highValueBrief && typeof commandCenter.highValueBrief.strategyRightNow === 'string', 'high-value brief missing');
  assert(Array.isArray(commandCenter.researchInsights), 'command center research insights missing');
  assert(commandCenter.executionLevels && commandCenter.executionLevels.orbRangeTicks === 160, 'execution levels should include ORB');
  assert(commandCenter.todayRecommendation && typeof commandCenter.todayRecommendation === 'object', 'todayRecommendation missing');
  assert(['trade_normally', 'trade_selectively', 'wait_for_news', 'wait_for_clearance', 'stand_down'].includes(String(commandCenter.todayRecommendation.posture || '')), 'todayRecommendation posture invalid');
  assert(typeof commandCenter.todayRecommendation.recommendedStrategy === 'string', 'todayRecommendation recommendedStrategy missing');
  assert(typeof commandCenter.todayRecommendation.recommendedTpMode === 'string', 'todayRecommendation recommendedTpMode missing');
  assert(['high', 'medium', 'low'].includes(String(commandCenter.todayRecommendation.confidenceLabel || '')), 'todayRecommendation confidenceLabel missing');
  assert(commandCenter.assistantDecisionBrief && typeof commandCenter.assistantDecisionBrief === 'object', 'assistantDecisionBrief missing');
  assert(typeof commandCenter.assistantDecisionBrief.actionNow === 'string' && commandCenter.assistantDecisionBrief.actionNow.length > 0, 'assistantDecisionBrief.actionNow missing');
  assert(typeof commandCenter.assistantDecisionBrief.confidence === 'string' && commandCenter.assistantDecisionBrief.confidence.length > 0, 'assistantDecisionBrief.confidence missing');
  assert(typeof commandCenter.assistantDecisionBriefText === 'string' && commandCenter.assistantDecisionBriefText.length > 0, 'assistantDecisionBriefText missing');
  assert(commandCenter.todayRecommendation.assistantDecisionBrief && typeof commandCenter.todayRecommendation.assistantDecisionBrief === 'object', 'todayRecommendation missing assistantDecisionBrief mirror');
  assert(commandCenter.todayRecommendation.assistantDecisionBriefText === commandCenter.assistantDecisionBriefText, 'todayRecommendation assistantDecisionBriefText should mirror root brief text');
  assert(!/recent miss pattern: too aggressive/i.test(String(commandCenter.assistantDecisionBriefText || '')), 'no recent too-aggressive sentinel should leave brief text unchanged');
  assert(commandCenter.jarvisBrief.originalPlanStatus && /original trading plan/i.test(commandCenter.jarvisBrief.originalPlanStatus), 'jarvis brief must frame original plan explicitly');
  assert(commandCenter.jarvisBrief.overlayStatus && /overlay/i.test(commandCenter.jarvisBrief.overlayStatus), 'jarvis brief must frame overlay explicitly');
  assert(Number.isFinite(Number(commandCenter.jarvisBrief.projectedWinChance)), 'projected win chance should be present');
  assert(commandCenter.jarvisBrief.recommendationBasisLabel && typeof commandCenter.jarvisBrief.recommendationBasisLabel === 'string', 'recommendation basis label missing');
  assert(commandCenter.jarvisBrief.nextImportantNewsTimeEt === '09:40', 'next important news time missing');
  assert(/news|delay|distort|confirm/i.test(String(commandCenter.jarvisBrief.newsRecommendationQualifier || '')), 'news qualifier narrative missing');
  assert(commandCenter.strategyStack[0] && commandCenter.strategyStack[0].tier === 'original_plan', 'strategy stack must expose original plan tier');
  assert(commandCenter.strategyStack[1] && commandCenter.strategyStack[1].tier === 'best_variant', 'strategy stack must expose best variant tier');
  assert(commandCenter.strategyStack.every((row) => typeof row.recommendationStatus === 'string'), 'strategy recommendation status missing');
  assert(commandCenter.strategyStack.every((row) => row.pineAccess && /\/api\/jarvis\/strategy\/pine\?/.test(String(row.pineAccess.endpoint || ''))), 'pine access contract missing');
  assert(commandCenter.todayContext && commandCenter.todayContext.historicalDayTime && commandCenter.todayContext.historicalDayTime.originalPlan, 'historical day/time context missing');
  assert(typeof commandCenter.mechanicsInsight === 'string' && commandCenter.mechanicsInsight.length > 0, 'command center mechanics insight missing');
  assert(typeof commandCenter.contextualMechanicsInsight === 'string' && commandCenter.contextualMechanicsInsight.length > 0, 'command center contextual mechanics insight missing');
  assert(['high', 'medium', 'low'].includes(String(commandCenter.contextualMechanicsConfidence || '')), 'command center contextual mechanics confidence missing');
  assert(commandCenter.researchInsights.some((line) => /mechanics research/i.test(String(line))), 'research insights should include mechanics insight line');

  const aggressiveSentinelCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: { caution: 'Sentinel check.', entryConditions: ['Confirm retest before entry.'] },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [{ time: '09:40', impact: 'high', title: 'CPI', country: 'US' }],
    commandSnapshot: {
      elite: {
        winModel: { point: 58.2, confidencePct: 72 },
      },
    },
    todayContext: {
      nowEt: '2026-03-18 09:35',
      sessionPhase: 'orb_window',
      regime: 'moderate volatility',
      trend: 'uptrend',
      volatility: 'normal',
      dayName: 'Thursday',
      timeBucket: 'orb_window',
      historicalBehaviorHint: 'Thursday session has stable follow-through.',
    },
    mechanicsResearchSummary: {
      windowSize: 120,
      bestTpModeRecent: 'Nearest',
      bestTpModeByWinRate: 'Nearest',
      bestTpModeByProfitFactor: 'Skip 2',
      mechanicsVariantTable: [
        { tpMode: 'Nearest', tradeCount: 120 },
        { tpMode: 'Skip 1', tradeCount: 120 },
        { tpMode: 'Skip 2', tradeCount: 120 },
      ],
      contextualRecommendation: {
        contextUsed: { weekday: 'Wednesday', timeBucket: 'orb_window', regime: null },
        fallbackLevel: 'drop_regime',
        sampleSize: 26,
        confidenceLabel: 'medium',
        contextualRecommendedTpMode: 'Nearest',
      },
    },
    recentTooAggressiveCheckpoint: {
      tradeDate: '2026-03-17',
      classification: 'too_aggressive',
      blockerState: 'clear',
      posture: 'trade_normally',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 70.22,
      frontLineActionNow: 'Trade selectively.',
    },
  });
  assert(aggressiveSentinelCommandCenter?.recentAggressiveMissSentinel, 'command center should surface recent aggressive miss sentinel');
  assert(aggressiveSentinelCommandCenter?.todayRecommendation?.recentAggressiveMissSentinel, 'todayRecommendation should surface recent aggressive miss sentinel');
  assert(
    /recent miss pattern: too aggressive/i.test(String(aggressiveSentinelCommandCenter?.assistantDecisionBriefText || '')),
    'recent too-aggressive checkpoint should trigger sentinel note in assistant brief'
  );
  assert(
    /clear state, trade normally, skip 2, medium \(70.22\) confidence/i.test(String(aggressiveSentinelCommandCenter?.assistantDecisionBriefText || '')),
    'sentinel note should include blocker/posture/tp/confidence context'
  );

  const guardedCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      caution: 'Guard test caution.',
      warnings: ['Top setup scorecard is sample-limited; reduce confidence and size.'],
    },
    latestSession: { orb: { high: 25000, low: 24618, range_ticks: 382 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 57.35, confidencePct: 64 },
      },
    },
    todayContext: {
      nowEt: '2026-03-16 19:19',
      sessionPhase: 'outside_window',
      regime: 'ranging',
      trend: 'ranging',
      volatility: 'extreme',
      regimeDetection: {
        regimeLabel: 'ranging',
        confidenceLabel: 'high',
        confidenceScore: 75,
        evidenceSignals: {
          trendProfile: 'ranging',
          volatilityProfile: 'extreme',
          orbProfile: 'wide',
          orbRangeTicks: 382,
        },
      },
    },
    mechanicsResearchSummary: {
      windowSize: 120,
      bestTpModeRecent: 'Skip 2',
      bestTpModeByWinRate: 'Skip 2',
      bestTpModeByProfitFactor: 'Skip 2',
      recommendedTpMode: 'Skip 2',
      mechanicsVariantTable: [
        { tpMode: 'Nearest', tradeCount: 120 },
        { tpMode: 'Skip 1', tradeCount: 120 },
        { tpMode: 'Skip 2', tradeCount: 120 },
      ],
      contextualRecommendation: {
        contextUsed: { weekday: 'Monday', timeBucket: 'late_window', regime: null },
        fallbackLevel: 'global',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Skip 2',
      },
    },
  });
  assert(guardedCommandCenter?.todayRecommendation?.recommendedTpMode === 'Nearest', 'strategy-layer wiring should allow TP guard to cap fallback/global Skip 2');
  assert(guardedCommandCenter?.todayRecommendation?.posture === 'wait_for_clearance', 'strategy-layer wiring should downgrade posture when fallback/global context is high-risk with mixed confirmation');
  assert(/guardrail override/i.test(String(guardedCommandCenter?.todayRecommendation?.tpRecommendationReason || '')), 'guarded recommendation reason should mention guardrail override');
  assert(guardedCommandCenter?.assistantDecisionBrief?.actionNow === 'Wait for clearance.', 'no-blocker cautious case should produce wait-for-clearance action brief');
  assert(!guardedCommandCenter?.assistantDecisionBrief?.blockedBy, 'no-blocker cautious case should not fabricate blocker guidance');

  const waitBlockedCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      signalLabel: 'WAIT',
      blockers: ['prob_green_below_50'],
      warnings: [],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 53.46, confidencePct: 62 },
        outcome: {
          distribution: {
            probGreen: 45.73,
          },
        },
      },
    },
    todayContext: {
      nowEt: '2026-03-17 08:55',
      sessionPhase: 'pre_open',
      regime: 'mixed',
      trend: 'ranging',
      volatility: 'normal',
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
      contextualRecommendation: {
        contextUsed: { weekday: 'Tuesday', timeBucket: 'pre_open', regime: null },
        fallbackLevel: 'global',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Skip 2',
      },
    },
  });
  assert(waitBlockedCommandCenter?.todayRecommendation?.posture === 'wait_for_clearance', 'WAIT + blocker should force wait_for_clearance posture');
  assert(waitBlockedCommandCenter?.todayRecommendation?.recommendedTpMode === 'Nearest', 'WAIT + blocker should cap aggressive TP to Nearest');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLineBlockerGateApplied === true, 'WAIT + blocker should mark blocker gate applied');
  assert(/front-line blocker authority active/i.test(String(waitBlockedCommandCenter?.todayRecommendation?.postureReason || '')), 'WAIT + blocker reason should reference front-line blocker authority');
  assert(Array.isArray(waitBlockedCommandCenter?.todayRecommendation?.frontLineBlockerClearanceGuidance), 'WAIT + blocker should expose blocker clearance guidance');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.blockerCode === 'prob_green_below_50', 'WAIT + blocker primary guidance should target known blocker code');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.mapped === true, 'known blocker should map to deterministic clearance guidance');
  assert(/confidence support|below the line/i.test(String(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.blockedBy || '').toLowerCase()), 'known blocker guidance should describe what is blocking the trade');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.currentValue === 45.73, 'known blocker guidance should expose current value from runtime truth');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.threshold === 50, 'known blocker guidance should expose threshold');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.deltaToClear === 4.27, 'known blocker guidance should expose numeric delta to clearance');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.clearanceState === 'far_from_clearance', 'known blocker guidance should classify clearance state');
  assert(/check again|re-check/i.test(String(waitBlockedCommandCenter?.todayRecommendation?.frontLineBlockerClearanceSummary || '').toLowerCase()), 'clearance summary should include when to re-check');
  assert(/current vs clear: 45.73 vs 50/i.test(String(waitBlockedCommandCenter?.todayRecommendation?.frontLineBlockerClearanceSummary || '')), 'clearance summary should include current vs clear');
  assert(/need \+4.27/i.test(String(waitBlockedCommandCenter?.todayRecommendation?.frontLineBlockerClearanceSummary || '')), 'clearance summary should include needed move to clear');
  assert(waitBlockedCommandCenter?.assistantDecisionBrief?.actionNow === 'Wait for clearance.', 'blocked WAIT case should surface wait-for-clearance action');
  assert(/current vs clear: 45.73 vs 50/i.test(String(waitBlockedCommandCenter?.assistantDecisionBrief?.assistantText || '').toLowerCase()), 'blocked WAIT assistant brief should include numeric current-vs-clear guidance');
  assert(Array.isArray(waitBlockedCommandCenter?.assistantDecisionBrief?.assistantLines), 'assistant brief should include deterministic line array');
  assert(waitBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.nextCheckWindow === 'Re-check at open and on the next decision refresh.', 'existing quantified blocker should keep deterministic next-check guidance');

  const noTradeBlockedCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      signalLabel: "DON'T TRADE",
      blockers: ['prob_green_below_50'],
      warnings: [],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 53.46, confidencePct: 62 },
      },
    },
    todayContext: {
      nowEt: '2026-03-17 08:55',
      sessionPhase: 'pre_open',
      regime: 'mixed',
      trend: 'ranging',
      volatility: 'normal',
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
      contextualRecommendation: {
        contextUsed: { weekday: 'Tuesday', timeBucket: 'pre_open', regime: null },
        fallbackLevel: 'global',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Skip 2',
      },
    },
  });
  assert(noTradeBlockedCommandCenter?.todayRecommendation?.posture === 'stand_down', 'NO_TRADE + blocker should force stand_down posture');
  assert(noTradeBlockedCommandCenter?.todayRecommendation?.recommendedTpMode === 'Nearest', 'NO_TRADE + blocker should cap aggressive TP to Nearest');
  assert(noTradeBlockedCommandCenter?.todayRecommendation?.frontLineBlockerGateSignal === 'NO_TRADE', 'NO_TRADE gate signal should be normalized');

  const unknownBlockedCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      signalLabel: 'WAIT',
      blockers: ['mystery_gate_unmapped'],
      warnings: [],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 53.46, confidencePct: 62 },
      },
    },
    todayContext: {
      nowEt: '2026-03-17 08:55',
      sessionPhase: 'pre_open',
      regime: 'mixed',
      trend: 'ranging',
      volatility: 'normal',
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
      contextualRecommendation: {
        contextUsed: { weekday: 'Tuesday', timeBucket: 'pre_open', regime: null },
        fallbackLevel: 'global',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Skip 2',
      },
    },
  });
  assert(unknownBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.mapped === false, 'unknown blocker should degrade gracefully with mapped=false');
  assert(/something is still blocking/i.test(String(unknownBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.blockedBy || '').toLowerCase()), 'unknown blocker guidance should still explain what is blocking');
  assert(/mystery gate unmapped/i.test(String(unknownBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.blockedBy || '').toLowerCase()), 'unknown blocker guidance should include normalized blocker hint');
  assert(unknownBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.currentValue == null, 'unknown blocker should remain qualitative and not force numeric fields');
  assert(unknownBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.deltaToClear == null, 'unknown blocker should not fabricate clearance delta');
  assert(unknownBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance?.clearanceCondition === 'Do not trade until this blocker is cleared on the next decision check.', 'unknown blocker fallback contract should remain intact');

  const rangeOverextendedBlockedCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      signalLabel: 'WAIT',
      blockers: ['RANGE OVEREXTENDED'],
      warnings: [],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 53.46, confidencePct: 62 },
      },
    },
    todayContext: {
      nowEt: '2026-03-17 08:55',
      sessionPhase: 'pre_open',
      regime: 'mixed',
      trend: 'ranging',
      volatility: 'normal',
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
      contextualRecommendation: {
        contextUsed: { weekday: 'Tuesday', timeBucket: 'pre_open', regime: null },
        fallbackLevel: 'global',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Skip 2',
      },
    },
  });
  const rangeGuidance = rangeOverextendedBlockedCommandCenter?.todayRecommendation?.frontLinePrimaryBlockerGuidance || {};
  assert(rangeGuidance?.mapped === true, 'RANGE OVEREXTENDED should map to deterministic blocker guidance');
  assert(/stretched at the edge of the range/i.test(String(rangeGuidance?.blockedBy || '').toLowerCase()), 'RANGE OVEREXTENDED guidance should explain the block clearly');
  assert(/rotates back inside the range/i.test(String(rangeGuidance?.clearanceCondition || '').toLowerCase()), 'RANGE OVEREXTENDED guidance should provide clear clearance condition');
  assert(rangeGuidance?.nextCheckWindow === 'Re-check at open for a clean rotation back inside range.', 'RANGE OVEREXTENDED guidance should provide deterministic re-check cue');
  assert(/fakeout|snapback/i.test(String(rangeGuidance?.riskIfIgnored || '').toLowerCase()), 'RANGE OVEREXTENDED guidance should include concise risk-if-ignored');

  const tradeNoBlockerCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      signalLabel: 'TRADE',
      blockers: [],
      warnings: [],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 58.2, confidencePct: 70 },
      },
    },
    todayContext: {
      nowEt: '2026-03-17 08:55',
      sessionPhase: 'pre_open',
      regime: 'mixed',
      trend: 'ranging',
      volatility: 'normal',
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
      contextualRecommendation: {
        contextUsed: { weekday: 'Tuesday', timeBucket: 'pre_open', regime: null },
        fallbackLevel: 'global',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Skip 2',
      },
    },
  });
  assert(tradeNoBlockerCommandCenter?.todayRecommendation?.recommendedTpMode === 'Skip 2', 'TRADE without blocker should keep TP recommendation unchanged');
  assert(tradeNoBlockerCommandCenter?.todayRecommendation?.frontLineBlockerGateApplied !== true, 'TRADE without blocker should not apply blocker gate');
  assert(!['wait_for_clearance', 'stand_down'].includes(String(tradeNoBlockerCommandCenter?.todayRecommendation?.posture || '')), 'TRADE without blocker should not be forcibly downgraded by blocker gate');
  assert(!tradeNoBlockerCommandCenter?.todayRecommendation?.frontLineBlockerClearanceGuidance, 'TRADE without blocker should not add blocker clearance guidance');
  assert(!tradeNoBlockerCommandCenter?.todayRecommendation?.frontLineBlockerClearanceSummary, 'TRADE without blocker should leave blocker clearance summary unchanged');
  assert(tradeNoBlockerCommandCenter?.assistantDecisionBrief?.actionNow === 'Trade selectively.', 'clear TRADE case should produce trade-selectively action brief');
  assert(/if it clears:/i.test(String(tradeNoBlockerCommandCenter?.assistantDecisionBrief?.assistantText || '').toLowerCase()), 'clear TRADE brief should include if-it-clears guidance');

  const alreadyDefensiveCommandCenter = buildCommandCenterPanels({
    strategyLayers: snapshot,
    decision: {
      signalLabel: 'WAIT',
      blockers: ['prob_green_below_50'],
      warnings: [],
    },
    latestSession: { orb: { high: 22135, low: 22095, range_ticks: 160 } },
    news: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 40, confidencePct: 55 },
      },
    },
    todayContext: {
      nowEt: '2026-03-17 08:55',
      sessionPhase: 'pre_open',
      regime: 'mixed',
      trend: 'ranging',
      volatility: 'normal',
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Nearest',
      contextualRecommendation: {
        contextUsed: { weekday: 'Tuesday', timeBucket: 'pre_open', regime: null },
        fallbackLevel: 'exact_context',
        sampleSize: 120,
        confidenceLabel: 'high',
        contextualRecommendedTpMode: 'Nearest',
      },
    },
  });
  assert(alreadyDefensiveCommandCenter?.todayRecommendation?.posture === 'stand_down', 'already-defensive posture should be preserved');
  assert(alreadyDefensiveCommandCenter?.todayRecommendation?.recommendedTpMode === 'Nearest', 'already-defensive TP should remain unchanged');
  assert(alreadyDefensiveCommandCenter?.todayRecommendation?.frontLineBlockerGateApplied !== true, 'already-defensive recommendation should not be mutated by blocker gate');
  assert(!/front-line blocker authority active/i.test(String(alreadyDefensiveCommandCenter?.todayRecommendation?.postureReason || '')), 'already-defensive posture reason should not be rewritten');

  console.log('All jarvis strategy layer tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`Strategy layer test failed: ${err.message}`);
  process.exit(1);
}
