'use strict';

const FAST_WINDOW_START_ET_MIN = 8 * 60 + 20; // 08:20 ET
const FAST_WINDOW_END_ET_MIN = 12 * 60; // 12:00 ET
const ENTRY_WINDOW_START_ET_MIN = 9 * 60 + 30; // 09:30 ET
const ENTRY_WINDOW_END_ET_MIN = 10 * 60 + 59; // 10:59 ET
const ORB_COMPLETE_ET_MIN = 9 * 60 + 45; // 09:45 ET
const MOMENTUM_CHECK_ET_MIN = 10 * 60 + 15; // 10:15 ET

function parseEtMinutes(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Number(input);
  const text = String(input == null ? '' : input).trim();
  if (!text) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const asNum = Number(text);
    if (Number.isFinite(asNum)) return asNum;
  }
  const hhmm = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!hhmm) return null;
  return (Number(hhmm[1]) * 60) + Number(hhmm[2]);
}

function normalizeSessionKey(input = {}) {
  const explicit = String(input.sessionKey || '').trim();
  if (explicit) {
    return explicit.startsWith('jarvis:') ? explicit : `jarvis:${explicit}`;
  }
  const sid = String(input.sessionId || input.clientId || '').trim();
  if (!sid) return null;
  return sid.startsWith('jarvis:') ? sid : `jarvis:${sid}`;
}

function resolveVoiceTradingTimePhase(input = {}) {
  const etMinutes = parseEtMinutes(input.etMinutes ?? input.nowEtTime ?? input.nowEt);
  if (!Number.isFinite(etMinutes)) {
    return {
      etMinutes: null,
      inEntryWindow: false,
      timePhase: 'postWindow',
    };
  }
  const inEntryWindow = etMinutes >= ENTRY_WINDOW_START_ET_MIN && etMinutes <= ENTRY_WINDOW_END_ET_MIN;
  let timePhase = 'postWindow';
  if (etMinutes < ORB_COMPLETE_ET_MIN) timePhase = 'preORB';
  else if (etMinutes < MOMENTUM_CHECK_ET_MIN) timePhase = 'orbSet';
  else if (etMinutes <= ENTRY_WINDOW_END_ET_MIN) timePhase = 'momentum';
  else timePhase = 'postWindow';
  return {
    etMinutes,
    inEntryWindow,
    timePhase,
  };
}

function resolveVoiceHealthPollIntervalMs(input = {}) {
  const etMinutes = parseEtMinutes(input.etMinutes ?? input.nowEtTime ?? input.nowEt);
  if (!Number.isFinite(etMinutes)) return 60_000;
  if (etMinutes >= FAST_WINDOW_START_ET_MIN && etMinutes < FAST_WINDOW_END_ET_MIN) return 15_000;
  return 60_000;
}

function defaultNowEtProvider() {
  try {
    const raw = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const d = new Date(raw);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return {
      date: `${yyyy}-${mon}-${day}`,
      time: `${hh}:${mm}:${ss}`,
    };
  } catch {
    return {
      date: '',
      time: '',
    };
  }
}

function buildSyntheticStaleSnapshot(nowEt, reason) {
  const date = String(nowEt?.date || '').trim();
  const time = String(nowEt?.time || '').trim();
  return {
    now_et: `${date} ${time} ET`.trim(),
    contractId_in_use: null,
    contract_roll_status: 'STALE',
    selected_contract_reason: null,
    topstep_bars: {
      ok: false,
      bars_returned: 0,
      last_bar_ts_utc: null,
      last_bar_ts_et: null,
      minutes_since_last_bar: null,
      last_close: null,
    },
    db_persist: {
      sessions_last_date: null,
      candles_1m_last_ts: null,
      candles_5m_last_ts: null,
      minutes_since_db_last_candle: null,
    },
    orb_state: {
      hasORBComplete: false,
      orbWindow: '09:30-09:45 ET',
      orbBarsRequired: 3,
    },
    status: 'STALE',
    reason: String(reason || 'voice_session_health_unavailable').trim() || 'voice_session_health_unavailable',
  };
}

