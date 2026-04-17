#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  buildStrategyLayerSnapshot,
  buildCommandCenterPanels,
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
  LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
} = require('../server/jarvis-core/strategy-layers');

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

function buildInput({
  signal = 'WAIT',
  probability = 0.4,
  expectedValueDollars = -20,
  nowEt = '2026-04-16 10:10',
  latestSession = {},
  db = null,
  monitorState = null,
  persistLiveCandidateState = true,
  observationWriteSource = LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
} = {}) {
  return {
    strategyLayers: buildStrategyLayers(),
    liveCandidateStateMonitorState: monitorState,
    db,
    persistLiveCandidateState,
    observationWriteSource,
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

function countRowsForCandidate(db, table, candidateKey) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE candidate_key = ?`).get(String(candidateKey || ''))?.c || 0);
}

function countRowsBySource(db, table, sourceColumn, source) {
  return Number(
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${sourceColumn} = ?`).get(String(source || '').trim())?.c || 0
  );
}

function run() {
  const db = new Database(':memory:');

  const readOnly = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    probability: 0.4,
    expectedValueDollars: -20,
    nowEt: '2026-04-16 10:09',
    latestSession: { no_trade_reason: 'no_confirmation' },
    db,
    monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
    persistLiveCandidateState: false,
  }));
  assert(readOnly.liveCandidateStateMonitor.responseReadOnly === true, 'read-only snapshot should mark responseReadOnly');
  assert(readOnly.liveCandidateStateMonitor.observationWriteEnabled === false, 'read-only snapshot should disable observation writes');
  assert(readOnly.liveCandidateStateMonitor.responseTriggeredDurableWrites === false, 'read-only snapshot should not trigger durable writes');
  assert(countRows(db, OBS_TABLE) === 0, 'read-only snapshot should not persist observations');
  assert(countRows(db, TRANS_TABLE) === 0, 'read-only snapshot should not persist transitions');

  const first = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    probability: 0.4,
    expectedValueDollars: -20,
    nowEt: '2026-04-16 10:10',
    latestSession: { no_trade_reason: 'no_confirmation' },
    db,
    monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
    observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
  }));

  assert(first.liveCandidateStateMonitor.storageMode === 'durable_sqlite', 'first snapshot should use durable sqlite storage');
  assert(first.liveCandidateStateMonitor.responseReadOnly === false, 'diagnostic write snapshot should be write-enabled');
  assert(first.liveCandidateStateMonitor.observationWriteSource === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC, 'diagnostic write snapshot should report write source');
  assert(first.liveCandidateStateMonitor.actionableTransitionDetected === false, 'first snapshot should not detect actionable transition');
  assert(first.liveCandidateStateMonitor.emptyStateReason === 'no_prior_observations_yet', 'first snapshot should mark no_prior_observations_yet on monitor');
  assert(first.liveCandidateStateMonitor.loopOnlyObservationCount === 0, 'diagnostic-only seed should report zero loop-only observations');
  assert(first.liveCandidateStateMonitor.diagnosticOnlyObservationCount > 0, 'diagnostic-only seed should report diagnostic observations');
  assert(first.liveCandidateTransitionHistory.loopOnlyTransitionCount === 0, 'diagnostic-only seed should report zero loop-only transitions');
  assert(first.liveCandidateTransitionHistory.diagnosticOnlyTransitionCount === 0, 'diagnostic-only seed should report zero diagnostic transitions before first transition event');
  assert(first.liveCandidateTransitionHistory.emptyStateReason === 'prior_observations_no_transitions', 'first snapshot history should mark prior_observations_no_transitions after baseline capture');
  const obsAfterFirst = countRows(db, OBS_TABLE);
  const trAfterFirst = countRows(db, TRANS_TABLE);
  assert(obsAfterFirst > 0, 'first snapshot should persist observations');
  assert(trAfterFirst === 0, 'first snapshot should not persist transitions');
  assert(
    countRowsBySource(db, OBS_TABLE, 'observation_write_source', LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC) > 0,
    'diagnostic writes should persist observation_write_source=endpoint_diagnostic'
  );

  const second = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    probability: 0.4,
    expectedValueDollars: -20,
    nowEt: '2026-04-16 10:11',
    latestSession: { no_trade_reason: 'no_confirmation' },
    db,
    monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
  }));
  const obsAfterSecond = countRows(db, OBS_TABLE);
  const trAfterSecond = countRows(db, TRANS_TABLE);
  assert(obsAfterSecond === obsAfterFirst, 'unchanged snapshot should suppress duplicate observation writes');
  assert(trAfterSecond === 0, 'unchanged snapshot should not create transitions');
  assert(second.liveCandidateTransitionHistory.emptyStateReason === 'prior_observations_no_transitions', 'second snapshot should mark prior_observations_no_transitions');

  const third = buildCommandCenterPanels(buildInput({
    signal: 'TRADE',
    probability: 0.79,
    expectedValueDollars: 72,
    nowEt: '2026-04-16 10:12',
    latestSession: {
      trade: {
        direction: 'long',
        entry_time: '2026-04-16 10:12',
        entry_price: 22140,
        sl_price: 22095,
        tp_price: 22200,
      },
    },
    db,
    monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
  }));

  const trAfterThird = countRows(db, TRANS_TABLE);
  assert(trAfterThird > trAfterSecond, 'changed actionable snapshot should persist transition rows');
  assert(third.liveCandidateStateMonitor.actionableTransitionDetected === true, 'changed actionable snapshot should detect actionable transition');
  assert(third.liveCandidateTransitionHistory.latestTransition && third.liveCandidateTransitionHistory.latestTransition.transitionType === 'crossed_into_actionable', 'latest transition should be crossed_into_actionable');
  const primaryCandidateKey = String(third.liveCandidateStateMonitor.candidateKey || third.liveOpportunityCandidates?.topCandidateOverall?.candidateKey || '').trim();
  assert(primaryCandidateKey.length > 0, 'expected primary candidate key for durable row assertions');
  const obsRowsForPrimaryAfterThird = countRowsForCandidate(db, OBS_TABLE, primaryCandidateKey);
  const transitionRowsForPrimaryAfterThird = countRowsForCandidate(db, TRANS_TABLE, primaryCandidateKey);

  const fourth = buildCommandCenterPanels(buildInput({
    signal: 'TRADE',
    probability: 0.79,
    expectedValueDollars: 72,
    nowEt: '2026-04-16 10:13',
    latestSession: {
      trade: {
        direction: 'long',
        entry_time: '2026-04-16 10:13',
        entry_price: 22140,
        sl_price: 22095,
        tp_price: 22200,
      },
    },
    db,
    monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
  }));

  const topMonitored = Array.isArray(fourth.liveCandidateStateMonitor.monitoredCandidates)
    ? fourth.liveCandidateStateMonitor.monitoredCandidates[0]
    : null;
  assert(topMonitored && topMonitored.previousStateSource === 'durable_sqlite', 'prior-state read should come from durable sqlite after restart-style monitor reset');
  const obsRowsForPrimaryAfterFourth = countRowsForCandidate(db, OBS_TABLE, primaryCandidateKey);
  const transitionRowsForPrimaryAfterFourth = countRowsForCandidate(db, TRANS_TABLE, primaryCandidateKey);
  const trAfterFourth = countRows(db, TRANS_TABLE);
  assert(obsRowsForPrimaryAfterFourth === obsRowsForPrimaryAfterThird, 'unchanged actionable snapshot should not keep appending observations for same candidate');
  assert(transitionRowsForPrimaryAfterFourth === transitionRowsForPrimaryAfterThird, 'unchanged actionable snapshot should not create extra transitions for same candidate');

  const fifth = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    probability: 0.4,
    expectedValueDollars: -20,
    nowEt: '2026-04-16 10:14',
    latestSession: { no_trade_reason: 'no_confirmation' },
    db,
    monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
  }));

  const latestTransition = fifth.liveCandidateTransitionHistory.latestTransition;
  assert(latestTransition && latestTransition.transitionType === 'dropped_out_of_actionable', 'drop back to poor structure should persist dropped_out_of_actionable transition');
  assert(fifth.liveCandidateStateMonitor.actionableTransitionDetected === false, 'drop snapshot should not set actionable transition true');
  assert(countRows(db, TRANS_TABLE) > trAfterFourth, 'drop snapshot should add another durable transition row');
  assert(
    countRowsBySource(db, TRANS_TABLE, 'transition_write_source', LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC) > 0,
    'diagnostic writes should persist transition_write_source=endpoint_diagnostic'
  );

  db.close();

  {
    const mixedDb = new Database(':memory:');
    const monitorState = { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] };

    buildCommandCenterPanels(buildInput({
      signal: 'WAIT',
      probability: 0.4,
      expectedValueDollars: -18,
      nowEt: '2026-04-16 10:20',
      latestSession: { no_trade_reason: 'no_confirmation' },
      db: mixedDb,
      monitorState,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    }));
    buildCommandCenterPanels(buildInput({
      signal: 'TRADE',
      probability: 0.82,
      expectedValueDollars: 84,
      nowEt: '2026-04-16 10:21',
      latestSession: {
        trade: {
          direction: 'long',
          entry_time: '2026-04-16 10:21',
          entry_price: 22140,
          sl_price: 22095,
          tp_price: 22200,
        },
      },
      db: mixedDb,
      monitorState,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    }));

    const mixed = buildCommandCenterPanels(buildInput({
      signal: 'WAIT',
      probability: 0.42,
      expectedValueDollars: -22,
      nowEt: '2026-04-16 10:22',
      latestSession: { no_trade_reason: 'no_confirmation' },
      db: mixedDb,
      monitorState,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
    }));

    assert(mixed.liveCandidateStateMonitor.historyProvenanceClassification === 'mixed_loop_and_endpoint', 'mixed run should classify monitor history as mixed_loop_and_endpoint');
    assert(mixed.liveCandidateStateMonitor.loopOnlyObservationCount > 0, 'mixed run should expose loop-only observation count');
    assert(mixed.liveCandidateStateMonitor.diagnosticOnlyObservationCount > 0, 'mixed run should expose diagnostic-only observation count');
    assert(mixed.liveCandidateTransitionHistory.loopOnlyTransitionCount > 0, 'mixed run should expose loop-only transition count');
    assert(mixed.liveCandidateTransitionHistory.diagnosticOnlyTransitionCount > 0, 'mixed run should expose diagnostic-only transition count');
    assert(
      String(mixed.liveCandidateTransitionHistory.loopOnlyLatestTransition?.transitionWriteSource || '') === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      'loop-only latest transition should come from loop_auto rows'
    );
    assert(
      String(mixed.liveCandidateTransitionHistory.diagnosticOnlyLatestTransition?.transitionWriteSource || '') === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
      'diagnostic-only latest transition should come from endpoint_diagnostic rows'
    );
    assert(
      Array.isArray(mixed.liveCandidateTransitionHistory.loopOnlyRecentTransitions)
      && mixed.liveCandidateTransitionHistory.loopOnlyRecentTransitions.every(
        (row) => String(row?.transitionWriteSource || '') === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO
      ),
      'loop-only transition view should exclude endpoint_diagnostic rows'
    );
    assert(
      Array.isArray(mixed.liveCandidateStateMonitor.loopOnlyRecentObservations)
      && mixed.liveCandidateStateMonitor.loopOnlyRecentObservations.every(
        (row) => String(row?.observationWriteSource || '') === LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO
      ),
      'loop-only observation view should exclude endpoint_diagnostic rows'
    );

    const beforeReadOnlyObs = countRows(mixedDb, OBS_TABLE);
    const beforeReadOnlyTr = countRows(mixedDb, TRANS_TABLE);
    const readOnlyMixed = buildCommandCenterPanels(buildInput({
      signal: 'WAIT',
      probability: 0.42,
      expectedValueDollars: -22,
      nowEt: '2026-04-16 10:23',
      latestSession: { no_trade_reason: 'no_confirmation' },
      db: mixedDb,
      monitorState,
      persistLiveCandidateState: false,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
    }));
    assert(readOnlyMixed.liveCandidateStateMonitor.responseReadOnly === true, 'read-only mixed snapshot should stay read-only');
    assert(countRows(mixedDb, OBS_TABLE) === beforeReadOnlyObs, 'read-only mixed snapshot should not add observation rows');
    assert(countRows(mixedDb, TRANS_TABLE) === beforeReadOnlyTr, 'read-only mixed snapshot should not add transition rows');
    mixedDb.close();
  }

  console.log('Jarvis live candidate state persistence test passed.');
}

run();
