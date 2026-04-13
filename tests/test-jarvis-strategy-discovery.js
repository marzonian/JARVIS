#!/usr/bin/env node
/* eslint-disable no-console */
const nodeAssert = require('assert');
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildStrategyDiscoverySummary,
  normalizeFamilyFilter,
} = require('../server/jarvis-core/strategy-discovery');

const TIMEOUT_MS = 120000;
const FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 750;

function makeIsoDate(offsetDays) {
  const base = new Date(Date.UTC(2025, 0, 2, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + Number(offsetDays || 0));
  return base.toISOString().slice(0, 10);
}

function makeSessions(count = 140) {
  const sessions = {};
  for (let i = 0; i < count; i += 1) {
    const date = makeIsoDate(i);
    const px = 22000 + i;
    sessions[date] = [
      { timestamp: `${date} 09:30:00`, date, time: '09:30:00', open: px, high: px + 8, low: px - 6, close: px + 2, volume: 1200 },
      { timestamp: `${date} 09:35:00`, date, time: '09:35:00', open: px + 2, high: px + 10, low: px - 2, close: px + 4, volume: 1300 },
      { timestamp: `${date} 09:40:00`, date, time: '09:40:00', open: px + 4, high: px + 12, low: px + 1, close: px + 8, volume: 1400 },
    ];
  }
  return sessions;
}

function fakeRunPlanBacktest() {
  return {
    metrics: {
      totalTrades: 40,
      winRate: 52,
      profitFactor: 1.18,
      expectancyDollars: 8.2,
      totalPnlDollars: 328,
    },
  };
}

function makeCandidate(input = {}) {
  return {
    key: input.key,
    name: input.name,
    status: input.status || 'watchlist',
    confidence: input.confidence || 'low',
    robustnessScore: input.robustnessScore,
    failureReasons: input.failureReasons || [],
    rules: {
      family: input.family,
      entryTime: input.entryTime || '10:00',
      thresholdTicks: input.thresholdTicks || 90,
      tpTicks: input.tpTicks || 100,
      slTicks: input.slTicks || 80,
    },
    splits: {
      train: {
        profitFactor: input.trainPf || 1.2,
        winRate: input.trainWr || 53,
      },
      valid: {
        profitFactor: input.validPf || 1.1,
        winRate: input.validWr || 51,
      },
      test: {
        totalTrades: input.testTrades || 22,
        winRate: input.testWr,
        profitFactor: input.testPf,
        expectancyDollars: input.expectancy || 9,
      },
      overall: {
        totalTrades: input.totalTrades,
        winRate: input.overallWr || input.testWr,
        profitFactor: input.overallPf || input.testPf,
        expectancyDollars: input.expectancy || 9,
        totalPnlDollars: input.totalPnl || 200,
        avgLossDollars: input.avgLoss || -36,
        maxConsecLosses: input.maxConsecLosses || 3,
      },
      counts: {
        trainSessions: input.trainSessions || 90,
        validSessions: input.validSessions || 30,
        testSessions: input.testSessions || 30,
      },
    },
  };
}

function fakeRunDiscovery() {
  return {
    status: 'ok',
    mode: 'two_stage',
    summary: {
      sessions: 160,
      candidates: 4,
      recommended: 1,
      watchlist: 2,
      rejected: 1,
    },
    methodology: {
      split: '60/20/20 chronological',
    },
    diagnostics: {
      topRejections: [{ reason: 'insufficient_test_trades', count: 1 }],
      nextResearchActions: ['Increase sample quality.'],
    },
    candidates: [
      makeCandidate({
        key: 'cand_pf',
        name: 'PF Leader',
        family: 'compression_breakout',
        status: 'live_eligible',
        confidence: 'moderate',
        robustnessScore: 84,
        totalTrades: 68,
        testWr: 50,
        testPf: 1.42,
        totalPnl: 520,
      }),
      makeCandidate({
        key: 'cand_wr',
        name: 'WR Leader',
        family: 'first_hour_momentum',
        status: 'watchlist',
        confidence: 'moderate',
        robustnessScore: 74,
        totalTrades: 63,
        testWr: 58,
        testPf: 1.16,
        totalPnl: 438,
      }),
      makeCandidate({
        key: 'cand_practical',
        name: 'Practical Blend',
        family: 'lunch_breakout',
        status: 'watchlist',
        confidence: 'low',
        robustnessScore: 70,
        totalTrades: 55,
        testWr: 54,
        testPf: 1.24,
        totalPnl: 460,
      }),
      makeCandidate({
        key: 'cand_thin',
        name: 'Thin Sample',
        family: 'midday_mean_reversion',
        status: 'rejected',
        confidence: 'low',
        robustnessScore: 51,
        totalTrades: 12,
        testTrades: 5,
        testWr: 70,
        testPf: 1.8,
        totalPnl: 90,
        failureReasons: ['insufficient_test_trades'],
      }),
    ],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(baseUrl, endpoint) {
  let lastErr = null;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status >= 500 && attempt < FETCH_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt >= FETCH_RETRIES) {
        break;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr || new Error(`${endpoint} failed after retries`);
}

function runUnitChecks() {
  const sessions = makeSessions(170);
  nodeAssert.strictEqual(normalizeFamilyFilter('continuation'), 'compression_breakout');
  nodeAssert.strictEqual(normalizeFamilyFilter('nearest'), null);

  const summary = buildStrategyDiscoverySummary({
    sessions,
    windowSessions: 160,
    candidateLimit: 12,
    deps: {
      runDiscovery: fakeRunDiscovery,
      runPlanBacktest: fakeRunPlanBacktest,
    },
  });

  nodeAssert(summary && typeof summary === 'object');
  nodeAssert.strictEqual(summary.advisoryOnly, true);
  nodeAssert(summary.bestCandidateOverall && summary.bestCandidateOverall.strategyKey);
  nodeAssert(summary.bestCandidateByWinRate && summary.bestCandidateByWinRate.strategyKey);
  nodeAssert(summary.bestCandidateByProfitFactor && summary.bestCandidateByProfitFactor.strategyKey);
  nodeAssert(summary.bestCandidatePractical && summary.bestCandidatePractical.strategyKey);
  nodeAssert(['research_only', 'worth_monitoring', 'strong_candidate_for_side_by_side_tracking'].includes(summary.candidatePromotionDecision));
  nodeAssert(typeof summary.promotionReason === 'string' && summary.promotionReason.length > 0);
  nodeAssert(Array.isArray(summary.candidates) && summary.candidates.length > 0);

  const first = summary.candidates[0];
  nodeAssert(typeof first.robustnessLabel === 'string' && first.robustnessLabel.length > 0);
  nodeAssert(first.comparisonVsOriginal && typeof first.comparisonVsOriginal === 'object');
  nodeAssert(Object.prototype.hasOwnProperty.call(first.comparisonVsOriginal, 'profitFactorDifference'));
  nodeAssert.strictEqual(first.advisoryOnly, true);

  const thin = summary.candidates.find((c) => c.strategyKey === 'cand_thin');
  nodeAssert(thin && thin.qualityWarnings.includes('insufficient_test_trades'));
  nodeAssert(Array.isArray(summary.dataQuality.warnings));

  const filtered = buildStrategyDiscoverySummary({
    sessions,
    windowSessions: 160,
    candidateLimit: 12,
    family: 'first_hour_momentum',
    deps: {
      runDiscovery: fakeRunDiscovery,
      runPlanBacktest: fakeRunPlanBacktest,
    },
  });
  nodeAssert(filtered.candidates.length >= 1);
  nodeAssert(filtered.candidates.every((c) => c.family === 'first_hour_momentum'));
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3174,
  });

  try {
    const discoveryOut = await getJson(server.baseUrl, '/api/jarvis/strategy/discovery?windowSessions=180&candidateLimit=16');
    assert(discoveryOut?.status === 'ok', 'strategy discovery endpoint should return ok', { discoveryOut });
    const summary = discoveryOut?.strategyDiscovery;
    assert(summary && typeof summary === 'object', 'strategyDiscovery payload missing', { discoveryOut });
    assert(summary.advisoryOnly === true, 'strategyDiscovery must be advisory only', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'bestCandidateOverall'), 'bestCandidateOverall missing', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'candidatePromotionDecision'), 'candidatePromotionDecision missing', { summary });
    assert(Array.isArray(summary.candidates), 'candidates array missing', { summary });
    if (summary.candidates.length > 0) {
      const candidate = summary.candidates[0];
      assert(candidate.comparisonVsOriginal && typeof candidate.comparisonVsOriginal === 'object', 'candidate comparisonVsOriginal missing', { candidate });
      assert(typeof candidate.robustnessLabel === 'string' && candidate.robustnessLabel.length > 0, 'candidate robustnessLabel missing', { candidate });
    }

    const layersOut = await getJson(server.baseUrl, '/api/jarvis/strategy/layers?windowSessions=180&candidateLimit=16');
    assert(layersOut?.status === 'ok', 'strategy layers endpoint should return ok', { layersOut });
    const layerSummary = layersOut?.strategyLayers?.discoverySummary;
    assert(layerSummary && typeof layerSummary === 'object', 'strategyLayers.discoverySummary missing', { layersOut });
    assert(layerSummary.advisoryOnly === true, 'strategyLayers.discoverySummary must be advisory only', { layerSummary });

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=180&candidateLimit=16');
    assert(centerOut?.status === 'ok', 'command center endpoint should return ok', { centerOut });
    const centerSummary = centerOut?.commandCenter?.discoverySummary;
    assert(centerSummary && typeof centerSummary === 'object', 'commandCenter.discoverySummary missing', { centerOut });
    if (centerSummary.bestCandidateOverall) {
      assert(typeof centerOut?.commandCenter?.discoveryInsight === 'string' && centerOut.commandCenter.discoveryInsight.length > 0, 'commandCenter.discoveryInsight missing when best candidate exists', { centerOut });
    }
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis strategy discovery tests passed.');
  } catch (err) {
    console.error(`Jarvis strategy discovery test failed: ${err.message}`);
    process.exit(1);
  }
})();
