'use strict';

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

function normalizeDate(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function weekdayFromDate(value) {
  const date = normalizeDate(value);
  if (!date) return null;
  const dt = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

function normalizeStrategyKey(value) {
  return toText(value).toLowerCase();
}

function normalizeTpMode(value) {
  const key = toText(value).toLowerCase();
  if (!key) return '';
  if (key.includes('nearest')) return 'Nearest';
  if (key.includes('skip 1') || key === 'skip1') return 'Skip 1';
  if (key.includes('skip 2') || key === 'skip2') return 'Skip 2';
  return toText(value);
}

function labelScore(value) {
  const key = toText(value).toLowerCase();
  if (key === 'correct') return 1;
  if (key === 'partially_correct') return 0.5;
  if (key === 'incorrect') return 0;
  return null;
}

function classifyConfidenceLabel(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'low';
  if (n >= 72) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

function average(values = []) {
  const items = values.filter((v) => Number.isFinite(Number(v))).map(Number);
  if (!items.length) return null;
  return items.reduce((sum, v) => sum + v, 0) / items.length;
}

function normalizeScorecardRow(row = {}) {
  const strategyScoreLabel = toText(
    row?.strategyScoreLabel
    || row?.strategyRecommendationScore?.scoreLabel
    || ''
  ).toLowerCase();
  const tpScoreLabel = toText(
    row?.tpScoreLabel
    || row?.tpRecommendationScore?.scoreLabel
    || ''
  ).toLowerCase();

  return {
    date: normalizeDate(row?.recommendationDate || row?.date || ''),
    sourceType: toText(row?.sourceType || '').toLowerCase() || null,
    reconstructionPhase: toText(row?.reconstructionPhase || '').toLowerCase() || null,
    posture: toText(row?.posture || '').toLowerCase() || null,
    recommendedStrategyKey: normalizeStrategyKey(
      row?.recommendedStrategyKey
      || row?.strategyRecommendationScore?.recommendedStrategyKey
      || ''
    ) || null,
    recommendedTpMode: normalizeTpMode(
      row?.recommendedTpMode
      || row?.recommendedMechanicsOutcome?.tpMode
      || ''
    ) || null,
    weekday: toText(row?.weekday || weekdayFromDate(row?.recommendationDate || row?.date || '') || '') || null,
    timeBucket: toText(row?.timeBucket || '').toLowerCase() || null,
    postureEvaluation: toText(row?.postureEvaluation || '').toLowerCase() || null,
    strategyScoreLabel,
    tpScoreLabel,
    recommendationDelta: toNumber(row?.recommendationDelta, null),
  };
}

function buildFallbackLevels(target = {}) {
  return [
    {
      id: 'full_context',
      match: (row) => row.posture === target.posture
        && row.recommendedStrategyKey === target.recommendedStrategyKey
        && row.recommendedTpMode === target.recommendedTpMode
        && row.weekday === target.weekday
        && row.timeBucket === target.timeBucket
        && row.reconstructionPhase === target.reconstructionPhase,
    },
    {
      id: 'drop_weekday',
      match: (row) => row.posture === target.posture
        && row.recommendedStrategyKey === target.recommendedStrategyKey
        && row.recommendedTpMode === target.recommendedTpMode
        && row.timeBucket === target.timeBucket
        && row.reconstructionPhase === target.reconstructionPhase,
    },
    {
      id: 'drop_time_bucket',
      match: (row) => row.posture === target.posture
        && row.recommendedStrategyKey === target.recommendedStrategyKey
        && row.recommendedTpMode === target.recommendedTpMode
        && row.reconstructionPhase === target.reconstructionPhase,
    },
    {
      id: 'global_fallback',
      match: (row) => !target.reconstructionPhase || row.reconstructionPhase === target.reconstructionPhase,
    },
  ];
}

function sampleQualityLabel(sampleSize) {
  const n = Number(sampleSize || 0);
  if (n < 5) return 'insufficient';
  if (n < 10) return 'thin';
  if (n < 20) return 'limited';
  return 'robust';
}

function isWeakRegimeTrustBias(label = '') {
  const normalized = toText(label).toLowerCase();
  if (!normalized) return false;
  return normalized === 'insufficient_live_confirmation'
    || normalized === 'suppress_regime_bias'
    || normalized === 'weak_live_confirmation'
    || normalized === 'mixed_live_confirmation';
}

function isMixedOrReducedRegimeTrustBias(label = '') {
  const normalized = toText(label).toLowerCase();
  if (!normalized) return false;
  return normalized === 'mixed_support'
    || normalized === 'reduce_regime_weight'
    || normalized === 'mixed_live_confirmation'
    || normalized === 'suppress_regime_bias'
    || normalized === 'balance_regime_weight';
}

function classifyEvidenceSourceType(sourceType = '') {
  const normalized = toText(sourceType).toLowerCase();
  if (!normalized) return 'other';
  if (normalized.includes('live')) return 'live';
  if (normalized.includes('backfill') || normalized.includes('retro') || normalized.includes('reconstruct')) {
    return 'backfill';
  }
  return 'other';
}

function computeMetrics(rows = []) {
  const postureAccuracy = average(rows.map((r) => labelScore(r.postureEvaluation)));
  const strategyAccuracy = average(rows.map((r) => labelScore(r.strategyScoreLabel)));
  const tpAccuracy = average(rows.map((r) => labelScore(r.tpScoreLabel)));
  const recommendationDelta = average(rows.map((r) => r.recommendationDelta));
  return {
    postureAccuracy: postureAccuracy == null ? null : round2(postureAccuracy * 100),
    strategyAccuracy: strategyAccuracy == null ? null : round2(strategyAccuracy * 100),
    tpAccuracy: tpAccuracy == null ? null : round2(tpAccuracy * 100),
    avgRecommendationDelta: recommendationDelta == null ? null : round2(recommendationDelta),
  };
}

function computeCalibrationDelta(metrics = {}) {
  const components = [];
  if (Number.isFinite(Number(metrics.postureAccuracy))) {
    components.push({
      weight: 0.45,
      score: clamp((Number(metrics.postureAccuracy) - 55) / 45, -1, 1),
    });
  }
  if (Number.isFinite(Number(metrics.strategyAccuracy))) {
    components.push({
      weight: 0.25,
      score: clamp((Number(metrics.strategyAccuracy) - 55) / 45, -1, 1),
    });
  }
  if (Number.isFinite(Number(metrics.tpAccuracy))) {
    components.push({
      weight: 0.2,
      score: clamp((Number(metrics.tpAccuracy) - 55) / 45, -1, 1),
    });
  }
  if (Number.isFinite(Number(metrics.avgRecommendationDelta))) {
    components.push({
      weight: 0.1,
      score: clamp(Number(metrics.avgRecommendationDelta) / 150, -1, 1),
    });
  }
  if (!components.length) return 0;

  const weightedScore = components.reduce((acc, item) => {
    acc.weight += item.weight;
    acc.total += (item.score * item.weight);
    return acc;
  }, { total: 0, weight: 0 });
  const composite = weightedScore.weight > 0 ? (weightedScore.total / weightedScore.weight) : 0;
  const delta = composite >= 0
    ? composite * 10
    : composite * 15;
  return round2(clamp(delta, -15, 10));
}

function calibrateConfidenceForRecommendation(input = {}) {
  const todayRecommendation = input.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const scorecardsRaw = Array.isArray(input.scorecards) ? input.scorecards : [];
  const recommendationDate = normalizeDate(
    input.recommendationDate
    || todayRecommendation?.recommendationDate
    || input?.nowEt?.date
    || input?.context?.nowEt?.date
    || ''
  );
  const target = {
    posture: toText(todayRecommendation?.posture || input?.context?.posture || '').toLowerCase() || null,
    recommendedStrategyKey: normalizeStrategyKey(
      input?.context?.recommendedStrategyKey
      || todayRecommendation?.recommendedStrategyKey
      || ''
    ) || null,
    recommendedTpMode: normalizeTpMode(
      input?.context?.recommendedTpMode
      || todayRecommendation?.recommendedTpMode
      || ''
    ) || null,
    weekday: toText(input?.context?.weekday || weekdayFromDate(recommendationDate) || '') || null,
    timeBucket: toText(input?.context?.timeBucket || '').toLowerCase() || null,
    reconstructionPhase: (() => {
      const phase = toText(input?.context?.reconstructionPhase || '').toLowerCase();
      return phase || null;
    })(),
  };

  const baseConfidenceScore = clamp(
    Number.isFinite(Number(todayRecommendation?.confidenceScore))
      ? Number(todayRecommendation.confidenceScore)
      : Number(input?.baseConfidenceScore || 50),
    1,
    99
  );
  const confidenceLabelBefore = classifyConfidenceLabel(baseConfidenceScore);

  const historicalRows = scorecardsRaw
    .map((row) => normalizeScorecardRow(row))
    .filter((row) => {
      if (!row?.date) return false;
      if (recommendationDate && row.date >= recommendationDate) return false;
      return true;
    });

  const fallbackLevels = buildFallbackLevels(target);
  let selectedRows = [];
  let fallbackLevel = 'none';
  for (const level of fallbackLevels) {
    const matched = historicalRows.filter(level.match);
    if (matched.length >= 5) {
      selectedRows = matched;
      fallbackLevel = level.id;
      break;
    }
    if (!selectedRows.length && matched.length > 0) {
      selectedRows = matched;
      fallbackLevel = level.id;
    }
  }

  const sampleSize = selectedRows.length;
  const sampleQuality = sampleQualityLabel(sampleSize);
  const metrics = computeMetrics(selectedRows);
  const evidenceSource = toText(input.evidenceSource || 'all').toLowerCase() || 'all';
  const fallbackLevelFromContext = toText(input?.context?.fallbackLevel || '').toLowerCase() || null;
  const fallbackDriven = !!fallbackLevelFromContext && fallbackLevelFromContext !== 'exact_context';
  const liveConfirmationWeak = input?.context?.liveConfirmationWeak === true;
  const weakRegimeTrustBias = isWeakRegimeTrustBias(input?.context?.regimeTrustBiasLabel);
  const mixedOrReducedRegimeTrustBias = isMixedOrReducedRegimeTrustBias(input?.context?.regimeTrustBiasLabel);
  const selectedSourceBreakdown = selectedRows.reduce((acc, row) => {
    const bucket = classifyEvidenceSourceType(row?.sourceType);
    acc.total += 1;
    acc[bucket] += 1;
    return acc;
  }, { live: 0, backfill: 0, other: 0, total: 0 });
  const liveSharePct = selectedSourceBreakdown.total > 0
    ? round2((selectedSourceBreakdown.live / selectedSourceBreakdown.total) * 100)
    : 0;
  const backfillDominant = selectedSourceBreakdown.backfill > selectedSourceBreakdown.live;
  const lowLiveShare = liveSharePct < 25;
  const weakPrecisionNoPositiveUplift = fallbackDriven && (liveConfirmationWeak || weakRegimeTrustBias);
  const mixedPrecisionNoPositiveUplift = fallbackDriven
    && !weakPrecisionNoPositiveUplift
    && mixedOrReducedRegimeTrustBias
    && backfillDominant
    && lowLiveShare;
  let confidenceClampReason = null;
  let positiveUpliftSuppressed = false;
  let mixedPrecisionUpliftSuppressed = false;

  let calibrationDelta = computeCalibrationDelta(metrics);
  if (fallbackLevel === 'drop_weekday' || fallbackLevel === 'drop_time_bucket') {
    calibrationDelta = round2(calibrationDelta * 0.8);
  } else if (fallbackLevel === 'global_fallback') {
    calibrationDelta = round2(calibrationDelta * 0.6);
  }

  if (weakPrecisionNoPositiveUplift && calibrationDelta > 0) {
    calibrationDelta = 0;
    confidenceClampReason = 'weak_precision_no_positive_uplift';
    positiveUpliftSuppressed = true;
  }

  if (mixedPrecisionNoPositiveUplift && calibrationDelta > 0) {
    calibrationDelta = 0;
    confidenceClampReason = 'mixed_precision_no_positive_uplift';
    mixedPrecisionUpliftSuppressed = true;
  }

  if (sampleSize < 5) {
    calibrationDelta = 0;
    confidenceClampReason = 'insufficient_sample_no_calibration';
  } else if (sampleSize < 10) {
    calibrationDelta = round2(clamp(calibrationDelta, -4, 4));
    confidenceClampReason = 'thin_sample_clamp';
  }

  let calibratedConfidenceScore = round2(clamp(baseConfidenceScore + calibrationDelta, 1, 99));
  let mixedPrecisionConfidenceCeilingApplied = false;
  if (mixedPrecisionNoPositiveUplift && calibratedConfidenceScore >= 72) {
    calibratedConfidenceScore = 71.99;
    mixedPrecisionConfidenceCeilingApplied = true;
    confidenceClampReason = 'mixed_precision_confidence_ceiling';
  }
  const confidenceLabelAfter = classifyConfidenceLabel(calibratedConfidenceScore);
  const evidenceDates = selectedRows
    .map((row) => row.date)
    .filter(Boolean)
    .sort();

  let calibrationReason = 'Confidence maintained because historical evidence is neutral.';
  if (positiveUpliftSuppressed) {
    calibrationReason = 'Confidence uplift suppressed because current evidence precision is weak (fallback context with weak trust/live confirmation).';
  } else if (mixedPrecisionConfidenceCeilingApplied) {
    calibrationReason = 'Confidence capped at medium because fallback/global evidence is mixed-precision, backfill-dominant, and reduced-trust.';
  } else if (mixedPrecisionUpliftSuppressed) {
    calibrationReason = 'Confidence uplift suppressed because fallback/global evidence is mixed-precision, backfill-dominant, and reduced-trust.';
  } else if (sampleSize < 5) {
    calibrationReason = 'Confidence maintained due to limited comparable historical samples.';
  } else if (calibrationDelta < 0) {
    calibrationReason = 'Confidence reduced because similar recommendations have historically underperformed.';
  } else if (calibrationDelta > 0) {
    calibrationReason = 'Confidence slightly increased because similar recommendations have historically outperformed.';
  }
  if (fallbackLevel !== 'full_context' && sampleSize >= 5) {
    calibrationReason = `${calibrationReason} Used ${fallbackLevel.replace(/_/g, ' ')} evidence matching.`;
  }

  return {
    baseConfidenceScore: round2(baseConfidenceScore),
    calibratedConfidenceScore,
    calibrationDelta,
    confidenceLabelBefore,
    confidenceLabelAfter,
    calibrationReason,
    evidenceWindow: {
      fallbackLevel,
      recommendationDate: recommendationDate || null,
      oldestEvidenceDate: evidenceDates[0] || null,
      newestEvidenceDate: evidenceDates[evidenceDates.length - 1] || null,
      metrics,
      bucket: {
        posture: target.posture,
        recommendedStrategyKey: target.recommendedStrategyKey,
        recommendedTpMode: target.recommendedTpMode,
        weekday: target.weekday,
        timeBucket: target.timeBucket,
        reconstructionPhase: target.reconstructionPhase,
      },
    },
    evidenceSource,
    sampleSize,
    sampleQuality,
    confidenceClampReason,
    weakPrecisionNoPositiveUplift,
    mixedPrecisionNoPositiveUplift,
    mixedPrecisionConfidenceCeilingApplied,
    precisionContext: {
      fallbackLevel: fallbackLevelFromContext,
      liveConfirmationWeak,
      weakRegimeTrustBias,
      mixedOrReducedRegimeTrustBias,
      liveSharePct,
      backfillDominant,
      sourceBreakdown: selectedSourceBreakdown,
    },
    advisoryOnly: true,
  };
}

function applyConfidenceCalibration(input = {}) {
  const todayRecommendation = input.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? { ...input.todayRecommendation }
    : {};
  const confidenceCalibration = calibrateConfidenceForRecommendation({
    todayRecommendation,
    scorecards: input.scorecards,
    recommendationDate: input.recommendationDate,
    context: input.context,
    evidenceSource: input.evidenceSource,
    baseConfidenceScore: input.baseConfidenceScore,
  });
  todayRecommendation.confidenceScore = confidenceCalibration.calibratedConfidenceScore;
  todayRecommendation.confidenceLabel = confidenceCalibration.confidenceLabelAfter;
  todayRecommendation.confidenceCalibration = confidenceCalibration;
  todayRecommendation.confidenceCalibrated = true;
  return {
    todayRecommendation,
    confidenceCalibration,
  };
}

module.exports = {
  classifyConfidenceLabel,
  calibrateConfidenceForRecommendation,
  applyConfidenceCalibration,
};
