'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
} = require('./data-foundation-storage');

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

const NEXT_NATURAL_DAY_WATCHDOG_PIPELINE_STATE_ENUM = Object.freeze([
  'waiting',
  'broken',
  'healthy',
]);

const NEXT_NATURAL_DAY_WATCHDOG_TERMINAL_ALERT_TYPE_ENUM = Object.freeze([
  'success',
  'failure',
]);

const RESULT_SET = new Set(NEXT_NATURAL_DAY_READINESS_RESULT_ENUM);
const PIPELINE_STATE_SET = new Set(NEXT_NATURAL_DAY_WATCHDOG_PIPELINE_STATE_ENUM);
const TERMINAL_ALERT_TYPE_SET = new Set(NEXT_NATURAL_DAY_WATCHDOG_TERMINAL_ALERT_TYPE_ENUM);
const CHECKPOINT_STATUS_SET = new Set([
  'success_inserted',
  'success_already_finalized',
  'blocked_invalid_day',
  'failure_missing_context',
  'failure_missing_market_data',
  'failure_scheduler_miss',
  'failure_duplicate_state',
  'failure_unknown',
  'waiting_valid',
]);

const WAITING_RESULT_SET = new Set([
  'next_natural_day_not_in_data_yet',
  'next_natural_day_in_data_not_seen_in_scoring',
  'next_natural_day_seen_but_not_resolved',
]);

const TERMINAL_FAILURE_RESULT_SET = new Set([
  'next_natural_day_resolved_but_missing_ownership',
  'next_natural_day_missing_preferred_owner_proof',
  'next_natural_day_missing_verifier',
  'next_natural_day_missing_natural_win',
  'next_natural_day_missing_operational_verdict',
  'next_natural_day_missing_proof_bundle',
]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeFromSet(value, set, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized && set.has(normalized)) return normalized;
  return fallback;
}

function normalizeResult(value = '') {
  return normalizeFromSet(
    value,
    RESULT_SET,
    'next_natural_day_not_in_data_yet'
  );
}

function normalizeCheckpointStatus(value = '') {
  return normalizeFromSet(value, CHECKPOINT_STATUS_SET, 'waiting_valid');
}

function normalizePipelineState(value = '') {
  return normalizeFromSet(value, PIPELINE_STATE_SET, 'waiting');
}

function normalizeTerminalAlertType(value = '') {
  return normalizeFromSet(value, TERMINAL_ALERT_TYPE_SET, 'failure');
}

function isoNow() {
  return new Date().toISOString();
}

function classifyTradingDaySafe(input = {}) {
  try {
    // Lazy load to avoid circular dependency during module initialization.
    const { classifyTradingDay } = require('./daily-evidence-scoring');
    if (typeof classifyTradingDay === 'function') return classifyTradingDay(input);
  } catch {}
  const date = normalizeDate(input?.date || '');
  if (!date) return { classification: 'invalid_mapping' };
  const dt = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime())) return { classification: 'invalid_mapping' };
  const weekday = dt.getUTCDay();
  if (weekday === 0 || weekday === 6) return { classification: 'non_trading_day' };
  return { classification: 'valid_trading_day' };
}

function loadSessionRowsByDate(db, date = '') {
  const target = normalizeDate(date || '');
  if (!target) return [];
  try {
    return db.prepare(`
      SELECT c.timestamp, c.open, c.high, c.low, c.close, c.volume
      FROM candles c
      JOIN sessions s ON s.id = c.session_id
      WHERE s.date = ?
      ORDER BY c.timestamp ASC
    `).all(target) || [];
  } catch {
    return [];
  }
}

