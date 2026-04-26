/**
 * McNair Mindset by 3130
 * ORB 3130 — Core Strategy Engine
 * 
 * Opening Range Breakout strategy logic.
 * Pure functions, no side effects, fully testable.
 * 
 * Strategy:
 *   1. Define ORB from 9:30-9:45 15-min candle (high/low)
 *   2. Detect 5-min breakout candle that closes beyond ORB
 *   3. Detect retest (touch of ORB level)
 *   4. Detect confirmation candle (closes beyond breakout candle)
 *   5. Entry at confirmation candle close
 *   6. TP = next psych level ≥ 110 ticks from entry
 *   7. SL = 1:1 from TP distance
 *   8. Invalidation: retest closes through opposite ORB boundary → flip
 */

const { calcTPSL, pointsToTicks, ticksToDollars } = require('./psych-levels');

// ============================================================
// CONSTANTS
// ============================================================

const ORB_START = '09:30';  // EST
const ORB_END = '09:45';    // EST — 15-min candle close
const SESSION_CLOSE = '15:55'; // Close 5 min before 4pm for safety
const TOPSTEP_CLOSE = '16:00';

// Commission: ~$4.50 round trip for MNQ on most platforms
const COMMISSION_PER_TRADE = 4.50;
// Slippage assumption: 1 tick per side (entry + exit)
const SLIPPAGE_TICKS = 2;
// Defaults updated 2026-04-25 to match user methodology spec.
// Old defaults (longOnly, skipMonday, maxEntryHour 11, tpMode skip2) were
// JARVIS-invented filters not in the user's actual method. New defaults:
//   - both directions traded equally
//   - no Monday skip (user has no such rule)
//   - no max-entry-hour (only Topstep flat-by 15:10 CT matters)
//   - tpMode 'default' = Nearest psych level ≥110 ticks (user's "next sensible level")
// Per-spec engineOptions in strategy-layers.js can still override these.
const V5_DEFAULTS = {
  longOnly: false,
  skipMonday: false,
  maxEntryHour: null, // null = no time gate; only Topstep cutoff applies
  tpMode: 'default',  // Nearest psych level (matches user's "next sensible level")
};

// ============================================================
// HELPERS
// ============================================================

/**
 * Parse time string from candle timestamp
 * Expects ISO format or "YYYY-MM-DD HH:MM" format
 * Returns { hour, minute } in EST
 */
function parseTime(timestamp) {
  const d = new Date(timestamp);
  // Assuming timestamps are already in EST
  // If they're UTC, we'll need to convert
  const timeStr = typeof timestamp === 'string' && timestamp.includes(' ')
    ? timestamp.split(' ')[1]
    : `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  
  const [hour, minute] = timeStr.split(':').map(Number);
  return { hour, minute, timeStr: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}` };
}

/**
 * Compare two time strings "HH:MM"
 * Returns -1, 0, or 1
 */
function compareTime(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  if (h1 !== h2) return h1 < h2 ? -1 : 1;
  if (m1 !== m2) return m1 < m2 ? -1 : 1;
  return 0;
}

/**
 * Check if a time is between start and end (inclusive of start, exclusive of end)
 */
function isTimeBetween(time, start, end) {
  return compareTime(time, start) >= 0 && compareTime(time, end) < 0;
}

/**
 * Check if a time is at or after a given time
 */
function isTimeAtOrAfter(time, target) {
  return compareTime(time, target) >= 0;
}

// ============================================================
// ORB DEFINITION
// ============================================================

/**
 * Find the ORB (Opening Range) from candle data.
 * 
 * The ORB is defined by the 15-min candle from 9:30-9:45.
 * On a 5-min chart, this is the union of the 9:30, 9:35, and 9:40 candles.
 * 
 * @param {Array} candles - Array of 5-min candles sorted by time
 * @returns {Object|null} { high, low, range_points, range_ticks, candles: [...] }
 */
