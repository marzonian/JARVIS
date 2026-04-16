'use strict';

const { processSession } = require('../engine/orb');
const { calcMetrics, calcDrawdown } = require('../engine/stats');
const { runDiscovery } = require('../engine/discovery');
const { buildTodayRecommendation } = require('./today-recommendation');
const { buildDecisionBoard } = require('./decision-board');

const ORIGINAL_PLAN_SPEC = Object.freeze({
  key: 'original_plan_orb_3130',
  layer: 'original',
  name: 'Original Trading Plan',
  description: 'Actual live ORB plan (no Monday skip and no ORB size filter).',
  engineOptions: Object.freeze({
    longOnly: true,
    skipMonday: false,
    maxEntryHour: 11,
    tpMode: 'skip2',
  }),
  filters: Object.freeze({}),
});

const DEFAULT_VARIANT_SPECS = Object.freeze([
  {
    key: 'variant_orb_70_220',
    layer: 'variant',
    name: 'ORB 70-220 Filter',
    description: 'Only take sessions where ORB range is between 70 and 220 ticks.',
    engineOptions: { longOnly: true, skipMonday: false, maxEntryHour: 11, tpMode: 'skip2' },
    filters: { orbRange: { min: 70, max: 220 } },
  },
  {
    key: 'variant_skip_monday',
    layer: 'variant',
    name: 'Skip Monday',
    description: 'Skip Monday sessions to reduce early-week noise.',
    engineOptions: { longOnly: true, skipMonday: false, maxEntryHour: 11, tpMode: 'skip2' },
    filters: { skipMonday: true },
  },
  {
    key: 'variant_earlier_window',
    layer: 'variant',
    name: 'Max Entry Hour 10',
    description: 'Require confirmation before 10:59 ET.',
    engineOptions: { longOnly: true, skipMonday: false, maxEntryHour: 10, tpMode: 'skip2' },
    filters: {},
  },
  {
    key: 'variant_nearest_tp',
    layer: 'variant',
    name: 'Nearest TP',
    description: 'Use nearest psych-level TP target.',
    engineOptions: { longOnly: true, skipMonday: false, maxEntryHour: 11, tpMode: 'default' },
    filters: {},
  },
  {
    key: 'variant_orb_80_220_skip_monday',
    layer: 'variant',
    name: 'ORB 80-220 + Skip Monday',
    description: 'Combined day and volatility filter overlay.',
    engineOptions: { longOnly: true, skipMonday: false, maxEntryHour: 11, tpMode: 'skip2' },
    filters: { skipMonday: true, orbRange: { min: 80, max: 220 } },
  },
]);

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function toIntInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toDateIso(dateLike) {
  const txt = String(dateLike || '').trim();
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function getEtDayName(dateIso) {
  const src = toDateIso(dateIso);
  if (!src) return '';
  const d = new Date(`${src}T12:00:00-05:00`);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
    }).format(d);
  } catch {
    return '';
  }
}

function parseEtDateTime(dateTime) {
  const txt = String(dateTime || '').trim();
  if (!txt) return null;
  const m = txt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    date: m[1],
    hour: Number(m[2]),
    minute: Number(m[3]),
  };
}

function toMinutes(hour, minute) {
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour * 60) + minute;
}

function formatPercent(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return round2(n);
}

function formatTimeBucketLabel(bucketId) {
  const id = String(bucketId || '').trim().toLowerCase();
  if (id === 'orb_window') return '9:30-9:45 ET ORB';
  if (id === 'post_orb') return '9:45-10:15 ET';
  if (id === 'momentum_window') return '10:15-10:59 ET';
  if (id === 'late_window') return 'After 11:00 ET';
  return 'Unknown time bucket';
}

function deriveTimeBucketFromEt(hour, minute) {
  const mins = toMinutes(hour, minute);
  if (!Number.isFinite(mins)) return { id: 'unknown', label: formatTimeBucketLabel('unknown') };
  if (mins < 585) return { id: 'orb_window', label: formatTimeBucketLabel('orb_window') };
  if (mins < 615) return { id: 'post_orb', label: formatTimeBucketLabel('post_orb') };
  if (mins <= 659) return { id: 'momentum_window', label: formatTimeBucketLabel('momentum_window') };
  return { id: 'late_window', label: formatTimeBucketLabel('late_window') };
}

function deriveReferenceContext(nowEtValue) {
  const raw = String(nowEtValue || '').trim();
  const parsed = parseEtDateTime(raw);
  if (!parsed) return null;
  const dayName = getEtDayName(parsed.date);
  const bucket = deriveTimeBucketFromEt(parsed.hour, parsed.minute);
  return {
    date: parsed.date,
    dayName,
    dayNameLower: String(dayName || '').trim().toLowerCase(),
    bucketId: bucket.id,
    bucketLabel: bucket.label,
  };
}

function summarizeTemporalStats(samples = 0, wins = 0) {
  const n = Number(samples || 0);
  const w = Number(wins || 0);
  return {
    samples: n,
    wins: w,
    winRate: n > 0 ? round2((w / n) * 100) : null,
  };
}

function inferSessionDateFromCandles(candles = []) {
  const first = candles[0];
  const ts = String(first?.timestamp || '').trim();
  return toDateIso(ts);
}

function scoreStrategy(report = {}) {
  const metrics = report.metrics || {};
  const drawdown = report.drawdown || {};
  const summary = report.summary || {};
  const totalTrades = Number(metrics.totalTrades || 0);
  if (totalTrades <= 0) return 0;
  const pfScore = clampNumber((Number(metrics.profitFactor || 0) / 2.5) * 42, 0, 42);
  const wrScore = clampNumber((Number(metrics.winRate || 0) / 70) * 24, 0, 24);
  const expScore = clampNumber(((Number(metrics.expectancyDollars || 0) + 20) / 80) * 18, 0, 18);
  const ddPenalty = clampNumber((Number(drawdown.maxDrawdownDollars || 0) / 2500) * 10, 0, 10);
  const freqScore = clampNumber((Number(summary.tradeFrequencyPct || 0) / 65) * 8, 0, 8);
  const sampleScore = clampNumber((totalTrades / 120) * 8, 0, 8);
  return round2(pfScore + wrScore + expScore + freqScore + sampleScore - ddPenalty);
}

function applyPlanFilters({ date, sessionResult, spec }) {
  const filters = spec?.filters && typeof spec.filters === 'object' ? spec.filters : {};
  const blocked = [];
  const orbTicks = Number(sessionResult?.orb?.range_ticks);

  if (filters.skipMonday === true && getEtDayName(date).toLowerCase() === 'monday') {
    blocked.push('skip_monday');
  }
  if (filters.orbRange && Number.isFinite(orbTicks)) {
    const min = Number(filters.orbRange.min);
    const max = Number(filters.orbRange.max);
    if (Number.isFinite(min) && orbTicks < min) blocked.push('orb_too_small');
    if (Number.isFinite(max) && orbTicks > max) blocked.push('orb_too_large');
  }
  if (filters.requireRetest === true && !String(sessionResult?.trade?.retest_time || '').trim()) {
    blocked.push('missing_retest');
  }
  if (filters.minRetestDelayMinutes && sessionResult?.trade?.retest_time && sessionResult?.trade?.confirmation_time) {
    const retest = parseEtDateTime(sessionResult.trade.retest_time);
    const confirmation = parseEtDateTime(sessionResult.trade.confirmation_time);
    if (retest && confirmation) {
      const delta = toMinutes(confirmation.hour, confirmation.minute) - toMinutes(retest.hour, retest.minute);
      if (delta < Number(filters.minRetestDelayMinutes)) blocked.push('retest_too_fast');
    }
  }
  return {
    eligible: blocked.length === 0,
    blocked,
    orbRangeTicks: Number.isFinite(orbTicks) ? orbTicks : null,
  };
}

function runPlanBacktest(sessions = {}, spec = ORIGINAL_PLAN_SPEC, options = {}) {
  const dates = Object.keys(sessions || {}).sort();
  const trades = [];
  const noTradeReasons = {};
  const blockedReasons = {};
  const referenceContext = options?.referenceContext && typeof options.referenceContext === 'object'
    ? options.referenceContext
    : null;
  const temporalAccumulator = referenceContext
    ? {
      day: { samples: 0, wins: 0 },
      bucket: { samples: 0, wins: 0 },
      combined: { samples: 0, wins: 0 },
    }
    : null;
  const includePerDate = options.includePerDate === true;
  const perDate = includePerDate ? {} : null;

  for (const date of dates) {
    const candles = sessions[date] || [];
    const sessionResult = processSession(candles, {
      ...(spec.engineOptions || {}),
    });
    const orbRangeTicks = Number(sessionResult?.orb?.range_ticks);
    const row = {
      date,
      orbRangeTicks: Number.isFinite(orbRangeTicks) ? orbRangeTicks : null,
      wouldTrade: false,
      blockedBy: [],
      noTradeReason: sessionResult?.no_trade_reason || null,
      tradeResult: null,
      tradePnlTicks: null,
      tradePnlDollars: null,
      tradeDirection: null,
      tradeEntryTime: null,
      tradeEntryPrice: null,
      tradeExitTime: null,
      tradeStopPrice: null,
      tradeTargetPrice: null,
    };

    if (sessionResult?.trade) {
      const filterEval = applyPlanFilters({ date, sessionResult, spec });
      row.blockedBy = filterEval.blocked.slice();
      if (filterEval.eligible) {
        row.wouldTrade = true;
        row.tradeResult = String(sessionResult.trade.result || '').trim().toLowerCase() || null;
        row.tradePnlTicks = Number.isFinite(Number(sessionResult?.trade?.pnl_ticks))
          ? Number(sessionResult.trade.pnl_ticks)
          : null;
        row.tradePnlDollars = Number.isFinite(Number(sessionResult?.trade?.pnl_dollars))
          ? Number(sessionResult.trade.pnl_dollars)
          : null;
        row.tradeDirection = String(sessionResult?.trade?.direction || '').trim().toLowerCase() || null;
        row.tradeEntryTime = String(sessionResult?.trade?.entry_time || '').trim() || null;
        row.tradeEntryPrice = Number.isFinite(Number(sessionResult?.trade?.entry_price))
          ? Number(sessionResult.trade.entry_price)
          : null;
        row.tradeExitTime = String(sessionResult?.trade?.exit_time || '').trim() || null;
        row.tradeStopPrice = Number.isFinite(Number(sessionResult?.trade?.sl_price))
          ? Number(sessionResult.trade.sl_price)
          : null;
        row.tradeTargetPrice = Number.isFinite(Number(sessionResult?.trade?.tp_price))
          ? Number(sessionResult.trade.tp_price)
          : null;
        const tradeTime = parseEtDateTime(
          sessionResult?.trade?.entry_time
          || sessionResult?.trade?.confirmation_time
          || sessionResult?.trade?.retest_time
          || ''
        );
        const tradeBucket = deriveTimeBucketFromEt(tradeTime?.hour, tradeTime?.minute);
        trades.push({
          ...sessionResult.trade,
          date,
          strategy_key: spec.key,
        });
        if (temporalAccumulator) {
          const dayNameLower = String(getEtDayName(date) || '').trim().toLowerCase();
          const isWin = row.tradeResult === 'win';
          const dayMatch = dayNameLower && dayNameLower === String(referenceContext.dayNameLower || '');
          const bucketMatch = tradeBucket.id === String(referenceContext.bucketId || '');
          if (dayMatch) {
            temporalAccumulator.day.samples += 1;
            if (isWin) temporalAccumulator.day.wins += 1;
          }
          if (bucketMatch) {
            temporalAccumulator.bucket.samples += 1;
            if (isWin) temporalAccumulator.bucket.wins += 1;
          }
          if (dayMatch && bucketMatch) {
            temporalAccumulator.combined.samples += 1;
            if (isWin) temporalAccumulator.combined.wins += 1;
          }
        }
      } else {
        for (const reason of filterEval.blocked) {
          blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
        }
      }
    } else {
      const reason = String(sessionResult?.no_trade_reason || 'no_trade').trim();
      noTradeReasons[reason] = (noTradeReasons[reason] || 0) + 1;
    }
    if (includePerDate) perDate[date] = row;
  }

  const metrics = calcMetrics(trades);
  const drawdown = calcDrawdown(trades, Number(options.startingBalance || 50000));
  const sessionsTotal = dates.length;
  const sessionsWithTrade = trades.length;
  const tradeFrequencyPct = sessionsTotal > 0
    ? round2((sessionsWithTrade / sessionsTotal) * 100)
    : 0;
  const summary = {
    totalSessions: sessionsTotal,
    sessionsWithTrade,
    sessionsNoTrade: Math.max(0, sessionsTotal - sessionsWithTrade),
    tradeFrequencyPct,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
  };

  const report = {
    key: spec.key,
    layer: spec.layer,
    name: spec.name,
    description: spec.description,
    rules: {
      ...spec.engineOptions,
      filters: spec.filters || {},
    },
    metrics,
    drawdown,
    summary,
    noTradeReasons,
    blockedReasons,
    score: 0,
  };
  if (temporalAccumulator) {
    report.temporalContext = {
      referenceDayName: referenceContext.dayName || null,
      referenceTimeBucket: referenceContext.bucketLabel || null,
      byDay: summarizeTemporalStats(temporalAccumulator.day.samples, temporalAccumulator.day.wins),
      byTimeBucket: summarizeTemporalStats(temporalAccumulator.bucket.samples, temporalAccumulator.bucket.wins),
      byDayTimeBucket: summarizeTemporalStats(temporalAccumulator.combined.samples, temporalAccumulator.combined.wins),
    };
  }
  if (includePerDate) report.perDate = perDate;
  report.score = scoreStrategy(report);
  return report;
}

