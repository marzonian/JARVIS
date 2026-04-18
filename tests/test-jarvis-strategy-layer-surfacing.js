#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 180000;

async function getJson(baseUrl, endpoint, timeoutMs = TIMEOUT_MS) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getRaw(baseUrl, endpoint, timeoutMs = TIMEOUT_MS) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = { raw: text };
  }
  return {
    status: resp.status,
    ok: resp.ok,
    json,
  };
}

function assertStrategySnapshotShape(label, snapshot) {
  assert(snapshot && typeof snapshot === 'object', `${label} strategyLayerSnapshot missing`, { snapshot });
  assert(snapshot.originalPlan && typeof snapshot.originalPlan === 'object', `${label} originalPlan missing`, { snapshot });
  assert(snapshot.bestVariant && typeof snapshot.bestVariant === 'object', `${label} bestVariant missing`, { snapshot });
  assert(snapshot.bestAlternative && typeof snapshot.bestAlternative === 'object', `${label} bestAlternative missing`, { snapshot });
  assert(snapshot.recommendationBasis && typeof snapshot.recommendationBasis === 'object', `${label} recommendationBasis missing`, { snapshot });
  assert(snapshot.assistantDecisionBrief && typeof snapshot.assistantDecisionBrief === 'object', `${label} assistantDecisionBrief missing`, { snapshot });
  assert(typeof snapshot.executionStance === 'string' && snapshot.executionStance.length > 0, `${label} executionStance missing`, { snapshot });
  assert(Array.isArray(snapshot.strategyStack), `${label} strategyStack missing`, { snapshot });
  assert(snapshot.strategyStack.length >= 1, `${label} strategyStack empty`, { snapshot });
  assert(snapshot.strategyStackCard && typeof snapshot.strategyStackCard === 'object', `${label} strategyStackCard missing`, { snapshot });
  assert(snapshot.strategyWhyRecommended && typeof snapshot.strategyWhyRecommended === 'object', `${label} strategyWhyRecommended missing`, { snapshot });
  assert(typeof snapshot.strategyRecommendationLine === 'string' && snapshot.strategyRecommendationLine.length > 0, `${label} strategyRecommendationLine missing`, { snapshot });
  assert(typeof snapshot.strategyStanceLine === 'string' && snapshot.strategyStanceLine.length > 0, `${label} strategyStanceLine missing`, { snapshot });
  assert(typeof snapshot.strategyVoiceLine === 'string' && snapshot.strategyVoiceLine.length > 0, `${label} strategyVoiceLine missing`, { snapshot });
  assert(snapshot.strategyComparisonReadout && typeof snapshot.strategyComparisonReadout === 'object', `${label} strategyComparisonReadout missing`, { snapshot });
  assert(typeof snapshot.strategyComparisonLine === 'string' && snapshot.strategyComparisonLine.length > 0, `${label} strategyComparisonLine missing`, { snapshot });
  assert(typeof snapshot.strategyComparisonVoiceLine === 'string' && snapshot.strategyComparisonVoiceLine.length > 0, `${label} strategyComparisonVoiceLine missing`, { snapshot });
  assert(snapshot.opportunityScoring && typeof snapshot.opportunityScoring === 'object', `${label} opportunityScoring missing`, { snapshot });
  assert(typeof snapshot.opportunityScoreSummaryLine === 'string' && snapshot.opportunityScoreSummaryLine.length > 0, `${label} opportunityScoreSummaryLine missing`, { snapshot });
  assert(snapshot.heuristicVsOpportunityComparison && typeof snapshot.heuristicVsOpportunityComparison === 'object', `${label} heuristicVsOpportunityComparison missing`, { snapshot });
  assert(snapshot.liveOpportunityCandidates && typeof snapshot.liveOpportunityCandidates === 'object', `${label} liveOpportunityCandidates missing`, { snapshot });
  assert(Array.isArray(snapshot.liveOpportunityCandidates.candidates), `${label} liveOpportunityCandidates.candidates missing`, { snapshot });
  assert(typeof snapshot.liveOpportunityCandidates.summaryLine === 'string' && snapshot.liveOpportunityCandidates.summaryLine.length > 0, `${label} liveOpportunityCandidates.summaryLine missing`, { snapshot });
  assert(snapshot.liveCandidateStateMonitor && typeof snapshot.liveCandidateStateMonitor === 'object', `${label} liveCandidateStateMonitor missing`, { snapshot });
  assert(Array.isArray(snapshot.liveCandidateStateMonitor.monitoredCandidates), `${label} liveCandidateStateMonitor.monitoredCandidates missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.actionableTransitionDetected === 'boolean', `${label} liveCandidateStateMonitor.actionableTransitionDetected missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.actionableTransitionReason === 'string' && snapshot.liveCandidateStateMonitor.actionableTransitionReason.length > 0, `${label} liveCandidateStateMonitor.actionableTransitionReason missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.responseReadOnly === 'boolean', `${label} liveCandidateStateMonitor.responseReadOnly missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.responseWriteMode === 'string' && snapshot.liveCandidateStateMonitor.responseWriteMode.length > 0, `${label} liveCandidateStateMonitor.responseWriteMode missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.responseTriggeredAnyWrites === 'boolean', `${label} liveCandidateStateMonitor.responseTriggeredAnyWrites missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.responseTriggeredDurableWrites === 'boolean', `${label} liveCandidateStateMonitor.responseTriggeredDurableWrites missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.responseWriteSummaryLine === 'string' && snapshot.liveCandidateStateMonitor.responseWriteSummaryLine.length > 0, `${label} liveCandidateStateMonitor.responseWriteSummaryLine missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.historyProvenanceClassification === 'string' && snapshot.liveCandidateStateMonitor.historyProvenanceClassification.length > 0, `${label} liveCandidateStateMonitor.historyProvenanceClassification missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.historyProvenanceSummaryLine === 'string' && snapshot.liveCandidateStateMonitor.historyProvenanceSummaryLine.length > 0, `${label} liveCandidateStateMonitor.historyProvenanceSummaryLine missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'loopOnlyObservationCount'), `${label} liveCandidateStateMonitor.loopOnlyObservationCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'loopOnlyTransitionCount'), `${label} liveCandidateStateMonitor.loopOnlyTransitionCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'loopOnlyLatestTransition'), `${label} liveCandidateStateMonitor.loopOnlyLatestTransition missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.loopOnlyHistorySummaryLine === 'string' && snapshot.liveCandidateStateMonitor.loopOnlyHistorySummaryLine.length > 0, `${label} liveCandidateStateMonitor.loopOnlyHistorySummaryLine missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'diagnosticOnlyObservationCount'), `${label} liveCandidateStateMonitor.diagnosticOnlyObservationCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'diagnosticOnlyTransitionCount'), `${label} liveCandidateStateMonitor.diagnosticOnlyTransitionCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'diagnosticOnlyLatestTransition'), `${label} liveCandidateStateMonitor.diagnosticOnlyLatestTransition missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.diagnosticOnlyHistorySummaryLine === 'string' && snapshot.liveCandidateStateMonitor.diagnosticOnlyHistorySummaryLine.length > 0, `${label} liveCandidateStateMonitor.diagnosticOnlyHistorySummaryLine missing`, { snapshot });
  assert(snapshot.liveCandidateStateMonitor.historyViews && typeof snapshot.liveCandidateStateMonitor.historyViews === 'object', `${label} liveCandidateStateMonitor.historyViews missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.historyEvaluationMode === 'string' && snapshot.liveCandidateStateMonitor.historyEvaluationMode.length > 0, `${label} liveCandidateStateMonitor.historyEvaluationMode missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyEvaluationFallbackUsed'), `${label} liveCandidateStateMonitor.historyEvaluationFallbackUsed missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyEvaluationFallbackReason'), `${label} liveCandidateStateMonitor.historyEvaluationFallbackReason missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyEvaluationFallbackMode'), `${label} liveCandidateStateMonitor.historyEvaluationFallbackMode missing`, { snapshot });
  assert(Array.isArray(snapshot.liveCandidateStateMonitor.historyEvaluationReferenceModes), `${label} liveCandidateStateMonitor.historyEvaluationReferenceModes missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyEvaluationLatestTransition'), `${label} liveCandidateStateMonitor.historyEvaluationLatestTransition missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugDbPath'), `${label} liveCandidateStateMonitor.historyDebugDbPath missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugRequestedSessionDate'), `${label} liveCandidateStateMonitor.historyDebugRequestedSessionDate missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugEffectiveSessionDate'), `${label} liveCandidateStateMonitor.historyDebugEffectiveSessionDate missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugRowScope'), `${label} liveCandidateStateMonitor.historyDebugRowScope missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugRowScopeFallbackUsed'), `${label} liveCandidateStateMonitor.historyDebugRowScopeFallbackUsed missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugRowScopeFallbackReason'), `${label} liveCandidateStateMonitor.historyDebugRowScopeFallbackReason missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugLatestObservationAt'), `${label} liveCandidateStateMonitor.historyDebugLatestObservationAt missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateStateMonitor, 'historyDebugLatestTransitionAt'), `${label} liveCandidateStateMonitor.historyDebugLatestTransitionAt missing`, { snapshot });
  assert(['loop_only', 'all_history', 'diagnostic_only'].includes(String(snapshot.liveCandidateStateMonitor.historyEvaluationMode || '')), `${label} liveCandidateStateMonitor.historyEvaluationMode invalid`, { snapshot });
  if (String(snapshot.liveCandidateStateMonitor.historyEvaluationMode || '') !== 'loop_only') {
    assert(snapshot.liveCandidateStateMonitor.historyEvaluationFallbackUsed === true, `${label} liveCandidateStateMonitor must mark fallback when mode is not loop_only`, { snapshot });
  }
  assert(typeof snapshot.liveCandidateStateMonitor.historyEvaluationSummaryLine === 'string' && snapshot.liveCandidateStateMonitor.historyEvaluationSummaryLine.length > 0, `${label} liveCandidateStateMonitor.historyEvaluationSummaryLine missing`, { snapshot });
  assert(typeof snapshot.liveCandidateStateMonitor.summaryLine === 'string' && snapshot.liveCandidateStateMonitor.summaryLine.length > 0, `${label} liveCandidateStateMonitor.summaryLine missing`, { snapshot });
  assert(snapshot.liveCandidateTransitionHistory && typeof snapshot.liveCandidateTransitionHistory === 'object', `${label} liveCandidateTransitionHistory missing`, { snapshot });
  assert(Array.isArray(snapshot.liveCandidateTransitionHistory.recentTransitions), `${label} liveCandidateTransitionHistory.recentTransitions missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'latestTransition'), `${label} liveCandidateTransitionHistory.latestTransition missing`, { snapshot });
  assert(typeof snapshot.liveCandidateTransitionHistory.historyProvenanceClassification === 'string' && snapshot.liveCandidateTransitionHistory.historyProvenanceClassification.length > 0, `${label} liveCandidateTransitionHistory.historyProvenanceClassification missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'loopOnlyObservationCount'), `${label} liveCandidateTransitionHistory.loopOnlyObservationCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'loopOnlyTransitionCount'), `${label} liveCandidateTransitionHistory.loopOnlyTransitionCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'loopOnlyLatestTransition'), `${label} liveCandidateTransitionHistory.loopOnlyLatestTransition missing`, { snapshot });
  assert(typeof snapshot.liveCandidateTransitionHistory.loopOnlyHistorySummaryLine === 'string' && snapshot.liveCandidateTransitionHistory.loopOnlyHistorySummaryLine.length > 0, `${label} liveCandidateTransitionHistory.loopOnlyHistorySummaryLine missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'diagnosticOnlyObservationCount'), `${label} liveCandidateTransitionHistory.diagnosticOnlyObservationCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'diagnosticOnlyTransitionCount'), `${label} liveCandidateTransitionHistory.diagnosticOnlyTransitionCount missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'diagnosticOnlyLatestTransition'), `${label} liveCandidateTransitionHistory.diagnosticOnlyLatestTransition missing`, { snapshot });
  assert(typeof snapshot.liveCandidateTransitionHistory.diagnosticOnlyHistorySummaryLine === 'string' && snapshot.liveCandidateTransitionHistory.diagnosticOnlyHistorySummaryLine.length > 0, `${label} liveCandidateTransitionHistory.diagnosticOnlyHistorySummaryLine missing`, { snapshot });
  assert(snapshot.liveCandidateTransitionHistory.historyViews && typeof snapshot.liveCandidateTransitionHistory.historyViews === 'object', `${label} liveCandidateTransitionHistory.historyViews missing`, { snapshot });
  assert(typeof snapshot.liveCandidateTransitionHistory.historyEvaluationMode === 'string' && snapshot.liveCandidateTransitionHistory.historyEvaluationMode.length > 0, `${label} liveCandidateTransitionHistory.historyEvaluationMode missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyEvaluationFallbackUsed'), `${label} liveCandidateTransitionHistory.historyEvaluationFallbackUsed missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyEvaluationFallbackReason'), `${label} liveCandidateTransitionHistory.historyEvaluationFallbackReason missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyEvaluationFallbackMode'), `${label} liveCandidateTransitionHistory.historyEvaluationFallbackMode missing`, { snapshot });
  assert(Array.isArray(snapshot.liveCandidateTransitionHistory.historyEvaluationReferenceModes), `${label} liveCandidateTransitionHistory.historyEvaluationReferenceModes missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyEvaluationLatestTransition'), `${label} liveCandidateTransitionHistory.historyEvaluationLatestTransition missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugDbPath'), `${label} liveCandidateTransitionHistory.historyDebugDbPath missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugRequestedSessionDate'), `${label} liveCandidateTransitionHistory.historyDebugRequestedSessionDate missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugEffectiveSessionDate'), `${label} liveCandidateTransitionHistory.historyDebugEffectiveSessionDate missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugRowScope'), `${label} liveCandidateTransitionHistory.historyDebugRowScope missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugRowScopeFallbackUsed'), `${label} liveCandidateTransitionHistory.historyDebugRowScopeFallbackUsed missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugRowScopeFallbackReason'), `${label} liveCandidateTransitionHistory.historyDebugRowScopeFallbackReason missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugLatestObservationAt'), `${label} liveCandidateTransitionHistory.historyDebugLatestObservationAt missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateTransitionHistory, 'historyDebugLatestTransitionAt'), `${label} liveCandidateTransitionHistory.historyDebugLatestTransitionAt missing`, { snapshot });
  assert(['loop_only', 'all_history', 'diagnostic_only'].includes(String(snapshot.liveCandidateTransitionHistory.historyEvaluationMode || '')), `${label} liveCandidateTransitionHistory.historyEvaluationMode invalid`, { snapshot });
  if (String(snapshot.liveCandidateTransitionHistory.historyEvaluationMode || '') !== 'loop_only') {
    assert(snapshot.liveCandidateTransitionHistory.historyEvaluationFallbackUsed === true, `${label} liveCandidateTransitionHistory must mark fallback when mode is not loop_only`, { snapshot });
  }
  assert(typeof snapshot.liveCandidateTransitionHistory.historyEvaluationSummaryLine === 'string' && snapshot.liveCandidateTransitionHistory.historyEvaluationSummaryLine.length > 0, `${label} liveCandidateTransitionHistory.historyEvaluationSummaryLine missing`, { snapshot });
  assert(typeof snapshot.liveCandidateTransitionHistory.summaryLine === 'string' && snapshot.liveCandidateTransitionHistory.summaryLine.length > 0, `${label} liveCandidateTransitionHistory.summaryLine missing`, { snapshot });
  assert(snapshot.liveCandidateObservationLoopStatus && typeof snapshot.liveCandidateObservationLoopStatus === 'object', `${label} liveCandidateObservationLoopStatus missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.enabled === 'boolean', `${label} liveCandidateObservationLoopStatus.enabled missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.running === 'boolean', `${label} liveCandidateObservationLoopStatus.running missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.currentMode === 'string' && snapshot.liveCandidateObservationLoopStatus.currentMode.length > 0, `${label} liveCandidateObservationLoopStatus.currentMode missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.currentIntervalMs === 'number', `${label} liveCandidateObservationLoopStatus.currentIntervalMs missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateObservationLoopStatus, 'lastInputRefreshAt'), `${label} liveCandidateObservationLoopStatus.lastInputRefreshAt missing`, { snapshot });
  assert(Array.isArray(snapshot.liveCandidateObservationLoopStatus.refreshedInputSources), `${label} liveCandidateObservationLoopStatus.refreshedInputSources missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.staleInputWarning === 'boolean', `${label} liveCandidateObservationLoopStatus.staleInputWarning missing`, { snapshot });
  assert(Array.isArray(snapshot.liveCandidateObservationLoopStatus.staleInputReasonCodes), `${label} liveCandidateObservationLoopStatus.staleInputReasonCodes missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateObservationLoopStatus, 'lastObservedMarketTimestamp'), `${label} liveCandidateObservationLoopStatus.lastObservedMarketTimestamp missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateObservationLoopStatus, 'lastObservedDecisionTimestamp'), `${label} liveCandidateObservationLoopStatus.lastObservedDecisionTimestamp missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateObservationLoopStatus, 'lastObservedContextTimestamp'), `${label} liveCandidateObservationLoopStatus.lastObservedContextTimestamp missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.lastStateClassification === 'string' && snapshot.liveCandidateObservationLoopStatus.lastStateClassification.length > 0, `${label} liveCandidateObservationLoopStatus.lastStateClassification missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.lastResponseReadOnly === 'boolean', `${label} liveCandidateObservationLoopStatus.lastResponseReadOnly missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateObservationLoopStatus, 'lastObservationWriteSource'), `${label} liveCandidateObservationLoopStatus.lastObservationWriteSource missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveCandidateObservationLoopStatus, 'lastHistoryProvenanceClassification'), `${label} liveCandidateObservationLoopStatus.lastHistoryProvenanceClassification missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatus.summaryLine === 'string' && snapshot.liveCandidateObservationLoopStatus.summaryLine.length > 0, `${label} liveCandidateObservationLoopStatus.summaryLine missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationLoopStatusLine === 'string' && snapshot.liveCandidateObservationLoopStatusLine.length > 0, `${label} liveCandidateObservationLoopStatusLine missing`, { snapshot });
  assert(snapshot.liveCandidateObservationRenderMode && typeof snapshot.liveCandidateObservationRenderMode === 'object', `${label} liveCandidateObservationRenderMode missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationRenderMode.responseReadOnly === 'boolean', `${label} liveCandidateObservationRenderMode.responseReadOnly missing`, { snapshot });
  assert(typeof snapshot.liveCandidateObservationRenderModeLine === 'string' && snapshot.liveCandidateObservationRenderModeLine.length > 0, `${label} liveCandidateObservationRenderModeLine missing`, { snapshot });
  assert(snapshot.liveOpportunityCandidates.topCandidateOverall && typeof snapshot.liveOpportunityCandidates.topCandidateOverall === 'object', `${label} liveOpportunityCandidates.topCandidateOverall missing`, { snapshot });
  assert(snapshot.liveOpportunityCandidates.topCandidateActionableNow === null || typeof snapshot.liveOpportunityCandidates.topCandidateActionableNow === 'object', `${label} liveOpportunityCandidates.topCandidateActionableNow should be object|null`, { snapshot });
  assert(typeof snapshot.liveOpportunityCandidates.hasActionableCandidateNow === 'boolean', `${label} liveOpportunityCandidates.hasActionableCandidateNow missing`, { snapshot });
  assert(typeof snapshot.liveOpportunityCandidates.actionableNowSummaryLine === 'string' && snapshot.liveOpportunityCandidates.actionableNowSummaryLine.length > 0, `${label} liveOpportunityCandidates.actionableNowSummaryLine missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveOpportunityCandidates, 'noActionableReasonCode'), `${label} liveOpportunityCandidates.noActionableReasonCode missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.liveOpportunityCandidates, 'noActionableReasonLine'), `${label} liveOpportunityCandidates.noActionableReasonLine missing`, { snapshot });
  assert(snapshot.liveOpportunityCandidates.candidateSourceCounts && typeof snapshot.liveOpportunityCandidates.candidateSourceCounts === 'object', `${label} liveOpportunityCandidates.candidateSourceCounts missing`, { snapshot });
  assert(typeof snapshot.liveOpportunityCandidates.candidateDiversitySummaryLine === 'string' && snapshot.liveOpportunityCandidates.candidateDiversitySummaryLine.length > 0, `${label} liveOpportunityCandidates.candidateDiversitySummaryLine missing`, { snapshot });
  assert(snapshot.strategyCandidateOpportunityBridge && typeof snapshot.strategyCandidateOpportunityBridge === 'object', `${label} strategyCandidateOpportunityBridge missing`, { snapshot });
  assert(['agree', 'disagree'].includes(String(snapshot.strategyCandidateOpportunityBridge.status || '')), `${label} strategyCandidateOpportunityBridge status missing`, { snapshot });
  assert(snapshot.shadowMockTradeDecision && typeof snapshot.shadowMockTradeDecision === 'object', `${label} shadowMockTradeDecision missing`, { snapshot });
  assert(Object.prototype.hasOwnProperty.call(snapshot.shadowMockTradeDecision, 'eligible'), `${label} shadowMockTradeDecision.eligible missing`, { snapshot });
  assert(typeof snapshot.shadowMockTradeDecision.status === 'string' && snapshot.shadowMockTradeDecision.status.length > 0, `${label} shadowMockTradeDecision.status missing`, { snapshot });
  assert(typeof snapshot.shadowMockTradeDecision.reason === 'string' && snapshot.shadowMockTradeDecision.reason.length > 0, `${label} shadowMockTradeDecision.reason missing`, { snapshot });
  assert(typeof snapshot.shadowMockTradeDecision.tradePlanSummaryLine === 'string' && snapshot.shadowMockTradeDecision.tradePlanSummaryLine.length > 0, `${label} shadowMockTradeDecision.tradePlanSummaryLine missing`, { snapshot });
  assert(snapshot.shadowMockTradeLedger && typeof snapshot.shadowMockTradeLedger === 'object', `${label} shadowMockTradeLedger missing`, { snapshot });
  assert(Array.isArray(snapshot.shadowMockTradeLedger.pending), `${label} shadowMockTradeLedger.pending missing`, { snapshot });
  assert(Array.isArray(snapshot.shadowMockTradeLedger.open), `${label} shadowMockTradeLedger.open missing`, { snapshot });
  assert(Array.isArray(snapshot.shadowMockTradeLedger.closed), `${label} shadowMockTradeLedger.closed missing`, { snapshot });
  assert(typeof snapshot.shadowMockTradeLedger.summaryLine === 'string' && snapshot.shadowMockTradeLedger.summaryLine.length > 0, `${label} shadowMockTradeLedger.summaryLine missing`, { snapshot });
  assert(snapshot.todayRecommendationMirror && typeof snapshot.todayRecommendationMirror === 'object', `${label} todayRecommendationMirror missing`, { snapshot });
  assert(snapshot.decisionBoardMirror && typeof snapshot.decisionBoardMirror === 'object', `${label} decisionBoardMirror missing`, { snapshot });
  assert(snapshot.todayRecommendationMirror.liveCandidateStateMonitor && typeof snapshot.todayRecommendationMirror.liveCandidateStateMonitor === 'object', `${label} todayRecommendationMirror.liveCandidateStateMonitor missing`, { snapshot });
  assert(snapshot.decisionBoardMirror.liveCandidateStateMonitor && typeof snapshot.decisionBoardMirror.liveCandidateStateMonitor === 'object', `${label} decisionBoardMirror.liveCandidateStateMonitor missing`, { snapshot });
  assert(snapshot.todayRecommendationMirror.liveCandidateTransitionHistory && typeof snapshot.todayRecommendationMirror.liveCandidateTransitionHistory === 'object', `${label} todayRecommendationMirror.liveCandidateTransitionHistory missing`, { snapshot });
  assert(snapshot.decisionBoardMirror.liveCandidateTransitionHistory && typeof snapshot.decisionBoardMirror.liveCandidateTransitionHistory === 'object', `${label} decisionBoardMirror.liveCandidateTransitionHistory missing`, { snapshot });
  assert(snapshot.todayRecommendationMirror.liveCandidateObservationLoopStatus && typeof snapshot.todayRecommendationMirror.liveCandidateObservationLoopStatus === 'object', `${label} todayRecommendationMirror.liveCandidateObservationLoopStatus missing`, { snapshot });
  assert(snapshot.decisionBoardMirror.liveCandidateObservationLoopStatus && typeof snapshot.decisionBoardMirror.liveCandidateObservationLoopStatus === 'object', `${label} decisionBoardMirror.liveCandidateObservationLoopStatus missing`, { snapshot });
  assert(typeof snapshot.todayRecommendationMirror.liveCandidateObservationLoopStatusLine === 'string' && snapshot.todayRecommendationMirror.liveCandidateObservationLoopStatusLine.length > 0, `${label} todayRecommendationMirror.liveCandidateObservationLoopStatusLine missing`, { snapshot });
  assert(typeof snapshot.decisionBoardMirror.liveCandidateObservationLoopStatusLine === 'string' && snapshot.decisionBoardMirror.liveCandidateObservationLoopStatusLine.length > 0, `${label} decisionBoardMirror.liveCandidateObservationLoopStatusLine missing`, { snapshot });
  assert(snapshot.todayRecommendationMirror.liveCandidateObservationRenderMode && typeof snapshot.todayRecommendationMirror.liveCandidateObservationRenderMode === 'object', `${label} todayRecommendationMirror.liveCandidateObservationRenderMode missing`, { snapshot });
  assert(snapshot.decisionBoardMirror.liveCandidateObservationRenderMode && typeof snapshot.decisionBoardMirror.liveCandidateObservationRenderMode === 'object', `${label} decisionBoardMirror.liveCandidateObservationRenderMode missing`, { snapshot });

  for (const row of snapshot.strategyStack) {
    assert(typeof row.available === 'boolean', `${label} strategy stack row missing available flag`, { row });
    assert(row.pineAccess && typeof row.pineAccess === 'object', `${label} strategy stack row pineAccess missing`, { row });
    assert(typeof row.pineAccess.endpoint === 'string' && row.pineAccess.endpoint.startsWith('/api/jarvis/strategy/pine?'), `${label} pineAccess endpoint missing`, { row });
    assert(String(row.pineAccess.format || '').toLowerCase() === 'pine_v6', `${label} pineAccess format must be pine_v6`, { row });
  }

  const cards = Array.isArray(snapshot?.strategyStackCard?.cards) ? snapshot.strategyStackCard.cards : [];
  assert(cards.length === 3, `${label} strategyStackCard.cards should expose original/variant/alternative`, { cards });
  for (const card of cards) {
    assert(typeof card.title === 'string' && card.title.length > 0, `${label} strategy card title missing`, { card });
    assert(typeof card.key === 'string' && card.key.length > 0, `${label} strategy card key missing`, { card });
    assert(typeof card.layer === 'string' && card.layer.length > 0, `${label} strategy card layer missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'suitability'), `${label} strategy card suitability missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'score'), `${label} strategy card score missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'winRate'), `${label} strategy card winRate missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'profitFactor'), `${label} strategy card profitFactor missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'maxDrawdownDollars'), `${label} strategy card maxDrawdownDollars missing`, { card });
    assert(typeof card.recommendationStatus === 'string' && card.recommendationStatus.length > 0, `${label} strategy card recommendationStatus missing`, { card });
    assert(card.pineAccess && typeof card.pineAccess === 'object', `${label} strategy card pineAccess missing`, { card });
    assert(typeof card.pineAccess.endpoint === 'string' && card.pineAccess.endpoint.startsWith('/api/jarvis/strategy/pine?'), `${label} strategy card pineAccess endpoint missing`, { card });
    assert(String(card.pineAccess.format || '').toLowerCase() === 'pine_v6', `${label} strategy card pineAccess format invalid`, { card });
    assert(card.pineContractRef === card.pineAccess.endpoint, `${label} strategy card pine contract ref mismatch`, { card });
  }

  const comparisonRows = Array.isArray(snapshot?.strategyComparisonReadout?.comparisonRows)
    ? snapshot.strategyComparisonReadout.comparisonRows
    : [];
  assert(comparisonRows.length >= 3, `${label} strategy comparison rows missing`, { comparisonRows });
  const recommendedRows = comparisonRows.filter((row) => row?.isRecommended === true);
  assert(recommendedRows.length === 1, `${label} strategy comparison should mark exactly one recommended row`, { comparisonRows });
  for (const row of comparisonRows) {
    assert(typeof row.key === 'string' && row.key.length > 0, `${label} strategy comparison row key missing`, { row });
    assert(typeof row.name === 'string' && row.name.length > 0, `${label} strategy comparison row name missing`, { row });
    assert(typeof row.layer === 'string' && row.layer.length > 0, `${label} strategy comparison row layer missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'winRate'), `${label} strategy comparison row winRate missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'profitFactor'), `${label} strategy comparison row profitFactor missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'maxDrawdownDollars'), `${label} strategy comparison row maxDrawdownDollars missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'suitability') || Object.prototype.hasOwnProperty.call(row, 'score'), `${label} strategy comparison row score/suitability missing`, { row });
    assert(typeof row.whyChosenOrNot === 'string' && row.whyChosenOrNot.length > 0, `${label} strategy comparison row whyChosenOrNot missing`, { row });
    assert(typeof row.tradeoffLine === 'string' && row.tradeoffLine.length > 0, `${label} strategy comparison row tradeoffLine missing`, { row });
  }
  const nonRecommendedRows = comparisonRows.filter((row) => row?.isRecommended !== true);
  assert(nonRecommendedRows.every((row) => typeof row.whyChosenOrNot === 'string' && row.whyChosenOrNot.length > 0), `${label} non-recommended rows should include whyChosenOrNot`, { nonRecommendedRows });

  const opportunityRows = Array.isArray(snapshot?.opportunityScoring?.comparisonRows)
    ? snapshot.opportunityScoring.comparisonRows
    : [];
  assert(opportunityRows.length >= 1, `${label} opportunity scoring rows missing`, { opportunityRows });
  for (const row of opportunityRows) {
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityWinProb'), `${label} opportunity row missing win prob`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityExpectedValue'), `${label} opportunity row missing EV`, { row });
    assert(typeof row.opportunityCalibrationBand === 'string' && row.opportunityCalibrationBand.length > 0, `${label} opportunity row missing calibration band`, { row });
    assert(row.opportunityFeatureVector && typeof row.opportunityFeatureVector === 'object', `${label} opportunity row missing feature vector`, { row });
    assert(typeof row.opportunityScoreSummaryLine === 'string' && row.opportunityScoreSummaryLine.length > 0, `${label} opportunity row missing summary line`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'heuristicCompositeScore'), `${label} opportunity row missing heuristic score`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityCompositeScore'), `${label} opportunity row missing opportunity score`, { row });
    assert(row.heuristicVsOpportunityComparison && typeof row.heuristicVsOpportunityComparison === 'object', `${label} opportunity row missing comparison object`, { row });
  }

  const candidateRows = Array.isArray(snapshot?.liveOpportunityCandidates?.candidates)
    ? snapshot.liveOpportunityCandidates.candidates
    : [];
  assert(candidateRows.length >= 1, `${label} liveOpportunityCandidates rows missing`, { candidateRows });
  for (const row of candidateRows) {
    assert(typeof row.candidateKey === 'string' && row.candidateKey.length > 0, `${label} candidate row candidateKey missing`, { row });
    assert(typeof row.strategyKey === 'string' && row.strategyKey.length > 0, `${label} candidate row strategyKey missing`, { row });
    assert(typeof row.strategyLayer === 'string' && row.strategyLayer.length > 0, `${label} candidate row strategyLayer missing`, { row });
    assert(typeof row.candidateSource === 'string' && row.candidateSource.length > 0, `${label} candidate row candidateSource missing`, { row });
    assert(typeof row.candidateType === 'string' && row.candidateType.length > 0, `${label} candidate row candidateType missing`, { row });
    assert(typeof row.direction === 'string' && row.direction.length > 0, `${label} candidate row direction missing`, { row });
    assert(typeof row.entryWindow === 'string' && row.entryWindow.length > 0, `${label} candidate row entryWindow missing`, { row });
    assert(typeof row.sessionPhase === 'string' || row.sessionPhase === null, `${label} candidate row sessionPhase missing`, { row });
    assert(typeof row.timeBucket === 'string' && row.timeBucket.length > 0, `${label} candidate row timeBucket missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'regime'), `${label} candidate row regime missing`, { row });
    assert(row.triggerStructure && typeof row.triggerStructure === 'object', `${label} candidate row triggerStructure missing`, { row });
    assert(typeof row.candidateStatus === 'string' && row.candidateStatus.length > 0, `${label} candidate row candidateStatus missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'candidateWinProb'), `${label} candidate row candidateWinProb missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'candidateExpectedValue'), `${label} candidate row candidateExpectedValue missing`, { row });
    assert(typeof row.candidateCalibrationBand === 'string' && row.candidateCalibrationBand.length > 0, `${label} candidate row calibration missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'structureQualityScore'), `${label} candidate row structureQualityScore missing`, { row });
    assert(typeof row.structureQualityLabel === 'string' && row.structureQualityLabel.length > 0, `${label} candidate row structureQualityLabel missing`, { row });
    assert(Array.isArray(row.structureQualityReasonCodes), `${label} candidate row structureQualityReasonCodes missing`, { row });
    assert(typeof row.structureQualitySummaryLine === 'string' && row.structureQualitySummaryLine.length > 0, `${label} candidate row structureQualitySummaryLine missing`, { row });
    assert(row.candidateFeatureVector && typeof row.candidateFeatureVector === 'object', `${label} candidate row feature vector missing`, { row });
    assert(typeof row.candidateScoreSummaryLine === 'string' && row.candidateScoreSummaryLine.length > 0, `${label} candidate row score summary missing`, { row });
    assert(typeof row.candidateSummaryLine === 'string' && row.candidateSummaryLine.length > 0, `${label} candidate row summary line missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'candidateQualityPenalty'), `${label} candidate row quality penalty missing`, { row });
    assert(Array.isArray(row.candidateQualityReasonCodes), `${label} candidate row quality reasons missing`, { row });
  }
  const sourceSet = new Set(candidateRows.map((row) => String(row?.candidateSource || '').trim()));
  assert(sourceSet.has('strategy_stack'), `${label} candidate rows should include strategy_stack source`, { candidateRows });
  assert(sourceSet.has('decision_top_setup'), `${label} candidate rows should include decision_top_setup source`, { candidateRows });
  assert(sourceSet.has('live_structure'), `${label} candidate rows should include live_structure source`, { candidateRows });
}

(async () => {
  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => {
    console.log(`✅ ${name}`);
  };

  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3186,
    env: {
      DATABENTO_API_ENABLED: 'false',
      DATABENTO_API_KEY: '',
      TOPSTEP_API_ENABLED: 'false',
      TOPSTEP_API_KEY: '',
      NEWS_ENABLED: 'false',
      DISCORD_BOT_TOKEN: '',
    },
  });

  try {
    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1');
    assert(center?.status === 'ok', 'command-center status should be ok', { center });
    assertStrategySnapshotShape('command-center root', center.strategyLayerSnapshot);
    assert(center.originalPlan && typeof center.originalPlan === 'object', 'command-center originalPlan root field missing', { center });
    assert(center.bestVariant && typeof center.bestVariant === 'object', 'command-center bestVariant root field missing', { center });
    assert(center.bestAlternative && typeof center.bestAlternative === 'object', 'command-center bestAlternative root field missing', { center });
    assert(center.recommendationBasis && typeof center.recommendationBasis === 'object', 'command-center recommendationBasis root field missing', { center });
    assert(center.assistantDecisionBrief && typeof center.assistantDecisionBrief === 'object', 'command-center assistantDecisionBrief root field missing', { center });
    assert(typeof center.executionStance === 'string' && center.executionStance.length > 0, 'command-center executionStance root field missing', { center });
    assert(Array.isArray(center.strategyStack), 'command-center strategyStack root field missing', { center });
    assert(center.strategyStackCard && typeof center.strategyStackCard === 'object', 'command-center strategyStackCard root field missing', { center });
    assert(center.strategyWhyRecommended && typeof center.strategyWhyRecommended === 'object', 'command-center strategyWhyRecommended root field missing', { center });
    assert(typeof center.strategyRecommendationLine === 'string' && center.strategyRecommendationLine.length > 0, 'command-center strategyRecommendationLine root field missing', { center });
    assert(typeof center.strategyStanceLine === 'string' && center.strategyStanceLine.length > 0, 'command-center strategyStanceLine root field missing', { center });
    assert(typeof center.strategyVoiceLine === 'string' && center.strategyVoiceLine.length > 0, 'command-center strategyVoiceLine root field missing', { center });
    assert(center.strategyComparisonReadout && typeof center.strategyComparisonReadout === 'object', 'command-center strategyComparisonReadout root field missing', { center });
    assert(typeof center.strategyComparisonLine === 'string' && center.strategyComparisonLine.length > 0, 'command-center strategyComparisonLine root field missing', { center });
    assert(typeof center.strategyComparisonVoiceLine === 'string' && center.strategyComparisonVoiceLine.length > 0, 'command-center strategyComparisonVoiceLine root field missing', { center });
    assert(center.opportunityScoring && typeof center.opportunityScoring === 'object', 'command-center opportunityScoring root field missing', { center });
    assert(typeof center.opportunityScoreSummaryLine === 'string' && center.opportunityScoreSummaryLine.length > 0, 'command-center opportunityScoreSummaryLine root field missing', { center });
    assert(center.heuristicVsOpportunityComparison && typeof center.heuristicVsOpportunityComparison === 'object', 'command-center heuristicVsOpportunityComparison root field missing', { center });
    assert(center.liveOpportunityCandidates && typeof center.liveOpportunityCandidates === 'object', 'command-center liveOpportunityCandidates root field missing', { center });
    assert(center.liveCandidateStateMonitor && typeof center.liveCandidateStateMonitor === 'object', 'command-center liveCandidateStateMonitor root field missing', { center });
    assert(center.liveCandidateTransitionHistory && typeof center.liveCandidateTransitionHistory === 'object', 'command-center liveCandidateTransitionHistory root field missing', { center });
    assert(center.liveCandidateObservationLoopStatus && typeof center.liveCandidateObservationLoopStatus === 'object', 'command-center liveCandidateObservationLoopStatus root field missing', { center });
    assert(typeof center.liveCandidateObservationLoopStatusLine === 'string' && center.liveCandidateObservationLoopStatusLine.length > 0, 'command-center liveCandidateObservationLoopStatusLine root field missing', { center });
    assert(center.liveCandidateObservationRenderMode && typeof center.liveCandidateObservationRenderMode === 'object', 'command-center liveCandidateObservationRenderMode root field missing', { center });
    assert(typeof center.liveCandidateObservationRenderMode.responseReadOnly === 'boolean', 'command-center liveCandidateObservationRenderMode.responseReadOnly missing', { center });
    assert(center.strategyCandidateOpportunityBridge && typeof center.strategyCandidateOpportunityBridge === 'object', 'command-center strategyCandidateOpportunityBridge root field missing', { center });
    assert(center.shadowMockTradeDecision && typeof center.shadowMockTradeDecision === 'object', 'command-center shadowMockTradeDecision root field missing', { center });
    assert(center.shadowMockTradeLedger && typeof center.shadowMockTradeLedger === 'object', 'command-center shadowMockTradeLedger root field missing', { center });
    assert(center.todayRecommendation && typeof center.todayRecommendation === 'object', 'command-center todayRecommendation root mirror missing', { center });
    assert(center.decisionBoard && typeof center.decisionBoard === 'object', 'command-center decisionBoard root mirror missing', { center });

    assert(center.commandCenter && typeof center.commandCenter === 'object', 'commandCenter payload missing', { center });
    assert(center.commandCenter.strategyLayerSnapshot && typeof center.commandCenter.strategyLayerSnapshot === 'object', 'commandCenter.strategyLayerSnapshot missing', { center });
    assert(center.commandCenter.todayRecommendation && typeof center.commandCenter.todayRecommendation === 'object', 'commandCenter.todayRecommendation missing', { center });
    assert(center.commandCenter.decisionBoard && typeof center.commandCenter.decisionBoard === 'object', 'commandCenter.decisionBoard missing', { center });
    assert(center.commandCenter.todayRecommendation.strategyStackCard && typeof center.commandCenter.todayRecommendation.strategyStackCard === 'object', 'todayRecommendation strategyStackCard mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.strategyWhyRecommended && typeof center.commandCenter.todayRecommendation.strategyWhyRecommended === 'object', 'todayRecommendation strategyWhyRecommended mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyStackCard && typeof center.commandCenter.decisionBoard.strategyStackCard === 'object', 'decisionBoard strategyStackCard mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyWhyRecommended && typeof center.commandCenter.decisionBoard.strategyWhyRecommended === 'object', 'decisionBoard strategyWhyRecommended mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.strategyComparisonReadout && typeof center.commandCenter.todayRecommendation.strategyComparisonReadout === 'object', 'todayRecommendation strategyComparisonReadout mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyComparisonReadout && typeof center.commandCenter.decisionBoard.strategyComparisonReadout === 'object', 'decisionBoard strategyComparisonReadout mirror missing', { center });
    assert(typeof center.commandCenter.todayRecommendation.strategyComparisonLine === 'string' && center.commandCenter.todayRecommendation.strategyComparisonLine.length > 0, 'todayRecommendation strategyComparisonLine mirror missing', { center });
    assert(typeof center.commandCenter.decisionBoard.strategyComparisonLine === 'string' && center.commandCenter.decisionBoard.strategyComparisonLine.length > 0, 'decisionBoard strategyComparisonLine mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.originalPlan && typeof center.commandCenter.todayRecommendation.originalPlan === 'object', 'todayRecommendation originalPlan mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.bestVariant && typeof center.commandCenter.todayRecommendation.bestVariant === 'object', 'todayRecommendation bestVariant mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.bestAlternative && typeof center.commandCenter.todayRecommendation.bestAlternative === 'object', 'todayRecommendation bestAlternative mirror missing', { center });
    assert(center.commandCenter.decisionBoard.originalPlan && typeof center.commandCenter.decisionBoard.originalPlan === 'object', 'decisionBoard originalPlan mirror missing', { center });
    assert(center.commandCenter.decisionBoard.bestVariant && typeof center.commandCenter.decisionBoard.bestVariant === 'object', 'decisionBoard bestVariant mirror missing', { center });
    assert(center.commandCenter.decisionBoard.bestAlternative && typeof center.commandCenter.decisionBoard.bestAlternative === 'object', 'decisionBoard bestAlternative mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.opportunityScoring && typeof center.commandCenter.todayRecommendation.opportunityScoring === 'object', 'todayRecommendation opportunityScoring mirror missing', { center });
    assert(center.commandCenter.decisionBoard.opportunityScoring && typeof center.commandCenter.decisionBoard.opportunityScoring === 'object', 'decisionBoard opportunityScoring mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.liveOpportunityCandidates && typeof center.commandCenter.todayRecommendation.liveOpportunityCandidates === 'object', 'todayRecommendation liveOpportunityCandidates mirror missing', { center });
    assert(center.commandCenter.decisionBoard.liveOpportunityCandidates && typeof center.commandCenter.decisionBoard.liveOpportunityCandidates === 'object', 'decisionBoard liveOpportunityCandidates mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.liveCandidateStateMonitor && typeof center.commandCenter.todayRecommendation.liveCandidateStateMonitor === 'object', 'todayRecommendation liveCandidateStateMonitor mirror missing', { center });
    assert(center.commandCenter.decisionBoard.liveCandidateStateMonitor && typeof center.commandCenter.decisionBoard.liveCandidateStateMonitor === 'object', 'decisionBoard liveCandidateStateMonitor mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.liveCandidateTransitionHistory && typeof center.commandCenter.todayRecommendation.liveCandidateTransitionHistory === 'object', 'todayRecommendation liveCandidateTransitionHistory mirror missing', { center });
    assert(center.commandCenter.decisionBoard.liveCandidateTransitionHistory && typeof center.commandCenter.decisionBoard.liveCandidateTransitionHistory === 'object', 'decisionBoard liveCandidateTransitionHistory mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.liveCandidateObservationLoopStatus && typeof center.commandCenter.todayRecommendation.liveCandidateObservationLoopStatus === 'object', 'todayRecommendation liveCandidateObservationLoopStatus mirror missing', { center });
    assert(center.commandCenter.decisionBoard.liveCandidateObservationLoopStatus && typeof center.commandCenter.decisionBoard.liveCandidateObservationLoopStatus === 'object', 'decisionBoard liveCandidateObservationLoopStatus mirror missing', { center });
    assert(typeof center.commandCenter.todayRecommendation.liveCandidateObservationLoopStatusLine === 'string' && center.commandCenter.todayRecommendation.liveCandidateObservationLoopStatusLine.length > 0, 'todayRecommendation liveCandidateObservationLoopStatusLine mirror missing', { center });
    assert(typeof center.commandCenter.decisionBoard.liveCandidateObservationLoopStatusLine === 'string' && center.commandCenter.decisionBoard.liveCandidateObservationLoopStatusLine.length > 0, 'decisionBoard liveCandidateObservationLoopStatusLine mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.liveCandidateObservationRenderMode && typeof center.commandCenter.todayRecommendation.liveCandidateObservationRenderMode === 'object', 'todayRecommendation liveCandidateObservationRenderMode mirror missing', { center });
    assert(center.commandCenter.decisionBoard.liveCandidateObservationRenderMode && typeof center.commandCenter.decisionBoard.liveCandidateObservationRenderMode === 'object', 'decisionBoard liveCandidateObservationRenderMode mirror missing', { center });
    assert(center.liveCandidateStateMonitor.responseReadOnly === true, 'command-center default read should be read-only for durable candidate history', { center });
    assert(center.liveCandidateStateMonitor.observationWriteEnabled === false, 'command-center default read should not enable observation writes', { center });
    assert(center.liveCandidateObservationRenderMode.responseReadOnly === true, 'command-center render mode should report read-only default', { center });
    const centerDiagnostic = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1&observationWrite=1');
    assert(centerDiagnostic.liveCandidateStateMonitor && centerDiagnostic.liveCandidateStateMonitor.responseReadOnly === false, 'command-center diagnostic mode should enable write path explicitly', { centerDiagnostic });
    assert(String(centerDiagnostic.liveCandidateStateMonitor.observationWriteSource || '') === 'endpoint_diagnostic', 'command-center diagnostic mode should surface endpoint_diagnostic source', { centerDiagnostic });
    assert(center.commandCenter.todayRecommendation.strategyCandidateOpportunityBridge && typeof center.commandCenter.todayRecommendation.strategyCandidateOpportunityBridge === 'object', 'todayRecommendation strategyCandidateOpportunityBridge mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyCandidateOpportunityBridge && typeof center.commandCenter.decisionBoard.strategyCandidateOpportunityBridge === 'object', 'decisionBoard strategyCandidateOpportunityBridge mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.shadowMockTradeDecision && typeof center.commandCenter.todayRecommendation.shadowMockTradeDecision === 'object', 'todayRecommendation shadowMockTradeDecision mirror missing', { center });
    assert(center.commandCenter.decisionBoard.shadowMockTradeDecision && typeof center.commandCenter.decisionBoard.shadowMockTradeDecision === 'object', 'decisionBoard shadowMockTradeDecision mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.shadowMockTradeLedger && typeof center.commandCenter.todayRecommendation.shadowMockTradeLedger === 'object', 'todayRecommendation shadowMockTradeLedger mirror missing', { center });
    assert(center.commandCenter.decisionBoard.shadowMockTradeLedger && typeof center.commandCenter.decisionBoard.shadowMockTradeLedger === 'object', 'decisionBoard shadowMockTradeLedger mirror missing', { center });
    pass('command-center strategy-layer snapshot and mirrors');

    const perf = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?force=1');
    assert(perf?.status === 'ok', 'recommendation/performance status should be ok', { perf });
    assertStrategySnapshotShape('recommendation/performance root', perf.strategyLayerSnapshot);
    assert(perf.recommendationPerformance && typeof perf.recommendationPerformance === 'object', 'recommendationPerformance object missing', { perf });
    assert(perf.recommendationPerformance.strategyLayerSnapshot && typeof perf.recommendationPerformance.strategyLayerSnapshot === 'object', 'recommendationPerformance.strategyLayerSnapshot missing', { perf });
    assert(perf.recommendationPerformance.originalPlan && typeof perf.recommendationPerformance.originalPlan === 'object', 'recommendationPerformance.originalPlan missing', { perf });
    assert(perf.recommendationPerformance.bestVariant && typeof perf.recommendationPerformance.bestVariant === 'object', 'recommendationPerformance.bestVariant missing', { perf });
    assert(perf.recommendationPerformance.bestAlternative && typeof perf.recommendationPerformance.bestAlternative === 'object', 'recommendationPerformance.bestAlternative missing', { perf });
    assert(perf.recommendationPerformance.recommendationBasis && typeof perf.recommendationPerformance.recommendationBasis === 'object', 'recommendationPerformance.recommendationBasis missing', { perf });
    assert(perf.recommendationPerformance.assistantDecisionBrief && typeof perf.recommendationPerformance.assistantDecisionBrief === 'object', 'recommendationPerformance.assistantDecisionBrief missing', { perf });
    assert(typeof perf.recommendationPerformance.executionStance === 'string' && perf.recommendationPerformance.executionStance.length > 0, 'recommendationPerformance.executionStance missing', { perf });
    assert(Array.isArray(perf.recommendationPerformance.strategyStack), 'recommendationPerformance.strategyStack missing', { perf });
    assert(perf.recommendationPerformance.strategyStackCard && typeof perf.recommendationPerformance.strategyStackCard === 'object', 'recommendationPerformance.strategyStackCard missing', { perf });
    assert(perf.recommendationPerformance.strategyWhyRecommended && typeof perf.recommendationPerformance.strategyWhyRecommended === 'object', 'recommendationPerformance.strategyWhyRecommended missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyRecommendationLine === 'string' && perf.recommendationPerformance.strategyRecommendationLine.length > 0, 'recommendationPerformance.strategyRecommendationLine missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyStanceLine === 'string' && perf.recommendationPerformance.strategyStanceLine.length > 0, 'recommendationPerformance.strategyStanceLine missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyVoiceLine === 'string' && perf.recommendationPerformance.strategyVoiceLine.length > 0, 'recommendationPerformance.strategyVoiceLine missing', { perf });
    assert(perf.recommendationPerformance.strategyComparisonReadout && typeof perf.recommendationPerformance.strategyComparisonReadout === 'object', 'recommendationPerformance.strategyComparisonReadout missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyComparisonLine === 'string' && perf.recommendationPerformance.strategyComparisonLine.length > 0, 'recommendationPerformance.strategyComparisonLine missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyComparisonVoiceLine === 'string' && perf.recommendationPerformance.strategyComparisonVoiceLine.length > 0, 'recommendationPerformance.strategyComparisonVoiceLine missing', { perf });
    assert(perf.recommendationPerformance.opportunityScoring && typeof perf.recommendationPerformance.opportunityScoring === 'object', 'recommendationPerformance.opportunityScoring missing', { perf });
    assert(typeof perf.recommendationPerformance.opportunityScoreSummaryLine === 'string' && perf.recommendationPerformance.opportunityScoreSummaryLine.length > 0, 'recommendationPerformance.opportunityScoreSummaryLine missing', { perf });
    assert(perf.recommendationPerformance.heuristicVsOpportunityComparison && typeof perf.recommendationPerformance.heuristicVsOpportunityComparison === 'object', 'recommendationPerformance.heuristicVsOpportunityComparison missing', { perf });
    assert(perf.recommendationPerformance.liveOpportunityCandidates && typeof perf.recommendationPerformance.liveOpportunityCandidates === 'object', 'recommendationPerformance.liveOpportunityCandidates missing', { perf });
    assert(perf.recommendationPerformance.liveCandidateStateMonitor && typeof perf.recommendationPerformance.liveCandidateStateMonitor === 'object', 'recommendationPerformance.liveCandidateStateMonitor missing', { perf });
    assert(perf.recommendationPerformance.liveCandidateTransitionHistory && typeof perf.recommendationPerformance.liveCandidateTransitionHistory === 'object', 'recommendationPerformance.liveCandidateTransitionHistory missing', { perf });
    assert(perf.recommendationPerformance.liveCandidateObservationLoopStatus && typeof perf.recommendationPerformance.liveCandidateObservationLoopStatus === 'object', 'recommendationPerformance.liveCandidateObservationLoopStatus missing', { perf });
    assert(typeof perf.recommendationPerformance.liveCandidateObservationLoopStatusLine === 'string' && perf.recommendationPerformance.liveCandidateObservationLoopStatusLine.length > 0, 'recommendationPerformance.liveCandidateObservationLoopStatusLine missing', { perf });
    assert(perf.liveCandidateObservationRenderMode && typeof perf.liveCandidateObservationRenderMode === 'object', 'recommendation/performance liveCandidateObservationRenderMode missing', { perf });
    assert(typeof perf.liveCandidateObservationRenderMode.responseReadOnly === 'boolean', 'recommendation/performance liveCandidateObservationRenderMode.responseReadOnly missing', { perf });
    assert(perf.recommendationPerformance.liveCandidateObservationRenderMode && typeof perf.recommendationPerformance.liveCandidateObservationRenderMode === 'object', 'recommendationPerformance.liveCandidateObservationRenderMode missing', { perf });
    assert(perf.recommendationPerformance.strategyCandidateOpportunityBridge && typeof perf.recommendationPerformance.strategyCandidateOpportunityBridge === 'object', 'recommendationPerformance.strategyCandidateOpportunityBridge missing', { perf });
    assert(perf.recommendationPerformance.shadowMockTradeDecision && typeof perf.recommendationPerformance.shadowMockTradeDecision === 'object', 'recommendationPerformance.shadowMockTradeDecision missing', { perf });
    assert(perf.recommendationPerformance.shadowMockTradeLedger && typeof perf.recommendationPerformance.shadowMockTradeLedger === 'object', 'recommendationPerformance.shadowMockTradeLedger missing', { perf });
    assert(perf.liveCandidateStateMonitor && perf.liveCandidateStateMonitor.responseReadOnly === true, 'recommendation/performance default read should be read-only', { perf });
    assert(perf.liveCandidateObservationRenderMode.responseReadOnly === true, 'recommendation/performance render mode should report read-only default', { perf });
    const perfDiagnostic = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?force=1&observationWrite=1');
    assert(perfDiagnostic.liveCandidateStateMonitor && perfDiagnostic.liveCandidateStateMonitor.responseReadOnly === false, 'recommendation/performance diagnostic mode should enable write path explicitly', { perfDiagnostic });
    assert(String(perfDiagnostic.liveCandidateStateMonitor?.observationWriteSource || '') === 'endpoint_diagnostic', 'recommendation/performance diagnostic mode should surface endpoint_diagnostic source', { perfDiagnostic });
    pass('recommendation/performance strategy-layer snapshot contract');

    const stackRows = Array.isArray(center.strategyLayerSnapshot?.strategyStack)
      ? center.strategyLayerSnapshot.strategyStack.filter((row) => row?.pineAccess?.available === true && row?.key)
      : [];
    assert(stackRows.length >= 1, 'expected at least one pine-exportable strategy row', { center });

    for (const row of stackRows.slice(0, 3)) {
      const pine = await getJson(server.baseUrl, row.pineAccess.endpoint);
      assert(pine?.status === 'ok', 'pine endpoint should return ok', { row, pine });
      assert(String(pine?.strategy?.key || '') === String(row.key), 'pine endpoint returned wrong strategy key', { row, pine });
      assert(String(pine?.strategy?.layer || '').toLowerCase() === String(row.layer || '').toLowerCase(), 'pine endpoint returned wrong layer', { row, pine });
      assert(String(pine?.format || '').toLowerCase() === 'pine_v6', 'pine endpoint format should be pine_v6', { row, pine });
      assert(pine?.copyReady === true, 'pine endpoint should mark copyReady', { row, pine });
      assert(typeof pine?.pineScript === 'string' && pine.pineScript.includes('//@version=6'), 'pine endpoint should return pine v6 text', { row, pine });
    }

    const invalid = await getRaw(server.baseUrl, '/api/jarvis/strategy/pine?key=missing_strategy_key_for_test');
    assert(invalid.status === 404, 'pine endpoint should 404 unknown strategy key', { invalid });
    pass('strategy/pine endpoint behavior and contract compliance');
  } catch (err) {
    fail('strategy layer surfacing integration', err);
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`\nJarvis strategy-layer surfacing test failed with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log('\nJarvis strategy-layer surfacing test passed.');
})();
