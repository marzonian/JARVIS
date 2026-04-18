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

const LIVE_CANDIDATE_STATE_MONITOR_STATE = {
  candidateStates: Object.create(null),
  observationHistoryByCandidate: Object.create(null),
  transitionRows: [],
  lastSnapshotAt: null,
  lastActionableTransition: null,
};
const LIVE_CANDIDATE_STATE_HISTORY_LIMIT = 24;
const LIVE_CANDIDATE_TRANSITION_HISTORY_LIMIT = 80;
const LIVE_CANDIDATE_STATE_OBSERVATION_TABLE = 'jarvis_live_candidate_state_observations';
const LIVE_CANDIDATE_STATE_TRANSITION_TABLE = 'jarvis_live_candidate_state_transitions';
const LIVE_CANDIDATE_DURABLE_OBSERVATION_LIMIT_PER_CANDIDATE = 120;
const LIVE_CANDIDATE_DURABLE_OBSERVATION_LIMIT_GLOBAL = 5000;
const LIVE_CANDIDATE_DURABLE_TRANSITION_LIMIT_GLOBAL = 2000;
const LIVE_CANDIDATE_RECENT_HISTORY_LIMIT = 12;
const LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT = 240;
const LIVE_CANDIDATE_LOOP_ONLY_MIN_OBSERVATIONS_FOR_INTERPRETATION = 6;
const LIVE_CANDIDATE_LOOP_ONLY_MIN_TRANSITIONS_FOR_INTERPRETATION = 1;
const LIVE_CANDIDATE_DB_STATEMENT_CACHE = new WeakMap();
const LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY = 'read_only';
const LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO = 'loop_auto';
const LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC = 'endpoint_diagnostic';
const LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN = 'legacy_unknown';

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

function cloneData(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
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

function selectTemporalContextSignal(temporalContext = {}) {
  const byDayTime = temporalContext?.byDayTimeBucket && typeof temporalContext.byDayTimeBucket === 'object'
    ? temporalContext.byDayTimeBucket
    : null;
  const byDay = temporalContext?.byDay && typeof temporalContext.byDay === 'object'
    ? temporalContext.byDay
    : null;
  const byTime = temporalContext?.byTimeBucket && typeof temporalContext.byTimeBucket === 'object'
    ? temporalContext.byTimeBucket
    : null;

  if (Number(byDayTime?.samples || 0) >= 4) {
    return {
      source: 'day_time_bucket',
      samples: Number(byDayTime.samples || 0),
      winRate: Number(byDayTime.winRate),
    };
  }
  if (Number(byDay?.samples || 0) >= Number(byTime?.samples || 0)) {
    return {
      source: 'day',
      samples: Number(byDay?.samples || 0),
      winRate: Number(byDay?.winRate),
    };
  }
  return {
    source: 'time_bucket',
    samples: Number(byTime?.samples || 0),
    winRate: Number(byTime?.winRate),
  };
}

function classifyOpportunityCalibrationBand(totalTrades = 0, temporalSamples = 0) {
  const trades = Number(totalTrades || 0);
  const temporal = Number(temporalSamples || 0);
  if (trades >= 140 && temporal >= 14) return 'high';
  if (trades >= 80 && temporal >= 8) return 'medium';
  if (trades >= 40) return 'low';
  return 'very_low';
}

function buildOpportunityScore(entry = {}, context = {}) {
  const metrics = entry?.metrics && typeof entry.metrics === 'object' ? entry.metrics : {};
  const drawdown = entry?.drawdown && typeof entry.drawdown === 'object' ? entry.drawdown : {};
  const summary = entry?.summary && typeof entry.summary === 'object' ? entry.summary : {};
  const temporalContext = entry?.temporalContext && typeof entry.temporalContext === 'object'
    ? entry.temporalContext
    : {};
  const referenceContext = deriveReferenceContext(context?.nowEt);
  const temporalSignal = selectTemporalContextSignal(temporalContext);

  const totalTrades = Number(metrics.totalTrades || summary.sessionsWithTrade || 0);
  const baseWinRate = Number.isFinite(Number(metrics.winRate))
    ? Number(metrics.winRate)
    : 50;
  const temporalWinRate = Number.isFinite(Number(temporalSignal.winRate))
    ? Number(temporalSignal.winRate)
    : null;
  const temporalSamples = Number(temporalSignal.samples || 0);
  const sampleWeight = clampNumber(totalTrades / 180, 0.1, 0.72);
  const temporalWeight = Number.isFinite(temporalWinRate)
    ? clampNumber(temporalSamples / 60, 0, 0.22)
    : 0;
  const priorWeight = clampNumber(1 - sampleWeight - temporalWeight, 0.08, 0.85);
  let opportunityWinProb = (50 * priorWeight) + (baseWinRate * sampleWeight) + ((temporalWinRate || 50) * temporalWeight);

  const phase = String(context?.sessionPhase || '').trim().toLowerCase();
  if (phase === 'orb_window' || phase === 'opening_window') opportunityWinProb += 1.5;
  else if (phase === 'entry_window' || phase === 'post_orb') opportunityWinProb += 0.8;
  else if (phase === 'pre_open') opportunityWinProb -= 2.5;
  else if (phase === 'outside_window') opportunityWinProb -= 5;

  const profitFactor = Number(metrics.profitFactor || 0);
  opportunityWinProb += clampNumber((profitFactor - 1) * 4.5, -6, 8);

  const expectancyDollars = Number(metrics.expectancyDollars || 0);
  opportunityWinProb += clampNumber(expectancyDollars / 12, -5, 5);

  const maxDrawdownDollars = Number(drawdown.maxDrawdownDollars || 0);
  opportunityWinProb -= clampNumber((maxDrawdownDollars / 2500) * 4, 0, 4);

  const suitability = Number(entry.suitability || 0);
  if (Number.isFinite(suitability)) {
    opportunityWinProb += clampNumber((suitability - 50) * 0.05, -3, 3);
  }
  opportunityWinProb = round2(clampNumber(opportunityWinProb, 1, 99));

  const avgWinDollarsRaw = Math.abs(Number(metrics.avgWinDollars || 0));
  const avgLossDollarsRaw = Math.abs(Number(metrics.avgLossDollars || 0));
  const avgWinDollars = avgWinDollarsRaw > 0 ? avgWinDollarsRaw : Math.max(40, Math.abs(expectancyDollars) + 60);
  const avgLossDollars = avgLossDollarsRaw > 0 ? avgLossDollarsRaw : Math.max(35, Math.abs(expectancyDollars) + 55);
  const impliedExpectedValue = ((opportunityWinProb / 100) * avgWinDollars) - (((100 - opportunityWinProb) / 100) * avgLossDollars);
  const opportunityExpectedValue = round2((expectancyDollars * 0.55) + (impliedExpectedValue * 0.45));

  const evNormalized = clampNumber(((opportunityExpectedValue + 80) / 200) * 100, 0, 100);
  const pfNormalized = clampNumber((profitFactor / 2.5) * 100, 0, 100);
  const opportunityCompositeScore = round2(
    (opportunityWinProb * 0.62)
    + (evNormalized * 0.28)
    + (pfNormalized * 0.10)
  );
  const opportunityCalibrationBand = classifyOpportunityCalibrationBand(totalTrades, temporalSamples);

  const opportunityFeatureVector = {
    strategyKey: String(entry?.key || '').trim() || null,
    strategyLayer: String(entry?.layer || '').trim().toLowerCase() || null,
    sessionPhase: phase || null,
    referenceDay: referenceContext?.dayNameLower || null,
    referenceTimeBucket: referenceContext?.bucketId || null,
    regime: String(context?.regime || context?.marketRegime || '').trim() || null,
    trend: String(context?.trend || context?.marketTrend || '').trim() || null,
    volatility: String(context?.volatility || '').trim() || null,
    orbRangeTicks: Number.isFinite(Number(context?.orbRangeTicks)) ? Number(context.orbRangeTicks) : null,
    totalTrades: Number.isFinite(totalTrades) ? Math.round(totalTrades) : null,
    winRate: round2(baseWinRate),
    profitFactor: round2(profitFactor),
    expectancyDollars: round2(expectancyDollars),
    tradeFrequencyPct: Number.isFinite(Number(summary.tradeFrequencyPct)) ? round2(Number(summary.tradeFrequencyPct)) : null,
    maxDrawdownDollars: Number.isFinite(maxDrawdownDollars) ? round2(maxDrawdownDollars) : null,
    temporalContextSource: temporalSignal.source || null,
    temporalContextSamples: Number.isFinite(temporalSamples) ? Math.round(temporalSamples) : null,
    temporalContextWinRate: Number.isFinite(temporalWinRate) ? round2(temporalWinRate) : null,
  };
  const opportunityScoreSummaryLine = `Win ${opportunityWinProb}% | EV $${opportunityExpectedValue} | ${opportunityCalibrationBand} calibration`;

  return {
    opportunityWinProb,
    opportunityExpectedValue,
    opportunityCalibrationBand,
    opportunityFeatureVector,
    opportunityCompositeScore,
    opportunityScoreSummaryLine,
  };
}

function buildOpportunityScoringLayer({ strategyStack = [], context = {}, recommendation = null } = {}) {
  const baseRows = (Array.isArray(strategyStack) ? strategyStack : []).map((entry) => {
    const heuristic = computeRecommendationPriority(entry, context);
    const opportunity = buildOpportunityScore(entry, context);
    return {
      key: String(entry?.key || '').trim() || null,
      name: String(entry?.name || '').trim() || null,
      layer: String(entry?.layer || '').trim().toLowerCase() || null,
      heuristicCompositeScore: round2(Number(heuristic?.composite || entry?.suitability || entry?.score || 0)),
      heuristicComponents: heuristic?.components || null,
      ...opportunity,
    };
  });

  const heuristicSorted = [...baseRows].sort(
    (a, b) => Number(b.heuristicCompositeScore || 0) - Number(a.heuristicCompositeScore || 0)
  );
  const opportunitySorted = [...baseRows].sort(
    (a, b) => Number(b.opportunityCompositeScore || 0) - Number(a.opportunityCompositeScore || 0)
  );
  const heuristicRankMap = new Map();
  const opportunityRankMap = new Map();
  heuristicSorted.forEach((row, index) => {
    heuristicRankMap.set(String(row.key || ''), index + 1);
  });
  opportunitySorted.forEach((row, index) => {
    opportunityRankMap.set(String(row.key || ''), index + 1);
  });

  const comparisonRows = baseRows.map((row) => {
    const heuristicRank = Number(heuristicRankMap.get(String(row.key || '')) || null);
    const opportunityRank = Number(opportunityRankMap.get(String(row.key || '')) || null);
    const rankDelta = Number.isFinite(heuristicRank) && Number.isFinite(opportunityRank)
      ? heuristicRank - opportunityRank
      : null;
    return {
      ...row,
      heuristicRank,
      opportunityRank,
      rankDelta,
      heuristicVsOpportunityAgreement: heuristicRank === opportunityRank ? 'agree' : 'disagree',
      heuristicVsOpportunityComparison: {
        heuristicScore: row.heuristicCompositeScore,
        opportunityScore: row.opportunityCompositeScore,
        agreement: heuristicRank === opportunityRank,
        status: heuristicRank === opportunityRank ? 'agree' : 'disagree',
      },
    };
  });

  const recommendedByHeuristic = heuristicSorted[0] || null;
  const recommendedByOpportunity = opportunitySorted[0] || null;
  const recommendationKey = String(recommendation?.strategyKey || '').trim();
  const heuristicAgreement = String(recommendedByHeuristic?.key || '') === String(recommendedByOpportunity?.key || '');
  const matchesLiveRecommendation = recommendationKey
    ? recommendationKey === String(recommendedByOpportunity?.key || '')
    : null;
  const summaryLine = recommendedByOpportunity
    ? `Opportunity shadow scorer: ${recommendedByOpportunity.name || recommendedByOpportunity.key} at ${round2(recommendedByOpportunity.opportunityWinProb)}% win, EV $${round2(recommendedByOpportunity.opportunityExpectedValue)} (${heuristicAgreement ? 'agrees' : 'disagrees'} with heuristic).`
    : 'Opportunity shadow scorer unavailable.';

  return {
    recommendedByHeuristicKey: recommendedByHeuristic?.key || null,
    recommendedByOpportunityKey: recommendedByOpportunity?.key || null,
    recommendedByOpportunityName: recommendedByOpportunity?.name || null,
    heuristicVsOpportunityAgreement: heuristicAgreement,
    matchesLiveRecommendation,
    heuristicVsOpportunityComparison: {
      heuristicTopKey: recommendedByHeuristic?.key || null,
      opportunityTopKey: recommendedByOpportunity?.key || null,
      agreement: heuristicAgreement,
      status: heuristicAgreement ? 'agree' : 'disagree',
      matchesLiveRecommendation,
      summaryLine: heuristicAgreement
        ? `Heuristic and opportunity scorer align on ${recommendedByOpportunity?.name || recommendedByOpportunity?.key || 'current top strategy'}.`
        : `Heuristic favors ${recommendedByHeuristic?.name || recommendedByHeuristic?.key || 'unknown'} while opportunity scorer favors ${recommendedByOpportunity?.name || recommendedByOpportunity?.key || 'unknown'}.`,
    },
    comparisonRows: comparisonRows.sort(
      (a, b) => Number(a.opportunityRank || 999) - Number(b.opportunityRank || 999)
    ),
    summaryLine,
    advisoryOnly: true,
  };
}

function deriveCandidateTimeBucket(sessionPhase = '', fallbackBucket = '') {
  const phase = String(sessionPhase || '').trim().toLowerCase();
  const fallback = String(fallbackBucket || '').trim().toLowerCase();
  if (phase === 'pre_open') return { id: 'pre_open_watch', label: 'Pre-open watch' };
  if (phase === 'orb_window' || phase === 'opening_window') return { id: 'orb_window', label: 'ORB confirmation window' };
  if (phase === 'entry_window' || phase === 'post_orb' || phase === 'momentum_window') return { id: 'entry_window', label: 'Primary entry window' };
  if (phase === 'outside_window' || phase === 'late_window') return { id: 'next_session_setup', label: 'Next-session setup window' };
  if (fallback) return { id: fallback, label: humanizeUnderscoreText(fallback) };
  return { id: 'context_pending', label: 'Context pending' };
}

function inferCandidateDirection(decision = {}, todayContext = {}, topSetup = null) {
  const setupId = String(topSetup?.setupId || '').trim().toLowerCase();
  const setupName = String(topSetup?.name || '').trim().toLowerCase();
  const setupText = `${setupId} ${setupName}`;
  if (setupText.includes('short') || setupText.includes('fade_down')) return 'short';
  if (setupText.includes('long') || setupText.includes('fade_up')) return 'long';
  const signalLine = String(decision?.signalLine || '').trim().toLowerCase();
  if (signalLine.includes('short')) return 'short';
  if (signalLine.includes('long')) return 'long';
  const trend = String(todayContext?.trend || todayContext?.marketTrend || '').trim().toLowerCase();
  if (trend.includes('down')) return 'short';
  return 'long';
}

function deriveCandidateType(strategyLayer = '', strategyKey = '') {
  const layer = String(strategyLayer || '').trim().toLowerCase();
  const key = String(strategyKey || '').trim().toLowerCase();
  if (layer === 'discovery') return 'alternative_discovery_setup';
  if (layer === 'variant') {
    if (key.includes('skip_monday') && key.includes('orb')) return 'orb_overlay_filter';
    if (key.includes('nearest')) return 'orb_nearest_tp_overlay';
    return 'orb_variant_overlay';
  }
  return 'orb_continuation_retest';
}

function deriveTopSetupCandidateType(topSetup = null) {
  const setupId = String(topSetup?.setupId || '').trim().toLowerCase();
  const setupName = String(topSetup?.name || '').trim().toLowerCase();
  const text = `${setupId} ${setupName}`;
  if (!text) return 'decision_setup_watch';
  if (text.includes('reversal') || text.includes('fade')) return 'failed_extension_reversal';
  if (text.includes('retest')) return 'retest_continuation';
  if (text.includes('breakout') || text.includes('continuation')) return 'breakout_continuation';
  return 'decision_setup_watch';
}

function classifyPriceLocationVsOrb({ referencePrice = null, orbHigh = null, orbLow = null } = {}) {
  const px = Number(referencePrice);
  const hi = Number(orbHigh);
  const lo = Number(orbLow);
  if (!Number.isFinite(px) || !Number.isFinite(hi) || !Number.isFinite(lo)) return 'unknown';
  if (hi <= lo) return 'unknown';
  const orbRange = hi - lo;
  const extensionThreshold = orbRange * 0.12;
  const mid = lo + (orbRange / 2);
  if (px >= hi + extensionThreshold) return 'above_orb_high_extended';
  if (px > hi) return 'above_orb_high';
  if (px <= lo - extensionThreshold) return 'below_orb_low_extended';
  if (px < lo) return 'below_orb_low';
  if (px >= mid) return 'inside_orb_upper';
  return 'inside_orb_lower';
}

function inferLiveStructureCandidateType({
  topSetup = null,
  todayContext = {},
  latestSession = {},
  signal = '',
  blockerCount = 0,
} = {}) {
  const topSetupType = deriveTopSetupCandidateType(topSetup);
  if (topSetupType === 'failed_extension_reversal' || topSetupType === 'retest_continuation' || topSetupType === 'breakout_continuation') {
    return topSetupType;
  }
  const normalizedSignal = normalizeDecisionSignal(signal);
  const noTradeReason = String(latestSession?.no_trade_reason || '').trim().toLowerCase();
  const phase = String(todayContext?.sessionPhase || '').trim().toLowerCase();
  const trend = String(todayContext?.trend || todayContext?.marketTrend || '').trim().toLowerCase();
  if (blockerCount > 0) return 'blocked_context_watch';
  if (noTradeReason.includes('entry_after_max_hour') || phase === 'outside_window' || phase === 'late_window') return 'late_session_structure_watch';
  if (noTradeReason.includes('no_confirmation') || normalizedSignal === 'WAIT') return 'retest_continuation_watch';
  if (trend.includes('up') || trend.includes('down') || normalizedSignal === 'TRADE') return 'breakout_continuation';
  return 'range_reversion_watch';
}

function inferLiveStructureDirection({
  decision = {},
  todayContext = {},
  topSetup = null,
  priceLocationVsOrb = 'unknown',
} = {}) {
  const setupDirection = inferCandidateDirection(decision, todayContext, topSetup);
  if (priceLocationVsOrb === 'above_orb_high_extended') return 'short';
  if (priceLocationVsOrb === 'below_orb_low_extended') return 'long';
  return setupDirection;
}

function classifyCandidateStatus({ signal = '', blockerCount = 0, sessionPhase = '', isRecommendedStrategy = false }) {
  const normalizedSignal = normalizeDecisionSignal(signal);
  const phase = String(sessionPhase || '').trim().toLowerCase();
  if (normalizedSignal === 'NO_TRADE') return 'blocked';
  if (phase === 'outside_window' || phase === 'late_window') return blockerCount > 0 ? 'blocked' : 'await_next_session';
  if (phase === 'pre_open') return 'pre_open_watch';
  if (normalizedSignal === 'WAIT') return blockerCount > 0 ? 'blocked' : 'watch_trigger';
  if (normalizedSignal === 'TRADE' && blockerCount <= 0) return isRecommendedStrategy ? 'ready_now' : 'secondary_watch';
  if (blockerCount > 0) return 'blocked';
  return isRecommendedStrategy ? 'watch_trigger' : 'secondary_watch';
}

function statusToCandidateAdjustment(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'ready_now') return { winProb: 1.8, ev: 7, score: 2.5 };
  if (normalized === 'secondary_watch') return { winProb: 0.8, ev: 2, score: 1.2 };
  if (normalized === 'watch_trigger') return { winProb: -0.8, ev: -4, score: -1.5 };
  if (normalized === 'pre_open_watch') return { winProb: -1.2, ev: -6, score: -2.2 };
  if (normalized === 'await_next_session') return { winProb: -1.5, ev: -8, score: -2.8 };
  if (normalized === 'blocked') return { winProb: -4.5, ev: -28, score: -7 };
  return { winProb: 0, ev: 0, score: 0 };
}

