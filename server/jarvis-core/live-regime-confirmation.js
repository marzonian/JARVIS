'use strict';

const {
  SUPPORTED_REGIME_LABELS,
  buildRegimeDetection,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const SOURCE_LIVE = 'live';

const PROMOTION_STATES = new Set([
  'no_live_support',
  'emerging_live_support',
  'near_live_confirmation',
  'live_confirmed',
  'stalled_live_support',
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

function normalizeSourceType(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live') return 'live';
  return 'backfill';
}

function parseDateToUtcDay(dateIso) {
  const date = normalizeDate(dateIso);
  if (!date) return null;
  const [y, m, d] = date.split('-').map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return Date.UTC(y, m - 1, d);
}

function daysBetween(dateA, dateB) {
  const a = parseDateToUtcDay(dateA);
  const b = parseDateToUtcDay(dateB);
  if (a == null || b == null) return null;
  return Math.max(0, Math.round((a - b) / (24 * 60 * 60 * 1000)));
}

function deriveRegimeLabelForDate(dateIso = '', regimeByDate = {}, cache = new Map()) {
  const date = normalizeDate(dateIso);
  if (!date) return 'unknown';
  if (cache.has(date)) return cache.get(date);
  const detected = buildRegimeDetection({
    regimeByDate,
    latestDate: date,
    includeEvidence: false,
    sessionPhase: 'unknown',
  });
  const label = normalizeRegimeLabel(detected?.regimeLabel || 'unknown');
  const safe = SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
  cache.set(date, safe);
  return safe;
}

function normalizeUsefulnessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong' || txt === 'moderate' || txt === 'weak' || txt === 'noisy') return txt;
  return 'insufficient';
}

function createLiveStatsAccumulator() {
  const map = new Map();
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    map.set(regimeLabel, {
      regimeLabel,
      liveSampleSize: 0,
      latestLiveDate: null,
      firstLiveDate: null,
    });
  }
  return map;
}

function buildLiveStatsByRegime(scorecards = [], regimeByDate = {}) {
  const out = createLiveStatsAccumulator();
  const dateCache = new Map();
  for (const card of (Array.isArray(scorecards) ? scorecards : [])) {
    if (normalizeSourceType(card?.sourceType) !== SOURCE_LIVE) continue;
    const date = normalizeDate(card?.date || card?.recommendationDate || '');
    if (!date) continue;
    const label = normalizeRegimeLabel(
      card?.regimeLabel
      || deriveRegimeLabelForDate(date, regimeByDate, dateCache)
      || 'unknown'
    );
    const regimeLabel = SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
    if (!out.has(regimeLabel)) continue;
    const row = out.get(regimeLabel);
    row.liveSampleSize += 1;
    if (!row.latestLiveDate || date > row.latestLiveDate) row.latestLiveDate = date;
    if (!row.firstLiveDate || date < row.firstLiveDate) row.firstLiveDate = date;
  }
  return out;
}

function findByRegime(rows = [], regimeLabel = '') {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    normalizeRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
  )) || null;
}

function deriveTrustBiasForRegime(row = {}) {
  const liveSample = Math.max(0, Number(row?.liveSampleSize || 0));
  const liveLabel = normalizeUsefulnessLabel(row?.liveUsefulnessLabel || 'insufficient');
  const allLabel = normalizeUsefulnessLabel(row?.allEvidenceUsefulnessLabel || 'insufficient');
  const scoreGap = toNumber(row?.scoreGap, null);
  const live = Math.max(0, Number(row?.allEvidenceSourceBreakdown?.live || 0));
  const backfill = Math.max(0, Number(row?.allEvidenceSourceBreakdown?.backfill || 0));
  const backfillDominant = backfill >= (live * 2) && backfill >= 10;
  if (liveSample < 5 || liveLabel === 'insufficient') return 'insufficient_live_confirmation';
  if (
    liveSample >= 10
    && (liveLabel === 'strong' || liveLabel === 'moderate')
    && (!Number.isFinite(scoreGap) || Math.abs(scoreGap) <= 8)
  ) {
    return 'live_confirmed';
  }
  if (
    (allLabel === 'strong' || allLabel === 'moderate')
    && (
      liveLabel === 'weak'
      || liveLabel === 'noisy'
      || (Number.isFinite(scoreGap) && scoreGap >= 12)
      || backfillDominant
    )
  ) {
    return 'retrospective_led';
  }
  return 'mixed_support';
}

