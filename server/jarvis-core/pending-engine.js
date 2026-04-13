'use strict';

const { parseConsentReply } = require('./consent');

const DEFAULT_RECOVERY_WINDOW_MS = 60 * 1000;
const DEFAULT_GENERAL_TTL_MS = 10 * 60 * 1000;

const SELECTION_INTENT_RE = /\b(the\s+first\s+one|the\s+second\s+one|the\s+third\s+one|option\s+\d+|option\s+(one|two|three|four|five)|first\s+one|second\s+one|third\s+one|pick\s+\d+|choose\s+\d+|number\s+\d+|directions|take me there|route me there|open directions|that one|this one)\b/i;
const SWITCH_TOPIC_RE = /\b(switch topics?|change topic|switch|something else|move on|new topic|forget that|skip that)\b/i;
const CONTINUE_RE = /\b(continue|resume|go back|keep going|finish that|continue that)\b/i;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSelectionLabel(value) {
  return normalizeText(value);
}

function parseOrdinalIndex(message) {
  const text = normalizeText(message);
  if (!text) return null;
  if (/\b(first|1st|one|1)\b/.test(text)) return 0;
  if (/\b(second|2nd|two|2)\b/.test(text)) return 1;
  if (/\b(third|3rd|three|3)\b/.test(text)) return 2;
  if (/\b(fourth|4th|four|4)\b/.test(text)) return 3;
  if (/\b(fifth|5th|five|5)\b/.test(text)) return 4;
  const leading = text.match(/^(\d+)\b/);
  if (!leading) return null;
  const asNumber = Number(leading[1]);
  if (!Number.isFinite(asNumber) || asNumber < 1 || asNumber > 50) return null;
  return asNumber - 1;
}

function isSelectionIntentText(message) {
  return SELECTION_INTENT_RE.test(String(message || ''));
}

function isSwitchTopicPhrase(message) {
  return SWITCH_TOPIC_RE.test(String(message || ''));
}

function isContinuePendingPhrase(message) {
  return CONTINUE_RE.test(String(message || ''));
}

function buildPendingActionLabel(kind) {
  const key = String(kind || '').trim().toLowerCase();
  if (key === 'location') return 'a location confirmation';
  if (key === 'web_search') return 'a web lookup confirmation';
  if (key === 'web_directions_select') return 'a result selection';
  if (key === 'web_directions_confirm') return 'a directions confirmation';
  if (key === 'trade_execution') return 'a trade execution confirmation';
  if (key === 'os_action') return 'an OS action confirmation';
  if (key === 'memory_update') return 'a memory preference update';
  return 'a pending action';
}

function buildAwaitReply(kind) {
  const key = String(kind || '').trim().toLowerCase();
  if (key === 'location') return 'To continue, say "use my phone location" or tell me a specific city. Say "switch topics" to drop it.';
  if (key === 'web_search') return 'To continue, say "yes" to run the lookup or "no" to cancel. Say "switch topics" to move on.';
  if (key === 'web_directions_select') return 'To continue, say "the first one" or the exact place name. Say "switch topics" to move on.';
  if (key === 'web_directions_confirm') return 'To continue, say "yes" to open directions or "no" to skip. Say "switch topics" to move on.';
  if (key === 'trade_execution' || key === 'os_action' || key === 'memory_update') {
    return 'To continue, say "yes" to confirm or "no" to cancel. Say "switch topics" to move on.';
  }
  return 'To continue, say "yes" or "no", or say "switch topics".';
}

function pickSelection(message, sources = []) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!list.length) {
    return {
      selected: null,
      index: null,
      matcher: null,
      attemptedSelection: false,
      inputType: 'none',
    };
  }
  const text = normalizeText(message);
  if (!text) {
    return {
      selected: null,
      index: null,
      matcher: null,
      attemptedSelection: false,
      inputType: 'none',
    };
  }
  const ordinal = parseOrdinalIndex(text);
  const attemptedSelection = isSelectionIntentText(text) || Number.isInteger(ordinal);
  if (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < list.length && (attemptedSelection || /^\d+$/.test(text))) {
    return {
      selected: list[ordinal],
      index: ordinal,
      matcher: 'selection:ordinal',
      attemptedSelection: true,
      inputType: 'selection',
    };
  }
  for (let i = 0; i < list.length; i += 1) {
    const title = normalizeSelectionLabel(list[i]?.title || '');
    if (!title) continue;
    if (
      text === title
      || text === `that ${title}`
      || text === `to ${title}`
      || text === `directions to ${title}`
      || text === `take me to ${title}`
    ) {
      return {
        selected: list[i],
        index: i,
        matcher: 'selection:exact_name',
        attemptedSelection: true,
        inputType: 'selection',
      };
    }
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3 && words.some((w) => w.length >= 4)) {
    const candidates = [];
    for (let i = 0; i < list.length; i += 1) {
      const title = normalizeSelectionLabel(list[i]?.title || '');
      if (!title) continue;
      const titleWords = new Set(title.split(/\s+/).filter(Boolean));
      if (words.every((w) => titleWords.has(w))) candidates.push(i);
    }
    if (candidates.length === 1) {
      const idx = candidates[0];
      return {
        selected: list[idx],
        index: idx,
        matcher: 'selection:unique_title_token',
        attemptedSelection: true,
        inputType: 'selection',
      };
    }
  }
  if (list.length === 1 && /\b(directions|take me there|route me there|open directions|that one|this one)\b/i.test(text)) {
    return {
      selected: list[0],
      index: 0,
      matcher: 'selection:single_result',
      attemptedSelection: true,
      inputType: 'selection',
    };
  }
  return {
    selected: null,
    index: null,
    matcher: null,
    attemptedSelection,
    inputType: attemptedSelection ? 'selection' : 'other',
  };
}

