#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { buildStrategyLayerSnapshot } = require('../server/jarvis-core/strategy-layers');

function candle(date, time, open, high, low, close, volume = 1000) {
  return { timestamp: `${date} ${time}`, open, high, low, close, volume, time };
}

function buildSession(date, trend = 'up') {
  const sign = trend === 'down' ? -1 : 1;
  const base = 22100;
  return [
    candle(date, '09:30', base, base + (20 * sign), base - 8, base + (15 * sign)),
    candle(date, '09:35', base + (15 * sign), base + (28 * sign), base + (8 * sign), base + (22 * sign)),
    candle(date, '09:40', base + (22 * sign), base + (34 * sign), base + (6 * sign), base + (18 * sign)),
    candle(date, '09:45', base + (18 * sign), base + (30 * sign), base + (14 * sign), base + (26 * sign)),
    candle(date, '09:50', base + (26 * sign), base + (38 * sign), base + (20 * sign), base + (31 * sign)),
    candle(date, '09:55', base + (31 * sign), base + (42 * sign), base + (24 * sign), base + (35 * sign)),
    candle(date, '10:00', base + (35 * sign), base + (44 * sign), base + (28 * sign), base + (33 * sign)),
    candle(date, '10:05', base + (33 * sign), base + (45 * sign), base + (26 * sign), base + (39 * sign)),
    candle(date, '10:10', base + (39 * sign), base + (54 * sign), base + (34 * sign), base + (48 * sign)),
    candle(date, '10:15', base + (48 * sign), base + (60 * sign), base + (42 * sign), base + (56 * sign)),
    candle(date, '10:20', base + (56 * sign), base + (68 * sign), base + (51 * sign), base + (64 * sign)),
    candle(date, '10:25', base + (64 * sign), base + (76 * sign), base + (58 * sign), base + (72 * sign)),
    candle(date, '10:30', base + (72 * sign), base + (84 * sign), base + (66 * sign), base + (81 * sign)),
    candle(date, '10:35', base + (81 * sign), base + (95 * sign), base + (75 * sign), base + (90 * sign)),
  ];
}

function run() {
  const sessions = {
    '2026-04-10': buildSession('2026-04-10', 'up'),
    '2026-04-13': buildSession('2026-04-13', 'down'),
    '2026-04-14': buildSession('2026-04-14', 'up'),
    '2026-04-15': buildSession('2026-04-15', 'up'),
    '2026-04-16': buildSession('2026-04-16', 'down'),
  };

  const snapshot = buildStrategyLayerSnapshot(sessions, {
    includeDiscovery: false,
    context: {
      nowEt: '2026-04-16 10:22',
      sessionPhase: 'entry_window',
      regime: 'ranging|extreme|wide',
      trend: 'mixed',
      volatility: 'high',
      orbRangeTicks: 188,
    },
  });

  assert(snapshot && typeof snapshot === 'object', 'snapshot missing');
  assert(snapshot.opportunityScoring && typeof snapshot.opportunityScoring === 'object', 'opportunityScoring missing');
  assert(snapshot.opportunityScoring.advisoryOnly === true, 'opportunityScoring must remain shadow-only');
  assert(typeof snapshot.opportunityScoreSummaryLine === 'string' && snapshot.opportunityScoreSummaryLine.length > 0, 'opportunityScoreSummaryLine missing');
  assert(snapshot.heuristicVsOpportunityComparison && typeof snapshot.heuristicVsOpportunityComparison === 'object', 'heuristicVsOpportunityComparison missing');
  assert(typeof snapshot.heuristicVsOpportunityComparison.status === 'string', 'heuristicVsOpportunityComparison.status missing');

  const rows = Array.isArray(snapshot.opportunityScoring.comparisonRows)
    ? snapshot.opportunityScoring.comparisonRows
    : [];
  assert(rows.length >= 2, 'opportunityScoring rows missing');
  for (const row of rows) {
    assert(typeof row.key === 'string' && row.key.length > 0, 'row key missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'heuristicCompositeScore'), 'heuristicCompositeScore missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityCompositeScore'), 'opportunityCompositeScore missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityWinProb'), 'opportunityWinProb missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityExpectedValue'), 'opportunityExpectedValue missing');
    assert(typeof row.opportunityCalibrationBand === 'string' && row.opportunityCalibrationBand.length > 0, 'opportunityCalibrationBand missing');
    assert(row.opportunityFeatureVector && typeof row.opportunityFeatureVector === 'object', 'opportunityFeatureVector missing');
    assert(typeof row.opportunityScoreSummaryLine === 'string' && row.opportunityScoreSummaryLine.length > 0, 'opportunityScoreSummaryLine missing');
    assert(row.heuristicVsOpportunityComparison && typeof row.heuristicVsOpportunityComparison === 'object', 'heuristicVsOpportunityComparison row object missing');
  }

  const stack = Array.isArray(snapshot.strategyStack) ? snapshot.strategyStack : [];
  assert(stack.length >= 2, 'strategyStack missing');
  for (const row of stack) {
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityWinProb'), 'stack opportunityWinProb missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityExpectedValue'), 'stack opportunityExpectedValue missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityCalibrationBand'), 'stack opportunityCalibrationBand missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityFeatureVector'), 'stack opportunityFeatureVector missing');
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityScoreSummaryLine'), 'stack opportunityScoreSummaryLine missing');
  }

  console.log('Jarvis opportunity scorer test passed.');
}

run();
