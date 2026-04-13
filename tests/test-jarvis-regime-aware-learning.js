#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimeAwareLearningSummary,
} = require('../server/jarvis-core/regime-aware-learning');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;

function buildFixture() {
  return {
    regimeDetection: {
      regimeLabel: 'trending',
      confidenceLabel: 'high',
      confidenceScore: 82,
    },
    regimeByDate: {
      '2026-02-24': {
        regime_trend: 'trending',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
        metrics: { session_range_ticks: 620, orb_range_ticks: 130 },
      },
      '2026-02-25': {
        regime_trend: 'trending',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
        metrics: { session_range_ticks: 560, orb_range_ticks: 112 },
      },
      '2026-02-26': {
        regime_trend: 'ranging',
        regime_vol: 'low',
        regime_orb_size: 'narrow',
        metrics: { session_range_ticks: 210, orb_range_ticks: 50 },
      },
      '2026-02-27': {
        regime_trend: 'ranging',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
        metrics: { session_range_ticks: 380, orb_range_ticks: 95 },
      },
    },
    strategyTracking: {
      trackedStrategies: [
        {
          strategyKey: 'original_plan_orb_3130',
          strategyName: 'Original Trading Plan',
          strategyType: 'original_plan',
          sourceLayer: 'original',
          contextPerformance: {
            regime: {
              rows: [
                { context: 'trending', tradeCount: 52, winRate: 56, profitFactor: 1.38, score: 74 },
                { context: 'ranging', tradeCount: 48, winRate: 49, profitFactor: 1.11, score: 59 },
              ],
            },
          },
        },
        {
          strategyKey: 'variant_strict_retest',
          strategyName: 'Variant Strict Retest',
          strategyType: 'learned_variant',
          sourceLayer: 'variant',
          contextPerformance: {
            regime: {
              rows: [
                { context: 'trending', tradeCount: 33, winRate: 62, profitFactor: 1.86, score: 86 },
                { context: 'ranging', tradeCount: 28, winRate: 43, profitFactor: 0.92, score: 43 },
              ],
            },
          },
        },
        {
          strategyKey: 'alt_first_hour_momo',
          strategyName: 'Alt First-Hour Momentum',
          strategyType: 'alternative_candidate',
          sourceLayer: 'discovery',
          contextPerformance: {
            regime: {
              rows: [
                { context: 'trending', tradeCount: 21, winRate: 59, profitFactor: 1.34, score: 69 },
                { context: 'compressed', tradeCount: 12, winRate: 64, profitFactor: 1.58, score: 78 },
              ],
            },
          },
        },
      ],
    },
    mechanicsResearchSummary: {
      segmentations: {
        regime: {
          available: true,
          rows: [
            { bucket: 'trending', tpMode: 'Nearest', tradeCount: 48, winRatePct: 61, profitFactor: 1.24, scoreRecent: 80 },
            { bucket: 'trending', tpMode: 'Skip 1', tradeCount: 48, winRatePct: 56, profitFactor: 1.31, scoreRecent: 77 },
            { bucket: 'trending', tpMode: 'Skip 2', tradeCount: 48, winRatePct: 52, profitFactor: 1.58, scoreRecent: 83 },
            { bucket: 'compressed', tpMode: 'Nearest', tradeCount: 18, winRatePct: 66, profitFactor: 1.29, scoreRecent: 79 },
            { bucket: 'compressed', tpMode: 'Skip 2', tradeCount: 18, winRatePct: 48, profitFactor: 1.09, scoreRecent: 58 },
          ],
        },
      },
    },
    recommendationPerformance: {
      scorecards: [
        {
          date: '2026-02-24',
          postureEvaluation: 'correct',
          strategyRecommendationScore: { scoreLabel: 'correct' },
          tpRecommendationScore: { scoreLabel: 'partially_correct' },
          recommendationDelta: 42,
        },
        {
          date: '2026-02-25',
          postureEvaluation: 'partially_correct',
          strategyRecommendationScore: { scoreLabel: 'correct' },
          tpRecommendationScore: { scoreLabel: 'correct' },
          recommendationDelta: 18,
        },
        {
          date: '2026-02-26',
          postureEvaluation: 'incorrect',
          strategyRecommendationScore: { scoreLabel: 'partially_correct' },
          tpRecommendationScore: { scoreLabel: 'incorrect' },
          recommendationDelta: -36,
        },
        {
          date: '2026-02-27',
          postureEvaluation: 'partially_correct',
          strategyRecommendationScore: { scoreLabel: 'partially_correct' },
          tpRecommendationScore: { scoreLabel: 'partially_correct' },
          recommendationDelta: -8,
        },
      ],
    },
  };
}

