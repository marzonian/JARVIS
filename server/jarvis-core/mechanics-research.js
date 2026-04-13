'use strict';

const { ORIGINAL_PLAN_SPEC } = require('./strategy-layers');
const { calcDrawdown } = require('../engine/stats');
const {
  buildContextualMechanicsRecommendation,
} = require('./contextual-mechanics');

const SUPPORTED_TP_MODES = Object.freeze(['Nearest', 'Skip 1', 'Skip 2']);
const SUPPORTED_STOP_FAMILIES = Object.freeze(['rr_1_to_1_from_tp']);
const UNSUPPORTED_STOP_FAMILIES = Object.freeze(['structure_stop', 'orb_opposite_stop', 'fixed_tick_stop']);
const ORIGINAL_PLAN_TP_MODE = 'Skip 2';
const ORIGINAL_PLAN_STOP_MODE = 'rr_1_to_1_from_tp';
const DEFAULT_WINDOW_TRADES = 120;
const MIN_WINDOW_TRADES = 20;
const MAX_WINDOW_TRADES = 500;
const MIN_TRADES_PER_MODE = 15;

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
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

function pnlDollarsFromTicks(ticks) {
  const n = toNumber(ticks, null);
  if (!Number.isFinite(n)) return null;
  return round2((n * 0.5) - 4.5);
}

function normalizeOutcome(value) {
  const key = toText(value).toLowerCase();
  if (key === 'win' || key === 'loss' || key === 'breakeven' || key === 'open') return key;
  return 'unknown';
}

function normalizeRegime(regimeByDate = {}, date) {
  const src = regimeByDate && typeof regimeByDate === 'object' ? regimeByDate[date] : null;
  if (!src || typeof src !== 'object') return null;
  return toText(src.regime || src.regime_trend || src.trend || src.volatility || '').toLowerCase() || null;
}

function buildEmptyModeAccumulator(tpMode) {
  return {
    tpMode,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    breakevenCount: 0,
    openCount: 0,
    unknownCount: 0,
    grossWinTicks: 0,
    grossLossTicks: 0,
    netTicks: 0,
    winTickSum: 0,
    lossTickSum: 0,
    mfeSum: 0,
    mfeCount: 0,
    maeSum: 0,
    maeCount: 0,
    maxConsecLosses: 0,
    _consecLosses: 0,
    _pnlDollarsSeries: [],
  };
}

function accumulateMode(acc, record) {
  const outcome = normalizeOutcome(record?.outcome);
  const pnlTicks = toNumber(record?.pnlTicks, 0);
  const pnlDollars = toNumber(record?.pnlDollars, null);
  const effectivePnlDollars = Number.isFinite(pnlDollars) ? pnlDollars : pnlDollarsFromTicks(pnlTicks);
  const mfe = toNumber(record?.mfe, null);
  const mae = toNumber(record?.mae, null);

  acc.tradeCount += 1;
  if (outcome === 'win') {
    acc.winCount += 1;
    acc.grossWinTicks += Math.max(0, pnlTicks);
    acc.winTickSum += Math.max(0, pnlTicks);
    acc._consecLosses = 0;
  } else if (outcome === 'loss') {
    acc.lossCount += 1;
    acc.grossLossTicks += Math.abs(Math.min(0, pnlTicks));
    acc.lossTickSum += Math.abs(Math.min(0, pnlTicks));
    acc._consecLosses += 1;
    acc.maxConsecLosses = Math.max(acc.maxConsecLosses, acc._consecLosses);
  } else if (outcome === 'breakeven') {
    acc.breakevenCount += 1;
    acc._consecLosses = 0;
  } else if (outcome === 'open') {
    acc.openCount += 1;
    acc._consecLosses = 0;
  } else {
    acc.unknownCount += 1;
    acc._consecLosses = 0;
  }

  acc.netTicks += pnlTicks;
  if (Number.isFinite(mfe)) {
    acc.mfeSum += mfe;
    acc.mfeCount += 1;
  }
  if (Number.isFinite(mae)) {
    acc.maeSum += mae;
    acc.maeCount += 1;
  }
  if (Number.isFinite(effectivePnlDollars)) {
    acc._pnlDollarsSeries.push(effectivePnlDollars);
  }
}

