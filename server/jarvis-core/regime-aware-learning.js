'use strict';

const { ORIGINAL_PLAN_SPEC } = require('./strategy-layers');
const {
  SUPPORTED_REGIME_LABELS,
  buildRegimeDetection,
} = require('./regime-detection');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;
const MIN_BUCKET_SAMPLE = 10;

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeRegimeLabel(rawValue = '') {
  const raw = toText(rawValue).toLowerCase();
  if (!raw) return 'unknown';
  if (SUPPORTED_REGIME_LABELS.includes(raw)) return raw;
  if (raw === 'choppy') return 'ranging';
  if (raw === 'flat') return 'compressed';
  if (raw === 'wide' || raw === 'high' || raw === 'extreme') return 'wide_volatile';
  if (raw === 'narrow' || raw === 'low') return 'compressed';
  if (raw === 'normal') return 'mixed';
  return 'unknown';
}

function scoreLabelToPct(label = '') {
  const txt = toText(label).toLowerCase();
  if (txt === 'correct') return 1;
  if (txt === 'partially_correct') return 0.5;
  if (txt === 'incorrect') return 0;
  return null;
}

function sampleConfidence(sampleSize = 0, extra = 0) {
  const n = toNumber(sampleSize, 0);
  const boost = toNumber(extra, 0);
  if (n >= 25 + boost) return 'high';
  if (n >= 12 + Math.round(boost / 2)) return 'medium';
  return 'low';
}

function sampleWarning(sampleSize = 0, kind = 'bucket') {
  const n = toNumber(sampleSize, 0);
  if (n >= MIN_BUCKET_SAMPLE) return null;
  return `${kind}_thin_sample_${n}`;
}

function metricScore(row = {}) {
  const pf = toNumber(row.profitFactor, 0);
  const wr = toNumber(row.winRate, toNumber(row.winRatePct, 0));
  const sample = toNumber(row.tradeCount, toNumber(row.sampleSize, 0));
  return round2((pf * 35) + (wr * 0.45) + Math.min(25, sample * 0.5));
}

function aggregateWeightedRows(rows = [], keyField) {
  const byKey = new Map();
  for (const row of rows) {
    const key = toText(row?.[keyField]);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        tradeCount: 0,
        winRateWeighted: 0,
        profitFactorWeighted: 0,
        scoreWeighted: 0,
      });
    }
    const acc = byKey.get(key);
    const weight = Math.max(1, toNumber(row?.tradeCount, 0));
    acc.tradeCount += weight;
    acc.winRateWeighted += toNumber(row?.winRate, toNumber(row?.winRatePct, 0)) * weight;
    acc.profitFactorWeighted += toNumber(row?.profitFactor, 0) * weight;
    acc.scoreWeighted += metricScore(row) * weight;
  }

  return Array.from(byKey.values()).map((acc) => ({
    key: acc.key,
    tradeCount: acc.tradeCount,
    winRate: acc.tradeCount > 0 ? round2(acc.winRateWeighted / acc.tradeCount) : 0,
    profitFactor: acc.tradeCount > 0 ? round2(acc.profitFactorWeighted / acc.tradeCount) : 0,
    score: acc.tradeCount > 0 ? round2(acc.scoreWeighted / acc.tradeCount) : 0,
  }));
}