function isApprovedShadowActionWindow(sessionPhase = '') {
  const approvedActionWindows = new Set(['orb_window', 'opening_window', 'entry_window', 'post_orb', 'momentum_window']);
  const normalizedPhase = String(sessionPhase || '').trim().toLowerCase();
  return approvedActionWindows.has(normalizedPhase);
}

function isCandidateActionableNow(candidate = {}, options = {}) {
  const phase = String(candidate?.sessionPhase || options?.sessionPhase || '').trim().toLowerCase();
  const status = String(candidate?.candidateStatus || '').trim().toLowerCase();
  const expectedValue = Number(candidate?.candidateExpectedValue);
  const structureQualityScore = Number(candidate?.structureQualityScore);
  const structureQualityLabel = String(candidate?.structureQualityLabel || '').trim().toLowerCase();
  const negativeEvTolerance = Number.isFinite(Number(options?.negativeEvTolerance))
    ? Number(options.negativeEvTolerance)
    : -15;
  const minStructureQualityScore = Number.isFinite(Number(options?.minStructureQualityScore))
    ? Number(options.minStructureQualityScore)
    : 58;
  if (status === 'blocked') return false;
  if (status === 'await_next_session') return false;
  if (!isApprovedShadowActionWindow(phase)) return false;
  if (Number.isFinite(expectedValue) && expectedValue < negativeEvTolerance) return false;
  if (structureQualityLabel === 'poor') return false;
  if (Number.isFinite(structureQualityScore) && structureQualityScore < minStructureQualityScore) return false;
  return status === 'ready_now' || status === 'secondary_watch' || status === 'watch_trigger';
}

function buildCandidateQualityPenalty({
  candidateStatus = '',
  candidateExpectedValue = null,
  sessionPhase = '',
} = {}) {
  const status = String(candidateStatus || '').trim().toLowerCase();
  const phase = String(sessionPhase || '').trim().toLowerCase();
  const ev = Number(candidateExpectedValue);
  const reasonCodes = [];
  let penalty = 0;

  if (status === 'blocked') {
    penalty -= 18;
    reasonCodes.push('blocked_candidate');
  } else if (status === 'await_next_session') {
    penalty -= 9;
    reasonCodes.push('next_session_only');
  } else if (status === 'pre_open_watch') {
    penalty -= 7;
    reasonCodes.push('pre_open_watch');
  } else if (status === 'watch_trigger') {
    penalty -= 4;
    reasonCodes.push('watch_trigger_only');
  }

  if (!isApprovedShadowActionWindow(phase) && status !== 'await_next_session') {
    penalty -= 12;
    reasonCodes.push('outside_action_window');
  }
  if (phase === 'late_window' || phase === 'outside_window') {
    penalty -= 6;
    reasonCodes.push('late_or_outside_phase');
  }

  if (Number.isFinite(ev) && ev < 0) {
    if (ev <= -60) {
      penalty -= 16;
      reasonCodes.push('deep_negative_ev');
    } else if (ev <= -25) {
      penalty -= 10;
      reasonCodes.push('strong_negative_ev');
    } else if (ev < -5) {
      penalty -= 6;
      reasonCodes.push('negative_ev');
    } else {
      penalty -= 3;
      reasonCodes.push('slightly_negative_ev');
    }
  }

  return {
    penalty: round2(penalty),
    reasonCodes,
  };
}

function buildCandidateSummaryLine(row = {}, blockers = []) {
  const status = String(row?.candidateStatus || '').trim().toLowerCase();
  const name = String(row?.strategyName || row?.strategyKey || 'Candidate').trim();
  const direction = String(row?.direction || 'long').trim().toUpperCase();
  const timeLabel = String(row?.timeBucketLabel || '').trim();
  if (status === 'ready_now') return `${name}: ${direction} candidate is live in ${timeLabel}.`;
  if (status === 'secondary_watch') return `${name}: ${direction} is secondary, monitor trigger quality in ${timeLabel}.`;
  if (status === 'watch_trigger') return `${name}: ${direction} setup is watch-only until cleaner trigger prints.`;
  if (status === 'pre_open_watch') return `${name}: pre-open watch; confirm ORB structure before entry.`;
  if (status === 'await_next_session') return `${name}: queue ${direction} candidate for next session opening window.`;
  const blockerText = blockers.length ? blockers.slice(0, 2).join(', ').toLowerCase() : 'active blockers';
  return `${name}: blocked by ${blockerText}; avoid entry for now.`;
}

function evaluateStructureQuality({
  candidateStatus = '',
  candidateType = '',
  candidateSource = '',
  sessionPhase = '',
  normalizedSignal = '',
  blockers = [],
  topSetupProbability = null,
  candidateExpectedValue = null,
  noTradeReason = '',
  priceLocationVsOrb = 'unknown',
} = {}) {
  let score = 50;
  const reasonCodes = [];
  const pushReason = (code, delta = 0) => {
    if (!code) return;
    reasonCodes.push(String(code).trim().toLowerCase());
    score += Number(delta || 0);
  };

  const status = String(candidateStatus || '').trim().toLowerCase();
  const type = String(candidateType || '').trim().toLowerCase();
  const source = String(candidateSource || '').trim().toLowerCase();
  const phase = String(sessionPhase || '').trim().toLowerCase();
  const signal = String(normalizedSignal || '').trim().toUpperCase();
  const setupProb = Number(topSetupProbability);
  const expectedValue = Number(candidateExpectedValue);
  const blockerList = Array.isArray(blockers) ? blockers : [];
  const noTrade = String(noTradeReason || '').trim().toLowerCase();
  const location = String(priceLocationVsOrb || '').trim().toLowerCase();

  if (status === 'ready_now') pushReason('ready_context', 12);
  else if (status === 'secondary_watch') pushReason('secondary_watch_context', 5);
  else if (status === 'watch_trigger') pushReason('watch_trigger_context', -5);
  else if (status === 'await_next_session') pushReason('outside_action_window', -10);
  else if (status === 'blocked') pushReason('blocked_context', -28);

  if (signal === 'TRADE') pushReason('trade_signal_active', 7);
  else if (signal === 'WAIT') pushReason('wait_signal', -5);
  else if (signal === 'NO_TRADE') pushReason('no_trade_signal', -10);

  if (blockerList.length > 0) {
    const blockerPenalty = Math.min(24, blockerList.length * 8);
    pushReason('blocked_context', -blockerPenalty);
  }

  if (Number.isFinite(setupProb)) {
    if (setupProb >= 65) pushReason('strong_breakout_setup', 9);
    else if (setupProb >= 55) pushReason('moderate_breakout_setup', 4);
    else if (setupProb < 45) pushReason('weak_breakout_setup', -8);
  }

  if (Number.isFinite(expectedValue)) {
    if (expectedValue >= 25) pushReason('strong_follow_through', 8);
    else if (expectedValue >= 5) pushReason('moderate_follow_through', 4);
    else if (expectedValue < -25) pushReason('weak_follow_through', -12);
    else if (expectedValue < 0) pushReason('weak_follow_through', -7);
  }

  if (phase === 'entry_window' || phase === 'post_orb' || phase === 'orb_window' || phase === 'momentum_window') {
    pushReason('in_action_window', 6);
  } else if (phase === 'outside_window' || phase === 'late_window') {
    pushReason('outside_action_window', -10);
  } else if (phase === 'pre_open') {
    pushReason('pre_open_uncertain', -6);
  }

  if (type.includes('blocked_context_watch')) pushReason('unclear_structure', -12);
  if (type.includes('retest_continuation_watch')) pushReason('no_clean_retest', -8);
  if (type.includes('failed_extension_reversal')) pushReason('reversal_structure_present', 4);

  if (noTrade.includes('entry_after_max_hour')) pushReason('overextended_move', -9);
  if (noTrade.includes('no_confirmation')) pushReason('no_clean_retest', -10);
  if (noTrade.includes('no_follow_through')) pushReason('weak_follow_through', -10);
  if (noTrade.includes('range_overextended')) pushReason('overextended_move', -12);

  if (location === 'above_orb_high_extended' || location === 'below_orb_low_extended') {
    if (type.includes('failed_extension_reversal')) pushReason('reversal_extension_setup', 5);
    else pushReason('overextended_move', -8);
  } else if (location === 'inside_orb_upper' || location === 'inside_orb_lower') {
    pushReason('inside_orb_balance', 2);
  }

  if (source === 'live_structure') pushReason('live_structure_context', 3);
  if (source === 'decision_top_setup') pushReason('decision_setup_context', 2);

  const uniqueReasonCodes = [...new Set(reasonCodes)];
  const structureQualityScore = round2(clampNumber(score, 1, 99));
  const structureQualityLabel = structureQualityScore >= 72
    ? 'clean'
    : structureQualityScore >= 55
      ? 'mixed'
      : 'poor';

  let structureQualitySummaryLine = 'Mixed structure: monitor trigger quality.';
  if (structureQualityLabel === 'clean') {
    structureQualitySummaryLine = 'Clean structure: breakout/retest context is aligned.';
  } else if (structureQualityLabel === 'poor') {
    if (uniqueReasonCodes.includes('blocked_context')) structureQualitySummaryLine = 'Poor structure: blocked context.';
    else if (uniqueReasonCodes.includes('overextended_move')) structureQualitySummaryLine = 'Poor structure: overextended move.';
    else if (uniqueReasonCodes.includes('no_clean_retest')) structureQualitySummaryLine = 'Poor structure: no clean retest.';
    else if (uniqueReasonCodes.includes('weak_follow_through')) structureQualitySummaryLine = 'Poor structure: weak follow-through.';
    else if (uniqueReasonCodes.includes('unclear_structure')) structureQualitySummaryLine = 'Poor structure: unclear setup.';
    else structureQualitySummaryLine = 'Poor structure: avoid entry.';
  } else {
    if (uniqueReasonCodes.includes('no_clean_retest')) structureQualitySummaryLine = 'Mixed structure: retest is not clean yet.';
    else if (uniqueReasonCodes.includes('weak_follow_through')) structureQualitySummaryLine = 'Mixed structure: follow-through is weak.';
  }

  return {
    structureQualityScore,
    structureQualityLabel,
    structureQualityReasonCodes: uniqueReasonCodes,
    structureQualitySummaryLine,
  };
}

