-- McNair Mindset by 3130
-- Database Schema v1.0
-- SQLite

-- ============================================================
-- CORE DATA
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL UNIQUE,
  orb_high        REAL,
  orb_low         REAL,
  orb_range_ticks INTEGER,
  open_price      REAL,
  close_price     REAL,
  high_price      REAL,
  low_price       REAL,
  gap_ticks       INTEGER,
  gap_direction   TEXT CHECK(gap_direction IN ('up', 'down', 'flat')),
  overnight_high  REAL,
  overnight_low   REAL,
  overnight_range_ticks INTEGER,
  volume_total    INTEGER,
  candle_count    INTEGER,
  -- Regime classification
  regime_trend    TEXT CHECK(regime_trend IN ('trending', 'ranging', 'choppy')),
  regime_vol      TEXT CHECK(regime_vol IN ('low', 'normal', 'high', 'extreme')),
  regime_gap      TEXT CHECK(regime_gap IN ('gap_up_large', 'gap_up_small', 'flat', 'gap_down_small', 'gap_down_large')),
  regime_orb_size TEXT CHECK(regime_orb_size IN ('narrow', 'normal', 'wide')),
  day_of_week     INTEGER CHECK(day_of_week BETWEEN 0 AND 6),
  has_econ_event  TEXT DEFAULT '[]',
  vix_open        REAL,
  es_correlation  REAL,
  fingerprint     TEXT DEFAULT '{}',
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  timestamp   TEXT NOT NULL,
  timeframe   TEXT NOT NULL DEFAULT '5m',
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      INTEGER DEFAULT 0,
  UNIQUE(session_id, timestamp, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_candles_session ON candles(session_id);
CREATE INDEX IF NOT EXISTS idx_candles_timestamp ON candles(timestamp);

-- ============================================================
-- TRADES
-- ============================================================

CREATE TABLE IF NOT EXISTS trades (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             INTEGER REFERENCES sessions(id),
  source                 TEXT NOT NULL DEFAULT 'backtest' CHECK(source IN ('manual', 'backtest', 'mutation')),
  mutation_id            INTEGER REFERENCES mutations(id),
  direction              TEXT NOT NULL CHECK(direction IN ('long', 'short')),
  -- ORB data
  orb_high               REAL NOT NULL,
  orb_low                REAL NOT NULL,
  -- Signal sequence
  breakout_time          TEXT,
  breakout_candle_high   REAL,
  breakout_candle_low    REAL,
  breakout_candle_close  REAL,
  retest_time            TEXT,
  confirmation_time      TEXT,
  -- Entry / Exit
  entry_price            REAL NOT NULL,
  entry_time             TEXT NOT NULL,
  tp_price               REAL NOT NULL,
  tp_distance_ticks      INTEGER,
  sl_price               REAL NOT NULL,
  sl_distance_ticks      INTEGER,
  exit_price             REAL,
  exit_time              TEXT,
  exit_reason            TEXT,
  -- Result
  result                 TEXT CHECK(result IN ('win', 'loss', 'breakeven', 'time_exit', 'no_resolution')),
  pnl_ticks              REAL,
  pnl_dollars            REAL,
  -- Regime snapshot at trade time
  regime_snapshot        TEXT DEFAULT '{}',
  -- Manual trade extras
  confidence             INTEGER CHECK(confidence BETWEEN 1 AND 5),
  notes                  TEXT,
  screenshot_path        TEXT,
  -- Metadata
  date                   TEXT,
  created_at             TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source);
CREATE INDEX IF NOT EXISTS idx_trades_result ON trades(result);

-- ============================================================
-- CONFLICT RESOLUTIONS (persists across re-imports)
-- ============================================================

CREATE TABLE IF NOT EXISTS conflict_resolutions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date        TEXT NOT NULL,
  direction         TEXT NOT NULL,
  entry_price       REAL NOT NULL,
  resolved_result   TEXT NOT NULL CHECK(resolved_result IN ('win', 'loss')),
  resolved_exit     TEXT NOT NULL CHECK(resolved_exit IN ('tp', 'sl')),
  resolved_pnl_ticks REAL NOT NULL,
  resolved_pnl_dollars REAL NOT NULL,
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(trade_date, direction, entry_price)
);

