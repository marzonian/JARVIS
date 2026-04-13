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

const DURABILITY_STATES = new Set([
  'unconfirmed',
  'building_durability',
  'durable_confirmed',
  'fragile_confirmation',
  'decaying_confirmation',
  'recovering_confirmation',
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

function normalizeUsefulnessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong' || txt === 'moderate' || txt === 'weak' || txt === 'noisy') return txt;
  return 'insufficient';
}

function normalizeTrustBiasLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_confirmed') return 'live_confirmed';
  if (txt === 'mixed_support') return 'mixed_support';
  if (txt === 'retrospective_led') return 'retrospective_led';
  return 'insufficient_live_confirmation';
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
}

function parseEvidenceQuality(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong_live' || txt === 'mixed' || txt === 'retrospective_heavy' || txt === 'thin') return txt;
  return 'thin';
}

function normalizePersistenceSource(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'persisted_live_history'
    || txt === 'persisted_reconstructed_history'
    || txt === 'mixed_persisted_history'
    || txt === 'proxy_only'
  ) {
    return txt;
  }
  return 'proxy_only';
}

function deriveRowPersistenceSource(historyRow = null) {
  if (!historyRow || historyRow.hasRealPersistenceHistory !== true) return 'proxy_only';
  const breakdown = historyRow?.provenanceBreakdown && typeof historyRow.provenanceBreakdown === 'object'
    ? historyRow.provenanceBreakdown
    : {};
  const live = Math.max(0, Number(breakdown.liveCapturedDays || 0));
  const reconstructed = Math.max(0, Number(breakdown.reconstructedDays || 0));
  const mixed = Math.max(0, Number(breakdown.mixedDays || 0));
  const hasLiveCapturedHistory = historyRow?.hasLiveCapturedHistory === true
    || Math.max(0, Number(historyRow?.liveCapturedSnapshotCount || 0)) > 0
    || Math.max(0, Number(historyRow?.liveCapturedTenureDays || 0)) > 0
    || live > 0;
  if (mixed > 0 || (hasLiveCapturedHistory && reconstructed > 0)) return 'mixed_persisted_history';
  if (mixed > 0 && !hasLiveCapturedHistory) return 'persisted_reconstructed_history';
  if (!hasLiveCapturedHistory && reconstructed > 0) return 'persisted_reconstructed_history';
  if (live > 0) return 'persisted_live_history';
  if (reconstructed > 0 || mixed > 0) return 'persisted_reconstructed_history';
  return 'proxy_only';
}

function findByRegime(rows = [], regimeLabel = '') {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  return (Array.isArray(rows) ? rows : []).find((row) => (
    normalizeRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
  )) || null;
}

function classifyEvidenceQualityFromBreakdown(breakdown = {}) {
  const live = Math.max(0, Number(breakdown.live || 0));
  const backfill = Math.max(0, Number(breakdown.backfill || 0));
  const total = Math.max(0, Number(breakdown.total || (live + backfill)));
  if (total < 10) return 'thin';
  if (backfill >= (live * 2) && backfill >= 10) return 'retrospective_heavy';
  if (live >= 20 && live >= (backfill * 1.5)) return 'strong_live';
  return 'mixed';
}

