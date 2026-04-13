'use strict';

const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');
const {
  buildRegimePersistenceReadinessSummary,
} = require('./regime-persistence-readiness');
const {
  buildRegimePersistenceGraduationSummary,
} = require('./regime-persistence-graduation');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const ALLOWED_DELTA_DIRECTIONS = new Set([
  'improving',
  'flat',
  'regressing',
]);

const ALLOWED_DELTA_STRENGTH = new Set([
  'strong',
  'moderate',
  'weak',
]);

const ALLOWED_MOMENTUM_LABELS = new Set([
  'accelerating',
  'steady_progress',
  'stalled',
  'oscillating',
  'slipping',
]);

const ALLOWED_REQUIREMENTS = new Set([
  'add_live_tenure',
  'increase_live_coverage',
  'reduce_reconstructed_share',
  'improve_durability',
  'improve_persistence_quality',
  'confirm_live_cadence',
  'establish_live_base',
]);

const MILESTONE_RANK = new Map([
  ['no_live_base', 0],
  ['live_base_established', 1],
  ['live_depth_building', 2],
  ['durability_building', 3],
  ['nearing_operational_readiness', 4],
  ['operationally_ready', 5],
]);

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeDate(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function normalizePerformanceSource(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live' || txt === 'backfill') return txt;
  return 'all';
}

function safeCanonicalRegimeLabel(value) {
  const label = normalizeRegimeLabel(value || 'unknown');
  return SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
}

function normalizePersistenceProvenance(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'live_captured'
    || txt === 'reconstructed_from_historical_sources'
    || txt === 'mixed'
  ) {
    return txt;
  }
  return 'reconstructed_from_historical_sources';
}

function normalizePromotionState(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'no_live_support'
    || txt === 'emerging_live_support'
    || txt === 'near_live_confirmation'
    || txt === 'live_confirmed'
    || txt === 'stalled_live_support'
  ) {
    return txt;
  }
  return 'no_live_support';
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
}

function normalizeTrustBiasLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_confirmed') return 'live_confirmed';
  if (txt === 'mixed_support') return 'mixed_support';
  if (txt === 'retrospective_led') return 'retrospective_led';
  return 'insufficient_live_confirmation';
}

function normalizeEvidenceQuality(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong_live' || txt === 'mixed' || txt === 'retrospective_heavy' || txt === 'thin') return txt;
  return 'thin';
}

function normalizeMilestone(value) {
  const txt = toText(value).toLowerCase();
  return MILESTONE_RANK.has(txt) ? txt : 'no_live_base';
}

function normalizeRequirements(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toText(item).toLowerCase())
    .filter((item) => ALLOWED_REQUIREMENTS.has(item));
}

function rowHasLiveCapturedEvidence(row = {}) {
  const count = Math.max(0, Number(row.live_capture_count || 0));
  if (count > 0) return true;
  const provenance = normalizePersistenceProvenance(row.persistence_provenance || 'reconstructed_from_historical_sources');
  return provenance === 'live_captured' || provenance === 'mixed';
}

function derivePersistenceSourceFromCounts(counts = {}) {
  const liveCapturedDays = Math.max(0, Number(counts.liveCapturedDays || 0));
  const reconstructedDays = Math.max(0, Number(counts.reconstructedDays || 0));
  const mixedDays = Math.max(0, Number(counts.mixedDays || 0));
  if (mixedDays > 0 || (liveCapturedDays > 0 && reconstructedDays > 0)) return 'mixed_persisted_history';
  if (liveCapturedDays > 0 && reconstructedDays <= 0) return 'persisted_live_history';
  if (reconstructedDays > 0) return 'persisted_reconstructed_history';
  return 'proxy_only';
}

function deriveDurabilityState(input = {}) {
  const promotionState = normalizePromotionState(input.promotionState);
  const trustLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const evidenceQuality = normalizeEvidenceQuality(input.evidenceQuality);

  if (promotionState === 'live_confirmed') {
    if (trustLabel === 'allow_regime_confidence' && evidenceQuality !== 'retrospective_heavy') return 'durable_confirmed';
    if (trustLabel === 'allow_with_caution') return 'building_durability';
    if (trustLabel === 'reduce_regime_weight') return 'fragile_confirmation';
    return 'decaying_confirmation';
  }
  if (promotionState === 'near_live_confirmation' || promotionState === 'emerging_live_support') {
    return 'building_durability';
  }
  if (promotionState === 'stalled_live_support') {
    return 'decaying_confirmation';
  }
  return 'unconfirmed';
}

function deriveCadenceLabel(input = {}) {
  const hasLiveCapturedHistory = input.hasLiveCapturedHistory === true;
  const liveCapturedTenureDays = Math.max(0, Number(input.liveCapturedTenureDays || 0));
  const liveCoveragePct = clamp(Number(input.liveCoveragePct || 0), 0, 100);
  const captureGapDays = toNumber(input.captureGapDays, null);

  if (!hasLiveCapturedHistory || !Number.isFinite(captureGapDays) || captureGapDays > 7) return 'stale';
  if (captureGapDays <= 1 && liveCoveragePct >= 50) return 'healthy';
  if (liveCapturedTenureDays >= 2 && liveCoveragePct >= 20) return 'improving';
  return 'sparse';
}

