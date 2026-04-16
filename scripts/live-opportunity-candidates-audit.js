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
  return {
    summaryLine: candidates.summaryLine || null,
    topCandidateKey: candidates.topCandidateKey || null,
    topCandidateSummaryLine: candidates.topCandidateSummaryLine || null,
    strategyCandidateOpportunityBridge: snapshot?.strategyCandidateOpportunityBridge || null,
    topCandidate: topRow ? {
      candidateKey: topRow.candidateKey || null,
      strategyKey: topRow.strategyKey || null,
      strategyLayer: topRow.strategyLayer || null,
      candidateType: topRow.candidateType || null,
      direction: topRow.direction || null,
      entryWindow: topRow.entryWindow || null,
      sessionPhase: topRow.sessionPhase || null,
      timeBucket: topRow.timeBucket || null,
      regime: topRow.regime || null,
      candidateStatus: topRow.candidateStatus || null,
      candidateWinProb: topRow.candidateWinProb ?? null,
      candidateExpectedValue: topRow.candidateExpectedValue ?? null,
      candidateCalibrationBand: topRow.candidateCalibrationBand || null,
      candidateFeatureVector: topRow.candidateFeatureVector || null,
      candidateScoreSummaryLine: topRow.candidateScoreSummaryLine || null,
      candidateSummaryLine: topRow.candidateSummaryLine || null,
    } : null,
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
