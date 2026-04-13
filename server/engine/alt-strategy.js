/**
 * McNair Mindset by 3130
 * Alt Strategy Engine — "Closer TP" variant
 * 
 * Rebuilds the entire trade set using the next-closer psych level as TP.
 * For losses that flip → becomes a win at smaller target
 * For wins that hit full target → reduces P&L to closer level
 * For losses that don't flip → stays the same
 * 
 * Then runs ALL stats on the new trade set so every module can show both.
 */

const { runTPSensitivity, candidateLevels } = require('./tp-analysis');
const { 
  calcMetrics, calcEquityCurve, calcDrawdown, 
  calcSharpe, calcSortino, monteCarlo,
  monthlyBreakdown, dayOfWeekBreakdown,
  calcRolling, detectDecay,
} = require('./stats');

/**
 * Build the alt-strategy trade set using closer TP levels.
 * 
 * @param {Array} originalTrades - Trades from the original backtest
 * @param {Object} sessionCandles - { 'YYYY-MM-DD': [candles], ... }
 * @returns {Object} Full alt-strategy results with all metrics
 */
function buildAltStrategy(originalTrades, sessionCandles, options = {}) {
  const {
    startingBalance = 50000,
    topstepMaxDD = 2000,
    topstepTarget = 3000,
    monteCarloSims = 10000,
  } = options;

  // Run TP sensitivity to get per-trade analysis
  const tpAnalysis = runTPSensitivity(originalTrades, sessionCandles);
  const tpByDate = {};
  for (const detail of tpAnalysis.trade_details) {
    tpByDate[detail.date] = detail;
  }

  // Rebuild each trade with closer TP
  const altTrades = [];
  const changes = []; // Track what changed for transparency

  for (const trade of originalTrades) {
    const tp = tpByDate[trade.date];
    const altTrade = { ...trade };

    if (!tp || !tp.closer_level) {
      // No closer level available — keep as-is
      altTrades.push(altTrade);
      changes.push({
        date: trade.date,
        change: 'none',
        reason: 'no_closer_level',
      });
      continue;
    }

    const closerLevel = tp.closer_level;
    const closerTP = closerLevel.level;
    const closerDistTicks = closerLevel.distance_ticks;

    if (trade.result === 'loss' && closerLevel.would_hit) {
      // FLIP: Loss becomes win at closer level
      const winTicks = closerDistTicks - 2; // subtract 2 slippage ticks (matching orb.js)
      const winDollars = (winTicks * 0.50) - 4.50; // $0.50/tick - commission

      // Guard: if P&L is negative after costs, this isn't really a win
      if (winDollars <= 0) {
        altTrade._alt_change = 'unchanged';
        changes.push({
          date: trade.date,
          change: 'unchanged',
          reason: 'closer_tp_negative_after_costs',
        });
        altTrades.push(altTrade);
        continue;
      }

      altTrade.result = 'win';
      altTrade.exit_reason = 'tp_hit';
      altTrade.tp_price = closerTP;
      altTrade.exit_price = closerTP;
      altTrade.pnl_ticks = winTicks;
      altTrade.pnl_dollars = winDollars;
      altTrade._alt_change = 'flipped';
      altTrade._original_result = 'loss';
      altTrade._original_pnl = trade.pnl_dollars;

      changes.push({
        date: trade.date,
        change: 'flipped',
        direction: trade.direction,
        entry: trade.entry_price,
        original_tp: trade.tp_price,
        new_tp: closerTP,
        original_pnl: trade.pnl_dollars,
        new_pnl: winDollars,
        impact: winDollars - trade.pnl_dollars,
      });
    } else if (trade.result === 'win') {
      // WIN stays win, but with smaller target
      const winTicks = closerDistTicks - 2; // subtract 2 slippage ticks
      const winDollars = (winTicks * 0.50) - 4.50;

      // Only reduce if closer level is actually closer AND still profitable
      if (winDollars > 0 && winDollars < trade.pnl_dollars) {
        altTrade.tp_price = closerTP;
        altTrade.exit_price = closerTP;
        altTrade.pnl_ticks = winTicks;
        altTrade.pnl_dollars = winDollars;
        altTrade._alt_change = 'reduced';
        altTrade._original_pnl = trade.pnl_dollars;

        changes.push({
          date: trade.date,
          change: 'reduced',
          direction: trade.direction,
          entry: trade.entry_price,
          original_tp: trade.tp_price,
          new_tp: closerTP,
          original_pnl: trade.pnl_dollars,
          new_pnl: winDollars,
          impact: winDollars - trade.pnl_dollars,
        });
      } else {
        // Closer level is actually farther (edge case) — keep original
        changes.push({
          date: trade.date,
          change: 'none',
          reason: 'closer_not_better',
        });
      }
    } else {
      // Loss that doesn't flip — keep as-is
      altTrade._alt_change = 'unchanged';
      changes.push({
        date: trade.date,
        change: 'unchanged',
        reason: 'loss_no_flip',
      });
    }

    altTrades.push(altTrade);
  }

  // Run ALL stats on the alt trade set
  const metrics = calcMetrics(altTrades);
  const equityCurve = calcEquityCurve(altTrades, startingBalance);
  const drawdown = calcDrawdown(altTrades, startingBalance);
  const sharpe = calcSharpe(altTrades);
  const sortino = calcSortino(altTrades);
  const monthly = monthlyBreakdown(altTrades);
  const dayOfWeek = dayOfWeekBreakdown(altTrades);
  const rolling = calcRolling(altTrades, 30);
  const decay = detectDecay(altTrades, 30);

  // Monte Carlo
  const mc = monteCarlo(altTrades, monteCarloSims, {
    balance: startingBalance,
    maxDrawdown: topstepMaxDD,
    payoutTarget: topstepTarget,
  });

  // Direction breakdown
  const longTrades = altTrades.filter(t => t.direction === 'long');
  const shortTrades = altTrades.filter(t => t.direction === 'short');

  // Exit reasons
  const exitReasons = {};
  for (const t of altTrades) {
    exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
  }

  // Change summary
  const flipped = changes.filter(c => c.change === 'flipped');
  const reduced = changes.filter(c => c.change === 'reduced');
  const totalFlipImpact = flipped.reduce((s, c) => s + (c.impact || 0), 0);
  const totalReduceImpact = reduced.reduce((s, c) => s + (c.impact || 0), 0);

  return {
    strategy: 'ORB 3130 — Closer TP',
    description: 'Uses next-closer psych level as TP target for all trades',
    metrics,
    drawdown,
    sharpe,
    sortino,
    monteCarlo: mc,
    equityCurve,
    monthly,
    dayOfWeek,
    rolling,
    decay,
    directionBreakdown: {
      long: calcMetrics(longTrades),
      short: calcMetrics(shortTrades),
    },
    exitReasons,
    trades: altTrades,
    changeSummary: {
      totalTrades: altTrades.length,
      flipped: flipped.length,
      reduced: reduced.length,
      unchanged: changes.filter(c => c.change === 'unchanged' || c.change === 'none').length,
      flipImpact: Math.round(totalFlipImpact * 100) / 100,
      reduceImpact: Math.round(totalReduceImpact * 100) / 100,
      netImpact: Math.round((totalFlipImpact + totalReduceImpact) * 100) / 100,
    },
    changes, // Full per-trade change log
  };
}

module.exports = { buildAltStrategy };
