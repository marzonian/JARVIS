#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimeEvidenceSplitSummary,
} = require('../server/jarvis-core/regime-evidence-split');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;
const ALLOWED_TRUST_BIAS = ['live_confirmed', 'mixed_support', 'retrospective_led', 'insufficient_live_confirmation'];
const ALLOWED_COVERAGE = ['direct_provenance', 'upstream_only', 'mixed_support', 'no_support'];
const ALLOWED_ALL_PROVENANCE = ['direct', 'retrospective_heavy', 'mixed', 'inferred_only', 'absent'];
const ALLOWED_LIVE_PROVENANCE = ['direct', 'absent', 'thin_live'];

function buildFixture() {
  return {
    regimeDetection: { regimeLabel: 'trending' },
    regimeByDate: {
      '2026-03-01': {
        regime_trend: 'trending',
        regime_vol: 'high',
        regime_orb_size: 'wide',
      },
    },
    regimePerformanceFeedback: {
      regimeUsefulness: [
        {
          regimeLabel: 'trending',
          usefulnessScore: 74,
          usefulnessLabel: 'strong',
          confidenceAdjustment: 6,
          directProvenanceSampleSize: 40,
          upstreamCoverageSampleSize: 40,
          coverageType: 'mixed_support',
          provenanceStrengthLabel: 'retrospective_heavy',
          evidenceSourceBreakdown: { live: 2, backfill: 38, total: 40 },
          warnings: [],
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
    },
    recommendationPerformance: {
      scorecards: [
        {
          date: '2026-03-01',
          sourceType: 'backfill',
          postureEvaluation: 'correct',
          strategyRecommendationScore: { scoreLabel: 'correct' },
          tpRecommendationScore: { scoreLabel: 'correct' },
          recommendationDelta: 18,
        },
      ],
      summary: {
        sourceBreakdown: { live: 0, backfill: 40, total: 40 },
      },
    },
    regimeAwareLearning: {
      strategyByRegime: [],
      tpModeByRegime: [],
      recommendationAccuracyByRegime: [],
    },
  };
}

function assertBreakdown(row) {
  const src = row?.evidenceSourceBreakdown;
  assert(src && typeof src === 'object', 'evidenceSourceBreakdown missing');
  assert(Number.isFinite(Number(src.live)), 'evidenceSourceBreakdown.live missing');
  assert(Number.isFinite(Number(src.backfill)), 'evidenceSourceBreakdown.backfill missing');
  assert(Number.isFinite(Number(src.total)), 'evidenceSourceBreakdown.total missing');
  assert(Number(src.total) === Number(src.live) + Number(src.backfill), 'evidenceSourceBreakdown total mismatch');
}

function runUnitChecks() {
  const summary = buildRegimeEvidenceSplitSummary({
    windowSessions: 120,
    performanceSource: 'all',
    ...buildFixture(),
  });

  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(Array.isArray(summary.allEvidenceByRegime), 'allEvidenceByRegime missing');
  assert(Array.isArray(summary.liveOnlyByRegime), 'liveOnlyByRegime missing');
  assert(Array.isArray(summary.liveConfirmedRegimeLabels), 'liveConfirmedRegimeLabels missing');
  assert(Array.isArray(summary.retrospectiveLedRegimeLabels), 'retrospectiveLedRegimeLabels missing');
  assert(ALLOWED_TRUST_BIAS.includes(String(summary.trustBiasLabel || '')), 'invalid trustBiasLabel');
  assert(summary.currentRegimeComparison && typeof summary.currentRegimeComparison === 'object', 'currentRegimeComparison missing');

  for (const row of summary.allEvidenceByRegime) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), `unsupported allEvidence regime label: ${row?.regimeLabel}`);
    assert(ALLOWED_COVERAGE.includes(String(row?.coverageType || '')), 'invalid allEvidence coverageType');
    assert(ALLOWED_ALL_PROVENANCE.includes(String(row?.provenanceStrengthLabel || '')), 'invalid allEvidence provenanceStrengthLabel');
    assertBreakdown(row);
  }

  for (const row of summary.liveOnlyByRegime) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), `unsupported liveOnly regime label: ${row?.regimeLabel}`);
    assert(ALLOWED_COVERAGE.includes(String(row?.coverageType || '')), 'invalid liveOnly coverageType');
    assert(ALLOWED_LIVE_PROVENANCE.includes(String(row?.provenanceStrengthLabel || '')), 'invalid liveOnly provenanceStrengthLabel');
    assertBreakdown(row);
    assert(Number(row?.evidenceSourceBreakdown?.backfill || 0) === 0, 'liveOnly row cannot include backfill evidence');
    assert(Number(row?.evidenceSourceBreakdown?.total || 0) === Number(row?.evidenceSourceBreakdown?.live || 0), 'liveOnly total must equal live');
    if (Number(row?.liveDirectSampleSize || 0) < 5) {
      assert(String(row?.usefulnessLabel || '') === 'insufficient', 'liveOnly <5 sample must be insufficient');
      assert(Number(row?.confidenceAdjustment || 0) === 0, 'liveOnly <5 sample must have zero adjustment');
    }
  }

  const trendingComparison = summary.currentRegimeComparison;
  assert(String(trendingComparison.regimeLabel || '') === 'trending', 'currentRegimeComparison should target trending');
  assert(String(trendingComparison.allEvidenceUsefulnessLabel || '') === 'strong', 'fixture should keep allEvidence strong');
  assert(String(trendingComparison.liveOnlyUsefulnessLabel || '') === 'insufficient', 'fixture should produce insufficient live-only');
  assert(String(trendingComparison.trustBiasLabel || '') !== 'live_confirmed', 'strong all-evidence + insufficient live must never be live_confirmed');
}

