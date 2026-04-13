#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePersistenceOperationalCredibilitySummary,
} = require('../server/jarvis-core/regime-persistence-operational-credibility');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 420000;
const ALLOWED_CREDIBILITY_LABELS = [
  'not_credible',
  'limited',
  'credible',
];
const ALLOWED_GATES = [
  'blocked',
  'cautious_use',
  'operationally_credible',
];
const ALLOWED_PERMISSION_LEVELS = [
  'suppress_persistence_confidence',
  'allow_persistence_with_caution',
  'allow_persistence_confidence',
];
const ALLOWED_BLOCKERS = [
  'no_live_base',
  'insufficient_live_tenure',
  'insufficient_live_coverage',
  'reconstructed_history_dominant',
  'mixed_persistence_history',
  'durability_not_confirmed',
  'persistence_quality_not_live_ready',
  'graduation_not_ready',
  'delta_not_progressing',
  'live_capture_depth_too_thin',
  'cadence_not_reliable',
];
const ALLOWED_SIGNALS = [
  'live_base_present',
  'live_tenure_building',
  'live_coverage_improving',
  'durability_building',
  'durability_confirmed',
  'quality_improving',
  'graduation_progressing',
  'blockers_reducing',
  'cadence_healthy',
  'cadence_improving',
];