function deriveRequiredSampleForPromotion(regimeLabel = '', context = {}) {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  if (safe === 'mixed' || safe === 'unknown') return 30;
  const scoreGap = toNumber(context.scoreGap, null);
  const trustBias = toText(context.trustBiasLabel || '').toLowerCase();
  const allProvStrength = toText(context.provenanceStrengthLabel || '').toLowerCase();
  if (
    trustBias === 'retrospective_led'
    || allProvStrength === 'retrospective_heavy'
    || (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 15)
  ) {
    return 20;
  }
  return 15;
}

function qualityProgress(label = '') {
  const txt = normalizeUsefulnessLabel(label);
  if (txt === 'strong') return 1.0;
  if (txt === 'moderate') return 0.75;
  if (txt === 'weak') return 0.35;
  if (txt === 'noisy') return 0.2;
  return 0.1;
}

function buildEvidenceFreshnessLabel(row = {}, globalLatestLiveDate = '') {
  const sample = Math.max(0, Number(row?.liveSampleSize || 0));
  if (sample <= 0) return 'stale_or_sparse';
  const rowLatest = normalizeDate(row?.latestLiveDate || '');
  const ref = normalizeDate(globalLatestLiveDate || '');
  const ageDays = daysBetween(ref, rowLatest);
  if (ageDays == null) {
    if (sample >= 10) return 'recent_but_thin';
    return 'stale_or_sparse';
  }
  if (ageDays <= 5 && sample >= 10) return 'fresh';
  if (ageDays <= 20) return sample >= 10 ? 'fresh' : 'recent_but_thin';
  return sample >= 10 ? 'recent_but_thin' : 'stale_or_sparse';
}

function computeProgressPct(input = {}) {
  const state = toText(input.promotionState).toLowerCase();
  if (state === 'no_live_support') return 0;
  const sample = Math.max(0, Number(input.liveSampleSize || 0));
  const required = Math.max(1, Number(input.requiredSampleForPromotion || 15));
  const sampleProgress = clamp(sample / required, 0, 1);
  const quality = qualityProgress(input.liveUsefulnessLabel);
  let progress = 100 * ((0.7 * sampleProgress) + (0.3 * quality));

  const trustConsumptionLabel = toText(input.trustConsumptionLabel).toLowerCase();
  const trustBiasLabel = toText(input.trustBiasLabel).toLowerCase();
  if (trustConsumptionLabel === 'suppress_regime_bias') progress *= 0.65;
  else if (trustConsumptionLabel === 'reduce_regime_weight') progress *= 0.85;
  if (trustBiasLabel === 'retrospective_led') progress *= 0.9;
  if (state === 'stalled_live_support') progress = Math.min(progress, 65);
  if (state === 'live_confirmed') progress = Math.max(progress, 90);

  return round2(clamp(progress, 0, 100));
}

