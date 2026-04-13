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
const SOURCE_BACKFILL = 'backfill';

const TRUST_BIAS_LABELS = new Set([
  'live_confirmed',
  'mixed_support',
  'retrospective_led',
  'insufficient_live_confirmation',
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
  const src = toText(value).toLowerCase();
  if (src === SOURCE_BACKFILL) return SOURCE_BACKFILL;
  return SOURCE_LIVE;
}

function buildBreakdown(live = 0, backfill = 0) {
  const out = {
    live: Math.max(0, Number(live || 0)),
    backfill: Math.max(0, Number(backfill || 0)),
    total: 0,
  };
  out.total = out.live + out.backfill;
  return out;
}

function scoreLabelToPct(value) {
  const key = toText(value).toLowerCase();
  if (key === 'correct') return 100;
  if (key === 'partially_correct') return 50;
  if (key === 'incorrect') return 0;
  return null;
}

function average(values = []) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function computeWeightedUsefulness(parts = {}) {
  const weights = {
    recommendation: 0.50,
    strategy: 0.25,
    tp: 0.20,
    delta: 0.05,
  };
  let weighted = 0;
  let totalWeight = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = toNumber(parts?.[k], null);
    if (!Number.isFinite(v)) continue;
    weighted += (v * w);
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;
  return round2(weighted / totalWeight);
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

function deriveCoverageType(upstreamCoverageSampleSize = 0, directProvenanceSampleSize = 0) {
  const upstream = Math.max(0, Number(upstreamCoverageSampleSize || 0));
  const direct = Math.max(0, Number(directProvenanceSampleSize || 0));
  if (direct > 0 && upstream <= 0) return 'direct_provenance';
  if (upstream > 0 && direct <= 0) return 'upstream_only';
  if (upstream > 0 && direct > 0) return 'mixed_support';
  return 'no_support';
}

function deriveAllEvidenceProvenanceStrength(row = {}) {
  const coverageType = toText(row?.coverageType).toLowerCase();
  const direct = Math.max(0, Number(row?.directProvenanceSampleSize || 0));
  const upstream = Math.max(0, Number(row?.upstreamCoverageSampleSize || 0));
  const breakdown = row?.evidenceSourceBreakdown || buildBreakdown(0, 0);
  const live = Math.max(0, Number(breakdown.live || 0));
  const backfill = Math.max(0, Number(breakdown.backfill || 0));
  if (coverageType === 'no_support' || (direct <= 0 && upstream <= 0)) return 'absent';
  if (coverageType === 'upstream_only' || (direct <= 0 && upstream > 0)) return 'inferred_only';
  if (backfill >= (live * 2) && backfill >= 10) return 'retrospective_heavy';
  if (live > 0 && backfill > 0) return 'mixed';
  return 'direct';
}

function classifyAllEvidenceLabel(score = null, sampleSize = 0) {
  const n = Number(sampleSize || 0);
  if (!Number.isFinite(n) || n < 5) return 'insufficient';
  if (n < 10) return 'noisy';
  const s = toNumber(score, null);
  if (!Number.isFinite(s)) return 'weak';
  if (s >= 68) return 'strong';
  if (s >= 55) return 'moderate';
  return 'weak';
}

function computeAllEvidenceAdjustment(row = {}) {
  const label = toText(row?.usefulnessLabel).toLowerCase();
  const sampleSize = Math.max(0, Number(row?.sampleSize || 0));
  const directSampleSize = Math.max(0, Number(row?.directProvenanceSampleSize || 0));
  const coverageType = toText(row?.coverageType).toLowerCase();
  const score = toNumber(row?.usefulnessScore, null);
  const regimeLabel = normalizeRegimeLabel(row?.regimeLabel || 'unknown');

  let adjustment = 0;
  if (label === 'strong') adjustment = 6;
  else if (label === 'moderate') adjustment = 2;
  else if (label === 'weak') adjustment = -4;
  else if (label === 'noisy') adjustment = -2;

  if (Number.isFinite(score)) adjustment += round2((score - 55) / 12);
  if (sampleSize < 5) adjustment = 0;
  else if (sampleSize < 10) adjustment = clamp(adjustment, -2, 2);
  else if (sampleSize < 15) adjustment = clamp(adjustment, -4, 4);

  if ((regimeLabel === 'mixed' || regimeLabel === 'unknown') && !(sampleSize >= 30 && Number(score || 0) >= 70)) {
    adjustment = Math.min(adjustment, 0);
  }
  if (coverageType === 'upstream_only' || coverageType === 'no_support' || directSampleSize <= 0) {
    adjustment = Math.min(adjustment, 0);
  }
  if (coverageType === 'no_support') adjustment = 0;
  if (directSampleSize > 0 && directSampleSize < 5) adjustment = clamp(adjustment, -2, 0);
  return round2(clamp(adjustment, -15, 10));
}

function buildAllEvidenceRows(regimePerformanceFeedback = {}) {
  const rows = Array.isArray(regimePerformanceFeedback?.regimeUsefulness)
    ? regimePerformanceFeedback.regimeUsefulness
    : [];
  const byLabel = new Map();
  for (const row of rows) {
    const regimeLabel = normalizeRegimeLabel(row?.regimeLabel || '');
    if (!SUPPORTED_REGIME_LABELS.includes(regimeLabel)) continue;
    const breakdown = row?.evidenceSourceBreakdown && typeof row.evidenceSourceBreakdown === 'object'
      ? buildBreakdown(row.evidenceSourceBreakdown.live, row.evidenceSourceBreakdown.backfill)
      : buildBreakdown(0, 0);
    const upstreamCoverageSampleSize = Math.max(0, Number(
      row?.upstreamCoverageSampleSize != null ? row.upstreamCoverageSampleSize : row?.sampleSize || 0
    ));
    const directProvenanceSampleSize = Math.max(0, Number(
      row?.directProvenanceSampleSize != null ? row.directProvenanceSampleSize : breakdown.total
    ));
    const coverageType = toText(row?.coverageType || deriveCoverageType(upstreamCoverageSampleSize, directProvenanceSampleSize)).toLowerCase();

    let usefulnessScore = Number.isFinite(Number(row?.usefulnessScore)) ? round2(Number(row.usefulnessScore)) : null;
    let usefulnessLabel = toText(row?.usefulnessLabel || classifyAllEvidenceLabel(usefulnessScore, Math.max(upstreamCoverageSampleSize, directProvenanceSampleSize))).toLowerCase();
    const warnings = Array.from(new Set((Array.isArray(row?.warnings) ? row.warnings : []).filter(Boolean)));

    if (coverageType === 'no_support') {
      usefulnessScore = null;
      usefulnessLabel = 'insufficient';
      warnings.push('no_regime_support');
    } else if (directProvenanceSampleSize <= 0) {
      warnings.push('no_direct_regime_provenance');
      warnings.push('inferred_from_upstream_buckets');
      if (usefulnessLabel === 'strong') usefulnessLabel = 'moderate';
    }
    if (directProvenanceSampleSize > 0 && directProvenanceSampleSize < 5 && usefulnessLabel !== 'insufficient') {
      warnings.push('thin_direct_regime_provenance');
      usefulnessLabel = 'noisy';
    }

    const normalized = {
      regimeLabel,
      usefulnessScore,
      usefulnessLabel,
      confidenceAdjustment: 0,
      directProvenanceSampleSize,
      upstreamCoverageSampleSize,
      coverageType,
      provenanceStrengthLabel: 'absent',
      evidenceSourceBreakdown: breakdown,
      warnings: Array.from(new Set(warnings)),
      advisoryOnly: true,
    };
    normalized.confidenceAdjustment = computeAllEvidenceAdjustment(normalized);
    normalized.provenanceStrengthLabel = deriveAllEvidenceProvenanceStrength(normalized);
    byLabel.set(regimeLabel, normalized);
  }

  const out = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    if (byLabel.has(regimeLabel)) {
      out.push(byLabel.get(regimeLabel));
      continue;
    }
    out.push({
      regimeLabel,
      usefulnessScore: null,
      usefulnessLabel: 'insufficient',
      confidenceAdjustment: 0,
      directProvenanceSampleSize: 0,
      upstreamCoverageSampleSize: 0,
      coverageType: 'no_support',
      provenanceStrengthLabel: 'absent',
      evidenceSourceBreakdown: buildBreakdown(0, 0),
      warnings: ['no_regime_support'],
      advisoryOnly: true,
    });
  }
  return out;
}

function buildLiveStatsByRegime(scorecards = [], regimeByDate = {}) {
  const out = new Map();
  const dateCache = new Map();
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    out.set(regimeLabel, {
      regimeLabel,
      liveCount: 0,
      postureSum: 0,
      postureCount: 0,
      strategySum: 0,
      strategyCount: 0,
      tpSum: 0,
      tpCount: 0,
      deltaSum: 0,
      deltaCount: 0,
    });
  }

  for (const card of (Array.isArray(scorecards) ? scorecards : [])) {
    const src = normalizeSourceType(card?.sourceType);
    if (src !== SOURCE_LIVE) continue;
    const date = normalizeDate(card?.date || card?.recommendationDate || '');
    if (!date) continue;
    const regimeLabel = normalizeRegimeLabel(
      card?.regimeLabel
      || deriveRegimeLabelForDate(date, regimeByDate, dateCache)
      || 'unknown'
    );
    const safeLabel = SUPPORTED_REGIME_LABELS.includes(regimeLabel) ? regimeLabel : 'unknown';
    if (!out.has(safeLabel)) continue;
    const acc = out.get(safeLabel);
    acc.liveCount += 1;

    const posture = scoreLabelToPct(card?.postureEvaluation);
    if (posture !== null) {
      acc.postureSum += posture;
      acc.postureCount += 1;
    }
    const strategy = scoreLabelToPct(card?.strategyRecommendationScore?.scoreLabel);
    if (strategy !== null) {
      acc.strategySum += strategy;
      acc.strategyCount += 1;
    }
    const tp = scoreLabelToPct(card?.tpRecommendationScore?.scoreLabel);
    if (tp !== null) {
      acc.tpSum += tp;
      acc.tpCount += 1;
    }
    const delta = Number(card?.recommendationDelta);
    if (Number.isFinite(delta)) {
      acc.deltaSum += delta;
      acc.deltaCount += 1;
    }
  }

  return out;
}