function readLatestNaturalTradingDayInData(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT s.date AS session_date, COUNT(c.id) AS candle_rows
      FROM sessions s
      JOIN candles c ON c.session_id = s.id
      GROUP BY s.date
      ORDER BY s.date DESC
    `).all();
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const day = normalizeDate(row?.session_date || '');
    const candleRows = toNumber(row?.candle_rows, 0);
    if (!day || candleRows <= 0) continue;
    const classification = classifyTradingDaySafe({
      date: day,
      sessionForDate: [{}],
    });
    if (String(classification.classification || '') !== 'valid_trading_day') continue;
    return day;
  }
  return null;
}

function readNextNaturalTradingDayAfterBaseline(db, { baselineDate = null } = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const baseline = normalizeDate(baselineDate || '');
  if (!baseline) return null;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT s.date AS session_date, COUNT(c.id) AS candle_rows
      FROM sessions s
      JOIN candles c ON c.session_id = s.id
      WHERE s.date > ?
      GROUP BY s.date
      ORDER BY s.date ASC
    `).all(baseline);
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const day = normalizeDate(row?.session_date || '');
    const candleRows = toNumber(row?.candle_rows, 0);
    if (!day || candleRows <= 0) continue;
    const classification = classifyTradingDaySafe({
      date: day,
      sessionForDate: [{}],
    });
    if (String(classification.classification || '') !== 'valid_trading_day') continue;
    return day;
  }
  return null;
}

function readLatestFullyCompletedPreferredOwnerDay(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT p.target_trading_day AS target_day
      FROM jarvis_live_preferred_owner_proof p
      JOIN jarvis_preferred_owner_post_close_verifier v
        ON v.target_trading_day = p.target_trading_day
      JOIN jarvis_preferred_owner_operational_verdicts ov
        ON ov.target_trading_day = p.target_trading_day
      JOIN jarvis_preferred_owner_operational_proof_bundles pb
        ON pb.target_trading_day = p.target_trading_day
      WHERE lower(v.checkpoint_status) != 'waiting_valid'
      ORDER BY p.target_trading_day DESC
      LIMIT 1
    `).get();
    return normalizeDate(row?.target_day || '') || null;
  } catch {
    return null;
  }
}

function readDailyScoringRowsForTarget(db, targetTradingDay = '') {
  const day = normalizeDate(targetTradingDay || '');
  if (!day) return [];
  try {
    return db.prepare(`
      SELECT
        id,
        run_date,
        mode,
        run_origin,
        created_at,
        json_extract(details_json, '$.liveCheckpoint.targetTradingDay') AS target_day,
        json_extract(details_json, '$.liveCheckpoint.checkpointStatus') AS checkpoint_status,
        json_extract(details_json, '$.liveCheckpoint.runtimeCheckpointSource') AS runtime_source
      FROM jarvis_daily_scoring_runs
      WHERE json_extract(details_json, '$.liveCheckpoint.targetTradingDay') = ?
      ORDER BY id DESC
    `).all(day) || [];
  } catch {
    return [];
  }
}

function readSingleRowByDay(db, table, targetTradingDay = '') {
  const day = normalizeDate(targetTradingDay || '');
  if (!day) return null;
  try {
    return db.prepare(`
      SELECT *
      FROM ${table}
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(day) || null;
  } catch {
    return null;
  }
}

