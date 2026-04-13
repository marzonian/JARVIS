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
const COVERAGE_DIRECT_PROVENANCE = 'direct_provenance';
const COVERAGE_UPSTREAM_ONLY = 'upstream_only';
const COVERAGE_MIXED_SUPPORT = 'mixed_support';
const COVERAGE_NO_SUPPORT = 'no_support';

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

function classifyEvidenceQuality(breakdown = {}) {
  const live = Math.max(0, Number(breakdown.live || 0));
  const backfill = Math.max(0, Number(breakdown.backfill || 0));
  const total = Math.max(0, Number(breakdown.total || (live + backfill)));

  if (total < 10) return 'thin';
  if (backfill >= (live * 2) && backfill >= 10) return 'retrospective_heavy';
  if (live >= 20 && live >= (backfill * 1.5)) return 'strong_live';
  return 'mixed';
}

function deriveCoverageType(upstreamCoverageSampleSize = 0, directProvenanceSampleSize = 0) {
  const upstream = Math.max(0, Number(upstreamCoverageSampleSize || 0));
  const direct = Math.max(0, Number(directProvenanceSampleSize || 0));
  if (direct > 0 && upstream <= 0) return COVERAGE_DIRECT_PROVENANCE;
  if (upstream > 0 && direct <= 0) return COVERAGE_UPSTREAM_ONLY;
  if (upstream > 0 && direct > 0) return COVERAGE_MIXED_SUPPORT;
  return COVERAGE_NO_SUPPORT;
}

function deriveProvenanceStrengthLabel(row = {}) {
  const direct = Math.max(0, Number(row?.directProvenanceSampleSize || 0));
  const upstream = Math.max(0, Number(row?.upstreamCoverageSampleSize || 0));
  const coverageType = String(row?.coverageType || '');
  if (coverageType === COVERAGE_NO_SUPPORT || (direct <= 0 && upstream <= 0)) return 'absent';
  if (coverageType === COVERAGE_UPSTREAM_ONLY || (direct <= 0 && upstream > 0)) return 'inferred_only';
  const evidenceQuality = classifyEvidenceQuality(row?.evidenceSourceBreakdown || {});
  if (evidenceQuality === 'retrospective_heavy') return 'retrospective_heavy';
  if (evidenceQuality === 'mixed') return 'mixed';
  return 'direct';
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

function buildProvenanceByRegime(scorecards = [], regimeByDate = {}) {
  const out = new Map();
  const cache = new Map();

  for (const card of (Array.isArray(scorecards) ? scorecards : [])) {
    const date = normalizeDate(card?.date || card?.recommendationDate || '');
    if (!date) continue;
    const regimeLabel = normalizeRegimeLabel(
      card?.regimeLabel
      || deriveRegimeLabelForDate(date, regimeByDate, cache)
      || 'unknown'
    );
    const safeLabel = SUPPORTED_REGIME_LABELS.includes(regimeLabel) ? regimeLabel : 'unknown';
    if (!out.has(safeLabel)) out.set(safeLabel, buildBreakdown(0, 0));

    const row = out.get(safeLabel);
    const src = normalizeSourceType(card?.sourceType);
    if (src === SOURCE_BACKFILL) row.backfill += 1;
    else row.live += 1;
    row.total = row.live + row.backfill;
  }

  return out;
}

function toRegimeLookup(rows = []) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const label = normalizeRegimeLabel(row?.regimeLabel || row?.regime || '');
    if (!label) continue;
    map.set(label, row);
  }
  return map;
}

function average(values = []) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function scoreRecommendationRow(row = {}) {
  const base = average([
    toNumber(row?.postureAccuracyPct, toNumber(row?.postureAccuracy, null)),
    toNumber(row?.strategyAccuracyPct, toNumber(row?.strategyAccuracy, null)),
    toNumber(row?.tpAccuracyPct, toNumber(row?.tpAccuracy, null)),
  ]);
  return Number.isFinite(base) ? round2(clamp(base, 0, 100)) : null;
}