function classifyLiveUsefulnessLabel(score = null, liveSample = 0) {
  const sample = Math.max(0, Number(liveSample || 0));
  if (sample < 5) return 'insufficient';
  if (sample < 10) return 'noisy';
  const s = toNumber(score, null);
  if (!Number.isFinite(s)) return 'weak';
  if (s >= 68) return 'strong';
  if (s >= 55) return 'moderate';
  return 'weak';
}

function computeLiveConfidenceAdjustment(row = {}) {
  const sample = Math.max(0, Number(row?.liveDirectSampleSize || 0));
  const label = toText(row?.usefulnessLabel).toLowerCase();
  const score = toNumber(row?.usefulnessScore, null);

  let adjustment = 0;
  if (label === 'strong') adjustment = 4;
  else if (label === 'moderate') adjustment = 1;
  else if (label === 'weak') adjustment = -3;
  else if (label === 'noisy') adjustment = -1;
  if (Number.isFinite(score)) adjustment += round2((score - 55) / 15);

  if (sample < 5) adjustment = 0;
  else if (sample < 10) adjustment = clamp(adjustment, -2, 2);
  if (label === 'insufficient') adjustment = 0;
  return round2(clamp(adjustment, -15, 10));
}

function buildLiveOnlyRows(scorecards = [], regimeByDate = {}) {
  const statsByRegime = buildLiveStatsByRegime(scorecards, regimeByDate);
  const rows = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const stats = statsByRegime.get(regimeLabel) || { liveCount: 0 };
    const liveDirectSampleSize = Math.max(0, Number(stats.liveCount || 0));
    const breakdown = buildBreakdown(liveDirectSampleSize, 0);
    const recommendationScore = average([
      stats.postureCount > 0 ? round2(stats.postureSum / stats.postureCount) : null,
      stats.strategyCount > 0 ? round2(stats.strategySum / stats.strategyCount) : null,
      stats.tpCount > 0 ? round2(stats.tpSum / stats.tpCount) : null,
    ]);
    const strategyScore = stats.strategyCount > 0 ? round2(stats.strategySum / stats.strategyCount) : null;
    const tpScore = stats.tpCount > 0 ? round2(stats.tpSum / stats.tpCount) : null;
    const avgDelta = stats.deltaCount > 0 ? round2(stats.deltaSum / stats.deltaCount) : null;
    const deltaScore = Number.isFinite(Number(avgDelta))
      ? round2(clamp(50 + (Number(avgDelta) / 2), 0, 100))
      : null;

    let usefulnessScore = computeWeightedUsefulness({
      recommendation: recommendationScore,
      strategy: strategyScore,
      tp: tpScore,
      delta: deltaScore,
    });
    let usefulnessLabel = classifyLiveUsefulnessLabel(usefulnessScore, liveDirectSampleSize);
    const warnings = [];

    if (liveDirectSampleSize <= 0) {
      usefulnessScore = null;
      usefulnessLabel = 'insufficient';
      warnings.push('no_live_regime_provenance');
      warnings.push('no_live_confirmation');
    } else if (liveDirectSampleSize < 5) {
      usefulnessScore = null;
      usefulnessLabel = 'insufficient';
      warnings.push('thin_live_regime_sample');
    } else if (liveDirectSampleSize < 10) {
      warnings.push('limited_live_regime_sample');
      usefulnessLabel = 'noisy';
    }

    const coverageType = liveDirectSampleSize > 0 ? 'direct_provenance' : 'no_support';
    let provenanceStrengthLabel = 'absent';
    if (liveDirectSampleSize > 0 && liveDirectSampleSize < 10) provenanceStrengthLabel = 'thin_live';
    else if (liveDirectSampleSize >= 10) provenanceStrengthLabel = 'direct';

    const row = {
      regimeLabel,
      usefulnessScore: Number.isFinite(Number(usefulnessScore)) ? round2(Number(usefulnessScore)) : null,
      usefulnessLabel,
      confidenceAdjustment: 0,
      liveDirectSampleSize,
      coverageType,
      provenanceStrengthLabel,
      evidenceSourceBreakdown: breakdown,
      warnings: Array.from(new Set(warnings)),
      advisoryOnly: true,
    };
    row.confidenceAdjustment = computeLiveConfidenceAdjustment(row);
    if (row.usefulnessLabel === 'insufficient') row.confidenceAdjustment = 0;
    if (liveDirectSampleSize < 5) row.confidenceAdjustment = 0;
    if (liveDirectSampleSize < 10) row.confidenceAdjustment = clamp(row.confidenceAdjustment, -2, 2);
    rows.push(row);
  }
  return rows;
}

