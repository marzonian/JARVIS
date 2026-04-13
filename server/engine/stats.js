/**
 * McNair Mindset by 3130
 * Statistical Analysis Engine
 * 
 * Computes all performance metrics for backtest results and live trades.
 */

const { ticksToDollars } = require('./psych-levels');

// ============================================================
// BASIC METRICS
// ============================================================

/**
 * Calculate core performance metrics from an array of trade results.
 * 
 * @param {Array} trades - Array of { result, pnl_ticks, pnl_dollars, direction, ... }
 * @returns {Object} Performance metrics
 */
function calcMetrics(trades) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0, losses: 0, breakevens: 0, timeExits: 0,
      winRate: 0, lossRate: 0,
      profitFactor: 0,
      totalPnlTicks: 0, totalPnlDollars: 0,
      avgWinTicks: 0, avgLossTicks: 0,
      avgWinDollars: 0, avgLossDollars: 0,
      largestWinTicks: 0, largestLossTicks: 0,
      avgRR: 0,
      expectancy: 0, expectancyDollars: 0,
      maxConsecWins: 0, maxConsecLosses: 0,
      longTrades: 0, shortTrades: 0,
      longWinRate: 0, shortWinRate: 0,
    };
  }

  const wins = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  const breakevens = trades.filter(t => t.result === 'breakeven');
  const timeExits = trades.filter(t => t.exit_reason === 'time_close');
  const longs = trades.filter(t => t.direction === 'long');
  const shorts = trades.filter(t => t.direction === 'short');

  const totalWinTicks = wins.reduce((s, t) => s + Math.abs(t.pnl_ticks), 0);
  const totalLossTicks = losses.reduce((s, t) => s + Math.abs(t.pnl_ticks), 0);
  const totalWinDollars = wins.reduce((s, t) => s + Math.abs(t.pnl_dollars), 0);
  const totalLossDollars = losses.reduce((s, t) => s + Math.abs(t.pnl_dollars), 0);

  // Profit Factor
  const profitFactor = totalLossDollars > 0 
    ? totalWinDollars / totalLossDollars 
    : totalWinDollars > 0 ? Infinity : 0;

  // Win/Loss streaks
  let maxConsecWins = 0, maxConsecLosses = 0;
  let currentWins = 0, currentLosses = 0;
  for (const t of trades) {
    if (t.result === 'win') {
      currentWins++;
      currentLosses = 0;
      maxConsecWins = Math.max(maxConsecWins, currentWins);
    } else if (t.result === 'loss') {
      currentLosses++;
      currentWins = 0;
      maxConsecLosses = Math.max(maxConsecLosses, currentLosses);
    }
  }

  const totalPnlTicks = trades.reduce((s, t) => s + t.pnl_ticks, 0);
  const totalPnlDollars = trades.reduce((s, t) => s + t.pnl_dollars, 0);

  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWinTicks = wins.length > 0 ? totalWinTicks / wins.length : 0;
  const avgLossTicks = losses.length > 0 ? totalLossTicks / losses.length : 0;

  // Expectancy (avg profit per trade in ticks)
  const expectancy = trades.length > 0 ? totalPnlTicks / trades.length : 0;
  const expectancyDollars = trades.length > 0 ? totalPnlDollars / trades.length : 0;

  // Direction breakdown
  const longWins = longs.filter(t => t.result === 'win');
  const shortWins = shorts.filter(t => t.result === 'win');

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    timeExits: timeExits.length,
    winRate: Math.round(winRate * 1000) / 10, // e.g., 58.3
    lossRate: Math.round((1 - winRate) * 1000) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalPnlTicks: Math.round(totalPnlTicks),
    totalPnlDollars: Math.round(totalPnlDollars * 100) / 100,
    avgWinTicks: Math.round(avgWinTicks * 10) / 10,
    avgLossTicks: Math.round(avgLossTicks * 10) / 10,
    avgWinDollars: wins.length > 0 ? Math.round(totalWinDollars / wins.length * 100) / 100 : 0,
    avgLossDollars: losses.length > 0 ? Math.round(totalLossDollars / losses.length * 100) / 100 : 0,
    largestWinTicks: wins.length > 0 ? Math.max(...wins.map(t => t.pnl_ticks)) : 0,
    largestLossTicks: losses.length > 0 ? Math.min(...losses.map(t => t.pnl_ticks)) : 0,
    expectancy: Math.round(expectancy * 10) / 10,
    expectancyDollars: Math.round(expectancyDollars * 100) / 100,
    maxConsecWins,
    maxConsecLosses,
    longTrades: longs.length,
    shortTrades: shorts.length,
    longWinRate: longs.length > 0 ? Math.round(longWins.length / longs.length * 1000) / 10 : 0,
    shortWinRate: shorts.length > 0 ? Math.round(shortWins.length / shorts.length * 1000) / 10 : 0,
  };
}

