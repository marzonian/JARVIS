#!/usr/bin/env node
/* eslint-disable no-console */
const nodeAssert = require('assert');
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildStrategyTrackingSummary,
} = require('../server/jarvis-core/strategy-tracking');

const TIMEOUT_MS = 120000;

function makeIsoDate(offsetDays) {
  const base = new Date(Date.UTC(2025, 0, 2, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + Number(offsetDays || 0));
  return base.toISOString().slice(0, 10);
}

function makeSessions(count = 160) {
  const sessions = {};
  for (let i = 0; i < count; i += 1) {
    const date = makeIsoDate(i);
    const px = 22000 + i;
    sessions[date] = [
      { timestamp: `${date} 09:30:00`, date, time: '09:30:00', open: px, high: px + 10, low: px - 8, close: px + 1, volume: 1000 },
      { timestamp: `${date} 09:35:00`, date, time: '09:35:00', open: px + 1, high: px + 14, low: px - 2, close: px + 7, volume: 1100 },
      { timestamp: `${date} 09:40:00`, date, time: '09:40:00', open: px + 7, high: px + 18, low: px + 1, close: px + 4, volume: 1200 },
    ];
  }
  return sessions;
}

function buildPerDate(dates = [], cfg = {}) {
  const perDate = {};
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    const shouldTrade = i % 2 === 0;
    if (!shouldTrade) {
      perDate[date] = {
        date,
        wouldTrade: false,
        noTradeReason: 'no_setup',
      };
      continue;
    }
    const pattern = Array.isArray(cfg.pattern) ? cfg.pattern : [1, 1, -1, 1, -1, 1];
    const sign = pattern[i % pattern.length] >= 0 ? 1 : -1;
    const winTicks = Number(cfg.winTicks || 60);
    const lossTicks = Number(cfg.lossTicks || -45);
    const pnlTicks = sign > 0 ? winTicks : lossTicks;
    const pnlDollars = Number((pnlTicks * 0.5) - 4.5).toFixed(2);
    const hour = i % 3 === 0 ? '09' : i % 3 === 1 ? '10' : '11';
    perDate[date] = {
      date,
      wouldTrade: true,
      tradeResult: sign > 0 ? 'win' : 'loss',
      tradePnlTicks: pnlTicks,
      tradePnlDollars: Number(pnlDollars),
      tradeDirection: sign > 0 ? 'long' : 'short',
      tradeEntryTime: `${date} ${hour}:05:00`,
      tradeExitTime: `${date} ${hour}:20:00`,
    };
  }
  return perDate;
}

function fakeRunPlanBacktest(sessions, spec = {}) {
  const dates = Object.keys(sessions || {}).sort();
  const key = String(spec?.key || 'unknown');
  const originalCfg = { pattern: [1, 1, -1, 1, -1, 1], winTicks: 64, lossTicks: -44 };
  const variantCfg = { pattern: [1, -1, 1, 1, -1, 1], winTicks: 72, lossTicks: -42 };
  const cfg = key.includes('variant') ? variantCfg : originalCfg;
  return {
    perDate: buildPerDate(dates, cfg),
  };
}

function fakeBuildVariantReports() {
  return {
    best: {
      key: 'variant_orb_70_220',
      name: 'ORB 70-220 Filter',
      description: 'Variant filter.',
      rules: {
        longOnly: true,
        skipMonday: false,
        maxEntryHour: 11,
        tpMode: 'skip2',
        filters: { orbRange: { min: 70, max: 220 } },
      },
    },
  };
}

function makeAltTrades(dates = [], behavior = 'mixed') {
  const trades = [];
  for (let i = 0; i < dates.length; i += 1) {
    if (i % 2 !== 0) continue;
    const date = dates[i];
    let sign = 1;
    if (behavior === 'weak_recent') {
      sign = dates.length <= 20 ? -1 : dates.length <= 60 ? -1 : 1;
    } else if (behavior === 'strong_recent') {
      sign = dates.length <= 20 ? 1 : 1;
    }
    const pnlTicks = sign > 0 ? 80 : -60;
    trades.push({
      date,
      result: sign > 0 ? 'win' : 'loss',
      pnl_ticks: pnlTicks,
      pnl_dollars: Number(((pnlTicks * 0.5) - 4.5).toFixed(2)),
      direction: sign > 0 ? 'long' : 'short',
      entry_time: `${date} ${i % 3 === 0 ? '09:55:00' : i % 3 === 1 ? '10:25:00' : '11:10:00'}`,
      exit_time: `${date} 11:30:00`,
    });
  }
  return trades;
}

function fakeEvaluateCandidateWindow(sessions) {
  const dates = Object.keys(sessions || {}).sort();
  return {
    sessions: dates.length,
    trades: makeAltTrades(dates, 'weak_recent'),
  };
}

function fakeRunDiscovery() {
  return {
    status: 'ok',
    candidates: [
      {
        key: 'alt_candidate_1',
        name: 'Alternative Candidate 1',
        status: 'live_eligible',
        confidence: 'moderate',
        robustnessScore: 76,
        rules: {
          family: 'first_hour_momentum',
          entryTime: '10:00',
          thresholdTicks: 70,
          tpTicks: 100,
          slTicks: 80,
        },
      },
    ],
  };
}