function deriveDurabilityConstraint(input = {}) {
  const durabilityState = toText(input.durabilityState).toLowerCase();
  const cadenceLabel = toText(input.cadenceLabel).toLowerCase();
  const persistenceQualityLabel = toText(input.persistenceQualityLabel).toLowerCase();
  const trustLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const weakDurability = (
    durabilityState === 'unconfirmed'
    || durabilityState === 'building_durability'
    || durabilityState === 'fragile_confirmation'
    || durabilityState === 'decaying_confirmation'
  );
  const captureLimited = weakDurability && (cadenceLabel === 'sparse' || cadenceLabel === 'stale');
  const depthLimited = weakDurability && persistenceQualityLabel === 'insufficient_live_depth';
  const qualityLimited = weakDurability && (
    trustLabel === 'reduce_regime_weight'
    || trustLabel === 'suppress_regime_bias'
  );
  const factors = [captureLimited, depthLimited, qualityLimited].filter(Boolean).length;
  if (factors >= 2) return 'mixed_constraints';
  if (captureLimited) return 'capture_cadence_limited';
  if (depthLimited) return 'live_depth_limited';
  if (qualityLimited) return 'regime_quality_limited';
  return 'regime_quality_limited';
}

function collectDistinctRecentDates(rows = [], windowSessions = DEFAULT_WINDOW_SESSIONS) {
  const unique = Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => normalizeDate(row.snapshot_date || ''))
    .filter(Boolean)));
  unique.sort((a, b) => a.localeCompare(b));
  if (unique.length <= windowSessions) return unique;
  return unique.slice(unique.length - windowSessions);
}

function daysBetween(leftDate = '', rightDate = '') {
  const left = normalizeDate(leftDate);
  const right = normalizeDate(rightDate);
  if (!left || !right) return null;
  const a = new Date(`${left}T00:00:00.000Z`);
  const b = new Date(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return null;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

function buildAggregateMeta(rowsUpToDate = [], targetDate = '') {
  const rows = Array.isArray(rowsUpToDate) ? rowsUpToDate : [];
  const liveCapturedDays = rows.filter((row) => normalizePersistenceProvenance(row.persistence_provenance) === 'live_captured').length;
  const reconstructedDays = rows.filter((row) => normalizePersistenceProvenance(row.persistence_provenance) === 'reconstructed_from_historical_sources').length;
  const mixedDays = rows.filter((row) => normalizePersistenceProvenance(row.persistence_provenance) === 'mixed').length;
  const totalSnapshots = rows.length;

  let liveCapturedTenureDays = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rowHasLiveCapturedEvidence(rows[i])) liveCapturedTenureDays += 1;
    else break;
  }

  let lastLiveCapturedDate = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rowHasLiveCapturedEvidence(rows[i])) {
      lastLiveCapturedDate = normalizeDate(rows[i].snapshot_date || '');
      break;
    }
  }

  const liveCoveragePct = totalSnapshots > 0
    ? round2(clamp(((liveCapturedDays + mixedDays) / totalSnapshots) * 100, 0, 100))
    : 0;
  const hasLiveCapturedHistory = liveCapturedTenureDays > 0 || liveCapturedDays > 0 || mixedDays > 0;
  const persistenceSource = derivePersistenceSourceFromCounts({ liveCapturedDays, reconstructedDays, mixedDays });
  const captureGapDays = daysBetween(lastLiveCapturedDate, targetDate);

  return {
    totalSnapshots,
    liveCapturedDays,
    reconstructedDays,
    mixedDays,
    liveCapturedTenureDays,
    lastLiveCapturedDate,
    liveCoveragePct,
    hasLiveCapturedHistory,
    persistenceSource,
    captureGapDays,
  };
}