// ============================================================
// EQUITY CURVE
// ============================================================

/**
 * Generate equity curve data points from trades.
 * 
 * @param {Array} trades - Sorted by date
 * @param {number} startingBalance - Starting account balance
 * @returns {Array} [{ date, tradeNum, balance, drawdown, highWater }, ...]
 */
function calcEquityCurve(trades, startingBalance = 50000) {
  const curve = [{ 
    date: null, 
    tradeNum: 0, 
    balance: startingBalance, 
    drawdown: 0, 
    highWater: startingBalance,
    pnl: 0,
  }];

  let balance = startingBalance;
  let highWater = startingBalance;

  for (let i = 0; i < trades.length; i++) {
    balance += trades[i].pnl_dollars;
    highWater = Math.max(highWater, balance);
    const drawdown = highWater - balance;

    curve.push({
      date: trades[i].date || trades[i].entry_time?.split(' ')[0],
      tradeNum: i + 1,
      balance: Math.round(balance * 100) / 100,
      drawdown: Math.round(drawdown * 100) / 100,
      highWater: Math.round(highWater * 100) / 100,
      pnl: Math.round(trades[i].pnl_dollars * 100) / 100,
    });
  }

  return curve;
}

// ============================================================
// DRAWDOWN ANALYSIS
// ============================================================

/**
 * Calculate max drawdown metrics.
 */
function calcDrawdown(trades, startingBalance = 50000) {
  const curve = calcEquityCurve(trades, startingBalance);
  
  let maxDrawdownDollars = 0;
  let maxDrawdownPercent = 0;
  let currentDrawdownStart = null;
  let longestDrawdown = 0;
  let currentDrawdownLength = 0;

  for (const point of curve) {
    if (point.drawdown > 0) {
      if (currentDrawdownStart === null) currentDrawdownStart = point.tradeNum;
      currentDrawdownLength = point.tradeNum - currentDrawdownStart;
      longestDrawdown = Math.max(longestDrawdown, currentDrawdownLength);
    } else {
      currentDrawdownStart = null;
      currentDrawdownLength = 0;
    }

    maxDrawdownDollars = Math.max(maxDrawdownDollars, point.drawdown);
    if (point.highWater > 0) {
      maxDrawdownPercent = Math.max(maxDrawdownPercent, point.drawdown / point.highWater);
    }
  }

  return {
    maxDrawdownDollars: Math.round(maxDrawdownDollars * 100) / 100,
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 1000) / 10,
    longestDrawdownTrades: longestDrawdown,
    finalBalance: curve[curve.length - 1].balance,
  };
}

// ============================================================
// SHARPE & SORTINO RATIOS
// ============================================================

/**
 * Calculate Sharpe Ratio (annualized, assuming 252 trading days).
 * Risk-free rate assumed 0 for simplicity.
 */
function calcSharpe(trades) {
  if (trades.length < 2) return 0;

  const returns = trades.map(t => t.pnl_dollars);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: assume ~1 trade/day, 252 trading days
  const annualizedReturn = mean * 252;
  const annualizedStdDev = stdDev * Math.sqrt(252);

  return Math.round((annualizedReturn / annualizedStdDev) * 100) / 100;
}

/**
 * Calculate Sortino Ratio (only considers downside deviation).
 */
