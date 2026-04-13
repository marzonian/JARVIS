'use strict';

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function toDateIso(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function getEtWeekday(dateIso) {
  const src = toDateIso(dateIso);
  if (!src) return 'Unknown';
  const d = new Date(`${src}T12:00:00-05:00`);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
    }).format(d);
  } catch {
    return 'Unknown';
  }
}

function parseNowEt(input) {
  if (input && typeof input === 'object') {
    const date = toDateIso(input.date || input.nowDate || input.sessionDate);
    const time = toText(input.time || input.nowTime).slice(0, 5);
    if (date && /^\d{2}:\d{2}$/.test(time)) return { date, time };
  }
  const txt = toText(input);
  const m = txt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };

  const now = new Date();
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const date = `${dateParts.find((p) => p.type === 'year')?.value || '1970'}-${dateParts.find((p) => p.type === 'month')?.value || '01'}-${dateParts.find((p) => p.type === 'day')?.value || '01'}`;
  const time = `${timeParts.find((p) => p.type === 'hour')?.value || '00'}:${timeParts.find((p) => p.type === 'minute')?.value || '00'}`;
  return { date, time };
}

function deriveTimeBucketFromClock(timeText) {
  const src = toText(timeText);
  const m = src.match(/^(\d{2}):(\d{2})$/);
  if (!m) return 'unknown';
  const mins = (Number(m[1]) * 60) + Number(m[2]);
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 585) return 'orb_window';
  if (mins < 615) return 'post_orb';
  if (mins <= 659) return 'momentum_window';
  return 'late_window';
}

function normalizeRegime(regimeByDate = {}, date, explicitRegime = '') {
  const explicit = toText(explicitRegime).toLowerCase();
  if (explicit) return explicit;
  const src = regimeByDate && typeof regimeByDate === 'object' ? regimeByDate[date] : null;
  if (!src || typeof src !== 'object') return null;
  return toText(src.regime || src.regime_trend || src.trend || src.volatility || '').toLowerCase() || null;
}

function resolveTodayContext(options = {}) {
  const nowEt = parseNowEt(options.nowEt);
  const date = nowEt.date;
  const time = nowEt.time;
  const weekday = getEtWeekday(date);
  const timeBucket = deriveTimeBucketFromClock(time);
  const regime = normalizeRegime(options.regimeByDate || {}, date, options.currentRegime);
  return {
    date,
    time,
    weekday,
    timeBucket,
    regime,
    regimeAvailable: !!regime,
  };
}

function getTradeKey(record = {}) {
  const tradeKey = toText(record.tradeKey);
  if (tradeKey) return tradeKey;
  const date = toDateIso(record.date);
  const tpMode = toText(record.tpMode || 'mode');
  return `${date}|${tpMode}`;
}

function countDistinctTrades(records = []) {
  const keys = new Set();
  for (const record of (Array.isArray(records) ? records : [])) {
    keys.add(getTradeKey(record));
  }
  return keys.size;
}

function selectContextualRecords(records = [], context = {}, options = {}) {
  const all = Array.isArray(records) ? records.filter(Boolean) : [];
  const minSampleSize = Math.max(1, Number(options.minSampleSize || 15));
  const weekday = toText(context.weekday);
  const timeBucket = toText(context.timeBucket);
  const regime = toText(context.regime).toLowerCase();

  const fallbackSteps = [];
  if (weekday && timeBucket && regime) {
    fallbackSteps.push({
      fallbackLevel: 'exact_context',
      contextUsed: { weekday, timeBucket, regime },
      predicate: (row) => toText(row.weekday) === weekday
        && toText(row.timeBucket) === timeBucket
        && toText(row.regime).toLowerCase() === regime,
    });
  }
  if (weekday && timeBucket) {
    fallbackSteps.push({
      fallbackLevel: 'drop_regime',
      contextUsed: { weekday, timeBucket, regime: null },
      predicate: (row) => toText(row.weekday) === weekday
        && toText(row.timeBucket) === timeBucket,
    });
  }
  if (timeBucket) {
    fallbackSteps.push({
      fallbackLevel: 'time_bucket_only',
      contextUsed: { weekday: null, timeBucket, regime: null },
      predicate: (row) => toText(row.timeBucket) === timeBucket,
    });
  }
  fallbackSteps.push({
    fallbackLevel: 'global',
    contextUsed: { weekday: null, timeBucket: null, regime: null },
    predicate: () => true,
  });

  let selected = [];
  let selectedStep = fallbackSteps[fallbackSteps.length - 1];
  for (const step of fallbackSteps) {
    const subset = all.filter(step.predicate);
    const sampleSize = countDistinctTrades(subset);
    if (sampleSize >= minSampleSize || step.fallbackLevel === 'global') {
      selected = subset;
      selectedStep = step;
      break;
    }
  }

  const sampleSize = countDistinctTrades(selected);
  const warnings = [];
  if (selectedStep.fallbackLevel !== 'exact_context') {
    warnings.push(`context_fallback_${selectedStep.fallbackLevel}`);
  }
  if (sampleSize < minSampleSize) {
    warnings.push(`thin_context_sample_${sampleSize}`);
  }

  return {
    selectedRecords: selected,
    fallbackLevel: selectedStep.fallbackLevel,
    contextUsed: selectedStep.contextUsed,
    sampleSize,
    minSampleSize,
    warnings,
  };
}

