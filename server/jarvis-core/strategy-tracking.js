'use strict';

const { calcMetrics, calcDrawdown } = require('../engine/stats');
const { runDiscovery, evaluateCandidateWindow } = require('../engine/discovery');
const {
  ORIGINAL_PLAN_SPEC,
  runPlanBacktest,
  buildVariantReports,
} = require('./strategy-layers');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;
const DEFAULT_ROLLING_WINDOWS = Object.freeze([20, 60, 120]);

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function toDateIso(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function parseEtDateTime(text) {
  const src = toText(text);
  if (!src) return null;
  const m = src.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    date: m[1],
    hour: Number(m[2]),
    minute: Number(m[3]),
  };
}

function deriveTimeBucket(entryTime) {
  const parsed = parseEtDateTime(entryTime);
  if (!parsed) return 'unknown';
  const mins = (parsed.hour * 60) + parsed.minute;
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 585) return 'orb_window';
  if (mins < 615) return 'post_orb';
  if (mins <= 659) return 'momentum_window';
  return 'late_window';
}

function getEtWeekday(dateIso) {
  const src = toDateIso(dateIso);
  if (!src) return 'Unknown';
  const d = new Date(`${src}T12:00:00-05:00`);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
    }).format(d);
  } catch {
    return 'Unknown';
  }
}

function inferRegimeForDate(regimeByDate = {}, dateIso = '') {
  const row = regimeByDate && typeof regimeByDate === 'object' ? regimeByDate[dateIso] : null;
  if (!row || typeof row !== 'object') return null;
  return toText(row.regime || row.regime_trend || row.trend || row.volatility || '').toLowerCase() || null;
}