function finalizeModeAccumulator(acc) {
  const tradeCount = Number(acc.tradeCount || 0);
  const winRatePct = tradeCount > 0 ? round2((Number(acc.winCount || 0) / tradeCount) * 100) : 0;
  let profitFactor = 0;
  if (Number(acc.grossLossTicks || 0) > 0) {
    profitFactor = round2(Number(acc.grossWinTicks || 0) / Number(acc.grossLossTicks || 1));
  } else if (Number(acc.grossWinTicks || 0) > 0) {
    profitFactor = 999;
  }
  const expectancyTicks = tradeCount > 0 ? round2(Number(acc.netTicks || 0) / tradeCount) : 0;
  const avgWinTicks = Number(acc.winCount || 0) > 0
    ? round2(Number(acc.winTickSum || 0) / Number(acc.winCount || 1))
    : 0;
  const avgLossTicks = Number(acc.lossCount || 0) > 0
    ? round2(Number(acc.lossTickSum || 0) / Number(acc.lossCount || 1))
    : 0;
  const avgMfeTicks = Number(acc.mfeCount || 0) > 0
    ? round2(Number(acc.mfeSum || 0) / Number(acc.mfeCount || 1))
    : 0;
  const avgMaeTicks = Number(acc.maeCount || 0) > 0
    ? round2(Number(acc.maeSum || 0) / Number(acc.maeCount || 1))
    : 0;

  const pseudoTrades = (Array.isArray(acc._pnlDollarsSeries) ? acc._pnlDollarsSeries : []).map((d) => ({ pnl_dollars: Number(d) }));
  const drawdown = calcDrawdown(pseudoTrades, 50000);
  const maxDrawdownDollars = Number.isFinite(Number(drawdown?.maxDrawdownDollars))
    ? round2(Number(drawdown.maxDrawdownDollars))
    : 0;

  // PF-first, WR-second, sample-quality third.
  const pfScore = Math.min(100, profitFactor * 25);
  const wrScore = Math.min(100, winRatePct);
  const sampleScore = Math.min(100, (tradeCount / 120) * 100);
  const scoreRecent = round2((pfScore * 0.6) + (wrScore * 0.3) + (sampleScore * 0.1));

  return {
    tpMode: acc.tpMode,
    tradeCount,
    winCount: Number(acc.winCount || 0),
    lossCount: Number(acc.lossCount || 0),
    breakevenCount: Number(acc.breakevenCount || 0),
    openCount: Number(acc.openCount || 0),
    winRatePct,
    profitFactor,
    expectancyTicks,
    avgWinTicks,
    avgLossTicks,
    avgMfeTicks,
    avgMaeTicks,
    maxConsecLosses: Number(acc.maxConsecLosses || 0),
    maxDrawdownDollars,
    scoreRecent,
  };
}

function groupRecordsBy(records = [], groupBy = 'weekday') {
  const groups = new Map();
  for (const record of records) {
    const bucket = toText(record?.[groupBy] || 'unknown') || 'unknown';
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(record);
  }
  return groups;
}

function buildSegmentRows(records = [], groupBy = 'weekday') {
  const groups = groupRecordsBy(records, groupBy);
  const rows = [];
  for (const [bucket, bucketRecords] of groups.entries()) {
    const segment = aggregateMechanicsVariants(bucketRecords, {
      segmentWeekday: false,
      segmentTimeBucket: false,
      segmentRegime: false,
      includeSegmentations: false,
    });
    for (const row of segment.mechanicsVariantTable) {
      rows.push({
        bucket,
        tpMode: row.tpMode,
        tradeCount: row.tradeCount,
        winRatePct: row.winRatePct,
        profitFactor: row.profitFactor,
        scoreRecent: row.scoreRecent,
      });
    }
  }
  rows.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)) || String(a.tpMode).localeCompare(String(b.tpMode)));
  return rows;
}

