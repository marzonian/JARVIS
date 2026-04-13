/**
 * McNair Mindset by 3130
 * Backtesting Engine
 * 
 * Runs the ORB 3130 strategy across historical session data.
 * Produces complete performance report with all metrics.
 */

const { processSession } = require('./orb');
const { 
  calcMetrics, calcEquityCurve, calcDrawdown, 
  calcSharpe, calcSortino, monteCarlo,
  monthlyBreakdown, dayOfWeekBreakdown,
  calcRolling, detectDecay,
} = require('./stats');

// ============================================================
// BACKTEST RUNNER
// ============================================================

/**
 * Run the ORB 3130 strategy across all provided sessions.
 * 
 * @param {Object} sessions - { 'YYYY-MM-DD': [candles], ... }
 * @param {Object} options - Configuration overrides
 * @returns {Object} Complete backtest results
 */
function runBacktest(sessions, options = {}) {
  const {
    startDate = null,    // Filter: only sessions on/after this date
    endDate = null,      // Filter: only sessions on/before this date
    startingBalance = 50000,
    topstepMaxDD = 2000,
    topstepTarget = 3000,
    monteCarloSims = 10000,
  } = options;

  const dates = Object.keys(sessions).sort();
  const filteredDates = dates.filter(d => {
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  });

  // Process each session
  const sessionResults = [];
  const trades = [];
  const noTradeReasons = {};

  for (const date of filteredDates) {
    const candles = sessions[date];
    const result = processSession(candles);
    result.date = date;
    sessionResults.push(result);

    if (result.trade) {
      result.trade.date = date;
      trades.push(result.trade);
    } else {
      const reason = result.no_trade_reason || 'unknown';
      noTradeReasons[reason] = (noTradeReasons[reason] || 0) + 1;
    }
  }

  // Calculate all metrics
  const metrics = calcMetrics(trades);
  const equityCurve = calcEquityCurve(trades, startingBalance);
  const drawdown = calcDrawdown(trades, startingBalance);
  const sharpe = calcSharpe(trades);
  const sortino = calcSortino(trades);
  const monthly = monthlyBreakdown(trades);
  const dayOfWeek = dayOfWeekBreakdown(trades);
  const rolling = calcRolling(trades, 30);
  const decay = detectDecay(trades, 30);

  // Monte Carlo — Topstep specific
  const mc = monteCarlo(trades, monteCarloSims, {
    balance: startingBalance,
    maxDrawdown: topstepMaxDD,
    payoutTarget: topstepTarget,
  });

  // Direction breakdown
  const longTrades = trades.filter(t => t.direction === 'long');
  const shortTrades = trades.filter(t => t.direction === 'short');

  // Trade distribution
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
  }

  return {
    summary: {
      strategy: 'ORB 3130',
      instrument: 'MNQ',
      dateRange: { 
        start: filteredDates[0], 
        end: filteredDates[filteredDates.length - 1],
      },
      totalSessions: filteredDates.length,
      sessionsWithTrade: trades.length,
      sessionsNoTrade: filteredDates.length - trades.length,
      tradeFrequency: Math.round((trades.length / filteredDates.length) * 1000) / 10, // percentage
    },
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
    noTradeReasons,
    // Raw data for further analysis
    trades,
    sessionResults,
  };
}

// ============================================================
// WALK-FORWARD ANALYSIS
// ============================================================

/**
 * Walk-forward optimization to detect overfitting.
 * 
 * Splits data into in-sample (IS) and out-of-sample (OOS) windows.
 * If OOS performance is significantly worse than IS, strategy may be overfit.
 * 
 * @param {Object} sessions - All session data
 * @param {Object} options
 * @returns {Object} Walk-forward results
 */