function findORB(candles) {
  // Find candles in the 9:30-9:45 window (3 five-minute candles)
  const orbCandles = candles.filter(c => {
    const { timeStr } = parseTime(c.timestamp);
    return isTimeBetween(timeStr, ORB_START, ORB_END);
  });

  if (orbCandles.length === 0) return null;

  const high = Math.max(...orbCandles.map(c => c.high));
  const low = Math.min(...orbCandles.map(c => c.low));
  const rangePoints = high - low;
  const rangeTicks = pointsToTicks(rangePoints);

  return {
    high,
    low,
    range_points: rangePoints,
    range_ticks: rangeTicks,
    candles: orbCandles,
  };
}

// ============================================================
// BREAKOUT DETECTION
// ============================================================

/**
 * Find the first breakout candle after ORB closes.
 * 
 * LONG breakout: 5-min candle CLOSES above ORB high
 * SHORT breakout: 5-min candle CLOSES below ORB low
 * 
 * @param {Array} candles - 5-min candles sorted by time (post-ORB only)
 * @param {Object} orb - ORB object { high, low }
 * @returns {Object|null} { candle, direction, time }
 */
function findBreakout(candles, orb, settings = {}) {
  // Only consider candles after ORB closes (9:45 and later)
  const postORB = candles.filter(c => {
    const { timeStr } = parseTime(c.timestamp);
    return isTimeAtOrAfter(timeStr, ORB_END);
  });

  for (const candle of postORB) {
    if (candle.close > orb.high) {
      return {
        candle,
        direction: 'long',
        time: candle.timestamp,
        close: candle.close,
        high: candle.high,
        low: candle.low,
      };
    }
    if (!settings.longOnly && candle.close < orb.low) {
      return {
        candle,
        direction: 'short',
        time: candle.timestamp,
        close: candle.close,
        high: candle.high,
        low: candle.low,
      };
    }
  }

  return null; // No breakout occurred
}

// ============================================================
// RETEST DETECTION
// ============================================================

/**
 * Find the retest candle after breakout.
 * 
 * LONG retest: candle's LOW touches or goes below ORB high
 * SHORT retest: candle's HIGH touches or goes above ORB low
 * 
 * Also checks for invalidation:
 * - LONG invalidated if any candle CLOSES below ORB low
 * - SHORT invalidated if any candle CLOSES above ORB high
 * 
 * @param {Array} candles - 5-min candles after breakout candle
 * @param {Object} orb - ORB object { high, low }
 * @param {string} direction - 'long' or 'short'
 * @returns {Object} { retest, invalidation }
 */
function findRetest(candles, orb, direction) {
  for (const candle of candles) {
    // Check invalidation FIRST
    // Long invalidated if candle CLOSES below ORB LOW (through opposite boundary)
    if (direction === 'long' && candle.close < orb.low) {
      return {
        retest: null,
        invalidation: {
          candle,
          time: candle.timestamp,
          reason: 'close_through_opposite',
          new_direction: 'short',
        },
      };
    }
    // Short invalidated if candle CLOSES above ORB HIGH
    if (direction === 'short' && candle.close > orb.high) {
      return {
        retest: null,
        invalidation: {
          candle,
          time: candle.timestamp,
          reason: 'close_through_opposite',
          new_direction: 'long',
        },
      };
    }

    // Check for retest
    if (direction === 'long' && candle.low <= orb.high) {
      return {
        retest: {
          candle,
          time: candle.timestamp,
          touch_price: Math.min(candle.low, orb.high),
        },
        invalidation: null,
      };
    }
    if (direction === 'short' && candle.high >= orb.low) {
      return {
        retest: {
          candle,
          time: candle.timestamp,
          touch_price: Math.max(candle.high, orb.low),
        },
        invalidation: null,
      };
    }
  }

  return { retest: null, invalidation: null }; // No retest occurred
}

// ============================================================
// CONFIRMATION DETECTION
// ============================================================

/**
 * Find the confirmation candle after retest.
 * 
 * LONG confirmation: candle CLOSES above breakout candle's CLOSE
 * SHORT confirmation: candle CLOSES below breakout candle's CLOSE
 * 
 * Also continues checking for invalidation during this phase.
 * 
 * @param {Array} candles - 5-min candles after retest candle
 * @param {Object} orb - ORB object
 * @param {Object} breakout - Breakout object { high, low, close, direction }
 * @param {string} direction - 'long' or 'short'
 * @returns {Object} { confirmation, invalidation }
 */
