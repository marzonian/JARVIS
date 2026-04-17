#!/usr/bin/env node
/* eslint-disable no-console */

const { startAuditServer } = require('../tests/jarvis-audit-common');

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
