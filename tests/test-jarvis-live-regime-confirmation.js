#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildLiveRegimeConfirmationSummary,
} = require('../server/jarvis-core/live-regime-confirmation');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 240000;
const ALLOWED_STATES = [
  'no_live_support',
  'emerging_live_support',
  'near_live_confirmation',
  'live_confirmed',
  'stalled_live_support',
];

function makeAllRow(regimeLabel, score, label, live, backfill, prov = 'mixed') {
  return {
    regimeLabel,
    usefulnessScore: score,
    usefulnessLabel: label,
    confidenceAdjustment: 0,
    directProvenanceSampleSize: live + backfill,
    upstreamCoverageSampleSize: live + backfill,
    coverageType: live + backfill > 0 ? 'mixed_support' : 'no_support',
    provenanceStrengthLabel: prov,
    evidenceSourceBreakdown: { live, backfill, total: live + backfill },
    warnings: [],
    advisoryOnly: true,
  };
}

function makeLiveRow(regimeLabel, score, label, sample, confAdj = 0, prov = 'direct') {
  return {
    regimeLabel,
    usefulnessScore: score,
    usefulnessLabel: label,
    confidenceAdjustment: confAdj,
    liveDirectSampleSize: sample,
    coverageType: sample > 0 ? 'direct_provenance' : 'no_support',
    provenanceStrengthLabel: sample > 0 ? prov : 'absent',
    evidenceSourceBreakdown: { live: sample, backfill: 0, total: sample },
    warnings: [],
    advisoryOnly: true,
  };
}

function buildFixture() {
  const liveCards = [];
  const addCards = (regimeLabel, count, startDay = 1) => {
    for (let i = 0; i < count; i += 1) {
      const day = String(((startDay + i) % 27) + 1).padStart(2, '0');
      liveCards.push({
        date: `2026-03-${day}`,
        sourceType: 'live',
        regimeLabel,
      });
    }
  };
  addCards('wide_volatile', 12, 1);
  addCards('compressed', 18, 3);
  addCards('mixed', 22, 5);
  addCards('ranging', 14, 7);

  return {
    windowSessions: 120,
    regimeDetection: { regimeLabel: 'wide_volatile' },
    regimeByDate: {
      '2026-03-01': {
        regime_trend: 'up',
        regime_vol: 'high',
        regime_orb_size: 'wide',
      },
      '2026-03-02': {
        regime_trend: 'up',
        regime_vol: 'high',
        regime_orb_size: 'wide',
      },
      '2026-03-03': {
        regime_trend: 'flat',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
      },
      '2026-03-04': {
        regime_trend: 'flat',
        regime_vol: 'low',
        regime_orb_size: 'narrow',
      },
      '2026-03-05': {
        regime_trend: 'down',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
      },
      '2026-03-06': {
        regime_trend: 'up',
        regime_vol: 'low',
        regime_orb_size: 'narrow',
      },
    },
    regimePerformanceFeedback: {
      advisoryOnly: true,
    },
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeComparison: {
        regimeLabel: 'wide_volatile',
        allEvidenceUsefulnessScore: 66,
        allEvidenceUsefulnessLabel: 'moderate',
        liveOnlyUsefulnessScore: 44,
        liveOnlyUsefulnessLabel: 'weak',
        scoreGap: 22,
        liveDirectSampleSize: 12,
        allEvidenceDirectSampleSize: 120,
        trustBiasLabel: 'retrospective_led',
      },
      allEvidenceByRegime: [
        makeAllRow('wide_volatile', 66, 'moderate', 8, 112, 'retrospective_heavy'),
        makeAllRow('compressed', 63, 'moderate', 18, 2, 'mixed'),
        makeAllRow('mixed', 71, 'strong', 22, 4, 'mixed'),
        makeAllRow('trending', 59, 'moderate', 0, 0, 'absent'),
        makeAllRow('ranging', 58, 'moderate', 14, 6, 'mixed'),
        makeAllRow('unknown', 74, 'strong', 0, 12, 'retrospective_heavy'),
      ],
      liveOnlyByRegime: [
        makeLiveRow('wide_volatile', 44, 'weak', 12, -1, 'direct'),
        makeLiveRow('compressed', 62, 'moderate', 18, 1, 'direct'),
        makeLiveRow('mixed', 75, 'strong', 22, 2, 'direct'),
        makeLiveRow('trending', null, 'insufficient', 0, 0, 'absent'),
        makeLiveRow('ranging', 53, 'weak', 14, -1, 'direct'),
        makeLiveRow('unknown', null, 'insufficient', 0, 0, 'absent'),
      ],
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'insufficient_live_confirmation',
      trustConsumptionLabel: 'suppress_regime_bias',
      trustConsumptionReason: 'Live sample remains too thin for current regime trust.',
      confidenceAdjustmentOverride: -9,
    },
    recommendationPerformance: {
      scorecards: [
        ...liveCards,
        { date: '2026-03-28', sourceType: 'backfill' },
        { date: '2026-03-29', sourceType: 'backfill' },
      ],
      summary: {
        sourceBreakdown: { live: liveCards.length, backfill: 2, total: liveCards.length + 2 },
      },
    },
  };
}

