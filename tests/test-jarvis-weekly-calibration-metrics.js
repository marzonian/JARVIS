#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildWeeklyTraceability,
  computeWeeklySystemAccuracy,
  computeSampleSafePercent,
  deriveWeeklyMetricStatuses,
  formatSampleSafePercent,
} = require('../server/jarvis-core/weekly-calibration-metrics');

function run() {
  // Normal non-empty weekly sample
  const totalsRate = computeSampleSafePercent(2, 3);
  assert.strictEqual(totalsRate.hasSample, true, 'non-empty sample should be sample-backed');
  assert.strictEqual(totalsRate.value, 66.67, '2/3 should be 66.67%');
  assert.strictEqual(totalsRate.display, '66.67%', 'display should include percent for non-empty sample');
  const statuses = deriveWeeklyMetricStatuses({
    totalsTrades: 3,
    goldenTrades: 1,
    orbCoverageDates: 2,
    judged: 1,
  });
  assert.strictEqual(statuses.totalsMetricStatus, 'source_backed');
  assert.strictEqual(statuses.goldenMetricStatus, 'source_backed');
  assert.strictEqual(statuses.filterMetricStatus, 'source_backed');
  assert.strictEqual(statuses.systemAccuracyMetricStatus, 'source_backed');
  const sourcedAccuracy = computeWeeklySystemAccuracy({
    totalsTrades: 3,
    totalsWinRate: 66.67,
    alignmentRateStats: { hasSample: true, value: 75 },
  });
  assert.strictEqual(sourcedAccuracy.score, 71.25, 'system accuracy should blend alignment + win rate when judged sample exists');
  assert.strictEqual(sourcedAccuracy.status, 'source_backed');

  // Empty-set metrics must render as N/A (not 0%)
  const emptyRate = computeSampleSafePercent(0, 0);
  assert.strictEqual(emptyRate.hasSample, false, 'empty sample should be marked unsupported');
  assert.strictEqual(emptyRate.value, null, 'empty sample should not expose numeric percent');
  assert.strictEqual(emptyRate.display, 'N/A', 'empty sample should render N/A');
  assert.strictEqual(formatSampleSafePercent(emptyRate.value), 'N/A', 'formatter should keep N/A semantics');
  const noSampleStatuses = deriveWeeklyMetricStatuses({
    totalsTrades: 0,
    goldenTrades: 0,
    orbCoverageDates: 0,
    judged: 0,
  });
  assert.strictEqual(noSampleStatuses.totalsMetricStatus, 'insufficient_samples');
  assert.strictEqual(noSampleStatuses.goldenMetricStatus, 'suppressed_no_orb_coverage');
  assert.strictEqual(noSampleStatuses.filterMetricStatus, 'no_judged_samples');
  assert.strictEqual(noSampleStatuses.systemAccuracyMetricStatus, 'insufficient_outcome_samples');
  const derivedAccuracy = computeWeeklySystemAccuracy({
    totalsTrades: 3,
    totalsWinRate: 66.67,
    alignmentRateStats: { hasSample: false, value: null },
  });
  assert.strictEqual(derivedAccuracy.score, 66.67, 'without judged alignment sample, system accuracy should fall back to totals win rate');
  assert.strictEqual(derivedAccuracy.status, 'derived_without_filter_alignment_samples');

  // Weekly totals must trace cleanly to counted source rows
  const traceabilityGood = buildWeeklyTraceability({
    feedbackRowsCounted: 5,
    totalsTradeCount: 5,
    filteredTradeEventsCounted: 2,
    judgedFilterDates: 1,
  });
  assert.strictEqual(traceabilityGood.tradeCountConsistent, true, 'traceability should pass when counts match');
  const traceabilityBad = buildWeeklyTraceability({
    feedbackRowsCounted: 4,
    totalsTradeCount: 5,
  });
  assert.strictEqual(traceabilityBad.tradeCountConsistent, false, 'traceability should fail when counts diverge');
}

try {
  run();
  console.log('test-jarvis-weekly-calibration-metrics: PASS');
} catch (err) {
  console.error('test-jarvis-weekly-calibration-metrics: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
