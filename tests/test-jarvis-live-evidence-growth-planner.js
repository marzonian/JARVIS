#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  ensureDataFoundationTables,
} = require('../server/jarvis-core/data-foundation-storage');
const {
  buildLiveEvidenceGrowthPlannerSummary,
  ALLOWED_EVIDENCE_TIERS,
  ALLOWED_TARGET_REACHABILITY_LABELS,
  ALLOWED_ESTIMATED_TIER_DISTANCE,
  ALLOWED_ESTIMATED_DAYS_TO_NEXT_TIER_LABELS,
  ALLOWED_REQUIREMENT_ENUM,
  ALLOWED_PROGRESS_SIGNALS,
  ALLOWED_STALLED_SIGNALS,
} = require('../server/jarvis-core/live-evidence-growth-planner');

const TIMEOUT_MS = 420000;
const TRANSIENT_FETCH_RETRIES = 3;
const TRANSIENT_FETCH_RETRY_DELAY_MS = 250;

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  return db;
}

function insertOutcome(db, {
  scoreDate,
  sourceType = 'live',
  reconstructionPhase = 'live_intraday',
  regimeLabel = 'trending',
  strategyKey = 'orb_3130',
  posture = 'trade_selectively',
} = {}) {
  db.prepare(`
    INSERT INTO jarvis_scored_trade_outcomes (
      score_date,
      source_type,
      reconstruction_phase,
      regime_label,
      strategy_key,
      posture,
      confidence_label,
      confidence_score,
      recommendation_json,
      outcome_json,
      score_label,
      recommendation_delta,
      actual_pnl,
      best_possible_pnl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scoreDate,
    sourceType,
    reconstructionPhase,
    regimeLabel,
    strategyKey,
    posture,
    'medium',
    58,
    '{}',
    '{}',
    'ok',
    2,
    50,
    80
  );
}

function insertDailyRun(db, { runDate, status = 'ok', mode = 'auto', contextsSeen = 3, scoredRows = 2, insertedRows = 1 } = {}) {
  db.prepare(`
    INSERT INTO jarvis_daily_scoring_runs (
      run_date,
      mode,
      window_days,
      contexts_seen,
      scored_rows,
      inserted_rows,
      updated_rows,
      status,
      error_message,
      details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runDate,
    mode,
    3,
    contextsSeen,
    scoredRows,
    insertedRows,
    0,
    status,
    null,
    '{}'
  );
}

function insertLiveSession(db, dateStr) {
  db.prepare(`
    INSERT INTO jarvis_live_session_data (
      source,
      symbol,
      snapshot_at,
      feed_status,
      payload_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    'topstep_sync',
    'MNQ',
    `${dateStr}T14:30:00.000Z`,
    'healthy',
    '{}'
  );
}

function assertBounded(summary) {
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');

  assert(ALLOWED_EVIDENCE_TIERS.has(String(summary.currentEvidenceTier || '')), 'currentEvidenceTier invalid');
  assert(ALLOWED_EVIDENCE_TIERS.has(String(summary.nextTargetTier || '')), 'nextTargetTier invalid');
  assert(ALLOWED_TARGET_REACHABILITY_LABELS.has(String(summary.targetReachabilityLabel || '')), 'targetReachabilityLabel invalid');
  assert(ALLOWED_ESTIMATED_TIER_DISTANCE.has(String(summary.estimatedTierDistance || '')), 'estimatedTierDistance invalid');
  assert(ALLOWED_ESTIMATED_DAYS_TO_NEXT_TIER_LABELS.has(String(summary.estimatedDaysToNextTierLabel || '')), 'estimatedDaysToNextTierLabel invalid');

  assert(Number.isFinite(Number(summary.readinessProgressPct)), 'readinessProgressPct missing');
  assert(Number(summary.readinessProgressPct) >= 0 && Number(summary.readinessProgressPct) <= 100, 'readinessProgressPct out of bounds');

  const requirementArrays = [
    summary.requirementsSatisfied,
    summary.requirementsRemaining,
    summary.hardBlockers,
    summary.softBlockers,
    summary.growthSupports,
    summary.shortestPathActions,
  ];
  for (const arr of requirementArrays) {
    assert(Array.isArray(arr), 'requirement-style array missing');
    for (const item of arr) {
      assert(ALLOWED_REQUIREMENT_ENUM.has(String(item || '')), `invalid requirement/blocker/action: ${item}`);
    }
  }

  assert(Array.isArray(summary.progressSignals), 'progressSignals missing');
  for (const signal of summary.progressSignals) {
    assert(ALLOWED_PROGRESS_SIGNALS.has(String(signal || '')), `invalid progress signal: ${signal}`);
  }

  assert(Array.isArray(summary.stalledSignals), 'stalledSignals missing');
  for (const signal of summary.stalledSignals) {
    assert(ALLOWED_STALLED_SIGNALS.has(String(signal || '')), `invalid stalled signal: ${signal}`);
  }
}

function runUnitChecks() {
  const nowDate = '2026-03-10';

  const blockedDb = makeDb();
  insertOutcome(blockedDb, { scoreDate: '2026-03-09', sourceType: 'live', reconstructionPhase: 'live_1' });
  for (const d of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) {
    insertOutcome(blockedDb, { scoreDate: d, sourceType: 'backfill', reconstructionPhase: `bf_${d}` });
  }

  const blocked = buildLiveEvidenceGrowthPlannerSummary({
    db: blockedDb,
    nowDate,
    snapshotDate: nowDate,
    currentRegimeLabel: 'unknown',
    liveEvidenceAccumulation: {
      liveEvidenceCount: 1,
      backfillEvidenceCount: 5,
      totalEvidenceCount: 6,
      liveEvidencePct: 16.67,
      liveEvidence7d: 1,
      liveEvidence14d: 1,
      liveEvidence30d: 1,
      liveEvidenceGrowthDirection: 'flat',
      liveEvidenceGrowthRatePct: 0,
      intelligenceReadinessLabel: 'not_ready',
      blockers: ['databento_recent_gap_present', 'persistence_still_suppressed'],
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 0 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'suppress_confidence',
      overrideLabel: 'suppressed',
    },
    topstepIntegrationAudit: {
      currentLiveFeedStatus: 'degraded',
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'error' }],
      symbolsStatus: [{ symbol: 'MNQ.c.0', deferredRanges: [{ start: '2026-03-10', end: '2026-03-10' }] }],
    },
    dailyEvidenceScoringStatus: {
      latestRun: { runDate: '2026-03-01', status: 'error' },
    },
  });

  assertBounded(blocked);
  assert(blocked.currentEvidenceTier === 'not_ready', 'blocked fixture should remain not_ready');
  assert(blocked.targetReachabilityLabel === 'blocked', 'blocked fixture should be blocked');
  assert(Number(blocked.readinessProgressPct) <= 30, 'blocked fixture progress must stay low under hard blockers');
  assert(blocked.estimatedTierDistance === 'far', 'blocked fixture tier distance should be far');
  assert(['unknown', 'gt_20_days'].includes(String(blocked.estimatedDaysToNextTierLabel || '')), 'blocked fixture time-to-next-tier should stay conservative');
  assert(Array.isArray(blocked.shortestPathActions) && blocked.shortestPathActions.length > 0, 'shortestPathActions should be non-empty when blocked');
  assert(blocked.shortestPathActions[0] === 'raise_live_outcomes', 'blocked fixture should prioritize raise_live_outcomes first');

  const thinRealityDb = makeDb();
  for (const d of ['2026-03-08', '2026-03-09', '2026-03-10']) {
    insertOutcome(thinRealityDb, { scoreDate: d, sourceType: 'live', reconstructionPhase: `live_${d}` });
    insertDailyRun(thinRealityDb, { runDate: d, status: 'ok' });
    insertLiveSession(thinRealityDb, d);
  }
  for (const d of [
    '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05',
    '2026-02-06', '2026-02-07', '2026-02-08', '2026-02-09', '2026-02-10',
    '2026-02-11', '2026-02-12', '2026-02-13', '2026-02-14', '2026-02-15',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    '2026-02-21', '2026-02-22', '2026-02-23', '2026-02-24', '2026-02-25',
    '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02',
    '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  ]) {
    insertOutcome(thinRealityDb, { scoreDate: d, sourceType: 'backfill', reconstructionPhase: `bf_${d}` });
  }

  const thinReality = buildLiveEvidenceGrowthPlannerSummary({
    db: thinRealityDb,
    nowDate,
    snapshotDate: nowDate,
    currentRegimeLabel: 'wide_volatile',
    liveEvidenceAccumulation: {
      liveEvidenceCount: 3,
      backfillEvidenceCount: 34,
      totalEvidenceCount: 37,
      liveEvidencePct: 8.11,
      liveEvidence7d: 3,
      liveEvidence14d: 3,
      liveEvidence30d: 3,
      liveEvidenceGrowthDirection: 'improving',
      liveEvidenceGrowthRatePct: 4,
      intelligenceReadinessLabel: 'not_ready',
      blockers: ['persistence_still_suppressed', 'backfill_still_dominant', 'topstep_window_thin'],
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 0 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'suppress_confidence',
      overrideLabel: 'suppressed',
    },
    topstepIntegrationAudit: {
      currentLiveFeedStatus: 'healthy',
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'ok' }],
      symbolsStatus: [{ symbol: 'MNQ.c.0', deferredRanges: [] }],
    },
    dailyEvidenceScoringStatus: {
      latestRun: { runDate: '2026-03-10', status: 'ok' },
    },
  });

  assertBounded(thinReality);
  assert(thinReality.currentEvidenceTier === 'not_ready', '3 live / 34 backfill fixture should remain not_ready');
  assert(['blocked', 'distant'].includes(String(thinReality.targetReachabilityLabel || '')), 'thin reality fixture should be blocked or distant');
  assert(Number(thinReality.readinessProgressPct) <= 35, 'thin reality fixture must not show inflated readiness');
  assert(String(thinReality.estimatedTierDistance) === 'far', 'thin reality fixture distance must remain far');
  assert(['unknown', 'gt_20_days'].includes(String(thinReality.estimatedDaysToNextTierLabel || '')), 'thin reality fixture days label must stay conservative');
  assert(typeof thinReality.plannerInsight === 'string' && thinReality.plannerInsight.toLowerCase().includes('firmly not_ready'), 'thin reality insight should be blunt about not_ready state');

  const earlyDb = makeDb();
  for (const d of ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']) {
    insertOutcome(earlyDb, { scoreDate: d, sourceType: 'live', reconstructionPhase: `live_${d}` });
    insertDailyRun(earlyDb, { runDate: d, status: 'ok' });
    insertLiveSession(earlyDb, d);
  }
  for (const d of ['2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07']) {
    insertOutcome(earlyDb, { scoreDate: d, sourceType: 'backfill', reconstructionPhase: `bf_${d}` });
  }

  const early = buildLiveEvidenceGrowthPlannerSummary({
    db: earlyDb,
    nowDate,
    snapshotDate: nowDate,
    currentRegimeLabel: 'trending',
    liveEvidenceAccumulation: {
      liveEvidenceCount: 6,
      backfillEvidenceCount: 8,
      totalEvidenceCount: 14,
      liveEvidencePct: 42.86,
      liveEvidence7d: 6,
      liveEvidence14d: 6,
      liveEvidence30d: 6,
      liveEvidenceGrowthDirection: 'improving',
      liveEvidenceGrowthRatePct: 20,
      intelligenceReadinessLabel: 'early_live_build',
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 1 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'suppress_confidence',
      overrideLabel: 'suppressed',
    },
    topstepIntegrationAudit: {
      currentLiveFeedStatus: 'healthy',
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'ok' }],
      symbolsStatus: [{ symbol: 'MNQ.c.0', deferredRanges: [] }],
    },
    dailyEvidenceScoringStatus: {
      latestRun: { runDate: '2026-03-10', status: 'ok' },
    },
  });

  assertBounded(early);
  assert(early.currentEvidenceTier === 'early_live_build', 'fixture should classify as early_live_build');
  assert(early.nextTargetTier === 'limited_use', 'early fixture should target limited_use next');
  assert(Number(early.readinessProgressPct) <= 70, 'early fixture should not appear near-complete when still building');

  const limitedDb = makeDb();
  for (const d of ['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']) {
    insertOutcome(limitedDb, { scoreDate: d, sourceType: 'live', reconstructionPhase: `live_${d}` });
    insertDailyRun(limitedDb, { runDate: d, status: 'ok' });
    insertLiveSession(limitedDb, d);
  }
  for (const d of ['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']) {
    insertOutcome(limitedDb, { scoreDate: d, sourceType: 'backfill', reconstructionPhase: `bf_${d}` });
  }

  const limited = buildLiveEvidenceGrowthPlannerSummary({
    db: limitedDb,
    nowDate,
    snapshotDate: nowDate,
    currentRegimeLabel: 'ranging',
    liveEvidenceAccumulation: {
      liveEvidenceCount: 18,
      backfillEvidenceCount: 20,
      totalEvidenceCount: 38,
      liveEvidencePct: 47.37,
      liveEvidence7d: 8,
      liveEvidence14d: 12,
      liveEvidence30d: 18,
      liveEvidenceGrowthDirection: 'improving',
      liveEvidenceGrowthRatePct: 25,
      intelligenceReadinessLabel: 'limited_use',
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 2 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'allow_cautious_confidence',
      overrideLabel: 'cautious',
    },
    topstepIntegrationAudit: {
      currentLiveFeedStatus: 'healthy',
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'ok' }],
      symbolsStatus: [{ symbol: 'MNQ.c.0', deferredRanges: [] }],
    },
    dailyEvidenceScoringStatus: {
      latestRun: { runDate: '2026-03-10', status: 'ok' },
    },
  });

  assertBounded(limited);
  assert(limited.currentEvidenceTier === 'limited_use', 'fixture should classify as limited_use');
  assert(limited.currentEvidenceTier !== 'intelligence_ready', 'limited fixture must not overclaim intelligence_ready');

  const nearCandidateButNotReady = buildLiveEvidenceGrowthPlannerSummary({
    db: limitedDb,
    nowDate,
    snapshotDate: nowDate,
    currentRegimeLabel: 'compressed',
    liveEvidenceAccumulation: {
      liveEvidenceCount: 42,
      backfillEvidenceCount: 26,
      totalEvidenceCount: 68,
      liveEvidencePct: 61.76,
      liveEvidence7d: 9,
      liveEvidence14d: 18,
      liveEvidence30d: 42,
      liveEvidenceGrowthDirection: 'improving',
      liveEvidenceGrowthRatePct: 12,
      intelligenceReadinessLabel: 'intelligence_candidate',
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 4 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'allow_structured_confidence',
      overrideLabel: 'enabled',
    },
    topstepIntegrationAudit: {
      currentLiveFeedStatus: 'healthy',
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'ok' }],
      symbolsStatus: [{ symbol: 'MNQ.c.0', deferredRanges: [] }],
    },
    dailyEvidenceScoringStatus: {
      latestRun: { runDate: '2026-03-10', status: 'ok' },
    },
  });

  assertBounded(nearCandidateButNotReady);
  assert(nearCandidateButNotReady.currentEvidenceTier !== 'intelligence_ready', 'non-elite fixture must not jump to intelligence_ready');

  blockedDb.close();
  thinRealityDb.close();
  earlyDb.close();
  limitedDb.close();
}

async function getJson(baseUrl, endpoint) {
  let lastErr = null;
  for (let attempt = 0; attempt <= TRANSIENT_FETCH_RETRIES; attempt += 1) {
    try {
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) {
      const message = String(err?.message || err || '');
      const transient = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated/i.test(message);
      if (!transient || attempt >= TRANSIENT_FETCH_RETRIES) {
        throw err;
      }
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_FETCH_RETRY_DELAY_MS));
    }
  }
  throw lastErr || new Error(`fetch failed: ${endpoint}`);
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3211,
    env: {
      DATABENTO_AUTO_INGEST_ENABLED: 'false',
    },
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/evidence/live-growth-planner?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'live-growth-planner endpoint should return ok');
    const summary = out?.liveEvidenceGrowthPlanner;
    assert(summary && typeof summary === 'object', 'liveEvidenceGrowthPlanner missing');
    assertBounded(summary);
    assert(typeof summary.plannerInsight === 'string' && summary.plannerInsight.length > 0, 'plannerInsight missing');

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.liveEvidenceGrowthPlanner && typeof center.liveEvidenceGrowthPlanner === 'object', 'top-level liveEvidenceGrowthPlanner missing in command-center response');

    const cc = center?.commandCenter || {};
    assert(ALLOWED_EVIDENCE_TIERS.has(String(cc.liveEvidenceTier || '')), 'commandCenter.liveEvidenceTier invalid');
    assert(ALLOWED_EVIDENCE_TIERS.has(String(cc.nextLiveEvidenceTargetTier || '')), 'commandCenter.nextLiveEvidenceTargetTier invalid');
    assert(ALLOWED_TARGET_REACHABILITY_LABELS.has(String(cc.liveEvidenceTargetReachability || '')), 'commandCenter.liveEvidenceTargetReachability invalid');
    assert(Number.isFinite(Number(cc.liveEvidenceReadinessProgressPct)), 'commandCenter.liveEvidenceReadinessProgressPct missing');
    assert(Number(cc.liveEvidenceReadinessProgressPct) >= 0 && Number(cc.liveEvidenceReadinessProgressPct) <= 100, 'commandCenter.liveEvidenceReadinessProgressPct out of bounds');
    if (cc.liveEvidenceHighestPriorityAction !== null) {
      assert(ALLOWED_REQUIREMENT_ENUM.has(String(cc.liveEvidenceHighestPriorityAction || '')), 'commandCenter.liveEvidenceHighestPriorityAction invalid');
    }
    assert(typeof cc.liveEvidencePlannerInsight === 'string' && cc.liveEvidencePlannerInsight.length > 0, 'commandCenter.liveEvidencePlannerInsight missing');

    const decisionBoard = cc?.decisionBoard || {};
    assert(ALLOWED_EVIDENCE_TIERS.has(String(decisionBoard.liveEvidenceTier || '')), 'decisionBoard.liveEvidenceTier invalid');
    assert(ALLOWED_EVIDENCE_TIERS.has(String(decisionBoard.nextLiveEvidenceTargetTier || '')), 'decisionBoard.nextLiveEvidenceTargetTier invalid');
    assert(ALLOWED_TARGET_REACHABILITY_LABELS.has(String(decisionBoard.liveEvidenceTargetReachability || '')), 'decisionBoard.liveEvidenceTargetReachability invalid');

    const todayRecommendation = cc?.todayRecommendation || {};
    assert(ALLOWED_EVIDENCE_TIERS.has(String(todayRecommendation.liveEvidenceTier || '')), 'todayRecommendation.liveEvidenceTier invalid');
    assert(ALLOWED_EVIDENCE_TIERS.has(String(todayRecommendation.nextLiveEvidenceTargetTier || '')), 'todayRecommendation.nextLiveEvidenceTargetTier invalid');
    assert(Number.isFinite(Number(todayRecommendation.liveEvidenceReadinessProgressPct)), 'todayRecommendation.liveEvidenceReadinessProgressPct missing');
    assert(Number(todayRecommendation.liveEvidenceReadinessProgressPct) >= 0 && Number(todayRecommendation.liveEvidenceReadinessProgressPct) <= 100, 'todayRecommendation.liveEvidenceReadinessProgressPct out of bounds');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ live evidence growth planner checks passed');
  } catch (err) {
    console.error('❌ live evidence growth planner checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