function buildSyntheticSummaries(regimeLabel = 'unknown', latestRow = {}, aggregate = {}) {
  const safeRegime = safeCanonicalRegimeLabel(regimeLabel);
  const promotionState = normalizePromotionState(latestRow.promotion_state || 'no_live_support');
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(latestRow.trust_consumption_label || 'suppress_regime_bias');
  const trustBiasLabel = normalizeTrustBiasLabel(latestRow.trust_bias_label || 'insufficient_live_confirmation');
  const evidenceQuality = normalizeEvidenceQuality(latestRow.evidence_quality || 'thin');
  const durabilityState = deriveDurabilityState({ promotionState, trustConsumptionLabel, evidenceQuality });

  const persistenceQualityLabel = (
    aggregate.persistenceSource === 'persisted_live_history' && aggregate.hasLiveCapturedHistory && aggregate.liveCapturedTenureDays >= 5
      ? 'live_ready'
      : (!aggregate.hasLiveCapturedHistory || aggregate.liveCapturedTenureDays < 3)
        ? 'insufficient_live_depth'
        : ((aggregate.persistenceSource === 'mixed_persisted_history' || aggregate.persistenceSource === 'persisted_reconstructed_history')
          && aggregate.reconstructedDays > aggregate.liveCapturedDays)
          ? 'mostly_reconstructed'
          : 'partially_live_supported'
  );
  const cadenceLabel = deriveCadenceLabel({
    hasLiveCapturedHistory: aggregate.hasLiveCapturedHistory,
    liveCapturedTenureDays: aggregate.liveCapturedTenureDays,
    liveCoveragePct: aggregate.liveCoveragePct,
    captureGapDays: aggregate.captureGapDays,
  });
  const durabilityConstraint = deriveDurabilityConstraint({
    durabilityState,
    cadenceLabel,
    persistenceQualityLabel,
    trustConsumptionLabel,
  });

  const provenanceBreakdown = {
    liveCapturedDays: aggregate.liveCapturedDays,
    reconstructedDays: aggregate.reconstructedDays,
    mixedDays: aggregate.mixedDays,
  };

  const regimeConfirmationHistory = {
    currentRegimeLabel: safeRegime,
    currentRegimeHasLiveCapturedHistory: aggregate.hasLiveCapturedHistory,
    currentRegimeLiveCapturedTenureDays: aggregate.liveCapturedTenureDays,
    historyProvenanceBreakdown: provenanceBreakdown,
    byRegime: [
      {
        regimeLabel: safeRegime,
        hasLiveCapturedHistory: aggregate.hasLiveCapturedHistory,
        liveCapturedTenureDays: aggregate.liveCapturedTenureDays,
        provenanceBreakdown,
      },
    ],
    advisoryOnly: true,
  };

  const regimeConfirmationDurability = {
    currentRegimeLabel: safeRegime,
    currentRegimeDurabilityState: durabilityState,
    persistenceSource: aggregate.persistenceSource,
    durabilityByRegime: [
      {
        regimeLabel: safeRegime,
        durabilityState,
        persistenceSource: aggregate.persistenceSource,
        hasLiveCapturedHistory: aggregate.hasLiveCapturedHistory,
        liveCapturedTenureDays: aggregate.liveCapturedTenureDays,
        provenanceBreakdown,
      },
    ],
    advisoryOnly: true,
  };

  const regimeLivePersistenceQuality = {
    currentRegimeLabel: safeRegime,
    currentRegimeLiveCadenceLabel: cadenceLabel,
    currentRegimePersistenceQualityLabel: persistenceQualityLabel,
    currentRegimeDurabilityConstraint: durabilityConstraint,
    currentRegimeCaptureGapDays: Number.isFinite(Number(aggregate.captureGapDays)) ? Number(aggregate.captureGapDays) : null,
    liveCaptureCoveragePct: aggregate.liveCoveragePct,
    advisoryOnly: true,
  };

  const liveRegimeConfirmation = {
    currentRegimeLabel: safeRegime,
    currentRegimePromotionState: promotionState,
    advisoryOnly: true,
  };

  const regimeTrustConsumption = {
    currentRegimeLabel: safeRegime,
    trustBiasLabel,
    trustConsumptionLabel,
    confidenceAdjustmentOverride: Number.isFinite(Number(latestRow.confidence_adjustment_override))
      ? Number(latestRow.confidence_adjustment_override)
      : 0,
    advisoryOnly: true,
  };

  const readiness = buildRegimePersistenceReadinessSummary({
    windowSessions: DEFAULT_WINDOW_SESSIONS,
    performanceSource: 'all',
    regimeConfirmationHistory,
    regimeConfirmationDurability,
    regimeLivePersistenceQuality,
    liveRegimeConfirmation,
    regimeTrustConsumption,
  });

  const graduation = buildRegimePersistenceGraduationSummary({
    windowSessions: DEFAULT_WINDOW_SESSIONS,
    performanceSource: 'all',
    regimePersistenceReadiness: readiness,
    regimeLivePersistenceQuality,
    regimeConfirmationDurability,
    regimeConfirmationHistory,
  });

  return {
    readiness,
    graduation,
    regimeLivePersistenceQuality,
    regimeConfirmationDurability,
    regimeConfirmationHistory,
    meta: {
      persistenceSource: aggregate.persistenceSource,
      liveCapturedTenureDays: aggregate.liveCapturedTenureDays,
      liveCoveragePct: aggregate.liveCoveragePct,
      hasLiveCapturedHistory: aggregate.hasLiveCapturedHistory,
      totalSnapshots: aggregate.totalSnapshots,
      liveCapturedDays: aggregate.liveCapturedDays,
      reconstructedDays: aggregate.reconstructedDays,
      mixedDays: aggregate.mixedDays,
      captureGapDays: aggregate.captureGapDays,
    },
  };
}

function classifyDeltaDirection(deltaProgressScore = 0) {
  const delta = Number(deltaProgressScore || 0);
  if (delta > 5) return 'improving';
  if (delta < -5) return 'regressing';
  return 'flat';
}

function classifyDeltaStrength(deltaProgressScore = 0) {
  const absDelta = Math.abs(Number(deltaProgressScore || 0));
  if (absDelta >= 15) return 'strong';
  if (absDelta >= 7) return 'moderate';
  return 'weak';
}

