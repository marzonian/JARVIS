#!/usr/bin/env node
/* eslint-disable no-console */
const nodeAssert = require('assert');
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildStrategyExperimentsSummary,
} = require('../server/jarvis-core/strategy-experiments');

const TIMEOUT_MS = 120000;

function buildFixtures() {
  return {
    strategyTracking: {
      trackedStrategies: [
        {
          strategyKey: 'original_plan_orb_3130',
          strategyName: 'Original Trading Plan',
          strategyType: 'original_plan',
          availability: 'available',
          trackingStatus: 'baseline',
          primaryMetrics: { sampleQuality: 'robust' },
          rollingWindowSummary: [{ windowSessions: 120 }],
          stabilityScore: 62,
          momentumOfPerformance: 'stable',
          vsOriginal: { relativeProfitFactor: 0, relativeWinRate: 0 },
        },
        {
          strategyKey: 'new_candidate_1',
          strategyName: 'New Candidate',
          strategyType: 'alternative_candidate',
          availability: 'available',
          trackingStatus: 'low_confidence',
          primaryMetrics: { sampleQuality: 'very_thin' },
          rollingWindowSummary: [{ windowSessions: 12 }],
          stabilityScore: 40,
          momentumOfPerformance: 'stable',
          vsOriginal: { relativeProfitFactor: 0.12, relativeWinRate: 2.2 },
        },
        {
          strategyKey: 'trial_candidate_1',
          strategyName: 'Trial Candidate',
          strategyType: 'alternative_candidate',
          availability: 'available',
          trackingStatus: 'monitor_closely',
          primaryMetrics: { sampleQuality: 'thin' },
          rollingWindowSummary: [{ windowSessions: 35 }],
          stabilityScore: 48,
          momentumOfPerformance: 'stable',
          vsOriginal: { relativeProfitFactor: 0.03, relativeWinRate: 0.6 },
        },
        {
          strategyKey: 'promising_candidate_1',
          strategyName: 'Promising Candidate',
          strategyType: 'alternative_candidate',
          availability: 'available',
          trackingStatus: 'context_specific_alternative',
          contextDominanceLabel: 'context_specific_dominant',
          primaryMetrics: { sampleQuality: 'robust' },
          rollingWindowSummary: [{ windowSessions: 120 }],
          stabilityScore: 74,
          momentumOfPerformance: 'stable',
          vsOriginal: { relativeProfitFactor: 0.14, relativeWinRate: -1.1 },
        },
        {
          strategyKey: 'weakening_candidate_1',
          strategyName: 'Weakening Candidate',
          strategyType: 'alternative_candidate',
          availability: 'available',
          trackingStatus: 'weakening_candidate',
          primaryMetrics: { sampleQuality: 'moderate' },
          rollingWindowSummary: [{ windowSessions: 40 }],
          stabilityScore: 44,
          momentumOfPerformance: 'weakening',
          vsOriginal: { relativeProfitFactor: -0.08, relativeWinRate: -1.7 },
        },
        {
          strategyKey: 'retired_candidate_1',
          strategyName: 'Retired Candidate',
          strategyType: 'alternative_candidate',
          availability: 'unavailable',
          trackingStatus: 'weakening_candidate',
          primaryMetrics: { sampleQuality: 'moderate' },
          rollingWindowSummary: [{ windowSessions: 120 }],
          stabilityScore: 30,
          momentumOfPerformance: 'weakening',
          vsOriginal: { relativeProfitFactor: -0.25, relativeWinRate: -4.8 },
        },
      ],
    },
    strategyPortfolio: {
      strategies: [
        {
          strategyKey: 'new_candidate_1',
          portfolioState: 'low_confidence',
          demotionRisk: 'medium',
        },
        {
          strategyKey: 'trial_candidate_1',
          portfolioState: 'watchlist',
          demotionRisk: 'medium',
        },
        {
          strategyKey: 'promising_candidate_1',
          portfolioState: 'context_only_candidate',
          demotionRisk: 'low',
        },
        {
          strategyKey: 'weakening_candidate_1',
          portfolioState: 'weakening',
          demotionRisk: 'high',
        },
        {
          strategyKey: 'retired_candidate_1',
          portfolioState: 'deprioritized',
          demotionRisk: 'high',
        },
      ],
    },
    strategyDiscovery: {
      candidates: [
        { strategyKey: 'promising_candidate_1', robustnessLabel: 'promising' },
        { strategyKey: 'weakening_candidate_1', robustnessLabel: 'low_confidence' },
      ],
    },
  };
}