function findConfirmation(candles, orb, breakout, direction, settings = {}) {
  for (const candle of candles) {
    const t = parseTime(candle.timestamp);
    // maxEntryHour is now optional — null/undefined disables the gate.
    // User method has no time cutoff; only Topstep flat-by enforces close.
    const maxHour = settings.maxEntryHour;
    if (Number.isFinite(maxHour) && maxHour > 0 && t.hour >= maxHour) {
      return { confirmation: null, invalidation: null, timeout: true };
    }

    // Check invalidation during confirmation phase too
    if (direction === 'long' && candle.close < orb.low) {
      return {
        confirmation: null,
        invalidation: {
          candle,
          time: candle.timestamp,
          reason: 'close_through_opposite_during_confirmation',
          new_direction: 'short',
        },
      };
    }
    if (direction === 'short' && candle.close > orb.high) {
      return {
        confirmation: null,
        invalidation: {
          candle,
          time: candle.timestamp,
          reason: 'close_through_opposite_during_confirmation',
          new_direction: 'long',
        },
      };
    }

    // Check for confirmation — close beyond breakout candle's CLOSE
    if (direction === 'long' && candle.close > breakout.close) {
      return {
        confirmation: {
          candle,
          time: candle.timestamp,
          entry_price: candle.close,
        },
        invalidation: null,
      };
    }
    if (direction === 'short' && candle.close < breakout.close) {
      return {
        confirmation: {
          candle,
          time: candle.timestamp,
          entry_price: candle.close,
        },
        invalidation: null,
      };
    }
  }

  return { confirmation: null, invalidation: null };
}

// ============================================================
// TRADE RESOLUTION
// ============================================================

/**
 * Resolve a trade — did it hit TP, SL, or time out?
 * 
 * @param {Array} candles - 5-min candles after entry
 * @param {number} entryPrice
 * @param {string} direction - 'long' or 'short'
 * @param {number} tpPrice
 * @param {number} slPrice
 * @returns {Object} { result, exit_price, exit_time, exit_reason, pnl_ticks, pnl_dollars }
 */
