#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  buildStrategyLayerSnapshot,
  buildCommandCenterPanels,
  buildLiveCandidateHistoryStatusCalibrationDiagnostics,
  buildLiveCandidateHistoryActionInterpretation,
  buildLiveCandidateHistoryActionInterpretationAudit,
  buildLiveCandidateHistoryConfirmationGuide,
  buildLiveCandidateHistoryConfirmationGuideAudit,
  buildLiveCandidateTradeTriggerCard,
  buildLiveCandidateTradeTriggerCardAudit,
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

function countRowsBySession(db, table, sessionDate) {
  return Number(
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_date = ?`).get(String(sessionDate || '').trim())?.c || 0
  );
}

function insertObservation(db, row = {}) {
  db.prepare(`
    INSERT INTO ${OBS_TABLE} (
      observed_at,
      session_date,
      candidate_key,
      strategy_key,
      candidate_source,
      candidate_status,
      structure_quality_score,
      structure_quality_label,
      candidate_win_prob,
      candidate_expected_value,
      inside_approved_action_window,
      actionable_now,
      observation_write_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(row.observed_at || '2026-04-17 10:00'),
    String(row.session_date || '2026-04-17'),
    String(row.candidate_key || 'strategy_stack:closer_tp_variant:test:long:entry_window'),
    String(row.strategy_key || 'closer_tp_variant'),
    String(row.candidate_source || 'strategy_stack'),
    String(row.candidate_status || 'watch_trigger'),
    Number(row.structure_quality_score ?? 60),
    String(row.structure_quality_label || 'mixed'),
    Number(row.candidate_win_prob ?? 55),
    Number(row.candidate_expected_value ?? 5),
    Number(row.inside_approved_action_window === true ? 1 : 0),
    Number(row.actionable_now === true ? 1 : 0),
    String(row.observation_write_source || LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO)
  );
}

function insertTransition(db, row = {}) {
  db.prepare(`
    INSERT INTO ${TRANS_TABLE} (
      transition_at,
      session_date,
      candidate_key,
      previous_status,
      current_status,
      previous_structure_quality_score,
      current_structure_quality_score,
      previous_actionable,
      current_actionable,
      transition_type,
      transition_summary_line,
      transition_write_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(row.transition_at || '2026-04-17 10:01'),
    String(row.session_date || '2026-04-17'),
    String(row.candidate_key || 'strategy_stack:closer_tp_variant:test:long:entry_window'),
    String(row.previous_status || 'watch_trigger'),
    String(row.current_status || 'secondary_watch'),
    Number(row.previous_structure_quality_score ?? 55),
    Number(row.current_structure_quality_score ?? 62),
    Number(row.previous_actionable === true ? 1 : 0),
    Number(row.current_actionable === true ? 1 : 0),
    String(row.transition_type || 'structure_improved'),
    String(row.transition_summary_line || 'structure improved'),
    String(row.transition_write_source || LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO)
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
  assert(first.liveCandidateStateMonitor.historyEvaluationMode === 'all_history', 'diagnostic-only seed should fallback monitor interpretation to all_history');
  assert(first.liveCandidateStateMonitor.historyEvaluationFallbackUsed === true, 'diagnostic-only seed should mark monitor fallback used');
  assert(String(first.liveCandidateStateMonitor.historyEvaluationFallbackReason || '').includes('loop_history_sparse'), 'diagnostic-only seed should surface monitor fallback reason');
  assert(first.liveCandidateTransitionHistory.loopOnlyTransitionCount === 0, 'diagnostic-only seed should report zero loop-only transitions');
  assert(first.liveCandidateTransitionHistory.diagnosticOnlyTransitionCount === 0, 'diagnostic-only seed should report zero diagnostic transitions before first transition event');
  assert(first.liveCandidateTransitionHistory.historyEvaluationMode === 'all_history', 'diagnostic-only seed should fallback transition interpretation to all_history');
  assert(first.liveCandidateTransitionHistory.historyEvaluationFallbackUsed === true, 'diagnostic-only seed should mark transition fallback used');
  assert(String(first.liveCandidateTransitionHistory.historyEvaluationFallbackReason || '').includes('loop_history_sparse'), 'diagnostic-only seed should surface transition fallback reason');
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
    const fallbackDb = new Database(':memory:');
    const activeMonitorState = { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] };
    buildCommandCenterPanels(buildInput({
      signal: 'WAIT',
      probability: 0.41,
      expectedValueDollars: -12,
      nowEt: '2026-04-17 10:10',
      latestSession: { no_trade_reason: 'no_confirmation' },
      db: fallbackDb,
      monitorState: activeMonitorState,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    }));
    buildCommandCenterPanels(buildInput({
      signal: 'TRADE',
      probability: 0.83,
      expectedValueDollars: 95,
      nowEt: '2026-04-17 10:11',
      latestSession: {
        trade: {
          direction: 'long',
          entry_time: '2026-04-17 10:11',
          entry_price: 22144,
          sl_price: 22098,
          tp_price: 22208,
        },
      },
      db: fallbackDb,
      monitorState: activeMonitorState,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    }));

    const obsForPrevSession = countRowsBySession(fallbackDb, OBS_TABLE, '2026-04-17');
    const trForPrevSession = countRowsBySession(fallbackDb, TRANS_TABLE, '2026-04-17');
    assert(obsForPrevSession > 0, 'fallback fixture should persist observations on previous session date');
    assert(trForPrevSession > 0, 'fallback fixture should persist transitions on previous session date');

    const restartedRead = buildCommandCenterPanels(buildInput({
      signal: 'WAIT',
      probability: 0.39,
      expectedValueDollars: -18,
      nowEt: '2026-04-18 10:01',
      latestSession: { no_trade_reason: 'outside_window' },
      db: fallbackDb,
      monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
      persistLiveCandidateState: false,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    }));

    assert(restartedRead.liveCandidateStateMonitor.responseReadOnly === true, 'restart read should remain read-only');
    assert(restartedRead.liveCandidateStateMonitor.historyDebugRequestedSessionDate === '2026-04-18', 'requested session should reflect current runtime date');
    assert(restartedRead.liveCandidateStateMonitor.historyDebugEffectiveSessionDate === '2026-04-17', 'effective session should fallback to latest populated session date');
    assert(restartedRead.liveCandidateStateMonitor.historyDebugRowScope === 'latest_available_session_date', 'monitor row scope should report latest_available_session_date fallback');
    assert(restartedRead.liveCandidateStateMonitor.historyDebugRowScopeFallbackUsed === true, 'monitor row-scope fallback should be explicit');
    assert(
      restartedRead.liveCandidateStateMonitor.historyDebugRowScopeFallbackReason === 'requested_session_empty_using_latest_available_session_date',
      'monitor fallback reason should explain requested session empty fallback'
    );
    assert(restartedRead.liveCandidateStateMonitor.historyEvaluationMode === 'loop_only', 'loop-only interpretation should remain primary on populated loop rows');
    assert(restartedRead.liveCandidateStateMonitor.durableObservationCount === obsForPrevSession, 'monitor durableObservationCount should match fallback effective session rows');
    assert(restartedRead.liveCandidateStateMonitor.durableTransitionCount === trForPrevSession, 'monitor durableTransitionCount should match fallback effective session rows');
    assert(restartedRead.liveCandidateTransitionHistory.historyDebugRequestedSessionDate === '2026-04-18', 'transition history requested session should reflect current runtime date');
    assert(restartedRead.liveCandidateTransitionHistory.historyDebugEffectiveSessionDate === '2026-04-17', 'transition history effective session should fallback to latest populated session date');
    assert(restartedRead.liveCandidateTransitionHistory.historyDebugRowScopeFallbackUsed === true, 'transition history row-scope fallback should be explicit');
    assert(restartedRead.liveCandidateTransitionHistory.totalObservationRows === obsForPrevSession, 'transition history observation count should match fallback effective session rows');
    assert(restartedRead.liveCandidateTransitionHistory.totalTransitionRows === trForPrevSession, 'transition history transition count should match fallback effective session rows');
    fallbackDb.close();
  }

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
    assert(mixed.liveCandidateStateMonitor.historyEvaluationMode === 'loop_only', 'mixed run should default monitor interpretation to loop_only');
    assert(mixed.liveCandidateStateMonitor.historyEvaluationFallbackUsed === false, 'mixed run should not fallback monitor interpretation when loop-only is sufficient');
    assert(mixed.liveCandidateTransitionHistory.loopOnlyTransitionCount > 0, 'mixed run should expose loop-only transition count');
    assert(mixed.liveCandidateTransitionHistory.diagnosticOnlyTransitionCount > 0, 'mixed run should expose diagnostic-only transition count');
    assert(mixed.liveCandidateTransitionHistory.historyEvaluationMode === 'loop_only', 'mixed run should default transition interpretation to loop_only');
    assert(mixed.liveCandidateTransitionHistory.historyEvaluationFallbackUsed === false, 'mixed run should not fallback transition interpretation when loop-only is sufficient');
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

  {
    const makeReadSnapshot = ({ db, nowEt = '2026-04-18 10:05' }) => buildCommandCenterPanels(buildInput({
      signal: 'WAIT',
      probability: 0.41,
      expectedValueDollars: -14,
      nowEt,
      latestSession: { no_trade_reason: 'outside_window' },
      db,
      monitorState: { candidateStates: Object.create(null), observationHistoryByCandidate: Object.create(null), transitionRows: [] },
      persistLiveCandidateState: false,
      observationWriteSource: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
    }));

    const sparseDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: sparseDb, persistLiveCandidateState: false }));
    insertObservation(sparseDb, {
      observed_at: '2026-04-17 10:00',
      candidate_status: 'watch_trigger',
      structure_quality_score: 58,
      structure_quality_label: 'mixed',
      candidate_expected_value: 2,
      actionable_now: false,
      observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    const sparseSnapshot = makeReadSnapshot({ db: sparseDb });
    assert(sparseSnapshot.liveCandidateHistoryJudgment && typeof sparseSnapshot.liveCandidateHistoryJudgment === 'object', 'sparse case should surface liveCandidateHistoryJudgment');
    assert(sparseSnapshot.liveCandidateHistoryJudgmentAudit && typeof sparseSnapshot.liveCandidateHistoryJudgmentAudit === 'object', 'sparse case should surface liveCandidateHistoryJudgmentAudit');
    assert(sparseSnapshot.liveCandidateHistoryJudgment.modeUsed === 'loop_only', 'sparse case should stay loop_only');
    assert(sparseSnapshot.liveCandidateHistoryJudgment.sparseHistory === true, 'sparse case should mark sparseHistory true');
    assert(['insufficient_loop_observations', 'insufficient_loop_transitions', 'insufficient_supportive_signal'].includes(String(sparseSnapshot.liveCandidateHistoryJudgment.sparseReason || '')), 'sparse case should expose explicit sparseReason');
    assert(typeof sparseSnapshot.liveCandidateHistoryJudgment.confidenceReason === 'string' && sparseSnapshot.liveCandidateHistoryJudgment.confidenceReason.length > 0, 'sparse case should surface confidenceReason');
    assert(Array.isArray(sparseSnapshot.liveCandidateHistoryJudgment.confidenceDrivers), 'sparse case should surface confidenceDrivers');
    assert(Array.isArray(sparseSnapshot.liveCandidateHistoryJudgment.confidencePenaltyReasons), 'sparse case should surface confidencePenaltyReasons');
    assert(sparseSnapshot.liveCandidateHistoryJudgmentAudit.sampleSize >= 1, 'sparse case audit should classify at least one row');
    assert(Array.isArray(sparseSnapshot.liveCandidateHistoryJudgmentAudit.recentClassifiedRows), 'sparse case audit should include recentClassifiedRows');
    assert(sparseSnapshot.liveCandidateHistoryStatusCalibration && typeof sparseSnapshot.liveCandidateHistoryStatusCalibration === 'object', 'sparse case should surface status calibration object');
    assert(sparseSnapshot.liveCandidateHistoryActionInterpretation && typeof sparseSnapshot.liveCandidateHistoryActionInterpretation === 'object', 'sparse case should surface action interpretation');
    assert(sparseSnapshot.liveCandidateHistoryActionInterpretation.actionStance === 'neutral_wait', 'sparse case should map to neutral_wait action stance');
    assert(sparseSnapshot.liveCandidateHistoryActionInterpretation.requiresFreshConfirmation === true, 'sparse case should require fresh confirmation');
    assert(sparseSnapshot.liveCandidateHistoryActionInterpretationAudit && typeof sparseSnapshot.liveCandidateHistoryActionInterpretationAudit === 'object', 'sparse case should surface action interpretation audit');
    assert(sparseSnapshot.liveCandidateHistoryConfirmationGuide && typeof sparseSnapshot.liveCandidateHistoryConfirmationGuide === 'object', 'sparse case should surface confirmation guide');
    assert(sparseSnapshot.liveCandidateHistoryConfirmationGuide.confirmationState === 'waiting_for_confirmation', 'sparse case should wait for confirmation');
    assert(Array.isArray(sparseSnapshot.liveCandidateHistoryConfirmationGuide.confirmationTriggers), 'sparse case should include confirmationTriggers');
    assert(Array.isArray(sparseSnapshot.liveCandidateHistoryConfirmationGuide.confirmationFailures), 'sparse case should include confirmationFailures');
    assert(sparseSnapshot.liveCandidateHistoryConfirmationGuideAudit && typeof sparseSnapshot.liveCandidateHistoryConfirmationGuideAudit === 'object', 'sparse case should surface confirmation guide audit');
    assert(sparseSnapshot.liveCandidateTradeTriggerCard && typeof sparseSnapshot.liveCandidateTradeTriggerCard === 'object', 'sparse case should surface trade trigger card');
    assert(sparseSnapshot.liveCandidateTradeTriggerCard.confirmationState === 'waiting_for_confirmation', 'sparse case trade trigger should keep waiting_for_confirmation');
    assert(['waiting_for_confirmation', 'blocked'].includes(String(sparseSnapshot.liveCandidateTradeTriggerCard.currentState || '')), 'sparse case trade trigger should remain waiting/blocked');
    assert(sparseSnapshot.liveCandidateTradeTriggerCardAudit && typeof sparseSnapshot.liveCandidateTradeTriggerCardAudit === 'object', 'sparse case should surface trade trigger card audit');
    sparseDb.close();

    const diagOnlyDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: diagOnlyDb, persistLiveCandidateState: false }));
    for (let i = 0; i < 8; i += 1) {
      insertObservation(diagOnlyDb, {
        observed_at: `2026-04-17 10:${String(i).padStart(2, '0')}`,
        candidate_status: 'ready_now',
        structure_quality_score: 74,
        structure_quality_label: 'clean',
        candidate_expected_value: 18,
        actionable_now: true,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      insertTransition(diagOnlyDb, {
        transition_at: `2026-04-17 10:${String(20 + i).padStart(2, '0')}`,
        transition_type: 'crossed_into_actionable',
        previous_status: 'watch_trigger',
        current_status: 'ready_now',
        previous_actionable: false,
        current_actionable: true,
        transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_ENDPOINT_DIAGNOSTIC,
      });
    }
    const diagOnlySnapshot = makeReadSnapshot({ db: diagOnlyDb });
    assert(diagOnlySnapshot.liveCandidateStateMonitor.diagnosticOnlyObservationCount > 0, 'diagnostic-only fixture should have diagnostic observations');
    assert(diagOnlySnapshot.liveCandidateStateMonitor.loopOnlyObservationCount === 0, 'diagnostic-only fixture should have zero loop observations');
    assert(diagOnlySnapshot.liveCandidateHistoryJudgment.modeUsed === 'loop_only', 'diagnostic-only fixture should keep judgment mode loop_only');
    assert(diagOnlySnapshot.liveCandidateHistoryJudgment.sparseHistory === true, 'diagnostic-only fixture should remain sparse (no loop history)');
    assert(diagOnlySnapshot.liveCandidateHistoryJudgment.sparseReason === 'no_loop_history', 'diagnostic-only fixture should surface no_loop_history');
    assert(diagOnlySnapshot.liveCandidateHistoryJudgmentAudit.sampleSize === 0, 'diagnostic-only fixture should produce zero loop-only classified rows');
    assert(Array.isArray(diagOnlySnapshot.liveCandidateHistoryJudgmentAudit.dominantUnsupportiveRules), 'diagnostic-only fixture should expose dominant unsupportive rules array');
    assert(diagOnlySnapshot.liveCandidateHistoryStatusCalibration.statusEvidence && typeof diagOnlySnapshot.liveCandidateHistoryStatusCalibration.statusEvidence === 'object', 'diagnostic-only fixture should surface statusEvidence');
    assert(diagOnlySnapshot.liveCandidateHistoryActionInterpretation.actionStance === 'neutral_wait', 'diagnostic-only sparse loop history should map to neutral_wait');
    assert(diagOnlySnapshot.liveCandidateHistoryActionInterpretationAudit.ruleUsed === 'sparse_history_neutral_wait', 'diagnostic-only sparse loop history should use sparse rule');
    assert(diagOnlySnapshot.liveCandidateHistoryConfirmationGuide.confirmationState === 'waiting_for_confirmation', 'diagnostic-only sparse loop history should wait for confirmation');
    assert(diagOnlySnapshot.liveCandidateHistoryConfirmationGuideAudit.ruleUsed === 'sparse_waiting_for_confirmation', 'diagnostic-only sparse loop history should use sparse confirmation rule');
    assert(diagOnlySnapshot.liveCandidateTradeTriggerCard && typeof diagOnlySnapshot.liveCandidateTradeTriggerCard === 'object', 'diagnostic-only sparse loop history should surface trade trigger card');
    assert(diagOnlySnapshot.liveCandidateTradeTriggerCard.riskBucket === 'no_trade', 'diagnostic-only sparse loop history should remain no_trade');
    assert(diagOnlySnapshot.liveCandidateTradeTriggerCard.sizeGuidance === 'none', 'diagnostic-only sparse loop history should keep sizeGuidance none');
    assert(diagOnlySnapshot.liveCandidateTradeTriggerCardAudit && typeof diagOnlySnapshot.liveCandidateTradeTriggerCardAudit === 'object', 'diagnostic-only sparse loop history should surface trade trigger card audit');
    diagOnlyDb.close();

    const preOpenDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: preOpenDb, persistLiveCandidateState: false }));
    for (let i = 0; i < 8; i += 1) {
      insertObservation(preOpenDb, {
        observed_at: `2026-04-17 09:${String(40 + i).padStart(2, '0')}`,
        candidate_status: 'pre_open_watch',
        structure_quality_score: 67,
        structure_quality_label: 'clean',
        candidate_expected_value: 12,
        actionable_now: false,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    insertTransition(preOpenDb, {
      transition_at: '2026-04-17 09:55',
      transition_type: 'status_changed',
      previous_status: 'watch_trigger',
      current_status: 'pre_open_watch',
      previous_actionable: false,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    insertTransition(preOpenDb, {
      transition_at: '2026-04-17 09:56',
      transition_type: 'structure_improved',
      previous_status: 'pre_open_watch',
      current_status: 'pre_open_watch',
      previous_actionable: false,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    const preOpenSnapshot = makeReadSnapshot({ db: preOpenDb, nowEt: '2026-04-17 10:01' });
    assert(preOpenSnapshot.liveCandidateHistoryJudgment.unsupportiveCount === 0, 'pre_open fixture should not auto-classify pre_open rows as unsupportive');
    assert(typeof preOpenSnapshot.liveCandidateHistoryJudgment.directionVsTransitionTension === 'boolean', 'pre_open fixture should surface directionVsTransitionTension');
    assert(typeof preOpenSnapshot.liveCandidateHistoryJudgment.directionVsTransitionSummaryLine === 'string' && preOpenSnapshot.liveCandidateHistoryJudgment.directionVsTransitionSummaryLine.length > 0, 'pre_open fixture should surface directionVsTransitionSummaryLine');
    assert(preOpenSnapshot.liveCandidateHistoryStatusCalibration.statusEvidence.pre_open_watch.sampledRowCount >= 1, 'pre_open fixture should expose pre_open_watch status evidence');
    assert(preOpenSnapshot.liveCandidateHistoryStatusCalibration.statusRuleMap.pre_open_watch.directionalEffect === 'neutral', 'pre_open status map should mark directional neutral');
    const preOpenDominant = Array.isArray(preOpenSnapshot.liveCandidateHistoryStatusCalibration.dominantStatusEffects)
      ? preOpenSnapshot.liveCandidateHistoryStatusCalibration.dominantStatusEffects.find((entry) => String(entry?.status || '') === 'pre_open_watch')
      : null;
    assert(preOpenDominant && preOpenDominant.directionalEffect === 'neutral', 'pre_open dominant status effect should remain neutral under calibrated map');
    assert(!String(preOpenSnapshot.liveCandidateHistoryStatusCalibration.summaryLine || '').includes('pre_open_watch (unsupportive)'), 'pre_open summary should not describe pre_open_watch as unsupportive');
    assert(preOpenSnapshot.liveCandidateHistoryJudgmentAudit.neutralRuleHits.observation_status_pre_open_watch_context_neutral >= 1, 'pre_open fixture should track context-neutral pre_open rule hits');
    assert(preOpenSnapshot.liveCandidateHistoryJudgment.confidencePenaltyReasons.includes('context_only_status_dominance'), 'pre_open fixture should apply context-only confidence penalty');
    assert(preOpenSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics && typeof preOpenSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics === 'object', 'pre_open fixture should surface status calibration diagnostics');
    assert(preOpenSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics.consistent === true, 'pre_open fixture should report consistent status calibration diagnostics');
    preOpenDb.close();

    const supportiveDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: supportiveDb, persistLiveCandidateState: false }));
    for (let i = 0; i < 10; i += 1) {
      insertObservation(supportiveDb, {
        observed_at: `2026-04-17 10:${String(i).padStart(2, '0')}`,
        candidate_status: 'ready_now',
        structure_quality_score: 72,
        structure_quality_label: 'clean',
        candidate_expected_value: 16,
        actionable_now: true,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    insertTransition(supportiveDb, {
      transition_at: '2026-04-17 10:30',
      transition_type: 'crossed_into_actionable',
      previous_status: 'watch_trigger',
      current_status: 'ready_now',
      previous_actionable: false,
      current_actionable: true,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    insertTransition(supportiveDb, {
      transition_at: '2026-04-17 10:31',
      transition_type: 'structure_improved',
      previous_status: 'secondary_watch',
      current_status: 'secondary_watch',
      previous_actionable: false,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    insertTransition(supportiveDb, {
      transition_at: '2026-04-17 10:32',
      transition_type: 'status_changed',
      previous_status: 'watch_trigger',
      current_status: 'secondary_watch',
      previous_actionable: false,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    const supportiveSnapshot = makeReadSnapshot({ db: supportiveDb });
    assert(supportiveSnapshot.liveCandidateHistoryJudgment.sparseHistory === false, 'supportive fixture should not be sparse');
    assert(supportiveSnapshot.liveCandidateHistoryJudgment.judgment === 'supportive', 'supportive fixture should classify as supportive');
    assert(supportiveSnapshot.liveCandidateHistoryJudgment.recentTransitionBias === 'improving', 'supportive fixture should classify transition bias as improving');
    assert(supportiveSnapshot.liveCandidateHistoryJudgment.supportiveCount > supportiveSnapshot.liveCandidateHistoryJudgment.unsupportiveCount, 'supportive fixture should have supportive edge');
    assert(supportiveSnapshot.liveCandidateHistoryJudgmentAudit.supportiveRuleHits.observation_actionable_now_true >= 1, 'supportive fixture should expose supportive observation rule hit');
    assert(supportiveSnapshot.liveCandidateHistoryJudgmentAudit.dominantSupportiveRules.length > 0, 'supportive fixture should expose dominant supportive rules');
    assert(supportiveSnapshot.liveCandidateHistoryJudgment.confidenceLabel !== 'low', 'supportive fixture should not be low-confidence');
    assert(['supportive_followthrough', 'early_reversal_watch'].includes(String(supportiveSnapshot.liveCandidateHistoryActionInterpretation.actionStance || '')), 'supportive fixture should surface constructive action interpretation');
    assert(['confirmed', 'not_needed'].includes(String(supportiveSnapshot.liveCandidateHistoryConfirmationGuide.confirmationState || '')), 'supportive fixture should be confirmed or not_needed');
    assert(supportiveSnapshot.liveCandidateTradeTriggerCard && typeof supportiveSnapshot.liveCandidateTradeTriggerCard === 'object', 'supportive fixture should surface trade trigger card');
    assert(['confirmed_supportive', 'confirmed_defensive', 'partially_constructive', 'waiting_for_confirmation', 'blocked'].includes(String(supportiveSnapshot.liveCandidateTradeTriggerCard.currentState || '')), 'supportive fixture should surface deterministic trade-trigger state');
    assert(['full_size', 'half_size', 'quarter_size', 'none'].includes(String(supportiveSnapshot.liveCandidateTradeTriggerCard.sizeGuidance || '')), 'supportive fixture should provide deterministic size guidance');
    assert(supportiveSnapshot.liveCandidateTradeTriggerCardAudit && typeof supportiveSnapshot.liveCandidateTradeTriggerCardAudit === 'object', 'supportive fixture should surface trade trigger card audit');
    supportiveDb.close();

    const weakDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: weakDb, persistLiveCandidateState: false }));
    for (let i = 0; i < 10; i += 1) {
      insertObservation(weakDb, {
        observed_at: `2026-04-17 11:${String(i).padStart(2, '0')}`,
        candidate_status: 'blocked',
        structure_quality_score: 12,
        structure_quality_label: 'poor',
        candidate_expected_value: -35,
        actionable_now: false,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    insertTransition(weakDb, {
      transition_at: '2026-04-17 11:30',
      transition_type: 'dropped_out_of_actionable',
      previous_status: 'ready_now',
      current_status: 'watch_trigger',
      previous_actionable: true,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    insertTransition(weakDb, {
      transition_at: '2026-04-17 11:31',
      transition_type: 'structure_worsened',
      previous_status: 'watch_trigger',
      current_status: 'watch_trigger',
      previous_actionable: false,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    insertTransition(weakDb, {
      transition_at: '2026-04-17 11:32',
      transition_type: 'status_changed',
      previous_status: 'watch_trigger',
      current_status: 'blocked',
      previous_actionable: false,
      current_actionable: false,
      transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
    });
    const weakSnapshot = makeReadSnapshot({ db: weakDb });
    assert(weakSnapshot.liveCandidateHistoryJudgment.sparseHistory === false, 'weak fixture should not be sparse');
    assert(weakSnapshot.liveCandidateHistoryJudgment.judgment === 'weak', 'weak fixture should classify as weak');
    assert(weakSnapshot.liveCandidateHistoryJudgment.recentTransitionBias === 'deteriorating', 'weak fixture should classify transition bias as deteriorating');
    assert(weakSnapshot.liveCandidateHistoryJudgment.directionVsTransitionTension === false, 'weak fixture should not mark direction-vs-transition tension when both are deteriorating');
    assert(weakSnapshot.liveCandidateHistoryJudgment.unsupportiveCount > weakSnapshot.liveCandidateHistoryJudgment.supportiveCount, 'weak fixture should have unsupportive edge');
    assert(weakSnapshot.liveCandidateHistoryJudgmentAudit.unsupportiveRuleHits.observation_status_blocked_poor_structure >= 1, 'weak fixture should expose blocked-poor-structure unsupportive rule hit');
    assert(weakSnapshot.liveCandidateHistoryJudgmentAudit.dominantUnsupportiveRules.length > 0, 'weak fixture should expose dominant unsupportive rules');
    assert(weakSnapshot.liveCandidateHistoryJudgment.confidenceReason.toLowerCase().includes('unsupportive'), 'weak fixture confidence reason should explain unsupportive majority');
    assert(weakSnapshot.liveCandidateHistoryJudgmentAudit.recentClassifiedRows.every((row) => Array.isArray(row.ruleHits)), 'weak fixture recent classified rows should include ruleHits');
    assert(weakSnapshot.liveCandidateHistoryStatusCalibration.statusRuleMap.blocked.treatment === 'unsupportive_if_quality_negative_else_neutral', 'weak fixture should expose blocked split treatment');
    assert(weakSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics && weakSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics.consistent === true, 'weak fixture should report consistent status calibration diagnostics');
    assert(weakSnapshot.liveCandidateHistoryActionInterpretation.actionStance === 'avoid', 'weak deteriorating fixture should map to avoid');
    assert(weakSnapshot.liveCandidateHistoryActionInterpretation.actionBias === 'defensive', 'weak deteriorating fixture should remain defensive');
    assert(weakSnapshot.liveCandidateHistoryActionInterpretation.confidenceImpact === 'reinforces', 'weak deteriorating fixture should reinforce directional weakness');
    assert(weakSnapshot.liveCandidateHistoryActionInterpretationAudit.ruleUsed === 'weak_deteriorating_avoid', 'weak deteriorating fixture should expose deterministic action rule');
    assert(['failed_confirmation', 'waiting_for_confirmation'].includes(String(weakSnapshot.liveCandidateHistoryConfirmationGuide.confirmationState || '')), 'avoid fixture should map to failed_confirmation or waiting_for_confirmation');
    assert(weakSnapshot.liveCandidateTradeTriggerCard && typeof weakSnapshot.liveCandidateTradeTriggerCard === 'object', 'weak fixture should surface trade trigger card');
    assert(weakSnapshot.liveCandidateTradeTriggerCard.currentState === 'blocked', 'weak fixture should map trade trigger currentState to blocked');
    assert(weakSnapshot.liveCandidateTradeTriggerCard.riskBucket === 'no_trade', 'weak fixture should remain no_trade');
    assert(weakSnapshot.liveCandidateTradeTriggerCard.sizeGuidance === 'none', 'weak fixture should keep size none');
    assert(weakSnapshot.liveCandidateTradeTriggerCardAudit && typeof weakSnapshot.liveCandidateTradeTriggerCardAudit === 'object', 'weak fixture should surface trade trigger card audit');
    weakDb.close();

    const tensionDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: tensionDb, persistLiveCandidateState: false }));
    for (let i = 0; i < 12; i += 1) {
      insertObservation(tensionDb, {
        observed_at: `2026-04-17 11:${String(i).padStart(2, '0')}`,
        candidate_status: 'blocked',
        structure_quality_score: 15,
        structure_quality_label: 'poor',
        candidate_expected_value: -28,
        actionable_now: false,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    for (let i = 0; i < 10; i += 1) {
      insertTransition(tensionDb, {
        transition_at: `2026-04-17 11:${String(30 + i).padStart(2, '0')}`,
        transition_type: 'structure_improved',
        previous_status: 'watch_trigger',
        current_status: 'watch_trigger',
        previous_actionable: false,
        current_actionable: false,
        transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    const tensionSnapshot = makeReadSnapshot({ db: tensionDb });
    assert(tensionSnapshot.liveCandidateHistoryJudgment.judgment === 'weak', 'tension fixture should keep weak overall direction');
    assert(tensionSnapshot.liveCandidateHistoryJudgment.recentTransitionBias === 'improving', 'tension fixture should mark improving transition bias');
    assert(tensionSnapshot.liveCandidateHistoryJudgment.directionVsTransitionTension === true, 'tension fixture should detect direction-vs-transition tension');
    assert(String(tensionSnapshot.liveCandidateHistoryJudgment.directionVsTransitionSummaryLine || '').toLowerCase().includes('improving'), 'tension fixture summary should mention improving transitions');
    assert(
      tensionSnapshot.liveCandidateHistoryJudgment.confidencePenaltyReasons.includes('recent_transition_bias_conflicts_with_overall_direction')
      || tensionSnapshot.liveCandidateHistoryJudgment.confidenceDrivers.includes('overall_direction_still_dominates_recent_transition_conflict'),
      'tension fixture should surface explicit confidence reconciliation rule'
    );
    assert(tensionSnapshot.liveCandidateHistoryActionInterpretation.actionStance === 'stabilization_watch', 'weak improving tension fixture should map to stabilization_watch');
    assert(tensionSnapshot.liveCandidateHistoryActionInterpretation.actionBias === 'defensive', 'weak improving tension fixture should stay defensive');
    assert(tensionSnapshot.liveCandidateHistoryActionInterpretation.confidenceImpact === 'conflicts', 'weak improving tension fixture should mark confidence conflict');
    assert(tensionSnapshot.liveCandidateHistoryActionInterpretation.requiresFreshConfirmation === true, 'weak improving tension fixture should require fresh confirmation');
    assert(tensionSnapshot.liveCandidateHistoryActionInterpretationAudit.tensionCase === 'weak_overall_improving_recent', 'weak improving tension fixture should expose tension case');
    assert(tensionSnapshot.liveCandidateHistoryConfirmationGuide && typeof tensionSnapshot.liveCandidateHistoryConfirmationGuide === 'object', 'weak improving tension fixture should surface confirmation guide');
    assert(tensionSnapshot.liveCandidateHistoryConfirmationGuide.confirmationState === 'waiting_for_confirmation', 'stabilization_watch should map to waiting_for_confirmation');
    assert(Array.isArray(tensionSnapshot.liveCandidateHistoryConfirmationGuide.confirmationTriggers), 'stabilization_watch should include confirmation trigger list');
    assert(Array.isArray(tensionSnapshot.liveCandidateHistoryConfirmationGuide.confirmationFailures), 'stabilization_watch should include confirmation failure list');
    assert(tensionSnapshot.liveCandidateHistoryConfirmationGuide.nextBestStateIfConfirmed === 'early_reversal_watch', 'stabilization_watch should expose next state if confirmed');
    assert(tensionSnapshot.liveCandidateHistoryConfirmationGuideAudit && typeof tensionSnapshot.liveCandidateHistoryConfirmationGuideAudit === 'object', 'stabilization_watch should surface confirmation guide audit');
    assert(Array.isArray(tensionSnapshot.liveCandidateHistoryConfirmationGuideAudit.unmetCriticalTriggers), 'stabilization_watch audit should include unmetCriticalTriggers');
    assert(tensionSnapshot.liveCandidateHistoryConfirmationGuideAudit.unmetCriticalTriggers.includes('structure_constructive_now'), 'stabilization_watch should require structure_constructive_now');
    assert(tensionSnapshot.liveCandidateHistoryConfirmationGuideAudit.unmetCriticalTriggers.includes('actionability_constructive_now'), 'stabilization_watch should require actionability_constructive_now');
    assert(tensionSnapshot.liveCandidateTradeTriggerCard && typeof tensionSnapshot.liveCandidateTradeTriggerCard === 'object', 'tension fixture should surface trade trigger card');
    assert(tensionSnapshot.liveCandidateTradeTriggerCard.currentActionStance === 'stabilization_watch', 'tension fixture trade trigger should keep stabilization_watch');
    assert(tensionSnapshot.liveCandidateTradeTriggerCard.confirmationState === 'waiting_for_confirmation', 'tension fixture trade trigger should remain waiting_for_confirmation');
    assert(tensionSnapshot.liveCandidateTradeTriggerCard.riskBucket === 'defensive' || tensionSnapshot.liveCandidateTradeTriggerCard.riskBucket === 'no_trade', 'tension fixture trade trigger should stay defensive/no_trade');
    assert(tensionSnapshot.liveCandidateTradeTriggerCard.sizeGuidance === 'quarter_size' || tensionSnapshot.liveCandidateTradeTriggerCard.sizeGuidance === 'none', 'tension fixture trade trigger should remain constrained size');
    assert(tensionSnapshot.liveCandidateTradeTriggerCardAudit && typeof tensionSnapshot.liveCandidateTradeTriggerCardAudit === 'object', 'tension fixture should surface trade trigger card audit');
    tensionDb.close();

    const supportiveDeterioratingInterpretation = buildLiveCandidateHistoryActionInterpretation({
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'supportive',
        recentTransitionBias: 'deteriorating',
        directionVsTransitionTension: true,
        sparseHistory: false,
        confidenceLabel: 'high',
        historySampleSize: 24,
        transitionSampleSize: 8,
        supportiveCount: 18,
        unsupportiveCount: 4,
        neutralCount: 2,
      },
    });
    const supportiveDeterioratingAudit = buildLiveCandidateHistoryActionInterpretationAudit({
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'supportive',
        recentTransitionBias: 'deteriorating',
        directionVsTransitionTension: true,
        sparseHistory: false,
        confidenceLabel: 'high',
        historySampleSize: 24,
        transitionSampleSize: 8,
        supportiveCount: 18,
        unsupportiveCount: 4,
        neutralCount: 2,
      },
      liveCandidateHistoryActionInterpretation: supportiveDeterioratingInterpretation,
    });
    assert(supportiveDeterioratingInterpretation.actionStance === 'caution', 'supportive+deteriorating tension should map to caution');
    assert(supportiveDeterioratingInterpretation.actionBias === 'defensive', 'supportive+deteriorating tension should be defensive');
    assert(supportiveDeterioratingInterpretation.confidenceImpact === 'conflicts', 'supportive+deteriorating tension should mark confidence conflict');
    assert(supportiveDeterioratingAudit.ruleUsed === 'supportive_deteriorating_tension_caution', 'supportive+deteriorating tension should use deterministic caution rule');
    const stabilizationGuide = buildLiveCandidateHistoryConfirmationGuide({
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'stabilization_watch',
        requiresFreshConfirmation: true,
      },
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'weak',
        recentTransitionBias: 'improving',
        directionVsTransitionTension: true,
        sparseHistory: false,
        historySampleSize: 30,
        transitionSampleSize: 10,
        supportiveCount: 4,
        unsupportiveCount: 12,
        neutralCount: 14,
      },
      liveCandidateHistoryJudgmentAudit: {
        unsupportiveRuleHits: {
          observation_structure_quality_poor: 12,
        },
      },
      liveCandidateStateMonitor: {
        monitoredCandidates: [{
          candidateKey: 'candidate:one',
          currentStatus: 'pre_open_watch',
          currentStructureQualityScore: 25,
          currentActionable: false,
        }],
        actionableTransitionDetected: false,
      },
      liveCandidateTransitionHistory: {
        loopOnlyRecentTransitions: [{
          candidateKey: 'candidate:one',
          transitionType: 'structure_improved',
        }],
      },
      liveOpportunityCandidates: {
        hasActionableCandidateNow: false,
        topCandidateOverall: {
          candidateKey: 'candidate:one',
          candidateStatus: 'pre_open_watch',
          structureQualityLabel: 'poor',
          structureQualityScore: 25,
        },
      },
      liveCandidateHistoryStatusCalibration: {
        statusRuleMap: {
          pre_open_watch: {
            directionalEffect: 'neutral',
            treatment: 'context_only',
          },
        },
      },
    });
    const stabilizationGuideAudit = buildLiveCandidateHistoryConfirmationGuideAudit({
      liveCandidateHistoryConfirmationGuide: stabilizationGuide,
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'stabilization_watch',
        requiresFreshConfirmation: true,
      },
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'weak',
        recentTransitionBias: 'improving',
        directionVsTransitionTension: true,
        sparseHistory: false,
      },
    });
    assert(stabilizationGuide.confirmationState === 'waiting_for_confirmation', 'stabilization_watch guide should wait for confirmation');
    assert(stabilizationGuide.confirmationTriggers.some((item) => item.code === 'improving_transition_bias_persists' && item.met === true), 'stabilization_watch guide should mark improving transition trigger');
    assert(stabilizationGuide.confirmationState !== 'confirmed', 'transition improvement alone with poor structure must not count as full confirmation');
    assert(stabilizationGuideAudit.ruleUsed && stabilizationGuideAudit.ruleUsed.length > 0, 'stabilization_watch guide audit should expose deterministic ruleUsed');
    const supportiveGuide = buildLiveCandidateHistoryConfirmationGuide({
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'supportive_followthrough',
        requiresFreshConfirmation: false,
      },
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'supportive',
        recentTransitionBias: 'improving',
        directionVsTransitionTension: false,
        sparseHistory: false,
      },
      liveOpportunityCandidates: {
        hasActionableCandidateNow: true,
        topCandidateActionableNow: {
          candidateKey: 'candidate:two',
          candidateStatus: 'ready_now',
          structureQualityLabel: 'clean',
          structureQualityScore: 72,
          insideApprovedActionWindow: true,
        },
      },
      liveCandidateTransitionHistory: {
        loopOnlyRecentTransitions: [{
          candidateKey: 'candidate:two',
          transitionType: 'crossed_into_actionable',
        }],
      },
    });
    assert(['not_needed', 'confirmed'].includes(String(supportiveGuide.confirmationState || '')), 'supportive_followthrough should map to confirmed or not_needed');
    const weakImprovingTriggerCard = buildLiveCandidateTradeTriggerCard({
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'weak',
        confidenceLabel: 'high',
        recentTransitionBias: 'improving',
        directionVsTransitionTension: true,
      },
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'stabilization_watch',
      },
      liveCandidateHistoryConfirmationGuide: stabilizationGuide,
      liveOpportunityCandidates: {
        topCandidateOverall: {
          candidateKey: 'candidate:one',
          strategyKey: 'original_plan_orb_3130',
          strategyName: 'Original Plan ORB 3130',
          candidateType: 'orb_continuation_retest',
          candidateStatus: 'blocked',
        },
      },
      shadowMockTradeDecision: {
        eligible: false,
        status: 'ineligible',
        reason: 'candidate_blocked',
      },
    });
    const weakImprovingTriggerCardAudit = buildLiveCandidateTradeTriggerCardAudit({
      liveCandidateTradeTriggerCard: weakImprovingTriggerCard,
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'weak',
        confidenceLabel: 'high',
        recentTransitionBias: 'improving',
        directionVsTransitionTension: true,
      },
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'stabilization_watch',
      },
      liveCandidateHistoryConfirmationGuide: stabilizationGuide,
      shadowMockTradeDecision: {
        eligible: false,
        status: 'ineligible',
        reason: 'candidate_blocked',
      },
    });
    assert(weakImprovingTriggerCard.currentActionStance === 'stabilization_watch', 'weak+improving tension trigger card should keep stabilization_watch');
    assert(weakImprovingTriggerCard.confirmationState === 'waiting_for_confirmation', 'weak+improving tension trigger card should wait for confirmation');
    assert(weakImprovingTriggerCard.nextUpgradeState === 'early_reversal_watch', 'weak+improving tension trigger card should point next upgrade to early_reversal_watch');
    assert(weakImprovingTriggerCard.riskBucket === 'no_trade' || weakImprovingTriggerCard.riskBucket === 'defensive', 'weak+improving tension trigger card should remain no_trade/defensive');
    assert(weakImprovingTriggerCardAudit.ruleUsed && weakImprovingTriggerCardAudit.ruleUsed.length > 0, 'weak+improving tension trigger card audit should expose ruleUsed');
    assert(Array.isArray(weakImprovingTriggerCardAudit.triggerBreakdown?.missing), 'weak+improving tension trigger card audit should expose missing trigger breakdown');

    const supportiveTriggerCard = buildLiveCandidateTradeTriggerCard({
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'supportive',
        confidenceLabel: 'high',
        recentTransitionBias: 'improving',
        directionVsTransitionTension: false,
      },
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'supportive_followthrough',
      },
      liveCandidateHistoryConfirmationGuide: {
        modeUsed: 'loop_only',
        confirmationState: 'confirmed',
        confirmationTriggers: [
          { code: 'structure_constructive_now', met: true, source: 'test', detail: 'ok' },
          { code: 'actionability_constructive_now', met: true, source: 'test', detail: 'ok' },
        ],
        confirmationFailures: [],
      },
      liveOpportunityCandidates: {
        topCandidateActionableNow: {
          candidateKey: 'candidate:confirmed',
          strategyKey: 'original_plan_orb_3130',
          strategyName: 'Original Plan ORB 3130',
          candidateType: 'orb_continuation_retest',
          candidateStatus: 'ready_now',
          triggerStructure: { topSetupName: 'ORB Retest Long' },
        },
      },
      shadowMockTradeDecision: {
        eligible: true,
        status: 'eligible',
        reason: 'ready_for_shadow',
      },
    });
    assert(supportiveTriggerCard.currentState === 'confirmed_supportive', 'supportive confirmed trigger card should map to confirmed_supportive');
    assert(supportiveTriggerCard.riskBucket === 'standard', 'supportive confirmed trigger card should map to standard risk bucket');
    assert(supportiveTriggerCard.sizeGuidance === 'full_size', 'supportive confirmed trigger card should map to full_size guidance');

    const fallbackTriggerCard = buildLiveCandidateTradeTriggerCard({
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'sparse',
        confidenceLabel: 'low',
        recentTransitionBias: 'insufficient_history',
      },
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'neutral_wait',
      },
      liveCandidateHistoryConfirmationGuide: {
        modeUsed: 'loop_only',
        confirmationState: 'waiting_for_confirmation',
        confirmationTriggers: [],
        confirmationFailures: [],
      },
      liveOpportunityCandidates: {},
      recommendationBasis: {},
      shadowMockTradeDecision: {
        eligible: false,
        status: 'ineligible',
        reason: 'no_candidate',
      },
    });
    const fallbackTriggerCardAudit = buildLiveCandidateTradeTriggerCardAudit({
      liveCandidateTradeTriggerCard: fallbackTriggerCard,
      liveCandidateHistoryJudgment: {
        modeUsed: 'loop_only',
        judgment: 'sparse',
        confidenceLabel: 'low',
      },
      liveCandidateHistoryActionInterpretation: {
        modeUsed: 'loop_only',
        actionStance: 'neutral_wait',
      },
      liveCandidateHistoryConfirmationGuide: {
        modeUsed: 'loop_only',
        confirmationState: 'waiting_for_confirmation',
        confirmationTriggers: [],
        confirmationFailures: [],
      },
      shadowMockTradeDecision: {
        eligible: false,
        status: 'ineligible',
        reason: 'no_candidate',
      },
    });
    assert(fallbackTriggerCard.strategyLabel === 'Unknown strategy', 'missing-upstream trigger card should fallback strategy label');
    assert(fallbackTriggerCardAudit.inputsUsed.strategyIdentitySource === 'fallback_unknown_strategy', 'missing-upstream trigger card audit should expose strategy fallback source');
    assert(fallbackTriggerCardAudit.triggerBreakdown.sourceEmpty === true, 'missing-upstream trigger card audit should mark empty trigger source');
    assert(fallbackTriggerCardAudit.failureBreakdown.sourceEmpty === true, 'missing-upstream trigger card audit should mark empty failure source');

    const forcedDiagnostics = buildLiveCandidateHistoryStatusCalibrationDiagnostics({
      statusCalibration: {
        statusRuleMap: {
          pre_open_watch: {
            directionalEffect: 'neutral',
          },
        },
        statusEvidence: {
          pre_open_watch: {
            sampledRowCount: 2,
            mappedDirectionalEffect: 'neutral',
          },
        },
        dominantStatusEffects: [
          {
            status: 'pre_open_watch',
            directionalEffect: 'unsupportive',
          },
        ],
        statusSourceOfTruth: 'statusRuleMap.directionalEffect',
        summaryDerivedFrom: 'dominantStatusEffects.directionalEffect(rule_map)',
      },
    });
    assert(forcedDiagnostics.consistent === false, 'forced diagnostics fixture should detect inconsistency');
    assert(Array.isArray(forcedDiagnostics.inconsistencies) && forcedDiagnostics.inconsistencies.length > 0, 'forced diagnostics fixture should return non-empty inconsistency list');

    const mixedDb = new Database(':memory:');
    buildCommandCenterPanels(buildInput({ db: mixedDb, persistLiveCandidateState: false }));
    for (let i = 0; i < 4; i += 1) {
      insertObservation(mixedDb, {
        observed_at: `2026-04-17 12:${String(i).padStart(2, '0')}`,
        candidate_status: 'ready_now',
        structure_quality_score: 68,
        structure_quality_label: 'clean',
        candidate_expected_value: 8,
        actionable_now: true,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      insertObservation(mixedDb, {
        observed_at: `2026-04-17 12:${String(10 + i).padStart(2, '0')}`,
        candidate_status: 'blocked',
        structure_quality_score: 24,
        structure_quality_label: 'poor',
        candidate_expected_value: -24,
        actionable_now: false,
        observation_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      insertTransition(mixedDb, {
        transition_at: `2026-04-17 12:${String(30 + i).padStart(2, '0')}`,
        transition_type: 'structure_improved',
        previous_status: 'watch_trigger',
        current_status: 'watch_trigger',
        previous_actionable: false,
        current_actionable: false,
        transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
      insertTransition(mixedDb, {
        transition_at: `2026-04-17 12:${String(40 + i).padStart(2, '0')}`,
        transition_type: 'structure_worsened',
        previous_status: 'watch_trigger',
        current_status: 'watch_trigger',
        previous_actionable: false,
        current_actionable: false,
        transition_write_source: LIVE_CANDIDATE_OBSERVATION_WRITE_SOURCE_LOOP_AUTO,
      });
    }
    const mixedJudgmentSnapshot = makeReadSnapshot({ db: mixedDb });
    assert(mixedJudgmentSnapshot.liveCandidateHistoryJudgment.sparseHistory === false, 'mixed fixture should not be sparse');
    assert(mixedJudgmentSnapshot.liveCandidateHistoryJudgment.judgment === 'mixed', 'mixed fixture should classify as mixed');
    assert(mixedJudgmentSnapshot.liveCandidateHistoryJudgment.recentTransitionBias === 'neutral', 'mixed fixture should classify transition bias as neutral');
    assert(mixedJudgmentSnapshot.liveCandidateHistoryJudgmentAudit.dominantSupportiveRules.length > 0, 'mixed fixture should include supportive dominant rules');
    assert(mixedJudgmentSnapshot.liveCandidateHistoryJudgmentAudit.dominantUnsupportiveRules.length > 0, 'mixed fixture should include unsupportive dominant rules');
    assert(mixedJudgmentSnapshot.liveCandidateHistoryJudgmentAudit.sampleSize === mixedJudgmentSnapshot.liveCandidateHistoryJudgment.historySampleSize + mixedJudgmentSnapshot.liveCandidateHistoryJudgment.transitionSampleSize, 'mixed fixture audit sample size should include observations plus transitions');
    assert(mixedJudgmentSnapshot.shadowMockTradeDecision && mixedJudgmentSnapshot.shadowMockTradeDecision.advisoryOnly === true, 'history judgment audit should not change authority path');
    assert(Array.isArray(mixedJudgmentSnapshot.liveCandidateHistoryStatusCalibration.dominantStatusEffects), 'mixed fixture should surface dominant status effects');
    assert(mixedJudgmentSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics && mixedJudgmentSnapshot.liveCandidateHistoryStatusCalibrationDiagnostics.consistent === true, 'mixed fixture should report calibration consistency');
    mixedDb.close();
  }

  console.log('Jarvis live candidate state persistence test passed.');
}

run();