function buildConfidenceScore({
  selectedTable = [],
  globalTable = [],
  recommendedMode = '',
  contextSampleSize = 0,
  minSampleSize = 15,
}) {
  const rows = Array.isArray(selectedTable) ? selectedTable.filter(Boolean) : [];
  const sorted = rows.slice().sort((a, b) => Number(b.scoreRecent || 0) - Number(a.scoreRecent || 0));
  const top = sorted[0] || null;
  const second = sorted[1] || null;

  const sampleScore = clamp(contextSampleSize / Math.max(minSampleSize * 3, 30), 0, 1);
  const wrGap = top && second ? Math.abs(Number(top.winRatePct || 0) - Number(second.winRatePct || 0)) : 0;
  const pfGap = top && second ? Math.abs(Number(top.profitFactor || 0) - Number(second.profitFactor || 0)) : 0;
  const stabilityScore = clamp((Math.min(1, wrGap / 12) * 0.45) + (Math.min(1, pfGap / 0.75) * 0.55), 0, 1);

  const globalRows = Array.isArray(globalTable) ? globalTable.filter(Boolean) : [];
  const ctxMode = toText(recommendedMode);
  const contextRow = rows.find((r) => toText(r.tpMode) === ctxMode) || null;
  const globalRow = globalRows.find((r) => toText(r.tpMode) === ctxMode) || null;
  const wrDistance = contextRow && globalRow
    ? Math.abs(Number(contextRow.winRatePct || 0) - Number(globalRow.winRatePct || 0))
    : 0;
  const pfDistance = contextRow && globalRow
    ? Math.abs(Number(contextRow.profitFactor || 0) - Number(globalRow.profitFactor || 0))
    : 0;
  const distancePenalty = clamp((Math.min(1, wrDistance / 20) * 0.5) + (Math.min(1, pfDistance / 1.0) * 0.5), 0, 1);
  const distanceScore = 1 - distancePenalty;

  const confidenceScore = round2(((sampleScore * 0.5) + (stabilityScore * 0.3) + (distanceScore * 0.2)) * 100);
  const confidenceLabel = confidenceScore >= 75 ? 'high' : confidenceScore >= 50 ? 'medium' : 'low';

  return {
    confidenceScore,
    confidenceLabel,
    components: {
      sampleScore: round2(sampleScore * 100),
      stabilityScore: round2(stabilityScore * 100),
      distanceScore: round2(distanceScore * 100),
    },
  };
}

function formatContextLabel(contextUsed = {}) {
  const weekday = toText(contextUsed.weekday);
  const timeBucket = toText(contextUsed.timeBucket).replace(/_/g, ' ');
  const regime = toText(contextUsed.regime);
  if (weekday && timeBucket && regime) return `${weekday} ${timeBucket} (${regime})`;
  if (weekday && timeBucket) return `${weekday} ${timeBucket}`;
  if (timeBucket) return `${timeBucket}`;
  return 'global context';
}