function buildSnapshotFromAuditMock(auditMock = {}, nowEtProvider = defaultNowEtProvider) {
  const nowEt = (auditMock.nowEt && typeof auditMock.nowEt === 'object')
    ? {
      date: String(auditMock.nowEt.date || nowEtProvider().date || '').slice(0, 10),
      time: String(auditMock.nowEt.time || nowEtProvider().time || '').slice(0, 8),
    }
    : nowEtProvider();
  const status = String(auditMock.healthStatus || 'OK').trim().toUpperCase() || 'OK';
  const blocked = status === 'DEGRADED' || status === 'STALE';
  const reason = String(auditMock.healthReason || (blocked ? 'audit_mock_health_block' : 'audit_mock_health_ok')).trim();
  const riskInputs = (auditMock.riskInputs && typeof auditMock.riskInputs === 'object') ? auditMock.riskInputs : {};
  const freshness = (riskInputs.marketDataFreshness && typeof riskInputs.marketDataFreshness === 'object')
    ? riskInputs.marketDataFreshness
    : {};
  const hasTodaySessionBars = freshness.hasTodaySessionBars !== false && !blocked;
  const minutesSinceLast = Number(freshness.minutesSinceLastCandle);
  return {
    now_et: `${nowEt.date} ${nowEt.time} ET`,
    contractId_in_use: String(auditMock.contractIdInUse || 'MNQ-MOCK').trim(),
    contract_roll_status: 'OK',
    selected_contract_reason: 'audit_mock',
    topstep_bars: {
      ok: !blocked,
      bars_returned: hasTodaySessionBars ? Number(freshness.barsReturned || 120) : 0,
      last_bar_ts_utc: null,
      last_bar_ts_et: hasTodaySessionBars ? `${nowEt.date} ${nowEt.time} ET` : null,
      minutes_since_last_bar: Number.isFinite(minutesSinceLast) ? minutesSinceLast : (hasTodaySessionBars ? 1 : 9),
      last_close: Number(auditMock.lastClose || 25000),
    },
    db_persist: {
      sessions_last_date: String(freshness.sessionDateOfData || nowEt.date || '').trim() || null,
      candles_1m_last_ts: null,
      candles_5m_last_ts: null,
      minutes_since_db_last_candle: Number.isFinite(minutesSinceLast) ? minutesSinceLast : (hasTodaySessionBars ? 1 : 9),
    },
    orb_state: {
      hasORBComplete: freshness.hasORBComplete === true,
      orbWindow: '09:30-09:45 ET',
      orbBarsRequired: 3,
    },
    status,
    reason: reason || (blocked ? 'audit_mock_health_block' : 'audit_mock_health_ok'),
  };
}

