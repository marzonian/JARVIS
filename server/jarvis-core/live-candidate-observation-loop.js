'use strict';

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (Number.isFinite(min) && rounded < min) return min;
  if (Number.isFinite(max) && rounded > max) return max;
  return rounded;
}

function parseClockMinutes(value, fallbackMinutes) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mins)) return fallbackMinutes;
  if (h < 0 || h > 23 || mins < 0 || mins > 59) return fallbackMinutes;
  return (h * 60) + mins;
}

function parseNowEt(nowEtInput) {
  if (nowEtInput && typeof nowEtInput === 'object') {
    const date = String(nowEtInput.date || '').trim();
    const time = String(nowEtInput.time || '').trim();
    if (date && time) return { date, time };
  }
  const text = String(nowEtInput || '').trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  const now = new Date();
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmtDate.formatToParts(now).reduce((acc, part) => {
    if (part?.type) acc[part.type] = part.value;
    return acc;
  }, {});
  const fmtTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const time = String(fmtTime.format(now)).trim().slice(0, 5);
  return {
    date: `${parts.year || '1970'}-${parts.month || '01'}-${parts.day || '01'}`,
    time: time || '00:00',
  };
}

function deriveWeekdayFromEtDate(dateText = '') {
  const date = String(dateText || '').trim();
  if (!date) return '';
  const dt = new Date(`${date}T12:00:00-04:00`);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
}

function resolveLiveCandidateObservationMode(nowEtInput, options = {}) {
  const nowEt = parseNowEt(nowEtInput);
  const weekday = deriveWeekdayFromEtDate(nowEt.date);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  const activeIntervalMs = clampInt(options.activeIntervalMs, 60_000, 1_000, 30 * 60 * 1000);
  const monitorIntervalMs = clampInt(options.monitorIntervalMs, 180_000, 1_000, 30 * 60 * 1000);
  const idleIntervalMs = clampInt(options.idleIntervalMs, 300_000, 1_000, 60 * 60 * 1000);

  const activeStart = parseClockMinutes(options.activeStartEt || '09:20', 9 * 60 + 20);
  const activeEnd = parseClockMinutes(options.activeEndEt || '12:00', 12 * 60);
  const monitorStart = parseClockMinutes(options.monitorStartEt || '08:00', 8 * 60);
  const monitorEnd = parseClockMinutes(options.monitorEndEt || '20:30', 20 * 60 + 30);
  const nowMinutes = parseClockMinutes(nowEt.time, 0);

  let mode = 'idle';
  let shouldObserve = false;
  let reason = 'outside_monitoring_window';
  let intervalMs = idleIntervalMs;

  if (!isWeekday) {
    mode = 'idle';
    shouldObserve = false;
    reason = 'weekend_idle';
    intervalMs = idleIntervalMs;
  } else if (nowMinutes >= activeStart && nowMinutes <= activeEnd) {
    mode = 'active';
    shouldObserve = true;
    reason = 'inside_active_window';
    intervalMs = activeIntervalMs;
  } else if (nowMinutes >= monitorStart && nowMinutes <= monitorEnd) {
    mode = 'monitor';
    shouldObserve = true;
    reason = 'inside_monitor_window';
    intervalMs = monitorIntervalMs;
  } else {
    mode = 'idle';
    shouldObserve = false;
    reason = 'outside_monitoring_window';
    intervalMs = idleIntervalMs;
  }

  return {
    nowEt,
    weekday,
    isWeekday,
    mode,
    shouldObserve,
    reason,
    intervalMs,
    windows: {
      active: `${String(options.activeStartEt || '09:20').trim() || '09:20'}-${String(options.activeEndEt || '12:00').trim() || '12:00'} ET`,
      monitor: `${String(options.monitorStartEt || '08:00').trim() || '08:00'}-${String(options.monitorEndEt || '20:30').trim() || '20:30'} ET`,
    },
  };
}

function isoNow() {
  return new Date().toISOString();
}

