'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  toText,
} = require('./data-foundation-storage');
const {
  runPreferredOwnerNaturalDrill,
  PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_ENUM,
} = require('./preferred-owner-natural-drill');
const {
  LIVE_CHECKPOINT_STATUS_ENUM,
  LIVE_FINALIZATION_SWEEP_SOURCE_ENUM,
  DAILY_SCORING_RUN_ORIGIN_ENUM,
} = require('./daily-evidence-scoring');

const PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM = Object.freeze([
  'waiting_for_resolution',
  'triggered_and_executed',
  'already_executed_for_target_day',
  'resolved_but_not_close_complete_source',
  'resolved_but_drill_failed',
]);

const PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_SET = new Set(
  PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM
);
const DRILL_OUTCOME_SET = new Set(PREFERRED_OWNER_NATURAL_DRILL_OUTCOME_ENUM || []);
const RUN_ORIGIN_SET = new Set(DAILY_SCORING_RUN_ORIGIN_ENUM || []);
const CHECKPOINT_STATUS_SET = new Set(LIVE_CHECKPOINT_STATUS_ENUM || []);
const FINALIZATION_SOURCE_SET = new Set(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM || []);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isoDateOnly(value = '') {
  return normalizeDate(value || '') || null;
}

function normalizeFromSet(value, set, fallback) {
  const key = toText(value || '').trim().toLowerCase();
  if (key && set.has(key)) return key;
  return fallback;
}

function normalizeRunOrigin(value = '') {
  return normalizeFromSet(value, RUN_ORIGIN_SET, 'manual');
}

function normalizeCheckpointStatus(value = '') {
  return normalizeFromSet(value, CHECKPOINT_STATUS_SET, 'waiting_valid');
}

function normalizeRuntimeSource(value = '') {
  return normalizeFromSet(value, FINALIZATION_SOURCE_SET, 'manual_api_run');
}

function normalizeWatcherOutcome(value = '') {
  return normalizeFromSet(value, PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_SET, 'waiting_for_resolution');
}

function normalizeDrillOutcome(value = '') {
  return normalizeFromSet(value, DRILL_OUTCOME_SET, null);
}

function readWatcherRowByTargetDay(db, targetTradingDay = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const target = isoDateOnly(targetTradingDay);
  if (!target) return null;
  try {
    const row = db.prepare(`
      SELECT
        id,
        target_trading_day,
        trigger_run_id,
        trigger_run_origin,
        trigger_runtime_source,
        pre_transition_checkpoint_status,
        post_transition_checkpoint_status,
        drill_outcome,
        executed,
        executed_at,
        created_at
      FROM jarvis_preferred_owner_natural_drill_watch_runs
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target);
    if (!row) return null;
    return {
      id: toNumber(row.id, null),
      targetTradingDay: isoDateOnly(row.target_trading_day),
      triggerRunId: toNumber(row.trigger_run_id, null),
      triggerRunOrigin: normalizeRunOrigin(row.trigger_run_origin || 'manual'),
      triggerRuntimeSource: normalizeRuntimeSource(row.trigger_runtime_source || 'manual_api_run'),
      preTransitionCheckpointStatus: normalizeCheckpointStatus(
        row.pre_transition_checkpoint_status || 'waiting_valid'
      ),
      postTransitionCheckpointStatus: normalizeCheckpointStatus(
        row.post_transition_checkpoint_status || 'waiting_valid'
      ),
      drillOutcome: normalizeDrillOutcome(row.drill_outcome),
      executed: Number(row.executed || 0) === 1,
      executedAt: toText(row.executed_at || '') || null,
      createdAt: toText(row.created_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readLatestWatcherRow(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_natural_drill_watch_runs
      ORDER BY target_trading_day DESC, id DESC
      LIMIT 1
    `).get();
    if (!row?.target_trading_day) return null;
    return readWatcherRowByTargetDay(db, row.target_trading_day);
  } catch {
    return null;
  }
}

function readPriorNaturalCheckpointStatusForTargetDay(db, targetTradingDay = '', beforeRunId = null) {
  if (!db || typeof db.prepare !== 'function') return 'waiting_valid';
  const target = isoDateOnly(targetTradingDay);
  if (!target) return 'waiting_valid';
  const limitRunId = toNumber(beforeRunId, 0);
  let rows = [];
  try {
    if (limitRunId > 0) {
      rows = db.prepare(`
        SELECT id, details_json
        FROM jarvis_daily_scoring_runs
        WHERE lower(run_origin) = 'natural' AND id < ?
        ORDER BY id DESC
        LIMIT 80
      `).all(limitRunId);
    } else {
      rows = db.prepare(`
        SELECT id, details_json
        FROM jarvis_daily_scoring_runs
        WHERE lower(run_origin) = 'natural'
        ORDER BY id DESC
        LIMIT 80
      `).all();
    }
  } catch {
    return 'waiting_valid';
  }
  for (const row of rows) {
    let details = {};
    try { details = JSON.parse(String(row?.details_json || '{}')); } catch {}
    const checkpoint = details?.liveCheckpoint && typeof details.liveCheckpoint === 'object'
      ? details.liveCheckpoint
      : {};
    const checkpointTarget = isoDateOnly(checkpoint.targetTradingDay || '');
    if (checkpointTarget !== target) continue;
    return normalizeCheckpointStatus(checkpoint.checkpointStatus || 'waiting_valid');
  }
  return 'waiting_valid';
}