function buildVariantReports(sessions = {}, options = {}) {
  const variantSpecs = Array.isArray(options.variantSpecs) && options.variantSpecs.length > 0
    ? options.variantSpecs
    : DEFAULT_VARIANT_SPECS;
  const tested = variantSpecs.map((spec) => runPlanBacktest(sessions, spec, options));
  tested.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return {
    tested,
    best: tested[0] || null,
  };
}

function normalizeDiscoveryCandidate(candidate = {}) {
  const testMetrics = candidate?.splits?.test || {};
  const overallMetrics = candidate?.splits?.overall || {};
  const pf = Number(testMetrics.profitFactor || 0);
  const wr = Number(testMetrics.winRate || 0);
  const trades = Number(overallMetrics.totalTrades || 0);
  const expectancy = Number(testMetrics.expectancyDollars || 0);
  const score = round2(
    clampNumber((pf / 2.5) * 40, 0, 40)
    + clampNumber((wr / 70) * 25, 0, 25)
    + clampNumber((trades / 140) * 20, 0, 20)
    + clampNumber(((expectancy + 20) / 80) * 15, 0, 15)
  );
  return {
    key: candidate.key,
    layer: 'discovery',
    name: candidate.name,
    hypothesis: candidate.hypothesis,
    status: candidate.status,
    confidence: candidate.confidence || 'low',
    score,
    testMetrics,
    overallMetrics,
    rules: candidate.rules || {},
    failureReasons: candidate.failureReasons || [],
  };
}

function buildDiscoveryLayer(sessions = {}, options = {}) {
  if (options.includeDiscovery === false) {
    return {
      status: 'skipped',
      message: 'Discovery disabled for this request.',
      bestAlternative: null,
      candidatesTop: [],
      diagnostics: { topRejections: [], nextResearchActions: [] },
    };
  }
  const defaultMaxCandidates = toIntInRange(
    process.env.STRATEGY_DISCOVERY_MAX_CANDIDATES,
    24,
    8,
    200
  );
  const maxCandidates = toIntInRange(options.maxCandidates, defaultMaxCandidates, 8, 300);
  const defaultStage1 = toIntInRange(Math.ceil(maxCandidates * 0.55), 12, 6, maxCandidates);
  const stage1Budget = toIntInRange(options.stage1Budget, defaultStage1, 6, maxCandidates);
  const defaultSeedTopK = Math.max(3, Math.min(10, Math.ceil(stage1Budget / 2)));
  const seedTopK = toIntInRange(options.seedTopK, defaultSeedTopK, 3, 20);
  const discovery = runDiscovery(sessions, {
    mode: 'two_stage',
    maxCandidates,
    stage1Budget,
    seedTopK,
  });
  if (discovery?.status !== 'ok') {
    return {
      status: discovery?.status || 'insufficient_data',
      message: discovery?.message || 'Discovery unavailable.',
      bestAlternative: null,
      candidatesTop: [],
      diagnostics: discovery?.diagnostics || { topRejections: [], nextResearchActions: [] },
    };
  }
  const normalized = (discovery.candidates || []).map(normalizeDiscoveryCandidate);
  const preferred = normalized.find((c) => c.status === 'live_eligible')
    || normalized.find((c) => c.status === 'watchlist')
    || normalized[0]
    || null;
  return {
    status: 'ok',
    message: null,
    bestAlternative: preferred,
    candidatesTop: normalized.slice(0, 5),
    diagnostics: discovery.diagnostics || { topRejections: [], nextResearchActions: [] },
    summary: discovery.summary || null,
  };
}

function buildSuitabilityScore(entry = {}, context = {}) {
  const base = Number(entry.score || 0);
  const phase = String(context.sessionPhase || '').toLowerCase();
  if (!phase) return round2(base);
  if (phase === 'outside_window') return round2(base - 8);
  if (phase === 'orb_window') return round2(base + 3);
  return round2(base);
}

function scoreStrategyPracticality(entry = {}) {
  const summary = entry.summary || {};
  const trades = Number(entry.metrics?.totalTrades || summary.sessionsWithTrade || 0);
  const frequency = Number(summary.tradeFrequencyPct);
  const sampleScore = clampNumber((trades / 120) * 100, 0, 100);
  if (!Number.isFinite(frequency)) {
    return round2((sampleScore * 0.6) + 35);
  }
  const distanceFromIdeal = Math.min(
    Math.abs(frequency - 42),
    Math.abs(frequency - 30),
    Math.abs(frequency - 55)
  );
  const freqScore = clampNumber(100 - (distanceFromIdeal * 2.1), 20, 100);
  return round2((sampleScore * 0.45) + (freqScore * 0.55));
}

function computeRecommendationPriority(entry = {}, context = {}) {
  const wr = clampNumber(Number(entry.metrics?.winRate || 0), 0, 100);
  const pf = clampNumber((Number(entry.metrics?.profitFactor || 0) / 2.5) * 100, 0, 100);
  const suitability = clampNumber(buildSuitabilityScore(entry, context), 0, 100);
  const practicality = scoreStrategyPracticality(entry);
  const composite = round2((wr * 0.5) + (pf * 0.3) + (practicality * 0.12) + (suitability * 0.08));
  return {
    composite,
    components: {
      winRate: round2(wr),
      profitFactor: round2(pf),
      practicality: round2(practicality),
      contextFit: round2(suitability),
    },
  };
}

function chooseRecommendedStrategy({ original, bestVariant, bestDiscovery, context = {} }) {
  const candidates = [original, bestVariant, bestDiscovery].filter(Boolean).map((entry) => ({
    ...entry,
    suitability: buildSuitabilityScore(entry, context),
    recommendationPriority: computeRecommendationPriority(entry, context),
  }));
  candidates.sort((a, b) => Number(b.recommendationPriority?.composite || 0) - Number(a.recommendationPriority?.composite || 0));
  const top = candidates[0] || null;
  if (!top) return null;
  const wr = Number(top.metrics?.winRate || 0);
  const pf = Number(top.metrics?.profitFactor || 0);
  let reason = `Ranked highest on win-rate-first scoring (${round2(wr)}% WR, PF ${round2(pf)}).`;
  if (top.layer === 'variant') reason = `Learned overlay leads today on WR/PF practicality balance (${round2(wr)}% WR, PF ${round2(pf)}).`;
  if (top.layer === 'discovery') reason = `Alternative strategy currently leads WR/PF score for this regime (${round2(wr)}% WR, PF ${round2(pf)}).`;
  return {
    strategyKey: top.key,
    layer: top.layer,
    name: top.name,
    suitability: top.suitability,
    recommendationScore: round2(top.recommendationPriority?.composite || top.suitability || 0),
    rankingComponents: top.recommendationPriority?.components || null,
    reason,
  };
}

function buildResearchInsights({ original, bestVariant, bestDiscovery }) {
  const insights = [];
  if (original && bestVariant) {
    const pfDelta = round2(Number(bestVariant.metrics?.profitFactor || 0) - Number(original.metrics?.profitFactor || 0));
    const wrDelta = round2(Number(bestVariant.metrics?.winRate || 0) - Number(original.metrics?.winRate || 0));
    if (pfDelta > 0 || wrDelta > 0) {
      insights.push(`Variant edge: ${bestVariant.name} changes PF by ${pfDelta} and WR by ${wrDelta} points vs original.`);
    } else {
      insights.push('No tested variant beats the original plan on both PF and WR right now.');
    }
  }
  if (bestDiscovery) {
    insights.push(`Discovery leader: ${bestDiscovery.name} (${bestDiscovery.status || 'candidate'}) with score ${bestDiscovery.score}.`);
  }
  return insights.slice(0, 5);
}

function buildPineScriptForStrategy(strategyEntry = {}) {
  const key = String(strategyEntry.key || 'strategy').trim();
  const name = String(strategyEntry.name || 'Strategy').trim();
  const layer = String(strategyEntry.layer || '').trim().toLowerCase();
  const rules = strategyEntry.rules || {};
  const maxEntryHour = Number.isFinite(Number(rules.maxEntryHour)) ? Number(rules.maxEntryHour) : 11;
  const longOnly = rules.longOnly !== false;
  const skipMonday = rules.skipMonday === true;
  const orbMin = Number(rules?.filters?.orbRange?.min);
  const orbMax = Number(rules?.filters?.orbRange?.max);
  const hasOrbFilter = Number.isFinite(orbMin) || Number.isFinite(orbMax);

  if (layer === 'discovery') {
    return `//@version=6
strategy("${name} [Discovery]", overlay=true, process_orders_on_close=true)
// Auto-generated discovery scaffold for ${key}.
// Family: ${String(rules.family || 'custom')}
// NOTE: Implement exact entry logic from Jarvis candidate rules before live use.
plot(close, "Price", color=color.new(color.white, 0))
`;
  }

  return `//@version=6
strategy("${name}", overlay=true, process_orders_on_close=true)
// Auto-generated by Jarvis Strategy Layers (${key}).
// Original plan remains unchanged unless explicitly adopted.
i_longOnly = input.bool(${longOnly ? 'true' : 'false'}, "Long Only")
i_skipMonday = input.bool(${skipMonday ? 'true' : 'false'}, "Skip Monday")
i_maxEntryHour = input.int(${maxEntryHour}, "Max Entry Hour", minval=9, maxval=16)
${hasOrbFilter ? `i_orbMin = input.int(${Number.isFinite(orbMin) ? Math.round(orbMin) : 0}, "ORB Min Ticks")
i_orbMax = input.int(${Number.isFinite(orbMax) ? Math.round(orbMax) : 9999}, "ORB Max Ticks")` : '// No ORB size filter in this layer.'}
// Integrate with your ORB 9:30-9:45 breakout/retest confirmation script body.
plot(close, "Price", color=color.new(color.white, 0))
`;
}