function buildRollingWindows(windowSessions = DEFAULT_WINDOW_SESSIONS) {
  const maxWindow = clampInt(windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const set = new Set();
  for (const w of DEFAULT_ROLLING_WINDOWS) {
    if (w <= maxWindow) set.add(w);
  }
  set.add(maxWindow);
  return Array.from(set).sort((a, b) => a - b);
}

function sliceSessions(sessions = {}, size = DEFAULT_WINDOW_SESSIONS) {
  const dates = Object.keys(sessions || {}).sort();
  const windowSize = clampInt(size, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const selected = dates.slice(Math.max(0, dates.length - windowSize));
  const out = {};
  for (const d of selected) out[d] = Array.isArray(sessions[d]) ? sessions[d] : [];
  return {
    sessions: out,
    dates: selected,
    windowSize,
  };
}

function toPlanSpecFromReport(report = {}) {
  const rules = report?.rules && typeof report.rules === 'object' ? report.rules : {};
  const filters = rules?.filters && typeof rules.filters === 'object' ? rules.filters : {};
  return {
    key: toText(report.key || 'variant'),
    layer: 'variant',
    name: toText(report.name || 'Variant'),
    description: toText(report.description || 'Learned overlay variant'),
    engineOptions: {
      longOnly: rules.longOnly !== false,
      skipMonday: rules.skipMonday === true,
      maxEntryHour: Number.isFinite(Number(rules.maxEntryHour)) ? Number(rules.maxEntryHour) : 11,
      tpMode: toText(rules.tpMode || 'skip2') || 'skip2',
    },
    filters,
  };
}

function chooseBestDiscoveryCandidate(discoveryResult = {}) {
  const candidates = Array.isArray(discoveryResult?.candidates) ? discoveryResult.candidates : [];
  if (!candidates.length) return null;
  const ranked = candidates.slice().sort((a, b) => Number(b?.robustnessScore || 0) - Number(a?.robustnessScore || 0));
  return ranked.find((c) => toText(c?.status).toLowerCase() === 'live_eligible')
    || ranked.find((c) => toText(c?.status).toLowerCase() === 'watchlist')
    || ranked[0]
    || null;
}

function normalizeTradeRecord(trade = {}, dateFallback = '') {
  const pnlTicks = Number(trade?.pnl_ticks);
  const pnlDollars = Number(trade?.pnl_dollars);
  const result = toText(trade?.result).toLowerCase() || 'unknown';
  const date = toDateIso(trade?.date || trade?.entry_time || dateFallback);
  return {
    date,
    result,
    pnl_ticks: Number.isFinite(pnlTicks) ? pnlTicks : 0,
    pnl_dollars: Number.isFinite(pnlDollars) ? pnlDollars : 0,
    direction: toText(trade?.direction).toLowerCase() || 'unknown',
    entry_time: toText(trade?.entry_time || ''),
    exit_time: toText(trade?.exit_time || ''),
  };
}

function collectTradesFromPlanPerDate(perDate = {}, regimeByDate = {}) {
  const out = [];
  for (const [date, row] of Object.entries(perDate || {})) {
    if (!row || row.wouldTrade !== true) continue;
    const trade = normalizeTradeRecord({
      date,
      result: row.tradeResult,
      pnl_ticks: row.tradePnlTicks,
      pnl_dollars: row.tradePnlDollars,
      direction: row.tradeDirection,
      entry_time: row.tradeEntryTime,
      exit_time: row.tradeExitTime,
    }, date);
    trade.weekday = getEtWeekday(trade.date);
    trade.timeBucket = deriveTimeBucket(trade.entry_time);
    trade.regime = inferRegimeForDate(regimeByDate, trade.date);
    out.push(trade);
  }
  return out;
}

function normalizeAlternativeTrades(trades = [], regimeByDate = {}) {
  return (Array.isArray(trades) ? trades : []).map((trade) => {
    const normalized = normalizeTradeRecord(trade, trade?.date);
    normalized.weekday = getEtWeekday(normalized.date);
    normalized.timeBucket = deriveTimeBucket(normalized.entry_time);
    normalized.regime = inferRegimeForDate(regimeByDate, normalized.date);
    return normalized;
  });
}

function buildMetricsFromTrades(trades = [], sessionCount = 0) {
  const metrics = calcMetrics(Array.isArray(trades) ? trades : []);
  const drawdown = calcDrawdown(Array.isArray(trades) ? trades : [], 50000);
  const tradeCount = toNumber(metrics.totalTrades, 0);
  const tradeFrequencyPct = sessionCount > 0 ? round2((tradeCount / sessionCount) * 100) : 0;
  const sampleQuality = tradeCount < 10
    ? 'very_thin'
    : tradeCount < 20
      ? 'thin'
      : tradeCount < 40
        ? 'moderate'
        : 'robust';

  return {
    tradeCount,
    winRate: round2(toNumber(metrics.winRate, 0)),
    profitFactor: round2(toNumber(metrics.profitFactor, 0)),
    expectancy: round2(toNumber(metrics.expectancyDollars, 0)),
    totalPnlDollars: round2(toNumber(metrics.totalPnlDollars, 0)),
    drawdownProxy: round2(toNumber(drawdown?.maxDrawdownDollars, 0)),
    maxConsecLosses: toNumber(metrics.maxConsecLosses, 0),
    tradeFrequencyPct,
    sampleQuality,
  };
}

function scoreMetricsForRanking(metrics = {}) {
  const pf = clamp((toNumber(metrics.profitFactor, 0) - 1) * 60, 0, 100);
  const wr = clamp((toNumber(metrics.winRate, 0) - 40) * 2, 0, 100);
  const freq = clamp(100 - Math.abs(toNumber(metrics.tradeFrequencyPct, 0) - 35) * 2, 10, 100);
  const ddPenalty = clamp((toNumber(metrics.drawdownProxy, 0) / 2000) * 20, 0, 20);
  return round2((pf * 0.45) + (wr * 0.35) + (freq * 0.2) - ddPenalty);
}

function buildWindowComparisons(strategy = {}, sessions = {}, rollingWindows = [], regimeByDate = {}, deps = {}) {
  const windows = [];
  const runPlanBacktestImpl = typeof deps.runPlanBacktest === 'function' ? deps.runPlanBacktest : runPlanBacktest;
  const evaluateCandidateWindowImpl = typeof deps.evaluateCandidateWindow === 'function'
    ? deps.evaluateCandidateWindow
    : evaluateCandidateWindow;

  for (const windowSize of rollingWindows) {
    const sliced = sliceSessions(sessions, windowSize);
    let trades = [];

    if (strategy.strategyType === 'alternative_candidate') {
      const evalOut = evaluateCandidateWindowImpl(sliced.sessions, strategy.candidateRules || {}, {});
      trades = normalizeAlternativeTrades(evalOut?.trades || [], regimeByDate);
    } else {
      const report = runPlanBacktestImpl(sliced.sessions, strategy.planSpec, { includePerDate: true });
      trades = collectTradesFromPlanPerDate(report?.perDate || {}, regimeByDate);
    }

    const metrics = buildMetricsFromTrades(trades, sliced.dates.length);
    windows.push({
      windowSessions: windowSize,
      metrics,
      trades,
      rankingScore: scoreMetricsForRanking(metrics),
    });
  }

  return windows;
}

function getWindowMap(windows = []) {
  const map = new Map();
  for (const row of windows) map.set(Number(row.windowSessions), row);
  return map;
}

function pickPrimaryWindow(windows = []) {
  const map = getWindowMap(windows);
  if (map.has(60)) return map.get(60);
  if (map.has(120)) return map.get(120);
  return windows[windows.length - 1] || null;
}

function buildStabilityAndMomentum(windows = []) {
  const sorted = windows.slice().sort((a, b) => Number(a.windowSessions) - Number(b.windowSessions));
  const pfSeries = sorted.map((w) => toNumber(w?.metrics?.profitFactor, 0)).filter((n) => Number.isFinite(n));
  const wrSeries = sorted.map((w) => toNumber(w?.metrics?.winRate, 0)).filter((n) => Number.isFinite(n));

  const pfSpread = pfSeries.length > 1 ? Math.max(...pfSeries) - Math.min(...pfSeries) : 0;
  const wrSpread = wrSeries.length > 1 ? Math.max(...wrSeries) - Math.min(...wrSeries) : 0;
  const stabilityScore = round2(clamp(100 - (pfSpread * 25) - (wrSpread * 1.6), 0, 100));

  let momentumOfPerformance = 'stable';
  if (sorted.length >= 2) {
    const shortRow = sorted[0];
    const longRow = sorted[sorted.length - 1];
    const shortScore = scoreMetricsForRanking(shortRow.metrics);
    const longScore = scoreMetricsForRanking(longRow.metrics);
    const delta = shortScore - longScore;
    if (delta >= 8) momentumOfPerformance = 'improving';
    else if (delta <= -8) momentumOfPerformance = 'weakening';
    else if (Math.abs(delta) <= 3.5) momentumOfPerformance = 'stable';
    else momentumOfPerformance = 'volatile';
  }

  return {
    stabilityScore,
    momentumOfPerformance,
  };
}

function aggregateContextRows(trades = [], keyName = 'weekday') {
  const buckets = new Map();
  for (const trade of trades) {
    const key = toText(trade?.[keyName] || 'unknown') || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(trade);
  }
  const rows = [];
  for (const [context, list] of buckets.entries()) {
    const metrics = buildMetricsFromTrades(list, list.length);
    rows.push({
      context,
      tradeCount: metrics.tradeCount,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      expectancy: metrics.expectancy,
      drawdownProxy: metrics.drawdownProxy,
      score: scoreMetricsForRanking(metrics),
    });
  }
  rows.sort((a, b) => String(a.context).localeCompare(String(b.context)));
  return rows;
}

function buildContextPerformance(primaryTrades = [], includeContext = true) {
  if (!includeContext) {
    return {
      weekday: { available: false, rows: [] },
      timeBucket: { available: false, rows: [] },
      regime: { available: false, rows: [] },
    };
  }
  const weekdayRows = aggregateContextRows(primaryTrades, 'weekday');
  const timeRows = aggregateContextRows(primaryTrades, 'timeBucket');
  const regimeRows = aggregateContextRows(primaryTrades.filter((t) => toText(t?.regime)), 'regime');
  return {
    weekday: { available: true, rows: weekdayRows },
    timeBucket: { available: true, rows: timeRows },
    regime: { available: regimeRows.length > 0, rows: regimeRows },
  };
}

function contextRowMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = toText(row?.context);
    if (!key) continue;
    map.set(key, row);
  }
  return map;
}

