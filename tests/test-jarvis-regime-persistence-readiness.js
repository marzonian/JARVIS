#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePersistenceReadinessSummary,
} = require('../server/jarvis-core/regime-persistence-readiness');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;
const ALLOWED_READINESS_LABELS = [
  'ready',
  'near_ready',
  'early',
  'not_ready',
];
const ALLOWED_GRADUATION_STATES = [
  'live_persistence_ready',
  'nearing_live_persistence',
  'accumulating_live_depth',
  'reconstructed_dominant',
];
const ALLOWED_BLOCKERS = [
  'insufficient_live_tenure',
  'insufficient_live_coverage',
  'reconstructed_history_dominant',
  'durability_not_confirmed',
  'cadence_too_sparse',
  'live_depth_too_thin',
  'mixed_constraints',
  'no_live_history',
];

function buildFixture(overrides = {}) {
  return {
    windowSessions: 120,
    performanceSource: 'all',
    regimeConfirmationHistory: {
      currentRegimeLabel: 'compressed',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 2,
      historyProvenanceBreakdown: {
        liveCapturedDays: 2,
        reconstructedDays: 6,
        mixedDays: 0,
      },
      byRegime: [
        {
          regimeLabel: 'compressed',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 2,
          provenanceBreakdown: {
            liveCapturedDays: 2,
            reconstructedDays: 6,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'compressed',
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'mixed_persisted_history',
      durabilityByRegime: [
        {
          regimeLabel: 'compressed',
          durabilityState: 'unconfirmed',
          persistenceSource: 'mixed_persisted_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 2,
          provenanceBreakdown: {
            liveCapturedDays: 2,
            reconstructedDays: 6,
            mixedDays: 0,
          },
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'compressed',
      currentRegimeLiveCadenceLabel: 'improving',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      currentRegimeDurabilityConstraint: 'mixed_constraints',
      liveCaptureCoveragePct: 25,
      advisoryOnly: true,
    },
    liveRegimeConfirmation: {
      currentRegimeLabel: 'compressed',
      advisoryOnly: true,
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'compressed',
      advisoryOnly: true,
    },
    ...overrides,
  };
}

function runUnitChecks() {
  const summary = buildRegimePersistenceReadinessSummary(buildFixture());
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(Number.isFinite(Number(summary.readinessScore)), 'readinessScore missing');
  assert(Number(summary.readinessScore) >= 0 && Number(summary.readinessScore) <= 100, 'readinessScore out of bounds');
  assert(ALLOWED_READINESS_LABELS.includes(String(summary.readinessLabel || '')), 'readinessLabel invalid');
  assert(ALLOWED_GRADUATION_STATES.includes(String(summary.graduationState || '')), 'graduationState invalid');
  for (const blocker of (summary.blockers || [])) {
    assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `invalid blocker: ${blocker}`);
  }
  assert(String(summary.readinessLabel) !== 'ready', 'thin mixed fixture should not be ready');
  assert(String(summary.graduationState) === 'reconstructed_dominant', 'reconstructed-dominant fixture should be reconstructed_dominant');

  const noLive = buildRegimePersistenceReadinessSummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'unknown',
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      historyProvenanceBreakdown: {
        liveCapturedDays: 0,
        reconstructedDays: 8,
        mixedDays: 0,
      },
      byRegime: [
        {
          regimeLabel: 'unknown',
          hasLiveCapturedHistory: false,
          liveCapturedTenureDays: 0,
          provenanceBreakdown: {
            liveCapturedDays: 0,
            reconstructedDays: 8,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'unknown',
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'persisted_reconstructed_history',
      durabilityByRegime: [
        {
          regimeLabel: 'unknown',
          durabilityState: 'unconfirmed',
          persistenceSource: 'persisted_reconstructed_history',
          hasLiveCapturedHistory: false,
          liveCapturedTenureDays: 0,
          provenanceBreakdown: {
            liveCapturedDays: 0,
            reconstructedDays: 8,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'unknown',
      currentRegimeLiveCadenceLabel: 'stale',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      currentRegimeDurabilityConstraint: 'mixed_constraints',
      liveCaptureCoveragePct: 0,
      advisoryOnly: true,
    },
    liveRegimeConfirmation: { currentRegimeLabel: 'unknown' },
    regimeTrustConsumption: { currentRegimeLabel: 'unknown' },
  }));
  assert(String(noLive.readinessLabel) !== 'ready' && String(noLive.readinessLabel) !== 'near_ready', 'no live history cannot be ready/near_ready');
  assert((noLive.blockers || []).includes('no_live_history'), 'no live history blocker missing');

  const mixedHigh = buildRegimePersistenceReadinessSummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'ranging',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 8,
      historyProvenanceBreakdown: {
        liveCapturedDays: 12,
        reconstructedDays: 6,
        mixedDays: 2,
      },
      byRegime: [
        {
          regimeLabel: 'ranging',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: {
            liveCapturedDays: 12,
            reconstructedDays: 6,
            mixedDays: 2,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'ranging',
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'mixed_persisted_history',
      durabilityByRegime: [
        {
          regimeLabel: 'ranging',
          durabilityState: 'durable_confirmed',
          persistenceSource: 'mixed_persisted_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: {
            liveCapturedDays: 12,
            reconstructedDays: 6,
            mixedDays: 2,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'ranging',
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'partially_live_supported',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
      liveCaptureCoveragePct: 70,
      advisoryOnly: true,
    },
    liveRegimeConfirmation: { currentRegimeLabel: 'ranging' },
    regimeTrustConsumption: { currentRegimeLabel: 'ranging' },
  }));
  assert(String(mixedHigh.graduationState) !== 'live_persistence_ready', 'mixed_persisted_history cannot be live_persistence_ready');

  const ready = buildRegimePersistenceReadinessSummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'trending',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 8,
      historyProvenanceBreakdown: {
        liveCapturedDays: 15,
        reconstructedDays: 0,
        mixedDays: 0,
      },
      byRegime: [
        {
          regimeLabel: 'trending',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: {
            liveCapturedDays: 15,
            reconstructedDays: 0,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'trending',
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'persisted_live_history',
      durabilityByRegime: [
        {
          regimeLabel: 'trending',
          durabilityState: 'durable_confirmed',
          persistenceSource: 'persisted_live_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: {
            liveCapturedDays: 15,
            reconstructedDays: 0,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'trending',
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
      liveCaptureCoveragePct: 90,
      advisoryOnly: true,
    },
    liveRegimeConfirmation: { currentRegimeLabel: 'trending' },
    regimeTrustConsumption: { currentRegimeLabel: 'trending' },
  }));
  assert(String(ready.readinessLabel) === 'ready', 'persisted_live_history with strong tenure/coverage should become ready');
  assert(String(ready.graduationState) === 'live_persistence_ready', 'ready case should graduate to live_persistence_ready');

  const insufficientDepth = buildRegimePersistenceReadinessSummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 2,
      historyProvenanceBreakdown: {
        liveCapturedDays: 4,
        reconstructedDays: 1,
        mixedDays: 0,
      },
      byRegime: [
        {
          regimeLabel: 'wide_volatile',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 2,
          provenanceBreakdown: {
            liveCapturedDays: 4,
            reconstructedDays: 1,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeDurabilityState: 'building_durability',
      persistenceSource: 'persisted_live_history',
      durabilityByRegime: [
        {
          regimeLabel: 'wide_volatile',
          durabilityState: 'building_durability',
          persistenceSource: 'persisted_live_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 2,
          provenanceBreakdown: {
            liveCapturedDays: 4,
            reconstructedDays: 1,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeLiveCadenceLabel: 'improving',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      currentRegimeDurabilityConstraint: 'live_depth_limited',
      liveCaptureCoveragePct: 80,
      advisoryOnly: true,
    },
    liveRegimeConfirmation: { currentRegimeLabel: 'wide_volatile' },
    regimeTrustConsumption: { currentRegimeLabel: 'wide_volatile' },
  }));
  assert(String(insufficientDepth.readinessLabel) !== 'ready', 'insufficient_live_depth should prevent ready');

  const unconfirmedDurability = buildRegimePersistenceReadinessSummary(buildFixture({
    regimeConfirmationHistory: {
      currentRegimeLabel: 'ranging',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 7,
      historyProvenanceBreakdown: {
        liveCapturedDays: 12,
        reconstructedDays: 0,
        mixedDays: 0,
      },
      byRegime: [
        {
          regimeLabel: 'ranging',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 7,
          provenanceBreakdown: {
            liveCapturedDays: 12,
            reconstructedDays: 0,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'ranging',
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'persisted_live_history',
      durabilityByRegime: [
        {
          regimeLabel: 'ranging',
          durabilityState: 'unconfirmed',
          persistenceSource: 'persisted_live_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 7,
          provenanceBreakdown: {
            liveCapturedDays: 12,
            reconstructedDays: 0,
            mixedDays: 0,
          },
        },
      ],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'ranging',
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
      liveCaptureCoveragePct: 80,
      advisoryOnly: true,
    },
    liveRegimeConfirmation: { currentRegimeLabel: 'ranging' },
    regimeTrustConsumption: { currentRegimeLabel: 'ranging' },
  }));
  assert(String(unconfirmedDurability.readinessLabel) !== 'ready', 'unconfirmed durability should prevent ready');

  for (const label of ready.liveReadyRegimeLabels || []) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical liveReady label: ${label}`);
  }
  for (const label of ready.nearReadyRegimeLabels || []) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical nearReady label: ${label}`);
  }
  for (const label of ready.notReadyRegimeLabels || []) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `non-canonical notReady label: ${label}`);
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
    port: process.env.JARVIS_AUDIT_PORT || 3196,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-readiness?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'regime/persistence-readiness endpoint should return ok');
    const readiness = out?.regimePersistenceReadiness;
    assert(readiness && typeof readiness === 'object', 'regimePersistenceReadiness missing');
    assert(readiness.advisoryOnly === true, 'regimePersistenceReadiness must be advisoryOnly');
    assert(ALLOWED_READINESS_LABELS.includes(String(readiness.readinessLabel || '')), 'endpoint readinessLabel invalid');
    assert(ALLOWED_GRADUATION_STATES.includes(String(readiness.graduationState || '')), 'endpoint graduationState invalid');
    assert(Number.isFinite(Number(readiness.readinessScore)), 'endpoint readinessScore missing');
    assert(Number(readiness.readinessScore) >= 0 && Number(readiness.readinessScore) <= 100, 'endpoint readinessScore out of bounds');
    for (const blocker of (readiness.blockers || [])) {
      assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `endpoint blocker invalid: ${blocker}`);
    }
    for (const label of (readiness.liveReadyRegimeLabels || [])) {
      assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `endpoint non-canonical liveReady label: ${label}`);
    }
    for (const label of (readiness.nearReadyRegimeLabels || [])) {
      assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `endpoint non-canonical nearReady label: ${label}`);
    }
    for (const label of (readiness.notReadyRegimeLabels || [])) {
      assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `endpoint non-canonical notReady label: ${label}`);
    }

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimePersistenceReadiness && typeof center.regimePersistenceReadiness === 'object', 'top-level regimePersistenceReadiness missing');
    const cc = center?.commandCenter || {};
    assert(Number.isFinite(Number(cc.regimePersistenceReadinessScore)), 'commandCenter.regimePersistenceReadinessScore missing');
    assert(ALLOWED_READINESS_LABELS.includes(String(cc.regimePersistenceReadinessLabel || '')), 'commandCenter.regimePersistenceReadinessLabel invalid');
    assert(ALLOWED_GRADUATION_STATES.includes(String(cc.regimePersistenceGraduationState || '')), 'commandCenter.regimePersistenceGraduationState invalid');
    assert(Array.isArray(cc.regimePersistenceBlockers), 'commandCenter.regimePersistenceBlockers missing');
    for (const blocker of (cc.regimePersistenceBlockers || [])) {
      assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `commandCenter blocker invalid: ${blocker}`);
    }
    assert(typeof cc.regimePersistenceReadinessInsight === 'string' && cc.regimePersistenceReadinessInsight.length > 0, 'commandCenter.regimePersistenceReadinessInsight missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_READINESS_LABELS.includes(String(cc.decisionBoard.regimePersistenceReadinessLabel || '')), 'decisionBoard.regimePersistenceReadinessLabel invalid');
    assert(ALLOWED_GRADUATION_STATES.includes(String(cc.decisionBoard.regimePersistenceGraduationState || '')), 'decisionBoard.regimePersistenceGraduationState invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_READINESS_LABELS.includes(String(cc.todayRecommendation.regimePersistenceReadinessLabel || '')), 'todayRecommendation.regimePersistenceReadinessLabel invalid');
    assert(ALLOWED_GRADUATION_STATES.includes(String(cc.todayRecommendation.regimePersistenceGraduationState || '')), 'todayRecommendation.regimePersistenceGraduationState invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimePersistenceReadinessScore)), 'todayRecommendation.regimePersistenceReadinessScore missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime persistence readiness tests passed.');
  } catch (err) {
    console.error(`Jarvis regime persistence readiness test failed: ${err.message}`);
    process.exit(1);
  }
})();