function parseLabelRank(label = '') {
  const txt = toText(label).toLowerCase();
  if (txt === 'strong') return 4;
  if (txt === 'moderate') return 3;
  if (txt === 'weak') return 2;
  if (txt === 'noisy') return 1;
  return 0;
}

function isLiveConfirmedEligible(regimeLabel = '', liveRow = {}, scoreGap = null) {
  const label = toText(liveRow?.usefulnessLabel).toLowerCase();
  const liveSample = Math.max(0, Number(liveRow?.liveDirectSampleSize || 0));
  const liveScore = toNumber(liveRow?.usefulnessScore, null);
  const regime = normalizeRegimeLabel(regimeLabel || 'unknown');
  const gapOkay = !Number.isFinite(scoreGap) || Math.abs(Number(scoreGap || 0)) <= 8;
  const labelOkay = (label === 'strong' || label === 'moderate');
  if (!(labelOkay && liveSample >= 10 && gapOkay)) return false;
  if ((regime === 'mixed' || regime === 'unknown') && !(liveSample >= 20 && Number(liveScore || 0) >= 70)) return false;
  return true;
}

function classifyTrustBias(regimeLabel = '', allRow = {}, liveRow = {}) {
  const regime = normalizeRegimeLabel(regimeLabel || 'unknown');
  const allScore = toNumber(allRow?.usefulnessScore, null);
  const liveScore = toNumber(liveRow?.usefulnessScore, null);
  const allLabel = toText(allRow?.usefulnessLabel).toLowerCase();
  const liveLabel = toText(liveRow?.usefulnessLabel).toLowerCase();
  const allBreakdown = allRow?.evidenceSourceBreakdown || buildBreakdown(0, 0);
  const liveSample = Math.max(0, Number(liveRow?.liveDirectSampleSize || 0));
  const scoreGap = (Number.isFinite(allScore) && Number.isFinite(liveScore))
    ? round2(allScore - liveScore)
    : null;
  const backfillDominant = Number(allBreakdown.backfill || 0) >= (Number(allBreakdown.live || 0) * 2)
    && Number(allBreakdown.backfill || 0) >= 10;

  if (liveSample < 5 || liveLabel === 'insufficient' || liveRow?.coverageType === 'no_support') {
    return {
      trustBiasLabel: 'insufficient_live_confirmation',
      trustBiasReason: `Live confirmation is insufficient for ${regime} (live sample ${liveSample}).`,
      scoreGap,
    };
  }

  if (isLiveConfirmedEligible(regime, liveRow, scoreGap)) {
    return {
      trustBiasLabel: 'live_confirmed',
      trustBiasReason: `${regime} has direct live confirmation with limited divergence from all-evidence scoring.`,
      scoreGap,
    };
  }

  const materiallyStrongerAllEvidence = Number.isFinite(scoreGap) && scoreGap >= 12;
  const allLooksGood = allLabel === 'strong' || allLabel === 'moderate';
  const liveLooksWeak = ['weak', 'noisy', 'insufficient'].includes(liveLabel);
  if (
    (allLooksGood && liveLooksWeak)
    || (materiallyStrongerAllEvidence && backfillDominant)
    || (allLooksGood && liveSample < 10)
  ) {
    return {
      trustBiasLabel: 'retrospective_led',
      trustBiasReason: `${regime} appears stronger in all-evidence scoring than live-only confirmation, with retrospective support dominating.`,
      scoreGap,
    };
  }

  return {
    trustBiasLabel: 'mixed_support',
    trustBiasReason: `${regime} has mixed live and retrospective support; keep trust balanced while live sample builds.`,
    scoreGap,
  };
}

