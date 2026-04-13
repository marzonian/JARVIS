/**
 * McNair Mindset by 3130
 * Psych Level Calculator — MNQ
 * 
 * MNQ psych levels occur every 25 points.
 * Tick value: $0.50 per tick, 4 ticks per point.
 * 
 * Examples: 22000, 22025, 22050, 22075, 22100...
 */

const PSYCH_INTERVAL = 25; // points
const TICKS_PER_POINT = 4;
const TICK_VALUE_MNQ = 0.50; // dollars per tick
const MIN_TP_TICKS = 110;    // minimum TP distance in ticks (27.5 points)

/**
 * Get the nearest psych level above a price
 */
function nextPsychAbove(price) {
  return Math.ceil(price / PSYCH_INTERVAL) * PSYCH_INTERVAL;
}

/**
 * Get the nearest psych level below a price
 */
function nextPsychBelow(price) {
  return Math.floor(price / PSYCH_INTERVAL) * PSYCH_INTERVAL;
}

/**
 * Get all psych levels in a range
 */
function psychLevelsInRange(low, high) {
  const levels = [];
  let level = nextPsychAbove(low);
  while (level <= high) {
    levels.push(level);
    level += PSYCH_INTERVAL;
  }
  return levels;
}

/**
 * Convert points to ticks
 */
function pointsToTicks(points) {
  return Math.round(points * TICKS_PER_POINT);
}

/**
 * Convert ticks to points
 */
function ticksToPoints(ticks) {
  return ticks / TICKS_PER_POINT;
}

/**
 * Convert ticks to dollars (MNQ)
 */
function ticksToDollars(ticks, contracts = 1) {
  return ticks * TICK_VALUE_MNQ * contracts;
}

/**
 * Calculate TP for a LONG trade
 * Returns the first psych level above entry that is >= MIN_TP_TICKS away
 */
function calcTPLong(entryPrice) {
  let level = nextPsychAbove(entryPrice);
  
  // If entry is exactly on a psych level, start from the next one
  if (level === entryPrice) {
    level += PSYCH_INTERVAL;
  }
  
  while (true) {
    const distancePoints = level - entryPrice;
    const distanceTicks = pointsToTicks(distancePoints);
    
    if (distanceTicks >= MIN_TP_TICKS) {
      return {
        price: level,
        distancePoints,
        distanceTicks,
        distanceDollars: ticksToDollars(distanceTicks),
      };
    }
    level += PSYCH_INTERVAL;
    
    // Safety: don't loop forever
    if (level - entryPrice > 500) {
      throw new Error(`No valid TP found for LONG entry at ${entryPrice}`);
    }
  }
}

function calcTPLongSkipLevels(entryPrice, skipLevels = 2) {
  let level = nextPsychAbove(entryPrice);
  if (level === entryPrice) level += PSYCH_INTERVAL;
  level += PSYCH_INTERVAL * skipLevels;

  const distancePoints = level - entryPrice;
  const distanceTicks = pointsToTicks(distancePoints);
  return {
    price: level,
    distancePoints,
    distanceTicks,
    distanceDollars: ticksToDollars(distanceTicks),
  };
}

/**
 * Calculate TP for a SHORT trade
 * Returns the first psych level below entry that is >= MIN_TP_TICKS away
 */
function calcTPShort(entryPrice) {
  let level = nextPsychBelow(entryPrice);
  
  // If entry is exactly on a psych level, start from the next one down
  if (level === entryPrice) {
    level -= PSYCH_INTERVAL;
  }
  
  while (true) {
    const distancePoints = entryPrice - level;
    const distanceTicks = pointsToTicks(distancePoints);
    
    if (distanceTicks >= MIN_TP_TICKS) {
      return {
        price: level,
        distancePoints,
        distanceTicks,
        distanceDollars: ticksToDollars(distanceTicks),
      };
    }
    level -= PSYCH_INTERVAL;
    
    if (entryPrice - level > 500) {
      throw new Error(`No valid TP found for SHORT entry at ${entryPrice}`);
    }
  }
}

function calcTPShortSkipLevels(entryPrice, skipLevels = 2) {
  let level = nextPsychBelow(entryPrice);
  if (level === entryPrice) level -= PSYCH_INTERVAL;
  level -= PSYCH_INTERVAL * skipLevels;

  const distancePoints = entryPrice - level;
  const distanceTicks = pointsToTicks(distancePoints);
  return {
    price: level,
    distancePoints,
    distanceTicks,
    distanceDollars: ticksToDollars(distanceTicks),
  };
}

/**
 * Calculate full TP/SL for a trade (1:1 R:R)
 */
function calcTPSL(entryPrice, direction, options = {}) {
  const { tpMode = 'default', skipLevels = 2 } = options;
  let tp;
  if (tpMode === 'skip2') {
    tp = direction === 'long'
      ? calcTPLongSkipLevels(entryPrice, skipLevels)
      : calcTPShortSkipLevels(entryPrice, skipLevels);
  } else {
    tp = direction === 'long'
      ? calcTPLong(entryPrice)
      : calcTPShort(entryPrice);
  }
  
  const slPrice = direction === 'long'
    ? entryPrice - tp.distancePoints
    : entryPrice + tp.distancePoints;
  
  return {
    entry: entryPrice,
    direction,
    tp: {
      price: tp.price,
      distancePoints: tp.distancePoints,
      distanceTicks: tp.distanceTicks,
      distanceDollars: tp.distanceDollars,
    },
    sl: {
      price: slPrice,
      distancePoints: tp.distancePoints,
      distanceTicks: tp.distanceTicks,
      distanceDollars: tp.distanceDollars,
    },
    riskReward: 1.0,
  };
}

module.exports = {
  PSYCH_INTERVAL,
  TICKS_PER_POINT,
  TICK_VALUE_MNQ,
  MIN_TP_TICKS,
  nextPsychAbove,
  nextPsychBelow,
  psychLevelsInRange,
  pointsToTicks,
  ticksToPoints,
  ticksToDollars,
  calcTPLong,
  calcTPLongSkipLevels,
  calcTPShort,
  calcTPShortSkipLevels,
  calcTPSL,
};
