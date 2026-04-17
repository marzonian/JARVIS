#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  buildStrategyLayerSnapshot,
  buildCommandCenterPanels,
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
} = require('../server/jarvis-core/strategy-layers');
const {
  createLiveCandidateObservationLoop,
  resolveLiveCandidateObservationMode,
} = require('../server/jarvis-core/live-candidate-observation-loop');

const OBS_TABLE = 'jarvis_live_candidate_state_observations';
const TRANS_TABLE = 'jarvis_live_candidate_state_transitions';

function candle(date, time, open, high, low, close, volume = 1000) {
  return { timestamp: `${date} ${time}`, time, open, high, low, close, volume };
}

function buildSession(date) {
  return [
    candle(date, '09:30', 22100, 22120, 22095, 22110),
    candle(date, '09:35', 22110, 22128, 22106, 22122),
    candle(date, '09:40', 22122, 22134, 22112, 22116),
    candle(date, '09:45', 22116, 22132, 22114, 22130),
    candle(date, '09:50', 22130, 22145, 22124, 22140),
    candle(date, '09:55', 22140, 22155, 22134, 22148),
    candle(date, '10:00', 22148, 22163, 22143, 22158),
    candle(date, '10:05', 22158, 22175, 22152, 22170),
    candle(date, '10:10', 22170, 22184, 22164, 22180),
    candle(date, '10:15', 22180, 22195, 22172, 22190),
  ];
}

