#!/usr/bin/env node
/* eslint-disable no-console */

const { startAuditServer } = require('../tests/jarvis-audit-common');

const TIMEOUT_MS = 180000;

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

function summarizeCandidates(snapshot = {}) {
  const candidates = snapshot?.liveOpportunityCandidates && typeof snapshot.liveOpportunityCandidates === 'object'
    ? snapshot.liveOpportunityCandidates
    : {};
  const rows = Array.isArray(candidates.candidates) ? candidates.candidates : [];
  const topRow = rows[0] || null;
  const sourceCounts = rows.reduce((acc, row) => {
    const key = String(row?.candidateSource || 'unknown').trim().toLowerCase() || 'unknown';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    summaryLine: candidates.summaryLine || null,
    topCandidateKey: candidates.topCandidateKey || null,
    topCandidateSummaryLine: candidates.topCandidateSummaryLine || null,
    topCandidateOverall: candidates.topCandidateOverall || null,
    topCandidateActionableNow: candidates.topCandidateActionableNow || null,
    hasActionableCandidateNow: candidates.hasActionableCandidateNow === true,
    actionableNowSummaryLine: candidates.actionableNowSummaryLine || null,
    noActionableReasonCode: candidates.noActionableReasonCode || null,
    noActionableReasonLine: candidates.noActionableReasonLine || null,
    candidateSourceCounts: candidates.candidateSourceCounts || sourceCounts,
    candidateDiversitySummaryLine: candidates.candidateDiversitySummaryLine || null,
    strategyCandidateOpportunityBridge: snapshot?.strategyCandidateOpportunityBridge || null,
    topCandidate: topRow ? {
      candidateKey: topRow.candidateKey || null,
      strategyKey: topRow.strategyKey || null,
      strategyLayer: topRow.strategyLayer || null,
      candidateSource: topRow.candidateSource || null,
      candidateType: topRow.candidateType || null,
      direction: topRow.direction || null,
      entryWindow: topRow.entryWindow || null,
      sessionPhase: topRow.sessionPhase || null,
      timeBucket: topRow.timeBucket || null,
      regime: topRow.regime || null,
      candidateStatus: topRow.candidateStatus || null,
      structureQualityScore: topRow.structureQualityScore ?? null,
      structureQualityLabel: topRow.structureQualityLabel || null,
      structureQualityReasonCodes: Array.isArray(topRow.structureQualityReasonCodes) ? topRow.structureQualityReasonCodes : [],
      structureQualitySummaryLine: topRow.structureQualitySummaryLine || null,
      candidateWinProb: topRow.candidateWinProb ?? null,
      candidateExpectedValue: topRow.candidateExpectedValue ?? null,
      candidateCalibrationBand: topRow.candidateCalibrationBand || null,
      candidateFeatureVector: topRow.candidateFeatureVector || null,
      candidateQualityPenalty: topRow.candidateQualityPenalty ?? null,
      candidateQualityReasonCodes: Array.isArray(topRow.candidateQualityReasonCodes) ? topRow.candidateQualityReasonCodes : [],
      candidateScoreSummaryLine: topRow.candidateScoreSummaryLine || null,
      candidateSummaryLine: topRow.candidateSummaryLine || null,
    } : null,
    candidateSourceSample: rows.slice(0, 6).map((row) => ({
      candidateKey: row?.candidateKey || null,
      candidateSource: row?.candidateSource || null,
      candidateType: row?.candidateType || null,
      candidateStatus: row?.candidateStatus || null,
      structureQualityScore: row?.structureQualityScore ?? null,
      structureQualityLabel: row?.structureQualityLabel || null,
      structureQualityReasonCodes: Array.isArray(row?.structureQualityReasonCodes) ? row.structureQualityReasonCodes : [],
      structureQualitySummaryLine: row?.structureQualitySummaryLine || null,
    })),
  };
}

(async () => {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3192,
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
    const commandCenter = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1');
    const performance = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?force=1');
    const output = {
      status: 'ok',
      baseUrl: server.baseUrl,
      commandCenter: summarizeCandidates(commandCenter),
      recommendationPerformance: summarizeCandidates(performance),
      summaryLine: 'Live opportunity candidate audit complete: candidate rows and bridge are surfaced in command-center and recommendation-performance.',
      advisoryOnly: true,
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err.message || 'live_opportunity_candidates_audit_failed',
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await server.stop();
  }
})();
