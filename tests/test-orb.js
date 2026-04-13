/**
 * McNair Mindset by 3130
 * ORB 3130 Engine Tests
 * 
 * Tests the core strategy logic with synthetic candle data.
 * Run: node tests/test-orb.js
 */

const { findORB, findBreakout, findRetest, findConfirmation, resolveTrade, processSession } = require('../server/engine/orb');
const { calcTPSL, nextPsychAbove, nextPsychBelow, pointsToTicks } = require('../server/engine/psych-levels');
const { calcMetrics } = require('../server/engine/stats');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

function assertClose(a, b, tolerance, testName) {
  assert(Math.abs(a - b) <= tolerance, `${testName} (got ${a}, expected ${b})`);
}

// Helper: create a candle
function candle(time, open, high, low, close, volume = 1000) {
  return { timestamp: `2024-06-03 ${time}`, open, high, low, close, volume };
}

function withDate(candles, date) {
  return candles.map(c => ({ ...c, timestamp: `${date} ${c.timestamp.split(' ')[1]}` }));
}

// ============================================================
console.log('\n═══════════════════════════════════════');
console.log('  McNair Mindset by 3130 — Test Suite');
console.log('═══════════════════════════════════════\n');

// ============================================================
console.log('▸ PSYCH LEVELS');
// ============================================================

assert(nextPsychAbove(22013) === 22025, 'Next psych above 22013 = 22025');
assert(nextPsychAbove(22025) === 22025, 'Next psych above 22025 = 22025 (exact)');
assert(nextPsychAbove(22025.01) === 22050, 'Next psych above 22025.01 = 22050');
assert(nextPsychBelow(22037) === 22025, 'Next psych below 22037 = 22025');
assert(nextPsychBelow(22025) === 22025, 'Next psych below 22025 = 22025 (exact)');
assert(nextPsychBelow(22024.99) === 22000, 'Next psych below 22024.99 = 22000');

// ============================================================
console.log('\n▸ TP/SL CALCULATION');
// ============================================================

// Entry at 22015 LONG
// Next psych above: 22025 (distance: 10 pts = 40 ticks < 110) → skip
// Next: 22050 (distance: 35 pts = 140 ticks ≥ 110) → TP
const tpsl1 = calcTPSL(22015, 'long');
assert(tpsl1.tp.price === 22050, 'LONG from 22015: TP = 22050');
assert(tpsl1.tp.distanceTicks === 140, 'LONG from 22015: TP distance = 140 ticks');
assert(tpsl1.sl.price === 22015 - 35, 'LONG from 22015: SL = 21980 (1:1)');

// Entry at 22040 SHORT
// Next psych below: 22025 (distance: 15 pts = 60 ticks < 110) → skip
// Next: 22000 (distance: 40 pts = 160 ticks ≥ 110) → TP
const tpsl2 = calcTPSL(22040, 'short');
assert(tpsl2.tp.price === 22000, 'SHORT from 22040: TP = 22000');
assert(tpsl2.tp.distanceTicks === 160, 'SHORT from 22040: TP distance = 160 ticks');
assert(tpsl2.sl.price === 22040 + 40, 'SHORT from 22040: SL = 22080 (1:1)');

// Entry exactly on psych level
const tpsl3 = calcTPSL(22050, 'long');
assert(tpsl3.tp.price === 22100, 'LONG from 22050 (exact): TP = 22100 (skip to next+)');
// 22075 is 25pts = 100 ticks < 110, so skip to 22100 which is 50pts = 200 ticks
assert(tpsl3.tp.distanceTicks === 200, 'LONG from 22050: TP distance = 200 ticks');

const LEGACY_OPTS = { longOnly: false, skipMonday: false, maxEntryHour: 24, tpMode: 'default' };

// ============================================================
console.log('\n▸ ORB DETECTION');
// ============================================================

const orbCandles = [
  candle('09:30', 22100, 22120, 22095, 22115),  // ORB candle 1
  candle('09:35', 22115, 22130, 22110, 22125),  // ORB candle 2
  candle('09:40', 22125, 22135, 22105, 22120),  // ORB candle 3
  candle('09:45', 22120, 22140, 22118, 22138),  // Post-ORB
];