function buildContextualMechanicsRecommendation(input = {}) {
  const records = Array.isArray(input.records) ? input.records.filter(Boolean) : [];
  const aggregate = input?.deps?.aggregateMechanicsVariants;
  const rank = input?.deps?.rankMechanicsModes;
  const recommend = input?.deps?.buildMechanicsRecommendation;

  if (!records.length || typeof aggregate !== 'function' || typeof rank !== 'function' || typeof recommend !== 'function') {
    return {
      contextUsed: null,
      fallbackLevel: 'global',
      sampleSize: 0,
      confidenceScore: 0,
      confidenceLabel: 'low',
      bestTpModeContext: null,
      bestTpModeContextWinRate: null,
      bestTpModeContextPF: null,
      contextualRecommendedTpMode: null,
      contextualRecommendationReason: 'Contextual mechanics recommendation is unavailable due to missing inputs.',
      contextVariantTable: [],
      advisoryOnly: true,
      warnings: ['contextual_inputs_missing'],
    };
  }

  const minSampleSize = Math.max(1, Number(input.minSampleSize || 15));
  const context = resolveTodayContext({
    nowEt: input.nowEt,
    regimeByDate: input.regimeByDate || {},
    currentRegime: input.currentRegime,
  });
  const selected = selectContextualRecords(records, context, { minSampleSize });
  const aggregated = aggregate(selected.selectedRecords, {
    segmentWeekday: false,
    segmentTimeBucket: false,
    segmentRegime: false,
    includeSegmentations: false,
  });
  const contextTable = Array.isArray(aggregated.mechanicsVariantTable)
    ? aggregated.mechanicsVariantTable
    : [];
  const contextRanking = rank(contextTable, { minTradesPerMode: minSampleSize });
  const contextRecommendation = recommend(contextTable, contextRanking, { minTradesPerMode: minSampleSize });
  const recommendedMode = toText(contextRecommendation.recommendedTpMode);
  const recommendedRow = contextTable.find((row) => toText(row.tpMode) === recommendedMode) || null;

  const confidence = buildConfidenceScore({
    selectedTable: contextTable,
    globalTable: input?.globalSummary?.mechanicsVariantTable || [],
    recommendedMode,
    contextSampleSize: selected.sampleSize,
    minSampleSize,
  });

  const contextLabel = formatContextLabel(selected.contextUsed);
  const fallbackPhrase = selected.fallbackLevel === 'exact_context'
    ? ''
    : ` Using ${selected.fallbackLevel.replace(/_/g, ' ')} fallback due to thin exact-context samples.`;
  const recommendationReason = recommendedMode
    ? `Today's session matches ${contextLabel}, where ${recommendedMode} shows the strongest contextual mechanics profile across ${selected.sampleSize} trades.${fallbackPhrase}`
    : `Contextual mechanics recommendation is unavailable for ${contextLabel}.${fallbackPhrase}`;

  return {
    contextUsed: {
      date: context.date,
      time: context.time,
      weekday: selected.contextUsed.weekday || context.weekday || null,
      timeBucket: selected.contextUsed.timeBucket || context.timeBucket || null,
      regime: selected.contextUsed.regime || null,
    },
    fallbackLevel: selected.fallbackLevel,
    sampleSize: selected.sampleSize,
    confidenceScore: confidence.confidenceScore,
    confidenceLabel: confidence.confidenceLabel,
    bestTpModeContext: contextRanking.bestTpModeRecent || contextRanking.bestTpModeByProfitFactor || contextRanking.bestTpModeByWinRate || null,
    bestTpModeContextWinRate: recommendedRow ? toNumber(recommendedRow.winRatePct, null) : null,
    bestTpModeContextPF: recommendedRow ? toNumber(recommendedRow.profitFactor, null) : null,
    contextualRecommendedTpMode: recommendedMode || null,
    contextualRecommendationReason: recommendationReason,
    contextVariantTable: contextTable,
    advisoryOnly: true,
    warnings: [
      ...(Array.isArray(selected.warnings) ? selected.warnings : []),
      ...((contextRanking?.dataQuality?.warnings && Array.isArray(contextRanking.dataQuality.warnings))
        ? contextRanking.dataQuality.warnings
        : []),
    ],
    confidenceComponents: confidence.components,
  };
}

module.exports = {
  resolveTodayContext,
  selectContextualRecords,
  buildContextualMechanicsRecommendation,
};
