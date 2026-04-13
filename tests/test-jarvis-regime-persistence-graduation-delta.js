#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildRegimePersistenceGraduationDeltaSummary,
} = require('../server/jarvis-core/regime-persistence-graduation-delta');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 240000;
const TRANSIENT_FETCH_RETRIES = 3;
const TRANSIENT_FETCH_RETRY_DELAY_MS = 250;
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
const ALLOWED_MOMENTUM_LABELS = [
  'accelerating',
  'steady_progress',
  'stalled',
  'oscillating',
  'slipping',
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

function makeHistoryRow(overrides = {}) {
  const date = String(overrides.snapshot_date || overrides.date || '2026-03-01');
  const regimeLabel = String(overrides.regime_label || overrides.regimeLabel || 'trending').trim().toLowerCase();
  return {
    snapshot_date: date,
    window_sessions: 120,
    performance_source: 'all',
    regime_label: regimeLabel,
    promotion_state: overrides.promotion_state || 'emerging_live_support',
    promotion_reason: overrides.promotion_reason || `${regimeLabel} ${overrides.promotion_state || 'emerging_live_support'}`,
    confirmation_progress_pct: Number.isFinite(Number(overrides.confirmation_progress_pct)) ? Number(overrides.confirmation_progress_pct) : 30,
    live_sample_size: Number.isFinite(Number(overrides.live_sample_size)) ? Number(overrides.live_sample_size) : 6,
    required_sample_for_promotion: Number.isFinite(Number(overrides.required_sample_for_promotion))
      ? Number(overrides.required_sample_for_promotion)
      : ((regimeLabel === 'mixed' || regimeLabel === 'unknown') ? 30 : 15),
    trust_bias_label: overrides.trust_bias_label || 'mixed_support',
    trust_consumption_label: overrides.trust_consumption_label || 'allow_with_caution',
    confidence_adjustment_override: Number.isFinite(Number(overrides.confidence_adjustment_override)) ? Number(overrides.confidence_adjustment_override) : 0,
    all_evidence_usefulness_label: overrides.all_evidence_usefulness_label || 'moderate',
    live_only_usefulness_label: overrides.live_only_usefulness_label || 'moderate',
    score_gap: Number.isFinite(Number(overrides.score_gap)) ? Number(overrides.score_gap) : 0,
    provenance_strength_label: overrides.provenance_strength_label || 'direct',
    evidence_quality: overrides.evidence_quality || 'mixed',
    persistence_provenance: overrides.persistence_provenance || 'live_captured',
    reconstruction_confidence: overrides.reconstruction_confidence || 'high',
    live_capture_count: Number.isFinite(Number(overrides.live_capture_count)) ? Number(overrides.live_capture_count) : 1,
  };
}

function buildBaseRows(overrides = {}) {
  const regimeLabel = String(overrides.regimeLabel || 'trending').trim().toLowerCase();
  return [
    makeHistoryRow({
      date: '2026-03-01',
      regime_label: regimeLabel,
      promotion_state: 'emerging_live_support',
      confirmation_progress_pct: 28,
      live_sample_size: 6,
      ...overrides.day1,
    }),
    makeHistoryRow({
      date: '2026-03-02',
      regime_label: regimeLabel,
      promotion_state: 'near_live_confirmation',
      confirmation_progress_pct: 52,
      live_sample_size: 11,
      ...overrides.day2,
    }),
    makeHistoryRow({
      date: '2026-03-03',
      regime_label: regimeLabel,
      promotion_state: 'live_confirmed',
      trust_consumption_label: 'allow_regime_confidence',
      confirmation_progress_pct: 76,
      live_sample_size: 18,
      evidence_quality: 'strong_live',
      ...overrides.day3,
    }),
  ];
}

function buildSummary({
  historyRows,
  currentRegimeLabel = 'trending',
  graduationMilestone = 'durability_building',
  graduationProgressScore = 80,
  remainingRequirements = ['improve_durability'],
  readyForOperationalUse = false,
} = {}) {
  return buildRegimePersistenceGraduationDeltaSummary({
    windowSessions: 120,
    performanceSource: 'all',
    historyRows: Array.isArray(historyRows) ? historyRows : buildBaseRows(),
    regimePersistenceGraduation: {
      currentRegimeLabel,
      graduationMilestone,
      graduationProgressScore,
      remainingRequirements,
      readyForOperationalUse,
    },
  });
}

function assertBoundedSummary(summary) {
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(SUPPORTED_REGIME_LABELS.includes(String(summary.currentRegimeLabel || '')), 'currentRegimeLabel must be canonical');
  assert(ALLOWED_DELTA_DIRECTIONS.includes(String(summary.deltaDirection || '')), `invalid summary deltaDirection: ${summary.deltaDirection}`);
  assert(ALLOWED_DELTA_STRENGTH.includes(String(summary.deltaStrength || '')), `invalid summary deltaStrength: ${summary.deltaStrength}`);
  assert(ALLOWED_MOMENTUM_LABELS.includes(String(summary.momentumLabel || '')), `invalid summary momentumLabel: ${summary.momentumLabel}`);

  for (const requirement of (summary.blockersAdded || [])) {
    assert(ALLOWED_REQUIREMENTS.includes(String(requirement || '')), `invalid blockersAdded requirement: ${requirement}`);
  }
  for (const requirement of (summary.blockersRemoved || [])) {
    assert(ALLOWED_REQUIREMENTS.includes(String(requirement || '')), `invalid blockersRemoved requirement: ${requirement}`);
  }
  for (const requirement of (summary.blockersUnchanged || [])) {
    assert(ALLOWED_REQUIREMENTS.includes(String(requirement || '')), `invalid blockersUnchanged requirement: ${requirement}`);
  }

  for (const row of (summary.graduationDeltaByRegime || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row.regimeLabel || '')), `invalid per-row regimeLabel: ${row.regimeLabel}`);
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(row.deltaDirection || '')), `invalid per-row deltaDirection: ${row.deltaDirection}`);
    assert(ALLOWED_DELTA_STRENGTH.includes(String(row.deltaStrength || '')), `invalid per-row deltaStrength: ${row.deltaStrength}`);
    assert(ALLOWED_MOMENTUM_LABELS.includes(String(row.momentumLabel || '')), `invalid per-row momentumLabel: ${row.momentumLabel}`);
    assert(row.advisoryOnly === true, `per-row advisoryOnly must be true for ${row.regimeLabel}`);
  }

  for (const label of (summary.progressingRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid progressingRegimeLabels entry: ${label}`);
  }
  for (const label of (summary.regressingRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid regressingRegimeLabels entry: ${label}`);
  }
  for (const label of (summary.stalledRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid stalledRegimeLabels entry: ${label}`);
  }
  for (const label of (summary.oscillatingRegimeLabels || [])) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(label || '')), `invalid oscillatingRegimeLabels entry: ${label}`);
  }
}

function runUnitChecks() {
  const summary = buildSummary();
  assertBoundedSummary(summary);

  const trend = (summary.graduationDeltaByRegime || []).find((row) => row.regimeLabel === 'trending');
  assert(trend, 'trending row missing');
  assert(typeof trend.milestoneFrom === 'undefined', 'per-row milestoneFrom should not leak into row schema');

  const accelerating = buildSummary({
    historyRows: buildBaseRows(),
    currentRegimeLabel: 'trending',
    graduationMilestone: 'durability_building',
    graduationProgressScore: 80,
    remainingRequirements: ['improve_durability'],
    readyForOperationalUse: false,
  });
  assert(String(accelerating.deltaDirection) === 'improving', 'accelerating fixture should be improving');
  assert(String(accelerating.momentumLabel) === 'accelerating', 'improving + blocker reduction + milestone forward should classify accelerating');
  assert((accelerating.blockersAdded || []).length === 0, 'accelerating fixture should not add blockers');
  assert((accelerating.blockersRemoved || []).length >= 1, 'accelerating fixture should remove blockers');
  assert(accelerating.milestoneChanged === true, 'accelerating fixture should show milestone changed');
  assert(String(accelerating.milestoneFrom || '') !== String(accelerating.milestoneTo || ''), 'accelerating milestone should move forward');

  const oscillating = buildSummary({
    historyRows: buildBaseRows(),
    currentRegimeLabel: 'trending',
    graduationMilestone: 'durability_building',
    graduationProgressScore: 75,
    remainingRequirements: ['improve_durability', 'confirm_live_cadence'],
    readyForOperationalUse: false,
  });
  assert(String(oscillating.momentumLabel) === 'oscillating', 'mixed blocker adds/removals should classify oscillating');
  assert((oscillating.blockersAdded || []).includes('confirm_live_cadence'), 'oscillating fixture should include blocker addition');
  assert((oscillating.blockersRemoved || []).length >= 1, 'oscillating fixture should include blocker removals');

  const reconstructedHeavy = buildSummary({
    historyRows: buildBaseRows({
      day1: {
        persistence_provenance: 'reconstructed_from_historical_sources',
        live_capture_count: 0,
        evidence_quality: 'retrospective_heavy',
        trust_bias_label: 'retrospective_led',
        trust_consumption_label: 'reduce_regime_weight',
      },
      day2: {
        persistence_provenance: 'reconstructed_from_historical_sources',
        live_capture_count: 0,
        evidence_quality: 'retrospective_heavy',
        trust_bias_label: 'retrospective_led',
        trust_consumption_label: 'reduce_regime_weight',
      },
      day3: {
        persistence_provenance: 'reconstructed_from_historical_sources',
        live_capture_count: 0,
        evidence_quality: 'retrospective_heavy',
        trust_bias_label: 'retrospective_led',
        trust_consumption_label: 'reduce_regime_weight',
      },
    }),
    currentRegimeLabel: 'trending',
    graduationMilestone: 'durability_building',
    graduationProgressScore: 72,
    remainingRequirements: ['improve_durability', 'reduce_reconstructed_share'],
    readyForOperationalUse: false,
  });
  assert(String(reconstructedHeavy.deltaDirection) === 'improving', 'reconstructed-heavy fixture can still be improving');
  assert(String(reconstructedHeavy.momentumLabel) !== 'accelerating', 'reconstructed-heavy history must not overclaim accelerating momentum');
  assert((reconstructedHeavy.warnings || []).includes('reconstructed_dominant_history'), 'reconstructed-heavy warning missing');

  const noPrior = buildSummary({
    historyRows: [makeHistoryRow({
      date: '2026-03-03',
      regime_label: 'trending',
      promotion_state: 'emerging_live_support',
      persistence_provenance: 'reconstructed_from_historical_sources',
      live_capture_count: 0,
      evidence_quality: 'thin',
      trust_bias_label: 'insufficient_live_confirmation',
      trust_consumption_label: 'suppress_regime_bias',
      live_sample_size: 3,
      all_evidence_usefulness_label: 'insufficient',
      live_only_usefulness_label: 'insufficient',
      provenance_strength_label: 'absent',
    })],
    currentRegimeLabel: 'trending',
    graduationMilestone: 'live_base_established',
    graduationProgressScore: 30,
    remainingRequirements: ['add_live_tenure'],
    readyForOperationalUse: false,
  });
  assert(noPrior.priorGraduationProgressScore === null, 'no prior snapshot should keep priorGraduationProgressScore null');
  assert(String(noPrior.deltaDirection) === 'flat', 'no prior snapshot should default to flat direction');
  assert(String(noPrior.deltaStrength) === 'weak', 'no prior snapshot should default to weak delta strength');
  assert(String(noPrior.momentumLabel) === 'stalled', 'no prior snapshot should default to stalled momentum');
  assert(noPrior.milestoneChanged === false, 'no prior snapshot should not mark milestone changed');
  assert(noPrior.milestoneFrom === null, 'no prior snapshot should keep milestoneFrom null');
  assert((noPrior.warnings || []).includes('no_prior_snapshot'), 'no prior snapshot warning missing');
}

async function getJson(baseUrl, endpoint) {
  let lastErr = null;
  for (let attempt = 0; attempt <= TRANSIENT_FETCH_RETRIES; attempt += 1) {
    try {
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) {
      const message = String(err?.message || err || '');
      const transient = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated|timed out|timeout|aborted/i.test(message);
      if (!transient || attempt >= TRANSIENT_FETCH_RETRIES) {
        throw err;
      }
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_FETCH_RETRY_DELAY_MS));
    }
  }
  throw lastErr || new Error(`fetch failed: ${endpoint}`);
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    // Use an ephemeral port by default to avoid cross-suite port reuse flakes.
    port: process.env.JARVIS_AUDIT_PORT || 0,
    env: {
      DATABENTO_API_ENABLED: 'false',
      DATABENTO_API_KEY: '',
      TOPSTEP_API_ENABLED: 'false',
      TOPSTEP_API_KEY: '',
      NEWS_ENABLED: 'false',
      DISCORD_BOT_TOKEN: '',
    },
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/regime/persistence-graduation-delta?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'endpoint should return ok');
    const delta = out?.regimePersistenceGraduationDelta;
    assert(delta && typeof delta === 'object', 'regimePersistenceGraduationDelta missing');
    assert(delta.advisoryOnly === true, 'regimePersistenceGraduationDelta must be advisoryOnly');
    assertBoundedSummary(delta);
    assert(typeof delta.regimeProgressDeltaInsight === 'string' && delta.regimeProgressDeltaInsight.length > 0, 'regimeProgressDeltaInsight missing');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.regimePersistenceGraduationDelta && typeof center.regimePersistenceGraduationDelta === 'object', 'top-level regimePersistenceGraduationDelta missing in command-center response');

    const cc = center?.commandCenter || {};
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(cc.regimePersistenceDeltaDirection || '')), 'commandCenter.regimePersistenceDeltaDirection invalid');
    assert(ALLOWED_DELTA_STRENGTH.includes(String(cc.regimePersistenceDeltaStrength || '')), 'commandCenter.regimePersistenceDeltaStrength invalid');
    assert(ALLOWED_MOMENTUM_LABELS.includes(String(cc.regimePersistenceMomentumLabel || '')), 'commandCenter.regimePersistenceMomentumLabel invalid');
    assert(Number.isFinite(Number(cc.regimePersistenceDeltaScore)), 'commandCenter.regimePersistenceDeltaScore missing');
    assert(Array.isArray(cc.regimePersistenceBlockersAdded), 'commandCenter.regimePersistenceBlockersAdded missing');
    assert(Array.isArray(cc.regimePersistenceBlockersRemoved), 'commandCenter.regimePersistenceBlockersRemoved missing');
    assert(typeof cc.regimePersistenceDeltaInsight === 'string' && cc.regimePersistenceDeltaInsight.length > 0, 'commandCenter.regimePersistenceDeltaInsight missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_MOMENTUM_LABELS.includes(String(cc.decisionBoard.regimePersistenceMomentumLabel || '')), 'decisionBoard.regimePersistenceMomentumLabel invalid');
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(cc.decisionBoard.regimePersistenceDeltaDirection || '')), 'decisionBoard.regimePersistenceDeltaDirection invalid');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_MOMENTUM_LABELS.includes(String(cc.todayRecommendation.regimePersistenceMomentumLabel || '')), 'todayRecommendation.regimePersistenceMomentumLabel invalid');
    assert(ALLOWED_DELTA_DIRECTIONS.includes(String(cc.todayRecommendation.regimePersistenceDeltaDirection || '')), 'todayRecommendation.regimePersistenceDeltaDirection invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimePersistenceDeltaScore)), 'todayRecommendation.regimePersistenceDeltaScore missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime persistence graduation delta tests passed.');
  } catch (err) {
    console.error(`Jarvis regime persistence graduation delta test failed: ${err.message}`);
    process.exit(1);
  }
})();
