#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimeLivePersistenceQualitySummary,
} = require('../server/jarvis-core/regime-live-persistence-quality');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;
const ALLOWED_CADENCE_LABELS = [
  'healthy',
  'improving',
  'sparse',
  'stale',
];
const ALLOWED_PERSISTENCE_QUALITY_LABELS = [
  'live_ready',
  'partially_live_supported',
  'mostly_reconstructed',
  'insufficient_live_depth',
];
const ALLOWED_DURABILITY_CONSTRAINTS = [
  'capture_cadence_limited',
  'live_depth_limited',
  'regime_quality_limited',
  'mixed_constraints',
];

function buildFixture(overrides = {}) {
  return {
    windowSessions: 120,
    performanceSource: 'all',
    nowEt: { date: '2026-03-09', time: '14:50' },
    regimeConfirmationHistory: {
      currentRegimeLabel: 'wide_volatile',
      historyCoverageDays: 20,
      currentRegimeTenureDays: 12,
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 4,
      currentRegimeLastLiveCapturedDate: '2026-03-07',
      historyProvenanceBreakdown: {
        liveCapturedDays: 3,
        reconstructedDays: 14,
        mixedDays: 3,
      },
      byRegime: [
        {
          regimeLabel: 'wide_volatile',
          lastSeenAt: '2026-03-09',
          currentStateTenureDays: 12,
          liveCapturedTenureDays: 4,
          hasLiveCapturedHistory: true,
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimeDurabilityScore: 42,
      persistenceSource: 'mixed_persisted_history',
      advisoryOnly: true,
    },
    liveRegimeConfirmation: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimePromotionState: 'near_live_confirmation',
      advisoryOnly: true,
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'wide_volatile',
      trustConsumptionLabel: 'reduce_regime_weight',
      advisoryOnly: true,
    },
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 24, backfill: 91, total: 115 },
    },
    ...overrides,
  };
}