function resolveTrade(candles, entryPrice, direction, tpPrice, slPrice) {
  for (const candle of candles) {
    const { timeStr } = parseTime(candle.timestamp);
    
    // Time-based exit at 3:55 PM (Topstep safety)
    if (isTimeAtOrAfter(timeStr, SESSION_CLOSE)) {
      const exitPrice = candle.close;
      const pnlPoints = direction === 'long' 
        ? exitPrice - entryPrice 
        : entryPrice - exitPrice;
      const pnlTicks = pointsToTicks(pnlPoints);
      
      return {
        result: pnlTicks > 0 ? 'win' : pnlTicks < 0 ? 'loss' : 'breakeven',
        exit_price: exitPrice,
        exit_time: candle.timestamp,
        exit_reason: 'time_close',
        pnl_ticks: pnlTicks - SLIPPAGE_TICKS,
        pnl_dollars: ticksToDollars(pnlTicks - SLIPPAGE_TICKS) - COMMISSION_PER_TRADE,
      };
    }

    // Check if both TP and SL were hit in same candle
    let tpHit = false;
    let slHit = false;

    if (direction === 'long') {
      tpHit = candle.high >= tpPrice;
      slHit = candle.low <= slPrice;
    } else {
      tpHit = candle.low <= tpPrice;
      slHit = candle.high >= slPrice;
    }

    // Both hit in same candle → use wick direction heuristic
    if (tpHit && slHit) {
      // Standard 5-min candle wick model:
      //   Bearish candle (close < open): Open → High → Low → Close (goes UP first)
      //   Bullish candle (close > open): Open → Low → High → Close (goes DOWN first)
      //
      // For LONG trades (TP above, SL below):
      //   Bearish → went high first → TP hit first → WIN
      //   Bullish → went low first → SL hit first → LOSS
      //
      // For SHORT trades (TP below, SL above):
      //   Bearish → went high first → SL hit first → LOSS
      //   Bullish → went low first → TP hit first → WIN

      const isBearish = candle.close < candle.open;
      const isBullish = candle.close > candle.open;

      // Doji tiebreaker: check if open is closer to high or low
      // If open closer to high → went up first (bearish-like)
      // If open closer to low → went down first (bullish-like)
      const openToHigh = candle.high - candle.open;
      const openToLow = candle.open - candle.low;
      const isDoji = !isBearish && !isBullish;
      const dojiWentUpFirst = isDoji && openToHigh <= openToLow;

      const tpFirst = (direction === 'long' && (isBearish || dojiWentUpFirst)) ||
                      (direction === 'short' && (isBullish || (isDoji && !dojiWentUpFirst)));

      if (tpFirst) {
        // TP hit first → WIN
        const pnlTicks = direction === 'long'
          ? pointsToTicks(tpPrice - entryPrice)
          : pointsToTicks(entryPrice - tpPrice);

        return {
          result: 'win',
          exit_price: tpPrice,
          exit_time: candle.timestamp,
          exit_reason: 'tp_wick_inferred',
          pnl_ticks: pnlTicks - SLIPPAGE_TICKS,
          pnl_dollars: ticksToDollars(pnlTicks - SLIPPAGE_TICKS) - COMMISSION_PER_TRADE,
        };
      } else {
        // SL hit first → LOSS
        const pnlTicks = direction === 'long'
          ? pointsToTicks(slPrice - entryPrice)
          : pointsToTicks(entryPrice - slPrice);

        return {
          result: 'loss',
          exit_price: slPrice,
          exit_time: candle.timestamp,
          exit_reason: 'sl_wick_inferred',
          pnl_ticks: pnlTicks - SLIPPAGE_TICKS,
          pnl_dollars: ticksToDollars(pnlTicks - SLIPPAGE_TICKS) - COMMISSION_PER_TRADE,
        };
      }
    }

    // TP hit
    if (tpHit) {
      const pnlTicks = direction === 'long'
        ? pointsToTicks(tpPrice - entryPrice)
        : pointsToTicks(entryPrice - tpPrice);
      
      return {
        result: 'win',
        exit_price: tpPrice,
        exit_time: candle.timestamp,
        exit_reason: 'tp',
        pnl_ticks: pnlTicks - SLIPPAGE_TICKS,
        pnl_dollars: ticksToDollars(pnlTicks - SLIPPAGE_TICKS) - COMMISSION_PER_TRADE,
      };
    }

    // SL hit
    if (slHit) {
      const pnlTicks = direction === 'long'
        ? pointsToTicks(slPrice - entryPrice)
        : pointsToTicks(entryPrice - slPrice);
      
      return {
        result: 'loss',
        exit_price: slPrice,
        exit_time: candle.timestamp,
        exit_reason: 'sl',
        pnl_ticks: pnlTicks - SLIPPAGE_TICKS,
        pnl_dollars: ticksToDollars(pnlTicks - SLIPPAGE_TICKS) - COMMISSION_PER_TRADE,
      };
    }
  }

  // No resolution — ran out of candles (shouldn't happen with time close)
  return {
    result: 'no_resolution',
    exit_price: null,
    exit_time: null,
    exit_reason: 'no_data',
    pnl_ticks: 0,
    pnl_dollars: 0,
  };
}

// ============================================================
// FULL SESSION PROCESSOR
// ============================================================

/**
 * Process a complete trading session through the ORB 3130 strategy.
 * 
 * This is the main entry point. Give it all 5-min candles for a day
 * and it returns the full signal chain + trade result.
 * 
 * Handles invalidation/flip by recursing with the new direction.
 * 
 * @param {Array} candles - All 5-min candles for the session, sorted by time
 * @param {Object} options - { maxFlips: 2 } prevent infinite recursion
 * @returns {Object} Complete trade analysis for the session
 */
