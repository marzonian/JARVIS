#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePerformanceFeedbackSummary,
} = require('../server/jarvis-core/regime-performance-feedback');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;

const ALLOWED_EVIDENCE_QUALITY = ['strong_live', 'mixed', 'retrospective_heavy', 'thin'];
const ALLOWED_COVERAGE_TYPE = ['direct_provenance', 'upstream_only', 'mixed_support', 'no_support'];
const ALLOWED_PROVENANCE_STRENGTH = ['direct', 'retrospective_heavy', 'mixed', 'inferred_only', 'absent'];

function buildFixture() {
  return {
    regimeDetection: {
      regimeLabel: 'wide_volatile',
      confidenceLabel: 'high',
      confidenceScore: 78,
    },
    regimeByDate: {
      '2026-03-01': {
        regime_trend: 'trending',
        regime_vol: 'extreme',
        regime_orb_size: 'wide',
        metrics: { session_range_ticks: 940, orb_range_ticks: 250 },
      },
      '2026-03-02': {
        regime_trend: 'trending',
        regime_vol: 'high',
        regime_orb_size: 'wide',
        metrics: { session_range_ticks: 780, orb_range_ticks: 220 },
      },
      '2026-03-03': {
        regime_trend: 'ranging',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
        metrics: { session_range_ticks: 420, orb_range_ticks: 115 },
      },
      '2026-03-04': {
        regime_trend: 'ranging',
        regime_vol: 'low',
        regime_orb_size: 'narrow',
        metrics: { session_range_ticks: 210, orb_range_ticks: 55 },
      },
    },
    regimeAwareLearning: {
      strategyByRegime: [
        {
          regimeLabel: 'wide_volatile',
          sampleSize: 22,
          confidenceLabel: 'medium',
          bestStrategy: {
            strategyKey: 'variant_volatility_guard',
            strategyName: 'Variant Volatility Guard',
            strategyType: 'learned_variant',
            sourceLayer: 'variant',
            tradeCount: 22,
            winRate: 59,
            profitFactor: 1.42,
            score: 74,
          },
        },
        {
          regimeLabel: 'mixed',
          sampleSize: 8,
          confidenceLabel: 'low',
          bestStrategy: {
            strategyKey: 'original_plan_orb_3130',
            strategyName: 'Original Trading Plan',
            strategyType: 'original_plan',
            sourceLayer: 'original',
            tradeCount: 8,
            winRate: 48,
            profitFactor: 1.02,
            score: 48,
          },
        },
        {
          regimeLabel: 'compressed',
          sampleSize: 14,
          confidenceLabel: 'medium',
          bestStrategy: {
            strategyKey: 'variant_nearest_tp',
            strategyName: 'Nearest TP Overlay',
            strategyType: 'learned_variant',
            sourceLayer: 'variant',
            tradeCount: 14,
            winRate: 57,
            profitFactor: 1.19,
            score: 62,
          },
        },
      ],
      tpModeByRegime: [
        {
          regimeLabel: 'wide_volatile',
          sampleSize: 22,
          confidenceLabel: 'medium',
          bestTpMode: 'Skip 2',
          bestTpWinRate: 55,
          bestTpProfitFactor: 1.62,
          tpModes: [
            { tpMode: 'Skip 2', tradeCount: 22, winRate: 55, profitFactor: 1.62, score: 78 },
            { tpMode: 'Nearest', tradeCount: 22, winRate: 61, profitFactor: 1.31, score: 74 },
          ],
        },
        {
          regimeLabel: 'mixed',
          sampleSize: 8,
          confidenceLabel: 'low',
          bestTpMode: 'Nearest',
          bestTpWinRate: 52,
          bestTpProfitFactor: 0.98,
          tpModes: [
            { tpMode: 'Nearest', tradeCount: 8, winRate: 52, profitFactor: 0.98, score: 44 },
          ],
        },
      ],
      recommendationAccuracyByRegime: [
        {
          regimeLabel: 'wide_volatile',
          sampleSize: 20,
          confidenceLabel: 'medium',
          postureAccuracy: 62,
          strategyAccuracy: 58,
          tpAccuracy: 54,
          avgRecommendationDelta: 14,
        },
        {
          regimeLabel: 'mixed',
          sampleSize: 8,
          confidenceLabel: 'low',
          postureAccuracy: 47,
          strategyAccuracy: 42,
          tpAccuracy: 39,
          avgRecommendationDelta: -18,
        },
      ],
    },
    recommendationPerformance: {
      scorecards: [
        {
          date: '2026-03-01',
          sourceType: 'live',
          postureEvaluation: 'correct',
          strategyRecommendationScore: { scoreLabel: 'correct' },
          tpRecommendationScore: { scoreLabel: 'partially_correct' },
          recommendationDelta: 28,
        },
        {
          date: '2026-03-02',
          sourceType: 'backfill',
          postureEvaluation: 'partially_correct',
          strategyRecommendationScore: { scoreLabel: 'partially_correct' },
          tpRecommendationScore: { scoreLabel: 'correct' },
          recommendationDelta: 10,
        },
        {
          date: '2026-03-03',
          sourceType: 'backfill',
          postureEvaluation: 'incorrect',
          strategyRecommendationScore: { scoreLabel: 'incorrect' },
          tpRecommendationScore: { scoreLabel: 'incorrect' },
          recommendationDelta: -22,
        },
        {
          date: '2026-03-04',
          sourceType: 'live',
          postureEvaluation: 'correct',
          strategyRecommendationScore: { scoreLabel: 'partially_correct' },
          tpRecommendationScore: { scoreLabel: 'partially_correct' },
          recommendationDelta: 12,
        },
      ],
      summary: {
        sourceBreakdown: { live: 2, backfill: 2, total: 4 },
        warnings: ['thin_sample_30d'],
      },
      warnings: ['thin_sample_30d'],
    },
  };
}

