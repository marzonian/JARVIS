#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePersistenceTrustOverrideSummary,
} = require('../server/jarvis-core/regime-persistence-trust-override');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 420000;
const ALLOWED_OVERRIDE_LABELS = [
  'suppressed',
  'cautious',
  'enabled',
];
const ALLOWED_CONFIDENCE_POLICIES = [
  'suppress_confidence',
  'allow_cautious_confidence',
  'allow_structured_confidence',
];
const ALLOWED_OVERRIDE_ACTIONS = [
  'decrease_confidence',
  'no_material_change',
  'increase_confidence',
];
const ALLOWED_POLICY_BLOCKERS = [
  'credibility_blocked',
  'credibility_not_strong_enough',
  'reconstructed_dominant',
  'mixed_history_constraint',
  'durability_unconfirmed',
  'quality_not_live_ready',
  'readiness_not_ready',
  'graduation_not_ready',
  'delta_not_supportive',
  'live_depth_insufficient',
  'coverage_insufficient',
];
const ALLOWED_POLICY_SUPPORTS = [
  'credibility_cautious',
  'credibility_operational',
  'durability_confirmed',
  'quality_live_ready',
  'readiness_ready',
  'graduation_progressing',
  'delta_supportive',
  'blockers_reducing',
  'live_depth_sufficient',
  'coverage_sufficient',
];

