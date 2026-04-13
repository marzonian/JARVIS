#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimeConfirmationDurabilitySummary,
} = require('../server/jarvis-core/regime-confirmation-durability');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;
const ALLOWED_DURABILITY_STATES = [
  'unconfirmed',
  'building_durability',
  'durable_confirmed',
  'fragile_confirmation',
  'decaying_confirmation',
  'recovering_confirmation',
];

function makeLiveConfirmationRow(regimeLabel, opts = {}) {
  return {
    regimeLabel,
    liveSampleSize: Number(opts.liveSampleSize || 0),
    liveUsefulnessLabel: opts.liveUsefulnessLabel || 'insufficient',
    liveUsefulnessScore: Number.isFinite(Number(opts.liveUsefulnessScore)) ? Number(opts.liveUsefulnessScore) : null,
    liveConfidenceAdjustment: Number.isFinite(Number(opts.liveConfidenceAdjustment)) ? Number(opts.liveConfidenceAdjustment) : 0,
    promotionState: opts.promotionState || 'no_live_support',
    promotionReason: opts.promotionReason || `${regimeLabel} state`,
    requiredSampleForPromotion: Number(opts.requiredSampleForPromotion || 15),
    progressPct: Number.isFinite(Number(opts.progressPct)) ? Number(opts.progressPct) : 0,
    evidenceFreshnessLabel: opts.evidenceFreshnessLabel || 'recent_but_thin',
    warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
    advisoryOnly: true,
  };
}

function makeAllRow(regimeLabel, opts = {}) {
  const live = Number(opts.live || 0);
  const backfill = Number(opts.backfill || 0);
  const total = live + backfill;
  return {
    regimeLabel,
    usefulnessScore: Number.isFinite(Number(opts.usefulnessScore)) ? Number(opts.usefulnessScore) : null,
    usefulnessLabel: opts.usefulnessLabel || 'insufficient',
    confidenceAdjustment: Number.isFinite(Number(opts.confidenceAdjustment)) ? Number(opts.confidenceAdjustment) : 0,
    directProvenanceSampleSize: Number.isFinite(Number(opts.directProvenanceSampleSize))
      ? Number(opts.directProvenanceSampleSize)
      : total,
    upstreamCoverageSampleSize: Number.isFinite(Number(opts.upstreamCoverageSampleSize))
      ? Number(opts.upstreamCoverageSampleSize)
      : total,
    coverageType: opts.coverageType || (total > 0 ? 'mixed_support' : 'no_support'),
    provenanceStrengthLabel: opts.provenanceStrengthLabel || (backfill > live ? 'retrospective_heavy' : (live > 0 ? 'mixed' : 'absent')),
    evidenceSourceBreakdown: { live, backfill, total },
    warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
    advisoryOnly: true,
  };
}

function makeLiveSplitRow(regimeLabel, opts = {}) {
  const live = Number(opts.liveDirectSampleSize || 0);
  return {
    regimeLabel,
    usefulnessScore: Number.isFinite(Number(opts.usefulnessScore)) ? Number(opts.usefulnessScore) : null,
    usefulnessLabel: opts.usefulnessLabel || 'insufficient',
    confidenceAdjustment: Number.isFinite(Number(opts.confidenceAdjustment)) ? Number(opts.confidenceAdjustment) : 0,
    liveDirectSampleSize: live,
    coverageType: opts.coverageType || (live > 0 ? 'direct_provenance' : 'no_support'),
    provenanceStrengthLabel: opts.provenanceStrengthLabel || (live >= 10 ? 'direct' : (live > 0 ? 'thin_live' : 'absent')),
    evidenceSourceBreakdown: { live, backfill: 0, total: live },
    warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
    advisoryOnly: true,
  };
}

