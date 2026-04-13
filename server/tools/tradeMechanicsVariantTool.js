'use strict';

const { calcTPSL } = require('../engine/psych-levels');
const { resolveTrade } = require('../engine/orb');

const SUPPORTED_TP_VARIANTS = Object.freeze([
  Object.freeze({ key: 'nearest', label: 'Nearest', tpMode: 'skip2', skipLevels: 0 }),
  Object.freeze({ key: 'skip1', label: 'Skip 1', tpMode: 'skip2', skipLevels: 1 }),
  Object.freeze({ key: 'skip2', label: 'Skip 2', tpMode: 'skip2', skipLevels: 2 }),
]);

const STOP_MODE = 'rr_1_to_1_from_tp';

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandleTimestamp(raw) {
  const txt = toText(raw);
  if (!txt) return '';
  if (txt.includes('T')) return txt.replace('T', ' ').replace(/Z$/i, '');
  return txt;
}

function normalizeCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((c) => {
      const timestamp = normalizeCandleTimestamp(c?.timestamp || `${toText(c?.date)} ${toText(c?.time)}`);
      return {
        timestamp,
        open: Number(c?.open),
        high: Number(c?.high),
        low: Number(c?.low),
        close: Number(c?.close),
      };
    })
    .filter((c) => c.timestamp && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v)))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function pointsToTicks(points) {
  const n = Number(points);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 4);
}

function normalizeOutcomeFromResolution(resolution = {}) {
  const key = toText(resolution?.result).toLowerCase();
  if (key === 'win' || key === 'loss' || key === 'breakeven') return key;
  if (key === 'no_resolution') return 'open';
  return 'unknown';
}

function normalizeHitOrder(resolution = {}) {
  const reason = toText(resolution?.exit_reason).toLowerCase();
  if (!reason) return 'unknown';
  if (reason.startsWith('tp')) return 'tp_first';
  if (reason.startsWith('sl')) return 'sl_first';
  if (reason === 'time_close') return 'time_close';
  if (reason === 'no_data') return 'unknown';
  return reason;
}

function computeBarsToResolution(postEntryCandles = [], resolution = {}) {
  const exitTime = normalizeCandleTimestamp(resolution?.exit_time);
  if (!exitTime) return null;
  const idx = postEntryCandles.findIndex((c) => String(c.timestamp) === String(exitTime));
  if (idx < 0) return null;
  return idx + 1;
}

function computeExcursionToResolution({
  direction,
  entryPrice,
  postEntryCandles,
  resolution,
}) {
  const dir = toText(direction).toLowerCase();
  const entry = toNumber(entryPrice);
  if (!entry || !Array.isArray(postEntryCandles) || postEntryCandles.length === 0) {
    return { mfe: null, mae: null };
  }

  const barsToResolution = computeBarsToResolution(postEntryCandles, resolution);
  const slice = Number.isFinite(barsToResolution)
    ? postEntryCandles.slice(0, Math.max(0, barsToResolution))
    : postEntryCandles.slice();
  if (!slice.length) return { mfe: null, mae: null };

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const c of slice) {
    maxHigh = Math.max(maxHigh, Number(c.high));
    minLow = Math.min(minLow, Number(c.low));
  }
  if (!Number.isFinite(maxHigh) || !Number.isFinite(minLow)) return { mfe: null, mae: null };

  if (dir === 'short') {
    return {
      mfe: Math.max(0, pointsToTicks(entry - minLow) || 0),
      mae: Math.max(0, pointsToTicks(maxHigh - entry) || 0),
    };
  }

  return {
    mfe: Math.max(0, pointsToTicks(maxHigh - entry) || 0),
    mae: Math.max(0, pointsToTicks(entry - minLow) || 0),
  };
}