function scoreStrategyRow(row = {}) {
  const best = row?.bestStrategy && typeof row.bestStrategy === 'object'
    ? row.bestStrategy
    : null;
  if (!best) return null;

  const explicit = toNumber(best.score, null);
  if (Number.isFinite(explicit)) return round2(clamp(explicit, 0, 100));

  const tradeCount = toNumber(best.tradeCount, 0);
  const winRate = toNumber(best.winRate, 0);
  const pf = toNumber(best.profitFactor, 0);
  return round2(clamp((pf * 35) + (winRate * 0.45) + Math.min(25, tradeCount * 0.5), 0, 100));
}

function scoreTpRow(row = {}) {
  const candidates = Array.isArray(row?.tpModes) ? row.tpModes : [];
  if (candidates.length > 0) {
    const sorted = candidates.slice().sort((a, b) => toNumber(b?.score, 0) - toNumber(a?.score, 0));
    const top = sorted[0] || null;
    if (top) {
      const explicit = toNumber(top?.score, null);
      if (Number.isFinite(explicit)) return round2(clamp(explicit, 0, 100));
      const tradeCount = toNumber(top?.tradeCount, 0);
      const winRate = toNumber(top?.winRate, 0);
      const pf = toNumber(top?.profitFactor, 0);
      return round2(clamp((pf * 35) + (winRate * 0.45) + Math.min(25, tradeCount * 0.5), 0, 100));
    }
  }

  const bestWinRate = toNumber(row?.bestTpWinRate, null);
  const bestPf = toNumber(row?.bestTpProfitFactor, null);
  if (!Number.isFinite(bestWinRate) && !Number.isFinite(bestPf)) return null;
  return round2(clamp((Math.max(0, bestPf || 0) * 35) + (Math.max(0, bestWinRate || 0) * 0.45) + 10, 0, 100));
}

function scoreDeltaRow(row = {}) {
  const delta = toNumber(row?.avgRecommendationDelta, null);
  if (!Number.isFinite(delta)) return null;
  return round2(clamp(50 + (delta / 2), 0, 100));
}

