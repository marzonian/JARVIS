#!/usr/bin/env node
/* eslint-disable no-console */
const nodeAssert = require('assert');
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildStrategyLearningSummary,
} = require('../server/jarvis-core/strategy-learning');

const TIMEOUT_MS = 120000;

function buildFixture() {
  return {
    strategyTracking: {
      trackedStrategies: [
        {
          strategyKey: 'original_plan_orb_3130',
          strategyName: 'Original Trading Plan',
          strategyType: 'original_plan',
          sourceLayer: 'original',
          availability: 'available',
          trackingStatus: 'baseline',
          momentumOfPerformance: 'stable',
          stabilityScore: 65,
          primaryMetrics: { sampleQuality: 'robust', tradeCount: 120 },
          vsOriginal: { relativeProfitFactor: 0, relativeWinRate: 0 },
        },
        {
          strategyKey: 'alt_improving_a',
          strategyName: 'Alternative Improving A',
          strategyType: 'alternative_candidate',
          sourceLayer: 'discovery',
          availability: 'available',
          trackingStatus: 'strong_alternative',
          momentumOfPerformance: 'improving',
          stabilityScore: 74,
          primaryMetrics: { sampleQuality: 'robust', tradeCount: 62 },
          vsOriginal: { relativeProfitFactor: 0.18, relativeWinRate: 2.4 },
        },
        {
          strategyKey: 'alt_weak_b',
          strategyName: 'Alternative Weakening B',
          strategyType: 'alternative_candidate',
          sourceLayer: 'discovery',
          availability: 'available',
          trackingStatus: 'weakening_candidate',
          momentumOfPerformance: 'weakening',
          stabilityScore: 42,
          primaryMetrics: { sampleQuality: 'moderate', tradeCount: 58 },
          vsOriginal: { relativeProfitFactor: -0.21, relativeWinRate: -3.1 },
        },
      ],
    },
    strategyPortfolio: {
      strategies: [
        {
          strategyKey: 'alt_improving_a',
          portfolioState: 'active_candidate',
          demotionRisk: 'low',
        },
        {
          strategyKey: 'alt_weak_b',
          portfolioState: 'deprioritized',
          demotionRisk: 'high',
        },
      ],
    },
    strategyExperiments: {
      candidates: [
        {
          strategyKey: 'alt_improving_a',
          experimentState: 'shadow_stable',
          promotionReadiness: 'high',
        },
        {
          strategyKey: 'alt_weak_b',
          experimentState: 'retired_candidate',
          promotionReadiness: 'none',
        },
      ],
    },
    strategyDiscovery: {
      candidates: [
        {
          strategyKey: 'alt_improving_a',
          robustnessLabel: 'promising',
        },
        {
          strategyKey: 'alt_weak_b',
          robustnessLabel: 'low_confidence',
        },
      ],
    },
    mechanicsResearchSummary: {
      windowSize: 120,
      recommendedTpMode: 'Skip 2',
      bestTpModeByWinRate: 'Nearest',
      bestTpModeByProfitFactor: 'Skip 2',
      dataQuality: { isThinSample: false },
      contextualRecommendation: {
        contextualRecommendedTpMode: 'Nearest',
        confidenceLabel: 'medium',
        sampleSize: 32,
        fallbackLevel: 'drop_regime',
      },
    },
    recommendationPerformance: {
      summary: {
        postureAccuracy30d: 64,
        strategyAccuracy30d: 58,
        tpAccuracy30d: 53,
        avgRecommendationDelta: 27,
        sampleSize30d: 30,
        sampleSize90d: 90,
        rowCountUsed: 90,
        sourceBreakdown: {
          live: 40,
          backfill: 50,
          total: 90,
        },
      },
    },
  };
}

