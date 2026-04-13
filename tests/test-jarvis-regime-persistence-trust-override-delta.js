#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePersistenceTrustOverrideDeltaSummary,
} = require('../server/jarvis-core/regime-persistence-trust-override-delta');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 420000;

const ALLOWED_DELTA_DIRECTIONS = [
  'improving',
  'flat',
  'regressing',
];
const ALLOWED_DELTA_STRENGTH = [
  'strong',
  'moderate',
  'weak',
];
const ALLOWED_MOMENTUM = [
  'accelerating',
  'steady_improvement',
  'stalled',
  'oscillating',
  'deteriorating',
];
const ALLOWED_BLOCKERS = [
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
const ALLOWED_SUPPORTS = [
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

function makeTrustRow(regimeLabel, overrides = {}) {
  return {
    regimeLabel,
    overrideScore: 30,
    overrideLabel: 'suppressed',
    confidencePolicy: 'suppress_confidence',
    confidenceOverrideAction: 'decrease_confidence',
    confidenceOverridePoints: -4,
    readyForOperationalUse: false,
    policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
    policySupports: [],
    advisoryOnly: true,
    ...overrides,
  };
}

function makeHistoryOverrideRow(regimeLabel, snapshotDate, overrides = {}) {
  return {
    snapshot_date: snapshotDate,
    regimeLabel,
    overrideScore: 25,
    overrideLabel: 'suppressed',
    confidencePolicy: 'suppress_confidence',
    confidenceOverridePoints: -6,
    policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
    policySupports: [],
    readyForOperationalUse: false,
    advisoryOnly: true,
    ...overrides,
  };
}

function buildFixture(overrides = {}) {
  const currentRegimeLabel = String(overrides.currentRegimeLabel || 'trending').trim().toLowerCase();
  const currentRowOverrides = overrides.currentRow || {};

  const trustRows = SUPPORTED_REGIME_LABELS.map((label) => (
    makeTrustRow(label, label === currentRegimeLabel ? currentRowOverrides : {})
  ));

  const currentRow = trustRows.find((row) => row.regimeLabel === currentRegimeLabel) || makeTrustRow(currentRegimeLabel);

  return {
    windowSessions: 120,
    performanceSource: 'all',
    regimePersistenceTrustOverride: {
      currentRegimeLabel,
      overrideScore: currentRow.overrideScore,
      overrideLabel: currentRow.overrideLabel,
      confidencePolicy: currentRow.confidencePolicy,
      confidenceOverrideAction: currentRow.confidenceOverrideAction,
      confidenceOverridePoints: currentRow.confidenceOverridePoints,
      policyBlockers: currentRow.policyBlockers,
      policySupports: currentRow.policySupports,
      readyForOperationalUse: currentRow.readyForOperationalUse,
      trustOverrideByRegime: trustRows,
      advisoryOnly: true,
      ...(overrides.regimePersistenceTrustOverride || {}),
    },
    regimePersistenceReadiness: {
      currentRegimeLabel,
      persistenceSource: 'persisted_live_history',
      currentRegimeHasLiveCapturedHistory: true,
      currentRegimeLiveCapturedTenureDays: 6,
      currentRegimeLiveCaptureCoveragePct: 62,
      advisoryOnly: true,
      ...(overrides.regimePersistenceReadiness || {}),
    },
    regimeConfirmationHistory: {
      currentRegimeLabel,
      historyCoverageDays: 8,
      currentRegimeHasLiveCapturedHistory: true,
      historyProvenanceBreakdown: {
        liveCapturedDays: 8,
        reconstructedDays: 1,
        mixedDays: 0,
      },
      advisoryOnly: true,
      ...(overrides.regimeConfirmationHistory || {}),
    },
    overrideHistoryRows: Array.isArray(overrides.overrideHistoryRows)
      ? overrides.overrideHistoryRows
      : [
        makeHistoryOverrideRow(currentRegimeLabel, '2026-03-07', {
          overrideScore: 22,
          overrideLabel: 'suppressed',
          confidencePolicy: 'suppress_confidence',
          confidenceOverridePoints: -7,
          policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
          policySupports: [],
        }),
        makeHistoryOverrideRow(currentRegimeLabel, '2026-03-08', {
          overrideScore: 28,
          overrideLabel: 'suppressed',
          confidencePolicy: 'suppress_confidence',
          confidenceOverridePoints: -5,
          policyBlockers: ['readiness_not_ready'],
          policySupports: ['blockers_reducing'],
        }),
      ],
    ...(overrides.extra || {}),
  };
}

function assertBounded(summary) {
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');

  assert(ALLOWED_DELTA_DIRECTIONS.includes(String(summary.deltaDirection || '')), `invalid deltaDirection: ${summary.deltaDirection}`);
  assert(ALLOWED_DELTA_STRENGTH.includes(String(summary.deltaStrength || '')), `invalid deltaStrength: ${summary.deltaStrength}`);
  assert(ALLOWED_MOMENTUM.includes(String(summary.momentumLabel || '')), `invalid momentumLabel: ${summary.momentumLabel}`);

  assert(Number.isFinite(Number(summary.currentOverrideScore)), 'currentOverrideScore missing');
  assert(Number(summary.currentOverrideScore) >= 0 && Number(summary.currentOverrideScore) <= 100, 'currentOverrideScore out of bounds');
  if (summary.priorOverrideScore != null) {
    assert(Number.isFinite(Number(summary.priorOverrideScore)), 'priorOverrideScore must be numeric or null');
    assert(Number(summary.priorOverrideScore) >= 0 && Number(summary.priorOverrideScore) <= 100, 'priorOverrideScore out of bounds');
  }

  const blockerLists = [
    summary.blockersAdded,
    summary.blockersRemoved,
  ];
  for (const list of blockerLists) {
    assert(Array.isArray(list), 'top-level blocker diff list missing');
    for (const item of list) {
      assert(ALLOWED_BLOCKERS.includes(String(item || '')), `unsupported blocker diff: ${item}`);
    }
  }

  const supportLists = [
    summary.supportsAdded,
    summary.supportsRemoved,
  ];
  for (const list of supportLists) {
    assert(Array.isArray(list), 'top-level support diff list missing');
    for (const item of list) {
      assert(ALLOWED_SUPPORTS.includes(String(item || '')), `unsupported support diff: ${item}`);
    }
  }

  assert(Array.isArray(summary.trustOverrideDeltaByRegime), 'trustOverrideDeltaByRegime missing');
  assert(summary.trustOverrideDeltaByRegime.length >= SUPPORTED_REGIME_LABELS.length, 'trustOverrideDeltaByRegime should include canonical labels');

  for (const row of summary.trustOverrideDeltaByRegime) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row.regimeLabel || '')), `non-canonical regime row: ${row.regimeLabel}`);
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(row.deltaDirection || '')), `row deltaDirection invalid: ${row.deltaDirection}`);
    assert(ALLOWED_DELTA_STRENGTH.includes(String(row.deltaStrength || '')), `row deltaStrength invalid: ${row.deltaStrength}`);
    assert(ALLOWED_MOMENTUM.includes(String(row.momentumLabel || '')), `row momentum invalid: ${row.momentumLabel}`);
    assert(row.advisoryOnly === true, 'row advisoryOnly must be true');
    for (const item of (Array.isArray(row.blockersAdded) ? row.blockersAdded : [])) {
      assert(ALLOWED_BLOCKERS.includes(String(item || '')), `row blockersAdded has unsupported value: ${item}`);
    }
    for (const item of (Array.isArray(row.blockersRemoved) ? row.blockersRemoved : [])) {
      assert(ALLOWED_BLOCKERS.includes(String(item || '')), `row blockersRemoved has unsupported value: ${item}`);
    }
    for (const item of (Array.isArray(row.supportsAdded) ? row.supportsAdded : [])) {
      assert(ALLOWED_SUPPORTS.includes(String(item || '')), `row supportsAdded has unsupported value: ${item}`);
    }
    for (const item of (Array.isArray(row.supportsRemoved) ? row.supportsRemoved : [])) {
      assert(ALLOWED_SUPPORTS.includes(String(item || '')), `row supportsRemoved has unsupported value: ${item}`);
    }
  }
}