function persistWatcherRow(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const targetTradingDay = isoDateOnly(input.targetTradingDay || '');
  if (!targetTradingDay) return null;
  const triggerRunId = toNumber(input.triggerRunId, null);
  const triggerRunOrigin = normalizeRunOrigin(input.triggerRunOrigin || 'manual');
  const triggerRuntimeSource = normalizeRuntimeSource(input.triggerRuntimeSource || 'manual_api_run');
  const preTransitionCheckpointStatus = normalizeCheckpointStatus(
    input.preTransitionCheckpointStatus || 'waiting_valid'
  );
  const postTransitionCheckpointStatus = normalizeCheckpointStatus(
    input.postTransitionCheckpointStatus || 'waiting_valid'
  );
  const drillOutcome = normalizeDrillOutcome(input.drillOutcome || null);
  const executed = input.executed === true ? 1 : 0;
  const executedAt = toText(input.executedAt || '') || null;
  let existingId = null;
  try {
    const existing = db.prepare(`
      SELECT id
      FROM jarvis_preferred_owner_natural_drill_watch_runs
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(targetTradingDay);
    existingId = toNumber(existing?.id, null);
  } catch {}
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_natural_drill_watch_runs (
        target_trading_day,
        trigger_run_id,
        trigger_run_origin,
        trigger_runtime_source,
        pre_transition_checkpoint_status,
        post_transition_checkpoint_status,
        drill_outcome,
        executed,
        executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_trading_day) DO NOTHING
    `).run(
      targetTradingDay,
      triggerRunId,
      triggerRunOrigin,
      triggerRuntimeSource,
      preTransitionCheckpointStatus,
      postTransitionCheckpointStatus,
      drillOutcome,
      executed,
      executedAt
    );
  } catch {
    return null;
  }
  const row = readWatcherRowByTargetDay(db, targetTradingDay);
  if (!row) return null;
  return {
    ...row,
    wasNewRowPersisted: existingId === null,
    previousRowId: existingId,
    advisoryOnly: true,
  };
}

