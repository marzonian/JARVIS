'use strict';

const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const TRUST_CONSUMPTION_LABELS = new Set([
  'allow_regime_confidence',
  'allow_with_caution',
  'reduce_regime_weight',
  'suppress_regime_bias',
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

function normalizeTrustBiasLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_confirmed') return 'live_confirmed';
  if (txt === 'mixed_support') return 'mixed_support';
  if (txt === 'retrospective_led') return 'retrospective_led';
  return 'insufficient_live_confirmation';
}

function normalizeUsefulnessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong' || txt === 'moderate' || txt === 'weak' || txt === 'noisy') return txt;
  return 'insufficient';
}

function classifyEvidenceQuality(breakdown = {}) {
  const live = Math.max(0, Number(breakdown.live || 0));
  const backfill = Math.max(0, Number(breakdown.backfill || 0));
  const total = Math.max(0, Number(breakdown.total || (live + backfill)));
  if (total < 10) return 'thin';
  if (backfill >= (live * 2) && backfill >= 10) return 'retrospective_heavy';
  if (live >= 20 && live >= (backfill * 1.5)) return 'strong_live';
  return 'mixed';
}

function findRegimeRow(rows = [], regimeLabel = '') {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    normalizeRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
  )) || null;
}

function parseTrustConsumptionLabel(input = {}) {
  const trustBiasLabel = normalizeTrustBiasLabel(input.trustBiasLabel);
  const currentRegimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const liveLabel = normalizeUsefulnessLabel(input.liveOnlyUsefulnessLabel);
  const liveSample = Math.max(0, Number(input.liveDirectSampleSize || 0));
  const scoreGap = toNumber(input.scoreGap, null);
  const provenanceStrengthLabel = toText(input.provenanceStrengthLabel).toLowerCase();
  const materiallyLargeGap = Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12;

  if (
    trustBiasLabel === 'insufficient_live_confirmation'
    || liveLabel === 'insufficient'
    || liveSample < 5
  ) {
    return {
      trustConsumptionLabel: 'suppress_regime_bias',
      trustConsumptionReason: `Live regime confirmation is insufficient for ${currentRegimeLabel} (live sample ${liveSample}).`,
    };
  }

  if (
    trustBiasLabel === 'live_confirmed'
    && liveSample >= 10
    && (liveLabel === 'strong' || liveLabel === 'moderate')
  ) {
    return {
      trustConsumptionLabel: 'allow_regime_confidence',
      trustConsumptionReason: `${currentRegimeLabel} has live-confirmed regime support with adequate sample.`,
    };
  }

  if (
    trustBiasLabel === 'retrospective_led'
    || materiallyLargeGap
    || provenanceStrengthLabel === 'retrospective_heavy'
  ) {
    return {
      trustConsumptionLabel: 'reduce_regime_weight',
      trustConsumptionReason: `${currentRegimeLabel} appears retrospective-led versus live confirmation; reduce regime-conditioned weight.`,
    };
  }

  if (trustBiasLabel === 'mixed_support' && liveLabel !== 'insufficient' && liveLabel !== 'weak') {
    return {
      trustConsumptionLabel: 'allow_with_caution',
      trustConsumptionReason: `${currentRegimeLabel} has mixed live/retrospective support; keep regime messaging cautious.`,
    };
  }

  return {
    trustConsumptionLabel: 'reduce_regime_weight',
    trustConsumptionReason: `${currentRegimeLabel} regime support is not strong enough for full confidence weighting.`,
  };
}

