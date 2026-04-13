function toText(input) {
  return String(input == null ? '' : input).replace(/\s+/g, ' ').trim();
}

const ET_TZ = 'America/New_York';
const ORB_COMPLETE_ET_MIN = 9 * 60 + 45; // 09:45 ET
const MOMENTUM_CHECK_ET_MIN = 10 * 60 + 15; // 10:15 ET

function sentence(text) {
  const out = toText(text);
  if (!out) return '';
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

function parseClockToMinutes(raw) {
  const m = String(raw || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function resolveEtMinutes(snapshot = {}) {
  const candidates = [
    snapshot?.nowEtTime,
    snapshot?.nowEt?.time,
    snapshot?.marketDataFreshness?.nowEtTime,
    snapshot?.marketDataFreshness?.nowEt?.time,
  ];
  for (const c of candidates) {
    const mins = parseClockToMinutes(c);
    if (Number.isFinite(mins)) return mins;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TZ,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const hh = parts.find((p) => p.type === 'hour')?.value;
    const mm = parts.find((p) => p.type === 'minute')?.value;
    const mins = parseClockToMinutes(`${hh}:${mm}`);
    if (Number.isFinite(mins)) return mins;
  } catch {}
  return null;
}

function buildTimeAwareTrigger({ etMinutes, stale }) {
  if (!Number.isFinite(etMinutes)) {
    return stale
      ? "Let's focus on ORB context and the 10:15 momentum checkpoint, but we need live bars for a valid read."
      : "Let's focus on ORB context and the 10:15 momentum checkpoint.";
  }
  if (etMinutes < ORB_COMPLETE_ET_MIN) {
    return stale
      ? "Let's see how the 9:45 ORB prints, then check the 10:15 momentum checkpoint once live bars are flowing."
      : "Let's see how the 9:45 ORB prints, then check the 10:15 momentum setup.";
  }
  if (etMinutes < MOMENTUM_CHECK_ET_MIN) {
    return stale
      ? "Let's focus on the 10:15 momentum checkpoint, but we need live bars for that read."
      : "Let's focus on the 10:15 momentum checkpoint now that ORB context is set.";
  }
  return stale
    ? "Let's focus on the next momentum leg and ORB retest quality; live bars are required for that read."
    : "Let's focus on the next momentum leg and ORB retest quality from here.";
}

function extractRangeTicks(snapshot = {}, replyText = '') {
  const fromDecision = Number(snapshot?.decision?.orbRangeTicks);
  if (Number.isFinite(fromDecision)) return Math.round(fromDecision);
  const src = toText(replyText);
  const patterns = [
    /opening range is\s*([0-9,]+(?:\.\d+)?)\s*ticks?/i,
    /first 15-minute opening range is\s*([0-9,]+(?:\.\d+)?)\s*ticks?/i,
    /orb[^.]{0,20}\b([0-9,]+(?:\.\d+)?)\s*ticks?/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (!m) continue;
    const n = Number(String(m[1] || '').replace(/,/g, ''));
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

function extractTimes(replyText = '') {
  const src = String(replyText || '');
  const out = [];
  const seen = new Set();
  const re = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
  let m = re.exec(src);
  while (m) {
    const hh = String(m[1]).padStart(2, '0');
    const mm = String(m[2]).padStart(2, '0');
    const t = `${hh}:${mm}`;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    m = re.exec(src);
  }
  return out;
}

function extractBlockers(snapshot = {}, replyText = '') {
  const blockers = [];
  if (Array.isArray(snapshot?.decision?.blockers)) {
    for (const b of snapshot.decision.blockers) {
      const t = toText(b);
      if (t) blockers.push(t);
    }
  }
  const src = String(replyText || '');
  const m = src.match(/main blockers?\s*(?:right now)?\s*:\s*([^\n.]+)/i);
  if (m && m[1]) {
    for (const part of String(m[1]).split(/[,;|]/)) {
      const t = toText(part);
      if (t) blockers.push(t);
    }
  }
  return blockers;
}

function blockerSeverity(raw = '', rangeTicks = null) {
  const b = String(raw || '').toLowerCase();
  if (!b) {
    if (Number.isFinite(rangeTicks) && rangeTicks > 220) {
      return { score: 90, kind: 'range_too_big', reason: 'the opening range is too big and fakeout risk is elevated' };
    }
    if (Number.isFinite(rangeTicks) && rangeTicks < 70) {
      return { score: 72, kind: 'range_too_tight', reason: 'the opening range is too tight and can stay noisy' };
    }
    return { score: 40, kind: 'mixed', reason: 'structure is still mixed and not clean enough' };
  }
  if (/(stale|no fresh|fresh mnq bars|missing data|no bars)/i.test(b)) {
    return { score: 100, kind: 'stale_data', reason: "I don't have fresh MNQ bars yet" };
  }
  if (/(range_overextended|friday_volatility_exhaustion|range too wide|overextended|fakeout|too big)/i.test(b)) {
    return { score: 90, kind: 'range_too_big', reason: 'the opening range is too big and fakeout risk is elevated' };
  }
  if (/(news|lockout)/i.test(b)) {
    return { score: 85, kind: 'news_risk', reason: 'news risk is elevated right now' };
  }
  if (/topstep_/i.test(b)) {
    return { score: 80, kind: 'account_guard', reason: 'account safeguards are still blocking clean entries' };
  }
  if (/(outside your primary|entry window|window closed)/i.test(b)) {
    return { score: 74, kind: 'outside_entry_window', reason: 'the primary entry window is already closed' };
  }
  if (/(setup quality|below threshold|insufficient|weak edge)/i.test(b)) {
    return { score: 68, kind: 'weak_edge', reason: "today's structure quality is not clean enough" };
  }
  return { score: 55, kind: 'other', reason: toText(raw).toLowerCase() };
}

function pickPrimaryBlocker(snapshot = {}, replyText = '', rangeTicks = null) {
  const blockers = extractBlockers(snapshot, replyText);
  let best = blockerSeverity('', rangeTicks);
  for (const raw of blockers) {
    const scored = blockerSeverity(raw, rangeTicks);
    if (scored.score > best.score) best = scored;
  }
  return best;
}

function sanitizeEarbudOutput(text) {
  let out = String(text || '');
  out = out
    .replace(/\[(?:WAIT|TRADE|DON['’]T\s*TRADE|DONT\s*TRADE|DO\s*NOT\s*TRADE)\]/gi, '')
    .replace(/\bDON['’]T\s*TRADE\b/gi, 'sit out')
    .replace(/\bDO\s*NOT\s*TRADE\b/gi, 'sit out')
    .replace(/\bDONT\s*TRADE\b/gi, 'sit out')
    .replace(/\bWAIT:\s*/gi, '')
    .replace(/\bTRADE\b/gi, 'engage')
    .replace(/\bscore\b[^.]*\.?/gi, '')
    .replace(/\bconfidence\b[^.]*\.?/gi, '')
    .replace(/\bwin rate\b[^.]*\.?/gi, '')
    .replace(/[0-9]+(?:\.[0-9]+)?%/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}

function sentenceCount(text = '') {
  const m = String(text || '').match(/[.!?](?=\s|$)/g);
  return Array.isArray(m) ? m.length : 0;
}

function ensureTimeAnchor(text = '') {
  if (/\b(?:9:45|10:15|orb)\b/i.test(String(text || ''))) return text;
  const trimmed = String(text || '').trim();
  if (!trimmed) return trimmed;
  return `${trimmed} Let's re-check after 9:45 ET ORB completion.`;
}

function fitLength(text, maxLen = 420) {
  let out = String(text || '').trim();
  if (!out) return out;
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen - 1).trimEnd()}.`;
  }
  return out;
}

function resolvePositionState(snapshot = {}, replyText = '') {
  const state = snapshot?.positionState && typeof snapshot.positionState === 'object'
    ? snapshot.positionState
    : {};
  const qty = Number(state.qty);
  const openPositions = Number(state.openPositions ?? snapshot?.openPositions ?? 0);
  const hasByQty = Number.isFinite(qty) && Math.abs(qty) > 0;
  const hasOpenPosition = state.hasOpenPosition === true || hasByQty || (Number.isFinite(openPositions) && openPositions > 0);
  const sideRaw = String(state.side || '').trim().toLowerCase();
  const side = sideRaw === 'long' || sideRaw === 'short' ? sideRaw : null;
  const pnl = Number(state.unrealizedPnl);
  const unrealizedPnl = Number.isFinite(pnl) ? pnl : null;
  const volatilityExpanding = state.volatilityExpanding === true
    || /\b(volatility\s+(?:is\s+)?(?:high|expanding|elevated)|expanding volatility|high volatility)\b/i.test(String(replyText || ''));
  return {
    hasOpenPosition,
    side,
    unrealizedPnl,
    volatilityExpanding,
  };
}

function buildEarbudCoachBrief(snapshot = {}) {
  const replyText = String(snapshot?.replyText || snapshot?.text || '');
  const marketDataFreshness = snapshot?.marketDataFreshness || {};
  const hasTodayBars = marketDataFreshness?.hasTodaySessionBars === true;
  const staleByText = /don't have fresh mnq|do not have fresh mnq|no fresh mnq|stale|no bars/i.test(replyText);
  const stale = !hasTodayBars || staleByText;
  const rangeTicks = extractRangeTicks(snapshot, replyText);
  const primary = pickPrimaryBlocker(snapshot, replyText, rangeTicks);
  const etMinutes = resolveEtMinutes(snapshot);
  const tradableSignal = /\b(tradable|engage|green light|conditions look tradable)\b/i.test(replyText)
    || String(snapshot?.decision?.signal || '').toUpperCase() === 'GO';
  const position = resolvePositionState(snapshot, replyText);

  let stance = '';
  let trigger = '';
  let condition = '';

  if (position.hasOpenPosition) {
    if (position.side === 'long') {
      stance = "You're currently long.";
    } else if (position.side === 'short') {
      stance = "You're currently short.";
    } else {
      stance = "We're in a position here.";
    }

    if (position.volatilityExpanding) {
      trigger = "Let's reduce size if momentum stalls and keep the trail tight.";
    } else if (Number.isFinite(position.unrealizedPnl) && position.unrealizedPnl > 0) {
      trigger = position.side === 'short'
        ? "Let's protect it below the last lower high and trail above structure."
        : "Let's protect it above the last higher low and trail under structure.";
    } else {
      trigger = "Let's keep risk tight and avoid adding size until momentum firms up.";
    }

    condition = position.side === 'short'
      ? 'If momentum flips against us, we flatten.'
      : 'If we lose structure on a close, we step out.';
  } else if (stale) {
    stance = "I'd sit out for now because I don't have fresh MNQ bars yet.";
    trigger = buildTimeAwareTrigger({ etMinutes, stale: true });
    condition = 'If data sync is live and ORB is under 220 ticks with one clean retest, we can engage.';
  } else {
    if (Number.isFinite(rangeTicks) && rangeTicks > 220) {
      stance = "I'd sit out for now because the opening range is too big.";
    } else if (Number.isFinite(rangeTicks) && rangeTicks < 70) {
      stance = "I'd sit out for now because the opening range is too tight and early structure can stay noisy.";
    } else if (tradableSignal) {
      stance = "I'd engage selectively because ORB is inside your workable zone and structure is cleaner than average.";
    } else {
      stance = `I'd sit out for now because ${primary.reason}.`;
    }

    trigger = buildTimeAwareTrigger({ etMinutes, stale: false });

    if (primary.kind === 'range_too_big' || (Number.isFinite(rangeTicks) && rangeTicks > 220)) {
      condition = 'If we get compression under 220 ticks and one clean retest, we can engage.';
    } else if (primary.kind === 'outside_entry_window') {
      condition = "If we're inside the entry window and get one clean retest confirmation, we can engage.";
    } else if (primary.kind === 'range_too_tight' || (Number.isFinite(rangeTicks) && rangeTicks < 70)) {
      condition = 'If ORB expands into the 70 to 220 tick zone with one clean retest, we can engage.';
    } else {
      condition = 'If we get one clean ORB breakout and retest confirmation, we can engage.';
    }
  }

  let out = [sentence(stance), sentence(trigger), sentence(condition)]
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  out = sanitizeEarbudOutput(out);
  if (position.hasOpenPosition) {
    if (!/^(?:We're in a position here|You['’]re currently (?:long|short))\b/i.test(out)) {
      out = `We're in a position here. ${out}`.trim();
    }
  } else if (!/^I['’]d\b/i.test(out)) {
    out = `I'd sit out for now because structure is still mixed. ${out}`.trim();
  }
  if (!position.hasOpenPosition) out = ensureTimeAnchor(out);
  out = fitLength(out, 420);

  // Keep hard max of 3 sentences.
  if (sentenceCount(out) > 3) {
    const parts = String(out).split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
    out = parts.join(' ').trim();
    out = fitLength(out, 420);
  }
  return out;
}

module.exports = {
  buildEarbudCoachBrief,
};