function buildStrategyLayerSnapshot(sessions = {}, options = {}) {
  const context = options.context && typeof options.context === 'object' ? options.context : {};
  const referenceContext = deriveReferenceContext(context.nowEt);
  const runOptions = {
    ...options,
    referenceContext,
  };
  const original = runPlanBacktest(sessions, ORIGINAL_PLAN_SPEC, runOptions);
  const variants = buildVariantReports(sessions, runOptions);
  const discovery = buildDiscoveryLayer(sessions, options);

  const bestVariant = variants.best
    ? {
      ...variants.best,
      layer: 'variant',
    }
    : null;
  const bestDiscovery = discovery.bestAlternative
    ? {
      ...discovery.bestAlternative,
      metrics: discovery.bestAlternative.testMetrics || {},
      drawdown: null,
      summary: {
        totalSessions: Number(discovery.summary?.sessions || 0),
        sessionsWithTrade: Number(discovery.bestAlternative.overallMetrics?.totalTrades || 0),
        sessionsNoTrade: null,
        tradeFrequencyPct: null,
      },
    }
    : null;

  const recommendation = chooseRecommendedStrategy({
    original,
    bestVariant,
    bestDiscovery,
    context,
  });

  const strategyStack = [
    {
      key: original.key,
      layer: 'original',
      name: original.name,
      score: original.score,
      suitability: buildSuitabilityScore(original, context),
      metrics: original.metrics,
      drawdown: original.drawdown,
      rules: original.rules,
      temporalContext: original.temporalContext || null,
      pineScript: buildPineScriptForStrategy(original),
    },
    bestVariant ? {
      key: bestVariant.key,
      layer: 'variant',
      name: bestVariant.name,
      score: bestVariant.score,
      suitability: buildSuitabilityScore(bestVariant, context),
      metrics: bestVariant.metrics,
      drawdown: bestVariant.drawdown,
      rules: bestVariant.rules,
      temporalContext: bestVariant.temporalContext || null,
      pineScript: buildPineScriptForStrategy(bestVariant),
    } : null,
    bestDiscovery ? {
      key: bestDiscovery.key,
      layer: 'discovery',
      name: bestDiscovery.name,
      score: bestDiscovery.score,
      suitability: buildSuitabilityScore(bestDiscovery, context),
      metrics: bestDiscovery.metrics,
      drawdown: bestDiscovery.drawdown,
      rules: bestDiscovery.rules,
      temporalContext: bestDiscovery.temporalContext || null,
      pineScript: buildPineScriptForStrategy(bestDiscovery),
    } : null,
  ].filter(Boolean);

  const originalPlan = strategyStack.find((s) => s.layer === 'original') || null;
  const bestVariantEntry = strategyStack.find((s) => s.layer === 'variant') || null;
  const bestAlternativeEntry = strategyStack.find((s) => s.layer === 'discovery') || null;
  const recommendationLayer = String(recommendation?.layer || '').trim().toLowerCase();
  const recommendationBasis = {
    basisType: recommendationLayer === 'variant'
      ? 'overlay'
      : recommendationLayer === 'discovery'
        ? 'alternative'
        : 'baseline',
    recommendedLayer: recommendationLayer || 'original',
    recommendedStrategyKey: recommendation?.strategyKey || originalPlan?.key || null,
    recommendedStrategyName: recommendation?.name || originalPlan?.name || null,
    rationale: recommendation?.reason || 'Baseline recommendation.',
    isOriginalPlanRecommendation: recommendationLayer === 'original' || !recommendationLayer,
  };

  const mechanicsSummaryInput = options?.mechanicsSummary && typeof options.mechanicsSummary === 'object'
    ? options.mechanicsSummary
    : {};
  const bestTpModeRecent = String(mechanicsSummaryInput.bestTpModeRecent || '').trim() || null;
  const bestTpModeByWinRate = String(mechanicsSummaryInput.bestTpModeByWinRate || '').trim() || null;
  const bestTpModeByProfitFactor = String(mechanicsSummaryInput.bestTpModeByProfitFactor || '').trim() || null;
  const recommendedTpMode = String(mechanicsSummaryInput.recommendedTpMode || '').trim() || null;
  const recommendedTpModeReason = String(mechanicsSummaryInput.recommendedTpModeReason || '').trim() || null;
  const evidenceWindowTrades = Number.isFinite(Number(mechanicsSummaryInput.evidenceWindowTrades))
    ? Number(mechanicsSummaryInput.evidenceWindowTrades)
    : null;
  const tpModeComparisonAvailable = mechanicsSummaryInput.tpModeComparisonAvailable === true;
  const sampleQuality = mechanicsSummaryInput.sampleQuality && typeof mechanicsSummaryInput.sampleQuality === 'object'
    ? mechanicsSummaryInput.sampleQuality
    : null;
  const originalPlanTpMode = String(mechanicsSummaryInput.originalPlanTpMode || 'Skip 2').trim() || 'Skip 2';
  const originalPlanStopMode = String(mechanicsSummaryInput.originalPlanStopMode || 'rr_1_to_1_from_tp').trim() || 'rr_1_to_1_from_tp';
  const advisoryOnly = mechanicsSummaryInput.advisoryOnly !== false;
  const contextualTpRecommendation = String(mechanicsSummaryInput.contextualTpRecommendation || '').trim() || null;
  const contextConfidence = String(mechanicsSummaryInput.contextConfidence || '').trim() || null;
  const contextConfidenceScore = Number.isFinite(Number(mechanicsSummaryInput.contextConfidenceScore))
    ? Number(mechanicsSummaryInput.contextConfidenceScore)
    : null;
  const contextSampleSize = Number.isFinite(Number(mechanicsSummaryInput.contextSampleSize))
    ? Number(mechanicsSummaryInput.contextSampleSize)
    : null;
  const contextFallbackLevel = String(mechanicsSummaryInput.contextFallbackLevel || '').trim() || null;
  const contextUsed = mechanicsSummaryInput.contextUsed && typeof mechanicsSummaryInput.contextUsed === 'object'
    ? mechanicsSummaryInput.contextUsed
    : null;
  const discoverySummary = options?.discoverySummary && typeof options.discoverySummary === 'object'
    ? options.discoverySummary
    : null;
  const strategyTrackingSummary = options?.strategyTrackingSummary && typeof options.strategyTrackingSummary === 'object'
    ? options.strategyTrackingSummary
    : null;
  const strategyPortfolioSummary = options?.strategyPortfolioSummary && typeof options.strategyPortfolioSummary === 'object'
    ? options.strategyPortfolioSummary
    : null;
  const strategyExperimentsSummary = options?.strategyExperimentsSummary && typeof options.strategyExperimentsSummary === 'object'
    ? options.strategyExperimentsSummary
    : null;
  const researchInsights = buildResearchInsights({
    original,
    bestVariant,
    bestDiscovery,
  });
  if (discoverySummary?.bestCandidateOverall?.strategyName) {
    const top = discoverySummary.bestCandidateOverall;
    researchInsights.unshift(
      `Discovery advisory: ${top.strategyName} (${top.robustnessLabel || 'unrated'}) with ${round2(Number(top.winRate || 0))}% WR and PF ${round2(Number(top.profitFactor || 0))}.`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    mission: 'Long-term consistent trading profitability through strategy evolution.',
    originalPlan,
    bestVariant: bestVariantEntry,
    bestAlternative: bestAlternativeEntry,
    recommendationBasis,
    mechanicsSummary: {
      bestTpModeRecent,
      bestTpModeByWinRate,
      bestTpModeByProfitFactor,
      recommendedTpMode,
      recommendedTpModeReason,
      evidenceWindowTrades,
      tpModeComparisonAvailable,
      sampleQuality,
      originalPlanTpMode,
      originalPlanStopMode,
      advisoryOnly,
      contextualTpRecommendation,
      contextConfidence,
      contextConfidenceScore,
      contextSampleSize,
      contextFallbackLevel,
      contextUsed,
    },
    discoverySummary,
    strategyTrackingSummary,
    strategyPortfolioSummary,
    strategyExperimentsSummary,
    layers: {
      original,
      variants: {
        testedCount: variants.tested.length,
        best: bestVariant,
        tested: variants.tested.slice(0, 10),
      },
      discovery,
    },
    recommendation,
    strategyStack,
    researchInsights,
  };
}

function buildReplayVariantAssessment(summary = {}) {
  const orb = Number(summary.orbRangeTicks);
  const marketOutcome = String(summary.marketOutcome || 'unknown').trim().toLowerCase() || 'unknown';
  const originalPlanEligible = summary.strategyEligible === true;
  const originalPlanOutcome = String(summary.strategyOutcome || (originalPlanEligible ? 'unknown' : 'no_trade')).trim().toLowerCase() || 'no_trade';
  const replayDate = toDateIso(summary.replayDate);
  const dayName = getEtDayName(replayDate).toLowerCase();
  const variantKey = 'variant_orb_70_220';
  const variantName = 'ORB 70-220 Filter';
  const variantEligible = Number.isFinite(orb) ? (orb >= 70 && orb <= 220) : false;
  const variantOutcome = variantEligible ? originalPlanOutcome : 'no_trade';
  const notes = [];
  if (!variantEligible && Number.isFinite(orb)) notes.push(`ORB ${Math.round(orb)} ticks is outside 70-220.`);
  if (dayName === 'monday') notes.push('Monday session; skip-Monday variant would also stand down.');
  let impact = 'neutral';
  if (originalPlanOutcome === 'loss' && variantOutcome === 'no_trade') impact = 'improve';
  if (originalPlanOutcome === 'win' && variantOutcome === 'no_trade') impact = 'worse';

  return {
    marketOutcome,
    originalPlanEligible,
    originalPlanOutcome,
    variantAssessment: {
      variantKey,
      variantName,
      variantEligible,
      variantOutcome,
      rationale: notes.length ? notes.join(' ') : 'Variant rules produce same eligibility as original.',
      impactVsOriginal: impact,
    },
    strategyVariantComparison: {
      comparedVariant: variantName,
      changedDecision: variantEligible !== originalPlanEligible || variantOutcome !== originalPlanOutcome,
      originalPlanOutcome,
      variantOutcome,
      actionableSummary: impact === 'improve'
        ? 'Variant would likely have reduced downside on this session.'
        : impact === 'worse'
          ? 'Variant would have filtered a winning original-plan trade.'
          : 'Variant does not materially change this replay decision.',
    },
  };
}

function newsImpactRank(impact) {
  const txt = String(impact || '').trim().toLowerCase();
  if (txt.includes('high')) return 3;
  if (txt.includes('medium')) return 2;
  if (txt.includes('low')) return 1;
  return 0;
}

function parseNewsTimeToMinutes(timeText) {
  const txt = String(timeText || '').trim();
  if (!txt) return null;
  const m = txt.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour * 60) + minute;
}

