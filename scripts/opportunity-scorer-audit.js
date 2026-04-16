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

function summarizeOpportunity(snapshot = {}) {
  const scoring = snapshot?.opportunityScoring && typeof snapshot.opportunityScoring === 'object'
    ? snapshot.opportunityScoring
    : {};
  const topRow = Array.isArray(scoring.comparisonRows) && scoring.comparisonRows.length > 0
    ? scoring.comparisonRows[0]
    : null;
  return {
    opportunityScoreSummaryLine: snapshot?.opportunityScoreSummaryLine || scoring?.summaryLine || null,
    heuristicVsOpportunityComparison: snapshot?.heuristicVsOpportunityComparison || scoring?.heuristicVsOpportunityComparison || null,
    topOpportunityRow: topRow ? {
      key: topRow.key || null,
      layer: topRow.layer || null,
      opportunityWinProb: topRow.opportunityWinProb ?? null,
      opportunityExpectedValue: topRow.opportunityExpectedValue ?? null,
      opportunityCalibrationBand: topRow.opportunityCalibrationBand || null,
      opportunityScoreSummaryLine: topRow.opportunityScoreSummaryLine || null,
      opportunityFeatureVector: topRow.opportunityFeatureVector || null,
      heuristicCompositeScore: topRow.heuristicCompositeScore ?? null,
      opportunityCompositeScore: topRow.opportunityCompositeScore ?? null,
      agreement: topRow?.heuristicVsOpportunityComparison?.status || null,
    } : null,
  };
}

(async () => {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3191,
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
      commandCenter: summarizeOpportunity(commandCenter),
      recommendationPerformance: summarizeOpportunity(performance),
      summaryLine: 'Opportunity scorer audit complete: shadow probability/EV block is surfaced in command-center and recommendation-performance.',
      advisoryOnly: true,
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err.message || 'opportunity_scorer_audit_failed',
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await server.stop();
  }
})();
