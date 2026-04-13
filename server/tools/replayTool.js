'use strict';

const { runTradeMechanicsVariantTool } = require('./tradeMechanicsVariantTool');

const ORIGINAL_PLAN_DEFAULTS = Object.freeze({
  longOnly: true,
  skipMonday: false,
  maxEntryHour: 11,
  tpMode: 'skip2',
});

const LEARNED_OVERLAY_DEFAULTS = Object.freeze({
  key: 'overlay_orb_70_220_skip_monday',
  name: 'Learned Overlay: ORB 70-220 + Skip Monday',
  orbRange: Object.freeze({ min: 70, max: 220 }),
  skipMonday: true,
});

const REPLAY_WORKABLE_ORB_MIN = 70;
const REPLAY_WORKABLE_ORB_MAX = 220;
const REPLAY_FRIDAY_EXHAUSTION_LIMIT = 380;
const REPLAY_GLOBAL_EXHAUSTION_LIMIT = 400;

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toEtDate(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return String(new Date().toISOString().slice(0, 10));
  }
}

function addDays(dateIso, deltaDays) {
  const src = String(dateIso || '').trim();
  if (!src) return null;
  const d = new Date(`${src}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function parseTargetDateFromMessage(message, fallbackDate) {
  const txt = toText(message).toLowerCase();
  const iso = txt.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso && iso[1]) return String(iso[1]);
  if (/\byesterday\b/.test(txt)) return addDays(fallbackDate, -1) || fallbackDate;
  if (/\btoday\b/.test(txt)) return fallbackDate;
  return fallbackDate;
}

function parseCandleTime(candle) {
  const rawTime = toText(candle?.time);
  if (rawTime) return rawTime.slice(0, 5);
  const ts = toText(candle?.timestamp);
  if (!ts) return '';
  if (ts.includes(' ')) return String(ts.split(' ')[1] || '').slice(0, 5);
  if (ts.includes('T')) {
    const right = String(ts.split('T')[1] || '').replace(/Z$/i, '');
    return right.slice(0, 5);
  }
  return '';
}

function normalizeDateFromCandle(candle) {
  const date = toText(candle?.date);
  if (date) return date.slice(0, 10);
  const ts = toText(candle?.timestamp);
  if (ts.includes(' ')) return String(ts.split(' ')[0] || '').slice(0, 10);
  if (ts.includes('T')) return String(ts.split('T')[0] || '').slice(0, 10);
  return '';
}

function withinRth(timeHHMM) {
  const t = toText(timeHHMM).slice(0, 5);
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return false;
  return t >= '09:30' && t <= '16:00';
}

function normalizeFiveMinuteCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((c) => {
      const date = normalizeDateFromCandle(c);
      const time = parseCandleTime(c);
      const timestamp = toText(c?.timestamp) || `${date} ${time}`;
      return {
        timestamp,
        date,
        time,
        open: Number(c?.open),
        high: Number(c?.high),
        low: Number(c?.low),
        close: Number(c?.close),
        volume: Number(c?.volume || 0),
      };
    })
    .filter((c) => c.date && c.time && withinRth(c.time))
    .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n)))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function roundTicks(points) {
  const n = Number(points);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 4);
}

function computeExcursionTicks(trade = {}, candles = []) {
  const entryPrice = Number(trade?.entry_price);
  const direction = String(trade?.direction || '').toLowerCase();
  const entryTime = toText(trade?.entry_time);
  if (!Number.isFinite(entryPrice) || !entryTime || !Array.isArray(candles) || candles.length === 0) {
    return { mfeTicks: null, maeTicks: null };
  }
  const sorted = normalizeFiveMinuteCandles(candles);
  const entryIdx = sorted.findIndex((c) => String(c.timestamp) === entryTime);
  const fromIdx = entryIdx >= 0 ? entryIdx : sorted.findIndex((c) => String(c.timestamp) >= entryTime);
  const post = fromIdx >= 0 ? sorted.slice(fromIdx) : sorted;
  if (!post.length) return { mfeTicks: null, maeTicks: null };

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const c of post) {
    maxHigh = Math.max(maxHigh, Number(c.high));
    minLow = Math.min(minLow, Number(c.low));
  }
  if (!Number.isFinite(maxHigh) || !Number.isFinite(minLow)) return { mfeTicks: null, maeTicks: null };

  if (direction === 'short') {
    const mfeTicks = roundTicks(entryPrice - minLow);
    const maeTicks = roundTicks(maxHigh - entryPrice);
    return {
      mfeTicks: Number.isFinite(mfeTicks) ? Math.max(0, mfeTicks) : null,
      maeTicks: Number.isFinite(maeTicks) ? Math.max(0, maeTicks) : null,
    };
  }

  const mfeTicks = roundTicks(maxHigh - entryPrice);
  const maeTicks = roundTicks(entryPrice - minLow);
  return {
    mfeTicks: Number.isFinite(mfeTicks) ? Math.max(0, mfeTicks) : null,
    maeTicks: Number.isFinite(maeTicks) ? Math.max(0, maeTicks) : null,
  };
}

function humanNoTradeReason(reasonCode) {
  const key = String(reasonCode || '').trim().toLowerCase();
  const map = {
    skip_monday: 'Monday is skipped by your strategy rules',
    no_orb_data: 'opening range bars are missing',
    no_post_orb_candles: 'no post-ORB candles were available',
    no_breakout: 'no breakout confirmed after ORB',
    no_retest: 'breakout never gave a clean retest',
    no_confirmation: 'retest never got confirmation',
    entry_after_max_hour: 'confirmation arrived after your max entry hour',
    max_flips_exceeded: 'invalidation flips exceeded the safety cap',
  };
  return map[key] || (key ? key.replace(/_/g, ' ') : 'setup conditions were not met');
}

function humanEligibilityReason(code) {
  const key = String(code || '').trim().toLowerCase();
  const map = {
    orb_outside_workable_zone: `ORB is outside your workable ${REPLAY_WORKABLE_ORB_MIN}-${REPLAY_WORKABLE_ORB_MAX} tick zone`,
    orb_global_exhaustion: `ORB exceeded ${REPLAY_GLOBAL_EXHAUSTION_LIMIT} ticks (historical exhaustion risk)`,
    orb_friday_exhaustion: `Friday ORB exceeded ${REPLAY_FRIDAY_EXHAUSTION_LIMIT} ticks (volatility exhaustion risk)`,
    entry_after_max_hour: 'confirmation arrived after your max entry hour',
    retest_not_confirmed: 'retest structure did not complete',
    direction_filter_long_only: 'first breakout was short but strategy is long-only',
    risk_skip_monday: 'Monday is excluded by your active strategy rules',
    no_breakout: 'no valid breakout confirmed after ORB',
    no_confirmation: 'retest never confirmed with entry conditions',
    max_flips_exceeded: 'invalidation flip count exceeded safety limit',
  };
  return map[key] || humanNoTradeReason(key);
}

function getDayNameEt(dateIso) {
  const src = String(dateIso || '').trim();
  if (!src) return null;
  const d = new Date(`${src}T12:00:00-05:00`);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
    }).format(d);
  } catch {
    return null;
  }
}

function findFirstBreakDirection(candles = [], orb = null) {
  if (!Array.isArray(candles) || !orb) return null;
  const high = Number(orb.high);
  const low = Number(orb.low);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  const sorted = normalizeFiveMinuteCandles(candles);
  for (const c of sorted) {
    if (String(c.time || '') < '09:45') continue;
    if (Number(c.close) > high) return 'long';
    if (Number(c.close) < low) return 'short';
  }
  return null;
}

function deriveMarketOutcome({ replay = {}, firstBreakDirection = null } = {}) {
  if (replay?.wouldTrade === true) {
    return String(replay?.result || 'unknown').trim().toLowerCase() || 'unknown';
  }
  if (firstBreakDirection === 'long') return 'upside_move';
  if (firstBreakDirection === 'short') return 'downside_move';
  return 'rangebound';
}

function deriveStrategyAlignment({ targetDate, orb = {}, replay = {}, noTradeReason = '', firstBreakDirection = null }) {
  const orbRangeTicks = Number(orb?.rangeTicks);
  const hasOrb = Number.isFinite(orbRangeTicks);
  const dayName = String(getDayNameEt(targetDate) || '').toLowerCase();
  const normalizedNoTrade = String(noTradeReason || replay?.noTradeReason || '').trim().toLowerCase();
  const originalBlockedByTimeWindow = normalizedNoTrade === 'entry_after_max_hour';
  const originalBlockedByRetestRule = normalizedNoTrade === 'no_retest' || normalizedNoTrade === 'no_confirmation';
  const originalBlockedByDirectionRule = (
    (normalizedNoTrade === 'no_breakout' && firstBreakDirection === 'short')
    || (replay?.wouldTrade === true
      && String(replay?.direction || '').toLowerCase() === 'short'
      && ORIGINAL_PLAN_DEFAULTS.longOnly === true)
  );
  const originalBlockedByRiskRule = false;

  const originalReasonCodes = [];
  if (originalBlockedByTimeWindow) originalReasonCodes.push('entry_after_max_hour');
  if (originalBlockedByRetestRule) {
    if (normalizedNoTrade === 'no_confirmation') originalReasonCodes.push('no_confirmation');
    else originalReasonCodes.push('retest_not_confirmed');
  }
  if (originalBlockedByDirectionRule) originalReasonCodes.push('direction_filter_long_only');
  if (replay?.wouldTrade !== true && normalizedNoTrade) {
    if (normalizedNoTrade === 'no_breakout') originalReasonCodes.push('no_breakout');
    else if (normalizedNoTrade === 'max_flips_exceeded') originalReasonCodes.push('max_flips_exceeded');
  }
  const dedupOriginalCodes = Array.from(new Set(originalReasonCodes));

  const originalPlanEligible = replay?.wouldTrade === true
    && !originalBlockedByTimeWindow
    && !originalBlockedByRetestRule
    && !originalBlockedByDirectionRule
    && !originalBlockedByRiskRule;
  const originalPlanOutcome = originalPlanEligible
    ? (String(replay?.result || 'unknown').trim().toLowerCase() || 'unknown')
    : 'no_trade';

  const overlayRange = LEARNED_OVERLAY_DEFAULTS.orbRange || {};
  const overlayBlockedByRangeFilter = hasOrb && (
    orbRangeTicks < Number(overlayRange.min)
      || orbRangeTicks > Number(overlayRange.max)
      || orbRangeTicks > REPLAY_GLOBAL_EXHAUSTION_LIMIT
      || (dayName === 'friday' && orbRangeTicks > REPLAY_FRIDAY_EXHAUSTION_LIMIT)
  );
  const overlayBlockedByMonday = LEARNED_OVERLAY_DEFAULTS.skipMonday === true && dayName === 'monday';
  const overlayReasonCodes = [];
  if (overlayBlockedByRangeFilter) {
    overlayReasonCodes.push('orb_outside_workable_zone');
    if (hasOrb && orbRangeTicks > REPLAY_GLOBAL_EXHAUSTION_LIMIT) {
      overlayReasonCodes.push('orb_global_exhaustion');
    } else if (hasOrb && dayName === 'friday' && orbRangeTicks > REPLAY_FRIDAY_EXHAUSTION_LIMIT) {
      overlayReasonCodes.push('orb_friday_exhaustion');
    }
  }
  if (overlayBlockedByMonday) overlayReasonCodes.push('risk_skip_monday');
  const dedupOverlayCodes = Array.from(new Set(overlayReasonCodes));
  const overlayEligible = originalPlanEligible
    && !overlayBlockedByRangeFilter
    && !overlayBlockedByMonday;
  const overlayOutcome = overlayEligible ? originalPlanOutcome : 'no_trade';

  const originalPlanBlockers = dedupOriginalCodes.map((code) => humanEligibilityReason(code));
  const overlayBlockers = dedupOverlayCodes.map((code) => humanEligibilityReason(code));
  const marketOutcome = deriveMarketOutcome({ replay, firstBreakDirection });

  let skipReasonCode = null;
  if (!originalPlanEligible) skipReasonCode = dedupOriginalCodes[0] || normalizedNoTrade || 'rules_not_satisfied';
  else if (!overlayEligible) skipReasonCode = dedupOverlayCodes[0] || 'overlay_rules_not_satisfied';

  const overlayAssessment = {
    overlayKey: LEARNED_OVERLAY_DEFAULTS.key,
    overlayName: LEARNED_OVERLAY_DEFAULTS.name,
    overlayEligible,
    overlayOutcome,
    overlayBlockers,
    rationale: overlayEligible
      ? 'Learned overlay does not downgrade this original-plan setup.'
      : (overlayBlockers[0] || 'Learned overlay blocked this setup.'),
    changedDecision: originalPlanEligible !== overlayEligible || originalPlanOutcome !== overlayOutcome,
  };

  return {
    originalPlanEligible,
    originalPlanBlockers,
    originalPlanOutcome,
    overlayEligible,
    overlayBlockers,
    overlayOutcome,
    overlayAssessment,
    marketOutcome,
    // Legacy compatibility fields (mapped to original plan truth).
    strategyEligible: originalPlanEligible,
    strategyOutcome: originalPlanOutcome,
    eligibilityReasonCodes: dedupOriginalCodes,
    eligibilityReasons: originalPlanBlockers,
    blockedByRangeFilter: overlayBlockedByRangeFilter,
    blockedByTimeWindow: originalBlockedByTimeWindow,
    blockedByRetestRule: originalBlockedByRetestRule,
    blockedByDirectionRule: originalBlockedByDirectionRule,
    blockedByRiskRule: originalBlockedByRiskRule || overlayBlockedByMonday,
    skipReasonCode,
    skipReason: skipReasonCode ? humanEligibilityReason(skipReasonCode) : null,
    firstBreakDirection,
  };
}

function pickLatestSessionDate(sessions = {}) {
  const dates = Object.keys(sessions || {}).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function buildReplayNarrative(snapshot = {}) {
  const targetDate = String(snapshot?.targetDate || '').trim();
  const replay = snapshot?.replay || {};
  const orb = snapshot?.orb || {};
  const alignment = snapshot?.alignment && typeof snapshot.alignment === 'object' ? snapshot.alignment : null;

  if (!snapshot?.available) {
    return {
      stance: `I can't replay that accurately yet because ${snapshot?.missingReason || 'session bars are missing'}.`,
      trigger: "Let's sync fresh bars or use a session date that exists in your data.",
      condition: 'If you share a valid date, then I can compute the exact would-have result.',
      details: [
        `Replay unavailable for ${targetDate || 'requested session'}.`,
        `Missing reason: ${snapshot?.missingReason || 'session_data_missing'}.`,
      ],
    };
  }

  if (replay?.wouldTrade === true) {
    const outcome = String((alignment?.strategyOutcome || replay?.result || 'unknown')).toLowerCase();
    const outcomeText = outcome === 'win'
      ? 'a win'
      : outcome === 'loss'
        ? 'a loss'
        : outcome === 'breakeven'
          ? 'break-even'
          : 'an unresolved result';
    const direction = String(replay?.direction || '').toLowerCase() || 'unknown';
    const rangeLine = Number.isFinite(Number(orb?.rangeTicks))
      ? `${Math.round(Number(orb.rangeTicks))} tick ORB`
      : 'unconfirmed ORB size';
    const mfeLine = Number.isFinite(Number(replay?.mfeTicks))
      ? `${Math.round(Number(replay.mfeTicks))} favorable ticks`
      : 'n/a favorable excursion';
    const maeLine = Number.isFinite(Number(replay?.maeTicks))
      ? `${Math.round(Number(replay.maeTicks))} adverse ticks`
      : 'n/a adverse excursion';
    if (alignment?.originalPlanEligible !== true) {
      const blocker = Array.isArray(alignment?.originalPlanBlockers) && alignment.originalPlanBlockers.length > 0
        ? alignment.originalPlanBlockers[0]
        : (toText(alignment?.skipReason) || 'original plan rules blocked the entry');
      return {
        stance: `Under your original trading plan, this would have been blocked on ${targetDate}.`,
        trigger: `The break was ${direction} off a ${rangeLine}, with about ${mfeLine} and ${maeLine}; blocker was ${blocker}.`,
        condition: 'If breakout, retest, and confirmation complete before your cutoff, then this becomes valid under your original plan.',
        details: [
          `Market outcome: ${toText(alignment?.marketOutcome) || 'unknown'}.`,
          `Original plan outcome: ${toText(alignment?.originalPlanOutcome) || 'no_trade'}.`,
          `Original plan blockers: ${(alignment?.originalPlanBlockers || []).join(' | ') || blocker}.`,
          `Overlay outcome: ${toText(alignment?.overlayOutcome) || 'n/a'} (${(alignment?.overlayBlockers || []).join(' | ') || 'none'}).`,
        ],
      };
    }

    if (alignment?.overlayEligible !== true) {
      const overlayBlocker = Array.isArray(alignment?.overlayBlockers) && alignment.overlayBlockers.length > 0
        ? alignment.overlayBlockers[0]
        : 'learned overlay blocked this setup';
      return {
        stance: `Under your original trading plan, this would have been valid and finished ${outcomeText}.`,
        trigger: `The break was ${direction} off a ${rangeLine}, with about ${mfeLine} and ${maeLine}; learned overlay downgraded it because ${overlayBlocker}.`,
        condition: `If ORB stays inside ${REPLAY_WORKABLE_ORB_MIN}-${REPLAY_WORKABLE_ORB_MAX} and day filter passes, then both original and overlay paths align.`,
        details: [
          `Market outcome: ${toText(alignment?.marketOutcome) || outcome}.`,
          `Original plan outcome: ${toText(alignment?.originalPlanOutcome) || outcome}.`,
          `Overlay outcome: ${toText(alignment?.overlayOutcome) || 'no_trade'}.`,
          `Overlay blockers: ${(alignment?.overlayBlockers || []).join(' | ') || overlayBlocker}.`,
        ],
      };
    }

    return {
      stance: `This would have been valid under your original plan on ${targetDate}, and finished ${outcomeText}.`,
      trigger: `The break was ${direction} off a ${rangeLine}, with about ${mfeLine} and ${maeLine}.`,
      condition: `If breakout, retest, and confirmation keep printing cleanly in-window, then this stays inside your original edge profile.`,
      details: [
        `Market outcome: ${toText(alignment?.marketOutcome) || outcome}.`,
        `Original plan outcome: ${toText(alignment?.originalPlanOutcome) || outcome}.`,
        `Overlay outcome: ${toText(alignment?.overlayOutcome) || outcome}.`,
        `Direction: ${direction}.`,
        `Entry: ${toText(replay?.entryTime)} @ ${Number.isFinite(Number(replay?.entryPrice)) ? Number(replay.entryPrice).toFixed(2) : 'n/a'}.`,
        `Exit: ${toText(replay?.exitTime)} @ ${Number.isFinite(Number(replay?.exitPrice)) ? Number(replay.exitPrice).toFixed(2) : 'n/a'} (${toText(replay?.exitReason) || 'unknown'}).`,
        `PnL ticks: ${Number.isFinite(Number(replay?.pnlTicks)) ? Math.round(Number(replay.pnlTicks)) : 'n/a'}.`,
      ],
    };
  }

  const noTradeReason = toText(alignment?.skipReason) || humanNoTradeReason(replay?.noTradeReason);
  const rangeText = Number.isFinite(Number(orb?.rangeTicks))
    ? `${Math.round(Number(orb.rangeTicks))} ticks`
    : 'not confirmed';
  return {
    stance: `This session is a strategy no-trade on ${targetDate}.`,
    trigger: `Market outcome was ${toText(alignment?.marketOutcome) || 'rangebound'} with ORB ${rangeText}; rules blocked entry because ${noTradeReason}.`,
    condition: `If breakout, retest, and confirmation complete inside ${REPLAY_WORKABLE_ORB_MIN}-${REPLAY_WORKABLE_ORB_MAX} ORB conditions, then it becomes eligible.`,
    details: [
      `Market outcome: ${toText(alignment?.marketOutcome) || 'unknown'}.`,
      `Strategy outcome: ${toText(alignment?.strategyOutcome) || 'no_trade'}.`,
      `Eligibility reasons: ${(alignment?.eligibilityReasons || []).join(' | ') || noTradeReason}.`,
      `ORB range: ${rangeText}.`,
    ],
  };
}