function processSession(candles, options = {}) {
  const settings = { ...V5_DEFAULTS, ...options };
  const { maxFlips = 2 } = settings;
  
  const result = {
    date: candles.length > 0 ? candles[0].timestamp.split(' ')[0] || candles[0].timestamp.split('T')[0] : null,
    orb: null,
    signals: [],     // Array of signal attempts (including invalidated ones)
    trade: null,      // The final trade taken (or null)
    no_trade_reason: null,
  };

  if (settings.skipMonday && result.date) {
    const d = new Date(`${result.date}T12:00:00`);
    if (d.getDay() === 1) {
      result.no_trade_reason = 'skip_monday';
      return result;
    }
  }

  // Step 1: Find ORB
  const orb = findORB(candles);
  if (!orb) {
    result.no_trade_reason = 'no_orb_data';
    return result;
  }
  result.orb = orb;

  // Get post-ORB candles
  const postORB = candles.filter(c => {
    const { timeStr } = parseTime(c.timestamp);
    return isTimeAtOrAfter(timeStr, ORB_END);
  });

  if (postORB.length === 0) {
    result.no_trade_reason = 'no_post_orb_candles';
    return result;
  }

  // Process signal chain (with flip handling)
  let remainingCandles = [...postORB];
  let flipCount = 0;

  while (flipCount <= maxFlips && remainingCandles.length > 0) {
    const signal = processSignalChain(remainingCandles, orb, settings);
    result.signals.push(signal);

    // If we got a valid entry
    if (signal.entry) {
      // Calculate TP/SL
      const tpsl = calcTPSL(signal.entry.price, signal.direction, {
        tpMode: settings.tpMode,
        skipLevels: 2,
      });

      // Find candles after entry for resolution
      const entryIndex = remainingCandles.findIndex(c => c.timestamp === signal.entry.time);
      const postEntry = remainingCandles.slice(entryIndex + 1);

      // Resolve trade
      const resolution = resolveTrade(
        postEntry,
        signal.entry.price,
        signal.direction,
        tpsl.tp.price,
        tpsl.sl.price
      );

      result.trade = {
        direction: signal.direction,
        orb_high: orb.high,
        orb_low: orb.low,
        breakout_time: signal.breakout.time,
        breakout_candle_high: signal.breakout.high,
        breakout_candle_low: signal.breakout.low,
        breakout_candle_close: signal.breakout.close,
        // 2026-04-25: break candle (last bullish/bearish before retest) is now
        // distinct from the initial breakout candle. May be the same in fast
        // setups; differs when the break-leg has multiple post-break candles.
        break_candle_time: signal.breakCandle ? signal.breakCandle.time : signal.breakout.time,
        break_candle_close: signal.breakCandle ? signal.breakCandle.close : signal.breakout.close,
        break_candle_high: signal.breakCandle ? signal.breakCandle.high : signal.breakout.high,
        break_candle_low: signal.breakCandle ? signal.breakCandle.low : signal.breakout.low,
        retest_time: signal.retest.time,
        confirmation_time: signal.confirmation.time,
        entry_price: signal.entry.price,
        entry_time: signal.entry.time,
        tp_price: tpsl.tp.price,
        tp_distance_ticks: tpsl.tp.distanceTicks,
        sl_price: tpsl.sl.price,
        sl_distance_ticks: tpsl.sl.distanceTicks,
        ...resolution,
      };

      break; // Done — we have our trade
    }

    // If invalidated/flipped, continue with remaining candles
    if (signal.invalidation) {
      flipCount++;
      const invalidIndex = remainingCandles.findIndex(
        c => c.timestamp === signal.invalidation.time
      );
      remainingCandles = remainingCandles.slice(invalidIndex);
      continue;
    }

    // No breakout, no retest, no confirmation — no trade
    if (!signal.breakout) {
      result.no_trade_reason = 'no_breakout';
    } else if (!signal.retest) {
      result.no_trade_reason = 'no_retest';
    } else if (!signal.confirmation) {
      result.no_trade_reason = signal.timeout ? 'entry_after_max_hour' : 'no_confirmation';
    }
    break;
  }

  if (flipCount > maxFlips && !result.trade) {
    result.no_trade_reason = 'max_flips_exceeded';
  }

  return result;
}

/**
 * Find the "break candle" for confirmation purposes — per user spec:
 *   "Whatever is the last bullish candle before reversing to retest the ORB
 *    high (in a long situation) is the break candle for me."
 *
 * Implementation: among the candles between the initial breakout and the retest,
 * find the LATEST bullish candle (close > open) with the HIGHEST close.
 * This becomes the confirmation threshold instead of the first breakout candle.
 *
 * Falls back to the initial breakout candle itself when no superior bullish
 * candle exists in the break leg.
 *
 * For shorts: latest bearish candle (close < open) with the LOWEST close.
 */
