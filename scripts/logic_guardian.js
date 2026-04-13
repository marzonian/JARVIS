#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'mcnair.db');

const WINDOW_DAYS = clampNumber(Number(process.env.LOGIC_GUARD_WINDOW_DAYS || 14), 3, 120);
const MIN_SAMPLE = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_MIN_SAMPLE || 12), 4, 200));
const MIN_DECISIVE_SAMPLE = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_MIN_DECISIVE_SAMPLE || 6), 2, 200));
const MIN_DECISIVE_DAYS = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_MIN_DECISIVE_DAYS || 4), 1, 40));
const COOLDOWN_MINUTES = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_COOLDOWN_MIN || 180), 10, 1440));
const LOCK_MINUTES = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_LOCK_MIN || 12), 2, 120));
const MAX_WINDOW_DAYS = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_MAX_WINDOW_DAYS || 120), WINDOW_DAYS, 365));
const MIN_HEALTHY_RUNS_TO_RELAX = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_MIN_HEALTHY_RELAX || 2), 1, 10));
const MAX_BOUNDARY_CHANGES_PER_DAY = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_MAX_CHANGES_PER_DAY || 1), 1, 10));
const RECENCY_HALF_LIFE = clampNumber(Number(process.env.LOGIC_GUARD_RECENCY_HALF_LIFE || 12), 3, 80);

const TARGET_WR_LOW = clampNumber(Number(process.env.LOGIC_GUARD_WR_LOW || 45), 20, 70);
const TARGET_WR_HIGH = clampNumber(Number(process.env.LOGIC_GUARD_WR_HIGH || 58), TARGET_WR_LOW + 1, 90);
const LOSS_STREAK_TRIGGER = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_LOSS_STREAK || 3), 2, 10));
const SEVERE_LOSS_STREAK = Math.floor(clampNumber(Number(process.env.LOGIC_GUARD_SEVERE_STREAK || 4), LOSS_STREAK_TRIGGER, 12));

const BASE_WAIT_THRESHOLD = 50;
const BASE_GO_THRESHOLD = 72;
const MAX_WAIT_THRESHOLD = 88;
const MAX_GO_THRESHOLD = 95;