function parsePendingInput(message) {
  const text = String(message || '');
  const confirmation = parseConsentReply(text);
  return {
    confirmation,
    isConfirm: confirmation === 'YES',
    isCancel: confirmation === 'NO',
    isSwitchTopic: isSwitchTopicPhrase(text),
    isContinuePending: isContinuePendingPhrase(text),
    isSelectionIntent: isSelectionIntentText(text),
    ordinalIndex: parseOrdinalIndex(text),
    normalizedText: normalizeText(text),
  };
}

function createGeneralPendingStore(ttlMs = DEFAULT_GENERAL_TTL_MS) {
  let effectiveTtlMs = ttlMs;
  let persistence = null;
  if (ttlMs && typeof ttlMs === 'object') {
    effectiveTtlMs = Number(ttlMs.ttlMs || DEFAULT_GENERAL_TTL_MS);
    persistence = ttlMs.persistence && typeof ttlMs.persistence === 'object' ? ttlMs.persistence : null;
  }
  const stateType = 'general_pending';
  const useDurable = !!(persistence && typeof persistence.put === 'function');
  const store = new Map();
  function cleanup(sessionId) {
    const sid = String(sessionId || '').trim() || 'jarvis_default';
    if (useDurable) {
      const row = persistence.get({
        stateType,
        stateKey: sid,
      });
      if (!row) return null;
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      return {
        ...payload,
        sessionId: String(payload.sessionId || sid).trim() || sid,
        createdAt: Number(payload.createdAt || row.createdAtMs || 0) || 0,
        expiresAt: Number(payload.expiresAt || row.expiresAtMs || 0) || 0,
      };
    }
    const row = store.get(sid);
    if (!row) return null;
    if (Date.now() > Number(row.expiresAt || 0)) {
      store.delete(sid);
      return null;
    }
    return row;
  }
  return {
    get(sessionId) {
      return cleanup(sessionId);
    },
    set(sessionId, item = {}, overrideTtlMs = null) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      const now = Date.now();
      const effectiveTtl = Math.max(30_000, Number(overrideTtlMs || effectiveTtlMs || DEFAULT_GENERAL_TTL_MS));
      const row = {
        ...item,
        sessionId: sid,
        createdAt: now,
        expiresAt: now + effectiveTtl,
      };
      if (useDurable) {
        persistence.put({
          stateType,
          stateKey: sid,
          sessionId: sid,
          clientId: String(item.clientId || '').trim() || null,
          sessionKey: String(item.sessionKey || '').trim() || null,
          ttlMs: effectiveTtl,
          payload: row,
        });
      } else {
        store.set(sid, row);
      }
      return row;
    },
    clear(sessionId) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      if (useDurable) {
        persistence.remove({
          stateType,
          stateKey: sid,
        });
      } else {
        store.delete(sid);
      }
    },
  };
}

function createJarvisPendingEngine(options = {}) {
  const consentManager = options.consentManager || null;
  const recoveryWindowMs = Math.max(10_000, Number(options.recoveryWindowMs || DEFAULT_RECOVERY_WINDOW_MS));
  const generalStore = options.generalStore || createGeneralPendingStore(options.generalTtlMs);

  function getConsentPending(sessionId, input = {}) {
    if (!consentManager || typeof consentManager.getPending !== 'function') {
      return {
        state: null,
        expired: false,
        recoveredFromSessionId: null,
        ambiguousRecovery: false,
        recoveryCandidates: [],
      };
    }
    const parsed = parsePendingInput(input.message || '');
    return consentManager.getPending(sessionId, {
      allowRecovery: parsed.isConfirm || parsed.isCancel,
      clientId: input.clientId,
      sessionKey: input.sessionKey,
      recoveryWindowMs: Number(input.recoveryWindowMs || recoveryWindowMs),
      adopt: input.adopt !== false,
      consume: input.consume !== false,
    });
  }

  function setConsentPending(sessionId, payload, ttlMs = null, meta = {}) {
    if (!consentManager || typeof consentManager.setPending !== 'function') return null;
    return consentManager.setPending(sessionId, payload, ttlMs, meta);
  }

  function clearConsentPending(sessionId) {
    if (!consentManager || typeof consentManager.clear !== 'function') return;
    consentManager.clear(sessionId);
  }

  function shouldTopicShiftGuard(message, options = {}) {
    const parsed = parsePendingInput(message);
    if (parsed.isConfirm || parsed.isCancel || parsed.isSwitchTopic || parsed.isContinuePending) return false;
    if (options.allowSelection && parsed.isSelectionIntent) return false;
    return true;
  }

  function getGeneralPending(sessionId) {
    return generalStore.get(sessionId);
  }

  function setGeneralPending(sessionId, item, ttlMs = null) {
    return generalStore.set(sessionId, item, ttlMs);
  }

  function clearGeneralPending(sessionId) {
    generalStore.clear(sessionId);
  }

  return {
    parsePendingInput,
    pickSelection,
    shouldTopicShiftGuard,
    buildPendingActionLabel,
    buildAwaitReply,
    getConsentPending,
    setConsentPending,
    clearConsentPending,
    getGeneralPending,
    setGeneralPending,
    clearGeneralPending,
  };
}

module.exports = {
  DEFAULT_RECOVERY_WINDOW_MS,
  createJarvisPendingEngine,
  createGeneralPendingStore,
  parsePendingInput,
  pickSelection,
  buildPendingActionLabel,
  buildAwaitReply,
};
