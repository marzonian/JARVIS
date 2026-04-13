#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildDecisionBoard,
} = require('../server/jarvis-core/decision-board');

const TIMEOUT_MS = 120000;

function runUnitChecks() {
  const board = buildDecisionBoard({
    originalPlan: {
      key: 'original_plan_orb_3130',
      name: 'Original Trading Plan',
      layer: 'original',
    },
    bestAlternative: {
      key: 'alt_a',
      name: 'Alternative A',
      layer: 'discovery',
    },
    strategyPortfolio: {
      baselineStrategy: {
        strategyKey: 'original_plan_orb_3130',
        strategyName: 'Original Trading Plan',
        strategyType: 'original_plan',
      },
      highestPriorityCandidate: {
        strategyKey: 'alt_a',
        strategyName: 'Alternative A',
        strategyType: 'alternative_candidate',
        portfolioState: 'watchlist',
      },
    },
    strategyExperiments: {
      highestPriorityExperiment: {
        strategyKey: 'alt_a',
        strategyName: 'Alternative A',
        strategyType: 'alternative_candidate',
        experimentState: 'shadow_trial',
      },
    },
    strategyTracking: {
      recommendationHandoffState: 'keep_original_plan_baseline',
    },
    todayRecommendation: {
      recommendedStrategy: 'Original Trading Plan',
      posture: 'trade_selectively',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 58,
      postureReason: 'High-impact news within 10 minutes.',
      tpRecommendationReason: 'Global mechanics currently favor Skip 2.',
      projectedWinChance: 57,
    },
    todayContext: {
      nowEt: '2026-03-08 09:42',
      sessionPhase: 'orb_window',
      regime: 'moderate',
      trend: 'up',
    },
    newsQualifier: {
      qualifier: 'High-impact news within 10 minutes.',
    },
  });

  assert(board && typeof board === 'object', 'decision board missing');
  assert(board.advisoryOnly === true, 'decision board must be advisory-only');
  assert(board.baseline && board.baseline.strategyName, 'baseline missing');
  assert(board.topCandidate && board.topCandidate.strategyName, 'topCandidate missing');
  assert(typeof board.posture === 'string' && board.posture.length > 0, 'posture missing');
  assert(typeof board.tpRecommendation === 'string' && board.tpRecommendation.length > 0, 'tpRecommendation missing');
  assert(board.confidence && typeof board.confidence === 'object', 'confidence object missing');
  assert(typeof board.confidenceReason === 'string' && board.confidenceReason.length > 0, 'confidenceReason missing');
  assert(typeof board.summaryLine === 'string' && board.summaryLine.length > 0, 'summaryLine missing');
  assert(String(board.newsCaution || '').trim().length > 0, 'news caution missing');
  assert(String(board.keyRisk || '').trim().length > 0, 'keyRisk missing');
  assert(String(board.newsCaution || '').toLowerCase() !== String(board.keyRisk || '').toLowerCase(), 'dedupe failed: keyRisk should not repeat newsCaution');
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

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3178,
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1');
    assert(out?.status === 'ok', 'command-center endpoint should return ok');
    const board = out?.commandCenter?.decisionBoard;
    assert(board && typeof board === 'object', 'decisionBoard missing from command-center');
    assert(board.baseline && typeof board.baseline === 'object', 'decisionBoard.baseline missing');
    assert(Object.prototype.hasOwnProperty.call(board, 'topCandidate'), 'decisionBoard.topCandidate field missing');
    assert(typeof board.posture === 'string' && board.posture.length > 0, 'decisionBoard.posture missing');
    assert(typeof board.tpRecommendation === 'string' && board.tpRecommendation.length > 0, 'decisionBoard.tpRecommendation missing');
    assert(board.confidence && typeof board.confidence === 'object', 'decisionBoard.confidence missing');
    assert(typeof board.confidenceReason === 'string' && board.confidenceReason.length > 0, 'decisionBoard.confidenceReason missing');
    assert(typeof board.summaryLine === 'string' && board.summaryLine.length > 0, 'decisionBoard.summaryLine missing');
    assert(board.advisoryOnly === true, 'decisionBoard advisoryOnly must be true');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis decision board tests passed.');
  } catch (err) {
    console.error(`Jarvis decision board test failed: ${err.message}`);
    process.exit(1);
  }
})();