const orb = findORB(orbCandles);
assert(orb !== null, 'ORB found');
assert(orb.high === 22135, 'ORB high = 22135 (highest high of 3 ORB candles)');
assert(orb.low === 22095, 'ORB low = 22095 (lowest low of 3 ORB candles)');
assert(orb.candles.length === 3, 'ORB has 3 candles (9:30, 9:35, 9:40)');

// ============================================================
console.log('\n▸ BREAKOUT DETECTION');
// ============================================================

const breakoutCandles = [
  candle('09:45', 22120, 22132, 22118, 22130),  // Close below ORB high (22135) — no break
  candle('09:50', 22130, 22140, 22128, 22138),  // Close above ORB high! → LONG breakout
  candle('09:55', 22138, 22145, 22136, 22142),
];

const breakout = findBreakout(breakoutCandles, { high: 22135, low: 22095 });
assert(breakout !== null, 'Breakout detected');
assert(breakout.direction === 'long', 'Breakout direction = long');
assert(breakout.close === 22138, 'Breakout candle close = 22138');
assert(breakout.time === '2024-06-03 09:50', 'Breakout at 09:50');

// SHORT breakout test
const shortBreakoutCandles = [
  candle('09:45', 22100, 22105, 22092, 22093),  // Close below ORB low (22095) → SHORT
];
const shortBreakout = findBreakout(shortBreakoutCandles, { high: 22135, low: 22095 });
assert(shortBreakout !== null, 'Short breakout detected');
assert(shortBreakout.direction === 'short', 'Short breakout direction');

// ============================================================
console.log('\n▸ RETEST DETECTION');
// ============================================================

// After long breakout above 22135, retest = candle low touches 22135
const retestCandles = [
  candle('09:55', 22138, 22145, 22136, 22142),  // Low 22136 > 22135 — no touch
  candle('10:00', 22142, 22143, 22134, 22140),  // Low 22134 ≤ 22135 — RETEST!
];

const { retest, invalidation } = findRetest(retestCandles, { high: 22135, low: 22095 }, 'long');
assert(retest !== null, 'Retest found');
assert(invalidation === null, 'No invalidation');
assert(retest.time === '2024-06-03 10:00', 'Retest at 10:00');

// ============================================================
console.log('\n▸ INVALIDATION DETECTION');
// ============================================================

// Long setup, but retest candle closes below ORB LOW → invalidation
const invalidCandles = [
  candle('09:55', 22138, 22140, 22090, 22088),  // Close 22088 < ORB low 22095 → INVALID
];

const inv = findRetest(invalidCandles, { high: 22135, low: 22095 }, 'long');
assert(inv.retest === null, 'No retest when invalidated');
assert(inv.invalidation !== null, 'Invalidation detected');
assert(inv.invalidation.new_direction === 'short', 'Flips to short');

// ============================================================
console.log('\n▸ CONFIRMATION DETECTION');
// ============================================================

// After long retest, confirmation = candle closes above breakout candle CLOSE
const confirmCandles = [
  candle('10:05', 22140, 22142, 22137, 22139),  // Close 22139 < breakout close 22140 — no confirm
  candle('10:10', 22139, 22148, 22138, 22145),  // Close 22145 > breakout close 22140 — CONFIRM!
];

const { confirmation, invalidation: confInv } = findConfirmation(
  confirmCandles, 
  { high: 22135, low: 22095 }, 
  { high: 22142, low: 22128, close: 22140 }, 
  'long'
);
assert(confirmation !== null, 'Confirmation found');
assert(confInv === null, 'No invalidation during confirmation');
assert(confirmation.entry_price === 22145, 'Entry price = 22145 (confirmation candle close)');

// ============================================================
console.log('\n▸ TRADE RESOLUTION');
// ============================================================

// LONG trade: entry 22145, TP 22200, SL 22090
const resolutionCandles = [
  candle('10:15', 22145, 22155, 22143, 22152),  // Normal move up
  candle('10:20', 22152, 22165, 22150, 22160),  // Continuing up
  candle('10:25', 22160, 22175, 22158, 22170),  // Getting closer
  candle('10:30', 22170, 22202, 22168, 22198),  // High hits 22202 ≥ TP 22200 → WIN
];

const resolution = resolveTrade(resolutionCandles, 22145, 'long', 22200, 22090);
assert(resolution.result === 'win', 'Trade result = win');
assert(resolution.exit_price === 22200, 'Exit at TP = 22200');
assert(resolution.exit_reason === 'tp', 'Exit reason = tp');