function computeConfidenceOverride(input = {}) {
  const trustConsumptionLabel = toText(input.trustConsumptionLabel).toLowerCase();
  const trustBiasLabel = normalizeTrustBiasLabel(input.trustBiasLabel);
  const currentRegimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const liveLabel = normalizeUsefulnessLabel(input.liveOnlyUsefulnessLabel);
  const liveSample = Math.max(0, Number(input.liveDirectSampleSize || 0));
  const scoreGap = toNumber(input.scoreGap, null);
  const provenanceStrengthLabel = toText(input.provenanceStrengthLabel).toLowerCase();
  const materiallyLargeGap = Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12;

  let out = 0;
  if (trustConsumptionLabel === 'allow_regime_confidence') {
    out = 2;
    if (liveLabel === 'strong') out += 1;
    if (liveSample >= 20) out += 1;
    if (!Number.isFinite(scoreGap) || Math.abs(scoreGap) <= 5) out += 1;
    out = clamp(out, 0, 5);
  } else if (trustConsumptionLabel === 'allow_with_caution') {
    out = 0;
    if (liveSample < 15) out -= 1;
    if (materiallyLargeGap) out -= 1;
    if (liveLabel === 'noisy' || liveLabel === 'weak') out -= 1;
    out = clamp(out, -2, 2);
  } else if (trustConsumptionLabel === 'reduce_regime_weight') {
    out = -4;
    if (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 20) out = -8;
    else if (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12) out = -6;
    else if (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 8) out = -5;
    if (provenanceStrengthLabel === 'retrospective_heavy') out -= 1;
    if (liveSample < 10) out -= 1;
    out = clamp(out, -8, -3);
  } else {
    out = -7;
    if (liveSample === 0) out = -10;
    else if (liveSample < 3) out = -9;
    else if (liveSample < 5) out = -8;
    out = clamp(out, -12, -6);
  }

  if (trustBiasLabel === 'insufficient_live_confirmation') out = Math.min(out, -6);
  if (trustBiasLabel === 'retrospective_led') out = Math.min(out, 0);
  if ((currentRegimeLabel === 'mixed' || currentRegimeLabel === 'unknown') && trustBiasLabel !== 'live_confirmed') {
    out = Math.min(out, 0);
  }

  return round2(out);
}

function computeSuppressionFlags(input = {}) {
  const trustConsumptionLabel = toText(input.trustConsumptionLabel).toLowerCase();
  const liveSample = Math.max(0, Number(input.liveDirectSampleSize || 0));
  const regimeAwareLearning = input.regimeAwareLearning && typeof input.regimeAwareLearning === 'object'
    ? input.regimeAwareLearning
    : {};
  const currentRegimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const topRegimeAlignedStrategy = regimeAwareLearning?.topRegimeAlignedStrategy
    && typeof regimeAwareLearning.topRegimeAlignedStrategy === 'object'
    ? regimeAwareLearning.topRegimeAlignedStrategy
    : null;
  const opportunityRows = Array.isArray(regimeAwareLearning?.regimeSpecificOpportunities)
    ? regimeAwareLearning.regimeSpecificOpportunities
    : [];
  const todayRecommendation = input.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const recommendationBasisText = toText(
    todayRecommendation?.recommendationBasis
      || todayRecommendation?.recommendationBasisLabel
      || todayRecommendation?.strategyReason
      || ''
  ).toLowerCase();
  const regimeDependentRecommendation = recommendationBasisText.includes('regime')
    || recommendationBasisText.includes('context');

  const hasCurrentRegimeOpportunity = opportunityRows.some((row) => (
    normalizeRegimeLabel(row?.regimeLabel || 'unknown') === currentRegimeLabel
  )) || (
    normalizeRegimeLabel(topRegimeAlignedStrategy?.regimeLabel || 'unknown') === currentRegimeLabel
  );
  const shouldSuppressOpportunity = hasCurrentRegimeOpportunity || regimeDependentRecommendation;

  if (trustConsumptionLabel === 'suppress_regime_bias') {
    return {
      shouldSuppressRegimeOpportunity: shouldSuppressOpportunity,
      shouldSuppressRegimeRisk: false,
      shouldSuppressTopRegimeAlignedStrategy: true,
    };
  }
  if (trustConsumptionLabel === 'reduce_regime_weight') {
    return {
      shouldSuppressRegimeOpportunity: shouldSuppressOpportunity,
      shouldSuppressRegimeRisk: false,
      shouldSuppressTopRegimeAlignedStrategy: liveSample < 5,
    };
  }
  return {
    shouldSuppressRegimeOpportunity: false,
    shouldSuppressRegimeRisk: false,
    shouldSuppressTopRegimeAlignedStrategy: false,
  };
}