function simulateVariant({
  candles,
  entryPrice,
  entryTime,
  direction,
  variant,
}) {
  const outWarnings = [];
  const entry = toNumber(entryPrice);
  const dir = toText(direction).toLowerCase();
  if (!Number.isFinite(entry) || !entryTime || (dir !== 'long' && dir !== 'short')) {
    return {
      tpMode: variant.label,
      stopMode: STOP_MODE,
      entryPx: Number.isFinite(entry) ? entry : null,
      tpPx: null,
      slPx: null,
      hitOrder: 'unknown',
      outcome: 'unknown',
      mfe: null,
      mae: null,
      barsToResolution: null,
      warnings: ['missing_trade_inputs'],
      _meta: {
        key: variant.key,
        skipLevels: variant.skipLevels,
        tpModeInternal: variant.tpMode,
        pnlTicks: null,
        exitReason: null,
      },
    };
  }

  const tpsl = calcTPSL(entry, dir, {
    tpMode: variant.tpMode,
    skipLevels: variant.skipLevels,
  });

  const normalized = normalizeCandles(candles);
  const entryIdx = normalized.findIndex((c) => String(c.timestamp) === String(entryTime));
  const fromIdx = entryIdx >= 0
    ? entryIdx + 1
    : normalized.findIndex((c) => String(c.timestamp) > String(entryTime));
  const postEntry = fromIdx >= 0 ? normalized.slice(fromIdx) : [];
  if (!postEntry.length) outWarnings.push('no_post_entry_candles');

  const resolution = resolveTrade(
    postEntry,
    entry,
    dir,
    Number(tpsl?.tp?.price),
    Number(tpsl?.sl?.price)
  );
  const outcome = normalizeOutcomeFromResolution(resolution);
  const hitOrder = normalizeHitOrder(resolution);
  const barsToResolution = computeBarsToResolution(postEntry, resolution);
  const pnlTicks = Number.isFinite(Number(resolution?.pnl_ticks)) ? Number(resolution.pnl_ticks) : null;
  const pnlDollars = Number.isFinite(Number(resolution?.pnl_dollars)) ? Number(resolution.pnl_dollars) : null;
  const exitReason = toText(resolution?.exit_reason) || null;
  const excursion = computeExcursionToResolution({
    direction: dir,
    entryPrice: entry,
    postEntryCandles: postEntry,
    resolution,
  });

  return {
    tpMode: variant.label,
    stopMode: STOP_MODE,
    entryPx: entry,
    tpPx: Number(tpsl?.tp?.price),
    slPx: Number(tpsl?.sl?.price),
    hitOrder,
    outcome,
    pnlTicks,
    pnlDollars,
    exitReason,
    mfe: Number.isFinite(Number(excursion?.mfe)) ? Number(excursion.mfe) : null,
    mae: Number.isFinite(Number(excursion?.mae)) ? Number(excursion.mae) : null,
    barsToResolution: Number.isFinite(Number(barsToResolution)) ? Number(barsToResolution) : null,
    warnings: outWarnings,
    _meta: {
      key: variant.key,
      skipLevels: variant.skipLevels,
      tpModeInternal: variant.tpMode,
      pnlTicks,
      pnlDollars,
      exitReason,
      exitTime: toText(resolution?.exit_time) || null,
    },
  };
}

function outcomeRank(outcome) {
  const key = toText(outcome).toLowerCase();
  if (key === 'win') return 5;
  if (key === 'breakeven') return 4;
  if (key === 'open') return 3;
  if (key === 'loss') return 2;
  if (key === 'no_trade') return 1;
  return 0;
}

function pickBestVariant(variants = []) {
  const list = Array.isArray(variants) ? variants.filter(Boolean) : [];
  if (!list.length) return null;
  const ranked = list.slice().sort((a, b) => {
    const rankDelta = outcomeRank(b?.outcome) - outcomeRank(a?.outcome);
    if (rankDelta !== 0) return rankDelta;
    const pnlDelta = Number(b?._meta?.pnlTicks || 0) - Number(a?._meta?.pnlTicks || 0);
    if (pnlDelta !== 0) return pnlDelta;
    const mfeDelta = Number(b?.mfe || 0) - Number(a?.mfe || 0);
    if (mfeDelta !== 0) return mfeDelta;
    const barA = Number.isFinite(Number(a?.barsToResolution)) ? Number(a.barsToResolution) : Number.POSITIVE_INFINITY;
    const barB = Number.isFinite(Number(b?.barsToResolution)) ? Number(b.barsToResolution) : Number.POSITIVE_INFINITY;
    return barA - barB;
  });
  return ranked[0] || null;
}

function stripPrivateFields(item = null) {
  if (!item || typeof item !== 'object') return null;
  const clone = { ...item };
  delete clone._meta;
  return clone;
}