function aggregateMechanicsVariants(records = [], options = {}) {
  const clean = Array.isArray(records) ? records.filter(Boolean) : [];
  const byMode = new Map();
  for (const mode of SUPPORTED_TP_MODES) byMode.set(mode, buildEmptyModeAccumulator(mode));

  for (const record of clean) {
    const mode = toText(record?.tpMode);
    if (!byMode.has(mode)) continue;
    accumulateMode(byMode.get(mode), record);
  }

  const mechanicsVariantTable = Array.from(byMode.values()).map(finalizeModeAccumulator);
  const includeSegmentations = options.includeSegmentations !== false;
  const segmentWeekday = options.segmentWeekday !== false;
  const segmentTimeBucket = options.segmentTimeBucket !== false;
  const segmentRegime = options.segmentRegime === true;

  const segmentations = includeSegmentations
    ? {
      weekday: segmentWeekday
        ? { available: true, rows: buildSegmentRows(clean, 'weekday') }
        : { available: false, rows: [] },
      timeBucket: segmentTimeBucket
        ? { available: true, rows: buildSegmentRows(clean, 'timeBucket') }
        : { available: false, rows: [] },
      regime: segmentRegime
        ? { available: clean.some((r) => toText(r?.regime)), rows: buildSegmentRows(clean.filter((r) => toText(r?.regime)), 'regime') }
        : { available: false, rows: [] },
    }
    : {
      weekday: { available: false, rows: [] },
      timeBucket: { available: false, rows: [] },
      regime: { available: false, rows: [] },
    };

  return {
    mechanicsVariantTable,
    segmentations,
  };
}

function selectBestRow(rows = [], comparator) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return null;
  const sorted = list.slice().sort(comparator);
  return sorted[0] || null;
}

function rankMechanicsModes(table = [], options = {}) {
  const minTradesPerMode = clampInt(options.minTradesPerMode, 1, 1000, MIN_TRADES_PER_MODE);
  const rows = Array.isArray(table) ? table.filter((r) => r && Number(r.tradeCount || 0) > 0) : [];

  const bestByWinRate = selectBestRow(rows, (a, b) => {
    if (Number(b.winRatePct || 0) !== Number(a.winRatePct || 0)) return Number(b.winRatePct || 0) - Number(a.winRatePct || 0);
    if (Number(b.tradeCount || 0) !== Number(a.tradeCount || 0)) return Number(b.tradeCount || 0) - Number(a.tradeCount || 0);
    return Number(b.profitFactor || 0) - Number(a.profitFactor || 0);
  });

  const bestByProfitFactor = selectBestRow(rows, (a, b) => {
    if (Number(b.profitFactor || 0) !== Number(a.profitFactor || 0)) return Number(b.profitFactor || 0) - Number(a.profitFactor || 0);
    if (Number(b.winRatePct || 0) !== Number(a.winRatePct || 0)) return Number(b.winRatePct || 0) - Number(a.winRatePct || 0);
    return Number(b.tradeCount || 0) - Number(a.tradeCount || 0);
  });

  const sampleQualifiedRows = rows.filter((r) => Number(r.tradeCount || 0) >= minTradesPerMode);
  const bestRecentRow = selectBestRow(sampleQualifiedRows.length ? sampleQualifiedRows : rows, (a, b) => {
    if (Number(b.scoreRecent || 0) !== Number(a.scoreRecent || 0)) return Number(b.scoreRecent || 0) - Number(a.scoreRecent || 0);
    if (Number(b.profitFactor || 0) !== Number(a.profitFactor || 0)) return Number(b.profitFactor || 0) - Number(a.profitFactor || 0);
    return Number(b.winRatePct || 0) - Number(a.winRatePct || 0);
  });

  const warnings = [];
  const isThinSample = rows.some((r) => Number(r.tradeCount || 0) < minTradesPerMode) || rows.length === 0;
  if (isThinSample) warnings.push(`Thin-sample caution: at least one TP mode has fewer than ${minTradesPerMode} trades in the evidence window.`);

  return {
    bestTpModeByWinRate: bestByWinRate?.tpMode || null,
    bestTpModeByProfitFactor: bestByProfitFactor?.tpMode || null,
    bestTpModeRecent: bestRecentRow?.tpMode || null,
    _rowsByMode: {
      byWinRate: bestByWinRate || null,
      byProfitFactor: bestByProfitFactor || null,
      byRecent: bestRecentRow || null,
    },
    dataQuality: {
      isThinSample,
      warnings,
    },
  };
}