async function resolveReplaySessionCandles(ctx = {}, targetDate) {
  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const sessions = typeof deps.loadAllSessions === 'function' ? deps.loadAllSessions() : {};
  const normalizedSessions = sessions && typeof sessions === 'object' ? sessions : {};
  const fallbackDate = pickLatestSessionDate(normalizedSessions);
  const chosenDate = String(targetDate || fallbackDate || '').trim();
  const dbCandles = normalizeFiveMinuteCandles(normalizedSessions[chosenDate] || []);
  if (dbCandles.length > 0) {
    return {
      targetDate: chosenDate,
      source: 'db_5m',
      candles: dbCandles,
      sessions: normalizedSessions,
    };
  }

  const todayEt = toEtDate();
  if (chosenDate && chosenDate !== todayEt) {
    return {
      targetDate: chosenDate,
      source: 'none',
      candles: [],
      sessions: normalizedSessions,
      missingReason: 'requested date has no stored 5-minute candles',
    };
  }

  if (
    typeof deps.getLiveBarsSnapshot !== 'function'
    || typeof deps.topstepBarToSessionCandle !== 'function'
    || typeof deps.aggregateOneMinuteCandlesToFiveMinute !== 'function'
  ) {
    return {
      targetDate: chosenDate || todayEt,
      source: 'none',
      candles: [],
      sessions: normalizedSessions,
      missingReason: 'live bar dependencies are unavailable',
    };
  }

  const snapshot = await deps.getLiveBarsSnapshot({
    symbol: String(ctx.symbol || 'MNQ').toUpperCase(),
    lookbackMinutes: 420,
    unitNumber: 1,
    includePartialBar: true,
    forceFresh: false,
    triggerSource: 'jarvis_replay_tool',
  }).catch(() => null);

  const bars = Array.isArray(snapshot?.bars) ? snapshot.bars : [];
  if (!(snapshot?.ok) || bars.length === 0) {
    return {
      targetDate: chosenDate || todayEt,
      source: 'none',
      candles: [],
      sessions: normalizedSessions,
      missingReason: toText(snapshot?.error) || 'live bars are unavailable',
    };
  }

  const oneMinute = bars
    .map((bar) => deps.topstepBarToSessionCandle(bar))
    .filter((c) => c && normalizeDateFromCandle(c) === (chosenDate || todayEt));
  const fiveMinute = normalizeFiveMinuteCandles(
    deps.aggregateOneMinuteCandlesToFiveMinute(oneMinute)
  );
  if (!fiveMinute.length) {
    return {
      targetDate: chosenDate || todayEt,
      source: 'none',
      candles: [],
      sessions: normalizedSessions,
      missingReason: 'live bars returned no 5-minute candles for the requested session',
    };
  }
  return {
    targetDate: chosenDate || todayEt,
    source: 'topstep_live_1m',
    candles: fiveMinute,
    sessions: normalizedSessions,
  };
}