function enrichDominanceLabels(trackedStrategies = [], includeContext = true) {
  if (!includeContext) {
    return trackedStrategies.map((row) => ({
      ...row,
      dominantContexts: [],
      weakContexts: [],
      contextDominanceLabel: 'not_requested',
    }));
  }

  const byKey = new Map(trackedStrategies.map((row) => [row.strategyKey, row]));
  const dimensions = ['weekday', 'timeBucket', 'regime'];
  const dominant = new Map();
  const weak = new Map();
  for (const row of trackedStrategies) {
    dominant.set(row.strategyKey, []);
    weak.set(row.strategyKey, []);
  }

  for (const dim of dimensions) {
    const allContexts = new Set();
    const maps = new Map();
    for (const row of trackedStrategies) {
      const rows = row?.contextPerformance?.[dim]?.rows || [];
      const m = contextRowMap(rows);
      maps.set(row.strategyKey, m);
      for (const key of m.keys()) allContexts.add(key);
    }

    for (const context of allContexts) {
      const comparables = [];
      for (const row of trackedStrategies) {
        const found = maps.get(row.strategyKey)?.get(context);
        if (!found) continue;
        if (toNumber(found.tradeCount, 0) < 4) continue;
        comparables.push({
          strategyKey: row.strategyKey,
          score: toNumber(found.score, 0),
        });
      }
      if (comparables.length < 2) continue;
      comparables.sort((a, b) => b.score - a.score);
      const leader = comparables[0];
      const lagger = comparables[comparables.length - 1];
      dominant.get(leader.strategyKey).push(`${dim}:${context}`);
      weak.get(lagger.strategyKey).push(`${dim}:${context}`);
    }
  }

  return trackedStrategies.map((row) => {
    const d = dominant.get(row.strategyKey) || [];
    const w = weak.get(row.strategyKey) || [];
    let label = 'neutral';
    if (d.length >= 2) label = 'context_specific_dominant';
    if (w.length >= 2 && d.length === 0) label = 'context_weak';
    return {
      ...row,
      dominantContexts: d,
      weakContexts: w,
      contextDominanceLabel: label,
    };
  });
}