function buildStrategyByRegime(strategyTracking = {}) {
  const tracked = Array.isArray(strategyTracking?.trackedStrategies)
    ? strategyTracking.trackedStrategies
    : [];
  const rows = [];

  for (const strategy of tracked) {
    const regimeRows = Array.isArray(strategy?.contextPerformance?.regime?.rows)
      ? strategy.contextPerformance.regime.rows
      : [];
    for (const regimeRow of regimeRows) {
      const regimeLabel = normalizeRegimeLabel(regimeRow?.context);
      rows.push({
        regimeLabel,
        strategyKey: toText(strategy?.strategyKey),
        strategyName: toText(strategy?.strategyName),
        strategyType: toText(strategy?.strategyType).toLowerCase() || 'unknown',
        sourceLayer: toText(strategy?.sourceLayer).toLowerCase() || 'unknown',
        tradeCount: toNumber(regimeRow?.tradeCount, 0),
        winRate: toNumber(regimeRow?.winRate, 0),
        profitFactor: toNumber(regimeRow?.profitFactor, 0),
        score: toNumber(regimeRow?.score, metricScore(regimeRow)),
      });
    }
  }

  const byRegime = new Map();
  for (const row of rows) {
    if (!byRegime.has(row.regimeLabel)) byRegime.set(row.regimeLabel, []);
    byRegime.get(row.regimeLabel).push(row);
  }

  const out = [];
  for (const [regimeLabel, regimeRows] of byRegime.entries()) {
    const merged = aggregateWeightedRows(regimeRows, 'strategyKey').map((m) => {
      const seed = regimeRows.find((x) => toText(x.strategyKey) === toText(m.key)) || {};
      return {
        strategyKey: m.key,
        strategyName: toText(seed.strategyName || m.key),
        strategyType: toText(seed.strategyType).toLowerCase() || 'unknown',
        sourceLayer: toText(seed.sourceLayer).toLowerCase() || 'unknown',
        tradeCount: m.tradeCount,
        winRate: m.winRate,
        profitFactor: m.profitFactor,
        score: m.score,
      };
    });

    merged.sort((a, b) => toNumber(b.score, 0) - toNumber(a.score, 0));
    const best = merged[0] || null;
    const weakest = merged.length > 1 ? merged[merged.length - 1] : null;
    const sampleSize = toNumber(best?.tradeCount, 0);
    const warning = sampleWarning(sampleSize, `strategy_${regimeLabel}`);

    out.push({
      regimeLabel,
      sampleSize,
      confidenceLabel: sampleConfidence(sampleSize),
      comparedStrategies: merged.length,
      bestStrategy: best
        ? {
          strategyKey: best.strategyKey,
          strategyName: best.strategyName,
          strategyType: best.strategyType,
          sourceLayer: best.sourceLayer,
          tradeCount: best.tradeCount,
          winRate: round2(best.winRate),
          profitFactor: round2(best.profitFactor),
          score: round2(best.score),
          advisoryOnly: true,
        }
        : null,
      weakestStrategy: weakest
        ? {
          strategyKey: weakest.strategyKey,
          strategyName: weakest.strategyName,
          strategyType: weakest.strategyType,
          sourceLayer: weakest.sourceLayer,
          tradeCount: weakest.tradeCount,
          winRate: round2(weakest.winRate),
          profitFactor: round2(weakest.profitFactor),
          score: round2(weakest.score),
          advisoryOnly: true,
        }
        : null,
      warning,
      advisoryOnly: true,
    });
  }

  return out.sort((a, b) => String(a.regimeLabel).localeCompare(String(b.regimeLabel)));
}

function buildTpModeByRegime(mechanicsResearchSummary = {}) {
  const segmentRows = Array.isArray(mechanicsResearchSummary?.segmentations?.regime?.rows)
    ? mechanicsResearchSummary.segmentations.regime.rows
    : [];
  const normalized = segmentRows.map((row) => ({
    regimeLabel: normalizeRegimeLabel(row?.bucket),
    tpMode: toText(row?.tpMode),
    tradeCount: toNumber(row?.tradeCount, 0),
    winRate: toNumber(row?.winRatePct, 0),
    profitFactor: toNumber(row?.profitFactor, 0),
    score: toNumber(row?.scoreRecent, metricScore({
      tradeCount: row?.tradeCount,
      winRatePct: row?.winRatePct,
      profitFactor: row?.profitFactor,
    })),
  })).filter((row) => row.tpMode);

  const byRegime = new Map();
  for (const row of normalized) {
    if (!byRegime.has(row.regimeLabel)) byRegime.set(row.regimeLabel, []);
    byRegime.get(row.regimeLabel).push(row);
  }

  const out = [];
  for (const [regimeLabel, rows] of byRegime.entries()) {
    const merged = aggregateWeightedRows(rows, 'tpMode').map((m) => ({
      tpMode: m.key,
      tradeCount: m.tradeCount,
      winRate: m.winRate,
      profitFactor: m.profitFactor,
      score: m.score,
    }));
    merged.sort((a, b) => toNumber(b.score, 0) - toNumber(a.score, 0));
    const best = merged[0] || null;
    const sampleSize = toNumber(best?.tradeCount, 0);

    out.push({
      regimeLabel,
      sampleSize,
      confidenceLabel: sampleConfidence(sampleSize),
      bestTpMode: best?.tpMode || null,
      bestTpWinRate: best ? round2(best.winRate) : null,
      bestTpProfitFactor: best ? round2(best.profitFactor) : null,
      tpModes: merged.map((row) => ({
        tpMode: row.tpMode,
        tradeCount: row.tradeCount,
        winRate: round2(row.winRate),
        profitFactor: round2(row.profitFactor),
        score: round2(row.score),
      })),
      warning: sampleWarning(sampleSize, `tp_${regimeLabel}`),
      advisoryOnly: true,
    });
  }

  return out.sort((a, b) => String(a.regimeLabel).localeCompare(String(b.regimeLabel)));
}