function runUnitChecks() {
  const fixture = buildFixture();
  const summary = buildRegimeAwareLearningSummary({
    windowSessions: 120,
    includeContext: true,
    performanceSource: 'all',
    ...fixture,
  });

  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisory-only');
  assert(Array.isArray(summary.strategyByRegime), 'strategyByRegime missing');
  assert(Array.isArray(summary.tpModeByRegime), 'tpModeByRegime missing');
  assert(Array.isArray(summary.recommendationAccuracyByRegime), 'recommendationAccuracyByRegime missing');
  assert(Array.isArray(summary.regimeSpecificOpportunities), 'regimeSpecificOpportunities missing');
  assert(Array.isArray(summary.regimeSpecificRisks), 'regimeSpecificRisks missing');
  assert(typeof summary.regimeLearningInsight === 'string' && summary.regimeLearningInsight.length > 0, 'regimeLearningInsight missing');

  const labels = new Set([
    ...summary.strategyByRegime.map((x) => x.regimeLabel),
    ...summary.tpModeByRegime.map((x) => x.regimeLabel),
    ...summary.recommendationAccuracyByRegime.map((x) => x.regimeLabel),
    summary.currentRegimeLabel,
  ]);
  for (const label of labels) {
    assert(SUPPORTED_REGIME_LABELS.includes(label), `unsupported regime label: ${label}`);
  }

  assert(summary.topRegimeAlignedStrategy && typeof summary.topRegimeAlignedStrategy === 'object', 'topRegimeAlignedStrategy missing');
  assert(summary.topRegimeMisalignedStrategy && typeof summary.topRegimeMisalignedStrategy === 'object', 'topRegimeMisalignedStrategy missing');

  const trendingRow = summary.strategyByRegime.find((row) => row.regimeLabel === 'trending');
  assert(trendingRow && trendingRow.bestStrategy, 'trending strategy row missing');
  assert(Number.isFinite(Number(trendingRow.sampleSize)), 'trending sample size missing');

  const compressedTp = summary.tpModeByRegime.find((row) => row.regimeLabel === 'compressed');
  assert(compressedTp && compressedTp.bestTpMode, 'compressed tp row missing');

  const thinFixture = buildFixture();
  thinFixture.recommendationPerformance.scorecards = thinFixture.recommendationPerformance.scorecards.slice(0, 2);
  thinFixture.strategyTracking.trackedStrategies = thinFixture.strategyTracking.trackedStrategies.map((row) => ({
    ...row,
    contextPerformance: {
      regime: {
        rows: (row.contextPerformance.regime.rows || []).map((r) => ({ ...r, tradeCount: 4 })),
      },
    },
  }));
  const thin = buildRegimeAwareLearningSummary({
    windowSessions: 120,
    includeContext: true,
    performanceSource: 'backfill',
    ...thinFixture,
  });
  assert(thin.dataQuality && thin.dataQuality.isThinSample === true, 'thin sample guard should flag isThinSample');
  assert(Array.isArray(thin.dataQuality.warnings) && thin.dataQuality.warnings.length > 0, 'thin sample warnings missing');
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
    port: process.env.JARVIS_AUDIT_PORT || 3183,
  });

  try {
    const learningOut = await getJson(server.baseUrl, '/api/jarvis/strategy/learning/regime?windowSessions=120&performanceSource=all&includeContext=1&force=1');
    assert(learningOut?.status === 'ok', 'regime learning endpoint should return ok');
    const learning = learningOut?.regimeAwareLearning;
    assert(learning && typeof learning === 'object', 'regimeAwareLearning payload missing');
    assert(learning.advisoryOnly === true, 'regimeAwareLearning advisoryOnly missing');
    assert(Array.isArray(learning.strategyByRegime), 'strategyByRegime missing from endpoint');
    assert(Array.isArray(learning.tpModeByRegime), 'tpModeByRegime missing from endpoint');
    assert(Array.isArray(learning.recommendationAccuracyByRegime), 'recommendationAccuracyByRegime missing from endpoint');
    assert(Array.isArray(learning.regimeSpecificOpportunities), 'regimeSpecificOpportunities missing from endpoint');
    assert(Array.isArray(learning.regimeSpecificRisks), 'regimeSpecificRisks missing from endpoint');

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&windowSessions=120&includeContext=1&performanceSource=all');
    assert(centerOut?.status === 'ok', 'command-center should return ok');
    assert(centerOut?.regimeAwareLearning && typeof centerOut.regimeAwareLearning === 'object', 'top-level regimeAwareLearning missing in command-center response');

    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.regimeLearningInsight === 'string' && cc.regimeLearningInsight.length > 0, 'command-center regimeLearningInsight missing');
    assert(Object.prototype.hasOwnProperty.call(cc, 'regimeOpportunity'), 'command-center regimeOpportunity missing');
    assert(Object.prototype.hasOwnProperty.call(cc, 'regimeRisk'), 'command-center regimeRisk missing');
    assert(Object.prototype.hasOwnProperty.call(cc, 'topRegimeAlignedStrategy'), 'command-center topRegimeAlignedStrategy missing');

    const ccRegime = String(cc?.regimeLabel || '').trim();
    const learnRegime = String(centerOut?.regimeAwareLearning?.currentRegimeLabel || '').trim();
    if (ccRegime && learnRegime) {
      assert(ccRegime === learnRegime, 'regimeAwareLearning currentRegimeLabel must match command-center regimeLabel');
    }
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime-aware learning tests passed.');
  } catch (err) {
    console.error(`Jarvis regime-aware learning test failed: ${err.message}`);
    process.exit(1);
  }
})();
