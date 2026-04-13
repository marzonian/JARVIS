function toNum(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, lo, hi, fallback) {
  const n = toNum(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function parseMinutes(hhmm, fallback = null) {
  const m = String(hhmm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mins = Math.max(0, Math.min(59, Number(m[2])));
  return (h * 60) + mins;
}

function normalizeVerdict(v) {
  const x = String(v || '').trim().toUpperCase();
  if (x === 'ALLOW' || x === 'WAIT' || x === 'BLOCK') return x;
  return 'ALLOW';
}

function isEarbudMode(options = {}) {
  const mode = String(options.voiceBriefMode || '').trim().toLowerCase();
  return mode === 'earbud' || mode === 'earpiece';
}

function sentenceCount(text = '') {
  const m = String(text || '').match(/[.!?](?=\s|$)/g);
  return Array.isArray(m) ? m.length : 0;
}

function fitThreeSentencesAndLen(text = '', maxLen = 420) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  if (!out) return out;
  const parts = out.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
  out = parts.join(' ').trim();
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 1).trimEnd()}.`;
  if (sentenceCount(out) > 3) {
    out = out.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3).join(' ').trim();
  }
  return out;
}

function appendEarbudExplainClause(text = '') {
  const clause = 'Say "explain" for details.';
  const src = String(text || '').trim();
  if (!src) return clause;
  if (src.includes(clause)) return fitThreeSentencesAndLen(src);
  const parts = src.split(/(?<=[.!?])\s+/).filter(Boolean);
  const limited = parts.slice(0, 2).join(' ').trim();
  return fitThreeSentencesAndLen(`${limited} ${clause}`.trim());
}

function buildRiskStateSnapshot(input = {}) {
  const nowEt = (input.nowEt && typeof input.nowEt === 'object')
    ? { date: String(input.nowEt.date || ''), time: String(input.nowEt.time || '') }
    : { date: String(input.sessionDateEt || ''), time: '' };
  const sessionDateEt = String(input.sessionDateEt || nowEt.date || '').trim() || null;

  const entryWindowStartEt = String(input.entryWindowStartEt || '09:30').trim() || '09:30';
  const entryWindowEndEt = String(input.entryWindowEndEt || '10:59').trim() || '10:59';
  const nowMins = parseMinutes(nowEt.time, null);
  const startMins = parseMinutes(entryWindowStartEt, 570);
  const endMins = parseMinutes(entryWindowEndEt, 659);
  const inEntryWindow = Number.isFinite(nowMins) ? (nowMins >= startMins && nowMins <= endMins) : false;

  const marketDataFreshness = input.marketDataFreshness && typeof input.marketDataFreshness === 'object'
    ? input.marketDataFreshness
    : {};
  const orbComplete = input.orbComplete === true || marketDataFreshness.hasORBComplete === true;

  const openPositionIn = input.openPosition && typeof input.openPosition === 'object' ? input.openPosition : {};
  const openQty = Math.abs(toNum(openPositionIn.qty, 0));
  const openPosition = {
    side: String(openPositionIn.side || '').trim().toLowerCase() || null,
    qty: Number.isFinite(openQty) ? openQty : 0,
    avgPrice: toNum(openPositionIn.avgPrice, null),
    unrealizedPnL: toNum(openPositionIn.unrealizedPnL, null),
  };
  const hasOpenPosition = input.hasOpenPosition === true || openPosition.qty > 0;

  const maxTradesPerDay = Math.max(1, clampInt(input.maxTradesPerDay, 1, 20, 1));
  const tradesTakenToday = Math.max(0, clampInt(input.tradesTakenToday, 0, 500, 0));
  const hasTradedToday = tradesTakenToday >= 1;

  const dailyLossLimit = Math.abs(toNum(input.dailyLossLimit, 500));
  const maxContracts = Math.max(1, clampInt(input.maxContracts, 1, 100, 1));
  const minDrawdownBufferDollars = Math.max(0, toNum(input.minDrawdownBufferDollars, 250));
  const lossCooldownEnabled = input.lossCooldownEnabled !== false;
  const lossCooldownMinutes = Math.max(1, clampInt(input.lossCooldownMinutes, 1, 240, 10));

  const balance = toNum(input.balance, null);
  const equity = toNum(input.equity, null);
  const unrealizedPnL = toNum(input.unrealizedPnL, openPosition.unrealizedPnL);
  const realizedPnLToday = toNum(input.realizedPnLToday, null);
  const dailyPnL = toNum(input.dailyPnL, null);
  const trailingDrawdownDistance = toNum(input.trailingDrawdownDistance, null);
  const lastRealizedTradePnL = toNum(input.lastRealizedTradePnL, null);
  const lastRealizedTradeTimeEt = String(input.lastRealizedTradeTimeEt || '').trim() || null;
  const cooldownRemainingMinutes = Math.max(0, clampInt(input.cooldownRemainingMinutes, 0, 240, 0));

  const blocked_oneTradePerDay = tradesTakenToday >= maxTradesPerDay;
  const blocked_outsideEntryWindow = !inEntryWindow;
  const blocked_dailyLossLimit = Number.isFinite(dailyPnL) && dailyPnL <= -dailyLossLimit;
  const blocked_trailingDrawdown = Number.isFinite(trailingDrawdownDistance) && trailingDrawdownDistance <= minDrawdownBufferDollars;
  const blocked_maxContracts = hasOpenPosition && Number.isFinite(openPosition.qty) && openPosition.qty >= maxContracts;
  const blocked_hasOpenPosition = hasOpenPosition && input.blockWhenOpenPosition !== false;
  const blocked_dataStale = input.blockedDataStale === true || input.readinessNeedsFreshData === true;
  const blocked_cooldown_after_loss = input.blockedCooldownAfterLoss === true || (
    lossCooldownEnabled
    && Number.isFinite(lastRealizedTradePnL)
    && lastRealizedTradePnL < 0
    && cooldownRemainingMinutes > 0
  );

  const reasons = [];
  const reasonCodes = [];
  const pushReason = (code, text) => {
    reasonCodes.push(code);
    reasons.push(String(text || code));
  };
  if (blocked_hasOpenPosition) pushReason('has_open_position', 'Open position already active');
  if (blocked_dailyLossLimit) pushReason('daily_loss_limit', 'Daily loss limit reached');
  if (blocked_trailingDrawdown) pushReason('trailing_drawdown', 'Too close to trailing drawdown limit');
  if (blocked_cooldown_after_loss) pushReason('cooldown_after_loss', 'Cooldown after realized loss is active');
  if (blocked_oneTradePerDay) pushReason('one_trade_per_day', 'Already traded today');
  if (blocked_outsideEntryWindow) pushReason('outside_entry_window', 'Outside entry window');
  if (blocked_maxContracts) pushReason('max_contracts', 'At max contract size');
  if (blocked_dataStale) pushReason('data_stale', 'Market data is stale');

  const hasHardBlock = (
    blocked_hasOpenPosition
    || blocked_dailyLossLimit
    || blocked_trailingDrawdown
    || blocked_cooldown_after_loss
    || blocked_oneTradePerDay
    || blocked_outsideEntryWindow
    || blocked_maxContracts
  );
  const riskVerdict = normalizeVerdict(
    hasHardBlock ? 'BLOCK' : (blocked_dataStale ? 'WAIT' : 'ALLOW')
  );

  const out = {
    nowEt,
    sessionDateEt,
    inEntryWindow,
    entryWindowStartEt,
    entryWindowEndEt,
    orbComplete,

    equity,
    balance,
    unrealizedPnL,
    realizedPnLToday,
    dailyPnL,

    openPosition,
    hasOpenPosition,

    tradesTakenToday,
    hasTradedToday,
    maxTradesPerDay,
    maxContracts,
    dailyLossLimit,
    minDrawdownBufferDollars,
    lossCooldownEnabled,
    lossCooldownMinutes,
    lastRealizedTradePnL,
    lastRealizedTradeTimeEt,
    cooldownRemainingMinutes,

    blocked_oneTradePerDay,
    blocked_outsideEntryWindow,
    blocked_dailyLossLimit,
    blocked_trailingDrawdown,
    blocked_cooldown_after_loss,
    blocked_maxContracts,
    blocked_hasOpenPosition,
    blocked_dataStale,

    riskVerdict,
    riskReasons: reasons,
    riskReasonCodes: reasonCodes,
    marketDataFreshness,
  };
  if (Number.isFinite(trailingDrawdownDistance)) out.trailingDrawdownDistance = trailingDrawdownDistance;
  if (Number.isFinite(toNum(input.maxDrawdownToday, null))) out.maxDrawdownToday = toNum(input.maxDrawdownToday, null);
  return out;
}

function pickPrimaryReasonCode(riskState = {}) {
  const arr = Array.isArray(riskState.riskReasonCodes) ? riskState.riskReasonCodes : [];
  if (arr.length > 0) return String(arr[0]);
  return 'unknown';
}

function buildEarbudBlockedReply(riskState = {}) {
  const code = pickPrimaryReasonCode(riskState);
  const tradesTakenToday = Math.max(0, Number(riskState.tradesTakenToday || 0));
  if (code === 'one_trade_per_day') {
    return appendEarbudExplainClause(fitThreeSentencesAndLen(
      `I'd sit out for now - that would be trade #${tradesTakenToday + 1} today. ` +
      "Let's protect discipline and wait for the next session. " +
      "If you want, ask for a post-trade review and I'll grade today's execution."
    ));
  }
  if (code === 'outside_entry_window') {
    return appendEarbudExplainClause(fitThreeSentencesAndLen(
      "I'd sit out for now - we're outside your entry window. " +
      "Let's wait for the next planned checkpoint. " +
      "If we're back inside the window with clean structure, we can engage."
    ));
  }
  if (code === 'daily_loss_limit' || code === 'trailing_drawdown') {
    return appendEarbudExplainClause(fitThreeSentencesAndLen(
      "I'd sit out - we're too close to the risk limit. " +
      'Protect the account and stop the bleeding. ' +
      'If risk resets tomorrow and structure is clean, we engage again.'
    ));
  }
  if (code === 'cooldown_after_loss') {
    const remaining = Math.max(1, Number(riskState.cooldownRemainingMinutes || 0));
    return appendEarbudExplainClause(fitThreeSentencesAndLen(
      "I'd sit out for now - you're in a cooldown after a loss. " +
      `Let's reset and protect discipline for ${remaining} more minute${remaining === 1 ? '' : 's'}. ` +
      'If structure is clean after the cooldown, we can re-check.'
    ));
  }
  if (code === 'has_open_position' || code === 'max_contracts') {
    return appendEarbudExplainClause(fitThreeSentencesAndLen(
      "We're already in a position. " +
      "Let's manage this trade, not add risk; if structure breaks, we flatten."
    ));
  }
  return appendEarbudExplainClause(fitThreeSentencesAndLen(
    "I'd sit out for now because risk controls are active. " +
    "Let's protect discipline and wait for cleaner conditions. " +
    'If guardrails clear and structure is clean, we can engage.'
  ));
}