function runUnitChecks() {
  const fixture = buildFixtures();
  const summary = buildStrategyExperimentsSummary({
    windowSessions: 120,
    includeContext: true,
    strategyTracking: fixture.strategyTracking,
    strategyPortfolio: fixture.strategyPortfolio,
    strategyDiscovery: fixture.strategyDiscovery,
  });

  nodeAssert(summary && typeof summary === 'object');
  nodeAssert(summary.advisoryOnly === true);
  nodeAssert(Array.isArray(summary.candidates) && summary.candidates.length >= 5);
  nodeAssert(summary.highestPriorityExperiment && typeof summary.highestPriorityExperiment === 'object');
  nodeAssert(summary.experimentSummary && typeof summary.experimentSummary === 'object');
  nodeAssert(typeof summary.experimentInsight === 'string' && summary.experimentInsight.length > 0);

  const byKey = new Map(summary.candidates.map((row) => [row.strategyKey, row]));
  nodeAssert(byKey.get('new_candidate_1').experimentState === 'new_candidate', 'new candidate state mismatch');
  nodeAssert(byKey.get('trial_candidate_1').experimentState === 'shadow_trial', 'shadow trial state mismatch');
  nodeAssert(byKey.get('promising_candidate_1').experimentState === 'shadow_promising', 'shadow promising state mismatch');
  nodeAssert(byKey.get('weakening_candidate_1').experimentState === 'shadow_weakening', 'shadow weakening state mismatch');
  nodeAssert(byKey.get('retired_candidate_1').experimentState === 'retired_candidate', 'retired candidate state mismatch');
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
    port: process.env.JARVIS_AUDIT_PORT || 3177,
  });

  try {
    const expOut = await getJson(server.baseUrl, '/api/jarvis/strategy/experiments?windowSessions=120&includeContext=1&force=1');
    assert(expOut?.status === 'ok', 'strategy experiments endpoint should return ok', { expOut });
    const experiments = expOut?.strategyExperiments;
    assert(experiments && typeof experiments === 'object', 'strategyExperiments payload missing', { expOut });
    assert(Array.isArray(experiments.candidates), 'candidates list missing', { experiments });
    assert(Object.prototype.hasOwnProperty.call(experiments, 'highestPriorityExperiment'), 'highestPriorityExperiment missing', { experiments });
    const anyRow = experiments.candidates[0] || null;
    if (anyRow) {
      assert(typeof anyRow.experimentState === 'string' && anyRow.experimentState.length > 0, 'experimentState missing', { anyRow });
      assert(Number.isFinite(Number(anyRow.shadowSessionsTracked)), 'shadowSessionsTracked missing', { anyRow });
      assert(typeof anyRow.promotionReadiness === 'string' && anyRow.promotionReadiness.length > 0, 'promotionReadiness missing', { anyRow });
      assert(typeof anyRow.experimentReason === 'string' && anyRow.experimentReason.length > 0, 'experimentReason missing', { anyRow });
    }

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&includeContext=1&force=1');
    assert(centerOut?.status === 'ok', 'command center endpoint should return ok', { centerOut });
    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.experimentInsight === 'string' && cc.experimentInsight.length > 0, 'command-center experimentInsight missing', { centerOut });
    assert(Object.prototype.hasOwnProperty.call(cc, 'highestPriorityExperiment'), 'command-center highestPriorityExperiment missing', { centerOut });
    assert(cc.experimentSummary && typeof cc.experimentSummary === 'object', 'command-center experimentSummary missing', { centerOut });
    assert(centerOut?.strategyExperiments && typeof centerOut.strategyExperiments === 'object', 'top-level strategyExperiments missing', { centerOut });
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis strategy experiments tests passed.');
  } catch (err) {
    console.error(`Jarvis strategy experiments test failed: ${err.message}`);
    process.exit(1);
  }
})();