-- ============================================================
-- THE LAB — MUTATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS mutations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  mutation_type     TEXT NOT NULL CHECK(mutation_type IN ('filter', 'entry', 'exit', 'sizing')),
  parameters        TEXT NOT NULL DEFAULT '{}',
  -- Backtest results
  total_trades      INTEGER,
  wins              INTEGER,
  losses            INTEGER,
  win_rate          REAL,
  profit_factor     REAL,
  sharpe_ratio      REAL,
  max_drawdown      REAL,
  avg_win_ticks     REAL,
  avg_loss_ticks    REAL,
  expectancy        REAL,
  -- Comparison to base
  base_win_rate     REAL,
  base_pf           REAL,
  improvement_pf    REAL,
  improvement_wr    REAL,
  trade_reduction   INTEGER,
  -- Validation
  status            TEXT DEFAULT 'testing' CHECK(status IN ('testing', 'validated', 'rejected')),
  walk_forward_pass INTEGER DEFAULT 0,
  validated_at      TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- THE ADVERSARY — VULNERABILITY FINDINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS adversary_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  regime_desc     TEXT NOT NULL,
  regime_filter   TEXT NOT NULL DEFAULT '{}',
  total_trades    INTEGER,
  wins            INTEGER,
  losses          INTEGER,
  win_rate        REAL,
  profit_factor   REAL,
  severity        TEXT CHECK(severity IN ('critical', 'high', 'moderate', 'low')),
  baseline_wr     REAL,
  baseline_pf     REAL,
  deviation_wr    REAL,
  deviation_pf    REAL,
  scan_date       TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- BRIEFINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS briefings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  date                 TEXT NOT NULL UNIQUE,
  confidence           TEXT CHECK(confidence IN ('high', 'moderate', 'low')),
  fingerprint_match    REAL,
  similar_sessions     INTEGER,
  adversary_clear      INTEGER DEFAULT 1,
  active_vulnerabilities TEXT DEFAULT '[]',
  key_levels           TEXT DEFAULT '{}',
  module_reports       TEXT DEFAULT '{}',
  recommendation       TEXT CHECK(recommendation IN ('trade', 'caution', 'sit_out')),
  narrative            TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- TOPSTEP ACCOUNT TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS topstep_account (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  balance         REAL NOT NULL,
  daily_pnl       REAL DEFAULT 0,
  trailing_dd     REAL,
  max_dd_buffer   REAL,
  trades_today    INTEGER DEFAULT 0,
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topstep_sync_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_source        TEXT NOT NULL DEFAULT 'manual',
  mode                  TEXT NOT NULL DEFAULT 'read_only',
  status                TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'partial', 'error', 'disabled', 'noop')),
  account_id            TEXT,
  account_rows          INTEGER NOT NULL DEFAULT 0,
  position_rows         INTEGER NOT NULL DEFAULT 0,
  fill_rows             INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  details_json          TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_sync_runs_created ON topstep_sync_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topstep_sync_runs_status ON topstep_sync_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS topstep_account_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id           INTEGER REFERENCES topstep_sync_runs(id) ON DELETE SET NULL,
  account_id            TEXT,
  account_name          TEXT,
  status                TEXT,
  balance               REAL,
  equity                REAL,
  daily_pnl             REAL,
  realized_pnl          REAL,
  unrealized_pnl        REAL,
  trailing_drawdown     REAL,
  max_drawdown_buffer   REAL,
  max_loss_limit        REAL,
  raw_json              TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_account_snapshots_created ON topstep_account_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topstep_account_snapshots_account ON topstep_account_snapshots(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS topstep_position_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id           INTEGER REFERENCES topstep_sync_runs(id) ON DELETE CASCADE,
  account_id            TEXT,
  symbol                TEXT,
  side                  TEXT,
  qty                   REAL,
  avg_price             REAL,
  mark_price            REAL,
  unrealized_pnl        REAL,
  realized_pnl          REAL,
  opened_at             TEXT,
  raw_json              TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_position_snapshots_sync ON topstep_position_snapshots(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_topstep_position_snapshots_symbol ON topstep_position_snapshots(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS topstep_fills (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  external_fill_id      TEXT UNIQUE,
  sync_run_id           INTEGER REFERENCES topstep_sync_runs(id) ON DELETE SET NULL,
  account_id            TEXT,
  order_id              TEXT,
  symbol                TEXT,
  side                  TEXT,
  qty                   REAL,
  price                 REAL,
  realized_pnl          REAL,
  fill_time             TEXT,
  raw_json              TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_fills_time ON topstep_fills(fill_time DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topstep_fills_symbol ON topstep_fills(symbol, fill_time DESC);

CREATE TABLE IF NOT EXISTS topstep_order_context (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  broker_order_id       TEXT NOT NULL UNIQUE,
  account_id            TEXT,
  symbol                TEXT,
  side                  TEXT,
  qty                   INTEGER,
  setup_id              TEXT,
  setup_name            TEXT,
  signal_time           TEXT,
  intent_id             INTEGER REFERENCES execution_order_intents(id) ON DELETE SET NULL,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_order_context_account ON topstep_order_context(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topstep_order_context_setup ON topstep_order_context(setup_id, created_at DESC);

CREATE TABLE IF NOT EXISTS topstep_auto_journal_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_source        TEXT NOT NULL DEFAULT 'manual',
  status                TEXT NOT NULL DEFAULT 'noop' CHECK(status IN ('ok', 'partial', 'noop', 'error', 'disabled')),
  fills_scanned         INTEGER NOT NULL DEFAULT 0,
  groups_detected       INTEGER NOT NULL DEFAULT 0,
  feedback_rows_added   INTEGER NOT NULL DEFAULT 0,
  fills_linked          INTEGER NOT NULL DEFAULT 0,
  total_pnl_dollars     REAL NOT NULL DEFAULT 0,
  error_message         TEXT,
  details_json          TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_auto_journal_runs_created ON topstep_auto_journal_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topstep_auto_journal_runs_status ON topstep_auto_journal_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS topstep_auto_journal_links (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_run_id        INTEGER REFERENCES topstep_auto_journal_runs(id) ON DELETE SET NULL,
  external_fill_id      TEXT NOT NULL UNIQUE,
  feedback_id           INTEGER REFERENCES trade_outcome_feedback(id) ON DELETE SET NULL,
  trade_date            TEXT,
  symbol                TEXT,
  order_id              TEXT,
  pnl_dollars           REAL,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topstep_auto_journal_links_trade_date ON topstep_auto_journal_links(trade_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topstep_auto_journal_links_feedback ON topstep_auto_journal_links(feedback_id, created_at DESC);

-- ============================================================
-- ACTIVITY LOG (While You Were Away)
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  module      TEXT NOT NULL,
  message     TEXT NOT NULL,
  severity    TEXT DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical', 'success')),
  data        TEXT DEFAULT '{}',
  read        INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_module ON activity_log(module);

-- ============================================================
-- IMPORTS TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,
  total_rows    INTEGER,
  total_candles INTEGER,
  sessions_added INTEGER,
  date_range_start TEXT,
  date_range_end   TEXT,
  status        TEXT DEFAULT 'success' CHECK(status IN ('success', 'partial', 'failed')),
  errors        TEXT DEFAULT '[]',
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS data_sync_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_source        TEXT NOT NULL DEFAULT 'manual',
  scanned_files         INTEGER NOT NULL DEFAULT 0,
  imported_files        INTEGER NOT NULL DEFAULT 0,
  sessions_added        INTEGER NOT NULL DEFAULT 0,
  candles_added         INTEGER NOT NULL DEFAULT 0,
  stale_before          INTEGER NOT NULL DEFAULT 0,
  stale_after           INTEGER NOT NULL DEFAULT 0,
  freshness_json        TEXT NOT NULL DEFAULT '{}',
  validation_json       TEXT NOT NULL DEFAULT '{}',
  details_json          TEXT NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'partial', 'error', 'noop')),
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_data_sync_runs_created ON data_sync_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_sync_runs_status ON data_sync_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_imports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  filename              TEXT NOT NULL,
  file_hash             TEXT NOT NULL UNIQUE,
  source                TEXT NOT NULL DEFAULT 'manual_upload',
  rows_read             INTEGER NOT NULL DEFAULT 0,
  trades_detected       INTEGER NOT NULL DEFAULT 0,
  feedback_rows_added   INTEGER NOT NULL DEFAULT 0,
  total_pnl_dollars     REAL DEFAULT 0,
  details_json          TEXT NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'partial', 'error', 'duplicate')),
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_imports_created ON reconciliation_imports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_imports_status ON reconciliation_imports(status, created_at DESC);

-- ============================================================
-- COACH + STRATEGY PROPOSALS
-- ============================================================

CREATE TABLE IF NOT EXISTS coach_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type      TEXT NOT NULL CHECK(run_type IN ('pre_market', 'post_session', 'nightly_check', 'manual')),
  summary       TEXT NOT NULL,
  payload       TEXT DEFAULT '{}',
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_proposals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL CHECK(category IN ('filter', 'entry', 'exit', 'sizing')),
  rationale           TEXT NOT NULL,
  proposed_filter     TEXT NOT NULL DEFAULT '{}',
  expected_impact     REAL DEFAULT 0,
  confidence          TEXT DEFAULT 'moderate' CHECK(confidence IN ('low', 'moderate', 'high')),
  source              TEXT DEFAULT 'coach',
  status              TEXT DEFAULT 'pending_approval' CHECK(status IN ('pending_approval', 'approved', 'rejected', 'applied')),
  reviewed_by         TEXT,
  review_notes        TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  reviewed_at         TEXT,
  applied_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON strategy_proposals(status);

CREATE TABLE IF NOT EXISTS proposal_validations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id         INTEGER NOT NULL UNIQUE REFERENCES strategy_proposals(id) ON DELETE CASCADE,
  target_trades       INTEGER NOT NULL DEFAULT 20,
  sample_size         INTEGER NOT NULL DEFAULT 0,
  win_rate            REAL,
  profit_factor       REAL,
  pnl_dollars         REAL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'passed', 'failed', 'live_eligible')),
  started_at          TEXT DEFAULT (datetime('now')),
  completed_at        TEXT,
  notes               TEXT
);

-- ============================================================
-- AGENT MEMORY (DAILY BRIEFING SNAPSHOTS)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_briefings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  briefing_date       TEXT NOT NULL,
  strategy            TEXT NOT NULL CHECK(strategy IN ('original', 'alt')),
  setup_score         INTEGER,
  setup_grade         TEXT,
  edge_score          INTEGER,
  next_action         TEXT,
  risk_mode           TEXT,
  win_rate            REAL,
  profit_factor       REAL,
  total_pnl_dollars   REAL,
  total_trades        INTEGER,
  top_opportunity     TEXT,
  payload             TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(briefing_date, strategy)
);

CREATE INDEX IF NOT EXISTS idx_agent_briefings_date ON agent_briefings(briefing_date DESC);
CREATE INDEX IF NOT EXISTS idx_agent_briefings_strategy ON agent_briefings(strategy);

-- ============================================================
-- DISCOVERY LAB (NON-ORB STRATEGY RESEARCH)
-- ============================================================

CREATE TABLE IF NOT EXISTS discovery_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mode                TEXT NOT NULL DEFAULT 'full_scan',
  candidate_count     INTEGER NOT NULL DEFAULT 0,
  recommended_count   INTEGER NOT NULL DEFAULT 0,
  payload             TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              INTEGER NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  strategy_key        TEXT NOT NULL,
  name                TEXT NOT NULL,
  hypothesis          TEXT,
  rules               TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL CHECK(status IN ('rejected', 'watchlist', 'live_eligible')),
  robustness_score    REAL DEFAULT 0,
  failure_reasons     TEXT NOT NULL DEFAULT '[]',
  train_metrics       TEXT NOT NULL DEFAULT '{}',
  valid_metrics       TEXT NOT NULL DEFAULT '{}',
  test_metrics        TEXT NOT NULL DEFAULT '{}',
  overall_metrics     TEXT NOT NULL DEFAULT '{}',
  payload             TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_created ON discovery_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_candidates_run ON discovery_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_candidates_status ON discovery_candidates(status);

CREATE TABLE IF NOT EXISTS discovery_validations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id        INTEGER NOT NULL UNIQUE REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL DEFAULT 'paper_forward' CHECK(mode IN ('paper_forward')),
  start_date          TEXT NOT NULL,
  target_trades       INTEGER NOT NULL DEFAULT 20,
  sample_size         INTEGER NOT NULL DEFAULT 0,
  win_rate            REAL,
  profit_factor       REAL,
  pnl_dollars         REAL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'failed', 'live_eligible')),
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_validations_status ON discovery_validations(status);
CREATE INDEX IF NOT EXISTS idx_discovery_validations_start_date ON discovery_validations(start_date);

