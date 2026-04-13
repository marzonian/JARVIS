#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  deriveNewsImpactStatus,
  classifyPosture,
  selectTpRecommendation,
  buildTodayRecommendation,
} = require('../server/jarvis-core/today-recommendation');

const TIMEOUT_MS = 120000;

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
  const imminent = deriveNewsImpactStatus({
    recommendationAdjustment: 'delay_or_downgrade',
    normalizedEvents: [
      { impact: 'high', deltaMinutes: 9, time: '09:39' },
    ],
  });
  assert(imminent.status === 'high_impact_imminent', 'imminent news status mismatch');

  const waitPosture = classifyPosture({
    projectedWinChance: 62,
    historicalStance: 'favorable',
    sessionPhase: 'orb_window',
    newsImpact: imminent,
  });
  assert(waitPosture.posture === 'wait_for_news', 'imminent high impact should force wait_for_news');

  const standDown = classifyPosture({
    projectedWinChance: 41,
    historicalStance: 'mixed',
    sessionPhase: 'pre_open',
    newsImpact: deriveNewsImpactStatus({ recommendationAdjustment: 'normal' }),
  });
  assert(standDown.posture === 'stand_down', 'low projected edge should produce stand_down');

  const normal = classifyPosture({
    projectedWinChance: 66,
    historicalStance: 'favorable',
    sessionPhase: 'post_orb',
    newsImpact: deriveNewsImpactStatus({ recommendationAdjustment: 'normal' }),
  });
  assert(normal.posture === 'trade_normally', 'favorable high-edge setup should be trade_normally');

  const reliabilityDowngraded = classifyPosture({
    projectedWinChance: 57.35,
    historicalStance: 'mixed',
    sessionPhase: 'outside_window',
    newsImpact: deriveNewsImpactStatus({ recommendationAdjustment: 'normal' }),
    reliabilityContext: {
      fallbackLevel: 'global',
      trend: 'ranging',
      volatility: 'extreme',
      orbProfile: 'wide',
      orbRangeTicks: 382,
      weakLiveConfirmation: true,
    },
  });
  assert(reliabilityDowngraded.posture === 'wait_for_clearance', 'fallback/global high-risk mixed-confirmation context should downgrade posture to wait_for_clearance');

  const exactContextNoDowngrade = classifyPosture({
    projectedWinChance: 57.35,
    historicalStance: 'mixed',
    sessionPhase: 'outside_window',
    newsImpact: deriveNewsImpactStatus({ recommendationAdjustment: 'normal' }),
    reliabilityContext: {
      fallbackLevel: 'exact_context',
      trend: 'ranging',
      volatility: 'extreme',
      orbProfile: 'wide',
      orbRangeTicks: 382,
      weakLiveConfirmation: true,
    },
  });
  assert(exactContextNoDowngrade.posture === 'trade_selectively', 'exact-context should not trigger reliability gate');

  const lowRiskNoDowngrade = classifyPosture({
    projectedWinChance: 57.35,
    historicalStance: 'mixed',
    sessionPhase: 'outside_window',
    newsImpact: deriveNewsImpactStatus({ recommendationAdjustment: 'normal' }),
    reliabilityContext: {
      fallbackLevel: 'global',
      trend: 'trending',
      volatility: 'normal',
      orbProfile: 'normal',
      orbRangeTicks: 140,
      weakLiveConfirmation: true,
    },
  });
  assert(lowRiskNoDowngrade.posture === 'trade_selectively', 'lower-risk context should not trigger reliability gate');

  const tp = selectTpRecommendation({
    globalRecommendedTpMode: 'Skip 2',
    contextualRecommendation: {
      contextualRecommendedTpMode: 'Nearest',
      confidenceLabel: 'high',
      sampleSize: 48,
      fallbackLevel: 'drop_regime',
      contextUsed: { weekday: 'Tuesday', timeBucket: 'orb_window' },
    },
  });
  assert(tp.recommendedTpMode === 'Nearest', 'contextual TP should win when confidence/sample are strong');
  assert(tp.recommendationBasis === 'contextual_mechanics', 'tp recommendation basis mismatch');

  const guardedTp = selectTpRecommendation({
    globalRecommendedTpMode: 'Skip 2',
    contextualRecommendation: {
      contextualRecommendedTpMode: 'Skip 2',
      confidenceLabel: 'high',
      sampleSize: 120,
      fallbackLevel: 'global',
      contextUsed: { weekday: 'Monday', timeBucket: 'late_window' },
    },
    tpGuardContext: {
      trend: 'ranging',
      volatility: 'extreme',
      orbProfile: 'wide',
      orbRangeTicks: 382,
    },
  });
  assert(guardedTp.recommendedTpMode === 'Nearest', 'fallback/global aggressive TP should be capped to Nearest in wide+extreme+ranging context');
  assert(/guardrail override/i.test(String(guardedTp.tpRecommendationReason || '')), 'guarded TP reason should explain override');

  const exactContextAggressiveTp = selectTpRecommendation({
    globalRecommendedTpMode: 'Skip 2',
    contextualRecommendation: {
      contextualRecommendedTpMode: 'Skip 2',
      confidenceLabel: 'high',
      sampleSize: 120,
      fallbackLevel: 'exact_context',
      contextUsed: { weekday: 'Monday', timeBucket: 'late_window' },
    },
    tpGuardContext: {
      trend: 'ranging',
      volatility: 'extreme',
      orbProfile: 'wide',
      orbRangeTicks: 382,
    },
  });
  assert(exactContextAggressiveTp.recommendedTpMode === 'Skip 2', 'exact-context TP recommendation should not be downgraded');

  const nonRiskFallbackTp = selectTpRecommendation({
    globalRecommendedTpMode: 'Skip 2',
    contextualRecommendation: {
      contextualRecommendedTpMode: 'Skip 2',
      confidenceLabel: 'high',
      sampleSize: 120,
      fallbackLevel: 'global',
      contextUsed: { weekday: 'Tuesday', timeBucket: 'orb_window' },
    },
    tpGuardContext: {
      trend: 'trending',
      volatility: 'normal',
      orbProfile: 'normal',
      orbRangeTicks: 150,
    },
  });
  assert(nonRiskFallbackTp.recommendedTpMode === 'Skip 2', 'non-risk context should preserve fallback/global TP recommendation');

  const today = buildTodayRecommendation({
    recommendedStrategy: 'Original Trading Plan',
    strategyConfidence: 63,
    globalRecommendedTpMode: 'Skip 2',
    contextualRecommendation: {
      contextualRecommendedTpMode: 'Nearest',
      confidenceLabel: 'medium',
      confidenceScore: 61,
      sampleSize: 30,
      fallbackLevel: 'drop_regime',
      contextUsed: { weekday: 'Tuesday', timeBucket: 'post_orb' },
    },
    projectedWinChance: 57,
    news: {
      recommendationAdjustment: 'qualify',
      qualifier: 'News window near open may distort ORB behavior.',
      normalizedEvents: [],
    },
    historicalContext: {
      stance: 'mixed',
      narrative: 'Current day/time profile is mixed.',
    },
    sessionPhase: 'post_orb',
  });
  assert(today && typeof today === 'object', 'today recommendation missing');
  assert(today.posture === 'trade_selectively', 'qualify news should downgrade to trade_selectively');
  assert(today.recommendedStrategy === 'Original Trading Plan', 'recommendedStrategy mismatch');
  assert(['high', 'medium', 'low'].includes(String(today.confidenceLabel || '')), 'confidenceLabel missing');
  assert(today.advisoryOnly === true, 'today recommendation must stay advisory-only');

  const todayReliabilityGate = buildTodayRecommendation({
    recommendedStrategy: 'Original Trading Plan',
    strategyConfidence: 55,
    globalRecommendedTpMode: 'Skip 2',
    contextualRecommendation: {
      contextualRecommendedTpMode: 'Skip 2',
      confidenceLabel: 'high',
      confidenceScore: 77.5,
      sampleSize: 120,
      fallbackLevel: 'global',
      contextUsed: { weekday: 'Monday', timeBucket: 'late_window', regime: null },
    },
    projectedWinChance: 57.35,
    news: {
      recommendationAdjustment: 'normal',
      qualifier: 'No near-term high-impact news distortion detected.',
      normalizedEvents: [],
    },
    historicalContext: {
      stance: 'mixed',
      narrative: 'Current day/time profile is mixed.',
    },
    sessionPhase: 'outside_window',
    tpGuardContext: {
      trend: 'ranging',
      volatility: 'extreme',
      orbProfile: 'wide',
      orbRangeTicks: 382,
    },
  });
  assert(todayReliabilityGate.posture === 'wait_for_clearance', 'buildTodayRecommendation should apply reliability posture gate for fallback/global high-risk mixed-confirmation context');
  assert(/fallback/i.test(String(todayReliabilityGate.postureReason || '')), 'reliability posture reason should explain fallback-driven caution');
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3171,
  });
  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1');
    assert(out?.status === 'ok', 'command-center endpoint should return ok');
    const rec = out?.commandCenter?.todayRecommendation;
    assert(rec && typeof rec === 'object', 'todayRecommendation missing from command center');
    assert(['trade_normally', 'trade_selectively', 'wait_for_news', 'wait_for_clearance', 'stand_down'].includes(String(rec.posture || '')), 'invalid todayRecommendation posture');
    assert(typeof rec.recommendedStrategy === 'string' && rec.recommendedStrategy.length > 0, 'recommendedStrategy missing');
    assert(typeof rec.recommendedTpMode === 'string' && rec.recommendedTpMode.length > 0, 'recommendedTpMode missing');
    assert(['high', 'medium', 'low'].includes(String(rec.confidenceLabel || '')), 'confidenceLabel missing');
    assert(rec.advisoryOnly === true, 'todayRecommendation must be advisory-only');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis today recommendation tests passed.');
  } catch (err) {
    console.error(`Jarvis today recommendation test failed: ${err.message}`);
    process.exit(1);
  }
})();