function buildReplayReceipt(ctx = {}, result = {}) {
  const alignment = result?.alignment && typeof result.alignment === 'object' ? result.alignment : {};
  const mechanics = result?.mechanics && typeof result.mechanics === 'object' ? result.mechanics : {};
  return {
    traceId: toText(ctx.traceId) || null,
    intent: toText(ctx.intent) || 'trading_hypothetical',
    tool: 'ReplayTool',
    consent: null,
    parameters: {
      message: toText(ctx.message),
      targetDate: toText(result?.targetDate),
      strategy: toText(ctx.strategy || 'original'),
      symbol: toText(ctx.symbol || 'MNQ'),
      assumptions: {
        originalPlan: { ...ORIGINAL_PLAN_DEFAULTS },
        learnedOverlay: {
          key: LEARNED_OVERLAY_DEFAULTS.key,
          name: LEARNED_OVERLAY_DEFAULTS.name,
          orbRange: { ...LEARNED_OVERLAY_DEFAULTS.orbRange },
          skipMonday: LEARNED_OVERLAY_DEFAULTS.skipMonday,
        },
      },
    },
    result: {
      executed: result?.available === true,
      source: toText(result?.source) || 'none',
      available: result?.available === true,
      missingReason: toText(result?.missingReason) || null,
      wouldTrade: result?.replay?.wouldTrade === true,
      outcome: toText(result?.replay?.result || (result?.replay?.wouldTrade === false ? 'no_trade' : 'unknown')),
      strategyEligible: alignment.originalPlanEligible === true,
      eligibilityReasons: Array.isArray(alignment.originalPlanBlockers) ? alignment.originalPlanBlockers : [],
      originalPlanEligible: alignment.originalPlanEligible === true,
      originalPlanBlockers: Array.isArray(alignment.originalPlanBlockers) ? alignment.originalPlanBlockers : [],
      originalPlanOutcome: toText(alignment.originalPlanOutcome) || null,
      overlayEligible: alignment.overlayEligible === true,
      overlayBlockers: Array.isArray(alignment.overlayBlockers) ? alignment.overlayBlockers : [],
      overlayOutcome: toText(alignment.overlayOutcome) || null,
      overlayAssessment: alignment.overlayAssessment || null,
      blockedByRangeFilter: alignment.blockedByRangeFilter === true,
      blockedByTimeWindow: alignment.blockedByTimeWindow === true,
      blockedByRetestRule: alignment.blockedByRetestRule === true,
      blockedByDirectionRule: alignment.blockedByDirectionRule === true,
      blockedByRiskRule: alignment.blockedByRiskRule === true,
      marketOutcome: toText(alignment.marketOutcome) || null,
      strategyOutcome: toText(alignment.strategyOutcome) || null,
      skipReason: toText(alignment.skipReason) || null,
      mechanicsVariants: Array.isArray(mechanics?.mechanicsVariants) ? mechanics.mechanicsVariants : [],
      originalPlanMechanicsVariant: mechanics?.originalPlanMechanicsVariant || null,
      bestMechanicsVariant: mechanics?.bestMechanicsVariant || null,
      mechanicsComparisonSummary: mechanics?.mechanicsComparisonSummary || null,
    },
    startedAt: ctx.startedAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

async function runReplayTool(ctx = {}) {
  const startedAt = new Date().toISOString();
  const message = toText(ctx.message);
  const strategy = String(ctx.strategy || 'original') === 'alt' ? 'alt' : 'original';
  const nowEtDate = toEtDate();
  const targetDateHint = parseTargetDateFromMessage(message, nowEtDate);
  const sessionData = await resolveReplaySessionCandles(ctx, targetDateHint);

  const base = {
    targetDate: sessionData?.targetDate || targetDateHint || nowEtDate,
    source: sessionData?.source || 'none',
    available: false,
    missingReason: sessionData?.missingReason || null,
    replay: null,
    orb: null,
  };

  if (!Array.isArray(sessionData?.candles) || sessionData.candles.length < 10) {
    const missingReason = base.missingReason || 'insufficient bars for replay';
    const finalOut = {
      ...base,
      available: false,
      missingReason,
      mechanics: {
        available: false,
        forcedSimulation: false,
        mechanicsVariants: [],
        originalPlanMechanicsVariant: null,
        bestMechanicsVariant: null,
        mechanicsComparisonSummary: {
          comparisonAvailable: false,
          forcedSimulation: false,
          summaryLine: 'Mechanics variants were not run because replay data was insufficient.',
          bestTpMode: null,
          originalTpMode: 'Skip 2',
          changedVsOriginal: false,
        },
      },
    };
    const narrative = buildReplayNarrative(finalOut);
    const receipt = buildReplayReceipt({
      ...ctx,
      strategy,
      startedAt,
    }, finalOut);
    return {
      ok: false,
      toolName: 'ReplayTool',
      data: {
        ...finalOut,
        receipt,
      },
      narrative,
      warnings: [missingReason],
      debug: {
        candleCount: Array.isArray(sessionData?.candles) ? sessionData.candles.length : 0,
      },
      metrics: {
        candleCount: Array.isArray(sessionData?.candles) ? sessionData.candles.length : 0,
      },
    };
  }

  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const processor = typeof deps.processSession === 'function'
    ? deps.processSession
    : null;
  if (!processor) {
    const finalOut = {
      ...base,
      available: false,
      missingReason: 'strategy processor unavailable',
      mechanics: {
        available: false,
        forcedSimulation: false,
        mechanicsVariants: [],
        originalPlanMechanicsVariant: null,
        bestMechanicsVariant: null,
        mechanicsComparisonSummary: {
          comparisonAvailable: false,
          forcedSimulation: false,
          summaryLine: 'Mechanics variants were not run because strategy processing was unavailable.',
          bestTpMode: null,
          originalTpMode: 'Skip 2',
          changedVsOriginal: false,
        },
      },
    };
    const narrative = buildReplayNarrative(finalOut);
    const receipt = buildReplayReceipt({
      ...ctx,
      strategy,
      startedAt,
    }, finalOut);
    return {
      ok: false,
      toolName: 'ReplayTool',
      data: {
        ...finalOut,
        receipt,
      },
      narrative,
      warnings: ['strategy processor unavailable'],
      debug: {},
      metrics: {
        candleCount: sessionData.candles.length,
      },
    };
  }

  const sessionResult = processor(sessionData.candles, { ...ORIGINAL_PLAN_DEFAULTS });
  const trade = sessionResult?.trade || null;
  const wouldTrade = !!trade;
  const excursion = trade ? computeExcursionTicks(trade, sessionData.candles) : { mfeTicks: null, maeTicks: null };
  const replay = wouldTrade
    ? {
      wouldTrade: true,
      result: toText(trade.result || 'unknown').toLowerCase() || 'unknown',
      direction: toText(trade.direction || '').toLowerCase() || 'unknown',
      entryPrice: Number(trade.entry_price),
      entryTime: toText(trade.entry_time),
      tpPrice: Number(trade.tp_price),
      slPrice: Number(trade.sl_price),
      exitPrice: Number(trade.exit_price),
      exitTime: toText(trade.exit_time),
      exitReason: toText(trade.exit_reason),
      pnlTicks: Number.isFinite(Number(trade.pnl_ticks)) ? Number(trade.pnl_ticks) : null,
      pnlDollars: Number.isFinite(Number(trade.pnl_dollars)) ? Number(trade.pnl_dollars) : null,
      breakoutTime: toText(trade.breakout_time),
      retestTime: toText(trade.retest_time),
      confirmationTime: toText(trade.confirmation_time),
      mfeTicks: excursion.mfeTicks,
      maeTicks: excursion.maeTicks,
    }
    : {
      wouldTrade: false,
      result: 'no_trade',
      noTradeReason: toText(sessionResult?.no_trade_reason) || 'no_trade',
    };

  const firstBreakDirection = findFirstBreakDirection(sessionData.candles, {
    high: sessionResult?.orb?.high,
    low: sessionResult?.orb?.low,
  });
  const alignment = deriveStrategyAlignment({
    targetDate: sessionData?.targetDate || base.targetDate,
    orb: {
      rangeTicks: Number.isFinite(Number(sessionResult?.orb?.range_ticks))
        ? Number(sessionResult.orb.range_ticks)
        : null,
    },
    replay,
    noTradeReason: toText(sessionResult?.no_trade_reason) || null,
    firstBreakDirection,
  });

  const mechanicsToolOut = runTradeMechanicsVariantTool({
    candles: sessionData.candles,
    trade,
    originalPlanEligible: alignment.originalPlanEligible === true,
  });
  const mechanicsData = mechanicsToolOut?.data && typeof mechanicsToolOut.data === 'object'
    ? mechanicsToolOut.data
    : {
      available: false,
      forcedSimulation: false,
      mechanicsVariants: [],
      originalPlanMechanicsVariant: null,
      bestMechanicsVariant: null,
      mechanicsComparisonSummary: {
        comparisonAvailable: false,
        forcedSimulation: false,
        summaryLine: 'Mechanics variants were not computed.',
        bestTpMode: null,
        originalTpMode: 'Skip 2',
        changedVsOriginal: false,
      },
    };

  const finalOut = {
    ...base,
    available: true,
    replay,
    orb: {
      high: Number(sessionResult?.orb?.high),
      low: Number(sessionResult?.orb?.low),
      rangeTicks: Number.isFinite(Number(sessionResult?.orb?.range_ticks))
        ? Number(sessionResult.orb.range_ticks)
        : null,
    },
    alignment,
    mechanics: mechanicsData,
  };
  const narrative = buildReplayNarrative(finalOut);
  const receipt = buildReplayReceipt({
    ...ctx,
    strategy,
    startedAt,
  }, finalOut);

  return {
    ok: true,
    toolName: 'ReplayTool',
    data: {
      ...finalOut,
      receipt,
    },
    narrative,
    warnings: Array.isArray(mechanicsToolOut?.warnings) ? mechanicsToolOut.warnings : [],
    debug: {
      sessionDate: finalOut.targetDate,
      source: finalOut.source,
      candleCount: sessionData.candles.length,
    },
    metrics: {
      candleCount: sessionData.candles.length,
      wouldTrade: replay.wouldTrade === true,
      orbRangeTicks: finalOut.orb?.rangeTicks ?? null,
    },
  };
}

module.exports = {
  runReplayTool,
};
