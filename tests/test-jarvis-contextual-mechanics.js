#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  resolveTodayContext,
  selectContextualRecords,
  buildContextualMechanicsRecommendation,
} = require('../server/jarvis-core/contextual-mechanics');
const {
  aggregateMechanicsVariants,
  rankMechanicsModes,
  buildMechanicsRecommendation,
} = require('../server/jarvis-core/mechanics-research');

function mkVariantRows({ tradeKey, date, weekday, timeBucket, regime, nearest, skip1, skip2 }) {
  return [
    {
      tradeKey,
      date,
      weekday,
      timeBucket,
      regime,
      tpMode: 'Nearest',
      stopMode: 'rr_1_to_1_from_tp',
      outcome: nearest >= 0 ? 'win' : 'loss',
      pnlTicks: nearest,
      pnlDollars: (nearest * 0.5) - 4.5,
      mfe: Math.max(8, Math.abs(nearest) + 6),
      mae: Math.max(6, Math.abs(nearest) - 2),
    },
    {
      tradeKey,
      date,
      weekday,
      timeBucket,
      regime,
      tpMode: 'Skip 1',
      stopMode: 'rr_1_to_1_from_tp',
      outcome: skip1 >= 0 ? 'win' : 'loss',
      pnlTicks: skip1,
      pnlDollars: (skip1 * 0.5) - 4.5,
      mfe: Math.max(8, Math.abs(skip1) + 5),
      mae: Math.max(6, Math.abs(skip1) - 2),
    },
    {
      tradeKey,
      date,
      weekday,
      timeBucket,
      regime,
      tpMode: 'Skip 2',
      stopMode: 'rr_1_to_1_from_tp',
      outcome: skip2 >= 0 ? 'win' : 'loss',
      pnlTicks: skip2,
      pnlDollars: (skip2 * 0.5) - 4.5,
      mfe: Math.max(8, Math.abs(skip2) + 4),
      mae: Math.max(6, Math.abs(skip2) - 1),
    },
  ];
}

function makeFixtureRecords() {
  const rows = [];
  let idx = 0;

  const pushTrades = ({ count, weekday, timeBucket, regime, nearestFn, skip1Fn, skip2Fn }) => {
    for (let i = 0; i < count; i += 1) {
      idx += 1;
      const tradeKey = `t-${idx}`;
      const date = `2026-03-${String((idx % 28) + 1).padStart(2, '0')}`;
      rows.push(...mkVariantRows({
        tradeKey,
        date,
        weekday,
        timeBucket,
        regime,
        nearest: nearestFn(i),
        skip1: skip1Fn(i),
        skip2: skip2Fn(i),
      }));
    }
  };

  // Tuesday orb_window: exact regime-wide is thin (6), weekday+time is healthy (20 total)
  pushTrades({
    count: 6,
    weekday: 'Tuesday',
    timeBucket: 'orb_window',
    regime: 'wide_range',
    nearestFn: () => 22,
    skip1Fn: () => 12,
    skip2Fn: () => 6,
  });
  pushTrades({
    count: 14,
    weekday: 'Tuesday',
    timeBucket: 'orb_window',
    regime: 'normal',
    nearestFn: () => 14,
    skip1Fn: () => 11,
    skip2Fn: () => 9,
  });

  // Other weekdays with same time bucket to support fallback checks
  pushTrades({
    count: 18,
    weekday: 'Wednesday',
    timeBucket: 'orb_window',
    regime: 'normal',
    nearestFn: (i) => (i % 3 === 0 ? -8 : 10),
    skip1Fn: (i) => (i % 4 === 0 ? -10 : 11),
    skip2Fn: (i) => (i % 2 === 0 ? 18 : -13),
  });

  // late window and other context
  pushTrades({
    count: 16,
    weekday: 'Tuesday',
    timeBucket: 'late_window',
    regime: 'normal',
    nearestFn: (i) => (i % 2 === 0 ? -6 : 9),
    skip1Fn: () => 12,
    skip2Fn: () => 14,
  });

  return rows;
}

