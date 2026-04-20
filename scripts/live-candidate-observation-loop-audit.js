#!/usr/bin/env node
/* eslint-disable no-console */

const Database = require('better-sqlite3');
const { startAuditServer } = require('../tests/jarvis-audit-common');
const {
  buildStrategyLayerSnapshot,
  buildCommandCenterPanels,
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
} = require('../server/jarvis-core/strategy-layers');

const TIMEOUT_MS = 180000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(baseUrl, endpoint) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function pullStatus(payload = {}) {
  return payload?.liveCandidateObservationLoopStatus
    && typeof payload.liveCandidateObservationLoopStatus === 'object'
    ? payload.liveCandidateObservationLoopStatus
    : {};
}

function candle(date, time, open, high, low, close, volume = 1000) {
  return { timestamp: `${date} ${time}`, time, open, high, low, close, volume };
}

function buildSession(date) {
  return [
    candle(date, '09:30', 22100, 22120, 22095, 22110),
    candle(date, '09:35', 22110, 22128, 22106, 22122),
    candle(date, '09:40', 22122, 22134, 22112, 22116),
    candle(date, '09:45', 22116, 22132, 22114, 22130),
    candle(date, '09:50', 22130, 22145, 22124, 22140),
    candle(date, '09:55', 22140, 22155, 22134, 22148),
    candle(date, '10:00', 22148, 22163, 22143, 22158),
    candle(date, '10:05', 22158, 22175, 22152, 22170),
    candle(date, '10:10', 22170, 22184, 22164, 22180),
    candle(date, '10:15', 22180, 22195, 22172, 22190),
  ];
}

function buildStrategyLayers() {
  const sessions = {
    '2026-04-10': buildSession('2026-04-10'),
    '2026-04-13': buildSession('2026-04-13'),
    '2026-04-14': buildSession('2026-04-14'),
    '2026-04-15': buildSession('2026-04-15'),
    '2026-04-16': buildSession('2026-04-16'),
  };
  return buildStrategyLayerSnapshot(sessions, {
    includeDiscovery: false,
    context: {
      nowEt: '2026-04-16 10:10',
      sessionPhase: 'entry_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
  });
}

function buildSyntheticInput({ db, nowEt = '2026-04-16 10:10', persistLiveCandidateState = true, observationWriteSource = LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC } = {}) {
  return {
    strategyLayers: buildStrategyLayers(),
    liveCandidateStateMonitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
    db,
    persistLiveCandidateState,
    observationWriteSource,
    decision: {
      signal: 'WAIT',
      signalLabel: 'WAIT',
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability: 0.41,
        expectedValueDollars: -20,
        annualizedTrades: 120,
      }],
    },
    latestSession: { no_trade_reason: 'no_confirmation' },
    todayContext: {
      nowEt,
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
  };
}