function classifyPromotionState(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const liveSampleSize = Math.max(0, Number(input.liveSampleSize || 0));
  const liveUsefulnessLabel = normalizeUsefulnessLabel(input.liveUsefulnessLabel || 'insufficient');
  const liveUsefulnessScore = toNumber(input.liveUsefulnessScore, null);
  const liveConfidenceAdjustment = toNumber(input.liveConfidenceAdjustment, 0);
  const requiredSample = Math.max(1, Number(input.requiredSampleForPromotion || 15));
  const trustBiasLabel = toText(input.trustBiasLabel).toLowerCase();
  const trustConsumptionLabel = toText(input.trustConsumptionLabel).toLowerCase();
  const liveProvenanceStrength = toText(input.liveProvenanceStrengthLabel).toLowerCase();
  const scoreGap = toNumber(input.scoreGap, null);

  if (liveSampleSize === 0) {
    return {
      promotionState: 'no_live_support',
      promotionReason: `No direct live evidence exists yet for ${regimeLabel}.`,
    };
  }

  const persistentWeakness = (
    liveSampleSize >= Math.max(10, requiredSample)
    && (liveUsefulnessLabel === 'weak' || liveUsefulnessLabel === 'insufficient' || liveUsefulnessLabel === 'noisy')
  );
  const trustStillSuppressedWhileAccumulating = (
    liveSampleSize >= 10
    && (trustConsumptionLabel === 'suppress_regime_bias' || trustConsumptionLabel === 'reduce_regime_weight')
    && trustBiasLabel !== 'live_confirmed'
  );

  if (persistentWeakness || trustStillSuppressedWhileAccumulating) {
    const reason = persistentWeakness
      ? `${regimeLabel} has accumulating live samples but live usefulness remains weak/noisy.`
      : `${regimeLabel} has live accumulation, but trust remains suppressed due to weak live confirmation.`;
    return {
      promotionState: 'stalled_live_support',
      promotionReason: reason,
    };
  }

  if (liveSampleSize < 10 || liveUsefulnessLabel === 'insufficient' || liveUsefulnessLabel === 'noisy') {
    return {
      promotionState: 'emerging_live_support',
      promotionReason: `${regimeLabel} has early live support (${liveSampleSize} samples) but remains below confirmation quality/size.`,
    };
  }

  const mixedUnknownExtraGate = (
    (regimeLabel === 'mixed' || regimeLabel === 'unknown')
    ? (liveSampleSize >= 30 && Number(liveUsefulnessScore || 0) >= 70)
    : true
  );
  const liveConfirmed = (
    liveSampleSize >= requiredSample
    && (liveUsefulnessLabel === 'moderate' || liveUsefulnessLabel === 'strong')
    && liveConfidenceAdjustment >= 0
    && liveProvenanceStrength !== 'absent'
    && trustBiasLabel !== 'insufficient_live_confirmation'
    && mixedUnknownExtraGate
  );

  if (liveConfirmed) {
    return {
      promotionState: 'live_confirmed',
      promotionReason: `${regimeLabel} meets live confirmation criteria with sufficient sample and non-negative live confidence.`,
    };
  }

  const nearReasonBits = [];
  if (liveSampleSize < requiredSample) nearReasonBits.push(`sample ${liveSampleSize}/${requiredSample}`);
  if (liveConfidenceAdjustment < 0) nearReasonBits.push('live confidence still negative');
  if (trustBiasLabel === 'insufficient_live_confirmation') nearReasonBits.push('trust bias still insufficient');
  if ((regimeLabel === 'mixed' || regimeLabel === 'unknown') && !mixedUnknownExtraGate) nearReasonBits.push('mixed/unknown requires stronger live evidence');
  if (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12) nearReasonBits.push('all-vs-live gap remains elevated');
  return {
    promotionState: 'near_live_confirmation',
    promotionReason: `${regimeLabel} is near live confirmation but not fully promoted (${nearReasonBits.join(', ') || 'criteria incomplete'}).`,
  };
}

function buildInsight(summary = {}) {
  const regime = normalizeRegimeLabel(summary?.currentRegimeLabel || 'unknown');
  const state = toText(summary?.currentRegimePromotionState).toLowerCase();
  const sample = Math.max(0, Number(summary?.currentRegimeLiveSampleSize || 0));
  const required = Math.max(1, Number(summary?.currentRegimeRequiredSampleForPromotion || 15));
  const confirmed = Array.isArray(summary?.liveConfirmedRegimeLabels) ? summary.liveConfirmedRegimeLabels : [];

  if (state === 'live_confirmed') {
    return `${regime} is currently live-confirmed with direct sample support (${sample}/${required}).`;
  }
  if (state === 'near_live_confirmation') {
    return `${regime} is near live confirmation with ${sample}/${required} live samples; maintain cautious trust until full promotion.`;
  }
  if (state === 'emerging_live_support') {
    return `${regime} has emerging live support (${sample}/${required}) but is not yet live-confirmed.`;
  }
  if (state === 'stalled_live_support') {
    return `${regime} live support is currently stalled; additional high-quality live evidence is needed before promotion.`;
  }
  if (confirmed.length === 0) {
    return 'No regime currently qualifies as live-confirmed; live support remains early-stage.';
  }
  return `${regime} currently has no live support; wait for direct live evidence accumulation.`;
}