function readLatestDeferralByDay(db, targetTradingDay = '') {
  const day = normalizeDate(targetTradingDay || '');
  if (!day) return null;
  try {
    return db.prepare(`
      SELECT *
      FROM jarvis_preferred_owner_deferrals
      WHERE target_trading_day = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(day) || null;
  } catch {
    return null;
  }
}

function evaluateResultForNextDay(input = {}) {
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  const scoringRows = Array.isArray(input.scoringRows) ? input.scoringRows : [];
  const ownershipRow = input.ownershipRow || null;
  const proofRow = input.proofRow || null;
  const verifierRow = input.verifierRow || null;
  const naturalWinRow = input.naturalWinRow || null;
  const verdictRow = input.verdictRow || null;
  const bundleRow = input.bundleRow || null;

  const scoringSeen = scoringRows.length > 0;
  const resolved = scoringRows.some((row) => (
    normalizeCheckpointStatus(row?.checkpoint_status || '') !== 'waiting_valid'
  ));
  const closeCompleteRan = scoringRows.some((row) => (
    String(row?.run_origin || '').toLowerCase() === 'natural'
    && String(row?.runtime_source || '').toLowerCase() === 'close_complete_checkpoint'
  ));
  const preferredOwnerWon = toBool(proofRow?.preferred_owner_won);

  let result = 'next_natural_day_fully_completed';
  let firstMissingLayer = 'none';
  if (!scoringSeen) {
    result = 'next_natural_day_in_data_not_seen_in_scoring';
    firstMissingLayer = 'jarvis_daily_scoring_runs';
  } else if (!resolved) {
    result = 'next_natural_day_seen_but_not_resolved';
    firstMissingLayer = 'checkpoint_resolution';
  } else if (!ownershipRow) {
    result = 'next_natural_day_resolved_but_missing_ownership';
    firstMissingLayer = 'jarvis_live_outcome_ownership';
  } else if (!proofRow) {
    result = 'next_natural_day_missing_preferred_owner_proof';
    firstMissingLayer = 'jarvis_live_preferred_owner_proof';
  } else if (!verifierRow) {
    result = 'next_natural_day_missing_verifier';
    firstMissingLayer = 'jarvis_preferred_owner_post_close_verifier';
  } else if (preferredOwnerWon && !naturalWinRow) {
    result = 'next_natural_day_missing_natural_win';
    firstMissingLayer = 'jarvis_preferred_owner_natural_wins';
  } else if (!verdictRow) {
    result = 'next_natural_day_missing_operational_verdict';
    firstMissingLayer = 'jarvis_preferred_owner_operational_verdicts';
  } else if (!bundleRow) {
    result = 'next_natural_day_missing_proof_bundle';
    firstMissingLayer = 'jarvis_preferred_owner_operational_proof_bundles';
  }

  return {
    targetTradingDay: targetTradingDay || null,
    result: normalizeResult(result),
    firstMissingLayer,
    scoringSeen,
    resolved,
    closeCompleteRan,
    preferredOwnerWon,
    advisoryOnly: true,
  };
}

function classifyPipelineStateFromResult(result = '') {
  const normalized = normalizeResult(result);
  if (normalized === 'next_natural_day_fully_completed') return 'healthy';
  if (WAITING_RESULT_SET.has(normalized)) return 'waiting';
  return 'broken';
}

function resolveTerminalAlertTypeFromResult(result = '') {
  const normalized = normalizeResult(result);
  if (normalized === 'next_natural_day_fully_completed') return 'success';
  if (TERMINAL_FAILURE_RESULT_SET.has(normalized)) return 'failure';
  return null;
}

function readWatchdogStateRow(db, { baselineDate = '', targetTradingDay = '' } = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const baseline = normalizeDate(baselineDate || '');
  const target = normalizeDate(targetTradingDay || '');
  if (!baseline || !target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        baseline_date,
        target_trading_day,
        first_seen_at,
        latest_checked_at,
        current_result,
        first_missing_layer,
        completed,
        completed_at,
        alert_emitted,
        created_at,
        updated_at
      FROM jarvis_preferred_owner_next_natural_day_watchdog
      WHERE baseline_date = ?
        AND target_trading_day = ?
      LIMIT 1
    `).get(baseline, target) || null;
  } catch {
    return null;
  }
}

function readLatestWatchdogStateRowByBaseline(db, baselineDate = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const baseline = normalizeDate(baselineDate || '');
  if (!baseline) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        baseline_date,
        target_trading_day,
        first_seen_at,
        latest_checked_at,
        current_result,
        first_missing_layer,
        completed,
        completed_at,
        alert_emitted,
        created_at,
        updated_at
      FROM jarvis_preferred_owner_next_natural_day_watchdog
      WHERE baseline_date = ?
      ORDER BY target_trading_day DESC, id DESC
      LIMIT 1
    `).get(baseline) || null;
  } catch {
    return null;
  }
}

function readTerminalAlertRow(db, { baselineDate = '', targetTradingDay = '' } = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const baseline = normalizeDate(baselineDate || '');
  const target = normalizeDate(targetTradingDay || '');
  if (!baseline || !target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        baseline_date,
        target_trading_day,
        alert_type,
        result,
        first_missing_layer,
        pipeline_state,
        emitted_at,
        created_at
      FROM jarvis_preferred_owner_next_natural_day_watchdog_alerts
      WHERE baseline_date = ?
        AND target_trading_day = ?
      LIMIT 1
    `).get(baseline, target) || null;
  } catch {
    return null;
  }
}

