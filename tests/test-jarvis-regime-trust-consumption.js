#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimeTrustConsumptionSummary,
} = require('../server/jarvis-core/regime-trust-consumption');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;
const ALLOWED_CONSUMPTION_LABELS = [
  'allow_regime_confidence',
  'allow_with_caution',
  'reduce_regime_weight',
  'suppress_regime_bias',
];
const ALLOWED_TRUST_BIAS = [
  'live_confirmed',
  'mixed_support',
  'retrospective_led',
  'insufficient_live_confirmation',
];

function buildFixture(overrides = {}) {
  return {
    windowSessions: 120,
    regimeDetection: {
      regimeLabel: 'wide_volatile',
    },
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'retrospective_led',
      trustBiasReason: 'All-evidence is stronger than live-only for current regime.',
      currentRegimeComparison: {
        regimeLabel: 'wide_volatile',
        allEvidenceUsefulnessScore: 66,
        allEvidenceUsefulnessLabel: 'moderate',
        liveOnlyUsefulnessScore: 49,
        liveOnlyUsefulnessLabel: 'weak',
        scoreGap: 17,
        liveDirectSampleSize: 6,
        allEvidenceDirectSampleSize: 120,
        trustBiasLabel: 'retrospective_led',
        trustBiasReason: 'All-evidence is stronger than live-only for current regime.',
      },
      allEvidenceByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 66,
          usefulnessLabel: 'moderate',
          directProvenanceSampleSize: 120,
          upstreamCoverageSampleSize: 120,
          coverageType: 'mixed_support',
          provenanceStrengthLabel: 'retrospective_heavy',
          evidenceSourceBreakdown: { live: 8, backfill: 112, total: 120 },
        },
      ],
      liveOnlyByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 49,
          usefulnessLabel: 'weak',
          liveDirectSampleSize: 6,
          coverageType: 'direct_provenance',
          provenanceStrengthLabel: 'thin_live',
          evidenceSourceBreakdown: { live: 6, backfill: 0, total: 6 },
        },
      ],
    },
    regimeAwareLearning: {
      topRegimeAlignedStrategy: {
        regimeLabel: 'wide_volatile',
        strategyKey: 'candidate_a',
      },
      regimeSpecificOpportunities: [
        {
          regimeLabel: 'wide_volatile',
          insight: 'Candidate A leads in wide_volatile.',
        },
      ],
      regimeSpecificRisks: [
        {
          regimeLabel: 'wide_volatile',
          insight: 'Regime drift risk is elevated.',
        },
      ],
    },
    regimePerformanceFeedback: {
      regimeConfidenceGuidance: {
        evidenceQuality: 'retrospective_heavy',
      },
    },
    recommendationPerformanceSummary: {
      warnings: ['thin_sample_30d'],
      calibrationWarnings: ['insufficient_calibration_sample'],
      sourceBreakdown: { live: 6, backfill: 114, total: 120 },
    },
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
    },
    ...overrides,
  };
}