// LOSS scenario
const lossCandles = [
  candle('10:15', 22145, 22148, 22088, 22092),  // Low hits SL 22090 → LOSS
];

const loss = resolveTrade(lossCandles, 22145, 'long', 22200, 22090);
assert(loss.result === 'loss', 'Trade result = loss');
assert(loss.exit_reason === 'sl', 'Exit reason = sl');

// Same candle TP + SL → wick inference determines result
const bothCandles = [
  candle('10:15', 22145, 22205, 22085, 22150),  // Both TP and SL hit, bullish candle
];

const both = resolveTrade(bothCandles, 22145, 'long', 22200, 22090);
// Bullish candle (close 22150 > open 22145) + long = went LOW first → SL hit first → LOSS
assert(both.result === 'loss', 'Both TP+SL bullish candle + long = SL first (loss)');
assert(both.exit_reason === 'sl_wick_inferred', 'Exit reason = sl_wick_inferred');

// Same candle TP + SL on bearish candle → TP first → WIN
const bothBearishCandles = [
  candle('10:15', 22145, 22205, 22085, 22120),  // Both hit, bearish candle (close < open)
];
const bothBearish = resolveTrade(bothBearishCandles, 22145, 'long', 22200, 22090);
// Bearish candle (close 22120 < open 22145) + long = went HIGH first → TP hit first → WIN
assert(bothBearish.result === 'win', 'Both TP+SL bearish candle + long = TP first (win)');
assert(bothBearish.exit_reason === 'tp_wick_inferred', 'Exit reason = tp_wick_inferred');

// Time close scenario
const timeCandles = [
  candle('15:50', 22145, 22155, 22140, 22150),
  candle('15:55', 22150, 22158, 22148, 22155),  // 15:55 → time close
];

const timeClose = resolveTrade(timeCandles, 22145, 'long', 22200, 22090);
assert(timeClose.result === 'win', 'Time close with profit = win');
assert(timeClose.exit_reason === 'time_close', 'Exit reason = time_close');

// ============================================================
console.log('\n▸ FULL SESSION PROCESSING');
// ============================================================

// Complete session: ORB → breakout → retest → confirmation → win
const fullSession = [
  // ORB period (9:30 - 9:45)
  candle('09:30', 22100, 22120, 22095, 22115),
  candle('09:35', 22115, 22130, 22110, 22125),
  candle('09:40', 22125, 22135, 22105, 22120),
  // Post-ORB: ORB high = 22135, ORB low = 22095
  candle('09:45', 22120, 22132, 22118, 22130),  // No breakout (close < 22135)
  candle('09:50', 22130, 22142, 22128, 22138),  // BREAKOUT long (close 22138 > 22135)
  candle('09:55', 22138, 22145, 22136, 22142),  // No retest (low 22136 > 22135)
  candle('10:00', 22142, 22143, 22134, 22140),  // RETEST (low 22134 ≤ 22135)
  candle('10:05', 22140, 22141, 22137, 22139),  // No confirm (close 22139 < breakout high 22142)
  candle('10:10', 22139, 22150, 22138, 22148),  // CONFIRMATION (close 22148 > breakout close 22138)
  // Entry at 22148. TP calc: next psych ≥ 110 ticks:
  //   22150: 2pts = 8 ticks (too close)
  //   22175: 27pts = 108 ticks (too close! < 110)
  //   22200: 52pts = 208 ticks ✓ → TP = 22200
  // SL = 22148 - 52 = 22096
  candle('10:15', 22148, 22160, 22146, 22158),
  candle('10:20', 22158, 22170, 22155, 22168),
  candle('10:25', 22168, 22180, 22165, 22178),
  candle('10:30', 22178, 22190, 22176, 22188),
  candle('10:35', 22188, 22205, 22185, 22198),  // High 22205 ≥ TP 22200 → WIN!
];

const session = processSession(fullSession, LEGACY_OPTS);
assert(session.orb !== null, 'Session: ORB found');
assert(session.orb.high === 22135, 'Session: ORB high = 22135');
assert(session.orb.low === 22095, 'Session: ORB low = 22095');
assert(session.trade !== null, 'Session: Trade generated');
assert(session.trade.direction === 'long', 'Session: Direction = long');
assert(session.trade.entry_price === 22140, 'Session: Entry = 22140');
assert(session.trade.tp_price === 22175, 'Session: TP = 22175');
assertClose(session.trade.sl_price, 22105, 0.01, 'Session: SL ≈ 22105');
assert(session.trade.result === 'win', 'Session: Result = WIN');
assert(session.signals.length >= 1, 'Session: At least 1 signal chain');

