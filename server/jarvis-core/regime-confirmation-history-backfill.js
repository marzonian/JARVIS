'use strict';

const {
  SUPPORTED_REGIME_LABELS,
  buildRegimeDetection,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');
const {
  ensureRegimeConfirmationHistoryTables,
  appendRegimeConfirmationHistorySnapshot,
  buildRegimeConfirmationHistorySummary,
} = require('./regime-confirmation-history');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const MIN_SCORECARDS_FOR_RECONSTRUCTION = 2;

const SOURCE_LIVE = 'live';
const SOURCE_BACKFILL = 'backfill';

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
  const src = toText(value).toLowerCase();
  return src === SOURCE_BACKFILL ? SOURCE_BACKFILL : SOURCE_LIVE;
}

function normalizePerformanceSource(value) {
  const src = toText(value).toLowerCase();
  if (src === SOURCE_LIVE || src === SOURCE_BACKFILL) return src;
  return 'all';
}

function normalizePersistenceProvenance(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_captured') return 'live_captured';
  if (txt === 'mixed') return 'mixed';
  return 'reconstructed_from_historical_sources';
}

function normalizeReconstructionConfidence(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'high' || txt === 'medium' || txt === 'low') return txt;
  return 'low';
}

function normalizeUsefulnessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong' || txt === 'moderate' || txt === 'weak' || txt === 'noisy') return txt;
  return 'insufficient';
}

function normalizeTrustBiasLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_confirmed' || txt === 'mixed_support' || txt === 'retrospective_led') return txt;
  return 'insufficient_live_confirmation';
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
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

function scoreLabelToPct(value) {
  const label = toText(value).toLowerCase();
  if (label === 'correct') return 100;
  if (label === 'partially_correct') return 50;
  if (label === 'incorrect') return 0;
  return null;
}

function average(values = []) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
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

function emptyStats() {
  return {
    sampleSize: 0,
    posturePct: [],
    strategyPct: [],
    tpPct: [],
    deltas: [],
  };
}

function createStatsByRegime() {
  const out = new Map();
  for (const label of SUPPORTED_REGIME_LABELS) {
    out.set(label, {
      regimeLabel: label,
      all: emptyStats(),
      live: emptyStats(),
      sourceBreakdown: { live: 0, backfill: 0, total: 0 },
    });
  }
  return out;
}

function addCardToStats(stats = {}, card = {}, sourceType = SOURCE_LIVE) {
  stats.sampleSize += 1;
  const posture = scoreLabelToPct(card?.postureEvaluation);
  if (Number.isFinite(posture)) stats.posturePct.push(posture);
  const strategy = scoreLabelToPct(card?.strategyRecommendationScore?.scoreLabel);
  if (Number.isFinite(strategy)) stats.strategyPct.push(strategy);
  const tp = scoreLabelToPct(card?.tpRecommendationScore?.scoreLabel);
  if (Number.isFinite(tp)) stats.tpPct.push(tp);
  const delta = toNumber(card?.recommendationDelta, null);
  if (Number.isFinite(delta)) stats.deltas.push(delta);
  if (sourceType === SOURCE_BACKFILL || sourceType === SOURCE_LIVE) {
    // no-op; source breakdown tracked separately
  }
}

function computeUsefulnessFromStats(stats = {}) {
  const sampleSize = Math.max(0, Number(stats.sampleSize || 0));
  if (sampleSize <= 0) {
    return {
      sampleSize,
      postureAccuracyPct: null,
      strategyAccuracyPct: null,
      tpAccuracyPct: null,
      avgRecommendationDelta: null,
      recommendationScore: null,
      strategyScore: null,
      tpScore: null,
      deltaScore: null,
      usefulnessScore: null,
      usefulnessLabel: 'insufficient',
    };
  }

  const postureAccuracyPct = Number.isFinite(average(stats.posturePct)) ? round2(average(stats.posturePct)) : null;
  const strategyAccuracyPct = Number.isFinite(average(stats.strategyPct)) ? round2(average(stats.strategyPct)) : null;
  const tpAccuracyPct = Number.isFinite(average(stats.tpPct)) ? round2(average(stats.tpPct)) : null;
  const avgRecommendationDelta = Number.isFinite(average(stats.deltas)) ? round2(average(stats.deltas)) : null;

  const recommendationScore = Number.isFinite(average([postureAccuracyPct, strategyAccuracyPct, tpAccuracyPct]))
    ? round2(average([postureAccuracyPct, strategyAccuracyPct, tpAccuracyPct]))
    : null;
  const strategyScore = Number.isFinite(strategyAccuracyPct) ? round2(strategyAccuracyPct) : null;
  const tpScore = Number.isFinite(tpAccuracyPct) ? round2(tpAccuracyPct) : null;
  const deltaScore = Number.isFinite(avgRecommendationDelta)
    ? round2(clamp(50 + (Number(avgRecommendationDelta) / 2), 0, 100))
    : null;

  const weights = {
    recommendationScore: 0.50,
    strategyScore: 0.25,
    tpScore: 0.20,
    deltaScore: 0.05,
  };
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = toNumber({ recommendationScore, strategyScore, tpScore, deltaScore }[key], null);
    if (!Number.isFinite(value)) continue;
    weighted += (value * weight);
    totalWeight += weight;
  }

  const usefulnessScore = totalWeight > 0
    ? round2(clamp(weighted / totalWeight, 0, 100))
    : null;

  let usefulnessLabel = 'insufficient';
  if (sampleSize < 5) usefulnessLabel = 'insufficient';
  else if (sampleSize < 10) usefulnessLabel = 'noisy';
  else if (!Number.isFinite(usefulnessScore)) usefulnessLabel = 'weak';
  else if (usefulnessScore >= 68) usefulnessLabel = 'strong';
  else if (usefulnessScore >= 55) usefulnessLabel = 'moderate';
  else usefulnessLabel = 'weak';

  return {
    sampleSize,
    postureAccuracyPct,
    strategyAccuracyPct,
    tpAccuracyPct,
    avgRecommendationDelta,
    recommendationScore,
    strategyScore,
    tpScore,
    deltaScore,
    usefulnessScore,
    usefulnessLabel,
  };
}