function readLatestTerminalAlertRowByBaseline(db, baselineDate = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const baseline = normalizeDate(baselineDate || '');
  if (!baseline) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        baseline_date,
        target_trading_day,
        alert_type,
        result,
        first_missing_layer,
        pipeline_state,
        emitted_at,
        created_at
      FROM jarvis_preferred_owner_next_natural_day_watchdog_alerts
      WHERE baseline_date = ?
      ORDER BY target_trading_day DESC, id DESC
      LIMIT 1
    `).get(baseline) || null;
  } catch {
    return null;
  }
}

function persistWatchdogStateRow(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const baselineDate = normalizeDate(input.baselineDate || '');
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!baselineDate || !targetTradingDay) return null;
  const firstSeenAt = String(input.firstSeenAt || '').trim() || null;
  const latestCheckedAt = String(input.latestCheckedAt || '').trim() || isoNow();
  const currentResult = normalizeResult(input.currentResult || '');
  const firstMissingLayer = String(input.firstMissingLayer || '').trim() || 'none';
  const completed = input.completed === true ? 1 : 0;
  const completedAt = String(input.completedAt || '').trim() || null;
  const alertEmitted = input.alertEmitted === true ? 1 : 0;
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_next_natural_day_watchdog (
        baseline_date,
        target_trading_day,
        first_seen_at,
        latest_checked_at,
        current_result,
        first_missing_layer,
        completed,
        completed_at,
        alert_emitted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(baseline_date, target_trading_day) DO UPDATE SET
        latest_checked_at = excluded.latest_checked_at,
        current_result = excluded.current_result,
        first_missing_layer = excluded.first_missing_layer,
        completed = excluded.completed,
        completed_at = COALESCE(jarvis_preferred_owner_next_natural_day_watchdog.completed_at, excluded.completed_at),
        alert_emitted = excluded.alert_emitted,
        updated_at = datetime('now')
    `).run(
      baselineDate,
      targetTradingDay,
      firstSeenAt,
      latestCheckedAt,
      currentResult,
      firstMissingLayer,
      completed,
      completedAt,
      alertEmitted
    );
  } catch {
    return null;
  }
  return readWatchdogStateRow(db, { baselineDate, targetTradingDay });
}