function buildFixture() {
  return {
    windowSessions: 120,
    liveRegimeConfirmation: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimePromotionState: 'live_confirmed',
      currentRegimePromotionReason: 'wide_volatile promoted.',
      currentRegimeLiveSampleSize: 18,
      currentRegimeRequiredSampleForPromotion: 15,
      currentRegimeConfirmationProgressPct: 78,
      liveConfirmationByRegime: [
        makeLiveConfirmationRow('wide_volatile', {
          liveSampleSize: 18,
          liveUsefulnessLabel: 'moderate',
          liveUsefulnessScore: 58,
          liveConfidenceAdjustment: -1,
          promotionState: 'live_confirmed',
          requiredSampleForPromotion: 15,
          progressPct: 78,
          evidenceFreshnessLabel: 'fresh',
        }),
        makeLiveConfirmationRow('ranging', {
          liveSampleSize: 27,
          liveUsefulnessLabel: 'strong',
          liveUsefulnessScore: 73,
          liveConfidenceAdjustment: 2,
          promotionState: 'live_confirmed',
          requiredSampleForPromotion: 15,
          progressPct: 92,
          evidenceFreshnessLabel: 'fresh',
        }),
        makeLiveConfirmationRow('compressed', {
          liveSampleSize: 16,
          liveUsefulnessLabel: 'moderate',
          liveUsefulnessScore: 58,
          liveConfidenceAdjustment: -2,
          promotionState: 'live_confirmed',
          requiredSampleForPromotion: 15,
          progressPct: 50,
          evidenceFreshnessLabel: 'recent_but_thin',
        }),
        makeLiveConfirmationRow('trending', {
          liveSampleSize: 20,
          liveUsefulnessLabel: 'weak',
          liveUsefulnessScore: 47,
          liveConfidenceAdjustment: -2,
          promotionState: 'live_confirmed',
          requiredSampleForPromotion: 15,
          progressPct: 74,
          evidenceFreshnessLabel: 'fresh',
        }),
        makeLiveConfirmationRow('mixed', {
          liveSampleSize: 24,
          liveUsefulnessLabel: 'moderate',
          liveUsefulnessScore: 66,
          liveConfidenceAdjustment: 1,
          promotionState: 'near_live_confirmation',
          requiredSampleForPromotion: 30,
          progressPct: 70,
          evidenceFreshnessLabel: 'recent_but_thin',
        }),
        makeLiveConfirmationRow('unknown', {
          liveSampleSize: 0,
          liveUsefulnessLabel: 'insufficient',
          liveUsefulnessScore: null,
          liveConfidenceAdjustment: 0,
          promotionState: 'no_live_support',
          requiredSampleForPromotion: 30,
          progressPct: 0,
          evidenceFreshnessLabel: 'stale_or_sparse',
        }),
      ],
      liveConfirmedRegimeLabels: ['wide_volatile', 'ranging', 'compressed', 'trending'],
      emergingLiveSupportRegimeLabels: ['mixed'],
      stalledRegimeLabels: [],
      liveConfirmationInsight: 'Fixture insight',
      advisoryOnly: true,
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'retrospective_led',
      trustBiasReason: 'Current regime still retrospective-led.',
      trustConsumptionLabel: 'reduce_regime_weight',
      trustConsumptionReason: 'Current regime should be reduced in weighting.',
      confidenceAdjustmentOverride: -6,
      currentRegimeTrustSnapshot: {
        regimeLabel: 'wide_volatile',
        trustBiasLabel: 'retrospective_led',
        trustConsumptionLabel: 'reduce_regime_weight',
        liveOnlyUsefulnessLabel: 'moderate',
        allEvidenceUsefulnessLabel: 'strong',
        liveDirectSampleSize: 18,
        allEvidenceDirectSampleSize: 120,
        scoreGap: 16,
        provenanceStrengthLabel: 'retrospective_heavy',
        evidenceQuality: 'retrospective_heavy',
        advisoryOnly: true,
      },
      advisoryOnly: true,
    },
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeComparison: {
        regimeLabel: 'wide_volatile',
        allEvidenceUsefulnessScore: 74,
        allEvidenceUsefulnessLabel: 'strong',
        liveOnlyUsefulnessScore: 58,
        liveOnlyUsefulnessLabel: 'moderate',
        scoreGap: 16,
        liveDirectSampleSize: 18,
        allEvidenceDirectSampleSize: 120,
        trustBiasLabel: 'retrospective_led',
        trustBiasReason: 'Divergence still high.',
      },
      allEvidenceByRegime: [
        makeAllRow('wide_volatile', { usefulnessScore: 74, usefulnessLabel: 'strong', live: 12, backfill: 108, provenanceStrengthLabel: 'retrospective_heavy' }),
        makeAllRow('ranging', { usefulnessScore: 72, usefulnessLabel: 'strong', live: 27, backfill: 4, provenanceStrengthLabel: 'mixed' }),
        makeAllRow('compressed', { usefulnessScore: 67, usefulnessLabel: 'moderate', live: 16, backfill: 6, provenanceStrengthLabel: 'mixed' }),
        makeAllRow('trending', { usefulnessScore: 76, usefulnessLabel: 'strong', live: 10, backfill: 90, provenanceStrengthLabel: 'retrospective_heavy' }),
        makeAllRow('mixed', { usefulnessScore: 68, usefulnessLabel: 'strong', live: 24, backfill: 12, provenanceStrengthLabel: 'mixed' }),
        makeAllRow('unknown', { usefulnessScore: null, usefulnessLabel: 'insufficient', live: 0, backfill: 0, provenanceStrengthLabel: 'absent' }),
      ],
      liveOnlyByRegime: [
        makeLiveSplitRow('wide_volatile', { usefulnessScore: 58, usefulnessLabel: 'moderate', confidenceAdjustment: -1, liveDirectSampleSize: 18 }),
        makeLiveSplitRow('ranging', { usefulnessScore: 73, usefulnessLabel: 'strong', confidenceAdjustment: 2, liveDirectSampleSize: 27 }),
        makeLiveSplitRow('compressed', { usefulnessScore: 58, usefulnessLabel: 'moderate', confidenceAdjustment: -2, liveDirectSampleSize: 16 }),
        makeLiveSplitRow('trending', { usefulnessScore: 47, usefulnessLabel: 'weak', confidenceAdjustment: -2, liveDirectSampleSize: 20 }),
        makeLiveSplitRow('mixed', { usefulnessScore: 66, usefulnessLabel: 'moderate', confidenceAdjustment: 1, liveDirectSampleSize: 24 }),
        makeLiveSplitRow('unknown', { usefulnessScore: null, usefulnessLabel: 'insufficient', confidenceAdjustment: 0, liveDirectSampleSize: 0 }),
      ],
      trustBiasLabel: 'retrospective_led',
      trustBiasReason: 'Current regime is retrospective-led.',
      advisoryOnly: true,
    },
    regimePerformanceFeedback: {
      regimeConfidenceGuidance: {
        regimeLabel: 'wide_volatile',
        evidenceQuality: 'retrospective_heavy',
        evidenceSourceBreakdown: { live: 12, backfill: 108, total: 120 },
        advisoryOnly: true,
      },
      advisoryOnly: true,
    },
    recommendationPerformance: {
      scorecards: [
        { date: '2026-03-01', sourceType: 'live', regimeLabel: 'wide_volatile' },
        { date: '2026-03-02', sourceType: 'live', regimeLabel: 'ranging' },
      ],
      summary: {
        sourceBreakdown: { live: 38, backfill: 182, total: 220 },
      },
    },
  };
}