function runUnitChecks() {
  const summary = buildRegimeLivePersistenceQualitySummary(buildFixture());
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(ALLOWED_CADENCE_LABELS.includes(String(summary.currentRegimeLiveCadenceLabel || '')), 'cadence label invalid');
  assert(ALLOWED_PERSISTENCE_QUALITY_LABELS.includes(String(summary.currentRegimePersistenceQualityLabel || '')), 'persistence quality label invalid');
  assert(ALLOWED_DURABILITY_CONSTRAINTS.includes(String(summary.currentRegimeDurabilityConstraint || '')), 'durability constraint label invalid');
  assert(Number.isFinite(Number(summary.liveCaptureCoveragePct)), 'liveCaptureCoveragePct missing');
  assert(Number(summary.liveCaptureCoveragePct) >= 0 && Number(summary.liveCaptureCoveragePct) <= 100, 'liveCaptureCoveragePct out of bounds');
  assert(Number.isFinite(Number(summary.currentRegimeLiveTenureSharePct)), 'currentRegimeLiveTenureSharePct missing');
  assert(Number(summary.currentRegimeLiveTenureSharePct) >= 0 && Number(summary.currentRegimeLiveTenureSharePct) <= 100, 'currentRegimeLiveTenureSharePct out of bounds');
  assert(Number.isFinite(Number(summary.missingExpectedLiveDays)), 'missingExpectedLiveDays should be numeric');
  assert(String(summary.currentRegimePersistenceQualityLabel) === 'mostly_reconstructed', 'fixture should classify as mostly_reconstructed');

  const noLiveSummary = buildRegimeLivePersistenceQualitySummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'unknown',
      historyCoverageDays: 6,
      currentRegimeTenureDays: 6,
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      currentRegimeLastLiveCapturedDate: null,
      historyProvenanceBreakdown: {
        liveCapturedDays: 0,
        reconstructedDays: 6,
        mixedDays: 0,
      },
      byRegime: [
        {
          regimeLabel: 'unknown',
          lastSeenAt: '2026-03-09',
          currentStateTenureDays: 6,
          liveCapturedTenureDays: 0,
          hasLiveCapturedHistory: false,
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'unknown',
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimeDurabilityScore: 22,
      persistenceSource: 'persisted_reconstructed_history',
      advisoryOnly: true,
    },
    liveRegimeConfirmation: {
      currentRegimeLabel: 'unknown',
      currentRegimePromotionState: 'no_live_support',
      advisoryOnly: true,
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'unknown',
      trustConsumptionLabel: 'suppress_regime_bias',
      advisoryOnly: true,
    },
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 0, backfill: 30, total: 30 },
    },
    nowEt: { date: '2026-03-09', time: '14:50' },
  }));
  assert(String(noLiveSummary.currentRegimeLiveCadenceLabel) === 'stale', 'no live history should be stale cadence');
  assert(String(noLiveSummary.currentRegimePersistenceQualityLabel) === 'insufficient_live_depth', 'no live history should be insufficient_live_depth');

  const liveReady = buildRegimeLivePersistenceQualitySummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'ranging',
      historyCoverageDays: 12,
      currentRegimeTenureDays: 8,
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 6,
      currentRegimeLastLiveCapturedDate: '2026-03-09',
      historyProvenanceBreakdown: {
        liveCapturedDays: 9,
        reconstructedDays: 1,
        mixedDays: 2,
      },
      byRegime: [
        {
          regimeLabel: 'ranging',
          lastSeenAt: '2026-03-09',
          currentStateTenureDays: 8,
          liveCapturedTenureDays: 6,
          hasLiveCapturedHistory: true,
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'ranging',
      currentRegimeDurabilityState: 'building_durability',
      currentRegimeDurabilityScore: 68,
      persistenceSource: 'persisted_live_history',
      advisoryOnly: true,
    },
    liveRegimeConfirmation: {
      currentRegimeLabel: 'ranging',
      currentRegimePromotionState: 'live_confirmed',
      advisoryOnly: true,
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'ranging',
      trustConsumptionLabel: 'allow_with_caution',
      advisoryOnly: true,
    },
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 55, backfill: 12, total: 67 },
    },
    nowEt: { date: '2026-03-09', time: '14:50' },
  }));
  assert(String(liveReady.currentRegimePersistenceQualityLabel) === 'live_ready', 'persisted_live_history with enough tenure should classify as live_ready');
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
    port: process.env.JARVIS_AUDIT_PORT || 3195,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-quality?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'regime/persistence-quality endpoint should return ok');
    const quality = out?.regimeLivePersistenceQuality;
    assert(quality && typeof quality === 'object', 'regimeLivePersistenceQuality missing');
    assert(quality.advisoryOnly === true, 'regimeLivePersistenceQuality must be advisoryOnly');
    assert(SUPPORTED_REGIME_LABELS.includes(String(quality.currentRegimeLabel || '')), 'endpoint currentRegimeLabel must be canonical');
    assert(ALLOWED_CADENCE_LABELS.includes(String(quality.currentRegimeLiveCadenceLabel || '')), 'endpoint cadence label invalid');
    assert(ALLOWED_PERSISTENCE_QUALITY_LABELS.includes(String(quality.currentRegimePersistenceQualityLabel || '')), 'endpoint persistence quality label invalid');
    assert(ALLOWED_DURABILITY_CONSTRAINTS.includes(String(quality.currentRegimeDurabilityConstraint || '')), 'endpoint durability constraint invalid');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimeLivePersistenceQuality && typeof center.regimeLivePersistenceQuality === 'object', 'top-level regimeLivePersistenceQuality missing');
    const cc = center?.commandCenter || {};
    assert(Number.isFinite(Number(cc.regimeLiveCaptureCoveragePct)), 'commandCenter.regimeLiveCaptureCoveragePct missing');
    assert(ALLOWED_CADENCE_LABELS.includes(String(cc.currentRegimeLiveCadenceLabel || '')), 'commandCenter.currentRegimeLiveCadenceLabel invalid');
    assert(ALLOWED_PERSISTENCE_QUALITY_LABELS.includes(String(cc.currentRegimePersistenceQualityLabel || '')), 'commandCenter.currentRegimePersistenceQualityLabel invalid');
    assert(ALLOWED_DURABILITY_CONSTRAINTS.includes(String(cc.currentRegimeDurabilityConstraint || '')), 'commandCenter.currentRegimeDurabilityConstraint invalid');
    assert(typeof cc.persistenceQualityInsight === 'string' && cc.persistenceQualityInsight.length > 0, 'commandCenter.persistenceQualityInsight missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_CADENCE_LABELS.includes(String(cc.decisionBoard.regimeLiveCadenceLabel || '')), 'decisionBoard.regimeLiveCadenceLabel invalid');
    assert(ALLOWED_PERSISTENCE_QUALITY_LABELS.includes(String(cc.decisionBoard.regimePersistenceQualityLabel || '')), 'decisionBoard.regimePersistenceQualityLabel invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_CADENCE_LABELS.includes(String(cc.todayRecommendation.regimeLiveCadenceLabel || '')), 'todayRecommendation.regimeLiveCadenceLabel invalid');
    assert(ALLOWED_PERSISTENCE_QUALITY_LABELS.includes(String(cc.todayRecommendation.regimePersistenceQualityLabel || '')), 'todayRecommendation.regimePersistenceQualityLabel invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeLiveCaptureCoveragePct)), 'todayRecommendation.regimeLiveCaptureCoveragePct missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime live persistence quality tests passed.');
  } catch (err) {
    console.error(`Jarvis regime live persistence quality test failed: ${err.message}`);
    process.exit(1);
  }
})();
