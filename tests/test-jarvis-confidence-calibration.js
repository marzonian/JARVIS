#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  calibrateConfidenceForRecommendation,
  applyConfidenceCalibration,
} = require('../server/jarvis-core/confidence-calibration');
const {
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 120000;

function buildRow(input = {}) {
  return {
    date: input.date || '2026-03-01',
    sourceType: input.sourceType || 'backfill',
    reconstructionPhase: input.reconstructionPhase || 'pre_orb_recommendation',
    posture: input.posture || 'trade_selectively',
    recommendedStrategyKey: input.recommendedStrategyKey || 'original_plan_orb_3130',
    recommendedTpMode: input.recommendedTpMode || 'Skip 2',
    weekday: input.weekday || 'Tuesday',
    timeBucket: input.timeBucket || 'post_orb',
    postureEvaluation: input.postureEvaluation || 'correct',
    strategyScoreLabel: input.strategyScoreLabel || 'correct',
    tpScoreLabel: input.tpScoreLabel || 'correct',
    recommendationDelta: input.recommendationDelta ?? 25,
  };
}

function runUnitChecks() {
  const targetContext = {
    posture: 'trade_selectively',
    recommendedStrategyKey: 'original_plan_orb_3130',
    recommendedTpMode: 'Skip 2',
    weekday: 'Tuesday',
    timeBucket: 'post_orb',
    reconstructionPhase: 'pre_orb_recommendation',
  };
  const todayRecommendation = {
    posture: targetContext.posture,
    recommendedTpMode: targetContext.recommendedTpMode,
    confidenceScore: 58,
  };
  const highBaseRecommendation = {
    posture: targetContext.posture,
    recommendedTpMode: targetContext.recommendedTpMode,
    confidenceScore: 76,
  };

  // 1) confidence increases when evidence is strong
  const strongRows = Array.from({ length: 22 }, (_, i) => buildRow({
    date: `2026-02-${String(1 + i).padStart(2, '0')}`,
    recommendationDelta: 35,
    postureEvaluation: i % 6 === 0 ? 'partially_correct' : 'correct',
    strategyScoreLabel: i % 8 === 0 ? 'partially_correct' : 'correct',
    tpScoreLabel: i % 7 === 0 ? 'partially_correct' : 'correct',
  }));
  const strong = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: strongRows,
    recommendationDate: '2026-03-10',
    context: targetContext,
    evidenceSource: 'backfill',
  });
  assert(strong.sampleSize >= 20, 'strong sampleSize should be >= 20');
  assert(strong.calibrationDelta > 0, 'confidence should increase with strong evidence');
  assert(strong.calibratedConfidenceScore > strong.baseConfidenceScore, 'calibrated confidence should be above base');
  assert(strong.evidenceWindow?.fallbackLevel === 'full_context', 'strong evidence should use full_context');

  // 1b) weak-precision context should not allow positive uplift
  const weakPrecisionSuppressed = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: strongRows,
    recommendationDate: '2026-03-10',
    context: {
      ...targetContext,
      fallbackLevel: 'global',
      regimeTrustBiasLabel: 'insufficient_live_confirmation',
      liveConfirmationWeak: true,
    },
    evidenceSource: 'all',
  });
  assert(Number(weakPrecisionSuppressed.calibrationDelta) <= 0, 'weak-precision context must not receive positive confidence uplift');
  assert(Number(weakPrecisionSuppressed.calibratedConfidenceScore) <= Number(weakPrecisionSuppressed.baseConfidenceScore), 'weak-precision context should not raise confidence score');
  assert(weakPrecisionSuppressed.confidenceClampReason === 'weak_precision_no_positive_uplift', 'weak-precision uplift suppression reason missing');

  // 1c) mixed-precision fallback context should never end in high confidence
  const mixedPrecisionCapped = calibrateConfidenceForRecommendation({
    todayRecommendation: highBaseRecommendation,
    scorecards: strongRows,
    recommendationDate: '2026-03-10',
    context: {
      ...targetContext,
      fallbackLevel: 'global_fallback',
      regimeTrustBiasLabel: 'mixed_support',
      liveConfirmationWeak: false,
    },
    evidenceSource: 'all',
  });
  assert(Number(mixedPrecisionCapped.calibrationDelta) <= 0, 'mixed-precision fallback context must not receive positive confidence uplift');
  assert(Number(mixedPrecisionCapped.calibratedConfidenceScore) < 72, 'mixed-precision fallback context must be capped below high confidence threshold');
  assert(mixedPrecisionCapped.confidenceLabelAfter === 'medium', 'mixed-precision fallback context should resolve to medium confidence');
  assert(mixedPrecisionCapped.confidenceClampReason === 'mixed_precision_confidence_ceiling', 'mixed-precision fallback confidence ceiling reason missing');
  assert(mixedPrecisionCapped.mixedPrecisionConfidenceCeilingApplied === true, 'mixed-precision ceiling flag should be true');

  // 1d) exact-context and confirmed context should still allow positive uplift
  const exactContextStrong = calibrateConfidenceForRecommendation({
    todayRecommendation: highBaseRecommendation,
    scorecards: strongRows,
    recommendationDate: '2026-03-10',
    context: {
      ...targetContext,
      fallbackLevel: 'exact_context',
      regimeTrustBiasLabel: 'none',
      liveConfirmationWeak: false,
    },
    evidenceSource: 'all',
  });
  assert(Number(exactContextStrong.calibrationDelta) > 0, 'exact-context confirmed case should still allow positive uplift');
  assert(exactContextStrong.confidenceLabelAfter === 'high', 'exact-context confirmed case should retain high-confidence behavior when evidence is strong');

  // 1e) fallback/global with healthy trust should not be forced into suppression
  const fallbackHealthyTrust = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: strongRows,
    recommendationDate: '2026-03-10',
    context: {
      ...targetContext,
      fallbackLevel: 'global',
      regimeTrustBiasLabel: 'none',
      liveConfirmationWeak: false,
    },
    evidenceSource: 'all',
  });
  assert(Number(fallbackHealthyTrust.calibrationDelta) > 0, 'fallback/global alone should not be suppressed without weak trust/live-confirmation');

  // 2) confidence decreases when evidence is weak
  const weakRows = Array.from({ length: 24 }, (_, i) => buildRow({
    date: `2026-01-${String(1 + i).padStart(2, '0')}`,
    recommendationDelta: -80,
    postureEvaluation: i % 3 === 0 ? 'partially_correct' : 'incorrect',
    strategyScoreLabel: 'incorrect',
    tpScoreLabel: 'incorrect',
  }));
  const weak = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: weakRows,
    recommendationDate: '2026-03-10',
    context: targetContext,
    evidenceSource: 'backfill',
  });
  assert(weak.sampleSize >= 20, 'weak sampleSize should be >= 20');
  assert(weak.calibrationDelta < 0, 'confidence should decrease with weak evidence');
  assert(weak.calibratedConfidenceScore < weak.baseConfidenceScore, 'calibrated confidence should be below base');

  // 3) clamp when sample is small
  const thinRows = Array.from({ length: 6 }, (_, i) => buildRow({
    date: `2026-01-${String(1 + i).padStart(2, '0')}`,
    recommendationDelta: 90,
    postureEvaluation: 'correct',
    strategyScoreLabel: 'correct',
    tpScoreLabel: 'correct',
  }));
  const thin = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: thinRows,
    recommendationDate: '2026-03-10',
    context: targetContext,
    evidenceSource: 'backfill',
  });
  assert(thin.sampleSize === 6, 'thin sample size should be 6');
  assert(Math.abs(Number(thin.calibrationDelta || 0)) <= 4.01, 'thin sample must clamp calibration delta');
  assert(thin.confidenceClampReason === 'thin_sample_clamp', 'thin sample clamp reason missing');

  // 4) fallback chain works (drop_weekday)
  const fallbackRows = Array.from({ length: 12 }, (_, i) => buildRow({
    date: `2026-01-${String(1 + i).padStart(2, '0')}`,
    weekday: 'Monday',
    timeBucket: 'post_orb',
    recommendationDelta: 10,
    postureEvaluation: 'correct',
    strategyScoreLabel: 'correct',
    tpScoreLabel: 'partially_correct',
  }));
  const fallback = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: fallbackRows,
    recommendationDate: '2026-03-10',
    context: targetContext,
    evidenceSource: 'backfill',
  });
  assert(fallback.sampleSize >= 10, 'fallback sample should match rows');
  assert(fallback.evidenceWindow?.fallbackLevel === 'drop_weekday', 'fallback should select drop_weekday');

  // apply wrapper sanity
  const applied = applyConfidenceCalibration({
    todayRecommendation,
    scorecards: strongRows,
    recommendationDate: '2026-03-10',
    context: targetContext,
    evidenceSource: 'backfill',
  });
  assert(applied?.todayRecommendation?.confidenceCalibration, 'applied calibration should attach confidenceCalibration');
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

async function runIntegrationCheck() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3175,
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
    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1');
    assert(center?.status === 'ok', 'command-center should return ok');
    const today = center?.commandCenter?.todayRecommendation;
    assert(today && typeof today === 'object', 'todayRecommendation missing');
    const calibration = today?.confidenceCalibration;
    assert(calibration && typeof calibration === 'object', 'confidenceCalibration missing from todayRecommendation');
    const required = [
      'baseConfidenceScore',
      'calibratedConfidenceScore',
      'calibrationDelta',
      'confidenceLabelBefore',
      'confidenceLabelAfter',
      'calibrationReason',
      'evidenceSource',
      'sampleSize',
      'sampleQuality',
    ];
    for (const key of required) {
      assert(Object.prototype.hasOwnProperty.call(calibration, key), `missing confidenceCalibration.${key}`);
    }
    assert(typeof center?.commandCenter?.confidenceCalibrationInsight === 'string', 'confidenceCalibrationInsight missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationCheck();
    console.log('All jarvis confidence calibration tests passed.');
  } catch (err) {
    console.error(`Jarvis confidence calibration test failed: ${err.message}`);
    process.exit(1);
  }
})();
