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
  buildLiveEvidenceAccumulationSummary,
  ALLOWED_EVIDENCE_DEPTH_LABELS,
  ALLOWED_EVIDENCE_FRESHNESS_LABELS,
  ALLOWED_EVIDENCE_RELIABILITY_LABELS,
  ALLOWED_INTELLIGENCE_READINESS_LABELS,
  ALLOWED_GROWTH_DIRECTIONS,
  ALLOWED_BLOCKERS,
  ALLOWED_SUPPORTS,
} = require('../server/jarvis-core/live-evidence-accumulation');
const {
  LIVE_CHECKPOINT_STATUS_ENUM,
  LIVE_CHECKPOINT_REASON_ENUM,
  LIVE_FINALIZATION_SWEEP_SOURCE_ENUM,
  CHECKPOINT_WINDOW_REASON_ENUM,
  RUNTIME_CHECKPOINT_OUTCOME_ENUM,
  LIVE_INSERTION_SLA_OUTCOME_ENUM,
  LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM,
  LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM,
  LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM,
  LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM,
  LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM,
  LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM,
  LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM,
  LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM,
  LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM,
  LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM,
  LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM,
  LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM,
} = require('../server/jarvis-core/daily-evidence-scoring');

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

function insertGap(db, {
  symbol = 'MNQ.c.0',
  gapStart = '2026-03-09',
  gapEnd = '2026-03-10',
  status = 'open',
  resolvedAt = null,
} = {}) {
  db.prepare(`
    INSERT INTO jarvis_databento_gap_audit (
      provider,
      dataset,
      schema_name,
      symbol,
      gap_start,
      gap_end,
      status,
      discovered_at,
      resolved_at,
      details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'databento',
    'GLBX.MDP3',
    'ohlcv-1m',
    symbol,
    gapStart,
    gapEnd,
    status,
    `${gapStart}T00:00:00.000Z`,
    resolvedAt,
    '{}'
  );
}

function assertBounded(summary) {
  assert(summary && typeof summary === 'object', 'summary missing');
  assert(summary.advisoryOnly === true, 'summary must be advisoryOnly');
  assert(Number.isFinite(Number(summary.totalEvidenceCount)), 'totalEvidenceCount missing');
  assert(Number.isFinite(Number(summary.liveEvidenceCount)), 'liveEvidenceCount missing');
  assert(Number.isFinite(Number(summary.backfillEvidenceCount)), 'backfillEvidenceCount missing');
  assert(Number(summary.liveEvidencePct) >= 0 && Number(summary.liveEvidencePct) <= 100, 'liveEvidencePct out of bounds');
  assert(Number(summary.backfillEvidencePct) >= 0 && Number(summary.backfillEvidencePct) <= 100, 'backfillEvidencePct out of bounds');
  assert(ALLOWED_GROWTH_DIRECTIONS.has(String(summary.liveEvidenceGrowthDirection || '')), 'liveEvidenceGrowthDirection invalid');
  assert(ALLOWED_EVIDENCE_DEPTH_LABELS.has(String(summary.evidenceDepthLabel || '')), 'evidenceDepthLabel invalid');
  assert(ALLOWED_EVIDENCE_FRESHNESS_LABELS.has(String(summary.evidenceFreshnessLabel || '')), 'evidenceFreshnessLabel invalid');
  assert(ALLOWED_EVIDENCE_RELIABILITY_LABELS.has(String(summary.evidenceReliabilityLabel || '')), 'evidenceReliabilityLabel invalid');
  assert(ALLOWED_INTELLIGENCE_READINESS_LABELS.has(String(summary.intelligenceReadinessLabel || '')), 'intelligenceReadinessLabel invalid');
  assert(Array.isArray(summary.blockers), 'blockers missing');
  assert(Array.isArray(summary.supports), 'supports missing');
  for (const blocker of summary.blockers) {
    assert(ALLOWED_BLOCKERS.has(String(blocker || '')), `invalid blocker: ${blocker}`);
  }
  for (const support of summary.supports) {
    assert(ALLOWED_SUPPORTS.has(String(support || '')), `invalid support: ${support}`);
  }
  for (const moduleName of ['strategyModule', 'regimeModule', 'persistenceModule']) {
    const row = summary[moduleName];
    assert(row && typeof row === 'object', `${moduleName} missing`);
    assert(typeof row.enoughEvidence === 'boolean', `${moduleName}.enoughEvidence missing`);
    assert(ALLOWED_EVIDENCE_RELIABILITY_LABELS.has(String(row.evidenceQualityLabel || '')), `${moduleName}.evidenceQualityLabel invalid`);
    assert(Array.isArray(row.blockerReasons), `${moduleName}.blockerReasons missing`);
    assert(Array.isArray(row.supportingReasons), `${moduleName}.supportingReasons missing`);
    for (const blocker of row.blockerReasons) {
      assert(ALLOWED_BLOCKERS.has(String(blocker || '')), `${moduleName} invalid blocker: ${blocker}`);
    }
    for (const support of row.supportingReasons) {
      assert(ALLOWED_SUPPORTS.has(String(support || '')), `${moduleName} invalid support: ${support}`);
    }
    assert(row.advisoryOnly === true, `${moduleName}.advisoryOnly must be true`);
  }
}

function runUnitChecks() {
  const db = makeDb();
  const nowDate = '2026-03-10';

  for (const d of ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']) {
    insertOutcome(db, { scoreDate: d, sourceType: 'live', reconstructionPhase: `live_${d}` });
  }
  for (const d of ['2026-02-26', '2026-02-27', '2026-03-01']) {
    insertOutcome(db, { scoreDate: d, sourceType: 'live', reconstructionPhase: `prev_live_${d}` });
  }
  for (const d of ['2026-02-24', '2026-02-25', '2026-02-28', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']) {
    insertOutcome(db, { scoreDate: d, sourceType: 'backfill', reconstructionPhase: `backfill_${d}` });
  }

  for (const d of ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']) {
    insertDailyRun(db, { runDate: d, status: 'ok' });
  }

  insertLiveSession(db, '2026-03-08');
  insertLiveSession(db, '2026-03-09');
  insertLiveSession(db, '2026-03-10');

  const summary = buildLiveEvidenceAccumulationSummary({
    db,
    nowDate,
    snapshotDate: nowDate,
    windowSessions: 120,
    performanceSource: 'all',
    currentRegimeLabel: 'trending',
    recommendationPerformanceSummary: {
      sampleSize30d: 18,
      sourceBreakdown: {
        live: 10,
        backfill: 8,
        total: 18,
      },
    },
    dataCoverage: {
      evidenceReadiness: {
        strategyModule: { enoughEvidence: true, sampleSize30d: 18, liveSampleSize: 10 },
        regimeModule: { enoughEvidence: true, sampleSize30d: 18, liveSampleSize: 10 },
        persistenceModule: { enoughEvidence: true, sampleSize30d: 18, liveSampleSize: 10, confidencePolicy: 'allow_cautious_confidence' },
      },
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 2 },
        sourceBreakdown: { live: 10, backfill: 8, total: 18 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'allow_cautious_confidence',
      overrideLabel: 'cautious',
    },
    regimePersistenceTrustOverrideDelta: {
      deltaDirection: 'improving',
    },
    regimeLivePersistenceQuality: {
      currentRegimeLiveCapturedTenureDays: 4,
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

  assertBounded(summary);
  assert(summary.totalEvidenceCount === 18, 'totalEvidenceCount should match inserted rows');
  assert(summary.liveEvidenceCount === 10, 'liveEvidenceCount should match inserted live rows');
  assert(summary.backfillEvidenceCount === 8, 'backfillEvidenceCount should match inserted backfill rows');
  assert(summary.liveEvidencePct > summary.backfillEvidencePct, 'liveEvidencePct should exceed backfillEvidencePct in this fixture');
  assert(summary.liveEvidence7d === 7, 'liveEvidence7d should count latest 7 days');
  assert(summary.liveEvidenceGrowthDirection === 'improving', 'growth direction should be improving with stronger recent live counts');
  assert(summary.supports.includes('live_evidence_growing'), 'support should include live_evidence_growing');
  assert(summary.supports.length >= 1, 'supports should include at least one bounded support reason');

  const thinDb = makeDb();
  insertOutcome(thinDb, { scoreDate: '2026-03-09', sourceType: 'live', reconstructionPhase: 'live_a' });
  insertOutcome(thinDb, { scoreDate: '2026-03-10', sourceType: 'live', reconstructionPhase: 'live_b' });
  for (const d of ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']) {
    insertOutcome(thinDb, { scoreDate: d, sourceType: 'backfill', reconstructionPhase: `bf_${d}` });
  }
  insertLiveSession(thinDb, '2026-03-10');
  insertGap(thinDb, { symbol: 'MNQ.c.0', gapStart: '2026-03-10', gapEnd: '2026-03-10', status: 'deferred_recent' });

  const thinSummary = buildLiveEvidenceAccumulationSummary({
    db: thinDb,
    nowDate,
    snapshotDate: nowDate,
    currentRegimeLabel: 'unknown',
    dataCoverage: {
      evidenceReadiness: {
        strategyModule: { enoughEvidence: false, sampleSize30d: 8, liveSampleSize: 2 },
        regimeModule: { enoughEvidence: false, sampleSize30d: 8, liveSampleSize: 1 },
        persistenceModule: { enoughEvidence: false, sampleSize30d: 8, liveSampleSize: 1, confidencePolicy: 'suppress_confidence' },
      },
    },
    regimePerformanceFeedback: {
      dataQuality: {
        coverage: { withProvenance: 0 },
        sourceBreakdown: { live: 0, backfill: 8, total: 8 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'suppress_confidence',
      overrideLabel: 'suppressed',
    },
    regimePersistenceTrustOverrideDelta: {
      deltaDirection: 'flat',
    },
    regimeLivePersistenceQuality: {
      currentRegimeLiveCapturedTenureDays: 1,
    },
    topstepIntegrationAudit: {
      currentLiveFeedStatus: 'healthy',
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'ok' }],
      symbolsStatus: [{ symbol: 'MNQ.c.0', deferredRanges: [{ start: '2026-03-10', end: '2026-03-10' }] }],
    },
  });

  assertBounded(thinSummary);
  assert(thinSummary.evidenceDepthLabel === 'insufficient', 'thin fixture should remain insufficient depth');
  assert(thinSummary.intelligenceReadinessLabel === 'not_ready', 'thin fixture should remain not_ready');
  assert(thinSummary.blockers.includes('live_sample_too_small'), 'thin fixture should include live_sample_too_small blocker');
  assert(thinSummary.blockers.includes('backfill_dominant'), 'thin fixture should include backfill_dominant blocker');
  assert(thinSummary.blockers.includes('persistence_still_suppressed'), 'thin fixture should include persistence_still_suppressed blocker');
  assert(thinSummary.blockers.includes('databento_recent_gap_present'), 'thin fixture should include databento_recent_gap_present blocker');

  db.close();
  thinDb.close();
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
    // Use an ephemeral port by default to avoid cross-suite port reuse flakes.
    port: process.env.JARVIS_AUDIT_PORT || 0,
    env: {
      DATABENTO_AUTO_INGEST_ENABLED: 'false',
    },
  });

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/evidence/live-accumulation?windowSessions=120&performanceSource=all&force=1');
    assert(out?.status === 'ok', 'live-accumulation endpoint should return ok');
    const summary = out?.liveEvidenceAccumulation;
    assert(summary && typeof summary === 'object', 'liveEvidenceAccumulation missing');
    assertBounded(summary);
    assert(typeof summary.liveEvidenceInsight === 'string' && summary.liveEvidenceInsight.length > 0, 'liveEvidenceInsight missing');
    const dailyScoringStatusOut = await getJson(server.baseUrl, '/api/jarvis/evidence/daily-scoring?windowSessions=120&performanceSource=all&force=1');
    assert(dailyScoringStatusOut?.status === 'ok', 'daily-scoring endpoint should return ok');
    const dailyScoringStatus = dailyScoringStatusOut?.dailyEvidenceScoringStatus || {};

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(center?.status === 'ok', 'command-center endpoint should return ok');
    assert(center?.liveEvidenceAccumulation && typeof center.liveEvidenceAccumulation === 'object', 'top-level liveEvidenceAccumulation missing in command-center response');

    const cc = center?.commandCenter || {};
    assert(typeof cc.liveEvidenceSummary === 'string' && cc.liveEvidenceSummary.length > 0, 'commandCenter.liveEvidenceSummary missing');
    assert(ALLOWED_EVIDENCE_DEPTH_LABELS.has(String(cc.liveEvidenceDepthLabel || '')), 'commandCenter.liveEvidenceDepthLabel invalid');
    assert(ALLOWED_EVIDENCE_RELIABILITY_LABELS.has(String(cc.liveEvidenceReliabilityLabel || '')), 'commandCenter.liveEvidenceReliabilityLabel invalid');
    assert(ALLOWED_GROWTH_DIRECTIONS.has(String(cc.liveEvidenceGrowthDirection || '')), 'commandCenter.liveEvidenceGrowthDirection invalid');
    assert(ALLOWED_INTELLIGENCE_READINESS_LABELS.has(String(cc.intelligenceReadinessLabel || '')), 'commandCenter.intelligenceReadinessLabel invalid');
    assert(typeof cc.liveEvidenceInsight === 'string' && cc.liveEvidenceInsight.length > 0, 'commandCenter.liveEvidenceInsight missing');
    assert(typeof cc.liveEvidenceCreatedToday === 'boolean', 'commandCenter.liveEvidenceCreatedToday missing');
    assert(Number.isFinite(Number(cc.liveEvidenceContextsSeenToday)), 'commandCenter.liveEvidenceContextsSeenToday missing');
    assert(Number.isFinite(Number(cc.liveEvidenceContextsEligibleToday)), 'commandCenter.liveEvidenceContextsEligibleToday missing');
    assert(Number.isFinite(Number(cc.liveEvidenceContextsScoredToday)), 'commandCenter.liveEvidenceContextsScoredToday missing');
    assert(Number.isFinite(Number(cc.liveEvidenceRowsInsertedToday)), 'commandCenter.liveEvidenceRowsInsertedToday missing');
    assert(Number.isFinite(Number(cc.liveEvidenceRowsUpdatedToday)), 'commandCenter.liveEvidenceRowsUpdatedToday missing');
    assert(cc.liveEvidenceReasonBucketsToday && typeof cc.liveEvidenceReasonBucketsToday === 'object', 'commandCenter.liveEvidenceReasonBucketsToday missing');
    assert(Array.isArray(cc.liveEvidenceLatestUnconvertedDates), 'commandCenter.liveEvidenceLatestUnconvertedDates missing');
    if (cc.liveEvidenceTopBlockedReasonToday !== null && cc.liveEvidenceTopBlockedReasonToday !== undefined) {
      assert(typeof cc.liveEvidenceTopBlockedReasonToday === 'string', 'commandCenter.liveEvidenceTopBlockedReasonToday should be string when present');
    }
    assert(Number.isFinite(Number(cc.liveFinalizationPendingCount)), 'commandCenter.liveFinalizationPendingCount missing');
    assert(Number.isFinite(Number(cc.liveFinalizationFinalizedTodayCount)), 'commandCenter.liveFinalizationFinalizedTodayCount missing');
    assert(Number.isFinite(Number(cc.liveFinalizationValidLiveDaysSeen)), 'commandCenter.liveFinalizationValidLiveDaysSeen missing');
    assert(Number.isFinite(Number(cc.liveFinalizationValidLiveDaysReadyToFinalize)), 'commandCenter.liveFinalizationValidLiveDaysReadyToFinalize missing');
    assert(Number.isFinite(Number(cc.liveFinalizationValidLiveDaysFinalizedInserted)), 'commandCenter.liveFinalizationValidLiveDaysFinalizedInserted missing');
    assert(Number.isFinite(Number(cc.liveFinalizationValidLiveDaysFinalizedUpdated)), 'commandCenter.liveFinalizationValidLiveDaysFinalizedUpdated missing');
    assert(Number.isFinite(Number(cc.liveFinalizationValidLiveDaysStillWaiting)), 'commandCenter.liveFinalizationValidLiveDaysStillWaiting missing');
    assert(Number.isFinite(Number(cc.liveFinalizationValidLiveDaysBlocked)), 'commandCenter.liveFinalizationValidLiveDaysBlocked missing');
    assert(Number.isFinite(Number(cc.liveFinalizationMissedValidDaysCount)), 'commandCenter.liveFinalizationMissedValidDaysCount missing');
    if (cc.liveFinalizationSweepSource !== null && cc.liveFinalizationSweepSource !== undefined) {
      assert(typeof cc.liveFinalizationSweepSource === 'string', 'commandCenter.liveFinalizationSweepSource should be string when present');
    }
    assert(Array.isArray(cc.liveFinalizationLatestReadyButUninsertedDates), 'commandCenter.liveFinalizationLatestReadyButUninsertedDates missing');
    assert(Array.isArray(cc.liveFinalizationLatestWaitingDates), 'commandCenter.liveFinalizationLatestWaitingDates missing');
    assert(Array.isArray(cc.liveFinalizationLatestBlockedDates), 'commandCenter.liveFinalizationLatestBlockedDates missing');
    assert(Number.isFinite(Number(cc.invalidLiveContextsCreatedToday)), 'commandCenter.invalidLiveContextsCreatedToday missing');
    assert(Number.isFinite(Number(cc.invalidLiveContextsSuppressedToday)), 'commandCenter.invalidLiveContextsSuppressedToday missing');
    assert(Array.isArray(cc.latestInvalidLiveContextDates), 'commandCenter.latestInvalidLiveContextDates missing');
    assert(Number.isFinite(Number(cc.liveEvidenceNetNew1d)), 'commandCenter.liveEvidenceNetNew1d missing');
    assert(Number.isFinite(Number(cc.liveEvidenceNetNew3d)), 'commandCenter.liveEvidenceNetNew3d missing');
    assert(Number.isFinite(Number(cc.liveEvidenceNetNew7d)), 'commandCenter.liveEvidenceNetNew7d missing');
    assert(LIVE_CHECKPOINT_STATUS_ENUM.includes(String(cc.liveCheckpointStatus || '')), 'commandCenter.liveCheckpointStatus invalid');
    assert(LIVE_CHECKPOINT_REASON_ENUM.includes(String(cc.liveCheckpointReason || '')), 'commandCenter.liveCheckpointReason invalid');
    if (cc.liveCheckpointSweepSource !== null && cc.liveCheckpointSweepSource !== undefined) {
      assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(cc.liveCheckpointSweepSource || '')), 'commandCenter.liveCheckpointSweepSource invalid');
    }
    if (cc.liveCheckpointTargetTradingDay !== null && cc.liveCheckpointTargetTradingDay !== undefined) {
      assert(typeof cc.liveCheckpointTargetTradingDay === 'string', 'commandCenter.liveCheckpointTargetTradingDay should be string when present');
    }
    assert(typeof cc.liveCheckpointCloseComplete === 'boolean', 'commandCenter.liveCheckpointCloseComplete missing');
    if (cc.liveCheckpointCloseCompleteReason !== null && cc.liveCheckpointCloseCompleteReason !== undefined) {
      assert(typeof cc.liveCheckpointCloseCompleteReason === 'string', 'commandCenter.liveCheckpointCloseCompleteReason should be string when present');
    }
    assert(Number.isFinite(Number(cc.liveCheckpointExpectedOutcomeCount)), 'commandCenter.liveCheckpointExpectedOutcomeCount missing');
    assert(Number.isFinite(Number(cc.liveCheckpointActualOutcomeCount)), 'commandCenter.liveCheckpointActualOutcomeCount missing');
    assert(Number.isFinite(Number(cc.liveCheckpointInsertDelta)), 'commandCenter.liveCheckpointInsertDelta missing');
    assert(typeof cc.liveCheckpointFirstEligibleCycleExpectedInsert === 'boolean', 'commandCenter.liveCheckpointFirstEligibleCycleExpectedInsert missing');
    assert(typeof cc.liveCheckpointFirstEligibleCycleInsertAttempted === 'boolean', 'commandCenter.liveCheckpointFirstEligibleCycleInsertAttempted missing');
    assert(typeof cc.liveCheckpointFirstEligibleCycleInsertSucceeded === 'boolean', 'commandCenter.liveCheckpointFirstEligibleCycleInsertSucceeded missing');
    if (cc.liveCheckpointFirstEligibleCycleFailureReason !== null && cc.liveCheckpointFirstEligibleCycleFailureReason !== undefined) {
      assert(typeof cc.liveCheckpointFirstEligibleCycleFailureReason === 'string', 'commandCenter.liveCheckpointFirstEligibleCycleFailureReason should be string when present');
    }
    assert(Number.isFinite(Number(cc.liveCheckpointFailureCount)), 'commandCenter.liveCheckpointFailureCount missing');
    assert(Array.isArray(cc.latestMissedCheckpointDates), 'commandCenter.latestMissedCheckpointDates missing');
    assert(Array.isArray(cc.latestCheckpointFailures), 'commandCenter.latestCheckpointFailures missing');
    assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(cc.liveRuntimeCheckpointOutcome || '')), 'commandCenter.liveRuntimeCheckpointOutcome invalid');
    assert(typeof cc.liveRuntimeCheckpointWasAutonomous === 'boolean', 'commandCenter.liveRuntimeCheckpointWasAutonomous missing');
    assert(typeof cc.liveRuntimeCheckpointTriggered === 'boolean', 'commandCenter.liveRuntimeCheckpointTriggered missing');
    if (cc.liveRuntimeCheckpointTriggeredAt !== null && cc.liveRuntimeCheckpointTriggeredAt !== undefined) {
      assert(typeof cc.liveRuntimeCheckpointTriggeredAt === 'string', 'commandCenter.liveRuntimeCheckpointTriggeredAt should be string when present');
    }
    if (cc.liveRuntimeCheckpointSource !== null && cc.liveRuntimeCheckpointSource !== undefined) {
      assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(cc.liveRuntimeCheckpointSource || '')), 'commandCenter.liveRuntimeCheckpointSource invalid');
    }
    if (cc.liveRuntimeCheckpointTargetTradingDay !== null && cc.liveRuntimeCheckpointTargetTradingDay !== undefined) {
      assert(typeof cc.liveRuntimeCheckpointTargetTradingDay === 'string', 'commandCenter.liveRuntimeCheckpointTargetTradingDay should be string when present');
    }
    assert(typeof cc.liveRuntimeCheckpointMissed === 'boolean', 'commandCenter.liveRuntimeCheckpointMissed missing');
    if (cc.liveRuntimeCheckpointMissReason !== null && cc.liveRuntimeCheckpointMissReason !== undefined) {
      assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(cc.liveRuntimeCheckpointMissReason || '')), 'commandCenter.liveRuntimeCheckpointMissReason invalid');
    }
    if (cc.liveCheckpointDeadlineAt !== null && cc.liveCheckpointDeadlineAt !== undefined) {
      assert(typeof cc.liveCheckpointDeadlineAt === 'string', 'commandCenter.liveCheckpointDeadlineAt should be string when present');
    }
    assert(typeof cc.liveCheckpointWithinAllowedWindow === 'boolean', 'commandCenter.liveCheckpointWithinAllowedWindow missing');
    assert(typeof cc.liveCheckpointPastDeadline === 'boolean', 'commandCenter.liveCheckpointPastDeadline missing');
    assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(cc.liveInsertionSlaOutcome || '')), 'commandCenter.liveInsertionSlaOutcome invalid');
    assert(typeof cc.liveInsertionSlaRequired === 'boolean', 'commandCenter.liveInsertionSlaRequired missing');
    if (cc.liveInsertionSlaTargetTradingDay !== null && cc.liveInsertionSlaTargetTradingDay !== undefined) {
      assert(typeof cc.liveInsertionSlaTargetTradingDay === 'string', 'commandCenter.liveInsertionSlaTargetTradingDay should be string when present');
    }
    assert(typeof cc.liveInsertionSlaWasAutonomous === 'boolean', 'commandCenter.liveInsertionSlaWasAutonomous missing');
    if (cc.liveInsertionSlaSource !== null && cc.liveInsertionSlaSource !== undefined) {
      assert(typeof cc.liveInsertionSlaSource === 'string', 'commandCenter.liveInsertionSlaSource should be string when present');
    }
    if (cc.liveInsertionSlaTriggeredAt !== null && cc.liveInsertionSlaTriggeredAt !== undefined) {
      assert(typeof cc.liveInsertionSlaTriggeredAt === 'string', 'commandCenter.liveInsertionSlaTriggeredAt should be string when present');
    }
    assert(typeof cc.liveInsertionSlaWithinWindow === 'boolean', 'commandCenter.liveInsertionSlaWithinWindow missing');
    assert(typeof cc.liveInsertionSlaPastDeadline === 'boolean', 'commandCenter.liveInsertionSlaPastDeadline missing');
    assert(typeof cc.liveInsertionSlaNetNewRowCreated === 'boolean', 'commandCenter.liveInsertionSlaNetNewRowCreated missing');
    assert(Number.isFinite(Number(cc.liveInsertionSlaLateByMinutes)), 'commandCenter.liveInsertionSlaLateByMinutes missing');
    assert(Number.isFinite(Number(cc.liveNetNewRequiredToday)), 'commandCenter.liveNetNewRequiredToday missing');
    assert(Number.isFinite(Number(cc.liveNetNewDeliveredToday)), 'commandCenter.liveNetNewDeliveredToday missing');
    assert(Number.isFinite(Number(cc.liveNetNewMissedToday)), 'commandCenter.liveNetNewMissedToday missing');
    assert(Number.isFinite(Number(cc.liveNetNewLateToday)), 'commandCenter.liveNetNewLateToday missing');
    assert(LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(cc.liveInsertionOwnershipScope || '')), 'commandCenter.liveInsertionOwnershipScope invalid');
    assert(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(cc.liveInsertionOwnershipOutcome || '')), 'commandCenter.liveInsertionOwnershipOutcome invalid');
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(String(cc.liveInsertionOwnershipSourceSpecificOutcome || '')),
      'commandCenter.liveInsertionOwnershipSourceSpecificOutcome invalid'
    );
    assert(typeof cc.liveTargetDayOwnershipConsistent === 'boolean', 'commandCenter.liveTargetDayOwnershipConsistent missing');
    assert(LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(cc.liveTargetDayOwnershipMismatchReason || '')), 'commandCenter.liveTargetDayOwnershipMismatchReason invalid');
    assert(cc.liveAutonomousInsertReadiness && typeof cc.liveAutonomousInsertReadiness === 'object', 'commandCenter.liveAutonomousInsertReadiness missing');
    assert(typeof cc.liveAutonomousInsertReadiness.validTradingDay === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.validTradingDay missing');
    assert(typeof cc.liveAutonomousInsertReadiness.liveContextPresent === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.liveContextPresent missing');
    assert(typeof cc.liveAutonomousInsertReadiness.closeComplete === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.closeComplete missing');
    assert(typeof cc.liveAutonomousInsertReadiness.requiredMarketDataPresent === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.requiredMarketDataPresent missing');
    assert(typeof cc.liveAutonomousInsertReadiness.firstRightSatisfied === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.firstRightSatisfied missing');
    assert(typeof cc.liveAutonomousInsertReadiness.existingLiveRowPresent === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.existingLiveRowPresent missing');
    assert(typeof cc.liveAutonomousInsertReadiness.autonomousInsertEligible === 'boolean', 'commandCenter.liveAutonomousInsertReadiness.autonomousInsertEligible missing');
    assert(LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(cc.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')), 'commandCenter.liveAutonomousInsertReadiness.autonomousInsertBlockReason invalid');
    assert(LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(cc.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')), 'commandCenter.liveAutonomousInsertReadiness.autonomousInsertNextTransition invalid');
    assert(cc.liveAutonomousAttemptTransition && typeof cc.liveAutonomousAttemptTransition === 'object', 'commandCenter.liveAutonomousAttemptTransition missing');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(cc.liveAutonomousAttemptTransition.attemptResult || '')), 'commandCenter.liveAutonomousAttemptTransition.attemptResult invalid');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(cc.liveAutonomousAttemptResult || '')), 'commandCenter.liveAutonomousAttemptResult invalid');
    assert(typeof cc.liveAutonomousAttemptRequired === 'boolean', 'commandCenter.liveAutonomousAttemptRequired missing');
    assert(typeof cc.liveAutonomousAttemptExecuted === 'boolean', 'commandCenter.liveAutonomousAttemptExecuted missing');
    assert(typeof cc.liveAutonomousAttemptRowInsertedByThisAttempt === 'boolean', 'commandCenter.liveAutonomousAttemptRowInsertedByThisAttempt missing');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(cc.liveAutonomousProofOutcome || '')), 'commandCenter.liveAutonomousProofOutcome invalid');
    assert(typeof cc.liveAutonomousProofEligible === 'boolean', 'commandCenter.liveAutonomousProofEligible missing');
    assert(typeof cc.liveAutonomousProofAttempted === 'boolean', 'commandCenter.liveAutonomousProofAttempted missing');
    assert(typeof cc.liveAutonomousProofSucceeded === 'boolean', 'commandCenter.liveAutonomousProofSucceeded missing');
    assert(LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(cc.liveAutonomousProofFailureReason || '')), 'commandCenter.liveAutonomousProofFailureReason invalid');
    if (cc.liveAutonomousProofTargetTradingDay !== null && cc.liveAutonomousProofTargetTradingDay !== undefined) {
      assert(typeof cc.liveAutonomousProofTargetTradingDay === 'string', 'commandCenter.liveAutonomousProofTargetTradingDay should be string when present');
    }
    assert(typeof cc.liveOwnershipConsistencyOk === 'boolean', 'commandCenter.liveOwnershipConsistencyOk missing');
    assert(typeof cc.liveInsertionOwnershipFirstInsertedAutonomous === 'boolean', 'commandCenter.liveInsertionOwnershipFirstInsertedAutonomous missing');
    assert(typeof cc.liveInsertionOwnershipCurrentRunWasFirstCreator === 'boolean', 'commandCenter.liveInsertionOwnershipCurrentRunWasFirstCreator missing');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(cc.liveAutonomousFirstRightOutcome || '')), 'commandCenter.liveAutonomousFirstRightOutcome invalid');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(cc.liveAutonomousFirstRightWindowState || '')), 'commandCenter.liveAutonomousFirstRightWindowState invalid');
    assert(typeof cc.liveAutonomousFirstRightActive === 'boolean', 'commandCenter.liveAutonomousFirstRightActive missing');
    assert(typeof cc.liveManualInsertDeferred === 'boolean', 'commandCenter.liveManualInsertDeferred missing');
    assert(typeof cc.liveManualInsertWouldHavePreemptedAutonomous === 'boolean', 'commandCenter.liveManualInsertWouldHavePreemptedAutonomous missing');
    assert(typeof cc.liveAutonomousFirstRightReachedExecution === 'boolean', 'commandCenter.liveAutonomousFirstRightReachedExecution missing');
    assert(Number.isFinite(Number(cc.liveAutonomousInsertRequiredToday)), 'commandCenter.liveAutonomousInsertRequiredToday missing');
    assert(Number.isFinite(Number(cc.liveAutonomousInsertDeliveredToday)), 'commandCenter.liveAutonomousInsertDeliveredToday missing');
    assert(Number.isFinite(Number(cc.liveAutonomousInsertMissedToday)), 'commandCenter.liveAutonomousInsertMissedToday missing');
    assert(Number.isFinite(Number(cc.liveAutonomousInsertLateToday)), 'commandCenter.liveAutonomousInsertLateToday missing');
    assert(Number.isFinite(Number(cc.rolling5dAutonomousInsertRatePct)), 'commandCenter.rolling5dAutonomousInsertRatePct missing');
    assert(Number.isFinite(Number(cc.consecutiveAutonomousInsertDays)), 'commandCenter.consecutiveAutonomousInsertDays missing');
    assert(Number.isFinite(Number(cc.consecutiveAutonomousInsertMissDays)), 'commandCenter.consecutiveAutonomousInsertMissDays missing');
    if (cc.livePreferredOwnerTargetTradingDay !== null && cc.livePreferredOwnerTargetTradingDay !== undefined) {
      assert(typeof cc.livePreferredOwnerTargetTradingDay === 'string', 'commandCenter.livePreferredOwnerTargetTradingDay should be string when present');
    }
    if (cc.livePreferredOwnerExpectedSource !== null && cc.livePreferredOwnerExpectedSource !== undefined) {
      assert(typeof cc.livePreferredOwnerExpectedSource === 'string', 'commandCenter.livePreferredOwnerExpectedSource should be string when present');
    }
    if (cc.livePreferredOwnerActualSource !== null && cc.livePreferredOwnerActualSource !== undefined) {
      assert(typeof cc.livePreferredOwnerActualSource === 'string', 'commandCenter.livePreferredOwnerActualSource should be string when present');
    }
    assert(typeof cc.livePreferredOwnerWon === 'boolean', 'commandCenter.livePreferredOwnerWon missing');
    assert(
      LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM.includes(String(cc.livePreferredOwnerFailureReason || '')),
      'commandCenter.livePreferredOwnerFailureReason invalid'
    );
    if (cc.livePreferredOwnerProofCapturedAt !== null && cc.livePreferredOwnerProofCapturedAt !== undefined) {
      assert(typeof cc.livePreferredOwnerProofCapturedAt === 'string', 'commandCenter.livePreferredOwnerProofCapturedAt should be string when present');
    }
    assert(Number.isFinite(Number(cc.preferredOwnerWonToday)), 'commandCenter.preferredOwnerWonToday missing');
    assert(Number.isFinite(Number(cc.preferredOwnerMissedToday)), 'commandCenter.preferredOwnerMissedToday missing');
    assert(Number.isFinite(Number(cc.rolling5dPreferredOwnerWinRatePct)), 'commandCenter.rolling5dPreferredOwnerWinRatePct missing');
    assert(Number.isFinite(Number(cc.consecutivePreferredOwnerWinDays)), 'commandCenter.consecutivePreferredOwnerWinDays missing');
    assert(Number.isFinite(Number(cc.consecutivePreferredOwnerMissDays)), 'commandCenter.consecutivePreferredOwnerMissDays missing');
    assert(Number.isFinite(Number(cc.consecutiveValidDaysWithOnTimeInsert)), 'commandCenter.consecutiveValidDaysWithOnTimeInsert missing');
    assert(Number.isFinite(Number(cc.consecutiveValidDaysMissed)), 'commandCenter.consecutiveValidDaysMissed missing');
    assert(Number.isFinite(Number(cc.rolling5dOnTimeRatePct)), 'commandCenter.rolling5dOnTimeRatePct missing');
    assert(typeof cc.liveEvidenceOperationalNextAction === 'string' && cc.liveEvidenceOperationalNextAction.length > 0, 'commandCenter.liveEvidenceOperationalNextAction missing');
    assert(
      String(cc.liveInsertionOwnershipOutcome || '') === String(dailyScoringStatus?.liveInsertionOwnership?.liveInsertionOwnershipOutcome || ''),
      'ownership outcome mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveInsertionOwnershipScope || '') === String(dailyScoringStatus?.liveInsertionOwnership?.liveInsertionOwnershipScope || ''),
      'ownership scope mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveInsertionOwnershipFirstInsertedBySource || '') === String(dailyScoringStatus?.liveInsertionOwnership?.liveInsertionOwnershipFirstInsertedBySource || ''),
      'ownership source mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveInsertionOwnershipSourceSpecificOutcome || '') === String(dailyScoringStatus?.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome || ''),
      'ownership source-specific outcome mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.livePreferredOwnerTargetTradingDay || '') === String(dailyScoringStatus?.livePreferredOwnerTargetTradingDay || ''),
      'preferred-owner target day mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.livePreferredOwnerExpectedSource || '') === String(dailyScoringStatus?.livePreferredOwnerExpectedSource || ''),
      'preferred-owner expected source mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.livePreferredOwnerActualSource || '') === String(dailyScoringStatus?.livePreferredOwnerActualSource || ''),
      'preferred-owner actual source mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.livePreferredOwnerWon === (dailyScoringStatus?.livePreferredOwnerWon === true),
      'preferred-owner won flag mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.livePreferredOwnerFailureReason || '') === String(dailyScoringStatus?.livePreferredOwnerFailureReason || ''),
      'preferred-owner failure reason mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveOwnershipConsistencyOk === (dailyScoringStatus?.liveOwnershipConsistencyOk === true),
      'ownership consistency flag mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveTargetDayOwnershipConsistent === (dailyScoringStatus?.liveTargetDayOwnershipConsistent === true),
      'target-day ownership consistency mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveTargetDayOwnershipMismatchReason || '') === String(dailyScoringStatus?.liveTargetDayOwnershipMismatchReason || ''),
      'target-day ownership mismatch reason mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveAutonomousInsertReadiness?.targetTradingDay || '') === String(dailyScoringStatus?.liveAutonomousInsertReadiness?.targetTradingDay || ''),
      'autonomous insert readiness target day mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveAutonomousInsertReadiness?.autonomousInsertBlockReason || '') === String(dailyScoringStatus?.liveAutonomousInsertReadiness?.autonomousInsertBlockReason || ''),
      'autonomous insert readiness block reason mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveAutonomousInsertReadiness?.autonomousInsertNextTransition || '') === String(dailyScoringStatus?.liveAutonomousInsertReadiness?.autonomousInsertNextTransition || ''),
      'autonomous insert readiness next transition mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveAutonomousAttemptTransition?.attemptResult || '') === String(dailyScoringStatus?.liveAutonomousAttemptTransition?.attemptResult || ''),
      'autonomous attempt transition result mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveAutonomousAttemptRequired === (dailyScoringStatus?.liveAutonomousAttemptRequired === true),
      'autonomous attempt required mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveAutonomousAttemptExecuted === (dailyScoringStatus?.liveAutonomousAttemptExecuted === true),
      'autonomous attempt executed mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveAutonomousProofOutcome || '') === String(dailyScoringStatus?.liveAutonomousProofOutcome || ''),
      'autonomous proof outcome mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveAutonomousProofEligible === (dailyScoringStatus?.liveAutonomousProofEligible === true),
      'autonomous proof eligible mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveAutonomousProofAttempted === (dailyScoringStatus?.liveAutonomousProofAttempted === true),
      'autonomous proof attempted mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveAutonomousProofSucceeded === (dailyScoringStatus?.liveAutonomousProofSucceeded === true),
      'autonomous proof succeeded mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      String(cc.liveAutonomousProofFailureReason || '') === String(dailyScoringStatus?.liveAutonomousProofFailureReason || ''),
      'autonomous proof failure reason mismatch between commandCenter and dailyScoringStatus'
    );
    assert(
      cc.liveAutonomousFirstRightReachedExecution === (dailyScoringStatus?.liveAutonomousFirstRightReachedExecution === true),
      'autonomous first-right reached execution mismatch between commandCenter and dailyScoringStatus'
    );

    const decisionBoard = cc?.decisionBoard || {};
    assert(ALLOWED_EVIDENCE_DEPTH_LABELS.has(String(decisionBoard.liveEvidenceDepthLabel || '')), 'decisionBoard.liveEvidenceDepthLabel invalid');
    assert(ALLOWED_EVIDENCE_RELIABILITY_LABELS.has(String(decisionBoard.liveEvidenceReliabilityLabel || '')), 'decisionBoard.liveEvidenceReliabilityLabel invalid');
    assert(typeof decisionBoard.liveEvidenceCreatedToday === 'boolean', 'decisionBoard.liveEvidenceCreatedToday missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationPendingCount)), 'decisionBoard.liveFinalizationPendingCount missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationValidLiveDaysSeen)), 'decisionBoard.liveFinalizationValidLiveDaysSeen missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationValidLiveDaysReadyToFinalize)), 'decisionBoard.liveFinalizationValidLiveDaysReadyToFinalize missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationValidLiveDaysFinalizedInserted)), 'decisionBoard.liveFinalizationValidLiveDaysFinalizedInserted missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationValidLiveDaysFinalizedUpdated)), 'decisionBoard.liveFinalizationValidLiveDaysFinalizedUpdated missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationValidLiveDaysStillWaiting)), 'decisionBoard.liveFinalizationValidLiveDaysStillWaiting missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationValidLiveDaysBlocked)), 'decisionBoard.liveFinalizationValidLiveDaysBlocked missing');
    assert(Number.isFinite(Number(decisionBoard.liveFinalizationMissedValidDaysCount)), 'decisionBoard.liveFinalizationMissedValidDaysCount missing');
    assert(LIVE_CHECKPOINT_STATUS_ENUM.includes(String(decisionBoard.liveCheckpointStatus || '')), 'decisionBoard.liveCheckpointStatus invalid');
    assert(LIVE_CHECKPOINT_REASON_ENUM.includes(String(decisionBoard.liveCheckpointReason || '')), 'decisionBoard.liveCheckpointReason invalid');
    assert(typeof decisionBoard.liveCheckpointCloseComplete === 'boolean', 'decisionBoard.liveCheckpointCloseComplete missing');
    assert(Number.isFinite(Number(decisionBoard.liveCheckpointExpectedOutcomeCount)), 'decisionBoard.liveCheckpointExpectedOutcomeCount missing');
    assert(Number.isFinite(Number(decisionBoard.liveCheckpointActualOutcomeCount)), 'decisionBoard.liveCheckpointActualOutcomeCount missing');
    assert(Number.isFinite(Number(decisionBoard.liveCheckpointInsertDelta)), 'decisionBoard.liveCheckpointInsertDelta missing');
    assert(typeof decisionBoard.liveCheckpointFirstEligibleCycleExpectedInsert === 'boolean', 'decisionBoard.liveCheckpointFirstEligibleCycleExpectedInsert missing');
    assert(typeof decisionBoard.liveCheckpointFirstEligibleCycleInsertAttempted === 'boolean', 'decisionBoard.liveCheckpointFirstEligibleCycleInsertAttempted missing');
    assert(typeof decisionBoard.liveCheckpointFirstEligibleCycleInsertSucceeded === 'boolean', 'decisionBoard.liveCheckpointFirstEligibleCycleInsertSucceeded missing');
    assert(Number.isFinite(Number(decisionBoard.liveCheckpointFailureCount)), 'decisionBoard.liveCheckpointFailureCount missing');
    assert(Array.isArray(decisionBoard.latestMissedCheckpointDates), 'decisionBoard.latestMissedCheckpointDates missing');
    assert(Array.isArray(decisionBoard.latestCheckpointFailures), 'decisionBoard.latestCheckpointFailures missing');
    assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(decisionBoard.liveRuntimeCheckpointOutcome || '')), 'decisionBoard.liveRuntimeCheckpointOutcome invalid');
    assert(typeof decisionBoard.liveRuntimeCheckpointWasAutonomous === 'boolean', 'decisionBoard.liveRuntimeCheckpointWasAutonomous missing');
    assert(typeof decisionBoard.liveRuntimeCheckpointMissed === 'boolean', 'decisionBoard.liveRuntimeCheckpointMissed missing');
    assert(typeof decisionBoard.liveCheckpointWithinAllowedWindow === 'boolean', 'decisionBoard.liveCheckpointWithinAllowedWindow missing');
    assert(typeof decisionBoard.liveCheckpointPastDeadline === 'boolean', 'decisionBoard.liveCheckpointPastDeadline missing');
    assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(decisionBoard.liveInsertionSlaOutcome || '')), 'decisionBoard.liveInsertionSlaOutcome invalid');
    assert(typeof decisionBoard.liveInsertionSlaRequired === 'boolean', 'decisionBoard.liveInsertionSlaRequired missing');
    assert(typeof decisionBoard.liveInsertionSlaWasAutonomous === 'boolean', 'decisionBoard.liveInsertionSlaWasAutonomous missing');
    assert(typeof decisionBoard.liveInsertionSlaWithinWindow === 'boolean', 'decisionBoard.liveInsertionSlaWithinWindow missing');
    assert(typeof decisionBoard.liveInsertionSlaPastDeadline === 'boolean', 'decisionBoard.liveInsertionSlaPastDeadline missing');
    assert(typeof decisionBoard.liveInsertionSlaNetNewRowCreated === 'boolean', 'decisionBoard.liveInsertionSlaNetNewRowCreated missing');
    assert(Number.isFinite(Number(decisionBoard.liveInsertionSlaLateByMinutes)), 'decisionBoard.liveInsertionSlaLateByMinutes missing');
    assert(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(decisionBoard.liveInsertionOwnershipOutcome || '')), 'decisionBoard.liveInsertionOwnershipOutcome invalid');
    assert(LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(decisionBoard.liveInsertionOwnershipScope || '')), 'decisionBoard.liveInsertionOwnershipScope invalid');
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(String(decisionBoard.liveInsertionOwnershipSourceSpecificOutcome || '')),
      'decisionBoard.liveInsertionOwnershipSourceSpecificOutcome invalid'
    );
    assert(typeof decisionBoard.liveTargetDayOwnershipConsistent === 'boolean', 'decisionBoard.liveTargetDayOwnershipConsistent missing');
    assert(LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(decisionBoard.liveTargetDayOwnershipMismatchReason || '')), 'decisionBoard.liveTargetDayOwnershipMismatchReason invalid');
    assert(decisionBoard.liveAutonomousInsertReadiness && typeof decisionBoard.liveAutonomousInsertReadiness === 'object', 'decisionBoard.liveAutonomousInsertReadiness missing');
    assert(LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(decisionBoard.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')), 'decisionBoard.liveAutonomousInsertReadiness.autonomousInsertBlockReason invalid');
    assert(LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(decisionBoard.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')), 'decisionBoard.liveAutonomousInsertReadiness.autonomousInsertNextTransition invalid');
    assert(decisionBoard.liveAutonomousAttemptTransition && typeof decisionBoard.liveAutonomousAttemptTransition === 'object', 'decisionBoard.liveAutonomousAttemptTransition missing');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(decisionBoard.liveAutonomousAttemptTransition.attemptResult || '')), 'decisionBoard.liveAutonomousAttemptTransition.attemptResult invalid');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(decisionBoard.liveAutonomousAttemptResult || '')), 'decisionBoard.liveAutonomousAttemptResult invalid');
    assert(typeof decisionBoard.liveAutonomousAttemptRequired === 'boolean', 'decisionBoard.liveAutonomousAttemptRequired missing');
    assert(typeof decisionBoard.liveAutonomousAttemptExecuted === 'boolean', 'decisionBoard.liveAutonomousAttemptExecuted missing');
    assert(typeof decisionBoard.liveAutonomousAttemptRowInsertedByThisAttempt === 'boolean', 'decisionBoard.liveAutonomousAttemptRowInsertedByThisAttempt missing');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(decisionBoard.liveAutonomousProofOutcome || '')), 'decisionBoard.liveAutonomousProofOutcome invalid');
    assert(typeof decisionBoard.liveAutonomousProofEligible === 'boolean', 'decisionBoard.liveAutonomousProofEligible missing');
    assert(typeof decisionBoard.liveAutonomousProofAttempted === 'boolean', 'decisionBoard.liveAutonomousProofAttempted missing');
    assert(typeof decisionBoard.liveAutonomousProofSucceeded === 'boolean', 'decisionBoard.liveAutonomousProofSucceeded missing');
    assert(LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(decisionBoard.liveAutonomousProofFailureReason || '')), 'decisionBoard.liveAutonomousProofFailureReason invalid');
    assert(typeof decisionBoard.liveOwnershipConsistencyOk === 'boolean', 'decisionBoard.liveOwnershipConsistencyOk missing');
    assert(typeof decisionBoard.liveInsertionOwnershipFirstInsertedAutonomous === 'boolean', 'decisionBoard.liveInsertionOwnershipFirstInsertedAutonomous missing');
    assert(typeof decisionBoard.liveInsertionOwnershipCurrentRunWasFirstCreator === 'boolean', 'decisionBoard.liveInsertionOwnershipCurrentRunWasFirstCreator missing');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(decisionBoard.liveAutonomousFirstRightOutcome || '')), 'decisionBoard.liveAutonomousFirstRightOutcome invalid');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(decisionBoard.liveAutonomousFirstRightWindowState || '')), 'decisionBoard.liveAutonomousFirstRightWindowState invalid');
    assert(typeof decisionBoard.liveAutonomousFirstRightActive === 'boolean', 'decisionBoard.liveAutonomousFirstRightActive missing');
    assert(typeof decisionBoard.liveManualInsertDeferred === 'boolean', 'decisionBoard.liveManualInsertDeferred missing');
    assert(typeof decisionBoard.liveManualInsertWouldHavePreemptedAutonomous === 'boolean', 'decisionBoard.liveManualInsertWouldHavePreemptedAutonomous missing');
    assert(typeof decisionBoard.liveAutonomousFirstRightReachedExecution === 'boolean', 'decisionBoard.liveAutonomousFirstRightReachedExecution missing');
    assert(Number.isFinite(Number(decisionBoard.liveAutonomousInsertRequiredToday)), 'decisionBoard.liveAutonomousInsertRequiredToday missing');
    assert(Number.isFinite(Number(decisionBoard.liveAutonomousInsertDeliveredToday)), 'decisionBoard.liveAutonomousInsertDeliveredToday missing');
    assert(Number.isFinite(Number(decisionBoard.liveAutonomousInsertMissedToday)), 'decisionBoard.liveAutonomousInsertMissedToday missing');
    assert(Number.isFinite(Number(decisionBoard.liveAutonomousInsertLateToday)), 'decisionBoard.liveAutonomousInsertLateToday missing');
    assert(Number.isFinite(Number(decisionBoard.rolling5dAutonomousInsertRatePct)), 'decisionBoard.rolling5dAutonomousInsertRatePct missing');
    assert(Number.isFinite(Number(decisionBoard.consecutiveAutonomousInsertDays)), 'decisionBoard.consecutiveAutonomousInsertDays missing');
    assert(Number.isFinite(Number(decisionBoard.consecutiveAutonomousInsertMissDays)), 'decisionBoard.consecutiveAutonomousInsertMissDays missing');
    assert(typeof decisionBoard.livePreferredOwnerWon === 'boolean', 'decisionBoard.livePreferredOwnerWon missing');
    assert(LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM.includes(String(decisionBoard.livePreferredOwnerFailureReason || '')), 'decisionBoard.livePreferredOwnerFailureReason invalid');
    assert(Number.isFinite(Number(decisionBoard.preferredOwnerWonToday)), 'decisionBoard.preferredOwnerWonToday missing');
    assert(Number.isFinite(Number(decisionBoard.preferredOwnerMissedToday)), 'decisionBoard.preferredOwnerMissedToday missing');
    assert(Number.isFinite(Number(decisionBoard.rolling5dPreferredOwnerWinRatePct)), 'decisionBoard.rolling5dPreferredOwnerWinRatePct missing');
    assert(Number.isFinite(Number(decisionBoard.consecutivePreferredOwnerWinDays)), 'decisionBoard.consecutivePreferredOwnerWinDays missing');
    assert(Number.isFinite(Number(decisionBoard.consecutivePreferredOwnerMissDays)), 'decisionBoard.consecutivePreferredOwnerMissDays missing');
    assert(Number.isFinite(Number(decisionBoard.rolling5dOnTimeRatePct)), 'decisionBoard.rolling5dOnTimeRatePct missing');
    assert(Number.isFinite(Number(decisionBoard.consecutiveValidDaysWithOnTimeInsert)), 'decisionBoard.consecutiveValidDaysWithOnTimeInsert missing');
    assert(Number.isFinite(Number(decisionBoard.consecutiveValidDaysMissed)), 'decisionBoard.consecutiveValidDaysMissed missing');
    assert(Number.isFinite(Number(decisionBoard.invalidLiveContextsCreatedToday)), 'decisionBoard.invalidLiveContextsCreatedToday missing');
    assert(Number.isFinite(Number(decisionBoard.invalidLiveContextsSuppressedToday)), 'decisionBoard.invalidLiveContextsSuppressedToday missing');
    assert(Array.isArray(decisionBoard.latestInvalidLiveContextDates), 'decisionBoard.latestInvalidLiveContextDates missing');
    if (decisionBoard.liveEvidenceTopBlockedReasonToday !== null && decisionBoard.liveEvidenceTopBlockedReasonToday !== undefined) {
      assert(typeof decisionBoard.liveEvidenceTopBlockedReasonToday === 'string', 'decisionBoard.liveEvidenceTopBlockedReasonToday should be string when present');
    }

    const todayRecommendation = cc?.todayRecommendation || {};
    assert(ALLOWED_EVIDENCE_DEPTH_LABELS.has(String(todayRecommendation.liveEvidenceDepthLabel || '')), 'todayRecommendation.liveEvidenceDepthLabel invalid');
    assert(ALLOWED_EVIDENCE_RELIABILITY_LABELS.has(String(todayRecommendation.liveEvidenceReliabilityLabel || '')), 'todayRecommendation.liveEvidenceReliabilityLabel invalid');
    assert(ALLOWED_GROWTH_DIRECTIONS.has(String(todayRecommendation.liveEvidenceGrowthDirection || '')), 'todayRecommendation.liveEvidenceGrowthDirection invalid');
    assert(typeof todayRecommendation.liveEvidenceCreatedToday === 'boolean', 'todayRecommendation.liveEvidenceCreatedToday missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationPendingCount)), 'todayRecommendation.liveFinalizationPendingCount missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationValidLiveDaysSeen)), 'todayRecommendation.liveFinalizationValidLiveDaysSeen missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationValidLiveDaysReadyToFinalize)), 'todayRecommendation.liveFinalizationValidLiveDaysReadyToFinalize missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationValidLiveDaysFinalizedInserted)), 'todayRecommendation.liveFinalizationValidLiveDaysFinalizedInserted missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationValidLiveDaysFinalizedUpdated)), 'todayRecommendation.liveFinalizationValidLiveDaysFinalizedUpdated missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationValidLiveDaysStillWaiting)), 'todayRecommendation.liveFinalizationValidLiveDaysStillWaiting missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationValidLiveDaysBlocked)), 'todayRecommendation.liveFinalizationValidLiveDaysBlocked missing');
    assert(Number.isFinite(Number(todayRecommendation.liveFinalizationMissedValidDaysCount)), 'todayRecommendation.liveFinalizationMissedValidDaysCount missing');
    assert(LIVE_CHECKPOINT_STATUS_ENUM.includes(String(todayRecommendation.liveCheckpointStatus || '')), 'todayRecommendation.liveCheckpointStatus invalid');
    assert(LIVE_CHECKPOINT_REASON_ENUM.includes(String(todayRecommendation.liveCheckpointReason || '')), 'todayRecommendation.liveCheckpointReason invalid');
    assert(typeof todayRecommendation.liveCheckpointCloseComplete === 'boolean', 'todayRecommendation.liveCheckpointCloseComplete missing');
    assert(Number.isFinite(Number(todayRecommendation.liveCheckpointExpectedOutcomeCount)), 'todayRecommendation.liveCheckpointExpectedOutcomeCount missing');
    assert(Number.isFinite(Number(todayRecommendation.liveCheckpointActualOutcomeCount)), 'todayRecommendation.liveCheckpointActualOutcomeCount missing');
    assert(Number.isFinite(Number(todayRecommendation.liveCheckpointInsertDelta)), 'todayRecommendation.liveCheckpointInsertDelta missing');
    assert(typeof todayRecommendation.liveCheckpointFirstEligibleCycleExpectedInsert === 'boolean', 'todayRecommendation.liveCheckpointFirstEligibleCycleExpectedInsert missing');
    assert(typeof todayRecommendation.liveCheckpointFirstEligibleCycleInsertAttempted === 'boolean', 'todayRecommendation.liveCheckpointFirstEligibleCycleInsertAttempted missing');
    assert(typeof todayRecommendation.liveCheckpointFirstEligibleCycleInsertSucceeded === 'boolean', 'todayRecommendation.liveCheckpointFirstEligibleCycleInsertSucceeded missing');
    assert(Number.isFinite(Number(todayRecommendation.liveCheckpointFailureCount)), 'todayRecommendation.liveCheckpointFailureCount missing');
    assert(Array.isArray(todayRecommendation.latestMissedCheckpointDates), 'todayRecommendation.latestMissedCheckpointDates missing');
    assert(Array.isArray(todayRecommendation.latestCheckpointFailures), 'todayRecommendation.latestCheckpointFailures missing');
    assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(todayRecommendation.liveRuntimeCheckpointOutcome || '')), 'todayRecommendation.liveRuntimeCheckpointOutcome invalid');
    assert(typeof todayRecommendation.liveRuntimeCheckpointWasAutonomous === 'boolean', 'todayRecommendation.liveRuntimeCheckpointWasAutonomous missing');
    assert(typeof todayRecommendation.liveRuntimeCheckpointMissed === 'boolean', 'todayRecommendation.liveRuntimeCheckpointMissed missing');
    assert(typeof todayRecommendation.liveCheckpointWithinAllowedWindow === 'boolean', 'todayRecommendation.liveCheckpointWithinAllowedWindow missing');
    assert(typeof todayRecommendation.liveCheckpointPastDeadline === 'boolean', 'todayRecommendation.liveCheckpointPastDeadline missing');
    assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(todayRecommendation.liveInsertionSlaOutcome || '')), 'todayRecommendation.liveInsertionSlaOutcome invalid');
    assert(typeof todayRecommendation.liveInsertionSlaRequired === 'boolean', 'todayRecommendation.liveInsertionSlaRequired missing');
    assert(typeof todayRecommendation.liveInsertionSlaWasAutonomous === 'boolean', 'todayRecommendation.liveInsertionSlaWasAutonomous missing');
    assert(typeof todayRecommendation.liveInsertionSlaWithinWindow === 'boolean', 'todayRecommendation.liveInsertionSlaWithinWindow missing');
    assert(typeof todayRecommendation.liveInsertionSlaPastDeadline === 'boolean', 'todayRecommendation.liveInsertionSlaPastDeadline missing');
    assert(typeof todayRecommendation.liveInsertionSlaNetNewRowCreated === 'boolean', 'todayRecommendation.liveInsertionSlaNetNewRowCreated missing');
    assert(Number.isFinite(Number(todayRecommendation.liveInsertionSlaLateByMinutes)), 'todayRecommendation.liveInsertionSlaLateByMinutes missing');
    assert(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(todayRecommendation.liveInsertionOwnershipOutcome || '')), 'todayRecommendation.liveInsertionOwnershipOutcome invalid');
    assert(LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(todayRecommendation.liveInsertionOwnershipScope || '')), 'todayRecommendation.liveInsertionOwnershipScope invalid');
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(String(todayRecommendation.liveInsertionOwnershipSourceSpecificOutcome || '')),
      'todayRecommendation.liveInsertionOwnershipSourceSpecificOutcome invalid'
    );
    assert(typeof todayRecommendation.liveTargetDayOwnershipConsistent === 'boolean', 'todayRecommendation.liveTargetDayOwnershipConsistent missing');
    assert(LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(todayRecommendation.liveTargetDayOwnershipMismatchReason || '')), 'todayRecommendation.liveTargetDayOwnershipMismatchReason invalid');
    assert(todayRecommendation.liveAutonomousInsertReadiness && typeof todayRecommendation.liveAutonomousInsertReadiness === 'object', 'todayRecommendation.liveAutonomousInsertReadiness missing');
    assert(LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(todayRecommendation.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')), 'todayRecommendation.liveAutonomousInsertReadiness.autonomousInsertBlockReason invalid');
    assert(LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(todayRecommendation.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')), 'todayRecommendation.liveAutonomousInsertReadiness.autonomousInsertNextTransition invalid');
    assert(todayRecommendation.liveAutonomousAttemptTransition && typeof todayRecommendation.liveAutonomousAttemptTransition === 'object', 'todayRecommendation.liveAutonomousAttemptTransition missing');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(todayRecommendation.liveAutonomousAttemptTransition.attemptResult || '')), 'todayRecommendation.liveAutonomousAttemptTransition.attemptResult invalid');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(todayRecommendation.liveAutonomousAttemptResult || '')), 'todayRecommendation.liveAutonomousAttemptResult invalid');
    assert(typeof todayRecommendation.liveAutonomousAttemptRequired === 'boolean', 'todayRecommendation.liveAutonomousAttemptRequired missing');
    assert(typeof todayRecommendation.liveAutonomousAttemptExecuted === 'boolean', 'todayRecommendation.liveAutonomousAttemptExecuted missing');
    assert(typeof todayRecommendation.liveAutonomousAttemptRowInsertedByThisAttempt === 'boolean', 'todayRecommendation.liveAutonomousAttemptRowInsertedByThisAttempt missing');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(todayRecommendation.liveAutonomousProofOutcome || '')), 'todayRecommendation.liveAutonomousProofOutcome invalid');
    assert(typeof todayRecommendation.liveAutonomousProofEligible === 'boolean', 'todayRecommendation.liveAutonomousProofEligible missing');
    assert(typeof todayRecommendation.liveAutonomousProofAttempted === 'boolean', 'todayRecommendation.liveAutonomousProofAttempted missing');
    assert(typeof todayRecommendation.liveAutonomousProofSucceeded === 'boolean', 'todayRecommendation.liveAutonomousProofSucceeded missing');
    assert(LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(todayRecommendation.liveAutonomousProofFailureReason || '')), 'todayRecommendation.liveAutonomousProofFailureReason invalid');
    assert(typeof todayRecommendation.liveOwnershipConsistencyOk === 'boolean', 'todayRecommendation.liveOwnershipConsistencyOk missing');
    assert(typeof todayRecommendation.liveInsertionOwnershipFirstInsertedAutonomous === 'boolean', 'todayRecommendation.liveInsertionOwnershipFirstInsertedAutonomous missing');
    assert(typeof todayRecommendation.liveInsertionOwnershipCurrentRunWasFirstCreator === 'boolean', 'todayRecommendation.liveInsertionOwnershipCurrentRunWasFirstCreator missing');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(todayRecommendation.liveAutonomousFirstRightOutcome || '')), 'todayRecommendation.liveAutonomousFirstRightOutcome invalid');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(todayRecommendation.liveAutonomousFirstRightWindowState || '')), 'todayRecommendation.liveAutonomousFirstRightWindowState invalid');
    assert(typeof todayRecommendation.liveAutonomousFirstRightActive === 'boolean', 'todayRecommendation.liveAutonomousFirstRightActive missing');
    assert(typeof todayRecommendation.liveManualInsertDeferred === 'boolean', 'todayRecommendation.liveManualInsertDeferred missing');
    assert(typeof todayRecommendation.liveManualInsertWouldHavePreemptedAutonomous === 'boolean', 'todayRecommendation.liveManualInsertWouldHavePreemptedAutonomous missing');
    assert(typeof todayRecommendation.liveAutonomousFirstRightReachedExecution === 'boolean', 'todayRecommendation.liveAutonomousFirstRightReachedExecution missing');
    assert(Number.isFinite(Number(todayRecommendation.liveAutonomousInsertRequiredToday)), 'todayRecommendation.liveAutonomousInsertRequiredToday missing');
    assert(Number.isFinite(Number(todayRecommendation.liveAutonomousInsertDeliveredToday)), 'todayRecommendation.liveAutonomousInsertDeliveredToday missing');
    assert(Number.isFinite(Number(todayRecommendation.liveAutonomousInsertMissedToday)), 'todayRecommendation.liveAutonomousInsertMissedToday missing');
    assert(Number.isFinite(Number(todayRecommendation.liveAutonomousInsertLateToday)), 'todayRecommendation.liveAutonomousInsertLateToday missing');
    assert(Number.isFinite(Number(todayRecommendation.rolling5dAutonomousInsertRatePct)), 'todayRecommendation.rolling5dAutonomousInsertRatePct missing');
    assert(Number.isFinite(Number(todayRecommendation.consecutiveAutonomousInsertDays)), 'todayRecommendation.consecutiveAutonomousInsertDays missing');
    assert(Number.isFinite(Number(todayRecommendation.consecutiveAutonomousInsertMissDays)), 'todayRecommendation.consecutiveAutonomousInsertMissDays missing');
    assert(typeof todayRecommendation.livePreferredOwnerWon === 'boolean', 'todayRecommendation.livePreferredOwnerWon missing');
    assert(LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM.includes(String(todayRecommendation.livePreferredOwnerFailureReason || '')), 'todayRecommendation.livePreferredOwnerFailureReason invalid');
    assert(Number.isFinite(Number(todayRecommendation.preferredOwnerWonToday)), 'todayRecommendation.preferredOwnerWonToday missing');
    assert(Number.isFinite(Number(todayRecommendation.preferredOwnerMissedToday)), 'todayRecommendation.preferredOwnerMissedToday missing');
    assert(Number.isFinite(Number(todayRecommendation.rolling5dPreferredOwnerWinRatePct)), 'todayRecommendation.rolling5dPreferredOwnerWinRatePct missing');
    assert(Number.isFinite(Number(todayRecommendation.consecutivePreferredOwnerWinDays)), 'todayRecommendation.consecutivePreferredOwnerWinDays missing');
    assert(Number.isFinite(Number(todayRecommendation.consecutivePreferredOwnerMissDays)), 'todayRecommendation.consecutivePreferredOwnerMissDays missing');
    assert(Number.isFinite(Number(todayRecommendation.rolling5dOnTimeRatePct)), 'todayRecommendation.rolling5dOnTimeRatePct missing');
    assert(Number.isFinite(Number(todayRecommendation.consecutiveValidDaysWithOnTimeInsert)), 'todayRecommendation.consecutiveValidDaysWithOnTimeInsert missing');
    assert(Number.isFinite(Number(todayRecommendation.consecutiveValidDaysMissed)), 'todayRecommendation.consecutiveValidDaysMissed missing');
    assert(Number.isFinite(Number(todayRecommendation.invalidLiveContextsCreatedToday)), 'todayRecommendation.invalidLiveContextsCreatedToday missing');
    assert(Number.isFinite(Number(todayRecommendation.invalidLiveContextsSuppressedToday)), 'todayRecommendation.invalidLiveContextsSuppressedToday missing');
    assert(Array.isArray(todayRecommendation.latestInvalidLiveContextDates), 'todayRecommendation.latestInvalidLiveContextDates missing');
    assert(Number.isFinite(Number(todayRecommendation.liveEvidenceNetNew1d)), 'todayRecommendation.liveEvidenceNetNew1d missing');
    if (todayRecommendation.liveEvidenceTopBlockedReasonToday !== null && todayRecommendation.liveEvidenceTopBlockedReasonToday !== undefined) {
      assert(typeof todayRecommendation.liveEvidenceTopBlockedReasonToday === 'string', 'todayRecommendation.liveEvidenceTopBlockedReasonToday should be string when present');
    }
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ live evidence accumulation checks passed');
  } catch (err) {
    console.error('❌ live evidence accumulation checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