function calcSortino(trades) {
  if (trades.length < 2) return 0;

  const returns = trades.map(t => t.pnl_dollars);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  
  // Only negative returns for downside deviation
  const negReturns = returns.filter(r => r < 0);
  if (negReturns.length === 0) return Infinity;

  const downsideVariance = negReturns.reduce((s, r) => s + Math.pow(r, 2), 0) / negReturns.length;
  const downsideStdDev = Math.sqrt(downsideVariance);

  if (downsideStdDev === 0) return 0;

  const annualizedReturn = mean * 252;
  const annualizedDownside = downsideStdDev * Math.sqrt(252);

  return Math.round((annualizedReturn / annualizedDownside) * 100) / 100;
}

// ============================================================
// MONTE CARLO SIMULATION
// ============================================================

/**
 * Run Monte Carlo simulation on trade results.
 * 
 * Randomly reorders trades N times to generate
 * a distribution of possible equity paths.
 * 
 * Key output: probability of hitting Topstep drawdown limit
 * before reaching payout target.
 * 
 * @param {Array} trades - Historical trade results
 * @param {number} simulations - Number of simulations (default 10,000)
 * @param {Object} account - { balance, maxDrawdown, payoutTarget }
 * @returns {Object} Simulation results
 */
function monteCarlo(trades, simulations = 10000, account = {}) {
  const {
    balance = 50000,
    maxDrawdown = 2000,   // Topstep trailing DD
    payoutTarget = 3000,  // Topstep profit target
  } = account;

  if (trades.length === 0) {
    return { simulations: 0, results: {} };
  }

  const pnls = trades.map(t => t.pnl_dollars);
  let hitPayout = 0;
  let hitDrawdown = 0;
  let survived = 0;
  const finalBalances = [];
  const maxDrawdowns = [];

  for (let sim = 0; sim < simulations; sim++) {
    // Shuffle trades (Fisher-Yates)
    const shuffled = [...pnls];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let bal = balance;
    let highWater = balance;
    let maxDD = 0;
    let payoutReached = false;
    let drawdownHit = false;

    for (const pnl of shuffled) {
      bal += pnl;
      highWater = Math.max(highWater, bal);
      const dd = highWater - bal;
      maxDD = Math.max(maxDD, dd);

      if (dd >= maxDrawdown) {
        drawdownHit = true;
        break;
      }
      if (bal - balance >= payoutTarget) {
        payoutReached = true;
        break;
      }
    }

    if (payoutReached) hitPayout++;
    else if (drawdownHit) hitDrawdown++;
    else survived++;

    finalBalances.push(bal);
    maxDrawdowns.push(maxDD);
  }

  // Sort for percentile calculations
  finalBalances.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const percentile = (arr, p) => {
    const idx = Math.floor(arr.length * p);
    return arr[Math.min(idx, arr.length - 1)];
  };

  return {
    simulations,
    tradeCount: trades.length,
    account: { balance, maxDrawdown, payoutTarget },
    probabilities: {
      hitPayout: Math.round((hitPayout / simulations) * 1000) / 10,
      hitDrawdown: Math.round((hitDrawdown / simulations) * 1000) / 10,
      survived: Math.round((survived / simulations) * 1000) / 10,
    },
    finalBalance: {
      median: Math.round(percentile(finalBalances, 0.5) * 100) / 100,
      p5: Math.round(percentile(finalBalances, 0.05) * 100) / 100,
      p25: Math.round(percentile(finalBalances, 0.25) * 100) / 100,
      p75: Math.round(percentile(finalBalances, 0.75) * 100) / 100,
      p95: Math.round(percentile(finalBalances, 0.95) * 100) / 100,
    },
    maxDrawdown: {
      median: Math.round(percentile(maxDrawdowns, 0.5) * 100) / 100,
      p75: Math.round(percentile(maxDrawdowns, 0.75) * 100) / 100,
      p95: Math.round(percentile(maxDrawdowns, 0.95) * 100) / 100,
      worst: Math.round(maxDrawdowns[maxDrawdowns.length - 1] * 100) / 100,
    },
  };
}

// ============================================================
// ROLLING METRICS (for Edge Decay)
// ============================================================

/**
 * Calculate rolling window metrics for edge decay detection.
 * 
 * @param {Array} trades - Sorted by date
 * @param {number} window - Rolling window size (number of trades)
 * @returns {Array} Rolling metric data points
 */
