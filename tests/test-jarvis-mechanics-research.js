#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildMechanicsResearchSummary,
  rankMechanicsModes,
} = require('../server/jarvis-core/mechanics-research');

function makeIsoDate(offsetDays) {
  const base = new Date(Date.UTC(2026, 0, 5, 12, 0, 0)); // 2026-01-05
  base.setUTCDate(base.getUTCDate() + Number(offsetDays || 0));
  return base.toISOString().slice(0, 10);
}

function makeSessions(count = 18) {
  const sessions = {};
  for (let i = 0; i < count; i += 1) {
    const date = makeIsoDate(i);
    sessions[date] = [
      {
        timestamp: `${date} 09:30:00`,
        date,
        time: '09:30:00',
        open: 22000 + i,
        high: 22010 + i,
        low: 21990 + i,
        close: 22005 + i,
        volume: 1000,
      },
    ];
  }
  return sessions;
}

function buildFakeProcessSession() {
  return (candles = [], options = {}) => {
    assert(options.longOnly === true, 'original-plan eligibility must keep longOnly=true');
    assert(options.skipMonday === false, 'original-plan eligibility must not skip Mondays');
    assert(Number(options.maxEntryHour) === 11, 'original-plan eligibility must keep maxEntryHour=11');
    assert(String(options.tpMode || '').toLowerCase() === 'skip2', 'original-plan eligibility must keep baseline tpMode=skip2');
    const date = String(candles?.[0]?.date || '').slice(0, 10);
    return {
      trade: {
        direction: 'long',
        entry_price: 22000,
        entry_time: `${date} 09:55:00`,
      },
    };
  };
}

function buildFakeMechanicsRunner(dateToIndex = {}) {
  return ({ trade }) => {
    const date = String(trade?.entry_time || '').slice(0, 10);
    const idx = Number(dateToIndex[date] || 0);

    const nearestLoss = idx % 3 === 0;
    const skip1Loss = idx % 2 === 1;
    const skip2Win = idx % 3 === 0;

    const variants = [
      {
        tpMode: 'Nearest',
        stopMode: 'rr_1_to_1_from_tp',
        outcome: nearestLoss ? 'loss' : 'win',
        pnlTicks: nearestLoss ? -20 : 8,
        pnlDollars: nearestLoss ? -14.5 : -0.5,
        mfe: nearestLoss ? 10 : 32,
        mae: nearestLoss ? 28 : 8,
      },
      {
        tpMode: 'Skip 1',
        stopMode: 'rr_1_to_1_from_tp',
        outcome: skip1Loss ? 'loss' : 'win',
        pnlTicks: skip1Loss ? -12 : 12,
        pnlDollars: skip1Loss ? -10.5 : 1.5,
        mfe: skip1Loss ? 18 : 24,
        mae: skip1Loss ? 21 : 10,
      },
      {
        tpMode: 'Skip 2',
        stopMode: 'rr_1_to_1_from_tp',
        outcome: skip2Win ? 'win' : 'loss',
        pnlTicks: skip2Win ? 40 : -10,
        pnlDollars: skip2Win ? 15.5 : -9.5,
        mfe: skip2Win ? 55 : 20,
        mae: skip2Win ? 12 : 22,
      },
    ];

    return {
      ok: true,
      data: {
        mechanicsVariants: variants,
      },
    };
  };
}

function assertModeTableConsistency(table = []) {
  assert(Array.isArray(table), 'mechanicsVariantTable must be an array');
  assert(table.length === 3, 'mechanicsVariantTable must contain all 3 TP modes');
  for (const row of table) {
    const tradeCount = Number(row.tradeCount || 0);
    const totalOutcomes = Number(row.winCount || 0)
      + Number(row.lossCount || 0)
      + Number(row.breakevenCount || 0)
      + Number(row.openCount || 0);
    assert(tradeCount === totalOutcomes, `outcome counts must sum to tradeCount for ${row.tpMode}`);
  }
}

