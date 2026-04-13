/**
 * McNair Mindset by 3130
 * Regime Classifier
 * 
 * Classifies each trading session across multiple dimensions
 * to enable regime-based filtering and analysis.
 */

const { pointsToTicks } = require('./psych-levels');

/**
 * Classify a session's regime from its candle data.
 * 
 * @param {Array} candles - 5-min RTH candles for the session
 * @param {Object} orb - { high, low, range_ticks }
 * @param {Object} prevSession - Previous session data (for gap calc)
 * @returns {Object} Regime classification
 */
function classifyRegime(candles, orb, prevSession = null) {
  if (!candles || candles.length === 0) return null;

  const opens = candles.map(c => c.open);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const sessionHigh = Math.max(...highs);
  const sessionLow = Math.min(...lows);
  const sessionOpen = opens[0];
  const sessionClose = closes[closes.length - 1];
  const sessionRange = sessionHigh - sessionLow;
  const sessionRangeTicks = pointsToTicks(sessionRange);

  // 1. TREND classification
  const regime_trend = classifyTrend(candles, sessionOpen, sessionClose, sessionRange);

  // 2. VOLATILITY classification (based on session range)
  const regime_vol = classifyVolatility(sessionRangeTicks);

  // 3. GAP classification
  const regime_gap = classifyGap(sessionOpen, prevSession);

  // 4. ORB SIZE classification
  const regime_orb_size = classifyOrbSize(orb ? orb.range_ticks : 0);

  // 5. Day of week
  const date = candles[0].date || candles[0].timestamp.split(' ')[0];
  const [ry, rm, rd] = date.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(ry, rm - 1, rd)).getUTCDay();
  const adjDow = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0

  // 6. First 15 min post-ORB behavior
  const first15min = classifyFirst15(candles, orb);

  // 7. Session type (AM range vs PM range)
  const sessionType = classifySessionType(candles);

  return {
    regime_trend,
    regime_vol,
    regime_gap,
    regime_orb_size,
    day_of_week: adjDow,
    first_15min: first15min,
    session_type: sessionType,
    // Raw metrics for fingerprinting
    metrics: {
      session_range_ticks: sessionRangeTicks,
      orb_range_ticks: orb ? orb.range_ticks : 0,
      gap_ticks: prevSession ? pointsToTicks(sessionOpen - prevSession.close) : 0,
      open: sessionOpen,
      close: sessionClose,
      high: sessionHigh,
      low: sessionLow,
      close_vs_open: sessionClose > sessionOpen ? 'up' : sessionClose < sessionOpen ? 'down' : 'flat',
      close_position: sessionRange > 0 ? ((sessionClose - sessionLow) / sessionRange) : 0.5,
    },
  };
}

function classifyTrend(candles, open, close, range) {
  if (range === 0) return 'flat';
  
  const movePercent = Math.abs(close - open) / range;
  
  // Count directional candles
  let upCandles = 0, downCandles = 0;
  for (const c of candles) {
    if (c.close > c.open) upCandles++;
    else if (c.close < c.open) downCandles++;
  }
  const directionalRatio = Math.max(upCandles, downCandles) / candles.length;

  // Strong directional move + directional candle majority = trending
  if (movePercent > 0.5 && directionalRatio > 0.55) return 'trending';
  
  // Check for chop: many reversals
  let reversals = 0;
  for (let i = 2; i < candles.length; i++) {
    const prev = candles[i-1].close - candles[i-1].open;
    const curr = candles[i].close - candles[i].open;
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) reversals++;
  }
  const reversalRate = candles.length > 2 ? reversals / (candles.length - 2) : 0;
  
  if (reversalRate > 0.55) return 'choppy';
  return 'ranging';
}

function classifyVolatility(rangeTicks) {
  // Based on typical MNQ daily ranges
  if (rangeTicks < 200) return 'low';
  if (rangeTicks < 500) return 'normal';
  if (rangeTicks < 800) return 'high';
  return 'extreme';
}

function classifyGap(sessionOpen, prevSession) {
  if (!prevSession || !prevSession.close) return 'flat';
  
  const gapPoints = sessionOpen - prevSession.close;
  const gapTicks = pointsToTicks(gapPoints);
  
  if (gapTicks > 100) return 'gap_up_large';
  if (gapTicks > 30) return 'gap_up_small';
  if (gapTicks < -100) return 'gap_down_large';
  if (gapTicks < -30) return 'gap_down_small';
  return 'flat';
}

function classifyOrbSize(orbRangeTicks) {
  if (orbRangeTicks < 60) return 'narrow';
  if (orbRangeTicks < 200) return 'normal';
  return 'wide';
}

function classifyFirst15(candles, orb) {
  if (!orb) return 'unknown';
  
  // Find candles in 9:45-10:00 window (first 3 post-ORB candles)
  const first15 = candles.filter(c => {
    const [h, m] = (c.time || c.timestamp.split(' ')[1]).split(':').map(Number);
    const mins = h * 60 + m;
    return mins >= 585 && mins < 600; // 9:45 to 10:00
  });

  if (first15.length === 0) return 'unknown';

  const lastClose = first15[first15.length - 1].close;
  
  if (lastClose > orb.high) return 'continuation_up';
  if (lastClose < orb.low) return 'continuation_down';
  return 'inside';
}

function classifySessionType(candles) {
  if (candles.length < 20) return 'unknown';
  
  const midIdx = Math.floor(candles.length / 2);
  const amCandles = candles.slice(0, midIdx);
  const pmCandles = candles.slice(midIdx);
  
  const amRange = Math.max(...amCandles.map(c => c.high)) - Math.min(...amCandles.map(c => c.low));
  const pmRange = Math.max(...pmCandles.map(c => c.high)) - Math.min(...pmCandles.map(c => c.low));
  
  if (amRange > pmRange * 1.5) return 'am_dominant';
  if (pmRange > amRange * 1.5) return 'pm_dominant';
  return 'balanced';
}

module.exports = { classifyRegime };
