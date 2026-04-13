/**
 * McNair Mindset by 3130
 * TP Sensitivity Engine
 * 
 * For every trade, calculates what would've happened at 
 * alternate TP targets (closer/further psych levels).
 * Answers: "How many losses become wins at the next-closer level?"
 */

const { psychLevelsInRange } = require('./psych-levels');

/**
 * Find all candidate psych levels for a given entry.
 * Returns them sorted by distance from entry (nearest first).
 */
function candidateLevels(entryPrice, direction) {
  const range = direction === 'long'
    ? { min: entryPrice, max: entryPrice + 300 }
    : { min: entryPrice - 300, max: entryPrice };

  // Generate psych levels: 25, 50, 75, 00 of each 100-point range
  const levels = [];
  const base = Math.floor(range.min / 100) * 100;
  for (let p = base; p <= range.max + 100; p += 25) {
    if (direction === 'long' && p > entryPrice + 2) levels.push(p);
    if (direction === 'short' && p < entryPrice - 2) levels.push(p);
  }

  // Sort by distance from entry (nearest first)
  levels.sort((a, b) => Math.abs(a - entryPrice) - Math.abs(b - entryPrice));
  return levels;
}

/**
 * For a single trade, simulate all psych level TP targets.
 * Returns array of { level, distance_ticks, would_hit, candle_time }
 */
function simulateTPLevels(trade, candles) {
  if (!trade || !trade.entry_price || !trade.entry_time) return [];

  const direction = trade.direction;
  const entry = trade.entry_price;
  const entryTime = trade.entry_time;
  const sl = trade.sl_price;

  const levels = candidateLevels(entry, direction);

  // Get candles after entry
  const entryIdx = candles.findIndex(c => c.timestamp === entryTime);
  if (entryIdx < 0) return [];
  const postEntry = candles.slice(entryIdx + 1);

  return levels.map(level => {
    const distTicks = Math.round(Math.abs(level - entry) * 4);
    let wouldHit = false;
    let hitTime = null;
    let hitBeforeSL = false;

    for (const c of postEntry) {
      const tpHit = direction === 'long' ? c.high >= level : c.low <= level;
      const slHit = direction === 'long' ? c.low <= sl : c.high >= sl;

      if (tpHit && slHit) {
        // Use wick direction heuristic (same as orb.js)
        const isBearish = c.close < c.open;
        const isBullish = c.close > c.open;
        const openToHigh = c.high - c.open;
        const openToLow = c.open - c.low;
        const isDoji = !isBearish && !isBullish;
        const dojiWentUpFirst = isDoji && openToHigh <= openToLow;

        const tpFirst = (direction === 'long' && (isBearish || dojiWentUpFirst)) ||
                        (direction === 'short' && (isBullish || (isDoji && !dojiWentUpFirst)));

        if (tpFirst) {
          wouldHit = true;
          hitTime = c.timestamp;
          hitBeforeSL = true;
        }
        break;
      }

      if (tpHit) {
        wouldHit = true;
        hitTime = c.timestamp;
        hitBeforeSL = true;
        break;
      }

      if (slHit) {
        break; // SL hit first, this level doesn't work
      }
    }

    return {
      level,
      distance_ticks: distTicks,
      distance_dollars: ((distTicks - 2) * 0.50) - 4.50, // subtract 2 slippage ticks, $0.50/tick, minus commission
      would_hit: wouldHit,
      hit_before_sl: hitBeforeSL,
      hit_time: hitTime,
    };
  });
}

/**
 * Run TP sensitivity across all trades.
 * Returns aggregate analysis.
 */
function runTPSensitivity(trades, sessionCandles) {
  const results = [];

  for (const trade of trades) {
    if (!trade.date || !sessionCandles[trade.date]) continue;

    const candles = sessionCandles[trade.date];
    const levels = simulateTPLevels(trade, candles);
    if (levels.length === 0) continue;

    // Find the actual TP used and its index
    const actualTP = trade.tp_price;
    const actualIdx = levels.findIndex(l => Math.abs(l.level - actualTP) < 1);

    // Find closest level that would've hit
    const closestHit = levels.find(l => l.would_hit);
    // Find the level one step closer than actual
    const closerLevel = actualIdx > 0 ? levels[actualIdx - 1] : null;

    results.push({
      date: trade.date,
      direction: trade.direction,
      entry: trade.entry_price,
      actual_tp: actualTP,
      actual_result: trade.result,
      actual_pnl: trade.pnl_dollars,
      levels,
      closest_winning_level: closestHit ? closestHit.level : null,
      closer_level: closerLevel,
      would_flip: trade.result === 'loss' && closerLevel?.would_hit,
    });
  }

  // Aggregate: how many losses flip at each "level offset"
  const lossesOnly = results.filter(r => r.actual_result === 'loss');
  const flipsAtCloser = lossesOnly.filter(r => r.would_flip).length;

  // More detailed: for each offset from actual TP
  const offsetAnalysis = {};
  for (const r of lossesOnly) {
    const actualIdx = r.levels.findIndex(l => Math.abs(l.level - r.actual_tp) < 1);
    for (let offset = 1; offset <= 3; offset++) {
      const idx = actualIdx - offset;
      if (idx >= 0 && r.levels[idx]) {
        if (!offsetAnalysis[offset]) offsetAnalysis[offset] = { checked: 0, flips: 0, totalSaved: 0 };
        offsetAnalysis[offset].checked++;
        if (r.levels[idx].would_hit) {
          offsetAnalysis[offset].flips++;
          // Saved = avoided loss + gained win at closer level
          const winDollars = r.levels[idx].distance_dollars;
          const lossDollars = Math.abs(r.actual_pnl);
          offsetAnalysis[offset].totalSaved += winDollars + lossDollars;
        }
      }
    }
  }

  return {
    total_trades: trades.length,
    total_losses: lossesOnly.length,
    flips_at_one_closer: flipsAtCloser,
    flip_rate: lossesOnly.length > 0 ? Math.round(flipsAtCloser / lossesOnly.length * 100) : 0,
    offset_analysis: Object.entries(offsetAnalysis).map(([offset, data]) => ({
      levels_closer: parseInt(offset),
      losses_checked: data.checked,
      would_flip: data.flips,
      flip_rate: data.checked > 0 ? Math.round(data.flips / data.checked * 100) : 0,
      total_dollar_impact: Math.round(data.totalSaved * 100) / 100,
    })),
    trade_details: results,
  };
}

module.exports = { runTPSensitivity, simulateTPLevels, candidateLevels };
