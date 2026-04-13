'use strict';

const { normalizeLocalSearchQuery, looksLikeLocalSearchQuery } = require('./query-normalizer');

const YES_ALIASES = new Set([
  'yes',
  'yeah',
  'yep',
  'go ahead',
  'do it',
  'run it',
  'run it now',
  'please',
  'sure',
  'confirm',
  'confirm it',
  'yes confirm',
  'yes run it',
]);

const NO_ALIASES = new Set([
  'no',
  'nope',
  'stop',
  "don't",
  'dont',
  'cancel',
  'never mind',
  'not now',
]);

const US_STATE_NAME_TO_ABBR = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
});

const US_STATE_ABBR_SET = new Set(Object.values(US_STATE_NAME_TO_ABBR));

const AMBIGUOUS_CITY_OPTIONS = Object.freeze({
  newark: ['NJ', 'DE'],
});

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConsentText(value) {
  return normalizeText(value)
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

function parseConsentReply(text) {
  const normalized = normalizeConsentText(text);
  if (!normalized) return null;
  if (YES_ALIASES.has(normalized)) return 'YES';
  if (NO_ALIASES.has(normalized)) return 'NO';
  return null;
}

function parseLocationConsentAction(text) {
  const normalized = normalizeConsentText(text);
  if (!normalized) return null;
  if (
    normalized === 'use my phone location'
    || normalized === 'use phone location'
    || normalized === 'use current location'
    || normalized === 'use my current location'
    || normalized === 'use location'
    || normalized === 'phone location'
    || normalized === 'current location'
  ) {
    return 'USE_PHONE';
  }
  if (
    normalized === 'use city'
    || normalized === 'use city instead'
    || normalized === 'use a city'
    || normalized === 'city instead'
    || normalized === 'specific city'
  ) {
    return 'USE_CITY';
  }
  return null;
}

function toTitleWord(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return raw
    .toLowerCase()
    .split(/([-'’])/)
    .map((part) => {
      if (!part || /[-'’]/.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join('');
}

function toTitleCity(cityText) {
  return String(cityText || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(toTitleWord)
    .join(' ');
}

function normalizeStateInput(stateText) {
  const raw = String(stateText || '').trim();
  if (!raw) return null;
  const compact = raw.toLowerCase().replace(/[.\s]+/g, ' ').trim();
  const abbrLike = compact.replace(/\s+/g, '');
  if (/^[a-z]{2}$/i.test(abbrLike)) {
    const up = abbrLike.toUpperCase();
    if (US_STATE_ABBR_SET.has(up)) return up;
  }
  if (Object.prototype.hasOwnProperty.call(US_STATE_NAME_TO_ABBR, compact)) {
    return US_STATE_NAME_TO_ABBR[compact];
  }
  return null;
}

function stripCityFillers(text) {
  let out = String(text || '').trim();
  if (!out) return '';
  out = out
    .replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  const prefixes = [
    /^(?:please\s+)?you\s+can\s+use\s+/i,
    /^(?:please\s+)?use\s+/i,
    /^(?:please\s+)?in\s+/i,
    /^(?:please\s+)?near\s+/i,
    /^(?:please\s+)?around\s+/i,
    /^(?:please\s+)?my city is\s+/i,
    /^(?:please\s+)?city is\s+/i,
    /^(?:please\s+)?just\s+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of prefixes) {
      if (re.test(out)) {
        out = out.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return out.trim();
}

function normalizeCityInput(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  const hasLocationLeadIn = /^(?:\s*(?:hey\s+)?jarvis[\s,:-]*)?(?:please\s+)?(?:you\s+can\s+use|use|in|near|around|my city is|city is|just)\b/i.test(raw);
  const stripped = stripCityFillers(raw);
  if (!stripped) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  if (parseConsentReply(stripped) || parseLocationConsentAction(stripped)) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  // City-only helper should not interpret generic search-like questions.
  if (/\b(nearest|nearby|closest|coffee|shop|weather|news|search|look up|google|find)\b/i.test(stripped)) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  if (/^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(stripped)) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  const strippedTokens = stripped.split(/\s+/).filter(Boolean);
  if (
    strippedTokens.length > 5
    || /\b(?:would|should|could|have|has|had|been|being|perfect|date)\b/i.test(stripped)
  ) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  let cityPart = stripped;
  let statePart = '';

  const commaMatch = stripped.match(/^(.+?),\s*([a-z][a-z.\s'-]*)$/i);
  if (commaMatch) {
    cityPart = String(commaMatch[1] || '').trim();
    statePart = String(commaMatch[2] || '').trim();
  } else {
    const tokens = stripped.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3) {
      const maybeTwoWordState = `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`;
      const normalizedTwoWordState = normalizeStateInput(maybeTwoWordState);
      if (normalizedTwoWordState) {
        statePart = maybeTwoWordState;
        cityPart = tokens.slice(0, -2).join(' ');
      }
    }
    if (!statePart && tokens.length >= 2) {
      const maybeOneWordState = tokens[tokens.length - 1];
      const normalizedOneWordState = normalizeStateInput(maybeOneWordState);
      if (normalizedOneWordState) {
        statePart = maybeOneWordState;
        cityPart = tokens.slice(0, -1).join(' ');
      }
    }
  }

  cityPart = String(cityPart || '').trim().replace(/\s+/g, ' ');
  const normalizedState = normalizeStateInput(statePart);
  const knownRegion = normalizeStateInput(options.knownRegion || options.region || options.defaultRegion || '');
  const cityTokenCount = cityPart.split(/\s+/).filter(Boolean).length;

  if (!cityPart) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  const normalizedCity = toTitleCity(cityPart);
  const cityKey = normalizedCity.toLowerCase();
  const ambiguousOptions = (!normalizedState && Object.prototype.hasOwnProperty.call(AMBIGUOUS_CITY_OPTIONS, cityKey))
    ? AMBIGUOUS_CITY_OPTIONS[cityKey]
    : [];

  // Reject arbitrary multi-word text during location pending unless it is explicitly
  // phrased as location input or includes state/comma disambiguation.
  if (
    !normalizedState
    && !commaMatch
    && cityTokenCount > 1
    && !hasLocationLeadIn
    && ambiguousOptions.length === 0
  ) {
    return {
      matched: false,
      locationHint: null,
      needsClarification: false,
      clarificationPrompt: null,
      city: null,
      state: null,
      options: [],
    };
  }

  let state = normalizedState || null;

  if (!state && knownRegion) {
    state = knownRegion;
  }

  if (!state && ambiguousOptions.length > 1) {
    const cityWithOptions = ambiguousOptions.map((abbr) => `${normalizedCity}, ${abbr}`).join(' or ');
    return {
      matched: true,
      locationHint: null,
      needsClarification: true,
      clarificationPrompt: `I can use ${normalizedCity}, but I need the state: ${cityWithOptions}?`,
      city: normalizedCity,
      state: null,
      options: ambiguousOptions.slice(),
    };
  }

  const finalState = state || (ambiguousOptions.length === 1 ? ambiguousOptions[0] : null);
  const canonicalCity = finalState ? `${normalizedCity}, ${finalState}` : normalizedCity;
  return {
    matched: true,
    locationHint: {
      lat: null,
      lon: null,
      city: canonicalCity,
      region: finalState || null,
      country: finalState ? 'US' : null,
    },
    needsClarification: false,
    clarificationPrompt: null,
    city: normalizedCity,
    state: finalState || null,
    options: [],
  };
}

function normalizeLocationHint(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  const city = String(value.city || '').trim();
  const region = String(value.region || '').trim();
  const country = String(value.country || '').trim();
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return {
      lat,
      lon,
      city: city || null,
      region: region || null,
      country: country || null,
    };
  }
  if (city) {
    return {
      lat: null,
      lon: null,
      city,
      region: region || null,
      country: country || null,
    };
  }
  return null;
}

function parseLocationHintFromText(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  const normalizedCity = normalizeCityInput(src);
  if (normalizedCity?.matched === true && normalizedCity?.needsClarification !== true && normalizedCity?.locationHint) {
    return normalizedCity.locationHint;
  }
  const normalized = normalizeConsentText(src);
  if (parseConsentReply(normalized) || parseLocationConsentAction(normalized)) {
    return null;
  }

  const coords = src.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (coords) {
    const lat = Number(coords[1]);
    const lon = Number(coords[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, city: null, region: null, country: null };
    }
  }

  const inPhrase = src.match(/\b(?:in|near|around)\s+([a-z][a-z\s.'-]{1,60})$/i);
  if (inPhrase) {
    const cityText = String(inPhrase[1] || '').trim();
    const lowered = normalizeConsentText(cityText);
    if (
      cityText
      && lowered !== 'me'
      && lowered !== 'my area'
      && lowered !== 'here'
      && lowered !== 'there'
    ) {
      return { lat: null, lon: null, city: cityText, region: null, country: null };
    }
  }

  const plainCity = src.match(/^([a-z][a-z\s.'-]{1,50}(?:,\s*[a-z]{2})?)$/i);
  if (plainCity) {
    const cityText = String(plainCity[1] || '').trim();
    const lowered = normalizeConsentText(cityText);
    const looksLikeQuery = /\b(nearest|nearby|near me|closest|coffee|shop|weather|news|search|google|look up|find)\b/i.test(cityText);
    const hasStateSuffix = /\b[a-z]{2}\b/i.test(cityText.split(/\s+/).slice(-1)[0] || '');
    const hasComma = cityText.includes(',');
    const tokenCount = cityText.split(/\s+/).filter(Boolean).length;
    if (!YES_ALIASES.has(lowered) && !NO_ALIASES.has(lowered)) {
      if (!looksLikeQuery && cityText.length <= 32 && (hasComma || hasStateSuffix || tokenCount === 1)) {
        return { lat: null, lon: null, city: cityText, region: null, country: null };
      }
    }
  }

  return null;
}

function parseWebLookupIntent(message, userLocationHint = null, options = {}) {
  const raw = String(message || '').trim();
  const text = normalizeText(raw);
  const normalizedIntentHint = String(options.intent || '').trim().toLowerCase();
  const forcedLocalSearch = normalizedIntentHint === 'local_search' || normalizedIntentHint === 'web_local_search';
  const localSearchPhrase = /\b(nearest|closest|nearby|near me|around here|around me|in my area|find\s+(?:a|an|the)?\s*[a-z0-9][a-z0-9\s.'-]{0,60}|where(?:'s| is)\s+(?:the\s+)?(?:nearest|closest)?\s*[a-z0-9][a-z0-9\s.'-]{0,60})\b/i.test(raw);
  const localSearch = forcedLocalSearch || localSearchPhrase || looksLikeLocalSearchQuery(raw);
  const locationFromText = parseLocationHintFromText(raw);
  const locationHint = locationFromText || normalizeLocationHint(userLocationHint);
  const normalizedLocal = normalizeLocalSearchQuery(raw);

  const locationRequired = localSearch || /\b(nearest|near me|nearby|closest|around me|around here|in my area|near)\b/.test(text);
  const likelyOfflineKnowledge = (
    !localSearch
    &&
    /^(who is|what is|define|explain|tell me about)\b/.test(text)
    && !/\b(latest|today|news|weather|nearest|nearby|near me|search|look up|google|where is)\b/.test(text)
  );

  let queryUsed = raw;
  const withPrefix = raw.match(/^(?:search(?: the web)? for|look up|google)\s+(.+)$/i);
  if (withPrefix && String(withPrefix[1] || '').trim()) {
    queryUsed = String(withPrefix[1] || '').trim();
  }
  if (localSearch) {
    queryUsed = String(normalizedLocal.entityQuery || normalizedLocal.normalizedQuery || queryUsed).trim();
  } else if (/^nearest\s+/i.test(queryUsed) && locationHint?.city) {
    queryUsed = `${queryUsed} in ${locationHint.city}`;
  }

  return {
    originalQuery: normalizedLocal.originalQuery || raw,
    normalizedQuery: normalizedLocal.normalizedQuery || queryUsed,
    brandOrTerm: normalizedLocal.brandOrTerm || null,
    categoryHint: normalizedLocal.categoryHint || null,
    queryUsed: String(queryUsed || '').trim(),
    localSearch,
    locationRequired,
    locationHint,
    likelyOfflineKnowledge,
  };
}

function createJarvisConsentManager(options = {}) {
  const ttlMs = Math.max(30_000, Number(options.ttlMs || 90_000));
  const recoveryWindowMs = Math.max(10_000, Number(options.recoveryWindowMs || 60_000));
  const stateStore = options.stateStore && typeof options.stateStore === 'object' ? options.stateStore : null;
  const store = new Map();
  const byClient = new Map();
  const CONSENT_STATE_TYPE = 'consent_pending';
  const useDurableStore = !!(stateStore && typeof stateStore.put === 'function');

  function removeClientIndex(clientId, sessionId) {
    if (useDurableStore) return;
    const cid = String(clientId || '').trim();
    const sid = String(sessionId || '').trim();
    if (!cid || !sid) return;
    const bucket = byClient.get(cid);
    if (!bucket) return;
    bucket.delete(sid);
    if (bucket.size <= 0) byClient.delete(cid);
  }

  function addClientIndex(clientId, sessionId) {
    if (useDurableStore) return;
    const cid = String(clientId || '').trim();
    const sid = String(sessionId || '').trim();
    if (!cid || !sid) return;
    if (!byClient.has(cid)) byClient.set(cid, new Set());
    byClient.get(cid).add(sid);
  }

  function getActiveRow(sessionId) {
    const sid = String(sessionId || '').trim() || 'jarvis_default';
    if (useDurableStore) {
      const raw = stateStore.get({
        stateType: CONSENT_STATE_TYPE,
        stateKey: sid,
        allowExpired: true,
      });
      if (!raw) return { state: null, expired: false };
      const now = Date.now();
      const expiresAt = Number(raw.expiresAtMs || 0);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && now >= expiresAt) {
        stateStore.remove({
          stateType: CONSENT_STATE_TYPE,
          stateKey: sid,
        });
        return { state: null, expired: true, last: raw };
      }
      const row = raw;
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const state = {
        pending: true,
        kind: String(payload.kind || '').trim() || 'web_search',
        requestedAt: Number(payload.requestedAt || row.updatedAtMs || Date.now()),
        expiresAt: Number(row.expiresAtMs || (Date.now() + ttlMs)),
        payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
        sessionId: String(payload.sessionId || sid).trim() || sid,
        clientId: String(payload.clientId || '').trim() || sid,
        sessionKey: String(payload.sessionKey || `jarvis:${sid}`).trim() || `jarvis:${sid}`,
      };
      return { state, expired: false };
    }
    const row = store.get(sid);
    if (!row) return { state: null, expired: false };
    if (Date.now() > Number(row.expiresAt || 0)) {
      store.delete(sid);
      removeClientIndex(row.clientId, sid);
      return { state: null, expired: true, last: row };
    }
    return { state: row, expired: false };
  }

  function listRecentByClient(clientId, options = {}) {
    const cid = String(clientId || '').trim();
    if (!cid) return [];
    if (useDurableStore) {
      const now = Date.now();
      const maxAgeMs = Math.max(5_000, Number(options.windowMs || recoveryWindowMs));
      const excludeSessionId = String(options.excludeSessionId || '').trim();
      const rows = stateStore.listByClient({
        stateType: CONSENT_STATE_TYPE,
        clientId: cid,
        excludeStateKey: excludeSessionId || '',
        minUpdatedAtMs: now - maxAgeMs,
        limit: 8,
      });
      return rows
        .map((row) => {
          const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
          return {
            pending: true,
            kind: String(payload.kind || '').trim() || 'web_search',
            requestedAt: Number(payload.requestedAt || row.updatedAtMs || 0) || 0,
            expiresAt: Number(row.expiresAtMs || 0) || 0,
            payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
            sessionId: String(payload.sessionId || row.stateKey || '').trim() || null,
            clientId: String(payload.clientId || cid).trim() || cid,
            sessionKey: String(payload.sessionKey || '').trim() || null,
          };
        })
        .filter((row) => row.sessionId && ((now - Number(row.requestedAt || 0)) <= maxAgeMs))
        .sort((a, b) => Number(b?.requestedAt || 0) - Number(a?.requestedAt || 0));
    }
    const maxAgeMs = Math.max(5_000, Number(options.windowMs || recoveryWindowMs));
    const now = Date.now();
    const out = [];
    const bucket = byClient.get(cid);
    if (!bucket || bucket.size <= 0) return out;
    const exclude = String(options.excludeSessionId || '').trim();
    for (const sid of bucket.values()) {
      if (!sid || sid === exclude) continue;
      const state = getActiveRow(sid).state;
      if (!state) continue;
      if ((now - Number(state.requestedAt || 0)) > maxAgeMs) continue;
      out.push(state);
    }
    out.sort((a, b) => Number(b?.requestedAt || 0) - Number(a?.requestedAt || 0));
    return out;
  }

  function recoverPending(sessionId, options = {}) {
    const clientId = String(options.clientId || '').trim();
    const candidates = listRecentByClient(clientId, {
      windowMs: options.recoveryWindowMs,
      excludeSessionId: sessionId,
    });
    if (candidates.length <= 0) {
      return { state: null, ambiguous: false, candidates: [] };
    }
    if (candidates.length > 1) {
      return {
        state: null,
        ambiguous: true,
        candidates: candidates.map((row) => ({
          kind: String(row.kind || '').trim() || null,
          sessionId: String(row.sessionId || '').trim() || null,
          clientId: String(row.clientId || '').trim() || null,
          sessionKey: String(row.sessionKey || '').trim() || null,
          requestedAt: Number(row.requestedAt || 0) || null,
          expiresAt: Number(row.expiresAt || 0) || null,
        })),
      };
    }
    const found = candidates[0];
    if (!found) return { state: null, ambiguous: false, candidates: [] };
    if (options.adopt === false) {
      return {
        state: found,
        ambiguous: false,
        recoveredFromSessionId: String(found.sessionId || '').trim() || null,
        candidates: [],
      };
    }
    const now = Date.now();
    const remainingMs = Math.max(10_000, Number(found.expiresAt || 0) - now);
    const adopted = setPending(
      sessionId,
      {
        kind: found.kind,
        payload: found.payload || {},
      },
      remainingMs,
      {
        clientId: String(found.clientId || clientId || '').trim() || null,
        sessionKey: String(options.sessionKey || found.sessionKey || '').trim() || null,
      }
    );
    return {
      state: adopted,
      ambiguous: false,
      recoveredFromSessionId: String(found.sessionId || '').trim() || null,
      candidates: [],
    };
  }

  function setPending(sessionId, payload = {}, overrideTtlMs = null, meta = null) {
    let ttlOverride = overrideTtlMs;
    let metaInfo = meta && typeof meta === 'object' ? meta : {};
    if (ttlOverride && typeof ttlOverride === 'object') {
      metaInfo = ttlOverride;
      ttlOverride = null;
    }
    const sid = String(sessionId || '').trim() || 'jarvis_default';
    const previous = store.get(sid);
    const clientId = String(metaInfo.clientId || previous?.clientId || sid).trim() || sid;
    const sessionKey = String(metaInfo.sessionKey || previous?.sessionKey || `jarvis:${sid}`).trim() || `jarvis:${sid}`;
    const now = Date.now();
    const effectiveTtl = Math.max(30_000, Number(ttlOverride || ttlMs));
    const row = {
      pending: true,
      kind: String(payload.kind || 'web_search').trim(),
      requestedAt: now,
      expiresAt: now + effectiveTtl,
      payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
      sessionId: sid,
      clientId,
      sessionKey,
    };
    if (useDurableStore) {
      stateStore.put({
        stateType: CONSENT_STATE_TYPE,
        stateKey: sid,
        sessionId: sid,
        clientId,
        sessionKey,
        ttlMs: effectiveTtl,
        payload: row,
      });
    } else {
      if (previous) removeClientIndex(previous.clientId, sid);
      store.set(sid, row);
      addClientIndex(clientId, sid);
    }
    return row;
  }

  function getPending(sessionId, options = {}) {
    const sid = String(sessionId || '').trim() || 'jarvis_default';
    const direct = getActiveRow(sid);
    const consume = options.consume !== false;
    if (
      process.env.JARVIS_TEST_FORCE_PENDING_EXPIRED === '1'
      && direct.state
      && consume
    ) {
      clear(sid);
      return {
        state: null,
        expired: true,
        last: direct.state,
        recoveredFromSessionId: null,
        ambiguousRecovery: false,
        recoveryCandidates: [],
      };
    }
    if (direct.state || direct.expired) return direct;
    if (options.allowRecovery !== true) {
      return {
        state: null,
        expired: false,
        recoveredFromSessionId: null,
        ambiguousRecovery: false,
        recoveryCandidates: [],
      };
    }
    const recovered = recoverPending(sid, {
      clientId: options.clientId,
      recoveryWindowMs: options.recoveryWindowMs,
      sessionKey: options.sessionKey,
      adopt: options.adopt !== false,
    });
    if (recovered.ambiguous) {
      return {
        state: null,
        expired: false,
        recoveredFromSessionId: null,
        ambiguousRecovery: true,
        recoveryCandidates: Array.isArray(recovered.candidates) ? recovered.candidates : [],
      };
    }
    return {
      state: recovered.state || null,
      expired: false,
      recoveredFromSessionId: recovered.recoveredFromSessionId || null,
      ambiguousRecovery: false,
      recoveryCandidates: [],
    };
  }

  function clear(sessionId) {
    const sid = String(sessionId || '').trim() || 'jarvis_default';
    if (useDurableStore) {
      stateStore.remove({
        stateType: CONSENT_STATE_TYPE,
        stateKey: sid,
      });
      return;
    }
    const row = store.get(sid);
    store.delete(sid);
    if (row) removeClientIndex(row.clientId, sid);
  }

  return {
    setPending,
    getPending,
    clear,
    listRecentByClient,
  };
}

module.exports = {
  createJarvisConsentManager,
  normalizeCityInput,
  normalizeLocationHint,
  parseConsentReply,
  parseLocationConsentAction,
  parseLocationHintFromText,
  parseWebLookupIntent,
};