(async () => {
  const useForce = process.env.AUDIT_FORCE === '1';
  const commandCenterQuery = useForce ? '/api/jarvis/command-center?force=1&discovery=1' : '/api/jarvis/command-center?discovery=1';
  const commandCenterWriteQuery = useForce
    ? '/api/jarvis/command-center?force=1&discovery=1&observationWrite=1'
    : '/api/jarvis/command-center?discovery=1&observationWrite=1';
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3194,
    env: {
      LIVE_CANDIDATE_OBSERVATION_LOOP_ENABLED: 'true',
      LIVE_CANDIDATE_OBSERVATION_ACTIVE_INTERVAL_MS: '2500',
      LIVE_CANDIDATE_OBSERVATION_MONITOR_INTERVAL_MS: '3000',
      LIVE_CANDIDATE_OBSERVATION_IDLE_INTERVAL_MS: '4000',
      LIVE_CANDIDATE_OBSERVATION_ACTIVE_WINDOW: '00:00-23:59',
      LIVE_CANDIDATE_OBSERVATION_MONITOR_WINDOW: '00:00-23:59',
      DATABENTO_API_ENABLED: 'false',
      DATABENTO_API_KEY: '',
      TOPSTEP_API_ENABLED: 'false',
      TOPSTEP_API_KEY: '',
      NEWS_ENABLED: 'false',
      DISCORD_BOT_TOKEN: '',
    },
  });

  try {
    const first = await getJson(server.baseUrl, commandCenterQuery);
    const firstStatus = pullStatus(first);
    const firstMonitor = first?.liveCandidateStateMonitor && typeof first.liveCandidateStateMonitor === 'object'
      ? first.liveCandidateStateMonitor
      : {};
    const firstJudgment = first?.liveCandidateHistoryJudgment && typeof first.liveCandidateHistoryJudgment === 'object'
      ? first.liveCandidateHistoryJudgment
      : {};
    const firstJudgmentAudit = first?.liveCandidateHistoryJudgmentAudit && typeof first.liveCandidateHistoryJudgmentAudit === 'object'
      ? first.liveCandidateHistoryJudgmentAudit
      : {};
    const firstStatusCalibration = first?.liveCandidateHistoryStatusCalibration && typeof first.liveCandidateHistoryStatusCalibration === 'object'
      ? first.liveCandidateHistoryStatusCalibration
      : {};
    const firstStatusCalibrationDiagnostics = first?.liveCandidateHistoryStatusCalibrationDiagnostics
      && typeof first.liveCandidateHistoryStatusCalibrationDiagnostics === 'object'
      ? first.liveCandidateHistoryStatusCalibrationDiagnostics
      : {};
    const firstActionInterpretation = first?.liveCandidateHistoryActionInterpretation
      && typeof first.liveCandidateHistoryActionInterpretation === 'object'
      ? first.liveCandidateHistoryActionInterpretation
      : {};
    const firstActionInterpretationAudit = first?.liveCandidateHistoryActionInterpretationAudit
      && typeof first.liveCandidateHistoryActionInterpretationAudit === 'object'
      ? first.liveCandidateHistoryActionInterpretationAudit
      : {};
    const firstConfirmationGuide = first?.liveCandidateHistoryConfirmationGuide
      && typeof first.liveCandidateHistoryConfirmationGuide === 'object'
      ? first.liveCandidateHistoryConfirmationGuide
      : {};
    const firstConfirmationGuideAudit = first?.liveCandidateHistoryConfirmationGuideAudit
      && typeof first.liveCandidateHistoryConfirmationGuideAudit === 'object'
      ? first.liveCandidateHistoryConfirmationGuideAudit
      : {};
    const firstTradeTriggerCard = first?.liveCandidateTradeTriggerCard
      && typeof first.liveCandidateTradeTriggerCard === 'object'
      ? first.liveCandidateTradeTriggerCard
      : {};
    const firstTradeTriggerCardAudit = first?.liveCandidateTradeTriggerCardAudit
      && typeof first.liveCandidateTradeTriggerCardAudit === 'object'
      ? first.liveCandidateTradeTriggerCardAudit
      : {};
    await sleep(3600);
    const second = await getJson(server.baseUrl, commandCenterQuery);
    const secondStatus = pullStatus(second);
    const secondMonitor = second?.liveCandidateStateMonitor && typeof second.liveCandidateStateMonitor === 'object'
      ? second.liveCandidateStateMonitor
      : {};
    const secondJudgment = second?.liveCandidateHistoryJudgment && typeof second.liveCandidateHistoryJudgment === 'object'
      ? second.liveCandidateHistoryJudgment
      : {};
    const secondJudgmentAudit = second?.liveCandidateHistoryJudgmentAudit && typeof second.liveCandidateHistoryJudgmentAudit === 'object'
      ? second.liveCandidateHistoryJudgmentAudit
      : {};
    const secondStatusCalibration = second?.liveCandidateHistoryStatusCalibration && typeof second.liveCandidateHistoryStatusCalibration === 'object'
      ? second.liveCandidateHistoryStatusCalibration
      : {};
    const secondStatusCalibrationDiagnostics = second?.liveCandidateHistoryStatusCalibrationDiagnostics
      && typeof second.liveCandidateHistoryStatusCalibrationDiagnostics === 'object'
      ? second.liveCandidateHistoryStatusCalibrationDiagnostics
      : {};
    const secondActionInterpretation = second?.liveCandidateHistoryActionInterpretation
      && typeof second.liveCandidateHistoryActionInterpretation === 'object'
      ? second.liveCandidateHistoryActionInterpretation
      : {};
    const secondActionInterpretationAudit = second?.liveCandidateHistoryActionInterpretationAudit
      && typeof second.liveCandidateHistoryActionInterpretationAudit === 'object'
      ? second.liveCandidateHistoryActionInterpretationAudit
      : {};
    const secondConfirmationGuide = second?.liveCandidateHistoryConfirmationGuide
      && typeof second.liveCandidateHistoryConfirmationGuide === 'object'
      ? second.liveCandidateHistoryConfirmationGuide
      : {};
    const secondConfirmationGuideAudit = second?.liveCandidateHistoryConfirmationGuideAudit
      && typeof second.liveCandidateHistoryConfirmationGuideAudit === 'object'
      ? second.liveCandidateHistoryConfirmationGuideAudit
      : {};
    const secondTradeTriggerCard = second?.liveCandidateTradeTriggerCard
      && typeof second.liveCandidateTradeTriggerCard === 'object'
      ? second.liveCandidateTradeTriggerCard
      : {};
    const secondTradeTriggerCardAudit = second?.liveCandidateTradeTriggerCardAudit
      && typeof second.liveCandidateTradeTriggerCardAudit === 'object'
      ? second.liveCandidateTradeTriggerCardAudit
      : {};
    const secondTodayRecommendation = second?.todayRecommendation && typeof second.todayRecommendation === 'object'
      ? second.todayRecommendation
      : {};
    const secondDecisionBoard = second?.decisionBoard && typeof second.decisionBoard === 'object'
      ? second.decisionBoard
      : {};
    const third = await getJson(server.baseUrl, commandCenterQuery);
    const thirdMonitor = third?.liveCandidateStateMonitor && typeof third.liveCandidateStateMonitor === 'object'
      ? third.liveCandidateStateMonitor
      : {};
    const diagnostic = await getJson(server.baseUrl, commandCenterWriteQuery);
    const diagnosticMonitor = diagnostic?.liveCandidateStateMonitor && typeof diagnostic.liveCandidateStateMonitor === 'object'
      ? diagnostic.liveCandidateStateMonitor
      : {};
    const deltaPolls = Number(secondStatus.pollsThisSession || 0) - Number(firstStatus.pollsThisSession || 0);
    const deltaEvaluated = Number(secondStatus.observationsEvaluatedThisSession || 0) - Number(firstStatus.observationsEvaluatedThisSession || 0);
    const deltaWrites = Number(secondStatus.writesThisSession || 0) - Number(firstStatus.writesThisSession || 0);
    const deltaSuppressed = Number(secondStatus.suppressedWritesThisSession || 0) - Number(firstStatus.suppressedWritesThisSession || 0);
    const immediateReadOnlyDelta = Number(thirdMonitor.durableObservationCount || 0) - Number(secondMonitor.durableObservationCount || 0);
    const syntheticDb = new Database(':memory:');
    const syntheticSeed = buildCommandCenterPanels(buildSyntheticInput({
      db: syntheticDb,
      nowEt: '2026-04-16 10:10',
      persistLiveCandidateState: true,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
    }));
    const syntheticFallback = buildCommandCenterPanels(buildSyntheticInput({
      db: syntheticDb,
      nowEt: '2026-04-16 10:11',
      persistLiveCandidateState: false,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
    }));
    const syntheticFallbackMonitor = syntheticFallback?.liveCandidateStateMonitor && typeof syntheticFallback.liveCandidateStateMonitor === 'object'
      ? syntheticFallback.liveCandidateStateMonitor
      : {};
    const syntheticFallbackHistory = syntheticFallback?.liveCandidateTransitionHistory && typeof syntheticFallback.liveCandidateTransitionHistory === 'object'
      ? syntheticFallback.liveCandidateTransitionHistory
      : {};
    syntheticDb.close();

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl: server.baseUrl,
      first: {
        loop: {
          enabled: firstStatus.enabled === true,
          running: firstStatus.running === true,
          currentMode: firstStatus.currentMode || null,
          currentIntervalMs: firstStatus.currentIntervalMs ?? null,
          pollsThisSession: Number(firstStatus.pollsThisSession || 0),
          writesThisSession: Number(firstStatus.writesThisSession || 0),
          suppressedWritesThisSession: Number(firstStatus.suppressedWritesThisSession || 0),
          observationsEvaluatedThisSession: Number(firstStatus.observationsEvaluatedThisSession || 0),
          lastInputRefreshAt: firstStatus.lastInputRefreshAt || null,
          refreshedInputSources: Array.isArray(firstStatus.refreshedInputSources) ? firstStatus.refreshedInputSources : [],
          staleInputWarning: firstStatus.staleInputWarning === true,
          staleInputReasonCodes: Array.isArray(firstStatus.staleInputReasonCodes) ? firstStatus.staleInputReasonCodes : [],
          lastObservedMarketTimestamp: firstStatus.lastObservedMarketTimestamp || null,
          lastObservedDecisionTimestamp: firstStatus.lastObservedDecisionTimestamp || null,
          lastObservedContextTimestamp: firstStatus.lastObservedContextTimestamp || null,
          lastStateClassification: firstStatus.lastStateClassification || null,
          lastStateClassificationReason: firstStatus.lastStateClassificationReason || null,
          lastPollAt: firstStatus.lastPollAt || null,
          summaryLine: firstStatus.summaryLine || null,
        },
        monitor: {
          storageMode: firstMonitor.storageMode || null,
          responseReadOnly: firstMonitor.responseReadOnly === true,
          observationWriteSource: firstMonitor.observationWriteSource || null,
          historyProvenanceClassification: firstMonitor.historyProvenanceClassification || null,
          historyEvaluationMode: firstMonitor.historyEvaluationMode || null,
          historyDebugDbPath: firstMonitor.historyDebugDbPath || null,
          historyDebugRequestedSessionDate: firstMonitor.historyDebugRequestedSessionDate || null,
          historyDebugEffectiveSessionDate: firstMonitor.historyDebugEffectiveSessionDate || null,
          historyDebugRowScope: firstMonitor.historyDebugRowScope || null,
          historyDebugRowScopeFallbackUsed: firstMonitor.historyDebugRowScopeFallbackUsed === true,
          historyDebugRowScopeFallbackReason: firstMonitor.historyDebugRowScopeFallbackReason || null,
          historyDebugLatestObservationAt: firstMonitor.historyDebugLatestObservationAt || null,
          historyDebugLatestTransitionAt: firstMonitor.historyDebugLatestTransitionAt || null,
          loopOnlyObservationCount: Number(firstMonitor.loopOnlyObservationCount || 0),
          loopOnlyTransitionCount: Number(firstMonitor.loopOnlyTransitionCount || 0),
          diagnosticOnlyObservationCount: Number(firstMonitor.diagnosticOnlyObservationCount || 0),
          diagnosticOnlyTransitionCount: Number(firstMonitor.diagnosticOnlyTransitionCount || 0),
          loopOnlyHistorySummaryLine: firstMonitor.loopOnlyHistorySummaryLine || null,
          diagnosticOnlyHistorySummaryLine: firstMonitor.diagnosticOnlyHistorySummaryLine || null,
          durableObservationCount: firstMonitor.durableObservationCount ?? null,
          durableTransitionCount: firstMonitor.durableTransitionCount ?? null,
        },
        judgment: {
          modeUsed: firstJudgment.modeUsed || null,
          judgment: firstJudgment.judgment || null,
          confidenceLabel: firstJudgment.confidenceLabel || null,
          confidenceReason: firstJudgment.confidenceReason || null,
          confidenceDrivers: Array.isArray(firstJudgment.confidenceDrivers) ? firstJudgment.confidenceDrivers : [],
          confidencePenaltyReasons: Array.isArray(firstJudgment.confidencePenaltyReasons) ? firstJudgment.confidencePenaltyReasons : [],
          historySampleSize: Number(firstJudgment.historySampleSize || 0),
          transitionSampleSize: Number(firstJudgment.transitionSampleSize || 0),
          supportiveCount: Number(firstJudgment.supportiveCount || 0),
          unsupportiveCount: Number(firstJudgment.unsupportiveCount || 0),
          neutralCount: Number(firstJudgment.neutralCount || 0),
          recentTransitionBias: firstJudgment.recentTransitionBias || null,
          directionVsTransitionTension: firstJudgment.directionVsTransitionTension === true,
          directionVsTransitionSummaryLine: firstJudgment.directionVsTransitionSummaryLine || null,
          sparseHistory: firstJudgment.sparseHistory === true,
          sparseReason: firstJudgment.sparseReason || null,
          summaryLine: firstJudgment.summaryLine || null,
        },
        judgmentAudit: {
          modeUsed: firstJudgmentAudit.modeUsed || null,
          sampleSize: Number(firstJudgmentAudit.sampleSize || 0),
          supportiveRuleHits: firstJudgmentAudit.supportiveRuleHits && typeof firstJudgmentAudit.supportiveRuleHits === 'object'
            ? firstJudgmentAudit.supportiveRuleHits
            : {},
          unsupportiveRuleHits: firstJudgmentAudit.unsupportiveRuleHits && typeof firstJudgmentAudit.unsupportiveRuleHits === 'object'
            ? firstJudgmentAudit.unsupportiveRuleHits
            : {},
          neutralRuleHits: firstJudgmentAudit.neutralRuleHits && typeof firstJudgmentAudit.neutralRuleHits === 'object'
            ? firstJudgmentAudit.neutralRuleHits
            : {},
          dominantSupportiveRules: Array.isArray(firstJudgmentAudit.dominantSupportiveRules) ? firstJudgmentAudit.dominantSupportiveRules : [],
          dominantUnsupportiveRules: Array.isArray(firstJudgmentAudit.dominantUnsupportiveRules) ? firstJudgmentAudit.dominantUnsupportiveRules : [],
          dominantNeutralRules: Array.isArray(firstJudgmentAudit.dominantNeutralRules) ? firstJudgmentAudit.dominantNeutralRules : [],
          recentClassifiedRows: Array.isArray(firstJudgmentAudit.recentClassifiedRows) ? firstJudgmentAudit.recentClassifiedRows.slice(0, 5) : [],
          summaryLine: firstJudgmentAudit.summaryLine || null,
        },
        statusCalibration: {
          modeUsed: firstStatusCalibration.modeUsed || null,
          statusSourceOfTruth: firstStatusCalibration.statusSourceOfTruth || null,
          summaryDerivedFrom: firstStatusCalibration.summaryDerivedFrom || null,
          dominantStatusEffects: Array.isArray(firstStatusCalibration.dominantStatusEffects)
            ? firstStatusCalibration.dominantStatusEffects
            : [],
          preOpenWatchTreatment: firstStatusCalibration?.statusRuleMap?.pre_open_watch || null,
          blockedTreatment: firstStatusCalibration?.statusRuleMap?.blocked || null,
          preOpenWatchEvidence: firstStatusCalibration?.statusEvidence?.pre_open_watch || null,
          blockedEvidence: firstStatusCalibration?.statusEvidence?.blocked || null,
          summaryLine: firstStatusCalibration.summaryLine || null,
        },
        statusCalibrationDiagnostics: {
          consistent: firstStatusCalibrationDiagnostics.consistent === true,
          inconsistencies: Array.isArray(firstStatusCalibrationDiagnostics.inconsistencies)
            ? firstStatusCalibrationDiagnostics.inconsistencies
            : [],
          statusSourceOfTruth: firstStatusCalibrationDiagnostics.statusSourceOfTruth || null,
          summaryDerivedFrom: firstStatusCalibrationDiagnostics.summaryDerivedFrom || null,
          summaryLine: firstStatusCalibrationDiagnostics.summaryLine || null,
        },
        actionInterpretation: {
          modeUsed: firstActionInterpretation.modeUsed || null,
          overallHistoryJudgment: firstActionInterpretation.overallHistoryJudgment || null,
          recentTransitionBias: firstActionInterpretation.recentTransitionBias || null,
          directionVsTransitionTension: firstActionInterpretation.directionVsTransitionTension === true,
          actionStance: firstActionInterpretation.actionStance || null,
          actionStanceReason: firstActionInterpretation.actionStanceReason || null,
          actionBias: firstActionInterpretation.actionBias || null,
          confidenceImpact: firstActionInterpretation.confidenceImpact || null,
          requiresFreshConfirmation: firstActionInterpretation.requiresFreshConfirmation === true,
          summaryLine: firstActionInterpretation.summaryLine || null,
        },
        actionInterpretationAudit: {
          ruleUsed: firstActionInterpretationAudit.ruleUsed || null,
          inputsUsed: firstActionInterpretationAudit.inputsUsed && typeof firstActionInterpretationAudit.inputsUsed === 'object'
            ? firstActionInterpretationAudit.inputsUsed
            : {},
          tensionCase: firstActionInterpretationAudit.tensionCase || null,
          stanceAlternativesConsidered: Array.isArray(firstActionInterpretationAudit.stanceAlternativesConsidered)
            ? firstActionInterpretationAudit.stanceAlternativesConsidered
            : [],
          summaryLine: firstActionInterpretationAudit.summaryLine || null,
        },
        confirmationGuide: {
          modeUsed: firstConfirmationGuide.modeUsed || null,
          currentActionStance: firstConfirmationGuide.currentActionStance || null,
          confirmationState: firstConfirmationGuide.confirmationState || null,
          confirmationTriggers: Array.isArray(firstConfirmationGuide.confirmationTriggers)
            ? firstConfirmationGuide.confirmationTriggers
            : [],
          confirmationFailures: Array.isArray(firstConfirmationGuide.confirmationFailures)
            ? firstConfirmationGuide.confirmationFailures
            : [],
          triggerSummaryLine: firstConfirmationGuide.triggerSummaryLine || null,
          failureSummaryLine: firstConfirmationGuide.failureSummaryLine || null,
          nextBestStateIfConfirmed: firstConfirmationGuide.nextBestStateIfConfirmed || null,
          summaryLine: firstConfirmationGuide.summaryLine || null,
        },
        confirmationGuideAudit: {
          ruleUsed: firstConfirmationGuideAudit.ruleUsed || null,
          inputsUsed: firstConfirmationGuideAudit.inputsUsed && typeof firstConfirmationGuideAudit.inputsUsed === 'object'
            ? firstConfirmationGuideAudit.inputsUsed
            : {},
          triggerCount: Number(firstConfirmationGuideAudit.triggerCount || 0),
          failureCount: Number(firstConfirmationGuideAudit.failureCount || 0),
          unmetCriticalTriggers: Array.isArray(firstConfirmationGuideAudit.unmetCriticalTriggers)
            ? firstConfirmationGuideAudit.unmetCriticalTriggers
            : [],
          summaryLine: firstConfirmationGuideAudit.summaryLine || null,
        },
        tradeTriggerCard: {
          modeUsed: firstTradeTriggerCard.modeUsed || null,
          currentState: firstTradeTriggerCard.currentState || null,
          confirmationState: firstTradeTriggerCard.confirmationState || null,
          triggerCount: Number(firstTradeTriggerCard.triggerCount || 0),
          failureCount: Number(firstTradeTriggerCard.failureCount || 0),
          missingTriggers: Array.isArray(firstTradeTriggerCard.missingTriggers) ? firstTradeTriggerCard.missingTriggers : [],
          activeFailures: Array.isArray(firstTradeTriggerCard.activeFailures) ? firstTradeTriggerCard.activeFailures : [],
          nextUpgradeState: firstTradeTriggerCard.nextUpgradeState || null,
          invalidationState: firstTradeTriggerCard.invalidationState || null,
          riskBucket: firstTradeTriggerCard.riskBucket || null,
          sizeGuidance: firstTradeTriggerCard.sizeGuidance || null,
          operatorSummaryLine: firstTradeTriggerCard.operatorSummaryLine || null,
        },
        tradeTriggerCardAudit: {
          ruleUsed: firstTradeTriggerCardAudit.ruleUsed || null,
          inputsUsed: firstTradeTriggerCardAudit.inputsUsed && typeof firstTradeTriggerCardAudit.inputsUsed === 'object'
            ? firstTradeTriggerCardAudit.inputsUsed
            : {},
          triggerBreakdown: firstTradeTriggerCardAudit.triggerBreakdown && typeof firstTradeTriggerCardAudit.triggerBreakdown === 'object'
            ? firstTradeTriggerCardAudit.triggerBreakdown
            : {},
          failureBreakdown: firstTradeTriggerCardAudit.failureBreakdown && typeof firstTradeTriggerCardAudit.failureBreakdown === 'object'
            ? firstTradeTriggerCardAudit.failureBreakdown
            : {},
          stateUpgradePath: firstTradeTriggerCardAudit.stateUpgradePath || null,
          stateInvalidationPath: firstTradeTriggerCardAudit.stateInvalidationPath || null,
          summaryLine: firstTradeTriggerCardAudit.summaryLine || null,
        },
      },
      second: {
        loop: {
          enabled: secondStatus.enabled === true,
          running: secondStatus.running === true,
          currentMode: secondStatus.currentMode || null,
          currentIntervalMs: secondStatus.currentIntervalMs ?? null,
          pollsThisSession: Number(secondStatus.pollsThisSession || 0),
          writesThisSession: Number(secondStatus.writesThisSession || 0),
          suppressedWritesThisSession: Number(secondStatus.suppressedWritesThisSession || 0),
          observationsEvaluatedThisSession: Number(secondStatus.observationsEvaluatedThisSession || 0),
          lastInputRefreshAt: secondStatus.lastInputRefreshAt || null,
          refreshedInputSources: Array.isArray(secondStatus.refreshedInputSources) ? secondStatus.refreshedInputSources : [],
          staleInputWarning: secondStatus.staleInputWarning === true,
          staleInputReasonCodes: Array.isArray(secondStatus.staleInputReasonCodes) ? secondStatus.staleInputReasonCodes : [],
          lastObservedMarketTimestamp: secondStatus.lastObservedMarketTimestamp || null,
          lastObservedDecisionTimestamp: secondStatus.lastObservedDecisionTimestamp || null,
          lastObservedContextTimestamp: secondStatus.lastObservedContextTimestamp || null,
          lastStateClassification: secondStatus.lastStateClassification || null,
          lastStateClassificationReason: secondStatus.lastStateClassificationReason || null,
          lastPollAt: secondStatus.lastPollAt || null,
          summaryLine: secondStatus.summaryLine || null,
        },
        monitor: {
          storageMode: secondMonitor.storageMode || null,
          responseReadOnly: secondMonitor.responseReadOnly === true,
          observationWriteSource: secondMonitor.observationWriteSource || null,
          historyProvenanceClassification: secondMonitor.historyProvenanceClassification || null,
          historyEvaluationMode: secondMonitor.historyEvaluationMode || null,
          historyDebugDbPath: secondMonitor.historyDebugDbPath || null,
          historyDebugRequestedSessionDate: secondMonitor.historyDebugRequestedSessionDate || null,
          historyDebugEffectiveSessionDate: secondMonitor.historyDebugEffectiveSessionDate || null,
          historyDebugRowScope: secondMonitor.historyDebugRowScope || null,
          historyDebugRowScopeFallbackUsed: secondMonitor.historyDebugRowScopeFallbackUsed === true,
          historyDebugRowScopeFallbackReason: secondMonitor.historyDebugRowScopeFallbackReason || null,
          historyDebugLatestObservationAt: secondMonitor.historyDebugLatestObservationAt || null,
          historyDebugLatestTransitionAt: secondMonitor.historyDebugLatestTransitionAt || null,
          loopOnlyObservationCount: Number(secondMonitor.loopOnlyObservationCount || 0),
          loopOnlyTransitionCount: Number(secondMonitor.loopOnlyTransitionCount || 0),
          diagnosticOnlyObservationCount: Number(secondMonitor.diagnosticOnlyObservationCount || 0),
          diagnosticOnlyTransitionCount: Number(secondMonitor.diagnosticOnlyTransitionCount || 0),
          loopOnlyHistorySummaryLine: secondMonitor.loopOnlyHistorySummaryLine || null,
          diagnosticOnlyHistorySummaryLine: secondMonitor.diagnosticOnlyHistorySummaryLine || null,
          loopOnlyRecentObservationSources: Array.isArray(secondMonitor.loopOnlyRecentObservations)
            ? secondMonitor.loopOnlyRecentObservations.map((row) => row?.observationWriteSource).filter(Boolean)
            : [],
          diagnosticOnlyRecentObservationSources: Array.isArray(secondMonitor.diagnosticOnlyRecentObservations)
            ? secondMonitor.diagnosticOnlyRecentObservations.map((row) => row?.observationWriteSource).filter(Boolean)
            : [],
          durableObservationCount: secondMonitor.durableObservationCount ?? null,
          durableTransitionCount: secondMonitor.durableTransitionCount ?? null,
        },
        judgment: {
          modeUsed: secondJudgment.modeUsed || null,
          judgment: secondJudgment.judgment || null,
          confidenceLabel: secondJudgment.confidenceLabel || null,
          confidenceReason: secondJudgment.confidenceReason || null,
          confidenceDrivers: Array.isArray(secondJudgment.confidenceDrivers) ? secondJudgment.confidenceDrivers : [],
          confidencePenaltyReasons: Array.isArray(secondJudgment.confidencePenaltyReasons) ? secondJudgment.confidencePenaltyReasons : [],
          historySampleSize: Number(secondJudgment.historySampleSize || 0),
          transitionSampleSize: Number(secondJudgment.transitionSampleSize || 0),
          supportiveCount: Number(secondJudgment.supportiveCount || 0),
          unsupportiveCount: Number(secondJudgment.unsupportiveCount || 0),
          neutralCount: Number(secondJudgment.neutralCount || 0),
          recentTransitionBias: secondJudgment.recentTransitionBias || null,
          directionVsTransitionTension: secondJudgment.directionVsTransitionTension === true,
          directionVsTransitionSummaryLine: secondJudgment.directionVsTransitionSummaryLine || null,
          sparseHistory: secondJudgment.sparseHistory === true,
          sparseReason: secondJudgment.sparseReason || null,
          summaryLine: secondJudgment.summaryLine || null,
        },
        judgmentAudit: {
          modeUsed: secondJudgmentAudit.modeUsed || null,
          sampleSize: Number(secondJudgmentAudit.sampleSize || 0),
          supportiveRuleHits: secondJudgmentAudit.supportiveRuleHits && typeof secondJudgmentAudit.supportiveRuleHits === 'object'
            ? secondJudgmentAudit.supportiveRuleHits
            : {},
          unsupportiveRuleHits: secondJudgmentAudit.unsupportiveRuleHits && typeof secondJudgmentAudit.unsupportiveRuleHits === 'object'
            ? secondJudgmentAudit.unsupportiveRuleHits
            : {},
          neutralRuleHits: secondJudgmentAudit.neutralRuleHits && typeof secondJudgmentAudit.neutralRuleHits === 'object'
            ? secondJudgmentAudit.neutralRuleHits
            : {},
          dominantSupportiveRules: Array.isArray(secondJudgmentAudit.dominantSupportiveRules) ? secondJudgmentAudit.dominantSupportiveRules : [],
          dominantUnsupportiveRules: Array.isArray(secondJudgmentAudit.dominantUnsupportiveRules) ? secondJudgmentAudit.dominantUnsupportiveRules : [],
          dominantNeutralRules: Array.isArray(secondJudgmentAudit.dominantNeutralRules) ? secondJudgmentAudit.dominantNeutralRules : [],
          recentClassifiedRows: Array.isArray(secondJudgmentAudit.recentClassifiedRows) ? secondJudgmentAudit.recentClassifiedRows.slice(0, 5) : [],
          summaryLine: secondJudgmentAudit.summaryLine || null,
        },
        statusCalibration: {
          modeUsed: secondStatusCalibration.modeUsed || null,
          statusSourceOfTruth: secondStatusCalibration.statusSourceOfTruth || null,
          summaryDerivedFrom: secondStatusCalibration.summaryDerivedFrom || null,
          dominantStatusEffects: Array.isArray(secondStatusCalibration.dominantStatusEffects)
            ? secondStatusCalibration.dominantStatusEffects
            : [],
          preOpenWatchTreatment: secondStatusCalibration?.statusRuleMap?.pre_open_watch || null,
          blockedTreatment: secondStatusCalibration?.statusRuleMap?.blocked || null,
          preOpenWatchEvidence: secondStatusCalibration?.statusEvidence?.pre_open_watch || null,
          blockedEvidence: secondStatusCalibration?.statusEvidence?.blocked || null,
          summaryLine: secondStatusCalibration.summaryLine || null,
        },
        statusCalibrationDiagnostics: {
          consistent: secondStatusCalibrationDiagnostics.consistent === true,
          inconsistencies: Array.isArray(secondStatusCalibrationDiagnostics.inconsistencies)
            ? secondStatusCalibrationDiagnostics.inconsistencies
            : [],
          statusSourceOfTruth: secondStatusCalibrationDiagnostics.statusSourceOfTruth || null,
          summaryDerivedFrom: secondStatusCalibrationDiagnostics.summaryDerivedFrom || null,
          summaryLine: secondStatusCalibrationDiagnostics.summaryLine || null,
        },
        actionInterpretation: {
          modeUsed: secondActionInterpretation.modeUsed || null,
          overallHistoryJudgment: secondActionInterpretation.overallHistoryJudgment || null,
          recentTransitionBias: secondActionInterpretation.recentTransitionBias || null,
          directionVsTransitionTension: secondActionInterpretation.directionVsTransitionTension === true,
          actionStance: secondActionInterpretation.actionStance || null,
          actionStanceReason: secondActionInterpretation.actionStanceReason || null,
          actionBias: secondActionInterpretation.actionBias || null,
          confidenceImpact: secondActionInterpretation.confidenceImpact || null,
          requiresFreshConfirmation: secondActionInterpretation.requiresFreshConfirmation === true,
          summaryLine: secondActionInterpretation.summaryLine || null,
        },
        actionInterpretationAudit: {
          ruleUsed: secondActionInterpretationAudit.ruleUsed || null,
          inputsUsed: secondActionInterpretationAudit.inputsUsed && typeof secondActionInterpretationAudit.inputsUsed === 'object'
            ? secondActionInterpretationAudit.inputsUsed
            : {},
          tensionCase: secondActionInterpretationAudit.tensionCase || null,
          stanceAlternativesConsidered: Array.isArray(secondActionInterpretationAudit.stanceAlternativesConsidered)
            ? secondActionInterpretationAudit.stanceAlternativesConsidered
            : [],
          summaryLine: secondActionInterpretationAudit.summaryLine || null,
        },
        confirmationGuide: {
          modeUsed: secondConfirmationGuide.modeUsed || null,
          currentActionStance: secondConfirmationGuide.currentActionStance || null,
          confirmationState: secondConfirmationGuide.confirmationState || null,
          confirmationTriggers: Array.isArray(secondConfirmationGuide.confirmationTriggers)
            ? secondConfirmationGuide.confirmationTriggers
            : [],
          confirmationFailures: Array.isArray(secondConfirmationGuide.confirmationFailures)
            ? secondConfirmationGuide.confirmationFailures
            : [],
          triggerSummaryLine: secondConfirmationGuide.triggerSummaryLine || null,
          failureSummaryLine: secondConfirmationGuide.failureSummaryLine || null,
          nextBestStateIfConfirmed: secondConfirmationGuide.nextBestStateIfConfirmed || null,
          summaryLine: secondConfirmationGuide.summaryLine || null,
        },
        confirmationGuideAudit: {
          ruleUsed: secondConfirmationGuideAudit.ruleUsed || null,
          inputsUsed: secondConfirmationGuideAudit.inputsUsed && typeof secondConfirmationGuideAudit.inputsUsed === 'object'
            ? secondConfirmationGuideAudit.inputsUsed
            : {},
          triggerCount: Number(secondConfirmationGuideAudit.triggerCount || 0),
          failureCount: Number(secondConfirmationGuideAudit.failureCount || 0),
          unmetCriticalTriggers: Array.isArray(secondConfirmationGuideAudit.unmetCriticalTriggers)
            ? secondConfirmationGuideAudit.unmetCriticalTriggers
            : [],
          summaryLine: secondConfirmationGuideAudit.summaryLine || null,
        },
        tradeTriggerCard: {
          modeUsed: secondTradeTriggerCard.modeUsed || null,
          currentState: secondTradeTriggerCard.currentState || null,
          confirmationState: secondTradeTriggerCard.confirmationState || null,
          triggerCount: Number(secondTradeTriggerCard.triggerCount || 0),
          failureCount: Number(secondTradeTriggerCard.failureCount || 0),
          missingTriggers: Array.isArray(secondTradeTriggerCard.missingTriggers) ? secondTradeTriggerCard.missingTriggers : [],
          activeFailures: Array.isArray(secondTradeTriggerCard.activeFailures) ? secondTradeTriggerCard.activeFailures : [],
          nextUpgradeState: secondTradeTriggerCard.nextUpgradeState || null,
          invalidationState: secondTradeTriggerCard.invalidationState || null,
          riskBucket: secondTradeTriggerCard.riskBucket || null,
          sizeGuidance: secondTradeTriggerCard.sizeGuidance || null,
          operatorSummaryLine: secondTradeTriggerCard.operatorSummaryLine || null,
        },
        tradeTriggerCardAudit: {
          ruleUsed: secondTradeTriggerCardAudit.ruleUsed || null,
          inputsUsed: secondTradeTriggerCardAudit.inputsUsed && typeof secondTradeTriggerCardAudit.inputsUsed === 'object'
            ? secondTradeTriggerCardAudit.inputsUsed
            : {},
          triggerBreakdown: secondTradeTriggerCardAudit.triggerBreakdown && typeof secondTradeTriggerCardAudit.triggerBreakdown === 'object'
            ? secondTradeTriggerCardAudit.triggerBreakdown
            : {},
          failureBreakdown: secondTradeTriggerCardAudit.failureBreakdown && typeof secondTradeTriggerCardAudit.failureBreakdown === 'object'
            ? secondTradeTriggerCardAudit.failureBreakdown
            : {},
          stateUpgradePath: secondTradeTriggerCardAudit.stateUpgradePath || null,
          stateInvalidationPath: secondTradeTriggerCardAudit.stateInvalidationPath || null,
          summaryLine: secondTradeTriggerCardAudit.summaryLine || null,
        },
        tradeTriggerMirrorParity: {
          todayRecommendationCurrentState: secondTodayRecommendation?.liveCandidateTradeTriggerCard?.currentState || null,
          decisionBoardCurrentState: secondDecisionBoard?.liveCandidateTradeTriggerCard?.currentState || null,
          todayRecommendationOperatorSummaryLine: secondTodayRecommendation?.liveCandidateTradeTriggerCard?.operatorSummaryLine || null,
          decisionBoardOperatorSummaryLine: secondDecisionBoard?.liveCandidateTradeTriggerCard?.operatorSummaryLine || null,
        },
      },
      thirdImmediateRead: {
        monitor: {
          responseReadOnly: thirdMonitor.responseReadOnly === true,
          observationWriteSource: thirdMonitor.observationWriteSource || null,
          observationWritesThisSnapshot: Number(thirdMonitor.observationWritesThisSnapshot || 0),
          durableObservationCount: thirdMonitor.durableObservationCount ?? null,
          durableTransitionCount: thirdMonitor.durableTransitionCount ?? null,
        },
      },
      diagnosticWriteMode: {
        responseReadOnly: diagnosticMonitor.responseReadOnly === true,
        observationWriteSource: diagnosticMonitor.observationWriteSource || null,
        observationWritesThisSnapshot: Number(diagnosticMonitor.observationWritesThisSnapshot || 0),
        durableObservationCount: diagnosticMonitor.durableObservationCount ?? null,
          durableTransitionCount: diagnosticMonitor.durableTransitionCount ?? null,
      },
      syntheticFallbackFixture: {
        seededWithDiagnosticOnlyRows: {
          monitorMode: syntheticSeed?.liveCandidateStateMonitor?.historyEvaluationMode || null,
          monitorFallbackUsed: syntheticSeed?.liveCandidateStateMonitor?.historyEvaluationFallbackUsed === true,
          transitionMode: syntheticSeed?.liveCandidateTransitionHistory?.historyEvaluationMode || null,
          transitionFallbackUsed: syntheticSeed?.liveCandidateTransitionHistory?.historyEvaluationFallbackUsed === true,
        },
        readOnlyInterpretation: {
          monitorMode: syntheticFallbackMonitor.historyEvaluationMode || null,
          monitorFallbackUsed: syntheticFallbackMonitor.historyEvaluationFallbackUsed === true,
          monitorFallbackReason: syntheticFallbackMonitor.historyEvaluationFallbackReason || null,
          monitorFallbackMode: syntheticFallbackMonitor.historyEvaluationFallbackMode || null,
          transitionMode: syntheticFallbackHistory.historyEvaluationMode || null,
          transitionFallbackUsed: syntheticFallbackHistory.historyEvaluationFallbackUsed === true,
          transitionFallbackReason: syntheticFallbackHistory.historyEvaluationFallbackReason || null,
          transitionFallbackMode: syntheticFallbackHistory.historyEvaluationFallbackMode || null,
        },
      },
      delta: {
        pollsThisSession: deltaPolls,
        observationsEvaluatedThisSession: deltaEvaluated,
        writesThisSession: deltaWrites,
        suppressedWritesThisSession: deltaSuppressed,
        immediateReadOnlyDurableObservationDelta: immediateReadOnlyDelta,
      },
      proof: {
        loopAdvancedWithoutContinuousEndpointPolling: deltaPolls > 0 && deltaEvaluated > 0,
        endpointReadOnlyDefault: secondMonitor.responseReadOnly === true && Number(secondMonitor.observationWritesThisSnapshot || 0) === 0,
        endpointReadNoInflationOnImmediateRepeat: immediateReadOnlyDelta === 0,
        endpointDiagnosticWriteExplicitOnly: diagnosticMonitor.responseReadOnly === false && String(diagnosticMonitor.observationWriteSource || '') === 'endpoint_diagnostic',
        defaultInterpretationModeLoopOnly: String(secondMonitor.historyEvaluationMode || '') === 'loop_only',
        loopOnlyAndMixedSurfaced: typeof secondMonitor.loopOnlyObservationCount === 'number'
          && typeof secondMonitor.diagnosticOnlyObservationCount === 'number'
          && typeof secondMonitor.durableObservationCount === 'number',
        loopOnlyViewExcludesDiagnosticRows: Array.isArray(secondMonitor.loopOnlyRecentObservations)
          ? secondMonitor.loopOnlyRecentObservations.every((row) => String(row?.observationWriteSource || '') !== 'endpoint_diagnostic')
          : true,
        diagnosticViewExcludesLoopRows: Array.isArray(secondMonitor.diagnosticOnlyRecentObservations)
          ? secondMonitor.diagnosticOnlyRecentObservations.every((row) => String(row?.observationWriteSource || '') !== 'loop_auto')
          : true,
        historyTrustabilityExplicit: typeof secondMonitor.historyEvaluationMode === 'string' && secondMonitor.historyEvaluationMode.length > 0,
        historyJudgmentSurfaced: secondJudgment && typeof secondJudgment === 'object'
          && typeof secondJudgment.summaryLine === 'string'
          && secondJudgment.summaryLine.length > 0,
        historyJudgmentLoopOnly: String(secondJudgment.modeUsed || '') === 'loop_only',
        historyJudgmentSparseExplicit:
          typeof secondJudgment.sparseHistory === 'boolean'
          && (
            secondJudgment.sparseHistory !== true
            || (typeof secondJudgment.sparseReason === 'string' && secondJudgment.sparseReason.length > 0)
          ),
        historyJudgmentConfidenceReasonVisible:
          typeof secondJudgment.confidenceReason === 'string'
          && secondJudgment.confidenceReason.length > 0,
        historyJudgmentRuleAuditVisible:
          secondJudgmentAudit && typeof secondJudgmentAudit === 'object'
          && Array.isArray(secondJudgmentAudit.dominantUnsupportiveRules)
          && Array.isArray(secondJudgmentAudit.recentClassifiedRows),
        historyStatusCalibrationVisible:
          Boolean(
            secondStatusCalibration
            && typeof secondStatusCalibration === 'object'
            && secondStatusCalibration.statusRuleMap
            && secondStatusCalibration.statusEvidence
          ),
        historyStatusCalibrationPreOpenExplicit:
          String(secondStatusCalibration?.statusRuleMap?.pre_open_watch?.directionalEffect || '') === 'neutral',
        historyStatusCalibrationBlockedExplicit:
          String(secondStatusCalibration?.statusRuleMap?.blocked?.treatment || '').length > 0,
        historyStatusCalibrationDiagnosticsVisible:
          Boolean(
            secondStatusCalibrationDiagnostics
            && typeof secondStatusCalibrationDiagnostics === 'object'
            && Object.prototype.hasOwnProperty.call(secondStatusCalibrationDiagnostics, 'consistent')
          ),
        historyStatusCalibrationConsistent:
          secondStatusCalibrationDiagnostics?.consistent === true,
        historyJudgmentTensionVisible:
          Object.prototype.hasOwnProperty.call(secondJudgment || {}, 'directionVsTransitionTension')
          && typeof secondJudgment?.directionVsTransitionSummaryLine === 'string',
        historyActionInterpretationVisible:
          Boolean(
            secondActionInterpretation
            && typeof secondActionInterpretation === 'object'
            && typeof secondActionInterpretation.actionStance === 'string'
            && secondActionInterpretation.actionStance.length > 0
          ),
        historyActionInterpretationAuditVisible:
          Boolean(
            secondActionInterpretationAudit
            && typeof secondActionInterpretationAudit === 'object'
            && typeof secondActionInterpretationAudit.ruleUsed === 'string'
            && secondActionInterpretationAudit.ruleUsed.length > 0
          ),
        historyConfirmationGuideVisible:
          Boolean(
            secondConfirmationGuide
            && typeof secondConfirmationGuide === 'object'
            && typeof secondConfirmationGuide.confirmationState === 'string'
            && secondConfirmationGuide.confirmationState.length > 0
          ),
        historyConfirmationGuideAuditVisible:
          Boolean(
            secondConfirmationGuideAudit
            && typeof secondConfirmationGuideAudit === 'object'
            && typeof secondConfirmationGuideAudit.ruleUsed === 'string'
            && secondConfirmationGuideAudit.ruleUsed.length > 0
          ),
        historyTradeTriggerCardVisible:
          Boolean(
            secondTradeTriggerCard
            && typeof secondTradeTriggerCard === 'object'
            && typeof secondTradeTriggerCard.currentState === 'string'
            && secondTradeTriggerCard.currentState.length > 0
          ),
        historyTradeTriggerCardAuditVisible:
          Boolean(
            secondTradeTriggerCardAudit
            && typeof secondTradeTriggerCardAudit === 'object'
            && typeof secondTradeTriggerCardAudit.ruleUsed === 'string'
            && secondTradeTriggerCardAudit.ruleUsed.length > 0
          ),
        historyTradeTriggerMirrorParity:
          String(secondTradeTriggerCard?.currentState || '') !== ''
          && String(secondTradeTriggerCard?.currentState || '') === String(secondTodayRecommendation?.liveCandidateTradeTriggerCard?.currentState || '')
          && String(secondTradeTriggerCard?.currentState || '') === String(secondDecisionBoard?.liveCandidateTradeTriggerCard?.currentState || ''),
        fallbackExplicitWhenTriggered:
          syntheticFallbackMonitor.historyEvaluationFallbackUsed === true
          && String(syntheticFallbackMonitor.historyEvaluationMode || '') !== 'loop_only'
          && String(syntheticFallbackMonitor.historyEvaluationFallbackReason || '').length > 0
          && syntheticFallbackHistory.historyEvaluationFallbackUsed === true
          && String(syntheticFallbackHistory.historyEvaluationMode || '') !== 'loop_only'
          && String(syntheticFallbackHistory.historyEvaluationFallbackReason || '').length > 0,
        staleVsUnchangedSurfaced: typeof secondStatus.lastStateClassification === 'string' && secondStatus.lastStateClassification.length > 0,
      },
      summaryLine: `Loop delta polls ${deltaPolls}, evaluated ${deltaEvaluated}, writes ${deltaWrites}, suppressed ${deltaSuppressed}; immediate read-only delta ${immediateReadOnlyDelta}.`,
      advisoryOnly: true,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err.message || 'live_candidate_observation_loop_audit_failed',
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await server.stop();
  }
})();