function buildCurrentComparison(currentRegimeLabel = 'unknown', allByRegime = new Map(), liveByRegime = new Map()) {
  const regimeLabel = normalizeRegimeLabel(currentRegimeLabel || 'unknown');
  const allRow = allByRegime.get(regimeLabel) || null;
  const liveRow = liveByRegime.get(regimeLabel) || null;
  const allScore = toNumber(allRow?.usefulnessScore, null);
  const liveScore = toNumber(liveRow?.usefulnessScore, null);
  const trust = classifyTrustBias(regimeLabel, allRow || {}, liveRow || {});

  return {
    regimeLabel,
    allEvidenceUsefulnessScore: Number.isFinite(allScore) ? round2(allScore) : null,
    allEvidenceUsefulnessLabel: toText(allRow?.usefulnessLabel || 'insufficient').toLowerCase(),
    liveOnlyUsefulnessScore: Number.isFinite(liveScore) ? round2(liveScore) : null,
    liveOnlyUsefulnessLabel: toText(liveRow?.usefulnessLabel || 'insufficient').toLowerCase(),
    scoreGap: Number.isFinite(Number(trust.scoreGap)) ? round2(Number(trust.scoreGap)) : null,
    liveDirectSampleSize: Math.max(0, Number(liveRow?.liveDirectSampleSize || 0)),
    allEvidenceDirectSampleSize: Math.max(0, Number(allRow?.directProvenanceSampleSize || 0)),
    trustBiasLabel: trust.trustBiasLabel,
    trustBiasReason: trust.trustBiasReason,
    advisoryOnly: true,
  };
}