async function getJson(baseUrl, endpoint) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function runUnitChecks() {
  const sessions = makeSessions(180);
  const summary = buildStrategyTrackingSummary({
    sessions,
    regimeByDate: {},
    windowSessions: 120,
    includeContext: true,
    deps: {
      runPlanBacktest: fakeRunPlanBacktest,
      buildVariantReports: fakeBuildVariantReports,
      runDiscovery: fakeRunDiscovery,
      evaluateCandidateWindow: fakeEvaluateCandidateWindow,
    },
  });

  nodeAssert(summary && typeof summary === 'object');
  nodeAssert(summary.advisoryOnly === true);
  nodeAssert(Array.isArray(summary.trackedStrategies) && summary.trackedStrategies.length === 3);
  nodeAssert(summary.bestTrackedStrategyNow && summary.bestTrackedStrategyNow.strategyKey);
  nodeAssert(typeof summary.bestTrackedStrategyReason === 'string' && summary.bestTrackedStrategyReason.length > 0);
  nodeAssert(['keep_original_plan_baseline', 'alternative_worth_side_by_side_tracking', 'alternative_context_only', 'insufficient_evidence_to_shift'].includes(summary.recommendationHandoffState));

  const original = summary.trackedStrategies.find((row) => row.strategyType === 'original_plan');
  const variant = summary.trackedStrategies.find((row) => row.strategyType === 'learned_variant');
  const alt = summary.trackedStrategies.find((row) => row.strategyType === 'alternative_candidate');
  nodeAssert(original && variant && alt);

  for (const row of summary.trackedStrategies) {
    nodeAssert(Array.isArray(row.rollingWindowSummary));
    nodeAssert(row.rollingWindowSummary.some((w) => Number(w.windowSessions) === 20));
    nodeAssert(row.rollingWindowSummary.some((w) => Number(w.windowSessions) === 60));
    nodeAssert(row.rollingWindowSummary.some((w) => Number(w.windowSessions) === 120));
    nodeAssert(Number.isFinite(Number(row.stabilityScore)));
    nodeAssert(typeof row.momentumOfPerformance === 'string');
    nodeAssert(typeof row.contextDominanceLabel === 'string');
    nodeAssert(row.vsOriginal && typeof row.vsOriginal === 'object');
    nodeAssert(row.vsBestTracked && typeof row.vsBestTracked === 'object');
    nodeAssert(typeof row.trackingStatus === 'string' && row.trackingStatus.length > 0);
  }

  nodeAssert(alt.trackingStatus === 'weakening_candidate', `expected alternative to be weakening_candidate, got ${alt.trackingStatus}`);
  nodeAssert(summary.dataQuality && Array.isArray(summary.dataQuality.windowsUsed));
  nodeAssert(summary.dataQuality.windowsUsed.includes(20));
  nodeAssert(summary.dataQuality.windowsUsed.includes(60));
  nodeAssert(summary.dataQuality.windowsUsed.includes(120));
  nodeAssert(summary.dataQuality.contextCoverage && typeof summary.dataQuality.contextCoverage === 'object');
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3175,
  });

  try {
    const trackingOut = await getJson(server.baseUrl, '/api/jarvis/strategy/tracking?windowSessions=120&includeContext=1&force=1');
    assert(trackingOut?.status === 'ok', 'strategy tracking endpoint should return ok', { trackingOut });
    const tracking = trackingOut?.strategyTracking;
    assert(tracking && typeof tracking === 'object', 'strategyTracking payload missing', { trackingOut });
    assert(Array.isArray(tracking.trackedStrategies), 'trackedStrategies missing', { tracking });
    assert(tracking.bestTrackedStrategyNow && typeof tracking.bestTrackedStrategyNow === 'object', 'bestTrackedStrategyNow missing', { tracking });
    assert(typeof tracking.bestTrackedStrategyReason === 'string' && tracking.bestTrackedStrategyReason.length > 0, 'bestTrackedStrategyReason missing', { tracking });
    assert(typeof tracking.recommendationHandoffState === 'string' && tracking.recommendationHandoffState.length > 0, 'recommendationHandoffState missing', { tracking });

    const anyTracked = tracking.trackedStrategies[0] || null;
    if (anyTracked) {
      assert(anyTracked.vsOriginal && typeof anyTracked.vsOriginal === 'object', 'vsOriginal comparison missing', { anyTracked });
      assert(typeof anyTracked.trackingStatus === 'string' && anyTracked.trackingStatus.length > 0, 'trackingStatus missing', { anyTracked });
      assert(Number.isFinite(Number(anyTracked.stabilityScore)), 'stabilityScore missing', { anyTracked });
      assert(typeof anyTracked.momentumOfPerformance === 'string', 'momentumOfPerformance missing', { anyTracked });
    }

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&includeContext=1&force=1');
    assert(centerOut?.status === 'ok', 'command center endpoint should return ok', { centerOut });
    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.trackingInsight === 'string' && cc.trackingInsight.length > 0, 'command-center trackingInsight missing', { centerOut });
    assert(typeof cc.handoffState === 'string' && cc.handoffState.length > 0, 'command-center handoffState missing', { centerOut });
    assert(typeof cc.trackedLeader === 'string' && cc.trackedLeader.length > 0, 'command-center trackedLeader missing', { centerOut });
    assert(centerOut?.strategyTracking && typeof centerOut.strategyTracking === 'object', 'command-center top-level strategyTracking missing', { centerOut });
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis strategy tracking tests passed.');
  } catch (err) {
    console.error(`Jarvis strategy tracking test failed: ${err.message}`);
    process.exit(1);
  }
})();