function run() {
  const sessions = makeSessions(18);
  const dateToIndex = {};
  Object.keys(sessions).sort().forEach((date, idx) => {
    dateToIndex[date] = idx;
  });

  const summary = buildMechanicsResearchSummary({
    sessions,
    windowTrades: 120,
    segmentWeekday: true,
    segmentTimeBucket: true,
    segmentRegime: false,
    deps: {
      processSession: buildFakeProcessSession(),
      runTradeMechanicsVariantTool: buildFakeMechanicsRunner(dateToIndex),
    },
  });

  assert(summary && typeof summary === 'object', 'summary must be returned');
  assert(summary.windowMode === 'eligible_trades', 'windowMode must be eligible_trades');
  assert(summary.windowSize === 120, 'windowSize should respect requested value');
  assert(summary.eligibleTradeCount === 18, 'eligible trade count mismatch');
  assert(summary.evaluatedTradeCount === 18, 'evaluated trade count mismatch');
  assert.deepStrictEqual(summary.supportedTpModes, ['Nearest', 'Skip 1', 'Skip 2'], 'supported TP modes mismatch');
  assert.deepStrictEqual(summary.supportedStopFamilies, ['rr_1_to_1_from_tp'], 'supported stop families mismatch');
  assert(Array.isArray(summary.unsupportedStopFamilies) && summary.unsupportedStopFamilies.includes('structure_stop'), 'unsupported stop families missing');
  assert(summary.originalPlanTpMode === 'Skip 2', 'originalPlanTpMode must be Skip 2 baseline');
  assert(summary.originalPlanStopMode === 'rr_1_to_1_from_tp', 'originalPlanStopMode baseline mismatch');
  assert(summary.advisoryOnly === true, 'mechanics research must be advisory-only');

  assertModeTableConsistency(summary.mechanicsVariantTable);

  assert(summary.bestTpModeByWinRate === 'Nearest', 'win-rate leader mismatch');
  assert(summary.bestTpModeByProfitFactor === 'Skip 2', 'profit-factor leader mismatch');
  assert(summary.bestTpModeRecent === 'Skip 2', 'recent leader should favor PF-first score');
  assert(summary.recommendedTpMode === 'Skip 2', 'practical recommendation should prefer PF in this fixture');
  assert(summary.recommendationBasis === 'profit_factor_priority', 'recommendation basis mismatch');
  assert(/profit factor/i.test(String(summary.recommendedTpModeReason || '')), 'recommendation reason should reference PF priority');
  assert(summary.dataQuality && summary.dataQuality.isThinSample === false, 'sample should not be thin for 18 trades/mode');
  assert(summary.contextualRecommendation && typeof summary.contextualRecommendation === 'object', 'contextual recommendation should be present');
  assert(['exact_context', 'drop_regime', 'time_bucket_only', 'global'].includes(String(summary.contextualRecommendation.fallbackLevel || '')), 'contextual fallback level invalid');
  assert(typeof summary.contextualRecommendation.contextualRecommendedTpMode === 'string' && summary.contextualRecommendation.contextualRecommendedTpMode.length > 0, 'contextual recommended tp mode missing');
  assert(['high', 'medium', 'low'].includes(String(summary.contextualRecommendation.confidenceLabel || '')), 'contextual confidence label missing');

  assert(summary.segmentations && summary.segmentations.weekday && summary.segmentations.weekday.available === true, 'weekday segmentation should be available');
  assert(summary.segmentations && summary.segmentations.timeBucket && summary.segmentations.timeBucket.available === true, 'time-bucket segmentation should be available');
  assert(summary.segmentations && summary.segmentations.regime && summary.segmentations.regime.available === false, 'regime segmentation should be unavailable without mapping');

  const ranking = rankMechanicsModes(summary.mechanicsVariantTable, { minTradesPerMode: 15 });
  assert(ranking.bestTpModeByWinRate === 'Nearest', 'ranking win-rate leader mismatch');
  assert(ranking.bestTpModeByProfitFactor === 'Skip 2', 'ranking PF leader mismatch');

  const thinSampleSummary = buildMechanicsResearchSummary({
    sessions: makeSessions(6),
    windowTrades: 120,
    segmentWeekday: true,
    segmentTimeBucket: true,
    deps: {
      processSession: buildFakeProcessSession(),
      runTradeMechanicsVariantTool: buildFakeMechanicsRunner(dateToIndex),
    },
  });
  assert(thinSampleSummary.dataQuality && thinSampleSummary.dataQuality.isThinSample === true, 'thin sample should be flagged when trade counts are low');
  assert(
    Array.isArray(thinSampleSummary.dataQuality.warnings)
      && thinSampleSummary.dataQuality.warnings.some((w) => /thin-sample/i.test(String(w))),
    'thin sample warnings should be surfaced'
  );
  assert(thinSampleSummary.recommendationBasis === 'thin_sample_guard', 'thin sample should use conservative recommendation basis');

  console.log('All jarvis mechanics research tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`Jarvis mechanics research test failed: ${err.message}`);
  process.exit(1);
}
