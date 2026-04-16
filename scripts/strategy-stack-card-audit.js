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

function summarizeCards(section = {}) {
  const toNumberOrNull = (value) => {
    if (value == null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const cards = Array.isArray(section.cards) ? section.cards : [];
  return cards.map((card) => ({
    title: card?.title || null,
    strategy: card?.strategyName || null,
    key: card?.key || null,
    layer: card?.layer || null,
    suitability: toNumberOrNull(card?.suitability),
    score: toNumberOrNull(card?.score),
    winRate: toNumberOrNull(card?.winRate),
    profitFactor: toNumberOrNull(card?.profitFactor),
    maxDrawdownDollars: toNumberOrNull(card?.maxDrawdownDollars),
    recommendationStatus: card?.recommendationStatus || null,
    pineAvailable: card?.pineAvailable === true,
    pineEndpoint: card?.pineAccess?.endpoint || card?.pineContractRef || null,
  }));
}

function summarizeComparison(readout = {}) {
  const rows = Array.isArray(readout.comparisonRows) ? readout.comparisonRows : [];
  return {
    recommendedKey: readout.recommendedKey || null,
    recommendedName: readout.recommendedName || null,
    summaryLine: readout.summaryLine || null,
    voiceSummaryLine: readout.voiceSummaryLine || null,
    comparisonRows: rows.map((row) => ({
      key: row?.key || null,
      name: row?.name || null,
      layer: row?.layer || null,
      isRecommended: row?.isRecommended === true,
      recommendationStatus: row?.recommendationStatus || null,
      winRate: row?.winRate ?? null,
      profitFactor: row?.profitFactor ?? null,
      maxDrawdownDollars: row?.maxDrawdownDollars ?? null,
      suitability: row?.suitability ?? null,
      score: row?.score ?? null,
      whyChosenOrNot: row?.whyChosenOrNot || null,
      tradeoffLine: row?.tradeoffLine || null,
    })),
  };
}

(async () => {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3189,
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
    const recommendationPerformance = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?force=1');

    const commandCard = commandCenter?.strategyStackCard || {};
    const perfCard = recommendationPerformance?.strategyStackCard || {};

    const output = {
      status: 'ok',
      baseUrl: server.baseUrl,
      commandCenter: {
        recommendationLine: commandCenter?.strategyRecommendationLine || null,
        stanceLine: commandCenter?.strategyStanceLine || null,
        voiceLine: commandCenter?.strategyVoiceLine || null,
        comparisonLine: commandCenter?.strategyComparisonLine || null,
        comparisonVoiceLine: commandCenter?.strategyComparisonVoiceLine || null,
        cards: summarizeCards(commandCard),
        comparison: summarizeComparison(commandCenter?.strategyComparisonReadout || {}),
      },
      recommendationPerformance: {
        recommendationLine: recommendationPerformance?.strategyRecommendationLine || null,
        stanceLine: recommendationPerformance?.strategyStanceLine || null,
        voiceLine: recommendationPerformance?.strategyVoiceLine || null,
        comparisonLine: recommendationPerformance?.strategyComparisonLine || null,
        comparisonVoiceLine: recommendationPerformance?.strategyComparisonVoiceLine || null,
        cards: summarizeCards(perfCard),
        comparison: summarizeComparison(recommendationPerformance?.strategyComparisonReadout || {}),
      },
      summaryLine: 'Strategy stack card audit complete: command-center and recommendation-performance expose strategy cards, why-recommended block, stance lines, and strategy comparison readout.',
      advisoryOnly: true,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await server.stop();
  }
})();