function buildStrategyLayers() {
  const sessions = {
    '2026-04-10': buildSession('2026-04-10'),
    '2026-04-13': buildSession('2026-04-13'),
    '2026-04-14': buildSession('2026-04-14'),
    '2026-04-15': buildSession('2026-04-15'),
    '2026-04-16': buildSession('2026-04-16'),
  };
  return buildStrategyLayerSnapshot(sessions, {
    includeDiscovery: false,
    context: {
      nowEt: '2026-04-16 10:10',
      sessionPhase: 'entry_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
  });
}

function buildInput({ signal, probability, expectedValueDollars, nowEt, latestSession, db }) {
  return {
    strategyLayers: buildStrategyLayers(),
    liveCandidateStateMonitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
    db,
    persistLiveCandidateState: true,
    observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    decision: {
      signal,
      signalLabel: signal,
      blockers: [],
      topSetups: [{
        setupId: 'orb_retest_long',
        name: 'ORB Retest Long',
        probability,
        expectedValueDollars,
        annualizedTrades: 120,
      }],
    },
    latestSession,
    todayContext: {
      nowEt,
      sessionPhase: 'entry_window',
      timeBucket: 'entry_window',
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
    commandSnapshot: {
      elite: {
        winModel: { point: 56.1, confidencePct: 66 },
      },
    },
  };
}

function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFreshness(row = {}, nowEt = '') {
  const nowText = String(nowEt || '').trim();
  const latestMarketTimestamp = String(
    row.latestMarketTimestamp
    || row?.latestSession?.trade?.entry_time
    || nowText
  ).trim() || null;
  const latestDecisionTimestamp = String(row.latestDecisionTimestamp || new Date().toISOString()).trim() || null;
  const latestContextTimestamp = String(row.latestContextTimestamp || nowText).trim() || null;
  const staleInputWarning = row.staleInputWarning === true;
  const staleInputReasonCodes = Array.isArray(row.staleInputReasonCodes)
    ? row.staleInputReasonCodes
    : (staleInputWarning ? ['session_cache_hit_under_force_fresh'] : []);
  return {
    lastInputRefreshAt: new Date().toISOString(),
    refreshedInputSources: staleInputWarning
      ? ['command_snapshot', 'decision_context', 'today_context']
      : ['sessions_5m_candles', 'command_snapshot', 'decision_context', 'today_context'],
    staleInputWarning,
    staleInputReasonCodes,
    lastObservedMarketTimestamp: latestMarketTimestamp,
    lastObservedDecisionTimestamp: latestDecisionTimestamp,
    lastObservedContextTimestamp: latestContextTimestamp,
    inputFingerprint: [
      latestMarketTimestamp || 'market:unknown',
      latestDecisionTimestamp || 'decision:unknown',
      latestContextTimestamp || 'context:unknown',
      `signal:${String(row.signal || '').trim().toLowerCase() || 'none'}`,
    ].join('|'),
  };
}

function createPoller(db, sequence, nowRef, statsRef) {
  let callIndex = 0;
  return async () => {
    statsRef.calls += 1;
    const idx = Math.min(callIndex, sequence.length - 1);
    callIndex += 1;
    const row = sequence[idx];
    const payload = buildCommandCenterPanels(buildInput({
      signal: row.signal,
      probability: row.probability,
      expectedValueDollars: row.expectedValueDollars,
      nowEt: nowRef.value,
      latestSession: row.latestSession,
      db,
    }));
    return {
      monitor: payload.liveCandidateStateMonitor,
      history: payload.liveCandidateTransitionHistory,
      freshness: buildFreshness(row, nowRef.value),
      summaryLine: payload.liveCandidateStateMonitor?.summaryLine || null,
      advisoryOnly: true,
    };
  };
}

async function run() {
  {
    const modeActive = resolveLiveCandidateObservationMode({ date: '2026-04-16', time: '09:35' }, {
      activeIntervalMs: 60_000,
      monitorIntervalMs: 180_000,
      idleIntervalMs: 300_000,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });
    assert(modeActive.mode === 'active', 'expected active mode in entry window');
    assert(modeActive.shouldObserve === true, 'active mode should observe');
    const modeIdle = resolveLiveCandidateObservationMode({ date: '2026-04-19', time: '11:00' }, {
      activeIntervalMs: 60_000,
      monitorIntervalMs: 180_000,
      idleIntervalMs: 300_000,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });
    assert(modeIdle.mode === 'idle', 'expected idle mode on weekend');
    assert(modeIdle.shouldObserve === false, 'weekend mode should not observe');
  }

  {
    const db = new Database(':memory:');
    const nowRef = { value: '2026-04-16 10:10' };
    const stats = { calls: 0 };
    const poller = createPoller(db, [{
      signal: 'WAIT',
      probability: 0.41,
      expectedValueDollars: -20,
      latestSession: { no_trade_reason: 'no_confirmation' },
      staleInputWarning: false,
    }, {
      signal: 'WAIT',
      probability: 0.41,
      expectedValueDollars: -20,
      latestSession: { no_trade_reason: 'no_confirmation' },
      staleInputWarning: false,
    }, {
      signal: 'WAIT',
      probability: 0.41,
      expectedValueDollars: -20,
      latestSession: { no_trade_reason: 'no_confirmation' },
      staleInputWarning: true,
      staleInputReasonCodes: ['session_cache_hit_under_force_fresh'],
    }], nowRef, stats);
    const loop = createLiveCandidateObservationLoop({
      enabled: true,
      poller,
      nowProvider: () => {
        const [date, time] = String(nowRef.value || '').split(' ');
        return { date, time };
      },
      activeIntervalMs: 10_000,
      monitorIntervalMs: 20_000,
      idleIntervalMs: 30_000,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });

    const first = await loop.runTick({ triggerSource: 'test_manual_1' });
    assert(first.status === 'ok', 'first manual loop tick should run');
    const obsAfterFirst = countRows(db, OBS_TABLE);
    const transAfterFirst = countRows(db, TRANS_TABLE);
    assert(obsAfterFirst > 0, 'first loop tick should write observations');
    assert(transAfterFirst === 0, 'first loop tick should not create transitions');
    const statusAfterFirst = loop.getStatus();
    assert(statusAfterFirst.writesThisSession > 0, 'status should report writes after first tick');
    assert(statusAfterFirst.lastResponseReadOnly === false, 'loop writes should not be read-only');
    assert(statusAfterFirst.lastObservationWriteSource === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO, 'loop writes should surface loop_auto source');

    nowRef.value = '2026-04-16 10:11';
    const second = await loop.runTick({ triggerSource: 'test_manual_2' });
    assert(second.status === 'ok', 'second manual loop tick should run');
    const obsAfterSecond = countRows(db, OBS_TABLE);
    const transAfterSecond = countRows(db, TRANS_TABLE);
    assert(obsAfterSecond === obsAfterFirst, 'unchanged loop tick should suppress duplicate observation writes');
    assert(transAfterSecond === 0, 'unchanged loop tick should not create transitions');
    const statusAfterSecond = loop.getStatus();
    assert(statusAfterSecond.suppressedWritesThisSession > 0, 'status should report suppressed writes');
    assert(statusAfterSecond.pollsThisSession >= 2, 'status should report polls');
    assert(statusAfterSecond.lastStateClassification === 'real_state_unchanged', 'unchanged state should classify as real_state_unchanged when inputs are refreshed');
    assert(statusAfterSecond.staleInputWarning === false, 'unchanged refreshed state should not emit stale warning');
    assert(Array.isArray(statusAfterSecond.refreshedInputSources) && statusAfterSecond.refreshedInputSources.length >= 1, 'loop status should include refreshedInputSources');
    assert(typeof statusAfterSecond.lastInputRefreshAt === 'string' && statusAfterSecond.lastInputRefreshAt.length > 0, 'loop status should expose lastInputRefreshAt');

    nowRef.value = '2026-04-16 10:12';
    const third = await loop.runTick({ triggerSource: 'test_manual_3_stale' });
    assert(third.status === 'ok', 'third manual loop tick should run');
    const statusAfterThird = loop.getStatus();
    assert(statusAfterThird.lastStateClassification === 'stale_input_warning', 'stale inputs should classify as stale_input_warning');
    assert(statusAfterThird.staleInputWarning === true, 'stale status should surface staleInputWarning true');
    assert(Array.isArray(statusAfterThird.staleInputReasonCodes) && statusAfterThird.staleInputReasonCodes.includes('session_cache_hit_under_force_fresh'), 'stale status should surface stale reason codes');
    assert(typeof statusAfterThird.lastHistoryProvenanceClassification === 'string' && statusAfterThird.lastHistoryProvenanceClassification.length > 0, 'loop status should expose history provenance classification');

    loop.stop({ reason: 'test_restart' });
    const restartLoop = createLiveCandidateObservationLoop({
      enabled: true,
      poller,
      nowProvider: () => {
        const [date, time] = String(nowRef.value || '').split(' ');
        return { date, time };
      },
      activeIntervalMs: 10_000,
      monitorIntervalMs: 20_000,
      idleIntervalMs: 30_000,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });
    await restartLoop.runTick({ triggerSource: 'test_restart_tick' });
    assert(countRows(db, TRANS_TABLE) === 0, 'restart with unchanged state should not fabricate transitions');
    assert(stats.calls >= 3, 'poller should have been called across manual/restart ticks');
    restartLoop.stop({ reason: 'done' });
    db.close();
  }

  {
    const db = new Database(':memory:');
    const nowRef = { value: '2026-04-16 10:20' };
    const stats = { calls: 0 };
    const poller = createPoller(db, [
      {
        signal: 'WAIT',
        probability: 0.39,
        expectedValueDollars: -18,
        latestSession: { no_trade_reason: 'no_confirmation' },
      },
      {
        signal: 'TRADE',
        probability: 0.81,
        expectedValueDollars: 88,
        latestSession: {
          trade: {
            direction: 'long',
            entry_time: '2026-04-16 10:21',
            entry_price: 22140,
            sl_price: 22095,
            tp_price: 22200,
          },
        },
      },
    ], nowRef, stats);
    const loop = createLiveCandidateObservationLoop({
      enabled: true,
      poller,
      nowProvider: () => {
        const [date, time] = String(nowRef.value || '').split(' ');
        return { date, time };
      },
      activeIntervalMs: 10_000,
      monitorIntervalMs: 20_000,
      idleIntervalMs: 30_000,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });
    await loop.runTick({ triggerSource: 'transition_before' });
    nowRef.value = '2026-04-16 10:21';
    await loop.runTick({ triggerSource: 'transition_after' });
    const transitionRows = countRows(db, TRANS_TABLE);
    assert(transitionRows > 0, 'automatic loop polling should create durable transitions after actionable change');
    const status = loop.getStatus();
    assert(status.transitionWritesThisSession > 0, 'loop status should count transition writes');
    loop.stop({ reason: 'done' });
    db.close();
  }

  {
    const db = new Database(':memory:');
    const nowRef = { value: '2026-04-19 11:00' };
    const stats = { calls: 0 };
    const poller = createPoller(db, [{
      signal: 'WAIT',
      probability: 0.4,
      expectedValueDollars: -10,
      latestSession: { no_trade_reason: 'weekend' },
    }], nowRef, stats);
    const loop = createLiveCandidateObservationLoop({
      enabled: true,
      poller,
      nowProvider: () => {
        const [date, time] = String(nowRef.value || '').split(' ');
        return { date, time };
      },
      activeIntervalMs: 10_000,
      monitorIntervalMs: 20_000,
      idleIntervalMs: 30_000,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });
    const idleTick = await loop.runTick({ triggerSource: 'idle_tick' });
    assert(idleTick.status === 'idle', 'idle/outside-window tick should stay idle');
    assert(stats.calls === 0, 'idle/outside-window tick should not call poller');
    const status = loop.getStatus();
    assert(status.currentMode === 'idle', 'status should surface idle mode');
    assert(String(status.currentModeReason || '').length > 0, 'status should surface idle reason');
    loop.stop({ reason: 'done' });
    db.close();
  }

  {
    const db = new Database(':memory:');
    const nowRef = { value: '2026-04-16 10:25' };
    const stats = { calls: 0 };
    const poller = createPoller(db, [{
      signal: 'WAIT',
      probability: 0.44,
      expectedValueDollars: -12,
      latestSession: { no_trade_reason: 'no_confirmation' },
    }], nowRef, stats);
    const loop = createLiveCandidateObservationLoop({
      enabled: true,
      poller,
      nowProvider: () => {
        const [date, time] = String(nowRef.value || '').split(' ');
        return { date, time };
      },
      activeIntervalMs: 50,
      monitorIntervalMs: 75,
      idleIntervalMs: 150,
      activeStartEt: '09:20',
      activeEndEt: '12:00',
      monitorStartEt: '08:00',
      monitorEndEt: '20:30',
    });
    loop.start({ immediate: true });
    await sleep(2300);
    const status = loop.getStatus();
    assert(stats.calls >= 2, 'automatic loop start should poll repeatedly without manual endpoint calls');
    assert(status.pollsThisSession >= 2, 'status should count automatic polls');
    assert(countRows(db, OBS_TABLE) > 0, 'automatic loop should write durable observations');
    loop.stop({ reason: 'done' });
    db.close();
  }

  console.log('Jarvis live candidate observation loop test passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