function normalizeNewsEvent(event) {
  if (event == null) return null;
  if (typeof event === 'string') {
    const txt = event.trim();
    if (!txt) return null;
    const m = txt.match(/(\d{1,2}:\d{2})\s*(?:ET)?\s*[-|]?\s*(.*)/i);
    return {
      time: m ? m[1] : null,
      impact: 'medium',
      title: m ? (m[2] || txt) : txt,
      country: null,
      minutes: m ? parseNewsTimeToMinutes(m[1]) : null,
      raw: txt,
    };
  }
  const time = String(event.time || event.et || '').trim() || null;
  const impact = String(event.impact || event.level || '').trim() || 'medium';
  const title = String(event.title || event.name || event.event || event.description || '').trim() || 'Economic event';
  const country = String(event.country || event.currency || '').trim() || null;
  const rawMinutes = event.minutes;
  const minutes = (rawMinutes === null || rawMinutes === undefined || String(rawMinutes).trim() === '')
    ? parseNewsTimeToMinutes(time)
    : (Number.isFinite(Number(rawMinutes)) ? Number(rawMinutes) : parseNewsTimeToMinutes(time));
  return {
    time,
    impact,
    title,
    country,
    minutes: Number.isFinite(minutes) ? minutes : null,
    raw: event,
  };
}

function normalizeNewsEvents(news = []) {
  return (Array.isArray(news) ? news : [])
    .map((item) => normalizeNewsEvent(item))
    .filter(Boolean)
    .sort((a, b) => {
      const ma = Number.isFinite(a.minutes) ? a.minutes : 9999;
      const mb = Number.isFinite(b.minutes) ? b.minutes : 9999;
      if (ma !== mb) return ma - mb;
      return newsImpactRank(b.impact) - newsImpactRank(a.impact);
    });
}

function evaluateNewsQualifier(newsEvents = [], nowEtText = '') {
  const now = parseEtDateTime(nowEtText);
  const nowMinutes = now ? toMinutes(now.hour, now.minute) : null;
  const withDelta = newsEvents
    .map((evt) => {
      const evtMinutes = Number.isFinite(evt.minutes) ? evt.minutes : parseNewsTimeToMinutes(evt.time);
      return {
        ...evt,
        minutes: Number.isFinite(evtMinutes) ? evtMinutes : null,
        deltaMinutes: Number.isFinite(nowMinutes) && Number.isFinite(evtMinutes)
          ? evtMinutes - nowMinutes
          : null,
      };
    });
  const upcoming = withDelta
    .filter((evt) => Number.isFinite(evt.deltaMinutes) && evt.deltaMinutes >= 0)
    .sort((a, b) => Number(a.deltaMinutes) - Number(b.deltaMinutes));
  const nextImportant = upcoming.find((evt) => newsImpactRank(evt.impact) >= 2) || upcoming[0] || null;
  const nearbyHighImpact = upcoming.find((evt) => newsImpactRank(evt.impact) >= 3 && Number(evt.deltaMinutes) <= 35) || null;
  const openWindowDistortion = upcoming.find((evt) =>
    newsImpactRank(evt.impact) >= 2
    && Number.isFinite(evt.minutes)
    && evt.minutes >= 570
    && evt.minutes <= 645
  ) || null;
  let qualifier = 'No near-term high-impact news distortion detected.';
  let recommendationAdjustment = 'normal';
  if (nearbyHighImpact) {
    qualifier = `High-impact news at ${nearbyHighImpact.time || 'TBD'} ET; delay aggressive entries until post-release structure confirms.`;
    recommendationAdjustment = 'delay_or_downgrade';
  } else if (openWindowDistortion) {
    qualifier = `News window near ${openWindowDistortion.time || 'open'} ET may distort ORB behavior; prioritize confirmation quality.`;
    recommendationAdjustment = 'qualify';
  }
  return {
    nextImportantNewsTimeEt: nextImportant?.time || null,
    nextImportantNewsTitle: nextImportant?.title || null,
    nextImportantNewsImpact: nextImportant?.impact || null,
    nearbyHighImpact: !!nearbyHighImpact,
    recommendationAdjustment,
    qualifier,
    normalizedEvents: withDelta.slice(0, 8),
  };
}

function buildHistoricalResemblance(temporalContext = null) {
  if (!temporalContext || typeof temporalContext !== 'object') {
    return {
      stance: 'unknown',
      narrative: 'Historical day/time match is unavailable.',
      winRate: null,
      samples: 0,
      source: 'none',
    };
  }
  const combined = temporalContext.byDayTimeBucket || {};
  const byDay = temporalContext.byDay || {};
  const byTime = temporalContext.byTimeBucket || {};
  const candidate = Number(combined.samples || 0) >= 4
    ? { ...combined, source: 'day_time_bucket' }
    : Number(byDay.samples || 0) >= Number(byTime.samples || 0)
      ? { ...byDay, source: 'day' }
      : { ...byTime, source: 'time_bucket' };
  const samples = Number(candidate.samples || 0);
  const winRate = Number(candidate.winRate);
  if (samples <= 0 || !Number.isFinite(winRate)) {
    return {
      stance: 'unknown',
      narrative: 'Historical day/time match has insufficient sample.',
      winRate: null,
      samples,
      source: candidate.source || 'none',
    };
  }
  const stance = winRate >= 56 ? 'favorable' : winRate < 46 ? 'unfavorable' : 'mixed';
  const narrative = stance === 'favorable'
    ? `Current day/time resembles a favorable profile (${round2(winRate)}% WR across ${samples} samples).`
    : stance === 'unfavorable'
      ? `Current day/time resembles an unfavorable profile (${round2(winRate)}% WR across ${samples} samples).`
      : `Current day/time profile is mixed (${round2(winRate)}% WR across ${samples} samples).`;
  return {
    stance,
    narrative,
    winRate: round2(winRate),
    samples,
    source: candidate.source || 'unknown',
  };
}

function buildPineAccessContract(strategyEntry = {}) {
  const key = String(strategyEntry.key || '').trim();
  const layer = String(strategyEntry.layer || '').trim().toLowerCase();
  return {
    available: Boolean(strategyEntry.pineScript),
    endpoint: `/api/jarvis/strategy/pine?key=${encodeURIComponent(key)}&layer=${encodeURIComponent(layer)}`,
    copyReady: Boolean(strategyEntry.pineScript),
    format: 'pine_v6',
  };
}

function normalizeDecisionSignal(value = '') {
  const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!raw) return '';
  if (raw === 'NO_TRADE' || raw === "DON'T_TRADE" || raw === 'DONT_TRADE') return 'NO_TRADE';
  if (raw === 'WAIT' || raw === 'HOLD') return 'WAIT';
  if (raw === 'TRADE' || raw === 'GO' || raw === 'GREEN_LIGHT') return 'TRADE';
  return raw;
}

function isDefensivePosture(posture = '') {
  const key = String(posture || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!key) return false;
  return key === 'stand_down'
    || key === 'wait_for_news'
    || key === 'wait_for_clearance'
    || key === 'dont_trade'
    || key === 'no_trade';
}

function isAggressiveTpMode(tpMode = '') {
  const key = String(tpMode || '').trim().toLowerCase().replace(/[\s_]+/g, '');
  return key === 'skip1' || key === 'skip2';
}

function appendUniqueReason(baseReason = '', nextReason = '') {
  const base = String(baseReason || '').trim();
  const next = String(nextReason || '').trim();
  if (!next) return base;
  if (!base) return next;
  if (base.toLowerCase().includes(next.toLowerCase())) return base;
  return `${base} ${next}`;
}