function buildInsight(currentRegimeComparison = null) {
  if (!currentRegimeComparison || typeof currentRegimeComparison !== 'object') {
    return 'Regime evidence split is active, but current live confirmation is unavailable.';
  }
  const regime = currentRegimeComparison.regimeLabel || 'current regime';
  const label = toText(currentRegimeComparison.trustBiasLabel).toLowerCase();
  if (label === 'live_confirmed') {
    return `${regime} guidance is live-confirmed in the current window.`;
  }
  if (label === 'retrospective_led') {
    return `${regime} guidance is currently retrospective-led; keep live confirmation requirements strict.`;
  }
  if (label === 'mixed_support') {
    return `${regime} guidance has mixed live and retrospective support; maintain balanced advisory trust.`;
  }
  return `${regime} guidance is not strongly live-confirmed yet; remain conservative.`;
}

function buildRegimeEvidenceSplitSummary(input = {}) {
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const performanceSource = toText(input.performanceSource || input.source || 'all').toLowerCase() || 'all';
  const regimeDetection = input.regimeDetection && typeof input.regimeDetection === 'object'
    ? input.regimeDetection
    : null;
  const currentRegimeLabel = normalizeRegimeLabel(regimeDetection?.regimeLabel || input.currentRegimeLabel || 'unknown');
  const regimePerformanceFeedback = input.regimePerformanceFeedback && typeof input.regimePerformanceFeedback === 'object'
    ? input.regimePerformanceFeedback
    : {};
  const recommendationPerformance = input.recommendationPerformance && typeof input.recommendationPerformance === 'object'
    ? input.recommendationPerformance
    : {};
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object'
    ? input.regimeByDate
    : {};

  const allEvidenceByRegime = buildAllEvidenceRows(regimePerformanceFeedback);
  const scorecards = Array.isArray(recommendationPerformance?.scorecards) ? recommendationPerformance.scorecards : [];
  const liveOnlyByRegime = buildLiveOnlyRows(scorecards, regimeByDate);

  const allByRegime = new Map(allEvidenceByRegime.map((row) => [row.regimeLabel, row]));
  const liveByRegime = new Map(liveOnlyByRegime.map((row) => [row.regimeLabel, row]));
  const currentRegimeComparison = buildCurrentComparison(currentRegimeLabel, allByRegime, liveByRegime);
  const trustBiasLabel = currentRegimeComparison.trustBiasLabel;
  const trustBiasReason = currentRegimeComparison.trustBiasReason;

  const liveConfirmedRegimeLabels = [];
  const retrospectiveLedRegimeLabels = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const trust = classifyTrustBias(regimeLabel, allByRegime.get(regimeLabel) || {}, liveByRegime.get(regimeLabel) || {});
    if (trust.trustBiasLabel === 'live_confirmed') liveConfirmedRegimeLabels.push(regimeLabel);
    if (trust.trustBiasLabel === 'retrospective_led') retrospectiveLedRegimeLabels.push(regimeLabel);
  }

  const warnings = [];
  if (liveConfirmedRegimeLabels.length === 0) warnings.push('no_live_confirmed_regime_labels');
  if (trustBiasLabel === 'retrospective_led') warnings.push('current_regime_retro_led');
  if (trustBiasLabel === 'insufficient_live_confirmation') warnings.push('current_regime_live_confirmation_insufficient');
  const sourceBreakdown = recommendationPerformance?.summary?.sourceBreakdown && typeof recommendationPerformance.summary.sourceBreakdown === 'object'
    ? buildBreakdown(
      recommendationPerformance.summary.sourceBreakdown.live,
      recommendationPerformance.summary.sourceBreakdown.backfill
    )
    : buildBreakdown(0, 0);

  const regimeEvidenceSplitInsight = buildInsight(currentRegimeComparison);

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    allEvidenceByRegime,
    liveOnlyByRegime,
    currentRegimeComparison,
    trustBiasLabel: TRUST_BIAS_LABELS.has(trustBiasLabel) ? trustBiasLabel : 'insufficient_live_confirmation',
    trustBiasReason: toText(trustBiasReason) || 'Live confirmation is currently insufficient for stronger regime trust.',
    liveConfirmedRegimeLabels,
    retrospectiveLedRegimeLabels,
    regimeEvidenceSplitInsight,
    dataQuality: {
      isThinSample: liveOnlyByRegime.every((row) => Number(row.liveDirectSampleSize || 0) < 10),
      warnings: Array.from(new Set(warnings)),
      sourceBreakdown,
      coverage: {
        regimes: SUPPORTED_REGIME_LABELS.length,
        liveDirectRegimes: liveOnlyByRegime.filter((row) => Number(row.liveDirectSampleSize || 0) > 0).length,
        liveConfirmedRegimes: liveConfirmedRegimeLabels.length,
        retrospectiveLedRegimes: retrospectiveLedRegimeLabels.length,
      },
    },
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimeEvidenceSplitSummary,
};