function runUnitChecks() {
  const summary = buildRegimeTrustConsumptionSummary(buildFixture());
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisory-only');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(ALLOWED_TRUST_BIAS.includes(String(summary.trustBiasLabel || '')), 'trustBiasLabel must be bounded');
  assert(ALLOWED_CONSUMPTION_LABELS.includes(String(summary.trustConsumptionLabel || '')), 'trustConsumptionLabel must be bounded');
  assert(Number.isFinite(Number(summary.confidenceAdjustmentOverride)), 'confidenceAdjustmentOverride must be numeric');
  assert(
    Number(summary.confidenceAdjustmentOverride) >= -12
      && Number(summary.confidenceAdjustmentOverride) <= 5,
    'confidenceAdjustmentOverride out of bounds'
  );
  assert(summary.currentRegimeTrustSnapshot && typeof summary.currentRegimeTrustSnapshot === 'object', 'currentRegimeTrustSnapshot missing');

  const insufficient = buildRegimeTrustConsumptionSummary(buildFixture({
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'insufficient_live_confirmation',
      trustBiasReason: 'Live sample is too thin.',
      currentRegimeComparison: {
        regimeLabel: 'wide_volatile',
        allEvidenceUsefulnessScore: 60,
        allEvidenceUsefulnessLabel: 'moderate',
        liveOnlyUsefulnessScore: null,
        liveOnlyUsefulnessLabel: 'insufficient',
        scoreGap: null,
        liveDirectSampleSize: 2,
        allEvidenceDirectSampleSize: 120,
      },
      allEvidenceByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 60,
          usefulnessLabel: 'moderate',
          directProvenanceSampleSize: 120,
          upstreamCoverageSampleSize: 120,
          coverageType: 'mixed_support',
          provenanceStrengthLabel: 'retrospective_heavy',
          evidenceSourceBreakdown: { live: 4, backfill: 116, total: 120 },
        },
      ],
      liveOnlyByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: null,
          usefulnessLabel: 'insufficient',
          liveDirectSampleSize: 2,
          coverageType: 'direct_provenance',
          provenanceStrengthLabel: 'thin_live',
          evidenceSourceBreakdown: { live: 2, backfill: 0, total: 2 },
        },
      ],
    },
  }));
  assert(String(insufficient.trustConsumptionLabel) === 'suppress_regime_bias', 'insufficient live should suppress regime bias');
  assert(Number(insufficient.confidenceAdjustmentOverride) <= -6, 'insufficient live cannot produce weakly negative override');
  assert(insufficient.shouldSuppressRegimeOpportunity === true, 'insufficient live should suppress opportunity bias');

  const retroLed = buildRegimeTrustConsumptionSummary(buildFixture({
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'retrospective_led',
      trustBiasReason: 'Retrospective support dominates.',
      currentRegimeComparison: {
        regimeLabel: 'wide_volatile',
        allEvidenceUsefulnessScore: 72,
        allEvidenceUsefulnessLabel: 'strong',
        liveOnlyUsefulnessScore: 52,
        liveOnlyUsefulnessLabel: 'weak',
        scoreGap: 20,
        liveDirectSampleSize: 8,
        allEvidenceDirectSampleSize: 120,
      },
      allEvidenceByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 72,
          usefulnessLabel: 'strong',
          directProvenanceSampleSize: 120,
          upstreamCoverageSampleSize: 120,
          coverageType: 'mixed_support',
          provenanceStrengthLabel: 'retrospective_heavy',
          evidenceSourceBreakdown: { live: 8, backfill: 112, total: 120 },
        },
      ],
      liveOnlyByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 52,
          usefulnessLabel: 'weak',
          liveDirectSampleSize: 8,
          coverageType: 'direct_provenance',
          provenanceStrengthLabel: 'thin_live',
          evidenceSourceBreakdown: { live: 8, backfill: 0, total: 8 },
        },
      ],
    },
  }));
  assert(Number(retroLed.confidenceAdjustmentOverride) <= 0, 'retrospective_led cannot produce positive override');

  const fakeLiveConfirmed = buildRegimeTrustConsumptionSummary(buildFixture({
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'live_confirmed',
      trustBiasReason: 'Incorrectly flagged live confirmed.',
      currentRegimeComparison: {
        regimeLabel: 'wide_volatile',
        allEvidenceUsefulnessScore: 61,
        allEvidenceUsefulnessLabel: 'moderate',
        liveOnlyUsefulnessScore: 60,
        liveOnlyUsefulnessLabel: 'moderate',
        scoreGap: 1,
        liveDirectSampleSize: 6,
        allEvidenceDirectSampleSize: 6,
      },
      allEvidenceByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 61,
          usefulnessLabel: 'moderate',
          directProvenanceSampleSize: 6,
          upstreamCoverageSampleSize: 6,
          coverageType: 'mixed_support',
          provenanceStrengthLabel: 'mixed',
          evidenceSourceBreakdown: { live: 6, backfill: 0, total: 6 },
        },
      ],
      liveOnlyByRegime: [
        {
          regimeLabel: 'wide_volatile',
          usefulnessScore: 60,
          usefulnessLabel: 'moderate',
          liveDirectSampleSize: 6,
          coverageType: 'direct_provenance',
          provenanceStrengthLabel: 'thin_live',
          evidenceSourceBreakdown: { live: 6, backfill: 0, total: 6 },
        },
      ],
    },
  }));
  assert(String(fakeLiveConfirmed.trustConsumptionLabel) !== 'allow_regime_confidence', 'live_confirmed gating requires live sample >= 10');
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
    port: process.env.JARVIS_AUDIT_PORT || 3187,
  });
  try {
    const trustOut = await getJson(server.baseUrl, '/api/jarvis/regime/trust?windowSessions=120&performanceSource=all&force=1');
    assert(trustOut?.status === 'ok', 'regime/trust endpoint should return ok');
    const trust = trustOut?.regimeTrustConsumption;
    assert(trust && typeof trust === 'object', 'regimeTrustConsumption missing');
    assert(trust.advisoryOnly === true, 'regimeTrustConsumption must be advisoryOnly');
    assert(ALLOWED_CONSUMPTION_LABELS.includes(String(trust.trustConsumptionLabel || '')), 'endpoint trustConsumptionLabel invalid');
    assert(Number.isFinite(Number(trust.confidenceAdjustmentOverride)), 'endpoint confidenceAdjustmentOverride missing');

    const out = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'command-center endpoint should return ok');
    assert(out?.regimeTrustConsumption && typeof out.regimeTrustConsumption === 'object', 'top-level regimeTrustConsumption missing');
    const cc = out?.commandCenter || {};
    assert(typeof cc.regimeTrustInsight === 'string' && cc.regimeTrustInsight.length > 0, 'commandCenter.regimeTrustInsight missing');
    assert(ALLOWED_CONSUMPTION_LABELS.includes(String(cc.regimeTrustConsumptionLabel || '')), 'commandCenter.regimeTrustConsumptionLabel invalid');
    assert(typeof cc.regimeTrustConsumptionReason === 'string' && cc.regimeTrustConsumptionReason.length > 0, 'commandCenter.regimeTrustConsumptionReason missing');
    assert(Number.isFinite(Number(cc.regimeConfidenceOverride)), 'commandCenter.regimeConfidenceOverride missing');
    assert(cc.currentRegimeTrustSnapshot && typeof cc.currentRegimeTrustSnapshot === 'object', 'commandCenter.currentRegimeTrustSnapshot missing');
    assert(cc.currentRegimeTrustSnapshot.advisoryOnly === true, 'commandCenter.currentRegimeTrustSnapshot must be advisoryOnly');
    if (cc.decisionBoard && typeof cc.decisionBoard === 'object') {
      assert(ALLOWED_CONSUMPTION_LABELS.includes(String(cc.decisionBoard.regimeTrustLabel || '')), 'decisionBoard.regimeTrustLabel invalid');
      assert(typeof cc.decisionBoard.regimeTrustReason === 'string', 'decisionBoard.regimeTrustReason missing');
    }
    if (cc.todayRecommendation && typeof cc.todayRecommendation === 'object') {
      assert(ALLOWED_CONSUMPTION_LABELS.includes(String(cc.todayRecommendation.regimeTrustConsumptionLabel || '')), 'todayRecommendation.regimeTrustConsumptionLabel invalid');
      assert(Number.isFinite(Number(cc.todayRecommendation.regimeConfidenceOverride)), 'todayRecommendation.regimeConfidenceOverride missing');
      assert(Object.prototype.hasOwnProperty.call(cc.todayRecommendation, 'regimeOpportunitySuppressed'), 'todayRecommendation.regimeOpportunitySuppressed missing');
    }
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime trust consumption tests passed.');
  } catch (err) {
    console.error(`Jarvis regime trust consumption test failed: ${err.message}`);
    process.exit(1);
  }
})();