function normalizeBlockerCode(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function defaultNextCheckWindow(sessionPhase = '') {
  const phase = String(sessionPhase || '').trim().toLowerCase();
  if (phase === 'pre_open') return 'Re-check at open and on the next decision refresh.';
  if (phase === 'orb_window' || phase === 'opening_window') return 'Re-check on the next setup confirmation window.';
  return 'Re-check on the next meaningful decision refresh.';
}

function parseBlockerThresholdFromCode(blockerCode = '') {
  const normalized = normalizeBlockerCode(blockerCode);
  const thresholdMatch = normalized.match(/_below_(\d+(?:_\d+)?)/);
  if (!thresholdMatch) return null;
  const token = String(thresholdMatch[1] || '').replace('_', '.');
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveProbGreenCurrentValue(options = {}) {
  const decision = options?.decision && typeof options.decision === 'object'
    ? options.decision
    : {};
  const commandSnapshot = options?.commandSnapshot && typeof options.commandSnapshot === 'object'
    ? options.commandSnapshot
    : {};
  const candidates = [
    decision?.probGreen,
    commandSnapshot?.decision?.probGreen,
    commandSnapshot?.elite?.outcome?.distribution?.probGreen,
    commandSnapshot?.elite?.probGreen,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return round2(value);
  }
  return null;
}

function classifyClearanceState(deltaToClear) {
  if (!Number.isFinite(deltaToClear)) return 'clearance_unknown';
  if (deltaToClear <= 0) return 'cleared';
  if (deltaToClear <= 1) return 'near_clearance';
  if (deltaToClear <= 3) return 'approaching_clearance';
  return 'far_from_clearance';
}

function humanizeClearanceState(state = '') {
  const normalized = String(state || '').trim().toLowerCase();
  if (normalized === 'cleared') return 'clear';
  if (normalized === 'near_clearance') return 'almost there';
  if (normalized === 'approaching_clearance') return 'getting closer';
  if (normalized === 'far_from_clearance') return 'still far';
  return 'not clear yet';
}

function mapBlockerToClearanceGuidance(blockerCode = '', options = {}) {
  const normalized = normalizeBlockerCode(blockerCode);
  const phase = options.sessionPhase || '';
  const fallbackWindow = defaultNextCheckWindow(phase);
  const map = {
    prob_green_below_50: {
      blockedBy: 'Confidence support is below the line right now.',
      clearanceCondition: 'Confidence support climbs back above the line with cleaner confirmation.',
      nextCheckWindow: fallbackWindow,
      riskIfIgnored: 'You are more likely to get chopped up with weak follow-through.',
    },
    range_overextended: {
      blockedBy: 'Range overextension is still blocking this setup; price is stretched at the edge of the range right now.',
      clearanceCondition: 'Price rotates back inside the range and confirms a cleaner re-entry setup.',
      nextCheckWindow: phase === 'pre_open'
        ? 'Re-check at open for a clean rotation back inside range.'
        : 'Re-check on the next 5-minute close for rotation back inside range.',
      riskIfIgnored: 'Chasing an overextended edge increases fakeout and snapback risk.',
    },
    insufficient_decisive_sample: {
      blockedBy: 'There is not enough clean confirmation yet.',
      clearanceCondition: 'We see enough clean confirmation to trust the setup.',
      nextCheckWindow: fallbackWindow,
      riskIfIgnored: 'Signal quality is weak and fake entries are more likely.',
    },
    top_setup_weak_20_60: {
      blockedBy: 'The setup still looks weak right now.',
      clearanceCondition: 'Setup quality improves to a cleaner level before entry.',
      nextCheckWindow: fallbackWindow,
      riskIfIgnored: 'Weak setup quality usually means worse entries and worse follow-through.',
    },
    top_setup_very_weak_20_60: {
      blockedBy: 'The setup is very weak right now.',
      clearanceCondition: 'Setup quality improves a lot before considering entry.',
      nextCheckWindow: fallbackWindow,
      riskIfIgnored: 'Very weak setup quality raises drawdown risk fast.',
    },
    friday_volatility_exhaustion: {
      blockedBy: 'Friday volatility looks stretched and fragile right now.',
      clearanceCondition: 'Range pressure eases and a cleaner confirmation setup appears.',
      nextCheckWindow: fallbackWindow,
      riskIfIgnored: 'Late-session exhaustion often reverses fast and punishes chases.',
    },
  };
  const mapped = map[normalized];
  if (mapped) {
    const threshold = normalized === 'prob_green_below_50'
      ? (parseBlockerThresholdFromCode(blockerCode) ?? 50)
      : null;
    const currentValue = normalized === 'prob_green_below_50'
      ? resolveProbGreenCurrentValue(options)
      : null;
    const deltaToClear = Number.isFinite(currentValue) && Number.isFinite(threshold)
      ? round2(Math.max(0, threshold - currentValue))
      : null;
    const clearanceState = Number.isFinite(deltaToClear)
      ? classifyClearanceState(deltaToClear)
      : null;
    return {
      blockerCode: String(blockerCode || '').trim(),
      blockerCodeNormalized: normalized,
      mapped: true,
      blockedBy: mapped.blockedBy,
      clearanceCondition: mapped.clearanceCondition,
      nextCheckWindow: mapped.nextCheckWindow,
      riskIfIgnored: mapped.riskIfIgnored,
      ...(Number.isFinite(currentValue) || Number.isFinite(threshold) ? {
        currentValue,
        threshold: Number.isFinite(threshold) ? round2(threshold) : null,
        deltaToClear,
        clearanceState: clearanceState || 'clearance_unknown',
      } : {}),
    };
  }
  const fallbackCode = String(blockerCode || '').trim() || 'unknown_blocker';
  return {
    blockerCode: fallbackCode,
    blockerCodeNormalized: normalized || 'unknown_blocker',
    mapped: false,
    blockedBy: `Something is still blocking this setup: ${fallbackCode.replace(/_/g, ' ')}.`,
    clearanceCondition: 'Do not trade until this blocker is cleared on the next decision check.',
    nextCheckWindow: fallbackWindow,
    riskIfIgnored: 'Forcing a trade while blocked adds avoidable risk.',
  };
}

function applyFrontLineBlockerClearanceGuidance(todayRecommendation = {}, decision = {}, todayContext = {}, commandSnapshot = {}) {
  if (!todayRecommendation || typeof todayRecommendation !== 'object') return todayRecommendation;
  const blockers = Array.isArray(decision?.blockers)
    ? decision.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!blockers.length) return todayRecommendation;
  const guidanceRows = blockers.map((blockerCode) =>
    mapBlockerToClearanceGuidance(blockerCode, {
      sessionPhase: todayContext?.sessionPhase || '',
      decision,
      commandSnapshot,
    }));
  const primary = guidanceRows[0] || null;
  if (!primary) return todayRecommendation;
  const recommendation = { ...todayRecommendation };
  recommendation.frontLineBlockerClearanceGuidance = guidanceRows;
  recommendation.frontLinePrimaryBlockerGuidance = primary;
  const numericSummary = Number.isFinite(primary?.currentValue) && Number.isFinite(primary?.threshold)
    ? ` Current vs clear: ${round2(primary.currentValue)} vs ${round2(primary.threshold)} (need +${round2(primary.deltaToClear || 0)}, ${humanizeClearanceState(primary.clearanceState)}).`
    : '';
  recommendation.frontLineBlockerClearanceSummary = `Blocked by: ${primary.blockedBy}${numericSummary} Clear when: ${primary.clearanceCondition} Check again: ${primary.nextCheckWindow} If ignored: ${primary.riskIfIgnored}`;
  return recommendation;
}

function toActionNowLabel(signal = '', posture = '', hasBlockers = false) {
  const normalizedSignal = normalizeDecisionSignal(signal);
  const postureKey = String(posture || '').trim().toLowerCase();
  const postureDefensive = isDefensivePosture(postureKey);
  if (normalizedSignal === 'NO_TRADE') return "Don't trade yet.";
  if (normalizedSignal === 'WAIT') return hasBlockers ? 'Wait for clearance.' : 'Wait.';
  if (normalizedSignal === 'TRADE') {
    return postureDefensive ? 'Trade, but keep it tight.' : 'Trade selectively.';
  }
  if (postureDefensive) return postureKey === 'stand_down' ? "Don't trade yet." : 'Wait for clearance.';
  return 'Trade selectively.';
}

function summarizeConfidence(todayRecommendation = {}) {
  const label = String(todayRecommendation?.confidenceLabel || '').trim().toLowerCase();
  const scoreRaw = Number(todayRecommendation?.confidenceScore);
  const labelDisplay = label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : 'Unknown';
  const scoreDisplay = Number.isFinite(scoreRaw) ? ` (${round2(scoreRaw)})` : '';
  let suffix = '';
  const calibration = todayRecommendation?.confidenceCalibration;
  const clampReason = String(calibration?.confidenceClampReason || '').trim().toLowerCase();
  const fallbackLevel = String(calibration?.precisionContext?.fallbackLevel || '').trim().toLowerCase();
  const liveSharePct = Number(calibration?.precisionContext?.liveSharePct);
  const backfillDominant = calibration?.precisionContext?.backfillDominant === true;
  const weakPrecisionClamp = clampReason === 'weak_precision_no_positive_uplift'
    || clampReason === 'mixed_precision_no_positive_uplift'
    || clampReason === 'mixed_precision_confidence_ceiling';
  if (weakPrecisionClamp) {
    const parts = [];
    if (fallbackLevel && fallbackLevel !== 'exact_context') parts.push('this setup read is broad, not a tight match');
    if (Number.isFinite(liveSharePct) && liveSharePct < 70) parts.push(`live confirmation is still light (${round2(liveSharePct)}%)`);
    if (backfillDominant) parts.push('older history is carrying more weight than live tape');
    if (parts.length) suffix = `. Not high yet because ${parts.join(', ')}.`;
  }
  return `${labelDisplay}${scoreDisplay}${suffix}`;
}

function humanizeUnderscoreText(value = '') {
  return String(value || '').replace(/_/g, ' ').trim();
}

function buildRecentAggressiveMissSentinelNote(sentinel = null) {
  if (!sentinel || typeof sentinel !== 'object') return null;
  if (String(sentinel.classification || '').trim().toLowerCase() !== 'too_aggressive') return null;
  const blockerState = humanizeUnderscoreText(sentinel.blockerState || 'unknown');
  const posture = humanizeUnderscoreText(sentinel.posture || 'unknown posture');
  const tpMode = String(sentinel.recommendedTpMode || 'unknown TP').trim() || 'unknown TP';
  const confidenceLabel = String(sentinel.confidenceLabel || '').trim().toLowerCase();
  const confidenceScore = Number(sentinel.confidenceScore);
  const confidence = confidenceLabel
    ? `${confidenceLabel}${Number.isFinite(confidenceScore) ? ` (${round2(confidenceScore)})` : ''}`
    : (Number.isFinite(confidenceScore) ? `${round2(confidenceScore)}` : 'unknown');
  return `Recent miss pattern: too aggressive (${blockerState} state, ${posture}, ${tpMode}, ${confidence} confidence). Stay tighter with aggressive continuation setups until reviewed.`;
}

function buildDecisionQualityCard(input = {}) {
  const decision = input?.decision && typeof input.decision === 'object' ? input.decision : {};
  const todayRecommendation = input?.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const assistantDecisionBrief = input?.assistantDecisionBrief && typeof input.assistantDecisionBrief === 'object'
    ? input.assistantDecisionBrief
    : {};
  const todayContext = input?.todayContext && typeof input.todayContext === 'object'
    ? input.todayContext
    : {};
  const primaryGuidance = todayRecommendation?.frontLinePrimaryBlockerGuidance
    && typeof todayRecommendation.frontLinePrimaryBlockerGuidance === 'object'
    ? todayRecommendation.frontLinePrimaryBlockerGuidance
    : null;
  const blockers = Array.isArray(decision?.blockers)
    ? decision.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!blockers.length && primaryGuidance?.blockerCode) blockers.push(String(primaryGuidance.blockerCode).trim());
  const topAction = String(assistantDecisionBrief?.actionNow || '').trim()
    || toActionNowLabel(
      decision?.signalLabel || decision?.signal || decision?.verdict || todayRecommendation?.frontLineBlockerGateSignal || '',
      todayRecommendation?.posture,
      blockers.length > 0
    );
  const why = String(
    assistantDecisionBrief?.why
    || todayRecommendation?.postureReason
    || decision?.signalLine
    || ''
  ).trim();
  const recommendedStrategy = String(todayRecommendation?.recommendedStrategy || 'Original Trading Plan').trim() || 'Original Trading Plan';
  const recommendedTpMode = String(todayRecommendation?.recommendedTpMode || 'Nearest').trim() || 'Nearest';
  const recommendation = `${recommendedStrategy} / ${recommendedTpMode}`;
  const frontLineRecommendationText = String(
    assistantDecisionBrief?.assistantText
    || todayRecommendation?.frontLineBlockerClearanceSummary
    || ''
  ).trim();
  const marketStateLabel = [
    todayContext?.sessionPhase ? `phase ${humanizeUnderscoreText(todayContext.sessionPhase)}` : '',
    todayContext?.regime ? `regime ${String(todayContext.regime).trim()}` : '',
    todayContext?.trend ? `trend ${String(todayContext.trend).trim()}` : '',
    todayContext?.volatility ? `vol ${String(todayContext.volatility).trim()}` : '',
  ].filter(Boolean).join(' | ');
  const nowEt = String(todayContext?.nowEt || '').trim() || null;
  const latestCheckpointTradeDate = String(
    input?.latestCheckpointTradeDate
    || todayContext?.latestCheckpointTradeDate
    || decision?.latestCheckpointTradeDate
    || ''
  ).trim() || null;
  const decisionSummary = `${topAction}${why ? ` ${why}` : ''}`.replace(/\s+/g, ' ').trim();
  const summaryParts = [
    `Action now: ${topAction}`,
    `Recommendation: ${recommendation}`,
    blockers.length ? `Blockers: ${blockers.join(', ')}` : 'Blockers: none',
    why ? `Why: ${why}` : '',
    primaryGuidance?.clearanceCondition ? `Clear when: ${primaryGuidance.clearanceCondition}` : '',
    primaryGuidance?.nextCheckWindow ? `Check again: ${primaryGuidance.nextCheckWindow}` : '',
  ].filter(Boolean);
  return {
    decisionSummary,
    recommendation,
    frontLineRecommendationText: frontLineRecommendationText || decisionSummary,
    topAction,
    blockers,
    summaryLine: summaryParts.join(' | '),
    marketStateLabel: marketStateLabel || null,
    nowEt,
    latestCheckpointTradeDate,
    advisoryOnly: true,
  };
}