function classifyEvidenceQuality(live = 0, backfill = 0, total = null) {
  const l = Math.max(0, Number(live || 0));
  const b = Math.max(0, Number(backfill || 0));
  const t = Math.max(0, Number(total != null ? total : (l + b)));
  if (t < 10) return 'thin';
  if (b >= (l * 2) && b >= 10) return 'retrospective_heavy';
  if (l >= 20 && l >= (b * 1.5)) return 'strong_live';
  return 'mixed';
}

function deriveProvenanceStrength({ live = 0, backfill = 0, total = 0 } = {}) {
  const l = Math.max(0, Number(live || 0));
  const b = Math.max(0, Number(backfill || 0));
  const t = Math.max(0, Number(total || (l + b)));
  if (t <= 0) return 'absent';
  if (l <= 0) return 'inferred_only';
  if (b >= (l * 2) && b >= 10) return 'retrospective_heavy';
  if (b > 0) return 'mixed';
  return 'direct';
}

function computeConfidenceAdjustment({ regimeLabel = 'unknown', sampleSize = 0, usefulnessLabel = 'insufficient', usefulnessScore = null } = {}) {
  let adjustment = 0;
  const label = normalizeUsefulnessLabel(usefulnessLabel);
  const score = toNumber(usefulnessScore, null);
  if (label === 'strong') adjustment = 4;
  else if (label === 'moderate') adjustment = 1;
  else if (label === 'weak') adjustment = -3;
  else if (label === 'noisy') adjustment = -1;

  if (Number.isFinite(score)) adjustment += round2((score - 55) / 15);

  const sample = Math.max(0, Number(sampleSize || 0));
  if (sample < 5) adjustment = 0;
  else if (sample < 10) adjustment = clamp(adjustment, -2, 2);

  const safeLabel = normalizeRegimeLabel(regimeLabel || 'unknown');
  if ((safeLabel === 'mixed' || safeLabel === 'unknown') && !(sample >= 30 && Number(score || 0) >= 70)) {
    adjustment = Math.min(adjustment, 0);
  }

  return round2(clamp(adjustment, -15, 10));
}

function deriveTrustBiasLabel({
  regimeLabel = 'unknown',
  allUsefulnessLabel = 'insufficient',
  liveUsefulnessLabel = 'insufficient',
  liveSampleSize = 0,
  scoreGap = null,
  sourceBreakdown = { live: 0, backfill: 0, total: 0 },
} = {}) {
  const safeRegime = normalizeRegimeLabel(regimeLabel || 'unknown');
  const allLabel = normalizeUsefulnessLabel(allUsefulnessLabel);
  const liveLabel = normalizeUsefulnessLabel(liveUsefulnessLabel);
  const liveSample = Math.max(0, Number(liveSampleSize || 0));
  const gap = toNumber(scoreGap, null);
  const liveCount = Math.max(0, Number(sourceBreakdown.live || 0));
  const backfillCount = Math.max(0, Number(sourceBreakdown.backfill || 0));
  const backfillDominant = backfillCount >= (liveCount * 2) && backfillCount >= 10;

  if (liveSample < 5 || liveLabel === 'insufficient') return 'insufficient_live_confirmation';

  if (
    liveSample >= 10
    && (liveLabel === 'strong' || liveLabel === 'moderate')
    && (!Number.isFinite(gap) || Math.abs(gap) <= 8)
  ) {
    if ((safeRegime === 'mixed' || safeRegime === 'unknown') && !(liveSample >= 20 && (toNumber(sourceBreakdown.liveUsefulnessScore, 0) || 0) >= 70)) {
      return 'mixed_support';
    }
    return 'live_confirmed';
  }

  if (
    (allLabel === 'strong' || allLabel === 'moderate')
    && (
      liveLabel === 'weak'
      || liveLabel === 'noisy'
      || (Number.isFinite(gap) && gap >= 12)
      || backfillDominant
    )
  ) {
    return 'retrospective_led';
  }

  return 'mixed_support';
}

function deriveTrustConsumptionLabel({
  trustBiasLabel = 'insufficient_live_confirmation',
  liveSampleSize = 0,
  liveUsefulnessLabel = 'insufficient',
  scoreGap = null,
  provenanceStrengthLabel = 'absent',
} = {}) {
  const bias = normalizeTrustBiasLabel(trustBiasLabel);
  const sample = Math.max(0, Number(liveSampleSize || 0));
  const liveLabel = normalizeUsefulnessLabel(liveUsefulnessLabel);
  const gap = toNumber(scoreGap, null);
  const provenance = toText(provenanceStrengthLabel).toLowerCase();
  const largeGap = Number.isFinite(gap) && Math.abs(gap) >= 12;

  if (bias === 'insufficient_live_confirmation' || sample < 5 || liveLabel === 'insufficient') {
    return 'suppress_regime_bias';
  }
  if (bias === 'live_confirmed' && sample >= 10 && (liveLabel === 'strong' || liveLabel === 'moderate')) {
    return 'allow_regime_confidence';
  }
  if (bias === 'retrospective_led' || largeGap || provenance === 'retrospective_heavy') {
    return 'reduce_regime_weight';
  }
  return 'allow_with_caution';
}