function runPreferredOwnerNaturalDrillWatcher(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'waiting_for_resolution',
      outcome: 'waiting_for_resolution',
      targetTradingDay: null,
      executed: false,
      executedAt: null,
      drillOutcome: null,
      reason: 'storage_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDataFoundationTables(db);
  const currentRun = input.currentRun && typeof input.currentRun === 'object'
    ? input.currentRun
    : {};
  const checkpoint = currentRun.liveCheckpoint && typeof currentRun.liveCheckpoint === 'object'
    ? currentRun.liveCheckpoint
    : {};
  const targetTradingDay = isoDateOnly(
    input.targetTradingDay
    || checkpoint.targetTradingDay
    || currentRun.liveCheckpointTargetTradingDay
    || currentRun.liveInsertionSlaTargetTradingDay
    || input.nowDate
    || ''
  );
  const checkpointStatus = normalizeCheckpointStatus(
    checkpoint.checkpointStatus
    || currentRun.liveCheckpointStatus
    || 'waiting_valid'
  );
  const runtimeSource = normalizeRuntimeSource(
    checkpoint.runtimeCheckpointSource
    || checkpoint.sweepSource
    || currentRun.liveRuntimeCheckpointSource
    || 'manual_api_run'
  );
  const triggerRunId = toNumber(currentRun.runId, null);
  const triggerRunOrigin = normalizeRunOrigin(currentRun.runOrigin || input.runOrigin || 'manual');
  const force = input.force === true;
  const runtimeTriggered = input.runtimeTriggered === true;
  const isNaturalRun = triggerRunOrigin === 'natural' && runtimeTriggered && !force;

  if (!targetTradingDay) {
    return {
      status: 'waiting_for_resolution',
      outcome: 'waiting_for_resolution',
      targetTradingDay: null,
      executed: false,
      executedAt: null,
      drillOutcome: null,
      reason: 'target_day_missing',
      advisoryOnly: true,
    };
  }

  const existing = readWatcherRowByTargetDay(db, targetTradingDay);
  if (existing) {
    return {
      status: 'already_executed_for_target_day',
      outcome: 'already_executed_for_target_day',
      targetTradingDay,
      executed: existing.executed === true,
      executedAt: existing.executedAt || existing.createdAt || null,
      drillOutcome: existing.drillOutcome || null,
      triggerRunId: existing.triggerRunId,
      triggerRunOrigin: existing.triggerRunOrigin,
      triggerRuntimeSource: existing.triggerRuntimeSource,
      preTransitionCheckpointStatus: existing.preTransitionCheckpointStatus,
      postTransitionCheckpointStatus: existing.postTransitionCheckpointStatus,
      watcherRow: existing,
      reason: 'already_recorded',
      advisoryOnly: true,
    };
  }

  if (!isNaturalRun || checkpointStatus === 'waiting_valid') {
    return {
      status: 'waiting_for_resolution',
      outcome: 'waiting_for_resolution',
      targetTradingDay,
      executed: false,
      executedAt: null,
      drillOutcome: null,
      triggerRunId,
      triggerRunOrigin,
      triggerRuntimeSource: runtimeSource,
      preTransitionCheckpointStatus: readPriorNaturalCheckpointStatusForTargetDay(db, targetTradingDay, triggerRunId),
      postTransitionCheckpointStatus: checkpointStatus,
      reason: !isNaturalRun ? 'run_not_natural' : 'checkpoint_not_resolved',
      advisoryOnly: true,
    };
  }

  const preTransitionCheckpointStatus = readPriorNaturalCheckpointStatusForTargetDay(
    db,
    targetTradingDay,
    triggerRunId
  );
  const postTransitionCheckpointStatus = checkpointStatus;

  if (runtimeSource !== 'close_complete_checkpoint') {
    const persisted = persistWatcherRow(db, {
      targetTradingDay,
      triggerRunId,
      triggerRunOrigin,
      triggerRuntimeSource: runtimeSource,
      preTransitionCheckpointStatus,
      postTransitionCheckpointStatus,
      drillOutcome: null,
      executed: false,
      executedAt: null,
    });
    return {
      status: 'resolved_but_not_close_complete_source',
      outcome: 'resolved_but_not_close_complete_source',
      targetTradingDay,
      executed: false,
      executedAt: null,
      drillOutcome: null,
      triggerRunId,
      triggerRunOrigin,
      triggerRuntimeSource: runtimeSource,
      preTransitionCheckpointStatus,
      postTransitionCheckpointStatus,
      watcherRow: persisted,
      reason: 'runtime_source_not_close_complete_checkpoint',
      advisoryOnly: true,
    };
  }

  const drillRunner = typeof input.drillRunner === 'function'
    ? input.drillRunner
    : runPreferredOwnerNaturalDrill;

  let drillResult = null;
  let drillOutcome = null;
  let watcherOutcome = 'triggered_and_executed';
  let executed = true;
  let error = null;
  const executedAt = new Date().toISOString();

  try {
    if (input.forceDrillFailure === true) {
      throw new Error('forced_drill_failure');
    }
    drillResult = drillRunner({
      db,
      sessions: input.sessions,
      nowDate: input.nowDate || targetTradingDay,
      nowTime: input.nowTime || '18:10',
      windowDays: Number(input.windowDays || 5) || 5,
      targetTradingDay,
      force: false,
      statusBefore: input.statusBefore && typeof input.statusBefore === 'object'
        ? input.statusBefore
        : undefined,
    });
    drillOutcome = normalizeDrillOutcome(drillResult?.drillOutcome || null);
    if (drillOutcome === 'resolved_but_bundle_missing_bug') {
      watcherOutcome = 'resolved_but_drill_failed';
    }
  } catch (err) {
    watcherOutcome = 'resolved_but_drill_failed';
    drillOutcome = 'resolved_but_bundle_missing_bug';
    error = err?.message || 'drill_failed';
  }

  const persisted = persistWatcherRow(db, {
    targetTradingDay,
    triggerRunId,
    triggerRunOrigin,
    triggerRuntimeSource: runtimeSource,
    preTransitionCheckpointStatus,
    postTransitionCheckpointStatus,
    drillOutcome,
    executed,
    executedAt,
  });

  return {
    status: normalizeWatcherOutcome(watcherOutcome),
    outcome: normalizeWatcherOutcome(watcherOutcome),
    targetTradingDay,
    executed,
    executedAt,
    drillOutcome,
    triggerRunId,
    triggerRunOrigin,
    triggerRuntimeSource: runtimeSource,
    preTransitionCheckpointStatus,
    postTransitionCheckpointStatus,
    watcherRow: persisted,
    drillResult,
    error,
    advisoryOnly: true,
  };
}

module.exports = {
  PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM,
  runPreferredOwnerNaturalDrillWatcher,
  readWatcherRowByTargetDay,
  readLatestWatcherRow,
};