const BASE_SETUP_PROB = 55;
const BASE_CONFIDENCE = 60;
const MAX_SETUP_PROB = 90;
const MAX_CONFIDENCE = 95;
const EXCLUDED_FEEDBACK_SOURCES = ['deep_reliability', 'stability_test', 'system_probe', 'synthetic'];

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDB() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS logic_guard_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      status              TEXT NOT NULL CHECK(status IN ('steady', 'tightened', 'relaxed', 'error')),
      sample_size         INTEGER NOT NULL DEFAULT 0,
      win_rate            REAL,
      loss_streak         INTEGER NOT NULL DEFAULT 0,
      action_json         TEXT NOT NULL DEFAULT '{}',
      details_json        TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_logic_guard_events_created ON logic_guard_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logic_guard_events_status ON logic_guard_events(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS logic_guard_state (
      id                        INTEGER PRIMARY KEY CHECK(id = 1),
      lock_expires_at           TEXT,
      last_run_at               TEXT,
      last_status               TEXT,
      last_error                TEXT,
      consecutive_healthy_runs  INTEGER NOT NULL DEFAULT 0,
      last_boundary_change_date TEXT,
      last_change_direction     TEXT,
      last_change_at            TEXT,
      updated_at                TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function safeParseJson(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function minutesSince(sqliteDateTime) {
  if (!sqliteDateTime) return null;
  let iso = String(sqliteDateTime).trim().replace(' ', 'T');
  if (iso && !/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) iso = `${iso}Z`;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.now() - ms) / 60000);
}

function getActiveThresholds(db) {
  const row = db.prepare(`
    SELECT id, scope, go_threshold, wait_threshold, created_at
    FROM score_thresholds
    WHERE scope = 'global' AND active = 1
    ORDER BY id DESC
    LIMIT 1
  `).get();
  const waitThreshold = clampNumber(Number(row?.wait_threshold ?? BASE_WAIT_THRESHOLD), 0, 95);
  const goThreshold = clampNumber(Number(row?.go_threshold ?? BASE_GO_THRESHOLD), waitThreshold + 1, 100);
  return {
    id: row?.id || null,
    scope: 'global',
    waitThreshold: round2(waitThreshold),
    goThreshold: round2(goThreshold),
  };
}

function setActiveThresholds(db, next) {
  const waitThreshold = clampNumber(Number(next.waitThreshold), 0, 95);
  const goThreshold = clampNumber(Number(next.goThreshold), waitThreshold + 1, 100);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE score_thresholds SET active = 0 WHERE scope = 'global' AND active = 1`).run();
    db.prepare(`
      INSERT INTO score_thresholds (scope, go_threshold, wait_threshold, active, created_at)
      VALUES ('global', ?, ?, 1, datetime('now'))
    `).run(goThreshold, waitThreshold);
  });
  tx();
  return getActiveThresholds(db);
}

function getAutonomySettings(db) {
  const row = db.prepare('SELECT * FROM execution_autonomy WHERE id = 1').get() || {};
  return {
    mode: ['manual', 'paper_auto', 'live_assist'].includes(String(row.mode || '').toLowerCase())
      ? String(row.mode).toLowerCase()
      : 'manual',
    proactiveMorningEnabled: Number(row.proactive_morning_enabled ?? 1) === 1,
    proactiveMorningTime: String(row.proactive_morning_time || '08:50'),
    proactiveTimezone: String(row.proactive_timezone || 'America/New_York'),
    paperAutoEnabled: Number(row.paper_auto_enabled ?? 0) === 1,
    paperAutoWindowStart: String(row.paper_auto_window_start || '09:45'),
    paperAutoWindowEnd: String(row.paper_auto_window_end || '11:00'),
    minSetupProbability: clampNumber(Number(row.min_setup_probability ?? BASE_SETUP_PROB), 40, 95),
    minConfidencePct: clampNumber(Number(row.min_confidence_pct ?? BASE_CONFIDENCE), 40, 98),
    requireOpenRiskClear: Number(row.require_open_risk_clear ?? 1) === 1,
    maxPaperActionsPerDay: Math.max(1, Math.min(10, Number(row.max_paper_actions_per_day ?? 2))),
    lastPaperActionDate: row.last_paper_action_date || null,
    lastPaperActionCount: Number(row.last_paper_action_count || 0),
  };
}

function saveAutonomySettings(db, next) {
  db.prepare(`
    INSERT INTO execution_autonomy (
      id, mode, proactive_morning_enabled, proactive_morning_time, proactive_timezone,
      paper_auto_enabled, paper_auto_window_start, paper_auto_window_end,
      min_setup_probability, min_confidence_pct, require_open_risk_clear,
      max_paper_actions_per_day, last_paper_action_date, last_paper_action_count, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      proactive_morning_enabled = excluded.proactive_morning_enabled,
      proactive_morning_time = excluded.proactive_morning_time,
      proactive_timezone = excluded.proactive_timezone,
      paper_auto_enabled = excluded.paper_auto_enabled,
      paper_auto_window_start = excluded.paper_auto_window_start,
      paper_auto_window_end = excluded.paper_auto_window_end,
      min_setup_probability = excluded.min_setup_probability,
      min_confidence_pct = excluded.min_confidence_pct,
      require_open_risk_clear = excluded.require_open_risk_clear,
      max_paper_actions_per_day = excluded.max_paper_actions_per_day,
      last_paper_action_date = excluded.last_paper_action_date,
      last_paper_action_count = excluded.last_paper_action_count,
      updated_at = datetime('now')
  `).run(
    next.mode,
    next.proactiveMorningEnabled ? 1 : 0,
    next.proactiveMorningTime,
    next.proactiveTimezone,
    next.paperAutoEnabled ? 1 : 0,
    next.paperAutoWindowStart,
    next.paperAutoWindowEnd,
    next.minSetupProbability,
    next.minConfidencePct,
    next.requireOpenRiskClear ? 1 : 0,
    next.maxPaperActionsPerDay,
    next.lastPaperActionDate,
    next.lastPaperActionCount
  );
  return getAutonomySettings(db);
}

function getRecentFeedback(db, windowDays = WINDOW_DAYS) {
  return db.prepare(`
    SELECT id, outcome, trade_date, setup_id, setup_name, created_at, source
    FROM trade_outcome_feedback
    WHERE trade_date >= date('now', ?)
      AND COALESCE(source, 'manual') NOT IN ('deep_reliability', 'stability_test', 'system_probe', 'synthetic')
      AND COALESCE(setup_id, '') NOT LIKE 'deep_reliability_%'
    ORDER BY trade_date DESC, id DESC
    LIMIT 1200
  `).all(`-${Math.max(1, Math.floor(windowDays))} days`);
}

function getRecentFeedbackAdaptive(db) {
  const candidates = [
    Math.floor(WINDOW_DAYS),
    30,
    60,
    90,
    Math.floor(MAX_WINDOW_DAYS),
  ].filter((n, idx, arr) => Number.isFinite(n) && n > 0 && arr.indexOf(n) === idx).sort((a, b) => a - b);

  let finalRows = [];
  let finalWindowDays = candidates[0] || Math.floor(WINDOW_DAYS);
  for (const wd of candidates) {
    const rows = getRecentFeedback(db, wd);
    finalRows = rows;
    finalWindowDays = wd;
    if (rows.length >= MIN_SAMPLE) break;
  }
  return {
    rows: finalRows,
    usedWindowDays: finalWindowDays,
    minSample: MIN_SAMPLE,
  };
}

function computeFeedbackMetrics(rows = []) {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let weightedWins = 0;
  let weightedLosses = 0;
  let weightedDecisive = 0;
  const decay = Math.log(2) / RECENCY_HALF_LIFE;
  const uniqueTradeDays = new Set();
  const decisiveDays = new Set();
  for (let idx = 0; idx < rows.length; idx += 1) {
    const r = rows[idx];
    const outcome = String(r.outcome || '').toLowerCase();
    const tradeDate = String(r.trade_date || '').slice(0, 10);
    if (tradeDate) uniqueTradeDays.add(tradeDate);
    const weight = Math.exp(-decay * idx);
    if (outcome === 'win') {
      wins += 1;
      weightedWins += weight;
      weightedDecisive += weight;
      if (tradeDate) decisiveDays.add(tradeDate);
    } else if (outcome === 'loss') {
      losses += 1;
      weightedLosses += weight;
      weightedDecisive += weight;
      if (tradeDate) decisiveDays.add(tradeDate);
    } else if (outcome === 'breakeven') {
      breakeven += 1;
    }
  }
  const decisive = wins + losses;
  const winRate = decisive > 0 ? round2((wins / decisive) * 100) : null;
  const weightedWinRate = weightedDecisive > 0 ? round2((weightedWins / weightedDecisive) * 100) : null;
  let lossStreak = 0;
  for (const r of rows) {
    const outcome = String(r.outcome || '').toLowerCase();
    if (outcome === 'loss') {
      lossStreak += 1;
      continue;
    }
    break;
  }
  return {
    sampleSize: rows.length,
    wins,
    losses,
    breakeven,
    decisive,
    winRate,
    weightedWinRate,
    recencyDelta: (winRate != null && weightedWinRate != null) ? round2(weightedWinRate - winRate) : null,
    weightedDecisive: round2(weightedDecisive),
    uniqueTradeDays: uniqueTradeDays.size,
    decisiveDays: decisiveDays.size,
    lossStreak,
  };
}

function getLatestGuardEvent(db) {
  const row = db.prepare(`
    SELECT id, status, sample_size, win_rate, loss_streak, action_json, details_json, created_at
    FROM logic_guard_events
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    sampleSize: Number(row.sample_size || 0),
    winRate: row.win_rate == null ? null : Number(row.win_rate),
    lossStreak: Number(row.loss_streak || 0),
    action: safeParseJson(row.action_json, {}),
    details: safeParseJson(row.details_json, {}),
    createdAt: row.created_at,
  };
}

function countBoundaryChangesToday(db) {
  const row = db.prepare(`
    SELECT COUNT(*) as c
    FROM logic_guard_events
    WHERE date(created_at) = date('now')
      AND status IN ('tightened', 'relaxed')
  `).get();
  return Number(row?.c || 0);
}

function getGuardState(db) {
  db.prepare(`
    INSERT INTO logic_guard_state (id, updated_at)
    VALUES (1, datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `).run();
  return db.prepare(`
    SELECT id, lock_expires_at, last_run_at, last_status, last_error,
           consecutive_healthy_runs, last_boundary_change_date,
           last_change_direction, last_change_at, updated_at
    FROM logic_guard_state
    WHERE id = 1
  `).get() || null;
}

function acquireRunLock(db) {
  getGuardState(db);
  const row = db.prepare(`
    UPDATE logic_guard_state
    SET lock_expires_at = datetime('now', ?), updated_at = datetime('now')
    WHERE id = 1
      AND (lock_expires_at IS NULL OR lock_expires_at <= datetime('now'))
  `).run(`+${LOCK_MINUTES} minutes`);
  if (Number(row?.changes || 0) > 0) return { acquired: true, state: getGuardState(db) };
  return { acquired: false, state: getGuardState(db) };
}

function releaseRunLock(db, patch = {}) {
  const nextStatus = patch.lastStatus == null ? null : String(patch.lastStatus);
  const nextError = patch.lastError == null ? null : String(patch.lastError).slice(0, 400);
  const healthyRunsRaw = Number(patch.consecutiveHealthyRuns);
  const hasHealthyRuns = Number.isFinite(healthyRunsRaw);
  const nextHealthyRuns = hasHealthyRuns ? Math.max(0, Math.floor(healthyRunsRaw)) : null;
  db.prepare(`
    UPDATE logic_guard_state
    SET
      lock_expires_at = datetime('now', '-1 second'),
      last_run_at = datetime('now'),
      last_status = COALESCE(?, last_status),
      last_error = ?,
      consecutive_healthy_runs = CASE
        WHEN ? IS NULL THEN consecutive_healthy_runs
        ELSE ?
      END,
      last_boundary_change_date = COALESCE(?, last_boundary_change_date),
      last_change_direction = COALESCE(?, last_change_direction),
      last_change_at = COALESCE(?, last_change_at),
      updated_at = datetime('now')
    WHERE id = 1
  `).run(
    nextStatus,
    nextError,
    hasHealthyRuns ? 1 : null,
    nextHealthyRuns,
    patch.lastBoundaryChangeDate || null,
    patch.lastChangeDirection || null,
    patch.lastChangeAt || null
  );
}

function chooseAction(ctx) {
  const {
    metrics,
    thresholds,
    autonomy,
    cooldownActive,
    allowRelax,
    maxChangesReached,
    healthyRunsRequired,
    healthyRunsNow,
  } = ctx;

  const reason = [];
  const action = {
    status: 'steady',
    changed: false,
    thresholdsNext: { ...thresholds },
    autonomyNext: { ...autonomy },
    reason: '',
    severity: 'none',
  };

  if (metrics.sampleSize < MIN_SAMPLE || metrics.decisive < MIN_DECISIVE_SAMPLE || metrics.decisiveDays < MIN_DECISIVE_DAYS) {
    reason.push(`insufficient sample (${metrics.sampleSize}/${MIN_SAMPLE})`);
    reason.push(`insufficient decisive outcomes (${metrics.decisive}/${MIN_DECISIVE_SAMPLE})`);
    reason.push(`insufficient decisive day diversity (${metrics.decisiveDays}/${MIN_DECISIVE_DAYS})`);
    action.reason = reason.join('; ');
    return action;
  }

  if (cooldownActive) {
    reason.push(`cooldown active (${COOLDOWN_MINUTES}m)`);
    action.reason = reason.join('; ');
    return action;
  }

  const primaryWinRate = metrics.weightedWinRate != null ? metrics.weightedWinRate : metrics.winRate;
  const lowEdge = primaryWinRate != null && primaryWinRate < TARGET_WR_LOW;
  const streakRisk = metrics.lossStreak >= LOSS_STREAK_TRIGGER;
  const trendDeterioration = metrics.recencyDelta != null && metrics.recencyDelta <= -8;
  const healthyEdge = primaryWinRate != null && primaryWinRate >= TARGET_WR_HIGH && metrics.lossStreak <= 1;

  if (lowEdge || streakRisk || trendDeterioration) {
    const severe = (primaryWinRate != null && primaryWinRate < (TARGET_WR_LOW - 4))
      || metrics.lossStreak >= SEVERE_LOSS_STREAK
      || (trendDeterioration && metrics.recencyDelta <= -12);
    if (maxChangesReached && !severe) {
      reason.push(`daily boundary change budget reached (${MAX_BOUNDARY_CHANGES_PER_DAY})`);
      reason.push('holding current thresholds to avoid overfitting');
      action.reason = reason.join('; ');
      return action;
    }
    const waitStep = severe ? 4 : 3;
    const goStep = severe ? 5 : 4;
    const autoStep = severe ? 6 : 4;

    const nextWait = clampNumber(thresholds.waitThreshold + waitStep, BASE_WAIT_THRESHOLD, MAX_WAIT_THRESHOLD);
    const nextGo = clampNumber(Math.max(thresholds.goThreshold + goStep, nextWait + 1), BASE_GO_THRESHOLD, MAX_GO_THRESHOLD);
    const nextSetupProb = clampNumber(autonomy.minSetupProbability + autoStep, BASE_SETUP_PROB, MAX_SETUP_PROB);
    const nextConfidence = clampNumber(autonomy.minConfidencePct + autoStep, BASE_CONFIDENCE, MAX_CONFIDENCE);

    action.status = 'tightened';
    action.severity = severe ? 'high' : 'medium';
    action.thresholdsNext = { ...thresholds, waitThreshold: round2(nextWait), goThreshold: round2(nextGo) };
    action.autonomyNext = {
      ...autonomy,
      minSetupProbability: round2(nextSetupProb),
      minConfidencePct: round2(nextConfidence),
    };
    reason.push(`effective win rate ${primaryWinRate == null ? 'n/a' : `${primaryWinRate}%`} below floor ${TARGET_WR_LOW}%`);
    if (trendDeterioration) reason.push(`recent edge deterioration ${metrics.recencyDelta}%`);
    reason.push(`loss streak ${metrics.lossStreak} (trigger ${LOSS_STREAK_TRIGGER})`);
  } else if (healthyEdge) {
    if (!allowRelax) {
      reason.push(`need ${healthyRunsRequired} consecutive healthy runs before relaxing`);
      reason.push(`healthy run streak now ${healthyRunsNow}`);
      action.reason = reason.join('; ');
      return action;
    }
    if (maxChangesReached) {
      reason.push(`daily boundary change budget reached (${MAX_BOUNDARY_CHANGES_PER_DAY})`);
      reason.push('deferring relax step to next run');
      action.reason = reason.join('; ');
      return action;
    }
    const nextWait = clampNumber(thresholds.waitThreshold - 2, BASE_WAIT_THRESHOLD, MAX_WAIT_THRESHOLD);
    const nextGo = clampNumber(Math.max(thresholds.goThreshold - 2, nextWait + 1), BASE_GO_THRESHOLD, MAX_GO_THRESHOLD);
    const nextSetupProb = clampNumber(autonomy.minSetupProbability - 2, BASE_SETUP_PROB, MAX_SETUP_PROB);
    const nextConfidence = clampNumber(autonomy.minConfidencePct - 2, BASE_CONFIDENCE, MAX_CONFIDENCE);

    action.status = 'relaxed';
    action.severity = 'low';
    action.thresholdsNext = { ...thresholds, waitThreshold: round2(nextWait), goThreshold: round2(nextGo) };
    action.autonomyNext = {
      ...autonomy,
      minSetupProbability: round2(nextSetupProb),
      minConfidencePct: round2(nextConfidence),
    };
    reason.push(`effective win rate ${primaryWinRate}% >= healthy target ${TARGET_WR_HIGH}%`);
    reason.push('loss streak <= 1');
  } else {
    reason.push('performance in neutral band');
  }

  const thresholdsChanged = action.thresholdsNext.goThreshold !== thresholds.goThreshold
    || action.thresholdsNext.waitThreshold !== thresholds.waitThreshold;
  const autonomyChanged = action.autonomyNext.minSetupProbability !== autonomy.minSetupProbability
    || action.autonomyNext.minConfidencePct !== autonomy.minConfidencePct;
  action.changed = thresholdsChanged || autonomyChanged;

  if ((action.status === 'tightened' || action.status === 'relaxed') && !action.changed) {
    action.status = 'steady';
    action.severity = 'none';
    reason.push('no effective delta after bounds');
  }
  action.reason = reason.join('; ');
  return action;
}

function logGuardEvent(db, payload = {}) {
  db.prepare(`
    INSERT INTO logic_guard_events (
      status, sample_size, win_rate, loss_streak, action_json, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    String(payload.status || 'error'),
    Number(payload.sampleSize || 0),
    payload.winRate == null ? null : Number(payload.winRate),
    Number(payload.lossStreak || 0),
    JSON.stringify(payload.action || {}),
    JSON.stringify(payload.details || {})
  );
}

function runAutoFixRemediation() {
  try {
    const output = execSync('npm run auto-fix:run', {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 180000,
      shell: '/bin/zsh',
    });
    return {
      invoked: true,
      ok: true,
      outputTail: String(output || '').trim().slice(-500),
    };
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : '';
    const stderr = err?.stderr ? String(err.stderr) : '';
    const merged = `${stdout}\n${stderr}`.trim();
    return {
      invoked: true,
      ok: false,
      error: String(err?.message || 'auto_fix_failed').slice(0, 260),
      outputTail: merged.slice(-500),
    };
  }
}

function main() {
  const db = getDB();
  try {
    const lock = acquireRunLock(db);
    if (!lock.acquired) {
      const lockExpiresAt = lock?.state?.lock_expires_at || null;
      console.log(JSON.stringify({
        ok: true,
        status: 'steady',
        changed: false,
        reason: `run skipped: lock active until ${lockExpiresAt || 'unknown'}`,
      }));
      return;
    }

    const guardState = lock?.state || getGuardState(db) || {};
    const thresholdsCurrent = getActiveThresholds(db);
    const autonomyCurrent = getAutonomySettings(db);
    const feedback = getRecentFeedbackAdaptive(db);
    const feedbackRows = feedback.rows;
    const metrics = computeFeedbackMetrics(feedbackRows);
    const latest = getLatestGuardEvent(db);
    const changesToday = countBoundaryChangesToday(db);
    const maxChangesReached = changesToday >= MAX_BOUNDARY_CHANGES_PER_DAY;
    const effectiveWinRate = metrics.weightedWinRate != null ? metrics.weightedWinRate : metrics.winRate;
    const healthyRunNow = metrics.sampleSize >= MIN_SAMPLE
      && metrics.decisive >= MIN_DECISIVE_SAMPLE
      && metrics.decisiveDays >= MIN_DECISIVE_DAYS
      && effectiveWinRate != null
      && effectiveWinRate >= TARGET_WR_HIGH
      && metrics.lossStreak <= 1;
    const prevHealthyRuns = Math.max(0, Number(guardState?.consecutive_healthy_runs || 0));
    const nextHealthyRuns = healthyRunNow ? prevHealthyRuns + 1 : 0;
    const allowRelax = nextHealthyRuns >= MIN_HEALTHY_RUNS_TO_RELAX;
    const minutesFromLastChange = latest ? minutesSince(latest.createdAt) : null;
    const cooldownActive = !!latest
      && ['tightened', 'relaxed'].includes(String(latest.status || '').toLowerCase())
      && minutesFromLastChange != null
      && minutesFromLastChange < COOLDOWN_MINUTES;

    const action = chooseAction({
      metrics,
      thresholds: thresholdsCurrent,
      autonomy: autonomyCurrent,
      cooldownActive,
      allowRelax,
      maxChangesReached,
      healthyRunsRequired: MIN_HEALTHY_RUNS_TO_RELAX,
      healthyRunsNow: nextHealthyRuns,
    });

    let thresholdsApplied = thresholdsCurrent;
    let autonomyApplied = autonomyCurrent;
    if (action.changed && (action.status === 'tightened' || action.status === 'relaxed')) {
      thresholdsApplied = setActiveThresholds(db, action.thresholdsNext);
      autonomyApplied = saveAutonomySettings(db, action.autonomyNext);
    }

    const eventPayload = {
      status: action.status,
      sampleSize: metrics.sampleSize,
      winRate: metrics.winRate,
      lossStreak: metrics.lossStreak,
      action: {
        reason: action.reason,
        severity: action.severity,
        changed: action.changed,
        thresholdsBefore: thresholdsCurrent,
        thresholdsAfter: thresholdsApplied,
        autonomyBefore: {
          minSetupProbability: round2(autonomyCurrent.minSetupProbability),
          minConfidencePct: round2(autonomyCurrent.minConfidencePct),
        },
        autonomyAfter: {
          minSetupProbability: round2(autonomyApplied.minSetupProbability),
          minConfidencePct: round2(autonomyApplied.minConfidencePct),
        },
      },
      details: {
        windowDays: WINDOW_DAYS,
        usedWindowDays: feedback.usedWindowDays,
        maxWindowDays: MAX_WINDOW_DAYS,
        maxBoundaryChangesPerDay: MAX_BOUNDARY_CHANGES_PER_DAY,
        boundaryChangesToday: changesToday,
        healthyRunsRequiredToRelax: MIN_HEALTHY_RUNS_TO_RELAX,
        healthyRunsNow: nextHealthyRuns,
        minSample: MIN_SAMPLE,
        minDecisiveSample: MIN_DECISIVE_SAMPLE,
        minDecisiveDays: MIN_DECISIVE_DAYS,
        recencyHalfLife: RECENCY_HALF_LIFE,
        excludedFeedbackSources: EXCLUDED_FEEDBACK_SOURCES,
        targetWinRateLow: TARGET_WR_LOW,
        targetWinRateHigh: TARGET_WR_HIGH,
        lossStreakTrigger: LOSS_STREAK_TRIGGER,
        severeLossStreak: SEVERE_LOSS_STREAK,
        cooldownMinutes: COOLDOWN_MINUTES,
        cooldownActive,
        minutesFromLastChange,
        metrics,
      },
    };
    logGuardEvent(db, eventPayload);

    const output = {
      ok: true,
      status: action.status,
      changed: action.changed,
      reason: action.reason,
      metrics,
      thresholds: thresholdsApplied,
      autonomy: {
        minSetupProbability: round2(autonomyApplied.minSetupProbability),
        minConfidencePct: round2(autonomyApplied.minConfidencePct),
      },
    };
    releaseRunLock(db, {
      lastStatus: action.status,
      lastError: null,
      consecutiveHealthyRuns: nextHealthyRuns,
      lastBoundaryChangeDate: action.changed ? db.prepare(`SELECT date('now') AS d`).get()?.d : null,
      lastChangeDirection: action.changed ? action.status : null,
      lastChangeAt: action.changed ? db.prepare(`SELECT datetime('now') AS dt`).get()?.dt : null,
    });
    console.log(JSON.stringify(output));
  } catch (err) {
    const remediation = runAutoFixRemediation();
    const fallback = {
      status: 'error',
      sampleSize: 0,
      winRate: null,
      lossStreak: 0,
      action: { error: String(err.message || 'logic_guard_failed') },
      details: { stack: String(err.stack || ''), remediation },
    };
    try {
      logGuardEvent(db, fallback);
    } catch (_) {
      // ignore secondary logging failures
    }
    try {
      releaseRunLock(db, {
        lastStatus: 'error',
        lastError: String(err.message || 'logic_guard_failed'),
      });
    } catch (_) {
      // ignore lock release failures
    }
    console.error(JSON.stringify({ ok: false, error: String(err.message || 'logic_guard_failed') }));
    process.exit(1);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}