function buildRegimeTrustInsight(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const trustConsumptionLabel = toText(input.trustConsumptionLabel).toLowerCase();
  const liveSample = Math.max(0, Number(input.liveDirectSampleSize || 0));

  if (trustConsumptionLabel === 'allow_regime_confidence') {
    return `${regimeLabel} regime trust is live-confirmed; regime-conditioned confidence can be used normally.`;
  }
  if (trustConsumptionLabel === 'allow_with_caution') {
    return `${regimeLabel} regime trust is mixed; keep regime-conditioned confidence cautious.`;
  }
  if (trustConsumptionLabel === 'reduce_regime_weight') {
    return `${regimeLabel} regime trust is retrospective-led; reduce regime-conditioned recommendation weight.`;
  }
  return `${regimeLabel} regime trust is not live-confirmed (live sample ${liveSample}); suppress regime-biased opportunity confidence.`;
}

function buildRegimeTrustConsumptionSummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const regimeDetection = input.regimeDetection && typeof input.regimeDetection === 'object'
    ? input.regimeDetection
    : {};
  const regimeAwareLearning = input.regimeAwareLearning && typeof input.regimeAwareLearning === 'object'
    ? input.regimeAwareLearning
    : {};
  const regimePerformanceFeedback = input.regimePerformanceFeedback && typeof input.regimePerformanceFeedback === 'object'
    ? input.regimePerformanceFeedback
    : {};
  const regimeEvidenceSplit = input.regimeEvidenceSplit && typeof input.regimeEvidenceSplit === 'object'
    ? input.regimeEvidenceSplit
    : {};
  const recommendationPerformanceSummary = input.recommendationPerformanceSummary && typeof input.recommendationPerformanceSummary === 'object'
    ? input.recommendationPerformanceSummary
    : (
      input.recommendationPerformance?.summary && typeof input.recommendationPerformance.summary === 'object'
        ? input.recommendationPerformance.summary
        : {}
    );

  const currentRegimeLabel = normalizeRegimeLabel(
    regimeDetection?.regimeLabel
      || regimeEvidenceSplit?.currentRegimeLabel
      || input.currentRegimeLabel
      || 'unknown'
  );
  const trustBiasLabel = normalizeTrustBiasLabel(
    regimeEvidenceSplit?.trustBiasLabel
      || regimeEvidenceSplit?.currentRegimeComparison?.trustBiasLabel
      || 'insufficient_live_confirmation'
  );
  const trustBiasReason = toText(
    regimeEvidenceSplit?.trustBiasReason
      || regimeEvidenceSplit?.currentRegimeComparison?.trustBiasReason
      || 'Live regime confirmation is insufficient.'
  ) || 'Live regime confirmation is insufficient.';

  const allRow = findRegimeRow(regimeEvidenceSplit?.allEvidenceByRegime, currentRegimeLabel) || {};
  const liveRow = findRegimeRow(regimeEvidenceSplit?.liveOnlyByRegime, currentRegimeLabel) || {};
  const comparison = regimeEvidenceSplit?.currentRegimeComparison
    && normalizeRegimeLabel(regimeEvidenceSplit.currentRegimeComparison.regimeLabel || 'unknown') === currentRegimeLabel
    ? regimeEvidenceSplit.currentRegimeComparison
    : {};

  const liveOnlyUsefulnessLabel = normalizeUsefulnessLabel(
    comparison?.liveOnlyUsefulnessLabel || liveRow?.usefulnessLabel || 'insufficient'
  );
  const allEvidenceUsefulnessLabel = normalizeUsefulnessLabel(
    comparison?.allEvidenceUsefulnessLabel || allRow?.usefulnessLabel || 'insufficient'
  );
  const liveDirectSampleSize = Math.max(0, Number(
    comparison?.liveDirectSampleSize != null
      ? comparison.liveDirectSampleSize
      : liveRow?.liveDirectSampleSize || 0
  ));
  const allEvidenceDirectSampleSize = Math.max(0, Number(
    comparison?.allEvidenceDirectSampleSize != null
      ? comparison.allEvidenceDirectSampleSize
      : allRow?.directProvenanceSampleSize || 0
  ));
  const allEvidenceUsefulnessScore = toNumber(
    comparison?.allEvidenceUsefulnessScore != null
      ? comparison.allEvidenceUsefulnessScore
      : allRow?.usefulnessScore,
    null
  );
  const liveOnlyUsefulnessScore = toNumber(
    comparison?.liveOnlyUsefulnessScore != null
      ? comparison.liveOnlyUsefulnessScore
      : liveRow?.usefulnessScore,
    null
  );
  const scoreGap = Number.isFinite(toNumber(comparison?.scoreGap, null))
    ? round2(Number(comparison.scoreGap))
    : (
      Number.isFinite(allEvidenceUsefulnessScore) && Number.isFinite(liveOnlyUsefulnessScore)
        ? round2(allEvidenceUsefulnessScore - liveOnlyUsefulnessScore)
        : null
    );
  const provenanceStrengthLabel = toText(allRow?.provenanceStrengthLabel || '').toLowerCase() || 'absent';

  const evidenceQuality = toText(regimePerformanceFeedback?.regimeConfidenceGuidance?.evidenceQuality || '').toLowerCase()
    || classifyEvidenceQuality(allRow?.evidenceSourceBreakdown || {});

  const trustConsumption = parseTrustConsumptionLabel({
    trustBiasLabel,
    currentRegimeLabel,
    liveOnlyUsefulnessLabel,
    liveDirectSampleSize,
    scoreGap,
    provenanceStrengthLabel,
  });
  const trustConsumptionLabel = TRUST_CONSUMPTION_LABELS.has(trustConsumption.trustConsumptionLabel)
    ? trustConsumption.trustConsumptionLabel
    : 'suppress_regime_bias';

  let trustConsumptionReason = toText(trustConsumption.trustConsumptionReason) || 'Regime trust evidence is limited; keep confidence conservative.';
  if (
    trustConsumptionLabel !== 'allow_regime_confidence'
    && liveDirectSampleSize < 5
    && !trustConsumptionReason.toLowerCase().includes('live sample')
  ) {
    trustConsumptionReason = `${trustConsumptionReason} Live sample is ${liveDirectSampleSize}.`;
  }

  const confidenceAdjustmentOverride = computeConfidenceOverride({
    trustConsumptionLabel,
    trustBiasLabel,
    currentRegimeLabel,
    liveOnlyUsefulnessLabel,
    liveDirectSampleSize,
    scoreGap,
    provenanceStrengthLabel,
  });

  const suppression = computeSuppressionFlags({
    trustConsumptionLabel,
    currentRegimeLabel,
    liveDirectSampleSize,
    regimeAwareLearning,
    todayRecommendation: input.todayRecommendation,
  });

  const currentRegimeTrustSnapshot = {
    regimeLabel: currentRegimeLabel,
    trustBiasLabel,
    trustConsumptionLabel,
    liveOnlyUsefulnessLabel,
    allEvidenceUsefulnessLabel,
    liveDirectSampleSize,
    allEvidenceDirectSampleSize,
    scoreGap: Number.isFinite(scoreGap) ? round2(scoreGap) : null,
    provenanceStrengthLabel,
    evidenceQuality,
    advisoryOnly: true,
  };

  const recommendationWarnings = [
    ...(Array.isArray(recommendationPerformanceSummary?.warnings) ? recommendationPerformanceSummary.warnings : []),
    ...(Array.isArray(recommendationPerformanceSummary?.calibrationWarnings) ? recommendationPerformanceSummary.calibrationWarnings : []),
  ];
  if (trustConsumptionLabel !== 'allow_regime_confidence' && recommendationWarnings.includes('insufficient_calibration_sample')) {
    trustConsumptionReason = `${trustConsumptionReason} Recommendation calibration sample is still thin.`;
  }

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    currentRegimeLabel,
    trustBiasLabel,
    trustBiasReason,
    trustConsumptionLabel,
    trustConsumptionReason,
    confidenceAdjustmentOverride,
    shouldSuppressRegimeOpportunity: suppression.shouldSuppressRegimeOpportunity === true,
    shouldSuppressRegimeRisk: suppression.shouldSuppressRegimeRisk === true,
    shouldSuppressTopRegimeAlignedStrategy: suppression.shouldSuppressTopRegimeAlignedStrategy === true,
    currentRegimeTrustSnapshot,
    regimeTrustInsight: buildRegimeTrustInsight({
      currentRegimeLabel,
      trustConsumptionLabel,
      liveDirectSampleSize,
    }),
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimeTrustConsumptionSummary,
};