function walkForward(sessions, options = {}) {
  const {
    isRatio = 0.7,       // 70% in-sample, 30% out-of-sample
    windows = 4,         // Number of walk-forward windows
  } = options;

  const dates = Object.keys(sessions).sort();
  const totalSessions = dates.length;
  const windowSize = Math.floor(totalSessions / windows);
  const isSize = Math.floor(windowSize * isRatio);
  const oosSize = windowSize - isSize;

  const results = [];

  for (let w = 0; w < windows; w++) {
    const startIdx = w * windowSize;
    const isStart = dates[startIdx];
    const isEnd = dates[Math.min(startIdx + isSize - 1, dates.length - 1)];
    const oosStart = dates[Math.min(startIdx + isSize, dates.length - 1)];
    const oosEnd = dates[Math.min(startIdx + windowSize - 1, dates.length - 1)];

    // Build session subsets
    const isSessions = {};
    const oosSessions = {};
    
    for (const date of dates) {
      if (date >= isStart && date <= isEnd) isSessions[date] = sessions[date];
      if (date >= oosStart && date <= oosEnd) oosSessions[date] = sessions[date];
    }

    const isResult = runBacktest(isSessions, { monteCarloSims: 1000 });
    const oosResult = runBacktest(oosSessions, { monteCarloSims: 1000 });

    results.push({
      window: w + 1,
      inSample: {
        dateRange: { start: isStart, end: isEnd },
        sessions: Object.keys(isSessions).length,
        trades: isResult.metrics.totalTrades,
        winRate: isResult.metrics.winRate,
        profitFactor: isResult.metrics.profitFactor,
        expectancy: isResult.metrics.expectancy,
      },
      outOfSample: {
        dateRange: { start: oosStart, end: oosEnd },
        sessions: Object.keys(oosSessions).length,
        trades: oosResult.metrics.totalTrades,
        winRate: oosResult.metrics.winRate,
        profitFactor: oosResult.metrics.profitFactor,
        expectancy: oosResult.metrics.expectancy,
      },
      // Degradation metrics
      degradation: {
        winRate: isResult.metrics.winRate > 0 
          ? Math.round((oosResult.metrics.winRate - isResult.metrics.winRate) / isResult.metrics.winRate * 1000) / 10
          : 0,
        profitFactor: isResult.metrics.profitFactor > 0
          ? Math.round((oosResult.metrics.profitFactor - isResult.metrics.profitFactor) / isResult.metrics.profitFactor * 1000) / 10
          : 0,
      },
    });
  }

  // Overall assessment
  const avgDegradationWR = results.reduce((s, r) => s + r.degradation.winRate, 0) / results.length;
  const avgDegradationPF = results.reduce((s, r) => s + r.degradation.profitFactor, 0) / results.length;

  return {
    windows: results,
    assessment: {
      avgWinRateDegradation: Math.round(avgDegradationWR * 10) / 10,
      avgPFDegradation: Math.round(avgDegradationPF * 10) / 10,
      overfitRisk: avgDegradationPF < -20 ? 'HIGH' : avgDegradationPF < -10 ? 'MODERATE' : 'LOW',
    },
  };
}

// ============================================================
// COMPARATIVE BACKTEST (for mutations)
// ============================================================

/**
 * Run a modified version of the strategy and compare to baseline.
 * Used by The Lab for mutation testing.
 * 
 * @param {Object} sessions - Session data
 * @param {Function} filterFn - Function(sessionResult, date, candles) → boolean
 *                                Returns true if trade should be TAKEN under new rules
 * @param {Object} baselineMetrics - Baseline strategy metrics for comparison
 * @returns {Object} Comparison results
 */
function comparativeBacktest(sessions, filterFn, baselineMetrics = null) {
  const dates = Object.keys(sessions).sort();
  const trades = [];

  for (const date of dates) {
    const candles = sessions[date];
    const result = processSession(candles);

    if (result.trade) {
      // Apply mutation filter
      const takeTrade = filterFn(result, date, candles);
      if (takeTrade) {
        result.trade.date = date;
        trades.push(result.trade);
      }
    }
  }

  const metrics = calcMetrics(trades);

  const comparison = baselineMetrics ? {
    winRateChange: Math.round((metrics.winRate - baselineMetrics.winRate) * 10) / 10,
    pfChange: Math.round((metrics.profitFactor - baselineMetrics.profitFactor) * 100) / 100,
    tradeReduction: baselineMetrics.totalTrades - metrics.totalTrades,
    tradeReductionPct: baselineMetrics.totalTrades > 0
      ? Math.round((1 - metrics.totalTrades / baselineMetrics.totalTrades) * 1000) / 10
      : 0,
  } : null;

  return {
    metrics,
    trades,
    comparison,
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  runBacktest,
  walkForward,
  comparativeBacktest,
};