function buildFixture(overrides = {}) {
  const currentRegimeLabel = String(overrides.currentRegimeLabel || 'trending').trim().toLowerCase();
  return {
    windowSessions: 120,
    performanceSource: 'all',
    regimePersistenceOperationalCredibility: {
      currentRegimeLabel,
      credibilityScore: 52,
      credibilityLabel: 'limited',
      operationalTrustGate: 'cautious_use',
      trustPermissionLevel: 'allow_persistence_with_caution',
      primaryBlockers: ['mixed_persistence_history'],
      secondaryBlockers: ['graduation_not_ready'],
      supportingSignals: ['live_base_present', 'quality_improving'],
      readyForOperationalUse: false,
      credibilityByRegime: [
        {
          regimeLabel: currentRegimeLabel,
          credibilityScore: 52,
          credibilityLabel: 'limited',
          operationalTrustGate: 'cautious_use',
          trustPermissionLevel: 'allow_persistence_with_caution',
          readyForOperationalUse: false,
          primaryBlockers: ['mixed_persistence_history'],
          secondaryBlockers: ['graduation_not_ready'],
          supportingSignals: ['live_base_present', 'quality_improving'],
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
      ...(overrides.regimePersistenceOperationalCredibility || {}),
    },
    regimePersistenceGraduationDelta: {
      currentRegimeLabel,
      deltaDirection: 'improving',
      deltaStrength: 'weak',
      momentumLabel: 'steady_progress',
      blockersAdded: [],
      blockersRemoved: ['add_live_tenure'],
      graduationDeltaByRegime: [
        {
          regimeLabel: currentRegimeLabel,
          currentGraduationMilestone: 'durability_building',
          priorGraduationMilestone: 'live_depth_building',
          currentGraduationProgressScore: 56,
          priorGraduationProgressScore: 50,
          deltaProgressScore: 6,
          deltaDirection: 'improving',
          deltaStrength: 'weak',
          momentumLabel: 'steady_progress',
          currentRemainingRequirements: ['improve_durability'],
          priorRemainingRequirements: ['add_live_tenure', 'improve_durability'],
          blockersAdded: [],
          blockersRemoved: ['add_live_tenure'],
          blockersUnchanged: ['improve_durability'],
          readyForOperationalUse: false,
          advisoryOnly: true,
        },
      ],
      advisoryOnly: true,
      ...(overrides.regimePersistenceGraduationDelta || {}),
    },
    regimePersistenceGraduation: {
      currentRegimeLabel,
      readinessLabel: 'near_ready',
      graduationState: 'nearing_live_persistence',
      graduationMilestone: 'durability_building',
      graduationProgressScore: 56,
      remainingRequirements: ['improve_durability'],
      readyForOperationalUse: false,
      graduatedRegimeLabels: [],
      progressingRegimeLabels: [currentRegimeLabel],
      stalledGraduationRegimeLabels: [],
      advisoryOnly: true,
      ...(overrides.regimePersistenceGraduation || {}),
    },
    regimePersistenceReadiness: {
      currentRegimeLabel,
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 4,
      currentRegimeLiveCaptureCoveragePct: 42,
      currentRegimeDurabilityState: 'building_durability',
      currentRegimePersistenceQualityLabel: 'partially_live_supported',
      readinessScore: 58,
      readinessLabel: 'near_ready',
      graduationState: 'nearing_live_persistence',
      blockers: ['insufficient_live_tenure'],
      liveReadyRegimeLabels: [],
      nearReadyRegimeLabels: [currentRegimeLabel],
      notReadyRegimeLabels: ['unknown'],
      advisoryOnly: true,
      ...(overrides.regimePersistenceReadiness || {}),
    },
    regimeLivePersistenceQuality: {
      currentRegimeLabel,
      liveCaptureCoveragePct: 42,
      currentRegimeLiveCadenceLabel: 'improving',
      currentRegimePersistenceQualityLabel: 'partially_live_supported',
      currentRegimeDurabilityConstraint: 'live_depth_limited',
      advisoryOnly: true,
      ...(overrides.regimeLivePersistenceQuality || {}),
    },
    regimeConfirmationDurability: {
      currentRegimeLabel,
      currentRegimeDurabilityState: 'building_durability',
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 4,
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
      ...(overrides.regimeConfirmationDurability || {}),
    },
    regimeConfirmationHistory: {
      currentRegimeLabel,
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 4,
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
      ...(overrides.regimeConfirmationHistory || {}),
    },
    regimeTrustConsumption: {
      currentRegimeLabel,
      trustConsumptionLabel: 'allow_with_caution',
      advisoryOnly: true,
      ...(overrides.regimeTrustConsumption || {}),
    },
  };
}

function assertBounded(summary) {
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(Number.isFinite(Number(summary.overrideScore)), 'overrideScore missing');
  assert(Number(summary.overrideScore) >= 0 && Number(summary.overrideScore) <= 100, 'overrideScore out of bounds');
  assert(ALLOWED_OVERRIDE_LABELS.includes(String(summary.overrideLabel || '')), `invalid overrideLabel: ${summary.overrideLabel}`);
  assert(ALLOWED_CONFIDENCE_POLICIES.includes(String(summary.confidencePolicy || '')), `invalid confidencePolicy: ${summary.confidencePolicy}`);
  assert(ALLOWED_OVERRIDE_ACTIONS.includes(String(summary.confidenceOverrideAction || '')), `invalid confidenceOverrideAction: ${summary.confidenceOverrideAction}`);
  assert(Number.isFinite(Number(summary.confidenceOverridePoints)), 'confidenceOverridePoints missing');
  assert(Number(summary.confidenceOverridePoints) >= -12 && Number(summary.confidenceOverridePoints) <= 6, 'confidenceOverridePoints out of bounds');
  assert(Array.isArray(summary.policyBlockers), 'policyBlockers missing');
  assert(Array.isArray(summary.policySupports), 'policySupports missing');
  for (const blocker of summary.policyBlockers) {
    assert(ALLOWED_POLICY_BLOCKERS.includes(String(blocker || '')), `invalid policy blocker: ${blocker}`);
  }
  for (const support of summary.policySupports) {
    assert(ALLOWED_POLICY_SUPPORTS.includes(String(support || '')), `invalid policy support: ${support}`);
  }
  for (const row of (summary.trustOverrideByRegime || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row.regimeLabel || '')), `invalid row regimeLabel: ${row.regimeLabel}`);
    assert(ALLOWED_OVERRIDE_LABELS.includes(String(row.overrideLabel || '')), `invalid row overrideLabel: ${row.overrideLabel}`);
    assert(ALLOWED_CONFIDENCE_POLICIES.includes(String(row.confidencePolicy || '')), `invalid row confidencePolicy: ${row.confidencePolicy}`);
    assert(ALLOWED_OVERRIDE_ACTIONS.includes(String(row.confidenceOverrideAction || '')), `invalid row confidenceOverrideAction: ${row.confidenceOverrideAction}`);
    assert(Number.isFinite(Number(row.confidenceOverridePoints)), `row confidenceOverridePoints missing for ${row.regimeLabel}`);
    assert(Number(row.confidenceOverridePoints) >= -12 && Number(row.confidenceOverridePoints) <= 6, `row confidenceOverridePoints out of bounds for ${row.regimeLabel}`);
    for (const blocker of (row.policyBlockers || [])) {
      assert(ALLOWED_POLICY_BLOCKERS.includes(String(blocker || '')), `invalid row blocker: ${blocker}`);
    }
    for (const support of (row.policySupports || [])) {
      assert(ALLOWED_POLICY_SUPPORTS.includes(String(support || '')), `invalid row support: ${support}`);
    }
    assert(row.advisoryOnly === true, `row advisoryOnly must be true for ${row.regimeLabel}`);
  }
}