function deriveRequiredSampleForPromotion({ regimeLabel = 'unknown', trustBiasLabel = '', provenanceStrengthLabel = '', scoreGap = null } = {}) {
  const safeRegime = normalizeRegimeLabel(regimeLabel || 'unknown');
  if (safeRegime === 'mixed' || safeRegime === 'unknown') return 30;
  const bias = normalizeTrustBiasLabel(trustBiasLabel);
  const provenance = toText(provenanceStrengthLabel).toLowerCase();
  const gap = toNumber(scoreGap, null);
  if (bias === 'retrospective_led' || provenance === 'retrospective_heavy' || (Number.isFinite(gap) && Math.abs(gap) >= 15)) {
    return 20;
  }
  return 15;
}

function qualityProgress(label = 'insufficient') {
  const normalized = normalizeUsefulnessLabel(label);
  if (normalized === 'strong') return 1.0;
  if (normalized === 'moderate') return 0.75;
  if (normalized === 'weak') return 0.35;
  if (normalized === 'noisy') return 0.2;
  return 0.1;
}

function computeProgressPct({
  promotionState = 'no_live_support',
  liveSampleSize = 0,
  requiredSampleForPromotion = 15,
  liveUsefulnessLabel = 'insufficient',
  trustConsumptionLabel = 'suppress_regime_bias',
  trustBiasLabel = 'insufficient_live_confirmation',
} = {}) {
  const state = normalizePromotionState(promotionState);
  if (state === 'no_live_support') return 0;
  const sample = Math.max(0, Number(liveSampleSize || 0));
  const required = Math.max(1, Number(requiredSampleForPromotion || 15));
  const sampleProgress = clamp(sample / required, 0, 1);
  let progress = 100 * ((0.7 * sampleProgress) + (0.3 * qualityProgress(liveUsefulnessLabel)));

  const trust = normalizeTrustConsumptionLabel(trustConsumptionLabel);
  const bias = normalizeTrustBiasLabel(trustBiasLabel);
  if (trust === 'suppress_regime_bias') progress *= 0.65;
  else if (trust === 'reduce_regime_weight') progress *= 0.85;
  if (bias === 'retrospective_led') progress *= 0.9;

  if (state === 'stalled_live_support') progress = Math.min(progress, 65);
  if (state === 'live_confirmed') progress = Math.max(progress, 90);

  return round2(clamp(progress, 0, 100));
}

function classifyPromotionState({
  regimeLabel = 'unknown',
  liveSampleSize = 0,
  liveUsefulnessLabel = 'insufficient',
  liveUsefulnessScore = null,
  liveConfidenceAdjustment = 0,
  requiredSampleForPromotion = 15,
  trustBiasLabel = 'insufficient_live_confirmation',
  trustConsumptionLabel = 'suppress_regime_bias',
  liveProvenanceStrengthLabel = 'absent',
  scoreGap = null,
} = {}) {
  const safeRegime = normalizeRegimeLabel(regimeLabel || 'unknown');
  const sample = Math.max(0, Number(liveSampleSize || 0));
  const liveLabel = normalizeUsefulnessLabel(liveUsefulnessLabel);
  const liveScore = toNumber(liveUsefulnessScore, null);
  const confidenceAdj = toNumber(liveConfidenceAdjustment, 0);
  const required = Math.max(1, Number(requiredSampleForPromotion || 15));
  const bias = normalizeTrustBiasLabel(trustBiasLabel);
  const trust = normalizeTrustConsumptionLabel(trustConsumptionLabel);
  const liveProv = toText(liveProvenanceStrengthLabel).toLowerCase();
  const gap = toNumber(scoreGap, null);

  if (sample === 0) {
    return {
      promotionState: 'no_live_support',
      promotionReason: `No direct live evidence exists yet for ${safeRegime}.`,
    };
  }

  const persistentWeakness = (
    sample >= Math.max(10, required)
    && (liveLabel === 'weak' || liveLabel === 'insufficient' || liveLabel === 'noisy')
  );
  const trustSuppressedWhileAccumulating = (
    sample >= 10
    && (trust === 'suppress_regime_bias' || trust === 'reduce_regime_weight')
    && bias !== 'live_confirmed'
  );

  if (persistentWeakness || trustSuppressedWhileAccumulating) {
    return {
      promotionState: 'stalled_live_support',
      promotionReason: persistentWeakness
        ? `${safeRegime} has accumulating live samples but live usefulness remains weak/noisy.`
        : `${safeRegime} has live accumulation but trust remains suppressed under weak live confirmation.`,
    };
  }

  if (sample < 10 || liveLabel === 'insufficient' || liveLabel === 'noisy') {
    return {
      promotionState: 'emerging_live_support',
      promotionReason: `${safeRegime} has early live support (${sample} samples) but remains below confirmation quality/size.`,
    };
  }

  const mixedUnknownExtraGate = (
    (safeRegime === 'mixed' || safeRegime === 'unknown')
      ? (sample >= 30 && Number(liveScore || 0) >= 70)
      : true
  );

  const liveConfirmed = (
    sample >= required
    && (liveLabel === 'moderate' || liveLabel === 'strong')
    && confidenceAdj >= 0
    && liveProv !== 'absent'
    && bias !== 'insufficient_live_confirmation'
    && mixedUnknownExtraGate
  );

  if (liveConfirmed) {
    return {
      promotionState: 'live_confirmed',
      promotionReason: `${safeRegime} meets live confirmation criteria with sufficient sample and non-negative live confidence.`,
    };
  }

  const reasonBits = [];
  if (sample < required) reasonBits.push(`sample ${sample}/${required}`);
  if (confidenceAdj < 0) reasonBits.push('live confidence still negative');
  if (bias === 'insufficient_live_confirmation') reasonBits.push('trust bias still insufficient');
  if ((safeRegime === 'mixed' || safeRegime === 'unknown') && !mixedUnknownExtraGate) reasonBits.push('mixed/unknown requires stronger live evidence');
  if (Number.isFinite(gap) && Math.abs(gap) >= 12) reasonBits.push('all-vs-live gap remains elevated');

  return {
    promotionState: 'near_live_confirmation',
    promotionReason: `${safeRegime} is near live confirmation but not fully promoted (${reasonBits.join(', ') || 'criteria incomplete'}).`,
  };
}