function buildLiveOpportunityCandidates(input = {}) {
  const strategyStack = Array.isArray(input?.strategyStack) ? input.strategyStack : [];
  const opportunityScoring = input?.opportunityScoring && typeof input.opportunityScoring === 'object'
    ? input.opportunityScoring
    : {};
  const recommendationKey = String(input?.recommendationKey || '').trim();
  const decision = input?.decision && typeof input.decision === 'object' ? input.decision : {};
  const todayContext = input?.todayContext && typeof input.todayContext === 'object' ? input.todayContext : {};
  const latestSession = input?.latestSession && typeof input.latestSession === 'object' ? input.latestSession : {};
  const regimeLabel = String(input?.regimeLabel || todayContext?.regime || todayContext?.marketRegime || 'unknown').trim();
  const projectedWinChance = Number(input?.projectedWinChance);
  const blockers = Array.isArray(decision?.blockers)
    ? decision.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const topSetup = Array.isArray(decision?.topSetups) && decision.topSetups.length
    ? decision.topSetups[0]
    : null;
  const signal = decision?.signalLabel || decision?.signal || decision?.verdict || '';
  const timeBucket = deriveCandidateTimeBucket(todayContext?.sessionPhase || '', todayContext?.timeBucket || '');
  const topSetupProbabilityRaw = Number(topSetup?.probability);
  const topSetupProbability = Number.isFinite(topSetupProbabilityRaw)
    ? (topSetupProbabilityRaw <= 1 ? (topSetupProbabilityRaw * 100) : topSetupProbabilityRaw)
    : null;
  const topSetupExpectedValue = Number.isFinite(Number(topSetup?.expectedValueDollars))
    ? Number(topSetup.expectedValueDollars)
    : null;
  const topSetupAnnualizedTrades = Number.isFinite(Number(topSetup?.annualizedTrades))
    ? Number(topSetup.annualizedTrades)
    : null;
  const topSetupCandidateType = deriveTopSetupCandidateType(topSetup);
  const normalizedSignal = normalizeDecisionSignal(signal);

  const opportunityByStrategyKey = new Map(
    (Array.isArray(opportunityScoring?.comparisonRows) ? opportunityScoring.comparisonRows : [])
      .map((row) => [String(row?.key || '').trim(), row])
  );
  const recommendationOpportunityRow = opportunityByStrategyKey.get(recommendationKey) || {};
  const orbHigh = Number(latestSession?.orb?.high);
  const orbLow = Number(latestSession?.orb?.low);
  const orbMid = Number.isFinite(orbHigh) && Number.isFinite(orbLow)
    ? round2((orbHigh + orbLow) / 2)
    : null;
  const referencePrice = Number.isFinite(Number(latestSession?.trade?.entry_price))
    ? Number(latestSession.trade.entry_price)
    : (Number.isFinite(Number(latestSession?.trade?.exit_price)) ? Number(latestSession.trade.exit_price) : null);
  const priceLocationVsOrb = classifyPriceLocationVsOrb({
    referencePrice,
    orbHigh: Number.isFinite(orbHigh) ? orbHigh : null,
    orbLow: Number.isFinite(orbLow) ? orbLow : null,
  });
  const latestNoTradeReason = String(latestSession?.no_trade_reason || '').trim().toLowerCase() || null;

  const buildCandidateRow = ({
    strategyKey = '',
    strategyLayer = '',
    strategyName = '',
    candidateType = 'context_candidate',
    candidateSource = 'strategy_stack',
    direction = 'long',
    isRecommendedStrategy = false,
    opportunityRow = {},
    candidateWinProbOverride = null,
    candidateExpectedValueOverride = null,
    probBias = 0,
    evBias = 0,
    scoreBias = 0,
    triggerStructureExtras = {},
    featureVectorExtras = {},
    noTradeReasonOverride = latestNoTradeReason,
    priceLocationOverride = priceLocationVsOrb,
  } = {}) => {
    const candidateStatus = classifyCandidateStatus({
      signal,
      blockerCount: blockers.length,
      sessionPhase: todayContext?.sessionPhase || '',
      isRecommendedStrategy,
    });
    const statusAdjustment = statusToCandidateAdjustment(candidateStatus);
    const strategyWinProb = Number.isFinite(Number(opportunityRow?.opportunityWinProb))
      ? Number(opportunityRow.opportunityWinProb)
      : 50;
    const strategyExpectedValue = Number.isFinite(Number(opportunityRow?.opportunityExpectedValue))
      ? Number(opportunityRow.opportunityExpectedValue)
      : 0;
    const blendedSetupProb = Number.isFinite(topSetupProbability)
      ? ((strategyWinProb * 0.72) + (topSetupProbability * 0.28))
      : strategyWinProb;
    let candidateWinProbBase = Number.isFinite(Number(candidateWinProbOverride))
      ? Number(candidateWinProbOverride)
      : blendedSetupProb;
    if (Number.isFinite(projectedWinChance)) {
      candidateWinProbBase = (candidateWinProbBase * 0.84) + (projectedWinChance * 0.16);
    }
    const candidateWinProb = round2(clampNumber(
      candidateWinProbBase + statusAdjustment.winProb + Number(probBias || 0),
      1,
      99
    ));
    const candidateExpectedValueBase = Number.isFinite(Number(candidateExpectedValueOverride))
      ? Number(candidateExpectedValueOverride)
      : ((strategyExpectedValue * 0.7)
        + ((Number.isFinite(topSetupExpectedValue) ? topSetupExpectedValue : strategyExpectedValue) * 0.3));
    const candidateExpectedValue = round2(candidateExpectedValueBase + statusAdjustment.ev + Number(evBias || 0));

    const strategyTradesFallback = strategyStack.find((s) => String(s?.key || '').trim() === String(strategyKey || '').trim())?.metrics?.totalTrades;
    const strategyTradesRaw = featureVectorExtras?.strategyTotalTrades ?? strategyTradesFallback ?? 0;
    const strategyTrades = Number(strategyTradesRaw);
    const temporalSamples = Number(opportunityRow?.opportunityFeatureVector?.temporalContextSamples || 0);
    const annualizedSample = Number.isFinite(topSetupAnnualizedTrades)
      ? Math.max(0, Math.min(120, Math.round(topSetupAnnualizedTrades / 12)))
      : 0;
    const candidateCalibrationBand = classifyOpportunityCalibrationBand(strategyTrades + annualizedSample, temporalSamples);
    const evNormalized = clampNumber(((candidateExpectedValue + 80) / 200) * 100, 0, 100);
    const strategyScore = Number.isFinite(Number(opportunityRow?.opportunityCompositeScore))
      ? Number(opportunityRow.opportunityCompositeScore)
      : Number(opportunityRow?.heuristicCompositeScore || 0);
    const candidateQualityPenalty = buildCandidateQualityPenalty({
      candidateStatus,
      candidateExpectedValue,
      sessionPhase: todayContext?.sessionPhase || '',
    });
    const baseCandidateScore = round2(clampNumber(
      (candidateWinProb * 0.6)
      + (evNormalized * 0.3)
      + (strategyScore * 0.1)
      + statusAdjustment.score
      + Number(scoreBias || 0),
      0,
      100
    ));
    const candidateCompositeScore = round2(clampNumber(
      baseCandidateScore + Number(candidateQualityPenalty.penalty || 0),
      0,
      100
    ));

    const triggerStructure = {
      signal: normalizedSignal,
      topSetupId: String(topSetup?.setupId || '').trim() || null,
      topSetupName: String(topSetup?.name || '').trim() || null,
      topSetupProbability: Number.isFinite(topSetupProbability) ? round2(topSetupProbability) : null,
      topSetupExpectedValue: Number.isFinite(topSetupExpectedValue) ? round2(topSetupExpectedValue) : null,
      entryConditions: Array.isArray(decision?.entryConditions) ? decision.entryConditions.slice(0, 3) : [],
      blockers: blockers.slice(0, 3),
      ...triggerStructureExtras,
    };
    const structureQuality = evaluateStructureQuality({
      candidateStatus,
      candidateType,
      candidateSource,
      sessionPhase: todayContext?.sessionPhase || '',
      normalizedSignal,
      blockers,
      topSetupProbability,
      candidateExpectedValue,
      noTradeReason: noTradeReasonOverride,
      priceLocationVsOrb: priceLocationOverride,
    });
    const candidateKey = `${candidateSource}:${strategyKey || 'strategy'}:${candidateType}:${direction}:${timeBucket.id}`;
    const entryWindow = timeBucket.id === 'next_session_setup'
      ? 'Next session 09:30-11:00 ET'
      : timeBucket.id === 'pre_open_watch'
        ? 'Pre-open to ORB confirmation'
        : '09:30-11:00 ET';
    const candidateFeatureVector = {
      strategyKey: strategyKey || null,
      strategyLayer: strategyLayer || null,
      candidateSource,
      candidateType,
      direction,
      sessionPhase: String(todayContext?.sessionPhase || '').trim().toLowerCase() || null,
      timeBucket: timeBucket.id,
      regime: regimeLabel || null,
      trend: String(todayContext?.trend || todayContext?.marketTrend || '').trim() || null,
      volatility: String(todayContext?.volatility || '').trim() || null,
      orbRangeTicks: Number.isFinite(Number(todayContext?.orbRangeTicks)) ? Number(todayContext.orbRangeTicks) : null,
      topSetupId: triggerStructure.topSetupId,
      topSetupProbability: triggerStructure.topSetupProbability,
      topSetupExpectedValue: triggerStructure.topSetupExpectedValue,
      projectedWinChance: Number.isFinite(projectedWinChance) ? round2(projectedWinChance) : null,
      strategyOpportunityWinProb: Number.isFinite(Number(opportunityRow?.opportunityWinProb))
        ? round2(Number(opportunityRow.opportunityWinProb))
        : null,
      strategyOpportunityExpectedValue: Number.isFinite(Number(opportunityRow?.opportunityExpectedValue))
        ? round2(Number(opportunityRow.opportunityExpectedValue))
        : null,
      strategyTotalTrades: Number.isFinite(strategyTrades) ? Math.round(strategyTrades) : null,
      structureQualityScore: structureQuality.structureQualityScore,
      structureQualityLabel: structureQuality.structureQualityLabel,
      structureQualityReasonCodes: structureQuality.structureQualityReasonCodes,
      ...featureVectorExtras,
    };
    const candidateScoreSummaryLine = `Win ${candidateWinProb}% | EV $${candidateExpectedValue} | ${candidateCalibrationBand} calibration | ${structureQuality.structureQualityLabel} structure`;
    const candidateRow = {
      candidateKey,
      strategyKey: strategyKey || null,
      strategyName: strategyName || strategyKey || 'Strategy',
      strategyLayer: strategyLayer || null,
      candidateSource,
      candidateType,
      direction,
      entryWindow,
      sessionPhase: String(todayContext?.sessionPhase || '').trim().toLowerCase() || null,
      timeBucket: timeBucket.id,
      timeBucketLabel: timeBucket.label,
      regime: regimeLabel || null,
      triggerStructure,
      candidateStatus,
      candidateWinProb,
      candidateExpectedValue,
      candidateCalibrationBand,
      structureQualityScore: structureQuality.structureQualityScore,
      structureQualityLabel: structureQuality.structureQualityLabel,
      structureQualityReasonCodes: structureQuality.structureQualityReasonCodes,
      structureQualitySummaryLine: structureQuality.structureQualitySummaryLine,
      candidateFeatureVector,
      candidateQualityPenalty: candidateQualityPenalty.penalty,
      candidateQualityReasonCodes: candidateQualityPenalty.reasonCodes,
      candidateCompositeScore,
      candidateScoreSummaryLine,
      advisoryOnly: true,
    };
    candidateRow.candidateSummaryLine = buildCandidateSummaryLine(candidateRow, blockers);
    return candidateRow;
  };

  const strategyCandidates = strategyStack.map((entry) => {
    const strategyKey = String(entry?.key || '').trim();
    const strategyLayer = String(entry?.layer || '').trim().toLowerCase();
    const strategyName = String(entry?.name || strategyKey || 'Strategy').trim();
    const candidateType = deriveCandidateType(strategyLayer, strategyKey);
    const direction = inferCandidateDirection(decision, todayContext, topSetup);
    const isRecommendedStrategy = recommendationKey && strategyKey === recommendationKey;
    const opportunityRow = opportunityByStrategyKey.get(strategyKey) || {};
    return buildCandidateRow({
      strategyKey,
      strategyLayer,
      strategyName,
      candidateType,
      candidateSource: 'strategy_stack',
      direction,
      isRecommendedStrategy,
      opportunityRow,
      featureVectorExtras: {
        strategyTotalTrades: Number(entry?.metrics?.totalTrades || 0),
      },
    });
  });

  const supplementalCandidates = [];
  if (topSetup && typeof topSetup === 'object') {
    supplementalCandidates.push(buildCandidateRow({
      strategyKey: String(topSetup?.setupId || '').trim() || recommendationKey || 'decision_top_setup',
      strategyLayer: 'decision',
      strategyName: String(topSetup?.name || '').trim() || 'Decision top setup',
      candidateType: topSetupCandidateType,
      candidateSource: 'decision_top_setup',
      direction: inferCandidateDirection(decision, todayContext, topSetup),
      isRecommendedStrategy: true,
      opportunityRow: recommendationOpportunityRow,
      candidateWinProbOverride: Number.isFinite(topSetupProbability) ? topSetupProbability : null,
      candidateExpectedValueOverride: Number.isFinite(topSetupExpectedValue) ? topSetupExpectedValue : null,
      probBias: Number.isFinite(topSetupProbability) && topSetupProbability >= 60 ? 0.8 : 0,
      evBias: Number.isFinite(topSetupExpectedValue) && topSetupExpectedValue > 0 ? 3 : 0,
      scoreBias: 1.5,
      triggerStructureExtras: {
        source: 'decision_top_setup',
      },
      featureVectorExtras: {
        sourceSignal: 'decision_top_setup',
        annualizedTradeEstimate: Number.isFinite(topSetupAnnualizedTrades) ? round2(topSetupAnnualizedTrades) : null,
      },
    }));
  }

  const structureCandidateType = inferLiveStructureCandidateType({
    topSetup,
    todayContext,
    latestSession,
    signal,
    blockerCount: blockers.length,
  });
  const structureDirection = inferLiveStructureDirection({
    decision,
    todayContext,
    topSetup,
    priceLocationVsOrb,
  });
  const structureNoTradeReason = String(latestSession?.no_trade_reason || '').trim().toLowerCase() || null;
  const structureBiasMap = {
    failed_extension_reversal: { prob: 1.4, ev: 8, score: 2.8 },
    breakout_continuation: { prob: 0.9, ev: 5, score: 1.9 },
    retest_continuation: { prob: 0.5, ev: 3, score: 1.2 },
    retest_continuation_watch: { prob: 0.2, ev: 1, score: 0.6 },
    range_reversion_watch: { prob: 0.4, ev: 2, score: 0.9 },
    late_session_structure_watch: { prob: -0.8, ev: -6, score: -2.1 },
    blocked_context_watch: { prob: -2.2, ev: -14, score: -4.5 },
  };
  const structureBias = structureBiasMap[structureCandidateType] || { prob: 0, ev: 0, score: 0 };
  supplementalCandidates.push(buildCandidateRow({
    strategyKey: recommendationKey || 'live_structure_context',
    strategyLayer: 'structure',
    strategyName: `Live structure: ${humanizeUnderscoreText(structureCandidateType)}`,
    candidateType: structureCandidateType,
    candidateSource: 'live_structure',
    direction: structureDirection,
    isRecommendedStrategy: blockers.length === 0,
    opportunityRow: recommendationOpportunityRow,
    candidateExpectedValueOverride: Number.isFinite(topSetupExpectedValue)
      ? round2(topSetupExpectedValue * 0.85)
      : null,
    probBias: structureBias.prob,
    evBias: structureBias.ev,
    scoreBias: structureBias.score,
    triggerStructureExtras: {
      source: 'live_structure',
      noTradeReason: structureNoTradeReason,
      priceLocationVsOrb,
      orbHigh: Number.isFinite(orbHigh) ? round2(orbHigh) : null,
      orbLow: Number.isFinite(orbLow) ? round2(orbLow) : null,
      orbMid,
    },
    featureVectorExtras: {
      sourceSignal: 'live_structure',
      priceLocationVsOrb,
      orbHigh: Number.isFinite(orbHigh) ? round2(orbHigh) : null,
      orbLow: Number.isFinite(orbLow) ? round2(orbLow) : null,
      orbMid,
      structureNoTradeReason,
    },
  }));

  const candidates = [...strategyCandidates, ...supplementalCandidates]
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => Number(b.candidateCompositeScore || 0) - Number(a.candidateCompositeScore || 0));

  const topCandidateOverall = candidates[0] || null;
  const actionableCandidates = candidates.filter((candidate) => isCandidateActionableNow(candidate, {
    negativeEvTolerance: -15,
    minStructureQualityScore: 58,
  }));
  const topCandidateActionableNow = actionableCandidates[0] || null;
  const topCandidateKey = topCandidateOverall?.candidateKey || null;
  const topCandidateSummaryLine = topCandidateOverall?.candidateSummaryLine || null;
  const hasActionableCandidateNow = Boolean(topCandidateActionableNow);
  const sourceCounts = candidates.reduce((acc, row) => {
    const key = String(row?.candidateSource || 'unknown').trim().toLowerCase() || 'unknown';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
  const candidateSourceCounts = sourceCounts;
  const candidateDiversitySummaryLine = Object.keys(candidateSourceCounts).length > 0
    ? `Sources: ${Object.entries(candidateSourceCounts).map(([key, count]) => `${key}(${count})`).join(', ')}.`
    : 'Sources: none.';

  const deriveNoActionableReason = () => {
    if (!topCandidateOverall) {
      return {
        code: 'no_strong_live_candidate',
        line: 'no strong live candidate',
      };
    }
    const status = String(topCandidateOverall?.candidateStatus || '').trim().toLowerCase();
    const phase = String(topCandidateOverall?.sessionPhase || '').trim().toLowerCase();
    const type = String(topCandidateOverall?.candidateType || '').trim().toLowerCase();
    const qualityReasons = Array.isArray(topCandidateOverall?.candidateQualityReasonCodes)
      ? topCandidateOverall.candidateQualityReasonCodes.map((item) => String(item || '').trim().toLowerCase())
      : [];
    const structureReasons = Array.isArray(topCandidateOverall?.structureQualityReasonCodes)
      ? topCandidateOverall.structureQualityReasonCodes.map((item) => String(item || '').trim().toLowerCase())
      : [];
    const structureLabel = String(topCandidateOverall?.structureQualityLabel || '').trim().toLowerCase();
    const expectedValue = Number(topCandidateOverall?.candidateExpectedValue);
    if (status === 'blocked' || qualityReasons.includes('blocked_candidate')) {
      return {
        code: 'blocked_context',
        line: 'blocked context',
      };
    }
    if (structureReasons.includes('overextended_move')) {
      return {
        code: 'overextended_move',
        line: 'overextended move',
      };
    }
    if (structureReasons.includes('no_clean_retest')) {
      return {
        code: 'no_clean_retest',
        line: 'no clean retest',
      };
    }
    if (structureReasons.includes('weak_follow_through')) {
      return {
        code: 'weak_follow_through',
        line: 'weak follow-through',
      };
    }
    if (structureLabel === 'poor' || structureReasons.includes('unclear_structure')) {
      return {
        code: 'poor_structure',
        line: 'poor structure',
      };
    }
    if ((phase === 'outside_window' || phase === 'late_window' || status === 'await_next_session')
      && !isApprovedShadowActionWindow(phase)) {
      return {
        code: 'outside_actionable_window',
        line: 'outside actionable window',
      };
    }
    if (Number.isFinite(expectedValue) && expectedValue < -15) {
      return {
        code: 'weak_expected_value',
        line: 'weak expected value',
      };
    }
    if (status === 'watch_trigger' || status === 'pre_open_watch') {
      return {
        code: 'no_clean_trigger',
        line: 'no clean trigger',
      };
    }
    if (type.includes('blocked_context') || type.includes('range_reversion_watch')) {
      return {
        code: 'bad_market_structure',
        line: 'bad market structure',
      };
    }
    return {
      code: 'no_strong_live_candidate',
      line: 'no strong live candidate',
    };
  };
  const noActionableReason = hasActionableCandidateNow ? null : deriveNoActionableReason();
  const actionableNowSummaryLine = hasActionableCandidateNow
    ? `Actionable now: ${topCandidateActionableNow.strategyName} (${topCandidateActionableNow.direction?.toUpperCase() || 'LONG'}) | ${topCandidateActionableNow.candidateScoreSummaryLine}.`
    : `Actionable now: none (${String(noActionableReason?.line || 'no candidate').trim().toLowerCase()}).`;
  const summaryLine = topCandidateOverall
    ? `Watchlist top: ${topCandidateOverall.strategyName} (${topCandidateOverall.direction?.toUpperCase() || 'LONG'}) | ${topCandidateOverall.candidateScoreSummaryLine}. ${actionableNowSummaryLine} ${candidateDiversitySummaryLine}`
    : 'No live candidate opportunities available.';
  return {
    candidates,
    topCandidateOverall,
    topCandidateActionableNow,
    hasActionableCandidateNow,
    topCandidateKey,
    topCandidateSummaryLine,
    actionableNowSummaryLine,
    noActionableReasonCode: noActionableReason?.code || null,
    noActionableReasonLine: noActionableReason?.line || null,
    candidateSourceCounts,
    candidateDiversitySummaryLine,
    summaryLine,
    advisoryOnly: true,
  };
}

function toSessionDateFromNowEt(nowEt = '') {
  const parsed = parseEtDateTime(nowEt);
  if (parsed?.date) return parsed.date;
  const fallback = toDateIso(nowEt);
  return fallback || '';
}

function normalizeObservationValue(value = null) {
  if (!Number.isFinite(Number(value))) return null;
  return round2(Number(value));
}

function normalizeLiveCandidateObservationWriteSource(value = '') {
  const source = String(value || '').trim().toLowerCase();
  if (source === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO) {
    return LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO;
  }
  if (source === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC) {
    return LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC;
  }
  if (source === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN) {
    return LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN;
  }
  return LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY;
}

function buildLiveCandidateHistoryProvenance(sourceCounts = {}) {
  const counts = sourceCounts && typeof sourceCounts === 'object'
    ? sourceCounts
    : {};
  const normalizedEntries = Object.entries(counts)
    .map(([rawKey, rawValue]) => {
      const key = normalizeLiveCandidateObservationWriteSource(rawKey);
      const value = Number(rawValue);
      return [key, Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0];
    })
    .filter(([, value]) => value > 0);
  if (!normalizedEntries.length) {
    return {
      classification: 'no_history',
      sources: [],
      sourceCounts: {},
      summaryLine: 'No durable observation history yet.',
    };
  }
  const mergedCounts = normalizedEntries.reduce((acc, [key, value]) => {
    acc[key] = Number(acc[key] || 0) + value;
    return acc;
  }, {});
  const sources = Object.keys(mergedCounts);
  let classification = 'mixed';
  if (sources.length === 1 && sources[0] === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO) {
    classification = 'loop_only';
  } else if (sources.length === 1 && sources[0] === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC) {
    classification = 'endpoint_diagnostic_only';
  } else if (sources.length === 1 && sources[0] === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN) {
    classification = 'legacy_unattributed';
  } else if (sources.length === 1 && sources[0] === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY) {
    classification = 'read_only_only';
  } else if (sources.includes(LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO)
    && sources.includes(LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC)) {
    classification = 'mixed_loop_and_endpoint';
  }
  const summaryLine = classification === 'loop_only'
    ? 'History provenance: loop-only writes.'
    : classification === 'endpoint_diagnostic_only'
      ? 'History provenance: endpoint diagnostic writes only.'
      : classification === 'legacy_unattributed'
        ? 'History provenance: legacy rows without write-source attribution.'
      : classification === 'mixed_loop_and_endpoint'
        ? 'History provenance: mixed loop and endpoint diagnostic writes.'
        : 'History provenance: mixed write sources.';
  return {
    classification,
    sources,
    sourceCounts: mergedCounts,
    summaryLine,
  };
}

function getLiveCandidateWriteSourceCount(sourceCounts = {}, source = '') {
  const normalizedSource = normalizeLiveCandidateObservationWriteSource(source);
  const counts = sourceCounts && typeof sourceCounts === 'object'
    ? sourceCounts
    : {};
  const value = Number(counts[normalizedSource] || 0);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function filterLiveCandidateRowsByWriteSource(rows = [], sourceField = '', source = '') {
  const normalizedSource = normalizeLiveCandidateObservationWriteSource(source);
  const field = String(sourceField || '').trim();
  if (!Array.isArray(rows) || !field || !normalizedSource) return [];
  return rows.filter((row) => normalizeLiveCandidateObservationWriteSource(row?.[field]) === normalizedSource);
}

function buildLiveCandidateFilteredHistoryViews(options = {}) {
  const allRecentObservations = Array.isArray(options.recentObservations)
    ? options.recentObservations
    : [];
  const allRecentTransitions = Array.isArray(options.recentTransitions)
    ? options.recentTransitions
    : [];
  const observationSourceCounts = options.observationSourceCounts && typeof options.observationSourceCounts === 'object'
    ? options.observationSourceCounts
    : {};
  const transitionSourceCounts = options.transitionSourceCounts && typeof options.transitionSourceCounts === 'object'
    ? options.transitionSourceCounts
    : {};
  const totalObservationRows = Number.isFinite(Number(options.totalObservationRows))
    ? Math.max(0, Math.round(Number(options.totalObservationRows)))
    : allRecentObservations.length;
  const totalTransitionRows = Number.isFinite(Number(options.totalTransitionRows))
    ? Math.max(0, Math.round(Number(options.totalTransitionRows)))
    : allRecentTransitions.length;

  const allObservationProvenance = buildLiveCandidateHistoryProvenance(observationSourceCounts);
  const allTransitionProvenance = buildLiveCandidateHistoryProvenance(transitionSourceCounts);

  const loopOnlyObservationCount = getLiveCandidateWriteSourceCount(
    observationSourceCounts,
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO
  );
  const loopOnlyTransitionCount = getLiveCandidateWriteSourceCount(
    transitionSourceCounts,
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO
  );
  const diagnosticOnlyObservationCount = getLiveCandidateWriteSourceCount(
    observationSourceCounts,
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC
  );
  const diagnosticOnlyTransitionCount = getLiveCandidateWriteSourceCount(
    transitionSourceCounts,
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC
  );

  const loopOnlyRecentObservations = filterLiveCandidateRowsByWriteSource(
    allRecentObservations,
    'observationWriteSource',
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO
  );
  const loopOnlyRecentTransitions = filterLiveCandidateRowsByWriteSource(
    allRecentTransitions,
    'transitionWriteSource',
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO
  );
  const diagnosticOnlyRecentObservations = filterLiveCandidateRowsByWriteSource(
    allRecentObservations,
    'observationWriteSource',
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC
  );
  const diagnosticOnlyRecentTransitions = filterLiveCandidateRowsByWriteSource(
    allRecentTransitions,
    'transitionWriteSource',
    LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC
  );

  const loopOnlyObservationProvenance = buildLiveCandidateHistoryProvenance({
    [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO]: loopOnlyObservationCount,
  });
  const loopOnlyTransitionProvenance = buildLiveCandidateHistoryProvenance({
    [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO]: loopOnlyTransitionCount,
  });
  const diagnosticOnlyObservationProvenance = buildLiveCandidateHistoryProvenance({
    [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC]: diagnosticOnlyObservationCount,
  });
  const diagnosticOnlyTransitionProvenance = buildLiveCandidateHistoryProvenance({
    [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC]: diagnosticOnlyTransitionCount,
  });

  const allLatestTransition = allRecentTransitions.length > 0 ? allRecentTransitions[0] : null;
  const loopOnlyLatestTransition = loopOnlyRecentTransitions.length > 0 ? loopOnlyRecentTransitions[0] : null;
  const diagnosticOnlyLatestTransition = diagnosticOnlyRecentTransitions.length > 0 ? diagnosticOnlyRecentTransitions[0] : null;

  const allSummaryLine = `All history: ${totalObservationRows} observation(s), ${totalTransitionRows} transition(s).`;
  const loopOnlySummaryLine = loopOnlyObservationCount <= 0 && loopOnlyTransitionCount <= 0
    ? 'Loop-only history: no rows yet.'
    : `Loop-only history: ${loopOnlyObservationCount} observation(s), ${loopOnlyTransitionCount} transition(s).`;
  const diagnosticOnlySummaryLine = diagnosticOnlyObservationCount <= 0 && diagnosticOnlyTransitionCount <= 0
    ? 'Diagnostic history: no rows.'
    : `Diagnostic history: ${diagnosticOnlyObservationCount} observation(s), ${diagnosticOnlyTransitionCount} transition(s).`;

  return {
    all: {
      observationCount: totalObservationRows,
      transitionCount: totalTransitionRows,
      latestTransition: cloneData(allLatestTransition, allLatestTransition),
      recentObservations: cloneData(allRecentObservations, allRecentObservations),
      recentTransitions: cloneData(allRecentTransitions, allRecentTransitions),
      observationProvenanceClassification: allObservationProvenance.classification,
      transitionProvenanceClassification: allTransitionProvenance.classification,
      observationProvenanceSummaryLine: allObservationProvenance.summaryLine,
      transitionProvenanceSummaryLine: allTransitionProvenance.summaryLine,
      summaryLine: allSummaryLine,
    },
    loopOnly: {
      source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      observationCount: loopOnlyObservationCount,
      transitionCount: loopOnlyTransitionCount,
      latestTransition: cloneData(loopOnlyLatestTransition, loopOnlyLatestTransition),
      recentObservations: cloneData(loopOnlyRecentObservations, loopOnlyRecentObservations),
      recentTransitions: cloneData(loopOnlyRecentTransitions, loopOnlyRecentTransitions),
      observationProvenanceClassification: loopOnlyObservationProvenance.classification,
      transitionProvenanceClassification: loopOnlyTransitionProvenance.classification,
      observationProvenanceSummaryLine: loopOnlyObservationProvenance.summaryLine,
      transitionProvenanceSummaryLine: loopOnlyTransitionProvenance.summaryLine,
      summaryLine: loopOnlySummaryLine,
    },
    diagnosticOnly: {
      source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
      observationCount: diagnosticOnlyObservationCount,
      transitionCount: diagnosticOnlyTransitionCount,
      latestTransition: cloneData(diagnosticOnlyLatestTransition, diagnosticOnlyLatestTransition),
      recentObservations: cloneData(diagnosticOnlyRecentObservations, diagnosticOnlyRecentObservations),
      recentTransitions: cloneData(diagnosticOnlyRecentTransitions, diagnosticOnlyRecentTransitions),
      observationProvenanceClassification: diagnosticOnlyObservationProvenance.classification,
      transitionProvenanceClassification: diagnosticOnlyTransitionProvenance.classification,
      observationProvenanceSummaryLine: diagnosticOnlyObservationProvenance.summaryLine,
      transitionProvenanceSummaryLine: diagnosticOnlyTransitionProvenance.summaryLine,
      summaryLine: diagnosticOnlySummaryLine,
    },
    summaryLine: `${allSummaryLine} ${loopOnlySummaryLine} ${diagnosticOnlySummaryLine}`,
  };
}

function resolveLiveCandidateHistoryInterpretation(options = {}) {
  const historyViews = options.historyViews && typeof options.historyViews === 'object'
    ? options.historyViews
    : {};
  const allView = historyViews.all && typeof historyViews.all === 'object'
    ? historyViews.all
    : {};
  const loopView = historyViews.loopOnly && typeof historyViews.loopOnly === 'object'
    ? historyViews.loopOnly
    : {};
  const diagnosticView = historyViews.diagnosticOnly && typeof historyViews.diagnosticOnly === 'object'
    ? historyViews.diagnosticOnly
    : {};
  const minLoopObservations = Number.isFinite(Number(options.minLoopObservations))
    ? Math.max(0, Math.round(Number(options.minLoopObservations)))
    : LIVE_CANDIDATE_LOOP_ONLY_MIN_OBSERVATIONS_FOR_INTERPRETATION;
  const minLoopTransitions = Number.isFinite(Number(options.minLoopTransitions))
    ? Math.max(0, Math.round(Number(options.minLoopTransitions)))
    : LIVE_CANDIDATE_LOOP_ONLY_MIN_TRANSITIONS_FOR_INTERPRETATION;
  const loopObservationCount = Number.isFinite(Number(loopView.observationCount))
    ? Math.max(0, Math.round(Number(loopView.observationCount)))
    : 0;
  const loopTransitionCount = Number.isFinite(Number(loopView.transitionCount))
    ? Math.max(0, Math.round(Number(loopView.transitionCount)))
    : 0;
  const allObservationCount = Number.isFinite(Number(allView.observationCount))
    ? Math.max(0, Math.round(Number(allView.observationCount)))
    : 0;
  const allTransitionCount = Number.isFinite(Number(allView.transitionCount))
    ? Math.max(0, Math.round(Number(allView.transitionCount)))
    : 0;
  const diagnosticObservationCount = Number.isFinite(Number(diagnosticView.observationCount))
    ? Math.max(0, Math.round(Number(diagnosticView.observationCount)))
    : 0;
  const diagnosticTransitionCount = Number.isFinite(Number(diagnosticView.transitionCount))
    ? Math.max(0, Math.round(Number(diagnosticView.transitionCount)))
    : 0;

  const hasLoopObservationDepth = loopObservationCount >= minLoopObservations;
  const hasLoopTransitionDepth = loopTransitionCount >= minLoopTransitions;
  const loopIsUsable = hasLoopObservationDepth && hasLoopTransitionDepth;

  let mode = 'loop_only';
  let selectedView = loopView;
  let fallbackUsed = false;
  let fallbackMode = null;
  let fallbackReason = null;
  let summaryLine = 'History interpretation uses loop-only provenance.';

  if (!loopIsUsable) {
    fallbackUsed = true;
    fallbackMode = 'all_history';
    if (!hasLoopObservationDepth && !hasLoopTransitionDepth) {
      fallbackReason = 'loop_history_sparse_observations_and_transitions';
    } else if (!hasLoopObservationDepth) {
      fallbackReason = 'loop_history_sparse_observations';
    } else {
      fallbackReason = 'loop_history_sparse_transitions';
    }
    if (allObservationCount > 0 || allTransitionCount > 0) {
      mode = 'all_history';
      selectedView = allView;
      summaryLine = `History interpretation fallback to all-history (${fallbackReason}).`;
    } else if (diagnosticObservationCount > 0 || diagnosticTransitionCount > 0) {
      mode = 'diagnostic_only';
      selectedView = diagnosticView;
      fallbackMode = 'diagnostic_only';
      fallbackReason = `${fallbackReason}_all_history_empty`;
      summaryLine = `History interpretation fallback to diagnostic-only (${fallbackReason}).`;
    } else {
      mode = 'loop_only';
      selectedView = loopView;
      fallbackMode = 'none';
      fallbackReason = 'no_history_available';
      summaryLine = 'History interpretation has no rows yet.';
    }
  }

  const latestTransition = selectedView && typeof selectedView === 'object'
    ? selectedView.latestTransition || null
    : null;
  const referenceModes = ['all_history', 'loop_only', 'diagnostic_only'];
  const activeModeLabel = mode === 'loop_only'
    ? 'loop-only'
    : mode === 'diagnostic_only'
      ? 'diagnostic-only'
      : 'all-history';

  return {
    mode,
    selectedView,
    latestTransition,
    fallbackUsed,
    fallbackMode,
    fallbackReason,
    referenceModes,
    summaryLine,
    activeModeLabel,
    minLoopObservations,
    minLoopTransitions,
    loopObservationCount,
    loopTransitionCount,
  };
}

function normalizeLiveCandidateObservation(candidate = {}, options = {}) {
  const nowEt = String(options.nowEt || '').trim() || new Date().toISOString();
  const insideApprovedActionWindow = options.insideApprovedActionWindow === true;
  const sessionDate = String(options.sessionDate || toSessionDateFromNowEt(nowEt)).trim() || null;
  const actionableNow = isCandidateActionableNow(candidate, {
    negativeEvTolerance: -15,
    minStructureQualityScore: 58,
  });
  return {
    timestamp: nowEt,
    sessionDate,
    candidateKey: String(candidate?.candidateKey || '').trim() || null,
    strategyKey: String(candidate?.strategyKey || '').trim() || null,
    candidateSource: String(candidate?.candidateSource || '').trim().toLowerCase() || null,
    candidateStatus: String(candidate?.candidateStatus || '').trim().toLowerCase() || null,
    structureQualityScore: normalizeObservationValue(candidate?.structureQualityScore),
    structureQualityLabel: String(candidate?.structureQualityLabel || '').trim().toLowerCase() || null,
    candidateWinProb: normalizeObservationValue(candidate?.candidateWinProb),
    candidateExpectedValue: normalizeObservationValue(candidate?.candidateExpectedValue),
    insideApprovedActionWindow,
    actionableNow,
  };
}

function observationStateEquals(left = null, right = null) {
  if (!left || !right) return false;
  return String(left.candidateStatus || '') === String(right.candidateStatus || '')
    && normalizeObservationValue(left.structureQualityScore) === normalizeObservationValue(right.structureQualityScore)
    && String(left.structureQualityLabel || '') === String(right.structureQualityLabel || '')
    && normalizeObservationValue(left.candidateWinProb) === normalizeObservationValue(right.candidateWinProb)
    && normalizeObservationValue(left.candidateExpectedValue) === normalizeObservationValue(right.candidateExpectedValue)
    && Boolean(left.insideApprovedActionWindow) === Boolean(right.insideApprovedActionWindow)
    && Boolean(left.actionableNow) === Boolean(right.actionableNow);
}

function classifyCandidateTransitionType(options = {}) {
  if (options.hasPreviousState !== true) return 'first_observation';
  if (options.currentActionable === true && options.previousActionable === false) return 'crossed_into_actionable';
  if (options.currentActionable === false && options.previousActionable === true) return 'dropped_out_of_actionable';
  if (String(options.currentStatus || '') !== String(options.previousStatus || '')) return 'status_changed';
  if (options.structureDirection === 'improved') return 'structure_improved';
  if (options.structureDirection === 'worsened') return 'structure_worsened';
  return 'unchanged';
}

function buildTransitionSummaryLine(transitionType, candidateLabel, previousStatus, currentStatus) {
  const label = String(candidateLabel || 'Candidate').trim() || 'Candidate';
  if (transitionType === 'crossed_into_actionable') return `${label} crossed into actionable structure.`;
  if (transitionType === 'dropped_out_of_actionable') return `${label} dropped out of actionable structure.`;
  if (transitionType === 'status_changed') {
    return `${label} status changed from ${String(previousStatus || 'unknown').trim() || 'unknown'} to ${String(currentStatus || 'unknown').trim() || 'unknown'}.`;
  }
  if (transitionType === 'structure_improved') return `${label} structure improved.`;
  if (transitionType === 'structure_worsened') return `${label} structure worsened.`;
  if (transitionType === 'first_observation') return `${label} baseline state captured.`;
  return `${label} structure unchanged.`;
}

function ensureLiveCandidateStateHistoryTables(db) {
  if (!db || typeof db.exec !== 'function') return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      session_date TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      strategy_key TEXT,
      candidate_source TEXT,
      candidate_status TEXT,
      structure_quality_score REAL,
      structure_quality_label TEXT,
      candidate_win_prob REAL,
      candidate_expected_value REAL,
      inside_approved_action_window INTEGER NOT NULL DEFAULT 0,
      actionable_now INTEGER NOT NULL DEFAULT 0,
      observation_write_source TEXT NOT NULL DEFAULT '${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_candidate_obs_date_key ON ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}(session_date, candidate_key, observed_at DESC, id DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_candidate_obs_observed_at ON ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}(observed_at DESC, id DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_candidate_obs_write_source ON ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}(observation_write_source, observed_at DESC, id DESC);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transition_at TEXT NOT NULL,
      session_date TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      previous_status TEXT,
      current_status TEXT,
      previous_structure_quality_score REAL,
      current_structure_quality_score REAL,
      previous_actionable INTEGER NOT NULL DEFAULT 0,
      current_actionable INTEGER NOT NULL DEFAULT 0,
      transition_type TEXT NOT NULL,
      transition_summary_line TEXT,
      transition_write_source TEXT NOT NULL DEFAULT '${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_candidate_transition_date_key ON ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}(session_date, candidate_key, transition_at DESC, id DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_candidate_transition_time ON ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}(transition_at DESC, id DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_candidate_transition_write_source ON ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}(transition_write_source, transition_at DESC, id DESC);`);

  try {
    const obsCols = db.prepare(`PRAGMA table_info('${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}')`).all();
    const obsColNames = new Set(obsCols.map((col) => String(col?.name || '').trim().toLowerCase()));
    if (!obsColNames.has('observation_write_source')) {
      db.exec(
        `ALTER TABLE ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE} ADD COLUMN observation_write_source TEXT NOT NULL DEFAULT '${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO}'`
      );
    }
  } catch {}
  try {
    const transitionCols = db.prepare(`PRAGMA table_info('${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}')`).all();
    const transitionColNames = new Set(transitionCols.map((col) => String(col?.name || '').trim().toLowerCase()));
    if (!transitionColNames.has('transition_write_source')) {
      db.exec(
        `ALTER TABLE ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE} ADD COLUMN transition_write_source TEXT NOT NULL DEFAULT '${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO}'`
      );
    }
  } catch {}
  return true;
}

function getLiveCandidateStateDbStatements(db = null) {
  if (!db || typeof db.prepare !== 'function') return null;
  if (LIVE_CANDIDATE_DB_STATEMENT_CACHE.has(db)) {
    return LIVE_CANDIDATE_DB_STATEMENT_CACHE.get(db);
  }
  if (!ensureLiveCandidateStateHistoryTables(db)) return null;
  const observationCols = db.prepare(`PRAGMA table_info('${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}')`).all();
  const transitionCols = db.prepare(`PRAGMA table_info('${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}')`).all();
  const observationColNames = new Set(observationCols.map((col) => String(col?.name || '').trim().toLowerCase()));
  const transitionColNames = new Set(transitionCols.map((col) => String(col?.name || '').trim().toLowerCase()));
  const hasObservationWriteSource = observationColNames.has('observation_write_source');
  const hasTransitionWriteSource = transitionColNames.has('transition_write_source');
  const observationWriteSourceSelect = hasObservationWriteSource
    ? 'observation_write_source'
    : `'${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN}' AS observation_write_source`;
  const transitionWriteSourceSelect = hasTransitionWriteSource
    ? 'transition_write_source'
    : `'${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN}' AS transition_write_source`;
  const insertObservationColumns = hasObservationWriteSource
    ? `observed_at, session_date, candidate_key, strategy_key, candidate_source, candidate_status,
        structure_quality_score, structure_quality_label, candidate_win_prob, candidate_expected_value,
        inside_approved_action_window, actionable_now, observation_write_source`
    : `observed_at, session_date, candidate_key, strategy_key, candidate_source, candidate_status,
        structure_quality_score, structure_quality_label, candidate_win_prob, candidate_expected_value,
        inside_approved_action_window, actionable_now`;
  const insertObservationValues = hasObservationWriteSource
    ? '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?'
    : '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
  const insertTransitionColumns = hasTransitionWriteSource
    ? `transition_at, session_date, candidate_key, previous_status, current_status,
        previous_structure_quality_score, current_structure_quality_score,
        previous_actionable, current_actionable, transition_type, transition_summary_line, transition_write_source`
    : `transition_at, session_date, candidate_key, previous_status, current_status,
        previous_structure_quality_score, current_structure_quality_score,
        previous_actionable, current_actionable, transition_type, transition_summary_line`;
  const insertTransitionValues = hasTransitionWriteSource
    ? '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?'
    : '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
  const statements = {
    readLatestObservationByCandidate: db.prepare(`
      SELECT observed_at, session_date, candidate_key, strategy_key, candidate_source, candidate_status,
             structure_quality_score, structure_quality_label, candidate_win_prob, candidate_expected_value,
             inside_approved_action_window, actionable_now, ${observationWriteSourceSelect}
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE session_date = ? AND candidate_key = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `),
    insertObservation: db.prepare(`
      INSERT INTO ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE} (${insertObservationColumns})
      VALUES (${insertObservationValues})
    `),
    pruneObservationsByCandidate: db.prepare(`
      DELETE FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE session_date = ? AND candidate_key = ?
        AND id NOT IN (
          SELECT id FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
          WHERE session_date = ? AND candidate_key = ?
          ORDER BY observed_at DESC, id DESC
          LIMIT ?
        )
    `),
    pruneObservationsGlobal: db.prepare(`
      DELETE FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE id NOT IN (
        SELECT id FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
        ORDER BY observed_at DESC, id DESC
        LIMIT ?
      )
    `),
    readLatestTransitionByCandidate: db.prepare(`
      SELECT transition_at, session_date, candidate_key, previous_status, current_status,
             previous_structure_quality_score, current_structure_quality_score,
             previous_actionable, current_actionable, transition_type, transition_summary_line, ${transitionWriteSourceSelect}
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      WHERE session_date = ? AND candidate_key = ?
      ORDER BY transition_at DESC, id DESC
      LIMIT 1
    `),
    insertTransition: db.prepare(`
      INSERT INTO ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE} (${insertTransitionColumns})
      VALUES (${insertTransitionValues})
    `),
    pruneTransitionsGlobal: db.prepare(`
      DELETE FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      WHERE id NOT IN (
        SELECT id FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
        ORDER BY transition_at DESC, id DESC
        LIMIT ?
      )
    `),
    readRecentTransitionsByDate: db.prepare(`
      SELECT transition_at, session_date, candidate_key, previous_status, current_status,
             previous_structure_quality_score, current_structure_quality_score,
             previous_actionable, current_actionable, transition_type, transition_summary_line, ${transitionWriteSourceSelect}
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      WHERE session_date = ?
      ORDER BY transition_at DESC, id DESC
      LIMIT ?
    `),
    readRecentTransitionsGlobal: db.prepare(`
      SELECT transition_at, session_date, candidate_key, previous_status, current_status,
             previous_structure_quality_score, current_structure_quality_score,
             previous_actionable, current_actionable, transition_type, transition_summary_line, ${transitionWriteSourceSelect}
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      ORDER BY transition_at DESC, id DESC
      LIMIT ?
    `),
    readRecentObservationsByDate: db.prepare(`
      SELECT observed_at, session_date, candidate_key, strategy_key, candidate_source, candidate_status,
             structure_quality_score, structure_quality_label, candidate_win_prob, candidate_expected_value,
             inside_approved_action_window, actionable_now, ${observationWriteSourceSelect}
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE session_date = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `),
    countObservationsByDate: db.prepare(`
      SELECT COUNT(*) AS c
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE session_date = ?
    `),
    countTransitionsByDate: db.prepare(`
      SELECT COUNT(*) AS c
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      WHERE session_date = ?
    `),
    countObservationSourcesByDate: db.prepare(hasObservationWriteSource
      ? `
      SELECT observation_write_source AS source, COUNT(*) AS c
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE session_date = ?
      GROUP BY observation_write_source
    `
      : `
      SELECT '${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN}' AS source, COUNT(*) AS c
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      WHERE session_date = ?
    `),
    countTransitionSourcesByDate: db.prepare(hasTransitionWriteSource
      ? `
      SELECT transition_write_source AS source, COUNT(*) AS c
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      WHERE session_date = ?
      GROUP BY transition_write_source
    `
      : `
      SELECT '${LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LEGACY_UNKNOWN}' AS source, COUNT(*) AS c
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      WHERE session_date = ?
    `),
    readLatestObservationSessionDate: db.prepare(`
      SELECT session_date
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      ORDER BY session_date DESC, observed_at DESC, id DESC
      LIMIT 1
    `),
    readLatestTransitionSessionDate: db.prepare(`
      SELECT session_date
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      ORDER BY session_date DESC, transition_at DESC, id DESC
      LIMIT 1
    `),
    readLatestObservationTimestampGlobal: db.prepare(`
      SELECT observed_at
      FROM ${LIVE_CANDIDATE_STATE_OBSERVATION_TABLE}
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `),
    readLatestTransitionTimestampGlobal: db.prepare(`
      SELECT transition_at
      FROM ${LIVE_CANDIDATE_STATE_TRANSITION_TABLE}
      ORDER BY transition_at DESC, id DESC
      LIMIT 1
    `),
    hasObservationWriteSource,
    hasTransitionWriteSource,
  };
  LIVE_CANDIDATE_DB_STATEMENT_CACHE.set(db, statements);
  return statements;
}

function resolveLiveCandidateHistoryRowScope(options = {}) {
  const statements = options?.persistenceStatements && typeof options.persistenceStatements === 'object'
    ? options.persistenceStatements
    : null;
  const requestedSessionDate = String(options?.sessionDate || '').trim();
  const dbPath = String(options?.dbPath || '').trim() || null;
  if (!statements || !requestedSessionDate) {
    return {
      requestedSessionDate: requestedSessionDate || null,
      effectiveSessionDate: requestedSessionDate || null,
      rowScopeMode: 'requested_session_date',
      rowScopeFallbackUsed: false,
      rowScopeFallbackReason: null,
      observationCount: 0,
      transitionCount: 0,
      observationSourceCounts: {},
      transitionSourceCounts: {},
      latestObservationAt: null,
      latestTransitionAt: null,
      dbPath,
    };
  }

  const requestedObservationCount = Number(statements.countObservationsByDate.get(requestedSessionDate)?.c || 0);
  const requestedTransitionCount = Number(statements.countTransitionsByDate.get(requestedSessionDate)?.c || 0);

  let effectiveSessionDate = requestedSessionDate;
  let rowScopeMode = 'requested_session_date';
  let rowScopeFallbackUsed = false;
  let rowScopeFallbackReason = null;

  if ((requestedObservationCount + requestedTransitionCount) <= 0) {
    const latestObservationSessionDate = String(
      statements.readLatestObservationSessionDate.get()?.session_date || ''
    ).trim();
    const latestTransitionSessionDate = String(
      statements.readLatestTransitionSessionDate.get()?.session_date || ''
    ).trim();
    const latestAvailableSessionDate = [latestObservationSessionDate, latestTransitionSessionDate]
      .filter(Boolean)
      .sort()
      .reverse()[0] || '';
    if (latestAvailableSessionDate && latestAvailableSessionDate !== requestedSessionDate) {
      effectiveSessionDate = latestAvailableSessionDate;
      rowScopeMode = 'latest_available_session_date';
      rowScopeFallbackUsed = true;
      rowScopeFallbackReason = 'requested_session_empty_using_latest_available_session_date';
    }
  }

  const observationCount = Number(statements.countObservationsByDate.get(effectiveSessionDate)?.c || 0);
  const transitionCount = Number(statements.countTransitionsByDate.get(effectiveSessionDate)?.c || 0);
  const observationSourceCounts = (statements.countObservationSourcesByDate.all(effectiveSessionDate) || [])
    .reduce((acc, row) => {
      const key = normalizeLiveCandidateObservationWriteSource(row?.source);
      const value = Number(row?.c || 0);
      acc[key] = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
      return acc;
    }, {});
  const transitionSourceCounts = (statements.countTransitionSourcesByDate.all(effectiveSessionDate) || [])
    .reduce((acc, row) => {
      const key = normalizeLiveCandidateObservationWriteSource(row?.source);
      const value = Number(row?.c || 0);
      acc[key] = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
      return acc;
    }, {});

  const latestObservationAt = String(
    statements.readLatestObservationTimestampGlobal.get()?.observed_at || ''
  ).trim() || null;
  const latestTransitionAt = String(
    statements.readLatestTransitionTimestampGlobal.get()?.transition_at || ''
  ).trim() || null;

  return {
    requestedSessionDate,
    effectiveSessionDate: effectiveSessionDate || null,
    rowScopeMode,
    rowScopeFallbackUsed,
    rowScopeFallbackReason,
    observationCount,
    transitionCount,
    observationSourceCounts,
    transitionSourceCounts,
    latestObservationAt,
    latestTransitionAt,
    dbPath,
  };
}

function normalizeDurableObservationRow(row = null) {
  if (!row || typeof row !== 'object') return null;
  return {
    timestamp: String(row.observed_at || '').trim() || null,
    sessionDate: String(row.session_date || '').trim() || null,
    candidateKey: String(row.candidate_key || '').trim() || null,
    strategyKey: String(row.strategy_key || '').trim() || null,
    candidateSource: String(row.candidate_source || '').trim().toLowerCase() || null,
    candidateStatus: String(row.candidate_status || '').trim().toLowerCase() || null,
    structureQualityScore: normalizeObservationValue(row.structure_quality_score),
    structureQualityLabel: String(row.structure_quality_label || '').trim().toLowerCase() || null,
    candidateWinProb: normalizeObservationValue(row.candidate_win_prob),
    candidateExpectedValue: normalizeObservationValue(row.candidate_expected_value),
    insideApprovedActionWindow: Number(row.inside_approved_action_window) === 1,
    actionableNow: Number(row.actionable_now) === 1,
    observationWriteSource: normalizeLiveCandidateObservationWriteSource(row.observation_write_source),
  };
}

function normalizeDurableTransitionRow(row = null) {
  if (!row || typeof row !== 'object') return null;
  return {
    timestamp: String(row.transition_at || '').trim() || null,
    sessionDate: String(row.session_date || '').trim() || null,
    candidateKey: String(row.candidate_key || '').trim() || null,
    previousStatus: String(row.previous_status || '').trim().toLowerCase() || null,
    currentStatus: String(row.current_status || '').trim().toLowerCase() || null,
    previousStructureQualityScore: normalizeObservationValue(row.previous_structure_quality_score),
    currentStructureQualityScore: normalizeObservationValue(row.current_structure_quality_score),
    previousActionable: Number(row.previous_actionable) === 1,
    currentActionable: Number(row.current_actionable) === 1,
    transitionType: String(row.transition_type || '').trim().toLowerCase() || null,
    transitionSummaryLine: String(row.transition_summary_line || '').trim() || null,
    transitionWriteSource: normalizeLiveCandidateObservationWriteSource(row.transition_write_source),
  };
}

function isSameTransitionState(left = null, right = null) {
  if (!left || !right) return false;
  return String(left.candidateKey || '') === String(right.candidateKey || '')
    && String(left.previousStatus || '') === String(right.previousStatus || '')
    && String(left.currentStatus || '') === String(right.currentStatus || '')
    && normalizeObservationValue(left.previousStructureQualityScore) === normalizeObservationValue(right.previousStructureQualityScore)
    && normalizeObservationValue(left.currentStructureQualityScore) === normalizeObservationValue(right.currentStructureQualityScore)
    && Boolean(left.previousActionable) === Boolean(right.previousActionable)
    && Boolean(left.currentActionable) === Boolean(right.currentActionable)
    && String(left.transitionType || '') === String(right.transitionType || '')
    && String(left.timestamp || '') === String(right.timestamp || '');
}

function buildInMemoryObservationSample(monitorState = {}, limit = 10) {
  const rows = [];
  const history = monitorState?.observationHistoryByCandidate && typeof monitorState.observationHistoryByCandidate === 'object'
    ? monitorState.observationHistoryByCandidate
    : {};
  Object.keys(history).forEach((candidateKey) => {
    const bucket = Array.isArray(history[candidateKey]) ? history[candidateKey] : [];
    if (!bucket.length) return;
    rows.push(...bucket.map((item) => ({
      ...item,
      candidateKey,
    })));
  });
  return rows
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, Math.max(1, Math.min(50, Number(limit || 10))))
    .map((item) => cloneData(item, item));
}

function buildLiveCandidateStateMonitor(input = {}) {
  const liveOpportunityCandidates = input?.liveOpportunityCandidates && typeof input.liveOpportunityCandidates === 'object'
    ? input.liveOpportunityCandidates
    : {};
  const todayContext = input?.todayContext && typeof input.todayContext === 'object'
    ? input.todayContext
    : {};
  const monitorState = input?.monitorState && typeof input.monitorState === 'object'
    ? input.monitorState
    : LIVE_CANDIDATE_STATE_MONITOR_STATE;
  if (!monitorState.candidateStates || typeof monitorState.candidateStates !== 'object') {
    monitorState.candidateStates = Object.create(null);
  }
  if (!monitorState.observationHistoryByCandidate || typeof monitorState.observationHistoryByCandidate !== 'object') {
    monitorState.observationHistoryByCandidate = Object.create(null);
  }
  if (!Array.isArray(monitorState.transitionRows)) {
    monitorState.transitionRows = [];
  }

  const allCandidates = Array.isArray(liveOpportunityCandidates?.candidates)
    ? liveOpportunityCandidates.candidates
    : [];
  const monitored = allCandidates.slice(0, 3);
  const stateRows = allCandidates.slice(0, 12);
  const nowEt = String(todayContext?.nowEt || '').trim() || new Date().toISOString();
  const sessionDate = toSessionDateFromNowEt(nowEt) || toDateIso(todayContext?.date || '') || '';
  const phase = String(todayContext?.sessionPhase || '').trim().toLowerCase();
  const insideApprovedActionWindow = isApprovedShadowActionWindow(phase);
  const persistenceDb = input?.db && typeof input.db.prepare === 'function' ? input.db : null;
  const persistenceStatements = persistenceDb ? getLiveCandidateStateDbStatements(persistenceDb) : null;
  const persistenceAvailable = Boolean(persistenceStatements);
  const allowObservationWrites = input?.persistLiveCandidateState === true;
  const persistenceWriteEnabled = persistenceAvailable && allowObservationWrites;
  const inMemoryWriteEnabled = !persistenceAvailable && allowObservationWrites;
  const observationWriteSource = allowObservationWrites
    ? normalizeLiveCandidateObservationWriteSource(input?.observationWriteSource)
    : LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY;
  const responseReadOnly = !allowObservationWrites;
  const snapshotTransitions = [];
  const stateByCandidateKey = new Map();

  let observationWritesThisSnapshot = 0;
  let observationSuppressedThisSnapshot = 0;
  let readOnlySkippedWritesThisSnapshot = 0;
  let transitionWritesThisSnapshot = 0;
  let priorObservationReadCount = 0;

  for (const candidate of stateRows) {
    const observation = normalizeLiveCandidateObservation(candidate, {
      nowEt,
      sessionDate,
      insideApprovedActionWindow,
    });
    const key = String(observation?.candidateKey || '').trim();
    if (!key) continue;

    let priorObservation = null;
    let previousStateSource = 'none';
    if (persistenceAvailable) {
      const durablePriorRow = persistenceStatements.readLatestObservationByCandidate.get(sessionDate || '', key);
      priorObservation = normalizeDurableObservationRow(durablePriorRow);
      if (priorObservation) {
        previousStateSource = 'durable_sqlite';
        priorObservationReadCount += 1;
      }
    }
    if (!priorObservation) {
      const fallback = monitorState.candidateStates[key] && typeof monitorState.candidateStates[key] === 'object'
        ? monitorState.candidateStates[key]
        : null;
      if (fallback) {
        priorObservation = {
          timestamp: String(fallback.updatedAt || '').trim() || null,
          sessionDate,
          candidateKey: key,
          strategyKey: observation.strategyKey,
          candidateSource: observation.candidateSource,
          candidateStatus: String(fallback.status || '').trim().toLowerCase() || null,
          structureQualityScore: normalizeObservationValue(fallback.structureQualityScore),
          structureQualityLabel: String(fallback.structureQualityLabel || '').trim().toLowerCase() || null,
          candidateWinProb: normalizeObservationValue(fallback.candidateWinProb),
          candidateExpectedValue: normalizeObservationValue(fallback.candidateExpectedValue),
          insideApprovedActionWindow: fallback.insideApprovedActionWindow === true,
          actionableNow: fallback.isActionableNow === true,
        };
        previousStateSource = 'in_memory';
      }
    }

    const hasPreviousState = Boolean(priorObservation);
    const previousStatus = String(priorObservation?.candidateStatus || '').trim().toLowerCase() || null;
    const currentStatus = String(observation?.candidateStatus || '').trim().toLowerCase() || null;
    const previousStructureQualityScore = normalizeObservationValue(priorObservation?.structureQualityScore);
    const currentStructureQualityScore = normalizeObservationValue(observation?.structureQualityScore);
    const previousActionable = priorObservation?.actionableNow === true;
    const currentActionable = observation?.actionableNow === true;
    let structureDirection = 'unchanged';
    if (hasPreviousState && Number.isFinite(previousStructureQualityScore) && Number.isFinite(currentStructureQualityScore)) {
      if (currentStructureQualityScore > previousStructureQualityScore + 0.25) structureDirection = 'improved';
      else if (currentStructureQualityScore < previousStructureQualityScore - 0.25) structureDirection = 'worsened';
    }
    const transitionType = classifyCandidateTransitionType({
      hasPreviousState,
      previousActionable,
      currentActionable,
      previousStatus,
      currentStatus,
      structureDirection,
    });
    const candidateLabel = String(candidate?.strategyName || candidate?.strategyKey || 'Candidate').trim() || 'Candidate';
    const transitionSummaryLine = buildTransitionSummaryLine(
      transitionType,
      candidateLabel,
      previousStatus,
      currentStatus
    );
    const crossedIntoActionable = hasPreviousState && currentActionable && !previousActionable;

    const transitionRow = {
      timestamp: nowEt,
      sessionDate: sessionDate || null,
      candidateKey: key,
      previousStatus,
      currentStatus,
      previousStructureQualityScore,
      currentStructureQualityScore,
      previousActionable,
      currentActionable,
      transitionType,
      transitionSummaryLine,
    };

    const unchanged = hasPreviousState && observationStateEquals(priorObservation, observation);
    if (persistenceWriteEnabled) {
      if (!unchanged) {
        const observationParams = [
          observation.timestamp || nowEt,
          observation.sessionDate || sessionDate || '',
          observation.candidateKey || key,
          observation.strategyKey || null,
          observation.candidateSource || null,
          observation.candidateStatus || null,
          observation.structureQualityScore,
          observation.structureQualityLabel || null,
          observation.candidateWinProb,
          observation.candidateExpectedValue,
          observation.insideApprovedActionWindow ? 1 : 0,
          observation.actionableNow ? 1 : 0,
        ];
        if (persistenceStatements.hasObservationWriteSource) {
          observationParams.push(observationWriteSource);
        }
        persistenceStatements.insertObservation.run(...observationParams);
        observationWritesThisSnapshot += 1;
        persistenceStatements.pruneObservationsByCandidate.run(
          observation.sessionDate || sessionDate || '',
          key,
          observation.sessionDate || sessionDate || '',
          key,
          LIVE_CANDIDATE_DURABLE_OBSERVATION_LIMIT_PER_CANDIDATE
        );
        persistenceStatements.pruneObservationsGlobal.run(LIVE_CANDIDATE_DURABLE_OBSERVATION_LIMIT_GLOBAL);
      } else {
        observationSuppressedThisSnapshot += 1;
      }
      if (hasPreviousState && transitionType !== 'unchanged' && transitionType !== 'first_observation') {
        const previousTransitionRow = normalizeDurableTransitionRow(
          persistenceStatements.readLatestTransitionByCandidate.get(sessionDate || '', key)
        );
        if (!isSameTransitionState(previousTransitionRow, transitionRow)) {
          const transitionParams = [
            transitionRow.timestamp || nowEt,
            transitionRow.sessionDate || sessionDate || '',
            key,
            transitionRow.previousStatus || null,
            transitionRow.currentStatus || null,
            transitionRow.previousStructureQualityScore,
            transitionRow.currentStructureQualityScore,
            transitionRow.previousActionable ? 1 : 0,
            transitionRow.currentActionable ? 1 : 0,
            transitionRow.transitionType || 'status_changed',
            transitionRow.transitionSummaryLine || null,
          ];
          if (persistenceStatements.hasTransitionWriteSource) {
            transitionParams.push(observationWriteSource);
          }
          persistenceStatements.insertTransition.run(...transitionParams);
          transitionWritesThisSnapshot += 1;
        }
        persistenceStatements.pruneTransitionsGlobal.run(LIVE_CANDIDATE_DURABLE_TRANSITION_LIMIT_GLOBAL);
      }
    } else if (inMemoryWriteEnabled) {
      if (!Array.isArray(monitorState.observationHistoryByCandidate[key])) {
        monitorState.observationHistoryByCandidate[key] = [];
      }
      const bucket = monitorState.observationHistoryByCandidate[key];
      const latestInMemory = bucket.length ? bucket[bucket.length - 1] : null;
      const inMemoryObservation = {
        ...observation,
        observationWriteSource,
      };
      if (!latestInMemory || !observationStateEquals(latestInMemory, observation)) {
        bucket.push(cloneData(inMemoryObservation, inMemoryObservation));
        observationWritesThisSnapshot += 1;
      } else {
        observationSuppressedThisSnapshot += 1;
      }
      if (bucket.length > LIVE_CANDIDATE_STATE_HISTORY_LIMIT) {
        monitorState.observationHistoryByCandidate[key] = bucket.slice(-LIVE_CANDIDATE_STATE_HISTORY_LIMIT);
      }
      if (hasPreviousState && transitionType !== 'unchanged' && transitionType !== 'first_observation') {
        const inMemoryTransition = {
          ...transitionRow,
          transitionWriteSource: observationWriteSource,
        };
        monitorState.transitionRows.push(cloneData(inMemoryTransition, inMemoryTransition));
        transitionWritesThisSnapshot += 1;
      }
      if (monitorState.transitionRows.length > LIVE_CANDIDATE_TRANSITION_HISTORY_LIMIT) {
        monitorState.transitionRows = monitorState.transitionRows.slice(-LIVE_CANDIDATE_TRANSITION_HISTORY_LIMIT);
      }
    } else if (responseReadOnly && unchanged) {
      observationSuppressedThisSnapshot += 1;
    } else {
      readOnlySkippedWritesThisSnapshot += 1;
    }

    if (hasPreviousState && transitionType !== 'unchanged' && transitionType !== 'first_observation') {
      snapshotTransitions.push(transitionRow);
    }
    monitorState.candidateStates[key] = {
      status: observation.candidateStatus,
      structureQualityScore: observation.structureQualityScore,
      structureQualityLabel: observation.structureQualityLabel,
      candidateWinProb: observation.candidateWinProb,
      candidateExpectedValue: observation.candidateExpectedValue,
      insideApprovedActionWindow: observation.insideApprovedActionWindow,
      isActionableNow: observation.actionableNow,
      updatedAt: observation.timestamp || nowEt,
    };
    stateByCandidateKey.set(key, {
      priorObservation,
      previousStateSource,
      observation,
      previousStatus,
      currentStatus,
      previousStructureQualityScore,
      currentStructureQualityScore,
      structureDirection,
      previousActionable,
      currentActionable,
      crossedIntoActionable,
      transitionType,
      transitionSummaryLine,
    });
  }

  const monitoredCandidates = monitored.map((candidate) => {
    const key = String(candidate?.candidateKey || '').trim();
    const state = key ? stateByCandidateKey.get(key) : null;
    return {
      candidateKey: key || null,
      strategyKey: String(candidate?.strategyKey || '').trim() || null,
      candidateSource: String(candidate?.candidateSource || '').trim() || null,
      previousStatus: state?.previousStatus || null,
      currentStatus: state?.currentStatus || null,
      previousStructureQualityScore: state?.previousStructureQualityScore ?? null,
      currentStructureQualityScore: state?.currentStructureQualityScore ?? null,
      structureDirection: state?.structureDirection || 'unchanged',
      previousActionable: state?.previousActionable === true,
      currentActionable: state?.currentActionable === true,
      crossedIntoActionable: state?.crossedIntoActionable === true,
      transitionType: state?.transitionType || 'first_observation',
      previousStateSource: state?.previousStateSource || 'none',
      previousObservationTimestamp: state?.priorObservation?.timestamp || null,
      transitionSummaryLine: state?.transitionSummaryLine
        || buildTransitionSummaryLine('first_observation', candidate?.strategyName || candidate?.strategyKey || 'Candidate'),
    };
  });

  let durableObservationCount = 0;
  let durableTransitionCount = 0;
  let recentObservationSample = [];
  let recentTransitionSample = [];
  let recentObservationRowsForViews = [];
  let recentTransitionRowsForViews = [];
  let observationSourceCounts = {};
  let transitionSourceCounts = {};
  let historyDebugRequestedSessionDate = sessionDate || null;
  let historyDebugEffectiveSessionDate = sessionDate || null;
  let historyDebugRowScope = 'requested_session_date';
  let historyDebugRowScopeFallbackUsed = false;
  let historyDebugRowScopeFallbackReason = null;
  let historyDebugDbPath = null;
  let historyDebugLatestObservationAt = null;
  let historyDebugLatestTransitionAt = null;
  if (persistenceAvailable) {
    const rowScope = resolveLiveCandidateHistoryRowScope({
      persistenceStatements,
      sessionDate: sessionDate || '',
      dbPath: String(persistenceDb?.name || '').trim() || null,
    });
    const historySessionDate = String(rowScope?.effectiveSessionDate || '').trim() || (sessionDate || '');
    historyDebugRequestedSessionDate = rowScope?.requestedSessionDate || sessionDate || null;
    historyDebugEffectiveSessionDate = rowScope?.effectiveSessionDate || historySessionDate || null;
    historyDebugRowScope = rowScope?.rowScopeMode || 'requested_session_date';
    historyDebugRowScopeFallbackUsed = rowScope?.rowScopeFallbackUsed === true;
    historyDebugRowScopeFallbackReason = rowScope?.rowScopeFallbackReason || null;
    historyDebugDbPath = rowScope?.dbPath || null;
    historyDebugLatestObservationAt = rowScope?.latestObservationAt || null;
    historyDebugLatestTransitionAt = rowScope?.latestTransitionAt || null;
    durableObservationCount = Number(rowScope?.observationCount || 0);
    durableTransitionCount = Number(rowScope?.transitionCount || 0);
    recentObservationRowsForViews = persistenceStatements
      .readRecentObservationsByDate
      .all(historySessionDate, LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT)
      .map((row) => normalizeDurableObservationRow(row))
      .filter(Boolean);
    recentObservationSample = recentObservationRowsForViews.slice(0, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
    recentTransitionRowsForViews = persistenceStatements
      .readRecentTransitionsByDate
      .all(historySessionDate, LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT)
      .map((row) => normalizeDurableTransitionRow(row))
      .filter(Boolean);
    recentTransitionSample = recentTransitionRowsForViews.slice(0, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
    observationSourceCounts = rowScope?.observationSourceCounts && typeof rowScope.observationSourceCounts === 'object'
      ? rowScope.observationSourceCounts
      : {};
    transitionSourceCounts = rowScope?.transitionSourceCounts && typeof rowScope.transitionSourceCounts === 'object'
      ? rowScope.transitionSourceCounts
      : {};
  } else {
    recentObservationRowsForViews = buildInMemoryObservationSample(
      monitorState,
      LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT
    );
    recentObservationSample = recentObservationRowsForViews.slice(0, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
    recentTransitionRowsForViews = Array.isArray(monitorState.transitionRows)
      ? monitorState.transitionRows
        .slice(-LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT)
        .reverse()
        .map((row) => cloneData(row, row))
      : [];
    recentTransitionSample = recentTransitionRowsForViews.slice(0, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
    durableObservationCount = recentObservationSample.length;
    durableTransitionCount = Array.isArray(monitorState.transitionRows) ? monitorState.transitionRows.length : 0;
    observationSourceCounts = {
      [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO]: durableObservationCount,
    };
    transitionSourceCounts = {
      [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO]: durableTransitionCount,
    };
  }
  const historyProvenance = buildLiveCandidateHistoryProvenance(observationSourceCounts);
  const historyViews = buildLiveCandidateFilteredHistoryViews({
    recentObservations: recentObservationRowsForViews,
    recentTransitions: recentTransitionRowsForViews,
    observationSourceCounts,
    transitionSourceCounts,
    totalObservationRows: durableObservationCount,
    totalTransitionRows: durableTransitionCount,
  });
  const historyInterpretation = resolveLiveCandidateHistoryInterpretation({
    historyViews,
    minLoopObservations: LIVE_CANDIDATE_LOOP_ONLY_MIN_OBSERVATIONS_FOR_INTERPRETATION,
    minLoopTransitions: LIVE_CANDIDATE_LOOP_ONLY_MIN_TRANSITIONS_FOR_INTERPRETATION,
  });
  const responseWriteMode = responseReadOnly
    ? LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY
    : observationWriteSource;
  const responseTriggeredDurableWrites = persistenceAvailable
    && ((observationWritesThisSnapshot + transitionWritesThisSnapshot) > 0);
  const responseTriggeredAnyWrites = (observationWritesThisSnapshot + transitionWritesThisSnapshot) > 0;
  const responseWriteSummaryLine = responseReadOnly
    ? (readOnlySkippedWritesThisSnapshot > 0
      ? `Read-only response skipped ${readOnlySkippedWritesThisSnapshot} candidate write(s).`
      : 'Read-only response; no candidate writes attempted.')
    : `${responseWriteMode} wrote ${observationWritesThisSnapshot} observation(s) and ${transitionWritesThisSnapshot} transition(s).`;
  const historyEvaluationMode = String(historyInterpretation?.mode || 'loop_only').trim() || 'loop_only';
  const historyEvaluationFallbackUsed = historyInterpretation?.fallbackUsed === true;
  const historyEvaluationFallbackReason = String(historyInterpretation?.fallbackReason || '').trim() || null;
  const historyEvaluationFallbackMode = String(historyInterpretation?.fallbackMode || '').trim() || null;
  const historyEvaluationReferenceModes = Array.isArray(historyInterpretation?.referenceModes)
    ? historyInterpretation.referenceModes
    : ['all_history', 'loop_only', 'diagnostic_only'];
  const historyEvaluationLatestTransition = cloneData(
    historyInterpretation?.latestTransition,
    historyInterpretation?.latestTransition
  );
  const historyEvaluationSummaryLine = historyEvaluationFallbackUsed
    ? `History interpretation uses ${historyEvaluationMode} (fallback: ${historyEvaluationFallbackReason || 'loop_history_sparse'}).`
    : `History interpretation uses ${historyEvaluationMode}.`;

  const transitionCandidate = monitoredCandidates.find((row) => row.transitionType === 'crossed_into_actionable') || null;
  const actionableTransitionDetected = Boolean(transitionCandidate && insideApprovedActionWindow);
  const actionableTransitionReason = actionableTransitionDetected
    ? 'structure_improved_to_actionable'
    : (transitionCandidate ? 'transition_outside_approved_window' : 'no_actionable_transition');
  const actionableTransitionTimestamp = actionableTransitionDetected
    ? nowEt
    : null;
  const actionableTransitionCandidateKey = actionableTransitionDetected
    ? transitionCandidate?.candidateKey || null
    : null;
  const transitionSummaryLine = actionableTransitionDetected
    ? `Actionable transition: ${transitionCandidate?.strategyKey || transitionCandidate?.candidateKey || 'candidate'} became actionable.`
    : (transitionCandidate
      ? 'Transition detected but outside approved action window.'
      : 'No actionable transition detected.');
  const hasPriorStateReadback = monitoredCandidates.some((row) => String(row?.previousStateSource || '').trim().toLowerCase() !== 'none');
  const emptyStateReason = !hasPriorStateReadback
    ? 'no_prior_observations_yet'
    : durableTransitionCount <= 0
      ? 'prior_observations_no_transitions'
      : 'transitions_recorded_no_actionable_transition';

  monitorState.lastSnapshotAt = nowEt;
  if (actionableTransitionDetected) {
    monitorState.lastActionableTransition = {
      candidateKey: actionableTransitionCandidateKey,
      timestamp: actionableTransitionTimestamp,
      reason: actionableTransitionReason,
    };
  }

  return {
    monitoredCandidates,
    actionableTransitionDetected,
    actionableTransitionReason,
    actionableTransitionTimestamp,
    candidateKey: actionableTransitionCandidateKey,
    insideApprovedActionWindow,
    storageMode: persistenceAvailable ? 'durable_sqlite' : 'in_memory',
    responseReadOnly,
    responseWriteMode,
    observationWriteEnabled: persistenceWriteEnabled,
    observationWriteSource,
    responseTriggeredAnyWrites,
    responseTriggeredDurableWrites,
    responseWriteSummaryLine,
    sessionDate: sessionDate || null,
    observationWritesThisSnapshot,
    observationSuppressedThisSnapshot,
    readOnlySkippedWritesThisSnapshot,
    transitionWritesThisSnapshot,
    priorObservationReadCount,
    durableObservationCount,
    durableTransitionCount,
    observationSourceCounts: historyProvenance.sourceCounts,
    transitionSourceCounts,
    loopOnlyObservationCount: Number(historyViews?.loopOnly?.observationCount || 0),
    loopOnlyTransitionCount: Number(historyViews?.loopOnly?.transitionCount || 0),
    loopOnlyLatestTransition: cloneData(historyViews?.loopOnly?.latestTransition, historyViews?.loopOnly?.latestTransition),
    loopOnlyRecentObservations: cloneData(historyViews?.loopOnly?.recentObservations, historyViews?.loopOnly?.recentObservations),
    loopOnlyRecentTransitions: cloneData(historyViews?.loopOnly?.recentTransitions, historyViews?.loopOnly?.recentTransitions),
    loopOnlyHistorySummaryLine: String(historyViews?.loopOnly?.summaryLine || '').trim() || 'Loop-only history: no rows yet.',
    diagnosticOnlyObservationCount: Number(historyViews?.diagnosticOnly?.observationCount || 0),
    diagnosticOnlyTransitionCount: Number(historyViews?.diagnosticOnly?.transitionCount || 0),
    diagnosticOnlyLatestTransition: cloneData(historyViews?.diagnosticOnly?.latestTransition, historyViews?.diagnosticOnly?.latestTransition),
    diagnosticOnlyRecentObservations: cloneData(historyViews?.diagnosticOnly?.recentObservations, historyViews?.diagnosticOnly?.recentObservations),
    diagnosticOnlyRecentTransitions: cloneData(historyViews?.diagnosticOnly?.recentTransitions, historyViews?.diagnosticOnly?.recentTransitions),
    diagnosticOnlyHistorySummaryLine: String(historyViews?.diagnosticOnly?.summaryLine || '').trim() || 'Diagnostic history: no rows.',
    historyViews: cloneData(historyViews, historyViews),
    historyEvaluationMode,
    historyEvaluationFallbackUsed,
    historyEvaluationFallbackReason,
    historyEvaluationFallbackMode,
    historyEvaluationReferenceModes,
    historyEvaluationLatestTransition,
    historyEvaluationSummaryLine,
    historyProvenanceClassification: historyProvenance.classification,
    historyProvenanceSources: historyProvenance.sources,
    historyProvenanceSummaryLine: historyProvenance.summaryLine,
    historyFromLoopOnly: historyProvenance.classification === 'loop_only',
    historyMixedProvenance: String(historyProvenance.classification || '').startsWith('mixed'),
    recentObservationSample,
    recentTransitionSample,
    emptyStateReason,
    summaryLine: transitionSummaryLine,
    historyDebugDbPath,
    historyDebugRequestedSessionDate,
    historyDebugEffectiveSessionDate,
    historyDebugRowScope,
    historyDebugRowScopeFallbackUsed,
    historyDebugRowScopeFallbackReason,
    historyDebugLatestObservationAt,
    historyDebugLatestTransitionAt,
    advisoryOnly: true,
  };
}

function buildLiveCandidateTransitionHistory(input = {}) {
  const monitorState = input?.monitorState && typeof input.monitorState === 'object'
    ? input.monitorState
    : LIVE_CANDIDATE_STATE_MONITOR_STATE;
  if (!Array.isArray(monitorState.transitionRows)) {
    monitorState.transitionRows = [];
  }
  const db = input?.db && typeof input.db.prepare === 'function' ? input.db : null;
  const sessionDate = String(input?.sessionDate || '').trim() || '';
  const persistenceStatements = db ? getLiveCandidateStateDbStatements(db) : null;
  let storageMode = 'in_memory';
  let recentTransitions = monitorState.transitionRows
    .slice(-LIVE_CANDIDATE_RECENT_HISTORY_LIMIT)
    .reverse()
    .map((row) => cloneData(row, row));
  let recentObservations = buildInMemoryObservationSample(monitorState, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
  let recentTransitionRowsForViews = monitorState.transitionRows
    .slice(-LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT)
    .reverse()
    .map((row) => cloneData(row, row));
  let recentObservationRowsForViews = buildInMemoryObservationSample(
    monitorState,
    LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT
  );
  let totalObservationRows = recentObservations.length;
  let totalTransitionRows = recentTransitions.length;
  let observationSourceCounts = {};
  let transitionSourceCounts = {};
  let historyDebugRequestedSessionDate = sessionDate || null;
  let historyDebugEffectiveSessionDate = sessionDate || null;
  let historyDebugRowScope = 'requested_session_date';
  let historyDebugRowScopeFallbackUsed = false;
  let historyDebugRowScopeFallbackReason = null;
  let historyDebugDbPath = null;
  let historyDebugLatestObservationAt = null;
  let historyDebugLatestTransitionAt = null;

  if (persistenceStatements) {
    storageMode = 'durable_sqlite';
    const rowScope = resolveLiveCandidateHistoryRowScope({
      persistenceStatements,
      sessionDate: sessionDate || '',
      dbPath: String(db?.name || '').trim() || null,
    });
    const historySessionDate = String(rowScope?.effectiveSessionDate || '').trim() || (sessionDate || '');
    historyDebugRequestedSessionDate = rowScope?.requestedSessionDate || sessionDate || null;
    historyDebugEffectiveSessionDate = rowScope?.effectiveSessionDate || historySessionDate || null;
    historyDebugRowScope = rowScope?.rowScopeMode || 'requested_session_date';
    historyDebugRowScopeFallbackUsed = rowScope?.rowScopeFallbackUsed === true;
    historyDebugRowScopeFallbackReason = rowScope?.rowScopeFallbackReason || null;
    historyDebugDbPath = rowScope?.dbPath || null;
    historyDebugLatestObservationAt = rowScope?.latestObservationAt || null;
    historyDebugLatestTransitionAt = rowScope?.latestTransitionAt || null;
    const transitionRows = persistenceStatements.readRecentTransitionsByDate.all(
      historySessionDate,
      LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT
    );
    recentTransitionRowsForViews = transitionRows
      .map((row) => normalizeDurableTransitionRow(row))
      .filter(Boolean);
    recentTransitions = recentTransitionRowsForViews.slice(0, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
    recentObservationRowsForViews = persistenceStatements
      .readRecentObservationsByDate
      .all(historySessionDate, LIVE_CANDIDATE_RECENT_HISTORY_FILTER_SCAN_LIMIT)
      .map((row) => normalizeDurableObservationRow(row))
      .filter(Boolean);
    recentObservations = recentObservationRowsForViews.slice(0, LIVE_CANDIDATE_RECENT_HISTORY_LIMIT);
    totalObservationRows = Number(rowScope?.observationCount || 0);
    totalTransitionRows = Number(rowScope?.transitionCount || 0);
    observationSourceCounts = rowScope?.observationSourceCounts && typeof rowScope.observationSourceCounts === 'object'
      ? rowScope.observationSourceCounts
      : {};
    transitionSourceCounts = rowScope?.transitionSourceCounts && typeof rowScope.transitionSourceCounts === 'object'
      ? rowScope.transitionSourceCounts
      : {};
  } else {
    observationSourceCounts = {
      [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO]: totalObservationRows,
    };
    transitionSourceCounts = {
      [LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO]: totalTransitionRows,
    };
  }
  const historyProvenance = buildLiveCandidateHistoryProvenance(observationSourceCounts);
  const transitionProvenance = buildLiveCandidateHistoryProvenance(transitionSourceCounts);
  const historyViews = buildLiveCandidateFilteredHistoryViews({
    recentObservations: recentObservationRowsForViews,
    recentTransitions: recentTransitionRowsForViews,
    observationSourceCounts,
    transitionSourceCounts,
    totalObservationRows,
    totalTransitionRows,
  });
  const historyInterpretation = resolveLiveCandidateHistoryInterpretation({
    historyViews,
    minLoopObservations: LIVE_CANDIDATE_LOOP_ONLY_MIN_OBSERVATIONS_FOR_INTERPRETATION,
    minLoopTransitions: LIVE_CANDIDATE_LOOP_ONLY_MIN_TRANSITIONS_FOR_INTERPRETATION,
  });

  const latestTransition = historyInterpretation?.latestTransition || null;
  const hasActionableTransition = recentTransitions.some((row) => String(row?.transitionType || '') === 'crossed_into_actionable');
  const emptyStateReason = totalObservationRows <= 0
    ? 'no_prior_observations_yet'
    : totalTransitionRows <= 0
      ? 'prior_observations_no_transitions'
      : (hasActionableTransition ? 'actionable_transitions_exist' : 'transitions_exist_no_actionable');
  const historyEvaluationMode = String(historyInterpretation?.mode || 'loop_only').trim() || 'loop_only';
  const historyEvaluationFallbackUsed = historyInterpretation?.fallbackUsed === true;
  const historyEvaluationFallbackReason = String(historyInterpretation?.fallbackReason || '').trim() || null;
  const historyEvaluationFallbackMode = String(historyInterpretation?.fallbackMode || '').trim() || null;
  const historyEvaluationReferenceModes = Array.isArray(historyInterpretation?.referenceModes)
    ? historyInterpretation.referenceModes
    : ['all_history', 'loop_only', 'diagnostic_only'];
  const historyEvaluationLatestTransition = cloneData(
    historyInterpretation?.latestTransition,
    historyInterpretation?.latestTransition
  );
  const summaryLine = historyEvaluationLatestTransition
    ? `Latest ${historyEvaluationMode} transition: ${String(historyEvaluationLatestTransition.transitionSummaryLine || '').trim() || 'state changed.'}`
    : (emptyStateReason === 'no_prior_observations_yet'
      ? 'No prior observations yet.'
      : 'No candidate transitions recorded yet.');
  const historyEvaluationSummaryLine = historyEvaluationFallbackUsed
    ? `Transition interpretation uses ${historyEvaluationMode} (fallback: ${historyEvaluationFallbackReason || 'loop_history_sparse'}).`
    : `Transition interpretation uses ${historyEvaluationMode}.`;
  return {
    recentTransitions,
    latestTransition: cloneData(historyEvaluationLatestTransition, historyEvaluationLatestTransition),
    recentObservations,
    storageMode,
    sessionDate: sessionDate || null,
    totalObservationRows,
    totalTransitionRows,
    loopOnlyObservationCount: Number(historyViews?.loopOnly?.observationCount || 0),
    loopOnlyTransitionCount: Number(historyViews?.loopOnly?.transitionCount || 0),
    loopOnlyLatestTransition: cloneData(historyViews?.loopOnly?.latestTransition, historyViews?.loopOnly?.latestTransition),
    loopOnlyRecentObservations: cloneData(historyViews?.loopOnly?.recentObservations, historyViews?.loopOnly?.recentObservations),
    loopOnlyRecentTransitions: cloneData(historyViews?.loopOnly?.recentTransitions, historyViews?.loopOnly?.recentTransitions),
    loopOnlyHistorySummaryLine: String(historyViews?.loopOnly?.summaryLine || '').trim() || 'Loop-only history: no rows yet.',
    diagnosticOnlyObservationCount: Number(historyViews?.diagnosticOnly?.observationCount || 0),
    diagnosticOnlyTransitionCount: Number(historyViews?.diagnosticOnly?.transitionCount || 0),
    diagnosticOnlyLatestTransition: cloneData(historyViews?.diagnosticOnly?.latestTransition, historyViews?.diagnosticOnly?.latestTransition),
    diagnosticOnlyRecentObservations: cloneData(historyViews?.diagnosticOnly?.recentObservations, historyViews?.diagnosticOnly?.recentObservations),
    diagnosticOnlyRecentTransitions: cloneData(historyViews?.diagnosticOnly?.recentTransitions, historyViews?.diagnosticOnly?.recentTransitions),
    diagnosticOnlyHistorySummaryLine: String(historyViews?.diagnosticOnly?.summaryLine || '').trim() || 'Diagnostic history: no rows.',
    historyViews: cloneData(historyViews, historyViews),
    historyEvaluationMode,
    historyEvaluationFallbackUsed,
    historyEvaluationFallbackReason,
    historyEvaluationFallbackMode,
    historyEvaluationReferenceModes,
    historyEvaluationLatestTransition,
    historyEvaluationSummaryLine,
    emptyStateReason,
    observationSourceCounts: historyProvenance.sourceCounts,
    transitionSourceCounts: transitionProvenance.sourceCounts,
    historyProvenanceClassification: historyProvenance.classification,
    historyProvenanceSources: historyProvenance.sources,
    historyProvenanceSummaryLine: historyProvenance.summaryLine,
    transitionHistoryProvenanceClassification: transitionProvenance.classification,
    transitionHistoryProvenanceSources: transitionProvenance.sources,
    transitionHistoryProvenanceSummaryLine: transitionProvenance.summaryLine,
    historyDebugDbPath,
    historyDebugRequestedSessionDate,
    historyDebugEffectiveSessionDate,
    historyDebugRowScope,
    historyDebugRowScopeFallbackUsed,
    historyDebugRowScopeFallbackReason,
    historyDebugLatestObservationAt,
    historyDebugLatestTransitionAt,
    observationTable: LIVE_CANDIDATE_STATE_OBSERVATION_TABLE,
    transitionTable: LIVE_CANDIDATE_STATE_TRANSITION_TABLE,
    summaryLine,
    advisoryOnly: true,
  };
}

function normalizeMockTradeReference(type = '', price = null, context = {}) {
  const normalizedType = String(type || '').trim().toLowerCase() || null;
  const numericPrice = Number(price);
  return {
    type: normalizedType,
    price: Number.isFinite(numericPrice) ? round2(numericPrice) : null,
    time: String(context?.time || '').trim() || null,
    window: String(context?.window || '').trim() || null,
    label: String(context?.label || '').trim() || null,
  };
}

function buildMockTradeStructure({ topCandidate = null, latestSession = {} } = {}) {
  const direction = String(topCandidate?.direction || 'long').trim().toLowerCase() === 'short'
    ? 'short'
    : 'long';
  const trade = latestSession?.trade && typeof latestSession.trade === 'object'
    ? latestSession.trade
    : null;
  const orb = latestSession?.orb && typeof latestSession.orb === 'object'
    ? latestSession.orb
    : {};
  const orbHigh = Number(orb.high);
  const orbLow = Number(orb.low);
  const orbRangeTicksRaw = Number(orb.range_ticks);
  const orbRangeTicks = Number.isFinite(orbRangeTicksRaw)
    ? Math.abs(orbRangeTicksRaw)
    : (Number.isFinite(orbHigh) && Number.isFinite(orbLow) ? Math.abs(orbHigh - orbLow) : null);

  const entryPrice = Number.isFinite(Number(trade?.entry_price))
    ? Number(trade.entry_price)
    : (direction === 'short' ? (Number.isFinite(orbLow) ? orbLow : null) : (Number.isFinite(orbHigh) ? orbHigh : null));
  const stopPrice = Number.isFinite(Number(trade?.sl_price))
    ? Number(trade.sl_price)
    : (direction === 'short' ? (Number.isFinite(orbHigh) ? orbHigh : null) : (Number.isFinite(orbLow) ? orbLow : null));
  const targetPrice = Number.isFinite(Number(trade?.tp_price))
    ? Number(trade.tp_price)
    : (Number.isFinite(entryPrice) && Number.isFinite(orbRangeTicks)
      ? (direction === 'short' ? (entryPrice - orbRangeTicks) : (entryPrice + orbRangeTicks))
      : null);

  const entryReference = normalizeMockTradeReference(
    Number.isFinite(Number(trade?.entry_price)) ? 'session_trade_entry' : 'orb_level_reference',
    entryPrice,
    {
      time: trade?.entry_time || null,
      window: topCandidate?.entryWindow || null,
      label: Number.isFinite(Number(trade?.entry_price))
        ? 'Derived from latest session entry signal.'
        : 'Derived from ORB reference level.',
    }
  );
  const stopReference = normalizeMockTradeReference(
    Number.isFinite(Number(trade?.sl_price)) ? 'session_trade_stop' : 'orb_invalidation_reference',
    stopPrice,
    {
      label: Number.isFinite(Number(trade?.sl_price))
        ? 'Derived from latest session stop level.'
        : 'Derived from ORB invalidation level.',
    }
  );
  const targetReference = normalizeMockTradeReference(
    Number.isFinite(Number(trade?.tp_price)) ? 'session_trade_target' : 'orb_range_projection',
    targetPrice,
    {
      label: Number.isFinite(Number(trade?.tp_price))
        ? 'Derived from latest session target level.'
        : 'Derived from ORB range projection.',
    }
  );

  const risk = Number.isFinite(entryReference.price) && Number.isFinite(stopReference.price)
    ? Math.abs(entryReference.price - stopReference.price)
    : null;
  const reward = Number.isFinite(entryReference.price) && Number.isFinite(targetReference.price)
    ? Math.abs(targetReference.price - entryReference.price)
    : null;
  const riskReward = Number.isFinite(risk) && Number.isFinite(reward) && risk > 0
    ? round2(reward / risk)
    : null;

  return {
    direction,
    entryReference,
    stopReference,
    targetReference,
    riskReward,
    complete: Number.isFinite(entryReference.price) && Number.isFinite(stopReference.price) && Number.isFinite(targetReference.price),
    usesSessionTrade: Boolean(trade),
  };
}

function buildShadowMockTradeDecision(input = {}) {
  const liveOpportunityCandidates = input?.liveOpportunityCandidates && typeof input.liveOpportunityCandidates === 'object'
    ? input.liveOpportunityCandidates
    : {};
  const todayContext = input?.todayContext && typeof input.todayContext === 'object'
    ? input.todayContext
    : {};
  const latestSession = input?.latestSession && typeof input.latestSession === 'object'
    ? input.latestSession
    : {};
  const liveCandidateStateMonitor = input?.liveCandidateStateMonitor && typeof input.liveCandidateStateMonitor === 'object'
    ? input.liveCandidateStateMonitor
    : null;
  const topCandidateActionableNow = liveOpportunityCandidates?.topCandidateActionableNow
    && typeof liveOpportunityCandidates.topCandidateActionableNow === 'object'
    ? liveOpportunityCandidates.topCandidateActionableNow
    : null;
  const topCandidateOverall = liveOpportunityCandidates?.topCandidateOverall
    && typeof liveOpportunityCandidates.topCandidateOverall === 'object'
    ? liveOpportunityCandidates.topCandidateOverall
    : (Array.isArray(liveOpportunityCandidates?.candidates) ? liveOpportunityCandidates.candidates[0] : null);
  const transitionCandidateKey = String(liveCandidateStateMonitor?.candidateKey || '').trim();
  const transitionCandidate = transitionCandidateKey && Array.isArray(liveOpportunityCandidates?.candidates)
    ? liveOpportunityCandidates.candidates.find((row) => String(row?.candidateKey || '').trim() === transitionCandidateKey) || null
    : null;
  const topCandidate = topCandidateActionableNow
    || (liveCandidateStateMonitor?.actionableTransitionDetected === true
      && liveCandidateStateMonitor?.insideApprovedActionWindow === true
      && transitionCandidate
      ? transitionCandidate
      : null)
    || (String(topCandidateOverall?.candidateStatus || '').trim().toLowerCase() === 'await_next_session'
      ? topCandidateOverall
      : null);

  const fallbackDecision = {
    eligible: false,
    status: 'ineligible',
    reason: 'no_candidate_available',
    candidateKey: null,
    strategyKey: null,
    direction: null,
    entryReference: null,
    stopReference: null,
    targetReference: null,
    riskReward: null,
    triggeredByActionableTransition: false,
    actionableTransitionCandidateKey: null,
    actionableTransitionTimestamp: null,
    actionableTransitionReason: null,
    tradePlanSummaryLine: 'Shadow mock-trade: no actionable candidate available.',
    advisoryOnly: true,
  };
  if (!topCandidate || typeof topCandidate !== 'object') {
    if (topCandidateOverall && typeof topCandidateOverall === 'object') {
      const overallStatus = String(topCandidateOverall?.candidateStatus || '').trim().toLowerCase();
      const overallExpectedValue = Number(topCandidateOverall?.candidateExpectedValue);
      const overallStructureLabel = String(topCandidateOverall?.structureQualityLabel || '').trim().toLowerCase();
      const overallStructureReasons = Array.isArray(topCandidateOverall?.structureQualityReasonCodes)
        ? topCandidateOverall.structureQualityReasonCodes.map((item) => String(item || '').trim().toLowerCase())
        : [];
      if (overallStatus === 'blocked') {
        return {
          ...fallbackDecision,
          reason: 'candidate_blocked',
          candidateKey: topCandidateOverall?.candidateKey || null,
          strategyKey: topCandidateOverall?.strategyKey || null,
          direction: topCandidateOverall?.direction || null,
          tradePlanSummaryLine: 'Shadow mock-trade: blocked candidate, no paper trade queued.',
        };
      }
      if (!isApprovedShadowActionWindow(String(topCandidateOverall?.sessionPhase || '').trim().toLowerCase())) {
        return {
          ...fallbackDecision,
          reason: 'outside_shadow_action_window',
          candidateKey: topCandidateOverall?.candidateKey || null,
          strategyKey: topCandidateOverall?.strategyKey || null,
          direction: topCandidateOverall?.direction || null,
          tradePlanSummaryLine: `Shadow mock-trade: phase ${String(topCandidateOverall?.sessionPhase || 'unknown').trim().toLowerCase() || 'unknown'} is outside approved action windows.`,
        };
      }
      if (Number.isFinite(overallExpectedValue) && overallExpectedValue < -15) {
        return {
          ...fallbackDecision,
          reason: 'negative_expected_value',
          candidateKey: topCandidateOverall?.candidateKey || null,
          strategyKey: topCandidateOverall?.strategyKey || null,
          direction: topCandidateOverall?.direction || null,
          tradePlanSummaryLine: `Shadow mock-trade: EV $${round2(overallExpectedValue)} is below tolerance.`,
        };
      }
      if (overallStructureLabel === 'poor' || overallStructureReasons.includes('no_clean_retest') || overallStructureReasons.includes('weak_follow_through') || overallStructureReasons.includes('overextended_move')) {
        const reason = overallStructureReasons.includes('overextended_move')
          ? 'overextended_move'
          : overallStructureReasons.includes('no_clean_retest')
            ? 'no_clean_retest'
            : overallStructureReasons.includes('weak_follow_through')
              ? 'weak_follow_through'
              : 'poor_structure';
        return {
          ...fallbackDecision,
          reason,
          candidateKey: topCandidateOverall?.candidateKey || null,
          strategyKey: topCandidateOverall?.strategyKey || null,
          direction: topCandidateOverall?.direction || null,
          tradePlanSummaryLine: `Shadow mock-trade: ${String(topCandidateOverall?.structureQualitySummaryLine || 'poor structure').trim().toLowerCase()}.`,
        };
      }
      return {
        ...fallbackDecision,
        reason: 'no_actionable_candidate_now',
        candidateKey: topCandidateOverall?.candidateKey || null,
        strategyKey: topCandidateOverall?.strategyKey || null,
        direction: topCandidateOverall?.direction || null,
        tradePlanSummaryLine: `Shadow mock-trade: no actionable candidate now (${overallStatus || 'none'}).`,
      };
    }
    return fallbackDecision;
  }

  const candidateStatus = String(topCandidate?.candidateStatus || '').trim().toLowerCase();
  const sessionPhase = String(topCandidate?.sessionPhase || todayContext?.sessionPhase || '').trim().toLowerCase();
  const candidateExpectedValue = Number(topCandidate?.candidateExpectedValue);
  const negativeEvTolerance = -15;
  const actionableStatuses = new Set(['ready_now', 'secondary_watch', 'watch_trigger', 'await_next_session']);
  const nextSessionQueued = candidateStatus === 'await_next_session';
  const blocked = candidateStatus === 'blocked';
  const insideApprovedActionWindow = isApprovedShadowActionWindow(sessionPhase);

  if (blocked) {
    return {
      ...fallbackDecision,
      reason: 'candidate_blocked',
      candidateKey: topCandidate?.candidateKey || null,
      strategyKey: topCandidate?.strategyKey || null,
      direction: topCandidate?.direction || null,
      tradePlanSummaryLine: 'Shadow mock-trade: blocked candidate, no paper trade queued.',
    };
  }
  if ((sessionPhase === 'outside_window' || sessionPhase === 'late_window') && !nextSessionQueued) {
    return {
      ...fallbackDecision,
      reason: 'outside_actionable_session_context',
      candidateKey: topCandidate?.candidateKey || null,
      strategyKey: topCandidate?.strategyKey || null,
      direction: topCandidate?.direction || null,
      tradePlanSummaryLine: 'Shadow mock-trade: outside actionable window and not queued for next session.',
    };
  }
  if (!insideApprovedActionWindow && !nextSessionQueued) {
    return {
      ...fallbackDecision,
      reason: 'outside_shadow_action_window',
      candidateKey: topCandidate?.candidateKey || null,
      strategyKey: topCandidate?.strategyKey || null,
      direction: topCandidate?.direction || null,
      tradePlanSummaryLine: `Shadow mock-trade: phase ${sessionPhase || 'unknown'} is outside approved action windows.`,
    };
  }
  if (!actionableStatuses.has(candidateStatus)) {
    return {
      ...fallbackDecision,
      reason: 'candidate_not_actionable',
      candidateKey: topCandidate?.candidateKey || null,
      strategyKey: topCandidate?.strategyKey || null,
      direction: topCandidate?.direction || null,
      tradePlanSummaryLine: `Shadow mock-trade: candidate status ${candidateStatus || 'unknown'} is not actionable.`,
    };
  }
  if (Number.isFinite(candidateExpectedValue) && candidateExpectedValue < negativeEvTolerance) {
    return {
      ...fallbackDecision,
      reason: 'negative_expected_value',
      candidateKey: topCandidate?.candidateKey || null,
      strategyKey: topCandidate?.strategyKey || null,
      direction: topCandidate?.direction || null,
      tradePlanSummaryLine: `Shadow mock-trade: EV $${round2(candidateExpectedValue)} is below tolerance.`,
    };
  }

  const structure = buildMockTradeStructure({ topCandidate, latestSession });
  if (!structure.complete) {
    return {
      ...fallbackDecision,
      reason: 'insufficient_trade_structure',
      candidateKey: topCandidate?.candidateKey || null,
      strategyKey: topCandidate?.strategyKey || null,
      direction: topCandidate?.direction || null,
      entryReference: structure.entryReference,
      stopReference: structure.stopReference,
      targetReference: structure.targetReference,
      riskReward: structure.riskReward,
      tradePlanSummaryLine: 'Shadow mock-trade: missing entry/stop/target structure, not eligible.',
    };
  }

  const status = nextSessionQueued ? 'queued_next_session' : 'eligible_ready';
  const reason = nextSessionQueued ? 'queued_for_next_session' : 'eligible_for_shadow_execution';
  const triggeredByActionableTransition = Boolean(
    !nextSessionQueued
    && liveCandidateStateMonitor?.actionableTransitionDetected === true
    && String(liveCandidateStateMonitor?.candidateKey || '').trim() !== ''
    && String(topCandidate?.candidateKey || '').trim() === String(liveCandidateStateMonitor?.candidateKey || '').trim()
  );
  const normalizedStatus = triggeredByActionableTransition ? 'eligible_ready_transition' : status;
  const entryPriceText = Number.isFinite(structure.entryReference?.price) ? structure.entryReference.price : 'n/a';
  const stopPriceText = Number.isFinite(structure.stopReference?.price) ? structure.stopReference.price : 'n/a';
  const targetPriceText = Number.isFinite(structure.targetReference?.price) ? structure.targetReference.price : 'n/a';
  const rrText = Number.isFinite(structure.riskReward) ? structure.riskReward : 'n/a';
  const tradePlanSummaryLine = nextSessionQueued
    ? `Shadow mock-trade queued: ${String(topCandidate?.strategyName || topCandidate?.strategyKey || 'candidate')} ${String(structure.direction || 'long').toUpperCase()} next session | entry ${entryPriceText}, stop ${stopPriceText}, target ${targetPriceText}, RR ${rrText}.`
    : (triggeredByActionableTransition
      ? `Shadow mock-trade ready on transition: ${String(topCandidate?.strategyName || topCandidate?.strategyKey || 'candidate')} ${String(structure.direction || 'long').toUpperCase()} | entry ${entryPriceText}, stop ${stopPriceText}, target ${targetPriceText}, RR ${rrText}.`
      : `Shadow mock-trade ready: ${String(topCandidate?.strategyName || topCandidate?.strategyKey || 'candidate')} ${String(structure.direction || 'long').toUpperCase()} | entry ${entryPriceText}, stop ${stopPriceText}, target ${targetPriceText}, RR ${rrText}.`);

  return {
    eligible: true,
    status: normalizedStatus,
    reason,
    candidateKey: topCandidate?.candidateKey || null,
    strategyKey: topCandidate?.strategyKey || null,
    direction: structure.direction || String(topCandidate?.direction || '').trim().toLowerCase() || null,
    entryReference: structure.entryReference,
    stopReference: structure.stopReference,
    targetReference: structure.targetReference,
    riskReward: structure.riskReward,
    triggeredByActionableTransition,
    actionableTransitionCandidateKey: triggeredByActionableTransition
      ? String(liveCandidateStateMonitor?.candidateKey || '').trim() || null
      : null,
    actionableTransitionTimestamp: triggeredByActionableTransition
      ? String(liveCandidateStateMonitor?.actionableTransitionTimestamp || '').trim() || null
      : null,
    actionableTransitionReason: triggeredByActionableTransition
      ? String(liveCandidateStateMonitor?.actionableTransitionReason || '').trim() || null
      : null,
    tradePlanSummaryLine,
    advisoryOnly: true,
  };
}

function buildShadowMockTradeLedger(input = {}) {
  const shadowMockTradeDecision = input?.shadowMockTradeDecision && typeof input.shadowMockTradeDecision === 'object'
    ? input.shadowMockTradeDecision
    : null;
  const latestSession = input?.latestSession && typeof input.latestSession === 'object'
    ? input.latestSession
    : {};
  const todayContext = input?.todayContext && typeof input.todayContext === 'object'
    ? input.todayContext
    : {};
  const pending = [];
  const open = [];
  const closed = [];

  if (!shadowMockTradeDecision || shadowMockTradeDecision.eligible !== true) {
    return {
      pending,
      open,
      closed,
      latestTrade: null,
      summaryLine: `Shadow mock ledger: no trade queued (${String(shadowMockTradeDecision?.reason || 'no_eligible_candidate').replace(/_/g, ' ')}).`,
      advisoryOnly: true,
    };
  }

  const tradeRecordBase = {
    tradeId: `${String(todayContext?.nowEt || 'unknown').slice(0, 10)}:${String(shadowMockTradeDecision.candidateKey || 'candidate')}`,
    candidateKey: shadowMockTradeDecision.candidateKey || null,
    strategyKey: shadowMockTradeDecision.strategyKey || null,
    direction: shadowMockTradeDecision.direction || null,
    entryTime: shadowMockTradeDecision.entryReference?.time || null,
    entryPriceReference: shadowMockTradeDecision.entryReference?.price ?? null,
    stop: shadowMockTradeDecision.stopReference?.price ?? null,
    target: shadowMockTradeDecision.targetReference?.price ?? null,
    riskReward: shadowMockTradeDecision.riskReward ?? null,
    exitTime: null,
    exitPriceReference: null,
    exitReason: null,
    realizedPnl: null,
    realizedOutcome: null,
    linkedCandidateKey: shadowMockTradeDecision.candidateKey || null,
    linkedStrategyKey: shadowMockTradeDecision.strategyKey || null,
    advisoryOnly: true,
  };

  if (shadowMockTradeDecision.status === 'queued_next_session') {
    pending.push({
      ...tradeRecordBase,
      status: 'pending',
      exitReason: 'queued_next_session',
      realizedOutcome: 'pending',
      realizedPnl: 0,
    });
  } else {
    const trade = latestSession?.trade && typeof latestSession.trade === 'object'
      ? latestSession.trade
      : null;
    const normalizedResult = String(trade?.result || '').trim().toLowerCase();
    if (trade && (normalizedResult === 'win' || normalizedResult === 'loss' || normalizedResult === 'breakeven')) {
      closed.push({
        ...tradeRecordBase,
        status: 'closed',
        entryTime: String(trade?.entry_time || tradeRecordBase.entryTime || '').trim() || null,
        entryPriceReference: Number.isFinite(Number(trade?.entry_price)) ? Number(trade.entry_price) : tradeRecordBase.entryPriceReference,
        stop: Number.isFinite(Number(trade?.sl_price)) ? Number(trade.sl_price) : tradeRecordBase.stop,
        target: Number.isFinite(Number(trade?.tp_price)) ? Number(trade.tp_price) : tradeRecordBase.target,
        exitTime: String(trade?.exit_time || '').trim() || null,
        exitPriceReference: Number.isFinite(Number(trade?.exit_price)) ? Number(trade.exit_price) : null,
        exitReason: String(trade?.exit_reason || normalizedResult).trim() || normalizedResult,
        realizedPnl: Number.isFinite(Number(trade?.pnl_dollars)) ? round2(Number(trade.pnl_dollars)) : 0,
        realizedOutcome: normalizedResult,
      });
    } else if (trade && normalizedResult === 'no_resolution') {
      open.push({
        ...tradeRecordBase,
        status: 'open',
        entryTime: String(trade?.entry_time || tradeRecordBase.entryTime || '').trim() || null,
        entryPriceReference: Number.isFinite(Number(trade?.entry_price)) ? Number(trade.entry_price) : tradeRecordBase.entryPriceReference,
        stop: Number.isFinite(Number(trade?.sl_price)) ? Number(trade.sl_price) : tradeRecordBase.stop,
        target: Number.isFinite(Number(trade?.tp_price)) ? Number(trade.tp_price) : tradeRecordBase.target,
        realizedOutcome: 'open',
      });
    } else {
      const phase = String(todayContext?.sessionPhase || '').trim().toLowerCase();
      if (phase === 'outside_window' || phase === 'late_window') {
        closed.push({
          ...tradeRecordBase,
          status: 'closed',
          exitReason: String(latestSession?.no_trade_reason || 'timeout_no_trigger').trim() || 'timeout_no_trigger',
          realizedOutcome: 'no_trade',
          realizedPnl: 0,
        });
      } else {
        pending.push({
          ...tradeRecordBase,
          status: 'pending',
          exitReason: String(latestSession?.no_trade_reason || 'awaiting_trigger').trim() || 'awaiting_trigger',
          realizedOutcome: 'pending',
          realizedPnl: 0,
        });
      }
    }
  }

  const latestTrade = closed[0] || open[0] || pending[0] || null;
  let summaryLine = 'Shadow mock ledger: no tracked mock trades.';
  if (closed.length > 0) {
    const first = closed[0];
    summaryLine = `Shadow mock ledger: ${closed.length} closed (${String(first.realizedOutcome || 'no_trade').toUpperCase()} ${Number.isFinite(first.realizedPnl) ? `$${round2(first.realizedPnl)}` : '$0'}).`;
  } else if (open.length > 0) {
    summaryLine = `Shadow mock ledger: ${open.length} open mock trade${open.length > 1 ? 's' : ''}.`;
  } else if (pending.length > 0) {
    summaryLine = `Shadow mock ledger: ${pending.length} pending mock trade${pending.length > 1 ? 's' : ''}.`;
  }
  return {
    pending,
    open,
    closed,
    latestTrade,
    summaryLine,
    advisoryOnly: true,
  };
}

function buildStrategyCandidateBridge({ opportunityScoring = null, liveOpportunityCandidates = null } = {}) {
  const strategyTopKey = String(opportunityScoring?.recommendedByOpportunityKey || '').trim() || null;
  const strategyTopName = String(opportunityScoring?.recommendedByOpportunityName || '').trim() || null;
  const topCandidate = (
    liveOpportunityCandidates?.topCandidateActionableNow
    && typeof liveOpportunityCandidates.topCandidateActionableNow === 'object'
  )
    ? liveOpportunityCandidates.topCandidateActionableNow
    : (Array.isArray(liveOpportunityCandidates?.candidates)
      ? liveOpportunityCandidates.candidates[0]
      : null);
  const candidateTopKey = String(topCandidate?.candidateKey || '').trim() || null;
  const candidateTopStrategyKey = String(topCandidate?.strategyKey || '').trim() || null;
  const agreement = Boolean(strategyTopKey && candidateTopStrategyKey && strategyTopKey === candidateTopStrategyKey);
  const status = agreement ? 'agree' : 'disagree';
  const summaryLine = strategyTopKey && candidateTopStrategyKey
    ? (agreement
      ? `Strategy and candidate scorers align on ${strategyTopName || strategyTopKey}.`
      : `Strategy scorer favors ${strategyTopName || strategyTopKey}; live candidate scorer favors ${topCandidate?.strategyName || candidateTopStrategyKey}.`)
    : 'Strategy-vs-candidate comparison unavailable.';
  return {
    strategyTopKey,
    strategyTopName: strategyTopName || null,
    candidateTopKey,
    candidateTopStrategyKey: candidateTopStrategyKey || null,
    agreement,
    status,
    summaryLine,
    advisoryOnly: true,
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

  const baseStrategyStack = [
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
  const opportunityScoring = buildOpportunityScoringLayer({
    strategyStack: baseStrategyStack,
    context,
    recommendation,
  });
  const opportunityScoreByKey = new Map(
    (Array.isArray(opportunityScoring?.comparisonRows) ? opportunityScoring.comparisonRows : [])
      .map((row) => [String(row?.key || ''), row])
  );
  const strategyStack = baseStrategyStack.map((entry) => {
    const opportunityRow = opportunityScoreByKey.get(String(entry?.key || ''));
    return {
      ...entry,
      opportunityWinProb: Number.isFinite(Number(opportunityRow?.opportunityWinProb))
        ? round2(Number(opportunityRow.opportunityWinProb))
        : null,
      opportunityExpectedValue: Number.isFinite(Number(opportunityRow?.opportunityExpectedValue))
        ? round2(Number(opportunityRow.opportunityExpectedValue))
        : null,
      opportunityCalibrationBand: String(opportunityRow?.opportunityCalibrationBand || '').trim().toLowerCase() || null,
      opportunityFeatureVector: opportunityRow?.opportunityFeatureVector || null,
      opportunityScoreSummaryLine: String(opportunityRow?.opportunityScoreSummaryLine || '').trim() || null,
      opportunityCompositeScore: Number.isFinite(Number(opportunityRow?.opportunityCompositeScore))
        ? round2(Number(opportunityRow.opportunityCompositeScore))
        : null,
      heuristicCompositeScore: Number.isFinite(Number(opportunityRow?.heuristicCompositeScore))
        ? round2(Number(opportunityRow.heuristicCompositeScore))
        : null,
      heuristicVsOpportunityComparison: opportunityRow?.heuristicVsOpportunityComparison || null,
    };
  });

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
    opportunityScoring,
    opportunityScoreSummaryLine: opportunityScoring?.summaryLine || null,
    heuristicVsOpportunityComparison: opportunityScoring?.heuristicVsOpportunityComparison || null,
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

function normalizeConfidenceLabel(value = '') {
  const label = String(value || '').trim().toLowerCase();
  if (label === 'high' || label === 'medium' || label === 'low') return label;
  return '';
}

function normalizePostureKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function toStanceExecutionAdjustment(stance = '') {
  const normalized = String(stance || '').trim().toLowerCase();
  if (normalized === 'attack') return 'standard management';
  if (normalized === 'standard') return 'standard management';
  if (normalized === 'caution') return 'size down';
  if (normalized === 'degraded target') return 'nearer TP';
  return 'avoid';
}

function buildExecutionStanceCard(input = {}) {
  const decision = input?.decision && typeof input.decision === 'object' ? input.decision : {};
  const todayRecommendation = input?.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const decisionQualityCard = input?.decisionQualityCard && typeof input.decisionQualityCard === 'object'
    ? input.decisionQualityCard
    : {};
  const primaryGuidance = todayRecommendation?.frontLinePrimaryBlockerGuidance
    && typeof todayRecommendation.frontLinePrimaryBlockerGuidance === 'object'
    ? todayRecommendation.frontLinePrimaryBlockerGuidance
    : null;
  const blockers = Array.isArray(decisionQualityCard?.blockers)
    ? decisionQualityCard.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const signal = normalizeDecisionSignal(
    decision?.signalLabel
    || decision?.signal
    || decision?.verdict
    || todayRecommendation?.frontLineBlockerGateSignal
    || ''
  );
  const postureKey = normalizePostureKey(todayRecommendation?.posture || '');
  const projectedWinChance = Number(todayRecommendation?.projectedWinChance);
  const confidenceScore = Number(todayRecommendation?.confidenceScore);
  const confidenceLabel = normalizeConfidenceLabel(todayRecommendation?.confidenceLabel || '');
  const recommendedTpMode = String(todayRecommendation?.recommendedTpMode || '').trim() || null;
  const hasBlockers = blockers.length > 0;
  const signalNoTrade = signal === 'NO_TRADE';
  const standDown = postureKey === 'stand_down';
  const waitSignal = signal === 'WAIT';
  const waitPosture = postureKey === 'wait_for_clearance' || postureKey === 'wait_for_news';
  const confidenceImmature = confidenceLabel === 'low'
    || (Number.isFinite(confidenceScore) && confidenceScore < 55);
  const setupValid = !signalNoTrade && !standDown && (
    signal === 'TRADE'
    || postureKey === 'trade_normally'
    || postureKey === 'trade_selectively'
    || (
      !hasBlockers
      && (waitSignal || waitPosture)
    )
  );
  const validButConfidenceImmature = setupValid && confidenceImmature;
  const strengthFactors = [];
  const weaknessFactors = [];

  if (signal === 'TRADE') strengthFactors.push('Front-line signal is trade-enabled.');
  if (!hasBlockers) strengthFactors.push('No active blocker gates.');
  if (Number.isFinite(projectedWinChance) && projectedWinChance >= 58) {
    strengthFactors.push(`Projected edge is constructive (${round2(projectedWinChance)}%).`);
  }
  if (confidenceLabel === 'high') strengthFactors.push('Confidence is high.');
  else if (confidenceLabel === 'medium') strengthFactors.push('Confidence is in the workable band.');
  if (postureKey === 'trade_normally') strengthFactors.push('Posture supports standard execution.');
  if (postureKey === 'trade_selectively') strengthFactors.push('Posture supports selective execution.');

  if (hasBlockers) {
    weaknessFactors.push(`Active blockers: ${blockers.join(', ')}.`);
    if (primaryGuidance?.blockedBy) weaknessFactors.push(primaryGuidance.blockedBy);
  }
  if (waitSignal || waitPosture) weaknessFactors.push('Entry timing still needs cleaner confirmation.');
  if (confidenceImmature) {
    weaknessFactors.push(
      Number.isFinite(confidenceScore)
        ? `Confidence is immature (${round2(confidenceScore)}).`
        : 'Confidence is immature.'
    );
  }
  if (Number.isFinite(projectedWinChance) && projectedWinChance < 55) {
    weaknessFactors.push(`Projected edge is below preferred attack band (${round2(projectedWinChance)}%).`);
  }
  if (recommendedTpMode && normalizePostureKey(recommendedTpMode) === 'nearest') {
    weaknessFactors.push('Target profile is conservative (Nearest TP).');
  }

  let stance = 'Standard';
  if (signalNoTrade || standDown) {
    stance = 'Skip';
  } else if (hasBlockers) {
    const clearanceState = String(primaryGuidance?.clearanceState || '').trim().toLowerCase();
    stance = clearanceState === 'near_clearance' || clearanceState === 'approaching_clearance'
      ? 'Degraded Target'
      : 'Skip';
  } else if (waitSignal || waitPosture) {
    stance = validButConfidenceImmature ? 'Caution' : 'Degraded Target';
  } else if (
    signal === 'TRADE'
    && postureKey === 'trade_normally'
    && confidenceLabel === 'high'
    && Number.isFinite(projectedWinChance)
    && projectedWinChance >= 62
  ) {
    stance = 'Attack';
  } else if (confidenceImmature || postureKey === 'trade_selectively') {
    stance = 'Caution';
  }

  const stanceReason = (() => {
    if (stance === 'Attack') {
      return 'Setup quality is strong with aligned signal and confidence.';
    }
    if (stance === 'Standard') {
      return 'Setup is valid with balanced confirmation and risk.';
    }
    if (stance === 'Caution') {
      return validButConfidenceImmature
        ? 'Setup is valid, but confidence is still immature.'
        : 'Setup is valid, but confirmation quality is mixed.';
    }
    if (stance === 'Degraded Target') {
      return 'Setup is tradable only with degraded targeting due timing/quality drag.';
    }
    return hasBlockers
      ? 'Blockers are still active; avoid engagement until clearance.'
      : 'Signal and posture are not trade-valid right now.';
  })();

  const confidenceMaturityNote = validButConfidenceImmature
    ? 'Setup is valid but confidence is immature; manage risk with sizing/target discipline instead of defaulting to fear-based wait logic.'
    : null;
  const executionAdjustment = toStanceExecutionAdjustment(stance);
  const summaryLine = `Stance ${stance}: ${stanceReason} Execution adjustment: ${executionAdjustment}.`;

  return {
    stance,
    reason: stanceReason,
    strengthFactors: strengthFactors.slice(0, 4),
    weaknessFactors: weaknessFactors.slice(0, 4),
    executionAdjustment,
    validButConfidenceImmature,
    confidenceMaturityNote,
    setupValid,
    signal: signal || null,
    posture: todayRecommendation?.posture || null,
    recommendedTpMode,
    summaryLine,
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
  const opportunityScoring = strategyLayers?.opportunityScoring && typeof strategyLayers.opportunityScoring === 'object'
    ? strategyLayers.opportunityScoring
    : null;
  const opportunityScoreSummaryLine = String(
    strategyLayers?.opportunityScoreSummaryLine
    || opportunityScoring?.summaryLine
    || ''
  ).trim() || null;
  const heuristicVsOpportunityComparison = strategyLayers?.heuristicVsOpportunityComparison
    && typeof strategyLayers.heuristicVsOpportunityComparison === 'object'
    ? strategyLayers.heuristicVsOpportunityComparison
    : (opportunityScoring?.heuristicVsOpportunityComparison || null);
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
  const liveOpportunityCandidates = buildLiveOpportunityCandidates({
    strategyStack: stack,
    opportunityScoring,
    recommendationKey,
    decision,
    todayContext,
    latestSession,
    regimeLabel,
    projectedWinChance,
  });
  const liveCandidateMonitorState = input?.liveCandidateStateMonitorState && typeof input.liveCandidateStateMonitorState === 'object'
    ? input.liveCandidateStateMonitorState
    : null;
  const liveCandidatePersistenceDb = input?.db && typeof input.db.prepare === 'function'
    ? input.db
    : null;
  const persistLiveCandidateState = input?.persistLiveCandidateState !== false;
  const requestedObservationWriteSource = normalizeLiveCandidateObservationWriteSource(input?.observationWriteSource);
  const observationWriteSource = persistLiveCandidateState
    ? ((requestedObservationWriteSource && requestedObservationWriteSource !== LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY)
      ? requestedObservationWriteSource
      : LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO)
    : LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY;
  const liveCandidateStateMonitor = buildLiveCandidateStateMonitor({
    liveOpportunityCandidates,
    todayContext,
    monitorState: liveCandidateMonitorState,
    db: liveCandidatePersistenceDb,
    persistLiveCandidateState,
    observationWriteSource,
  });
  const liveCandidateTransitionHistory = buildLiveCandidateTransitionHistory({
    monitorState: liveCandidateMonitorState,
    db: liveCandidatePersistenceDb,
    sessionDate: liveCandidateStateMonitor?.sessionDate || null,
  });
  const strategyCandidateOpportunityBridge = buildStrategyCandidateBridge({
    opportunityScoring,
    liveOpportunityCandidates,
  });
  const shadowMockTradeDecision = buildShadowMockTradeDecision({
    liveOpportunityCandidates,
    liveCandidateStateMonitor,
    todayContext,
    latestSession,
  });
  const shadowMockTradeLedger = buildShadowMockTradeLedger({
    shadowMockTradeDecision,
    latestSession,
    todayContext,
  });

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
  const executionStanceCard = buildExecutionStanceCard({
    decision,
    todayRecommendation,
    decisionQualityCard,
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
  todayRecommendation.executionStanceCard = { ...executionStanceCard };
  todayRecommendation.executionStance = executionStanceCard.stance;
  todayRecommendation.executionStanceReason = executionStanceCard.reason;
  todayRecommendation.executionAdjustment = executionStanceCard.executionAdjustment;
  todayRecommendation.executionStanceLine = executionStanceCard.summaryLine;
  todayRecommendation.opportunityScoring = opportunityScoring ? cloneData(opportunityScoring, opportunityScoring) : null;
  todayRecommendation.opportunityScoreSummaryLine = opportunityScoreSummaryLine;
  todayRecommendation.heuristicVsOpportunityComparison = heuristicVsOpportunityComparison
    ? cloneData(heuristicVsOpportunityComparison, heuristicVsOpportunityComparison)
    : null;
  todayRecommendation.liveOpportunityCandidates = cloneData(liveOpportunityCandidates, liveOpportunityCandidates);
  todayRecommendation.liveCandidateStateMonitor = cloneData(liveCandidateStateMonitor, liveCandidateStateMonitor);
  todayRecommendation.liveCandidateTransitionHistory = cloneData(
    liveCandidateTransitionHistory,
    liveCandidateTransitionHistory
  );
  todayRecommendation.strategyCandidateOpportunityBridge = cloneData(
    strategyCandidateOpportunityBridge,
    strategyCandidateOpportunityBridge
  );
  todayRecommendation.shadowMockTradeDecision = cloneData(shadowMockTradeDecision, shadowMockTradeDecision);
  todayRecommendation.shadowMockTradeLedger = cloneData(shadowMockTradeLedger, shadowMockTradeLedger);
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
  decisionBoard.executionStanceCard = { ...executionStanceCard };
  decisionBoard.executionStance = executionStanceCard.stance;
  decisionBoard.executionStanceReason = executionStanceCard.reason;
  decisionBoard.executionAdjustment = executionStanceCard.executionAdjustment;
  decisionBoard.executionStanceLine = executionStanceCard.summaryLine;
  decisionBoard.opportunityScoring = opportunityScoring ? cloneData(opportunityScoring, opportunityScoring) : null;
  decisionBoard.opportunityScoreSummaryLine = opportunityScoreSummaryLine;
  decisionBoard.heuristicVsOpportunityComparison = heuristicVsOpportunityComparison
    ? cloneData(heuristicVsOpportunityComparison, heuristicVsOpportunityComparison)
    : null;
  decisionBoard.liveOpportunityCandidates = cloneData(liveOpportunityCandidates, liveOpportunityCandidates);
  decisionBoard.liveCandidateStateMonitor = cloneData(liveCandidateStateMonitor, liveCandidateStateMonitor);
  decisionBoard.liveCandidateTransitionHistory = cloneData(
    liveCandidateTransitionHistory,
    liveCandidateTransitionHistory
  );
  decisionBoard.strategyCandidateOpportunityBridge = cloneData(
    strategyCandidateOpportunityBridge,
    strategyCandidateOpportunityBridge
  );
  decisionBoard.shadowMockTradeDecision = cloneData(shadowMockTradeDecision, shadowMockTradeDecision);
  decisionBoard.shadowMockTradeLedger = cloneData(shadowMockTradeLedger, shadowMockTradeLedger);

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
    executionStanceCard: executionStanceCard,
    executionStance: executionStanceCard.stance,
    executionStanceReason: executionStanceCard.reason,
    executionAdjustment: executionStanceCard.executionAdjustment,
    executionStanceLine: executionStanceCard.summaryLine,
    opportunityScoring: opportunityScoring ? cloneData(opportunityScoring, opportunityScoring) : null,
    opportunityScoreSummaryLine,
    heuristicVsOpportunityComparison: heuristicVsOpportunityComparison
      ? cloneData(heuristicVsOpportunityComparison, heuristicVsOpportunityComparison)
      : null,
    liveOpportunityCandidates: cloneData(liveOpportunityCandidates, liveOpportunityCandidates),
    liveCandidateStateMonitor: cloneData(liveCandidateStateMonitor, liveCandidateStateMonitor),
    liveCandidateTransitionHistory: cloneData(liveCandidateTransitionHistory, liveCandidateTransitionHistory),
    strategyCandidateOpportunityBridge: cloneData(
      strategyCandidateOpportunityBridge,
      strategyCandidateOpportunityBridge
    ),
    shadowMockTradeDecision: cloneData(shadowMockTradeDecision, shadowMockTradeDecision),
    shadowMockTradeLedger: cloneData(shadowMockTradeLedger, shadowMockTradeLedger),
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
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_READ_ONLY,
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
  runPlanBacktest,
  buildVariantReports,
  buildDiscoveryLayer,
  buildStrategyLayerSnapshot,
  buildReplayVariantAssessment,
  buildCommandCenterPanels,
  buildAssistantDecisionBrief,
  buildPineScriptForStrategy,
};
