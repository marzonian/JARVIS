'use strict';
/**
 * Tests the baseline guard in chooseRecommendedStrategy.
 *
 * Rule: a non-original strategy can only displace the original plan if it
 *   (1) has at least BASELINE_GUARD_MIN_TRADES backtested trades, AND
 *   (2) nets strictly higher total dollar P&L than original.
 *
 * These tests pin the regression fix for the 78-session evidence window where
 * variant_nearest_tp had higher WR/PF composite but net-lower dollar P&L
 * ($392 vs original $1,019), and was incorrectly being recommended on 17
 * historical backfill dates. Net cost of that bug: ~$241 over 78 sessions.
 */

const assert = require('assert');
const {
  chooseRecommendedStrategy,
  baselineGuardEvaluation,
  BASELINE_GUARD_MIN_TRADES,
  BASELINE_GUARD_MIN_PNL_MARGIN_DOLLARS,
} = require('../server/jarvis-core/strategy-layers.js');

const original = {
  key: 'original_plan_orb_3130',
  layer: 'original',
  name: 'Original Trading Plan',
  score: 70,
  metrics: { winRate: 69.6, profitFactor: 2.1, totalTrades: 23, totalPnlDollars: 1019.5 },
};

function run() {
  // --- Case 1: variant has higher WR/PF but LOWER dollar P&L ----------------
  // This is the real regression — variant_nearest_tp.
  const lowerDollarVariant = {
    key: 'variant_nearest_tp',
    layer: 'variant',
    name: 'Nearest TP',
    score: 70,
    metrics: { winRate: 72, profitFactor: 2.3, totalTrades: 23, totalPnlDollars: 392.5 },
  };
  const r1 = chooseRecommendedStrategy({
    original,
    bestVariant: lowerDollarVariant,
    bestDiscovery: null,
  });
  assert.strictEqual(
    r1.strategyKey,
    'original_plan_orb_3130',
    'Variant with lower dollar P&L must NOT displace original'
  );
  assert.strictEqual(r1.baselineGuard.applied, true);
  assert.strictEqual(r1.baselineGuard.enforced, true);
  assert.ok(
    /net|dollar|\$/i.test(r1.baselineGuard.reason),
    `Guard reason should cite dollar shortfall, got: ${r1.baselineGuard.reason}`
  );

  // --- Case 2: variant has strictly higher dollar P&L + enough trades -------
  // Guard must clear and allow the promotion.
  const winnerVariant = {
    key: 'variant_hypothetical_winner',
    layer: 'variant',
    name: 'Hypothetical Winner',
    score: 70,
    metrics: { winRate: 72, profitFactor: 2.3, totalTrades: 30, totalPnlDollars: 1500 },
  };
  const r2 = chooseRecommendedStrategy({
    original,
    bestVariant: winnerVariant,
    bestDiscovery: null,
  });
  assert.strictEqual(
    r2.strategyKey,
    'variant_hypothetical_winner',
    'Variant with higher dollar P&L AND enough trades must be allowed'
  );
  assert.strictEqual(r2.baselineGuard.enforced, false);
  assert.ok(r2.baselineGuard.pnlDeltaVsOriginal > 0);

  // --- Case 3: thin-sample variant (too few trades) -------------------------
  // Even if dollar P&L is higher, reject it without sample-size.
  const thinVariant = {
    key: 'variant_thin_sample',
    layer: 'variant',
    name: 'Thin Sample Hero',
    score: 90,
    metrics: { winRate: 100, profitFactor: 10, totalTrades: 3, totalPnlDollars: 2000 },
  };
  const r3 = chooseRecommendedStrategy({
    original,
    bestVariant: thinVariant,
    bestDiscovery: null,
  });
  assert.strictEqual(
    r3.strategyKey,
    'original_plan_orb_3130',
    'Thin-sample variant must NOT displace original regardless of dollar total'
  );
  assert.ok(
    /trade|sample/i.test(r3.baselineGuard.reason),
    `Guard reason should cite sample size, got: ${r3.baselineGuard.reason}`
  );

  // --- Case 4: discovery layer receives the same treatment ------------------
  const weakDiscovery = {
    key: 'discovery_weak_candidate',
    layer: 'discovery',
    name: 'Discovery Candidate',
    score: 80,
    metrics: { winRate: 75, profitFactor: 2.5, totalTrades: 15, totalPnlDollars: 500 },
  };
  const r4 = chooseRecommendedStrategy({
    original,
    bestVariant: null,
    bestDiscovery: weakDiscovery,
  });
  assert.strictEqual(
    r4.strategyKey,
    'original_plan_orb_3130',
    'Discovery layer must also be guarded — dollar P&L below original'
  );

  // --- Case 5: original wins on raw composite (no guard triggered) ----------
  const beatenVariant = {
    key: 'variant_also_ran',
    layer: 'variant',
    name: 'Also-Ran',
    score: 50,
    metrics: { winRate: 50, profitFactor: 1.2, totalTrades: 20, totalPnlDollars: 100 },
  };
  const r5 = chooseRecommendedStrategy({
    original,
    bestVariant: beatenVariant,
    bestDiscovery: null,
  });
  assert.strictEqual(r5.strategyKey, 'original_plan_orb_3130');
  // baselineGuard may still be populated (applied:false when top already is original)
  assert.strictEqual(r5.baselineGuard.enforced, false);

  // --- Case 6: direct baselineGuardEvaluation unit ---------------------------
  const direct = baselineGuardEvaluation(lowerDollarVariant, original);
  assert.strictEqual(direct.applied, true);
  assert.strictEqual(direct.enforced, true);
  assert.ok(direct.pnlDelta < 0);

  // Guard constants are sane.
  assert.ok(BASELINE_GUARD_MIN_TRADES >= 5, 'Trade threshold must be meaningful');
  assert.ok(BASELINE_GUARD_MIN_PNL_MARGIN_DOLLARS >= 0);

  console.log('All baseline-guard tests passed.');
}

run();