function runUnitChecks() {
  const baseline = buildRegimePersistenceTrustOverrideDeltaSummary(buildFixture());
  assertBounded(baseline);

  const noPrior = buildRegimePersistenceTrustOverrideDeltaSummary(buildFixture({
    overrideHistoryRows: [
      makeHistoryOverrideRow('trending', '2026-03-08', {
        overrideScore: 30,
        overrideLabel: 'suppressed',
        confidencePolicy: 'suppress_confidence',
      }),
    ],
  }));
  assert(noPrior.priorOverrideScore == null, 'missing prior should leave priorOverrideScore null');
  assert(String(noPrior.deltaDirection) === 'flat', 'missing prior should force flat direction');
  assert(String(noPrior.deltaStrength) === 'weak', 'missing prior should force weak strength');
  assert(String(noPrior.momentumLabel) === 'stalled', 'missing prior should force stalled momentum');
  assert(Array.isArray(noPrior.warnings) && noPrior.warnings.includes('no_prior_override_snapshot'), 'missing prior warning required');

  const improving = buildRegimePersistenceTrustOverrideDeltaSummary(buildFixture({
    currentRow: {
      overrideScore: 64,
      overrideLabel: 'cautious',
      confidencePolicy: 'allow_cautious_confidence',
      confidenceOverrideAction: 'no_material_change',
      confidenceOverridePoints: 1,
      policyBlockers: ['readiness_not_ready'],
      policySupports: ['credibility_cautious', 'blockers_reducing'],
    },
    overrideHistoryRows: [
      makeHistoryOverrideRow('trending', '2026-03-07', {
        overrideScore: 42,
        overrideLabel: 'suppressed',
        confidencePolicy: 'suppress_confidence',
        confidenceOverridePoints: -5,
        policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
        policySupports: [],
      }),
      makeHistoryOverrideRow('trending', '2026-03-08', {
        overrideScore: 53,
        overrideLabel: 'cautious',
        confidencePolicy: 'allow_cautious_confidence',
        confidenceOverridePoints: 0,
        policyBlockers: ['readiness_not_ready'],
        policySupports: ['credibility_cautious'],
      }),
    ],
  }));
  assert(String(improving.deltaDirection) === 'improving', 'expected improving direction');
  assert(improving.blockersRemoved.includes('live_depth_insufficient'), 'expected blocker removal to be tracked');
  assert(['accelerating', 'steady_improvement'].includes(String(improving.momentumLabel)), 'improving case should be improving momentum');

  const regressing = buildRegimePersistenceTrustOverrideDeltaSummary(buildFixture({
    currentRow: {
      overrideScore: 18,
      overrideLabel: 'suppressed',
      confidencePolicy: 'suppress_confidence',
      confidenceOverrideAction: 'decrease_confidence',
      confidenceOverridePoints: -10,
      policyBlockers: ['credibility_blocked', 'readiness_not_ready', 'live_depth_insufficient'],
      policySupports: [],
    },
    overrideHistoryRows: [
      makeHistoryOverrideRow('trending', '2026-03-07', {
        overrideScore: 78,
        overrideLabel: 'enabled',
        confidencePolicy: 'allow_structured_confidence',
        confidenceOverridePoints: 4,
        policyBlockers: ['delta_not_supportive'],
        policySupports: ['credibility_operational', 'readiness_ready', 'quality_live_ready'],
      }),
      makeHistoryOverrideRow('trending', '2026-03-08', {
        overrideScore: 74,
        overrideLabel: 'enabled',
        confidencePolicy: 'allow_structured_confidence',
        confidenceOverridePoints: 3,
        policyBlockers: ['delta_not_supportive'],
        policySupports: ['credibility_operational', 'readiness_ready'],
      }),
    ],
  }));
  assert(String(regressing.deltaDirection) === 'regressing', 'regressing direction expected');
  assert(String(regressing.momentumLabel) === 'deteriorating', 'regressing case should deteriorate');
  assert(regressing.policyChanged === true || regressing.labelChanged === true, 'policy/label should reflect deterioration');

  const oscillating = buildRegimePersistenceTrustOverrideDeltaSummary(buildFixture({
    currentRow: {
      overrideScore: 51,
      overrideLabel: 'cautious',
      confidencePolicy: 'allow_cautious_confidence',
      confidenceOverridePoints: 0,
      policyBlockers: ['readiness_not_ready', 'coverage_insufficient'],
      policySupports: ['credibility_cautious', 'delta_supportive'],
    },
    overrideHistoryRows: [
      makeHistoryOverrideRow('trending', '2026-03-07', {
        overrideScore: 49,
        overrideLabel: 'cautious',
        confidencePolicy: 'allow_cautious_confidence',
        confidenceOverridePoints: 0,
        policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
        policySupports: ['credibility_cautious', 'blockers_reducing'],
      }),
      makeHistoryOverrideRow('trending', '2026-03-08', {
        overrideScore: 50,
        overrideLabel: 'cautious',
        confidencePolicy: 'allow_cautious_confidence',
        confidenceOverridePoints: 0,
        policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
        policySupports: ['credibility_cautious', 'blockers_reducing'],
      }),
    ],
  }));
  assert(String(oscillating.deltaDirection) === 'flat', 'oscillating fixture should be flat delta');
  assert(String(oscillating.momentumLabel) === 'oscillating', 'mixed blocker/support changes should classify as oscillating');

  const reconstructedDominant = buildRegimePersistenceTrustOverrideDeltaSummary(buildFixture({
    currentRow: {
      overrideScore: 62,
      overrideLabel: 'cautious',
      confidencePolicy: 'allow_cautious_confidence',
      confidenceOverridePoints: 1,
      policyBlockers: ['readiness_not_ready'],
      policySupports: ['credibility_cautious', 'delta_supportive', 'blockers_reducing'],
    },
    regimePersistenceReadiness: {
      persistenceSource: 'persisted_reconstructed_history',
    },
    regimeConfirmationHistory: {
      historyCoverageDays: 2,
      historyProvenanceBreakdown: {
        liveCapturedDays: 1,
        reconstructedDays: 8,
        mixedDays: 0,
      },
    },
    overrideHistoryRows: [
      makeHistoryOverrideRow('trending', '2026-03-07', {
        overrideScore: 40,
        overrideLabel: 'suppressed',
        confidencePolicy: 'suppress_confidence',
        confidenceOverridePoints: -3,
        policyBlockers: ['readiness_not_ready', 'live_depth_insufficient'],
        policySupports: [],
      }),
      makeHistoryOverrideRow('trending', '2026-03-08', {
        overrideScore: 47,
        overrideLabel: 'cautious',
        confidencePolicy: 'allow_cautious_confidence',
        confidenceOverridePoints: 0,
        policyBlockers: ['readiness_not_ready'],
        policySupports: ['credibility_cautious'],
      }),
    ],
  }));
  assert(String(reconstructedDominant.deltaDirection) === 'improving', 'fixture should still show improving delta');
  assert(String(reconstructedDominant.momentumLabel) !== 'accelerating', 'reconstructed-dominant history cannot classify as accelerating');

  assertBounded(reconstructedDominant);
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
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-trust-override-delta?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'endpoint should return ok');
    const summary = out?.regimePersistenceTrustOverrideDelta;
    assert(summary && typeof summary === 'object', 'regimePersistenceTrustOverrideDelta missing');
    assertBounded(summary);
    assert(typeof summary.trustOverrideDeltaInsight === 'string' && summary.trustOverrideDeltaInsight.length > 0, 'trustOverrideDeltaInsight missing');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimePersistenceTrustOverrideDelta && typeof center.regimePersistenceTrustOverrideDelta === 'object', 'top-level regimePersistenceTrustOverrideDelta missing in command-center response');

    const cc = center?.commandCenter || {};
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(cc.regimePersistenceTrustDeltaDirection || '')), 'commandCenter.regimePersistenceTrustDeltaDirection invalid');
    assert(ALLOWED_DELTA_STRENGTH.includes(String(cc.regimePersistenceTrustDeltaStrength || '')), 'commandCenter.regimePersistenceTrustDeltaStrength invalid');
    assert(ALLOWED_MOMENTUM.includes(String(cc.regimePersistenceTrustMomentumLabel || '')), 'commandCenter.regimePersistenceTrustMomentumLabel invalid');
    assert(Number.isFinite(Number(cc.regimePersistenceTrustScoreDelta)), 'commandCenter.regimePersistenceTrustScoreDelta missing');
    assert(Number.isFinite(Number(cc.regimePersistenceTrustPointsDelta)), 'commandCenter.regimePersistenceTrustPointsDelta missing');
    assert(Array.isArray(cc.regimePersistenceTrustBlockersAdded), 'commandCenter.regimePersistenceTrustBlockersAdded missing');
    assert(Array.isArray(cc.regimePersistenceTrustBlockersRemoved), 'commandCenter.regimePersistenceTrustBlockersRemoved missing');
    assert(Array.isArray(cc.regimePersistenceTrustSupportsAdded), 'commandCenter.regimePersistenceTrustSupportsAdded missing');
    assert(Array.isArray(cc.regimePersistenceTrustSupportsRemoved), 'commandCenter.regimePersistenceTrustSupportsRemoved missing');
    assert(typeof cc.regimePersistenceTrustDeltaInsight === 'string' && cc.regimePersistenceTrustDeltaInsight.length > 0, 'commandCenter.regimePersistenceTrustDeltaInsight missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_MOMENTUM.includes(String(cc.decisionBoard.regimePersistenceTrustMomentumLabel || '')), 'decisionBoard.regimePersistenceTrustMomentumLabel invalid');
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(cc.decisionBoard.regimePersistenceTrustDeltaDirection || '')), 'decisionBoard.regimePersistenceTrustDeltaDirection invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_MOMENTUM.includes(String(cc.todayRecommendation.regimePersistenceTrustMomentumLabel || '')), 'todayRecommendation.regimePersistenceTrustMomentumLabel invalid');
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(cc.todayRecommendation.regimePersistenceTrustDeltaDirection || '')), 'todayRecommendation.regimePersistenceTrustDeltaDirection invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimePersistenceTrustScoreDelta)), 'todayRecommendation.regimePersistenceTrustScoreDelta missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ regime persistence trust override delta checks passed');
  } catch (err) {
    console.error('❌ regime persistence trust override delta checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