function runUnitChecks() {
  const fixture = buildFixture();
  const summary = buildStrategyLearningSummary({
    windowSessions: 120,
    includeContext: true,
    performanceSource: 'all',
    ...fixture,
  });

  nodeAssert(summary && typeof summary === 'object');
  nodeAssert(summary.advisoryOnly === true);
  nodeAssert(Array.isArray(summary.improvingStrategies), 'improvingStrategies missing');
  nodeAssert(Array.isArray(summary.weakeningStrategies), 'weakeningStrategies missing');
  nodeAssert(Array.isArray(summary.researchPriorityList), 'researchPriorityList missing');
  nodeAssert(Array.isArray(summary.mechanicsLearningInsights) && summary.mechanicsLearningInsights.length > 0, 'mechanicsLearningInsights missing');
  nodeAssert(Array.isArray(summary.recommendationLearningInsights) && summary.recommendationLearningInsights.length > 0, 'recommendationLearningInsights missing');
  nodeAssert(summary.evidenceStrength && typeof summary.evidenceStrength === 'object', 'evidenceStrength missing');

  const improvingKeys = summary.improvingStrategies.map((row) => row.strategyKey);
  const weakeningKeys = summary.weakeningStrategies.map((row) => row.strategyKey);
  nodeAssert(improvingKeys.includes('alt_improving_a'), 'expected improving strategy missing');
  nodeAssert(weakeningKeys.includes('alt_weak_b'), 'expected weakening strategy missing');

  const priorityByKey = new Map(summary.researchPriorityList.map((row) => [row.strategyKey, row]));
  nodeAssert(priorityByKey.get('alt_improving_a').researchPriority === 'increase_attention', 'priority for improving strategy should increase attention');
  nodeAssert(priorityByKey.get('alt_weak_b').researchPriority === 'retire_research_focus', 'priority for weakening strategy should retire research focus');

  nodeAssert(typeof summary.learningInsight === 'string' && summary.learningInsight.length > 0, 'learningInsight missing');
  nodeAssert(typeof summary.researchPrioritySummary === 'string' && summary.researchPrioritySummary.length > 0, 'researchPrioritySummary missing');
  nodeAssert(summary.topImprovingStrategy && summary.topImprovingStrategy.strategyKey === 'alt_improving_a', 'topImprovingStrategy mismatch');
  nodeAssert(summary.topWeakeningStrategy && summary.topWeakeningStrategy.strategyKey === 'alt_weak_b', 'topWeakeningStrategy mismatch');
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
    port: process.env.JARVIS_AUDIT_PORT || 3179,
  });

  try {
    const learnOut = await getJson(server.baseUrl, '/api/jarvis/strategy/learning?windowSessions=120&performanceSource=all&includeContext=1&force=1');
    assert(learnOut?.status === 'ok', 'strategy learning endpoint should return ok', { learnOut });
    const learning = learnOut?.strategyLearning;
    assert(learning && typeof learning === 'object', 'strategyLearning payload missing', { learnOut });
    assert(Array.isArray(learning.improvingStrategies), 'improvingStrategies missing', { learning });
    assert(Array.isArray(learning.weakeningStrategies), 'weakeningStrategies missing', { learning });
    assert(Array.isArray(learning.researchPriorityList), 'researchPriorityList missing', { learning });
    assert(Array.isArray(learning.mechanicsLearningInsights) && learning.mechanicsLearningInsights.length > 0, 'mechanicsLearningInsights missing', { learning });
    assert(Array.isArray(learning.recommendationLearningInsights) && learning.recommendationLearningInsights.length > 0, 'recommendationLearningInsights missing', { learning });
    assert(learning.evidenceStrength && typeof learning.evidenceStrength === 'object', 'evidenceStrength missing', { learning });
    assert(learning.advisoryOnly === true, 'advisoryOnly missing', { learning });

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&includeContext=1&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command center endpoint should return ok', { centerOut });
    assert(centerOut?.strategyLearning && typeof centerOut.strategyLearning === 'object', 'top-level strategyLearning missing from command-center response', { centerOut });
    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.learningInsight === 'string' && cc.learningInsight.length > 0, 'command-center learningInsight missing', { centerOut });
    assert(typeof cc.researchPrioritySummary === 'string' && cc.researchPrioritySummary.length > 0, 'command-center researchPrioritySummary missing', { centerOut });
    assert(Object.prototype.hasOwnProperty.call(cc, 'topImprovingStrategy'), 'command-center topImprovingStrategy field missing', { centerOut });
    assert(Object.prototype.hasOwnProperty.call(cc, 'topWeakeningStrategy'), 'command-center topWeakeningStrategy field missing', { centerOut });
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis strategy learning tests passed.');
  } catch (err) {
    console.error(`Jarvis strategy learning test failed: ${err.message}`);
    process.exit(1);
  }
})();