function run() {
  const records = makeFixtureRecords();
  assert(records.length > 0, 'fixture records must not be empty');

  const context = resolveTodayContext({
    nowEt: { date: '2026-03-10', time: '09:37' },
    regimeByDate: {
      '2026-03-10': { regime: 'wide_range' },
    },
  });
  assert(context.weekday === 'Tuesday', 'weekday detection mismatch');
  assert(context.timeBucket === 'orb_window', 'time-bucket detection mismatch');
  assert(context.regime === 'wide_range', 'regime detection mismatch');

  const selected = selectContextualRecords(records, context, { minSampleSize: 15 });
  assert(selected.fallbackLevel === 'drop_regime', 'expected fallback to drop_regime for thin exact context');
  assert(selected.sampleSize >= 15, 'fallback subset should satisfy minimum sample');
  assert(selected.contextUsed.weekday === 'Tuesday' && selected.contextUsed.timeBucket === 'orb_window', 'fallback context should keep weekday + time bucket');

  const veryThinContext = {
    date: '2026-03-10',
    time: '09:50',
    weekday: 'Friday',
    timeBucket: 'post_orb',
    regime: 'wide_range',
  };
  const selectedGlobal = selectContextualRecords(records, veryThinContext, { minSampleSize: 15 });
  assert(selectedGlobal.fallbackLevel === 'global', 'expected global fallback for very thin context');

  const globalAgg = aggregateMechanicsVariants(records, {
    segmentWeekday: true,
    segmentTimeBucket: true,
    segmentRegime: false,
    includeSegmentations: true,
  });
  const globalRanking = rankMechanicsModes(globalAgg.mechanicsVariantTable, { minTradesPerMode: 15 });
  const globalRec = buildMechanicsRecommendation(globalAgg.mechanicsVariantTable, globalRanking, { minTradesPerMode: 15 });

  const contextual = buildContextualMechanicsRecommendation({
    records,
    nowEt: { date: '2026-03-10', time: '09:38' },
    regimeByDate: {
      '2026-03-10': { regime: 'wide_range' },
    },
    minSampleSize: 15,
    globalSummary: {
      mechanicsVariantTable: globalAgg.mechanicsVariantTable,
      recommendedTpMode: globalRec.recommendedTpMode,
      bestTpModeRecent: globalRanking.bestTpModeRecent,
      bestTpModeByWinRate: globalRanking.bestTpModeByWinRate,
      bestTpModeByProfitFactor: globalRanking.bestTpModeByProfitFactor,
    },
    deps: {
      aggregateMechanicsVariants,
      rankMechanicsModes,
      buildMechanicsRecommendation,
    },
  });

  assert(contextual && typeof contextual === 'object', 'contextual recommendation missing');
  assert(['exact_context', 'drop_regime', 'time_bucket_only', 'global'].includes(contextual.fallbackLevel), 'invalid contextual fallback level');
  assert(Number(contextual.sampleSize || 0) > 0, 'contextual sample size should be positive');
  assert(Number(contextual.confidenceScore || -1) >= 0 && Number(contextual.confidenceScore || 101) <= 100, 'confidence score should be 0..100');
  assert(['high', 'medium', 'low'].includes(String(contextual.confidenceLabel || '')), 'confidence label missing');
  assert(typeof contextual.contextualRecommendedTpMode === 'string' && contextual.contextualRecommendedTpMode.length > 0, 'contextual recommended TP mode missing');
  assert(Array.isArray(contextual.contextVariantTable) && contextual.contextVariantTable.length === 3, 'context variant table should include 3 TP modes');
  assert(/today|session|context/i.test(String(contextual.contextualRecommendationReason || '')), 'contextual recommendation reason should be explanatory');

  console.log('All jarvis contextual mechanics tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`Jarvis contextual mechanics test failed: ${err.message}`);
  process.exit(1);
}