function computeUsefulnessScore(parts = {}) {
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

function classifyUsefulnessLabel(score = null, sampleSize = 0) {
  if (!Number.isFinite(Number(sampleSize)) || Number(sampleSize) < 5) return 'insufficient';
  if (Number(sampleSize) < 10) return 'noisy';
  const s = toNumber(score, null);
  if (!Number.isFinite(s)) return 'weak';
  if (s >= 68) return 'strong';
  if (s >= 55) return 'moderate';
  return 'weak';
}

function initialAdjustmentFromLabel(label = '') {
  const txt = toText(label).toLowerCase();
  if (txt === 'strong') return 6;
  if (txt === 'moderate') return 2;
  if (txt === 'weak') return -4;
  if (txt === 'noisy') return -2;
  return 0;
}

function computeConfidenceAdjustment(row = {}) {
  const label = toText(row?.usefulnessLabel).toLowerCase();
  const sampleSize = toNumber(row?.sampleSize, 0);
  const directSampleSize = toNumber(row?.directProvenanceSampleSize, 0);
  const score = toNumber(row?.usefulnessScore, null);
  const regimeLabel = normalizeRegimeLabel(row?.regimeLabel || 'unknown');
  const coverageType = toText(row?.coverageType).toLowerCase();

  let adjustment = initialAdjustmentFromLabel(label);
  if (Number.isFinite(score)) {
    adjustment += round2((score - 55) / 12);
  }

  if (sampleSize < 5) adjustment = 0;
  else if (sampleSize < 10) adjustment = clamp(adjustment, -2, 2);
  else if (sampleSize < 15) adjustment = clamp(adjustment, -4, 4);

  if ((regimeLabel === 'mixed' || regimeLabel === 'unknown') && !(sampleSize >= 30 && Number(score || 0) >= 70)) {
    adjustment = Math.min(adjustment, 0);
  }
  if (directSampleSize <= 0 || coverageType === COVERAGE_UPSTREAM_ONLY) {
    adjustment = Math.min(adjustment, 0);
  }
  if (directSampleSize > 0 && directSampleSize < 5) {
    adjustment = clamp(adjustment, -2, 0);
  }
  if (coverageType === COVERAGE_NO_SUPPORT) {
    adjustment = 0;
  }

  return round2(clamp(adjustment, -15, 10));
}

function toSecondaryStrategyUsefulness(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const best = row?.strategyRow?.bestStrategy;
    return {
      regimeLabel: row.regimeLabel,
      sampleSize: row.sampleSize,
      bestStrategy: best
        ? {
          strategyKey: toText(best.strategyKey) || null,
          strategyName: toText(best.strategyName) || null,
          strategyType: toText(best.strategyType).toLowerCase() || null,
          winRate: Number.isFinite(Number(best.winRate)) ? round2(Number(best.winRate)) : null,
          profitFactor: Number.isFinite(Number(best.profitFactor)) ? round2(Number(best.profitFactor)) : null,
          score: Number.isFinite(Number(best.score)) ? round2(Number(best.score)) : null,
          advisoryOnly: true,
        }
        : null,
      usefulnessScore: row.usefulnessScore,
      usefulnessLabel: row.usefulnessLabel,
      upstreamCoverageSampleSize: row.upstreamCoverageSampleSize,
      directProvenanceSampleSize: row.directProvenanceSampleSize,
      coverageType: row.coverageType,
      provenanceStrengthLabel: row.provenanceStrengthLabel,
      evidenceSourceBreakdown: row.evidenceSourceBreakdown,
      warnings: row.warnings,
      advisoryOnly: true,
    };
  });
}

function toSecondaryTpUsefulness(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const tpRow = row?.tpRow || {};
    return {
      regimeLabel: row.regimeLabel,
      sampleSize: row.sampleSize,
      bestTpMode: toText(tpRow?.bestTpMode || '') || null,
      bestTpWinRate: Number.isFinite(Number(tpRow?.bestTpWinRate)) ? round2(Number(tpRow.bestTpWinRate)) : null,
      bestTpProfitFactor: Number.isFinite(Number(tpRow?.bestTpProfitFactor)) ? round2(Number(tpRow.bestTpProfitFactor)) : null,
      usefulnessScore: row.usefulnessScore,
      usefulnessLabel: row.usefulnessLabel,
      upstreamCoverageSampleSize: row.upstreamCoverageSampleSize,
      directProvenanceSampleSize: row.directProvenanceSampleSize,
      coverageType: row.coverageType,
      provenanceStrengthLabel: row.provenanceStrengthLabel,
      evidenceSourceBreakdown: row.evidenceSourceBreakdown,
      warnings: row.warnings,
      advisoryOnly: true,
    };
  });
}