// ============================================================
console.log('\n▸ NO-TRADE SESSIONS');
// ============================================================

// Session with no breakout
const noBreakoutSession = [
  candle('09:30', 22100, 22120, 22095, 22115),
  candle('09:35', 22115, 22130, 22110, 22125),
  candle('09:40', 22125, 22135, 22105, 22120),
  // All candles close inside ORB range
  candle('09:45', 22120, 22130, 22098, 22125),
  candle('09:50', 22125, 22132, 22100, 22128),
  candle('09:55', 22128, 22134, 22096, 22130),
  candle('10:00', 22130, 22133, 22097, 22120),
  candle('10:05', 22120, 22134, 22096, 22115),
  candle('10:10', 22115, 22134, 22096, 22125),
  candle('10:15', 22125, 22134, 22096, 22120),
];

const noTrade = processSession(noBreakoutSession, LEGACY_OPTS);
assert(noTrade.trade === null, 'No-breakout session: No trade');
assert(noTrade.no_trade_reason === 'no_breakout', 'No-breakout session: Correct reason');

// ============================================================
console.log('\n▸ FLIP/INVALIDATION SESSION');
// ============================================================

// Long breakout → invalidation (close below ORB low) → flip to short sequence
const flipSession = [
  candle('09:30', 22100, 22120, 22095, 22115),
  candle('09:35', 22115, 22130, 22110, 22125),
  candle('09:40', 22125, 22135, 22105, 22120),
  // ORB: high=22135, low=22095
  candle('09:45', 22120, 22140, 22118, 22138),  // BREAKOUT long (close 22138 > 22135)
  candle('09:50', 22138, 22139, 22088, 22090),  // INVALIDATION (close 22090 < ORB low 22095) → flip to short
  // Now looking for SHORT breakout — but 22090 already closes below ORB low
  // The invalidation candle itself closed below ORB low, so the next scan should pick up a short breakout
  candle('09:55', 22090, 22096, 22080, 22085),  // Continues short, close < ORB low → short breakout
  candle('10:00', 22085, 22098, 22083, 22096),  // RETEST (high 22098 ≥ ORB low 22095)
  candle('10:05', 22096, 22097, 22080, 22082),  // Need confirm: close < short breakout candle low
  // Short breakout candle low depends on which candle is treated as breakout after flip
  // The invalidation candle (09:50) closed at 22090 < ORB low 22095, so it IS the breakout
  // Breakout candle: low=22088, so need close < 22088
  candle('10:10', 22082, 22085, 22075, 22078),  // Close 22078 < 22088? YES if breakout is 09:55 (low=22080) → 22078 < 22080 ✓
  // Actually after invalidation, the system re-runs processSignalChain on remaining candles
  // starting from the invalidation candle. Let me trace through carefully...
  candle('10:15', 22078, 22080, 22060, 22062),
  candle('10:20', 22062, 22065, 22050, 22055),
  candle('10:25', 22055, 22058, 22040, 22042),
  candle('10:30', 22042, 22045, 22030, 22035),
];

const flipResult = processSession(flipSession, LEGACY_OPTS);
assert(flipResult.signals.length >= 2, 'Flip session: Multiple signal chains attempted');
assert(flipResult.signals[0].invalidation !== null, 'Flip session: First signal was invalidated');

// ============================================================
console.log('\n▸ ORB V5 GUARDRAILS');
// ============================================================

const tuesdayFullSession = withDate(fullSession, '2024-06-04');
const v5Trade = processSession(tuesdayFullSession);
assert(v5Trade.trade !== null, 'V5: Tuesday session can produce a trade');
const expectedV5 = calcTPSL(v5Trade.trade.entry_price, 'long', { tpMode: 'skip2', skipLevels: 2 });
assert(v5Trade.trade.tp_price === expectedV5.tp.price, 'V5: TP uses skip2 mode');
assert(v5Trade.trade.sl_price === expectedV5.sl.price, 'V5: SL matches 1:1 distance');
assert(v5Trade.trade.tp_distance_ticks === v5Trade.trade.sl_distance_ticks, 'V5: TP/SL distance is 1:1');