function buildAssistantDecisionBrief(input = {}) {
  const decision = input?.decision && typeof input.decision === 'object' ? input.decision : {};
  const todayRecommendation = input?.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const recentAggressiveMissSentinel = input?.recentAggressiveMissSentinel
    && typeof input.recentAggressiveMissSentinel === 'object'
    ? input.recentAggressiveMissSentinel
    : null;
  const blockers = Array.isArray(decision?.blockers)
    ? decision.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const primaryGuidance = todayRecommendation?.frontLinePrimaryBlockerGuidance
    && typeof todayRecommendation.frontLinePrimaryBlockerGuidance === 'object'
    ? todayRecommendation.frontLinePrimaryBlockerGuidance
    : null;
  const signal = decision?.signalLabel || decision?.signal || decision?.verdict || todayRecommendation?.frontLineBlockerGateSignal || '';
  const actionNow = toActionNowLabel(signal, todayRecommendation?.posture, blockers.length > 0);
  const why = primaryGuidance?.blockedBy
    || String(todayRecommendation?.postureReason || '').trim()
    || String(decision?.signalLine || '').trim()
    || 'Wait for cleaner confirmation before taking this.';
  const recommendedStrategy = String(todayRecommendation?.recommendedStrategy || 'Original Trading Plan').trim() || 'Original Trading Plan';
  const recommendedTpMode = String(todayRecommendation?.recommendedTpMode || 'Nearest').trim() || 'Nearest';
  const leanIfCleared = `${recommendedStrategy}, ${recommendedTpMode === 'Nearest' ? 'nearest target' : `${recommendedTpMode} target`}.`;
  const confidence = summarizeConfidence(todayRecommendation);
  const runtimeFreshness = String(todayRecommendation?.liveRuntimeFreshnessStatus || '').trim().toLowerCase();
  const autoRepairStatus = String(todayRecommendation?.liveRuntimeAutoRepairStatus || '').trim().toLowerCase();
  const missingDerivedRows = todayRecommendation?.liveRuntimeDeterministicMissingDerivedRowsDetected === true;
  const trustMaterial = runtimeFreshness === 'stale'
    || runtimeFreshness === 'repaired'
    || autoRepairStatus === 'escalation'
    || missingDerivedRows;
  const trustRaw = trustMaterial
    ? String(todayRecommendation?.liveRuntimeLatestIntegrityIssue || '').trim()
    : '';
  const trustNote = trustRaw
    ? `Quick trust check: ${trustRaw}`
    : (trustMaterial ? 'Quick trust check: runtime health needs a quick verify before acting.' : null);
  const numericClearance = Number.isFinite(Number(primaryGuidance?.currentValue))
    && Number.isFinite(Number(primaryGuidance?.threshold))
    ? `Current vs clear: ${round2(Number(primaryGuidance.currentValue))} vs ${round2(Number(primaryGuidance.threshold))} (need +${round2(Number(primaryGuidance?.deltaToClear || 0))}, ${humanizeClearanceState(primaryGuidance?.clearanceState || '')}).`
    : null;
  const lines = [
    `Action now: ${actionNow}`,
    `Why: ${why}`,
  ];
  if (primaryGuidance?.blockedBy) {
    lines.push(`What I need to see: ${primaryGuidance.clearanceCondition || 'Cleaner confirmation before entry.'}`);
    if (numericClearance) lines.push(numericClearance);
    if (primaryGuidance?.nextCheckWindow) lines.push(`Check again: ${primaryGuidance.nextCheckWindow}`);
  if (primaryGuidance?.riskIfIgnored) lines.push(`If ignored: ${primaryGuidance.riskIfIgnored}`);
  }
  lines.push(`If it clears: ${leanIfCleared}`);
  lines.push(`Confidence: ${confidence}`);
  const recentAggressiveMissNote = buildRecentAggressiveMissSentinelNote(recentAggressiveMissSentinel);
  if (recentAggressiveMissNote) lines.push(recentAggressiveMissNote);
  if (trustNote) lines.push(trustNote);
  return {
    actionNow,
    why,
    blockedBy: primaryGuidance?.blockedBy || null,
    currentValue: Number.isFinite(Number(primaryGuidance?.currentValue)) ? round2(Number(primaryGuidance.currentValue)) : null,
    threshold: Number.isFinite(Number(primaryGuidance?.threshold)) ? round2(Number(primaryGuidance.threshold)) : null,
    deltaToClear: Number.isFinite(Number(primaryGuidance?.deltaToClear)) ? round2(Number(primaryGuidance.deltaToClear)) : null,
    clearanceState: primaryGuidance?.clearanceState || null,
    clearanceCondition: primaryGuidance?.clearanceCondition || null,
    nextCheckWindow: primaryGuidance?.nextCheckWindow || null,
    riskIfIgnored: primaryGuidance?.riskIfIgnored || null,
    leanIfCleared,
    confidence,
    recentAggressiveMissSentinel,
    recentAggressiveMissNote,
    trustNote,
    assistantText: lines.join(' '),
    assistantLines: lines,
    advisoryOnly: true,
  };
}

function applyFrontLineBlockerRecommendationGate(todayRecommendation = {}, decision = {}) {
  if (!todayRecommendation || typeof todayRecommendation !== 'object') return todayRecommendation;
  const blockers = Array.isArray(decision?.blockers)
    ? decision.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!blockers.length) return todayRecommendation;

  const signal = normalizeDecisionSignal(
    decision?.signalLabel
    || decision?.signal
    || decision?.verdict
    || ''
  );
  if (signal !== 'WAIT' && signal !== 'NO_TRADE') return todayRecommendation;

  const recommendation = { ...todayRecommendation };
  const targetPosture = signal === 'NO_TRADE' ? 'stand_down' : 'wait_for_clearance';
  const postureNeedsOverride = signal === 'NO_TRADE'
    ? String(recommendation.posture || '').trim().toLowerCase() !== 'stand_down'
    : !isDefensivePosture(recommendation.posture);
  const tpNeedsOverride = isAggressiveTpMode(recommendation.recommendedTpMode);
  if (!postureNeedsOverride && !tpNeedsOverride) return todayRecommendation;

  const blockerSummary = blockers.slice(0, 2).join(', ');
  const blockerReason = `Front-line blocker authority active (${blockerSummary}); recommendation stays defensive until blockers clear.`;

  if (postureNeedsOverride) {
    recommendation.posture = targetPosture;
    recommendation.postureReason = appendUniqueReason(recommendation.postureReason, blockerReason);
  }

  if (tpNeedsOverride) {
    recommendation.recommendedTpMode = 'Nearest';
    recommendation.tpRecommendationReason = appendUniqueReason(
      recommendation.tpRecommendationReason,
      `Front-line blocker authority active (${blockerSummary}); aggressive TP is capped to Nearest until clearance.`
    );
  }

  recommendation.frontLineBlockerGateApplied = true;
  recommendation.frontLineBlockerGateSignal = signal;
  recommendation.frontLineBlockerGateBlockers = blockers.slice(0, 3);
  recommendation.advisoryOnly = true;
  return recommendation;
}