function buildGuidance(row = null, currentRegimeLabel = 'unknown') {
  const regimeLabel = normalizeRegimeLabel(currentRegimeLabel || row?.regimeLabel || 'unknown');
  const breakdown = row?.evidenceSourceBreakdown || buildBreakdown(0, 0);
  const evidenceQuality = classifyEvidenceQuality(breakdown);
  const upstreamCoverageSampleSize = Math.max(0, Number(row?.upstreamCoverageSampleSize || 0));
  const directProvenanceSampleSize = Math.max(0, Number(row?.directProvenanceSampleSize || 0));
  const coverageType = row?.coverageType || deriveCoverageType(upstreamCoverageSampleSize, directProvenanceSampleSize);
  const provenanceStrengthLabel = row?.provenanceStrengthLabel || deriveProvenanceStrengthLabel({
    coverageType,
    upstreamCoverageSampleSize,
    directProvenanceSampleSize,
    evidenceSourceBreakdown: breakdown,
  });
  const usefulnessLabel = toText(row?.usefulnessLabel || 'insufficient').toLowerCase();
  const usefulnessScore = Number.isFinite(Number(row?.usefulnessScore)) ? round2(Number(row.usefulnessScore)) : null;
  const warnings = [];

  if (breakdown.total < 10) warnings.push('thin_regime_feedback_sample');
  if (evidenceQuality === 'retrospective_heavy') warnings.push('retrospective_heavy_regime_evidence');
  if (regimeLabel === 'mixed' || regimeLabel === 'unknown') warnings.push('noisy_regime_label');
  if (directProvenanceSampleSize <= 0) warnings.push('no_direct_regime_provenance');
  if (coverageType === COVERAGE_UPSTREAM_ONLY) warnings.push('inferred_from_upstream_buckets');
  if (coverageType === COVERAGE_NO_SUPPORT) warnings.push('no_regime_support');

  let guidanceLabel = 'maintain';
  if (
    coverageType !== COVERAGE_UPSTREAM_ONLY
    && coverageType !== COVERAGE_NO_SUPPORT
    && usefulnessLabel === 'strong'
    && Number(row?.confidenceAdjustment || 0) > 0
  ) guidanceLabel = 'increase_trust';
  else if (
    usefulnessLabel === 'weak'
    || usefulnessLabel === 'noisy'
    || usefulnessLabel === 'insufficient'
    || Number(row?.confidenceAdjustment || 0) < 0
    || coverageType === COVERAGE_UPSTREAM_ONLY
    || coverageType === COVERAGE_NO_SUPPORT
  ) guidanceLabel = 'reduce_trust';

  const reason = (() => {
    if (!row) return 'Regime usefulness evidence is unavailable; maintain conservative confidence.';
    if (coverageType === COVERAGE_NO_SUPPORT) {
      return `Regime ${regimeLabel} has no direct or upstream support in the current window; guidance remains conservative.`;
    }
    if (coverageType === COVERAGE_UPSTREAM_ONLY) {
      return `Current regime guidance for ${regimeLabel} is inferred from upstream regime buckets, not direct scored provenance; keep confidence conservative.`;
    }
    if (evidenceQuality === 'thin') {
      return `Regime usefulness sample is thin for ${regimeLabel}; keep confidence conservative.`;
    }
    if (evidenceQuality === 'retrospective_heavy') {
      return `Regime evidence for ${regimeLabel} is backfill-heavy, so confidence should remain conservative even when usefulness appears positive.`;
    }
    if (usefulnessLabel === 'strong') {
      return `Regime ${regimeLabel} is currently useful (score ${usefulnessScore}); confidence can be modestly increased.`;
    }
    if (usefulnessLabel === 'moderate') {
      return `Regime ${regimeLabel} usefulness is moderate; keep confidence balanced.`;
    }
    return `Regime ${regimeLabel} has weak/noisy usefulness signal; confidence should be reduced.`;
  })();

  return {
    regimeLabel,
    guidanceLabel,
    confidenceAdjustment: row ? round2(clamp(toNumber(row?.confidenceAdjustment, 0), -15, 10)) : 0,
    usefulnessScore,
    usefulnessLabel,
    upstreamCoverageSampleSize,
    directProvenanceSampleSize,
    coverageType,
    provenanceStrengthLabel,
    evidenceSourceBreakdown: breakdown,
    evidenceQuality,
    reason,
    warnings,
    advisoryOnly: true,
  };
}