function computeConfidenceAdjustmentOverride({
  trustConsumptionLabel = 'suppress_regime_bias',
  trustBiasLabel = 'insufficient_live_confirmation',
  regimeLabel = 'unknown',
  liveSampleSize = 0,
} = {}) {
  const trust = normalizeTrustConsumptionLabel(trustConsumptionLabel);
  const bias = normalizeTrustBiasLabel(trustBiasLabel);
  const regime = normalizeRegimeLabel(regimeLabel || 'unknown');
  const sample = Math.max(0, Number(liveSampleSize || 0));

  let override = 0;
  if (trust === 'allow_regime_confidence') override = 2;
  else if (trust === 'allow_with_caution') override = 0;
  else if (trust === 'reduce_regime_weight') override = -5;
  else override = -8;

  if (bias === 'insufficient_live_confirmation') override = Math.min(override, -6);
  if (bias === 'retrospective_led') override = Math.min(override, 0);
  if ((regime === 'mixed' || regime === 'unknown') && bias !== 'live_confirmed') override = Math.min(override, 0);
  if (trust === 'allow_regime_confidence' && sample < 10) override = 0;

  return round2(clamp(override, -12, 5));
}

function buildReconstructionConfidence({ allSample = 0, liveSample = 0, evidenceQuality = 'thin' } = {}) {
  if (allSample >= 20 && liveSample >= 10 && evidenceQuality !== 'thin') return 'high';
  if (allSample >= 10) return 'medium';
  return 'low';
}

function buildReconstructionWarnings({
  allSample = 0,
  liveSample = 0,
  evidenceQuality = 'thin',
  trustBiasLabel = 'insufficient_live_confirmation',
  regimeLabel = 'unknown',
} = {}) {
  const warnings = [];
  if (allSample <= 0) warnings.push('no_regime_support');
  if (allSample > 0 && allSample < 5) warnings.push('thin_regime_support');
  if (liveSample <= 0 && allSample > 0) warnings.push('no_direct_live_support');
  if (liveSample > 0 && liveSample < 5) warnings.push('thin_live_support');
  if (evidenceQuality === 'retrospective_heavy') warnings.push('retrospective_heavy_support');
  if (trustBiasLabel === 'insufficient_live_confirmation') warnings.push('insufficient_live_confirmation');
  if ((regimeLabel === 'mixed' || regimeLabel === 'unknown') && liveSample < 30) {
    warnings.push('mixed_unknown_requires_stronger_live_support');
  }
  return Array.from(new Set(warnings));
}