function findBreakLegBreakCandle(breakLegCandles, initialBreakoutCandle, direction) {
  let breakCandle = initialBreakoutCandle;
  let breakClose = initialBreakoutCandle.close;
  for (const c of breakLegCandles) {
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;
    if (direction === 'long' && isBullish && c.close >= breakClose) {
      breakCandle = c;
      breakClose = c.close;
    } else if (direction === 'short' && isBearish && c.close <= breakClose) {
      breakCandle = c;
      breakClose = c.close;
    }
  }
  return breakCandle;
}

/**
 * Process a single signal chain attempt.
 * Returns breakout → retest → confirmation sequence,
 * or stops at the point of failure/invalidation.
 *
 * Updated 2026-04-25 per user methodology:
 *   - "Break candle" used for confirmation is the LAST BULLISH (long) /
 *     LAST BEARISH (short) candle BEFORE the retest, not necessarily the
 *     first candle that closed beyond the ORB.
 *   - Setup invalidation = close beyond OPPOSITE ORB boundary (already correct).
 */
function processSignalChain(candles, orb, settings = {}) {
  const signal = {
    direction: null,
    breakout: null,
    breakCandle: null,
    retest: null,
    confirmation: null,
    entry: null,
    invalidation: null,
  };

  // Step 1: Find INITIAL breakout (first candle to close beyond ORB)
  const breakout = findBreakout(candles, orb, settings);
  if (!breakout) return signal;

  signal.direction = breakout.direction;
  signal.breakout = breakout;

  // Step 2: Find retest (candles after breakout)
  const breakoutIndex = candles.findIndex(c => c.timestamp === breakout.time);
  const postBreakout = candles.slice(breakoutIndex + 1);

  if (postBreakout.length === 0) return signal;

  const { retest, invalidation: retestInvalidation } = findRetest(
    postBreakout, orb, breakout.direction
  );

  if (retestInvalidation) {
    signal.invalidation = retestInvalidation;
    return signal;
  }

  if (!retest) return signal;
  signal.retest = retest;

  // Step 2b: Identify the "break candle" — the last bullish candle (long) or
  // last bearish candle (short) BEFORE the retest, with the most extreme close.
  // This is the threshold the confirmation candle must close beyond.
  const retestIndex = postBreakout.findIndex(c => c.timestamp === retest.time);
  const breakLegCandles = postBreakout.slice(0, retestIndex); // pre-retest candles only
  const breakCandle = findBreakLegBreakCandle(
    breakLegCandles, breakout.candle, breakout.direction
  );
  signal.breakCandle = {
    candle: breakCandle,
    close: breakCandle.close,
    high: breakCandle.high,
    low: breakCandle.low,
    time: breakCandle.timestamp,
  };

  // Step 3: Find confirmation — close must beat the break candle's close
  // (not the initial breakout candle's close).
  const postRetest = postBreakout.slice(retestIndex);
  if (postRetest.length === 0) return signal;

  const confirmationThreshold = {
    close: breakCandle.close,
    high: breakCandle.high,
    low: breakCandle.low,
  };
  const { confirmation, invalidation: confInvalidation, timeout } = findConfirmation(
    postRetest, orb, confirmationThreshold, breakout.direction, settings
  );

  if (confInvalidation) {
    signal.invalidation = confInvalidation;
    return signal;
  }

  if (!confirmation) {
    if (timeout) signal.timeout = true;
    return signal;
  }
  signal.confirmation = confirmation;

  // Entry!
  signal.entry = {
    price: confirmation.entry_price,
    time: confirmation.time,
  };

  return signal;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Core functions
  findORB,
  findBreakout,
  findRetest,
  findConfirmation,
  resolveTrade,
  processSession,
  processSignalChain,
  
  // Helpers (exported for testing)
  parseTime,
  compareTime,
  isTimeBetween,
  isTimeAtOrAfter,
  
  // Constants
  ORB_START,
  ORB_END,
  SESSION_CLOSE,
  TOPSTEP_CLOSE,
  COMMISSION_PER_TRADE,
  SLIPPAGE_TICKS,
};