function buildMechanicsRecommendation(table = [], ranking = {}, options = {}) {
  const minTradesPerMode = clampInt(options.minTradesPerMode, 1, 1000, MIN_TRADES_PER_MODE);
  const byMode = new Map((Array.isArray(table) ? table : []).map((r) => [toText(r?.tpMode), r]));
  const pfMode = toText(ranking?.bestTpModeByProfitFactor);
  const wrMode = toText(ranking?.bestTpModeByWinRate);
  const recentMode = toText(ranking?.bestTpModeRecent);
  const pfRow = byMode.get(pfMode) || null;
  const wrRow = byMode.get(wrMode) || null;
  const recentRow = byMode.get(recentMode) || null;

  let recommended = recentMode || pfMode || wrMode || ORIGINAL_PLAN_TP_MODE;
  let basis = 'pf_wr_sample_quality';
  let reason = 'Recent evidence favors this TP mode when balancing PF, win rate, and sample quality.';

  const thin = ranking?.dataQuality?.isThinSample === true;
  if (thin) {
    recommended = pfMode || recentMode || ORIGINAL_PLAN_TP_MODE;
    basis = 'thin_sample_guard';
    reason = `Sample quality is thin, so recommendation leans conservative toward the strongest PF evidence while keeping ${ORIGINAL_PLAN_TP_MODE} as baseline.`;
  } else if (pfRow && wrRow && pfMode && wrMode && pfMode !== wrMode) {
    const wrPf = Number(wrRow.profitFactor || 0);
    const pfPf = Number(pfRow.profitFactor || 0);
    const wrTrades = Number(wrRow.tradeCount || 0);
    const wrSafePf = pfPf > 0 ? (wrPf / pfPf) : 1;
    if (wrTrades >= minTradesPerMode && wrSafePf >= 0.75 && Number(wrRow.winRatePct || 0) > Number(pfRow.winRatePct || 0)) {
      recommended = wrMode;
      basis = 'win_rate_with_pf_guard';
      reason = `${wrMode} is recommended because it improves win rate while keeping profit factor within acceptable range versus ${pfMode}.`;
    } else {
      recommended = pfMode;
      basis = 'profit_factor_priority';
      reason = `${pfMode} is recommended because it preserves stronger profit factor despite lower win rate than ${wrMode}.`;
    }
  } else if (recentMode) {
    recommended = recentMode;
    basis = 'recent_rank';
    reason = `${recentMode} leads the recent PF-first ranking across eligible trades.`;
  }

  return {
    recommendedTpMode: recommended || ORIGINAL_PLAN_TP_MODE,
    recommendedTpModeReason: reason,
    recommendationBasis: basis,
  };
}

function buildResearchRecordsFromSessions({ sessions = {}, windowTrades = DEFAULT_WINDOW_TRADES, regimeByDate = {}, deps = {} }) {
  const process = typeof deps.processSession === 'function' ? deps.processSession : null;
  const mechanicsRunner = typeof deps.runTradeMechanicsVariantTool === 'function' ? deps.runTradeMechanicsVariantTool : null;
  if (!process || !mechanicsRunner) {
    return {
      eligibleTradeCount: 0,
      evaluatedTradeCount: 0,
      records: [],
      warnings: ['dependencies_missing'],
    };
  }

  const dates = Object.keys(sessions || {}).sort();
  const eligible = [];
  for (const date of dates) {
    const candles = Array.isArray(sessions[date]) ? sessions[date] : [];
    if (!candles.length) continue;
    const sessionResult = process(candles, { ...ORIGINAL_PLAN_SPEC.engineOptions });
    if (!sessionResult?.trade) continue;
    eligible.push({
      date,
      candles,
      trade: sessionResult.trade,
      weekday: getEtWeekday(date),
      timeBucket: deriveTimeBucket(sessionResult.trade.entry_time),
      regime: normalizeRegime(regimeByDate, date),
    });
  }

  const windowed = eligible.slice(Math.max(0, eligible.length - windowTrades));
  const records = [];
  const warnings = [];
  let evaluatedTradeCount = 0;

  for (const row of windowed) {
    const toolOut = mechanicsRunner({
      candles: row.candles,
      trade: row.trade,
      originalPlanEligible: true,
    });
    const variants = Array.isArray(toolOut?.data?.mechanicsVariants) ? toolOut.data.mechanicsVariants : [];
    if (!variants.length) {
      warnings.push(`mechanics_unavailable_${row.date}`);
      continue;
    }
    evaluatedTradeCount += 1;
    for (const variant of variants) {
      records.push({
        tradeKey: `${row.date}|${toText(row.trade?.entry_time || '')}|${toText(row.trade?.direction || '')}`,
        date: row.date,
        weekday: row.weekday,
        timeBucket: row.timeBucket,
        regime: row.regime,
        tpMode: toText(variant?.tpMode),
        stopMode: toText(variant?.stopMode),
        outcome: normalizeOutcome(variant?.outcome),
        pnlTicks: toNumber(variant?.pnlTicks, 0),
        pnlDollars: toNumber(variant?.pnlDollars, pnlDollarsFromTicks(variant?.pnlTicks)),
        mfe: toNumber(variant?.mfe, null),
        mae: toNumber(variant?.mae, null),
      });
    }
  }

  return {
    eligibleTradeCount: eligible.length,
    evaluatedTradeCount,
    records,
    warnings,
  };
}

