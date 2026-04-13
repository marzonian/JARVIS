#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  ensureRecommendationOutcomeSchema,
  upsertTodayRecommendationContext,
} = require('../server/jarvis-core/recommendation-outcome');
const {
  ensureDataFoundationTables,
} = require('../server/jarvis-core/data-foundation-storage');
const {
  runAutomaticDailyScoring,
  buildDailyScoringStatus,
  buildLivePreferredOwnerReservation,
  buildLiveAutonomousAttemptTransition,
  enforceEligibleAttemptOrBugContract,
  classifyTradingDay,
  evaluateLiveFinalizationReadiness,
  LIVE_DAY_CONVERSION_REASON_ENUM,
  LIVE_OUTCOME_FINALIZATION_REASON_ENUM,
  TRADING_DAY_CLASSIFICATION_ENUM,
  LIVE_FINALIZATION_READINESS_STATE_ENUM,
  LIVE_FINALIZATION_SWEEP_SOURCE_ENUM,
  LIVE_CHECKPOINT_STATUS_ENUM,
  LIVE_CHECKPOINT_REASON_ENUM,
  LIVE_CHECKPOINT_AWAITING_REASON_ENUM,
  LIVE_CHECKPOINT_FAILURE_REASON_ENUM,
  CLOSE_COMPLETE_REASON_ENUM,
  FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_ENUM,
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
  LIVE_PREFERRED_OWNER_RESERVATION_STATE_ENUM,
  LIVE_PREFERRED_OWNER_RESERVATION_BLOCK_REASON_ENUM,
  LIVE_PREFERRED_OWNER_KPI_MISMATCH_REASON_ENUM,
  DAILY_SCORING_RUN_ORIGIN_ENUM,
  PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM,
  PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM,
  PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM,
  LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM,
  LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM,
} = require('../server/jarvis-core/daily-evidence-scoring');

const TIMEOUT_MS = 240000;
const NEXT_NATURAL_DAY_READINESS_RESULT_ENUM = Object.freeze([
  'next_natural_day_not_in_data_yet',
  'next_natural_day_in_data_not_seen_in_scoring',
  'next_natural_day_seen_but_not_resolved',
  'next_natural_day_resolved_but_missing_ownership',
  'next_natural_day_missing_preferred_owner_proof',
  'next_natural_day_missing_verifier',
  'next_natural_day_missing_natural_win',
  'next_natural_day_missing_operational_verdict',
  'next_natural_day_missing_proof_bundle',
  'next_natural_day_fully_completed',
]);
const RUNTIME_INTEGRITY_REPAIR_POLICY_ENUM = Object.freeze([
  'SAFE_AUTO_REPAIR',
  'DETECT_AND_ESCALATE',
  'MANUAL_ONLY',
]);
const RUNTIME_INTEGRITY_AUTO_REPAIR_STATUS_ENUM = Object.freeze([
  'none',
  'repaired',
  'escalation',
]);
const RUNTIME_INTEGRITY_RUNTIME_FRESHNESS_STATUS_ENUM = Object.freeze([
  'current',
  'stale',
  'repaired',
]);

function makeDb() {
  const db = new Database(':memory:');
  ensureRecommendationOutcomeSchema(db);
  ensureDataFoundationTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      direction TEXT,
      entry_price REAL,
      entry_time TEXT,
      exit_time TEXT,
      result TEXT,
      pnl_ticks REAL,
      pnl_dollars REAL
    );
  `);
  return db;
}

function buildSessionCandles(date, count = 90) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const totalMinutes = (9 * 60) + 30 + (i * 5);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    const time = `${hh}:${mm}:00`;
    const timestamp = `${date} ${time}`;
    const open = price;
    const close = price + 0.4;
    const high = close + 0.2;
    const low = open - 0.2;
    candles.push({
      timestamp,
      date,
      time,
      open,
      high,
      low,
      close,
      volume: 1000 + i,
    });
    price = close;
  }
  return candles;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
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

async function postJson(baseUrl, endpoint, body) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function seedRecommendationContext(db, date) {
  upsertTodayRecommendationContext({
    db,
    recDate: date,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    reconstructionVersion: 'test_live_v1',
    generatedAt: `${date}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'ORB 3130 Core',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 58,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
        recommendedStrategyName: 'ORB 3130 Core',
      },
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
    },
    context: {
      nowEt: { date, time: '09:25' },
      sessionPhase: 'pre_open',
    },
  });
}