function runUnitChecks() {
  const summary = buildRegimeConfirmationDurabilitySummary(buildFixture());
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(Array.isArray(summary.durabilityByRegime), 'durabilityByRegime missing');
  assert(ALLOWED_DURABILITY_STATES.includes(String(summary.currentRegimeDurabilityState || '')), 'currentRegimeDurabilityState invalid');
  assert(Number.isFinite(Number(summary.currentRegimeDurabilityScore)), 'currentRegimeDurabilityScore missing');
  assert(Number(summary.currentRegimeDurabilityScore) >= 0 && Number(summary.currentRegimeDurabilityScore) <= 100, 'currentRegimeDurabilityScore bounds');
  assert(Number.isFinite(Number(summary.currentRegimeDurabilityProgressPct)), 'currentRegimeDurabilityProgressPct missing');
  assert(Number(summary.currentRegimeDurabilityProgressPct) >= 0 && Number(summary.currentRegimeDurabilityProgressPct) <= 100, 'currentRegimeDurabilityProgressPct bounds');
  assert(typeof summary.currentRegimeHasLiveCapturedHistory === 'boolean', 'currentRegimeHasLiveCapturedHistory missing');
  assert(Number.isFinite(Number(summary.currentRegimeLiveCapturedTenureDays)), 'currentRegimeLiveCapturedTenureDays missing');

  const rows = new Map(summary.durabilityByRegime.map((row) => [String(row.regimeLabel), row]));
  for (const row of summary.durabilityByRegime) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), `non-canonical regime label: ${row?.regimeLabel}`);
    assert(ALLOWED_DURABILITY_STATES.includes(String(row?.durabilityState || '')), `invalid durabilityState: ${row?.durabilityState}`);
    assert(Number.isFinite(Number(row?.durabilityScore)), 'row durabilityScore missing');
    assert(Number(row.durabilityScore) >= 0 && Number(row.durabilityScore) <= 100, 'row durabilityScore bounds');
    assert(Number.isFinite(Number(row?.durabilityProgressPct)), 'row durabilityProgressPct missing');
    assert(Number(row.durabilityProgressPct) >= 0 && Number(row.durabilityProgressPct) <= 100, 'row durabilityProgressPct bounds');
    assert(Number.isFinite(Number(row?.persistenceWindowCount)), 'row persistenceWindowCount missing');
    assert(Number.isFinite(Number(row?.consecutiveQualifiedWindows)), 'row consecutiveQualifiedWindows missing');
    assert(Number.isFinite(Number(row?.consecutiveWeakWindows)), 'row consecutiveWeakWindows missing');
    assert(typeof row?.hasLiveCapturedHistory === 'boolean', 'row hasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(row?.liveCapturedTenureDays || 0)), 'row liveCapturedTenureDays missing');
    assert(row.advisoryOnly === true, 'row advisoryOnly must be true');
  }

  for (const row of summary.durabilityByRegime) {
    if (String(row.durabilityState) === 'durable_confirmed') {
      assert(String(row.latestPromotionState) === 'live_confirmed', 'durable_confirmed requires latestPromotionState=live_confirmed');
    }
  }

  const trending = rows.get('trending');
  assert(trending && String(trending.durabilityState) === 'decaying_confirmation', 'trending should be decaying under high gap + retro-heavy conditions');
  assert(String(trending.durabilityState) !== 'durable_confirmed', 'retrospective-heavy weak trust row cannot be durable_confirmed');

  const compressed = rows.get('compressed');
  assert(compressed && String(compressed.durabilityState) === 'fragile_confirmation', 'compressed should be fragile when promotion exists but trust is only cautious');

  const mixed = rows.get('mixed');
  assert(mixed && String(mixed.durabilityState) === 'recovering_confirmation', 'mixed should be recovering with rebuilding progress');

  const unknown = rows.get('unknown');
  assert(unknown && String(unknown.durabilityState) === 'unconfirmed', 'unknown should be unconfirmed with no live support');

  for (const label of summary.durableConfirmedRegimeLabels) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical durableConfirmed label: ${label}`);
  }
  for (const label of summary.fragileRegimeLabels) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical fragile label: ${label}`);
  }
  for (const label of summary.decayingRegimeLabels) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical decaying label: ${label}`);
  }
  for (const label of summary.recoveringRegimeLabels) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical recovering label: ${label}`);
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
    port: process.env.JARVIS_AUDIT_PORT || 3189,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/durability?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'regime/durability endpoint should return ok');
    const durability = out?.regimeConfirmationDurability;
    assert(durability && typeof durability === 'object', 'regimeConfirmationDurability missing');
    assert(durability.advisoryOnly === true, 'regimeConfirmationDurability must be advisoryOnly');
    assert(ALLOWED_DURABILITY_STATES.includes(String(durability.currentRegimeDurabilityState || '')), 'endpoint currentRegimeDurabilityState invalid');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimeConfirmationDurability && typeof center.regimeConfirmationDurability === 'object', 'top-level regimeConfirmationDurability missing');
    const cc = center?.commandCenter || {};
    assert(typeof cc.regimeDurabilityInsight === 'string' && cc.regimeDurabilityInsight.length > 0, 'commandCenter.regimeDurabilityInsight missing');
    assert(ALLOWED_DURABILITY_STATES.includes(String(cc.currentRegimeDurabilityState || '')), 'commandCenter.currentRegimeDurabilityState invalid');
    assert(typeof cc.currentRegimeDurabilityReason === 'string', 'commandCenter.currentRegimeDurabilityReason missing');
    assert(Number.isFinite(Number(cc.currentRegimeDurabilityScore)), 'commandCenter.currentRegimeDurabilityScore missing');
    assert(Number.isFinite(Number(cc.currentRegimeDurabilityProgressPct)), 'commandCenter.currentRegimeDurabilityProgressPct missing');
    assert(typeof cc.currentRegimeHasLiveCapturedHistory === 'boolean', 'commandCenter.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(cc.currentRegimeLiveCapturedTenureDays)), 'commandCenter.currentRegimeLiveCapturedTenureDays missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'commandCenter.decisionBoard missing');
    assert(ALLOWED_DURABILITY_STATES.includes(String(cc.decisionBoard.regimeDurabilityState || '')), 'decisionBoard.regimeDurabilityState invalid');
    assert(typeof cc.decisionBoard.regimeDurabilityReason === 'string', 'decisionBoard.regimeDurabilityReason missing');
    assert(typeof cc.decisionBoard.regimeHasLiveCapturedHistory === 'boolean', 'decisionBoard.regimeHasLiveCapturedHistory missing');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'commandCenter.todayRecommendation missing');
    assert(ALLOWED_DURABILITY_STATES.includes(String(cc.todayRecommendation.regimeDurabilityState || '')), 'todayRecommendation.regimeDurabilityState invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeDurabilityProgressPct)), 'todayRecommendation.regimeDurabilityProgressPct missing');
    assert(typeof cc.todayRecommendation.regimeHasLiveCapturedHistory === 'boolean', 'todayRecommendation.regimeHasLiveCapturedHistory missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime confirmation durability tests passed.');
  } catch (err) {
    console.error(`Jarvis regime confirmation durability test failed: ${err.message}`);
    process.exit(1);
  }
})();