function buildRelativeComparison(metrics = {}, base = {}) {
  return {
    relativePnL: round2(toNumber(metrics.totalPnlDollars, 0) - toNumber(base.totalPnlDollars, 0)),
    relativeWinRate: round2(toNumber(metrics.winRate, 0) - toNumber(base.winRate, 0)),
    relativeProfitFactor: round2(toNumber(metrics.profitFactor, 0) - toNumber(base.profitFactor, 0)),
    relativeTradeFrequency: round2(toNumber(metrics.tradeFrequencyPct, 0) - toNumber(base.tradeFrequencyPct, 0)),
  };
}

function assignTrackingStatus(strategy = {}, bestKey = '', baseMetrics = {}) {
  if (strategy.strategyType === 'original_plan') return 'baseline';

  const primaryMetrics = strategy.primaryMetrics || {};
  const sampleQuality = toText(primaryMetrics.sampleQuality).toLowerCase();
  const thin = sampleQuality === 'very_thin' || sampleQuality === 'thin';
  if (thin) return 'low_confidence';

  const rel = strategy.vsOriginal || {};
  if (strategy.momentumOfPerformance === 'weakening'
      && toNumber(rel.relativeProfitFactor, 0) < 0
      && toNumber(rel.relativeWinRate, 0) < 0) {
    return 'weakening_candidate';
  }

  if (strategy.strategyKey === bestKey
      && toNumber(rel.relativeProfitFactor, 0) > 0
      && toNumber(rel.relativeWinRate, 0) >= 0
      && toNumber(strategy.stabilityScore, 0) >= 60) {
    return 'strong_alternative';
  }

  if (strategy.contextDominanceLabel === 'context_specific_dominant') return 'context_specific_alternative';
  return 'monitor_closely';
}

