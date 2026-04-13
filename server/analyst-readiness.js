'use strict';

function parseMinutesFromHHMM(text, fallback = null) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mins = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + mins;
}

function humanizePatternLabel(raw) {
  const txt = String(raw || '').trim().toLowerCase();
  if (!txt) return 'mixed';
  return txt.replace(/_/g, ' ');
}

function computeTrendLabel(pattern = {}) {
  const patternLabel = String(pattern.patternLabel || '').toLowerCase();
  const trendTicks30 = Number(pattern.trendTicks30);
  if (/bullish/.test(patternLabel)) return 'Bullish continuation';
  if (/bearish/.test(patternLabel)) return 'Bearish continuation';
  if (/compression/.test(patternLabel)) return 'Compression';
  if (/balance/.test(patternLabel)) return 'Balanced / sideways';
  if (Number.isFinite(trendTicks30) && trendTicks30 >= 24) return 'Uptrend';
  if (Number.isFinite(trendTicks30) && trendTicks30 <= -24) return 'Downtrend';
  return 'Mixed / transitional';
}

function computeBiasLabel(pattern = {}) {
  const momentum = String(pattern.momentumLabel || '').toLowerCase();
  const trendTicks30 = Number(pattern.trendTicks30);
  if (momentum === 'bullish') return 'Bullish tilt';
  if (momentum === 'bearish') return 'Bearish tilt';
  if (Number.isFinite(trendTicks30) && trendTicks30 >= 24) return 'Bullish tilt';
  if (Number.isFinite(trendTicks30) && trendTicks30 <= -24) return 'Bearish tilt';
  return 'Neutral / two-way';
}

function computeRegimeLabel(decision = {}, pattern = {}, freshnessGate = {}) {
  if (freshnessGate.orbPre945) return 'Pre-ORB (opening range still forming)';
  const orbTicks = Number(decision.orbRangeTicks);
  if (Number.isFinite(orbTicks)) {
    if (orbTicks > 400) return `Exhaustion (${Math.round(orbTicks)} ticks)`;
    if (orbTicks > 220) return `Expanded ORB (${Math.round(orbTicks)} ticks)`;
    if (orbTicks >= 70) return `Golden Zone ORB (${Math.round(orbTicks)} ticks)`;
    return `Compressed ORB (${Math.round(orbTicks)} ticks)`;
  }
  return humanizePatternLabel(pattern.patternLabel || 'mixed');
}

function buildOrbImplicationLine(decision = {}, freshnessGate = {}) {
  if (freshnessGate.needsFreshData) {
    return 'I need fresh today bars first; then I can score ORB quality.';
  }
  if (freshnessGate.orbPre945) {
    return "ORB is not complete until 9:45 ET, so treat early range reads as preliminary.";
  }
  const orbTicks = Number(decision.orbRangeTicks);
  if (!Number.isFinite(orbTicks)) {
    return 'Wait for a confirmed ORB range before committing to the setup.';
  }
  if (orbTicks > 220) {
    return 'Range is outside your strongest 70 to 220 zone, so fakeout risk is higher.';
  }
  if (orbTicks >= 70) {
    return 'Range is in your strongest historical zone; focus on clean trigger quality.';
  }
  return 'Range is very tight, so avoid forcing breakouts without clear follow-through.';
}

function evaluateMarketDataFreshnessGate(input = {}) {
  const nowEt = input.nowEt || { date: null, time: null };
  const marketDataFreshness = input.marketDataFreshness || {};
  const staleThresholdMinutes = Number.isFinite(Number(input.staleThresholdMinutes))
    ? Math.max(1, Math.min(30, Number(input.staleThresholdMinutes)))
    : 5;
  const hasTodaySessionBars = marketDataFreshness.hasTodaySessionBars === true;
  const hasORBComplete = marketDataFreshness.hasORBComplete === true;
  const sessionDateOfData = String(marketDataFreshness.sessionDateOfData || '').trim() || null;
  const minutesSinceLastCandle = Number(marketDataFreshness.minutesSinceLastCandle);
  const nowMinutes = parseMinutesFromHHMM(nowEt.time, null);
  const inRth = Number.isFinite(nowMinutes) && nowMinutes >= 570 && nowMinutes <= 960;
  const orbPre945 = Number.isFinite(nowMinutes) && nowMinutes < 585;
  const price = Number(input.lastPrice);
  const priceInvalid = !Number.isFinite(price) || price <= 0;
  const staleByLag = inRth && Number.isFinite(minutesSinceLastCandle) && minutesSinceLastCandle > staleThresholdMinutes;
  const sessionMismatch = !!(nowEt.date && sessionDateOfData && sessionDateOfData !== nowEt.date);
  const needsFreshData = !hasTodaySessionBars || priceInvalid || staleByLag || sessionMismatch;
  return {
    nowEt,
    staleThresholdMinutes,
    hasTodaySessionBars,
    hasORBComplete,
    sessionDateOfData,
    minutesSinceLastCandle: Number.isFinite(minutesSinceLastCandle) ? minutesSinceLastCandle : null,
    inRth,
    orbPre945,
    priceInvalid,
    staleByLag,
    sessionMismatch,
    needsFreshData,
  };
}

function buildFreshDataUnavailableReply(input = {}) {
  const readiness = input.readiness || {};
  const lastUpdateText = String(input.lastUpdateText || 'not available');
  const lines = [
    `I don't have fresh MNQ session data for today yet (last update: ${lastUpdateText}).`,
    "Until I have today's bars, I can't confirm today's ORB range or trend.",
  ];
  if (readiness.orbPre945) {
    lines.push("It's before 9:45 ET, so today's opening range is not complete yet.");
  }
  lines.push("At 9:45 ET I'll compute ORB size; if OR > 220 ticks, stand down.");
  lines.push('If data sync recovers, ask again.');
  return lines.join('\n');
}

function buildTrendRegimeReply(input = {}) {
  const decision = input.decision || {};
  const pattern = input.pattern || {};
  const readiness = input.readiness || {};
  if (readiness.needsFreshData) {
    const guard = buildFreshDataUnavailableReply({
      readiness,
      lastUpdateText: input.lastUpdateText || 'not available',
    });
    return [
      guard,
      'Trend: unavailable until fresh today bars arrive.',
      'Regime: unavailable until ORB is confirmed.',
      'Volatility: unavailable from stale feed.',
      'Bias: neutral until live data updates.',
      'What it means for ORB: wait for fresh data, then score ORB size after 9:45 ET.',
    ].join('\n');
  }
  const trend = computeTrendLabel(pattern);
  const regime = computeRegimeLabel(decision, pattern, readiness);
  const volatility = String(pattern.volatilityRegime || 'unknown').replace(/_/g, ' ');
  const bias = computeBiasLabel(pattern);
  const orbImplication = buildOrbImplicationLine(decision, readiness);
  return [
    `Trend: ${trend}.`,
    `Regime: ${regime}.`,
    `Volatility: ${volatility}.`,
    `Bias: ${bias}.`,
    `What it means for ORB: ${orbImplication}`,
  ].join('\n');
}

module.exports = {
  evaluateMarketDataFreshnessGate,
  buildFreshDataUnavailableReply,
  buildTrendRegimeReply,
};