function calcRolling(trades, window = 30) {
  if (trades.length < window) return [];

  const points = [];
  for (let i = window; i <= trades.length; i++) {
    const windowTrades = trades.slice(i - window, i);
    const metrics = calcMetrics(windowTrades);
    
    points.push({
      tradeNum: i,
      date: windowTrades[windowTrades.length - 1].date || 
            windowTrades[windowTrades.length - 1].entry_time?.split(' ')[0],
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      expectancy: metrics.expectancy,
      avgRR: metrics.avgWinTicks > 0 && metrics.avgLossTicks > 0
        ? Math.round(metrics.avgWinTicks / metrics.avgLossTicks * 100) / 100
        : 0,
    });
  }

  return points;
}

/**
 * Detect edge decay — is the strategy's performance declining?
 * 
 * Compares recent rolling window to long-term average.
 * Alerts if deviation exceeds threshold.
 */
function detectDecay(trades, window = 30, threshold = 1.5) {
  const rolling = calcRolling(trades, window);
  if (rolling.length < 10) return { decayDetected: false, reason: 'insufficient_data' };

  // Long-term averages
  const ltWR = rolling.reduce((s, p) => s + p.winRate, 0) / rolling.length;
  const ltPF = rolling.reduce((s, p) => s + p.profitFactor, 0) / rolling.length;

  // Standard deviations
  const wrStd = Math.sqrt(rolling.reduce((s, p) => s + Math.pow(p.winRate - ltWR, 2), 0) / rolling.length);
  const pfStd = Math.sqrt(rolling.reduce((s, p) => s + Math.pow(p.profitFactor - ltPF, 2), 0) / rolling.length);

  // Most recent point
  const latest = rolling[rolling.length - 1];

  const wrDeviation = wrStd > 0 ? (ltWR - latest.winRate) / wrStd : 0;
  const pfDeviation = pfStd > 0 ? (ltPF - latest.profitFactor) / pfStd : 0;

  const decayDetected = wrDeviation > threshold || pfDeviation > threshold;

  return {
    decayDetected,
    latest: {
      winRate: latest.winRate,
      profitFactor: latest.profitFactor,
    },
    longTerm: {
      winRate: Math.round(ltWR * 10) / 10,
      profitFactor: Math.round(ltPF * 100) / 100,
    },
    deviation: {
      winRate: Math.round(wrDeviation * 100) / 100,
      profitFactor: Math.round(pfDeviation * 100) / 100,
    },
    threshold,
    status: decayDetected ? 'DECAY_DETECTED' : 'HEALTHY',
  };
}

// ============================================================
// MONTHLY/WEEKLY BREAKDOWN
// ============================================================

/**
 * Group trades by month and calculate metrics per month.
 */
function monthlyBreakdown(trades) {
  const months = {};
  for (const trade of trades) {
    const date = trade.date || trade.entry_time?.split(' ')[0];
    if (!date) continue;
    const month = date.substring(0, 7); // YYYY-MM
    if (!months[month]) months[month] = [];
    months[month].push(trade);
  }

  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, monthTrades]) => ({
      month,
      ...calcMetrics(monthTrades),
    }));
}

/**
 * Group trades by day of week and calculate metrics.
 */
function dayOfWeekBreakdown(trades) {
  const days = { 0: [], 1: [], 2: [], 3: [], 4: [] }; // Mon-Fri
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  for (const trade of trades) {
    const date = trade.date || trade.entry_time?.split(' ')[0];
    if (!date) continue;
    // Parse date parts manually to avoid timezone shift
    const [y, m, day] = date.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, day));
    const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ... (UTC to match date string)
    const adjDow = dow === 0 ? 6 : dow - 1; // Convert to Mon=0
    if (adjDow >= 0 && adjDow <= 4) {
      days[adjDow].push(trade);
    }
  }

  return Object.entries(days).map(([dow, dayTrades]) => ({
    dayOfWeek: parseInt(dow),
    dayName: dayNames[parseInt(dow)],
    ...calcMetrics(dayTrades),
  }));
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  calcMetrics,
  calcEquityCurve,
  calcDrawdown,
  calcSharpe,
  calcSortino,
  monteCarlo,
  calcRolling,
  detectDecay,
  monthlyBreakdown,
  dayOfWeekBreakdown,
};