function runUnitChecks() {
  const summary = buildLiveRegimeConfirmationSummary(buildFixture());
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(ALLOWED_STATES.includes(String(summary.currentRegimePromotionState || '')), 'currentRegimePromotionState invalid');
  assert(Number.isFinite(Number(summary.currentRegimeConfirmationProgressPct)), 'currentRegimeConfirmationProgressPct missing');
  assert(Number(summary.currentRegimeConfirmationProgressPct) >= 0 && Number(summary.currentRegimeConfirmationProgressPct) <= 100, 'progress out of bounds');
  assert(Array.isArray(summary.liveConfirmationByRegime), 'liveConfirmationByRegime missing');
  assert(Array.isArray(summary.liveConfirmedRegimeLabels), 'liveConfirmedRegimeLabels missing');
  assert(Array.isArray(summary.emergingLiveSupportRegimeLabels), 'emergingLiveSupportRegimeLabels missing');
  assert(Array.isArray(summary.stalledRegimeLabels), 'stalledRegimeLabels missing');

  for (const row of summary.liveConfirmationByRegime) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), `unsupported regime label in row: ${row?.regimeLabel}`);
    assert(ALLOWED_STATES.includes(String(row?.promotionState || '')), `unsupported promotion state in row: ${row?.promotionState}`);
    assert(Number.isFinite(Number(row?.liveSampleSize)), 'row liveSampleSize missing');
    assert(Number.isFinite(Number(row?.requiredSampleForPromotion)), 'row requiredSampleForPromotion missing');
    assert(Number.isFinite(Number(row?.progressPct)), 'row progressPct missing');
    assert(Number(row.progressPct) >= 0 && Number(row.progressPct) <= 100, 'row progressPct out of bounds');
    assert(['fresh', 'recent_but_thin', 'stale_or_sparse'].includes(String(row?.evidenceFreshnessLabel || '')), 'invalid evidenceFreshnessLabel');
    assert(row.advisoryOnly === true, 'row advisoryOnly must be true');
  }

  const byRegime = new Map(summary.liveConfirmationByRegime.map((row) => [String(row.regimeLabel), row]));

  const trending = byRegime.get('trending');
  assert(trending && Number(trending.liveSampleSize) === 0, 'trending row should have no live sample in fixture');
  assert(String(trending.promotionState) === 'no_live_support', 'liveSampleSize=0 must map to no_live_support');

  const compressed = byRegime.get('compressed');
  assert(compressed && Number(compressed.liveSampleSize) === 18, 'compressed sample mismatch');
  assert(String(compressed.promotionState) === 'live_confirmed', 'compressed should be live_confirmed in fixture');

  const mixed = byRegime.get('mixed');
  assert(mixed && Number(mixed.liveSampleSize) === 22, 'mixed sample mismatch');
  assert(String(mixed.promotionState) !== 'live_confirmed', 'mixed cannot be live_confirmed below stronger threshold');

  const wide = byRegime.get('wide_volatile');
  assert(wide && Number(wide.liveSampleSize) >= 10, 'wide_volatile should have accumulating sample');
  assert(String(wide.promotionState) === 'stalled_live_support', 'wide_volatile should be stalled under weak trust + weak live usefulness');

  for (const label of summary.liveConfirmedRegimeLabels) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `unsupported liveConfirmed label: ${label}`);
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
    port: process.env.JARVIS_AUDIT_PORT || 3188,
  });
  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/live-confirmation?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'regime/live-confirmation should return ok');
    const liveConf = out?.liveRegimeConfirmation;
    assert(liveConf && typeof liveConf === 'object', 'liveRegimeConfirmation missing');
    assert(liveConf.advisoryOnly === true, 'liveRegimeConfirmation must be advisoryOnly');
    assert(ALLOWED_STATES.includes(String(liveConf.currentRegimePromotionState || '')), 'endpoint currentRegimePromotionState invalid');
    assert(Number.isFinite(Number(liveConf.currentRegimeConfirmationProgressPct)), 'endpoint currentRegimeConfirmationProgressPct missing');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center should return ok');
    assert(center?.liveRegimeConfirmation && typeof center.liveRegimeConfirmation === 'object', 'top-level liveRegimeConfirmation missing');
    const cc = center?.commandCenter || {};
    assert(typeof cc.liveRegimeConfirmationInsight === 'string' && cc.liveRegimeConfirmationInsight.length > 0, 'commandCenter.liveRegimeConfirmationInsight missing');
    assert(ALLOWED_STATES.includes(String(cc.currentRegimePromotionState || '')), 'commandCenter.currentRegimePromotionState invalid');
    assert(typeof cc.currentRegimePromotionReason === 'string', 'commandCenter.currentRegimePromotionReason missing');
    assert(Number.isFinite(Number(cc.currentRegimeConfirmationProgressPct)), 'commandCenter.currentRegimeConfirmationProgressPct missing');
    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_STATES.includes(String(cc.decisionBoard.liveRegimePromotionState || '')), 'decisionBoard.liveRegimePromotionState invalid');
    assert(typeof cc.decisionBoard.liveRegimePromotionReason === 'string', 'decisionBoard.liveRegimePromotionReason missing');
    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_STATES.includes(String(cc.todayRecommendation.liveRegimePromotionState || '')), 'todayRecommendation.liveRegimePromotionState invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.liveRegimeConfirmationProgressPct)), 'todayRecommendation.liveRegimeConfirmationProgressPct missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis live regime confirmation tests passed.');
  } catch (err) {
    console.error(`Jarvis live regime confirmation test failed: ${err.message}`);
    process.exit(1);
  }
})();