function createVoiceTradingSessionManager(options = {}) {
  const fetchHealthSnapshot = typeof options.fetchHealthSnapshot === 'function'
    ? options.fetchHealthSnapshot
    : (async () => null);
  const nowEtProvider = typeof options.nowEtProvider === 'function'
    ? options.nowEtProvider
    : defaultNowEtProvider;
  const activeTtlMs = Math.max(60_000, Number(options.activeTtlMs || (12 * 60 * 1000)));
  const maxBackoffMs = Math.max(60_000, Number(options.maxBackoffMs || (5 * 60 * 1000)));
  const maxSessions = Math.max(16, Number(options.maxSessions || 250));
  const healthFetchTimeoutMs = Math.max(1_500, Number(options.healthFetchTimeoutMs || 7_000));
  const enableBackgroundPolling = options.enableBackgroundPolling !== false;
  const stateStore = options.stateStore && typeof options.stateStore === 'object' ? options.stateStore : null;
  const useDurableStore = !!(stateStore && typeof stateStore.put === 'function');
  const VOICE_SESSION_STATE_TYPE = 'voice_session';
  const sessions = new Map();

  function persistState(state) {
    if (!useDurableStore || !state || !state.sessionKey) return;
    const now = Date.now();
    const expiresAtMs = now + Math.max(activeTtlMs * 2, 120_000);
    stateStore.put({
      stateType: VOICE_SESSION_STATE_TYPE,
      stateKey: state.sessionKey,
      sessionId: state.sessionId || null,
      clientId: state.clientId || null,
      sessionKey: state.sessionKey,
      expiresAtMs,
      payload: {
        sessionKey: state.sessionKey,
        sessionId: state.sessionId || null,
        clientId: state.clientId || null,
        symbol: state.symbol || 'MNQ',
        active: state.active === true,
        lastSeenAtMs: Number(state.lastSeenAtMs || 0) || now,
        lastHealthSnapshot: state.lastHealthSnapshot || null,
        lastHealthFetchedAtMs: Number(state.lastHealthFetchedAtMs || 0) || 0,
        lastHealthAgeSeconds: Number.isFinite(Number(state.lastHealthAgeSeconds)) ? Number(state.lastHealthAgeSeconds) : null,
        healthStatusUsed: state.healthStatusUsed || null,
        timePhase: state.timePhase || 'postWindow',
        etMinutes: Number.isFinite(Number(state.etMinutes)) ? Number(state.etMinutes) : null,
        inEntryWindow: state.inEntryWindow === true,
        pollIntervalMs: Number.isFinite(Number(state.pollIntervalMs)) ? Number(state.pollIntervalMs) : 60_000,
        pollFailureCount: Number(state.pollFailureCount || 0) || 0,
        lastError: state.lastError || null,
        nextPollAtMs: Number.isFinite(Number(state.nextPollAtMs)) ? Number(state.nextPollAtMs) : null,
      },
    });
  }

  function loadDurableState(sessionKey) {
    if (!useDurableStore || !sessionKey) return null;
    const row = stateStore.get({
      stateType: VOICE_SESSION_STATE_TYPE,
      stateKey: sessionKey,
    });
    if (!row || !row.payload || typeof row.payload !== 'object') return null;
    const payload = row.payload;
    return {
      sessionKey,
      sessionId: String(payload.sessionId || '').trim() || null,
      clientId: String(payload.clientId || '').trim() || null,
      symbol: String(payload.symbol || 'MNQ').trim().toUpperCase() || 'MNQ',
      active: payload.active === true,
      lastSeenAtMs: Number(payload.lastSeenAtMs || 0) || Date.now(),
      lastHealthSnapshot: payload.lastHealthSnapshot && typeof payload.lastHealthSnapshot === 'object'
        ? payload.lastHealthSnapshot
        : null,
      lastHealthFetchedAtMs: Number(payload.lastHealthFetchedAtMs || 0) || 0,
      lastHealthAgeSeconds: Number.isFinite(Number(payload.lastHealthAgeSeconds)) ? Number(payload.lastHealthAgeSeconds) : null,
      healthStatusUsed: String(payload.healthStatusUsed || '').trim() || null,
      timePhase: String(payload.timePhase || '').trim() || 'postWindow',
      etMinutes: Number.isFinite(Number(payload.etMinutes)) ? Number(payload.etMinutes) : null,
      inEntryWindow: payload.inEntryWindow === true,
      pollIntervalMs: Number.isFinite(Number(payload.pollIntervalMs)) ? Number(payload.pollIntervalMs) : 60_000,
      pollFailureCount: Number(payload.pollFailureCount || 0) || 0,
      lastError: String(payload.lastError || '').trim() || null,
      nextPollAtMs: Number.isFinite(Number(payload.nextPollAtMs)) ? Number(payload.nextPollAtMs) : null,
      timer: null,
      inFlightPromise: null,
    };
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [key, state] of sessions.entries()) {
      if (!state) {
        sessions.delete(key);
        continue;
      }
      const lastSeen = Number(state.lastSeenAtMs || 0);
      if (!Number.isFinite(lastSeen) || lastSeen <= 0) continue;
      const active = state.active === true && (now - lastSeen) <= activeTtlMs;
      if (!active && (now - lastSeen) > (activeTtlMs * 2)) {
        if (state.timer) clearTimeout(state.timer);
        sessions.delete(key);
      }
    }
    if (sessions.size <= maxSessions) return;
    const rows = Array.from(sessions.values())
      .sort((a, b) => Number(a.lastSeenAtMs || 0) - Number(b.lastSeenAtMs || 0));
    while (sessions.size > maxSessions && rows.length > 0) {
      const row = rows.shift();
      if (!row || !row.sessionKey) continue;
      if (row.timer) clearTimeout(row.timer);
      sessions.delete(row.sessionKey);
    }
  }

  function ensureState(input = {}) {
    const sessionKey = normalizeSessionKey(input);
    if (!sessionKey) return null;
    let state = sessions.get(sessionKey);
    if (!state) {
      state = loadDurableState(sessionKey);
    }
    if (!state) {
      state = {
        sessionKey,
        sessionId: String(input.sessionId || '').trim() || null,
        clientId: String(input.clientId || '').trim() || null,
        symbol: String(input.symbol || 'MNQ').trim().toUpperCase() || 'MNQ',
        active: false,
        lastSeenAtMs: Date.now(),
        lastHealthSnapshot: null,
        lastHealthFetchedAtMs: 0,
        lastHealthAgeSeconds: null,
        healthStatusUsed: null,
        timePhase: 'postWindow',
        etMinutes: null,
        inEntryWindow: false,
        pollIntervalMs: 60_000,
        pollFailureCount: 0,
        lastError: null,
        nextPollAtMs: null,
        timer: null,
        inFlightPromise: null,
      };
      sessions.set(sessionKey, state);
      pruneSessions();
    } else if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, state);
    }
    if (input.sessionId) state.sessionId = String(input.sessionId || '').trim() || state.sessionId;
    if (input.clientId) state.clientId = String(input.clientId || '').trim() || state.clientId;
    if (input.symbol) state.symbol = String(input.symbol || '').trim().toUpperCase() || state.symbol || 'MNQ';
    persistState(state);
    return state;
  }

  function updateDerivedState(state) {
    if (!state) return state;
    const now = Date.now();
    const nowEtFromSnapshot = String(state.lastHealthSnapshot?.now_et || '').trim();
    const nowEtFallback = nowEtProvider();
    const etMinutes = parseEtMinutes(nowEtFromSnapshot) ?? parseEtMinutes(nowEtFallback.time);
    const phase = resolveVoiceTradingTimePhase({ etMinutes });
    state.etMinutes = phase.etMinutes;
    state.timePhase = phase.timePhase;
    state.inEntryWindow = phase.inEntryWindow;
    state.pollIntervalMs = resolveVoiceHealthPollIntervalMs({ etMinutes: phase.etMinutes });
    if (Number.isFinite(Number(state.lastHealthFetchedAtMs)) && Number(state.lastHealthFetchedAtMs) > 0) {
      state.lastHealthAgeSeconds = Math.max(0, Math.floor((now - Number(state.lastHealthFetchedAtMs)) / 1000));
    } else {
      state.lastHealthAgeSeconds = null;
    }
    const liveActive = state.active === true && (now - Number(state.lastSeenAtMs || 0)) <= activeTtlMs;
    if (!liveActive) {
      state.active = false;
      state.nextPollAtMs = null;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    const status = String(state.lastHealthSnapshot?.status || state.healthStatusUsed || '').trim().toUpperCase();
    state.healthStatusUsed = status || null;
    return state;
  }

  function exportState(state, extras = {}) {
    if (!state) return null;
    updateDerivedState(state);
    return {
      sessionKey: state.sessionKey,
      sessionId: state.sessionId,
      clientId: state.clientId,
      symbol: state.symbol,
      voiceSessionModeActive: state.active === true,
      lastSeenAtMs: state.lastSeenAtMs || null,
      lastHealthSnapshot: state.lastHealthSnapshot || null,
      lastHealthFetchedAtMs: state.lastHealthFetchedAtMs || null,
      lastHealthAgeSeconds: Number.isFinite(Number(state.lastHealthAgeSeconds)) ? Number(state.lastHealthAgeSeconds) : null,
      healthStatusUsed: state.healthStatusUsed || null,
      timePhase: state.timePhase || 'postWindow',
      etMinutes: Number.isFinite(Number(state.etMinutes)) ? Number(state.etMinutes) : null,
      inEntryWindow: state.inEntryWindow === true,
      pollIntervalMs: Number.isFinite(Number(state.pollIntervalMs)) ? Number(state.pollIntervalMs) : 60_000,
      pollFailureCount: Number(state.pollFailureCount || 0),
      lastError: state.lastError || null,
      nextPollAtMs: state.nextPollAtMs || null,
      ...extras,
    };
  }

  function schedulePoll(state) {
    if (!state || !enableBackgroundPolling) return;
    updateDerivedState(state);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.active !== true) return;
    const baseMs = resolveVoiceHealthPollIntervalMs({ etMinutes: state.etMinutes });
    const backoffMult = state.pollFailureCount > 0
      ? Math.min(8, 2 ** Math.min(4, Number(state.pollFailureCount)))
      : 1;
    const delayMs = Math.min(maxBackoffMs, Math.max(baseMs, Math.round(baseMs * backoffMult)));
    state.nextPollAtMs = Date.now() + delayMs;
    state.timer = setTimeout(async () => {
      try {
        const current = sessions.get(state.sessionKey);
        if (!current) return;
        updateDerivedState(current);
        if (current.active !== true) return;
        await refreshStateHealth(current, {
          forceFresh: true,
          reason: 'background_poll',
        });
      } catch {}
    }, delayMs);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }

  async function refreshStateHealth(state, options = {}) {
    if (!state) return null;
    if (state.inFlightPromise) return state.inFlightPromise;
    const forceFresh = options.forceFresh === true;
    const reason = String(options.reason || 'manual').trim() || 'manual';
    const nowEt = nowEtProvider();
    const fetchWithTimeout = async () => Promise.race([
      Promise.resolve().then(() => fetchHealthSnapshot({
        symbol: state.symbol || 'MNQ',
        live: false,
        compareLiveModes: true,
        lookbackMinutes: 120,
        forceFresh,
        triggerSource: `voice_session_${reason}`,
      })),
      new Promise((_, reject) => {
        const timeoutErr = new Error(`voice_session_health_fetch_timeout_${Math.round(healthFetchTimeoutMs)}ms`);
        const timer = setTimeout(() => reject(timeoutErr), healthFetchTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    state.inFlightPromise = (async () => {
      try {
        const snapshot = await fetchWithTimeout();
        if (snapshot && typeof snapshot === 'object') {
          state.lastHealthSnapshot = snapshot;
          state.lastHealthFetchedAtMs = Date.now();
          state.lastError = null;
          state.pollFailureCount = 0;
          const status = String(snapshot.status || '').trim().toUpperCase();
          state.healthStatusUsed = status || null;
        }
      } catch (err) {
        state.pollFailureCount = Number(state.pollFailureCount || 0) + 1;
        state.lastError = String(err?.message || 'voice_session_health_refresh_failed');
        if (!state.lastHealthSnapshot) {
          state.lastHealthSnapshot = buildSyntheticStaleSnapshot(
            nowEt,
            `Voice health refresh failed: ${state.lastError}`
          );
          state.lastHealthFetchedAtMs = Date.now();
          state.healthStatusUsed = 'STALE';
        }
      } finally {
        state.inFlightPromise = null;
        updateDerivedState(state);
        persistState(state);
        schedulePoll(state);
      }
      return exportState(state);
    })();
    return state.inFlightPromise;
  }

  function touch(input = {}) {
    const state = ensureState(input);
    if (!state) return null;
    state.active = input.voiceMode === false ? false : true;
    state.lastSeenAtMs = Date.now();
    updateDerivedState(state);
    persistState(state);
    schedulePoll(state);
    return exportState(state);
  }

  function get(input = {}) {
    const state = ensureState(input);
    if (!state) return null;
    return exportState(state);
  }

  async function ensureForTrading(input = {}) {
    const state = ensureState(input);
    if (!state) return null;
    state.active = true;
    state.lastSeenAtMs = Date.now();
    const auditMock = input.auditMock && typeof input.auditMock === 'object' ? input.auditMock : null;
    if (auditMock) {
      state.lastHealthSnapshot = buildSnapshotFromAuditMock(auditMock, nowEtProvider);
      state.lastHealthFetchedAtMs = Date.now();
      state.pollFailureCount = 0;
      state.lastError = null;
      state.healthStatusUsed = String(state.lastHealthSnapshot?.status || '').trim().toUpperCase() || null;
      updateDerivedState(state);
      persistState(state);
      schedulePoll(state);
      return exportState(state, {
        snapshotUsed: state.lastHealthSnapshot,
        freshnessBudgetSeconds: resolveVoiceHealthPollIntervalMs({ etMinutes: state.etMinutes }) <= 15_000 ? 35 : 90,
      });
    }

    updateDerivedState(state);
    const baseIntervalMs = resolveVoiceHealthPollIntervalMs({ etMinutes: state.etMinutes });
    const freshnessBudgetSeconds = baseIntervalMs <= 15_000 ? 35 : 90;
    const ageSeconds = Number.isFinite(Number(state.lastHealthAgeSeconds)) ? Number(state.lastHealthAgeSeconds) : null;
    const nonBlocking = input.nonBlocking === true;
    const needsRefresh = (
      input.forceFresh === true
      || !state.lastHealthSnapshot
      || !Number.isFinite(ageSeconds)
      || ageSeconds > freshnessBudgetSeconds
    );
    if (needsRefresh) {
      const refreshPromise = refreshStateHealth(state, {
        forceFresh: true,
        reason: 'trading_query',
      });
      if (nonBlocking) {
        Promise.resolve(refreshPromise).catch(() => null);
      } else {
        await refreshPromise;
        updateDerivedState(state);
      }
    } else {
      schedulePoll(state);
    }

    let snapshotUsed = state.lastHealthSnapshot;
    let healthStatusUsed = String(snapshotUsed?.status || state.healthStatusUsed || '').trim().toUpperCase() || null;
    const finalAge = Number.isFinite(Number(state.lastHealthAgeSeconds)) ? Number(state.lastHealthAgeSeconds) : null;
    if (!snapshotUsed) {
      snapshotUsed = buildSyntheticStaleSnapshot(
        nowEtProvider(),
        'No health snapshot is available for this voice session.'
      );
      healthStatusUsed = 'STALE';
    } else if (Number.isFinite(finalAge) && finalAge > freshnessBudgetSeconds) {
      snapshotUsed = {
        ...snapshotUsed,
        status: 'STALE',
        reason: `Voice session market health is stale (${Math.round(finalAge)}s old).`,
      };
      healthStatusUsed = 'STALE';
    }
    state.healthStatusUsed = healthStatusUsed;
    updateDerivedState(state);
    persistState(state);
    schedulePoll(state);
    return exportState(state, {
      snapshotUsed,
      healthStatusUsed,
      freshnessBudgetSeconds,
      refreshInFlight: !!state.inFlightPromise,
      usedNonBlockingRefresh: nonBlocking && needsRefresh,
    });
  }

  function shutdown() {
    for (const state of sessions.values()) {
      if (state?.timer) clearTimeout(state.timer);
      persistState(state);
    }
    sessions.clear();
  }

  return {
    touch,
    get,
    ensureForTrading,
    shutdown,
    _internal: {
      sessions,
      parseEtMinutes,
    },
  };
}

module.exports = {
  createVoiceTradingSessionManager,
  resolveVoiceTradingTimePhase,
  resolveVoiceHealthPollIntervalMs,
  parseEtMinutes,
};