function moneyLine(value) {
  const n = toNum(value, null);
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n).toFixed(2);
  return `${n < 0 ? '-' : ''}$${abs}`;
}

function buildFullBlockedReply(riskState = {}) {
  const code = pickPrimaryReasonCode(riskState);
  const reasonMap = {
    has_open_position: 'open position already active',
    daily_loss_limit: 'daily loss limit reached',
    trailing_drawdown: 'too close to trailing drawdown limit',
    cooldown_after_loss: 'cooldown after loss is active',
    one_trade_per_day: 'trade cap reached for today',
    outside_entry_window: 'outside entry window',
    max_contracts: 'max contract cap reached',
    data_stale: 'market data is stale',
  };
  const nextAllowedMap = {
    has_open_position: 'Next allowed condition: flatten the current position first.',
    max_contracts: 'Next allowed condition: reduce or flatten before adding risk.',
    daily_loss_limit: 'Next allowed condition: daily risk resets next session.',
    trailing_drawdown: 'Next allowed condition: drawdown buffer must recover above minimum.',
    cooldown_after_loss: 'Next allowed condition: cooldown timer expires and structure is still clean.',
    one_trade_per_day: 'Next allowed condition: next session reset.',
    outside_entry_window: 'Next allowed condition: back inside the 09:30-10:59 ET entry window.',
    data_stale: 'Next allowed condition: fresh bars are flowing again.',
  };
  const reason = reasonMap[code] || 'risk controls active';
  const lines = [
    `Blocked: ${reason}.`,
    `Trades taken today: ${Number(riskState.tradesTakenToday || 0)}/${Number(riskState.maxTradesPerDay || 1)}.`,
    `Entry window: ${riskState.inEntryWindow ? 'inside' : 'outside'} (${riskState.entryWindowStartEt || '09:30'}-${riskState.entryWindowEndEt || '10:59'} ET).`,
  ];
  if (Number.isFinite(toNum(riskState.dailyPnL, null))) {
    lines.push(`Daily PnL: ${moneyLine(riskState.dailyPnL)} vs limit -${moneyLine(Math.abs(Number(riskState.dailyLossLimit || 0))).replace(/^\+?/, '')}.`);
  }
  if (code === 'cooldown_after_loss') {
    const remaining = Math.max(0, Number(riskState.cooldownRemainingMinutes || 0));
    const at = String(riskState.lastRealizedTradeTimeEt || '').trim() || 'not available';
    lines.push(`Last realized loss: ${at}. Cooldown remaining: ${remaining} minute${remaining === 1 ? '' : 's'}.`);
  }
  if ((code === 'has_open_position' || code === 'max_contracts') && riskState?.openPosition) {
    const side = String(riskState.openPosition.side || '').toUpperCase() || 'UNKNOWN';
    const qty = Number(riskState.openPosition.qty || 0);
    const avg = toNum(riskState.openPosition.avgPrice, null);
    const upnl = toNum(riskState.openPosition.unrealizedPnL, null);
    const openLine = [
      `Open position: ${side} ${qty}.`,
      Number.isFinite(avg) ? `Avg price ${avg}.` : null,
      Number.isFinite(upnl) ? `Unrealized PnL ${moneyLine(upnl)}.` : null,
    ].filter(Boolean).join(' ');
    if (openLine) lines.push(openLine);
  }
  lines.push(nextAllowedMap[code] || 'Next allowed condition: guardrails clear.');
  if (code === 'has_open_position' || code === 'max_contracts') lines.push('Next action: Manage existing position.');
  else if (code === 'one_trade_per_day') lines.push("Next action: Review today's trade and wait for tomorrow.");
  else if (code === 'cooldown_after_loss') lines.push('Next action: wait out the cooldown, then re-check.');
  else lines.push('Next action: Wait for tomorrow or for guardrails to clear.');
  return lines.join('\n');
}

function buildAnalystRiskGuardrailReply(riskState = {}, options = {}) {
  if (isEarbudMode(options)) return buildEarbudBlockedReply(riskState);
  return buildFullBlockedReply(riskState);
}

function applyAnalystRiskWaitPrefix(reply = '', riskState = {}, options = {}) {
  if (normalizeVerdict(riskState?.riskVerdict) !== 'WAIT') return String(reply || '').trim();
  if (isEarbudMode(options)) return String(reply || '').trim();
  const prefix = "Conservative stance: data is stale right now, so stand down until fresh bars sync.";
  const base = String(reply || '').trim();
  if (!base) return prefix;
  if (base.toLowerCase().startsWith(prefix.toLowerCase())) return base;
  return `${prefix}\n${base}`.trim();
}

module.exports = {
  buildRiskStateSnapshot,
  buildAnalystRiskGuardrailReply,
  applyAnalystRiskWaitPrefix,
};
