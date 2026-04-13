#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { runTradeMechanicsVariantTool } = require('../server/tools/tradeMechanicsVariantTool');

function candle(ts, open, high, low, close) {
  return { timestamp: ts, open, high, low, close, volume: 1000 };
}

function run() {
  const candles = [
    candle('2026-03-04 09:55', 22090, 22105, 22085, 22100),
    candle('2026-03-04 10:00', 22100, 22108, 22098, 22100),
    candle('2026-03-04 10:05', 22100, 22130, 22095, 22110),
    candle('2026-03-04 10:10', 22110, 22120, 22040, 22060),
    candle('2026-03-04 10:15', 22060, 22080, 22020, 22030),
    candle('2026-03-04 10:20', 22030, 22060, 22000, 22010),
  ];

  const trade = {
    direction: 'long',
    entry_price: 22100,
    entry_time: '2026-03-04 10:00',
  };

  const out = runTradeMechanicsVariantTool({
    candles,
    trade,
    originalPlanEligible: true,
  });

  assert(out && out.ok === true, 'mechanics tool should run for eligible replay');
  assert(Array.isArray(out.data.mechanicsVariants), 'mechanicsVariants missing');
  assert(out.data.mechanicsVariants.length === 3, 'expected 3 TP variants');

  const nearest = out.data.mechanicsVariants.find((v) => v.tpMode === 'Nearest');
  const skip1 = out.data.mechanicsVariants.find((v) => v.tpMode === 'Skip 1');
  const skip2 = out.data.mechanicsVariants.find((v) => v.tpMode === 'Skip 2');

  assert(nearest && skip1 && skip2, 'all TP variants should exist');
  assert(nearest.tpPx < skip1.tpPx && skip1.tpPx < skip2.tpPx, 'TP levels should progress nearest -> skip1 -> skip2');
  assert(nearest.outcome !== skip1.outcome || skip1.outcome !== skip2.outcome, 'variant outcomes should diverge for this path');

  assert(out.data.originalPlanMechanicsVariant && out.data.originalPlanMechanicsVariant.tpMode === 'Skip 2', 'original plan mechanics should be Skip 2');
  assert(out.data.bestMechanicsVariant && typeof out.data.bestMechanicsVariant.tpMode === 'string', 'best mechanics variant missing');
  assert(out.data.mechanicsComparisonSummary && out.data.mechanicsComparisonSummary.comparisonAvailable === true, 'comparison summary missing');

  const ineligible = runTradeMechanicsVariantTool({
    candles,
    trade: null,
    originalPlanEligible: false,
  });
  assert(ineligible.ok === false, 'ineligible mechanics run should return ok=false');
  assert(ineligible.data.available === false, 'ineligible mechanics run should be unavailable');
  assert(Array.isArray(ineligible.data.mechanicsVariants) && ineligible.data.mechanicsVariants.length === 0, 'ineligible run must not return official variants');

  console.log('All jarvis trade mechanics variant tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`Jarvis trade mechanics variant test failed: ${err.message}`);
  process.exit(1);
}