function seedBackfillContext(db, date, phaseSuffix = 'phase_a') {
  upsertTodayRecommendationContext({
    db,
    recDate: date,
    sourceType: 'backfill',
    reconstructionPhase: `test_backfill_${phaseSuffix}`,
    reconstructionVersion: 'test_backfill_v1',
    generatedAt: `${date}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'ORB 3130 Core',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'low',
      confidenceScore: 45,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date, time: '09:25' },
      sessionPhase: 'pre_open',
    },
  });
}

function insertLegacyLiveContext(db, {
  recDate,
  contextDate,
  generatedAt = null,
} = {}) {
  if (!recDate) return;
  const finalGeneratedAt = String(generatedAt || `${recDate}T09:25:00.000Z`);
  const payload = {
    nowEt: {
      date: contextDate || recDate,
      time: '09:25',
    },
    source: 'legacy_context_test',
  };
  db.prepare(`
    INSERT INTO jarvis_recommendation_context_history (
      rec_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
      generated_at,
      posture,
      recommended_strategy_key,
      recommended_strategy_name,
      recommended_tp_mode,
      confidence_label,
      confidence_score,
      recommendation_json,
      strategy_layers_json,
      mechanics_json,
      context_json
    ) VALUES (?, 'live', 'live_intraday', 'legacy_test', ?, 'trade_selectively', 'original_plan_orb_3130', 'ORB 3130 Core', 'Skip 2', 'low', 39, '{}', '{}', '{}', ?)
    ON CONFLICT(rec_date, source_type, reconstruction_phase) DO UPDATE SET
      generated_at = excluded.generated_at,
      context_json = excluded.context_json,
      updated_at = datetime('now')
  `).run(
    recDate,
    finalGeneratedAt,
    JSON.stringify(payload)
  );
}

async function runUnitChecks() {
  const db = makeDb();
  const date = '2026-03-05';
  const priorDate = '2026-03-04';
  seedRecommendationContext(db, priorDate);
  seedRecommendationContext(db, date);
  insertLegacyLiveContext(db, {
    recDate: '2026-03-03',
    contextDate: '2026-03-04',
    generatedAt: '2026-03-03T09:20:00.000Z',
  });
  for (let i = 0; i < 35; i += 1) {
    seedBackfillContext(db, date, `dense_${String(i).padStart(2, '0')}`);
  }
  const sessions = {
    '2026-03-03': buildSessionCandles('2026-03-03', 90),
    [priorDate]: buildSessionCandles(priorDate, 90),
    [date]: buildSessionCandles(date, 90),
  };

  const firstRun = runAutomaticDailyScoring({
    db,
    sessions,
    windowDays: 3,
    nowDate: date,
    mode: 'unit_test',
    force: false,
  });

  assert(firstRun && typeof firstRun === 'object', 'first daily scoring run missing');
  assert(['ok', 'partial', 'noop'].includes(String(firstRun.status || '')), 'first daily scoring status invalid');
  assert(Number(firstRun.contextsSeen || 0) >= 1, 'daily scoring should see recommendation contexts');
  assert(Number(firstRun.scoredRows || 0) >= 1, 'daily scoring should score at least one row with valid context+session');
  assert(Number(firstRun.insertedRows || 0) >= 1, 'daily scoring should insert scored outcome evidence');
  assert(Number(firstRun.liveContextsSeen || 0) >= 1, 'daily scoring should track live contexts seen');
  assert(Number(firstRun.liveContextsEligibleForScoring || 0) >= 1, 'daily scoring should track live contexts eligible');
  assert(Number(firstRun.liveContextsScored || 0) >= 1, 'daily scoring should track live contexts scored');
  assert(Number(firstRun.liveRowsInserted || 0) >= 1, 'daily scoring should track live inserted rows');
  assert(firstRun.liveSkipReasonBuckets && typeof firstRun.liveSkipReasonBuckets === 'object', 'liveSkipReasonBuckets missing');
  assert(firstRun.liveEligibilityReasonBuckets && typeof firstRun.liveEligibilityReasonBuckets === 'object', 'liveEligibilityReasonBuckets missing');
  assert(firstRun.liveBlockedReasonBuckets && typeof firstRun.liveBlockedReasonBuckets === 'object', 'liveBlockedReasonBuckets missing');
  assert(Array.isArray(firstRun.liveContextsWithoutFreshInsertDates), 'liveContextsWithoutFreshInsertDates missing');
  assert(Number(firstRun.liveRowsInserted || 0) >= 2, 'bridge should keep recent live contexts eligible even with dense backfill rows');
  const insertedBucket = Number(firstRun.liveEligibilityReasonBuckets.eligible_and_inserted || 0);
  assert(insertedBucket >= 2, 'eligible_and_inserted reason bucket should reflect live inserts');
  assert(Array.isArray(firstRun.liveContextDecisions), 'liveContextDecisions missing');
  assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(firstRun.liveFinalizationSweepSource || '')), 'liveFinalizationSweepSource should stay bounded');
  assert(firstRun.liveContextAudit && typeof firstRun.liveContextAudit === 'object', 'liveContextAudit missing on run output');
  assert(Number(firstRun.liveContextAudit.invalidLiveContextsFound || 0) >= 1, 'legacy invalid live context should be found by audit');
  assert(Number(firstRun.liveContextAudit.invalidLiveContextsActive || 0) >= 1, 'legacy invalid live context should be actively suppressed');
  assert(Array.isArray(firstRun.liveContextAudit.latestInvalidLiveContextDates), 'liveContextAudit.latestInvalidLiveContextDates missing');
  assert(firstRun.liveFinalization && typeof firstRun.liveFinalization === 'object', 'liveFinalization summary missing on run output');
  assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(firstRun.liveFinalization.sweepSource || '')), 'liveFinalization sweepSource should stay bounded');
  assert(Number(firstRun.liveFinalization.finalizedInsertedCount || 0) >= 2, 'liveFinalization.finalizedInsertedCount should track fresh live inserts');
  assert(firstRun.liveCheckpoint && typeof firstRun.liveCheckpoint === 'object', 'liveCheckpoint missing on first run');
  assert(LIVE_CHECKPOINT_STATUS_ENUM.includes(String(firstRun.liveCheckpoint.checkpointStatus || '')), 'liveCheckpoint.checkpointStatus should stay bounded');
  assert(LIVE_CHECKPOINT_REASON_ENUM.includes(String(firstRun.liveCheckpoint.checkpointReason || '')), 'liveCheckpoint.checkpointReason should stay bounded');
  assert(CLOSE_COMPLETE_REASON_ENUM.includes(String(firstRun.liveCheckpoint.closeCompleteReason || '')), 'liveCheckpoint.closeCompleteReason should stay bounded');
  assert(CLOSE_COMPLETE_REASON_ENUM.includes(String(firstRun.liveCheckpoint.closeCheckpointEligibilityReason || '')), 'liveCheckpoint.closeCheckpointEligibilityReason should stay bounded');
  assert(typeof firstRun.liveCheckpoint.closeComplete === 'boolean', 'liveCheckpoint.closeComplete missing');
  assert(typeof firstRun.liveCheckpoint.requiredCloseDataPresent === 'boolean', 'liveCheckpoint.requiredCloseDataPresent missing');
  assert(typeof firstRun.liveCheckpoint.requiredCloseBarsPresent === 'boolean', 'liveCheckpoint.requiredCloseBarsPresent missing');
  assert(typeof firstRun.liveCheckpoint.closeCheckpointEligible === 'boolean', 'liveCheckpoint.closeCheckpointEligible missing');
  if (firstRun.liveCheckpoint.firstEligibleCycleAt !== null && firstRun.liveCheckpoint.firstEligibleCycleAt !== undefined) {
    assert(typeof firstRun.liveCheckpoint.firstEligibleCycleAt === 'string', 'liveCheckpoint.firstEligibleCycleAt should be string when present');
  }
  assert(typeof firstRun.liveCheckpoint.firstEligibleCycleExpectedInsert === 'boolean', 'liveCheckpoint.firstEligibleCycleExpectedInsert missing');
  assert(typeof firstRun.liveCheckpoint.firstEligibleCycleInsertAttempted === 'boolean', 'liveCheckpoint.firstEligibleCycleInsertAttempted missing');
  assert(typeof firstRun.liveCheckpoint.firstEligibleCycleInsertSucceeded === 'boolean', 'liveCheckpoint.firstEligibleCycleInsertSucceeded missing');
  if (firstRun.liveCheckpoint.firstEligibleCycleFailureReason) {
    assert(
      FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_ENUM.includes(String(firstRun.liveCheckpoint.firstEligibleCycleFailureReason || '')),
      'liveCheckpoint.firstEligibleCycleFailureReason should stay bounded when present'
    );
  }
  assert(Number.isFinite(Number(firstRun.liveCheckpoint.checkpointExpectedOutcomeCount)), 'liveCheckpoint.checkpointExpectedOutcomeCount missing');
  assert(Number.isFinite(Number(firstRun.liveCheckpoint.checkpointActualOutcomeCount)), 'liveCheckpoint.checkpointActualOutcomeCount missing');
  assert(Number.isFinite(Number(firstRun.liveCheckpoint.checkpointInsertDelta)), 'liveCheckpoint.checkpointInsertDelta missing');
  assert(Number.isFinite(Number(firstRun.liveCheckpoint.checkpointDuplicateCount)), 'liveCheckpoint.checkpointDuplicateCount missing');
  assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(firstRun.liveCheckpoint.checkpointWindowReason || '')), 'liveCheckpoint.checkpointWindowReason should stay bounded');
  assert(typeof firstRun.liveCheckpoint.checkpointWithinAllowedWindow === 'boolean', 'liveCheckpoint.checkpointWithinAllowedWindow missing');
  assert(typeof firstRun.liveCheckpoint.checkpointPastDeadline === 'boolean', 'liveCheckpoint.checkpointPastDeadline missing');
  if (firstRun.liveCheckpoint.checkpointWindowOpenedAt !== null && firstRun.liveCheckpoint.checkpointWindowOpenedAt !== undefined) {
    assert(typeof firstRun.liveCheckpoint.checkpointWindowOpenedAt === 'string', 'liveCheckpoint.checkpointWindowOpenedAt should be string when present');
  }
  if (firstRun.liveCheckpoint.checkpointDeadlineAt !== null && firstRun.liveCheckpoint.checkpointDeadlineAt !== undefined) {
    assert(typeof firstRun.liveCheckpoint.checkpointDeadlineAt === 'string', 'liveCheckpoint.checkpointDeadlineAt should be string when present');
  }
  if (firstRun.liveCheckpoint.checkpointWindowClosedAt !== null && firstRun.liveCheckpoint.checkpointWindowClosedAt !== undefined) {
    assert(typeof firstRun.liveCheckpoint.checkpointWindowClosedAt === 'string', 'liveCheckpoint.checkpointWindowClosedAt should be string when present');
  }
  assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(firstRun.liveCheckpoint.runtimeCheckpointOutcome || '')), 'liveCheckpoint.runtimeCheckpointOutcome should stay bounded');
  assert(typeof firstRun.liveCheckpoint.runtimeCheckpointTriggered === 'boolean', 'liveCheckpoint.runtimeCheckpointTriggered missing');
  assert(typeof firstRun.liveCheckpoint.runtimeCheckpointWasAutonomous === 'boolean', 'liveCheckpoint.runtimeCheckpointWasAutonomous missing');
  assert(typeof firstRun.liveCheckpoint.runtimeCheckpointMissed === 'boolean', 'liveCheckpoint.runtimeCheckpointMissed missing');
  if (firstRun.liveCheckpoint.runtimeCheckpointTriggeredAt !== null && firstRun.liveCheckpoint.runtimeCheckpointTriggeredAt !== undefined) {
    assert(typeof firstRun.liveCheckpoint.runtimeCheckpointTriggeredAt === 'string', 'liveCheckpoint.runtimeCheckpointTriggeredAt should be string when present');
  }
  if (firstRun.liveCheckpoint.runtimeCheckpointSource !== null && firstRun.liveCheckpoint.runtimeCheckpointSource !== undefined) {
    assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(firstRun.liveCheckpoint.runtimeCheckpointSource || '')), 'liveCheckpoint.runtimeCheckpointSource should stay bounded');
  }
  if (firstRun.liveCheckpoint.runtimeCheckpointMissReason) {
    assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(firstRun.liveCheckpoint.runtimeCheckpointMissReason || '')), 'liveCheckpoint.runtimeCheckpointMissReason should stay bounded when present');
  }
  assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(firstRun.liveCheckpoint.sweepSource || '')), 'liveCheckpoint.sweepSource should stay bounded');
  if (firstRun.liveCheckpoint.awaitingReason) {
    assert(LIVE_CHECKPOINT_AWAITING_REASON_ENUM.includes(String(firstRun.liveCheckpoint.awaitingReason || '')), 'liveCheckpoint.awaitingReason should stay bounded when present');
  }
  if (firstRun.liveCheckpoint.failureReason) {
    assert(LIVE_CHECKPOINT_FAILURE_REASON_ENUM.includes(String(firstRun.liveCheckpoint.failureReason || '')), 'liveCheckpoint.failureReason should stay bounded when present');
  }
  assert(firstRun.liveInsertionSla && typeof firstRun.liveInsertionSla === 'object', 'first run liveInsertionSla missing');
  assert(firstRun.liveInsertionSla.advisoryOnly === true, 'first run liveInsertionSla should be advisoryOnly');
  assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(firstRun.liveInsertionSla.liveInsertionSlaOutcome || '')), 'first run liveInsertionSla.liveInsertionSlaOutcome should stay bounded');
  assert(typeof firstRun.liveInsertionSla.liveInsertionSlaRequired === 'boolean', 'first run liveInsertionSla.liveInsertionSlaRequired missing');
  assert(typeof firstRun.liveInsertionSla.liveInsertionSlaWasAutonomous === 'boolean', 'first run liveInsertionSla.liveInsertionSlaWasAutonomous missing');
  assert(typeof firstRun.liveInsertionSla.liveInsertionSlaWithinWindow === 'boolean', 'first run liveInsertionSla.liveInsertionSlaWithinWindow missing');
  assert(typeof firstRun.liveInsertionSla.liveInsertionSlaPastDeadline === 'boolean', 'first run liveInsertionSla.liveInsertionSlaPastDeadline missing');
  assert(typeof firstRun.liveInsertionSla.liveInsertionSlaNetNewRowCreated === 'boolean', 'first run liveInsertionSla.liveInsertionSlaNetNewRowCreated missing');
  assert(Number.isFinite(Number(firstRun.liveInsertionSla.liveInsertionSlaLateByMinutes)), 'first run liveInsertionSla.liveInsertionSlaLateByMinutes missing');
  assert(firstRun.liveInsertionGrowth && typeof firstRun.liveInsertionGrowth === 'object', 'first run liveInsertionGrowth missing');
  assert(firstRun.liveInsertionGrowth.advisoryOnly === true, 'first run liveInsertionGrowth should be advisoryOnly');
  assert(Number.isFinite(Number(firstRun.liveInsertionGrowth.liveNetNewRequiredToday)), 'first run liveInsertionGrowth.liveNetNewRequiredToday missing');
  assert(Number.isFinite(Number(firstRun.liveInsertionGrowth.liveNetNewDeliveredToday)), 'first run liveInsertionGrowth.liveNetNewDeliveredToday missing');
  assert(Number.isFinite(Number(firstRun.liveInsertionGrowth.liveNetNewMissedToday)), 'first run liveInsertionGrowth.liveNetNewMissedToday missing');
  assert(Number.isFinite(Number(firstRun.liveInsertionGrowth.liveNetNewLateToday)), 'first run liveInsertionGrowth.liveNetNewLateToday missing');
  assert(Number.isFinite(Number(firstRun.liveInsertionGrowth.rolling5dOnTimeRatePct)), 'first run liveInsertionGrowth.rolling5dOnTimeRatePct missing');
  assert(firstRun.liveInsertionOwnership && typeof firstRun.liveInsertionOwnership === 'object', 'first run liveInsertionOwnership missing');
  assert(firstRun.liveInsertionOwnership.advisoryOnly === true, 'first run liveInsertionOwnership should be advisoryOnly');
  assert(
    LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(firstRun.liveInsertionOwnership.liveInsertionOwnershipOutcome || '')),
    'first run liveInsertionOwnership.liveInsertionOwnershipOutcome should stay bounded'
  );
  assert(
    LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(firstRun.liveInsertionOwnership.liveInsertionOwnershipScope || '')),
    'first run liveInsertionOwnership.liveInsertionOwnershipScope should stay bounded'
  );
  assert(
    LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
      String(firstRun.liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || '')
    ),
    'first run liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome should stay bounded'
  );
  assert(typeof firstRun.liveInsertionOwnership.liveInsertionOwnershipFirstInsertedAutonomous === 'boolean', 'first run liveInsertionOwnership.liveInsertionOwnershipFirstInsertedAutonomous missing');
  assert(typeof firstRun.liveInsertionOwnership.liveInsertionOwnershipCurrentRunCreatedRow === 'boolean', 'first run liveInsertionOwnership.liveInsertionOwnershipCurrentRunCreatedRow missing');
  assert(typeof firstRun.liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator === 'boolean', 'first run liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator missing');
  assert(typeof firstRun.liveInsertionOwnership.liveOwnershipConsistencyOk === 'boolean', 'first run liveInsertionOwnership.liveOwnershipConsistencyOk missing');
  assert(firstRun.liveAutonomousFirstRight && typeof firstRun.liveAutonomousFirstRight === 'object', 'first run liveAutonomousFirstRight missing');
  assert(firstRun.liveAutonomousFirstRight.advisoryOnly === true, 'first run liveAutonomousFirstRight should be advisoryOnly');
  assert(
    LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(firstRun.liveAutonomousFirstRight.liveAutonomousFirstRightOutcome || '')),
    'first run liveAutonomousFirstRight.liveAutonomousFirstRightOutcome should stay bounded'
  );
  assert(
    LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(firstRun.liveAutonomousFirstRight.liveAutonomousFirstRightWindowState || '')),
    'first run liveAutonomousFirstRight.liveAutonomousFirstRightWindowState should stay bounded'
  );
  assert(typeof firstRun.liveAutonomousFirstRight.liveAutonomousFirstRightActive === 'boolean', 'first run liveAutonomousFirstRight.liveAutonomousFirstRightActive missing');
  assert(typeof firstRun.liveAutonomousFirstRight.liveManualInsertDeferred === 'boolean', 'first run liveAutonomousFirstRight.liveManualInsertDeferred missing');
  assert(typeof firstRun.liveAutonomousFirstRight.liveManualInsertWouldHavePreemptedAutonomous === 'boolean', 'first run liveAutonomousFirstRight.liveManualInsertWouldHavePreemptedAutonomous missing');
  assert(typeof firstRun.liveOwnershipConsistencyOk === 'boolean', 'first run liveOwnershipConsistencyOk missing');
  assert(firstRun.liveTargetDayOwnershipInvariant && typeof firstRun.liveTargetDayOwnershipInvariant === 'object', 'first run liveTargetDayOwnershipInvariant missing');
  assert(typeof firstRun.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent === 'boolean', 'first run liveTargetDayOwnershipConsistent missing');
  assert(
    LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(firstRun.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipMismatchReason || '')),
    'first run liveTargetDayOwnershipMismatchReason should stay bounded'
  );
  assert(firstRun.liveAutonomousProof && typeof firstRun.liveAutonomousProof === 'object', 'first run liveAutonomousProof missing');
  assert(
    LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(firstRun.liveAutonomousProof.liveAutonomousProofOutcome || '')),
    'first run liveAutonomousProofOutcome should stay bounded'
  );
  assert(typeof firstRun.liveAutonomousProof.liveAutonomousProofEligible === 'boolean', 'first run liveAutonomousProofEligible missing');
  assert(typeof firstRun.liveAutonomousProof.liveAutonomousProofAttempted === 'boolean', 'first run liveAutonomousProofAttempted missing');
  assert(typeof firstRun.liveAutonomousProof.liveAutonomousProofSucceeded === 'boolean', 'first run liveAutonomousProofSucceeded missing');
  assert(
    LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(firstRun.liveAutonomousProof.liveAutonomousProofFailureReason || '')),
    'first run liveAutonomousProofFailureReason should stay bounded'
  );
  assert(firstRun.liveAutonomousInsertReadiness && typeof firstRun.liveAutonomousInsertReadiness === 'object', 'first run liveAutonomousInsertReadiness missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.validTradingDay === 'boolean', 'first run liveAutonomousInsertReadiness.validTradingDay missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.liveContextPresent === 'boolean', 'first run liveAutonomousInsertReadiness.liveContextPresent missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.closeComplete === 'boolean', 'first run liveAutonomousInsertReadiness.closeComplete missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.requiredMarketDataPresent === 'boolean', 'first run liveAutonomousInsertReadiness.requiredMarketDataPresent missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.firstRightSatisfied === 'boolean', 'first run liveAutonomousInsertReadiness.firstRightSatisfied missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.existingLiveRowPresent === 'boolean', 'first run liveAutonomousInsertReadiness.existingLiveRowPresent missing');
  assert(typeof firstRun.liveAutonomousInsertReadiness.autonomousInsertEligible === 'boolean', 'first run liveAutonomousInsertReadiness.autonomousInsertEligible missing');
  assert(
    LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(firstRun.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')),
    'first run liveAutonomousInsertReadiness.autonomousInsertBlockReason should stay bounded'
  );
  assert(
    LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(firstRun.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')),
    'first run liveAutonomousInsertReadiness.autonomousInsertNextTransition should stay bounded'
  );
  assert(firstRun.liveAutonomousAttemptTransition && typeof firstRun.liveAutonomousAttemptTransition === 'object', 'first run liveAutonomousAttemptTransition missing');
  assert(typeof firstRun.liveAutonomousAttemptTransition.attemptRequired === 'boolean', 'first run liveAutonomousAttemptTransition.attemptRequired missing');
  assert(typeof firstRun.liveAutonomousAttemptTransition.attemptExecuted === 'boolean', 'first run liveAutonomousAttemptTransition.attemptExecuted missing');
  assert(typeof firstRun.liveAutonomousAttemptTransition.existingRowDetectedAtAttemptTime === 'boolean', 'first run liveAutonomousAttemptTransition.existingRowDetectedAtAttemptTime missing');
  assert(typeof firstRun.liveAutonomousAttemptTransition.rowInsertedByThisAttempt === 'boolean', 'first run liveAutonomousAttemptTransition.rowInsertedByThisAttempt missing');
  assert(
    LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(firstRun.liveAutonomousAttemptTransition.attemptResult || '')),
    'first run liveAutonomousAttemptTransition.attemptResult should stay bounded'
  );
  assert(
    LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(firstRun.liveAutonomousAttemptResult || '')),
    'first run liveAutonomousAttemptResult should stay bounded'
  );
  assert(firstRun.liveAutonomousInsertionMetrics && typeof firstRun.liveAutonomousInsertionMetrics === 'object', 'first run liveAutonomousInsertionMetrics missing');
  assert(firstRun.liveAutonomousInsertionMetrics.advisoryOnly === true, 'first run liveAutonomousInsertionMetrics should be advisoryOnly');
  assert(Number.isFinite(Number(firstRun.liveAutonomousInsertionMetrics.liveAutonomousInsertRequiredToday)), 'first run liveAutonomousInsertionMetrics.liveAutonomousInsertRequiredToday missing');
  assert(Number.isFinite(Number(firstRun.liveAutonomousInsertionMetrics.liveAutonomousInsertDeliveredToday)), 'first run liveAutonomousInsertionMetrics.liveAutonomousInsertDeliveredToday missing');
  assert(Number.isFinite(Number(firstRun.liveAutonomousInsertionMetrics.liveAutonomousInsertMissedToday)), 'first run liveAutonomousInsertionMetrics.liveAutonomousInsertMissedToday missing');
  assert(Number.isFinite(Number(firstRun.liveAutonomousInsertionMetrics.rolling5dAutonomousInsertRatePct)), 'first run liveAutonomousInsertionMetrics.rolling5dAutonomousInsertRatePct missing');
  assert(firstRun.livePreferredOwnerProof && typeof firstRun.livePreferredOwnerProof === 'object', 'first run livePreferredOwnerProof missing');
  assert(typeof firstRun.livePreferredOwnerProof.livePreferredOwnerWon === 'boolean', 'first run livePreferredOwnerProof.livePreferredOwnerWon missing');
  assert(
    LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM.includes(String(firstRun.livePreferredOwnerProof.livePreferredOwnerFailureReason || '')),
    'first run livePreferredOwnerProof.livePreferredOwnerFailureReason should stay bounded'
  );
  assert(firstRun.livePreferredOwnerMetrics && typeof firstRun.livePreferredOwnerMetrics === 'object', 'first run livePreferredOwnerMetrics missing');
  assert(Number.isFinite(Number(firstRun.livePreferredOwnerMetrics.preferredOwnerWonToday)), 'first run livePreferredOwnerMetrics.preferredOwnerWonToday missing');
  assert(Number.isFinite(Number(firstRun.livePreferredOwnerMetrics.preferredOwnerMissedToday)), 'first run livePreferredOwnerMetrics.preferredOwnerMissedToday missing');
  assert(Number.isFinite(Number(firstRun.livePreferredOwnerMetrics.rolling5dPreferredOwnerWinRatePct)), 'first run livePreferredOwnerMetrics.rolling5dPreferredOwnerWinRatePct missing');
  assert(Number.isFinite(Number(firstRun.livePreferredOwnerMetrics.consecutivePreferredOwnerWinDays)), 'first run livePreferredOwnerMetrics.consecutivePreferredOwnerWinDays missing');
  assert(Number.isFinite(Number(firstRun.livePreferredOwnerMetrics.consecutivePreferredOwnerMissDays)), 'first run livePreferredOwnerMetrics.consecutivePreferredOwnerMissDays missing');
  assert(typeof firstRun.livePreferredOwnerMetrics.livePreferredOwnerKpiConsistent === 'boolean', 'first run livePreferredOwnerMetrics.livePreferredOwnerKpiConsistent missing');
  assert(
    LIVE_PREFERRED_OWNER_KPI_MISMATCH_REASON_ENUM.includes(String(firstRun.livePreferredOwnerMetrics.livePreferredOwnerKpiMismatchReason || '')),
    'first run livePreferredOwnerMetrics.livePreferredOwnerKpiMismatchReason should stay bounded'
  );
  assert(
    String(firstRun.livePreferredOwnerMetrics.livePreferredOwnerKpiSource || '') === 'jarvis_live_preferred_owner_proof',
    'first run livePreferredOwnerMetrics.livePreferredOwnerKpiSource should be proof-table source'
  );
  assert(firstRun.livePreferredOwnerReservation && typeof firstRun.livePreferredOwnerReservation === 'object', 'first run livePreferredOwnerReservation missing');
  assert(typeof firstRun.livePreferredOwnerReservation.livePreferredOwnerReservationActive === 'boolean', 'first run livePreferredOwnerReservation.livePreferredOwnerReservationActive missing');
  assert(
    LIVE_PREFERRED_OWNER_RESERVATION_STATE_ENUM.includes(
      String(firstRun.livePreferredOwnerReservation.livePreferredOwnerReservationState || '')
    ),
    'first run livePreferredOwnerReservation.livePreferredOwnerReservationState should stay bounded'
  );
  assert(
    LIVE_PREFERRED_OWNER_RESERVATION_BLOCK_REASON_ENUM.includes(
      String(firstRun.livePreferredOwnerReservation.livePreferredOwnerReservationBlockReason || '')
    ),
    'first run livePreferredOwnerReservation.livePreferredOwnerReservationBlockReason should stay bounded'
  );
  assert(Array.isArray(firstRun.latestCheckpointFailures), 'first run latestCheckpointFailures missing');
  assert(Array.isArray(firstRun.latestMissedCheckpointDates), 'first run latestMissedCheckpointDates missing');
  assert(Number.isFinite(Number(firstRun.validLiveDaysMissedByScheduler)), 'validLiveDaysMissedByScheduler missing on run output');
  assert(Number.isFinite(Number(firstRun.netNewLiveRows1d)), 'netNewLiveRows1d missing on run output');
  const allowedReasons = new Set(LIVE_DAY_CONVERSION_REASON_ENUM);
  for (const decision of firstRun.liveContextDecisions) {
    if (!decision || typeof decision !== 'object') continue;
    if (decision.sourceType !== 'live') continue;
    assert(allowedReasons.has(String(decision.reason || '')), `unexpected live decision reason: ${decision.reason}`);
  }
  const finalizationAllowed = new Set(LIVE_OUTCOME_FINALIZATION_REASON_ENUM);
  for (const [reason] of Object.entries(firstRun.liveFinalizationReasonBuckets || {})) {
    assert(finalizationAllowed.has(String(reason || '')), `unexpected live finalization reason bucket: ${reason}`);
  }
  const stateAllowed = new Set(LIVE_FINALIZATION_READINESS_STATE_ENUM);
  for (const [state] of Object.entries(firstRun.liveFinalizationReadinessStateBuckets || {})) {
    assert(stateAllowed.has(String(state || '')), `unexpected live finalization readiness state bucket: ${state}`);
  }
  const classAllowed = new Set(TRADING_DAY_CLASSIFICATION_ENUM);
  for (const [cls] of Object.entries(firstRun.liveFinalizationTradingDayClassificationBuckets || {})) {
    assert(classAllowed.has(String(cls || '')), `unexpected trading day classification bucket: ${cls}`);
  }
  assert(Number.isFinite(Number(firstRun.validLiveDaysSeen)), 'validLiveDaysSeen missing');
  assert(Number.isFinite(Number(firstRun.validLiveDaysReadyToFinalize)), 'validLiveDaysReadyToFinalize missing');
  assert(Number.isFinite(Number(firstRun.validLiveDaysFinalizedInserted)), 'validLiveDaysFinalizedInserted missing');
  assert(Number.isFinite(Number(firstRun.validLiveDaysFinalizedUpdated)), 'validLiveDaysFinalizedUpdated missing');
  assert(Number.isFinite(Number(firstRun.validLiveDaysStillWaiting)), 'validLiveDaysStillWaiting missing');
  assert(Number.isFinite(Number(firstRun.validLiveDaysBlocked)), 'validLiveDaysBlocked missing');
  assert(Array.isArray(firstRun.latestReadyButUninsertedDates), 'latestReadyButUninsertedDates missing');
  assert(Array.isArray(firstRun.latestWaitingDates), 'latestWaitingDates missing');
  assert(Array.isArray(firstRun.latestBlockedDates), 'latestBlockedDates missing');
  const decisionStateAllowed = new Set(LIVE_FINALIZATION_READINESS_STATE_ENUM);
  const decisionClassAllowed = new Set(TRADING_DAY_CLASSIFICATION_ENUM);
  for (const decision of firstRun.liveContextDecisions || []) {
    if (!decision || typeof decision !== 'object') continue;
    if (decision.sourceType !== 'live') continue;
    assert(decisionStateAllowed.has(String(decision.readinessState || '')), `unexpected decision readinessState: ${decision.readinessState}`);
    assert(decisionClassAllowed.has(String(decision.tradingDayClassification || '')), `unexpected decision tradingDayClassification: ${decision.tradingDayClassification}`);
  }

  const scoredCount = Number(db.prepare('SELECT COUNT(*) AS c FROM jarvis_scored_trade_outcomes').get()?.c || 0);
  assert(scoredCount >= 1, 'scored outcomes table should contain rows after scoring run');

  const secondRun = runAutomaticDailyScoring({
    db,
    sessions,
    windowDays: 3,
    nowDate: date,
    mode: 'unit_test_repeat',
    force: false,
  });
  assert(secondRun && typeof secondRun === 'object', 'second daily scoring run missing');
  assert(Number(secondRun.insertedRows || 0) === 0, 'non-forced repeat run should not insert duplicate scored rows');
  assert(Number(secondRun.liveContextsSeen || 0) >= 1, 'repeat run should still see live contexts');
  assert(Number(secondRun.liveRowsInserted || 0) === 0, 'repeat run should not insert new live rows');
  assert(Number(secondRun.liveContextsSkipped || 0) >= 1, 'repeat run should report skipped live contexts');
  assert(secondRun.liveSkipReasonBuckets && typeof secondRun.liveSkipReasonBuckets === 'object', 'repeat run missing live skip reason buckets');
  assert(Number(secondRun.liveEligibilityReasonBuckets.already_scored || 0) >= 1, 'repeat run should classify already_scored for live contexts');
  assert(Number(secondRun.liveFinalizationAlreadyFinalizedCount || 0) >= 1, 'repeat run should classify already_finalized live contexts');
  assert(secondRun.liveCheckpoint && typeof secondRun.liveCheckpoint === 'object', 'second run missing liveCheckpoint');
  assert(String(secondRun.liveCheckpoint.checkpointStatus || '') === 'success_already_finalized', 'repeat run should checkpoint as success_already_finalized');
  assert(String(secondRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_not_required_already_finalized', 'repeat run should classify SLA as already finalized');

  const thinCloseDate = '2026-03-06';
  seedRecommendationContext(db, thinCloseDate);
  const thinSession = buildSessionCandles(thinCloseDate, 4);
  const awaitingRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [thinCloseDate]: thinSession,
    },
    windowDays: 3,
    nowDate: thinCloseDate,
    mode: 'unit_test_awaiting',
    force: false,
  });
  assert(Number(awaitingRun.liveRowsInserted || 0) === 0, 'thin close run should not insert live scored rows');
  assert(Number(awaitingRun.liveEligibilityReasonBuckets.awaiting_outcome_window || 0) >= 1, 'awaiting_outcome_window reason should be emitted for incomplete same-day sessions');
  assert(Number(awaitingRun.liveFinalizationWaitingReasonBuckets.awaiting_session_close || 0) >= 1, 'awaiting_session_close finalization reason should be emitted for incomplete same-day sessions');
  assert(Number(awaitingRun.validLiveDaysStillWaiting || 0) >= 1, 'validLiveDaysStillWaiting should increment for incomplete same-day session');
  assert(awaitingRun.liveCheckpoint && typeof awaitingRun.liveCheckpoint === 'object', 'awaiting run missing liveCheckpoint');
  assert(String(awaitingRun.liveCheckpoint.checkpointStatus || '') === 'waiting_valid', 'awaiting run should checkpoint as waiting_valid');
  assert(String(awaitingRun.liveCheckpoint.checkpointReason || '') === 'waiting_for_session_close', 'awaiting run should expose waiting_for_session_close');
  assert(String(awaitingRun.liveCheckpoint.awaitingReason || '') === 'awaiting_session_close', 'awaiting run should expose awaiting_session_close');
  assert(awaitingRun.liveCheckpoint.closeComplete === false, 'awaiting run should not be closeComplete');
  assert(String(awaitingRun.liveCheckpoint.closeCompleteReason || '') === 'awaiting_session_close', 'awaiting run closeCompleteReason should be awaiting_session_close');
  assert(String(awaitingRun.liveCheckpoint.checkpointWindowReason || '') === 'awaiting_close_complete', 'awaiting run should classify checkpointWindowReason as awaiting_close_complete');
  assert(String(awaitingRun.liveCheckpoint.runtimeCheckpointOutcome || '') === 'waiting_valid', 'awaiting run runtimeCheckpointOutcome should be waiting_valid');
  assert(String(awaitingRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_waiting_window', 'awaiting run should classify SLA as waiting window');

  const afterCloseMissingBarsRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [thinCloseDate]: buildSessionCandles(thinCloseDate, 4),
    },
    windowDays: 3,
    nowDate: addDays(thinCloseDate, 1),
    mode: 'manual_post_close_checkpoint',
    force: true,
    finalizationOnly: true,
    liveBridgeLookbackDays: 10,
    checkpointTargetTradingDay: thinCloseDate,
  });
  assert(afterCloseMissingBarsRun.liveCheckpoint && typeof afterCloseMissingBarsRun.liveCheckpoint === 'object', 'after-close missing-bars run missing liveCheckpoint');
  assert(afterCloseMissingBarsRun.liveCheckpoint.closeComplete === false, 'after-close missing-bars run should not be closeComplete');
  assert(String(afterCloseMissingBarsRun.liveCheckpoint.closeCompleteReason || '') === 'awaiting_close_bar_completion', 'after-close missing-bars run should classify as awaiting_close_bar_completion');
  assert(String(afterCloseMissingBarsRun.liveCheckpoint.checkpointStatus || '') === 'waiting_valid', 'after-close missing-bars run should remain waiting_valid');
  assert(String(afterCloseMissingBarsRun.liveCheckpoint.checkpointReason || '') === 'waiting_for_required_market_data', 'after-close missing-bars run should expose waiting_for_required_market_data');
  assert(String(afterCloseMissingBarsRun.liveCheckpoint.checkpointWindowReason || '') === 'awaiting_required_market_data', 'after-close missing-bars run should classify checkpointWindowReason as awaiting_required_market_data');
  assert(String(afterCloseMissingBarsRun.liveCheckpoint.runtimeCheckpointOutcome || '') === 'waiting_valid', 'after-close missing-bars run runtimeCheckpointOutcome should be waiting_valid');
  assert(String(afterCloseMissingBarsRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_missing_market_data', 'after-close missing-bars run should classify SLA as missing market data');

  const recoveredRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [thinCloseDate]: buildSessionCandles(thinCloseDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(thinCloseDate, 1),
    mode: 'unit_test_recovery',
    force: true,
    finalizationOnly: true,
    liveBridgeLookbackDays: 10,
  });
  assert(Number(recoveredRun.liveRowsInserted || 0) >= 1, 'late data recovery should insert when waiting day becomes finalizable');
  assert(Number(recoveredRun.validLiveDaysFinalizedInserted || 0) >= 1, 'validLiveDaysFinalizedInserted should increment after recovery insert');
  assert(recoveredRun.liveCheckpoint && typeof recoveredRun.liveCheckpoint === 'object', 'recovered run missing liveCheckpoint');
  assert(String(recoveredRun.liveCheckpoint.checkpointStatus || '') === 'success_inserted', 'close-complete first eligible cycle should checkpoint as success_inserted');
  assert(recoveredRun.liveCheckpoint.closeComplete === true, 'recovered run should be closeComplete');
  assert(String(recoveredRun.liveCheckpoint.closeCompleteReason || '') === 'close_data_complete', 'recovered run closeCompleteReason should be close_data_complete');
  assert(recoveredRun.liveCheckpoint.firstEligibleCycleExpectedInsert === true, 'recovered run should expect first eligible insert');
  assert(recoveredRun.liveCheckpoint.firstEligibleCycleInsertAttempted === true, 'recovered run should attempt insert on first eligible cycle');
  assert(recoveredRun.liveCheckpoint.firstEligibleCycleInsertSucceeded === true, 'recovered run should succeed insert on first eligible cycle');
  assert(String(recoveredRun.liveCheckpoint.sweepSource || '') === 'close_complete_checkpoint', 'recovered run should use close_complete_checkpoint sweep source');
  assert(recoveredRun.liveCheckpoint.runtimeCheckpointWasAutonomous === true, 'recovered run should be autonomous');
  assert(String(recoveredRun.liveCheckpoint.runtimeCheckpointOutcome || '') === 'success_inserted', 'recovered run runtimeCheckpointOutcome should be success_inserted');
  assert(recoveredRun.liveCheckpoint.runtimeCheckpointMissed === false, 'recovered run should not be runtime-missed');
  assert(String(recoveredRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_success_on_time', 'recovered run should classify SLA as success on-time');
  assert(recoveredRun.liveInsertionSla?.liveInsertionSlaNetNewRowCreated === true, 'recovered run should mark SLA net-new row created');
  assert(Number(recoveredRun.liveInsertionSla?.liveInsertionSlaCreatedRowId || 0) > 0, 'recovered run should report SLA created row id');
  assert(String(recoveredRun.liveInsertionOwnership?.liveInsertionOwnershipOutcome || '') === 'first_autonomous_insert_of_day', 'recovered run should mark first autonomous insert ownership');
  assert(
    String(recoveredRun.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome || '') === 'first_autonomous_insert_by_close_complete_checkpoint',
    'recovered run should mark close_complete_checkpoint as source-specific first autonomous owner'
  );
  assert(recoveredRun.liveInsertionOwnership?.liveInsertionOwnershipFirstInsertedAutonomous === true, 'recovered run ownership should be autonomous');
  assert(recoveredRun.liveInsertionOwnership?.liveInsertionOwnershipCurrentRunWasFirstCreator === true, 'recovered run ownership should mark current run as first creator');
  assert(recoveredRun.liveAutonomousAttemptTransition?.attemptRequired === true, 'recovered run should require autonomous attempt');
  assert(recoveredRun.liveAutonomousAttemptTransition?.attemptExecuted === true, 'recovered run should execute autonomous attempt');
  assert(String(recoveredRun.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_executed_success', 'recovered run should classify attempt result as executed success');
  assert(recoveredRun.liveAutonomousAttemptTransition?.rowInsertedByThisAttempt === true, 'recovered run should mark rowInsertedByThisAttempt true');
  assert(Number(recoveredRun.liveAutonomousAttemptTransition?.insertedRowId || 0) > 0, 'recovered run should expose insertedRowId');
  assert(String(recoveredRun.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_attempted_success', 'recovered run should classify autonomous proof as attempted success');
  assert(recoveredRun.liveAutonomousProof?.liveAutonomousProofAttempted === true, 'recovered run should mark autonomous proof attempted');
  assert(recoveredRun.liveAutonomousProof?.liveAutonomousProofSucceeded === true, 'recovered run should mark autonomous proof succeeded');
  assert(Number(recoveredRun.liveCheckpoint?.checkpointActualOutcomeCount || 0) === 1, 'recovered run checkpoint actual outcome count should be 1 on insert success');
  assert(Number(recoveredRun.liveAutonomousInsertionMetrics?.liveAutonomousInsertDeliveredToday || 0) === 1, 'recovered run should deliver autonomous insert today');
  const recoveredLiveRowCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ?
      AND lower(source_type) = 'live'
      AND lower(reconstruction_phase) = 'live_intraday'
  `).get(thinCloseDate)?.c || 0);
  assert(recoveredLiveRowCount === 1, 'recovered run should create exactly one live row for the target trading day');
  const recoveredOwnershipRow = db.prepare(`
    SELECT target_trading_day, created_row_id, first_run_id, first_run_mode, first_run_source, first_inserted_autonomous
    FROM jarvis_live_outcome_ownership
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(thinCloseDate);
  assert(recoveredOwnershipRow && recoveredOwnershipRow.target_trading_day === thinCloseDate, 'recovered run should persist ownership provenance row for target day');
  assert(Number(recoveredOwnershipRow.created_row_id || 0) === Number(recoveredRun.liveAutonomousAttemptTransition?.insertedRowId || 0), 'ownership created_row_id should match insertedRowId');
  assert(Number(recoveredOwnershipRow.first_inserted_autonomous || 0) === 1, 'ownership provenance should mark first insert as autonomous');
  assert(String(recoveredOwnershipRow.first_run_source || '') !== 'manual_api_run', 'ownership provenance first_run_source must not be manual_api_run for autonomous success');

  const recoveredRepeatRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [thinCloseDate]: buildSessionCandles(thinCloseDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(thinCloseDate, 1),
    mode: 'unit_test_recovery_repeat',
    force: false,
    finalizationOnly: true,
    liveBridgeLookbackDays: 10,
    checkpointTargetTradingDay: thinCloseDate,
  });
  assert(String(recoveredRepeatRun.liveCheckpoint.checkpointStatus || '') === 'success_already_finalized', 'existing live row after close-complete should checkpoint as success_already_finalized');
  assert(recoveredRepeatRun.liveCheckpoint.firstEligibleCycleExpectedInsert === false, 'existing live row should not expect first eligible insert');
  assert(recoveredRepeatRun.liveCheckpoint.runtimeCheckpointWasAutonomous === true, 'recovered repeat run should be autonomous');
  assert(String(recoveredRepeatRun.liveCheckpoint.runtimeCheckpointOutcome || '') === 'success_already_finalized', 'recovered repeat run runtimeCheckpointOutcome should be success_already_finalized');
  assert(String(recoveredRepeatRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_not_required_already_finalized', 'recovered repeat run should classify SLA as already finalized');
  assert(String(recoveredRepeatRun.liveInsertionOwnership?.liveInsertionOwnershipOutcome || '') === 'already_inserted_by_prior_autonomous_run', 'recovered repeat run should classify ownership as prior autonomous run');
  assert(String(recoveredRepeatRun.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_blocked_existing_row', 'recovered repeat run should classify attempt result as blocked existing row');
  assert(recoveredRepeatRun.liveAutonomousAttemptTransition?.attemptRequired === false, 'recovered repeat run should not require a fresh attempt');
  assert(recoveredRepeatRun.liveAutonomousAttemptTransition?.attemptExecuted === false, 'recovered repeat run should not execute a new attempt');
  assert(String(recoveredRepeatRun.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_blocked_existing_row', 'recovered repeat run should classify proof as blocked existing row');
  assert(Number(recoveredRepeatRun.liveAutonomousInsertionMetrics?.liveAutonomousInsertDeliveredToday || 0) === 0, 'recovered repeat run should not count as autonomous delivered today');

  const manualOwnershipDate = '2026-03-12';
  seedRecommendationContext(db, manualOwnershipDate);
  const manualOwnershipInsertRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [manualOwnershipDate]: buildSessionCandles(manualOwnershipDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(manualOwnershipDate, 1),
    mode: 'manual_post_close_checkpoint',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: manualOwnershipDate,
  });
  assert(String(manualOwnershipInsertRun.liveCheckpoint.runtimeCheckpointSource || '') === 'manual_api_run', 'manual ownership insert should come from manual_api_run');
  assert(String(manualOwnershipInsertRun.liveInsertionOwnership?.liveInsertionOwnershipOutcome || '') === 'already_inserted_by_manual_run', 'manual ownership insert should classify as already_inserted_by_manual_run');
  assert(
    String(manualOwnershipInsertRun.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome || '') === 'first_manual_insert_of_day',
    'manual ownership insert should keep source-specific manual-first attribution'
  );
  assert(
    manualOwnershipInsertRun.livePreferredOwnerProof?.livePreferredOwnerWon === false,
    'manual ownership insert should not mark preferred-owner win'
  );
  assert(
    String(manualOwnershipInsertRun.livePreferredOwnerProof?.livePreferredOwnerFailureReason || '') === 'manual_owner_preempted',
    'manual ownership insert should classify preferred-owner failure as manual_owner_preempted'
  );
  const naturalWinsAfterManualOwnershipInsert = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_natural_wins
    WHERE target_trading_day = ?
      AND lower(run_origin) = 'natural'
  `).get(manualOwnershipDate)?.c || 0);
  const naturalVerifierRowsAfterManualOwnershipInsert = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_post_close_verifier
    WHERE target_trading_day = ?
      AND lower(run_origin) = 'natural'
  `).get(manualOwnershipDate)?.c || 0);
  assert(
    naturalWinsAfterManualOwnershipInsert === 0,
    'manual ownership insert must not create natural preferred-owner win rows'
  );
  assert(
    naturalVerifierRowsAfterManualOwnershipInsert === 0,
    'manual ownership insert must not contaminate natural verifier rows'
  );
  const statusAfterManualOwnershipInsert = buildDailyScoringStatus({ db, sessions });
  assert(
    Number(statusAfterManualOwnershipInsert.naturalPreferredOwnerWinsTotal || 0) === 0,
    'manual ownership insert must not increment naturalPreferredOwnerWinsTotal'
  );
  assert(
    Number(statusAfterManualOwnershipInsert.naturalPreferredOwnerVerifierPassesLast5d || 0) === 0,
    'manual ownership insert must not increment naturalPreferredOwnerVerifierPassesLast5d'
  );
  assert(
    Number(statusAfterManualOwnershipInsert.naturalPreferredOwnerVerifierFailsLast5d || 0) === 0,
    'manual ownership insert must not increment naturalPreferredOwnerVerifierFailsLast5d'
  );
  const autonomousOwnershipConfirmRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [manualOwnershipDate]: buildSessionCandles(manualOwnershipDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(manualOwnershipDate, 1),
    mode: 'scheduled_live_finalization_morning_repair',
    force: false,
    finalizationOnly: true,
    checkpointTargetTradingDay: manualOwnershipDate,
  });
  assert(autonomousOwnershipConfirmRun.liveCheckpoint.runtimeCheckpointWasAutonomous === true, 'autonomous ownership confirm should be autonomous');
  assert(String(autonomousOwnershipConfirmRun.liveInsertionOwnership?.liveInsertionOwnershipOutcome || '') === 'already_inserted_by_manual_run', 'autonomous ownership confirm should preserve manual ownership outcome');
  assert(Number(autonomousOwnershipConfirmRun.liveAutonomousInsertionMetrics?.liveAutonomousInsertDeliveredToday || 0) === 0, 'autonomous ownership confirm should not count as autonomous delivery');
  assert(Number(autonomousOwnershipConfirmRun.liveAutonomousInsertionMetrics?.liveAutonomousInsertMissedToday || 0) === 0, 'manual preempted confirmation should not fabricate autonomous miss count');
  assert(
    String(autonomousOwnershipConfirmRun.livePreferredOwnerProof?.livePreferredOwnerFailureReason || '') === 'manual_owner_preempted',
    'autonomous ownership confirmation should retain preferred-owner manual preempt failure reason'
  );
  const closeCompleteLossVerifierRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [manualOwnershipDate]: buildSessionCandles(manualOwnershipDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(manualOwnershipDate, 1),
    nowTime: '17:12',
    mode: 'scheduled_live_finalization_close_window',
    finalizationSweepSource: 'close_complete_checkpoint',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: manualOwnershipDate,
    runOrigin: 'natural',
    runtimeTriggered: true,
  });
  assert(
    PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
      String(closeCompleteLossVerifierRun.livePreferredOwnerPostCloseProofVerifierStatus || '')
    ),
    'close-complete loss verifier run status should stay bounded'
  );
  assert(
    closeCompleteLossVerifierRun.livePreferredOwnerPostCloseProofVerifierPass === false,
    'close-complete loss verifier run should classify preferred-owner loss as verifier fail'
  );
  const lossVerifierReasons = Array.isArray(
    closeCompleteLossVerifierRun.livePreferredOwnerPostCloseProofVerifierFailureReasons
  )
    ? closeCompleteLossVerifierRun.livePreferredOwnerPostCloseProofVerifierFailureReasons
    : [];
  assert(
    lossVerifierReasons.every((reason) => PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))),
    'close-complete loss verifier reasons should stay bounded'
  );
  assert(
    lossVerifierReasons.includes('preferred_owner_not_winner'),
    'close-complete loss verifier should include preferred_owner_not_winner reason for manual preempted target day'
  );
  const lossVerifierRow = db.prepare(`
    SELECT target_trading_day, verifier_status, verifier_pass, failure_reasons_json
    FROM jarvis_preferred_owner_post_close_verifier
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(manualOwnershipDate);
  assert(lossVerifierRow, 'close-complete loss verifier run should persist post-close verifier row');
  assert(String(lossVerifierRow.verifier_status || '') === 'fail', 'loss verifier row should persist fail status');
  assert(Number(lossVerifierRow.verifier_pass || 0) === 0, 'loss verifier row should persist verifier_pass=0');
  const lossOperationalVerdictRow = db.prepare(`
    SELECT target_trading_day, verifier_status, verifier_pass, run_origin, runtime_checkpoint_source
    FROM jarvis_preferred_owner_operational_verdicts
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(manualOwnershipDate);
  assert(lossOperationalVerdictRow, 'close-complete loss verifier run should persist one operational verdict row');
  assert(String(lossOperationalVerdictRow.verifier_status || '') === 'fail', 'loss operational verdict row should persist fail status');
  assert(Number(lossOperationalVerdictRow.verifier_pass || 0) === 0, 'loss operational verdict row should persist verifier_pass=0');
  assert(String(lossOperationalVerdictRow.run_origin || '') === 'natural', 'loss operational verdict row should persist run_origin=natural');
  assert(String(lossOperationalVerdictRow.runtime_checkpoint_source || '') === 'close_complete_checkpoint', 'loss operational verdict row should persist runtime_checkpoint_source=close_complete_checkpoint');
  const lossOperationalProofBundleRow = db.prepare(`
    SELECT
      target_trading_day,
      verifier_status,
      verifier_pass,
      run_origin,
      runtime_checkpoint_source,
      ownership_source_specific_outcome
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(manualOwnershipDate);
  assert(lossOperationalProofBundleRow, 'close-complete loss verifier run should persist one operational proof bundle row');
  assert(String(lossOperationalProofBundleRow.verifier_status || '') === 'fail', 'loss operational proof bundle row should persist fail status');
  assert(Number(lossOperationalProofBundleRow.verifier_pass || 0) === 0, 'loss operational proof bundle row should persist verifier_pass=0');
  assert(String(lossOperationalProofBundleRow.run_origin || '') === 'natural', 'loss operational proof bundle row should persist run_origin=natural');
  assert(String(lossOperationalProofBundleRow.runtime_checkpoint_source || '') === 'close_complete_checkpoint', 'loss operational proof bundle row should persist runtime_checkpoint_source=close_complete_checkpoint');
  assert(
    LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
      String(lossOperationalProofBundleRow.ownership_source_specific_outcome || '')
    ),
    'loss operational proof bundle row should persist bounded ownership source-specific outcome'
  );
  const unresolvedWaitingDate = '2026-03-18';
  seedRecommendationContext(db, unresolvedWaitingDate);
  const unresolvedWaitingRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [unresolvedWaitingDate]: buildSessionCandles(unresolvedWaitingDate, 30),
    },
    windowDays: 3,
    nowDate: unresolvedWaitingDate,
    nowTime: '13:15',
    mode: 'scheduled_live_finalization_close_window',
    finalizationSweepSource: 'close_complete_checkpoint',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: unresolvedWaitingDate,
    runOrigin: 'natural',
    runtimeTriggered: true,
  });
  assert(
    String(unresolvedWaitingRun.liveCheckpoint?.checkpointStatus || '') === 'waiting_valid',
    'unresolved waiting run should keep checkpointStatus=waiting_valid'
  );
  assert(
    unresolvedWaitingRun.livePreferredOwnerPostCloseProofVerifierPass === false,
    'unresolved waiting run should keep verifier pass=false'
  );
  assert(
    Array.isArray(unresolvedWaitingRun.livePreferredOwnerPostCloseProofVerifierFailureReasons)
      && unresolvedWaitingRun.livePreferredOwnerPostCloseProofVerifierFailureReasons.includes('checkpoint_not_resolved'),
    'unresolved waiting run should emit checkpoint_not_resolved verifier reason'
  );
  const unresolvedVerifierRow = db.prepare(`
    SELECT target_trading_day
    FROM jarvis_preferred_owner_post_close_verifier
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(unresolvedWaitingDate);
  assert(
    !unresolvedVerifierRow,
    'unresolved waiting run must not persist a verifier row before resolved checkpoint state'
  );
  const unresolvedOperationalVerdictRow = db.prepare(`
    SELECT target_trading_day
    FROM jarvis_preferred_owner_operational_verdicts
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(unresolvedWaitingDate);
  assert(
    !unresolvedOperationalVerdictRow,
    'unresolved waiting run must not persist operational verdict rows before resolved checkpoint state'
  );
  const unresolvedOperationalProofBundleRow = db.prepare(`
    SELECT target_trading_day
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(unresolvedWaitingDate);
  assert(
    !unresolvedOperationalProofBundleRow,
    'unresolved waiting run must not persist operational proof bundle rows before resolved checkpoint state'
  );

  const manualResolvedNoWatcherDate = '2026-03-21';
  seedRecommendationContext(db, manualResolvedNoWatcherDate);
  db.prepare(`
    INSERT INTO jarvis_preferred_owner_post_close_verifier (
      target_trading_day,
      run_id,
      run_origin,
      runtime_source,
      checkpoint_status,
      verifier_status,
      verifier_pass,
      failure_reasons_json,
      summary_json,
      verified_at
    ) VALUES (?, ?, 'manual', 'manual_api_run', 'success_already_finalized', 'pass', 1, '[]', '{}', datetime('now'))
    ON CONFLICT(target_trading_day) DO NOTHING
  `).run(manualResolvedNoWatcherDate, Number(closeCompleteLossVerifierRun.runId || 0) + 500);
  const manualResolvedNoWatcherRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [manualResolvedNoWatcherDate]: buildSessionCandles(manualResolvedNoWatcherDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(manualResolvedNoWatcherDate, 1),
    nowTime: '17:20',
    mode: 'integration_manual',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: manualResolvedNoWatcherDate,
    runOrigin: 'manual',
    runtimeTriggered: false,
  });
  assert(
    String(manualResolvedNoWatcherRun.runOrigin || '') === 'manual',
    'manual resolved verifier scenario should run with manual origin'
  );
  const manualResolvedNoWatcherVerdictRow = db.prepare(`
    SELECT target_trading_day
    FROM jarvis_preferred_owner_operational_verdicts
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(manualResolvedNoWatcherDate);
  assert(
    !manualResolvedNoWatcherVerdictRow,
    'manual resolved verifier rows must not trigger natural operational verdict watcher rows'
  );
  const manualResolvedNoWatcherProofBundleRow = db.prepare(`
    SELECT target_trading_day
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(manualResolvedNoWatcherDate);
  assert(
    !manualResolvedNoWatcherProofBundleRow,
    'manual resolved verifier rows must not trigger natural operational proof bundle rows'
  );

  const manualDeferredDate = '2026-03-13';
  seedRecommendationContext(db, manualDeferredDate);
  const manualDeferredRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [manualDeferredDate]: buildSessionCandles(manualDeferredDate, 90),
    },
    windowDays: 2,
    nowDate: manualDeferredDate,
    nowTime: '17:10',
    mode: 'integration_manual',
    force: true,
    finalizationOnly: false,
    checkpointTargetTradingDay: manualDeferredDate,
  });
  assert(manualDeferredRun.liveAutonomousFirstRight?.liveManualInsertDeferred === true, 'manual deferred run should mark liveManualInsertDeferred');
  assert(
    String(manualDeferredRun.liveAutonomousFirstRight?.liveAutonomousFirstRightOutcome || '') === 'manual_insert_deferred_to_autonomous_window',
    'manual deferred run should classify first-right outcome as manual_insert_deferred_to_autonomous_window'
  );
  const manualDeferredOutcomeCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
  `).get(manualDeferredDate)?.c || 0);
  assert(manualDeferredOutcomeCount === 0, 'manual deferred run should not insert live outcome during autonomous first-right window');

  const preferredOwnerDate = '2026-03-17';
  seedRecommendationContext(db, preferredOwnerDate);
  const startupDeferredAutonomousRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [preferredOwnerDate]: buildSessionCandles(preferredOwnerDate, 90),
    },
    windowDays: 3,
    nowDate: preferredOwnerDate,
    nowTime: '17:10',
    mode: 'startup_live_finalization',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: preferredOwnerDate,
  });
  assert(
    String(startupDeferredAutonomousRun.liveCheckpoint?.runtimeCheckpointSource || '') === 'startup_reconciliation',
    'startup deferred autonomous run should use startup_reconciliation source'
  );
  assert(
    Number(startupDeferredAutonomousRun.liveEligibilityReasonBuckets?.autonomous_insert_deferred_to_preferred_owner || 0) >= 1,
    'startup deferred autonomous run should emit autonomous_insert_deferred_to_preferred_owner reason'
  );
  assert(
    startupDeferredAutonomousRun.livePreferredOwnerReservation?.livePreferredOwnerReservationActive === true,
    'startup deferred autonomous run should keep preferred-owner reservation active'
  );
  assert(
    String(startupDeferredAutonomousRun.livePreferredOwnerReservation?.livePreferredOwnerReservationState || '') === 'reservation_waiting_for_preferred_owner',
    'startup deferred autonomous run should classify reservation as waiting_for_preferred_owner'
  );
  assert(
    String(startupDeferredAutonomousRun.livePreferredOwnerReservation?.livePreferredOwnerDeferredFallbackSource || '') === 'startup_reconciliation',
    'startup deferred autonomous run should persist deferred fallback source as startup_reconciliation'
  );
  assert(
    String(startupDeferredAutonomousRun.livePreferredOwnerReservation?.livePreferredOwnerDeferredFallbackReason || '') === 'preferred_owner_window_still_open',
    'startup deferred autonomous run should persist deferred fallback reason as preferred_owner_window_still_open'
  );
  assert(
    LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM.includes(
      String(startupDeferredAutonomousRun.livePreferredOwnerProof?.livePreferredOwnerFailureReason || '')
    ),
    'startup deferred autonomous run preferred-owner failure reason should stay bounded'
  );
  const deferredAuditRow = db.prepare(`
    SELECT target_trading_day, fallback_source, deferral_reason, reservation_state, run_id, run_origin
    FROM jarvis_preferred_owner_deferrals
    WHERE target_trading_day = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(deferredAuditRow, 'startup deferred autonomous run should persist preferred-owner deferral audit row');
  assert(String(deferredAuditRow.fallback_source || '') === 'startup_reconciliation', 'preferred-owner deferral audit should persist fallback_source=startup_reconciliation');
  assert(String(deferredAuditRow.deferral_reason || '') === 'preferred_owner_window_still_open', 'preferred-owner deferral audit should persist preferred_owner_window_still_open reason');
  assert(String(deferredAuditRow.reservation_state || '') === 'reservation_waiting_for_preferred_owner', 'preferred-owner deferral audit should persist reservation_waiting_for_preferred_owner state');
  assert(DAILY_SCORING_RUN_ORIGIN_ENUM.includes(String(deferredAuditRow.run_origin || '')), 'preferred-owner deferral audit run_origin should stay bounded');
  const deferredAutonomousCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
  `).get(preferredOwnerDate)?.c || 0);
  assert(deferredAutonomousCount === 0, 'startup deferred autonomous run should not preempt preferred close-complete owner');

  const closeCompletePreferredOwnerRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [preferredOwnerDate]: buildSessionCandles(preferredOwnerDate, 90),
    },
    windowDays: 3,
    nowDate: preferredOwnerDate,
    nowTime: '17:12',
    mode: 'scheduled_live_finalization_close_window',
    finalizationSweepSource: 'close_complete_checkpoint',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: preferredOwnerDate,
    runOrigin: 'natural',
    runtimeTriggered: true,
  });
  assert(
    String(closeCompletePreferredOwnerRun.liveCheckpoint?.runtimeCheckpointSource || '') === 'close_complete_checkpoint',
    'close-complete preferred owner run should use close_complete_checkpoint source'
  );
  assert(
    String(closeCompletePreferredOwnerRun.liveInsertionOwnership?.liveInsertionOwnershipOutcome || '') === 'first_autonomous_insert_of_day',
    'close-complete preferred owner run should own first autonomous insert'
  );
  assert(
    String(closeCompletePreferredOwnerRun.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome || '') === 'first_autonomous_insert_by_close_complete_checkpoint',
    'close-complete preferred owner run should classify source-specific ownership correctly'
  );
  assert(
    closeCompletePreferredOwnerRun.livePreferredOwnerProof?.livePreferredOwnerWon === true,
    'close-complete preferred owner run should mark preferred owner won'
  );
  assert(
    String(closeCompletePreferredOwnerRun.livePreferredOwnerProof?.livePreferredOwnerFailureReason || '') === 'none',
    'close-complete preferred owner run should keep preferred owner failure reason as none'
  );
  assert(
    Number(closeCompletePreferredOwnerRun.livePreferredOwnerMetrics?.preferredOwnerWonToday || 0) === 1,
    'close-complete preferred owner run should count preferred owner won today'
  );
  assert(
    Number(closeCompletePreferredOwnerRun.livePreferredOwnerMetrics?.preferredOwnerMissedToday || 0) === 0,
    'close-complete preferred owner run should not count preferred owner missed today'
  );
  assert(
    closeCompletePreferredOwnerRun.livePreferredOwnerMetrics?.livePreferredOwnerKpiConsistent === true,
    'close-complete preferred owner run should keep preferred-owner KPI consistency true'
  );
  assert(
    String(closeCompletePreferredOwnerRun.livePreferredOwnerMetrics?.livePreferredOwnerKpiSource || '') === 'jarvis_live_preferred_owner_proof',
    'close-complete preferred owner run should source preferred-owner KPIs from proof table'
  );
  assert(
    Number(closeCompletePreferredOwnerRun.naturalPreferredOwnerWinsTotal || 0) >= 1,
    'close-complete preferred owner natural run should increment naturalPreferredOwnerWinsTotal'
  );
  assert(
    Number(closeCompletePreferredOwnerRun.naturalPreferredOwnerWinsLast5d || 0) >= 1,
    'close-complete preferred owner natural run should increment naturalPreferredOwnerWinsLast5d'
  );
  assert(
    String(closeCompletePreferredOwnerRun.lastNaturalPreferredOwnerWinDay || '') === preferredOwnerDate,
    'close-complete preferred owner natural run should set lastNaturalPreferredOwnerWinDay to target day'
  );
  assert(
    PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
      String(closeCompletePreferredOwnerRun.livePreferredOwnerPostCloseProofVerifierStatus || '')
    ),
    'close-complete preferred owner run verifier status should stay bounded'
  );
  assert(
    closeCompletePreferredOwnerRun.livePreferredOwnerPostCloseProofVerifierPass === true,
    'close-complete preferred owner run should pass post-close preferred-owner verifier'
  );
  assert(
    Array.isArray(closeCompletePreferredOwnerRun.livePreferredOwnerPostCloseProofVerifierFailureReasons)
      && closeCompletePreferredOwnerRun.livePreferredOwnerPostCloseProofVerifierFailureReasons.length === 0,
    'close-complete preferred owner run should not emit verifier fail reasons on pass'
  );
  assert(
    closeCompletePreferredOwnerRun.livePreferredOwnerNaturalWinEvent?.wasNewRowPersisted === true,
    'close-complete preferred owner natural run should persist exactly one new natural-win row'
  );
  const naturalWinAuditRow = db.prepare(`
    SELECT target_trading_day, run_id, first_creator_source, reservation_state, reservation_blocked_fallback, proof_row_id, run_origin
    FROM jarvis_preferred_owner_natural_wins
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(naturalWinAuditRow, 'close-complete preferred owner natural run should persist preferred-owner natural win row');
  assert(String(naturalWinAuditRow.first_creator_source || '') === 'close_complete_checkpoint', 'preferred-owner natural win should persist first_creator_source=close_complete_checkpoint');
  assert(String(naturalWinAuditRow.run_origin || '') === 'natural', 'preferred-owner natural win should persist run_origin=natural');
  assert(Number(naturalWinAuditRow.proof_row_id || 0) > 0, 'preferred-owner natural win should persist proof_row_id');
  const winVerifierRow = db.prepare(`
    SELECT target_trading_day, run_id, verifier_status, verifier_pass, failure_reasons_json
    FROM jarvis_preferred_owner_post_close_verifier
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(winVerifierRow, 'close-complete preferred owner run should persist post-close verifier row');
  assert(String(winVerifierRow.verifier_status || '') === 'pass', 'preferred-owner verifier row should persist pass status');
  assert(Number(winVerifierRow.verifier_pass || 0) === 1, 'preferred-owner verifier row should persist verifier_pass=1');
  const passOperationalVerdictRow = db.prepare(`
    SELECT
      target_trading_day,
      verifier_status,
      verifier_pass,
      run_origin,
      runtime_checkpoint_source,
      ownership_source_specific_outcome
    FROM jarvis_preferred_owner_operational_verdicts
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(passOperationalVerdictRow, 'close-complete preferred owner run should persist one operational verdict row');
  assert(String(passOperationalVerdictRow.verifier_status || '') === 'pass', 'pass operational verdict row should persist pass status');
  assert(Number(passOperationalVerdictRow.verifier_pass || 0) === 1, 'pass operational verdict row should persist verifier_pass=1');
  assert(String(passOperationalVerdictRow.run_origin || '') === 'natural', 'pass operational verdict row should persist run_origin=natural');
  assert(String(passOperationalVerdictRow.runtime_checkpoint_source || '') === 'close_complete_checkpoint', 'pass operational verdict row should persist runtime_checkpoint_source=close_complete_checkpoint');
  assert(
    LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
      String(passOperationalVerdictRow.ownership_source_specific_outcome || '')
    ),
    'pass operational verdict row should persist bounded ownership source-specific outcome'
  );
  const passOperationalProofBundleRow = db.prepare(`
    SELECT
      target_trading_day,
      verifier_status,
      verifier_pass,
      run_origin,
      runtime_checkpoint_source,
      ownership_source_specific_outcome
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(passOperationalProofBundleRow, 'close-complete preferred owner run should persist one operational proof bundle row');
  assert(String(passOperationalProofBundleRow.verifier_status || '') === 'pass', 'pass operational proof bundle row should persist pass status');
  assert(Number(passOperationalProofBundleRow.verifier_pass || 0) === 1, 'pass operational proof bundle row should persist verifier_pass=1');
  assert(String(passOperationalProofBundleRow.run_origin || '') === 'natural', 'pass operational proof bundle row should persist run_origin=natural');
  assert(String(passOperationalProofBundleRow.runtime_checkpoint_source || '') === 'close_complete_checkpoint', 'pass operational proof bundle row should persist runtime_checkpoint_source=close_complete_checkpoint');
  assert(
    LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
      String(passOperationalProofBundleRow.ownership_source_specific_outcome || '')
    ),
    'pass operational proof bundle row should persist bounded ownership source-specific outcome'
  );
  const naturalRunOriginRow = db.prepare(`
    SELECT run_origin
    FROM jarvis_daily_scoring_runs
    WHERE id = ?
    LIMIT 1
  `).get(Number(closeCompletePreferredOwnerRun.runId || 0));
  assert(String(naturalRunOriginRow?.run_origin || '') === 'natural', 'daily scoring run should persist run_origin=natural for natural preferred-owner run');
  assert(
    String(closeCompletePreferredOwnerRun.livePreferredOwnerReservation?.livePreferredOwnerReservationState || '') === 'reservation_released_after_preferred_owner_win',
    'close-complete preferred owner run should release reservation after preferred-owner win'
  );
  const preferredOwnerRow = db.prepare(`
    SELECT target_trading_day, first_run_source, first_inserted_autonomous
    FROM jarvis_live_outcome_ownership
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(preferredOwnerRow, 'close-complete preferred owner run should persist ownership row');
  assert(String(preferredOwnerRow.first_run_source || '') === 'close_complete_checkpoint', 'preferred owner provenance should set first_run_source=close_complete_checkpoint');
  assert(Number(preferredOwnerRow.first_inserted_autonomous || 0) === 1, 'preferred owner provenance should mark first_inserted_autonomous=1');
  const preferredOwnerProofRow = db.prepare(`
    SELECT
      target_trading_day,
      preferred_owner_expected_source,
      first_creator_source,
      preferred_owner_won,
      preferred_owner_failure_reason
    FROM jarvis_live_preferred_owner_proof
    WHERE target_trading_day = ?
    LIMIT 1
  `).get(preferredOwnerDate);
  assert(preferredOwnerProofRow, 'close-complete preferred owner run should persist preferred-owner proof row');
  assert(String(preferredOwnerProofRow.preferred_owner_expected_source || '') === 'close_complete_checkpoint', 'preferred-owner proof expected source should be close_complete_checkpoint');
  assert(String(preferredOwnerProofRow.first_creator_source || '') === 'close_complete_checkpoint', 'preferred-owner proof actual source should be close_complete_checkpoint');
  assert(Number(preferredOwnerProofRow.preferred_owner_won || 0) === 1, 'preferred-owner proof should mark preferred_owner_won=1');
  assert(String(preferredOwnerProofRow.preferred_owner_failure_reason || '') === 'none', 'preferred-owner proof should keep failure reason as none on preferred-owner win');
  const closeCompletePreferredCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
  `).get(preferredOwnerDate)?.c || 0);
  assert(closeCompletePreferredCount === 1, 'close-complete preferred owner run should insert exactly one live row');
  const verifierRowCountBeforeIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_post_close_verifier
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const operationalVerdictRowCountBeforeIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_operational_verdicts
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const naturalWinRowCountBeforeIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_natural_wins
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const operationalProofBundleRowCountBeforeIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const closeCompletePreferredReplayRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [preferredOwnerDate]: buildSessionCandles(preferredOwnerDate, 90),
    },
    windowDays: 3,
    nowDate: preferredOwnerDate,
    nowTime: '17:15',
    mode: 'scheduled_live_finalization_close_window',
    finalizationSweepSource: 'close_complete_checkpoint',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: preferredOwnerDate,
    runOrigin: 'natural',
    runtimeTriggered: true,
  });
  assert(
    closeCompletePreferredReplayRun.livePreferredOwnerPostCloseProofVerifierPass === true,
    'idempotent replay on same resolved natural cycle should keep verifier pass=true'
  );
  assert(
    closeCompletePreferredReplayRun.livePreferredOwnerPostCloseProofVerifier?.verifierPersistedThisRun === false,
    'idempotent replay on same resolved natural cycle must not persist a duplicate verifier row'
  );
  const verifierRowCountAfterIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_post_close_verifier
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const operationalVerdictRowCountAfterIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_operational_verdicts
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const naturalWinRowCountAfterIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_natural_wins
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  const operationalProofBundleRowCountAfterIdempotentReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
  `).get(preferredOwnerDate)?.c || 0);
  assert(
    verifierRowCountAfterIdempotentReplay === verifierRowCountBeforeIdempotentReplay,
    'idempotent replay must not create duplicate verifier rows for same target day'
  );
  assert(
    operationalVerdictRowCountAfterIdempotentReplay === operationalVerdictRowCountBeforeIdempotentReplay,
    'idempotent replay must not create duplicate operational verdict rows for same target day'
  );
  assert(
    naturalWinRowCountAfterIdempotentReplay === naturalWinRowCountBeforeIdempotentReplay,
    'idempotent replay must not create duplicate natural-win rows for same target day'
  );
  assert(
    operationalProofBundleRowCountAfterIdempotentReplay === operationalProofBundleRowCountBeforeIdempotentReplay,
    'idempotent replay must not create duplicate operational proof bundle rows for same target day'
  );

  const startupCloseCompletePreferredOwnerDate = '2026-03-09';
  seedRecommendationContext(db, startupCloseCompletePreferredOwnerDate);
  const startupCloseCompletePreferredOwnerRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [startupCloseCompletePreferredOwnerDate]: buildSessionCandles(startupCloseCompletePreferredOwnerDate, 90),
    },
    windowDays: 3,
    nowDate: startupCloseCompletePreferredOwnerDate,
    nowTime: '17:14',
    mode: 'startup_close_complete_checkpoint',
    finalizationSweepSource: 'close_complete_checkpoint',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: startupCloseCompletePreferredOwnerDate,
    runOrigin: 'natural',
    runtimeTriggered: true,
  });
  assert(
    String(startupCloseCompletePreferredOwnerRun.liveCheckpoint?.runtimeCheckpointSource || '') === 'close_complete_checkpoint',
    'startup close-complete preferred owner run should normalize runtime checkpoint source to close_complete_checkpoint'
  );
  assert(
    String(startupCloseCompletePreferredOwnerRun.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome || '')
      === 'first_autonomous_insert_by_startup_close_complete_checkpoint',
    'startup close-complete preferred owner run should classify source-specific ownership as startup close-complete variant'
  );
  assert(
    startupCloseCompletePreferredOwnerRun.livePreferredOwnerNaturalWinEvent?.wasNewRowPersisted === true,
    'startup close-complete preferred owner run should persist natural-win row for startup close-complete source variant'
  );
  assert(
    startupCloseCompletePreferredOwnerRun.livePreferredOwnerPostCloseProofVerifierPass === true,
    'startup close-complete preferred owner run should pass verifier when canonical preferred-owner win evidence is present'
  );
  const startupCloseCompleteNaturalWinRowsAfterFirstRun = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_natural_wins
    WHERE target_trading_day = ?
  `).get(startupCloseCompletePreferredOwnerDate)?.c || 0);
  assert(
    startupCloseCompleteNaturalWinRowsAfterFirstRun === 1,
    'startup close-complete preferred owner run should persist exactly one natural-win row'
  );
  const startupCloseCompletePreferredOwnerReplayRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [startupCloseCompletePreferredOwnerDate]: buildSessionCandles(startupCloseCompletePreferredOwnerDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(startupCloseCompletePreferredOwnerDate, 1),
    nowTime: '08:45',
    mode: 'startup_catchup',
    force: false,
    finalizationOnly: true,
    checkpointTargetTradingDay: startupCloseCompletePreferredOwnerDate,
    runOrigin: 'natural',
    runtimeTriggered: true,
  });
  assert(
    startupCloseCompletePreferredOwnerReplayRun.livePreferredOwnerNaturalWinEvent?.wasNewRowPersisted !== true,
    'startup close-complete preferred owner replay should dedupe natural-win rows'
  );
  const startupCloseCompleteNaturalWinRowsAfterReplay = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_natural_wins
    WHERE target_trading_day = ?
  `).get(startupCloseCompletePreferredOwnerDate)?.c || 0);
  assert(
    startupCloseCompleteNaturalWinRowsAfterReplay === 1,
    'startup close-complete preferred owner replay should keep natural-win row deduped at one row'
  );

  const preferredOwnerConfirmRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [preferredOwnerDate]: buildSessionCandles(preferredOwnerDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(preferredOwnerDate, 1),
    nowTime: '08:40',
    mode: 'startup_catchup',
    force: false,
    finalizationOnly: true,
    checkpointTargetTradingDay: preferredOwnerDate,
  });
  assert(
    Number(preferredOwnerConfirmRun.liveAutonomousInsertionMetrics?.rolling5dAutonomousInsertDelivered || 0) >= 1,
    'follow-up runs should retain rolling autonomous delivered count from first autonomous owner insertion'
  );
  assert(
    String(preferredOwnerConfirmRun.livePreferredOwnerProof?.livePreferredOwnerActualSource || '') === 'close_complete_checkpoint',
    'follow-up runs should retain preferred owner proof actual source as close_complete_checkpoint'
  );
  assert(
    preferredOwnerConfirmRun.livePreferredOwnerProof?.livePreferredOwnerWon === true,
    'follow-up runs should retain preferred owner win truth from first-creator provenance'
  );
  const persistedPreferredVerifierRunId = Number(winVerifierRow?.run_id || 0);
  assert(
    persistedPreferredVerifierRunId > 0,
    'preferred-owner verifier row should persist run_id for canonical surface parity checks'
  );
  const postAuditFollowUpDay = addDays(preferredOwnerDate, 1);
  db.prepare(`
    INSERT INTO jarvis_daily_scoring_runs (
      run_date,
      mode,
      run_origin,
      window_days,
      contexts_seen,
      scored_rows,
      inserted_rows,
      updated_rows,
      status,
      error_message,
      details_json,
      created_at
    ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'noop', NULL, ?, ?)
  `).run(
    postAuditFollowUpDay,
    'startup_catchup',
    'manual',
    3,
    JSON.stringify({
      runOrigin: 'manual',
      liveCheckpoint: {
        targetTradingDay: postAuditFollowUpDay,
        checkpointStatus: 'waiting_valid',
        checkpointReason: 'waiting_for_session_close',
        runtimeCheckpointSource: 'startup_reconciliation',
      },
      livePreferredOwnerPostCloseProofVerifier: {
        targetTradingDay: postAuditFollowUpDay,
        runId: 999001,
        runOrigin: 'manual',
        runtimeSource: 'startup_reconciliation',
        checkpointStatus: 'waiting_valid',
        verifierStatus: 'fail',
        verifierPass: false,
        failureReasons: ['proof_row_missing'],
        verifiedAt: `${postAuditFollowUpDay}T09:00:00.000Z`,
      },
    }),
    `${postAuditFollowUpDay}T09:00:00.000Z`
  );
  const canonicalVerifierParityStatus = buildDailyScoringStatus({ db });
  assert(
    String(canonicalVerifierParityStatus.livePreferredOwnerPostCloseProofVerifierStatus || '') === 'pass',
    'canonical persisted verifier row should override later follow-up run-detail fail status'
  );
  assert(
    canonicalVerifierParityStatus.livePreferredOwnerPostCloseProofVerifierPass === true,
    'canonical persisted verifier row should override later follow-up run-detail fail pass flag'
  );
  assert(
    String(canonicalVerifierParityStatus.livePreferredOwnerPostCloseProofVerifierTargetTradingDay || '') === preferredOwnerDate,
    'canonical verifier target day should remain the latest audited natural resolved day'
  );
  assert(
    Number(canonicalVerifierParityStatus.livePreferredOwnerPostCloseProofVerifierRunId || 0) === persistedPreferredVerifierRunId,
    'canonical verifier run id should remain anchored to persisted verifier row'
  );
  assert(
    Array.isArray(canonicalVerifierParityStatus.livePreferredOwnerPostCloseProofVerifierFailureReasons)
      && canonicalVerifierParityStatus.livePreferredOwnerPostCloseProofVerifierFailureReasons.length === 0,
    'canonical persisted verifier pass should keep failure reasons empty'
  );

  const reservationExpiredDate = '2026-03-19';
  seedRecommendationContext(db, reservationExpiredDate);
  const reservationExpiredFallbackRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [reservationExpiredDate]: buildSessionCandles(reservationExpiredDate, 90),
    },
    windowDays: 3,
    nowDate: addDays(reservationExpiredDate, 1),
    nowTime: '10:30',
    mode: 'startup_catchup',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: reservationExpiredDate,
  });
  assert(
    String(reservationExpiredFallbackRun.liveCheckpoint?.runtimeCheckpointSource || '') === 'startup_reconciliation',
    'reservation-expired fallback run should use startup_reconciliation source'
  );
  const reservationExpiredState = String(
    reservationExpiredFallbackRun.livePreferredOwnerReservation?.livePreferredOwnerReservationState || ''
  );
  assert(
    reservationExpiredState === 'reservation_expired_without_preferred_owner'
      || reservationExpiredState === 'reservation_released_after_preferred_owner_loss',
    'reservation-expired fallback run should classify reservation as expired or released_after_preferred_owner_loss'
  );
  assert(
    reservationExpiredFallbackRun.livePreferredOwnerReservation?.livePreferredOwnerReservationActive === false,
    'reservation-expired fallback run should release preferred-owner reservation'
  );
  assert(
    Number(reservationExpiredFallbackRun.liveRowsInserted || 0) >= 1,
    'reservation-expired fallback run should allow startup fallback insert after reservation expiry'
  );

  const lateSuccessDate = '2026-03-10';
  seedRecommendationContext(db, lateSuccessDate);
  const lateSuccessRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [lateSuccessDate]: buildSessionCandles(lateSuccessDate, 90),
    },
    windowDays: 2,
    nowDate: addDays(lateSuccessDate, 2),
    nowTime: '11:30',
    mode: 'scheduled_live_finalization_morning_repair',
    force: true,
    finalizationOnly: true,
    liveBridgeLookbackDays: 10,
    checkpointTargetTradingDay: lateSuccessDate,
  });
  assert(String(lateSuccessRun.liveCheckpoint.checkpointStatus || '') === 'success_inserted', 'late success run should checkpoint as success_inserted');
  assert(lateSuccessRun.liveCheckpoint.checkpointPastDeadline === true, 'late success run should be past checkpoint deadline');
  assert(String(lateSuccessRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_success_late', 'late success run should classify SLA as success late');
  assert(Number(lateSuccessRun.liveInsertionSla?.liveInsertionSlaLateByMinutes || 0) > 0, 'late success run should report positive SLA lateByMinutes');

  const readyButNotAttemptedDate = '2026-03-03';
  seedRecommendationContext(db, readyButNotAttemptedDate);
  const readyButNotAttemptedRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [readyButNotAttemptedDate]: buildSessionCandles(readyButNotAttemptedDate, 90),
    },
    windowDays: 3,
    nowDate: '2026-03-11',
    mode: 'manual_post_close_checkpoint',
    force: false,
    finalizationOnly: true,
    liveBridgeLookbackDays: 3,
    checkpointTargetTradingDay: readyButNotAttemptedDate,
  });
  assert(String(readyButNotAttemptedRun.liveCheckpoint.closeCompleteReason || '') === 'close_data_complete', 'ready-but-not-attempted run should be close_data_complete');
  assert(String(readyButNotAttemptedRun.liveCheckpoint.checkpointStatus || '') === 'failure_scheduler_miss', 'ready-but-not-attempted run should surface checkpoint failure');
  assert(String(readyButNotAttemptedRun.liveCheckpoint.firstEligibleCycleFailureReason || '') === 'insert_not_attempted_when_ready', 'ready-but-not-attempted run should surface insert_not_attempted_when_ready');
  assert(Number(readyButNotAttemptedRun.liveCheckpoint.checkpointExpectedOutcomeCount || 0) === 1, 'ready-but-not-attempted run expected count should be 1');
  assert(Number(readyButNotAttemptedRun.liveCheckpoint.checkpointActualOutcomeCount || 0) === 0, 'ready-but-not-attempted run actual count should be 0');
  assert(Number(readyButNotAttemptedRun.liveCheckpoint.checkpointInsertDelta || 0) === -1, 'ready-but-not-attempted run insert delta should be -1');
  assert(readyButNotAttemptedRun.liveCheckpoint.runtimeCheckpointWasAutonomous === false, 'ready-but-not-attempted run should be non-autonomous manual path');
  assert(String(readyButNotAttemptedRun.liveCheckpoint.runtimeCheckpointOutcome || '') === 'failure_scheduler_miss', 'ready-but-not-attempted run should classify runtime outcome as failure_scheduler_miss');
  assert(readyButNotAttemptedRun.liveCheckpoint.runtimeCheckpointMissed === true, 'ready-but-not-attempted run should set runtimeCheckpointMissed');
  assert(['after_checkpoint_deadline', 'checkpoint_window_missed'].includes(String(readyButNotAttemptedRun.liveCheckpoint.runtimeCheckpointMissReason || '')), 'ready-but-not-attempted run should expose a bounded past-deadline miss reason');
  assert(readyButNotAttemptedRun.liveCheckpoint.checkpointPastDeadline === true, 'ready-but-not-attempted run should be past deadline');
  assert(Array.isArray(readyButNotAttemptedRun.latestCheckpointFailures) && readyButNotAttemptedRun.latestCheckpointFailures.length >= 1, 'ready-but-not-attempted run should expose checkpoint failures');
  assert(String(readyButNotAttemptedRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_missed', 'ready-but-not-attempted run should classify SLA as missed');
  assert(readyButNotAttemptedRun.liveAutonomousInsertReadiness?.autonomousInsertEligible === true, 'ready-but-not-attempted run should be autonomous insert eligible');
  assert(readyButNotAttemptedRun.liveAutonomousAttemptTransition?.attemptRequired === true, 'ready-but-not-attempted run should require attempt');
  assert(readyButNotAttemptedRun.liveAutonomousAttemptTransition?.attemptExecuted === false, 'ready-but-not-attempted run should keep attemptExecuted false');
  assert(String(readyButNotAttemptedRun.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_skipped_bug', 'ready-but-not-attempted run should classify attempt result as skipped bug');
  assert(String(readyButNotAttemptedRun.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_eligible_not_attempted_bug', 'ready-but-not-attempted run should classify autonomous proof as eligible_not_attempted_bug');
  assert(readyButNotAttemptedRun.liveAutonomousProof?.liveAutonomousProofAttempted === false, 'ready-but-not-attempted run should keep autonomous proof attempted false');

  const directEligibleTargetDay = '2026-03-20';
  const directEligibleCheckpoint = {
    targetTradingDay: directEligibleTargetDay,
    checkpointExpectedOutcomeCount: 1,
    runtimeCheckpointSource: 'close_complete_checkpoint',
    sweepSource: 'close_complete_checkpoint',
    firstEligibleCycleExpectedInsert: true,
    firstEligibleCycleInsertAttempted: false,
    liveOutcomeInsertedThisCheckpoint: false,
    liveOutcomeUpdatedThisCheckpoint: false,
  };
  const directEligibleReadiness = {
    targetTradingDay: directEligibleTargetDay,
    validTradingDay: true,
    liveContextPresent: true,
    closeComplete: true,
    requiredMarketDataPresent: true,
    firstRightSatisfied: true,
    existingLiveRowPresent: false,
    autonomousInsertEligible: true,
    autonomousInsertBlockReason: 'none',
    autonomousInsertNextTransition: 'attempt_insert_now',
  };
  const directSkippedContract = enforceEligibleAttemptOrBugContract({
    liveCheckpoint: directEligibleCheckpoint,
    liveAutonomousInsertReadiness: directEligibleReadiness,
    liveAutonomousProof: {
      liveAutonomousProofTargetTradingDay: directEligibleTargetDay,
      liveAutonomousProofOutcome: 'proof_attempted_failure',
      liveAutonomousProofEligible: true,
      liveAutonomousProofAttempted: false,
      liveAutonomousProofSucceeded: false,
      liveAutonomousProofFailureReason: 'none',
      advisoryOnly: true,
    },
    liveAutonomousAttemptTransition: {
      targetTradingDay: directEligibleTargetDay,
      eligibleAt: `${addDays(directEligibleTargetDay, 1)}T09:35:00.000Z`,
      attemptRequired: true,
      attemptExecuted: false,
      attemptExecutionPath: 'close_complete_checkpoint',
      attemptSkippedReason: null,
      existingRowDetectedAtAttemptTime: false,
      rowInsertedByThisAttempt: false,
      insertedRowId: null,
      attemptResult: 'attempt_not_required',
      advisoryOnly: true,
    },
  });
  assert(String(directSkippedContract.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_skipped_bug', 'eligible not-attempted contract should classify attempt as attempt_skipped_bug');
  assert(String(directSkippedContract.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_eligible_not_attempted_bug', 'eligible not-attempted contract should classify proof as proof_eligible_not_attempted_bug');

  const directFailureContract = enforceEligibleAttemptOrBugContract({
    liveCheckpoint: directEligibleCheckpoint,
    liveAutonomousInsertReadiness: directEligibleReadiness,
    liveAutonomousProof: {
      liveAutonomousProofTargetTradingDay: directEligibleTargetDay,
      liveAutonomousProofOutcome: 'proof_attempted_failure',
      liveAutonomousProofEligible: true,
      liveAutonomousProofAttempted: true,
      liveAutonomousProofSucceeded: false,
      liveAutonomousProofFailureReason: 'attempted_failure',
      advisoryOnly: true,
    },
    liveAutonomousAttemptTransition: {
      targetTradingDay: directEligibleTargetDay,
      eligibleAt: `${addDays(directEligibleTargetDay, 1)}T09:35:00.000Z`,
      attemptRequired: true,
      attemptExecuted: true,
      attemptExecutionPath: 'close_complete_checkpoint',
      attemptSkippedReason: 'attempted_failure',
      existingRowDetectedAtAttemptTime: false,
      rowInsertedByThisAttempt: false,
      insertedRowId: null,
      attemptResult: 'attempt_executed_failure',
      advisoryOnly: true,
    },
  });
  assert(String(directFailureContract.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_executed_failure', 'eligible attempted-failure contract should classify attempt as attempt_executed_failure');
  assert(String(directFailureContract.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_attempted_failure', 'eligible attempted-failure contract should classify proof as proof_attempted_failure');

  const directSuccessContract = enforceEligibleAttemptOrBugContract({
    liveCheckpoint: directEligibleCheckpoint,
    liveAutonomousInsertReadiness: directEligibleReadiness,
    liveAutonomousProof: {
      liveAutonomousProofTargetTradingDay: directEligibleTargetDay,
      liveAutonomousProofOutcome: 'proof_attempted_success',
      liveAutonomousProofEligible: true,
      liveAutonomousProofAttempted: true,
      liveAutonomousProofSucceeded: true,
      liveAutonomousProofFailureReason: 'none',
      advisoryOnly: true,
    },
    liveAutonomousAttemptTransition: {
      targetTradingDay: directEligibleTargetDay,
      eligibleAt: `${addDays(directEligibleTargetDay, 1)}T09:35:00.000Z`,
      attemptRequired: true,
      attemptExecuted: true,
      attemptExecutionPath: 'close_complete_checkpoint',
      attemptSkippedReason: null,
      existingRowDetectedAtAttemptTime: false,
      rowInsertedByThisAttempt: true,
      insertedRowId: 12345,
      attemptResult: 'attempt_executed_success',
      advisoryOnly: true,
    },
  });
  assert(String(directSuccessContract.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_executed_success', 'eligible attempted-success contract should classify attempt as attempt_executed_success');
  assert(String(directSuccessContract.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_attempted_success', 'eligible attempted-success contract should classify proof as proof_attempted_success');

  const bypassBugDate = '2026-03-24';
  seedRecommendationContext(db, bypassBugDate);
  const bypassBugReservation = buildLivePreferredOwnerReservation({
    db,
    nowDate: addDays(bypassBugDate, 1),
    nowTime: '08:30',
    mode: 'startup_catchup',
    sweepSource: 'startup_reconciliation',
    targetTradingDay: bypassBugDate,
    sessions: {
      [bypassBugDate]: buildSessionCandles(bypassBugDate, 90),
    },
    liveAutonomousFirstRight: {
      liveAutonomousFirstRightTargetTradingDay: bypassBugDate,
      liveAutonomousFirstRightWindowOpenedAt: `${bypassBugDate} 16:05 America/New_York`,
      liveAutonomousFirstRightWindowExpiresAt: `${addDays(bypassBugDate, 1)} 09:45 America/New_York`,
      liveAutonomousFirstRightWindowState: 'autonomous_window_open',
      liveAutonomousFirstRightActive: true,
      liveAutonomousFirstRightReservedForSource: 'close_complete_checkpoint',
    },
    liveCheckpoint: {
      targetTradingDay: bypassBugDate,
      liveOutcomeInsertedThisCheckpoint: true,
      checkpointCompletedAt: `${addDays(bypassBugDate, 1)}T08:30:00.000Z`,
    },
    liveInsertionOwnership: {
      liveInsertionOwnershipTargetTradingDay: bypassBugDate,
      liveInsertionOwnershipCurrentRunCreatedRow: true,
    },
  });
  assert(
    String(bypassBugReservation.livePreferredOwnerReservationState || '') === 'reservation_bypassed_bug',
    'bypass-bug reservation should classify as reservation_bypassed_bug'
  );
  assert(
    String(bypassBugReservation.livePreferredOwnerReservationBlockReason || '') === 'reservation_should_have_blocked_but_did_not',
    'bypass-bug reservation should use reservation_should_have_blocked_but_did_not block reason'
  );

  const blockedExistingTargetDay = '2026-03-21';
  const blockedExistingCheckpoint = {
    targetTradingDay: blockedExistingTargetDay,
    checkpointExpectedOutcomeCount: 1,
    runtimeCheckpointSource: 'close_complete_checkpoint',
    sweepSource: 'close_complete_checkpoint',
    firstEligibleCycleExpectedInsert: false,
    firstEligibleCycleInsertAttempted: false,
    liveOutcomeInsertedThisCheckpoint: false,
    liveOutcomeUpdatedThisCheckpoint: false,
    liveOutcomeExists: true,
    runtimeCheckpointWasAutonomous: true,
  };
  const blockedExistingOwnership = {
    liveInsertionOwnershipTargetTradingDay: blockedExistingTargetDay,
    liveInsertionOwnershipScope: 'target_day',
    liveInsertionOwnershipOutcome: 'already_inserted_by_prior_autonomous_run',
    liveInsertionOwnershipCurrentRunWasFirstCreator: false,
    liveInsertionOwnershipCurrentRunCreatedRowId: null,
  };
  const blockedExistingFirstRight = {
    liveAutonomousFirstRightTargetTradingDay: blockedExistingTargetDay,
    liveAutonomousFirstRightReservedForSource: 'close_complete_checkpoint',
    liveAutonomousFirstRightOutcome: 'autonomous_first_right_reserved',
    liveAutonomousFirstRightActive: true,
  };
  const blockedExistingInvariant = {
    liveTargetDayOwnershipConsistent: true,
    liveTargetDayOwnershipMismatchReason: 'no_mismatch',
    advisoryOnly: true,
  };
  const blockedExistingReadiness = {
    targetTradingDay: blockedExistingTargetDay,
    validTradingDay: true,
    liveContextPresent: true,
    closeComplete: true,
    requiredMarketDataPresent: true,
    firstRightSatisfied: true,
    existingLiveRowPresent: true,
    autonomousInsertEligible: false,
    autonomousInsertBlockReason: 'existing_row_present',
    autonomousInsertNextTransition: 'no_action_existing_row',
    advisoryOnly: true,
  };
  const blockedExistingProof = {
    liveAutonomousProofTargetTradingDay: blockedExistingTargetDay,
    liveAutonomousProofOutcome: 'proof_blocked_existing_row',
    liveAutonomousProofEligible: false,
    liveAutonomousProofAttempted: false,
    liveAutonomousProofSucceeded: false,
    liveAutonomousProofFailureReason: 'blocked_existing_row',
    advisoryOnly: true,
  };
  const blockedExistingTransition = buildLiveAutonomousAttemptTransition({
    liveCheckpoint: blockedExistingCheckpoint,
    liveInsertionOwnership: blockedExistingOwnership,
    liveAutonomousFirstRight: blockedExistingFirstRight,
    liveTargetDayOwnershipInvariant: blockedExistingInvariant,
    liveAutonomousInsertReadiness: blockedExistingReadiness,
    liveAutonomousProof: blockedExistingProof,
  });
  assert(String(blockedExistingTransition.attemptResult || '') === 'attempt_blocked_existing_row', 'eligible state with existing row should classify attempt as attempt_blocked_existing_row');
  assert(String(blockedExistingProof.liveAutonomousProofOutcome || '') === 'proof_blocked_existing_row', 'eligible state with existing row should classify proof as proof_blocked_existing_row');
  const blockedExistingContract = enforceEligibleAttemptOrBugContract({
    liveCheckpoint: blockedExistingCheckpoint,
    liveAutonomousInsertReadiness: blockedExistingReadiness,
    liveAutonomousProof: blockedExistingProof,
    liveAutonomousAttemptTransition: blockedExistingTransition,
  });
  assert(String(blockedExistingContract.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_blocked_existing_row', 'blocked-existing contract should preserve attempt_blocked_existing_row');
  assert(String(blockedExistingContract.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_blocked_existing_row', 'blocked-existing contract should preserve proof_blocked_existing_row');

  const blockedInvalidDayRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      '2026-03-07': [],
    },
    windowDays: 2,
    nowDate: '2026-03-07',
    mode: 'unit_test_blocked_weekend',
    force: true,
    finalizationOnly: true,
    checkpointTargetTradingDay: '2026-03-07',
  });
  assert(blockedInvalidDayRun.liveCheckpoint && typeof blockedInvalidDayRun.liveCheckpoint === 'object', 'blocked invalid day run missing liveCheckpoint');
  assert(String(blockedInvalidDayRun.liveCheckpoint.checkpointStatus || '') === 'blocked_invalid_day', 'weekend checkpoint should be blocked_invalid_day');
  assert(String(blockedInvalidDayRun.liveCheckpoint.checkpointReason || '') === 'blocked_non_trading_day', 'weekend checkpoint should report blocked_non_trading_day');
  assert(String(blockedInvalidDayRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_blocked_invalid_day', 'weekend checkpoint should classify SLA as blocked invalid day');

  const missingContextDate = '2026-03-11';
  const missingContextRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [missingContextDate]: buildSessionCandles(missingContextDate, 90),
    },
    windowDays: 2,
    nowDate: addDays(missingContextDate, 1),
    nowTime: '09:10',
    mode: 'manual_post_close_checkpoint',
    force: false,
    finalizationOnly: true,
    checkpointTargetTradingDay: missingContextDate,
  });
  assert(String(missingContextRun.liveCheckpoint.checkpointStatus || '') === 'failure_missing_context', 'missing context run should checkpoint as failure_missing_context');
  assert(String(missingContextRun.liveInsertionSla?.liveInsertionSlaOutcome || '') === 'insert_required_missing_context', 'missing context run should classify SLA as missing context');

  const missedSchedulerRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [thinCloseDate]: buildSessionCandles(thinCloseDate, 4),
    },
    windowDays: 3,
    nowDate: addDays(thinCloseDate, 3),
    nowTime: '10:30',
    mode: 'scheduled_live_finalization_morning_repair',
    force: true,
    finalizationOnly: true,
    liveBridgeLookbackDays: 10,
    checkpointTargetTradingDay: thinCloseDate,
  });
  assert(missedSchedulerRun.liveCheckpoint && typeof missedSchedulerRun.liveCheckpoint === 'object', 'missed scheduler run missing liveCheckpoint');
  assert(String(missedSchedulerRun.liveCheckpoint.checkpointStatus || '') === 'failure_scheduler_miss', 'next-morning unresolved waiting should checkpoint as failure_scheduler_miss');
  assert(String(missedSchedulerRun.liveCheckpoint.failureReason || '') === 'unresolved_wait_past_deadline', 'next-morning unresolved waiting should report unresolved_wait_past_deadline');
  assert(missedSchedulerRun.liveCheckpoint.runtimeCheckpointWasAutonomous === true, 'missed scheduler run should be autonomous');
  assert(String(missedSchedulerRun.liveCheckpoint.runtimeCheckpointOutcome || '') === 'failure_scheduler_miss', 'missed scheduler run should classify runtime outcome as failure_scheduler_miss');
  assert(missedSchedulerRun.liveCheckpoint.runtimeCheckpointMissed === true, 'missed scheduler run should set runtimeCheckpointMissed');
  assert(['after_checkpoint_deadline', 'checkpoint_window_missed'].includes(String(missedSchedulerRun.liveCheckpoint.runtimeCheckpointMissReason || '')), 'missed scheduler run should expose a bounded past-deadline miss reason');
  assert(missedSchedulerRun.liveCheckpoint.checkpointPastDeadline === true, 'missed scheduler run should be past deadline');
  assert(Number(missedSchedulerRun.missedValidCheckpointDaysCount || 0) >= 1, 'missed scheduler run should increment missedValidCheckpointDaysCount');
  assert(Array.isArray(missedSchedulerRun.latestMissedCheckpointDates) && missedSchedulerRun.latestMissedCheckpointDates.length >= 1, 'missed scheduler run should expose latestMissedCheckpointDates');

  const lookbackDate = '2026-02-25';
  seedRecommendationContext(db, lookbackDate);
  const lookbackRecovery = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [lookbackDate]: buildSessionCandles(lookbackDate, 90),
    },
    windowDays: 1,
    nowDate: '2026-03-11',
    mode: 'unit_test_lookback_recovery',
    force: true,
    finalizationOnly: true,
    liveBridgeLookbackDays: 20,
  });
  assert(Number(lookbackRecovery.contextsSeen || 0) >= 1, 'lookback recovery run should evaluate at least one context');
  assert(Number(lookbackRecovery.liveRowsInserted || 0) >= 1, 'lookback recovery should finalize unresolved historical live day');

  const weekendClass = classifyTradingDay({
    date: '2026-03-07',
    sessionForDate: [],
  });
  assert(weekendClass.classification === 'non_trading_day', 'weekend should classify as non_trading_day');
  const holidayClass = classifyTradingDay({
    date: '2026-12-25',
    sessionForDate: [],
  });
  assert(holidayClass.classification === 'non_trading_day', 'US holiday should classify as non_trading_day');
  const invalidMappingClass = classifyTradingDay({
    date: '2026-03-07',
    sessionForDate: buildSessionCandles('2026-03-07', 5),
  });
  assert(invalidMappingClass.classification === 'invalid_mapping', 'weekend with session data should classify as invalid_mapping');

  const readyState = evaluateLiveFinalizationReadiness({
    date: '2026-03-06',
    nowDate: '2026-03-07',
    contextRow: { context_json: JSON.stringify({ nowEt: { date: '2026-03-06', time: '09:25' } }) },
    sessionForDate: buildSessionCandles('2026-03-06', 90),
  });
  assert(readyState.state === 'ready_to_finalize', 'completed prior valid day should be ready_to_finalize');
  const waitingState = evaluateLiveFinalizationReadiness({
    date: '2026-03-11',
    nowDate: '2026-03-11',
    contextRow: { context_json: JSON.stringify({ nowEt: { date: '2026-03-11', time: '09:25' } }) },
    sessionForDate: buildSessionCandles('2026-03-11', 4),
  });
  assert(waitingState.state === 'awaiting_session_close', 'incomplete same-day session should be awaiting_session_close');

  const targetDayWaitingDate = '2026-03-16';
  seedRecommendationContext(db, targetDayWaitingDate);
  const targetDayWaitingRun = runAutomaticDailyScoring({
    db,
    sessions: {
      ...sessions,
      [targetDayWaitingDate]: buildSessionCandles(targetDayWaitingDate, 4),
    },
    windowDays: 2,
    nowDate: targetDayWaitingDate,
    nowTime: '14:00',
    mode: 'scheduled_live_finalization_close_complete',
    force: false,
    finalizationOnly: true,
    checkpointTargetTradingDay: targetDayWaitingDate,
  });
  assert(String(targetDayWaitingRun.liveCheckpoint.checkpointStatus || '') === 'waiting_valid', 'target-day waiting run should checkpoint as waiting_valid');
  assert(Number(targetDayWaitingRun.liveCheckpoint.checkpointActualOutcomeCount || 0) === 0, 'target-day waiting run should keep checkpointActualOutcomeCount at 0');
  assert(String(targetDayWaitingRun.liveInsertionOwnership?.liveInsertionOwnershipOutcome || '') === 'target_day_not_inserted_yet', 'target-day waiting run should classify ownership as target_day_not_inserted_yet');
  assert(String(targetDayWaitingRun.liveInsertionOwnership?.liveInsertionOwnershipScope || '') === 'target_day', 'target-day waiting run should keep ownership scope target_day');
  assert(targetDayWaitingRun.liveTargetDayOwnershipInvariant?.liveTargetDayOwnershipConsistent === true, 'target-day waiting run should keep target-day ownership invariant consistent');
  assert(String(targetDayWaitingRun.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_waiting_for_close', 'target-day waiting run should classify autonomous proof as waiting for close');
  assert(targetDayWaitingRun.liveAutonomousInsertReadiness?.autonomousInsertEligible === false, 'target-day waiting run should not yet be autonomous insert eligible');
  assert(String(targetDayWaitingRun.liveAutonomousInsertReadiness?.autonomousInsertBlockReason || '') === 'waiting_for_close', 'target-day waiting run should block on waiting_for_close');
  assert(String(targetDayWaitingRun.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_waiting_for_close', 'target-day waiting run should classify attempt result as waiting for close');
  assert(targetDayWaitingRun.liveAutonomousAttemptTransition?.attemptRequired === false, 'target-day waiting run should not require attempt while waiting');
  assert(targetDayWaitingRun.liveAutonomousAttemptTransition?.attemptExecuted === false, 'target-day waiting run should not execute attempt while waiting');

  const status = buildDailyScoringStatus({ db });
  assert(status && typeof status === 'object', 'daily scoring status missing');
  assert(status.advisoryOnly === true, 'daily scoring status must be advisoryOnly');
  assert(status.latestRun && typeof status.latestRun === 'object', 'latestRun missing from daily scoring status');
  assert(status.liveEvidenceGeneration && typeof status.liveEvidenceGeneration === 'object', 'liveEvidenceGeneration missing from daily scoring status');
  assert(Number.isFinite(Number(status.liveEvidenceGeneration.liveContextsSeen)), 'liveEvidenceGeneration.liveContextsSeen missing');
  assert(status.liveEvidenceGeneration.liveSkipReasonBuckets && typeof status.liveEvidenceGeneration.liveSkipReasonBuckets === 'object', 'liveEvidenceGeneration.liveSkipReasonBuckets missing');
  assert(status.liveEvidenceGeneration.liveEligibilityReasonBuckets && typeof status.liveEvidenceGeneration.liveEligibilityReasonBuckets === 'object', 'liveEvidenceGeneration.liveEligibilityReasonBuckets missing');
  assert(Array.isArray(status.liveEvidenceGeneration.latestLiveContextsWithoutFreshInsertDates), 'latestLiveContextsWithoutFreshInsertDates missing');
  assert(status.liveDayConversion && typeof status.liveDayConversion === 'object', 'liveDayConversion missing from status');
  assert(status.liveDayConversion.advisoryOnly === true, 'liveDayConversion should be advisoryOnly');
  assert(status.liveOutcomeFinalization && typeof status.liveOutcomeFinalization === 'object', 'liveOutcomeFinalization missing from status');
  assert(status.liveOutcomeFinalization.advisoryOnly === true, 'liveOutcomeFinalization should be advisoryOnly');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.pendingLiveContextsCount)), 'liveOutcomeFinalization.pendingLiveContextsCount missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.netNewLiveRows.oneDay)), 'liveOutcomeFinalization.netNewLiveRows.oneDay missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysSeen)), 'liveOutcomeFinalization.validLiveDaysSeen missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysReadyToFinalize)), 'liveOutcomeFinalization.validLiveDaysReadyToFinalize missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysFinalizedInserted)), 'liveOutcomeFinalization.validLiveDaysFinalizedInserted missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysFinalizedUpdated)), 'liveOutcomeFinalization.validLiveDaysFinalizedUpdated missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysStillWaiting)), 'liveOutcomeFinalization.validLiveDaysStillWaiting missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysBlocked)), 'liveOutcomeFinalization.validLiveDaysBlocked missing');
  assert(Array.isArray(status.liveOutcomeFinalization.latestReadyButUninsertedDates), 'liveOutcomeFinalization.latestReadyButUninsertedDates missing');
  assert(Array.isArray(status.liveOutcomeFinalization.latestWaitingDates), 'liveOutcomeFinalization.latestWaitingDates missing');
  assert(Array.isArray(status.liveOutcomeFinalization.latestBlockedDates), 'liveOutcomeFinalization.latestBlockedDates missing');
  assert(status.liveOutcomeFinalization.readinessStateBuckets && typeof status.liveOutcomeFinalization.readinessStateBuckets === 'object', 'liveOutcomeFinalization.readinessStateBuckets missing');
  assert(status.liveOutcomeFinalization.tradingDayClassificationBuckets && typeof status.liveOutcomeFinalization.tradingDayClassificationBuckets === 'object', 'liveOutcomeFinalization.tradingDayClassificationBuckets missing');
  assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(status.liveOutcomeFinalization.latestSweepSource || '')), 'liveOutcomeFinalization.latestSweepSource must stay bounded');
  assert(status.liveOutcomeFinalization.finalizationSweepSourceBuckets && typeof status.liveOutcomeFinalization.finalizationSweepSourceBuckets === 'object', 'liveOutcomeFinalization.finalizationSweepSourceBuckets missing');
  assert(Number.isFinite(Number(status.liveOutcomeFinalization.validLiveDaysMissedByScheduler)), 'liveOutcomeFinalization.validLiveDaysMissedByScheduler missing');
  assert(status.liveCheckpoint && typeof status.liveCheckpoint === 'object', 'status.liveCheckpoint missing');
  assert(status.liveCheckpoint.advisoryOnly === true, 'status.liveCheckpoint should be advisoryOnly');
  assert(LIVE_CHECKPOINT_STATUS_ENUM.includes(String(status.liveCheckpoint.checkpointStatus || '')), 'status.liveCheckpoint.checkpointStatus invalid');
  assert(LIVE_CHECKPOINT_REASON_ENUM.includes(String(status.liveCheckpoint.checkpointReason || '')), 'status.liveCheckpoint.checkpointReason invalid');
  assert(CLOSE_COMPLETE_REASON_ENUM.includes(String(status.liveCheckpoint.closeCompleteReason || '')), 'status.liveCheckpoint.closeCompleteReason invalid');
  assert(CLOSE_COMPLETE_REASON_ENUM.includes(String(status.liveCheckpoint.closeCheckpointEligibilityReason || '')), 'status.liveCheckpoint.closeCheckpointEligibilityReason invalid');
  assert(typeof status.liveCheckpoint.closeComplete === 'boolean', 'status.liveCheckpoint.closeComplete missing');
  assert(typeof status.liveCheckpoint.requiredCloseDataPresent === 'boolean', 'status.liveCheckpoint.requiredCloseDataPresent missing');
  assert(typeof status.liveCheckpoint.requiredCloseBarsPresent === 'boolean', 'status.liveCheckpoint.requiredCloseBarsPresent missing');
  assert(typeof status.liveCheckpoint.closeCheckpointEligible === 'boolean', 'status.liveCheckpoint.closeCheckpointEligible missing');
  assert(typeof status.liveCheckpoint.firstEligibleCycleExpectedInsert === 'boolean', 'status.liveCheckpoint.firstEligibleCycleExpectedInsert missing');
  assert(typeof status.liveCheckpoint.firstEligibleCycleInsertAttempted === 'boolean', 'status.liveCheckpoint.firstEligibleCycleInsertAttempted missing');
  assert(typeof status.liveCheckpoint.firstEligibleCycleInsertSucceeded === 'boolean', 'status.liveCheckpoint.firstEligibleCycleInsertSucceeded missing');
  if (status.liveCheckpoint.firstEligibleCycleFailureReason) {
    assert(
      FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_ENUM.includes(String(status.liveCheckpoint.firstEligibleCycleFailureReason || '')),
      'status.liveCheckpoint.firstEligibleCycleFailureReason invalid'
    );
  }
  assert(Number.isFinite(Number(status.liveCheckpoint.checkpointExpectedOutcomeCount)), 'status.liveCheckpoint.checkpointExpectedOutcomeCount missing');
  assert(Number.isFinite(Number(status.liveCheckpoint.checkpointActualOutcomeCount)), 'status.liveCheckpoint.checkpointActualOutcomeCount missing');
  assert(Number.isFinite(Number(status.liveCheckpoint.checkpointInsertDelta)), 'status.liveCheckpoint.checkpointInsertDelta missing');
  assert(Number.isFinite(Number(status.liveCheckpoint.checkpointDuplicateCount)), 'status.liveCheckpoint.checkpointDuplicateCount missing');
  assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(status.liveCheckpoint.checkpointWindowReason || '')), 'status.liveCheckpoint.checkpointWindowReason invalid');
  assert(typeof status.liveCheckpoint.checkpointWithinAllowedWindow === 'boolean', 'status.liveCheckpoint.checkpointWithinAllowedWindow missing');
  assert(typeof status.liveCheckpoint.checkpointPastDeadline === 'boolean', 'status.liveCheckpoint.checkpointPastDeadline missing');
  assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(status.liveCheckpoint.runtimeCheckpointOutcome || '')), 'status.liveCheckpoint.runtimeCheckpointOutcome invalid');
  assert(typeof status.liveCheckpoint.runtimeCheckpointTriggered === 'boolean', 'status.liveCheckpoint.runtimeCheckpointTriggered missing');
  assert(typeof status.liveCheckpoint.runtimeCheckpointWasAutonomous === 'boolean', 'status.liveCheckpoint.runtimeCheckpointWasAutonomous missing');
  assert(typeof status.liveCheckpoint.runtimeCheckpointMissed === 'boolean', 'status.liveCheckpoint.runtimeCheckpointMissed missing');
  if (status.liveCheckpoint.runtimeCheckpointMissReason) {
    assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(status.liveCheckpoint.runtimeCheckpointMissReason || '')), 'status.liveCheckpoint.runtimeCheckpointMissReason invalid');
  }
  assert(Array.isArray(status.liveCheckpoint.latestMissedCheckpointDates), 'status.liveCheckpoint.latestMissedCheckpointDates missing');
  assert(Array.isArray(status.liveCheckpoint.latestCheckpointFailures), 'status.liveCheckpoint.latestCheckpointFailures missing');
  assert(Number.isFinite(Number(status.liveCheckpoint.checkpointFailureCount)), 'status.liveCheckpoint.checkpointFailureCount missing');
  if (status.liveCheckpoint.awaitingReason) {
    assert(LIVE_CHECKPOINT_AWAITING_REASON_ENUM.includes(String(status.liveCheckpoint.awaitingReason || '')), 'status.liveCheckpoint.awaitingReason invalid');
  }
  if (status.liveCheckpoint.failureReason) {
    assert(LIVE_CHECKPOINT_FAILURE_REASON_ENUM.includes(String(status.liveCheckpoint.failureReason || '')), 'status.liveCheckpoint.failureReason invalid');
  }
  assert(status.liveInsertionSla && typeof status.liveInsertionSla === 'object', 'status.liveInsertionSla missing');
  assert(status.liveInsertionSla.advisoryOnly === true, 'status.liveInsertionSla should be advisoryOnly');
  assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(status.liveInsertionSla.liveInsertionSlaOutcome || '')), 'status.liveInsertionSla.liveInsertionSlaOutcome invalid');
  assert(typeof status.liveInsertionSla.liveInsertionSlaRequired === 'boolean', 'status.liveInsertionSla.liveInsertionSlaRequired missing');
  assert(typeof status.liveInsertionSla.liveInsertionSlaNetNewRowCreated === 'boolean', 'status.liveInsertionSla.liveInsertionSlaNetNewRowCreated missing');
  assert(Number.isFinite(Number(status.liveInsertionSla.liveInsertionSlaLateByMinutes)), 'status.liveInsertionSla.liveInsertionSlaLateByMinutes missing');
  assert(status.liveInsertionGrowth && typeof status.liveInsertionGrowth === 'object', 'status.liveInsertionGrowth missing');
  assert(status.liveInsertionGrowth.advisoryOnly === true, 'status.liveInsertionGrowth should be advisoryOnly');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.liveNetNewRequiredToday)), 'status.liveInsertionGrowth.liveNetNewRequiredToday missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.liveNetNewDeliveredToday)), 'status.liveInsertionGrowth.liveNetNewDeliveredToday missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.liveNetNewMissedToday)), 'status.liveInsertionGrowth.liveNetNewMissedToday missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.liveNetNewLateToday)), 'status.liveInsertionGrowth.liveNetNewLateToday missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.consecutiveValidDaysWithOnTimeInsert)), 'status.liveInsertionGrowth.consecutiveValidDaysWithOnTimeInsert missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.consecutiveValidDaysMissed)), 'status.liveInsertionGrowth.consecutiveValidDaysMissed missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dValidDays)), 'status.liveInsertionGrowth.rolling5dValidDays missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dRequiredInserts)), 'status.liveInsertionGrowth.rolling5dRequiredInserts missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dOnTimeInserts)), 'status.liveInsertionGrowth.rolling5dOnTimeInserts missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dLateInserts)), 'status.liveInsertionGrowth.rolling5dLateInserts missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dMissedInserts)), 'status.liveInsertionGrowth.rolling5dMissedInserts missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dAlreadyFinalized)), 'status.liveInsertionGrowth.rolling5dAlreadyFinalized missing');
  assert(Number.isFinite(Number(status.liveInsertionGrowth.rolling5dOnTimeRatePct)), 'status.liveInsertionGrowth.rolling5dOnTimeRatePct missing');
  assert(status.liveInsertionOwnership && typeof status.liveInsertionOwnership === 'object', 'status.liveInsertionOwnership missing');
  assert(status.liveInsertionOwnership.advisoryOnly === true, 'status.liveInsertionOwnership should be advisoryOnly');
  assert(
    LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(status.liveInsertionOwnership.liveInsertionOwnershipOutcome || '')),
    'status.liveInsertionOwnership.liveInsertionOwnershipOutcome invalid'
  );
  assert(
    LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(status.liveInsertionOwnership.liveInsertionOwnershipScope || '')),
    'status.liveInsertionOwnership.liveInsertionOwnershipScope invalid'
  );
  assert(
    LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
      String(status.liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || '')
    ),
    'status.liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome invalid'
  );
  assert(typeof status.liveInsertionOwnership.liveInsertionOwnershipFirstInsertedAutonomous === 'boolean', 'status.liveInsertionOwnership.liveInsertionOwnershipFirstInsertedAutonomous missing');
  assert(typeof status.liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator === 'boolean', 'status.liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator missing');
  assert(typeof status.liveInsertionOwnership.liveOwnershipConsistencyOk === 'boolean', 'status.liveInsertionOwnership.liveOwnershipConsistencyOk missing');
  assert(status.liveTargetDayOwnershipInvariant && typeof status.liveTargetDayOwnershipInvariant === 'object', 'status.liveTargetDayOwnershipInvariant missing');
  assert(typeof status.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent === 'boolean', 'status.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent missing');
  assert(
    LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(status.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipMismatchReason || '')),
    'status.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipMismatchReason invalid'
  );
  assert(typeof status.liveTargetDayOwnershipConsistent === 'boolean', 'status.liveTargetDayOwnershipConsistent missing');
  assert(
    LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(status.liveTargetDayOwnershipMismatchReason || '')),
    'status.liveTargetDayOwnershipMismatchReason invalid'
  );
  assert(status.liveAutonomousInsertReadiness && typeof status.liveAutonomousInsertReadiness === 'object', 'status.liveAutonomousInsertReadiness missing');
  assert(typeof status.liveAutonomousInsertReadiness.validTradingDay === 'boolean', 'status.liveAutonomousInsertReadiness.validTradingDay missing');
  assert(typeof status.liveAutonomousInsertReadiness.liveContextPresent === 'boolean', 'status.liveAutonomousInsertReadiness.liveContextPresent missing');
  assert(typeof status.liveAutonomousInsertReadiness.closeComplete === 'boolean', 'status.liveAutonomousInsertReadiness.closeComplete missing');
  assert(typeof status.liveAutonomousInsertReadiness.requiredMarketDataPresent === 'boolean', 'status.liveAutonomousInsertReadiness.requiredMarketDataPresent missing');
  assert(typeof status.liveAutonomousInsertReadiness.firstRightSatisfied === 'boolean', 'status.liveAutonomousInsertReadiness.firstRightSatisfied missing');
  assert(typeof status.liveAutonomousInsertReadiness.existingLiveRowPresent === 'boolean', 'status.liveAutonomousInsertReadiness.existingLiveRowPresent missing');
  assert(typeof status.liveAutonomousInsertReadiness.autonomousInsertEligible === 'boolean', 'status.liveAutonomousInsertReadiness.autonomousInsertEligible missing');
  assert(
    LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(status.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')),
    'status.liveAutonomousInsertReadiness.autonomousInsertBlockReason invalid'
  );
  assert(
    LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(status.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')),
    'status.liveAutonomousInsertReadiness.autonomousInsertNextTransition invalid'
  );
  assert(status.liveAutonomousAttemptTransition && typeof status.liveAutonomousAttemptTransition === 'object', 'status.liveAutonomousAttemptTransition missing');
  assert(typeof status.liveAutonomousAttemptTransition.attemptRequired === 'boolean', 'status.liveAutonomousAttemptTransition.attemptRequired missing');
  assert(typeof status.liveAutonomousAttemptTransition.attemptExecuted === 'boolean', 'status.liveAutonomousAttemptTransition.attemptExecuted missing');
  assert(typeof status.liveAutonomousAttemptTransition.existingRowDetectedAtAttemptTime === 'boolean', 'status.liveAutonomousAttemptTransition.existingRowDetectedAtAttemptTime missing');
  assert(typeof status.liveAutonomousAttemptTransition.rowInsertedByThisAttempt === 'boolean', 'status.liveAutonomousAttemptTransition.rowInsertedByThisAttempt missing');
  assert(
    LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(status.liveAutonomousAttemptTransition.attemptResult || '')),
    'status.liveAutonomousAttemptTransition.attemptResult invalid'
  );
  assert(
    LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(status.liveAutonomousAttemptResult || '')),
    'status.liveAutonomousAttemptResult invalid'
  );
  assert(typeof status.liveAutonomousAttemptRequired === 'boolean', 'status.liveAutonomousAttemptRequired missing');
  assert(typeof status.liveAutonomousAttemptExecuted === 'boolean', 'status.liveAutonomousAttemptExecuted missing');
  assert(typeof status.liveAutonomousAttemptRowInsertedByThisAttempt === 'boolean', 'status.liveAutonomousAttemptRowInsertedByThisAttempt missing');
  if (
    status.liveAutonomousInsertReadiness.autonomousInsertEligible === true
    && status.liveAutonomousInsertReadiness.existingLiveRowPresent !== true
    && Number(status.liveCheckpoint?.checkpointExpectedOutcomeCount || status.checkpointExpectedOutcomeCount || 0) === 1
  ) {
    assert(
      status.liveAutonomousProofAttempted === true
      || String(status.liveAutonomousProofOutcome || '') === 'proof_eligible_not_attempted_bug',
      'eligible no-row expected=1 must be attempt-or-bug'
    );
  }
  assert(
    LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(status.liveAutonomousProofOutcome || '')),
    'status.liveAutonomousProofOutcome invalid'
  );
  assert(status.liveAutonomousProof && typeof status.liveAutonomousProof === 'object', 'status.liveAutonomousProof missing');
  assert(
    LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(status.liveAutonomousProof.liveAutonomousProofOutcome || '')),
    'status.liveAutonomousProof.liveAutonomousProofOutcome invalid'
  );
  assert(typeof status.liveAutonomousProof.liveAutonomousProofEligible === 'boolean', 'status.liveAutonomousProof.liveAutonomousProofEligible missing');
  assert(typeof status.liveAutonomousProof.liveAutonomousProofAttempted === 'boolean', 'status.liveAutonomousProof.liveAutonomousProofAttempted missing');
  assert(typeof status.liveAutonomousProof.liveAutonomousProofSucceeded === 'boolean', 'status.liveAutonomousProof.liveAutonomousProofSucceeded missing');
  assert(
    LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(status.liveAutonomousProof.liveAutonomousProofFailureReason || '')),
    'status.liveAutonomousProof.liveAutonomousProofFailureReason invalid'
  );
  assert(typeof status.liveAutonomousProofEligible === 'boolean', 'status.liveAutonomousProofEligible missing');
  assert(typeof status.liveAutonomousProofAttempted === 'boolean', 'status.liveAutonomousProofAttempted missing');
  assert(typeof status.liveAutonomousProofSucceeded === 'boolean', 'status.liveAutonomousProofSucceeded missing');
  assert(
    LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(status.liveAutonomousProofFailureReason || '')),
    'status.liveAutonomousProofFailureReason invalid'
  );
  assert(status.liveAutonomousFirstRight && typeof status.liveAutonomousFirstRight === 'object', 'status.liveAutonomousFirstRight missing');
  assert(status.liveAutonomousFirstRight.advisoryOnly === true, 'status.liveAutonomousFirstRight should be advisoryOnly');
  assert(
    LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(status.liveAutonomousFirstRight.liveAutonomousFirstRightOutcome || '')),
    'status.liveAutonomousFirstRight.liveAutonomousFirstRightOutcome invalid'
  );
  assert(
    LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(status.liveAutonomousFirstRight.liveAutonomousFirstRightWindowState || '')),
    'status.liveAutonomousFirstRight.liveAutonomousFirstRightWindowState invalid'
  );
  assert(typeof status.liveAutonomousFirstRight.liveAutonomousFirstRightActive === 'boolean', 'status.liveAutonomousFirstRight.liveAutonomousFirstRightActive missing');
  assert(typeof status.liveAutonomousFirstRight.liveManualInsertDeferred === 'boolean', 'status.liveAutonomousFirstRight.liveManualInsertDeferred missing');
  assert(typeof status.liveAutonomousFirstRight.liveOwnershipConsistencyOk === 'boolean', 'status.liveAutonomousFirstRight.liveOwnershipConsistencyOk missing');
  assert(typeof status.liveOwnershipConsistencyOk === 'boolean', 'status.liveOwnershipConsistencyOk missing');
  assert(status.liveAutonomousInsertionMetrics && typeof status.liveAutonomousInsertionMetrics === 'object', 'status.liveAutonomousInsertionMetrics missing');
  assert(status.liveAutonomousInsertionMetrics.advisoryOnly === true, 'status.liveAutonomousInsertionMetrics should be advisoryOnly');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.liveAutonomousInsertRequiredToday)), 'status.liveAutonomousInsertionMetrics.liveAutonomousInsertRequiredToday missing');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.liveAutonomousInsertDeliveredToday)), 'status.liveAutonomousInsertionMetrics.liveAutonomousInsertDeliveredToday missing');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.liveAutonomousInsertMissedToday)), 'status.liveAutonomousInsertionMetrics.liveAutonomousInsertMissedToday missing');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.liveAutonomousInsertLateToday)), 'status.liveAutonomousInsertionMetrics.liveAutonomousInsertLateToday missing');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.rolling5dAutonomousInsertRatePct)), 'status.liveAutonomousInsertionMetrics.rolling5dAutonomousInsertRatePct missing');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.consecutiveAutonomousInsertDays)), 'status.liveAutonomousInsertionMetrics.consecutiveAutonomousInsertDays missing');
  assert(Number.isFinite(Number(status.liveAutonomousInsertionMetrics.consecutiveAutonomousInsertMissDays)), 'status.liveAutonomousInsertionMetrics.consecutiveAutonomousInsertMissDays missing');
  assert(status.liveContextAudit && typeof status.liveContextAudit === 'object', 'liveContextAudit missing from status');
  assert(Number.isFinite(Number(status.liveContextAudit.invalidLiveContextsCreatedToday)), 'liveContextAudit.invalidLiveContextsCreatedToday missing');
  assert(Number.isFinite(Number(status.liveContextAudit.invalidLiveContextsSuppressedToday)), 'liveContextAudit.invalidLiveContextsSuppressedToday missing');
  assert(Array.isArray(status.liveContextAudit.latestInvalidLiveContextDates), 'liveContextAudit.latestInvalidLiveContextDates missing');
  assert(Array.isArray(status.liveOutcomeFinalization.latestReadyButUninsertedDates), 'liveOutcomeFinalization.latestReadyButUninsertedDates missing');
  assert(Array.isArray(status.recentRuns), 'recentRuns missing from daily scoring status');
  assert(Array.isArray(status.recentOutcomes), 'recentOutcomes missing from daily scoring status');

  const latestRunRow = db.prepare(`
    SELECT id, details_json
    FROM jarvis_daily_scoring_runs
    ORDER BY id DESC
    LIMIT 1
  `).get();
  assert(latestRunRow && latestRunRow.id, 'latest run row missing for mismatch injection');
  const patchedDetails = JSON.parse(String(latestRunRow.details_json || '{}'));
  patchedDetails.liveCheckpoint = {
    ...(patchedDetails.liveCheckpoint && typeof patchedDetails.liveCheckpoint === 'object' ? patchedDetails.liveCheckpoint : {}),
    checkpointExpectedOutcomeCount: 1,
    checkpointActualOutcomeCount: 0,
    checkpointInsertDelta: -1,
  };
  patchedDetails.liveInsertionOwnership = {
    ...(patchedDetails.liveInsertionOwnership && typeof patchedDetails.liveInsertionOwnership === 'object' ? patchedDetails.liveInsertionOwnership : {}),
    liveInsertionOwnershipScope: 'broader_cycle',
    liveInsertionOwnershipOutcome: 'already_inserted_before_this_cycle',
  };
  db.prepare('UPDATE jarvis_daily_scoring_runs SET details_json = ? WHERE id = ?')
    .run(JSON.stringify(patchedDetails), latestRunRow.id);
  const mismatchStatus = buildDailyScoringStatus({ db });
  assert(mismatchStatus.liveTargetDayOwnershipConsistent === false, 'mismatch status should flag target-day ownership consistency false');
  assert(
    ['scope_broader_cycle', 'target_day_scope_mismatch', 'target_day_zero_actual_claims_inserted'].includes(
      String(mismatchStatus.liveTargetDayOwnershipMismatchReason || '')
    ),
    'mismatch status should expose bounded mismatch reason'
  );
  assert(
    String(mismatchStatus.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_scope_mismatch',
    'mismatch status should classify autonomous proof as scope mismatch'
  );

  const latestRunRowForAttemptFailure = db.prepare(`
    SELECT id, details_json
    FROM jarvis_daily_scoring_runs
    ORDER BY id DESC
    LIMIT 1
  `).get();
  assert(latestRunRowForAttemptFailure && latestRunRowForAttemptFailure.id, 'latest run row missing for attempted-failure injection');
  const attemptedFailureDetails = JSON.parse(String(latestRunRowForAttemptFailure.details_json || '{}'));
  attemptedFailureDetails.liveCheckpoint = {
    ...(attemptedFailureDetails.liveCheckpoint && typeof attemptedFailureDetails.liveCheckpoint === 'object' ? attemptedFailureDetails.liveCheckpoint : {}),
    targetTradingDay: targetDayWaitingDate,
    tradingDayClassification: 'valid_trading_day',
    closeComplete: true,
    requiredCloseDataPresent: true,
    requiredCloseBarsPresent: true,
    closeCheckpointEligible: true,
    expectedLiveContextExists: true,
    liveContextSuppressed: false,
    liveOutcomeExists: false,
    liveOutcomeInsertedThisCheckpoint: false,
    runtimeCheckpointWasAutonomous: true,
    runtimeCheckpointSource: 'close_complete_checkpoint',
    sweepSource: 'close_complete_checkpoint',
    checkpointExpectedOutcomeCount: 1,
    checkpointActualOutcomeCount: 0,
    checkpointInsertDelta: -1,
    firstEligibleCycleExpectedInsert: true,
    firstEligibleCycleInsertAttempted: true,
    firstEligibleCycleInsertSucceeded: false,
    firstEligibleCycleFailureReason: 'insert_attempt_failed',
  };
  attemptedFailureDetails.liveInsertionOwnership = {
    ...(attemptedFailureDetails.liveInsertionOwnership && typeof attemptedFailureDetails.liveInsertionOwnership === 'object' ? attemptedFailureDetails.liveInsertionOwnership : {}),
    liveInsertionOwnershipTargetTradingDay: targetDayWaitingDate,
    liveInsertionOwnershipScope: 'target_day',
    liveInsertionOwnershipOutcome: 'target_day_not_inserted_yet',
    liveInsertionOwnershipCurrentRunWasFirstCreator: false,
    liveInsertionOwnershipCurrentRunCreatedRowId: null,
  };
  attemptedFailureDetails.liveAutonomousFirstRight = {
    ...(attemptedFailureDetails.liveAutonomousFirstRight && typeof attemptedFailureDetails.liveAutonomousFirstRight === 'object' ? attemptedFailureDetails.liveAutonomousFirstRight : {}),
    liveAutonomousFirstRightTargetTradingDay: targetDayWaitingDate,
    liveAutonomousFirstRightActive: true,
    liveAutonomousFirstRightOutcome: 'autonomous_first_right_reserved',
  };
  attemptedFailureDetails.liveTargetDayOwnershipInvariant = {
    liveTargetDayOwnershipConsistent: true,
    liveTargetDayOwnershipMismatchReason: 'no_mismatch',
    advisoryOnly: true,
  };
  attemptedFailureDetails.liveTargetDayOwnershipConsistent = true;
  attemptedFailureDetails.liveTargetDayOwnershipMismatchReason = 'no_mismatch';
  db.prepare('UPDATE jarvis_daily_scoring_runs SET details_json = ? WHERE id = ?')
    .run(JSON.stringify(attemptedFailureDetails), latestRunRowForAttemptFailure.id);
  db.prepare(`
    DELETE FROM jarvis_scored_trade_outcomes
    WHERE score_date = ?
      AND lower(source_type) = 'live'
  `).run(targetDayWaitingDate);
  const attemptedFailureStatus = buildDailyScoringStatus({ db });
  assert(
    String(attemptedFailureStatus.liveAutonomousInsertReadiness?.autonomousInsertBlockReason || '') === 'waiting_for_close',
    'recomputed status should block on waiting_for_close when target day has not reached close-complete'
  );
  assert(String(attemptedFailureStatus.liveAutonomousProof?.liveAutonomousProofOutcome || '') === 'proof_waiting_for_close', 'recomputed status should classify proof as waiting for close');
  assert(typeof attemptedFailureStatus.liveAutonomousProof?.liveAutonomousProofAttempted === 'boolean', 'recomputed status should expose attempted boolean while waiting');
  assert(attemptedFailureStatus.liveAutonomousProof?.liveAutonomousProofSucceeded === false, 'recomputed status should keep succeeded false while waiting');
  assert(String(attemptedFailureStatus.liveAutonomousAttemptTransition?.attemptResult || '') === 'attempt_waiting_for_close', 'recomputed status should classify attempt transition as waiting for close');
  assert(attemptedFailureStatus.liveAutonomousAttemptTransition?.attemptRequired === false, 'recomputed status should not require attempt while waiting');
  assert(attemptedFailureStatus.liveAutonomousAttemptTransition?.attemptExecuted === false, 'recomputed status should not execute attempt while waiting');

  db.close();
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3208,
    env: {
      JARVIS_AUTO_DAILY_SCORING_ENABLED: 'false',
    },
  });

  try {
    const statusOut = await getJson(server.baseUrl, '/api/jarvis/evidence/daily-scoring?force=1');
    assert(statusOut?.status === 'ok', 'daily scoring status endpoint should return ok');
    assert(statusOut?.dailyEvidenceScoringStatus && typeof statusOut.dailyEvidenceScoringStatus === 'object', 'dailyEvidenceScoringStatus missing');
    assert(DAILY_SCORING_RUN_ORIGIN_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.runOrigin || '')), 'daily scoring status endpoint invalid runOrigin');
    assert(statusOut.dailyEvidenceScoringStatus.liveEvidenceGeneration && typeof statusOut.dailyEvidenceScoringStatus.liveEvidenceGeneration === 'object', 'daily scoring status endpoint missing liveEvidenceGeneration');
    assert(statusOut.dailyEvidenceScoringStatus.liveDayConversion && typeof statusOut.dailyEvidenceScoringStatus.liveDayConversion === 'object', 'daily scoring status endpoint missing liveDayConversion');
    assert(statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization && typeof statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization === 'object', 'daily scoring status endpoint missing liveOutcomeFinalization');
    assert(statusOut.dailyEvidenceScoringStatus.liveCheckpoint && typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint === 'object', 'daily scoring status endpoint missing liveCheckpoint');
    assert(statusOut.dailyEvidenceScoringStatus.liveInsertionSla && typeof statusOut.dailyEvidenceScoringStatus.liveInsertionSla === 'object', 'daily scoring status endpoint missing liveInsertionSla');
    assert(statusOut.dailyEvidenceScoringStatus.liveInsertionGrowth && typeof statusOut.dailyEvidenceScoringStatus.liveInsertionGrowth === 'object', 'daily scoring status endpoint missing liveInsertionGrowth');
    assert(statusOut.dailyEvidenceScoringStatus.liveInsertionOwnership && typeof statusOut.dailyEvidenceScoringStatus.liveInsertionOwnership === 'object', 'daily scoring status endpoint missing liveInsertionOwnership');
    assert(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertionMetrics && typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertionMetrics === 'object', 'daily scoring status endpoint missing liveAutonomousInsertionMetrics');
    assert(statusOut.dailyEvidenceScoringStatus.liveAutonomousFirstRight && typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousFirstRight === 'object', 'daily scoring status endpoint missing liveAutonomousFirstRight');
    assert(CLOSE_COMPLETE_REASON_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveCheckpoint.closeCompleteReason || '')), 'daily scoring status endpoint invalid closeCompleteReason');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.closeComplete === 'boolean', 'daily scoring status endpoint missing closeComplete');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.firstEligibleCycleExpectedInsert === 'boolean', 'daily scoring status endpoint missing firstEligibleCycleExpectedInsert');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.firstEligibleCycleInsertAttempted === 'boolean', 'daily scoring status endpoint missing firstEligibleCycleInsertAttempted');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.firstEligibleCycleInsertSucceeded === 'boolean', 'daily scoring status endpoint missing firstEligibleCycleInsertSucceeded');
    assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveCheckpoint.checkpointWindowReason || '')), 'daily scoring status endpoint invalid checkpointWindowReason');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.checkpointWithinAllowedWindow === 'boolean', 'daily scoring status endpoint missing checkpointWithinAllowedWindow');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.checkpointPastDeadline === 'boolean', 'daily scoring status endpoint missing checkpointPastDeadline');
    assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveCheckpoint.runtimeCheckpointOutcome || '')), 'daily scoring status endpoint invalid runtimeCheckpointOutcome');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.runtimeCheckpointWasAutonomous === 'boolean', 'daily scoring status endpoint missing runtimeCheckpointWasAutonomous');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveCheckpoint.runtimeCheckpointMissed === 'boolean', 'daily scoring status endpoint missing runtimeCheckpointMissed');
    assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveInsertionSla.liveInsertionSlaOutcome || '')), 'daily scoring status endpoint invalid liveInsertionSlaOutcome');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveInsertionSla.liveInsertionSlaRequired === 'boolean', 'daily scoring status endpoint missing liveInsertionSlaRequired');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveInsertionSla.liveInsertionSlaNetNewRowCreated === 'boolean', 'daily scoring status endpoint missing liveInsertionSlaNetNewRowCreated');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveInsertionSla.liveInsertionSlaLateByMinutes)), 'daily scoring status endpoint missing liveInsertionSlaLateByMinutes');
    assert(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveInsertionOwnership.liveInsertionOwnershipOutcome || '')), 'daily scoring status endpoint invalid liveInsertionOwnershipOutcome');
    assert(LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveInsertionOwnership.liveInsertionOwnershipScope || '')), 'daily scoring status endpoint invalid liveInsertionOwnershipScope');
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || '')
      ),
      'daily scoring status endpoint invalid liveInsertionOwnershipSourceSpecificOutcome'
    );
    assert(statusOut.dailyEvidenceScoringStatus.liveTargetDayOwnershipInvariant && typeof statusOut.dailyEvidenceScoringStatus.liveTargetDayOwnershipInvariant === 'object', 'daily scoring status endpoint missing liveTargetDayOwnershipInvariant');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveTargetDayOwnershipConsistent === 'boolean', 'daily scoring status endpoint missing liveTargetDayOwnershipConsistent');
    assert(LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveTargetDayOwnershipMismatchReason || '')), 'daily scoring status endpoint invalid liveTargetDayOwnershipMismatchReason');
    assert(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertReadiness && typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertReadiness === 'object', 'daily scoring status endpoint missing liveAutonomousInsertReadiness');
    assert(LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')), 'daily scoring status endpoint invalid autonomousInsertBlockReason');
    assert(LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')), 'daily scoring status endpoint invalid autonomousInsertNextTransition');
    assert(statusOut.dailyEvidenceScoringStatus.liveAutonomousAttemptTransition && typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousAttemptTransition === 'object', 'daily scoring status endpoint missing liveAutonomousAttemptTransition');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousAttemptTransition.attemptResult || '')), 'daily scoring status endpoint invalid autonomous attempt result');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousAttemptResult || '')), 'daily scoring status endpoint invalid flattened autonomous attempt result');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousAttemptRequired === 'boolean', 'daily scoring status endpoint missing liveAutonomousAttemptRequired');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousAttemptExecuted === 'boolean', 'daily scoring status endpoint missing liveAutonomousAttemptExecuted');
    assert(statusOut.dailyEvidenceScoringStatus.liveAutonomousProof && typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousProof === 'object', 'daily scoring status endpoint missing liveAutonomousProof');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousProof.liveAutonomousProofOutcome || '')), 'daily scoring status endpoint invalid liveAutonomousProofOutcome');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousProofOutcome || '')), 'daily scoring status endpoint invalid flattened liveAutonomousProofOutcome');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousProofEligible === 'boolean', 'daily scoring status endpoint missing liveAutonomousProofEligible');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousProofAttempted === 'boolean', 'daily scoring status endpoint missing liveAutonomousProofAttempted');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveAutonomousProofSucceeded === 'boolean', 'daily scoring status endpoint missing liveAutonomousProofSucceeded');
    assert(LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousProofFailureReason || '')), 'daily scoring status endpoint invalid liveAutonomousProofFailureReason');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousFirstRight.liveAutonomousFirstRightOutcome || '')), 'daily scoring status endpoint invalid liveAutonomousFirstRightOutcome');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveAutonomousFirstRight.liveAutonomousFirstRightWindowState || '')), 'daily scoring status endpoint invalid liveAutonomousFirstRightWindowState');
    assert(typeof statusOut.dailyEvidenceScoringStatus.liveOwnershipConsistencyOk === 'boolean', 'daily scoring status endpoint missing liveOwnershipConsistencyOk');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertionMetrics.liveAutonomousInsertRequiredToday)), 'daily scoring status endpoint missing liveAutonomousInsertRequiredToday');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertionMetrics.liveAutonomousInsertDeliveredToday)), 'daily scoring status endpoint missing liveAutonomousInsertDeliveredToday');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveAutonomousInsertionMetrics.rolling5dAutonomousInsertRatePct)), 'daily scoring status endpoint missing rolling5dAutonomousInsertRatePct');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.naturalPreferredOwnerWinsLast5d)), 'daily scoring status endpoint missing naturalPreferredOwnerWinsLast5d');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.naturalPreferredOwnerWinsTotal)), 'daily scoring status endpoint missing naturalPreferredOwnerWinsTotal');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.naturalPreferredOwnerVerifierPassesLast5d)), 'daily scoring status endpoint missing naturalPreferredOwnerVerifierPassesLast5d');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.naturalPreferredOwnerVerifierFailsLast5d)), 'daily scoring status endpoint missing naturalPreferredOwnerVerifierFailsLast5d');
    if (statusOut.dailyEvidenceScoringStatus.lastNaturalPreferredOwnerWinDay !== null) {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(String(statusOut.dailyEvidenceScoringStatus.lastNaturalPreferredOwnerWinDay)), 'daily scoring status endpoint invalid lastNaturalPreferredOwnerWinDay');
    }
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierStatus || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerPostCloseProofVerifierStatus'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierPass === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerPostCloseProofVerifierPass'
    );
    assert(
      Array.isArray(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierFailureReasons),
      'daily scoring status endpoint missing livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierFailureReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring status endpoint invalid livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierRunOrigin || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerPostCloseProofVerifierRunOrigin'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofResolvedNaturally === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerPostCloseProofResolvedNaturally'
    );
    assert(
      PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerNaturalDrillWatcherStatus || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerNaturalDrillWatcherStatus'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerNaturalDrillWatcherExecuted === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerNaturalDrillWatcherExecuted'
    );
    assert(
      PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerNaturalDrillWatcherOutcome || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerNaturalDrillWatcherOutcome'
    );
    assert(
      LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorLatestSummaryLabel || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerMonitorLatestSummaryLabel'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorLatestVerifierPass === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerMonitorLatestVerifierPass'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorLatestWatcherExecuted === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerMonitorLatestWatcherExecuted'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorLatestProofBundlePass === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerMonitorLatestProofBundlePass'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorResolvedSuccess === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerMonitorResolvedSuccess'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorConsistent === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerMonitorConsistent'
    );
    assert(
      Array.isArray(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorMismatchReasons),
      'daily scoring status endpoint missing livePreferredOwnerMonitorMismatchReasons'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorMismatchReasons.every((reason) => (
        LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring status endpoint invalid livePreferredOwnerMonitorMismatchReasons'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus
        && typeof statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus === 'object',
      'daily scoring status endpoint missing liveNextNaturalDayTerminalStatus'
    );
    assert(
      NEXT_NATURAL_DAY_READINESS_RESULT_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus.result || '')
      ),
      'daily scoring status endpoint invalid liveNextNaturalDayTerminalStatus.result'
    );
    assert(
      ['waiting', 'broken', 'healthy'].includes(
        String(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus.pipelineState || '')
      ),
      'daily scoring status endpoint invalid liveNextNaturalDayTerminalStatus.pipelineState'
    );
    assert(
      ['waiting', 'broken'].includes(
        String(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus.waitingOrBroken || '')
      ),
      'daily scoring status endpoint invalid liveNextNaturalDayTerminalStatus.waitingOrBroken'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus.terminalAlertAlreadyEmitted === 'boolean',
      'daily scoring status endpoint missing liveNextNaturalDayTerminalStatus.terminalAlertAlreadyEmitted'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus.rowsUsed
        && typeof statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus.rowsUsed === 'object',
      'daily scoring status endpoint missing liveNextNaturalDayTerminalStatus.rowsUsed'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayDiscoveredInPersistedData === 'boolean',
      'daily scoring status endpoint missing liveNextNaturalDayDiscoveredInPersistedData'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay === 'boolean',
      'daily scoring status endpoint missing liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperatorSnapshot
        && typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperatorSnapshot === 'object',
      'daily scoring status endpoint missing livePreferredOwnerOperatorSnapshot'
    );
    const operatorSnapshot = statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperatorSnapshot;
    const requiredOperatorSnapshotFields = [
      'targetTradingDay',
      'expectedSource',
      'actualSource',
      'preferredOwnerWon',
      'ownershipSourceSpecificOutcome',
      'verifierStatus',
      'verifierPass',
      'verifierRunId',
      'verifierFailureReasons',
      'watcherStatus',
      'watcherExecuted',
      'watcherOutcome',
      'proofBundleStatus',
      'proofBundlePass',
      'monitorSummaryLabel',
      'monitorResolvedSuccess',
      'monitorConsistent',
      'monitorMismatchReasons',
    ];
    for (const key of requiredOperatorSnapshotFields) {
      assert(
        Object.prototype.hasOwnProperty.call(operatorSnapshot, key),
        `daily scoring status endpoint operator snapshot missing ${key}`
      );
    }
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(operatorSnapshot.verifierStatus || '')
      ),
      'daily scoring status endpoint operator snapshot verifierStatus should stay bounded'
    );
    assert(
      LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM.includes(
        String(operatorSnapshot.monitorSummaryLabel || '')
      ),
      'daily scoring status endpoint operator snapshot monitorSummaryLabel should stay bounded'
    );
    assert(
      Array.isArray(operatorSnapshot.monitorMismatchReasons)
        && operatorSnapshot.monitorMismatchReasons.every((reason) => (
          LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM.includes(String(reason || ''))
        )),
      'daily scoring status endpoint operator snapshot monitorMismatchReasons should stay bounded'
    );
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerLatestOperationalVerdictStatus || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerLatestOperationalVerdictStatus'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerLatestOperationalVerdictPass === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerLatestOperationalVerdictPass'
    );
    assert(
      Array.isArray(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerLatestOperationalVerdictReasons),
      'daily scoring status endpoint missing livePreferredOwnerLatestOperationalVerdictReasons'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.livePreferredOwnerLatestOperationalVerdictReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring status endpoint invalid livePreferredOwnerLatestOperationalVerdictReasons'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerLatestOperationalVerdictRunOrigin || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerLatestOperationalVerdictRunOrigin'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerLatestOperationalVerdictRuntimeSource || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerLatestOperationalVerdictRuntimeSource'
    );
    if (statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundle !== null) {
      assert(
        typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundle === 'object',
        'daily scoring status endpoint livePreferredOwnerOperationalProofBundle must be object when present'
      );
    }
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleCapturedThisRun === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleCapturedThisRun'
    );
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierStatus || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleVerifierStatus'
    );
    assert(
      typeof statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierPass === 'boolean',
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleVerifierPass'
    );
    assert(
      Array.isArray(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierFailureReasons),
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleVerifierFailureReasons'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierFailureReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleVerifierFailureReasons'
    );
    assert(
      LIVE_CHECKPOINT_STATUS_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleCheckpointStatus || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleCheckpointStatus'
    );
    assert(
      LIVE_CHECKPOINT_REASON_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleCheckpointReason || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleCheckpointReason'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundlePreferredOwnerExpectedSource || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundlePreferredOwnerExpectedSource'
    );
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleRunOrigin || '')
      ),
      'daily scoring status endpoint invalid livePreferredOwnerOperationalProofBundleRunOrigin'
    );
    assert(
      Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d)),
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d'
    );
    assert(
      Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal)),
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal'
    );
    assert(
      Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierPassesLast5d)),
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierPassesLast5d'
    );
    assert(
      Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierFailsLast5d)),
      'daily scoring status endpoint missing livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierFailsLast5d'
    );
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveInsertionGrowth.rolling5dOnTimeRatePct)), 'daily scoring status endpoint missing rolling5dOnTimeRatePct');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveInsertionGrowth.consecutiveValidDaysWithOnTimeInsert)), 'daily scoring status endpoint missing consecutiveValidDaysWithOnTimeInsert');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveInsertionGrowth.consecutiveValidDaysMissed)), 'daily scoring status endpoint missing consecutiveValidDaysMissed');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization.validLiveDaysSeen)), 'daily scoring status endpoint missing validLiveDaysSeen');
    assert(Number.isFinite(Number(statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization.validLiveDaysMissedByScheduler)), 'daily scoring status endpoint missing validLiveDaysMissedByScheduler');
    assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization.latestSweepSource || '')), 'daily scoring status endpoint latestSweepSource should stay bounded');
    assert(statusOut.dailyEvidenceScoringStatus.liveContextAudit && typeof statusOut.dailyEvidenceScoringStatus.liveContextAudit === 'object', 'daily scoring status endpoint missing liveContextAudit');
    assert(Array.isArray(statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization.latestWaitingDates), 'daily scoring status endpoint missing latestWaitingDates');
    assert(Array.isArray(statusOut.dailyEvidenceScoringStatus.liveOutcomeFinalization.latestBlockedDates), 'daily scoring status endpoint missing latestBlockedDates');
    assert(Array.isArray(statusOut.dailyEvidenceScoringStatus.liveCheckpoint.latestMissedCheckpointDates), 'daily scoring status endpoint missing liveCheckpoint.latestMissedCheckpointDates');
    assert(Array.isArray(statusOut.dailyEvidenceScoringStatus.liveCheckpoint.latestCheckpointFailures), 'daily scoring status endpoint missing liveCheckpoint.latestCheckpointFailures');
    if (statusOut.dailyEvidenceScoringStatus.liveEvidenceGeneration.latestContextCapture !== null) {
      assert(typeof statusOut.dailyEvidenceScoringStatus.liveEvidenceGeneration.latestContextCapture === 'object', 'latestContextCapture must be object when present');
    }

    const runOut = await postJson(server.baseUrl, '/api/jarvis/evidence/daily-scoring/run', {
      mode: 'integration_manual',
      windowDays: 2,
      force: false,
    });
    assert(runOut?.status === 'ok', 'daily scoring run endpoint should return ok');
    assert(runOut?.dailyEvidenceScoringRun && typeof runOut.dailyEvidenceScoringRun === 'object', 'dailyEvidenceScoringRun payload missing');
    assert(runOut.dailyEvidenceScoringRun.advisoryOnly === true, 'dailyEvidenceScoringRun should be advisoryOnly');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveContextsSeen)), 'daily scoring run endpoint missing liveContextsSeen');
    assert(runOut.dailyEvidenceScoringRun.liveSkipReasonBuckets && typeof runOut.dailyEvidenceScoringRun.liveSkipReasonBuckets === 'object', 'daily scoring run endpoint missing liveSkipReasonBuckets');
    assert(runOut.dailyEvidenceScoringRun.liveEligibilityReasonBuckets && typeof runOut.dailyEvidenceScoringRun.liveEligibilityReasonBuckets === 'object', 'daily scoring run endpoint missing liveEligibilityReasonBuckets');
    assert(Array.isArray(runOut.dailyEvidenceScoringRun.liveContextsWithoutFreshInsertDates), 'daily scoring run endpoint missing liveContextsWithoutFreshInsertDates');
    assert(runOut.dailyEvidenceScoringRun.liveDayConversion && typeof runOut.dailyEvidenceScoringRun.liveDayConversion === 'object', 'daily scoring run endpoint missing liveDayConversion');
    assert(runOut.dailyEvidenceScoringRun.liveDayConversion.advisoryOnly === true, 'daily scoring run liveDayConversion should be advisoryOnly');
    assert(runOut.dailyEvidenceScoringRun.liveFinalization && typeof runOut.dailyEvidenceScoringRun.liveFinalization === 'object', 'daily scoring run endpoint missing liveFinalization');
    assert(runOut.dailyEvidenceScoringRun.liveCheckpoint && typeof runOut.dailyEvidenceScoringRun.liveCheckpoint === 'object', 'daily scoring run endpoint missing liveCheckpoint');
    assert(runOut.dailyEvidenceScoringRun.liveInsertionSla && typeof runOut.dailyEvidenceScoringRun.liveInsertionSla === 'object', 'daily scoring run endpoint missing liveInsertionSla');
    assert(runOut.dailyEvidenceScoringRun.liveInsertionGrowth && typeof runOut.dailyEvidenceScoringRun.liveInsertionGrowth === 'object', 'daily scoring run endpoint missing liveInsertionGrowth');
    assert(runOut.dailyEvidenceScoringRun.liveInsertionOwnership && typeof runOut.dailyEvidenceScoringRun.liveInsertionOwnership === 'object', 'daily scoring run endpoint missing liveInsertionOwnership');
    assert(runOut.dailyEvidenceScoringRun.liveAutonomousInsertReadiness && typeof runOut.dailyEvidenceScoringRun.liveAutonomousInsertReadiness === 'object', 'daily scoring run endpoint missing liveAutonomousInsertReadiness');
    assert(LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousInsertReadiness.autonomousInsertBlockReason || '')), 'daily scoring run endpoint invalid autonomousInsertBlockReason');
    assert(LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousInsertReadiness.autonomousInsertNextTransition || '')), 'daily scoring run endpoint invalid autonomousInsertNextTransition');
    assert(runOut.dailyEvidenceScoringRun.liveAutonomousAttemptTransition && typeof runOut.dailyEvidenceScoringRun.liveAutonomousAttemptTransition === 'object', 'daily scoring run endpoint missing liveAutonomousAttemptTransition');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousAttemptTransition.attemptResult || '')), 'daily scoring run endpoint invalid autonomous attempt result');
    assert(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousAttemptResult || '')), 'daily scoring run endpoint invalid flattened autonomous attempt result');
    assert(typeof runOut.dailyEvidenceScoringRun.liveAutonomousAttemptRequired === 'boolean', 'daily scoring run endpoint missing liveAutonomousAttemptRequired');
    assert(typeof runOut.dailyEvidenceScoringRun.liveAutonomousAttemptExecuted === 'boolean', 'daily scoring run endpoint missing liveAutonomousAttemptExecuted');
    assert(runOut.dailyEvidenceScoringRun.liveAutonomousInsertionMetrics && typeof runOut.dailyEvidenceScoringRun.liveAutonomousInsertionMetrics === 'object', 'daily scoring run endpoint missing liveAutonomousInsertionMetrics');
    assert(runOut.dailyEvidenceScoringRun.liveAutonomousFirstRight && typeof runOut.dailyEvidenceScoringRun.liveAutonomousFirstRight === 'object', 'daily scoring run endpoint missing liveAutonomousFirstRight');
    assert(CLOSE_COMPLETE_REASON_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveCheckpoint.closeCompleteReason || '')), 'daily scoring run endpoint invalid closeCompleteReason');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.closeComplete === 'boolean', 'daily scoring run endpoint missing closeComplete');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.firstEligibleCycleExpectedInsert === 'boolean', 'daily scoring run endpoint missing firstEligibleCycleExpectedInsert');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.firstEligibleCycleInsertAttempted === 'boolean', 'daily scoring run endpoint missing firstEligibleCycleInsertAttempted');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.firstEligibleCycleInsertSucceeded === 'boolean', 'daily scoring run endpoint missing firstEligibleCycleInsertSucceeded');
    assert(CHECKPOINT_WINDOW_REASON_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveCheckpoint.checkpointWindowReason || '')), 'daily scoring run endpoint invalid checkpointWindowReason');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.checkpointWithinAllowedWindow === 'boolean', 'daily scoring run endpoint missing checkpointWithinAllowedWindow');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.checkpointPastDeadline === 'boolean', 'daily scoring run endpoint missing checkpointPastDeadline');
    assert(RUNTIME_CHECKPOINT_OUTCOME_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveCheckpoint.runtimeCheckpointOutcome || '')), 'daily scoring run endpoint invalid runtimeCheckpointOutcome');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.runtimeCheckpointWasAutonomous === 'boolean', 'daily scoring run endpoint missing runtimeCheckpointWasAutonomous');
    assert(typeof runOut.dailyEvidenceScoringRun.liveCheckpoint.runtimeCheckpointMissed === 'boolean', 'daily scoring run endpoint missing runtimeCheckpointMissed');
    assert(LIVE_INSERTION_SLA_OUTCOME_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveInsertionSla.liveInsertionSlaOutcome || '')), 'daily scoring run endpoint invalid liveInsertionSlaOutcome');
    assert(typeof runOut.dailyEvidenceScoringRun.liveInsertionSla.liveInsertionSlaRequired === 'boolean', 'daily scoring run endpoint missing liveInsertionSlaRequired');
    assert(typeof runOut.dailyEvidenceScoringRun.liveInsertionSla.liveInsertionSlaNetNewRowCreated === 'boolean', 'daily scoring run endpoint missing liveInsertionSlaNetNewRowCreated');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveInsertionSla.liveInsertionSlaLateByMinutes)), 'daily scoring run endpoint missing liveInsertionSlaLateByMinutes');
    assert(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveInsertionOwnership.liveInsertionOwnershipOutcome || '')), 'daily scoring run endpoint invalid liveInsertionOwnershipOutcome');
    assert(LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveInsertionOwnership.liveInsertionOwnershipScope || '')), 'daily scoring run endpoint invalid liveInsertionOwnershipScope');
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || '')
      ),
      'daily scoring run endpoint invalid liveInsertionOwnershipSourceSpecificOutcome'
    );
    assert(runOut.dailyEvidenceScoringRun.liveTargetDayOwnershipInvariant && typeof runOut.dailyEvidenceScoringRun.liveTargetDayOwnershipInvariant === 'object', 'daily scoring run endpoint missing liveTargetDayOwnershipInvariant');
    assert(typeof runOut.dailyEvidenceScoringRun.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent === 'boolean', 'daily scoring run endpoint missing liveTargetDayOwnershipConsistent');
    assert(LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveTargetDayOwnershipInvariant.liveTargetDayOwnershipMismatchReason || '')), 'daily scoring run endpoint invalid liveTargetDayOwnershipMismatchReason');
    assert(runOut.dailyEvidenceScoringRun.liveAutonomousProof && typeof runOut.dailyEvidenceScoringRun.liveAutonomousProof === 'object', 'daily scoring run endpoint missing liveAutonomousProof');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousProof.liveAutonomousProofOutcome || '')), 'daily scoring run endpoint invalid liveAutonomousProofOutcome');
    assert(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousProofOutcome || '')), 'daily scoring run endpoint invalid flattened liveAutonomousProofOutcome');
    assert(LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousProof.liveAutonomousProofFailureReason || '')), 'daily scoring run endpoint invalid liveAutonomousProofFailureReason');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousFirstRight.liveAutonomousFirstRightOutcome || '')), 'daily scoring run endpoint invalid liveAutonomousFirstRightOutcome');
    assert(LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveAutonomousFirstRight.liveAutonomousFirstRightWindowState || '')), 'daily scoring run endpoint invalid liveAutonomousFirstRightWindowState');
    assert(typeof runOut.dailyEvidenceScoringRun.liveOwnershipConsistencyOk === 'boolean', 'daily scoring run endpoint missing liveOwnershipConsistencyOk');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveAutonomousInsertionMetrics.liveAutonomousInsertRequiredToday)), 'daily scoring run endpoint missing liveAutonomousInsertRequiredToday');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveAutonomousInsertionMetrics.liveAutonomousInsertDeliveredToday)), 'daily scoring run endpoint missing liveAutonomousInsertDeliveredToday');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveAutonomousInsertionMetrics.rolling5dAutonomousInsertRatePct)), 'daily scoring run endpoint missing rolling5dAutonomousInsertRatePct');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveInsertionGrowth.rolling5dOnTimeRatePct)), 'daily scoring run endpoint missing rolling5dOnTimeRatePct');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveInsertionGrowth.consecutiveValidDaysWithOnTimeInsert)), 'daily scoring run endpoint missing consecutiveValidDaysWithOnTimeInsert');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveInsertionGrowth.consecutiveValidDaysMissed)), 'daily scoring run endpoint missing consecutiveValidDaysMissed');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.liveFinalization.pendingLiveContextsCount)), 'daily scoring run endpoint missing liveFinalization.pendingLiveContextsCount');
    assert(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(String(runOut.dailyEvidenceScoringRun.liveFinalizationSweepSource || '')), 'daily scoring run endpoint liveFinalizationSweepSource should stay bounded');
    assert(runOut.dailyEvidenceScoringRun.liveContextAudit && typeof runOut.dailyEvidenceScoringRun.liveContextAudit === 'object', 'daily scoring run endpoint missing liveContextAudit');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysSeen)), 'daily scoring run endpoint missing validLiveDaysSeen');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysReadyToFinalize)), 'daily scoring run endpoint missing validLiveDaysReadyToFinalize');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysFinalizedInserted)), 'daily scoring run endpoint missing validLiveDaysFinalizedInserted');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysFinalizedUpdated)), 'daily scoring run endpoint missing validLiveDaysFinalizedUpdated');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysStillWaiting)), 'daily scoring run endpoint missing validLiveDaysStillWaiting');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysBlocked)), 'daily scoring run endpoint missing validLiveDaysBlocked');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.validLiveDaysMissedByScheduler)), 'daily scoring run endpoint missing validLiveDaysMissedByScheduler');
    assert(Array.isArray(runOut.dailyEvidenceScoringRun.latestMissedCheckpointDates), 'daily scoring run endpoint missing latestMissedCheckpointDates');
    assert(Array.isArray(runOut.dailyEvidenceScoringRun.latestCheckpointFailures), 'daily scoring run endpoint missing latestCheckpointFailures');
    assert(Array.isArray(runOut.dailyEvidenceScoringRun.latestReadyButUninsertedDates), 'daily scoring run endpoint missing latestReadyButUninsertedDates');
    assert(Array.isArray(runOut.dailyEvidenceScoringRun.latestWaitingDates), 'daily scoring run endpoint missing latestWaitingDates');
    assert(Array.isArray(runOut.dailyEvidenceScoringRun.latestBlockedDates), 'daily scoring run endpoint missing latestBlockedDates');
    assert(DAILY_SCORING_RUN_ORIGIN_ENUM.includes(String(runOut.dailyEvidenceScoringRun.runOrigin || '')), 'daily scoring run endpoint invalid runOrigin');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.naturalPreferredOwnerWinsLast5d)), 'daily scoring run endpoint missing naturalPreferredOwnerWinsLast5d');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.naturalPreferredOwnerWinsTotal)), 'daily scoring run endpoint missing naturalPreferredOwnerWinsTotal');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.naturalPreferredOwnerVerifierPassesLast5d)), 'daily scoring run endpoint missing naturalPreferredOwnerVerifierPassesLast5d');
    assert(Number.isFinite(Number(runOut.dailyEvidenceScoringRun.naturalPreferredOwnerVerifierFailsLast5d)), 'daily scoring run endpoint missing naturalPreferredOwnerVerifierFailsLast5d');
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerPostCloseProofVerifierStatus || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerPostCloseProofVerifierStatus'
    );
    assert(
      typeof runOut.dailyEvidenceScoringRun.livePreferredOwnerPostCloseProofVerifierPass === 'boolean',
      'daily scoring run endpoint missing livePreferredOwnerPostCloseProofVerifierPass'
    );
    assert(
      Array.isArray(runOut.dailyEvidenceScoringRun.livePreferredOwnerPostCloseProofVerifierFailureReasons),
      'daily scoring run endpoint missing livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      runOut.dailyEvidenceScoringRun.livePreferredOwnerPostCloseProofVerifierFailureReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring run endpoint invalid livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerPostCloseProofVerifierRunOrigin || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerPostCloseProofVerifierRunOrigin'
    );
    assert(
      typeof runOut.dailyEvidenceScoringRun.livePreferredOwnerPostCloseProofResolvedNaturally === 'boolean',
      'daily scoring run endpoint missing livePreferredOwnerPostCloseProofResolvedNaturally'
    );
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerLatestOperationalVerdictStatus || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerLatestOperationalVerdictStatus'
    );
    assert(
      typeof runOut.dailyEvidenceScoringRun.livePreferredOwnerLatestOperationalVerdictPass === 'boolean',
      'daily scoring run endpoint missing livePreferredOwnerLatestOperationalVerdictPass'
    );
    assert(
      Array.isArray(runOut.dailyEvidenceScoringRun.livePreferredOwnerLatestOperationalVerdictReasons),
      'daily scoring run endpoint missing livePreferredOwnerLatestOperationalVerdictReasons'
    );
    assert(
      runOut.dailyEvidenceScoringRun.livePreferredOwnerLatestOperationalVerdictReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring run endpoint invalid livePreferredOwnerLatestOperationalVerdictReasons'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerLatestOperationalVerdictRunOrigin || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerLatestOperationalVerdictRunOrigin'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerLatestOperationalVerdictRuntimeSource || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerLatestOperationalVerdictRuntimeSource'
    );
    if (runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundle !== null) {
      assert(
        typeof runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundle === 'object',
        'daily scoring run endpoint livePreferredOwnerOperationalProofBundle must be object when present'
      );
    }
    assert(
      typeof runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleCapturedThisRun === 'boolean',
      'daily scoring run endpoint missing livePreferredOwnerOperationalProofBundleCapturedThisRun'
    );
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleVerifierStatus || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleVerifierStatus'
    );
    assert(
      typeof runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleVerifierPass === 'boolean',
      'daily scoring run endpoint missing livePreferredOwnerOperationalProofBundleVerifierPass'
    );
    assert(
      Array.isArray(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleVerifierFailureReasons),
      'daily scoring run endpoint missing livePreferredOwnerOperationalProofBundleVerifierFailureReasons'
    );
    assert(
      runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleVerifierFailureReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleVerifierFailureReasons'
    );
    assert(
      LIVE_CHECKPOINT_STATUS_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleCheckpointStatus || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleCheckpointStatus'
    );
    assert(
      LIVE_CHECKPOINT_REASON_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleCheckpointReason || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleCheckpointReason'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource'
    );
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleRunOrigin || '')
      ),
      'daily scoring run endpoint invalid livePreferredOwnerOperationalProofBundleRunOrigin'
    );
    assert(
      Number.isFinite(Number(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d)),
      'daily scoring run endpoint missing livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d'
    );
    assert(
      Number.isFinite(Number(runOut.dailyEvidenceScoringRun.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal)),
      'daily scoring run endpoint missing livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal'
    );

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command-center endpoint should return ok');
    const center = centerOut?.commandCenter && typeof centerOut.commandCenter === 'object' ? centerOut.commandCenter : {};
    assert(Number.isFinite(Number(center?.naturalPreferredOwnerWinsLast5d)), 'command-center missing naturalPreferredOwnerWinsLast5d');
    assert(Number.isFinite(Number(center?.naturalPreferredOwnerWinsTotal)), 'command-center missing naturalPreferredOwnerWinsTotal');
    assert(Number.isFinite(Number(center?.naturalPreferredOwnerVerifierPassesLast5d)), 'command-center missing naturalPreferredOwnerVerifierPassesLast5d');
    assert(Number.isFinite(Number(center?.naturalPreferredOwnerVerifierFailsLast5d)), 'command-center missing naturalPreferredOwnerVerifierFailsLast5d');
    if (center?.lastNaturalPreferredOwnerWinDay !== null && typeof center?.lastNaturalPreferredOwnerWinDay !== 'undefined') {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(String(center.lastNaturalPreferredOwnerWinDay)), 'command-center invalid lastNaturalPreferredOwnerWinDay');
    }
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(center?.livePreferredOwnerPostCloseProofVerifierStatus || '')
      ),
      'command-center invalid livePreferredOwnerPostCloseProofVerifierStatus'
    );
    assert(
      typeof center?.livePreferredOwnerPostCloseProofVerifierPass === 'boolean',
      'command-center missing livePreferredOwnerPostCloseProofVerifierPass'
    );
    assert(
      Array.isArray(center?.livePreferredOwnerPostCloseProofVerifierFailureReasons),
      'command-center missing livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      center.livePreferredOwnerPostCloseProofVerifierFailureReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'command-center invalid livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(center?.livePreferredOwnerPostCloseProofVerifierRunOrigin || '')
      ),
      'command-center invalid livePreferredOwnerPostCloseProofVerifierRunOrigin'
    );
    assert(
      typeof center?.livePreferredOwnerPostCloseProofResolvedNaturally === 'boolean',
      'command-center missing livePreferredOwnerPostCloseProofResolvedNaturally'
    );
    assert(
      PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM.includes(
        String(center?.livePreferredOwnerNaturalDrillWatcherStatus || '')
      ),
      'command-center invalid livePreferredOwnerNaturalDrillWatcherStatus'
    );
    assert(
      typeof center?.livePreferredOwnerNaturalDrillWatcherExecuted === 'boolean',
      'command-center missing livePreferredOwnerNaturalDrillWatcherExecuted'
    );
    assert(
      PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM.includes(
        String(center?.livePreferredOwnerNaturalDrillWatcherOutcome || '')
      ),
      'command-center invalid livePreferredOwnerNaturalDrillWatcherOutcome'
    );
    assert(
      LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM.includes(
        String(center?.livePreferredOwnerMonitorLatestSummaryLabel || '')
      ),
      'command-center invalid livePreferredOwnerMonitorLatestSummaryLabel'
    );
    assert(
      typeof center?.livePreferredOwnerMonitorLatestVerifierPass === 'boolean',
      'command-center missing livePreferredOwnerMonitorLatestVerifierPass'
    );
    assert(
      typeof center?.livePreferredOwnerMonitorLatestWatcherExecuted === 'boolean',
      'command-center missing livePreferredOwnerMonitorLatestWatcherExecuted'
    );
    assert(
      typeof center?.livePreferredOwnerMonitorLatestProofBundlePass === 'boolean',
      'command-center missing livePreferredOwnerMonitorLatestProofBundlePass'
    );
    assert(
      typeof center?.livePreferredOwnerMonitorResolvedSuccess === 'boolean',
      'command-center missing livePreferredOwnerMonitorResolvedSuccess'
    );
    assert(
      typeof center?.livePreferredOwnerMonitorConsistent === 'boolean',
      'command-center missing livePreferredOwnerMonitorConsistent'
    );
    assert(
      Array.isArray(center?.livePreferredOwnerMonitorMismatchReasons),
      'command-center missing livePreferredOwnerMonitorMismatchReasons'
    );
    assert(
      center.livePreferredOwnerMonitorMismatchReasons.every((reason) => (
        LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM.includes(String(reason || ''))
      )),
      'command-center invalid livePreferredOwnerMonitorMismatchReasons'
    );
    assert(
      center?.liveNextNaturalDayTerminalStatus
        && typeof center.liveNextNaturalDayTerminalStatus === 'object',
      'command-center missing liveNextNaturalDayTerminalStatus'
    );
    assert(
      center?.liveNextNaturalDayTerminalBanner
        && typeof center.liveNextNaturalDayTerminalBanner === 'object',
      'command-center missing liveNextNaturalDayTerminalBanner'
    );
    assert(
      NEXT_NATURAL_DAY_READINESS_RESULT_ENUM.includes(
        String(center.liveNextNaturalDayTerminalStatus.result || '')
      ),
      'command-center invalid liveNextNaturalDayTerminalStatus.result'
    );
    assert(
      ['waiting', 'broken', 'healthy'].includes(
        String(center.liveNextNaturalDayTerminalStatus.pipelineState || '')
      ),
      'command-center invalid liveNextNaturalDayTerminalStatus.pipelineState'
    );
    assert(
      ['waiting', 'broken'].includes(
        String(center.liveNextNaturalDayTerminalBanner.waitingOrBroken || '')
      ),
      'command-center invalid liveNextNaturalDayTerminalBanner.waitingOrBroken'
    );
    assert(
      typeof center.liveNextNaturalDayTerminalStatus.terminalAlertAlreadyEmitted === 'boolean',
      'command-center missing liveNextNaturalDayTerminalStatus.terminalAlertAlreadyEmitted'
    );
    assert(
      center.liveNextNaturalDayTerminalBanner.rowsUsed
        && typeof center.liveNextNaturalDayTerminalBanner.rowsUsed === 'object',
      'command-center missing liveNextNaturalDayTerminalBanner.rowsUsed'
    );
    assert(
      typeof center.liveNextNaturalDayDiscoveredInPersistedData === 'boolean',
      'command-center missing liveNextNaturalDayDiscoveredInPersistedData'
    );
    assert(
      typeof center.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay === 'boolean',
      'command-center missing liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay'
    );
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(center?.livePreferredOwnerLatestOperationalVerdictStatus || '')
      ),
      'command-center invalid livePreferredOwnerLatestOperationalVerdictStatus'
    );
    assert(
      typeof center?.livePreferredOwnerLatestOperationalVerdictPass === 'boolean',
      'command-center missing livePreferredOwnerLatestOperationalVerdictPass'
    );
    assert(
      Array.isArray(center?.livePreferredOwnerLatestOperationalVerdictReasons),
      'command-center missing livePreferredOwnerLatestOperationalVerdictReasons'
    );
    assert(
      center.livePreferredOwnerLatestOperationalVerdictReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'command-center invalid livePreferredOwnerLatestOperationalVerdictReasons'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(center?.livePreferredOwnerLatestOperationalVerdictRunOrigin || '')
      ),
      'command-center invalid livePreferredOwnerLatestOperationalVerdictRunOrigin'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(center?.livePreferredOwnerLatestOperationalVerdictRuntimeSource || '')
      ),
      'command-center invalid livePreferredOwnerLatestOperationalVerdictRuntimeSource'
    );
    if (center?.livePreferredOwnerOperationalProofBundle !== null && typeof center?.livePreferredOwnerOperationalProofBundle !== 'undefined') {
      assert(
        typeof center.livePreferredOwnerOperationalProofBundle === 'object',
        'command-center livePreferredOwnerOperationalProofBundle must be object when present'
      );
    }
    assert(
      typeof center?.livePreferredOwnerOperationalProofBundleCapturedThisRun === 'boolean',
      'command-center missing livePreferredOwnerOperationalProofBundleCapturedThisRun'
    );
    assert(
      PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM.includes(
        String(center?.livePreferredOwnerOperationalProofBundleVerifierStatus || '')
      ),
      'command-center invalid livePreferredOwnerOperationalProofBundleVerifierStatus'
    );
    assert(
      typeof center?.livePreferredOwnerOperationalProofBundleVerifierPass === 'boolean',
      'command-center missing livePreferredOwnerOperationalProofBundleVerifierPass'
    );
    assert(
      Array.isArray(center?.livePreferredOwnerOperationalProofBundleVerifierFailureReasons),
      'command-center missing livePreferredOwnerOperationalProofBundleVerifierFailureReasons'
    );
    assert(
      center.livePreferredOwnerOperationalProofBundleVerifierFailureReasons.every((reason) => (
        PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM.includes(String(reason || ''))
      )),
      'command-center invalid livePreferredOwnerOperationalProofBundleVerifierFailureReasons'
    );
    assert(
      LIVE_CHECKPOINT_STATUS_ENUM.includes(
        String(center?.livePreferredOwnerOperationalProofBundleCheckpointStatus || '')
      ),
      'command-center invalid livePreferredOwnerOperationalProofBundleCheckpointStatus'
    );
    assert(
      LIVE_CHECKPOINT_REASON_ENUM.includes(
        String(center?.livePreferredOwnerOperationalProofBundleCheckpointReason || '')
      ),
      'command-center invalid livePreferredOwnerOperationalProofBundleCheckpointReason'
    );
    assert(
      LIVE_FINALIZATION_SWEEP_SOURCE_ENUM.includes(
        String(center?.livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource || '')
      ),
      'command-center invalid livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource'
    );
    assert(
      LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM.includes(
        String(center?.livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome || '')
      ),
      'command-center invalid livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome'
    );
    assert(
      DAILY_SCORING_RUN_ORIGIN_ENUM.includes(
        String(center?.livePreferredOwnerOperationalProofBundleRunOrigin || '')
      ),
      'command-center invalid livePreferredOwnerOperationalProofBundleRunOrigin'
    );
    assert(
      String(center?.livePreferredOwnerOperationalProofBundleTargetTradingDay || '')
      === String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleTargetTradingDay || ''),
      'command-center/daily-scoring mismatch for livePreferredOwnerOperationalProofBundleTargetTradingDay'
    );
    assert(
      String(center?.livePreferredOwnerOperationalProofBundleVerifierStatus || '')
      === String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierStatus || ''),
      'command-center/daily-scoring mismatch for livePreferredOwnerOperationalProofBundleVerifierStatus'
    );
    assert(
      Boolean(center?.livePreferredOwnerOperationalProofBundleVerifierPass)
      === Boolean(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierPass),
      'command-center/daily-scoring mismatch for livePreferredOwnerOperationalProofBundleVerifierPass'
    );
    assert(
      String(center?.livePreferredOwnerMonitorLatestSummaryLabel || '')
      === String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorLatestSummaryLabel || ''),
      'command-center/daily-scoring mismatch for livePreferredOwnerMonitorLatestSummaryLabel'
    );
    assert(
      Boolean(center?.livePreferredOwnerMonitorConsistent)
      === Boolean(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorConsistent),
      'command-center/daily-scoring mismatch for livePreferredOwnerMonitorConsistent'
    );
    assert(
      Boolean(center?.livePreferredOwnerMonitorResolvedSuccess)
      === Boolean(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerMonitorResolvedSuccess),
      'command-center/daily-scoring mismatch for livePreferredOwnerMonitorResolvedSuccess'
    );
    assert(
      String(center?.livePreferredOwnerPostCloseProofVerifierStatus || '')
      === String(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierStatus || ''),
      'command-center/daily-scoring mismatch for livePreferredOwnerPostCloseProofVerifierStatus'
    );
    assert(
      Boolean(center?.livePreferredOwnerPostCloseProofVerifierPass)
      === Boolean(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierPass),
      'command-center/daily-scoring mismatch for livePreferredOwnerPostCloseProofVerifierPass'
    );
    assert(
      Number(center?.livePreferredOwnerPostCloseProofVerifierRunId || 0)
      === Number(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierRunId || 0),
      'command-center/daily-scoring mismatch for livePreferredOwnerPostCloseProofVerifierRunId'
    );
    assert(
      JSON.stringify(center?.livePreferredOwnerPostCloseProofVerifierFailureReasons || [])
      === JSON.stringify(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierFailureReasons || []),
      'command-center/daily-scoring mismatch for livePreferredOwnerPostCloseProofVerifierFailureReasons'
    );
    assert(
      center?.livePreferredOwnerOperatorSnapshot
        && typeof center.livePreferredOwnerOperatorSnapshot === 'object',
      'command-center missing livePreferredOwnerOperatorSnapshot'
    );
    assert(
      JSON.stringify(center.livePreferredOwnerOperatorSnapshot)
      === JSON.stringify(statusOut.dailyEvidenceScoringStatus.livePreferredOwnerOperatorSnapshot),
      'command-center/daily-scoring mismatch for livePreferredOwnerOperatorSnapshot'
    );
    assert(
      JSON.stringify(center.liveNextNaturalDayTerminalStatus)
      === JSON.stringify(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus),
      'command-center/daily-scoring mismatch for liveNextNaturalDayTerminalStatus'
    );
    assert(
      String(center.liveNextNaturalDayTerminalBanner?.boundedResult || '')
      === String(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus?.result || ''),
      'command-center banner boundedResult should mirror daily-scoring terminal status result'
    );
    assert(
      String(center.liveNextNaturalDayTerminalBanner?.firstMissingLayer || '')
      === String(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus?.firstMissingLayer || ''),
      'command-center banner firstMissingLayer should mirror daily-scoring terminal status'
    );
    assert(
      String(center.liveNextNaturalDayTerminalBanner?.targetTradingDay || '')
      === String(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalStatus?.targetTradingDay || ''),
      'command-center banner targetTradingDay should mirror daily-scoring terminal status'
    );
    assert(
      Boolean(center.liveNextNaturalDayDiscoveredInPersistedData)
      === Boolean(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayDiscoveredInPersistedData),
      'command-center/daily-scoring mismatch for liveNextNaturalDayDiscoveredInPersistedData'
    );
    assert(
      Boolean(center.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay)
      === Boolean(statusOut.dailyEvidenceScoringStatus.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay),
      'command-center/daily-scoring mismatch for liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay'
    );
    assert(center?.todayRecommendation && typeof center.todayRecommendation === 'object', 'command-center missing todayRecommendation');
    assert(center?.decisionBoard && typeof center.decisionBoard === 'object', 'command-center missing decisionBoard');
    assert(
      center.todayRecommendation.livePreferredOwnerOperatorSnapshot
        && typeof center.todayRecommendation.livePreferredOwnerOperatorSnapshot === 'object',
      'todayRecommendation missing livePreferredOwnerOperatorSnapshot'
    );
    assert(
      center.decisionBoard.livePreferredOwnerOperatorSnapshot
        && typeof center.decisionBoard.livePreferredOwnerOperatorSnapshot === 'object',
      'decisionBoard missing livePreferredOwnerOperatorSnapshot'
    );
    assert(
      JSON.stringify(center.todayRecommendation.livePreferredOwnerOperatorSnapshot)
      === JSON.stringify(center.livePreferredOwnerOperatorSnapshot),
      'todayRecommendation should mirror command-center livePreferredOwnerOperatorSnapshot'
    );
    assert(
      JSON.stringify(center.decisionBoard.livePreferredOwnerOperatorSnapshot)
      === JSON.stringify(center.livePreferredOwnerOperatorSnapshot),
      'decisionBoard should mirror command-center livePreferredOwnerOperatorSnapshot'
    );
    assert(
      JSON.stringify(center.todayRecommendation.liveNextNaturalDayTerminalStatus)
      === JSON.stringify(center.liveNextNaturalDayTerminalStatus),
      'todayRecommendation should mirror command-center liveNextNaturalDayTerminalStatus'
    );
    assert(
      JSON.stringify(center.decisionBoard.liveNextNaturalDayTerminalStatus)
      === JSON.stringify(center.liveNextNaturalDayTerminalStatus),
      'decisionBoard should mirror command-center liveNextNaturalDayTerminalStatus'
    );
    assert(
      JSON.stringify(center.todayRecommendation.liveNextNaturalDayTerminalBanner)
      === JSON.stringify(center.liveNextNaturalDayTerminalBanner),
      'todayRecommendation should mirror command-center liveNextNaturalDayTerminalBanner'
    );
    assert(
      Boolean(center.todayRecommendation.liveNextNaturalDayDiscoveredInPersistedData)
      === Boolean(center.liveNextNaturalDayDiscoveredInPersistedData),
      'todayRecommendation should mirror command-center liveNextNaturalDayDiscoveredInPersistedData'
    );
    assert(
      Boolean(center.todayRecommendation.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay)
      === Boolean(center.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay),
      'todayRecommendation should mirror command-center liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay'
    );
    assert(
      JSON.stringify(center.decisionBoard.liveNextNaturalDayTerminalBanner)
      === JSON.stringify(center.liveNextNaturalDayTerminalBanner),
      'decisionBoard should mirror command-center liveNextNaturalDayTerminalBanner'
    );
    assert(
      Boolean(center.decisionBoard.liveNextNaturalDayDiscoveredInPersistedData)
      === Boolean(center.liveNextNaturalDayDiscoveredInPersistedData),
      'decisionBoard should mirror command-center liveNextNaturalDayDiscoveredInPersistedData'
    );
    assert(
      Boolean(center.decisionBoard.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay)
      === Boolean(center.liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay),
      'decisionBoard should mirror command-center liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay'
    );
    assert(
      String(center.todayRecommendation.livePreferredOwnerPostCloseProofVerifierStatus || '')
      === String(center.livePreferredOwnerPostCloseProofVerifierStatus || ''),
      'todayRecommendation should mirror command-center post-close verifier status'
    );
    assert(
      Boolean(center.todayRecommendation.livePreferredOwnerPostCloseProofVerifierPass)
      === Boolean(center.livePreferredOwnerPostCloseProofVerifierPass),
      'todayRecommendation should mirror command-center post-close verifier pass'
    );
    assert(
      Number(center.todayRecommendation.livePreferredOwnerPostCloseProofVerifierRunId || 0)
      === Number(center.livePreferredOwnerPostCloseProofVerifierRunId || 0),
      'todayRecommendation should mirror command-center post-close verifier run id'
    );
    assert(
      String(center.todayRecommendation.livePreferredOwnerOperationalProofBundleVerifierStatus || '')
      === String(center.livePreferredOwnerOperationalProofBundleVerifierStatus || ''),
      'todayRecommendation should mirror command-center proof-bundle verifier status'
    );
    assert(
      Boolean(center.todayRecommendation.livePreferredOwnerOperationalProofBundleVerifierPass)
      === Boolean(center.livePreferredOwnerOperationalProofBundleVerifierPass),
      'todayRecommendation should mirror command-center proof-bundle verifier pass'
    );
    assert(
      String(center.todayRecommendation.livePreferredOwnerMonitorLatestSummaryLabel || '')
      === String(center.livePreferredOwnerMonitorLatestSummaryLabel || ''),
      'todayRecommendation should mirror command-center preferred-owner monitor summary label'
    );
    assert(
      Boolean(center.todayRecommendation.livePreferredOwnerMonitorConsistent)
      === Boolean(center.livePreferredOwnerMonitorConsistent),
      'todayRecommendation should mirror command-center preferred-owner monitor consistency flag'
    );
    assert(
      Boolean(center.todayRecommendation.livePreferredOwnerMonitorResolvedSuccess)
      === Boolean(center.livePreferredOwnerMonitorResolvedSuccess),
      'todayRecommendation should mirror command-center preferred-owner monitor resolved-success flag'
    );
    assert(
      String(center.decisionBoard.livePreferredOwnerPostCloseProofVerifierStatus || '')
      === String(center.livePreferredOwnerPostCloseProofVerifierStatus || ''),
      'decisionBoard should mirror command-center post-close verifier status'
    );
    assert(
      Boolean(center.decisionBoard.livePreferredOwnerPostCloseProofVerifierPass)
      === Boolean(center.livePreferredOwnerPostCloseProofVerifierPass),
      'decisionBoard should mirror command-center post-close verifier pass'
    );
    assert(
      Number(center.decisionBoard.livePreferredOwnerPostCloseProofVerifierRunId || 0)
      === Number(center.livePreferredOwnerPostCloseProofVerifierRunId || 0),
      'decisionBoard should mirror command-center post-close verifier run id'
    );
    assert(
      String(center.decisionBoard.livePreferredOwnerOperationalProofBundleVerifierStatus || '')
      === String(center.livePreferredOwnerOperationalProofBundleVerifierStatus || ''),
      'decisionBoard should mirror command-center proof-bundle verifier status'
    );
    assert(
      Boolean(center.decisionBoard.livePreferredOwnerOperationalProofBundleVerifierPass)
      === Boolean(center.livePreferredOwnerOperationalProofBundleVerifierPass),
      'decisionBoard should mirror command-center proof-bundle verifier pass'
    );
    assert(
      String(center.decisionBoard.livePreferredOwnerMonitorLatestSummaryLabel || '')
      === String(center.livePreferredOwnerMonitorLatestSummaryLabel || ''),
      'decisionBoard should mirror command-center preferred-owner monitor summary label'
    );
    assert(
      Boolean(center.decisionBoard.livePreferredOwnerMonitorConsistent)
      === Boolean(center.livePreferredOwnerMonitorConsistent),
      'decisionBoard should mirror command-center preferred-owner monitor consistency flag'
    );
    assert(
      Boolean(center.decisionBoard.livePreferredOwnerMonitorResolvedSuccess)
      === Boolean(center.livePreferredOwnerMonitorResolvedSuccess),
      'decisionBoard should mirror command-center preferred-owner monitor resolved-success flag'
    );
    assert(
      statusOut.dailyEvidenceScoringStatus.liveRuntimeIntegrityMonitor
        && typeof statusOut.dailyEvidenceScoringStatus.liveRuntimeIntegrityMonitor === 'object',
      'daily-scoring missing liveRuntimeIntegrityMonitor'
    );
    assert(
      center.liveRuntimeIntegrityMonitor
        && typeof center.liveRuntimeIntegrityMonitor === 'object',
      'command-center missing liveRuntimeIntegrityMonitor'
    );
    const dailyRuntimeMonitor = statusOut.dailyEvidenceScoringStatus.liveRuntimeIntegrityMonitor;
    const centerRuntimeMonitor = center.liveRuntimeIntegrityMonitor;
    assert(
      String(centerRuntimeMonitor.runtimeFreshnessStatus || '')
      === String(dailyRuntimeMonitor.runtimeFreshnessStatus || ''),
      'command-center/daily-scoring mismatch for runtimeFreshnessStatus'
    );
    assert(
      String(centerRuntimeMonitor.autoRepairStatus || '')
      === String(dailyRuntimeMonitor.autoRepairStatus || ''),
      'command-center/daily-scoring mismatch for autoRepairStatus'
    );
    assert(
      String(centerRuntimeMonitor.tpGuardOriginalTp || '')
      === String(dailyRuntimeMonitor.tpGuardOriginalTp || ''),
      'command-center/daily-scoring mismatch for tpGuardOriginalTp'
    );
    assert(
      String(centerRuntimeMonitor.tpGuardFinalTp || '')
      === String(dailyRuntimeMonitor.tpGuardFinalTp || ''),
      'command-center/daily-scoring mismatch for tpGuardFinalTp'
    );
    assert(
      String(centerRuntimeMonitor.tpGuardReason || '')
      === String(dailyRuntimeMonitor.tpGuardReason || ''),
      'command-center/daily-scoring mismatch for tpGuardReason'
    );
    assert(
      String(centerRuntimeMonitor.latestIntegrityIssue || '')
      === String(dailyRuntimeMonitor.latestIntegrityIssue || ''),
      'command-center/daily-scoring mismatch for latestIntegrityIssue'
    );
    assert(
      String(centerRuntimeMonitor.latestRecommendationIssue || '')
      === String(dailyRuntimeMonitor.latestRecommendationIssue || ''),
      'command-center/daily-scoring mismatch for latestRecommendationIssue'
    );
    assert(
      JSON.stringify(center.todayRecommendation.liveRuntimeIntegrityMonitor)
      === JSON.stringify(center.liveRuntimeIntegrityMonitor),
      'todayRecommendation should mirror command-center liveRuntimeIntegrityMonitor'
    );
    assert(
      JSON.stringify(center.decisionBoard.liveRuntimeIntegrityMonitor)
      === JSON.stringify(center.liveRuntimeIntegrityMonitor),
      'decisionBoard should mirror command-center liveRuntimeIntegrityMonitor'
    );
    assert(
      RUNTIME_INTEGRITY_RUNTIME_FRESHNESS_STATUS_ENUM.includes(String(center.liveRuntimeFreshnessStatus || '')),
      'command-center liveRuntimeFreshnessStatus invalid'
    );
    assert(
      RUNTIME_INTEGRITY_AUTO_REPAIR_STATUS_ENUM.includes(String(center.liveRuntimeAutoRepairStatus || '')),
      'command-center liveRuntimeAutoRepairStatus invalid'
    );
    assert(
      RUNTIME_INTEGRITY_REPAIR_POLICY_ENUM.includes(String(center.liveRuntimeAutoRepairPolicyClass || '')),
      'command-center liveRuntimeAutoRepairPolicyClass invalid'
    );
    const runtimeIssueRows = Array.isArray(center.liveRuntimeIssueClassifications)
      ? center.liveRuntimeIssueClassifications
      : [];
    assert(runtimeIssueRows.length >= 3, 'command-center liveRuntimeIssueClassifications should include core policy rows');
    runtimeIssueRows.forEach((row) => {
      assert(
        RUNTIME_INTEGRITY_REPAIR_POLICY_ENUM.includes(String(row?.policyClass || '')),
        `runtime issue policyClass invalid: ${JSON.stringify(row)}`
      );
    });
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    await runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ daily evidence scoring checks passed');
  } catch (err) {
    console.error('❌ daily evidence scoring checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