function buildLeaderReason(leader = null, original = null) {
  if (!leader) return 'No tracked strategy has enough evidence yet.';
  if (leader.strategyType === 'original_plan') {
    return `Original plan leads tracked score right now (PF ${round2(leader.primaryMetrics?.profitFactor || 0)}, WR ${round2(leader.primaryMetrics?.winRate || 0)}%).`;
  }
  const rel = leader?.vsOriginal || {};
  return `${leader.strategyName} leads tracked score with PF delta ${round2(rel.relativeProfitFactor || 0)} and WR delta ${round2(rel.relativeWinRate || 0)} vs original.`;
}

function classifyHandoffState(leader = null) {
  if (!leader || leader.strategyType === 'original_plan') return 'keep_original_plan_baseline';
  if (leader.trackingStatus === 'strong_alternative') return 'alternative_worth_side_by_side_tracking';
  if (leader.trackingStatus === 'context_specific_alternative') return 'alternative_context_only';
  return 'insufficient_evidence_to_shift';
}

function buildTrackingInsight(summary = {}) {
  const leader = summary?.bestTrackedStrategyNow;
  const handoff = toText(summary?.recommendationHandoffState).toLowerCase();
  if (!leader) return 'No clear tracked leader yet; keep baseline and continue evidence collection.';
  if (leader.strategyType === 'original_plan') {
    return 'Original plan remains strongest across tracked windows right now.';
  }
  if (handoff === 'alternative_context_only') {
    return `${leader.strategyName} is outperforming in specific contexts but not globally dominant.`;
  }
  if (handoff === 'alternative_worth_side_by_side_tracking') {
    return `${leader.strategyName} is a strong side-by-side tracking candidate, still advisory only.`;
  }
  return `${leader.strategyName} is interesting, but evidence is not yet strong enough to shift baseline confidence.`;
}

function buildTrackedSet(sessions = {}, deps = {}) {
  const runPlanBacktestImpl = typeof deps.runPlanBacktest === 'function' ? deps.runPlanBacktest : runPlanBacktest;
  const buildVariantReportsImpl = typeof deps.buildVariantReports === 'function' ? deps.buildVariantReports : buildVariantReports;
  const runDiscoveryImpl = typeof deps.runDiscovery === 'function' ? deps.runDiscovery : runDiscovery;

  const originalPlan = {
    strategyKey: ORIGINAL_PLAN_SPEC.key,
    strategyName: ORIGINAL_PLAN_SPEC.name,
    strategyType: 'original_plan',
    sourceLayer: 'original',
    advisoryOnly: true,
    planSpec: ORIGINAL_PLAN_SPEC,
    availability: 'available',
  };

  const variants = buildVariantReportsImpl(sessions, { includePerDate: false }) || {};
  const bestVariantReport = variants?.best || null;
  const bestVariant = bestVariantReport
    ? {
      strategyKey: toText(bestVariantReport.key),
      strategyName: toText(bestVariantReport.name),
      strategyType: 'learned_variant',
      sourceLayer: 'variant',
      advisoryOnly: true,
      planSpec: toPlanSpecFromReport(bestVariantReport),
      availability: 'available',
    }
    : {
      strategyKey: 'variant_unavailable',
      strategyName: 'Best Variant Unavailable',
      strategyType: 'learned_variant',
      sourceLayer: 'variant',
      advisoryOnly: true,
      availability: 'unavailable',
      unavailableReason: 'No variant report available for current dataset.',
    };

  const discoveryResult = runDiscoveryImpl(sessions, {
    mode: 'two_stage',
    maxCandidates: 40,
    stage1Budget: 20,
    seedTopK: 10,
  }) || {};
  const bestCandidate = chooseBestDiscoveryCandidate(discoveryResult);
  const alternative = bestCandidate
    ? {
      strategyKey: toText(bestCandidate.key),
      strategyName: toText(bestCandidate.name),
      strategyType: 'alternative_candidate',
      sourceLayer: 'discovery',
      advisoryOnly: true,
      candidateRules: bestCandidate.rules || {},
      candidateStatus: toText(bestCandidate.status).toLowerCase() || 'unknown',
      candidateConfidence: toText(bestCandidate.confidence).toLowerCase() || 'low',
      availability: 'available',
    }
    : {
      strategyKey: 'alternative_unavailable',
      strategyName: 'Best Alternative Unavailable',
      strategyType: 'alternative_candidate',
      sourceLayer: 'discovery',
      advisoryOnly: true,
      availability: 'unavailable',
      unavailableReason: 'No discovery candidate available for current dataset.',
    };

  return {
    tracked: [originalPlan, bestVariant, alternative],
    discoveryResult,
  };
}