function copyObject(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function createLiveCandidateObservationLoop(options = {}) {
  const poller = typeof options.poller === 'function' ? options.poller : null;
  const nowProvider = typeof options.nowProvider === 'function'
    ? options.nowProvider
    : (() => parseNowEt());
  const enabled = options.enabled !== false;
  const modeOptions = {
    activeStartEt: options.activeStartEt || '09:20',
    activeEndEt: options.activeEndEt || '12:00',
    monitorStartEt: options.monitorStartEt || '08:00',
    monitorEndEt: options.monitorEndEt || '20:30',
    activeIntervalMs: options.activeIntervalMs,
    monitorIntervalMs: options.monitorIntervalMs,
    idleIntervalMs: options.idleIntervalMs,
  };

  const state = {
    enabled,
    started: false,
    running: false,
    inFlight: false,
    timer: null,
    currentMode: enabled ? 'idle' : 'disabled',
    currentModeReason: enabled ? 'not_started' : 'disabled_by_config',
    currentIntervalMs: clampInt(options.idleIntervalMs, 300_000, 60_000, 60 * 60 * 1000),
    lastPollAt: null,
    lastSuccessfulWriteAt: null,
    lastObservationAt: null,
    lastError: null,
    lastIdleReason: null,
    lastSummaryLine: enabled ? 'Loop ready; first poll pending.' : 'Loop disabled by config.',
    pollsTotal: 0,
    pollsThisSession: 0,
    writesThisSession: 0,
    suppressedWritesThisSession: 0,
    transitionWritesThisSession: 0,
    observationsEvaluatedThisSession: 0,
    lastInputRefreshAt: null,
    refreshedInputSources: [],
    staleInputWarning: false,
    staleInputReasonCodes: [],
    lastObservedMarketTimestamp: null,
    lastObservedDecisionTimestamp: null,
    lastObservedContextTimestamp: null,
    lastStateClassification: 'no_state_evaluated',
    lastStateClassificationReason: 'loop_not_started',
    lastInputFingerprint: null,
    lastResponseReadOnly: null,
    lastObservationWriteSource: null,
    lastHistoryProvenanceClassification: null,
    lastHistoryProvenanceSummaryLine: null,
    sessionDate: null,
    nextPollAt: null,
    lastResult: null,
  };

  function resetSessionCounters(sessionDate) {
    if (state.sessionDate && state.sessionDate === sessionDate) return;
    state.sessionDate = sessionDate || null;
    state.pollsThisSession = 0;
    state.writesThisSession = 0;
    state.suppressedWritesThisSession = 0;
    state.transitionWritesThisSession = 0;
    state.observationsEvaluatedThisSession = 0;
  }

  function buildSummaryLine() {
    if (!state.enabled) return 'Live candidate observation loop is disabled.';
    if (!state.started) return 'Live candidate observation loop is ready; first poll pending.';
    if (state.currentMode === 'idle') {
      return `Live candidate observation loop idle (${state.currentModeReason || 'outside window'}); next poll in ${Math.max(1, Math.round((state.currentIntervalMs || 0) / 1000))}s.`;
    }
    const classification = String(state.lastStateClassification || '').trim().toLowerCase();
    const classificationNote = classification === 'stale_input_warning'
      ? ' stale-input warning.'
      : classification === 'real_state_unchanged'
        ? ' unchanged state appears real.'
        : classification === 'state_changed'
          ? ' state changed.'
          : '';
    return `Live candidate observation loop ${state.currentMode}; polls ${state.pollsThisSession}, writes ${state.writesThisSession}, suppressed ${state.suppressedWritesThisSession}.${classificationNote}`;
  }

  function getStatus() {
    const base = {
      enabled: state.enabled,
      running: state.running,
      started: state.started,
      currentMode: state.currentMode,
      currentModeReason: state.currentModeReason || null,
      currentIntervalMs: state.currentIntervalMs,
      sessionDate: state.sessionDate || null,
      lastPollAt: state.lastPollAt || null,
      lastObservationAt: state.lastObservationAt || null,
      lastSuccessfulWriteAt: state.lastSuccessfulWriteAt || null,
      lastIdleReason: state.lastIdleReason || null,
      lastError: state.lastError || null,
      nextPollAt: state.nextPollAt || null,
      pollsTotal: state.pollsTotal,
      pollsThisSession: state.pollsThisSession,
      writesThisSession: state.writesThisSession,
      suppressedWritesThisSession: state.suppressedWritesThisSession,
      transitionWritesThisSession: state.transitionWritesThisSession,
      observationsEvaluatedThisSession: state.observationsEvaluatedThisSession,
      lastInputRefreshAt: state.lastInputRefreshAt || null,
      refreshedInputSources: Array.isArray(state.refreshedInputSources) ? [...state.refreshedInputSources] : [],
      staleInputWarning: state.staleInputWarning === true,
      staleInputReasonCodes: Array.isArray(state.staleInputReasonCodes) ? [...state.staleInputReasonCodes] : [],
      lastObservedMarketTimestamp: state.lastObservedMarketTimestamp || null,
      lastObservedDecisionTimestamp: state.lastObservedDecisionTimestamp || null,
      lastObservedContextTimestamp: state.lastObservedContextTimestamp || null,
      lastStateClassification: String(state.lastStateClassification || '').trim() || 'no_state_evaluated',
      lastStateClassificationReason: String(state.lastStateClassificationReason || '').trim() || null,
      lastInputFingerprint: String(state.lastInputFingerprint || '').trim() || null,
      lastResponseReadOnly: state.lastResponseReadOnly === true,
      lastObservationWriteSource: String(state.lastObservationWriteSource || '').trim() || null,
      lastHistoryProvenanceClassification: String(state.lastHistoryProvenanceClassification || '').trim() || null,
      lastHistoryProvenanceSummaryLine: String(state.lastHistoryProvenanceSummaryLine || '').trim() || null,
      lastResult: copyObject(state.lastResult, null),
      summaryLine: state.lastSummaryLine || buildSummaryLine(),
      advisoryOnly: true,
    };
    return base;
  }

  async function runTick(meta = {}) {
    const triggerSource = String(meta.triggerSource || 'interval').trim() || 'interval';
    if (!state.enabled || !poller) {
      state.running = false;
      state.currentMode = 'disabled';
      state.currentModeReason = state.enabled ? 'missing_poller' : 'disabled_by_config';
      state.lastSummaryLine = buildSummaryLine();
      return { status: 'disabled', reason: state.currentModeReason };
    }
    if (state.inFlight) {
      state.lastSummaryLine = 'Live candidate observation tick skipped: previous tick still running.';
      return { status: 'skip', reason: 'tick_in_flight' };
    }

    const mode = resolveLiveCandidateObservationMode(nowProvider(), modeOptions);
    resetSessionCounters(mode.nowEt.date);
    state.currentMode = mode.mode;
    state.currentModeReason = mode.reason;
    state.currentIntervalMs = mode.intervalMs;
    state.lastPollAt = isoNow();
    state.pollsTotal += 1;
    state.pollsThisSession += 1;
    state.lastIdleReason = mode.shouldObserve ? null : mode.reason;
    state.running = true;

    if (!mode.shouldObserve) {
      state.lastStateClassification = 'no_state_evaluated';
      state.lastStateClassificationReason = String(mode.reason || 'outside_monitoring_window').trim().toLowerCase() || 'outside_monitoring_window';
      state.lastResult = {
        status: 'idle',
        reason: mode.reason,
        triggerSource,
        nowEt: `${mode.nowEt.date} ${mode.nowEt.time}`,
      };
      state.lastSummaryLine = buildSummaryLine();
      return state.lastResult;
    }

    state.inFlight = true;
    try {
      const pollResult = await Promise.resolve(
        poller({
          triggerSource,
          mode: copyObject(mode, mode),
          nowEt: copyObject(mode.nowEt, mode.nowEt),
        })
      );
      const monitor = pollResult?.monitor && typeof pollResult.monitor === 'object'
        ? pollResult.monitor
        : (pollResult?.liveCandidateStateMonitor && typeof pollResult.liveCandidateStateMonitor === 'object'
          ? pollResult.liveCandidateStateMonitor
          : null);
      const writes = clampInt(monitor?.observationWritesThisSnapshot, 0, 0, Number.MAX_SAFE_INTEGER);
      const suppressed = clampInt(monitor?.observationSuppressedThisSnapshot, 0, 0, Number.MAX_SAFE_INTEGER);
      const transitionWrites = clampInt(monitor?.transitionWritesThisSnapshot, 0, 0, Number.MAX_SAFE_INTEGER);
      const observationsEvaluated = Array.isArray(monitor?.recentObservationSample)
        ? monitor.recentObservationSample.length
        : clampInt(monitor?.priorObservationReadCount, 0, 0, Number.MAX_SAFE_INTEGER);
      state.lastResponseReadOnly = monitor?.responseReadOnly === true;
      state.lastObservationWriteSource = String(monitor?.observationWriteSource || '').trim().toLowerCase() || null;
      state.lastHistoryProvenanceClassification = String(monitor?.historyProvenanceClassification || '').trim().toLowerCase() || null;
      state.lastHistoryProvenanceSummaryLine = String(monitor?.historyProvenanceSummaryLine || '').trim() || null;
      const freshness = pollResult?.freshness && typeof pollResult.freshness === 'object'
        ? pollResult.freshness
        : null;
      state.writesThisSession += writes;
      state.suppressedWritesThisSession += suppressed;
      state.transitionWritesThisSession += transitionWrites;
      state.observationsEvaluatedThisSession += Math.max(observationsEvaluated, writes + suppressed);
      state.lastObservationAt = isoNow();
      if (writes > 0) state.lastSuccessfulWriteAt = state.lastObservationAt;
      if (freshness) {
        state.lastInputRefreshAt = String(freshness.lastInputRefreshAt || '').trim() || state.lastObservationAt;
        state.refreshedInputSources = Array.isArray(freshness.refreshedInputSources)
          ? freshness.refreshedInputSources.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
          : [];
        state.staleInputWarning = freshness.staleInputWarning === true;
        state.staleInputReasonCodes = Array.isArray(freshness.staleInputReasonCodes)
          ? freshness.staleInputReasonCodes.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
          : [];
        state.lastObservedMarketTimestamp = String(freshness.lastObservedMarketTimestamp || '').trim() || null;
        state.lastObservedDecisionTimestamp = String(freshness.lastObservedDecisionTimestamp || '').trim() || null;
        state.lastObservedContextTimestamp = String(freshness.lastObservedContextTimestamp || '').trim() || null;
        state.lastInputFingerprint = String(freshness.inputFingerprint || '').trim() || null;
      }
      let stateClassification = 'no_state_evaluated';
      let stateClassificationReason = 'no_candidate_observations';
      if (writes > 0 || transitionWrites > 0) {
        stateClassification = 'state_changed';
        stateClassificationReason = transitionWrites > 0 ? 'transition_or_observation_write' : 'observation_write';
      } else if (state.staleInputWarning) {
        stateClassification = 'stale_input_warning';
        stateClassificationReason = state.staleInputReasonCodes[0] || 'stale_input_warning';
      } else if (suppressed > 0 || observationsEvaluated > 0) {
        stateClassification = 'real_state_unchanged';
        stateClassificationReason = 'input_refreshed_but_state_unchanged';
      }
      state.lastStateClassification = stateClassification;
      state.lastStateClassificationReason = stateClassificationReason;
      state.lastError = null;
      state.lastResult = {
        status: 'ok',
        triggerSource,
        mode: mode.mode,
        writes,
        suppressed,
        transitionWrites,
        nowEt: `${mode.nowEt.date} ${mode.nowEt.time}`,
        stateClassification,
        stateClassificationReason,
        staleInputWarning: state.staleInputWarning === true,
        staleInputReasonCodes: Array.isArray(state.staleInputReasonCodes) ? [...state.staleInputReasonCodes] : [],
        refreshedInputSources: Array.isArray(state.refreshedInputSources) ? [...state.refreshedInputSources] : [],
        summaryLine: monitor?.summaryLine || pollResult?.summaryLine || null,
      };
      state.lastSummaryLine = buildSummaryLine();
      return state.lastResult;
    } catch (err) {
      state.lastError = String(err?.message || 'live_candidate_observation_poll_failed');
      state.lastStateClassification = 'poll_error';
      state.lastStateClassificationReason = state.lastError;
      state.lastResult = {
        status: 'error',
        reason: state.lastError,
        triggerSource,
        nowEt: `${mode.nowEt.date} ${mode.nowEt.time}`,
      };
      state.lastSummaryLine = `Live candidate observation loop error: ${state.lastError}.`;
      return state.lastResult;
    } finally {
      state.inFlight = false;
    }
  }

  function clearTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();
    if (!state.started || !state.enabled) {
      state.nextPollAt = null;
      return;
    }
    const mode = resolveLiveCandidateObservationMode(nowProvider(), modeOptions);
    state.currentMode = mode.mode;
    state.currentModeReason = mode.reason;
    state.currentIntervalMs = mode.intervalMs;
    const nextAt = new Date(Date.now() + Math.max(1_000, mode.intervalMs));
    state.nextPollAt = nextAt.toISOString();
    state.timer = setTimeout(async () => {
      try {
        await runTick({ triggerSource: 'interval' });
      } finally {
        scheduleNext();
      }
    }, Math.max(1_000, mode.intervalMs));
  }

  function start(options = {}) {
    if (!state.enabled || !poller) {
      state.started = false;
      state.running = false;
      state.currentMode = 'disabled';
      state.currentModeReason = !state.enabled ? 'disabled_by_config' : 'missing_poller';
      state.lastSummaryLine = buildSummaryLine();
      return getStatus();
    }
    if (state.started) return getStatus();
    state.started = true;
    state.running = true;
    state.lastSummaryLine = 'Live candidate observation loop starting.';
    const immediate = options.immediate !== false;
    if (immediate) {
      runTick({ triggerSource: 'startup' }).finally(() => {
        scheduleNext();
      });
    } else {
      scheduleNext();
    }
    return getStatus();
  }

  function stop(options = {}) {
    clearTimer();
    state.started = false;
    state.running = false;
    state.nextPollAt = null;
    state.currentMode = 'idle';
    state.currentModeReason = String(options.reason || 'stopped').trim().toLowerCase() || 'stopped';
    state.lastSummaryLine = `Live candidate observation loop stopped (${state.currentModeReason}).`;
    return getStatus();
  }

  return {
    start,
    stop,
    runTick,
    getStatus,
  };
}

module.exports = {
  resolveLiveCandidateObservationMode,
  createLiveCandidateObservationLoop,
};
