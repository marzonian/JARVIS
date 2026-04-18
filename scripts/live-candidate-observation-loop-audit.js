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
    const first = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1');
    const firstStatus = pullStatus(first);
    const firstMonitor = first?.liveCandidateStateMonitor && typeof first.liveCandidateStateMonitor === 'object'
      ? first.liveCandidateStateMonitor
      : {};
    await sleep(3600);
    const second = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1');
    const secondStatus = pullStatus(second);
    const secondMonitor = second?.liveCandidateStateMonitor && typeof second.liveCandidateStateMonitor === 'object'
      ? second.liveCandidateStateMonitor
      : {};
    const third = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1');
    const thirdMonitor = third?.liveCandidateStateMonitor && typeof third.liveCandidateStateMonitor === 'object'
      ? third.liveCandidateStateMonitor
      : {};
    const diagnostic = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1&observationWrite=1');
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
          loopOnlyObservationCount: Number(firstMonitor.loopOnlyObservationCount || 0),
          loopOnlyTransitionCount: Number(firstMonitor.loopOnlyTransitionCount || 0),
          diagnosticOnlyObservationCount: Number(firstMonitor.diagnosticOnlyObservationCount || 0),
          diagnosticOnlyTransitionCount: Number(firstMonitor.diagnosticOnlyTransitionCount || 0),
          loopOnlyHistorySummaryLine: firstMonitor.loopOnlyHistorySummaryLine || null,
          diagnosticOnlyHistorySummaryLine: firstMonitor.diagnosticOnlyHistorySummaryLine || null,
          durableObservationCount: firstMonitor.durableObservationCount ?? null,
          durableTransitionCount: firstMonitor.durableTransitionCount ?? null,
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