function persistTerminalAlertRow(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const baselineDate = normalizeDate(input.baselineDate || '');
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!baselineDate || !targetTradingDay) return null;
  const alertType = normalizeTerminalAlertType(input.alertType || 'failure');
  const result = normalizeResult(input.result || '');
  const firstMissingLayer = String(input.firstMissingLayer || '').trim() || 'none';
  const pipelineState = normalizePipelineState(input.pipelineState || 'broken');
  const emittedAt = String(input.emittedAt || '').trim() || isoNow();
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_next_natural_day_watchdog_alerts (
        baseline_date,
        target_trading_day,
        alert_type,
        result,
        first_missing_layer,
        pipeline_state,
        emitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(baseline_date, target_trading_day) DO NOTHING
    `).run(
      baselineDate,
      targetTradingDay,
      alertType,
      result,
      firstMissingLayer,
      pipelineState,
      emittedAt
    );
  } catch {
    return null;
  }
  return readTerminalAlertRow(db, { baselineDate, targetTradingDay });
}

function toWatchdogStateRowOutput(row) {
  if (!row || typeof row !== 'object') return null;
  const completed = toBool(row.completed);
  const completedAt = String(row.completed_at || '').trim() || null;
  let latestCheckedAt = String(row.latest_checked_at || '').trim() || null;
  let updatedAt = String(row.updated_at || '').trim() || null;
  if (completed && completedAt) {
    latestCheckedAt = completedAt;
    updatedAt = completedAt;
  }
  return {
    id: toNumber(row.id, null),
    baselineDate: normalizeDate(row.baseline_date || '') || null,
    targetTradingDay: normalizeDate(row.target_trading_day || '') || null,
    firstSeenAt: String(row.first_seen_at || '').trim() || null,
    latestCheckedAt,
    currentResult: normalizeResult(row.current_result || ''),
    firstMissingLayer: String(row.first_missing_layer || '').trim() || 'none',
    completed,
    completedAt,
    alertEmitted: toBool(row.alert_emitted),
    createdAt: String(row.created_at || '').trim() || null,
    updatedAt,
    advisoryOnly: true,
  };
}

function toTerminalAlertRowOutput(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: toNumber(row.id, null),
    baselineDate: normalizeDate(row.baseline_date || '') || null,
    targetTradingDay: normalizeDate(row.target_trading_day || '') || null,
    alertType: normalizeTerminalAlertType(row.alert_type || 'failure'),
    result: normalizeResult(row.result || ''),
    firstMissingLayer: String(row.first_missing_layer || '').trim() || 'none',
    pipelineState: normalizePipelineState(row.pipeline_state || 'broken'),
    emittedAt: String(row.emitted_at || '').trim() || null,
    createdAt: String(row.created_at || '').trim() || null,
    advisoryOnly: true,
  };
}

function runNextNaturalDayReadinessWatchdog(input = {}) {
  const db = input.db;
  const baselineDate = normalizeDate(input.baselineDate || '2026-03-13') || '2026-03-13';
  if (!db || typeof db.prepare !== 'function') {
    return {
      baselineDate,
      nextNaturalTradingDayAfterBaseline: null,
      latestActualNaturalTradingDayInData: null,
      latestFullyCompletedPreferredOwnerDay: null,
      result: normalizeResult('next_natural_day_not_in_data_yet'),
      firstMissingLayer: 'sessions',
      systemState: 'waiting_for_next_day',
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);

  const nextNaturalDay = readNextNaturalTradingDayAfterBaseline(db, { baselineDate });
  const latestActualNaturalTradingDayInData = readLatestNaturalTradingDayInData(db);
  const latestFullyCompletedPreferredOwnerDay = readLatestFullyCompletedPreferredOwnerDay(db);

  if (!nextNaturalDay) {
    return {
      baselineDate,
      nextNaturalTradingDayAfterBaseline: null,
      latestActualNaturalTradingDayInData,
      latestFullyCompletedPreferredOwnerDay,
      result: normalizeResult('next_natural_day_not_in_data_yet'),
      firstMissingLayer: 'none',
      systemState: 'waiting_for_next_day',
      exists: {
        sessionData: false,
        candleData: false,
        scoringSawDay: false,
        closeCompleteRan: false,
        ownership: false,
        preferredOwnerProof: false,
        verifier: false,
        naturalWin: false,
        deferral: false,
        operationalVerdict: false,
        proofBundle: false,
        watcher: false,
      },
      runDetails: {},
      advisoryOnly: true,
    };
  }

  const sessionRows = loadSessionRowsByDate(db, nextNaturalDay);
  const scoringRows = readDailyScoringRowsForTarget(db, nextNaturalDay);
  const ownershipRow = readSingleRowByDay(db, 'jarvis_live_outcome_ownership', nextNaturalDay);
  const proofRow = readSingleRowByDay(db, 'jarvis_live_preferred_owner_proof', nextNaturalDay);
  const verifierRow = readSingleRowByDay(db, 'jarvis_preferred_owner_post_close_verifier', nextNaturalDay);
  const naturalWinRow = readSingleRowByDay(db, 'jarvis_preferred_owner_natural_wins', nextNaturalDay);
  const deferralRow = readLatestDeferralByDay(db, nextNaturalDay);
  const verdictRow = readSingleRowByDay(db, 'jarvis_preferred_owner_operational_verdicts', nextNaturalDay);
  const bundleRow = readSingleRowByDay(db, 'jarvis_preferred_owner_operational_proof_bundles', nextNaturalDay);
  const watcherRow = readSingleRowByDay(db, 'jarvis_preferred_owner_natural_drill_watch_runs', nextNaturalDay);

  const evaluation = evaluateResultForNextDay({
    targetTradingDay: nextNaturalDay,
    scoringRows,
    ownershipRow,
    proofRow,
    verifierRow,
    naturalWinRow,
    verdictRow,
    bundleRow,
  });

  const scoringLatest = scoringRows[0] || null;
  const systemState = (
    evaluation.result === 'next_natural_day_fully_completed'
      ? 'healthy_on_next_day'
      : 'broken_on_next_day'
  );

  return {
    baselineDate,
    nextNaturalTradingDayAfterBaseline: nextNaturalDay,
    latestActualNaturalTradingDayInData,
    latestFullyCompletedPreferredOwnerDay,
    result: evaluation.result,
    firstMissingLayer: evaluation.firstMissingLayer,
    systemState,
    exists: {
      sessionData: sessionRows.length > 0,
      candleData: sessionRows.length > 0,
      scoringSawDay: evaluation.scoringSeen === true,
      closeCompleteRan: evaluation.closeCompleteRan === true,
      ownership: !!ownershipRow,
      preferredOwnerProof: !!proofRow,
      verifier: !!verifierRow,
      naturalWin: !!naturalWinRow,
      deferral: !!deferralRow,
      operationalVerdict: !!verdictRow,
      proofBundle: !!bundleRow,
      watcher: !!watcherRow,
    },
    runDetails: {
      latestScoringRun: scoringLatest
        ? {
          id: toNumber(scoringLatest.id, null),
          runDate: normalizeDate(scoringLatest.run_date || ''),
          mode: String(scoringLatest.mode || ''),
          runOrigin: String(scoringLatest.run_origin || ''),
          checkpointStatus: normalizeCheckpointStatus(scoringLatest.checkpoint_status || ''),
          runtimeCheckpointSource: String(scoringLatest.runtime_source || ''),
          createdAt: String(scoringLatest.created_at || ''),
        }
        : null,
      ownership: ownershipRow
        ? {
          firstRunId: toNumber(ownershipRow.first_run_id, null),
          firstRunSource: String(ownershipRow.first_run_source || ''),
          firstInsertedAt: String(ownershipRow.first_inserted_at || ''),
        }
        : null,
      preferredOwnerProof: proofRow
        ? {
          firstCreatorRunId: toNumber(proofRow.first_creator_run_id, null),
          firstCreatorSource: String(proofRow.first_creator_source || ''),
          preferredOwnerWon: toBool(proofRow.preferred_owner_won),
          capturedAt: String(proofRow.preferred_owner_proof_captured_at || ''),
        }
        : null,
      verifier: verifierRow
        ? {
          runId: toNumber(verifierRow.run_id, null),
          runOrigin: String(verifierRow.run_origin || ''),
          runtimeSource: String(verifierRow.runtime_source || ''),
          checkpointStatus: normalizeCheckpointStatus(verifierRow.checkpoint_status || ''),
          verifierStatus: String(verifierRow.verifier_status || ''),
          verifiedAt: String(verifierRow.verified_at || ''),
        }
        : null,
      naturalWin: naturalWinRow
        ? {
          id: toNumber(naturalWinRow.id, null),
          runId: toNumber(naturalWinRow.run_id, null),
          firstCreatorSource: String(naturalWinRow.first_creator_source || ''),
          timestamp: String(naturalWinRow.timestamp || ''),
        }
        : null,
      deferral: deferralRow
        ? {
          id: toNumber(deferralRow.id, null),
          runId: toNumber(deferralRow.run_id, null),
          fallbackSource: String(deferralRow.fallback_source || ''),
          timestamp: String(deferralRow.timestamp || ''),
        }
        : null,
      operationalVerdict: verdictRow
        ? {
          id: toNumber(verdictRow.id, null),
          runId: toNumber(verdictRow.run_id, null),
          runtimeCheckpointSource: String(verdictRow.runtime_checkpoint_source || ''),
          checkpointStatus: normalizeCheckpointStatus(verdictRow.checkpoint_status || ''),
          reportedAt: String(verdictRow.reported_at || ''),
        }
        : null,
      proofBundle: bundleRow
        ? {
          id: toNumber(bundleRow.id, null),
          runId: toNumber(bundleRow.run_id, null),
          runtimeCheckpointSource: String(bundleRow.runtime_checkpoint_source || ''),
          checkpointStatus: normalizeCheckpointStatus(bundleRow.checkpoint_status || ''),
          capturedAt: String(bundleRow.captured_at || ''),
        }
        : null,
      watcher: watcherRow
        ? {
          id: toNumber(watcherRow.id, null),
          triggerRunId: toNumber(watcherRow.trigger_run_id, null),
          triggerRunOrigin: String(watcherRow.trigger_run_origin || ''),
          triggerRuntimeSource: String(watcherRow.trigger_runtime_source || ''),
          drillOutcome: String(watcherRow.drill_outcome || ''),
          executed: toBool(watcherRow.executed),
          executedAt: String(watcherRow.executed_at || ''),
        }
        : null,
      sessionData: {
        candleRowCount: sessionRows.length,
        firstCandleTimestamp: sessionRows[0]?.timestamp || null,
        lastCandleTimestamp: sessionRows[sessionRows.length - 1]?.timestamp || null,
      },
    },
    advisoryOnly: true,
  };
}

function runNextNaturalDayReadinessWatchdogMonitor(input = {}) {
  const db = input.db;
  const baselineDate = normalizeDate(input.baselineDate || '2026-03-13') || '2026-03-13';
  if (!db || typeof db.prepare !== 'function') {
    return {
      baselineDate,
      targetTradingDay: null,
      result: normalizeResult('next_natural_day_not_in_data_yet'),
      firstMissingLayer: 'none',
      completed: false,
      alertEmitted: false,
      alertPersistedThisRun: false,
      pipelineState: 'waiting',
      nextNaturalDayDiscoveredInPersistedData: false,
      terminalAlertEmittedForDiscoveredDay: false,
      waitingForNextDay: true,
      actuallyBrokenOnNextDay: false,
      watchdogStateRow: null,
      watchdogTerminalAlertRow: null,
      latestWatchdogStateRow: null,
      latestWatchdogTerminalAlertRow: null,
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);
  const nowTs = String(input.nowTs || '').trim() || isoNow();
  const watchdog = runNextNaturalDayReadinessWatchdog({
    db,
    baselineDate,
  });
  const targetTradingDay = normalizeDate(
    watchdog.nextNaturalTradingDayAfterBaseline
    || ''
  ) || null;
  const result = normalizeResult(watchdog.result || 'next_natural_day_not_in_data_yet');
  const firstMissingLayer = String(watchdog.firstMissingLayer || '').trim() || 'none';
  const pipelineState = classifyPipelineStateFromResult(result);
  const terminalAlertType = resolveTerminalAlertTypeFromResult(result);
  let watchdogStateRow = null;
  let watchdogTerminalAlertRow = null;
  let alertPersistedThisRun = false;
  let alertEmitted = false;
  let completed = false;

  if (targetTradingDay) {
    const existingState = readWatchdogStateRow(db, { baselineDate, targetTradingDay });
    const existingAlert = readTerminalAlertRow(db, { baselineDate, targetTradingDay });
    const existingStateCompleted = toBool(existingState?.completed);
    const existingStateAlertEmitted = toBool(existingState?.alert_emitted);
    const freezeTerminalState = !!existingAlert || (existingStateCompleted && existingStateAlertEmitted);
    const shouldEmitTerminalAlert = !!terminalAlertType;
    alertEmitted = !!existingAlert;
    completed = alertEmitted || shouldEmitTerminalAlert;
    let completedAt = null;
    if (existingState?.completed_at) completedAt = String(existingState.completed_at || '').trim() || null;
    if (!completedAt && shouldEmitTerminalAlert) completedAt = nowTs;

    if (shouldEmitTerminalAlert && !existingAlert) {
      watchdogTerminalAlertRow = persistTerminalAlertRow(db, {
        baselineDate,
        targetTradingDay,
        alertType: terminalAlertType,
        result,
        firstMissingLayer,
        pipelineState,
        emittedAt: nowTs,
      });
      alertPersistedThisRun = !!watchdogTerminalAlertRow;
      alertEmitted = !!watchdogTerminalAlertRow;
    } else {
      watchdogTerminalAlertRow = existingAlert;
    }

    watchdogStateRow = persistWatchdogStateRow(db, {
      baselineDate,
      targetTradingDay,
      firstSeenAt: String(existingState?.first_seen_at || '').trim() || nowTs,
      latestCheckedAt: freezeTerminalState
        ? (String(existingState?.latest_checked_at || '').trim() || nowTs)
        : nowTs,
      currentResult: freezeTerminalState
        ? (String(existingState?.current_result || '').trim() || result)
        : result,
      firstMissingLayer: freezeTerminalState
        ? (String(existingState?.first_missing_layer || '').trim() || firstMissingLayer)
        : firstMissingLayer,
      completed: freezeTerminalState ? true : completed,
      completedAt,
      alertEmitted,
    });
  }

  const latestWatchdogStateRow = readLatestWatchdogStateRowByBaseline(db, baselineDate);
  const latestWatchdogTerminalAlertRow = readLatestTerminalAlertRowByBaseline(db, baselineDate);
  const outputStateRow = toWatchdogStateRowOutput(watchdogStateRow || latestWatchdogStateRow);
  const outputAlertRow = toTerminalAlertRowOutput(watchdogTerminalAlertRow || latestWatchdogTerminalAlertRow);
  const waitingForNextDay = (
    pipelineState === 'waiting'
    || result === 'next_natural_day_not_in_data_yet'
  );
  const nextNaturalDayDiscoveredInPersistedData = !!targetTradingDay;
  const terminalAlertEmittedForDiscoveredDay = (
    nextNaturalDayDiscoveredInPersistedData
    && alertEmitted === true
  );

  return {
    baselineDate,
    targetTradingDay,
    result,
    firstMissingLayer,
    completed: completed === true,
    alertEmitted: alertEmitted === true,
    alertPersistedThisRun: alertPersistedThisRun === true,
    pipelineState: normalizePipelineState(pipelineState),
    nextNaturalDayDiscoveredInPersistedData,
    terminalAlertEmittedForDiscoveredDay,
    waitingForNextDay: waitingForNextDay === true,
    actuallyBrokenOnNextDay: normalizePipelineState(pipelineState) === 'broken',
    watchdogStateRow: outputStateRow,
    watchdogTerminalAlertRow: outputAlertRow,
    latestWatchdogStateRow: toWatchdogStateRowOutput(latestWatchdogStateRow),
    latestWatchdogTerminalAlertRow: toTerminalAlertRowOutput(latestWatchdogTerminalAlertRow),
    readiness: watchdog,
    advisoryOnly: true,
  };
}

module.exports = {
  NEXT_NATURAL_DAY_READINESS_RESULT_ENUM,
  NEXT_NATURAL_DAY_WATCHDOG_PIPELINE_STATE_ENUM,
  NEXT_NATURAL_DAY_WATCHDOG_TERMINAL_ALERT_TYPE_ENUM,
  runNextNaturalDayReadinessWatchdog,
  runNextNaturalDayReadinessWatchdogMonitor,
};
