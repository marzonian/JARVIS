'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
} = require('./data-foundation-storage');
const {
  classifyTradingDay,
} = require('./daily-evidence-scoring');

const LATEST_NATURAL_DAY_GAP_AUDIT_RESULT_ENUM = Object.freeze([
  'latest_natural_day_not_seen_in_scoring',
  'latest_natural_day_seen_but_not_resolved',
  'latest_natural_day_resolved_but_missing_ownership',
  'latest_natural_day_missing_preferred_owner_proof',
  'latest_natural_day_missing_verifier',
  'latest_natural_day_missing_natural_win',
  'latest_natural_day_missing_operational_verdict',
  'latest_natural_day_missing_proof_bundle',
  'latest_natural_day_fully_completed',
]);

const RESULT_SET = new Set(LATEST_NATURAL_DAY_GAP_AUDIT_RESULT_ENUM);
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
    'latest_natural_day_not_seen_in_scoring'
  );
}

function normalizeCheckpointStatus(value = '') {
  return normalizeFromSet(value, CHECKPOINT_STATUS_SET, 'waiting_valid');
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

function readLatestNaturalTradingDayInData(db, { baselineDate = null } = {}) {
  if (!db || typeof db.prepare !== 'function') return { day: null, foundAfterBaseline: false };
  const baseline = normalizeDate(baselineDate || '');
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
  let latest = null;
  let latestAfterBaseline = null;
  for (const row of rows) {
    const day = normalizeDate(row?.session_date || '');
    const candleRows = toNumber(row?.candle_rows, 0);
    if (!day || candleRows <= 0) continue;
    const classification = classifyTradingDay({
      date: day,
      sessionForDate: [{}], // non-empty means session data exists
    });
    if (String(classification.classification || '') !== 'valid_trading_day') continue;
    if (!latest) latest = day;
    if (baseline && day > baseline) {
      latestAfterBaseline = day;
      break;
    }
  }
  return {
    day: latestAfterBaseline || latest || null,
    foundAfterBaseline: !!latestAfterBaseline,
  };
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

function buildGapResult(input = {}) {
  const scoringRows = Array.isArray(input.scoringRows) ? input.scoringRows : [];
  const ownershipRow = input.ownershipRow || null;
  const proofRow = input.proofRow || null;
  const verifierRow = input.verifierRow || null;
  const naturalWinRow = input.naturalWinRow || null;
  const verdictRow = input.verdictRow || null;
  const bundleRow = input.bundleRow || null;
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');

  const scoringSeen = scoringRows.length > 0;
  const resolved = scoringRows.some((row) => (
    normalizeCheckpointStatus(row?.checkpoint_status || '') !== 'waiting_valid'
  ));
  const closeCompleteScoringRan = scoringRows.some((row) => (
    String(row?.run_origin || '').toLowerCase() === 'natural'
    && String(row?.runtime_source || '').toLowerCase() === 'close_complete_checkpoint'
  ));

  const preferredOwnerWon = toBool(proofRow?.preferred_owner_won);
  let result = 'latest_natural_day_fully_completed';
  let firstMissingLayer = 'none';

  if (!scoringSeen) {
    result = 'latest_natural_day_not_seen_in_scoring';
    firstMissingLayer = 'jarvis_daily_scoring_runs';
  } else if (!resolved) {
    result = 'latest_natural_day_seen_but_not_resolved';
    firstMissingLayer = 'checkpoint_resolution';
  } else if (!ownershipRow) {
    result = 'latest_natural_day_resolved_but_missing_ownership';
    firstMissingLayer = 'jarvis_live_outcome_ownership';
  } else if (!proofRow) {
    result = 'latest_natural_day_missing_preferred_owner_proof';
    firstMissingLayer = 'jarvis_live_preferred_owner_proof';
  } else if (!verifierRow) {
    result = 'latest_natural_day_missing_verifier';
    firstMissingLayer = 'jarvis_preferred_owner_post_close_verifier';
  } else if (preferredOwnerWon && !naturalWinRow) {
    result = 'latest_natural_day_missing_natural_win';
    firstMissingLayer = 'jarvis_preferred_owner_natural_wins';
  } else if (!verdictRow) {
    result = 'latest_natural_day_missing_operational_verdict';
    firstMissingLayer = 'jarvis_preferred_owner_operational_verdicts';
  } else if (!bundleRow) {
    result = 'latest_natural_day_missing_proof_bundle';
    firstMissingLayer = 'jarvis_preferred_owner_operational_proof_bundles';
  }

  return {
    result: normalizeResult(result),
    firstMissingLayer,
    targetTradingDay: targetTradingDay || null,
    scoringSeen,
    resolved,
    closeCompleteScoringRan,
    preferredOwnerWon,
    advisoryOnly: true,
  };
}

function runLatestNaturalDayGapAudit(input = {}) {
  const db = input.db;
  const baselineDate = normalizeDate(input.baselineDate || '2026-03-13') || '2026-03-13';
  if (!db || typeof db.prepare !== 'function') {
    return {
      baselineDate,
      latestActualNaturalTradingDayInData: null,
      latestNaturalTradingDayAfterBaselineFound: false,
      latestFullyCompletedPreferredOwnerDay: null,
      result: normalizeResult('latest_natural_day_not_seen_in_scoring'),
      firstMissingLayer: 'jarvis_daily_scoring_runs',
      pipelineState: 'actually_broken',
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);

  const latestNatural = readLatestNaturalTradingDayInData(db, { baselineDate });
  const targetTradingDay = latestNatural.day;
  const latestFullyCompletedPreferredOwnerDay = readLatestFullyCompletedPreferredOwnerDay(db);

  if (!targetTradingDay) {
    return {
      baselineDate,
      latestActualNaturalTradingDayInData: null,
      latestNaturalTradingDayAfterBaselineFound: false,
      latestFullyCompletedPreferredOwnerDay,
      result: normalizeResult('latest_natural_day_not_seen_in_scoring'),
      firstMissingLayer: 'sessions',
      pipelineState: 'merely_lagging',
      exists: {
        sessionData: false,
        closeCompleteScoringRan: false,
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

  const sessionRows = loadSessionRowsByDate(db, targetTradingDay);
  const scoringRows = readDailyScoringRowsForTarget(db, targetTradingDay);
  const ownershipRow = readSingleRowByDay(db, 'jarvis_live_outcome_ownership', targetTradingDay);
  const proofRow = readSingleRowByDay(db, 'jarvis_live_preferred_owner_proof', targetTradingDay);
  const verifierRow = readSingleRowByDay(db, 'jarvis_preferred_owner_post_close_verifier', targetTradingDay);
  const naturalWinRow = readSingleRowByDay(db, 'jarvis_preferred_owner_natural_wins', targetTradingDay);
  const deferralRow = readLatestDeferralByDay(db, targetTradingDay);
  const verdictRow = readSingleRowByDay(db, 'jarvis_preferred_owner_operational_verdicts', targetTradingDay);
  const bundleRow = readSingleRowByDay(db, 'jarvis_preferred_owner_operational_proof_bundles', targetTradingDay);
  const watcherRow = readSingleRowByDay(db, 'jarvis_preferred_owner_natural_drill_watch_runs', targetTradingDay);

  const gap = buildGapResult({
    scoringRows,
    ownershipRow,
    proofRow,
    verifierRow,
    naturalWinRow,
    verdictRow,
    bundleRow,
    targetTradingDay,
  });

  const scoringLatest = scoringRows[0] || null;
  const closeCompleteScoringRan = scoringRows.some((row) => (
    String(row?.run_origin || '').toLowerCase() === 'natural'
    && String(row?.runtime_source || '').toLowerCase() === 'close_complete_checkpoint'
  ));
  const pipelineState = (
    latestNatural.foundAfterBaseline !== true
    && gap.result === 'latest_natural_day_fully_completed'
  )
    ? 'merely_lagging'
    : (gap.result === 'latest_natural_day_fully_completed' ? 'healthy' : 'actually_broken');

  return {
    baselineDate,
    latestActualNaturalTradingDayInData: targetTradingDay,
    latestNaturalTradingDayAfterBaselineFound: latestNatural.foundAfterBaseline === true,
    latestFullyCompletedPreferredOwnerDay,
    result: gap.result,
    firstMissingLayer: gap.firstMissingLayer,
    pipelineState,
    exists: {
      sessionData: sessionRows.length > 0,
      closeCompleteScoringRan: closeCompleteScoringRan === true,
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

module.exports = {
  LATEST_NATURAL_DAY_GAP_AUDIT_RESULT_ENUM,
  runLatestNaturalDayGapAudit,
};