function diffRequirements(currentList = [], priorList = []) {
  const current = normalizeRequirements(currentList);
  const prior = normalizeRequirements(priorList);
  const currentSet = new Set(current);
  const priorSet = new Set(prior);

  const blockersAdded = current.filter((item) => !priorSet.has(item));
  const blockersRemoved = prior.filter((item) => !currentSet.has(item));
  const blockersUnchanged = current.filter((item) => priorSet.has(item));

  return {
    currentRemainingRequirements: current,
    priorRemainingRequirements: prior,
    blockersAdded,
    blockersRemoved,
    blockersUnchanged,
  };
}

function milestoneDelta(input = {}) {
  const currentMilestone = normalizeMilestone(input.currentMilestone);
  const priorMilestone = input.hasPrior ? normalizeMilestone(input.priorMilestone) : null;
  const currentRank = MILESTONE_RANK.get(currentMilestone) || 0;
  const priorRank = priorMilestone ? (MILESTONE_RANK.get(priorMilestone) || 0) : 0;
  return {
    milestoneChanged: Boolean(priorMilestone && currentMilestone !== priorMilestone),
    milestoneFrom: priorMilestone,
    milestoneTo: currentMilestone,
    milestoneForward: Boolean(priorMilestone && currentRank > priorRank),
    milestoneBackward: Boolean(priorMilestone && currentRank < priorRank),
  };
}

function classifyMomentum(input = {}) {
  const hasPrior = input.hasPrior === true;
  const deltaDirection = ALLOWED_DELTA_DIRECTIONS.has(input.deltaDirection)
    ? input.deltaDirection
    : 'flat';
  const blockersAdded = Math.max(0, Number(input.blockersAdded || 0));
  const blockersRemoved = Math.max(0, Number(input.blockersRemoved || 0));
  const milestoneForward = input.milestoneForward === true;
  const milestoneBackward = input.milestoneBackward === true;
  const reconstructedDominant = input.reconstructedDominant === true;
  const thinHistory = input.thinHistory === true;

  if (!hasPrior) return 'stalled';
  if (deltaDirection === 'regressing' || milestoneBackward || blockersAdded > blockersRemoved) {
    return 'slipping';
  }
  if (deltaDirection === 'flat') {
    if (blockersAdded > 0 && blockersRemoved > 0) return 'oscillating';
    return 'stalled';
  }

  if (deltaDirection === 'improving') {
    if (blockersAdded > 0 && blockersRemoved > 0) return 'oscillating';
    if (blockersAdded > blockersRemoved) return 'oscillating';
    let momentum = (milestoneForward && blockersRemoved > blockersAdded)
      ? 'accelerating'
      : 'steady_progress';
    if (reconstructedDominant || thinHistory) {
      momentum = 'steady_progress';
    }
    return momentum;
  }

  return 'stalled';
}

function buildDeltaInsight(input = {}) {
  const regimeLabel = safeCanonicalRegimeLabel(input.regimeLabel || 'unknown');
  const deltaDirection = ALLOWED_DELTA_DIRECTIONS.has(input.deltaDirection) ? input.deltaDirection : 'flat';
  const deltaStrength = ALLOWED_DELTA_STRENGTH.has(input.deltaStrength) ? input.deltaStrength : 'weak';
  const momentumLabel = ALLOWED_MOMENTUM_LABELS.has(input.momentumLabel) ? input.momentumLabel : 'stalled';
  const deltaScore = round2(Number(input.deltaProgressScore || 0));
  const blockersAdded = Math.max(0, Number(input.blockersAddedCount || 0));
  const blockersRemoved = Math.max(0, Number(input.blockersRemovedCount || 0));
  const hasPrior = input.hasPrior === true;

  if (!hasPrior) {
    return `${regimeLabel} delta tracking is conservative because no prior comparable graduation snapshot is available.`;
  }
  if (momentumLabel === 'accelerating') {
    return `${regimeLabel} graduation momentum is accelerating (${deltaScore} ${deltaDirection}, ${deltaStrength}) with blocker reduction.`;
  }
  if (momentumLabel === 'steady_progress') {
    return `${regimeLabel} graduation progress is steady (${deltaScore} ${deltaDirection}, ${deltaStrength}) but still bounded by remaining requirements.`;
  }
  if (momentumLabel === 'oscillating') {
    return `${regimeLabel} graduation is oscillating; blocker adds/removals are mixed (${blockersAdded} added, ${blockersRemoved} removed).`;
  }
  if (momentumLabel === 'slipping') {
    return `${regimeLabel} graduation momentum is slipping (${deltaScore} ${deltaDirection}) and blockers worsened.`;
  }
  return `${regimeLabel} graduation momentum is stalled with limited net blocker change.`;
}

function normalizeHistoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      snapshot_date: normalizeDate(row.snapshot_date || row.snapshotDate || ''),
      window_sessions: clampInt(row.window_sessions != null ? row.window_sessions : row.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS),
      performance_source: normalizePerformanceSource(row.performance_source || row.performanceSource || 'all'),
      regime_label: safeCanonicalRegimeLabel(row.regime_label || row.regimeLabel || row.regime || 'unknown'),
      promotion_state: normalizePromotionState(row.promotion_state || row.promotionState || 'no_live_support'),
      promotion_reason: toText(row.promotion_reason || row.promotionReason || ''),
      confirmation_progress_pct: toNumber(row.confirmation_progress_pct != null ? row.confirmation_progress_pct : row.confirmationProgressPct, 0),
      live_sample_size: Math.max(0, Number(row.live_sample_size != null ? row.live_sample_size : row.liveSampleSize || 0)),
      required_sample_for_promotion: Math.max(1, Number(row.required_sample_for_promotion != null ? row.required_sample_for_promotion : row.requiredSampleForPromotion || 15)),
      trust_bias_label: normalizeTrustBiasLabel(row.trust_bias_label || row.trustBiasLabel || 'insufficient_live_confirmation'),
      trust_consumption_label: normalizeTrustConsumptionLabel(row.trust_consumption_label || row.trustConsumptionLabel || 'suppress_regime_bias'),
      confidence_adjustment_override: toNumber(row.confidence_adjustment_override != null ? row.confidence_adjustment_override : row.confidenceAdjustmentOverride, 0),
      all_evidence_usefulness_label: toText(row.all_evidence_usefulness_label || row.allEvidenceUsefulnessLabel || 'insufficient').toLowerCase() || 'insufficient',
      live_only_usefulness_label: toText(row.live_only_usefulness_label || row.liveOnlyUsefulnessLabel || 'insufficient').toLowerCase() || 'insufficient',
      score_gap: toNumber(row.score_gap != null ? row.score_gap : row.scoreGap, null),
      provenance_strength_label: toText(row.provenance_strength_label || row.provenanceStrengthLabel || 'absent').toLowerCase() || 'absent',
      evidence_quality: normalizeEvidenceQuality(row.evidence_quality || row.evidenceQuality || 'thin'),
      persistence_provenance: normalizePersistenceProvenance(row.persistence_provenance || row.persistenceProvenance || 'reconstructed_from_historical_sources'),
      reconstruction_confidence: toText(row.reconstruction_confidence || row.reconstructionConfidence || 'medium').toLowerCase() || 'medium',
      live_capture_count: Math.max(0, Number(row.live_capture_count != null ? row.live_capture_count : row.liveCaptureCount || 0)),
      first_live_captured_at: normalizeDate(row.first_live_captured_at || row.firstLiveCapturedAt || ''),
      last_live_captured_at: normalizeDate(row.last_live_captured_at || row.lastLiveCapturedAt || ''),
    }))
    .filter((row) => row.snapshot_date && SUPPORTED_REGIME_LABELS.includes(row.regime_label));
}