async function getJson(baseUrl, endpoint) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3186,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/evidence-split?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'evidence-split endpoint should return ok');
    const split = out?.regimeEvidenceSplit;
    assert(split && typeof split === 'object', 'regimeEvidenceSplit missing');
    assert(split.advisoryOnly === true, 'regimeEvidenceSplit should be advisoryOnly');
    assert(ALLOWED_TRUST_BIAS.includes(String(split.trustBiasLabel || '')), 'endpoint trustBiasLabel invalid');
    assert(split.currentRegimeComparison && typeof split.currentRegimeComparison === 'object', 'endpoint currentRegimeComparison missing');

    for (const row of (split.allEvidenceByRegime || [])) {
      assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), 'endpoint allEvidence label invalid');
      assert(ALLOWED_COVERAGE.includes(String(row?.coverageType || '')), 'endpoint allEvidence coverageType invalid');
      assert(ALLOWED_ALL_PROVENANCE.includes(String(row?.provenanceStrengthLabel || '')), 'endpoint allEvidence provenance label invalid');
    }
    for (const row of (split.liveOnlyByRegime || [])) {
      assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), 'endpoint liveOnly label invalid');
      assert(ALLOWED_COVERAGE.includes(String(row?.coverageType || '')), 'endpoint liveOnly coverageType invalid');
      assert(ALLOWED_LIVE_PROVENANCE.includes(String(row?.provenanceStrengthLabel || '')), 'endpoint liveOnly provenance label invalid');
      assert(Number(row?.evidenceSourceBreakdown?.backfill || 0) === 0, 'endpoint liveOnly backfill must be 0');
    }

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center should return ok');
    assert(center?.regimeEvidenceSplit && typeof center.regimeEvidenceSplit === 'object', 'top-level regimeEvidenceSplit missing');
    const cc = center?.commandCenter || {};
    assert(typeof cc.regimeEvidenceSplitInsight === 'string' && cc.regimeEvidenceSplitInsight.length > 0, 'commandCenter.regimeEvidenceSplitInsight missing');
    assert(ALLOWED_TRUST_BIAS.includes(String(cc.regimeTrustBiasLabel || '')), 'commandCenter.regimeTrustBiasLabel invalid');
    assert(typeof cc.regimeTrustBiasReason === 'string' && cc.regimeTrustBiasReason.length > 0, 'commandCenter.regimeTrustBiasReason missing');
    assert(cc.currentRegimeLiveConfirmation && typeof cc.currentRegimeLiveConfirmation === 'object', 'commandCenter.currentRegimeLiveConfirmation missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime evidence split tests passed.');
  } catch (err) {
    console.error(`Jarvis regime evidence split test failed: ${err.message}`);
    process.exit(1);
  }
})();