function buildCommandCenterPanels(input = {}) {
  const strategyLayers = input.strategyLayers || {};
  const decision = input.decision || {};
  const latestSession = input.latestSession || {};
  const commandSnapshot = input.commandSnapshot || {};
  const topNews = normalizeNewsEvents(input.news || []);
  const mechanicsResearchSummary = input.mechanicsResearchSummary && typeof input.mechanicsResearchSummary === 'object'
    ? input.mechanicsResearchSummary
    : null;
  const strategyDiscovery = input.strategyDiscovery && typeof input.strategyDiscovery === 'object'
    ? input.strategyDiscovery
    : (strategyLayers?.discoverySummary && typeof strategyLayers.discoverySummary === 'object'
      ? strategyLayers.discoverySummary
      : null);
  const strategyTracking = input.strategyTracking && typeof input.strategyTracking === 'object'
    ? input.strategyTracking
    : (strategyLayers?.strategyTrackingSummary && typeof strategyLayers.strategyTrackingSummary === 'object'
      ? strategyLayers.strategyTrackingSummary
      : null);
  const strategyPortfolio = input.strategyPortfolio && typeof input.strategyPortfolio === 'object'
    ? input.strategyPortfolio
    : (strategyLayers?.strategyPortfolioSummary && typeof strategyLayers.strategyPortfolioSummary === 'object'
      ? strategyLayers.strategyPortfolioSummary
      : null);
  const strategyExperiments = input.strategyExperiments && typeof input.strategyExperiments === 'object'
    ? input.strategyExperiments
    : (strategyLayers?.strategyExperimentsSummary && typeof strategyLayers.strategyExperimentsSummary === 'object'
      ? strategyLayers.strategyExperimentsSummary
      : null);
  const recommendation = strategyLayers.recommendation || null;
  const recommendationBasis = strategyLayers.recommendationBasis || {};
  const stack = Array.isArray(strategyLayers.strategyStack) ? strategyLayers.strategyStack : [];
  const originalPlan = strategyLayers.originalPlan || stack.find((s) => s.layer === 'original') || null;
  const bestVariant = strategyLayers.bestVariant || stack.find((s) => s.layer === 'variant') || null;
  const bestAlternative = strategyLayers.bestAlternative || stack.find((s) => s.layer === 'discovery') || null;
  const todayContext = input.todayContext || {};
  const recentAggressiveMissSentinel = input.recentTooAggressiveCheckpoint
    && typeof input.recentTooAggressiveCheckpoint === 'object'
    ? input.recentTooAggressiveCheckpoint
    : null;
  const regimeDetection = todayContext.regimeDetection && typeof todayContext.regimeDetection === 'object'
    ? todayContext.regimeDetection
    : null;
  const regimeLabel = String(
    regimeDetection?.regimeLabel
    || todayContext.regime
    || todayContext.marketRegime
    || 'unknown'
  ).trim();
  const regimeReason = String(regimeDetection?.regimeReason || todayContext.regimeReason || '').trim() || null;
  const regimeConfidence = String(regimeDetection?.confidenceLabel || todayContext.regimeConfidence || '').trim().toLowerCase() || 'low';
  const regimeConfidenceScore = Number.isFinite(Number(regimeDetection?.confidenceScore))
    ? round2(Number(regimeDetection.confidenceScore))
    : (Number.isFinite(Number(todayContext.regimeConfidenceScore)) ? round2(Number(todayContext.regimeConfidenceScore)) : null);
  const basisType = String(recommendationBasis.basisType || 'baseline').toLowerCase();
  const winModel = commandSnapshot?.elite?.winModel || todayContext.winModel || {};
  const projectedWinChance = Number(winModel?.point);
  const decisionConfidence = Number(decision?.confidence);
  const recommendationKey = String(recommendation?.strategyKey || recommendationBasis?.recommendedStrategyKey || '').trim();
  const recommendedStackEntry = stack.find((entry) => String(entry?.key || '').trim() === recommendationKey)
    || originalPlan;
  const recommendationScore = Number(recommendation?.recommendationScore || recommendedStackEntry?.suitability || 0);
  const recommendationConfidence = Number.isFinite(decisionConfidence)
    ? round2(decisionConfidence)
    : round2(clampNumber((recommendationScore * 0.65) + ((Number(projectedWinChance) || 50) * 0.35), 1, 99));
  const decisionBlockers = Array.isArray(decision?.blockers)
    ? decision.blockers.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const decisionWarnings = Array.isArray(decision?.warnings)
    ? decision.warnings.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const liveConfirmationWeak = decisionBlockers.some((blocker) =>
    blocker === 'INSUFFICIENT_DECISIVE_SAMPLE'
    || blocker === 'TOP_SETUP_WEAK_20_60'
    || blocker === 'TOP_SETUP_VERY_WEAK_20_60'
  ) || decisionWarnings.some((warning) =>
    warning.includes('sample-limited')
    || warning.includes('insufficient')
    || warning.includes('underperforming')
  );
  const newsQualifier = evaluateNewsQualifier(topNews, todayContext.nowEt || '');
  const originalHistorical = buildHistoricalResemblance(originalPlan?.temporalContext || null);
  const recommendedHistorical = buildHistoricalResemblance(recommendedStackEntry?.temporalContext || null);
  const recommendationBasisLabel = basisType === 'overlay'
    ? 'Best Variant Overlay'
    : basisType === 'alternative'
      ? 'Best Alternative Strategy'
      : 'Original Trading Plan';

  const originalPlanStatus = originalPlan
    ? 'Your original trading plan remains the live baseline and is evaluated independently.'
    : 'Your original trading plan baseline is unavailable until session data loads.';
  const overlayStatus = bestVariant
    ? `Best learned overlay: ${bestVariant.name}. This is advisory unless you explicitly adopt it.`
    : 'No learned overlay currently outperforms baseline in the tested window.';
  const alternativeStatus = bestAlternative
    ? `Best alternative strategy candidate: ${bestAlternative.name}.`
    : 'No alternative strategy is currently ranked above baseline.';
  const basisNarrative = basisType === 'overlay'
    ? `Today's top recommendation is a learned overlay, not a rewrite of your original plan.`
    : basisType === 'alternative'
      ? `Today's top recommendation is an alternative strategy candidate for current conditions.`
      : 'Today the baseline recommendation remains your original trading plan.';

  const highValueBrief = {
    whatKindOfDay: `${regimeLabel} regime with ${String(todayContext.trend || todayContext.marketTrend || 'unknown')} trend.`,
    strategyRightNow: recommendation?.name || recommendationBasis?.recommendedStrategyName || 'Original Trading Plan',
    confidence: recommendationConfidence,
    keyCaution: newsQualifier.qualifier || String(decision?.caution || ''),
    nextNews: newsQualifier.nextImportantNewsTimeEt
      ? `${newsQualifier.nextImportantNewsTimeEt} ET`
      : 'No major event queued',
    currentTimeEt: String(todayContext.nowEt || ''),
    regimeTrend: `${regimeLabel} / ${String(todayContext.trend || todayContext.marketTrend || 'unknown')}`,
    historicalFit: recommendedHistorical.narrative,
  };

  const strategyStackRows = [
    originalPlan ? {
      tier: 'original_plan',
      key: originalPlan.key,
      layer: originalPlan.layer,
      name: originalPlan.name,
      winRate: Number(originalPlan.metrics?.winRate || 0),
      profitFactor: Number(originalPlan.metrics?.profitFactor || 0),
      maxDrawdownDollars: Number(originalPlan.drawdown?.maxDrawdownDollars || 0),
      currentSuitability: Number(originalPlan.suitability || 0),
      recommendationStatus: recommendationKey && recommendationKey === originalPlan.key ? 'recommended_now' : 'baseline_reference',
      pineAccess: buildPineAccessContract(originalPlan),
      pineScript: originalPlan.pineScript,
      historicalContext: originalHistorical,
    } : null,
    bestVariant ? {
      tier: 'best_variant',
      key: bestVariant.key,
      layer: bestVariant.layer,
      name: bestVariant.name,
      winRate: Number(bestVariant.metrics?.winRate || 0),
      profitFactor: Number(bestVariant.metrics?.profitFactor || 0),
      maxDrawdownDollars: Number(bestVariant.drawdown?.maxDrawdownDollars || 0),
      currentSuitability: Number(bestVariant.suitability || 0),
      recommendationStatus: recommendationKey && recommendationKey === bestVariant.key ? 'recommended_now' : 'overlay_candidate',
      pineAccess: buildPineAccessContract(bestVariant),
      pineScript: bestVariant.pineScript,
      historicalContext: buildHistoricalResemblance(bestVariant.temporalContext || null),
    } : null,
    bestAlternative ? {
      tier: 'best_alternative',
      key: bestAlternative.key,
      layer: bestAlternative.layer,
      name: bestAlternative.name,
      winRate: Number(bestAlternative.metrics?.winRate || 0),
      profitFactor: Number(bestAlternative.metrics?.profitFactor || 0),
      maxDrawdownDollars: Number(bestAlternative.drawdown?.maxDrawdownDollars || 0),
      currentSuitability: Number(bestAlternative.suitability || 0),
      recommendationStatus: recommendationKey && recommendationKey === bestAlternative.key ? 'recommended_now' : 'alternative_candidate',
      pineAccess: buildPineAccessContract(bestAlternative),
      pineScript: bestAlternative.pineScript,
      historicalContext: buildHistoricalResemblance(bestAlternative.temporalContext || null),
    } : null,
  ].filter(Boolean);

  const mechanicsInsight = (() => {
    if (!mechanicsResearchSummary || !Array.isArray(mechanicsResearchSummary.mechanicsVariantTable)
      || mechanicsResearchSummary.mechanicsVariantTable.length === 0) {
      return null;
    }
    const windowSize = Number(mechanicsResearchSummary.windowSize || 0);
    const recent = String(mechanicsResearchSummary.bestTpModeRecent || '').trim();
    const pfLeader = String(mechanicsResearchSummary.bestTpModeByProfitFactor || '').trim();
    const wrLeader = String(mechanicsResearchSummary.bestTpModeByWinRate || '').trim();
    if (!recent && !pfLeader && !wrLeader) return null;
    const scope = Number.isFinite(windowSize) && windowSize > 0
      ? `last ${windowSize} eligible trades`
      : 'recent eligible trades';
    if (pfLeader && wrLeader && pfLeader !== wrLeader) {
      return `Mechanics research (${scope}): ${wrLeader} leads win rate while ${pfLeader} leads profit factor.`;
    }
    const leader = recent || pfLeader || wrLeader;
    return `Mechanics research (${scope}): ${leader} is the strongest TP-mode candidate right now.`;
  })();

  const contextualMechanics = (() => {
    const contextual = mechanicsResearchSummary?.contextualRecommendation;
    if (!contextual || typeof contextual !== 'object') return { insight: null, confidence: null };
    const mode = String(contextual.contextualRecommendedTpMode || '').trim();
    if (!mode) return { insight: null, confidence: null };
    const contextUsed = contextual.contextUsed && typeof contextual.contextUsed === 'object'
      ? contextual.contextUsed
      : {};
    const weekday = String(contextUsed.weekday || '').trim();
    const timeBucket = String(contextUsed.timeBucket || '').trim().replace(/_/g, ' ');
    const regime = String(contextUsed.regime || '').trim();
    const sampleSize = Number(contextual.sampleSize || 0);
    const confidence = String(contextual.confidenceLabel || '').trim().toLowerCase() || 'low';
    const fallbackLevel = String(contextual.fallbackLevel || '').trim();

    let contextLabel = 'this context';
    if (weekday && timeBucket && regime) contextLabel = `${weekday} ${timeBucket} (${regime})`;
    else if (weekday && timeBucket) contextLabel = `${weekday} ${timeBucket}`;
    else if (timeBucket) contextLabel = `${timeBucket}`;
    else if (regime) contextLabel = `${regime}`;

    const fallbackPhrase = fallbackLevel && fallbackLevel !== 'exact_context'
      ? ` (fallback: ${fallbackLevel.replace(/_/g, ' ')})`
      : '';
    return {
      insight: `Contextual mechanics research suggests ${mode} TP for ${contextLabel}, confidence ${confidence}, sample ${sampleSize}${fallbackPhrase}.`,
      confidence,
    };
  })();

  const discoveryInsight = (() => {
    if (!strategyDiscovery || typeof strategyDiscovery !== 'object') return null;
    const top = strategyDiscovery?.bestCandidateOverall;
    if (!top || typeof top !== 'object') return null;
    const name = String(top.strategyName || '').trim();
    if (!name) return null;
    const wr = Number(top.winRate || 0);
    const pf = Number(top.profitFactor || 0);
    const label = String(top.robustnessLabel || 'low_confidence').trim().toLowerCase();
    const promo = String(strategyDiscovery?.candidatePromotionDecision || 'research_only').trim().toLowerCase();
    const thin = strategyDiscovery?.dataQuality?.isThinSample === true;
    const thinTag = thin ? ' Sample quality is thin.' : '';
    return `Discovery candidate: ${name} (${label}) with ${round2(wr)}% WR and PF ${round2(pf)}. Decision: ${promo.replace(/_/g, ' ')}.${thinTag}`;
  })();
  const trackingInsight = (() => {
    if (!strategyTracking || typeof strategyTracking !== 'object') return null;
    const insight = String(strategyTracking.trackingInsight || '').trim();
    if (insight) return insight;
    const leader = strategyTracking.bestTrackedStrategyNow;
    if (!leader || typeof leader !== 'object') return null;
    const name = String(leader.strategyName || '').trim();
    if (!name) return null;
    const status = String(leader.trackingStatus || '').trim().replace(/_/g, ' ');
    const handoff = String(strategyTracking.recommendationHandoffState || '').trim().replace(/_/g, ' ');
    return `Tracking: ${name} is current leader (${status}). Handoff state: ${handoff}.`;
  })();
  const portfolioInsight = (() => {
    if (!strategyPortfolio || typeof strategyPortfolio !== 'object') return null;
    const insight = String(strategyPortfolio.portfolioInsight || '').trim();
    if (insight) return insight;
    const baseline = strategyPortfolio?.baselineStrategy?.strategyName;
    const candidate = strategyPortfolio?.highestPriorityCandidate?.strategyName;
    if (baseline && candidate) return `${baseline} remains baseline; ${candidate} is the highest-priority advisory candidate.`;
    if (baseline) return `${baseline} remains baseline; no candidate has enough evidence yet.`;
    return null;
  })();
  const experimentInsight = (() => {
    if (!strategyExperiments || typeof strategyExperiments !== 'object') return null;
    const insight = String(strategyExperiments.experimentInsight || '').trim();
    if (insight) return insight;
    const top = strategyExperiments?.highestPriorityExperiment;
    if (!top || typeof top !== 'object') return null;
    const state = String(top.experimentState || '').trim().replace(/_/g, ' ');
    const name = String(top.strategyName || '').trim();
    if (!name || !state) return null;
    return `${name} is currently in ${state} shadow state and remains advisory-only.`;
  })();

  const baseResearchInsights = Array.isArray(strategyLayers.researchInsights)
    ? strategyLayers.researchInsights.slice(0, 8)
    : [];
  if (experimentInsight) baseResearchInsights.unshift(experimentInsight);
  if (portfolioInsight) baseResearchInsights.unshift(portfolioInsight);
  if (trackingInsight) baseResearchInsights.unshift(trackingInsight);
  if (discoveryInsight) baseResearchInsights.unshift(discoveryInsight);
  if (contextualMechanics.insight) baseResearchInsights.unshift(contextualMechanics.insight);
  if (mechanicsInsight) baseResearchInsights.unshift(mechanicsInsight);
  const baseTodayRecommendation = buildTodayRecommendation({
    recommendedStrategy: recommendation?.name || recommendationBasis?.recommendedStrategyName || 'Original Trading Plan',
    strategyConfidence: recommendationConfidence,
    globalRecommendedTpMode: mechanicsResearchSummary?.recommendedTpMode
      || strategyLayers?.mechanicsSummary?.recommendedTpMode
      || null,
    contextualRecommendation: mechanicsResearchSummary?.contextualRecommendation
      || null,
    projectedWinChance: Number.isFinite(projectedWinChance)
      ? round2(projectedWinChance)
      : null,
    news: newsQualifier,
    historicalContext: recommendedHistorical,
    sessionPhase: todayContext.sessionPhase || null,
    liveConfirmationWeak,
    tpGuardContext: {
      trend: regimeDetection?.evidenceSignals?.trendProfile
        || todayContext.trend
        || todayContext.marketTrend
        || null,
      volatility: regimeDetection?.evidenceSignals?.volatilityProfile
        || todayContext.volatility
        || null,
      orbProfile: regimeDetection?.evidenceSignals?.orbProfile
        || todayContext.orbProfile
        || null,
      orbRangeTicks: regimeDetection?.evidenceSignals?.orbRangeTicks
        ?? todayContext.orbRangeTicks
        ?? latestSession?.orb?.range_ticks
        ?? null,
    },
  });
  const blockerAwareTodayRecommendation = applyFrontLineBlockerRecommendationGate(baseTodayRecommendation, decision);
  const todayRecommendation = applyFrontLineBlockerClearanceGuidance(
    blockerAwareTodayRecommendation,
    decision,
    todayContext,
    commandSnapshot
  );
  const assistantDecisionBrief = buildAssistantDecisionBrief({
    decision,
    todayRecommendation,
    recentAggressiveMissSentinel,
  });
  if (recentAggressiveMissSentinel) {
    todayRecommendation.recentAggressiveMissSentinel = recentAggressiveMissSentinel;
  }
  todayRecommendation.assistantDecisionBrief = assistantDecisionBrief;
  todayRecommendation.assistantDecisionBriefText = assistantDecisionBrief.assistantText;
  const decisionQualityCard = buildDecisionQualityCard({
    decision,
    todayRecommendation,
    assistantDecisionBrief,
    todayContext,
    latestCheckpointTradeDate: input?.latestCheckpointTradeDate || null,
  });
  todayRecommendation.decisionSummary = decisionQualityCard.decisionSummary;
  todayRecommendation.recommendation = decisionQualityCard.recommendation;
  todayRecommendation.frontLineRecommendationText = decisionQualityCard.frontLineRecommendationText;
  todayRecommendation.topAction = decisionQualityCard.topAction;
  todayRecommendation.blockers = Array.isArray(decisionQualityCard.blockers) ? [...decisionQualityCard.blockers] : [];
  todayRecommendation.summaryLine = decisionQualityCard.summaryLine;
  todayRecommendation.marketStateLabel = decisionQualityCard.marketStateLabel;
  todayRecommendation.nowEt = decisionQualityCard.nowEt;
  todayRecommendation.latestCheckpointTradeDate = decisionQualityCard.latestCheckpointTradeDate;
  const decisionBoard = buildDecisionBoard({
    originalPlan,
    bestAlternative,
    strategyTracking,
    strategyPortfolio,
    strategyExperiments,
    todayRecommendation,
    todayContext,
    newsQualifier,
    confidenceReason: `Posture: ${String(todayRecommendation.postureReason || '').trim() || 'n/a'} | TP: ${String(todayRecommendation.tpRecommendationReason || '').trim() || 'n/a'}`,
  });
  decisionBoard.decisionSummary = decisionQualityCard.decisionSummary;
  decisionBoard.recommendation = decisionQualityCard.recommendation;
  decisionBoard.frontLineRecommendationText = decisionQualityCard.frontLineRecommendationText;
  decisionBoard.topAction = decisionQualityCard.topAction;
  decisionBoard.blockers = Array.isArray(decisionQualityCard.blockers) ? [...decisionQualityCard.blockers] : [];
  decisionBoard.marketStateLabel = decisionQualityCard.marketStateLabel;
  decisionBoard.nowEt = decisionQualityCard.nowEt;
  decisionBoard.latestCheckpointTradeDate = decisionQualityCard.latestCheckpointTradeDate;
  decisionBoard.topActionSummaryLine = decisionQualityCard.summaryLine;

  return {
    layout: {
      primaryPanels: ['jarvisBrief', 'strategyStack', 'todayContext'],
      secondaryPanels: ['executionLevels', 'researchInsights'],
      decluttered: true,
    },
    recommendationBasis: {
      basisType,
      basisLabel: recommendationBasisLabel,
      recommendedStrategyKey: recommendationKey || null,
      recommendedStrategyName: recommendation?.name || recommendationBasis?.recommendedStrategyName || null,
      recommendationScore: recommendationScore,
      recommendationAdjustedForNews: newsQualifier.recommendationAdjustment !== 'normal',
    },
    highValueBrief,
    decisionBoard,
    todayRecommendation,
    decisionSummary: decisionQualityCard.decisionSummary,
    recommendation: decisionQualityCard.recommendation,
    frontLineRecommendationText: decisionQualityCard.frontLineRecommendationText,
    topAction: decisionQualityCard.topAction,
    blockers: Array.isArray(decisionQualityCard.blockers) ? [...decisionQualityCard.blockers] : [],
    summaryLine: decisionQualityCard.summaryLine,
    marketStateLabel: decisionQualityCard.marketStateLabel,
    nowEt: decisionQualityCard.nowEt,
    latestCheckpointTradeDate: decisionQualityCard.latestCheckpointTradeDate,
    assistantDecisionBrief,
    assistantDecisionBriefText: assistantDecisionBrief.assistantText,
    recentAggressiveMissSentinel,
    frontLineBlockerClearanceGuidance: todayRecommendation?.frontLineBlockerClearanceGuidance || null,
    frontLinePrimaryBlockerGuidance: todayRecommendation?.frontLinePrimaryBlockerGuidance || null,
    frontLineBlockerClearanceSummary: todayRecommendation?.frontLineBlockerClearanceSummary || null,
    jarvisBrief: {
      greeting: 'Good morning.',
      currentTimeEt: String(todayContext.nowEt || ''),
      regime: regimeLabel || 'Unknown regime',
      trend: String(todayContext.trend || todayContext.marketTrend || 'Unknown trend'),
      recommendedStrategy: recommendation?.name || 'Original Trading Plan',
      recommendationBasisLabel,
      recommendationBasis: basisType,
      recommendationScore: recommendationScore,
      projectedWinChance: Number.isFinite(projectedWinChance)
        ? clampNumber(round2(projectedWinChance), 1, 99)
        : null,
      projectedWinProbability: Number.isFinite(projectedWinChance)
        ? clampNumber(round2(projectedWinChance), 1, 99)
        : null,
      confidence: recommendationConfidence,
      originalPlanStatus,
      overlayStatus,
      alternativeStatus,
      basisNarrative,
      caution: String(decision?.caution || newsQualifier.qualifier || 'Protect risk around volatility spikes and hard blockers.'),
      keyCaution: newsQualifier.qualifier || String(decision?.caution || ''),
      nextImportantNewsTimeEt: newsQualifier.nextImportantNewsTimeEt,
      nextImportantNewsTitle: newsQualifier.nextImportantNewsTitle,
      nextImportantNewsImpact: newsQualifier.nextImportantNewsImpact,
      newsRecommendationQualifier: newsQualifier.qualifier,
      recommendationAdjustedForNews: newsQualifier.recommendationAdjustment !== 'normal',
      historicalContext: {
        originalPlan: originalHistorical,
        recommendedStrategy: recommendedHistorical,
      },
      newsToWatch: topNews.slice(0, 4),
    },
    strategyStack: strategyStackRows,
    todayContext: {
      nowEt: todayContext.nowEt || null,
      sessionPhase: todayContext.sessionPhase || null,
      marketRegime: regimeLabel || null,
      regimeReason: regimeReason || null,
      regimeConfidence: regimeConfidence,
      regimeConfidenceScore: regimeConfidenceScore,
      marketTrend: todayContext.trend || todayContext.marketTrend || null,
      volatilityContext: todayContext.volatility || null,
      projectedWinChance: Number.isFinite(projectedWinChance) ? round2(projectedWinChance) : null,
      dayOfWeekPerformance: todayContext.dayOfWeekPerformance || null,
      historicalDayTime: {
        dayName: todayContext.dayName || null,
        timeBucket: todayContext.timeBucket || null,
        originalPlan: originalHistorical,
        recommendedStrategy: recommendedHistorical,
        resemblance: recommendedHistorical.stance,
      },
      upcomingNews: topNews.slice(0, 4),
      nextImportantNews: {
        timeEt: newsQualifier.nextImportantNewsTimeEt,
        title: newsQualifier.nextImportantNewsTitle,
        impact: newsQualifier.nextImportantNewsImpact,
      },
      historicalBehaviorHint: todayContext.historicalBehaviorHint || null,
    },
    regimeLabel,
    regimeReason,
    regimeConfidence,
    regimeConfidenceScore,
    regimeInsight: regimeReason
      ? `${regimeLabel} regime (${regimeConfidence} confidence): ${regimeReason}`
      : `${regimeLabel} regime (${regimeConfidence} confidence).`,
    regimeDetection: regimeDetection || null,
    executionLevels: {
      orbHigh: latestSession?.orb?.high ?? null,
      orbLow: latestSession?.orb?.low ?? null,
      orbRangeTicks: latestSession?.orb?.range_ticks ?? null,
      invalidationLevel: latestSession?.orb?.low ?? null,
      watchLevels: input.watchLevels || [],
      entryConditions: decision?.entryConditions || [],
    },
    mechanicsInsight,
    trackingInsight,
    portfolioInsight,
    experimentInsight,
    handoffState: strategyTracking?.recommendationHandoffState || null,
    trackedLeader: strategyTracking?.bestTrackedStrategyNow?.strategyName || null,
    trackedLeaderConfidence: strategyTracking?.trackedLeaderConfidence || null,
    baselineStrategy: strategyPortfolio?.baselineStrategy || null,
    highestPriorityCandidate: strategyPortfolio?.highestPriorityCandidate || null,
    portfolioSummary: strategyPortfolio?.governanceSummary || null,
    highestPriorityExperiment: strategyExperiments?.highestPriorityExperiment || null,
    experimentSummary: strategyExperiments?.experimentSummary || null,
    contextualMechanicsInsight: contextualMechanics.insight,
    contextualMechanicsConfidence: contextualMechanics.confidence,
    discoveryInsight,
    discoverySummary: strategyDiscovery
      ? {
        bestCandidateOverall: strategyDiscovery.bestCandidateOverall || null,
        candidatePromotionDecision: strategyDiscovery.candidatePromotionDecision || null,
        promotionReason: strategyDiscovery.promotionReason || null,
        dataQuality: strategyDiscovery.dataQuality || null,
        advisoryOnly: strategyDiscovery.advisoryOnly === true,
      }
      : null,
    strategyTrackingSummary: strategyTracking
      ? {
        bestTrackedStrategyNow: strategyTracking.bestTrackedStrategyNow || null,
        bestTrackedStrategyReason: strategyTracking.bestTrackedStrategyReason || null,
        recommendationHandoffState: strategyTracking.recommendationHandoffState || null,
        dataQuality: strategyTracking.dataQuality || null,
        advisoryOnly: strategyTracking.advisoryOnly === true,
      }
      : null,
    strategyPortfolioSummary: strategyPortfolio
      ? {
        baselineStrategy: strategyPortfolio.baselineStrategy || null,
        highestPriorityCandidate: strategyPortfolio.highestPriorityCandidate || null,
        governanceSummary: strategyPortfolio.governanceSummary || null,
        advisoryOnly: strategyPortfolio.advisoryOnly === true,
      }
      : null,
    strategyExperimentsSummary: strategyExperiments
      ? {
        highestPriorityExperiment: strategyExperiments.highestPriorityExperiment || null,
        experimentSummary: strategyExperiments.experimentSummary || null,
        advisoryOnly: strategyExperiments.advisoryOnly === true,
      }
      : null,
    researchInsights: baseResearchInsights,
  };
}

module.exports = {
  ORIGINAL_PLAN_SPEC,
  DEFAULT_VARIANT_SPECS,
  runPlanBacktest,
  buildVariantReports,
  buildDiscoveryLayer,
  buildStrategyLayerSnapshot,
  buildReplayVariantAssessment,
  buildCommandCenterPanels,
  buildAssistantDecisionBrief,
  buildPineScriptForStrategy,
};
