'use strict';

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDate(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function normalizeTimestamp(value) {
  const txt = toText(value);
  if (!txt) return null;
  if (/^\d{16,}$/.test(txt)) {
    try {
      const ns = BigInt(txt);
      const ms = Number(ns / 1000000n);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    } catch {}
  }
  if (/^\d{13}$/.test(txt)) {
    const ms = Number(txt);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const dt = new Date(txt);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString();
}

function ensureDataFoundationTables(db) {
  if (!db || typeof db.exec !== 'function') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS jarvis_market_bars_raw (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      provider              TEXT NOT NULL DEFAULT 'databento',
      dataset               TEXT NOT NULL,
      schema_name           TEXT NOT NULL,
      stype_in              TEXT,
      symbol                TEXT NOT NULL,
      ts_event              TEXT NOT NULL,
      open                  REAL,
      high                  REAL,
      low                   REAL,
      close                 REAL,
      volume                REAL,
      raw_json              TEXT NOT NULL DEFAULT '{}',
      source_type           TEXT NOT NULL DEFAULT 'historical',
      source_run_id         INTEGER,
      created_at            TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, dataset, schema_name, symbol, ts_event)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_market_bars_symbol_time
      ON jarvis_market_bars_raw(symbol, ts_event DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_market_bars_provider
      ON jarvis_market_bars_raw(provider, dataset, schema_name, symbol, ts_event DESC);

    CREATE TABLE IF NOT EXISTS jarvis_databento_ingestion_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      provider              TEXT NOT NULL DEFAULT 'databento',
      mode                  TEXT NOT NULL DEFAULT 'auto',
      dataset               TEXT NOT NULL,
      schema_name           TEXT NOT NULL,
      stype_in              TEXT,
      symbol                TEXT NOT NULL,
      range_start           TEXT,
      range_end             TEXT,
      rows_fetched          INTEGER NOT NULL DEFAULT 0,
      rows_inserted         INTEGER NOT NULL DEFAULT 0,
      missing_ranges_json   TEXT NOT NULL DEFAULT '[]',
      status                TEXT NOT NULL DEFAULT 'noop',
      error_message         TEXT,
      details_json          TEXT NOT NULL DEFAULT '{}',
      started_at            TEXT,
      finished_at           TEXT,
      created_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_databento_runs_created
      ON jarvis_databento_ingestion_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_databento_runs_symbol
      ON jarvis_databento_ingestion_runs(symbol, created_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_databento_ingestion_state (
      provider              TEXT NOT NULL DEFAULT 'databento',
      dataset               TEXT NOT NULL,
      schema_name           TEXT NOT NULL,
      stype_in              TEXT,
      symbol                TEXT NOT NULL,
      last_success_ts       TEXT,
      last_success_date     TEXT,
      last_attempt_at       TEXT,
      last_status           TEXT,
      last_error_message    TEXT,
      updated_at            TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(provider, dataset, schema_name, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_databento_state_updated
      ON jarvis_databento_ingestion_state(updated_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_databento_gap_audit (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      provider              TEXT NOT NULL DEFAULT 'databento',
      dataset               TEXT NOT NULL,
      schema_name           TEXT NOT NULL,
      symbol                TEXT NOT NULL,
      gap_start             TEXT NOT NULL,
      gap_end               TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'open',
      discovered_at         TEXT DEFAULT (datetime('now')),
      resolved_at           TEXT,
      details_json          TEXT NOT NULL DEFAULT '{}',
      UNIQUE(provider, dataset, schema_name, symbol, gap_start, gap_end)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_databento_gap_symbol
      ON jarvis_databento_gap_audit(symbol, gap_start, gap_end);
    CREATE INDEX IF NOT EXISTS idx_jarvis_databento_gap_status
      ON jarvis_databento_gap_audit(status, discovered_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_live_session_data (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      source                TEXT NOT NULL,
      symbol                TEXT,
      snapshot_at           TEXT NOT NULL,
      feed_status           TEXT,
      payload_json          TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_live_session_data_source
      ON jarvis_live_session_data(source, snapshot_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_derived_features (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_date          TEXT NOT NULL,
      symbol                TEXT NOT NULL,
      feature_set           TEXT NOT NULL,
      feature_version       TEXT NOT NULL DEFAULT 'v1',
      source_ref            TEXT,
      features_json         TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      UNIQUE(feature_date, symbol, feature_set, feature_version)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_derived_features_date
      ON jarvis_derived_features(feature_date DESC, symbol);

    CREATE TABLE IF NOT EXISTS jarvis_scored_trade_outcomes (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      score_date            TEXT NOT NULL,
      source_type           TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase  TEXT NOT NULL DEFAULT 'live_intraday',
      regime_label          TEXT,
      strategy_key          TEXT,
      posture               TEXT,
      confidence_label      TEXT,
      confidence_score      REAL,
      recommendation_json   TEXT NOT NULL DEFAULT '{}',
      outcome_json          TEXT NOT NULL DEFAULT '{}',
      score_label           TEXT,
      recommendation_delta  REAL,
      actual_pnl            REAL,
      best_possible_pnl     REAL,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      UNIQUE(score_date, source_type, reconstruction_phase)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_scored_trade_outcomes_date
      ON jarvis_scored_trade_outcomes(score_date DESC, source_type, reconstruction_phase);

    CREATE TABLE IF NOT EXISTS jarvis_daily_scoring_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date              TEXT NOT NULL,
      mode                  TEXT NOT NULL DEFAULT 'auto',
      run_origin            TEXT NOT NULL DEFAULT 'manual',
      window_days           INTEGER NOT NULL DEFAULT 3,
      contexts_seen         INTEGER NOT NULL DEFAULT 0,
      scored_rows           INTEGER NOT NULL DEFAULT 0,
      inserted_rows         INTEGER NOT NULL DEFAULT 0,
      updated_rows          INTEGER NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'noop',
      error_message         TEXT,
      details_json          TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_daily_scoring_runs_date
      ON jarvis_daily_scoring_runs(run_date DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_live_outcome_ownership (
      target_trading_day        TEXT PRIMARY KEY,
      created_row_id            INTEGER,
      first_run_id              INTEGER,
      first_run_mode            TEXT,
      first_run_source          TEXT,
      first_insert_sla_outcome  TEXT,
      first_inserted_at         TEXT,
      first_inserted_autonomous INTEGER NOT NULL DEFAULT 0,
      updated_at                TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_live_outcome_ownership_inserted
      ON jarvis_live_outcome_ownership(first_inserted_at DESC, first_run_source);

    CREATE TABLE IF NOT EXISTS jarvis_live_preferred_owner_proof (
      target_trading_day                           TEXT PRIMARY KEY,
      preferred_owner_expected_source              TEXT NOT NULL DEFAULT 'close_complete_checkpoint',
      first_row_id                                 INTEGER,
      first_creator_run_id                         INTEGER,
      first_creator_mode                           TEXT,
      first_creator_source                         TEXT,
      first_creator_autonomous                     INTEGER NOT NULL DEFAULT 0,
      first_creation_timestamp                     TEXT,
      first_creation_checkpoint_status             TEXT,
      first_creation_attempt_result                TEXT,
      first_creation_proof_outcome                 TEXT,
      first_creation_ownership_outcome             TEXT,
      first_creation_ownership_source_specific_outcome TEXT,
      preferred_owner_won                          INTEGER NOT NULL DEFAULT 0,
      preferred_owner_won_first_eligible_cycle     INTEGER NOT NULL DEFAULT 0,
      preferred_owner_failure_reason               TEXT,
      preferred_owner_proof_captured_at            TEXT,
      updated_at                                   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_live_preferred_owner_proof_day
      ON jarvis_live_preferred_owner_proof(target_trading_day DESC, preferred_owner_won);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_natural_wins (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      target_trading_day            TEXT NOT NULL,
      run_id                        INTEGER,
      first_creator_source          TEXT,
      reservation_state             TEXT,
      reservation_blocked_fallback  INTEGER NOT NULL DEFAULT 0,
      proof_row_id                  INTEGER,
      run_origin                    TEXT NOT NULL DEFAULT 'manual',
      timestamp                     TEXT DEFAULT (datetime('now')),
      UNIQUE(target_trading_day)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_natural_wins_day
      ON jarvis_preferred_owner_natural_wins(target_trading_day DESC, timestamp DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_deferrals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      target_trading_day    TEXT NOT NULL,
      fallback_source       TEXT NOT NULL,
      deferral_reason       TEXT NOT NULL,
      reservation_state     TEXT NOT NULL,
      run_id                INTEGER,
      run_origin            TEXT NOT NULL DEFAULT 'manual',
      timestamp             TEXT DEFAULT (datetime('now')),
      UNIQUE(target_trading_day, run_id, fallback_source)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_deferrals_day
      ON jarvis_preferred_owner_deferrals(target_trading_day DESC, timestamp DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_post_close_verifier (
      target_trading_day       TEXT PRIMARY KEY,
      run_id                   INTEGER,
      run_origin               TEXT NOT NULL DEFAULT 'manual',
      runtime_source           TEXT NOT NULL DEFAULT 'manual_api_run',
      checkpoint_status        TEXT NOT NULL DEFAULT 'waiting_valid',
      verifier_status          TEXT NOT NULL DEFAULT 'fail',
      verifier_pass            INTEGER NOT NULL DEFAULT 0,
      failure_reasons_json     TEXT NOT NULL DEFAULT '[]',
      summary_json             TEXT NOT NULL DEFAULT '{}',
      verified_at              TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_post_close_verifier_day
      ON jarvis_preferred_owner_post_close_verifier(target_trading_day DESC, verified_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_operational_verdicts (
      id                                        INTEGER PRIMARY KEY AUTOINCREMENT,
      target_trading_day                        TEXT NOT NULL UNIQUE,
      run_id                                    INTEGER,
      run_origin                                TEXT NOT NULL DEFAULT 'manual',
      runtime_checkpoint_source                 TEXT NOT NULL DEFAULT 'manual_api_run',
      checkpoint_status                         TEXT NOT NULL DEFAULT 'waiting_valid',
      preferred_owner_expected_source           TEXT NOT NULL DEFAULT 'close_complete_checkpoint',
      preferred_owner_actual_source             TEXT,
      verifier_status                           TEXT NOT NULL DEFAULT 'fail',
      verifier_pass                             INTEGER NOT NULL DEFAULT 0,
      verifier_failure_reasons_json             TEXT NOT NULL DEFAULT '[]',
      ownership_source_specific_outcome         TEXT NOT NULL DEFAULT 'ownership_source_unknown',
      natural_preferred_owner_wins_last5d       INTEGER NOT NULL DEFAULT 0,
      natural_preferred_owner_wins_total        INTEGER NOT NULL DEFAULT 0,
      natural_preferred_owner_verifier_passes_last5d INTEGER NOT NULL DEFAULT 0,
      natural_preferred_owner_verifier_fails_last5d INTEGER NOT NULL DEFAULT 0,
      reported_at                               TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_operational_verdicts_day
      ON jarvis_preferred_owner_operational_verdicts(target_trading_day DESC, reported_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_operational_proof_bundles (
      id                                        INTEGER PRIMARY KEY AUTOINCREMENT,
      target_trading_day                        TEXT NOT NULL UNIQUE,
      run_id                                    INTEGER,
      run_origin                                TEXT NOT NULL DEFAULT 'manual',
      checkpoint_status                         TEXT NOT NULL DEFAULT 'waiting_valid',
      checkpoint_reason                         TEXT NOT NULL DEFAULT 'unknown_checkpoint_state',
      runtime_checkpoint_source                 TEXT NOT NULL DEFAULT 'manual_api_run',
      preferred_owner_expected_source           TEXT NOT NULL DEFAULT 'close_complete_checkpoint',
      preferred_owner_actual_source             TEXT,
      preferred_owner_won                       INTEGER NOT NULL DEFAULT 0,
      preferred_owner_failure_reason            TEXT NOT NULL DEFAULT 'none',
      ownership_source_specific_outcome         TEXT NOT NULL DEFAULT 'ownership_source_unknown',
      verifier_status                           TEXT NOT NULL DEFAULT 'fail',
      verifier_pass                             INTEGER NOT NULL DEFAULT 0,
      verifier_failure_reasons_json             TEXT NOT NULL DEFAULT '[]',
      natural_preferred_owner_wins_last5d       INTEGER NOT NULL DEFAULT 0,
      natural_preferred_owner_wins_total        INTEGER NOT NULL DEFAULT 0,
      natural_preferred_owner_verifier_passes_last5d INTEGER NOT NULL DEFAULT 0,
      natural_preferred_owner_verifier_fails_last5d INTEGER NOT NULL DEFAULT 0,
      captured_at                               TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_operational_proof_bundles_day
      ON jarvis_preferred_owner_operational_proof_bundles(target_trading_day DESC, captured_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_natural_drill_watch_runs (
      id                                INTEGER PRIMARY KEY AUTOINCREMENT,
      target_trading_day                TEXT NOT NULL UNIQUE,
      trigger_run_id                    INTEGER,
      trigger_run_origin                TEXT NOT NULL DEFAULT 'manual',
      trigger_runtime_source            TEXT NOT NULL DEFAULT 'manual_api_run',
      pre_transition_checkpoint_status  TEXT NOT NULL DEFAULT 'waiting_valid',
      post_transition_checkpoint_status TEXT NOT NULL DEFAULT 'waiting_valid',
      drill_outcome                     TEXT,
      executed                          INTEGER NOT NULL DEFAULT 0,
      executed_at                       TEXT,
      created_at                        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_natural_drill_watch_runs_day
      ON jarvis_preferred_owner_natural_drill_watch_runs(target_trading_day DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_next_natural_day_watchdog (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      baseline_date           TEXT NOT NULL,
      target_trading_day      TEXT NOT NULL,
      first_seen_at           TEXT,
      latest_checked_at       TEXT,
      current_result          TEXT NOT NULL DEFAULT 'next_natural_day_not_in_data_yet',
      first_missing_layer     TEXT NOT NULL DEFAULT 'none',
      completed               INTEGER NOT NULL DEFAULT 0,
      completed_at            TEXT,
      alert_emitted           INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT DEFAULT (datetime('now')),
      updated_at              TEXT DEFAULT (datetime('now')),
      UNIQUE(baseline_date, target_trading_day)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_next_natural_day_watchdog_day
      ON jarvis_preferred_owner_next_natural_day_watchdog(target_trading_day DESC, latest_checked_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_preferred_owner_next_natural_day_watchdog_alerts (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      baseline_date           TEXT NOT NULL,
      target_trading_day      TEXT NOT NULL,
      alert_type              TEXT NOT NULL DEFAULT 'failure',
      result                  TEXT NOT NULL DEFAULT 'next_natural_day_resolved_but_missing_ownership',
      first_missing_layer     TEXT NOT NULL DEFAULT 'none',
      pipeline_state          TEXT NOT NULL DEFAULT 'broken',
      emitted_at              TEXT DEFAULT (datetime('now')),
      created_at              TEXT DEFAULT (datetime('now')),
      UNIQUE(baseline_date, target_trading_day)
    );
    CREATE INDEX IF NOT EXISTS idx_jarvis_preferred_owner_next_natural_day_watchdog_alerts_day
      ON jarvis_preferred_owner_next_natural_day_watchdog_alerts(target_trading_day DESC, emitted_at DESC);
  `);
  try {
    const runCols = db.prepare(`PRAGMA table_info('jarvis_daily_scoring_runs')`).all();
    const hasRunOrigin = Array.isArray(runCols) && runCols.some((col) => String(col?.name || '').toLowerCase() === 'run_origin');
    if (!hasRunOrigin) {
      db.exec(`ALTER TABLE jarvis_daily_scoring_runs ADD COLUMN run_origin TEXT NOT NULL DEFAULT 'manual'`);
    }
  } catch {}
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jarvis_daily_scoring_runs_origin
        ON jarvis_daily_scoring_runs(run_origin, run_date DESC, created_at DESC);
    `);
  } catch {}
}

function upsertScoredTradeOutcome(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return { inserted: 0, updated: 0 };
  ensureDataFoundationTables(db);
  const scoreDate = normalizeDate(input.scoreDate || input.date);
  if (!scoreDate) return { inserted: 0, updated: 0 };
  const sourceType = toText(input.sourceType || 'live').toLowerCase() || 'live';
  const reconstructionPhase = toText(input.reconstructionPhase || 'live_intraday').toLowerCase() || 'live_intraday';
  const existing = db.prepare(`
    SELECT id
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ? AND source_type = ? AND reconstruction_phase = ?
    LIMIT 1
  `).get(scoreDate, sourceType, reconstructionPhase);

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
      best_possible_pnl,
      updated_at
    ) VALUES (
      @score_date,
      @source_type,
      @reconstruction_phase,
      @regime_label,
      @strategy_key,
      @posture,
      @confidence_label,
      @confidence_score,
      @recommendation_json,
      @outcome_json,
      @score_label,
      @recommendation_delta,
      @actual_pnl,
      @best_possible_pnl,
      datetime('now')
    )
    ON CONFLICT(score_date, source_type, reconstruction_phase) DO UPDATE SET
      regime_label = excluded.regime_label,
      strategy_key = excluded.strategy_key,
      posture = excluded.posture,
      confidence_label = excluded.confidence_label,
      confidence_score = excluded.confidence_score,
      recommendation_json = excluded.recommendation_json,
      outcome_json = excluded.outcome_json,
      score_label = excluded.score_label,
      recommendation_delta = excluded.recommendation_delta,
      actual_pnl = excluded.actual_pnl,
      best_possible_pnl = excluded.best_possible_pnl,
      updated_at = datetime('now')
  `).run({
    score_date: scoreDate,
    source_type: sourceType,
    reconstruction_phase: reconstructionPhase,
    regime_label: toText(input.regimeLabel || '') || null,
    strategy_key: toText(input.strategyKey || '') || null,
    posture: toText(input.posture || '') || null,
    confidence_label: toText(input.confidenceLabel || '') || null,
    confidence_score: toNumber(input.confidenceScore, null),
    recommendation_json: JSON.stringify(input.recommendation || {}),
    outcome_json: JSON.stringify(input.outcome || {}),
    score_label: toText(input.scoreLabel || '') || null,
    recommendation_delta: toNumber(input.recommendationDelta, null),
    actual_pnl: toNumber(input.actualPnl, null),
    best_possible_pnl: toNumber(input.bestPossiblePnl, null),
  });

  return existing ? { inserted: 0, updated: 1 } : { inserted: 1, updated: 0 };
}

function recordLiveSessionSnapshot(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  ensureDataFoundationTables(db);
  const source = toText(input.source || 'topstep_sync');
  if (!source) return null;
  const symbol = toText(input.symbol || '') || null;
  const snapshotAt = normalizeTimestamp(input.snapshotAt || new Date().toISOString()) || new Date().toISOString();
  const feedStatus = toText(input.feedStatus || '') || null;
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const row = db.prepare(`
    INSERT INTO jarvis_live_session_data (
      source,
      symbol,
      snapshot_at,
      feed_status,
      payload_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    source,
    symbol,
    snapshotAt,
    feedStatus,
    JSON.stringify(payload)
  );
  return Number(row.lastInsertRowid || 0) || null;
}

module.exports = {
  ensureDataFoundationTables,
  normalizeDate,
  normalizeTimestamp,
  toNumber,
  toText,
  upsertScoredTradeOutcome,
  recordLiveSessionSnapshot,
};