function buildRegimeFeedbackInsight(rows = [], guidance = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return 'Regime performance feedback is active, but there is not enough labeled history to score regime usefulness yet.';
  }

  const strong = list
    .filter((r) => (
      r.usefulnessLabel === 'strong'
      && r.coverageType !== COVERAGE_UPSTREAM_ONLY
      && r.coverageType !== COVERAGE_NO_SUPPORT
    ))
    .sort((a, b) => Number(b.usefulnessScore || 0) - Number(a.usefulnessScore || 0));
  const weak = list
    .filter((r) => ['weak', 'noisy', 'insufficient'].includes(String(r.usefulnessLabel || '').toLowerCase()))
    .sort((a, b) => Number(a.usefulnessScore || 0) - Number(b.usefulnessScore || 0));

  const strongLabel = strong[0]?.regimeLabel || null;
  const weakLabel = weak[0]?.regimeLabel || null;

  if (strongLabel && weakLabel) {
    return `${strongLabel} has the strongest recent regime usefulness signal, while ${weakLabel} is currently weak/noisy and should carry less advisory weight.`;
  }
  if (strongLabel) {
    return `${strongLabel} currently shows the strongest regime usefulness signal in the feedback window.`;
  }
  if (weakLabel) {
    return `${weakLabel} regime labeling is currently noisy/weak; advisory confidence should stay conservative.`;
  }
  if (guidance?.regimeLabel) {
    return `Regime feedback for ${guidance.regimeLabel} is mixed; maintain conservative confidence until evidence improves.`;
  }
  return 'Regime usefulness signals are mixed across current buckets.';
}

