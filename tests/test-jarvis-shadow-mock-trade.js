#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildStrategyLayerSnapshot,
  buildCommandCenterPanels,
} = require('../server/jarvis-core/strategy-layers');

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

function buildStrategyLayers(sessionPhase = 'entry_window') {
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
      nowEt: '2026-04-16 10:20',
      sessionPhase,
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
  });
}

function buildInput({ signal = 'TRADE', blockers = [], sessionPhase = 'entry_window', latestSession = {} } = {}) {
  return {
    strategyLayers: buildStrategyLayers(sessionPhase),
    decision: {
      signal,
      signalLabel: signal,
      blockers,
      entryConditions: ['Need clean retest and confirmation close.'],
      topSetups: [
        {
          setupId: 'orb_retest_long',
          name: 'ORB Retest Long',
          probability: 0.63,
          expectedValueDollars: 58.2,
          annualizedTrades: 172,
        },
      ],
    },
    latestSession,
    news: [],
    watchLevels: [],
    commandSnapshot: {
      elite: {
        winModel: { point: 58.6, confidencePct: 67 },
      },
    },
    todayContext: {
      nowEt: '2026-04-16 10:20',
      sessionPhase,
      dayName: 'Thursday',
      timeBucket: sessionPhase,
      regime: 'ranging|extreme|wide',
      trend: 'uptrend',
      volatility: 'high',
      orbRangeTicks: 160,
    },
  };
}

function run() {
  const eligibleCenter = buildCommandCenterPanels(buildInput({
    signal: 'TRADE',
    blockers: [],
    sessionPhase: 'entry_window',
    latestSession: {
      orb: { high: 22135, low: 22095, range_ticks: 160 },
      trade: {
        direction: 'long',
        entry_time: '2026-04-16 10:05',
        entry_price: 22140,
        sl_price: 22095,
        tp_price: 22200,
        exit_time: '2026-04-16 10:45',
        exit_price: 22200,
        exit_reason: 'tp_hit',
        result: 'win',
        pnl_dollars: 125.5,
      },
      no_trade_reason: null,
    },
  }));
  assert(eligibleCenter.shadowMockTradeDecision && typeof eligibleCenter.shadowMockTradeDecision === 'object', 'shadowMockTradeDecision missing');
  assert(eligibleCenter.shadowMockTradeDecision.eligible === true, 'expected eligible shadow decision');
  assert(eligibleCenter.shadowMockTradeDecision.status === 'eligible_ready', 'expected eligible_ready status');
  assert(eligibleCenter.shadowMockTradeDecision.reason === 'eligible_for_shadow_execution', 'expected eligible reason');
  assert(eligibleCenter.shadowMockTradeLedger && typeof eligibleCenter.shadowMockTradeLedger === 'object', 'shadowMockTradeLedger missing');
  assert(Array.isArray(eligibleCenter.shadowMockTradeLedger.closed) && eligibleCenter.shadowMockTradeLedger.closed.length === 1, 'expected one closed shadow trade');
  assert(String(eligibleCenter.shadowMockTradeLedger.closed[0].realizedOutcome || '') === 'win', 'expected win outcome');

  const blockedCenter = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    blockers: ['INSUFFICIENT_DECISIVE_SAMPLE'],
    sessionPhase: 'entry_window',
    latestSession: {
      orb: { high: 22135, low: 22095, range_ticks: 160 },
      no_trade_reason: 'no_confirmation',
    },
  }));
  assert(blockedCenter.shadowMockTradeDecision.eligible === false, 'blocked case should be ineligible');
  assert(blockedCenter.shadowMockTradeDecision.reason === 'candidate_blocked', 'blocked case should explain candidate_blocked');
  assert(Array.isArray(blockedCenter.shadowMockTradeLedger.pending) && blockedCenter.shadowMockTradeLedger.pending.length === 0, 'blocked case should not queue pending trades');
  assert(Array.isArray(blockedCenter.shadowMockTradeLedger.closed) && blockedCenter.shadowMockTradeLedger.closed.length === 0, 'blocked case should not close trades');

  const queuedCenter = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    blockers: [],
    sessionPhase: 'outside_window',
    latestSession: {
      orb: { high: 22135, low: 22095, range_ticks: 160 },
      no_trade_reason: 'entry_after_max_hour',
    },
  }));
  assert(queuedCenter.shadowMockTradeDecision.eligible === true, 'outside-window queued case should stay eligible');
  assert(queuedCenter.shadowMockTradeDecision.status === 'queued_next_session', 'expected queued_next_session status');
  assert(queuedCenter.shadowMockTradeDecision.reason === 'queued_for_next_session', 'expected queued_for_next_session reason');
  assert(Array.isArray(queuedCenter.shadowMockTradeLedger.pending) && queuedCenter.shadowMockTradeLedger.pending.length === 1, 'expected one pending queued trade');
  assert(String(queuedCenter.shadowMockTradeLedger.pending[0].exitReason || '') === 'queued_next_session', 'queued trade should state queued_next_session');

  const preOpenCenter = buildCommandCenterPanels(buildInput({
    signal: 'WAIT',
    blockers: [],
    sessionPhase: 'pre_open',
    latestSession: {
      orb: { high: 22135, low: 22095, range_ticks: 160 },
      no_trade_reason: null,
    },
  }));
  assert(preOpenCenter.shadowMockTradeDecision.eligible === false, 'pre-open should be ineligible for mock execution');
  assert(preOpenCenter.shadowMockTradeDecision.reason === 'outside_shadow_action_window', 'pre-open should map to outside_shadow_action_window');

  assert(eligibleCenter.todayRecommendation.shadowMockTradeDecision && typeof eligibleCenter.todayRecommendation.shadowMockTradeDecision === 'object', 'todayRecommendation mirror missing shadowMockTradeDecision');
  assert(eligibleCenter.decisionBoard.shadowMockTradeLedger && typeof eligibleCenter.decisionBoard.shadowMockTradeLedger === 'object', 'decisionBoard mirror missing shadowMockTradeLedger');

  console.log('Jarvis shadow mock-trade test passed.');
}

run();