function buildFixture(overrides = {}) {
  const windowSessions = Number.isFinite(Number(overrides.windowSessions)) ? Number(overrides.windowSessions) : 120;
  const performanceSource = String(overrides.performanceSource || 'all').trim().toLowerCase() || 'all';
  const currentRegimeLabel = String(overrides.currentRegimeLabel || 'trending').trim().toLowerCase();
  return {
    windowSessions,
    performanceSource,
    regimePersistenceReadiness: {
      currentRegimeLabel,
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 4,
      currentRegimeLiveCaptureCoveragePct: 42,
      currentRegimeDurabilityState: 'building_durability',
      currentRegimePersistenceQualityLabel: 'partially_live_supported',
      readinessScore: 56,
      readinessLabel: 'near_ready',
      graduationState: 'nearing_live_persistence',
      blockers: ['insufficient_live_tenure'],
      advisoryOnly: true,
      ...overrides.regimePersistenceReadiness,
    },
    regimePersistenceGraduation: {
      currentRegimeLabel,
      readinessLabel: 'near_ready',
      graduationState: 'nearing_live_persistence',
      graduationMilestone: 'nearing_operational_readiness',
      graduationProgressScore: 63,
      remainingRequirements: ['add_live_tenure'],
      readyForOperationalUse: false,
      advisoryOnly: true,
      ...overrides.regimePersistenceGraduation,
    },
    regimePersistenceGraduationDelta: {
      currentRegimeLabel,
      deltaDirection: 'improving',
      deltaStrength: 'moderate',
      momentumLabel: 'steady_progress',
      blockersAdded: [],
      blockersRemoved: ['add_live_tenure'],
      graduationDeltaByRegime: [
        {
          regimeLabel: currentRegimeLabel,
          deltaDirection: 'improving',
          deltaStrength: 'moderate',
          momentumLabel: 'steady_progress',
          blockersAdded: [],
          blockersRemoved: ['add_live_tenure'],
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
      ...overrides.regimePersistenceGraduationDelta,
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel,
      currentRegimeLiveCadenceLabel: 'improving',
      currentRegimePersistenceQualityLabel: 'partially_live_supported',
      currentRegimeDurabilityConstraint: 'live_depth_limited',
      liveCaptureCoveragePct: 42,
      advisoryOnly: true,
      ...overrides.regimeLivePersistenceQuality,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel,
      currentRegimeDurabilityState: 'building_durability',
      persistenceSource: 'mixed_persisted_history',
      durabilityByRegime: [
        {
          regimeLabel: currentRegimeLabel,
          durabilityState: 'building_durability',
          persistenceSource: 'mixed_persisted_history',
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 4,
          provenanceBreakdown: {
            liveCapturedDays: 4,
            reconstructedDays: 5,
            mixedDays: 1,
          },
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
      ...overrides.regimeConfirmationDurability,
    },
    regimeConfirmationHistory: {
      currentRegimeLabel,
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 4,
      historyCoverageDays: 10,
      historyProvenanceBreakdown: {
        liveCapturedDays: 4,
        reconstructedDays: 5,
        mixedDays: 1,
      },
      byRegime: [
        {
          regimeLabel: currentRegimeLabel,
          hasLiveCapturedHistory: true,
          liveCapturedTenureDays: 4,
          provenanceBreakdown: {
            liveCapturedDays: 4,
            reconstructedDays: 5,
            mixedDays: 1,
          },
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
      ...overrides.regimeConfirmationHistory,
    },
    regimeTrustConsumption: {
      currentRegimeLabel,
      trustBiasLabel: 'mixed_support',
      trustConsumptionLabel: 'allow_with_caution',
      advisoryOnly: true,
      ...overrides.regimeTrustConsumption,
    },
  };
}

function assertBounded(summary) {
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(Number.isFinite(Number(summary.credibilityScore)), 'credibilityScore missing');
  assert(Number(summary.credibilityScore) >= 0 && Number(summary.credibilityScore) <= 100, 'credibilityScore out of bounds');
  assert(ALLOWED_CREDIBILITY_LABELS.includes(String(summary.credibilityLabel || '')), `invalid credibilityLabel: ${summary.credibilityLabel}`);
  assert(ALLOWED_GATES.includes(String(summary.operationalTrustGate || '')), `invalid operationalTrustGate: ${summary.operationalTrustGate}`);
  assert(ALLOWED_PERMISSION_LEVELS.includes(String(summary.trustPermissionLevel || '')), `invalid trustPermissionLevel: ${summary.trustPermissionLevel}`);

  for (const blocker of (summary.primaryBlockers || [])) {
    assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `invalid primary blocker: ${blocker}`);
  }
  for (const blocker of (summary.secondaryBlockers || [])) {
    assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `invalid secondary blocker: ${blocker}`);
  }
  for (const signal of (summary.supportingSignals || [])) {
    assert(ALLOWED_SIGNALS.includes(String(signal || '')), `invalid supporting signal: ${signal}`);
  }

  for (const row of (summary.credibilityByRegime || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row.regimeLabel || '')), `invalid regime row: ${row.regimeLabel}`);
    assert(ALLOWED_CREDIBILITY_LABELS.includes(String(row.credibilityLabel || '')), `invalid row credibilityLabel: ${row.credibilityLabel}`);
    assert(ALLOWED_GATES.includes(String(row.operationalTrustGate || '')), `invalid row operationalTrustGate: ${row.operationalTrustGate}`);
    assert(ALLOWED_PERMISSION_LEVELS.includes(String(row.trustPermissionLevel || '')), `invalid row trustPermissionLevel: ${row.trustPermissionLevel}`);
    for (const blocker of (row.primaryBlockers || [])) {
      assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `invalid row primary blocker: ${blocker}`);
    }
    for (const blocker of (row.secondaryBlockers || [])) {
      assert(ALLOWED_BLOCKERS.includes(String(blocker || '')), `invalid row secondary blocker: ${blocker}`);
    }
    for (const signal of (row.supportingSignals || [])) {
      assert(ALLOWED_SIGNALS.includes(String(signal || '')), `invalid row supporting signal: ${signal}`);
    }
    assert(row.advisoryOnly === true, `row advisoryOnly must be true for ${row.regimeLabel}`);
  }
}

function runUnitChecks() {
  const summary = buildRegimePersistenceOperationalCredibilitySummary(buildFixture());
  assertBounded(summary);

  const noLive = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    currentRegimeLabel: 'unknown',
    regimePersistenceReadiness: {
      currentRegimeLabel: 'unknown',
      persistenceSource: 'proxy_only',
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      currentRegimeLiveCaptureCoveragePct: 0,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      readinessLabel: 'not_ready',
      graduationState: 'reconstructed_dominant',
    },
    regimePersistenceGraduation: {
      currentRegimeLabel: 'unknown',
      readinessLabel: 'not_ready',
      graduationState: 'reconstructed_dominant',
      readyForOperationalUse: false,
    },
    regimePersistenceGraduationDelta: {
      currentRegimeLabel: 'unknown',
      deltaDirection: 'flat',
      deltaStrength: 'weak',
      momentumLabel: 'stalled',
      blockersAdded: [],
      blockersRemoved: [],
      graduationDeltaByRegime: [{ regimeLabel: 'unknown', deltaDirection: 'flat', deltaStrength: 'weak', momentumLabel: 'stalled', blockersAdded: [], blockersRemoved: [], advisoryOnly: true }],
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel: 'unknown',
      currentRegimeLiveCadenceLabel: 'stale',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      liveCaptureCoveragePct: 0,
    },
    regimeConfirmationDurability: {
      currentRegimeLabel: 'unknown',
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'proxy_only',
      durabilityByRegime: [{ regimeLabel: 'unknown', durabilityState: 'unconfirmed', persistenceSource: 'proxy_only', hasLiveCapturedHistory: false, liveCapturedTenureDays: 0, provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }],
    },
    regimeConfirmationHistory: {
      currentRegimeLabel: 'unknown',
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      historyCoverageDays: 0,
      historyProvenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 },
      byRegime: [{ regimeLabel: 'unknown', hasLiveCapturedHistory: false, liveCapturedTenureDays: 0, provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }],
    },
  }));
  assert(String(noLive.operationalTrustGate) === 'blocked', 'no live base must be blocked');
  assert((noLive.primaryBlockers || []).includes('no_live_base'), 'no_live_base blocker missing');

  const reconstructed = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_reconstructed_history',
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      currentRegimeLiveCaptureCoveragePct: 0,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'mostly_reconstructed',
      readinessLabel: 'early',
      graduationState: 'reconstructed_dominant',
    },
    regimeConfirmationDurability: {
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'persisted_reconstructed_history',
      durabilityByRegime: [{ regimeLabel: 'trending', durabilityState: 'unconfirmed', persistenceSource: 'persisted_reconstructed_history', hasLiveCapturedHistory: false, liveCapturedTenureDays: 0, provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 9, mixedDays: 0 }, advisoryOnly: true }],
    },
    regimeConfirmationHistory: {
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      historyCoverageDays: 9,
      historyProvenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 9, mixedDays: 0 },
      byRegime: [{ regimeLabel: 'trending', hasLiveCapturedHistory: false, liveCapturedTenureDays: 0, provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 9, mixedDays: 0 }, advisoryOnly: true }],
    },
  }));
  assert(String(reconstructed.operationalTrustGate) === 'blocked', 'reconstructed/proxy must be blocked');

  const mixedStrong = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    regimePersistenceReadiness: {
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 10,
      currentRegimeLiveCaptureCoveragePct: 75,
      currentRegimeDurabilityState: 'durable_confirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessScore: 88,
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
    },
    regimePersistenceGraduation: {
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      readyForOperationalUse: true,
      graduationProgressScore: 84,
    },
    regimePersistenceGraduationDelta: {
      deltaDirection: 'improving',
      deltaStrength: 'strong',
      momentumLabel: 'accelerating',
      blockersAdded: [],
      blockersRemoved: ['add_live_tenure', 'improve_durability'],
      graduationDeltaByRegime: [{ regimeLabel: 'trending', deltaDirection: 'improving', deltaStrength: 'strong', momentumLabel: 'accelerating', blockersAdded: [], blockersRemoved: ['add_live_tenure', 'improve_durability'], advisoryOnly: true }],
    },
    regimeLivePersistenceQuality: {
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      liveCaptureCoveragePct: 75,
    },
    regimeConfirmationDurability: {
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'mixed_persisted_history',
      durabilityByRegime: [{ regimeLabel: 'trending', durabilityState: 'durable_confirmed', persistenceSource: 'mixed_persisted_history', hasLiveCapturedHistory: true, liveCapturedTenureDays: 10, provenanceBreakdown: { liveCapturedDays: 10, reconstructedDays: 4, mixedDays: 2 }, advisoryOnly: true }],
    },
    regimeConfirmationHistory: {
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 10,
      historyCoverageDays: 16,
      historyProvenanceBreakdown: { liveCapturedDays: 10, reconstructedDays: 4, mixedDays: 2 },
      byRegime: [{ regimeLabel: 'trending', hasLiveCapturedHistory: true, liveCapturedTenureDays: 10, provenanceBreakdown: { liveCapturedDays: 10, reconstructedDays: 4, mixedDays: 2 }, advisoryOnly: true }],
    },
  }));
  assert(String(mixedStrong.operationalTrustGate) !== 'operationally_credible', 'mixed history cannot silently become operationally_credible');

  const durabilityUnconfirmed = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 9,
      currentRegimeLiveCaptureCoveragePct: 78,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
    },
    regimePersistenceGraduation: { readinessLabel: 'ready', graduationState: 'live_persistence_ready', readyForOperationalUse: true, graduationProgressScore: 86 },
    regimeLivePersistenceQuality: { currentRegimeLiveCadenceLabel: 'healthy', currentRegimePersistenceQualityLabel: 'live_ready', liveCaptureCoveragePct: 78 },
    regimeConfirmationDurability: { currentRegimeDurabilityState: 'unconfirmed', persistenceSource: 'persisted_live_history', durabilityByRegime: [{ regimeLabel: 'trending', durabilityState: 'unconfirmed', persistenceSource: 'persisted_live_history', hasLiveCapturedHistory: true, liveCapturedTenureDays: 9, provenanceBreakdown: { liveCapturedDays: 9, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }] },
    regimeConfirmationHistory: { currentRegimeHasLiveCapturedHistory: true, currentRegimeLiveCapturedTenureDays: 9, historyCoverageDays: 9, historyProvenanceBreakdown: { liveCapturedDays: 9, reconstructedDays: 0, mixedDays: 0 }, byRegime: [{ regimeLabel: 'trending', hasLiveCapturedHistory: true, liveCapturedTenureDays: 9, provenanceBreakdown: { liveCapturedDays: 9, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }] },
  }));
  assert(String(durabilityUnconfirmed.operationalTrustGate) !== 'operationally_credible', 'unconfirmed durability must prevent operationally_credible');

  const insufficientDepth = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 2,
      currentRegimeLiveCaptureCoveragePct: 65,
      currentRegimeDurabilityState: 'building_durability',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      readinessLabel: 'early',
      graduationState: 'accumulating_live_depth',
    },
    regimePersistenceGraduation: { readinessLabel: 'early', graduationState: 'accumulating_live_depth', readyForOperationalUse: false },
    regimeLivePersistenceQuality: { currentRegimeLiveCadenceLabel: 'improving', currentRegimePersistenceQualityLabel: 'insufficient_live_depth', liveCaptureCoveragePct: 65 },
    regimeConfirmationDurability: { currentRegimeDurabilityState: 'building_durability', persistenceSource: 'persisted_live_history', durabilityByRegime: [{ regimeLabel: 'trending', durabilityState: 'building_durability', persistenceSource: 'persisted_live_history', hasLiveCapturedHistory: true, liveCapturedTenureDays: 2, provenanceBreakdown: { liveCapturedDays: 2, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }] },
    regimeConfirmationHistory: { currentRegimeHasLiveCapturedHistory: true, currentRegimeLiveCapturedTenureDays: 2, historyCoverageDays: 2, historyProvenanceBreakdown: { liveCapturedDays: 2, reconstructedDays: 0, mixedDays: 0 }, byRegime: [{ regimeLabel: 'trending', hasLiveCapturedHistory: true, liveCapturedTenureDays: 2, provenanceBreakdown: { liveCapturedDays: 2, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }] },
  }));
  assert(String(insufficientDepth.operationalTrustGate) !== 'operationally_credible', 'insufficient_live_depth must prevent operationally_credible');

  const fullyLiveReady = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 12,
      currentRegimeLiveCaptureCoveragePct: 85,
      currentRegimeDurabilityState: 'durable_confirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessScore: 90,
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      blockers: [],
    },
    regimePersistenceGraduation: {
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      graduationMilestone: 'operationally_ready',
      graduationProgressScore: 92,
      remainingRequirements: [],
      readyForOperationalUse: true,
    },
    regimePersistenceGraduationDelta: {
      deltaDirection: 'improving',
      deltaStrength: 'moderate',
      momentumLabel: 'steady_progress',
      blockersAdded: [],
      blockersRemoved: ['improve_durability'],
      graduationDeltaByRegime: [{ regimeLabel: 'trending', deltaDirection: 'improving', deltaStrength: 'moderate', momentumLabel: 'steady_progress', blockersAdded: [], blockersRemoved: ['improve_durability'], advisoryOnly: true }],
    },
    regimeLivePersistenceQuality: {
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      liveCaptureCoveragePct: 85,
    },
    regimeConfirmationDurability: {
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'persisted_live_history',
      durabilityByRegime: [{ regimeLabel: 'trending', durabilityState: 'durable_confirmed', persistenceSource: 'persisted_live_history', hasLiveCapturedHistory: true, liveCapturedTenureDays: 12, provenanceBreakdown: { liveCapturedDays: 12, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }],
    },
    regimeConfirmationHistory: {
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 12,
      historyCoverageDays: 12,
      historyProvenanceBreakdown: { liveCapturedDays: 12, reconstructedDays: 0, mixedDays: 0 },
      byRegime: [{ regimeLabel: 'trending', hasLiveCapturedHistory: true, liveCapturedTenureDays: 12, provenanceBreakdown: { liveCapturedDays: 12, reconstructedDays: 0, mixedDays: 0 }, advisoryOnly: true }],
    },
  }));
  assert(String(fullyLiveReady.operationalTrustGate) === 'operationally_credible', 'fully live + durable + ready should allow operationally_credible');

  const cautiousMixed = buildRegimePersistenceOperationalCredibilitySummary(buildFixture({
    regimePersistenceReadiness: {
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 7,
      currentRegimeLiveCaptureCoveragePct: 60,
      currentRegimeDurabilityState: 'building_durability',
      currentRegimePersistenceQualityLabel: 'partially_live_supported',
      readinessLabel: 'near_ready',
      graduationState: 'nearing_live_persistence',
    },
    regimePersistenceGraduation: { readinessLabel: 'near_ready', graduationState: 'nearing_live_persistence', readyForOperationalUse: false, remainingRequirements: ['improve_durability'] },
    regimePersistenceGraduationDelta: { deltaDirection: 'improving', deltaStrength: 'weak', momentumLabel: 'steady_progress', blockersAdded: [], blockersRemoved: ['add_live_tenure'], graduationDeltaByRegime: [{ regimeLabel: 'trending', deltaDirection: 'improving', deltaStrength: 'weak', momentumLabel: 'steady_progress', blockersAdded: [], blockersRemoved: ['add_live_tenure'], advisoryOnly: true }] },
    regimeLivePersistenceQuality: { currentRegimeLiveCadenceLabel: 'healthy', currentRegimePersistenceQualityLabel: 'partially_live_supported', liveCaptureCoveragePct: 60 },
    regimeConfirmationDurability: { currentRegimeDurabilityState: 'building_durability', persistenceSource: 'mixed_persisted_history', durabilityByRegime: [{ regimeLabel: 'trending', durabilityState: 'building_durability', persistenceSource: 'mixed_persisted_history', hasLiveCapturedHistory: true, liveCapturedTenureDays: 7, provenanceBreakdown: { liveCapturedDays: 7, reconstructedDays: 5, mixedDays: 1 }, advisoryOnly: true }] },
    regimeConfirmationHistory: { currentRegimeHasLiveCapturedHistory: true, currentRegimeLiveCapturedTenureDays: 7, historyCoverageDays: 13, historyProvenanceBreakdown: { liveCapturedDays: 7, reconstructedDays: 5, mixedDays: 1 }, byRegime: [{ regimeLabel: 'trending', hasLiveCapturedHistory: true, liveCapturedTenureDays: 7, provenanceBreakdown: { liveCapturedDays: 7, reconstructedDays: 5, mixedDays: 1 }, advisoryOnly: true }] },
  }));
  assert(String(cautiousMixed.operationalTrustGate) === 'cautious_use', 'mixed but improving fixture should classify cautious_use');
  assertBounded(cautiousMixed);
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
    port: process.env.JARVIS_AUDIT_PORT || 3204,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-operational-credibility?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'endpoint should return ok');
    const summary = out?.regimePersistenceOperationalCredibility;
    assert(summary && typeof summary === 'object', 'regimePersistenceOperationalCredibility missing');
    assertBounded(summary);
    assert(typeof summary.credibilityInsight === 'string' && summary.credibilityInsight.length > 0, 'credibilityInsight missing');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimePersistenceOperationalCredibility && typeof center.regimePersistenceOperationalCredibility === 'object', 'top-level regimePersistenceOperationalCredibility missing in command-center response');

    const cc = center?.commandCenter || {};
    assert(Number.isFinite(Number(cc.regimePersistenceCredibilityScore)), 'commandCenter.regimePersistenceCredibilityScore missing');
    assert(ALLOWED_CREDIBILITY_LABELS.includes(String(cc.regimePersistenceCredibilityLabel || '')), 'commandCenter.regimePersistenceCredibilityLabel invalid');
    assert(ALLOWED_GATES.includes(String(cc.regimePersistenceOperationalTrustGate || '')), 'commandCenter.regimePersistenceOperationalTrustGate invalid');
    assert(ALLOWED_PERMISSION_LEVELS.includes(String(cc.regimePersistenceTrustPermissionLevel || '')), 'commandCenter.regimePersistenceTrustPermissionLevel invalid');
    assert(Array.isArray(cc.regimePersistencePrimaryBlockers), 'commandCenter.regimePersistencePrimaryBlockers missing');
    assert(Array.isArray(cc.regimePersistenceSupportingSignals), 'commandCenter.regimePersistenceSupportingSignals missing');
    assert(typeof cc.regimePersistenceCredibilityInsight === 'string' && cc.regimePersistenceCredibilityInsight.length > 0, 'commandCenter.regimePersistenceCredibilityInsight missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_GATES.includes(String(cc.decisionBoard.regimePersistenceOperationalTrustGate || '')), 'decisionBoard.regimePersistenceOperationalTrustGate invalid');
    assert(ALLOWED_CREDIBILITY_LABELS.includes(String(cc.decisionBoard.regimePersistenceCredibilityLabel || '')), 'decisionBoard.regimePersistenceCredibilityLabel invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_GATES.includes(String(cc.todayRecommendation.regimePersistenceOperationalTrustGate || '')), 'todayRecommendation.regimePersistenceOperationalTrustGate invalid');
    assert(ALLOWED_CREDIBILITY_LABELS.includes(String(cc.todayRecommendation.regimePersistenceCredibilityLabel || '')), 'todayRecommendation.regimePersistenceCredibilityLabel invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimePersistenceCredibilityScore)), 'todayRecommendation.regimePersistenceCredibilityScore missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ regime persistence operational credibility checks passed');
  } catch (err) {
    console.error('❌ regime persistence operational credibility checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