function loadHistoryRowsFromDb(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return [];
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const dates = db.prepare(`
    SELECT DISTINCT snapshot_date
    FROM jarvis_regime_confirmation_history
    WHERE performance_source = ?
      AND window_sessions = ?
    ORDER BY snapshot_date DESC
    LIMIT ?
  `).all(performanceSource, windowSessions, windowSessions)
    .map((row) => normalizeDate(row.snapshot_date))
    .filter(Boolean);

  if (!dates.length) return [];
  const placeholders = dates.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM jarvis_regime_confirmation_history
    WHERE performance_source = ?
      AND window_sessions = ?
      AND snapshot_date IN (${placeholders})
    ORDER BY snapshot_date ASC, regime_label ASC
  `).all(performanceSource, windowSessions, ...dates);

  return normalizeHistoryRows(rows);
}

function buildStateForRegimeDate(regimeLabel = 'unknown', regimeRows = [], targetIndex = -1) {
  const rows = Array.isArray(regimeRows) ? regimeRows : [];
  if (!rows.length || targetIndex < 0 || targetIndex >= rows.length) {
    return null;
  }
  const uptoRows = rows.slice(0, targetIndex + 1);
  const latestRow = uptoRows[uptoRows.length - 1];
  const targetDate = normalizeDate(latestRow.snapshot_date || '');
  const aggregate = buildAggregateMeta(uptoRows, targetDate);
  const synthetic = buildSyntheticSummaries(regimeLabel, latestRow, aggregate);

  return {
    regimeLabel: safeCanonicalRegimeLabel(regimeLabel),
    snapshotDate: targetDate,
    readinessLabel: toText(synthetic.graduation.readinessLabel || '').toLowerCase() || 'not_ready',
    graduationState: toText(synthetic.graduation.graduationState || '').toLowerCase() || 'reconstructed_dominant',
    graduationMilestone: normalizeMilestone(synthetic.graduation.graduationMilestone || 'no_live_base'),
    graduationProgressScore: round2(Number(synthetic.graduation.graduationProgressScore || 0)),
    remainingRequirements: normalizeRequirements(synthetic.graduation.remainingRequirements),
    readyForOperationalUse: synthetic.graduation.readyForOperationalUse === true,
    persistenceSource: toText(synthetic.graduation?.persistenceSource || aggregate.persistenceSource).toLowerCase() || aggregate.persistenceSource,
    hasLiveCapturedHistory: aggregate.hasLiveCapturedHistory,
    liveCapturedTenureDays: aggregate.liveCapturedTenureDays,
    liveCoveragePct: round2(aggregate.liveCoveragePct),
    totalSnapshots: aggregate.totalSnapshots,
    liveCapturedDays: aggregate.liveCapturedDays,
    reconstructedDays: aggregate.reconstructedDays,
    mixedDays: aggregate.mixedDays,
    captureGapDays: aggregate.captureGapDays,
    latestRow,
  };
}

function compareStates(currentState = null, priorState = null, options = {}) {
  const hasPrior = !!(priorState && typeof priorState === 'object');
  const currentScore = round2(Number(currentState?.graduationProgressScore || 0));
  const priorScore = hasPrior ? round2(Number(priorState.graduationProgressScore || 0)) : null;
  const deltaProgressScore = hasPrior ? round2(currentScore - Number(priorScore || 0)) : 0;
  let deltaDirection = classifyDeltaDirection(deltaProgressScore);
  if (!hasPrior) deltaDirection = 'flat';

  const deltaStrength = hasPrior
    ? classifyDeltaStrength(deltaProgressScore)
    : 'weak';

  const requirementDiff = diffRequirements(
    currentState?.remainingRequirements || [],
    priorState?.remainingRequirements || []
  );

  const milestone = milestoneDelta({
    currentMilestone: currentState?.graduationMilestone,
    priorMilestone: priorState?.graduationMilestone,
    hasPrior,
  });

  const reconstructedDominant = (
    String(currentState?.persistenceSource || '').toLowerCase() === 'mixed_persisted_history'
    || String(currentState?.persistenceSource || '').toLowerCase() === 'persisted_reconstructed_history'
    || Number(currentState?.reconstructedDays || 0) > Number(currentState?.liveCapturedDays || 0)
  );
  const thinHistory = Number(currentState?.totalSnapshots || 0) < 3;

  let momentumLabel = classifyMomentum({
    hasPrior,
    deltaDirection,
    blockersAdded: requirementDiff.blockersAdded.length,
    blockersRemoved: requirementDiff.blockersRemoved.length,
    milestoneForward: milestone.milestoneForward,
    milestoneBackward: milestone.milestoneBackward,
    reconstructedDominant,
    thinHistory,
  });

  if (!hasPrior && ALLOWED_MOMENTUM_LABELS.has(momentumLabel) === false) momentumLabel = 'stalled';
  if (!ALLOWED_MOMENTUM_LABELS.has(momentumLabel)) momentumLabel = 'stalled';
  if (!ALLOWED_DELTA_DIRECTIONS.has(deltaDirection)) deltaDirection = 'flat';

  const warnings = [];
  if (!hasPrior) warnings.push('no_prior_snapshot');
  if (thinHistory) warnings.push('thin_delta_history');
  if (reconstructedDominant) warnings.push('reconstructed_dominant_history');
  if (String(currentState?.persistenceSource || '').toLowerCase() === 'mixed_persisted_history') warnings.push('mixed_history_only');
  if (currentState?.readyForOperationalUse !== true) warnings.push('current_regime_not_live_ready');
  if (Number(currentState?.liveCapturedTenureDays || 0) < 3) warnings.push('insufficient_live_capture_depth');

  const regimeProgressDeltaInsight = buildDeltaInsight({
    regimeLabel: currentState?.regimeLabel,
    hasPrior,
    deltaDirection,
    deltaStrength,
    deltaProgressScore,
    momentumLabel,
    blockersAddedCount: requirementDiff.blockersAdded.length,
    blockersRemovedCount: requirementDiff.blockersRemoved.length,
  });

  return {
    currentGraduationMilestone: normalizeMilestone(currentState?.graduationMilestone || 'no_live_base'),
    priorGraduationMilestone: hasPrior ? normalizeMilestone(priorState?.graduationMilestone || 'no_live_base') : null,
    currentGraduationProgressScore: currentScore,
    priorGraduationProgressScore: hasPrior ? priorScore : null,
    deltaProgressScore,
    deltaDirection,
    deltaStrength: ALLOWED_DELTA_STRENGTH.has(deltaStrength) ? deltaStrength : 'weak',
    momentumLabel,
    currentRemainingRequirements: requirementDiff.currentRemainingRequirements,
    priorRemainingRequirements: requirementDiff.priorRemainingRequirements,
    blockersAdded: requirementDiff.blockersAdded,
    blockersRemoved: requirementDiff.blockersRemoved,
    blockersUnchanged: requirementDiff.blockersUnchanged,
    milestoneChanged: milestone.milestoneChanged,
    milestoneFrom: milestone.milestoneFrom,
    milestoneTo: milestone.milestoneTo,
    regimeProgressDeltaInsight,
    readyForOperationalUse: currentState?.readyForOperationalUse === true,
    warnings,
  };
}

function buildRegimePersistenceGraduationDeltaSummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const regimePersistenceGraduation = input.regimePersistenceGraduation && typeof input.regimePersistenceGraduation === 'object'
    ? input.regimePersistenceGraduation
    : {};
  const regimePersistenceReadiness = input.regimePersistenceReadiness && typeof input.regimePersistenceReadiness === 'object'
    ? input.regimePersistenceReadiness
    : {};
  const regimeLivePersistenceQuality = input.regimeLivePersistenceQuality && typeof input.regimeLivePersistenceQuality === 'object'
    ? input.regimeLivePersistenceQuality
    : {};
  const regimeConfirmationDurability = input.regimeConfirmationDurability && typeof input.regimeConfirmationDurability === 'object'
    ? input.regimeConfirmationDurability
    : {};
  const regimeConfirmationHistory = input.regimeConfirmationHistory && typeof input.regimeConfirmationHistory === 'object'
    ? input.regimeConfirmationHistory
    : {};

  const currentRegimeLabel = safeCanonicalRegimeLabel(
    regimePersistenceGraduation.currentRegimeLabel
      || regimePersistenceReadiness.currentRegimeLabel
      || regimeLivePersistenceQuality.currentRegimeLabel
      || regimeConfirmationDurability.currentRegimeLabel
      || regimeConfirmationHistory.currentRegimeLabel
      || 'unknown'
  );

  const providedRows = normalizeHistoryRows(input.historyRows || []);
  const rows = providedRows.length
    ? providedRows.filter((row) => (
      row.performance_source === performanceSource
      && row.window_sessions === windowSessions
    ))
    : loadHistoryRowsFromDb({
      db: input.db,
      windowSessions,
      performanceSource,
    });

  const recentDates = collectDistinctRecentDates(rows, windowSessions);
  const minDate = recentDates.length ? recentDates[0] : null;

  const regimeRowsMap = new Map();
  for (const label of SUPPORTED_REGIME_LABELS) regimeRowsMap.set(label, []);
  for (const row of rows) {
    const label = safeCanonicalRegimeLabel(row.regime_label || 'unknown');
    if (!regimeRowsMap.has(label)) regimeRowsMap.set(label, []);
    regimeRowsMap.get(label).push(row);
  }
  for (const list of regimeRowsMap.values()) {
    list.sort((a, b) => normalizeDate(a.snapshot_date).localeCompare(normalizeDate(b.snapshot_date)));
  }

  const graduationDeltaByRegime = [];

  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const regimeRows = regimeRowsMap.get(regimeLabel) || [];
    const currentState = buildStateForRegimeDate(regimeLabel, regimeRows, regimeRows.length - 1);
    const priorState = buildStateForRegimeDate(regimeLabel, regimeRows, regimeRows.length - 2);

    let effectiveCurrentState = currentState;
    if (regimeLabel === currentRegimeLabel && currentState) {
      const currentRequirements = normalizeRequirements(regimePersistenceGraduation?.remainingRequirements || []);
      effectiveCurrentState = {
        ...currentState,
        readinessLabel: toText(regimePersistenceGraduation?.readinessLabel || currentState.readinessLabel).toLowerCase() || currentState.readinessLabel,
        graduationState: toText(regimePersistenceGraduation?.graduationState || currentState.graduationState).toLowerCase() || currentState.graduationState,
        graduationMilestone: normalizeMilestone(regimePersistenceGraduation?.graduationMilestone || currentState.graduationMilestone),
        graduationProgressScore: round2(toNumber(regimePersistenceGraduation?.graduationProgressScore, currentState.graduationProgressScore) || 0),
        readyForOperationalUse: regimePersistenceGraduation?.readyForOperationalUse === true,
        remainingRequirements: currentRequirements.length
          ? currentRequirements
          : currentState.remainingRequirements,
      };
    }

    if (!effectiveCurrentState) {
      const syntheticNoSupport = {
        regimeLabel,
        graduationMilestone: 'no_live_base',
        graduationProgressScore: 0,
        remainingRequirements: ['establish_live_base'],
        readyForOperationalUse: false,
        persistenceSource: 'proxy_only',
        liveCapturedTenureDays: 0,
        liveCapturedDays: 0,
        reconstructedDays: 0,
        totalSnapshots: 0,
      };
      const delta = compareStates(syntheticNoSupport, null);
      graduationDeltaByRegime.push({
        regimeLabel,
        ...delta,
        advisoryOnly: true,
      });
      continue;
    }

    const delta = compareStates(effectiveCurrentState, priorState);
    graduationDeltaByRegime.push({
      regimeLabel,
      currentGraduationMilestone: delta.currentGraduationMilestone,
      priorGraduationMilestone: delta.priorGraduationMilestone,
      currentGraduationProgressScore: delta.currentGraduationProgressScore,
      priorGraduationProgressScore: delta.priorGraduationProgressScore,
      deltaProgressScore: delta.deltaProgressScore,
      deltaDirection: delta.deltaDirection,
      deltaStrength: delta.deltaStrength,
      momentumLabel: delta.momentumLabel,
      currentRemainingRequirements: delta.currentRemainingRequirements,
      priorRemainingRequirements: delta.priorRemainingRequirements,
      blockersAdded: delta.blockersAdded,
      blockersRemoved: delta.blockersRemoved,
      blockersUnchanged: delta.blockersUnchanged,
      readyForOperationalUse: delta.readyForOperationalUse === true,
      warnings: delta.warnings,
      advisoryOnly: true,
    });
  }

  const currentRow = graduationDeltaByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || {
      regimeLabel: currentRegimeLabel,
      currentGraduationMilestone: normalizeMilestone(regimePersistenceGraduation.graduationMilestone || 'no_live_base'),
      priorGraduationMilestone: null,
      currentGraduationProgressScore: round2(toNumber(regimePersistenceGraduation.graduationProgressScore, 0) || 0),
      priorGraduationProgressScore: null,
      deltaProgressScore: 0,
      deltaDirection: 'flat',
      deltaStrength: 'weak',
      momentumLabel: 'stalled',
      currentRemainingRequirements: normalizeRequirements(regimePersistenceGraduation.remainingRequirements || []),
      priorRemainingRequirements: [],
      blockersAdded: normalizeRequirements(regimePersistenceGraduation.remainingRequirements || []),
      blockersRemoved: [],
      blockersUnchanged: [],
      readyForOperationalUse: regimePersistenceGraduation.readyForOperationalUse === true,
      warnings: ['no_prior_snapshot', 'thin_delta_history'],
      advisoryOnly: true,
    };

  const progressingRegimeLabels = graduationDeltaByRegime
    .filter((row) => row.momentumLabel === 'accelerating' || row.momentumLabel === 'steady_progress')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));
  const regressingRegimeLabels = graduationDeltaByRegime
    .filter((row) => row.momentumLabel === 'slipping')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));
  const stalledRegimeLabels = graduationDeltaByRegime
    .filter((row) => row.momentumLabel === 'stalled')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));
  const oscillatingRegimeLabels = graduationDeltaByRegime
    .filter((row) => row.momentumLabel === 'oscillating')
    .map((row) => row.regimeLabel)
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label));

  const milestoneFrom = currentRow.priorGraduationMilestone || null;
  const milestoneTo = currentRow.currentGraduationMilestone || 'no_live_base';
  const milestoneChanged = Boolean(milestoneFrom && milestoneFrom !== milestoneTo);

  const warnings = Array.from(new Set(Array.isArray(currentRow.warnings) ? currentRow.warnings : []));
  if (!currentRow.readyForOperationalUse) warnings.push('current_regime_not_live_ready');
  if (Number(regimePersistenceReadiness?.currentRegimeLiveCapturedTenureDays || 0) < 3) warnings.push('insufficient_live_capture_depth');
  if (String(regimePersistenceReadiness?.persistenceSource || '').toLowerCase() === 'mixed_persisted_history') warnings.push('mixed_history_only');
  if (String(regimePersistenceReadiness?.persistenceSource || '').toLowerCase() === 'persisted_reconstructed_history') warnings.push('reconstructed_dominant_history');
  if (!milestoneFrom) warnings.push('no_prior_snapshot');
  if (Number(regimeConfirmationHistory?.historyCoverageDays || 0) < 3) warnings.push('thin_delta_history');

  const regimeProgressDeltaInsight = buildDeltaInsight({
    regimeLabel: currentRegimeLabel,
    hasPrior: Number.isFinite(Number(currentRow.priorGraduationProgressScore)),
    deltaDirection: currentRow.deltaDirection,
    deltaStrength: currentRow.deltaStrength,
    deltaProgressScore: currentRow.deltaProgressScore,
    momentumLabel: currentRow.momentumLabel,
    blockersAddedCount: Array.isArray(currentRow.blockersAdded) ? currentRow.blockersAdded.length : 0,
    blockersRemovedCount: Array.isArray(currentRow.blockersRemoved) ? currentRow.blockersRemoved.length : 0,
  });

  const dedupedWarnings = Array.from(new Set(warnings));

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    currentGraduationMilestone: currentRow.currentGraduationMilestone,
    currentGraduationProgressScore: round2(Number(currentRow.currentGraduationProgressScore || 0)),
    priorGraduationProgressScore: currentRow.priorGraduationProgressScore != null
      && Number.isFinite(Number(currentRow.priorGraduationProgressScore))
      ? round2(Number(currentRow.priorGraduationProgressScore))
      : null,
    deltaProgressScore: round2(Number(currentRow.deltaProgressScore || 0)),
    deltaDirection: ALLOWED_DELTA_DIRECTIONS.has(currentRow.deltaDirection) ? currentRow.deltaDirection : 'flat',
    deltaStrength: ALLOWED_DELTA_STRENGTH.has(currentRow.deltaStrength) ? currentRow.deltaStrength : 'weak',
    momentumLabel: ALLOWED_MOMENTUM_LABELS.has(currentRow.momentumLabel) ? currentRow.momentumLabel : 'stalled',
    blockersAdded: normalizeRequirements(currentRow.blockersAdded || []),
    blockersRemoved: normalizeRequirements(currentRow.blockersRemoved || []),
    blockersUnchanged: normalizeRequirements(currentRow.blockersUnchanged || []),
    milestoneChanged,
    milestoneFrom,
    milestoneTo,
    regimeProgressDeltaInsight,
    readyForOperationalUse: currentRow.readyForOperationalUse === true,
    warnings: dedupedWarnings,
    progressingRegimeLabels,
    regressingRegimeLabels,
    stalledRegimeLabels,
    oscillatingRegimeLabels,
    graduationDeltaByRegime,
    advisoryOnly: true,
    historyRange: {
      from: minDate,
      to: recentDates.length ? recentDates[recentDates.length - 1] : null,
      snapshots: recentDates.length,
    },
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePersistenceGraduationDeltaSummary,
};
