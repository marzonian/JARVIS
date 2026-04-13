#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePersistenceGraduationSummary,
} = require('../server/jarvis-core/regime-persistence-graduation');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;
const ALLOWED_MILESTONES = [
  'no_live_base',
  'live_base_established',
  'live_depth_building',
  'durability_building',
  'nearing_operational_readiness',
  'operationally_ready',
];
const ALLOWED_DIRECTIONS = [
  'improving',
  'flat',
  'regressing',
];
const ALLOWED_REQUIREMENTS = [
  'add_live_tenure',
  'increase_live_coverage',
  'reduce_reconstructed_share',
  'improve_durability',
  'improve_persistence_quality',
  'confirm_live_cadence',
  'establish_live_base',
];

function buildFixture(overrides = {}) {
  return {
    windowSessions: 120,
    performanceSource: 'all',
    regimePersistenceReadiness: {
      currentRegimeLabel: 'wide_volatile',
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 2,
      currentRegimeLiveCaptureCoveragePct: 25,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      readinessScore: 26.75,
      readinessLabel: 'early',
      graduationState: 'reconstructed_dominant',
      blockers: [
        'insufficient_live_tenure',
        'insufficient_live_coverage',
        'reconstructed_history_dominant',
        'durability_not_confirmed',
        'live_depth_too_thin',
      ],
      liveReadyRegimeLabels: [],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: [],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeLiveCadenceLabel: 'improving',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      currentRegimeDurabilityConstraint: 'mixed_constraints',
      currentRegimeCaptureGapDays: 2,
      liveCaptureCoveragePct: 25,
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'mixed_persisted_history',
      durabilityByRegime: [
        {
          regimeLabel: 'wide_volatile',
          durabilityState: 'unconfirmed',
          persistenceSource: 'mixed_persisted_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 2,
          provenanceBreakdown: {
            liveCapturedDays: 2,
            reconstructedDays: 6,
            mixedDays: 2,
          },
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationHistory: {
      currentRegimeLabel: 'wide_volatile',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 2,
      historyProvenanceBreakdown: {
        liveCapturedDays: 2,
        reconstructedDays: 6,
        mixedDays: 2,
      },
      byRegime: [
        {
          regimeLabel: 'wide_volatile',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 2,
          provenanceBreakdown: {
            liveCapturedDays: 2,
            reconstructedDays: 6,
            mixedDays: 2,
          },
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
    },
    ...overrides,
  };
}

function assertBoundedArrays(summary) {
  for (const label of (summary.graduatedRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid graduated regime label: ${label}`);
  }
  for (const label of (summary.progressingRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid progressing regime label: ${label}`);
  }
  for (const label of (summary.stalledGraduationRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid stalled regime label: ${label}`);
  }
}

function runUnitChecks() {
  const summary = buildRegimePersistenceGraduationSummary(buildFixture());
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(Number.isFinite(Number(summary.graduationProgressScore)), 'graduationProgressScore missing');
  assert(Number(summary.graduationProgressScore) >= 0 && Number(summary.graduationProgressScore) <= 100, 'graduationProgressScore out of bounds');
  assert(Number.isFinite(Number(summary.graduationProgressPct)), 'graduationProgressPct missing');
  assert(Number(summary.graduationProgressPct) >= 0 && Number(summary.graduationProgressPct) <= 100, 'graduationProgressPct out of bounds');
  assert(ALLOWED_MILESTONES.includes(String(summary.graduationMilestone || '')), 'graduationMilestone invalid');
  assert(ALLOWED_DIRECTIONS.includes(String(summary.progressDirection || '')), 'progressDirection invalid');
  for (const requirement of (summary.remainingRequirements || [])) {
    assert(ALLOWED_REQUIREMENTS.includes(String(requirement || '')), `invalid remaining requirement: ${requirement}`);
  }
  assert(typeof summary.readyForOperationalUse === 'boolean', 'readyForOperationalUse must be boolean');

  const noLive = buildRegimePersistenceGraduationSummary(buildFixture({
    regimePersistenceReadiness: {
      currentRegimeLabel: 'unknown',
      persistenceSource: 'persisted_reconstructed_history',
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      currentRegimeLiveCaptureCoveragePct: 0,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      readinessScore: 12,
      readinessLabel: 'not_ready',
      graduationState: 'reconstructed_dominant',
      liveReadyRegimeLabels: [],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: ['unknown'],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'unknown',
      currentRegimeLiveCadenceLabel: 'stale',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      currentRegimeDurabilityConstraint: 'capture_cadence_limited',
      currentRegimeCaptureGapDays: 12,
      liveCaptureCoveragePct: 0,
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
          provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 8, mixedDays: 0 },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationHistory: {
      currentRegimeLabel: 'unknown',
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      historyProvenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 8, mixedDays: 0 },
      byRegime: [
        {
          regimeLabel: 'unknown',
          hasLiveCapturedHistory: false,
          liveCapturedTenureDays: 0,
          provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 8, mixedDays: 0 },
        },
      ],
      advisoryOnly: true,
    },
  }));
  assert(noLive.readyForOperationalUse === false, 'no live history cannot be readyForOperationalUse');
  assert(String(noLive.graduationMilestone) === 'no_live_base' || String(noLive.graduationMilestone) === 'live_base_established', 'no live history must stay at earliest milestones');
  assert(String(noLive.graduationMilestone) !== 'operationally_ready', 'no live history must never be operationally_ready');

  const mixedButStrong = buildRegimePersistenceGraduationSummary(buildFixture({
    regimePersistenceReadiness: {
      currentRegimeLabel: 'trending',
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 10,
      currentRegimeLiveCaptureCoveragePct: 88,
      currentRegimeDurabilityState: 'durable_confirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessScore: 84,
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      liveReadyRegimeLabels: ['trending'],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: [],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'trending',
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
      currentRegimeCaptureGapDays: 0,
      liveCaptureCoveragePct: 88,
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'trending',
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'mixed_persisted_history',
      durabilityByRegime: [
        {
          regimeLabel: 'trending',
          durabilityState: 'durable_confirmed',
          persistenceSource: 'mixed_persisted_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 10,
          provenanceBreakdown: { liveCapturedDays: 6, reconstructedDays: 4, mixedDays: 2 },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationHistory: {
      currentRegimeLabel: 'trending',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 10,
      historyProvenanceBreakdown: { liveCapturedDays: 6, reconstructedDays: 4, mixedDays: 2 },
      byRegime: [
        {
          regimeLabel: 'trending',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 10,
          provenanceBreakdown: { liveCapturedDays: 6, reconstructedDays: 4, mixedDays: 2 },
        },
      ],
      advisoryOnly: true,
    },
  }));
  assert(mixedButStrong.readyForOperationalUse === false, 'mixed_persisted_history cannot be operationally ready');
  assert(String(mixedButStrong.graduationMilestone) !== 'operationally_ready', 'mixed persistence cannot be operationally_ready');

  const conservative = buildRegimePersistenceGraduationSummary(buildFixture());
  assert(String(conservative.readinessLabel) === 'early', 'fixture should stay early');
  assert(String(conservative.graduationState) === 'reconstructed_dominant', 'fixture should remain reconstructed_dominant');
  assert(String(conservative.graduationMilestone) !== 'operationally_ready', 'early reconstructed fixture must stay conservative');

  const ready = buildRegimePersistenceGraduationSummary(buildFixture({
    regimePersistenceReadiness: {
      currentRegimeLabel: 'compressed',
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 8,
      currentRegimeLiveCaptureCoveragePct: 78,
      currentRegimeDurabilityState: 'durable_confirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessScore: 82,
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      liveReadyRegimeLabels: ['compressed'],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: [],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'compressed',
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
      currentRegimeCaptureGapDays: 0,
      liveCaptureCoveragePct: 78,
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'compressed',
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'persisted_live_history',
      durabilityByRegime: [
        {
          regimeLabel: 'compressed',
          durabilityState: 'durable_confirmed',
          persistenceSource: 'persisted_live_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: { liveCapturedDays: 8, reconstructedDays: 0, mixedDays: 0 },
        },
      ],
      advisoryOnly: true,
    },
    regimeConfirmationHistory: {
      currentRegimeLabel: 'compressed',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 8,
      historyProvenanceBreakdown: { liveCapturedDays: 8, reconstructedDays: 0, mixedDays: 0 },
      byRegime: [
        {
          regimeLabel: 'compressed',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: { liveCapturedDays: 8, reconstructedDays: 0, mixedDays: 0 },
        },
      ],
      advisoryOnly: true,
    },
  }));
  assert(ready.readyForOperationalUse === true, 'persisted_live_history with enough depth/coverage should be operationally ready');
  assert(String(ready.graduationMilestone) === 'operationally_ready', 'ready fixture should be operationally_ready');

  const unconfirmedDurability = buildRegimePersistenceGraduationSummary(buildFixture({
    regimePersistenceReadiness: {
      currentRegimeLabel: 'compressed',
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 8,
      currentRegimeLiveCaptureCoveragePct: 80,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessScore: 82,
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      liveReadyRegimeLabels: ['compressed'],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: [],
      advisoryOnly: true,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'compressed',
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
      currentRegimeCaptureGapDays: 0,
      liveCaptureCoveragePct: 80,
      advisoryOnly: true,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'compressed',
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'persisted_live_history',
      durabilityByRegime: [
        {
          regimeLabel: 'compressed',
          durabilityState: 'unconfirmed',
          persistenceSource: 'persisted_live_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 8,
          provenanceBreakdown: { liveCapturedDays: 8, reconstructedDays: 0, mixedDays: 0 },
        },
      ],
      advisoryOnly: true,
    },
  }));
  assert(unconfirmedDurability.readyForOperationalUse === false, 'unconfirmed durability must block operational readiness');
  assert(String(unconfirmedDurability.graduationMilestone) !== 'operationally_ready', 'unconfirmed durability must prevent operational milestone');

  assertBoundedArrays(summary);
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
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-graduation?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'regime/persistence-graduation endpoint should return ok');
    const graduation = out?.regimePersistenceGraduation;
    assert(graduation && typeof graduation === 'object', 'regimePersistenceGraduation missing');
    assert(graduation.advisoryOnly === true, 'regimePersistenceGraduation must be advisoryOnly');
    assert(SUPPORTED_REGIME_LABELS.includes(String(graduation.currentRegimeLabel || '')), 'endpoint currentRegimeLabel must be canonical');
    assert(ALLOWED_MILESTONES.includes(String(graduation.graduationMilestone || '')), 'endpoint graduationMilestone invalid');
    assert(ALLOWED_DIRECTIONS.includes(String(graduation.progressDirection || '')), 'endpoint progressDirection invalid');
    for (const requirement of (graduation.remainingRequirements || [])) {
      assert(ALLOWED_REQUIREMENTS.includes(String(requirement || '')), `endpoint invalid remaining requirement: ${requirement}`);
    }
    assert(typeof graduation.readyForOperationalUse === 'boolean', 'endpoint readyForOperationalUse must be boolean');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimePersistenceGraduation && typeof center.regimePersistenceGraduation === 'object', 'top-level regimePersistenceGraduation missing');

    const cc = center?.commandCenter || {};
    assert(ALLOWED_MILESTONES.includes(String(cc.regimePersistenceGraduationMilestone || '')), 'commandCenter.regimePersistenceGraduationMilestone invalid');
    assert(Number.isFinite(Number(cc.regimePersistenceGraduationProgressScore)), 'commandCenter.regimePersistenceGraduationProgressScore missing');
    assert(Number.isFinite(Number(cc.regimePersistenceGraduationProgressPct)), 'commandCenter.regimePersistenceGraduationProgressPct missing');
    assert(ALLOWED_DIRECTIONS.includes(String(cc.regimePersistenceProgressDirection || '')), 'commandCenter.regimePersistenceProgressDirection invalid');
    assert(Array.isArray(cc.regimePersistenceRemainingRequirements), 'commandCenter.regimePersistenceRemainingRequirements missing');
    for (const requirement of cc.regimePersistenceRemainingRequirements) {
      assert(ALLOWED_REQUIREMENTS.includes(String(requirement || '')), `commandCenter invalid remaining requirement: ${requirement}`);
    }
    assert(typeof cc.regimePersistenceGraduationInsight === 'string' && cc.regimePersistenceGraduationInsight.length > 0, 'commandCenter.regimePersistenceGraduationInsight missing');
    assert(typeof cc.regimeReadyForOperationalUse === 'boolean', 'commandCenter.regimeReadyForOperationalUse missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_MILESTONES.includes(String(cc.decisionBoard.regimePersistenceGraduationMilestone || '')), 'decisionBoard.regimePersistenceGraduationMilestone invalid');
    assert(ALLOWED_DIRECTIONS.includes(String(cc.decisionBoard.regimePersistenceProgressDirection || '')), 'decisionBoard.regimePersistenceProgressDirection invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_MILESTONES.includes(String(cc.todayRecommendation.regimePersistenceGraduationMilestone || '')), 'todayRecommendation.regimePersistenceGraduationMilestone invalid');
    assert(ALLOWED_DIRECTIONS.includes(String(cc.todayRecommendation.regimePersistenceProgressDirection || '')), 'todayRecommendation.regimePersistenceProgressDirection invalid');
    assert(typeof cc.todayRecommendation.regimeReadyForOperationalUse === 'boolean', 'todayRecommendation.regimeReadyForOperationalUse missing');

    assertBoundedArrays(graduation);
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime persistence graduation tests passed.');
  } catch (err) {
    console.error(`Jarvis regime persistence graduation test failed: ${err.message}`);
    process.exit(1);
  }
})();