function buildMechanicsResearchSummary(input = {}) {
  const windowTrades = clampInt(
    input.windowTrades,
    MIN_WINDOW_TRADES,
    MAX_WINDOW_TRADES,
    DEFAULT_WINDOW_TRADES
  );
  const segmentWeekday = input.segmentWeekday !== false;
  const segmentTimeBucket = input.segmentTimeBucket !== false;
  const segmentRegime = input.segmentRegime === true;
  const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object' ? input.regimeByDate : {};

  const built = buildResearchRecordsFromSessions({
    sessions,
    windowTrades,
    regimeByDate,
    deps: input.deps || {},
  });

  const aggregated = aggregateMechanicsVariants(built.records, {
    segmentWeekday,
    segmentTimeBucket,
    segmentRegime,
    includeSegmentations: true,
  });
  const ranking = rankMechanicsModes(aggregated.mechanicsVariantTable, {
    minTradesPerMode: MIN_TRADES_PER_MODE,
  });
  const recommendation = buildMechanicsRecommendation(aggregated.mechanicsVariantTable, ranking, {
    minTradesPerMode: MIN_TRADES_PER_MODE,
  });
  const contextualRecommendation = buildContextualMechanicsRecommendation({
    records: built.records,
    globalSummary: {
      mechanicsVariantTable: aggregated.mechanicsVariantTable,
      recommendedTpMode: recommendation.recommendedTpMode,
      bestTpModeRecent: ranking.bestTpModeRecent,
      bestTpModeByWinRate: ranking.bestTpModeByWinRate,
      bestTpModeByProfitFactor: ranking.bestTpModeByProfitFactor,
    },
    nowEt: input.nowEt,
    regimeByDate,
    currentRegime: input.currentRegime,
    minSampleSize: Number(input.contextMinSample || MIN_TRADES_PER_MODE),
    deps: {
      aggregateMechanicsVariants,
      rankMechanicsModes,
      buildMechanicsRecommendation,
    },
  });

  const warnings = [];
  if (Array.isArray(built.warnings) && built.warnings.length > 0) warnings.push(...built.warnings);
  if (Array.isArray(ranking?.dataQuality?.warnings) && ranking.dataQuality.warnings.length > 0) warnings.push(...ranking.dataQuality.warnings);

  return {
    generatedAt: new Date().toISOString(),
    windowMode: 'eligible_trades',
    windowSize: windowTrades,
    eligibleTradeCount: Number(built.eligibleTradeCount || 0),
    evaluatedTradeCount: Number(built.evaluatedTradeCount || 0),
    supportedTpModes: [...SUPPORTED_TP_MODES],
    supportedStopFamilies: [...SUPPORTED_STOP_FAMILIES],
    unsupportedStopFamilies: [...UNSUPPORTED_STOP_FAMILIES],
    originalPlanTpMode: ORIGINAL_PLAN_TP_MODE,
    originalPlanStopMode: ORIGINAL_PLAN_STOP_MODE,
    bestTpModeRecent: ranking.bestTpModeRecent,
    bestTpModeByWinRate: ranking.bestTpModeByWinRate,
    bestTpModeByProfitFactor: ranking.bestTpModeByProfitFactor,
    recommendedTpMode: recommendation.recommendedTpMode,
    recommendedTpModeReason: recommendation.recommendedTpModeReason,
    recommendationBasis: recommendation.recommendationBasis,
    contextualRecommendation,
    mechanicsVariantTable: aggregated.mechanicsVariantTable,
    segmentations: aggregated.segmentations,
    dataQuality: {
      isThinSample: ranking?.dataQuality?.isThinSample === true,
      warnings: Array.from(new Set(warnings)),
    },
    advisoryOnly: true,
  };
}

module.exports = {
  SUPPORTED_TP_MODES,
  SUPPORTED_STOP_FAMILIES,
  UNSUPPORTED_STOP_FAMILIES,
  ORIGINAL_PLAN_TP_MODE,
  ORIGINAL_PLAN_STOP_MODE,
  buildMechanicsResearchSummary,
  aggregateMechanicsVariants,
  rankMechanicsModes,
  buildMechanicsRecommendation,
};