function assertBreakdown(row) {
  assert(row && typeof row === 'object', 'row missing');
  const src = row.evidenceSourceBreakdown;
  assert(src && typeof src === 'object', 'evidenceSourceBreakdown missing');
  assert(Number.isFinite(Number(src.live)), 'evidenceSourceBreakdown.live missing');
  assert(Number.isFinite(Number(src.backfill)), 'evidenceSourceBreakdown.backfill missing');
  assert(Number.isFinite(Number(src.total)), 'evidenceSourceBreakdown.total missing');
  assert(Number(src.total) === Number(src.live) + Number(src.backfill), 'evidenceSourceBreakdown total mismatch');
}

function assertCoverageFields(row) {
  assert(Number.isFinite(Number(row?.upstreamCoverageSampleSize)), 'upstreamCoverageSampleSize missing');
  assert(Number.isFinite(Number(row?.directProvenanceSampleSize)), 'directProvenanceSampleSize missing');
  assert(ALLOWED_COVERAGE_TYPE.includes(String(row?.coverageType || '')), 'coverageType invalid');
  assert(ALLOWED_PROVENANCE_STRENGTH.includes(String(row?.provenanceStrengthLabel || '')), 'provenanceStrengthLabel invalid');
}

function runUnitChecks() {
  const fixture = buildFixture();
  const summary = buildRegimePerformanceFeedbackSummary({
    windowSessions: 120,
    includeContext: true,
    performanceSource: 'all',
    ...fixture,
  });

  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisory-only');
  assert(Array.isArray(summary.regimeUsefulness) && summary.regimeUsefulness.length > 0, 'regimeUsefulness missing');
  assert(Array.isArray(summary.strongRegimeLabels), 'strongRegimeLabels missing');
  assert(Array.isArray(summary.weakRegimeLabels), 'weakRegimeLabels missing');
  assert(Array.isArray(summary.strategySelectionUsefulnessByRegime), 'strategySelectionUsefulnessByRegime missing');
  assert(Array.isArray(summary.tpUsefulnessByRegime), 'tpUsefulnessByRegime missing');
  assert(summary.dataQuality && typeof summary.dataQuality === 'object', 'dataQuality missing');
  assert(summary.dataQuality.sourceBreakdown && typeof summary.dataQuality.sourceBreakdown === 'object', 'dataQuality.sourceBreakdown missing');
  assert(Number.isFinite(Number(summary.dataQuality.sourceBreakdown.live)), 'dataQuality.sourceBreakdown.live missing');
  assert(Number.isFinite(Number(summary.dataQuality.sourceBreakdown.backfill)), 'dataQuality.sourceBreakdown.backfill missing');
  assert(Number.isFinite(Number(summary.dataQuality.sourceBreakdown.total)), 'dataQuality.sourceBreakdown.total missing');
  assert(ALLOWED_EVIDENCE_QUALITY.includes(String(summary.dataQuality.sourceEvidenceQuality || '')), 'dataQuality.sourceEvidenceQuality invalid');

  for (const row of summary.regimeUsefulness) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row.regimeLabel || '')), `unsupported regime label: ${row.regimeLabel}`);
    assert(['strong', 'moderate', 'weak', 'noisy', 'insufficient'].includes(String(row.usefulnessLabel || '')), 'invalid usefulness label');
    assert(Number.isFinite(Number(row.confidenceAdjustment)), 'confidenceAdjustment missing');
    assert(Number(row.confidenceAdjustment) >= -15 && Number(row.confidenceAdjustment) <= 10, 'confidenceAdjustment out of bounds');
    assertBreakdown(row);
    assertCoverageFields(row);
    const label = String(row.regimeLabel || '');
    if ((label === 'mixed' || label === 'unknown') && !(Number(row.sampleSize || 0) >= 30 && Number(row.usefulnessScore || 0) >= 70)) {
      assert(Number(row.confidenceAdjustment || 0) <= 0, 'mixed/unknown adjustment cap violated');
    }
    if (Number(row?.directProvenanceSampleSize || 0) === 0) {
      assert(String(row?.usefulnessLabel || '') !== 'strong', 'rows without direct provenance cannot be strong');
      assert(Number(row?.confidenceAdjustment || 0) <= 0, 'rows without direct provenance must remain non-positive');
      assert(Array.isArray(row.warnings) && row.warnings.includes('no_direct_regime_provenance'), 'missing no_direct_regime_provenance warning');
    }
    if (String(row?.coverageType || '') === 'no_support') {
      assert(String(row?.usefulnessLabel || '') === 'insufficient', 'no_support rows must be insufficient');
      assert(Number(row?.confidenceAdjustment || 0) === 0, 'no_support rows must have zero adjustment');
      assert(Array.isArray(row.warnings) && row.warnings.includes('no_regime_support'), 'no_support rows must include no_regime_support');
    }
  }

  const zeroProvenanceRows = summary.regimeUsefulness.filter((row) =>
    Number(row?.evidenceSourceBreakdown?.total || 0) === 0
  );
  for (const row of zeroProvenanceRows) {
    assert(Array.isArray(row.warnings) && row.warnings.includes('no_regime_provenance'), 'zero-provenance rows must emit no_regime_provenance warning');
  }

  const guidance = summary.regimeConfidenceGuidance;
  assert(guidance && typeof guidance === 'object', 'regimeConfidenceGuidance missing');
  assert(['increase_trust', 'maintain', 'reduce_trust'].includes(String(guidance.guidanceLabel || '')), 'invalid guidanceLabel');
  assert(ALLOWED_EVIDENCE_QUALITY.includes(String(guidance.evidenceQuality || '')), 'invalid evidenceQuality');
  assertBreakdown(guidance);
  assertCoverageFields(guidance);
  assert(typeof summary.regimeFeedbackInsight === 'string' && summary.regimeFeedbackInsight.length > 0, 'regimeFeedbackInsight missing');

  const coverageByRegime = new Map(summary.regimeUsefulness.map((row) => [String(row.regimeLabel), String(row.coverageType)]));
  for (const label of summary.strongRegimeLabels) {
    const coverageType = coverageByRegime.get(String(label));
    assert(coverageType !== 'upstream_only' && coverageType !== 'no_support', 'strongRegimeLabels cannot include upstream_only/no_support rows');
  }
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
    port: process.env.JARVIS_AUDIT_PORT || 3185,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/performance?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'regime/performance endpoint should return ok');
    const feedback = out?.regimePerformanceFeedback;
    assert(feedback && typeof feedback === 'object', 'regimePerformanceFeedback missing');
    assert(feedback.advisoryOnly === true, 'regimePerformanceFeedback must be advisoryOnly');
    assert(Array.isArray(feedback.regimeUsefulness), 'regimeUsefulness missing from endpoint');
    assert(feedback.regimeUsefulness.length > 0, 'regimeUsefulness should not be empty');

    for (const row of feedback.regimeUsefulness) {
      assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), `unsupported regime label emitted: ${row?.regimeLabel}`);
      assertBreakdown(row);
      assertCoverageFields(row);
    }

    const guidance = feedback.regimeConfidenceGuidance;
    assert(guidance && typeof guidance === 'object', 'endpoint guidance missing');
    assert(ALLOWED_EVIDENCE_QUALITY.includes(String(guidance.evidenceQuality || '')), 'endpoint guidance evidenceQuality invalid');
    assertBreakdown(guidance);
    assertCoverageFields(guidance);
    assert(feedback?.dataQuality?.sourceBreakdown && typeof feedback.dataQuality.sourceBreakdown === 'object', 'endpoint dataQuality.sourceBreakdown missing');
    assert(ALLOWED_EVIDENCE_QUALITY.includes(String(feedback?.dataQuality?.sourceEvidenceQuality || '')), 'endpoint dataQuality.sourceEvidenceQuality invalid');

    if (Array.isArray(feedback.strongRegimeLabels)) {
      for (const label of feedback.strongRegimeLabels) {
        assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `unsupported strongRegimeLabel: ${label}`);
      }
    }
    if (Array.isArray(feedback.weakRegimeLabels)) {
      for (const label of feedback.weakRegimeLabels) {
        assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `unsupported weakRegimeLabel: ${label}`);
      }
    }

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&windowSessions=120&performanceSource=all');
    assert(centerOut?.status === 'ok', 'command-center endpoint should return ok');
    assert(centerOut?.regimePerformanceFeedback && typeof centerOut.regimePerformanceFeedback === 'object', 'top-level regimePerformanceFeedback missing in command-center response');

    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.regimeFeedbackInsight === 'string' && cc.regimeFeedbackInsight.length > 0, 'command-center regimeFeedbackInsight missing');
    assert(cc.regimeConfidenceGuidance && typeof cc.regimeConfidenceGuidance === 'object', 'command-center regimeConfidenceGuidance missing');
    assert(ALLOWED_EVIDENCE_QUALITY.includes(String(cc?.regimeConfidenceGuidance?.evidenceQuality || '')), 'command-center evidenceQuality invalid');
    assertCoverageFields(cc.regimeConfidenceGuidance);
    if (cc.strongRegimeLabel) assert(SUPPORTED_REGIME_LABELS.includes(String(cc.strongRegimeLabel)), 'unsupported command-center strongRegimeLabel');
    if (cc.weakRegimeLabel) assert(SUPPORTED_REGIME_LABELS.includes(String(cc.weakRegimeLabel)), 'unsupported command-center weakRegimeLabel');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime performance feedback tests passed.');
  } catch (err) {
    console.error(`Jarvis regime performance feedback test failed: ${err.message}`);
    process.exit(1);
  }
})();