function buildRecommendationAccuracyByRegime(recommendationPerformance = {}, regimeByDate = {}) {
  const scorecards = Array.isArray(recommendationPerformance?.scorecards)
    ? recommendationPerformance.scorecards
    : [];
  const byRegime = new Map();

  for (const scorecard of scorecards) {
    const date = toText(scorecard?.date || scorecard?.recommendationDate || '').slice(0, 10);
    if (!date) continue;
    const regime = buildRegimeDetection({
      regimeByDate,
      latestDate: date,
      includeEvidence: false,
      sessionPhase: toText(scorecard?.timeBucket || ''),
    });
    const regimeLabel = normalizeRegimeLabel(regime?.regimeLabel || 'unknown');

    if (!byRegime.has(regimeLabel)) {
      byRegime.set(regimeLabel, {
        regimeLabel,
        sampleSize: 0,
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

    const acc = byRegime.get(regimeLabel);
    acc.sampleSize += 1;

    const posture = scoreLabelToPct(scorecard?.postureEvaluation);
    if (posture !== null) {
      acc.postureSum += posture;
      acc.postureCount += 1;
    }

    const strategy = scoreLabelToPct(scorecard?.strategyRecommendationScore?.scoreLabel);
    if (strategy !== null) {
      acc.strategySum += strategy;
      acc.strategyCount += 1;
    }

    const tp = scoreLabelToPct(scorecard?.tpRecommendationScore?.scoreLabel);
    if (tp !== null) {
      acc.tpSum += tp;
      acc.tpCount += 1;
    }

    const delta = Number(scorecard?.recommendationDelta);
    if (Number.isFinite(delta)) {
      acc.deltaSum += delta;
      acc.deltaCount += 1;
    }
  }

  return Array.from(byRegime.values())
    .map((acc) => ({
      regimeLabel: acc.regimeLabel,
      sampleSize: acc.sampleSize,
      confidenceLabel: sampleConfidence(acc.sampleSize),
      postureAccuracy: acc.postureCount > 0 ? round2((acc.postureSum / acc.postureCount) * 100) : null,
      strategyAccuracy: acc.strategyCount > 0 ? round2((acc.strategySum / acc.strategyCount) * 100) : null,
      tpAccuracy: acc.tpCount > 0 ? round2((acc.tpSum / acc.tpCount) * 100) : null,
      avgRecommendationDelta: acc.deltaCount > 0 ? round2(acc.deltaSum / acc.deltaCount) : null,
      warning: sampleWarning(acc.sampleSize, `recommendation_${acc.regimeLabel}`),
      advisoryOnly: true,
    }))
    .sort((a, b) => String(a.regimeLabel).localeCompare(String(b.regimeLabel)));
}

function selectByRegime(rows = [], regimeLabel = '') {
  const label = normalizeRegimeLabel(regimeLabel);
  return (Array.isArray(rows) ? rows : []).find((row) => normalizeRegimeLabel(row?.regimeLabel) === label) || null;
}

function toStrategyRef(row = null, regimeLabel = '', reason = '') {
  if (!row || typeof row !== 'object') return null;
  return {
    regimeLabel: normalizeRegimeLabel(regimeLabel),
    strategyKey: toText(row.strategyKey),
    strategyName: toText(row.strategyName),
    strategyType: toText(row.strategyType).toLowerCase() || 'unknown',
    sourceLayer: toText(row.sourceLayer).toLowerCase() || 'unknown',
    confidenceLabel: toText(row.confidenceLabel || 'low').toLowerCase() || 'low',
    reason: toText(reason) || null,
    advisoryOnly: true,
  };
}

function buildRegimeSpecificInsights(input = {}) {
  const opportunities = [];
  const risks = [];

  const currentRegime = normalizeRegimeLabel(input.currentRegimeLabel || 'unknown');
  const strategyRow = selectByRegime(input.strategyByRegime, currentRegime);
  const tpRow = selectByRegime(input.tpModeByRegime, currentRegime);
  const recRow = selectByRegime(input.recommendationAccuracyByRegime, currentRegime);

  if (strategyRow?.bestStrategy) {
    opportunities.push({
      regimeLabel: currentRegime,
      insight: `${strategyRow.bestStrategy.strategyName} leads in ${currentRegime} regime conditions.`
        + (strategyRow.confidenceLabel === 'low' ? ' Confidence is limited due to sample size.' : ''),
      confidenceLabel: strategyRow.confidenceLabel,
      advisoryOnly: true,
    });

    const baselineWeak = strategyRow.bestStrategy.strategyKey !== ORIGINAL_PLAN_SPEC.key;
    if (baselineWeak && strategyRow.confidenceLabel !== 'low') {
      opportunities.push({
        regimeLabel: currentRegime,
        insight: `Baseline is not the top scorer in ${currentRegime}; keep ${strategyRow.bestStrategy.strategyName} on advisory watch.`,
        confidenceLabel: strategyRow.confidenceLabel,
        advisoryOnly: true,
      });
    }
  }

  if (tpRow?.bestTpMode) {
    opportunities.push({
      regimeLabel: currentRegime,
      insight: `${tpRow.bestTpMode} is the strongest TP mode in ${currentRegime} regime buckets.`
        + (tpRow.confidenceLabel === 'low' ? ' Evidence is thin.' : ''),
      confidenceLabel: tpRow.confidenceLabel,
      advisoryOnly: true,
    });
  }

  if (recRow && Number.isFinite(Number(recRow.postureAccuracy))) {
    const posture = Number(recRow.postureAccuracy);
    if (posture >= 60) {
      opportunities.push({
        regimeLabel: currentRegime,
        insight: `Recommendation posture accuracy is constructive in ${currentRegime} (${round2(posture)}%).`,
        confidenceLabel: recRow.confidenceLabel,
        advisoryOnly: true,
      });
    } else if (posture < 50) {
      risks.push({
        regimeLabel: currentRegime,
        insight: `Posture recommendation accuracy is weak in ${currentRegime} (${round2(posture)}%); stay conservative.`,
        confidenceLabel: recRow.confidenceLabel,
        advisoryOnly: true,
      });
    }
  }

  if (currentRegime === 'mixed' || currentRegime === 'unknown') {
    risks.push({
      regimeLabel: currentRegime,
      insight: `Current regime is ${currentRegime}; regime-specific learning confidence is naturally constrained.`,
      confidenceLabel: 'low',
      advisoryOnly: true,
    });
  }

  if (strategyRow?.warning) {
    risks.push({
      regimeLabel: currentRegime,
      insight: `Strategy-by-regime evidence is thin (${strategyRow.warning}).`,
      confidenceLabel: 'low',
      advisoryOnly: true,
    });
  }
  if (tpRow?.warning) {
    risks.push({
      regimeLabel: currentRegime,
      insight: `TP-by-regime evidence is thin (${tpRow.warning}).`,
      confidenceLabel: 'low',
      advisoryOnly: true,
    });
  }

  return {
    regimeSpecificOpportunities: opportunities.slice(0, 4),
    regimeSpecificRisks: risks.slice(0, 4),
  };
}

function buildTopAligned(strategyByRegime = [], currentRegimeLabel = '') {
  const currentRegime = normalizeRegimeLabel(currentRegimeLabel || 'unknown');
  const row = selectByRegime(strategyByRegime, currentRegime);
  if (!row?.bestStrategy) return null;
  return toStrategyRef(
    {
      ...row.bestStrategy,
      confidenceLabel: row.confidenceLabel,
    },
    currentRegime,
    `${row.bestStrategy.strategyName} has the strongest regime-aligned score for ${currentRegime}.`
  );
}

function buildTopMisaligned(strategyByRegime = [], currentRegimeLabel = '') {
  const currentRegime = normalizeRegimeLabel(currentRegimeLabel || 'unknown');
  const row = selectByRegime(strategyByRegime, currentRegime);
  if (!row?.weakestStrategy) return null;
  return toStrategyRef(
    {
      ...row.weakestStrategy,
      confidenceLabel: row.confidenceLabel,
    },
    currentRegime,
    `${row.weakestStrategy.strategyName} is currently the weakest regime-aligned lane for ${currentRegime}.`
  );
}

function buildRegimeLearningInsight(input = {}) {
  const opportunities = Array.isArray(input.regimeSpecificOpportunities) ? input.regimeSpecificOpportunities : [];
  const risks = Array.isArray(input.regimeSpecificRisks) ? input.regimeSpecificRisks : [];
  if (opportunities.length > 0 && risks.length > 0) {
    return `${opportunities[0].insight} ${risks[0].insight}`;
  }
  if (opportunities.length > 0) return opportunities[0].insight;
  if (risks.length > 0) return risks[0].insight;
  return 'Regime-aware learning is active, but evidence is still too thin for strong regime-specific claims.';
}

function buildRegimeAwareLearningSummary(input = {}) {
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const includeContext = input.includeContext !== false;
  const performanceSource = toText(input.performanceSource || 'all').toLowerCase() || 'all';

  const regimeDetection = input.regimeDetection && typeof input.regimeDetection === 'object'
    ? input.regimeDetection
    : null;
  const currentRegimeLabel = normalizeRegimeLabel(regimeDetection?.regimeLabel || input.currentRegimeLabel || 'unknown');
  const currentRegimeConfidence = toText(regimeDetection?.confidenceLabel || 'low').toLowerCase() || 'low';

  const strategyByRegime = buildStrategyByRegime(input.strategyTracking || {});
  const tpModeByRegime = buildTpModeByRegime(input.mechanicsResearchSummary || {});
  const recommendationAccuracyByRegime = buildRecommendationAccuracyByRegime(
    input.recommendationPerformance || {},
    input.regimeByDate || {}
  );

  const topRegimeAlignedStrategy = buildTopAligned(strategyByRegime, currentRegimeLabel);
  const topRegimeMisalignedStrategy = buildTopMisaligned(strategyByRegime, currentRegimeLabel);

  const scopedInsights = buildRegimeSpecificInsights({
    currentRegimeLabel,
    strategyByRegime,
    tpModeByRegime,
    recommendationAccuracyByRegime,
  });

  const warnings = [];
  const thinStrategy = strategyByRegime.every((row) => row.confidenceLabel === 'low');
  const thinTp = tpModeByRegime.every((row) => row.confidenceLabel === 'low');
  const thinRec = recommendationAccuracyByRegime.every((row) => row.confidenceLabel === 'low');

  if (strategyByRegime.length === 0) warnings.push('strategy_regime_coverage_missing');
  if (tpModeByRegime.length === 0) warnings.push('tp_regime_coverage_missing');
  if (recommendationAccuracyByRegime.length === 0) warnings.push('recommendation_regime_coverage_missing');
  if (thinStrategy && strategyByRegime.length > 0) warnings.push('strategy_regime_thin_sample');
  if (thinTp && tpModeByRegime.length > 0) warnings.push('tp_regime_thin_sample');
  if (thinRec && recommendationAccuracyByRegime.length > 0) warnings.push('recommendation_regime_thin_sample');
  if (performanceSource !== 'live') warnings.push('contains_retrospective_evidence');
  if (currentRegimeLabel === 'mixed' || currentRegimeLabel === 'unknown') warnings.push('weak_current_regime_clarity');

  const dataQuality = {
    isThinSample: warnings.some((w) => /thin|missing|weak_current_regime_clarity/.test(w)),
    warnings,
    regimeCoverage: {
      strategyBuckets: strategyByRegime.length,
      tpBuckets: tpModeByRegime.length,
      recommendationBuckets: recommendationAccuracyByRegime.length,
    },
    currentRegimeLabel,
    currentRegimeConfidence,
  };

  const regimeLearningInsight = buildRegimeLearningInsight(scopedInsights);

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    includeContext,
    performanceSource,
    currentRegimeLabel,
    currentRegimeConfidence,
    strategyByRegime,
    tpModeByRegime,
    recommendationAccuracyByRegime,
    regimeSpecificOpportunities: scopedInsights.regimeSpecificOpportunities,
    regimeSpecificRisks: scopedInsights.regimeSpecificRisks,
    topRegimeAlignedStrategy,
    topRegimeMisalignedStrategy,
    regimeLearningInsight,
    dataQuality,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRegimeAwareLearningSummary,
  normalizeRegimeLabel,
};