function buildHistoricalCards(scorecards = [], regimeByDate = {}) {
  const dateCache = new Map();
  return (Array.isArray(scorecards) ? scorecards : [])
    .map((card) => {
      const date = normalizeDate(card?.date || card?.recommendationDate || '');
      if (!date) return null;
      const sourceType = normalizeSourceType(card?.sourceType);
      const regimeLabel = normalizeRegimeLabel(
        card?.regimeLabel
        || deriveRegimeLabelForDate(date, regimeByDate, dateCache)
        || 'unknown'
      );
      const safeRegime = SUPPORTED_REGIME_LABELS.includes(regimeLabel) ? regimeLabel : 'unknown';
      return {
        ...card,
        date,
        sourceType,
        regimeLabel: safeRegime,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

function buildSnapshotForDate({ date = '', cardsUpToDate = [], regimeByDate = {} } = {}) {
  const snapshotDate = normalizeDate(date);
  if (!snapshotDate) {
    return {
      snapshot: null,
      warning: 'invalid_snapshot_date',
    };
  }

  const windowCards = (Array.isArray(cardsUpToDate) ? cardsUpToDate : [])
    .filter((card) => normalizeDate(card?.date || '') <= snapshotDate)
    .slice(-MAX_WINDOW_SESSIONS);

  if (windowCards.length < MIN_SCORECARDS_FOR_RECONSTRUCTION) {
    return {
      snapshot: null,
      warning: `${snapshotDate}:insufficient_reconstruction_evidence`,
    };
  }

  const statsByRegime = createStatsByRegime();
  for (const card of windowCards) {
    const label = normalizeRegimeLabel(card?.regimeLabel || 'unknown');
    const regimeLabel = SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
    const bucket = statsByRegime.get(regimeLabel);
    if (!bucket) continue;

    addCardToStats(bucket.all, card, card.sourceType);
    bucket.sourceBreakdown.total += 1;
    if (card.sourceType === SOURCE_BACKFILL) bucket.sourceBreakdown.backfill += 1;
    else bucket.sourceBreakdown.live += 1;

    if (card.sourceType === SOURCE_LIVE) addCardToStats(bucket.live, card, card.sourceType);
  }

  const dateCache = new Map();
  let currentRegimeLabel = deriveRegimeLabelForDate(snapshotDate, regimeByDate, dateCache);
  if (!SUPPORTED_REGIME_LABELS.includes(currentRegimeLabel)) currentRegimeLabel = 'unknown';
  if (currentRegimeLabel === 'unknown') {
    const mostCovered = Array.from(statsByRegime.values())
      .sort((a, b) => Number(b?.all?.sampleSize || 0) - Number(a?.all?.sampleSize || 0))[0];
    if (mostCovered && Number(mostCovered?.all?.sampleSize || 0) > 0) {
      currentRegimeLabel = normalizeRegimeLabel(mostCovered.regimeLabel || 'unknown');
    }
  }

  const allEvidenceByRegime = [];
  const liveOnlyByRegime = [];
  const liveConfirmationByRegime = [];
  const rowMetaByRegime = {};

  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const bucket = statsByRegime.get(regimeLabel) || {
      all: emptyStats(),
      live: emptyStats(),
      sourceBreakdown: { live: 0, backfill: 0, total: 0 },
    };

    const allEval = computeUsefulnessFromStats(bucket.all);
    const liveEval = computeUsefulnessFromStats(bucket.live);
    const sourceBreakdown = {
      live: Math.max(0, Number(bucket.sourceBreakdown.live || 0)),
      backfill: Math.max(0, Number(bucket.sourceBreakdown.backfill || 0)),
      total: Math.max(0, Number(bucket.sourceBreakdown.total || 0)),
    };

    const allUsefulnessScore = Number.isFinite(toNumber(allEval.usefulnessScore, null))
      ? round2(Number(allEval.usefulnessScore))
      : null;
    const liveUsefulnessScore = Number.isFinite(toNumber(liveEval.usefulnessScore, null))
      ? round2(Number(liveEval.usefulnessScore))
      : null;
    const scoreGap = Number.isFinite(allUsefulnessScore) && Number.isFinite(liveUsefulnessScore)
      ? round2(allUsefulnessScore - liveUsefulnessScore)
      : null;

    const provenanceStrengthLabel = deriveProvenanceStrength(sourceBreakdown);
    const evidenceQuality = classifyEvidenceQuality(sourceBreakdown.live, sourceBreakdown.backfill, sourceBreakdown.total);

    const allUsefulnessLabel = normalizeUsefulnessLabel(allEval.usefulnessLabel);
    const liveUsefulnessLabel = normalizeUsefulnessLabel(liveEval.usefulnessLabel);
    const liveConfidenceAdjustment = computeConfidenceAdjustment({
      regimeLabel,
      sampleSize: liveEval.sampleSize,
      usefulnessLabel: liveUsefulnessLabel,
      usefulnessScore: liveUsefulnessScore,
    });

    const trustBiasLabel = deriveTrustBiasLabel({
      regimeLabel,
      allUsefulnessLabel,
      liveUsefulnessLabel,
      liveSampleSize: liveEval.sampleSize,
      scoreGap,
      sourceBreakdown: {
        ...sourceBreakdown,
        liveUsefulnessScore,
      },
    });
    const trustConsumptionLabel = deriveTrustConsumptionLabel({
      trustBiasLabel,
      liveSampleSize: liveEval.sampleSize,
      liveUsefulnessLabel,
      scoreGap,
      provenanceStrengthLabel,
    });

    const requiredSampleForPromotion = deriveRequiredSampleForPromotion({
      regimeLabel,
      trustBiasLabel,
      provenanceStrengthLabel,
      scoreGap,
    });

    const liveProvenanceStrengthLabel = liveEval.sampleSize >= 10
      ? 'direct'
      : (liveEval.sampleSize > 0 ? 'thin_live' : 'absent');

    const promotion = classifyPromotionState({
      regimeLabel,
      liveSampleSize: liveEval.sampleSize,
      liveUsefulnessLabel,
      liveUsefulnessScore,
      liveConfidenceAdjustment,
      requiredSampleForPromotion,
      trustBiasLabel,
      trustConsumptionLabel,
      liveProvenanceStrengthLabel,
      scoreGap,
    });

    const promotionState = normalizePromotionState(promotion.promotionState);
    const progressPct = computeProgressPct({
      promotionState,
      liveSampleSize: liveEval.sampleSize,
      requiredSampleForPromotion,
      liveUsefulnessLabel,
      trustConsumptionLabel,
      trustBiasLabel,
    });

    const allWarnings = [];
    if (allEval.sampleSize <= 0) allWarnings.push('no_regime_support');
    if (allEval.sampleSize > 0 && allEval.sampleSize < 5) allWarnings.push('thin_regime_sample');

    const liveWarnings = [];
    if (liveEval.sampleSize <= 0) liveWarnings.push('no_live_regime_provenance');
    else if (liveEval.sampleSize < 5) liveWarnings.push('thin_live_regime_sample');
    else if (liveEval.sampleSize < 10) liveWarnings.push('limited_live_regime_sample');

    allEvidenceByRegime.push({
      regimeLabel,
      usefulnessScore: allUsefulnessScore,
      usefulnessLabel: allUsefulnessLabel,
      confidenceAdjustment: computeConfidenceAdjustment({
        regimeLabel,
        sampleSize: allEval.sampleSize,
        usefulnessLabel: allUsefulnessLabel,
        usefulnessScore: allUsefulnessScore,
      }),
      directProvenanceSampleSize: sourceBreakdown.total,
      upstreamCoverageSampleSize: allEval.sampleSize,
      coverageType: sourceBreakdown.total > 0 ? 'mixed_support' : 'no_support',
      provenanceStrengthLabel,
      evidenceSourceBreakdown: sourceBreakdown,
      warnings: Array.from(new Set(allWarnings)),
      advisoryOnly: true,
    });

    liveOnlyByRegime.push({
      regimeLabel,
      usefulnessScore: liveUsefulnessScore,
      usefulnessLabel: liveUsefulnessLabel,
      confidenceAdjustment: liveConfidenceAdjustment,
      liveDirectSampleSize: liveEval.sampleSize,
      coverageType: liveEval.sampleSize > 0 ? 'direct_provenance' : 'no_support',
      provenanceStrengthLabel: liveProvenanceStrengthLabel,
      evidenceSourceBreakdown: {
        live: liveEval.sampleSize,
        backfill: 0,
        total: liveEval.sampleSize,
      },
      warnings: Array.from(new Set(liveWarnings)),
      advisoryOnly: true,
    });

    liveConfirmationByRegime.push({
      regimeLabel,
      liveSampleSize: liveEval.sampleSize,
      liveUsefulnessLabel,
      liveUsefulnessScore,
      liveConfidenceAdjustment,
      promotionState,
      promotionReason: toText(promotion.promotionReason || '') || `${regimeLabel} ${promotionState}.`,
      requiredSampleForPromotion,
      progressPct,
      evidenceFreshnessLabel: liveEval.sampleSize >= 10 ? 'fresh' : (liveEval.sampleSize > 0 ? 'recent_but_thin' : 'stale_or_sparse'),
      warnings: Array.from(new Set([
        ...liveWarnings,
        ...(trustConsumptionLabel === 'suppress_regime_bias' ? ['trust_suppressed'] : []),
      ])),
      advisoryOnly: true,
    });

    const rowConfidence = buildReconstructionConfidence({
      allSample: allEval.sampleSize,
      liveSample: liveEval.sampleSize,
      evidenceQuality,
    });
    const rowWarnings = buildReconstructionWarnings({
      allSample: allEval.sampleSize,
      liveSample: liveEval.sampleSize,
      evidenceQuality,
      trustBiasLabel,
      regimeLabel,
    });
    rowMetaByRegime[regimeLabel] = {
      persistenceProvenance: 'reconstructed_from_historical_sources',
      reconstructionConfidence: rowConfidence,
      reconstructionWarnings: rowWarnings,
    };
  }

  const currentAll = allEvidenceByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || allEvidenceByRegime[0]
    || null;
  const currentLive = liveOnlyByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || liveOnlyByRegime[0]
    || null;
  const currentPromo = liveConfirmationByRegime.find((row) => row.regimeLabel === currentRegimeLabel)
    || liveConfirmationByRegime[0]
    || {
      regimeLabel: currentRegimeLabel,
      promotionState: 'no_live_support',
      promotionReason: `No evidence for ${currentRegimeLabel}.`,
      liveSampleSize: 0,
      requiredSampleForPromotion: currentRegimeLabel === 'mixed' || currentRegimeLabel === 'unknown' ? 30 : 15,
      progressPct: 0,
      liveUsefulnessLabel: 'insufficient',
      liveUsefulnessScore: null,
      liveConfidenceAdjustment: 0,
      advisoryOnly: true,
    };

  const currentScoreGap = Number.isFinite(toNumber(currentAll?.usefulnessScore, null)) && Number.isFinite(toNumber(currentLive?.usefulnessScore, null))
    ? round2(Number(currentAll.usefulnessScore) - Number(currentLive.usefulnessScore))
    : null;
  const currentTrustBias = deriveTrustBiasLabel({
    regimeLabel: currentRegimeLabel,
    allUsefulnessLabel: currentAll?.usefulnessLabel || 'insufficient',
    liveUsefulnessLabel: currentLive?.usefulnessLabel || 'insufficient',
    liveSampleSize: Number(currentLive?.liveDirectSampleSize || 0),
    scoreGap: currentScoreGap,
    sourceBreakdown: currentAll?.evidenceSourceBreakdown || { live: 0, backfill: 0, total: 0 },
  });
  const currentTrustConsumption = deriveTrustConsumptionLabel({
    trustBiasLabel: currentTrustBias,
    liveSampleSize: Number(currentLive?.liveDirectSampleSize || 0),
    liveUsefulnessLabel: currentLive?.usefulnessLabel || 'insufficient',
    scoreGap: currentScoreGap,
    provenanceStrengthLabel: currentAll?.provenanceStrengthLabel || 'absent',
  });

  const confidenceAdjustmentOverride = computeConfidenceAdjustmentOverride({
    trustConsumptionLabel: currentTrustConsumption,
    trustBiasLabel: currentTrustBias,
    regimeLabel: currentRegimeLabel,
    liveSampleSize: Number(currentLive?.liveDirectSampleSize || 0),
  });

  const guidanceEvidenceQuality = classifyEvidenceQuality(
    Number(currentAll?.evidenceSourceBreakdown?.live || 0),
    Number(currentAll?.evidenceSourceBreakdown?.backfill || 0),
    Number(currentAll?.evidenceSourceBreakdown?.total || 0)
  );

  const liveConfirmedRegimeLabels = liveConfirmationByRegime
    .filter((row) => String(row.promotionState) === 'live_confirmed')
    .map((row) => row.regimeLabel);
  const emergingLiveSupportRegimeLabels = liveConfirmationByRegime
    .filter((row) => String(row.promotionState) === 'emerging_live_support')
    .map((row) => row.regimeLabel);
  const stalledRegimeLabels = liveConfirmationByRegime
    .filter((row) => String(row.promotionState) === 'stalled_live_support')
    .map((row) => row.regimeLabel);

  const globalWarnings = [];
  if (currentRegimeLabel === 'unknown') globalWarnings.push(`${snapshotDate}:current_regime_unknown_reconstructed`);
  if (!liveConfirmedRegimeLabels.length) globalWarnings.push(`${snapshotDate}:no_live_confirmed_regime_in_reconstruction`);

  return {
    snapshot: {
      snapshotDate,
      currentRegimeLabel,
      liveRegimeConfirmation: {
        generatedAt: `${snapshotDate}T23:59:00.000Z`,
        currentRegimeLabel,
        currentRegimePromotionState: currentPromo.promotionState,
        currentRegimePromotionReason: currentPromo.promotionReason,
        currentRegimeLiveSampleSize: Number(currentPromo.liveSampleSize || 0),
        currentRegimeRequiredSampleForPromotion: Number(currentPromo.requiredSampleForPromotion || 15),
        currentRegimeConfirmationProgressPct: Number(currentPromo.progressPct || 0),
        liveConfirmationByRegime,
        liveConfirmedRegimeLabels,
        emergingLiveSupportRegimeLabels,
        stalledRegimeLabels,
        liveConfirmationInsight: `${currentRegimeLabel} historical confirmation reconstructed from scorecard evidence for ${snapshotDate}.`,
        advisoryOnly: true,
      },
      regimeEvidenceSplit: {
        generatedAt: `${snapshotDate}T23:59:00.000Z`,
        currentRegimeLabel,
        allEvidenceByRegime,
        liveOnlyByRegime,
        currentRegimeComparison: {
          regimeLabel: currentRegimeLabel,
          allEvidenceUsefulnessScore: currentAll?.usefulnessScore ?? null,
          allEvidenceUsefulnessLabel: currentAll?.usefulnessLabel || 'insufficient',
          liveOnlyUsefulnessScore: currentLive?.usefulnessScore ?? null,
          liveOnlyUsefulnessLabel: currentLive?.usefulnessLabel || 'insufficient',
          scoreGap: currentScoreGap,
          liveDirectSampleSize: Number(currentLive?.liveDirectSampleSize || 0),
          allEvidenceDirectSampleSize: Number(currentAll?.directProvenanceSampleSize || 0),
          trustBiasLabel: currentTrustBias,
          trustBiasReason: `Historical trust bias reconstructed for ${currentRegimeLabel} on ${snapshotDate}.`,
          advisoryOnly: true,
        },
        trustBiasLabel: currentTrustBias,
        trustBiasReason: `Historical trust bias reconstructed for ${currentRegimeLabel} on ${snapshotDate}.`,
        advisoryOnly: true,
      },
      regimeTrustConsumption: {
        generatedAt: `${snapshotDate}T23:59:00.000Z`,
        currentRegimeLabel,
        trustBiasLabel: currentTrustBias,
        trustBiasReason: `Trust bias reconstructed from historical scorecards for ${currentRegimeLabel}.`,
        trustConsumptionLabel: currentTrustConsumption,
        trustConsumptionReason: `Trust consumption reconstructed from historical scorecard support for ${currentRegimeLabel}.`,
        confidenceAdjustmentOverride,
        currentRegimeTrustSnapshot: {
          regimeLabel: currentRegimeLabel,
          trustBiasLabel: currentTrustBias,
          trustConsumptionLabel: currentTrustConsumption,
          liveOnlyUsefulnessLabel: currentLive?.usefulnessLabel || 'insufficient',
          allEvidenceUsefulnessLabel: currentAll?.usefulnessLabel || 'insufficient',
          liveDirectSampleSize: Number(currentLive?.liveDirectSampleSize || 0),
          allEvidenceDirectSampleSize: Number(currentAll?.directProvenanceSampleSize || 0),
          scoreGap: currentScoreGap,
          provenanceStrengthLabel: currentAll?.provenanceStrengthLabel || 'absent',
          evidenceQuality: guidanceEvidenceQuality,
          advisoryOnly: true,
        },
        advisoryOnly: true,
      },
      regimePerformanceFeedback: {
        generatedAt: `${snapshotDate}T23:59:00.000Z`,
        currentRegimeLabel,
        regimeUsefulness: allEvidenceByRegime,
        regimeConfidenceGuidance: {
          regimeLabel: currentRegimeLabel,
          guidanceLabel: currentTrustConsumption === 'allow_regime_confidence'
            ? 'increase_trust'
            : (currentTrustConsumption === 'allow_with_caution' ? 'maintain' : 'reduce_trust'),
          confidenceAdjustment: Number(currentAll?.confidenceAdjustment || 0),
          usefulnessScore: currentAll?.usefulnessScore ?? null,
          usefulnessLabel: currentAll?.usefulnessLabel || 'insufficient',
          evidenceSourceBreakdown: currentAll?.evidenceSourceBreakdown || { live: 0, backfill: 0, total: 0 },
          evidenceQuality: guidanceEvidenceQuality,
          reason: `Historical regime guidance reconstructed for ${currentRegimeLabel} on ${snapshotDate}.`,
          warnings: [],
          advisoryOnly: true,
        },
        advisoryOnly: true,
      },
      reconstructionMetaByRegime: rowMetaByRegime,
      warnings: globalWarnings,
    },
    warning: null,
  };
}

function buildRegimeConfirmationHistoryBackfillSummary(input = {}) {
  return {
    attemptedDays: Math.max(0, Number(input.attemptedDays || 0)),
    reconstructedDays: Math.max(0, Number(input.reconstructedDays || 0)),
    skippedDays: Math.max(0, Number(input.skippedDays || 0)),
    insertedRows: Math.max(0, Number(input.insertedRows || 0)),
    updatedRows: Math.max(0, Number(input.updatedRows || 0)),
    warnings: Array.from(new Set((Array.isArray(input.warnings) ? input.warnings : []).filter(Boolean))),
    windowSessions: Math.max(MIN_WINDOW_SESSIONS, Math.min(MAX_WINDOW_SESSIONS, Number(input.windowSessions || DEFAULT_WINDOW_SESSIONS))),
    performanceSource: normalizePerformanceSource(input.performanceSource || input.source || 'all'),
    startDate: normalizeDate(input.startDate || '' ) || null,
    endDate: normalizeDate(input.endDate || '') || null,
    maxDays: Math.max(1, Number(input.maxDays || DEFAULT_WINDOW_SESSIONS)),
    force: input.force === true,
    advisoryOnly: true,
  };
}

function backfillRegimeConfirmationHistory(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return buildRegimeConfirmationHistoryBackfillSummary({
      attemptedDays: 0,
      reconstructedDays: 0,
      skippedDays: 0,
      insertedRows: 0,
      updatedRows: 0,
      warnings: ['db_unavailable'],
      windowSessions: input.windowSessions,
      performanceSource: input.performanceSource,
      startDate: input.startDate,
      endDate: input.endDate,
      maxDays: input.maxDays,
      force: input.force,
    });
  }

  ensureRegimeConfirmationHistoryTables(db);

  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');
  const force = input.force === true;
  const maxDays = Math.max(1, Math.min(MAX_WINDOW_SESSIONS, Number(input.maxDays || windowSessions || DEFAULT_WINDOW_SESSIONS)));
  const startDate = normalizeDate(input.startDate || '');
  const endDate = normalizeDate(input.endDate || '');
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object' ? input.regimeByDate : {};

  const recommendationPerformance = input.recommendationPerformance && typeof input.recommendationPerformance === 'object'
    ? input.recommendationPerformance
    : {};
  const allCards = buildHistoricalCards(recommendationPerformance.scorecards || [], regimeByDate)
    .filter((card) => (
      performanceSource === 'all'
        ? true
        : normalizeSourceType(card.sourceType) === performanceSource
    ));

  const uniqueDates = Array.from(new Set(allCards.map((card) => card.date).filter(Boolean))).sort();
  const boundedDates = uniqueDates
    .filter((date) => (!startDate || date >= startDate) && (!endDate || date <= endDate));
  const candidateDates = boundedDates.slice(-maxDays);

  const warnings = [];
  let attemptedDays = 0;
  let reconstructedDays = 0;
  let skippedDays = 0;
  let insertedRows = 0;
  let updatedRows = 0;

  for (const date of candidateDates) {
    attemptedDays += 1;
    const cardsUpToDate = allCards.filter((card) => card.date <= date);

    const reconstruction = buildSnapshotForDate({
      date,
      cardsUpToDate,
      regimeByDate,
    });

    if (!reconstruction?.snapshot) {
      skippedDays += 1;
      if (reconstruction?.warning) warnings.push(reconstruction.warning);
      continue;
    }

    const snapshot = reconstruction.snapshot;
    const appendResult = appendRegimeConfirmationHistorySnapshot({
      db,
      snapshotDate: snapshot.snapshotDate,
      snapshotGeneratedAt: `${snapshot.snapshotDate}T23:59:00.000Z`,
      windowSessions,
      performanceSource,
      currentRegimeLabel: snapshot.currentRegimeLabel,
      liveRegimeConfirmation: snapshot.liveRegimeConfirmation,
      regimeTrustConsumption: snapshot.regimeTrustConsumption,
      regimeEvidenceSplit: snapshot.regimeEvidenceSplit,
      regimePerformanceFeedback: snapshot.regimePerformanceFeedback,
      persistenceProvenance: 'reconstructed_from_historical_sources',
      reconstructionConfidence: 'medium',
      reconstructionWarnings: snapshot.warnings,
      reconstructionMetaByRegime: snapshot.reconstructionMetaByRegime,
      force,
    });

    insertedRows += Number(appendResult?.inserted || 0);
    updatedRows += Number(appendResult?.updated || 0);
    if (Number(appendResult?.appended || 0) > 0) reconstructedDays += 1;
    if (Array.isArray(snapshot.warnings)) warnings.push(...snapshot.warnings);
  }

  if (!candidateDates.length) warnings.push('no_eligible_scorecard_dates');

  return buildRegimeConfirmationHistoryBackfillSummary({
    attemptedDays,
    reconstructedDays,
    skippedDays,
    insertedRows,
    updatedRows,
    warnings,
    windowSessions,
    performanceSource,
    startDate,
    endDate,
    maxDays,
    force,
  });
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  backfillRegimeConfirmationHistory,
  buildRegimeConfirmationHistoryBackfillSummary,
};
