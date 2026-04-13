#!/usr/bin/env node
/* eslint-disable no-console */
const nodeAssert = require('assert');
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildStrategyPortfolioSummary,
} = require('../server/jarvis-core/strategy-portfolio');

const TIMEOUT_MS = 120000;

function buildTrackingFixture() {
  return {
    trackedStrategies: [
      {
        strategyKey: 'original_plan_orb_3130',
        strategyName: 'Original Trading Plan',
        strategyType: 'original_plan',
        sourceLayer: 'original',
        availability: 'available',
        trackingStatus: 'baseline',
        stabilityScore: 62,
        momentumOfPerformance: 'stable',
        primaryMetrics: {
          sampleQuality: 'robust',
        },
        vsOriginal: {
          relativeProfitFactor: 0,
          relativeWinRate: 0,
        },
      },
      {
        strategyKey: 'variant_orb_80_220_skip_monday',
        strategyName: 'ORB 80-220 + Skip Monday',
        strategyType: 'learned_variant',
        sourceLayer: 'variant',
        availability: 'available',
        trackingStatus: 'monitor_closely',
        stabilityScore: 54,
        momentumOfPerformance: 'stable',
        primaryMetrics: {
          sampleQuality: 'moderate',
        },
        vsOriginal: {
          relativeProfitFactor: 0.05,
          relativeWinRate: 0.8,
        },
      },
      {
        strategyKey: 'alt_context',
        strategyName: 'Alternative Context Candidate',
        strategyType: 'alternative_candidate',
        sourceLayer: 'discovery',
        availability: 'available',
        trackingStatus: 'context_specific_alternative',
        contextDominanceLabel: 'context_specific_dominant',
        stabilityScore: 79,
        momentumOfPerformance: 'stable',
        primaryMetrics: {
          sampleQuality: 'robust',
        },
        vsOriginal: {
          relativeProfitFactor: 0.21,
          relativeWinRate: -1.6,
        },
      },
      {
        strategyKey: 'alt_weakening',
        strategyName: 'Alternative Weakening Candidate',
        strategyType: 'alternative_candidate',
        sourceLayer: 'discovery',
        availability: 'available',
        trackingStatus: 'weakening_candidate',
        stabilityScore: 44,
        momentumOfPerformance: 'weakening',
        primaryMetrics: {
          sampleQuality: 'moderate',
        },
        vsOriginal: {
          relativeProfitFactor: -0.28,
          relativeWinRate: -3.9,
        },
      },
      {
        strategyKey: 'alt_thin',
        strategyName: 'Alternative Thin Sample',
        strategyType: 'alternative_candidate',
        sourceLayer: 'discovery',
        availability: 'available',
        trackingStatus: 'low_confidence',
        stabilityScore: 73,
        momentumOfPerformance: 'stable',
        primaryMetrics: {
          sampleQuality: 'very_thin',
        },
        vsOriginal: {
          relativeProfitFactor: 0.34,
          relativeWinRate: 5.1,
        },
      },
    ],
  };
}

function runUnitChecks() {
  const summary = buildStrategyPortfolioSummary({
    windowSessions: 120,
    includeContext: true,
    strategyTracking: buildTrackingFixture(),
    strategyDiscovery: {
      advisoryOnly: true,
      candidates: [
        {
          strategyKey: 'alt_context',
          robustnessLabel: 'promising',
        },
        {
          strategyKey: 'alt_weakening',
          robustnessLabel: 'low_confidence',
        },
      ],
    },
    strategyLayers: {
      recommendationBasis: {
        basisType: 'baseline',
      },
    },
  });

  nodeAssert(summary && typeof summary === 'object');
  nodeAssert(summary.advisoryOnly === true);
  nodeAssert(Array.isArray(summary.strategies) && summary.strategies.length >= 5);
  nodeAssert(summary.baselineStrategy && summary.baselineStrategy.strategyType === 'original_plan');
  nodeAssert(summary.highestPriorityCandidate && summary.highestPriorityCandidate.strategyType !== 'original_plan');

  const byKey = new Map(summary.strategies.map((row) => [row.strategyKey, row]));
  nodeAssert(byKey.get('original_plan_orb_3130').portfolioState === 'baseline');
  nodeAssert(byKey.get('alt_context').portfolioState === 'context_only_candidate');
  nodeAssert(byKey.get('alt_weakening').portfolioState === 'deprioritized');
  nodeAssert(byKey.get('alt_thin').portfolioState === 'low_confidence');

  nodeAssert(summary.governanceSummary && typeof summary.governanceSummary === 'object');
  nodeAssert(Array.isArray(summary.governanceSummary.priorityOrder), 'priority order missing');
  nodeAssert(typeof summary.portfolioInsight === 'string' && summary.portfolioInsight.length > 0, 'portfolioInsight missing');

  const priorities = summary.strategies.map((row) => Number(row.portfolioPriority));
  const sorted = priorities.slice().sort((a, b) => a - b);
  nodeAssert(JSON.stringify(priorities) === JSON.stringify(sorted), 'strategies should be sorted by portfolio priority');
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

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3176,
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
    const portfolioOut = await getJson(server.baseUrl, '/api/jarvis/strategy/portfolio?windowSessions=120&includeContext=1&force=1');
    assert(portfolioOut?.status === 'ok', 'strategy portfolio endpoint should return ok', { portfolioOut });
    const portfolio = portfolioOut?.strategyPortfolio;
    assert(portfolio && typeof portfolio === 'object', 'strategyPortfolio payload missing', { portfolioOut });
    assert(Array.isArray(portfolio.strategies), 'portfolio strategies missing', { portfolio });
    assert(portfolio.baselineStrategy && typeof portfolio.baselineStrategy === 'object', 'baselineStrategy missing', { portfolio });
    assert(Object.prototype.hasOwnProperty.call(portfolio, 'highestPriorityCandidate'), 'highestPriorityCandidate field missing', { portfolio });
    if (portfolio.highestPriorityCandidate) {
      assert(typeof portfolio.highestPriorityCandidate.portfolioState === 'string', 'highestPriorityCandidate state missing', { portfolio });
    }
    const anyRow = portfolio.strategies[0] || null;
    if (anyRow) {
      assert(typeof anyRow.portfolioState === 'string', 'portfolioState missing on row', { anyRow });
      assert(typeof anyRow.governanceReason === 'string' && anyRow.governanceReason.length > 0, 'governanceReason missing on row', { anyRow });
    }

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&includeContext=1&force=1');
    assert(centerOut?.status === 'ok', 'command center endpoint should return ok', { centerOut });
    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.portfolioInsight === 'string' && cc.portfolioInsight.length > 0, 'command-center portfolioInsight missing', { centerOut });
    assert(Object.prototype.hasOwnProperty.call(cc, 'baselineStrategy'), 'command-center baselineStrategy field missing', { centerOut });
    assert(Object.prototype.hasOwnProperty.call(cc, 'highestPriorityCandidate'), 'command-center highestPriorityCandidate field missing', { centerOut });
    assert(cc.portfolioSummary && typeof cc.portfolioSummary === 'object', 'command-center portfolioSummary missing', { centerOut });
    assert(centerOut?.strategyPortfolio && typeof centerOut.strategyPortfolio === 'object', 'command-center top-level strategyPortfolio missing', { centerOut });
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis strategy portfolio tests passed.');
  } catch (err) {
    console.error(`Jarvis strategy portfolio test failed: ${err.message}`);
    process.exit(1);
  }
})();