function buildComparisonSummary({
  variants,
  originalPlanVariant,
  bestVariant,
  eligible,
}) {
  if (eligible !== true) {
    return {
      comparisonAvailable: false,
      forcedSimulation: false,
      summaryLine: 'Mechanics variants are not official because the original plan setup was not eligible.',
      bestTpMode: null,
      originalTpMode: originalPlanVariant?.tpMode || 'Skip 2',
      changedVsOriginal: false,
    };
  }

  if (!Array.isArray(variants) || variants.length === 0) {
    return {
      comparisonAvailable: false,
      forcedSimulation: false,
      summaryLine: 'Mechanics comparison was unavailable for this replay.',
      bestTpMode: null,
      originalTpMode: originalPlanVariant?.tpMode || 'Skip 2',
      changedVsOriginal: false,
    };
  }

  const best = bestVariant || null;
  const original = originalPlanVariant || null;
  const changed = !!(best && original && (best.tpMode !== original.tpMode || best.outcome !== original.outcome));
  const summaryLine = best
    ? (changed
      ? `${best.tpMode} resolved best for this replay while original plan mechanics (${original?.tpMode || 'Skip 2'}) resolved ${original?.outcome || 'unknown'}.`
      : `${original?.tpMode || 'Original mechanics'} remained the best-performing mechanics for this replay.`)
    : 'Mechanics comparison did not produce a best variant.';

  return {
    comparisonAvailable: true,
    forcedSimulation: false,
    summaryLine,
    bestTpMode: best?.tpMode || null,
    originalTpMode: original?.tpMode || 'Skip 2',
    changedVsOriginal: changed,
  };
}

function runTradeMechanicsVariantTool(input = {}) {
  const candles = normalizeCandles(input.candles || []);
  const trade = input.trade && typeof input.trade === 'object' ? input.trade : null;
  const originalPlanEligible = input.originalPlanEligible === true;

  if (!trade || originalPlanEligible !== true) {
    const reason = !trade ? 'missing_trade_entry' : 'original_plan_ineligible';
    return {
      ok: false,
      toolName: 'TradeMechanicsVariantTool',
      data: {
        available: false,
        forcedSimulation: false,
        mechanicsVariants: [],
        originalPlanMechanicsVariant: null,
        bestMechanicsVariant: null,
        mechanicsComparisonSummary: buildComparisonSummary({
          variants: [],
          originalPlanVariant: null,
          bestVariant: null,
          eligible: false,
        }),
        reason,
      },
      narrative: {
        stance: 'Mechanics variants were not run as official outcomes because the original plan setup was not eligible.',
        trigger: null,
        condition: null,
        details: [reason],
      },
      warnings: [reason],
      debug: {
        originalPlanEligible,
      },
      metrics: {
        variantCount: 0,
      },
    };
  }

  const entryPrice = toNumber(trade.entry_price);
  const entryTime = toText(trade.entry_time);
  const direction = toText(trade.direction).toLowerCase();

  const variants = SUPPORTED_TP_VARIANTS.map((variant) => simulateVariant({
    candles,
    entryPrice,
    entryTime,
    direction,
    variant,
  }));

  const originalPlanVariantRaw = variants.find((v) => toText(v?._meta?.key) === 'skip2') || null;
  const bestVariantRaw = pickBestVariant(variants);
  const comparison = buildComparisonSummary({
    variants,
    originalPlanVariant: originalPlanVariantRaw,
    bestVariant: bestVariantRaw,
    eligible: true,
  });

  return {
    ok: true,
    toolName: 'TradeMechanicsVariantTool',
    data: {
      available: true,
      forcedSimulation: false,
      mechanicsVariants: variants.map(stripPrivateFields),
      originalPlanMechanicsVariant: stripPrivateFields(originalPlanVariantRaw),
      bestMechanicsVariant: stripPrivateFields(bestVariantRaw),
      mechanicsComparisonSummary: comparison,
      variantMeta: variants.map((v) => ({
        tpMode: v.tpMode,
        key: v?._meta?.key || null,
        tpModeInternal: v?._meta?.tpModeInternal || null,
        skipLevels: Number.isFinite(Number(v?._meta?.skipLevels)) ? Number(v._meta.skipLevels) : null,
        pnlTicks: Number.isFinite(Number(v?._meta?.pnlTicks)) ? Number(v._meta.pnlTicks) : null,
      })),
    },
    narrative: {
      stance: comparison.summaryLine,
      trigger: null,
      condition: null,
      details: variants.map((v) => `${v.tpMode}: ${v.outcome}`),
    },
    warnings: variants.flatMap((v) => Array.isArray(v.warnings) ? v.warnings : []).filter(Boolean),
    debug: {
      direction,
      entryPrice,
      entryTime,
    },
    metrics: {
      variantCount: variants.length,
      bestTpMode: comparison.bestTpMode,
    },
  };
}

module.exports = {
  STOP_MODE,
  SUPPORTED_TP_VARIANTS,
  runTradeMechanicsVariantTool,
};