function buildLiveRegimeConfirmationSummary(input = {}) {
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const regimeDetection = input.regimeDetection && typeof input.regimeDetection === 'object'
    ? input.regimeDetection
    : {};
  const regimeEvidenceSplit = input.regimeEvidenceSplit && typeof input.regimeEvidenceSplit === 'object'
    ? input.regimeEvidenceSplit
    : {};
  const regimeTrustConsumption = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};
  const recommendationPerformance = input.recommendationPerformance && typeof input.recommendationPerformance === 'object'
    ? input.recommendationPerformance
    : {};
  const scorecards = Array.isArray(recommendationPerformance?.scorecards)
    ? recommendationPerformance.scorecards
    : [];
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object'
    ? input.regimeByDate
    : {};

  const currentRegimeLabel = normalizeRegimeLabel(
    regimeDetection?.regimeLabel
      || regimeEvidenceSplit?.currentRegimeLabel
      || regimeTrustConsumption?.currentRegimeLabel
      || 'unknown'
  );

  const allRows = Array.isArray(regimeEvidenceSplit?.allEvidenceByRegime)
    ? regimeEvidenceSplit.allEvidenceByRegime
    : [];
  const liveRows = Array.isArray(regimeEvidenceSplit?.liveOnlyByRegime)
    ? regimeEvidenceSplit.liveOnlyByRegime
    : [];

  const liveStatsByRegime = buildLiveStatsByRegime(scorecards, regimeByDate);
  let globalLatestLiveDate = null;
  for (const row of liveStatsByRegime.values()) {
    if (row.latestLiveDate && (!globalLatestLiveDate || row.latestLiveDate > globalLatestLiveDate)) {
      globalLatestLiveDate = row.latestLiveDate;
    }
  }

  const liveConfirmationByRegime = [];
  const liveConfirmedRegimeLabels = [];
  const emergingLiveSupportRegimeLabels = [];
  const stalledRegimeLabels = [];

  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const allRow = findByRegime(allRows, regimeLabel) || {};
    const liveRow = findByRegime(liveRows, regimeLabel) || {};
    const stats = liveStatsByRegime.get(regimeLabel) || {
      liveSampleSize: 0,
      latestLiveDate: null,
      firstLiveDate: null,
    };
    const liveSampleSize = Math.max(
      0,
      Number(stats.liveSampleSize || liveRow?.liveDirectSampleSize || 0)
    );
    const allEvidenceUsefulnessLabel = normalizeUsefulnessLabel(allRow?.usefulnessLabel || 'insufficient');
    const liveUsefulnessLabel = normalizeUsefulnessLabel(liveRow?.usefulnessLabel || 'insufficient');
    const liveUsefulnessScore = Number.isFinite(toNumber(liveRow?.usefulnessScore, null))
      ? round2(Number(liveRow.usefulnessScore))
      : null;
    const liveConfidenceAdjustment = Number.isFinite(toNumber(liveRow?.confidenceAdjustment, null))
      ? round2(Number(liveRow.confidenceAdjustment))
      : 0;
    const scoreGap = (
      Number.isFinite(toNumber(allRow?.usefulnessScore, null)) && Number.isFinite(liveUsefulnessScore)
    )
      ? round2(Number(allRow.usefulnessScore) - Number(liveUsefulnessScore))
      : null;

    const perRegimeTrustBiasLabel = deriveTrustBiasForRegime({
      liveSampleSize,
      liveUsefulnessLabel,
      allEvidenceUsefulnessLabel,
      scoreGap,
      allEvidenceSourceBreakdown: allRow?.evidenceSourceBreakdown || { live: 0, backfill: 0 },
    });
    const trustBiasForRow = regimeLabel === currentRegimeLabel
      ? toText(regimeTrustConsumption?.trustBiasLabel || perRegimeTrustBiasLabel).toLowerCase() || perRegimeTrustBiasLabel
      : perRegimeTrustBiasLabel;
    const trustConsumptionLabel = regimeLabel === currentRegimeLabel
      ? toText(regimeTrustConsumption?.trustConsumptionLabel || '').toLowerCase() || 'reduce_regime_weight'
      : (
        trustBiasForRow === 'insufficient_live_confirmation'
          ? 'suppress_regime_bias'
          : (trustBiasForRow === 'retrospective_led' ? 'reduce_regime_weight' : 'allow_with_caution')
      );

    const requiredSampleForPromotion = deriveRequiredSampleForPromotion(regimeLabel, {
      trustBiasLabel: trustBiasForRow,
      scoreGap,
      provenanceStrengthLabel: allRow?.provenanceStrengthLabel || 'absent',
    });
    const promotion = classifyPromotionState({
      regimeLabel,
      liveSampleSize,
      liveUsefulnessLabel,
      liveUsefulnessScore,
      liveConfidenceAdjustment,
      requiredSampleForPromotion,
      trustBiasLabel: trustBiasForRow,
      trustConsumptionLabel,
      liveProvenanceStrengthLabel: liveRow?.provenanceStrengthLabel || 'absent',
      scoreGap,
    });
    const promotionState = PROMOTION_STATES.has(promotion.promotionState)
      ? promotion.promotionState
      : 'no_live_support';

    const row = {
      regimeLabel,
      liveSampleSize,
      liveUsefulnessLabel,
      liveUsefulnessScore,
      liveConfidenceAdjustment,
      promotionState,
      promotionReason: toText(promotion.promotionReason) || `${regimeLabel} live confirmation state is ${promotionState}.`,
      requiredSampleForPromotion,
      progressPct: 0,
      evidenceFreshnessLabel: buildEvidenceFreshnessLabel({
        liveSampleSize,
        latestLiveDate: stats.latestLiveDate,
      }, globalLatestLiveDate),
      warnings: [],
      advisoryOnly: true,
    };
    row.progressPct = computeProgressPct({
      promotionState,
      liveSampleSize,
      requiredSampleForPromotion,
      liveUsefulnessLabel,
      trustConsumptionLabel,
      trustBiasLabel: trustBiasForRow,
    });
    if (liveSampleSize === 0) row.warnings.push('no_live_support');
    if (liveSampleSize > 0 && liveSampleSize < 5) row.warnings.push('thin_live_support');
    if (promotionState === 'stalled_live_support') row.warnings.push('live_support_stalled');
    if (regimeLabel === 'mixed' || regimeLabel === 'unknown') row.warnings.push('mixed_unknown_requires_stronger_live_confirmation');
    row.warnings = Array.from(new Set(row.warnings));

    liveConfirmationByRegime.push(row);
    if (promotionState === 'live_confirmed') liveConfirmedRegimeLabels.push(regimeLabel);
    if (promotionState === 'emerging_live_support' || promotionState === 'near_live_confirmation') {
      emergingLiveSupportRegimeLabels.push(regimeLabel);
    }
    if (promotionState === 'stalled_live_support') stalledRegimeLabels.push(regimeLabel);
  }

  const currentRow = findByRegime(liveConfirmationByRegime, currentRegimeLabel) || {
    regimeLabel: currentRegimeLabel,
    liveSampleSize: 0,
    promotionState: 'no_live_support',
    promotionReason: `No direct live evidence exists yet for ${currentRegimeLabel}.`,
    requiredSampleForPromotion: (currentRegimeLabel === 'mixed' || currentRegimeLabel === 'unknown') ? 30 : 15,
    progressPct: 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    currentRegimeLabel,
    currentRegimePromotionState: currentRow.promotionState,
    currentRegimePromotionReason: currentRow.promotionReason,
    currentRegimeLiveSampleSize: Number(currentRow.liveSampleSize || 0),
    currentRegimeRequiredSampleForPromotion: Number(currentRow.requiredSampleForPromotion || 15),
    currentRegimeConfirmationProgressPct: round2(Number(currentRow.progressPct || 0)),
    liveConfirmationByRegime,
    liveConfirmedRegimeLabels,
    emergingLiveSupportRegimeLabels,
    stalledRegimeLabels,
    liveConfirmationInsight: buildInsight({
      currentRegimeLabel,
      currentRegimePromotionState: currentRow.promotionState,
      currentRegimeLiveSampleSize: currentRow.liveSampleSize,
      currentRegimeRequiredSampleForPromotion: currentRow.requiredSampleForPromotion,
      liveConfirmedRegimeLabels,
    }),
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildLiveRegimeConfirmationSummary,
};
