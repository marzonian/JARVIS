function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeSampleSafePercent(numerator, denominator) {
  const top = Number(numerator);
  const base = Number(denominator);
  if (!Number.isFinite(base) || base <= 0) {
    return {
      value: null,
      display: 'N/A',
      hasSample: false,
      numerator: Number.isFinite(top) ? top : 0,
      denominator: Number.isFinite(base) ? base : 0,
    };
  }
  const safeTop = Number.isFinite(top) ? top : 0;
  const pct = round2((safeTop / base) * 100);
  return {
    value: pct,
    display: `${pct}%`,
    hasSample: true,
    numerator: safeTop,
    denominator: base,
  };
}

function formatSampleSafePercent(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  return `${round2(n)}%`;
}

function deriveWeeklyMetricStatuses(input = {}) {
  const totalsTrades = Number(input.totalsTrades || 0);
  const goldenTrades = Number(input.goldenTrades || 0);
  const orbCoverageDates = Number(input.orbCoverageDates || 0);
  const judged = Number(input.judged || 0);
  return {
    totalsMetricStatus: totalsTrades > 0 ? 'source_backed' : 'insufficient_samples',
    goldenMetricStatus: orbCoverageDates <= 0
      ? 'suppressed_no_orb_coverage'
      : goldenTrades > 0
        ? 'source_backed'
        : 'no_golden_zone_samples',
    filterMetricStatus: judged > 0 ? 'source_backed' : 'no_judged_samples',
    systemAccuracyMetricStatus: totalsTrades <= 0
      ? 'insufficient_outcome_samples'
      : judged > 0
        ? 'source_backed'
        : 'derived_without_filter_alignment_samples',
  };
}

function buildWeeklyTraceability(input = {}) {
  const feedbackRowsCounted = Number(input.feedbackRowsCounted || 0);
  const totalsTradeCount = Number(input.totalsTradeCount || 0);
  return {
    feedbackRowsCounted,
    totalsTradeCount,
    tradeCountConsistent: feedbackRowsCounted === totalsTradeCount,
    filteredTradeEventsCounted: Number(input.filteredTradeEventsCounted || 0),
    judgedFilterDates: Number(input.judgedFilterDates || 0),
  };
}

function computeWeeklySystemAccuracy(input = {}) {
  const totalsTrades = Number(input.totalsTrades || 0);
  const totalsWinRate = Number(input.totalsWinRate);
  const alignmentRateStats = input.alignmentRateStats && typeof input.alignmentRateStats === 'object'
    ? input.alignmentRateStats
    : { hasSample: false, value: null };
  if (totalsTrades <= 0 || !Number.isFinite(totalsWinRate)) {
    return {
      score: null,
      status: 'insufficient_outcome_samples',
    };
  }
  const hasAlignmentSample = alignmentRateStats.hasSample === true && Number.isFinite(Number(alignmentRateStats.value));
  const raw = hasAlignmentSample
    ? round2((Number(alignmentRateStats.value) * 0.55) + (totalsWinRate * 0.45))
    : round2(totalsWinRate);
  return {
    score: round2(clamp(Number(raw), 0, 100)),
    status: hasAlignmentSample
      ? 'source_backed'
      : 'derived_without_filter_alignment_samples',
  };
}

module.exports = {
  buildWeeklyTraceability,
  computeWeeklySystemAccuracy,
  computeSampleSafePercent,
  deriveWeeklyMetricStatuses,
  formatSampleSafePercent,
};