function buildStrategyTrackingSummary(input = {}) {
  const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object' ? input.regimeByDate : {};
  const includeContext = input.includeContext !== false;
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const rollingWindows = buildRollingWindows(windowSessions);

  const trackedSet = buildTrackedSet(sessions, input.deps || {});
  const tracked = [];

  for (const strategy of trackedSet.tracked) {
    if (strategy.availability !== 'available') {
      tracked.push({
        ...strategy,
        rollingWindowSummary: [],
        recentPerformanceWindow: null,
        primaryWindow: null,
        primaryMetrics: {
          tradeCount: 0,
          winRate: 0,
          profitFactor: 0,
          expectancy: 0,
          drawdownProxy: 0,
          tradeFrequencyPct: 0,
          sampleQuality: 'very_thin',
        },
        stabilityScore: 0,
        momentumOfPerformance: 'stable',
        contextPerformance: {
          weekday: { available: false, rows: [] },
          timeBucket: { available: false, rows: [] },
          regime: { available: false, rows: [] },
        },
      });
      continue;
    }

    const windows = buildWindowComparisons(strategy, sessions, rollingWindows, regimeByDate, input.deps || {});
    const primaryWindow = pickPrimaryWindow(windows);
    const primaryTrades = Array.isArray(primaryWindow?.trades) ? primaryWindow.trades : [];
    const stability = buildStabilityAndMomentum(windows);

    tracked.push({
      ...strategy,
      rollingWindowSummary: windows.map((w) => ({
        windowSessions: w.windowSessions,
        tradeCount: w.metrics.tradeCount,
        winRate: w.metrics.winRate,
        profitFactor: w.metrics.profitFactor,
        expectancy: w.metrics.expectancy,
        drawdownProxy: w.metrics.drawdownProxy,
        tradeFrequencyPct: w.metrics.tradeFrequencyPct,
        sampleQuality: w.metrics.sampleQuality,
        advisoryOnly: true,
      })),
      recentPerformanceWindow: windows[0]
        ? {
          windowSessions: windows[0].windowSessions,
          metrics: windows[0].metrics,
        }
        : null,
      primaryWindow: Number(primaryWindow?.windowSessions || 0) || null,
      primaryMetrics: primaryWindow?.metrics || {
        tradeCount: 0,
        winRate: 0,
        profitFactor: 0,
        expectancy: 0,
        drawdownProxy: 0,
        tradeFrequencyPct: 0,
        sampleQuality: 'very_thin',
      },
      stabilityScore: stability.stabilityScore,
      momentumOfPerformance: stability.momentumOfPerformance,
      contextPerformance: buildContextPerformance(primaryTrades, includeContext),
      advisoryOnly: true,
    });
  }

  const enriched = enrichDominanceLabels(tracked, includeContext);
  const original = enriched.find((row) => row.strategyType === 'original_plan') || null;
  const originalMetrics = original?.primaryMetrics || {};

  const rankScore = (row = {}) => {
    return scoreMetricsForRanking(row.primaryMetrics || {}) + (toNumber(row.stabilityScore, 0) * 0.08);
  };
  const rankedAll = enriched.slice().sort((a, b) => rankScore(b) - rankScore(a));
  const rankedQualified = enriched
    .filter((row) => row.availability === 'available' && toText(row?.primaryMetrics?.sampleQuality).toLowerCase() !== 'very_thin')
    .sort((a, b) => rankScore(b) - rankScore(a));
  const bestNow = rankedQualified[0] || rankedAll[0] || null;
  const bestMetrics = bestNow?.primaryMetrics || {};

  const compared = enriched.map((row) => {
    const rowMetrics = row.primaryMetrics || {};
    const vsOriginal = buildRelativeComparison(rowMetrics, originalMetrics);
    const vsBestTracked = buildRelativeComparison(rowMetrics, bestMetrics);
    return {
      ...row,
      vsOriginal,
      vsBestTracked,
    };
  });

  const bestKey = bestNow?.strategyKey || '';
  const finalTracked = compared.map((row) => ({
    ...row,
    trackingStatus: assignTrackingStatus(row, bestKey, originalMetrics),
  }));

  const finalLeader = finalTracked.find((row) => row.strategyKey === bestKey) || null;
  const handoff = classifyHandoffState(finalLeader);
  const windowsUsed = rollingWindows.slice();

  const warnings = [];
  for (const row of finalTracked) {
    if (row.availability !== 'available') warnings.push(`${row.strategyType}_unavailable`);
    if (toText(row.primaryMetrics?.sampleQuality).toLowerCase() === 'very_thin') warnings.push(`${row.strategyType}_very_thin_sample`);
    if (row.trackingStatus === 'weakening_candidate') warnings.push(`${row.strategyType}_weakening`);
  }

  const contextCoverage = {
    weekdayBuckets: finalTracked.reduce((sum, row) => sum + toNumber(row?.contextPerformance?.weekday?.rows?.length, 0), 0),
    timeBucketBuckets: finalTracked.reduce((sum, row) => sum + toNumber(row?.contextPerformance?.timeBucket?.rows?.length, 0), 0),
    regimeBuckets: finalTracked.reduce((sum, row) => sum + toNumber(row?.contextPerformance?.regime?.rows?.length, 0), 0),
    includeContext,
  };

  const dataQuality = {
    isThinSample: warnings.some((w) => /thin|unavailable/.test(w)),
    warnings: Array.from(new Set(warnings)),
    windowsUsed,
    contextCoverage,
  };

  return {
    generatedAt: new Date().toISOString(),
    trackedStrategies: finalTracked.map((row) => ({
      strategyKey: row.strategyKey,
      strategyName: row.strategyName,
      strategyType: row.strategyType,
      sourceLayer: row.sourceLayer,
      advisoryOnly: true,
      availability: row.availability,
      unavailableReason: row.unavailableReason || null,
      rollingWindowSummary: row.rollingWindowSummary,
      recentPerformanceWindow: row.recentPerformanceWindow,
      primaryWindow: row.primaryWindow,
      primaryMetrics: row.primaryMetrics,
      stabilityScore: row.stabilityScore,
      momentumOfPerformance: row.momentumOfPerformance,
      dominantContexts: row.dominantContexts,
      weakContexts: row.weakContexts,
      contextDominanceLabel: row.contextDominanceLabel,
      contextPerformance: row.contextPerformance,
      vsOriginal: row.vsOriginal,
      vsBestTracked: row.vsBestTracked,
      trackingStatus: row.trackingStatus,
    })),
    bestTrackedStrategyNow: finalLeader
      ? {
        strategyKey: finalLeader.strategyKey,
        strategyName: finalLeader.strategyName,
        strategyType: finalLeader.strategyType,
        trackingStatus: finalLeader.trackingStatus,
        stabilityScore: finalLeader.stabilityScore,
        momentumOfPerformance: finalLeader.momentumOfPerformance,
        advisoryOnly: true,
      }
      : null,
    bestTrackedStrategyReason: buildLeaderReason(finalLeader, original),
    recommendationHandoffState: handoff,
    trackingInsight: buildTrackingInsight({
      bestTrackedStrategyNow: finalLeader,
      recommendationHandoffState: handoff,
    }),
    trackedLeader: finalLeader?.strategyName || null,
    trackedLeaderConfidence: toText(finalLeader?.primaryMetrics?.sampleQuality || '').toLowerCase() || null,
    dataQuality,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  buildRollingWindows,
  buildStrategyTrackingSummary,
};