function runUnitChecks() {
  const summary = buildRegimePersistenceTrustOverrideSummary(buildFixture());
  assertBounded(summary);

  const blocked = buildRegimePersistenceTrustOverrideSummary(buildFixture({
    regimePersistenceOperationalCredibility: {
      currentRegimeLabel: 'unknown',
      operationalTrustGate: 'blocked',
      credibilityLabel: 'not_credible',
      credibilityScore: 18,
      primaryBlockers: ['no_live_base'],
      secondaryBlockers: ['durability_not_confirmed'],
      supportingSignals: [],
      credibilityByRegime: [{
        regimeLabel: 'unknown',
        operationalTrustGate: 'blocked',
        credibilityLabel: 'not_credible',
        credibilityScore: 18,
        readyForOperationalUse: false,
        primaryBlockers: ['no_live_base'],
        secondaryBlockers: ['durability_not_confirmed'],
        supportingSignals: [],
        advisoryOnly: true,
      }],
    },
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
      liveReadyRegimeLabels: [],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: ['unknown'],
    },
    regimePersistenceGraduation: {
      currentRegimeLabel: 'unknown',
      readinessLabel: 'not_ready',
      graduationState: 'reconstructed_dominant',
      readyForOperationalUse: false,
      graduatedRegimeLabels: [],
      progressingRegimeLabels: [],
      stalledGraduationRegimeLabels: ['unknown'],
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
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      durabilityByRegime: [{
        regimeLabel: 'unknown',
        durabilityState: 'unconfirmed',
        persistenceSource: 'proxy_only',
        hasLiveCapturedHistory: false,
        liveCapturedTenureDays: 0,
        provenanceBreakdown: { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 },
        advisoryOnly: true,
      }],
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'unknown',
      trustConsumptionLabel: 'suppress_regime_bias',
    },
  }));
  assert(String(blocked.confidencePolicy) === 'suppress_confidence', 'blocked credibility must force suppress_confidence');
  assert(String(blocked.overrideLabel) === 'suppressed', 'blocked credibility must force suppressed');
  assert(String(blocked.confidenceOverrideAction) === 'decrease_confidence', 'blocked credibility must force decrease_confidence');

  const cautious = buildRegimePersistenceTrustOverrideSummary(buildFixture({
    regimePersistenceOperationalCredibility: {
      operationalTrustGate: 'cautious_use',
      credibilityLabel: 'limited',
      credibilityScore: 78,
      primaryBlockers: [],
      secondaryBlockers: [],
      supportingSignals: ['live_base_present', 'durability_building'],
      credibilityByRegime: [{
        regimeLabel: 'trending',
        operationalTrustGate: 'cautious_use',
        credibilityLabel: 'limited',
        credibilityScore: 78,
        readyForOperationalUse: false,
        primaryBlockers: [],
        secondaryBlockers: [],
        supportingSignals: ['live_base_present', 'durability_building'],
        advisoryOnly: true,
      }],
    },
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 8,
      currentRegimeLiveCaptureCoveragePct: 70,
      currentRegimeDurabilityState: 'building_durability',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      readinessScore: 88,
      liveReadyRegimeLabels: ['trending'],
    },
    regimePersistenceGraduation: {
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      graduationProgressScore: 82,
      readyForOperationalUse: true,
      graduatedRegimeLabels: ['trending'],
    },
  }));
  assert(String(cautious.confidencePolicy) !== 'allow_structured_confidence', 'cautious operational credibility cannot become structured confidence');

  const mixedSource = buildRegimePersistenceTrustOverrideSummary(buildFixture({
    regimePersistenceOperationalCredibility: {
      operationalTrustGate: 'operationally_credible',
      credibilityLabel: 'credible',
      credibilityScore: 90,
      primaryBlockers: [],
      secondaryBlockers: [],
      supportingSignals: ['live_base_present', 'durability_confirmed'],
      credibilityByRegime: [{
        regimeLabel: 'trending',
        operationalTrustGate: 'operationally_credible',
        credibilityLabel: 'credible',
        credibilityScore: 90,
        readyForOperationalUse: true,
        primaryBlockers: [],
        secondaryBlockers: [],
        supportingSignals: ['live_base_present', 'durability_confirmed'],
        advisoryOnly: true,
      }],
    },
    regimePersistenceReadiness: {
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 10,
      currentRegimeLiveCaptureCoveragePct: 75,
      currentRegimeDurabilityState: 'durable_confirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      readinessScore: 90,
      liveReadyRegimeLabels: ['trending'],
    },
    regimePersistenceGraduation: {
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      graduationProgressScore: 91,
      readyForOperationalUse: true,
      graduatedRegimeLabels: ['trending'],
    },
    regimeConfirmationDurability: {
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'mixed_persisted_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 10,
      durabilityByRegime: [{
        regimeLabel: 'trending',
        durabilityState: 'durable_confirmed',
        persistenceSource: 'mixed_persisted_history',
        hasLiveCapturedHistory: true,
        liveCapturedTenureDays: 10,
        provenanceBreakdown: { liveCapturedDays: 10, reconstructedDays: 5, mixedDays: 2 },
        advisoryOnly: true,
      }],
    },
  }));
  assert(String(mixedSource.confidencePolicy) !== 'allow_structured_confidence', 'mixed history cannot become structured confidence');

  const unconfirmedDurability = buildRegimePersistenceTrustOverrideSummary(buildFixture({
    regimePersistenceOperationalCredibility: {
      operationalTrustGate: 'operationally_credible',
      credibilityLabel: 'credible',
      credibilityScore: 88,
      primaryBlockers: [],
      secondaryBlockers: [],
      supportingSignals: ['live_base_present'],
      credibilityByRegime: [{
        regimeLabel: 'trending',
        operationalTrustGate: 'operationally_credible',
        credibilityLabel: 'credible',
        credibilityScore: 88,
        readyForOperationalUse: true,
        primaryBlockers: [],
        secondaryBlockers: [],
        supportingSignals: ['live_base_present'],
        advisoryOnly: true,
      }],
    },
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 9,
      currentRegimeLiveCaptureCoveragePct: 76,
      currentRegimeDurabilityState: 'unconfirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      readinessScore: 86,
      liveReadyRegimeLabels: ['trending'],
    },
    regimePersistenceGraduation: {
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      graduationProgressScore: 84,
      readyForOperationalUse: true,
      graduatedRegimeLabels: ['trending'],
    },
    regimeConfirmationDurability: {
      currentRegimeDurabilityState: 'unconfirmed',
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 9,
      durabilityByRegime: [{
        regimeLabel: 'trending',
        durabilityState: 'unconfirmed',
        persistenceSource: 'persisted_live_history',
        hasLiveCapturedHistory: true,
        liveCapturedTenureDays: 9,
        provenanceBreakdown: { liveCapturedDays: 9, reconstructedDays: 0, mixedDays: 0 },
        advisoryOnly: true,
      }],
    },
  }));
  assert(String(unconfirmedDurability.confidencePolicy) !== 'allow_structured_confidence', 'unconfirmed durability must block structured confidence');

  const insufficientDepth = buildRegimePersistenceTrustOverrideSummary(buildFixture({
    regimePersistenceOperationalCredibility: {
      operationalTrustGate: 'operationally_credible',
      credibilityLabel: 'credible',
      credibilityScore: 85,
      primaryBlockers: [],
      secondaryBlockers: [],
      supportingSignals: ['live_base_present'],
      credibilityByRegime: [{
        regimeLabel: 'trending',
        operationalTrustGate: 'operationally_credible',
        credibilityLabel: 'credible',
        credibilityScore: 85,
        readyForOperationalUse: false,
        primaryBlockers: [],
        secondaryBlockers: [],
        supportingSignals: ['live_base_present'],
        advisoryOnly: true,
      }],
    },
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 2,
      currentRegimeLiveCaptureCoveragePct: 62,
      currentRegimeDurabilityState: 'building_durability',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      readinessLabel: 'early',
      graduationState: 'accumulating_live_depth',
      readinessScore: 48,
    },
    regimePersistenceGraduation: {
      readinessLabel: 'early',
      graduationState: 'accumulating_live_depth',
      graduationProgressScore: 47,
      readyForOperationalUse: false,
      graduatedRegimeLabels: [],
    },
    regimeLivePersistenceQuality: {
      currentRegimeLiveCadenceLabel: 'improving',
      currentRegimePersistenceQualityLabel: 'insufficient_live_depth',
      liveCaptureCoveragePct: 62,
    },
  }));
  assert(String(insufficientDepth.confidencePolicy) !== 'allow_structured_confidence', 'insufficient live depth must block structured confidence');

  const enabled = buildRegimePersistenceTrustOverrideSummary(buildFixture({
    regimePersistenceOperationalCredibility: {
      operationalTrustGate: 'operationally_credible',
      credibilityLabel: 'credible',
      credibilityScore: 94,
      primaryBlockers: [],
      secondaryBlockers: [],
      supportingSignals: ['live_base_present', 'durability_confirmed', 'quality_improving', 'graduation_progressing'],
      readyForOperationalUse: true,
      credibilityByRegime: [{
        regimeLabel: 'trending',
        operationalTrustGate: 'operationally_credible',
        credibilityLabel: 'credible',
        credibilityScore: 94,
        readyForOperationalUse: true,
        primaryBlockers: [],
        secondaryBlockers: [],
        supportingSignals: ['live_base_present', 'durability_confirmed', 'quality_improving', 'graduation_progressing'],
        advisoryOnly: true,
      }],
    },
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 12,
      currentRegimeLiveCaptureCoveragePct: 86,
      currentRegimeDurabilityState: 'durable_confirmed',
      currentRegimePersistenceQualityLabel: 'live_ready',
      readinessScore: 92,
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      blockers: [],
      liveReadyRegimeLabels: ['trending'],
      nearReadyRegimeLabels: [],
      notReadyRegimeLabels: [],
    },
    regimePersistenceGraduation: {
      readinessLabel: 'ready',
      graduationState: 'live_persistence_ready',
      graduationMilestone: 'operationally_ready',
      graduationProgressScore: 93,
      remainingRequirements: [],
      readyForOperationalUse: true,
      graduatedRegimeLabels: ['trending'],
      progressingRegimeLabels: [],
      stalledGraduationRegimeLabels: [],
    },
    regimePersistenceGraduationDelta: {
      deltaDirection: 'improving',
      deltaStrength: 'moderate',
      momentumLabel: 'steady_progress',
      blockersAdded: [],
      blockersRemoved: ['improve_durability'],
      graduationDeltaByRegime: [{
        regimeLabel: 'trending',
        currentGraduationMilestone: 'operationally_ready',
        priorGraduationMilestone: 'nearing_operational_readiness',
        currentGraduationProgressScore: 93,
        priorGraduationProgressScore: 83,
        deltaProgressScore: 10,
        deltaDirection: 'improving',
        deltaStrength: 'moderate',
        momentumLabel: 'steady_progress',
        currentRemainingRequirements: [],
        priorRemainingRequirements: ['improve_durability'],
        blockersAdded: [],
        blockersRemoved: ['improve_durability'],
        blockersUnchanged: [],
        readyForOperationalUse: true,
        advisoryOnly: true,
      }],
    },
    regimeLivePersistenceQuality: {
      liveCaptureCoveragePct: 86,
      currentRegimeLiveCadenceLabel: 'healthy',
      currentRegimePersistenceQualityLabel: 'live_ready',
      currentRegimeDurabilityConstraint: 'regime_quality_limited',
    },
    regimeConfirmationDurability: {
      currentRegimeDurabilityState: 'durable_confirmed',
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 12,
      durabilityByRegime: [{
        regimeLabel: 'trending',
        durabilityState: 'durable_confirmed',
        persistenceSource: 'persisted_live_history',
        hasLiveCapturedHistory: true,
        liveCapturedTenureDays: 12,
        provenanceBreakdown: { liveCapturedDays: 12, reconstructedDays: 0, mixedDays: 0 },
        advisoryOnly: true,
      }],
    },
    regimeTrustConsumption: {
      trustConsumptionLabel: 'allow_regime_confidence',
    },
  }));
  assert(String(enabled.overrideLabel) === 'enabled', 'fully live-ready + operationally credible fixture should enable override');
  assert(String(enabled.confidencePolicy) === 'allow_structured_confidence', 'enabled fixture should allow structured confidence');
  assert(String(enabled.confidenceOverrideAction) === 'increase_confidence', 'enabled fixture should increase confidence');

  assertBounded(enabled);
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
    port: process.env.JARVIS_AUDIT_PORT || 3205,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-trust-override?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'endpoint should return ok');
    const summary = out?.regimePersistenceTrustOverride;
    assert(summary && typeof summary === 'object', 'regimePersistenceTrustOverride missing');
    assertBounded(summary);
    assert(typeof summary.trustOverrideInsight === 'string' && summary.trustOverrideInsight.length > 0, 'trustOverrideInsight missing');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimePersistenceTrustOverride && typeof center.regimePersistenceTrustOverride === 'object', 'top-level regimePersistenceTrustOverride missing in command-center response');

    const cc = center?.commandCenter || {};
    assert(Number.isFinite(Number(cc.regimePersistenceOverrideScore)), 'commandCenter.regimePersistenceOverrideScore missing');
    assert(ALLOWED_OVERRIDE_LABELS.includes(String(cc.regimePersistenceOverrideLabel || '')), 'commandCenter.regimePersistenceOverrideLabel invalid');
    assert(ALLOWED_CONFIDENCE_POLICIES.includes(String(cc.regimePersistenceConfidencePolicy || '')), 'commandCenter.regimePersistenceConfidencePolicy invalid');
    assert(ALLOWED_OVERRIDE_ACTIONS.includes(String(cc.regimePersistenceConfidenceOverrideAction || '')), 'commandCenter.regimePersistenceConfidenceOverrideAction invalid');
    assert(Number.isFinite(Number(cc.regimePersistenceConfidenceOverridePoints)), 'commandCenter.regimePersistenceConfidenceOverridePoints missing');
    assert(Array.isArray(cc.regimePersistencePolicyBlockers), 'commandCenter.regimePersistencePolicyBlockers missing');
    assert(Array.isArray(cc.regimePersistencePolicySupports), 'commandCenter.regimePersistencePolicySupports missing');
    assert(typeof cc.regimePersistenceTrustOverrideInsight === 'string' && cc.regimePersistenceTrustOverrideInsight.length > 0, 'commandCenter.regimePersistenceTrustOverrideInsight missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_CONFIDENCE_POLICIES.includes(String(cc.decisionBoard.regimePersistenceConfidencePolicy || '')), 'decisionBoard.regimePersistenceConfidencePolicy invalid');
    assert(ALLOWED_OVERRIDE_LABELS.includes(String(cc.decisionBoard.regimePersistenceOverrideLabel || '')), 'decisionBoard.regimePersistenceOverrideLabel invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_CONFIDENCE_POLICIES.includes(String(cc.todayRecommendation.regimePersistenceConfidencePolicy || '')), 'todayRecommendation.regimePersistenceConfidencePolicy invalid');
    assert(ALLOWED_OVERRIDE_LABELS.includes(String(cc.todayRecommendation.regimePersistenceOverrideLabel || '')), 'todayRecommendation.regimePersistenceOverrideLabel invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimePersistenceConfidenceOverridePoints)), 'todayRecommendation.regimePersistenceConfidenceOverridePoints missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ regime persistence trust override checks passed');
  } catch (err) {
    console.error('❌ regime persistence trust override checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