function buildRegimePerformanceFeedbackSummary(input = {}) {
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const includeContext = input.includeContext !== false;
  const performanceSource = toText(input.performanceSource || input.source || 'all').toLowerCase() || 'all';

  const regimeDetection = input.regimeDetection && typeof input.regimeDetection === 'object'
    ? input.regimeDetection
    : null;
  const currentRegimeLabel = normalizeRegimeLabel(regimeDetection?.regimeLabel || input.currentRegimeLabel || 'unknown');

  const regimeAwareLearning = input.regimeAwareLearning && typeof input.regimeAwareLearning === 'object'
    ? input.regimeAwareLearning
    : {};
  const recommendationPerformance = input.recommendationPerformance && typeof input.recommendationPerformance === 'object'
    ? input.recommendationPerformance
    : {};
  const recommendationPerformanceSummary = recommendationPerformance?.summary && typeof recommendationPerformance.summary === 'object'
    ? recommendationPerformance.summary
    : {};
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object'
    ? input.regimeByDate
    : {};

  const strategyLookup = toRegimeLookup(regimeAwareLearning?.strategyByRegime || []);
  const tpLookup = toRegimeLookup(regimeAwareLearning?.tpModeByRegime || []);
  const recommendationLookup = toRegimeLookup(regimeAwareLearning?.recommendationAccuracyByRegime || []);
  const scorecards = Array.isArray(recommendationPerformance?.scorecards)
    ? recommendationPerformance.scorecards
    : [];
  const provenanceByRegime = buildProvenanceByRegime(scorecards, regimeByDate);

  const labels = new Set([
    ...strategyLookup.keys(),
    ...tpLookup.keys(),
    ...recommendationLookup.keys(),
    ...provenanceByRegime.keys(),
    currentRegimeLabel,
  ]);

  const rows = Array.from(labels)
    .map((label) => normalizeRegimeLabel(label))
    .filter((label) => SUPPORTED_REGIME_LABELS.includes(label))
    .map((regimeLabel) => {
      const strategyRow = strategyLookup.get(regimeLabel) || null;
      const tpRow = tpLookup.get(regimeLabel) || null;
      const recommendationRow = recommendationLookup.get(regimeLabel) || null;
      const breakdown = provenanceByRegime.get(regimeLabel) || buildBreakdown(0, 0);

      const recommendationScore = scoreRecommendationRow(recommendationRow || {});
      const strategyScore = scoreStrategyRow(strategyRow || {});
      const tpScore = scoreTpRow(tpRow || {});
      const deltaScore = scoreDeltaRow(recommendationRow || {});

      const usefulnessScore = computeUsefulnessScore({
        recommendation: recommendationScore,
        strategy: strategyScore,
        tp: tpScore,
        delta: deltaScore,
      });

      const upstreamCoverageSampleSize = Math.max(
        toNumber(recommendationRow?.sampleSize, 0) || 0,
        toNumber(strategyRow?.sampleSize, 0) || 0,
        toNumber(tpRow?.sampleSize, 0) || 0
      );
      const directProvenanceSampleSize = Math.max(0, Number(breakdown.total || 0));
      const sampleSize = Math.max(upstreamCoverageSampleSize, directProvenanceSampleSize);
      const coverageType = deriveCoverageType(upstreamCoverageSampleSize, directProvenanceSampleSize);

      const warnings = [];
      if (breakdown.total === 0) warnings.push('no_regime_provenance');
      if (sampleSize < 5) warnings.push('thin_regime_sample');
      if (!Number.isFinite(Number(recommendationScore))) warnings.push('missing_recommendation_signal');
      if (!Number.isFinite(Number(strategyScore))) warnings.push('missing_strategy_signal');
      if (!Number.isFinite(Number(tpScore))) warnings.push('missing_tp_signal');

      let usefulnessScoreSafe = Number.isFinite(Number(usefulnessScore)) ? round2(usefulnessScore) : null;
      let usefulnessLabel = classifyUsefulnessLabel(usefulnessScoreSafe, sampleSize);
      if (coverageType === COVERAGE_NO_SUPPORT) {
        usefulnessScoreSafe = null;
        usefulnessLabel = 'insufficient';
        warnings.push('no_regime_support');
      } else if (directProvenanceSampleSize <= 0) {
        warnings.push('no_direct_regime_provenance');
        warnings.push('inferred_from_upstream_buckets');
        if (usefulnessLabel === 'strong') usefulnessLabel = 'moderate';
      }
      if (coverageType === COVERAGE_UPSTREAM_ONLY && usefulnessLabel === 'strong') {
        usefulnessLabel = 'moderate';
      }
      if (directProvenanceSampleSize > 0 && directProvenanceSampleSize < 5) {
        warnings.push('thin_direct_regime_provenance');
        if (usefulnessLabel !== 'insufficient') usefulnessLabel = 'noisy';
      }

      const row = {
        regimeLabel,
        sampleSize,
        usefulnessScore: usefulnessScoreSafe,
        usefulnessLabel,
        confidenceAdjustment: 0,
        warnings,
        evidenceSourceBreakdown: breakdown,
        upstreamCoverageSampleSize,
        directProvenanceSampleSize,
        coverageType,
        provenanceStrengthLabel: 'absent',
        strategyRow,
        tpRow,
        recommendationRow,
      };
      row.confidenceAdjustment = computeConfidenceAdjustment(row);
      if (coverageType === COVERAGE_NO_SUPPORT) row.confidenceAdjustment = 0;
      if (directProvenanceSampleSize <= 0 || coverageType === COVERAGE_UPSTREAM_ONLY) {
        row.confidenceAdjustment = Math.min(row.confidenceAdjustment, 0);
      }
      if (directProvenanceSampleSize > 0 && directProvenanceSampleSize < 5) {
        row.confidenceAdjustment = round2(clamp(row.confidenceAdjustment, -2, 0));
      }
      row.provenanceStrengthLabel = deriveProvenanceStrengthLabel(row);
      row.advisoryOnly = true;
      row.warnings = Array.from(new Set((Array.isArray(row.warnings) ? row.warnings : []).filter(Boolean)));
      return row;
    })
    .sort((a, b) => {
      const as = toNumber(a?.usefulnessScore, Number.NEGATIVE_INFINITY);
      const bs = toNumber(b?.usefulnessScore, Number.NEGATIVE_INFINITY);
      if (bs !== as) return bs - as;
      return String(a?.regimeLabel || '').localeCompare(String(b?.regimeLabel || ''));
    });

  const strongRegimeLabels = rows
    .filter((row) => (
      row.usefulnessLabel === 'strong'
      && row.coverageType !== COVERAGE_UPSTREAM_ONLY
      && row.coverageType !== COVERAGE_NO_SUPPORT
    ))
    .map((row) => row.regimeLabel);
  const weakRegimeLabels = rows
    .filter((row) => ['weak', 'noisy', 'insufficient'].includes(String(row.usefulnessLabel || '').toLowerCase()))
    .map((row) => row.regimeLabel);

  const currentRow = rows.find((row) => row.regimeLabel === currentRegimeLabel) || null;
  const regimeConfidenceGuidance = buildGuidance(currentRow, currentRegimeLabel);
  const regimeFeedbackInsight = buildRegimeFeedbackInsight(rows, regimeConfidenceGuidance);

  const strategySelectionUsefulnessByRegime = toSecondaryStrategyUsefulness(rows);
  const tpUsefulnessByRegime = toSecondaryTpUsefulness(rows);

  const upstreamWarnings = [];
  if (Array.isArray(recommendationPerformance?.warnings)) upstreamWarnings.push(...recommendationPerformance.warnings);
  if (Array.isArray(recommendationPerformanceSummary?.warnings)) upstreamWarnings.push(...recommendationPerformanceSummary.warnings);
  if (Array.isArray(recommendationPerformanceSummary?.calibrationWarnings)) upstreamWarnings.push(...recommendationPerformanceSummary.calibrationWarnings);
  if (Array.isArray(regimeAwareLearning?.dataQuality?.warnings)) upstreamWarnings.push(...regimeAwareLearning.dataQuality.warnings);
  const summarySourceBreakdown = recommendationPerformanceSummary?.sourceBreakdown && typeof recommendationPerformanceSummary.sourceBreakdown === 'object'
    ? buildBreakdown(
      recommendationPerformanceSummary.sourceBreakdown.live,
      recommendationPerformanceSummary.sourceBreakdown.backfill
    )
    : buildBreakdown(0, 0);
  const summaryEvidenceQuality = classifyEvidenceQuality(summarySourceBreakdown);
  if (summaryEvidenceQuality === 'retrospective_heavy') upstreamWarnings.push('retrospective_heavy_global_source_mix');
  if (summaryEvidenceQuality === 'thin') upstreamWarnings.push('thin_global_source_mix');

  const dataQuality = {
    isThinSample: rows.every((row) => Number(row.sampleSize || 0) < 10),
    warnings: Array.from(new Set(upstreamWarnings.filter(Boolean))),
    sourceBreakdown: summarySourceBreakdown,
    sourceEvidenceQuality: summaryEvidenceQuality,
    coverage: {
      regimes: rows.length,
      withProvenance: rows.filter((row) => Number(row?.evidenceSourceBreakdown?.total || 0) > 0).length,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    includeContext,
    performanceSource,
    currentRegimeLabel,
    regimeUsefulness: rows.map((row) => ({
      regimeLabel: row.regimeLabel,
      sampleSize: row.sampleSize,
      usefulnessScore: row.usefulnessScore,
      usefulnessLabel: row.usefulnessLabel,
      confidenceAdjustment: row.confidenceAdjustment,
      upstreamCoverageSampleSize: row.upstreamCoverageSampleSize,
      directProvenanceSampleSize: row.directProvenanceSampleSize,
      coverageType: row.coverageType,
      provenanceStrengthLabel: row.provenanceStrengthLabel,
      warnings: row.warnings,
      evidenceSourceBreakdown: row.evidenceSourceBreakdown,
      advisoryOnly: true,
    })),
    regimeConfidenceGuidance,
    strategySelectionUsefulnessByRegime,
    tpUsefulnessByRegime,
    strongRegimeLabels,
    weakRegimeLabels,
    regimeFeedbackInsight,
    dataQuality,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimePerformanceFeedbackSummary,
  classifyEvidenceQuality,
};