function deriveTrustBiasLabelForRegime(regimeLabel = '', allRow = {}, liveRow = {}) {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  const allLabel = normalizeUsefulnessLabel(allRow?.usefulnessLabel || 'insufficient');
  const liveLabel = normalizeUsefulnessLabel(liveRow?.usefulnessLabel || 'insufficient');
  const liveSample = Math.max(0, Number(
    liveRow?.liveDirectSampleSize != null
      ? liveRow.liveDirectSampleSize
      : liveRow?.liveSampleSize || 0
  ));
  const allScore = toNumber(allRow?.usefulnessScore, null);
  const liveScore = toNumber(liveRow?.usefulnessScore, null);
  const scoreGap = (
    Number.isFinite(allScore) && Number.isFinite(liveScore)
      ? round2(allScore - liveScore)
      : null
  );
  const breakdown = allRow?.evidenceSourceBreakdown && typeof allRow.evidenceSourceBreakdown === 'object'
    ? allRow.evidenceSourceBreakdown
    : { live: 0, backfill: 0, total: 0 };
  const backfillDominant = Number(breakdown.backfill || 0) >= (Number(breakdown.live || 0) * 2)
    && Number(breakdown.backfill || 0) >= 10;

  if (liveSample < 5 || liveLabel === 'insufficient' || toText(liveRow?.coverageType).toLowerCase() === 'no_support') {
    return 'insufficient_live_confirmation';
  }
  if (
    liveSample >= 10
    && (liveLabel === 'strong' || liveLabel === 'moderate')
    && (!Number.isFinite(scoreGap) || Math.abs(scoreGap) <= 8)
  ) {
    if ((safe === 'mixed' || safe === 'unknown') && !(liveSample >= 20 && Number(liveScore || 0) >= 70)) {
      return 'mixed_support';
    }
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

function deriveTrustConsumptionFromBias(input = {}) {
  const trustBiasLabel = normalizeTrustBiasLabel(input.trustBiasLabel);
  const liveSample = Math.max(0, Number(input.liveSampleSize || 0));
  const liveUsefulnessLabel = normalizeUsefulnessLabel(input.liveUsefulnessLabel || 'insufficient');
  const scoreGap = toNumber(input.scoreGap, null);
  const provenanceStrengthLabel = toText(input.provenanceStrengthLabel).toLowerCase();
  const materiallyLargeGap = Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12;

  if (trustBiasLabel === 'insufficient_live_confirmation' || liveSample < 5 || liveUsefulnessLabel === 'insufficient') {
    return 'suppress_regime_bias';
  }
  if (
    trustBiasLabel === 'live_confirmed'
    && liveSample >= 10
    && (liveUsefulnessLabel === 'strong' || liveUsefulnessLabel === 'moderate')
  ) {
    return 'allow_regime_confidence';
  }
  if (
    trustBiasLabel === 'retrospective_led'
    || materiallyLargeGap
    || provenanceStrengthLabel === 'retrospective_heavy'
  ) {
    return 'reduce_regime_weight';
  }
  return 'allow_with_caution';
}

function deriveRequiredSampleForPromotion(regimeLabel = '', liveRow = {}) {
  const safe = normalizeRegimeLabel(regimeLabel || 'unknown');
  const explicit = toNumber(liveRow?.requiredSampleForPromotion, null);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return (safe === 'mixed' || safe === 'unknown') ? 30 : 15;
}

function derivePersistenceWindowCount(liveSampleSize = 0) {
  const sample = Math.max(0, Number(liveSampleSize || 0));
  if (sample <= 0) return 0;
  if (sample < 5) return 1;
  if (sample < 10) return 2;
  if (sample < 15) return 3;
  if (sample < 20) return 4;
  if (sample < 30) return 5;
  return 6;
}

function computeDurabilityScore(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const promotionState = toText(input.latestPromotionState || '').toLowerCase();
  const confirmationProgress = clamp(Number(input.latestConfirmationProgressPct || 0), 0, 100);
  const liveSample = Math.max(0, Number(input.latestLiveSampleSize || 0));
  const requiredSample = Math.max(1, Number(input.requiredSampleForPromotion || 15));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const evidenceQuality = parseEvidenceQuality(input.evidenceQuality);
  const scoreGap = toNumber(input.scoreGap, null);
  const liveUsefulnessScore = toNumber(input.liveUsefulnessScore, null);
  const liveConfidenceAdjustment = toNumber(input.liveConfidenceAdjustment, 0);

  let score = confirmationProgress;

  if (promotionState === 'live_confirmed') score += 15;
  else if (promotionState === 'near_live_confirmation') score += 8;
  else if (promotionState === 'emerging_live_support') score += 3;
  else if (promotionState === 'stalled_live_support') score -= 8;
  else if (promotionState === 'no_live_support') score -= 15;

  if (trustConsumptionLabel === 'allow_regime_confidence') score += 12;
  else if (trustConsumptionLabel === 'allow_with_caution') score += 5;
  else if (trustConsumptionLabel === 'reduce_regime_weight') score -= 8;
  else score -= 14;

  if (evidenceQuality === 'strong_live') score += 8;
  else if (evidenceQuality === 'retrospective_heavy') score -= 10;
  else if (evidenceQuality === 'thin') score -= 12;

  if (Number.isFinite(scoreGap)) {
    const absGap = Math.abs(scoreGap);
    if (absGap >= 20) score -= 14;
    else if (absGap >= 12) score -= 9;
    else if (absGap >= 8) score -= 5;
    else if (absGap <= 5) score += 2;
  }

  if (liveSample <= 0) score -= 12;
  else if (liveSample >= (requiredSample + 10)) score += 8;
  else if (liveSample >= (requiredSample + 5)) score += 6;
  else if (liveSample >= requiredSample) score += 3;
  else if (liveSample >= (requiredSample * 0.66)) score += 1;
  else if (liveSample >= (requiredSample * 0.4)) score -= 4;
  else score -= 8;

  if (liveConfidenceAdjustment >= 2) score += 3;
  else if (liveConfidenceAdjustment >= 0) score += 1;
  else score -= 2;

  if (regimeLabel === 'mixed' || regimeLabel === 'unknown') {
    const strongMixedUnknown = liveSample >= 30 && Number(liveUsefulnessScore || 0) >= 70;
    if (!strongMixedUnknown) score -= 10;
  }

  return round2(clamp(score, 0, 100));
}

function computeDurabilityProgress(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const confirmationProgress = clamp(Number(input.latestConfirmationProgressPct || 0), 0, 100);
  const liveSample = Math.max(0, Number(input.latestLiveSampleSize || 0));
  const requiredSample = Math.max(1, Number(input.requiredSampleForPromotion || 15));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const evidenceQuality = parseEvidenceQuality(input.evidenceQuality);
  const scoreGap = toNumber(input.scoreGap, null);
  const liveUsefulnessScore = toNumber(input.liveUsefulnessScore, null);
  const promotionState = toText(input.latestPromotionState).toLowerCase();

  if (promotionState === 'no_live_support' || liveSample <= 0) return 0;

  const sampleProgressPct = clamp((liveSample / requiredSample) * 100, 0, 130);
  const excessPct = clamp(((liveSample - requiredSample) / requiredSample) * 100, 0, 40);
  const sampleComposite = clamp((sampleProgressPct * 0.8) + (excessPct * 0.2), 0, 100);
  let trustComponent = 20;
  if (trustConsumptionLabel === 'allow_regime_confidence') trustComponent = 90;
  else if (trustConsumptionLabel === 'allow_with_caution') trustComponent = 70;
  else if (trustConsumptionLabel === 'reduce_regime_weight') trustComponent = 40;

  let progress = (0.5 * confirmationProgress) + (0.3 * sampleComposite) + (0.2 * trustComponent);

  if (evidenceQuality === 'retrospective_heavy') progress -= 15;
  else if (evidenceQuality === 'thin') progress -= 10;

  if (Number.isFinite(scoreGap)) {
    const absGap = Math.abs(scoreGap);
    if (absGap >= 20) progress -= 15;
    else if (absGap >= 12) progress -= 10;
    else if (absGap >= 8) progress -= 5;
  }

  if (regimeLabel === 'mixed' || regimeLabel === 'unknown') {
    const strongMixedUnknown = liveSample >= 30 && Number(liveUsefulnessScore || 0) >= 70;
    if (!strongMixedUnknown) progress -= 10;
  }

  return round2(clamp(progress, 0, 100));
}

function classifyDurabilityState(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const promotionState = toText(input.latestPromotionState || '').toLowerCase();
  const confirmationProgress = clamp(Number(input.latestConfirmationProgressPct || 0), 0, 100);
  const liveSample = Math.max(0, Number(input.latestLiveSampleSize || 0));
  const requiredSample = Math.max(1, Number(input.requiredSampleForPromotion || 15));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const scoreGap = toNumber(input.scoreGap, null);
  const evidenceQuality = parseEvidenceQuality(input.evidenceQuality);
  const liveUsefulnessLabel = normalizeUsefulnessLabel(input.liveUsefulnessLabel || 'insufficient');
  const liveUsefulnessScore = toNumber(input.liveUsefulnessScore, null);
  const durabilityScore = clamp(Number(input.durabilityScore || 0), 0, 100);
  const durabilityProgressPct = clamp(Number(input.durabilityProgressPct || 0), 0, 100);

  const suppressed = trustConsumptionLabel === 'reduce_regime_weight' || trustConsumptionLabel === 'suppress_regime_bias';
  const largeGap = Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12;
  const retroHeavy = evidenceQuality === 'retrospective_heavy';
  const weakLive = (liveUsefulnessLabel === 'weak' || liveUsefulnessLabel === 'noisy' || liveUsefulnessLabel === 'insufficient');
  const mixedUnknown = regimeLabel === 'mixed' || regimeLabel === 'unknown';
  const strongMixedUnknown = mixedUnknown && liveSample >= 30 && Number(liveUsefulnessScore || 0) >= 70;
  const consecutiveQualifiedWindows = Math.max(0, Number(input.consecutiveQualifiedWindows || 0));
  const consecutiveWeakWindows = Math.max(0, Number(input.consecutiveWeakWindows || 0));
  const decayCount = Math.max(0, Number(input.decayCount || 0));
  const recoveryCount = Math.max(0, Number(input.recoveryCount || 0));
  const liveConfirmedTenureDays = Math.max(0, Number(input.liveConfirmedTenureDays || 0));

  if (promotionState === 'no_live_support' || liveSample === 0 || confirmationProgress < 10) {
    return 'unconfirmed';
  }

  if (promotionState === 'live_confirmed') {
    const durableEligible = (
      durabilityScore >= 70
      && liveSample >= requiredSample
      && trustConsumptionLabel === 'allow_regime_confidence'
      && !retroHeavy
      && !largeGap
      && consecutiveQualifiedWindows >= 2
      && liveConfirmedTenureDays >= 2
      && consecutiveWeakWindows === 0
      && (!mixedUnknown || strongMixedUnknown)
    );
    if (durableEligible) return 'durable_confirmed';
    if (consecutiveWeakWindows > 0 || decayCount > 0) return 'decaying_confirmation';
    if (suppressed || retroHeavy || largeGap || weakLive) return 'decaying_confirmation';
    return 'fragile_confirmation';
  }

  if (promotionState === 'stalled_live_support') {
    if (suppressed || largeGap || retroHeavy || confirmationProgress >= 45) return 'decaying_confirmation';
    return 'fragile_confirmation';
  }

  const recoveringCandidate = (
    (promotionState === 'near_live_confirmation' || promotionState === 'emerging_live_support')
    && confirmationProgress >= 45
    && durabilityProgressPct >= 50
    && liveSample >= Math.max(8, Math.ceil(requiredSample * 0.5))
    && trustConsumptionLabel !== 'suppress_regime_bias'
    && !retroHeavy
    && !weakLive
    && (recoveryCount > 0 || consecutiveQualifiedWindows >= 1)
  );
  if (recoveringCandidate) return 'recovering_confirmation';

  if (suppressed && (largeGap || weakLive || consecutiveWeakWindows >= 2 || decayCount > recoveryCount)) return 'decaying_confirmation';
  return 'building_durability';
}

function buildDurabilityReason(input = {}) {
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');
  const state = toText(input.durabilityState).toLowerCase();
  const liveSample = Math.max(0, Number(input.latestLiveSampleSize || 0));
  const requiredSample = Math.max(1, Number(input.requiredSampleForPromotion || 15));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const scoreGap = toNumber(input.scoreGap, null);
  const evidenceQuality = parseEvidenceQuality(input.evidenceQuality);

  if (state === 'durable_confirmed') {
    return `${regimeLabel} is live-confirmed and showing durable persistence with ${liveSample}/${requiredSample}+ live support.`;
  }
  if (state === 'recovering_confirmation') {
    return `${regimeLabel} is rebuilding confirmation quality (${liveSample}/${requiredSample}) with improving trust conditions.`;
  }
  if (state === 'building_durability') {
    return `${regimeLabel} is accumulating live confirmation but has not reached durable persistence yet (${liveSample}/${requiredSample}).`;
  }
  if (state === 'fragile_confirmation') {
    return `${regimeLabel} remains fragile: confirmation exists but trust quality is still cautious (${liveSample}/${requiredSample}).`;
  }
  if (state === 'decaying_confirmation') {
    const gapTxt = Number.isFinite(scoreGap) ? `gap ${round2(Math.abs(scoreGap))}` : 'divergence risk';
    return `${regimeLabel} confirmation is decaying due to ${trustConsumptionLabel} conditions and ${gapTxt}.`;
  }
  if (evidenceQuality === 'thin') {
    return `${regimeLabel} has insufficient live evidence for durability assessment (${liveSample}/${requiredSample}).`;
  }
  return `${regimeLabel} is unconfirmed with limited live persistence evidence (${liveSample}/${requiredSample}).`;
}

function deriveProxyCounts(input = {}) {
  const persistenceWindowCount = derivePersistenceWindowCount(input.latestLiveSampleSize);
  const durabilityState = toText(input.durabilityState).toLowerCase();
  const durabilityProgressPct = clamp(Number(input.durabilityProgressPct || 0), 0, 100);
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const scoreGap = toNumber(input.scoreGap, null);
  const evidenceQuality = parseEvidenceQuality(input.evidenceQuality);
  const liveUsefulnessLabel = normalizeUsefulnessLabel(input.liveUsefulnessLabel || 'insufficient');
  const promotionState = toText(input.latestPromotionState || '').toLowerCase();

  let consecutiveQualifiedWindows = 0;
  if (durabilityState === 'durable_confirmed') {
    if (durabilityProgressPct >= 90) consecutiveQualifiedWindows = 5;
    else if (durabilityProgressPct >= 80) consecutiveQualifiedWindows = 4;
    else if (durabilityProgressPct >= 70) consecutiveQualifiedWindows = 3;
    else consecutiveQualifiedWindows = 2;
  } else if (durabilityState === 'recovering_confirmation') {
    consecutiveQualifiedWindows = durabilityProgressPct >= 65 ? 2 : 1;
  } else if (promotionState === 'near_live_confirmation' && durabilityProgressPct >= 55) {
    consecutiveQualifiedWindows = 1;
  }
  consecutiveQualifiedWindows = Math.min(persistenceWindowCount, consecutiveQualifiedWindows);

  let weakSignals = 0;
  if (trustConsumptionLabel === 'reduce_regime_weight' || trustConsumptionLabel === 'suppress_regime_bias') weakSignals += 1;
  if (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12) weakSignals += 1;
  if (evidenceQuality === 'retrospective_heavy' || evidenceQuality === 'thin') weakSignals += 1;
  if (liveUsefulnessLabel === 'weak' || liveUsefulnessLabel === 'noisy' || liveUsefulnessLabel === 'insufficient') weakSignals += 1;
  if (promotionState === 'stalled_live_support' || promotionState === 'no_live_support') weakSignals += 1;
  let consecutiveWeakWindows = Math.min(6, weakSignals + (trustConsumptionLabel === 'suppress_regime_bias' ? 1 : 0));
  if (durabilityState === 'unconfirmed' && consecutiveWeakWindows === 0) consecutiveWeakWindows = 1;
  consecutiveWeakWindows = Math.max(0, Math.min(6, consecutiveWeakWindows));

  return {
    persistenceWindowCount,
    consecutiveQualifiedWindows,
    consecutiveWeakWindows,
  };
}

function buildRowWarnings(input = {}) {
  const warnings = [];
  const liveSample = Math.max(0, Number(input.latestLiveSampleSize || 0));
  const trustConsumptionLabel = normalizeTrustConsumptionLabel(input.trustConsumptionLabel);
  const scoreGap = toNumber(input.scoreGap, null);
  const evidenceQuality = parseEvidenceQuality(input.evidenceQuality);
  const regimeLabel = normalizeRegimeLabel(input.regimeLabel || 'unknown');

  if (liveSample <= 0) warnings.push('no_live_support');
  else if (liveSample < 5) warnings.push('thin_live_sample');
  else if (liveSample < 10) warnings.push('limited_live_sample');
  if (trustConsumptionLabel === 'reduce_regime_weight' || trustConsumptionLabel === 'suppress_regime_bias') {
    warnings.push('trust_suppressed');
  }
  if (Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12) warnings.push('all_vs_live_divergence_high');
  if (evidenceQuality === 'retrospective_heavy') warnings.push('retrospective_heavy_evidence');
  if (regimeLabel === 'mixed' || regimeLabel === 'unknown') warnings.push('mixed_unknown_requires_stronger_live_evidence');
  return Array.from(new Set(warnings));
}

function computeInsight(summary = {}) {
  const currentRegimeLabel = normalizeRegimeLabel(summary?.currentRegimeLabel || 'unknown');
  const state = toText(summary?.currentRegimeDurabilityState).toLowerCase();
  const liveSample = Math.max(0, Number(summary?.currentRegimeLiveSampleSize || 0));
  const durableCount = Array.isArray(summary?.durableConfirmedRegimeLabels) ? summary.durableConfirmedRegimeLabels.length : 0;

  if (state === 'durable_confirmed') {
    return `${currentRegimeLabel} is live-confirmed and now durably confirmed.`;
  }
  if (state === 'recovering_confirmation') {
    return `${currentRegimeLabel} is recovering toward durable confirmation, but persistence is not established yet.`;
  }
  if (state === 'fragile_confirmation') {
    return `${currentRegimeLabel} confirmation remains fragile and should be treated cautiously.`;
  }
  if (state === 'decaying_confirmation') {
    return `${currentRegimeLabel} confirmation is decaying and should not be treated as durable trust yet.`;
  }
  if (state === 'building_durability') {
    return `${currentRegimeLabel} is only building durability (${liveSample} live samples) and remains below durable confirmation.`;
  }
  if (durableCount === 0) {
    return 'No regime currently qualifies as durably confirmed.';
  }
  return `${currentRegimeLabel} is still unconfirmed for durability and requires more live evidence.`;
}

function buildRegimeConfirmationDurabilitySummary(input = {}) {
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const liveRegimeConfirmation = input.liveRegimeConfirmation && typeof input.liveRegimeConfirmation === 'object'
    ? input.liveRegimeConfirmation
    : {};
  const regimeTrustConsumption = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};
  const regimeEvidenceSplit = input.regimeEvidenceSplit && typeof input.regimeEvidenceSplit === 'object'
    ? input.regimeEvidenceSplit
    : {};
  const regimePerformanceFeedback = input.regimePerformanceFeedback && typeof input.regimePerformanceFeedback === 'object'
    ? input.regimePerformanceFeedback
    : {};
  const recommendationPerformanceSummary = input.recommendationPerformance?.summary && typeof input.recommendationPerformance.summary === 'object'
    ? input.recommendationPerformance.summary
    : (input.recommendationPerformanceSummary && typeof input.recommendationPerformanceSummary === 'object'
      ? input.recommendationPerformanceSummary
      : {});
  const regimeConfirmationHistory = input.regimeConfirmationHistory && typeof input.regimeConfirmationHistory === 'object'
    ? input.regimeConfirmationHistory
    : {};
  const historyRows = Array.isArray(regimeConfirmationHistory?.byRegime)
    ? regimeConfirmationHistory.byRegime
    : [];

  const currentRegimeLabel = normalizeRegimeLabel(
    liveRegimeConfirmation?.currentRegimeLabel
      || regimeTrustConsumption?.currentRegimeLabel
      || regimeEvidenceSplit?.currentRegimeLabel
      || 'unknown'
  );

  const liveRows = Array.isArray(liveRegimeConfirmation?.liveConfirmationByRegime)
    ? liveRegimeConfirmation.liveConfirmationByRegime
    : [];
  const allRows = Array.isArray(regimeEvidenceSplit?.allEvidenceByRegime)
    ? regimeEvidenceSplit.allEvidenceByRegime
    : [];
  const splitLiveRows = Array.isArray(regimeEvidenceSplit?.liveOnlyByRegime)
    ? regimeEvidenceSplit.liveOnlyByRegime
    : [];

  const durabilityByRegime = [];
  const durableConfirmedRegimeLabels = [];
  const fragileRegimeLabels = [];
  const decayingRegimeLabels = [];
  const recoveringRegimeLabels = [];
  const historyAvailableByRegime = new Map();
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const historyRow = findByRegime(historyRows, regimeLabel);
    historyAvailableByRegime.set(regimeLabel, historyRow && historyRow.hasRealPersistenceHistory === true ? historyRow : null);
  }

  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const liveRow = findByRegime(liveRows, regimeLabel) || {};
    const allRow = findByRegime(allRows, regimeLabel) || {};
    const splitLiveRow = findByRegime(splitLiveRows, regimeLabel) || {};

    const latestPromotionState = toText(liveRow?.promotionState || 'no_live_support').toLowerCase() || 'no_live_support';
    const latestConfirmationProgressPct = clamp(Number(liveRow?.progressPct || 0), 0, 100);
    const latestLiveSampleSize = Math.max(0, Number(liveRow?.liveSampleSize || splitLiveRow?.liveDirectSampleSize || 0));
    const requiredSampleForPromotion = deriveRequiredSampleForPromotion(regimeLabel, liveRow);
    const liveUsefulnessLabel = normalizeUsefulnessLabel(splitLiveRow?.usefulnessLabel || liveRow?.liveUsefulnessLabel || 'insufficient');
    const liveUsefulnessScore = toNumber(splitLiveRow?.usefulnessScore != null ? splitLiveRow.usefulnessScore : liveRow?.liveUsefulnessScore, null);
    const liveConfidenceAdjustment = toNumber(splitLiveRow?.confidenceAdjustment != null ? splitLiveRow.confidenceAdjustment : liveRow?.liveConfidenceAdjustment, 0);
    const allUsefulnessScore = toNumber(allRow?.usefulnessScore, null);
    const scoreGap = (
      Number.isFinite(allUsefulnessScore) && Number.isFinite(liveUsefulnessScore)
        ? round2(allUsefulnessScore - liveUsefulnessScore)
        : null
    );

    const trustBiasLabel = regimeLabel === currentRegimeLabel
      ? normalizeTrustBiasLabel(
        regimeTrustConsumption?.trustBiasLabel
          || regimeTrustConsumption?.currentRegimeTrustSnapshot?.trustBiasLabel
          || deriveTrustBiasLabelForRegime(regimeLabel, allRow, splitLiveRow)
      )
      : deriveTrustBiasLabelForRegime(regimeLabel, allRow, splitLiveRow);

    const trustConsumptionLabel = regimeLabel === currentRegimeLabel
      ? normalizeTrustConsumptionLabel(regimeTrustConsumption?.trustConsumptionLabel)
      : deriveTrustConsumptionFromBias({
        trustBiasLabel,
        liveSampleSize: latestLiveSampleSize,
        liveUsefulnessLabel,
        scoreGap,
        provenanceStrengthLabel: allRow?.provenanceStrengthLabel || 'absent',
      });

    const evidenceQuality = regimeLabel === currentRegimeLabel
      ? parseEvidenceQuality(
        regimeTrustConsumption?.currentRegimeTrustSnapshot?.evidenceQuality
          || regimePerformanceFeedback?.regimeConfidenceGuidance?.evidenceQuality
          || classifyEvidenceQualityFromBreakdown(allRow?.evidenceSourceBreakdown || {})
      )
      : parseEvidenceQuality(classifyEvidenceQualityFromBreakdown(allRow?.evidenceSourceBreakdown || {}));

    const baseInput = {
      regimeLabel,
      latestPromotionState,
      latestConfirmationProgressPct,
      latestLiveSampleSize,
      requiredSampleForPromotion,
      trustConsumptionLabel,
      trustBiasLabel,
      evidenceQuality,
      scoreGap,
      liveUsefulnessLabel,
      liveUsefulnessScore,
      liveConfidenceAdjustment,
    };

    let durabilityScore = computeDurabilityScore(baseInput);
    let durabilityProgressPct = computeDurabilityProgress({
      ...baseInput,
      durabilityScore,
    });
    const durabilityState = classifyDurabilityState({
      ...baseInput,
      durabilityScore,
      durabilityProgressPct,
    });
    const persisted = historyAvailableByRegime.get(regimeLabel);
    const rowPersistenceSource = deriveRowPersistenceSource(persisted);
    if (rowPersistenceSource === 'persisted_reconstructed_history') {
      durabilityScore = round2(clamp(durabilityScore - 10, 0, 100));
      durabilityProgressPct = round2(clamp(durabilityProgressPct - 8, 0, 100));
    } else if (rowPersistenceSource === 'mixed_persisted_history') {
      durabilityScore = round2(clamp(durabilityScore - 4, 0, 100));
      durabilityProgressPct = round2(clamp(durabilityProgressPct - 3, 0, 100));
    }
    const proxies = deriveProxyCounts({
      ...baseInput,
      durabilityState,
      durabilityProgressPct,
    });
    const consecutiveQualifiedWindows = persisted
      ? Math.max(0, Number(persisted.consecutiveQualifiedWindows || 0))
      : proxies.consecutiveQualifiedWindows;
    const consecutiveWeakWindows = persisted
      ? Math.max(0, Number(persisted.consecutiveWeakWindows || 0))
      : proxies.consecutiveWeakWindows;
    const recoveryCount = persisted
      ? Math.max(0, Number(persisted.recoveryCount || 0))
      : 0;
    const decayCount = persisted
      ? Math.max(0, Number(persisted.decayCount || 0))
      : 0;
    const liveConfirmedTenureDays = persisted
      ? Math.max(0, Number(persisted.liveConfirmedTenureDays || 0))
      : 0;
    const persistenceWindowCount = persisted
      ? Math.max(0, Number(persisted.totalSnapshots || 0))
      : proxies.persistenceWindowCount;
    let stateWithHistory = classifyDurabilityState({
      ...baseInput,
      durabilityScore,
      durabilityProgressPct,
      consecutiveQualifiedWindows,
      consecutiveWeakWindows,
      recoveryCount,
      decayCount,
      liveConfirmedTenureDays,
    });
    if (
      rowPersistenceSource === 'persisted_reconstructed_history'
      && stateWithHistory === 'durable_confirmed'
      && (durabilityScore < 85 || trustConsumptionLabel !== 'allow_regime_confidence')
    ) {
      stateWithHistory = 'fragile_confirmation';
    }
    if (
      rowPersistenceSource === 'mixed_persisted_history'
      && stateWithHistory === 'durable_confirmed'
      && durabilityScore < 75
    ) {
      stateWithHistory = 'fragile_confirmation';
    }
    const row = {
      regimeLabel,
      latestPromotionState,
      latestConfirmationProgressPct: round2(latestConfirmationProgressPct),
      latestLiveSampleSize,
      durabilityScore,
      durabilityState: DURABILITY_STATES.has(stateWithHistory) ? stateWithHistory : 'unconfirmed',
      durabilityReason: '',
      durabilityProgressPct,
      persistenceWindowCount,
      consecutiveQualifiedWindows,
      consecutiveWeakWindows,
      recoveryCount,
      decayCount,
      liveConfirmedTenureDays,
      latestStateTransition: persisted?.latestStateTransition || null,
      currentStateTenureDays: persisted
        ? Math.max(0, Number(persisted.currentStateTenureDays || 0))
        : 0,
      persistenceSource: normalizePersistenceSource(rowPersistenceSource),
      provenanceBreakdown: persisted?.provenanceBreakdown && typeof persisted.provenanceBreakdown === 'object'
        ? {
          liveCapturedDays: Math.max(0, Number(persisted.provenanceBreakdown.liveCapturedDays || 0)),
          reconstructedDays: Math.max(0, Number(persisted.provenanceBreakdown.reconstructedDays || 0)),
          mixedDays: Math.max(0, Number(persisted.provenanceBreakdown.mixedDays || 0)),
        }
        : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 },
      hasLiveCapturedHistory: persisted?.hasLiveCapturedHistory === true
        || Math.max(0, Number(persisted?.liveCapturedSnapshotCount || 0)) > 0
        || Math.max(0, Number(persisted?.liveCapturedTenureDays || 0)) > 0,
      liveCapturedTenureDays: persisted
        ? Math.max(0, Number(persisted.liveCapturedTenureDays || 0))
        : 0,
      lastLiveCapturedDate: persisted?.lastLiveCapturedAt || null,
      hasRealPersistenceHistory: persisted?.hasRealPersistenceHistory === true,
      warnings: buildRowWarnings({
        regimeLabel,
        latestLiveSampleSize,
        trustConsumptionLabel,
        scoreGap,
        evidenceQuality,
      }),
      advisoryOnly: true,
    };
    row.durabilityReason = buildDurabilityReason({
      ...row,
      regimeLabel,
      requiredSampleForPromotion,
      trustConsumptionLabel,
      scoreGap,
      evidenceQuality,
    });
    if (row.hasRealPersistenceHistory) {
      if (!row.durabilityReason.toLowerCase().includes('persisted')) {
        if (row.persistenceSource === 'persisted_reconstructed_history') {
          row.durabilityReason = `${row.durabilityReason} Assessment uses persisted reconstructed streak history.`.trim();
        } else if (row.persistenceSource === 'mixed_persisted_history') {
          row.durabilityReason = `${row.durabilityReason} Assessment uses mixed persisted live + reconstructed streak history.`.trim();
        } else {
          row.durabilityReason = `${row.durabilityReason} Assessment uses persisted live-captured streak history.`.trim();
        }
      }
    } else if (!row.durabilityReason.toLowerCase().includes('proxy')) {
      row.durabilityReason = `${row.durabilityReason} Assessment is proxy-only due to limited history snapshots.`.trim();
    }
    if (row.persistenceSource === 'persisted_reconstructed_history') row.warnings.push('reconstructed_history_only');
    if (row.persistenceSource === 'mixed_persisted_history') row.warnings.push('mixed_history_provenance');
    if (!row.hasRealPersistenceHistory) row.warnings.push('proxy_history_only');
    row.warnings = Array.from(new Set(row.warnings));

    durabilityByRegime.push(row);
    if (row.durabilityState === 'durable_confirmed') durableConfirmedRegimeLabels.push(regimeLabel);
    if (row.durabilityState === 'fragile_confirmation') fragileRegimeLabels.push(regimeLabel);
    if (row.durabilityState === 'decaying_confirmation') decayingRegimeLabels.push(regimeLabel);
    if (row.durabilityState === 'recovering_confirmation') recoveringRegimeLabels.push(regimeLabel);
  }

  const currentRow = findByRegime(durabilityByRegime, currentRegimeLabel) || {
    regimeLabel: currentRegimeLabel,
    latestPromotionState: 'no_live_support',
    latestConfirmationProgressPct: 0,
    latestLiveSampleSize: 0,
    durabilityScore: 0,
    durabilityState: 'unconfirmed',
    durabilityReason: `No durable regime confirmation evidence is available for ${currentRegimeLabel}.`,
    durabilityProgressPct: 0,
    persistenceWindowCount: 0,
    consecutiveQualifiedWindows: 0,
    consecutiveWeakWindows: 1,
    recoveryCount: 0,
    decayCount: 0,
    liveConfirmedTenureDays: 0,
    latestStateTransition: null,
    currentStateTenureDays: 0,
    persistenceSource: 'proxy_only',
    provenanceBreakdown: {
      liveCapturedDays: 0,
      reconstructedDays: 0,
      mixedDays: 0,
    },
    hasLiveCapturedHistory: false,
    liveCapturedTenureDays: 0,
    lastLiveCapturedDate: null,
    hasRealPersistenceHistory: false,
    warnings: ['no_live_support'],
    advisoryOnly: true,
  };
  const persistenceSource = normalizePersistenceSource(
    currentRow.persistenceSource || deriveRowPersistenceSource(
      currentRow.hasRealPersistenceHistory === true
        ? currentRow
        : null
    )
  );
  const historyCoverageDays = Math.max(0, Number(regimeConfirmationHistory?.historyCoverageDays || 0));
  const historyProvenanceBreakdown = currentRow?.provenanceBreakdown && typeof currentRow.provenanceBreakdown === 'object'
    ? {
      liveCapturedDays: Math.max(0, Number(currentRow.provenanceBreakdown.liveCapturedDays || 0)),
      reconstructedDays: Math.max(0, Number(currentRow.provenanceBreakdown.reconstructedDays || 0)),
      mixedDays: Math.max(0, Number(currentRow.provenanceBreakdown.mixedDays || 0)),
    }
    : (regimeConfirmationHistory?.historyProvenanceBreakdown && typeof regimeConfirmationHistory.historyProvenanceBreakdown === 'object'
      ? {
        liveCapturedDays: Math.max(0, Number(regimeConfirmationHistory.historyProvenanceBreakdown.liveCapturedDays || 0)),
        reconstructedDays: Math.max(0, Number(regimeConfirmationHistory.historyProvenanceBreakdown.reconstructedDays || 0)),
        mixedDays: Math.max(0, Number(regimeConfirmationHistory.historyProvenanceBreakdown.mixedDays || 0)),
      }
      : { liveCapturedDays: 0, reconstructedDays: 0, mixedDays: 0 });
  const historyWarnings = [];
  if (persistenceSource === 'proxy_only') historyWarnings.push('insufficient_persisted_history');
  if (persistenceSource === 'persisted_reconstructed_history') historyWarnings.push('reconstructed_history_only');
  if (persistenceSource === 'mixed_persisted_history') historyWarnings.push('mixed_persistence_history');
  if (persistenceSource !== 'proxy_only' && Number(historyProvenanceBreakdown.liveCapturedDays || 0) <= 0) {
    historyWarnings.push('no_live_captured_persistence');
  }
  if (historyCoverageDays > 0 && historyCoverageDays < 5) historyWarnings.push('history_coverage_thin');

  const sourceBreakdown = recommendationPerformanceSummary?.sourceBreakdown && typeof recommendationPerformanceSummary.sourceBreakdown === 'object'
    ? recommendationPerformanceSummary.sourceBreakdown
    : { live: 0, backfill: 0, total: 0 };

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    currentRegimeLabel,
    currentRegimeDurabilityState: currentRow.durabilityState,
    currentRegimeDurabilityReason: currentRow.durabilityReason,
    currentRegimeDurabilityScore: round2(Number(currentRow.durabilityScore || 0)),
    currentRegimeDurabilityProgressPct: round2(Number(currentRow.durabilityProgressPct || 0)),
    currentRegimeHasLiveCapturedHistory: currentRow.hasLiveCapturedHistory === true,
    currentRegimeLiveCapturedTenureDays: Math.max(0, Number(currentRow.liveCapturedTenureDays || 0)),
    currentRegimeLastLiveCapturedDate: String(currentRow.lastLiveCapturedDate || '').trim() || null,
    persistenceSource,
    historyCoverageDays,
    historyProvenanceBreakdown,
    historyWarnings: Array.from(new Set(historyWarnings)),
    durabilityByRegime,
    durableConfirmedRegimeLabels,
    fragileRegimeLabels,
    decayingRegimeLabels,
    recoveringRegimeLabels,
    regimeDurabilityInsight: computeInsight({
      currentRegimeLabel,
      currentRegimeDurabilityState: currentRow.durabilityState,
      currentRegimeLiveSampleSize: currentRow.latestLiveSampleSize,
      durableConfirmedRegimeLabels,
    }),
    dataQuality: {
      isThinSample: durabilityByRegime.every((row) => Number(row.latestLiveSampleSize || 0) < 10),
      warnings: Array.from(new Set([
        durableConfirmedRegimeLabels.length === 0 ? 'no_durable_confirmed_regimes' : null,
        Number(sourceBreakdown.live || 0) < 10 ? 'limited_live_recommendation_provenance' : null,
      ].filter(Boolean))),
      sourceBreakdown: {
        live: Math.max(0, Number(sourceBreakdown.live || 0)),
        backfill: Math.max(0, Number(sourceBreakdown.backfill || 0)),
        total: Math.max(0, Number(sourceBreakdown.total || (Number(sourceBreakdown.live || 0) + Number(sourceBreakdown.backfill || 0)))),
      },
    },
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimeConfirmationDurabilitySummary,
};
