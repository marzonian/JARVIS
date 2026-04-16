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

function summarize(payload = {}) {
  const decision = payload?.shadowMockTradeDecision && typeof payload.shadowMockTradeDecision === 'object'
    ? payload.shadowMockTradeDecision
    : {};
  const ledger = payload?.shadowMockTradeLedger && typeof payload.shadowMockTradeLedger === 'object'
    ? payload.shadowMockTradeLedger
    : {};
  return {
    liveOpportunityCandidatesSummaryLine: payload?.liveOpportunityCandidates?.summaryLine || null,
    shadowMockTradeDecision: {
      eligible: decision?.eligible === true,
      status: decision?.status || null,
      reason: decision?.reason || null,
      candidateKey: decision?.candidateKey || null,
      strategyKey: decision?.strategyKey || null,
      direction: decision?.direction || null,
      entryReference: decision?.entryReference || null,
      stopReference: decision?.stopReference || null,
      targetReference: decision?.targetReference || null,
      riskReward: decision?.riskReward ?? null,
      tradePlanSummaryLine: decision?.tradePlanSummaryLine || null,
    },
    shadowMockTradeLedger: {
      pendingCount: Array.isArray(ledger?.pending) ? ledger.pending.length : 0,
      openCount: Array.isArray(ledger?.open) ? ledger.open.length : 0,
      closedCount: Array.isArray(ledger?.closed) ? ledger.closed.length : 0,
      latestTrade: ledger?.latestTrade || null,
      summaryLine: ledger?.summaryLine || null,
    },
  };
}

(async () => {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3193,
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
      commandCenter: summarize(commandCenter),
      recommendationPerformance: summarize(performance),
      summaryLine: 'Shadow mock-trade audit complete: decision and ledger are surfaced in command-center and recommendation-performance.',
      advisoryOnly: true,
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err.message || 'shadow_mock_trade_audit_failed',
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await server.stop();
  }
})();