CREATE TABLE IF NOT EXISTS discovery_promotions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id        INTEGER NOT NULL UNIQUE REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  validation_id       INTEGER NOT NULL REFERENCES discovery_validations(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved', 'rejected', 'applied')),
  reviewed_by         TEXT DEFAULT 'owner',
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  applied_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_promotions_status ON discovery_promotions(status);

CREATE TABLE IF NOT EXISTS discovery_reminders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id        INTEGER NOT NULL UNIQUE REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  time_local          TEXT NOT NULL DEFAULT '09:20', -- HH:MM
  timezone            TEXT NOT NULL DEFAULT 'America/New_York',
  active              INTEGER NOT NULL DEFAULT 1,
  last_sent_date      TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discovery_reminders_active ON discovery_reminders(active);

CREATE TABLE IF NOT EXISTS assistant_notifications (
  id                  INTEGER PRIMARY KEY CHECK(id = 1),
  active              INTEGER NOT NULL DEFAULT 0,
  discord_webhook_url TEXT,
  opportunity_alerts  INTEGER NOT NULL DEFAULT 1,
  approval_alerts     INTEGER NOT NULL DEFAULT 1,
  reminder_alerts     INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assistant_push_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  push_date           TEXT NOT NULL,
  push_tag            TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'discord_dm',
  created_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(push_date, push_tag, channel)
);

CREATE TABLE IF NOT EXISTS execution_controls (
  id                        INTEGER PRIMARY KEY CHECK(id = 1),
  enabled                   INTEGER NOT NULL DEFAULT 0,
  kill_switch               INTEGER NOT NULL DEFAULT 1,
  max_position_size         INTEGER NOT NULL DEFAULT 1,
  max_daily_loss_dollars    REAL NOT NULL DEFAULT 500,
  allowed_symbols           TEXT NOT NULL DEFAULT '["MNQ"]',
  require_two_step_confirm  INTEGER NOT NULL DEFAULT 1,
  updated_at                TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_guardrails (
  id                              INTEGER PRIMARY KEY CHECK(id = 1),
  max_orders_per_day              INTEGER NOT NULL DEFAULT 3,
  min_order_cooldown_seconds      INTEGER NOT NULL DEFAULT 120,
  duplicate_order_lock_seconds    INTEGER NOT NULL DEFAULT 90,
  news_lockout_minutes_before     INTEGER NOT NULL DEFAULT 12,
  news_lockout_minutes_after      INTEGER NOT NULL DEFAULT 8,
  require_fresh_data              INTEGER NOT NULL DEFAULT 1,
  updated_at                      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS live_trade_state (
  id                        INTEGER PRIMARY KEY CHECK(id = 1),
  as_of                     TEXT,
  symbol                    TEXT,
  side                      TEXT CHECK(side IN ('long', 'short')),
  in_position               INTEGER NOT NULL DEFAULT 0,
  qty                       INTEGER DEFAULT 0,
  entry_price               REAL,
  last_price                REAL,
  pnl_ticks                 REAL DEFAULT 0,
  pnl_dollars               REAL DEFAULT 0,
  risk_left_dollars         REAL,
  notes                     TEXT,
  updated_at                TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_order_intents (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at                TEXT DEFAULT (datetime('now')),
  expires_at                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'expired', 'rejected')),
  source                    TEXT DEFAULT 'api',
  requested_by              TEXT,
  symbol                    TEXT NOT NULL,
  side                      TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  qty                       INTEGER NOT NULL,
  meta                      TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_exec_order_intents_status ON execution_order_intents(status);

CREATE TABLE IF NOT EXISTS execution_autonomy (
  id                        INTEGER PRIMARY KEY CHECK(id = 1),
  mode                      TEXT NOT NULL DEFAULT 'manual' CHECK(mode IN ('manual', 'paper_auto', 'live_assist')),
  proactive_morning_enabled INTEGER NOT NULL DEFAULT 1,
  proactive_morning_time    TEXT NOT NULL DEFAULT '08:50',
  proactive_timezone        TEXT NOT NULL DEFAULT 'America/New_York',
  paper_auto_enabled        INTEGER NOT NULL DEFAULT 0,
  paper_auto_window_start   TEXT NOT NULL DEFAULT '09:45',
  paper_auto_window_end     TEXT NOT NULL DEFAULT '11:00',
  min_setup_probability     REAL NOT NULL DEFAULT 55,
  min_confidence_pct        REAL NOT NULL DEFAULT 60,
  require_open_risk_clear   INTEGER NOT NULL DEFAULT 1,
  max_paper_actions_per_day INTEGER NOT NULL DEFAULT 2,
  last_paper_action_date    TEXT,
  last_paper_action_count   INTEGER NOT NULL DEFAULT 0,
  updated_at                TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS autonomy_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date          TEXT NOT NULL,
  event_time          TEXT NOT NULL,
  event_type          TEXT NOT NULL CHECK(event_type IN ('paper_signal', 'paper_skip', 'mode_change', 'morning_autopilot', 'autonomy_error')),
  status              TEXT NOT NULL CHECK(status IN ('info', 'executed', 'skipped', 'blocked', 'error')),
  payload             TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_autonomy_events_date ON autonomy_events(event_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomy_events_type ON autonomy_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_outcome_feedback (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id            INTEGER REFERENCES trades(id) ON DELETE SET NULL,
  trade_date          TEXT NOT NULL,
  setup_id            TEXT NOT NULL,
  setup_name          TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK(outcome IN ('win', 'loss', 'breakeven')),
  pnl_dollars         REAL,
  notes               TEXT,
  source              TEXT NOT NULL DEFAULT 'manual',
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_trade_date ON trade_outcome_feedback(trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_setup ON trade_outcome_feedback(setup_id, created_at DESC);

-- ============================================================
-- UNIFIED INTELLIGENCE — KNOWLEDGE GRAPH
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_entities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key          TEXT NOT NULL UNIQUE,
  entity_type         TEXT NOT NULL,
  label               TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 0.5,
  trade_count         INTEGER NOT NULL DEFAULT 0,
  win_count           INTEGER NOT NULL DEFAULT 0,
  loss_count          INTEGER NOT NULL DEFAULT 0,
  avg_rr              REAL,
  last_seen_at        TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_conf ON kg_entities(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_kg_entities_active ON kg_entities(is_active, entity_type);

CREATE TABLE IF NOT EXISTS kg_observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id           INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  obs_type            TEXT NOT NULL,
  source_module       TEXT NOT NULL,
  trade_date          TEXT,
  session_date        TEXT,
  value_text          TEXT,
  value_numeric       REAL,
  value_json          TEXT NOT NULL DEFAULT '{}',
  confidence          REAL NOT NULL DEFAULT 0.5,
  is_verified         INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_obs_entity ON kg_observations(entity_id, obs_type);
CREATE INDEX IF NOT EXISTS idx_kg_obs_date ON kg_observations(trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_kg_obs_source ON kg_observations(source_module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_obs_session_date ON kg_observations(session_date DESC);

CREATE TABLE IF NOT EXISTS kg_relations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id      INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  to_entity_id        INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation_type       TEXT NOT NULL,
  strength            REAL NOT NULL DEFAULT 0.5,
  occurrence_count    INTEGER NOT NULL DEFAULT 1,
  metadata            TEXT NOT NULL DEFAULT '{}',
  last_occurred_at    TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_kg_rel_from ON kg_relations(from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_kg_rel_to ON kg_relations(to_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_kg_rel_strength ON kg_relations(strength DESC);

CREATE TABLE IF NOT EXISTS kg_insights (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  insight_key         TEXT NOT NULL UNIQUE,
  scope               TEXT NOT NULL DEFAULT 'global',
  signal              TEXT NOT NULL CHECK(signal IN ('GO', 'WAIT', 'NO-TRADE')),
  confidence_pct      REAL NOT NULL DEFAULT 0,
  blocker_count       INTEGER NOT NULL DEFAULT 0,
  reason              TEXT NOT NULL,
  details_json        TEXT NOT NULL DEFAULT '{}',
  trade_date          TEXT,
  expires_at          TEXT,
  source_module       TEXT NOT NULL DEFAULT 'system',
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_insights_scope_date ON kg_insights(scope, trade_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_insights_signal ON kg_insights(signal, created_at DESC);

CREATE TABLE IF NOT EXISTS score_weights (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT NOT NULL DEFAULT 'global',
  w_discovery         REAL NOT NULL DEFAULT 0.34,
  w_intel             REAL NOT NULL DEFAULT 0.33,
  w_execution         REAL NOT NULL DEFAULT 0.33,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending')),
  proposed_by         TEXT NOT NULL DEFAULT 'system',
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(scope, status)
);

CREATE TABLE IF NOT EXISTS score_thresholds (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT NOT NULL DEFAULT 'global',
  go_threshold        REAL NOT NULL DEFAULT 72,
  wait_threshold      REAL NOT NULL DEFAULT 50,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_score_thresholds_scope_active ON score_thresholds(scope, active);

CREATE TABLE IF NOT EXISTS self_heal_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_source      TEXT NOT NULL DEFAULT 'scheduler',
  status              TEXT NOT NULL CHECK(status IN ('ok', 'remediated', 'failed')),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  issues_json         TEXT NOT NULL DEFAULT '[]',
  actions_json        TEXT NOT NULL DEFAULT '[]',
  details_json        TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_self_heal_events_created ON self_heal_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_heal_events_status ON self_heal_events(status, created_at DESC);

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

CREATE TABLE IF NOT EXISTS model_eval_runs (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_source            TEXT NOT NULL DEFAULT 'manual',
  interpreter_passed        INTEGER NOT NULL DEFAULT 0,
  decision_passed           INTEGER NOT NULL DEFAULT 0,
  details_json              TEXT NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'failed' CHECK(status IN ('passed', 'failed')),
  created_at                TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_eval_runs_created ON model_eval_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_eval_runs_status ON model_eval_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_lifecycle (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_type             TEXT NOT NULL CHECK(strategy_type IN ('discovery', 'proposal')),
  strategy_id               INTEGER NOT NULL,
  stage                     TEXT NOT NULL CHECK(stage IN ('research', 'paper', 'live', 'rolled_back')),
  status                    TEXT NOT NULL CHECK(status IN ('active', 'paused', 'retired')),
  activation_date           TEXT,
  rollback_date             TEXT,
  quality_gate_json         TEXT NOT NULL DEFAULT '{}',
  metrics_json              TEXT NOT NULL DEFAULT '{}',
  notes                     TEXT,
  created_at                TEXT DEFAULT (datetime('now')),
  updated_at                TEXT DEFAULT (datetime('now')),
  UNIQUE(strategy_type, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_lifecycle_stage ON strategy_lifecycle(stage, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS jarvis_location_events (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                TEXT NOT NULL,
  client_id                 TEXT,
  lat                       REAL NOT NULL,
  lon                       REAL NOT NULL,
  accuracy                  REAL,
  ts                        TEXT NOT NULL,
  source                    TEXT,
  user_agent                TEXT,
  consent                   INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jarvis_location_events_session ON jarvis_location_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jarvis_location_events_created ON jarvis_location_events(created_at DESC);

CREATE TABLE IF NOT EXISTS jarvis_state_kv (
  state_type                TEXT NOT NULL,
  state_key                 TEXT NOT NULL,
  session_id                TEXT,
  client_id                 TEXT,
  session_key               TEXT,
  payload_json              TEXT NOT NULL DEFAULT '{}',
  created_at_ms             INTEGER NOT NULL,
  updated_at_ms             INTEGER NOT NULL,
  expires_at_ms             INTEGER,
  PRIMARY KEY (state_type, state_key)
);

CREATE INDEX IF NOT EXISTS idx_jarvis_state_kv_type_expires ON jarvis_state_kv(state_type, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_jarvis_state_kv_client_type ON jarvis_state_kv(client_id, state_type, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_jarvis_state_kv_session_type ON jarvis_state_kv(session_id, state_type, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS jarvis_complaints (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at                TEXT DEFAULT (datetime('now')),
  session_id                TEXT,
  client_id                 TEXT,
  trace_id                  TEXT,
  intent                    TEXT,
  selected_skill            TEXT,
  route_path                TEXT,
  tools_used_json           TEXT NOT NULL DEFAULT '[]',
  prompt                    TEXT NOT NULL,
  reply                     TEXT NOT NULL,
  notes                     TEXT,
  metadata_json             TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_jarvis_complaints_created ON jarvis_complaints(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jarvis_complaints_trace ON jarvis_complaints(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jarvis_complaints_skill ON jarvis_complaints(selected_skill, created_at DESC);

-- ============================================================
-- DATA FOUNDATION (INGESTION / EVIDENCE PIPELINE)
-- ============================================================

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