const mondaySkipped = processSession(fullSession); // 2024-06-03 is Monday
assert(mondaySkipped.trade === null, 'V5: Monday produces no trade');
assert(mondaySkipped.no_trade_reason === 'skip_monday', 'V5: Monday skip is enforced');

const shortOnlySession = withDate([
  candle('09:30', 22100, 22120, 22095, 22115),
  candle('09:35', 22115, 22130, 22110, 22125),
  candle('09:40', 22125, 22135, 22105, 22120),
  candle('09:45', 22120, 22122, 22090, 22092), // short breakout close < ORB low
  candle('09:50', 22092, 22098, 22088, 22090),
  candle('09:55', 22090, 22096, 22084, 22086),
  candle('10:00', 22086, 22093, 22080, 22082),
], '2024-06-04');
const v5ShortBlocked = processSession(shortOnlySession);
assert(v5ShortBlocked.trade === null, 'V5: short-only breakout is blocked');
assert(v5ShortBlocked.no_trade_reason === 'no_breakout', 'V5: longOnly skips short breakout');
const legacyShortAllowed = processSession(shortOnlySession, LEGACY_OPTS);
assert(legacyShortAllowed.trade !== null && legacyShortAllowed.trade.direction === 'short', 'Legacy opts: short breakout can trade');

const lateConfirmationSession = withDate([
  candle('09:30', 22100, 22120, 22095, 22115),
  candle('09:35', 22115, 22130, 22110, 22125),
  candle('09:40', 22125, 22135, 22105, 22120),
  candle('09:45', 22120, 22142, 22118, 22138), // long breakout
  candle('10:50', 22138, 22139, 22134, 22136), // retest
  candle('11:00', 22136, 22146, 22135, 22145), // confirm after max entry hour
], '2024-06-04');
const lateCutoff = processSession(lateConfirmationSession);
assert(lateCutoff.trade === null, 'V5: no trade after max entry hour');
assert(lateCutoff.no_trade_reason === 'entry_after_max_hour', 'V5: maxEntryHour=11 is enforced');

// ============================================================
console.log('\n▸ STATS ENGINE');
// ============================================================

const mockTrades = [
  { result: 'win', pnl_ticks: 140, pnl_dollars: 65.50, direction: 'long' },
  { result: 'win', pnl_ticks: 140, pnl_dollars: 65.50, direction: 'long' },
  { result: 'loss', pnl_ticks: -140, pnl_dollars: -74.50, direction: 'short' },
  { result: 'win', pnl_ticks: 160, pnl_dollars: 75.50, direction: 'long' },
  { result: 'loss', pnl_ticks: -140, pnl_dollars: -74.50, direction: 'short' },
  { result: 'win', pnl_ticks: 140, pnl_dollars: 65.50, direction: 'long' },
  { result: 'win', pnl_ticks: 200, pnl_dollars: 95.50, direction: 'short' },
  { result: 'loss', pnl_ticks: -160, pnl_dollars: -84.50, direction: 'long' },
  { result: 'win', pnl_ticks: 140, pnl_dollars: 65.50, direction: 'long' },
  { result: 'loss', pnl_ticks: -140, pnl_dollars: -74.50, direction: 'short' },
];

const metrics = calcMetrics(mockTrades);
assert(metrics.totalTrades === 10, 'Stats: 10 total trades');
assert(metrics.wins === 6, 'Stats: 6 wins');
assert(metrics.losses === 4, 'Stats: 4 losses');
assert(metrics.winRate === 60, 'Stats: 60% win rate');
assert(metrics.profitFactor > 1.0, 'Stats: PF > 1.0 (profitable)');
assert(metrics.maxConsecWins === 2, 'Stats: Max consecutive wins = 2');
assert(metrics.totalPnlDollars > 0, 'Stats: Positive total P&L');

// ============================================================
// SUMMARY
// ============================================================

console.log('\n═══════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════');

if (failed > 0) {
  console.log('\n⚠️  Some tests failed. Fix before deploying.\n');
  process.exit(1);
} else {
  console.log('\n🔥 All tests passed. ORB 3130 engine is solid.\n');
  process.exit(0);
}
