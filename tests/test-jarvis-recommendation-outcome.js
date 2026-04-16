#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  upsertTodayRecommendationContext,
  evaluateRecommendationOutcomeDay,
  buildRecommendationPerformance,
  evaluateLiveContextCreationGuard,
  auditAndSuppressInvalidLiveContexts,
  LIVE_CONTEXT_GUARD_STATUS_ENUM,
  ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_ENUM,
  MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_ENUM,
  SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
  SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
  SHADOW_PLAYBOOK_LANE_LABEL_ENUM,
  SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET,
  SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM,
  SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM,
  SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM,
  REALIZED_TRUTH_SOURCE_ENUM,
  SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_ENUM,
  classifyAssistantDecisionOutcomeCheckpoint,
  classifyModelVsRealizedDivergence,
  classifyFailedExtensionReversalFadeShadowLane,
  classifyFailedExtensionReversalFadeShadowPredecisionLane,
  splitFailedExtensionLaneReasonCodes,
  summarizeShadowPlaybookLaneDurability,
  getJarvisSimulatedTradeOutcomeForDate,
  getLateEntryPolicyExperimentForDate,
  buildLateEntryPolicyExperimentRow,
  upsertLateEntryPolicyExperimentRow,
  summarizeLateEntryPolicyExperiment,
  buildLateEntryPolicyCommonDateComparison,
  buildLateEntryShadowLeader,
  buildLateEntryPolicyPromotionReadinessPanel,
  classifyLateEntryPolicyTruthFinalizationBlocker,
  buildLateEntryPolicyTruthFinalizationQueue,
  buildLateEntryPolicyTruthBlockerDiagnostics,
  buildLateEntryPolicyTruthBlockerAudit,
  classifyLateEntryPolicyContextGap,
  buildLateEntryPolicyContextGapAudit,
  runLateEntryPolicyContextBackfillRun,
  buildLateEntryPolicyTruthRepairPlanner,
  buildLateEntryPolicyTruthDependencySplit,
  runLateEntryPolicyTruthBackfillRun,
  buildLateEntryPolicyCoverageAccelerationSummary,
  buildLateEntryPolicyTruthCoverageBacklog,
  buildLateEntryPolicyTruthCoverageLedger,
  buildLateEntryPolicyPromotionDossier,
  buildLateEntryPolicyManualReviewTrigger,
  buildLateEntryPolicyTruthAccumulationTrend,
  LATE_ENTRY_POLICY_EXPERIMENT_KEY,
  LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
  LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
  LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
  LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
  LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
  LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
  LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
  LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
  LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM,
  LATE_ENTRY_POLICY_V3_COMPARISON_ENUM,
  LATE_ENTRY_POLICY_V4_COMPARISON_ENUM,
  LATE_ENTRY_POLICY_V5_COMPARISON_ENUM,
  getLatestTooAggressiveCheckpointSentinel,
  upsertShadowPlaybookEvaluation,
  ensureRecommendationOutcomeSchema,
} = require('../server/jarvis-core/recommendation-outcome');
const { runTradeMechanicsVariantTool } = require('../server/tools/tradeMechanicsVariantTool');
const {
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 120000;

function candle(ts, open, high, low, close) {
  return { timestamp: ts, open, high, low, close, volume: 1000 };
}

function createTestDb() {
  const db = new Database(':memory:');
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
    CREATE TABLE IF NOT EXISTS trade_outcome_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      setup_id TEXT NOT NULL,
      setup_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      pnl_dollars REAL,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE IF NOT EXISTS topstep_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS topstep_auto_journal_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_run_id INTEGER,
      external_fill_id TEXT,
      feedback_id INTEGER,
      trade_date TEXT,
      symbol TEXT,
      order_id TEXT,
      pnl_dollars REAL
    );
    CREATE TABLE IF NOT EXISTS topstep_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fill_id TEXT,
      fill_time TEXT,
      account_id TEXT,
      symbol TEXT,
      qty REAL,
      price REAL,
      pnl_dollars REAL
    );
    CREATE TABLE IF NOT EXISTS jarvis_complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      session_id TEXT,
      client_id TEXT,
      trace_id TEXT,
      intent TEXT,
      selected_skill TEXT,
      route_path TEXT,
      tools_used_json TEXT NOT NULL DEFAULT '[]',
      prompt TEXT NOT NULL,
      reply TEXT NOT NULL,
      notes TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function insertTrade(db, row) {
  db.prepare(`
    INSERT INTO trades (date, direction, entry_price, entry_time, exit_time, result, pnl_ticks, pnl_dollars)
    VALUES (@date, @direction, @entry_price, @entry_time, @exit_time, @result, @pnl_ticks, @pnl_dollars)
  `).run(row);
}

function insertTradeOutcomeFeedback(db, row) {
  return db.prepare(`
    INSERT INTO trade_outcome_feedback (
      trade_date, setup_id, setup_name, outcome, pnl_dollars, source
    ) VALUES (
      @trade_date, @setup_id, @setup_name, @outcome, @pnl_dollars, @source
    )
  `).run(row);
}

function buildStrategySnapshot(dates = []) {
  const originalPerDate = {};
  const variantPerDate = {};
  for (const date of dates) {
    originalPerDate[date] = {
      wouldTrade: true,
      tradeResult: 'win',
      tradePnlDollars: 120,
      tradePnlTicks: 24,
    };
    variantPerDate[date] = {
      wouldTrade: true,
      tradeResult: 'loss',
      tradePnlDollars: -80,
      tradePnlTicks: -16,
    };
  }
  return {
    layers: {
      original: {
        key: 'original_plan_orb_3130',
        name: 'Original Trading Plan',
        perDate: originalPerDate,
      },
      variants: {
        tested: [
          {
            key: 'variant_skip_monday',
            name: 'Overlay Variant',
            perDate: variantPerDate,
          },
        ],
      },
    },
  };
}

function buildSessionsByDate(dates = []) {
  const sessions = {};
  for (const date of dates) {
    sessions[date] = [
      candle(`${date} 09:55`, 22090, 22105, 22085, 22100),
      candle(`${date} 10:00`, 22100, 22108, 22098, 22100),
      candle(`${date} 10:05`, 22100, 22130, 22095, 22110),
      candle(`${date} 10:10`, 22110, 22120, 22040, 22060),
      candle(`${date} 10:15`, 22060, 22080, 22020, 22030),
      candle(`${date} 10:20`, 22030, 22060, 22000, 22010),
    ];
  }
  return sessions;
}

function buildFailedExtensionReversalShadowCandles(date) {
  return [
    candle(`${date} 09:30`, 100, 103, 99, 102),
    candle(`${date} 09:35`, 102, 104, 101, 103),
    candle(`${date} 09:40`, 103, 105, 102, 104),
    candle(`${date} 09:45`, 104, 108, 103, 107), // up extension above ORB high
    candle(`${date} 09:50`, 107, 108, 98, 100),  // down extension below ORB low + reclaim inside range
    candle(`${date} 09:55`, 100, 102, 97, 98),
    candle(`${date} 10:00`, 98, 99, 95, 96),
    candle(`${date} 10:05`, 96, 100, 95, 99),
    candle(`${date} 10:10`, 99, 101, 98, 100),
  ];
}

function buildLateEntryExtensionCandles(date, confirmationTime = '11:40', retestTime = '11:20') {
  return [
    candle(`${date} 09:30`, 22000, 22012, 21996, 22008),
    candle(`${date} 09:35`, 22008, 22020, 22002, 22014),
    candle(`${date} 09:40`, 22014, 22018, 21990, 22002),
    candle(`${date} 09:45`, 22002, 22008, 21996, 22000),
    candle(`${date} 10:20`, 22000, 22038, 21998, 22030), // breakout > ORB high
    candle(`${date} 10:55`, 22030, 22034, 22022, 22028),
    candle(`${date} ${retestTime}`, 22028, 22031, 22018, 22022), // retest touches ORB high
    candle(`${date} ${confirmationTime}`, 22022, 22040, 22020, 22035), // confirmation entry
    candle(`${date} 12:05`, 22035, 22060, 22034, 22055), // nearest likely hit
    candle(`${date} 12:20`, 22055, 22112, 22050, 22105), // skip2 likely hit
    candle(`${date} 12:45`, 22105, 22120, 22090, 22110),
    candle(`${date} 13:30`, 22110, 22116, 22088, 22095),
  ];
}

function buildLateEntryNoReplayCandles(date) {
  return [
    candle(`${date} 09:30`, 22000, 22006, 21996, 22002),
    candle(`${date} 09:35`, 22002, 22007, 21998, 22001),
    candle(`${date} 09:40`, 22001, 22005, 21999, 22000),
    candle(`${date} 10:00`, 22000, 22004, 21998, 22001),
    candle(`${date} 10:30`, 22001, 22005, 21999, 22000),
    candle(`${date} 11:00`, 22000, 22003, 21998, 22001),
    candle(`${date} 11:30`, 22001, 22004, 21999, 22000),
    candle(`${date} 12:00`, 22000, 22003, 21998, 22001),
    candle(`${date} 12:30`, 22001, 22005, 21999, 22002),
  ];
}

function insertLateEntryPolicyFixtureRow(db, {
  tradeDate,
  policyKey,
  policyVersion = 'v1',
  sourceType = 'live',
  reconstructionPhase = 'live_intraday',
  selectedOutcome = 'no_trade',
  selectedPnl = null,
  baselineOutcome = 'no_trade',
  baselinePnl = null,
  hard1200Outcome = 'no_trade',
  hard1200Pnl = null,
  noCutoffOutcome = 'no_trade',
  noCutoffPnl = null,
  broadReplayOutcome = 'no_trade',
  broadReplayPnl = null,
  entryTime = null,
  weekday = 'Thursday',
  regimeLabel = 'ranging|extreme|wide',
  bucket = '11:30-12:00',
} = {}) {
  const lane = policyKey.endsWith('_v5')
    ? 'v5'
    : (policyKey.endsWith('_v4')
      ? 'v4'
      : (policyKey.endsWith('_v3')
        ? 'v3'
        : (policyKey.endsWith('_v2') ? 'v2' : 'v1')));
  const modeOutcomes = {
    nearest: { outcome: broadReplayOutcome, pnl: broadReplayPnl },
    skip1: { outcome: broadReplayOutcome, pnl: broadReplayPnl },
    skip2: { outcome: broadReplayOutcome, pnl: broadReplayPnl },
  };
  const summary = {
    tradeDate,
    policyKey,
    policyVersion,
    policyLane: lane,
    weekday,
    regimeLabel,
    diagnostics: { confirmationTimeBucket: bucket },
    baseline: {
      entryTime: null,
      modeOutcomes: {
        skip2: { outcome: baselineOutcome, pnl: baselinePnl },
      },
    },
    baselineDecision: {
      wouldTrade: baselineOutcome !== 'no_trade',
      entryTime: null,
    },
    extensionPolicyDecision: {
      wouldTrade: selectedOutcome !== 'no_trade',
      entryTime: entryTime || null,
    },
    hard1200: {
      entryTime: entryTime || null,
      modeOutcomes: {
        skip2: { outcome: hard1200Outcome, pnl: hard1200Pnl },
      },
    },
    hard1200Replay: {
      wouldTrade: hard1200Outcome !== 'no_trade',
      entryTime: entryTime || null,
      modeOutcomes: {
        skip2: { outcome: hard1200Outcome, pnl: hard1200Pnl },
      },
    },
    noCutoff: {
      entryTime: entryTime || null,
      modeOutcomes: {
        skip2: { outcome: noCutoffOutcome, pnl: noCutoffPnl },
      },
    },
    noCutoffReplay: {
      wouldTrade: noCutoffOutcome !== 'no_trade',
      entryTime: entryTime || null,
      modeOutcomes: {
        skip2: { outcome: noCutoffOutcome, pnl: noCutoffPnl },
      },
    },
    broadReplayReference: {
      laneKey: 'late_entry_broad_replay_reference',
      sourceVariant: 'hard_1200',
      wouldTrade: broadReplayOutcome !== 'no_trade',
      entryTime: entryTime || null,
      modeOutcomes,
      selectedOutcome: {
        outcome: broadReplayOutcome,
        pnl: broadReplayPnl,
      },
    },
    tpReplayComparison: {
      Nearest: { outcome: broadReplayOutcome, pnl: broadReplayPnl },
      Skip1: { outcome: broadReplayOutcome, pnl: broadReplayPnl },
      Skip2: { outcome: broadReplayOutcome, pnl: broadReplayPnl },
    },
  };
  db.prepare(`
    INSERT INTO late_entry_policy_experiment_daily (
      trade_date,
      policy_key,
      policy_version,
      source_type,
      reconstruction_phase,
      baseline_would_trade,
      baseline_no_trade_reason,
      extension_would_trade,
      extension_decision_reason,
      extension_reason_codes_json,
      entry_time,
      direction,
      strategy_key,
      strategy_name,
      selected_tp_mode,
      selected_outcome,
      selected_pnl,
      nearest_outcome,
      nearest_pnl,
      skip1_outcome,
      skip1_pnl,
      skip2_outcome,
      skip2_pnl,
      regime_label,
      weekday,
      orb_range_ticks,
      confirmation_time_bucket,
      source_candles_complete,
      simulation_confidence,
      summary_json
    ) VALUES (
      @trade_date,
      @policy_key,
      @policy_version,
      @source_type,
      @reconstruction_phase,
      @baseline_would_trade,
      @baseline_no_trade_reason,
      @extension_would_trade,
      @extension_decision_reason,
      @extension_reason_codes_json,
      @entry_time,
      @direction,
      @strategy_key,
      @strategy_name,
      @selected_tp_mode,
      @selected_outcome,
      @selected_pnl,
      @nearest_outcome,
      @nearest_pnl,
      @skip1_outcome,
      @skip1_pnl,
      @skip2_outcome,
      @skip2_pnl,
      @regime_label,
      @weekday,
      @orb_range_ticks,
      @confirmation_time_bucket,
      @source_candles_complete,
      @simulation_confidence,
      @summary_json
    )
  `).run({
    trade_date: tradeDate,
    policy_key: policyKey,
    policy_version: policyVersion,
    source_type: sourceType,
    reconstruction_phase: reconstructionPhase,
    baseline_would_trade: baselineOutcome !== 'no_trade' ? 1 : 0,
    baseline_no_trade_reason: baselineOutcome === 'no_trade' ? 'entry_after_max_hour' : null,
    extension_would_trade: selectedOutcome !== 'no_trade' ? 1 : 0,
    extension_decision_reason: selectedOutcome !== 'no_trade' ? 'extension_gate_passed' : 'extension_gate_rejected',
    extension_reason_codes_json: JSON.stringify(selectedOutcome !== 'no_trade' ? ['extension_gate_passed'] : ['extension_gate_rejected']),
    entry_time: entryTime,
    direction: 'long',
    strategy_key: 'original_plan_orb_3130',
    strategy_name: 'Original Trading Plan',
    selected_tp_mode: 'Skip 2',
    selected_outcome: selectedOutcome,
    selected_pnl: selectedPnl,
    nearest_outcome: selectedOutcome,
    nearest_pnl: selectedPnl,
    skip1_outcome: selectedOutcome,
    skip1_pnl: selectedPnl,
    skip2_outcome: selectedOutcome,
    skip2_pnl: selectedPnl,
    regime_label: regimeLabel,
    weekday,
    orb_range_ticks: 320,
    confirmation_time_bucket: bucket,
    source_candles_complete: 1,
    simulation_confidence: 0.95,
    summary_json: JSON.stringify(summary),
  });
}

function runUnitChecks() {
  const db = createTestDb();
  const date = '2026-03-06';
  insertTrade(db, {
    date,
    direction: 'long',
    entry_price: 22100,
    entry_time: `${date} 10:00`,
    exit_time: `${date} 10:15`,
    result: 'win',
    pnl_ticks: 24,
    pnl_dollars: 120,
  });

  upsertTodayRecommendationContext({
    db,
    recDate: date,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 62,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
    },
  });

  const row = db.prepare('SELECT * FROM jarvis_recommendation_context_history WHERE rec_date = ? AND source_type = ?').get(date, 'live');
  assert(row, 'recommendation context row should be persisted');
  assert(LIVE_CONTEXT_GUARD_STATUS_ENUM.includes(String(row ? 'allowed_live_context' : '')), 'live guard enum should include allowed status');

  const weekendDate = '2026-03-07';
  const rejectedWeekend = upsertTodayRecommendationContext({
    db,
    recDate: weekendDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${weekendDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
    },
    context: {
      nowEt: { date: weekendDate, time: '09:25' },
    },
    triggerSource: 'unit_test_weekend_reject',
  });
  assert(rejectedWeekend && rejectedWeekend.contextCreationAllowed === false, 'weekend live context should be rejected');
  assert(rejectedWeekend.contextCreationStatus === 'rejected_non_trading_day', 'weekend rejection status mismatch');
  const weekendRow = db.prepare(`
    SELECT id
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
  `).get(weekendDate);
  assert(!weekendRow, 'weekend live context should not be inserted');
  const weekendAudit = db.prepare(`
    SELECT creation_status, reason_code
    FROM jarvis_live_context_creation_audit
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    ORDER BY id DESC
    LIMIT 1
  `).get(weekendDate);
  assert(weekendAudit && weekendAudit.creation_status === 'rejected_non_trading_day', 'weekend rejection should be audited');

  const invalidMappingDate = '2026-03-08';
  const rejectedInvalidMapping = upsertTodayRecommendationContext({
    db,
    recDate: invalidMappingDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${invalidMappingDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
    },
    sessions: {
      [invalidMappingDate]: buildSessionsByDate([invalidMappingDate])[invalidMappingDate],
    },
    context: {
      nowEt: { date: invalidMappingDate, time: '09:25' },
    },
    triggerSource: 'unit_test_invalid_mapping_reject',
  });
  assert(rejectedInvalidMapping && rejectedInvalidMapping.contextCreationAllowed === false, 'invalid-mapping live context should be rejected');
  assert(rejectedInvalidMapping.contextCreationStatus === 'rejected_invalid_mapping', 'invalid mapping rejection status mismatch');
  const invalidMappingAudit = db.prepare(`
    SELECT creation_status, reason_code
    FROM jarvis_live_context_creation_audit
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    ORDER BY id DESC
    LIMIT 1
  `).get(invalidMappingDate);
  assert(invalidMappingAudit && invalidMappingAudit.creation_status === 'rejected_invalid_mapping', 'invalid mapping rejection should be audited');

  const guardCheck = evaluateLiveContextCreationGuard({
    recDate: '2026-03-10',
    context: { nowEt: { date: '2026-03-10', time: '09:25' } },
    sessions: {},
  });
  assert(guardCheck.status === 'allowed_live_context', 'valid weekday guard should allow live context creation');

  const legacyInvalidDate = '2026-03-14';
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
    ) VALUES (?, 'live', 'live_intraday', 'legacy_test', ?, 'trade_selectively', 'original_plan_orb_3130', 'Original Trading Plan', 'Skip 2', 'low', 40, '{}', '{}', '{}', ?)
  `).run(
    legacyInvalidDate,
    `${legacyInvalidDate}T09:20:00.000Z`,
    JSON.stringify({ nowEt: { date: legacyInvalidDate, time: '09:20' }, source: 'legacy_insert_test' })
  );
  const suppressionAudit = auditAndSuppressInvalidLiveContexts({
    db,
    nowDate: '2026-03-15',
    sessions: {},
    lookbackDays: 20,
    triggerSource: 'unit_test_suppression_audit',
  });
  assert(Number(suppressionAudit?.invalidLiveContextsFound || 0) >= 1, 'suppression audit should find legacy invalid live contexts');
  assert(Number(suppressionAudit?.invalidLiveContextsActive || 0) >= 1, 'suppression audit should activate suppression rows');
  assert(Array.isArray(suppressionAudit?.latestInvalidLiveContextDates), 'suppression audit latest invalid dates missing');
  const suppressionRow = db.prepare(`
    SELECT is_active, suppression_status, reason_code
    FROM jarvis_live_context_suppression
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(legacyInvalidDate);
  assert(suppressionRow && Number(suppressionRow.is_active || 0) === 1, 'legacy invalid live context should be actively suppressed');
  assert(String(suppressionRow.suppression_status || '') === 'suppressed', 'legacy invalid context suppression status should be suppressed');

  const sessions = buildSessionsByDate([date]);
  const strategySnapshot = buildStrategySnapshot([date]);
  const daily = evaluateRecommendationOutcomeDay({
    db,
    date,
    contextRow: row,
    sessions,
    strategySnapshot,
    runTradeMechanicsVariantTool,
  });

  assert(daily && typeof daily === 'object', 'daily recommendation outcome missing');
  assert(['correct', 'partially_correct', 'incorrect'].includes(String(daily.postureEvaluation || '')), 'invalid postureEvaluation');
  assert(daily.strategyRecommendationScore && typeof daily.strategyRecommendationScore === 'object', 'strategyRecommendationScore missing');
  assert(['correct', 'partially_correct', 'incorrect', 'unknown'].includes(String(daily.strategyRecommendationScore.scoreLabel || '')), 'invalid strategy score label');
  assert(daily.tpRecommendationScore && typeof daily.tpRecommendationScore === 'object', 'tpRecommendationScore missing');
  assert(['correct', 'partially_correct', 'incorrect', 'unknown'].includes(String(daily.tpRecommendationScore.scoreLabel || '')), 'invalid tp score label');
  assert(Object.prototype.hasOwnProperty.call(daily, 'actualPnL'), 'actualPnL missing');
  assert(Object.prototype.hasOwnProperty.call(daily, 'bestPossiblePnL'), 'bestPossiblePnL missing');
  assert(Object.prototype.hasOwnProperty.call(daily, 'recommendationDelta'), 'recommendationDelta missing');
  assert(String(daily.sourceType || '') === 'live', 'daily sourceType should default to live');
  assert(
    ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_ENUM.includes(
      String(daily?.assistantDecisionOutcomeCheckpoint?.realizedOutcomeClassification || '')
    ),
    'daily assistant decision checkpoint classification should be bounded'
  );
  assert(
    REALIZED_TRUTH_SOURCE_ENUM.includes(
      String(daily?.assistantDecisionOutcomeCheckpoint?.externalExecutionOutcome?.sourceInUse || '')
    ),
    'checkpoint externalExecutionOutcome sourceInUse should be bounded'
  );

  const checkpointRow = db.prepare(`
    SELECT *
    FROM jarvis_assistant_decision_outcome_checkpoints
    WHERE trade_date = ?
  `).get(date);
  assert(checkpointRow, 'assistant decision checkpoint row should be persisted for live day');
  assert(
    ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_ENUM.includes(
      String(checkpointRow.realized_outcome_classification || '')
    ),
    'persisted checkpoint classification should be bounded'
  );
  const simulatedTradeLedgerRow = db.prepare(`
    SELECT *
    FROM jarvis_simulated_trade_outcome_ledger_daily
    WHERE trade_date = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(date);
  assert(simulatedTradeLedgerRow, 'simulated trade ledger row should persist for scored day');
  assert(Number(simulatedTradeLedgerRow.did_jarvis_take_trade || 0) === 1, 'simulated ledger should mark trade day as did_jarvis_take_trade=1');
  assert(String(simulatedTradeLedgerRow.tp_mode_selected || '') === 'Skip 2', 'simulated ledger tp_mode_selected should match recommendation');
  assert(Number.isFinite(Number(simulatedTradeLedgerRow.entry_price)), 'simulated ledger entry_price should persist');
  assert(Number.isFinite(Number(simulatedTradeLedgerRow.nearest_tp_price)), 'simulated ledger nearest_tp_price should persist');
  assert(Number.isFinite(Number(simulatedTradeLedgerRow.skip1_tp_price)), 'simulated ledger skip1_tp_price should persist');
  assert(Number.isFinite(Number(simulatedTradeLedgerRow.skip2_tp_price)), 'simulated ledger skip2_tp_price should persist');
  assert.doesNotThrow(() => JSON.parse(String(simulatedTradeLedgerRow.snapshot_json || '{}')), 'simulated ledger snapshot_json should be valid JSON');
  const simulatedTradeQuery = getJarvisSimulatedTradeOutcomeForDate(db, { tradeDate: date });
  assert(simulatedTradeQuery && typeof simulatedTradeQuery === 'object', 'simulated trade query helper should return object for trade day');
  assert(simulatedTradeQuery.didJarvisTakeTrade === true, 'simulated trade query should report didJarvisTakeTrade=true');
  assert(String(simulatedTradeQuery?.selectedOutcome?.outcome || '').length > 0, 'simulated trade query selectedOutcome should be populated');
  assert(
    String(simulatedTradeQuery?.nearestTpOutcome?.outcome || '') === 'win',
    'Thursday-style nearest TP query should resolve to win in deterministic fixture'
  );
  assert(
    simulatedTradeQuery.externalTopstepOutcomeIfAvailable === null,
    'simulated trade query should still work without Topstep truth rows'
  );
  assert(
    String(simulatedTradeQuery.jarvisVsTopstepMatchStatus || '').length > 0,
    'simulated trade query should provide jarvisVsTopstepMatchStatus even when Topstep is unavailable'
  );

  const noTradeDate = '2026-03-11';
  upsertTodayRecommendationContext({
    db,
    recDate: noTradeDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${noTradeDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'wait_for_clearance',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 51,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: noTradeDate, time: '09:25' },
      sessionPhase: 'outside_window',
    },
  });
  const noTradeContextRow = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(noTradeDate);
  assert(noTradeContextRow, 'no-trade context row should persist');
  const noTradeDaily = evaluateRecommendationOutcomeDay({
    db,
    date: noTradeDate,
    contextRow: noTradeContextRow,
    sessions: buildSessionsByDate([noTradeDate]),
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [noTradeDate]: {
              wouldTrade: false,
              noTradeReason: 'no_breakout',
              tradeResult: null,
              tradePnlDollars: 0,
              tradeDirection: null,
              tradeEntryTime: null,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  assert(noTradeDaily && typeof noTradeDaily === 'object', 'no-trade day should evaluate');
  const noTradeLedgerRow = db.prepare(`
    SELECT *
    FROM jarvis_simulated_trade_outcome_ledger_daily
    WHERE trade_date = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(noTradeDate);
  assert(noTradeLedgerRow, 'no-trade simulated ledger row should persist');
  assert(Number(noTradeLedgerRow.did_jarvis_take_trade || 0) === 0, 'no-trade ledger row should persist did_jarvis_take_trade=0');
  assert(String(noTradeLedgerRow.no_trade_reason || '') === 'no_breakout', 'no-trade ledger row should persist explicit no_trade_reason');
  const noTradeQuery = getJarvisSimulatedTradeOutcomeForDate(db, { tradeDate: noTradeDate });
  assert(noTradeQuery && typeof noTradeQuery === 'object', 'no-trade query helper should return object');
  assert(noTradeQuery.didJarvisTakeTrade === false, 'no-trade query helper should report didJarvisTakeTrade=false');
  assert(String(noTradeQuery.noTradeReason || '') === 'no_breakout', 'no-trade query helper should expose noTradeReason');

  const lateEntryDate = '2026-04-09';
  upsertTodayRecommendationContext({
    db,
    recDate: lateEntryDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${lateEntryDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 67,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: lateEntryDate, time: '09:25' },
      sessionPhase: 'outside_window',
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 260,
    },
  });
  const lateEntryContext = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(lateEntryDate);
  assert(lateEntryContext, 'late-entry context row should persist');
  const lateEntryDaily = evaluateRecommendationOutcomeDay({
    db,
    date: lateEntryDate,
    contextRow: lateEntryContext,
    sessions: {
      [lateEntryDate]: buildLateEntryExtensionCandles(lateEntryDate, '11:40'),
    },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [lateEntryDate]: {
              wouldTrade: false,
              noTradeReason: 'entry_after_max_hour',
              tradeResult: null,
              tradePnlDollars: 0,
              tradePnlTicks: 0,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  assert(lateEntryDaily && typeof lateEntryDaily === 'object', 'late-entry day should evaluate');
  assert(
    lateEntryDaily?.lateEntryPolicyExperimentSummary
      && typeof lateEntryDaily.lateEntryPolicyExperimentSummary === 'object',
    'late-entry policy summary should exist on daily output'
  );
  const lateEntryQuery = getLateEntryPolicyExperimentForDate(db, { tradeDate: lateEntryDate });
  assert(lateEntryQuery && typeof lateEntryQuery === 'object', 'late-entry policy query should return object');
  assert(String(lateEntryQuery.policyKey || '') === LATE_ENTRY_POLICY_EXPERIMENT_KEY, 'late-entry policy key mismatch');
  assert(String(lateEntryQuery.policyVersion || '') === LATE_ENTRY_POLICY_EXPERIMENT_VERSION, 'late-entry policy version mismatch');
  assert(lateEntryQuery.wouldBaselineTakeTrade === false, 'baseline should reject post-11:00 late-entry fixture');
  assert(
    String(lateEntryQuery.baselineNoTradeReason || '') === 'entry_after_max_hour',
    'baseline no-trade reason should be entry_after_max_hour'
  );
  assert(lateEntryQuery.wouldExtensionPolicyTakeTrade === true, 'extension should accept qualifying 11:00-12:00 fixture');
  assert(
    String(lateEntryQuery.policyComparisonLabel || '') === 'rescued_opportunity',
    'qualifying late-entry fixture should classify as rescued_opportunity'
  );
  assert(
    ['11:00-11:15', '11:15-11:30', '11:30-12:00'].includes(String(lateEntryQuery.confirmationTimeBucket || '')),
    'late-entry confirmation bucket should be in extension window'
  );
  assert(
    ['win', 'loss', 'breakeven', 'open'].includes(String(lateEntryQuery.skip2Outcome?.outcome || '')),
    'late-entry skip2 outcome should be populated'
  );
  assert(
    ['win', 'loss', 'breakeven', 'open'].includes(String(lateEntryQuery.nearestTpOutcome?.outcome || '')),
    'late-entry nearest outcome should be populated'
  );

  const lateAfterNoonDate = '2026-04-10';
  upsertTodayRecommendationContext({
    db,
    recDate: lateAfterNoonDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${lateAfterNoonDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 66,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: lateAfterNoonDate, time: '09:25' },
      sessionPhase: 'outside_window',
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 250,
    },
  });
  const lateAfterNoonContext = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(lateAfterNoonDate);
  assert(lateAfterNoonContext, 'post-noon late-entry context row should persist');
  evaluateRecommendationOutcomeDay({
    db,
    date: lateAfterNoonDate,
    contextRow: lateAfterNoonContext,
    sessions: {
      [lateAfterNoonDate]: buildLateEntryExtensionCandles(lateAfterNoonDate, '12:05'),
    },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [lateAfterNoonDate]: {
              wouldTrade: false,
              noTradeReason: 'entry_after_max_hour',
              tradeResult: null,
              tradePnlDollars: 0,
              tradePnlTicks: 0,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  const lateAfterNoonQuery = getLateEntryPolicyExperimentForDate(db, { tradeDate: lateAfterNoonDate });
  assert(lateAfterNoonQuery && typeof lateAfterNoonQuery === 'object', 'post-noon late-entry query should return object');
  assert(lateAfterNoonQuery.wouldExtensionPolicyTakeTrade === false, 'extension should reject confirmations after 12:00');
  assert(
    lateAfterNoonQuery?.extensionReasonCodes?.includes('confirmation_outside_1100_1200_window'),
    'post-noon rejection should include confirmation_outside_1100_1200_window'
  );

  const incompleteLateDate = '2026-04-11';
  upsertTodayRecommendationContext({
    db,
    recDate: incompleteLateDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${incompleteLateDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 64,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: incompleteLateDate, time: '09:25' },
      sessionPhase: 'outside_window',
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 240,
    },
  });
  const incompleteLateContext = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(incompleteLateDate);
  evaluateRecommendationOutcomeDay({
    db,
    date: incompleteLateDate,
    contextRow: incompleteLateContext,
    sessions: {
      [incompleteLateDate]: buildLateEntryExtensionCandles(incompleteLateDate, '11:20').slice(0, 2),
    },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [incompleteLateDate]: {
              wouldTrade: false,
              noTradeReason: 'entry_after_max_hour',
              tradeResult: null,
              tradePnlDollars: 0,
              tradePnlTicks: 0,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  const incompleteLateQuery = getLateEntryPolicyExperimentForDate(db, { tradeDate: incompleteLateDate });
  assert(incompleteLateQuery && typeof incompleteLateQuery === 'object', 'incomplete-candle late-entry query should return object');
  assert(incompleteLateQuery.wouldExtensionPolicyTakeTrade === false, 'incomplete session should not allow extension trade');
  assert(
    incompleteLateQuery?.extensionReasonCodes?.includes('missing_session_candles'),
    'incomplete session should include missing_session_candles extension rejection'
  );

  const latePolicyRejectDate = '2026-04-12';
  const latePolicyRejectRow = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyRejectDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    selectedTpMode: 'Nearest',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyRejectDate, '11:40'),
    runTradeMechanicsVariantTool,
  });
  assert(latePolicyRejectRow && typeof latePolicyRejectRow === 'object', 'policy-reject replay row should build');
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyRejectRow });
  const latePolicyRejectQuery = getLateEntryPolicyExperimentForDate(db, { tradeDate: latePolicyRejectDate });
  assert(latePolicyRejectQuery && typeof latePolicyRejectQuery === 'object', 'policy-reject replay query should return object');
  assert(latePolicyRejectQuery.wouldBaselineTakeTrade === false, 'policy-reject replay fixture baseline should reject');
  assert(latePolicyRejectQuery.wouldExtensionPolicyTakeTrade === false, 'policy-reject replay fixture extension should reject');
  assert(latePolicyRejectQuery.hard1200Replay?.wouldTrade === true, 'policy-reject replay fixture hard1200 replay should trade');
  assert(latePolicyRejectQuery.noCutoffReplay?.wouldTrade === true, 'policy-reject replay fixture no-cutoff replay should trade');
  assert(latePolicyRejectQuery.broaderReplayWouldTrade === true, 'policy-reject replay fixture broader replay should exist');
  assert(
    latePolicyRejectQuery.replayWouldHaveTradedButPolicyRejected === true,
    'policy-reject replay fixture should flag replay trade rejected by policy'
  );
  assert(
    String(latePolicyRejectQuery.policyReplayClassification || '') === 'replay_would_have_traded_but_policy_rejected',
    'policy-reject replay fixture should classify replay_would_have_traded_but_policy_rejected'
  );
  assert(
    String(latePolicyRejectQuery.extensionPolicyDecision?.reasonCodes?.[0] || '') === 'selected_tp_mode_not_skip2',
    'policy-reject replay fixture should carry selected_tp_mode_not_skip2 reason'
  );
  assert(
    String(latePolicyRejectQuery.tpReplayComparison?.Nearest?.outcome || '') === 'win'
    && String(latePolicyRejectQuery.tpReplayComparison?.Skip1?.outcome || '') === 'win'
    && String(latePolicyRejectQuery.tpReplayComparison?.Skip2?.outcome || '') === 'win',
    'policy-reject replay fixture should preserve replay TP outcomes'
  );
  const latePolicyRejectV2Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyRejectDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    selectedTpMode: 'Nearest',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyRejectDate, '11:40'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyRejectV2Row });
  const latePolicyRejectV2Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: latePolicyRejectDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
  });
  assert(latePolicyRejectV2Query && typeof latePolicyRejectV2Query === 'object', 'policy-reject v2 query should return object');
  assert(latePolicyRejectV2Query.wouldExtensionPolicyTakeTrade === false, 'v2 should reject constrained non-lane replay case');
  assert(
    String(latePolicyRejectV2Query.policyReplayClassification || '') === 'replay_would_have_traded_but_policy_rejected',
    'v2 should classify replay_would_have_traded_but_policy_rejected when replay exists but v2 rejects'
  );

  const latePolicyAcceptDate = '2026-04-16';
  const latePolicyAcceptV2Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyAcceptDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    selectedTpMode: 'Nearest',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 335,
    },
    candles: buildLateEntryExtensionCandles(latePolicyAcceptDate, '11:40', '11:35'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyAcceptV2Row });
  const latePolicyAcceptV2Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: latePolicyAcceptDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
  });
  assert(latePolicyAcceptV2Query && typeof latePolicyAcceptV2Query === 'object', 'policy-accept v2 query should return object');
  assert(latePolicyAcceptV2Query.wouldExtensionPolicyTakeTrade === true, 'v2 should accept qualified nearest late-entry lane case');
  assert(
    String(latePolicyAcceptV2Query.v2ComparisonClassification || '') === 'v2_rescued_opportunity',
    'v2 accepted winning late-entry should classify as v2_rescued_opportunity'
  );

  const latePolicyV3RescueDate = '2026-04-09';
  const latePolicyV3RescueRow = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyV3RescueDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyV3RescueDate, '11:40'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyV3RescueRow });
  const latePolicyV3RescueQuery = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: latePolicyV3RescueDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
  });
  assert(latePolicyV3RescueQuery && typeof latePolicyV3RescueQuery === 'object', 'v3 rescue query should return object');
  assert(latePolicyV3RescueQuery.wouldExtensionPolicyTakeTrade === true, 'v3 should rescue late skip2 winner in high-risk Thursday lane');
  assert(
    String(latePolicyV3RescueQuery.policyReplayClassification || '') === 'policy_rescued_opportunity',
    'v3 rescue case should classify as policy_rescued_opportunity'
  );
  assert(
    String(latePolicyV3RescueQuery.v3ComparisonClassification || '') === 'v3_rescued_opportunity',
    'v3 rescue case should classify as v3_rescued_opportunity vs v2'
  );
  const latePolicyV4Date = '2026-04-30';
  const latePolicyV4Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyV4Date,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'high',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyV4Date, '11:20', '11:15'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyV4Row });
  const latePolicyV4Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: latePolicyV4Date,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
  });
  assert(latePolicyV4Query && typeof latePolicyV4Query === 'object', 'v4 query should return object');
  assert(latePolicyV4Query.wouldExtensionPolicyTakeTrade === true, 'v4 should rescue mined Thursday mid-late replay winner while v3 remains blocked');
  assert(
    String(latePolicyV4Query.policyReplayClassification || '') === 'policy_rescued_opportunity',
    'v4 should classify policy_rescued_opportunity when it accepts a replay winner'
  );
  assert(
    LATE_ENTRY_POLICY_V4_COMPARISON_ENUM.includes(String(latePolicyV4Query.v4ComparisonClassification || '')),
    'v4 comparison classification should be bounded'
  );
  assert(
    String(latePolicyV4Query.v4ComparisonClassification || '') === 'v4_rescued_opportunity',
    'v4 should classify this case as v4_rescued_opportunity vs v3'
  );
  const latePolicyV5ReopenDate = '2026-04-22';
  const latePolicyV5ReopenV4Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyV5ReopenDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyV5ReopenDate, '11:20', '10:55'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyV5ReopenV4Row });
  const latePolicyV5ReopenRow = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyV5ReopenDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyV5ReopenDate, '11:20', '10:55'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyV5ReopenRow });
  const latePolicyV5ReopenQuery = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: latePolicyV5ReopenDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  });
  assert(latePolicyV5ReopenQuery && typeof latePolicyV5ReopenQuery === 'object', 'v5 reopen query should return object');
  assert(latePolicyV5ReopenQuery.wouldExtensionPolicyTakeTrade === true, 'v5 should reopen profitable Wednesday 11:00-11:30 Skip2 pocket');
  assert(
    String(latePolicyV5ReopenQuery.policyReplayClassification || '') === 'policy_rescued_opportunity',
    'v5 reopened winner should classify as policy_rescued_opportunity'
  );
  assert(
    LATE_ENTRY_POLICY_V5_COMPARISON_ENUM.includes(String(latePolicyV5ReopenQuery.v5ComparisonClassification || '')),
    'v5 comparison classification should be bounded'
  );
  assert(
    String(latePolicyV5ReopenQuery.v5ComparisonClassification || '') === 'v5_rescued_opportunity',
    'v5 reopened winner should classify as v5_rescued_opportunity vs v4'
  );

  const latePolicyV5RejectDate = '2026-04-24';
  const latePolicyV5RejectV4Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyV5RejectDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyV5RejectDate, '11:10', '10:45'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyV5RejectV4Row });
  const latePolicyV5RejectRow = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: latePolicyV5RejectDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 330,
    },
    candles: buildLateEntryExtensionCandles(latePolicyV5RejectDate, '11:10', '10:45'),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: latePolicyV5RejectRow });
  const latePolicyV5RejectQuery = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: latePolicyV5RejectDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  });
  assert(latePolicyV5RejectQuery && typeof latePolicyV5RejectQuery === 'object', 'v5 negative-pocket reject query should return object');
  assert(latePolicyV5RejectQuery.wouldExtensionPolicyTakeTrade === false, 'v5 should keep Friday late pocket blocked');
  assert(
    Array.isArray(latePolicyV5RejectQuery.extensionReasonCodes)
    && latePolicyV5RejectQuery.extensionReasonCodes.includes('v5_weekday_not_in_reopen_cluster'),
    'v5 negative-pocket reject should expose weekday block reason'
  );
  assert(
    LATE_ENTRY_POLICY_V5_COMPARISON_ENUM.includes(String(latePolicyV5RejectQuery.v5ComparisonClassification || '')),
    'v5 reject comparison classification should be bounded'
  );

  const lateNoReplayDate = '2026-04-14';
  const lateNoReplayRow = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: lateNoReplayDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 210,
    },
    candles: buildLateEntryNoReplayCandles(lateNoReplayDate),
    runTradeMechanicsVariantTool,
  });
  assert(lateNoReplayRow && typeof lateNoReplayRow === 'object', 'no-replay row should build');
  upsertLateEntryPolicyExperimentRow({ db, row: lateNoReplayRow });
  const lateNoReplayQuery = getLateEntryPolicyExperimentForDate(db, { tradeDate: lateNoReplayDate });
  assert(lateNoReplayQuery && typeof lateNoReplayQuery === 'object', 'no-replay fixture query should return object');
  assert(lateNoReplayQuery.hard1200Replay?.wouldTrade !== true, 'no-replay fixture hard1200 should not trade');
  assert(lateNoReplayQuery.noCutoffReplay?.wouldTrade !== true, 'no-replay fixture no-cutoff should not trade');
  assert(lateNoReplayQuery.broaderReplayWouldTrade !== true, 'no-replay fixture broader replay should be absent');
  assert(
    String(lateNoReplayQuery.policyReplayClassification || '') === 'no_replay_trade_exists',
    'no-replay fixture should classify no_replay_trade_exists'
  );
  const lateNoReplayV2Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: lateNoReplayDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    selectedTpMode: 'Nearest',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 210,
    },
    candles: buildLateEntryNoReplayCandles(lateNoReplayDate),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: lateNoReplayV2Row });
  const lateNoReplayV2Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: lateNoReplayDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
  });
  assert(lateNoReplayV2Query && typeof lateNoReplayV2Query === 'object', 'no-replay v2 query should return object');
  assert(
    String(lateNoReplayV2Query.v2ComparisonClassification || '') === 'v2_agreed_with_replay_no_trade',
    'v2 should classify no-replay case as v2_agreed_with_replay_no_trade'
  );
  const lateNoReplayV3Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: lateNoReplayDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 210,
    },
    candles: buildLateEntryNoReplayCandles(lateNoReplayDate),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: lateNoReplayV3Row });
  const lateNoReplayV3Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: lateNoReplayDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
  });
  assert(lateNoReplayV3Query && typeof lateNoReplayV3Query === 'object', 'no-replay v3 query should return object');
  assert(
    LATE_ENTRY_POLICY_V3_COMPARISON_ENUM.includes(String(lateNoReplayV3Query.v3ComparisonClassification || '')),
    'v3 comparison classification should be bounded'
  );
  assert(
    String(lateNoReplayV3Query.v3ComparisonClassification || '') === 'v3_agreed_with_replay_no_trade',
    'v3 no-replay case should classify as v3_agreed_with_replay_no_trade'
  );
  const lateNoReplayV4Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: lateNoReplayDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 210,
    },
    candles: buildLateEntryNoReplayCandles(lateNoReplayDate),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: lateNoReplayV4Row });
  const lateNoReplayV4Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: lateNoReplayDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
  });
  assert(lateNoReplayV4Query && typeof lateNoReplayV4Query === 'object', 'no-replay v4 query should return object');
  assert(
    LATE_ENTRY_POLICY_V4_COMPARISON_ENUM.includes(String(lateNoReplayV4Query.v4ComparisonClassification || '')),
    'v4 comparison classification should be bounded'
  );
  assert(
    String(lateNoReplayV4Query.v4ComparisonClassification || '') === 'v4_agreed_with_replay_no_trade',
    'v4 no-replay case should classify as v4_agreed_with_replay_no_trade'
  );
  const lateNoReplayV5Row = buildLateEntryPolicyExperimentRow({
    db,
    tradeDate: lateNoReplayDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    selectedTpMode: 'Skip 2',
    strategyKey: 'original_plan_orb_3130',
    strategyName: 'Original Trading Plan',
    contextJson: {
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 210,
    },
    candles: buildLateEntryNoReplayCandles(lateNoReplayDate),
    runTradeMechanicsVariantTool,
  });
  upsertLateEntryPolicyExperimentRow({ db, row: lateNoReplayV5Row });
  const lateNoReplayV5Query = getLateEntryPolicyExperimentForDate(db, {
    tradeDate: lateNoReplayDate,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  });
  assert(lateNoReplayV5Query && typeof lateNoReplayV5Query === 'object', 'no-replay v5 query should return object');
  assert(
    LATE_ENTRY_POLICY_V5_COMPARISON_ENUM.includes(String(lateNoReplayV5Query.v5ComparisonClassification || '')),
    'v5 comparison classification should be bounded'
  );
  assert(
    String(lateNoReplayV5Query.v5ComparisonClassification || '') === 'v5_agreed_with_replay_no_trade',
    'v5 no-replay case should classify as v5_agreed_with_replay_no_trade'
  );

  ensureRecommendationOutcomeSchema(db);
  const commonPhase = 'common_date_eval_intraday';
  const commonDates = ['2026-05-01', '2026-05-02', '2026-05-03'];
  const policyFixtures = [
    { key: LATE_ENTRY_POLICY_EXPERIMENT_KEY, pnlByDate: { '2026-05-01': 10, '2026-05-02': 10, '2026-05-03': 100 } },
    { key: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY, pnlByDate: { '2026-05-01': 15, '2026-05-02': 15, '2026-05-03': 120 } },
    { key: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY, pnlByDate: { '2026-05-01': 20, '2026-05-02': 20, '2026-05-03': 140 } },
    { key: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY, pnlByDate: { '2026-05-01': 22, '2026-05-02': 32, '2026-05-03': 130 } },
    { key: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY, pnlByDate: { '2026-05-01': 30, '2026-05-02': 40 } },
  ];
  for (const fixture of policyFixtures) {
    for (const tradeDate of Object.keys(fixture.pnlByDate)) {
      insertLateEntryPolicyFixtureRow(db, {
        tradeDate,
        policyKey: fixture.key,
        reconstructionPhase: commonPhase,
        selectedOutcome: 'win',
        selectedPnl: fixture.pnlByDate[tradeDate],
        baselineOutcome: 'win',
        baselinePnl: 5,
        hard1200Outcome: 'win',
        hard1200Pnl: 7,
        noCutoffOutcome: 'win',
        noCutoffPnl: 7,
        broadReplayOutcome: 'win',
        broadReplayPnl: 7,
        entryTime: `${tradeDate} 11:20`,
        weekday: 'Thursday',
        regimeLabel: 'ranging|extreme|wide',
        bucket: '11:15-11:30',
      });
    }
  }
  const commonComparison = buildLateEntryPolicyCommonDateComparison(db, {
    sourceType: 'live',
    reconstructionPhase: commonPhase,
    targetDate: '2026-05-03',
    missingAuditDates: ['2026-05-03'],
    maxRows: 500,
  });
  assert(commonComparison && typeof commonComparison === 'object', 'common-date comparison should return object');
  assert(commonComparison.commonDateCount === 2, 'common-date comparison should include only fully shared lane dates');
  assert(
    Number(commonComparison?.rawTrackedSummaryByLane?.v3?.stats?.totalPnl || 0) === 180,
    'raw tracked v3 totalPnl should include non-common dates'
  );
  assert(
    Number(commonComparison?.strictCommonDateSummaryByLane?.v3?.stats?.totalPnl || 0) === 40,
    'strict common-date v3 totalPnl should exclude partial-lane dates'
  );
  assert(
    Number(commonComparison?.commonDateDeltas?.v4_vs_v3?.totalPnlDelta || 0) === 30,
    'common-date v4 vs v3 delta should be computed from common dates only'
  );
  assert(
    Number(commonComparison?.coverageDiagnosticsByLane?.v4?.missingDateCountVsV1Universe || 0) === 1,
    'coverage diagnostics should expose v4 missing date against v1 universe'
  );
  assert(
    commonComparison?.trustworthiness?.status === 'not_trustworthy',
    'comparison trustworthiness should be blocked when lane date universes are mismatched'
  );
  assert(
    commonComparison?.targetDateInCommonDateUniverse === false,
    'target date should be flagged outside strict common-date universe when a lane is missing'
  );
  assert(
    commonComparison?.v4MissingDateAudit
    && typeof commonComparison.v4MissingDateAudit === 'object',
    'common-date comparison should include v4 missing-date audit block'
  );
  assert(
    Array.isArray(commonComparison?.v4MissingDateAudit?.rows)
    && commonComparison.v4MissingDateAudit.rows.length === 1,
    'missing-date audit should evaluate configured target date set'
  );
  assert(
    String(commonComparison?.v4MissingDateAudit?.rows?.[0]?.v4RowStatus || '') === 'absent',
    'missing-date audit should mark missing v4 row as absent'
  );
  assert(
    String(commonComparison?.v4MissingDateAudit?.rows?.[0]?.rootCauseLayer || '') === 'persistence_path',
    'missing-date audit should classify missing v4 row as persistence-path gap when peer lanes exist'
  );
  assert(
    commonComparison?.trustIfV4MissingDatesRepaired
    && commonComparison.trustIfV4MissingDatesRepaired.projectedTrustworthy === true,
    'comparison should project trustworthy status when only v4 repairable dates are missing'
  );
  assert(
    typeof commonComparison?.v1VsV4GapLine === 'string',
    'common-date comparison should expose v1-v4 gap line'
  );
  const syntheticDegradedLeader = buildLateEntryShadowLeader({
    commonDateComparison: {
      commonDatePolicyRanking: {
        byTotalPnl: [{ laneKey: 'v5', rank: 1 }],
        byWinRatePct: [{ laneKey: 'v5', rank: 2 }],
        byProfitFactor: [{ laneKey: 'v5', rank: 2 }],
        byMaxDrawdown: [{ laneKey: 'v5', rank: 2 }],
      },
      strictCommonDateSummaryByLane: {
        baseline_1100: { stats: { totalPnl: 120 } },
        v1: { stats: { totalPnl: 140 } },
        v2: { stats: { totalPnl: 100 } },
        v3: { stats: { totalPnl: 95 } },
        v4: { stats: { totalPnl: 110 } },
        v5: { stats: { totalPnl: 180 } },
      },
      trustworthiness: { status: 'not_trustworthy' },
      commonDateCount: 10,
      unionDateCount: 13,
    },
  });
  assert(
    syntheticDegradedLeader && typeof syntheticDegradedLeader === 'object',
    'synthetic degraded leader should be computed'
  );
  assert(
    String(syntheticDegradedLeader.strictCommonDateTrustStatus || '') === 'not_trustworthy',
    'degraded trust should flow through leader object'
  );
  assert(
    String(syntheticDegradedLeader.summaryLine || '').toLowerCase().includes('provisional'),
    'leader summary line should explicitly mark provisional status when trust degrades'
  );
  const syntheticReadinessPanel = buildLateEntryPolicyPromotionReadinessPanel({
    v5Summary: {
      trackedDays: 12,
      policyAddedTrades: 2,
      externalCoveragePct: 25,
      rolling5ExternalCoveragePct: 40,
      rolling10ExternalCoveragePct: 30,
      externallyFinalizedEligibleDays: 1,
      externallyUnfinalizedEligibleDays: 6,
      promotionReadinessStatus: 'blocked_due_to_truth_coverage',
      promotionReadinessBlockReasons: ['full_external_coverage_below_threshold'],
      promotionReadinessThresholds: {
        minSampleDays: 60,
        minPolicyAddedTrades: 5,
        minExternalCoveragePct: 80,
        minRolling5ExternalCoveragePct: 80,
        minRolling10ExternalCoveragePct: 80,
        post1130DragWarnPnl: -200,
      },
    },
    shadowLeader: syntheticDegradedLeader,
  });
  assert(
    syntheticReadinessPanel && typeof syntheticReadinessPanel === 'object',
    'promotion-readiness panel should be computed'
  );
  assert(
    Number(syntheticReadinessPanel?.remainingToUnlock?.externalCoveragePctGap || 0) === 55,
    'promotion-readiness panel should expose numeric full coverage gap'
  );
  assert(
    Number(syntheticReadinessPanel?.remainingToUnlock?.rolling5CoverageGap || 0) === 40,
    'promotion-readiness panel should expose numeric rolling-5 coverage gap'
  );
  assert(
    Number(syntheticReadinessPanel?.remainingToUnlock?.minSampleGap || 0) === 48,
    'promotion-readiness panel should expose numeric sample-size gap'
  );
  const syntheticV5ShadowTracking = {
    recentShadowScore: {
      latestRelevantTradeDate: '2026-05-10',
      last5RelevantDays: {
        considered: 5,
        rescuedWins: 1,
        addedLosses: 0,
        agreedNoTrade: 2,
        agreedTrade: 2,
        externallyFinalizedDays: 1,
      },
      last10RelevantDays: {
        considered: 10,
        rescuedWins: 2,
        addedLosses: 0,
        agreedNoTrade: 2,
        agreedTrade: 6,
        externallyFinalizedDays: 4,
      },
    },
  };
  const syntheticBacklog = buildLateEntryPolicyTruthCoverageBacklog({
    v5Summary: {
      trackedDays: 12,
      externallyFinalizedEligibleDays: 2,
      externallyUnfinalizedEligibleDays: 5,
      externalCoveragePct: 25,
      unfinalizedTradeDates: ['2026-05-08', '2026-05-09', '2026-05-10'],
    },
    v5ShadowTracking: syntheticV5ShadowTracking,
    asOfTradeDate: '2026-05-10',
  });
  assert(
    syntheticBacklog && typeof syntheticBacklog === 'object',
    'truth coverage backlog should be computed'
  );
  assert(
    Number(syntheticBacklog?.externallyUnfinalizedEligibleDays || 0) === 5,
    'truth coverage backlog should include externallyUnfinalizedEligibleDays'
  );
  assert(
    Number(syntheticBacklog?.rolling5RelevantDays || 0) === 5
    && Number(syntheticBacklog?.rolling5ExternallyFinalizedDays || 0) === 1,
    'truth coverage backlog should include rolling-5 relevant/finalized counts'
  );
  const syntheticLedger = buildLateEntryPolicyTruthCoverageLedger({
    backlog: syntheticBacklog,
    unfinalizedTradeDates: ['2026-05-08', '2026-05-09', '2026-05-10'],
    maxRecent: 3,
    maxPriority: 2,
  });
  assert(
    syntheticLedger && typeof syntheticLedger === 'object',
    'truth coverage ledger should be computed'
  );
  assert(
    Array.isArray(syntheticLedger?.recentMissingDates) && syntheticLedger.recentMissingDates.length === 3,
    'truth coverage ledger should include deterministic recent missing dates'
  );
  assert(
    Array.isArray(syntheticLedger?.highPriorityMissingDates) && syntheticLedger.highPriorityMissingDates.length === 2,
    'truth coverage ledger should include deterministic high-priority missing dates'
  );
  const syntheticTrend = buildLateEntryPolicyTruthAccumulationTrend({
    v5ShadowTracking: syntheticV5ShadowTracking,
  });
  assert(
    syntheticTrend && typeof syntheticTrend === 'object',
    'truth accumulation trend should be computed'
  );
  assert(
    ['improving', 'flat', 'worsening'].includes(String(syntheticTrend?.deltaDirection || '')),
    'truth accumulation trend delta direction should be bounded'
  );
  const syntheticDossier = buildLateEntryPolicyPromotionDossier({
    shadowLeader: syntheticDegradedLeader,
    commonDateComparison: {
      strictCommonDateSummaryByLane: {
        baseline_1100: { stats: { totalPnl: 120 } },
        v1: { stats: { totalPnl: 140 } },
        v4: { stats: { totalPnl: 110 } },
        v5: { stats: { totalPnl: 180 } },
      },
      commonDateDeltas: {
        v5_vs_v4: { totalPnlDelta: 70 },
        v5_vs_v1: { totalPnlDelta: 40 },
      },
    },
    readinessPanel: syntheticReadinessPanel,
    pocketMap: {
      strongestPockets: [{ weekday: 'Wednesday', bucket: '11:00-11:15' }],
      blockedRiskPockets: [{ weekday: 'Friday', bucket: '11:00-11:15' }],
    },
    v5VsV4Delta: { rescuedWinners: 3, addedLosers: 1 },
    v5VsV1Delta: { totalPnlDelta: 40 },
  });
  assert(
    syntheticDossier && typeof syntheticDossier === 'object',
    'promotion dossier should be computed'
  );
  assert(
    String(syntheticDossier?.manualReviewVerdict || '') === 'not_ready',
    'promotion dossier should remain not_ready when readiness thresholds are blocked'
  );
  const syntheticTrigger = buildLateEntryPolicyManualReviewTrigger({
    readinessPanel: syntheticReadinessPanel,
    shadowLeader: syntheticDegradedLeader,
    dossier: syntheticDossier,
  });
  assert(
    syntheticTrigger && typeof syntheticTrigger === 'object',
    'manual review trigger should be computed'
  );
  assert(
    syntheticTrigger?.shouldOpenManualReview === false,
    'manual review trigger should remain false while coverage thresholds are blocked'
  );
  const syntheticReadyBlocker = classifyLateEntryPolicyTruthFinalizationBlocker({
    tradeDate: '2026-05-12',
    hasReplayRow: true,
    hasPolicyRows: true,
    hasContextRow: true,
    hasSessionCandles: true,
    hasExternalTruth: true,
    hasCheckpointRow: true,
    checkpointExternallyFinalized: false,
  });
  assert(
    syntheticReadyBlocker?.isReadyNow === true,
    'truth-finalization blocker classifier should mark ready candidate as ready'
  );
  const syntheticBlockedBlocker = classifyLateEntryPolicyTruthFinalizationBlocker({
    tradeDate: '2026-05-13',
    hasReplayRow: true,
    hasPolicyRows: true,
    hasContextRow: true,
    hasSessionCandles: true,
    hasExternalTruth: false,
    hasCheckpointRow: true,
    checkpointExternallyFinalized: false,
  });
  assert(
    syntheticBlockedBlocker?.isReadyNow === false
    && Array.isArray(syntheticBlockedBlocker?.blockReasons)
    && syntheticBlockedBlocker.blockReasons.includes('needs_external_close_truth'),
    'truth-finalization blocker classifier should deterministically block when external truth is missing'
  );

  const truthRepairPhase = 'truth_repair_scope';
  const truthReadyDate = '2026-05-12';
  const truthBlockedDate = '2026-05-13';
  const truthContextGapDate = '2026-05-14';
  for (const policyKey of [
    LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
  ]) {
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: truthReadyDate,
      policyKey,
      reconstructionPhase: truthRepairPhase,
      selectedOutcome: 'win',
      selectedPnl: 55,
      baselineOutcome: 'no_trade',
      baselinePnl: null,
      hard1200Outcome: 'win',
      hard1200Pnl: 55,
      noCutoffOutcome: 'win',
      noCutoffPnl: 55,
      broadReplayOutcome: 'win',
      broadReplayPnl: 55,
      entryTime: `${truthReadyDate} 11:20`,
      weekday: 'Tuesday',
      regimeLabel: 'ranging|extreme|wide',
      bucket: '11:15-11:30',
    });
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: truthBlockedDate,
      policyKey,
      reconstructionPhase: truthRepairPhase,
      selectedOutcome: 'win',
      selectedPnl: 40,
      baselineOutcome: 'no_trade',
      baselinePnl: null,
      hard1200Outcome: 'win',
      hard1200Pnl: 40,
      noCutoffOutcome: 'win',
      noCutoffPnl: 40,
      broadReplayOutcome: 'win',
      broadReplayPnl: 40,
      entryTime: `${truthBlockedDate} 11:25`,
      weekday: 'Wednesday',
      regimeLabel: 'ranging|extreme|wide',
      bucket: '11:15-11:30',
    });
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: truthContextGapDate,
      policyKey,
      reconstructionPhase: truthRepairPhase,
      selectedOutcome: 'win',
      selectedPnl: 33,
      baselineOutcome: 'no_trade',
      baselinePnl: null,
      hard1200Outcome: 'win',
      hard1200Pnl: 33,
      noCutoffOutcome: 'win',
      noCutoffPnl: 33,
      broadReplayOutcome: 'win',
      broadReplayPnl: 33,
      entryTime: `${truthContextGapDate} 11:10`,
      weekday: 'Thursday',
      regimeLabel: 'ranging|extreme|wide',
      bucket: '11:00-11:15',
    });
  }
  upsertTodayRecommendationContext({
    db,
    recDate: truthReadyDate,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    todayRecommendation: {
      posture: 'trade_normally',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'high',
      confidenceScore: 0.8,
      assistantDecisionBrief: { actionNow: 'Take trade' },
    },
    context: {
      nowEt: { date: truthReadyDate },
      sessionPhase: 'in_session',
      regime: { regime_trend: 'ranging', regime_vol: 'extreme', regime_orb_size: 'wide' },
    },
  });
  upsertTodayRecommendationContext({
    db,
    recDate: truthBlockedDate,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    todayRecommendation: {
      posture: 'trade_normally',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'high',
      confidenceScore: 0.8,
      assistantDecisionBrief: { actionNow: 'Take trade' },
    },
    context: {
      nowEt: { date: truthBlockedDate },
      sessionPhase: 'in_session',
      regime: { regime_trend: 'ranging', regime_vol: 'extreme', regime_orb_size: 'wide' },
    },
  });
  db.prepare(`
    INSERT INTO topstep_auto_journal_links (
      journal_run_id,
      external_fill_id,
      feedback_id,
      trade_date,
      symbol,
      order_id,
      pnl_dollars
    ) VALUES (1, 'ext-ready-1', NULL, ?, 'NQ', 'ord-ready-1', 55)
  `).run(truthReadyDate);
  db.prepare(`
    INSERT INTO jarvis_assistant_decision_outcome_checkpoints (
      trade_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
      front_line_action_now,
      posture,
      recommended_strategy_key,
      recommended_strategy_name,
      recommended_tp_mode,
      confidence_label,
      confidence_score,
      projected_win_chance,
      blocker_state,
      blocker_reason,
      clearance_guidance_snapshot_json,
      assistant_brief_text,
      realized_outcome_classification,
      realized_outcome_reason,
      actual_trade_taken,
      actual_pnl,
      best_possible_pnl,
      recommendation_delta,
      posture_evaluation,
      strategy_score_label,
      tp_score_label,
      snapshot_json,
      outcome_json
    ) VALUES (
      ?, 'live', ?, 'live_v1',
      'take_trade', 'trade_normally',
      'original_plan_orb_3130', 'Original Trading Plan', 'Skip 2',
      'high', 80, 65,
      'clear', NULL,
      '{}', 'synthetic checkpoint',
      'correct', 'synthetic',
      1, 0, 0, 0,
      'correct', 'correct', 'correct',
      '{}',
      '{"externalExecutionOutcome":{"hasRows":false,"tradeCount":0,"wins":0,"losses":0,"breakeven":0,"netPnlDollars":0,"sourceBacked":false,"sourceTable":"trade_outcome_feedback","sourceInUse":"none","trustClassification":"untrustworthy","trustReasonCodes":["no_realized_outcome_rows_for_date"],"sourceAttribution":{"primarySource":"primary","sourceInUse":"none","fallbackSourceInUse":null,"sourceLevel":"none","sourceFreshness":{"latestTopstepSyncAt":null,"latestTopstepSyncStatus":"unknown","latestTopstepTruthTradeDate":null,"targetTradeDate":"2026-05-12","targetDateInStaleWindow":false,"sourceLagDays":null},"sourceLadder":{},"recoveryPlan":{"backfillPending":false,"staleWindowStartDate":null,"staleWindowEndDate":null,"staleWindowDays":0,"targetDateInStaleWindow":false}}}}}'
    )
  `).run(truthReadyDate, truthRepairPhase);
  db.prepare(`
    INSERT INTO jarvis_recommendation_outcome_history (
      rec_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
      posture_evaluation,
      strategy_score_label,
      tp_score_label,
      actual_pnl,
      best_possible_pnl,
      recommendation_delta,
      outcome_json,
      calculated_at
    ) VALUES (
      ?, 'live', ?, 'live_v1',
      'correct', 'correct', 'correct',
      0, 0, 0,
      ?,
      datetime('now')
    )
  `).run(
    truthContextGapDate,
    truthRepairPhase,
    JSON.stringify({
      date: truthContextGapDate,
      recommendationDate: truthContextGapDate,
      posture: 'trade_normally',
      recommendedTpMode: 'Skip 2',
      recommendedStrategyKey: 'original_plan_orb_3130',
      recommendedStrategyOutcome: {
        strategyKey: 'original_plan_orb_3130',
        strategyName: 'Original Trading Plan',
        pnlDollars: 33,
      },
      timeBucket: 'in_session',
    })
  );
  const queueResult = buildLateEntryPolicyTruthFinalizationQueue({
    db,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    repairScope: 'all_eligible',
    sessions: {
      [truthReadyDate]: buildLateEntryNoReplayCandles(truthReadyDate),
      [truthBlockedDate]: buildLateEntryNoReplayCandles(truthBlockedDate),
      [truthContextGapDate]: buildLateEntryNoReplayCandles(truthContextGapDate),
    },
  });
  assert(
    queueResult?.queue && typeof queueResult.queue === 'object',
    'truth finalization queue should be computed'
  );
  assert(
    Number(queueResult?.queue?.readyNowCount || 0) === 1
    && Number(queueResult?.queue?.blockedCount || 0) === 2,
    'truth finalization queue should separate ready vs blocked candidates deterministically'
  );
  assert(
    Array.isArray(queueResult?.queue?.readyNowDates)
    && queueResult.queue.readyNowDates.includes(truthReadyDate),
    'truth finalization queue should include ready date in readyNowDates'
  );
  assert(
    Number(queueResult?.queue?.blockReasonCounts?.needs_external_close_truth || 0) >= 1,
    'truth finalization queue should count deterministic block reasons'
  );
  const blockerDiagnosticsBefore = buildLateEntryPolicyTruthBlockerDiagnostics({
    candidateRows: queueResult?.candidateRows || [],
  });
  assert(
    blockerDiagnosticsBefore
    && typeof blockerDiagnosticsBefore === 'object'
    && Number(blockerDiagnosticsBefore?.blockerCounts?.missing_context_row || 0) >= 1,
    'truth blocker diagnostics should include deterministic missing_context_row counts'
  );
  const blockerAuditBefore = buildLateEntryPolicyTruthBlockerAudit({
    candidateRows: queueResult?.candidateRows || [],
  });
  assert(
    blockerAuditBefore
    && Number(blockerAuditBefore?.blockedCount || 0) >= 1
    && Array.isArray(blockerAuditBefore?.blockerGroups),
    'truth blocker audit should group blocked dates by blocker type deterministically'
  );
  const externalGroup = Array.isArray(blockerAuditBefore?.blockerGroups)
    ? blockerAuditBefore.blockerGroups.find((group) => String(group?.blockerType || '') === 'needs_external_close_truth')
    : null;
  assert(
    externalGroup
    && Array.isArray(externalGroup.tradeDates)
    && externalGroup.tradeDates.includes(truthBlockedDate),
    'truth blocker audit should include exact blocked trade dates for needs_external_close_truth'
  );
  const repairPlannerBefore = buildLateEntryPolicyTruthRepairPlanner({
    candidateRows: queueResult?.candidateRows || [],
    blockerAudit: blockerAuditBefore,
  });
  assert(
    repairPlannerBefore
    && Array.isArray(repairPlannerBefore?.blockerActionPlan)
    && repairPlannerBefore.blockerActionPlan.length >= 1,
    'truth repair planner should expose deterministic blocker action plan'
  );
  assert(
    Array.isArray(repairPlannerBefore?.externalOnlyBlockedDates)
    && repairPlannerBefore.externalOnlyBlockedDates.includes(truthBlockedDate),
    'truth repair planner should classify external-only blocked trade dates deterministically'
  );
  const contextGapAudit = buildLateEntryPolicyContextGapAudit({
    db,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    candidateRows: queueResult?.candidateRows || [],
  });
  assert(
    contextGapAudit
    && Number(contextGapAudit?.missingContextCount || 0) >= 1
    && Number(contextGapAudit?.rebuildableCount || 0) >= 1,
    'context gap audit should classify missing_context_row dates and identify rebuildable cases'
  );
  const contextGapDateAudit = classifyLateEntryPolicyContextGap({
    db,
    tradeDate: truthContextGapDate,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
  });
  assert(
    contextGapDateAudit?.rebuildable === true
    && String(contextGapDateAudit?.rootCause || '').length > 0,
    'context gap classifier should identify deterministic rebuildability/root cause for missing-context date'
  );
  const contextBackfillRun = runLateEntryPolicyContextBackfillRun({
    db,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    candidateRows: queueResult?.scopedCandidateRows || [],
    sessions: {
      [truthReadyDate]: buildLateEntryNoReplayCandles(truthReadyDate),
      [truthBlockedDate]: buildLateEntryNoReplayCandles(truthBlockedDate),
      [truthContextGapDate]: buildLateEntryNoReplayCandles(truthContextGapDate),
    },
  });
  assert(
    contextBackfillRun
    && Number(contextBackfillRun?.rebuiltDates || 0) >= 1,
    'context backfill run should rebuild at least one safe missing-context case'
  );
  const queueAfterContextBackfill = buildLateEntryPolicyTruthFinalizationQueue({
    db,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    repairScope: 'all_eligible',
    sessions: {
      [truthReadyDate]: buildLateEntryNoReplayCandles(truthReadyDate),
      [truthBlockedDate]: buildLateEntryNoReplayCandles(truthBlockedDate),
      [truthContextGapDate]: buildLateEntryNoReplayCandles(truthContextGapDate),
    },
  });
  assert(
    Number(queueAfterContextBackfill?.queue?.blockReasonCounts?.missing_context_row || 0)
    < Number(queueResult?.queue?.blockReasonCounts?.missing_context_row || 0),
    'queue should be recomputed after context repair and reduce missing_context_row blockers'
  );
  const dependencySplit = buildLateEntryPolicyTruthDependencySplit({
    candidateRows: queueAfterContextBackfill?.candidateRows || [],
  });
  assert(
    dependencySplit
    && Number.isFinite(Number(dependencySplit?.locallyUnlockableDays || 0))
    && Number.isFinite(Number(dependencySplit?.externalTruthRequiredDays || 0)),
    'truth dependency split should deterministically separate local vs external dependencies'
  );
  assert(
    Array.isArray(dependencySplit?.locallyUnlockableSample)
    && Array.isArray(dependencySplit?.externalTruthRequiredSample),
    'truth dependency split should expose deterministic sample arrays'
  );
  const backfillRun = runLateEntryPolicyTruthBackfillRun({
    db,
    sourceType: 'live',
    reconstructionPhase: truthRepairPhase,
    candidateRows: Array.isArray(queueAfterContextBackfill?.scopedCandidateRows)
      ? queueAfterContextBackfill.scopedCandidateRows
      : [],
    repairScope: 'all_eligible',
    sessions: {
      [truthReadyDate]: buildLateEntryNoReplayCandles(truthReadyDate),
      [truthBlockedDate]: buildLateEntryNoReplayCandles(truthBlockedDate),
      [truthContextGapDate]: buildLateEntryNoReplayCandles(truthContextGapDate),
    },
    strategySnapshot: {},
    runTradeMechanicsVariantTool,
  });
  assert(
    backfillRun && typeof backfillRun === 'object',
    'truth backfill run should return summary object'
  );
  assert(
    Number(backfillRun?.newlyFinalizedDates || 0) >= 1,
    'truth backfill run should finalize ready candidate without inventing blocked truth'
  );
  const refreshedCheckpoint = db.prepare(`
    SELECT outcome_json
    FROM jarvis_assistant_decision_outcome_checkpoints
    WHERE trade_date = ?
    LIMIT 1
  `).get(truthReadyDate);
  const refreshedOutcomeJson = refreshedCheckpoint
    ? JSON.parse(String(refreshedCheckpoint.outcome_json || '{}'))
    : {};
  assert(
    refreshedOutcomeJson?.externalExecutionOutcome?.hasRows === true,
    'truth backfill run should refresh checkpoint externalExecutionOutcome when source-backed truth exists'
  );
  const blockedCheckpoint = db.prepare(`
    SELECT trade_date
    FROM jarvis_assistant_decision_outcome_checkpoints
    WHERE trade_date = ?
    LIMIT 1
  `).get(truthBlockedDate);
  assert(
    !blockedCheckpoint,
    'truth backfill run should not invent checkpoints for blocked dates without external close truth'
  );
  const accelerationSummary = buildLateEntryPolicyCoverageAccelerationSummary({
    before: {
      externallyFinalizedEligibleDays: 1,
      externalCoveragePct: 10,
      rolling5CoveragePct: 20,
      rolling10CoveragePct: 15,
    },
    after: {
      externallyFinalizedEligibleDays: 2,
      externalCoveragePct: 20,
      rolling5CoveragePct: 40,
      rolling10CoveragePct: 25,
    },
  });
  assert(
    accelerationSummary?.movedNeedle === true
    && Number(accelerationSummary?.deltas?.externallyFinalizedEligibleDaysDelta || 0) === 1,
    'coverage acceleration summary should reflect deterministic before/after improvements'
  );

  const gapPhase = 'common_date_gap_intraday';
  const allLaneKeys = [
    LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
  ];
  for (const policyKey of allLaneKeys) {
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: '2026-06-01',
      policyKey,
      reconstructionPhase: gapPhase,
      selectedOutcome: 'win',
      selectedPnl: policyKey === LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY ? 25 : 20,
      baselineOutcome: 'win',
      baselinePnl: 10,
      hard1200Outcome: 'win',
      hard1200Pnl: 10,
      noCutoffOutcome: 'win',
      noCutoffPnl: 10,
      broadReplayOutcome: 'win',
      broadReplayPnl: 10,
      entryTime: '2026-06-01 11:20',
      weekday: 'Monday',
      regimeLabel: 'ranging|extreme|wide',
      bucket: '11:15-11:30',
    });
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: '2026-06-02',
      policyKey,
      reconstructionPhase: gapPhase,
      selectedOutcome: policyKey === LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY ? 'no_trade' : 'win',
      selectedPnl: policyKey === LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY ? null : 60,
      baselineOutcome: 'win',
      baselinePnl: 20,
      hard1200Outcome: 'win',
      hard1200Pnl: 20,
      noCutoffOutcome: 'win',
      noCutoffPnl: 20,
      broadReplayOutcome: 'win',
      broadReplayPnl: 20,
      entryTime: '2026-06-02 11:25',
      weekday: 'Tuesday',
      regimeLabel: 'ranging|extreme|wide',
      bucket: '11:15-11:30',
    });
  }
  for (const policyKey of [
    LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
  ]) {
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: '2026-06-03',
      policyKey,
      reconstructionPhase: gapPhase,
      selectedOutcome: 'win',
      selectedPnl: 70,
      baselineOutcome: 'win',
      baselinePnl: 30,
      hard1200Outcome: 'win',
      hard1200Pnl: 30,
      noCutoffOutcome: 'win',
      noCutoffPnl: 30,
      broadReplayOutcome: 'win',
      broadReplayPnl: 30,
      entryTime: '2026-06-03 11:35',
      weekday: 'Wednesday',
      regimeLabel: 'ranging|extreme|wide',
      bucket: '11:30-12:00',
    });
  }
  const strictGapComparison = buildLateEntryPolicyCommonDateComparison(db, {
    sourceType: 'live',
    reconstructionPhase: gapPhase,
    targetDate: '2026-06-03',
    missingAuditDates: ['2026-06-03'],
    maxRows: 500,
  });
  assert(
    strictGapComparison?.commonDateCount === 2,
    'strict gap comparison should keep only dates shared by all lanes'
  );
  assert(
    strictGapComparison?.v1VsV4MissedTradeLedger
    && Array.isArray(strictGapComparison.v1VsV4MissedTradeLedger.rows)
    && strictGapComparison.v1VsV4MissedTradeLedger.rows.length === 1,
    'v1-v4 missed-trade ledger should only include strict common-date missed trades'
  );
  assert(
    String(strictGapComparison?.v1VsV4MissedTradeLedger?.rows?.[0]?.tradeDate || '') === '2026-06-02',
    'v1-v4 missed-trade ledger should exclude non-common dates'
  );
  assert(
    String(strictGapComparison?.v1VsV4MissedTradeLedger?.gapVerdict || '') === 'too_tight',
    'v1-v4 missed-trade ledger should classify a pure missed-winner profile as too_tight'
  );

  const contextOnlyPhase = 'live_intraday';
  const contextOnlyTradingDate = '2026-06-05';
  const contextOnlyWeekendDate = '2026-06-06';
  ensureRecommendationOutcomeSchema(db);
  const insertContextOnlyRow = db.prepare(`
    INSERT INTO jarvis_recommendation_context_history (
      rec_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
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
    ) VALUES (
      @rec_date,
      'live',
      @reconstruction_phase,
      'live_v1',
      'trade_selectively',
      'original_plan_orb_3130',
      'Original Trading Plan',
      'Skip 2',
      'medium',
      60,
      @recommendation_json,
      '{}',
      '{}',
      @context_json
    )
    ON CONFLICT(rec_date, source_type, reconstruction_phase) DO UPDATE SET
      recommendation_json = excluded.recommendation_json,
      context_json = excluded.context_json,
      updated_at = datetime('now')
  `);
  for (const tradeDate of [contextOnlyTradingDate, contextOnlyWeekendDate]) {
    insertContextOnlyRow.run({
      rec_date: tradeDate,
      reconstruction_phase: contextOnlyPhase,
      recommendation_json: JSON.stringify({
        recommendedTpMode: 'Skip 2',
        recommendedStrategy: 'Original Trading Plan',
      }),
      context_json: JSON.stringify({
        nowEt: { date: tradeDate, time: '09:45' },
      }),
    });
  }
  const contextOnlyRows = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date IN (?, ?)
      AND source_type = 'live'
      AND reconstruction_phase = ?
    ORDER BY rec_date DESC
  `).all(contextOnlyTradingDate, contextOnlyWeekendDate, contextOnlyPhase);
  const contextOnlySessions = {
    [contextOnlyTradingDate]: buildLateEntryNoReplayCandles(contextOnlyTradingDate),
  };
  const contextOnlyPerf = buildRecommendationPerformance({
    db,
    contextRows: contextOnlyRows,
    sessions: contextOnlySessions,
    strategySnapshot: {},
    runTradeMechanicsVariantTool,
    maxRecords: 20,
    source: 'live',
    reconstructionPhase: contextOnlyPhase,
  });
  assert(contextOnlyPerf && contextOnlyPerf.summary, 'context-only performance recompute should succeed');
  const repairedWeekendV4 = db.prepare(`
    SELECT trade_date, policy_key, source_type, reconstruction_phase, selected_outcome, source_candles_complete
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND source_type = 'live'
      AND reconstruction_phase = ?
    LIMIT 1
  `).get(contextOnlyWeekendDate, LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY, contextOnlyPhase);
  assert(repairedWeekendV4, 'v4 row should persist for context-only date even when session candles are missing');
  assert(String(repairedWeekendV4.selected_outcome || '') === 'no_trade', 'context-only v4 row should persist as no_trade');
  assert(Number(repairedWeekendV4.source_candles_complete || 0) === 0, 'context-only v4 row should preserve incomplete candle truth');
  const repairedWeekendV5 = db.prepare(`
    SELECT trade_date, policy_key, source_type, reconstruction_phase, selected_outcome, source_candles_complete
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND source_type = 'live'
      AND reconstruction_phase = ?
    LIMIT 1
  `).get(contextOnlyWeekendDate, LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY, contextOnlyPhase);
  assert(repairedWeekendV5, 'v5 row should persist for context-only date even when session candles are missing');
  assert(String(repairedWeekendV5.selected_outcome || '') === 'no_trade', 'context-only v5 row should persist as no_trade');
  assert(Number(repairedWeekendV5.source_candles_complete || 0) === 0, 'context-only v5 row should preserve incomplete candle truth');
  const legacyOnlyDate = '2026-06-07';
  for (const policyKey of [
    LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
  ]) {
    insertLateEntryPolicyFixtureRow(db, {
      tradeDate: legacyOnlyDate,
      policyKey,
      sourceType: 'live',
      reconstructionPhase: contextOnlyPhase,
      selectedOutcome: 'no_trade',
      selectedPnl: null,
      baselineOutcome: 'no_trade',
      baselinePnl: null,
      hard1200Outcome: 'no_trade',
      hard1200Pnl: null,
      noCutoffOutcome: 'no_trade',
      noCutoffPnl: null,
      broadReplayOutcome: 'no_trade',
      broadReplayPnl: null,
      entryTime: null,
      weekday: 'Sunday',
      regimeLabel: 'unknown|unknown|unknown',
      bucket: 'unknown',
    });
  }
  buildRecommendationPerformance({
    db,
    contextRows: contextOnlyRows,
    sessions: contextOnlySessions,
    strategySnapshot: {},
    runTradeMechanicsVariantTool,
    maxRecords: 20,
    source: 'live',
    reconstructionPhase: contextOnlyPhase,
  });
  const repairedLegacyV5 = db.prepare(`
    SELECT trade_date, policy_key, source_type, reconstruction_phase, selected_outcome, source_candles_complete
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND source_type = 'live'
      AND reconstruction_phase = ?
    LIMIT 1
  `).get(legacyOnlyDate, LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY, contextOnlyPhase);
  assert(repairedLegacyV5, 'v5 row should backfill from existing policy-date universe even when context/session are absent');
  assert(String(repairedLegacyV5.selected_outcome || '') === 'no_trade', 'legacy-universe v5 row should persist as no_trade');
  assert(Number(repairedLegacyV5.source_candles_complete || 0) === 0, 'legacy-universe v5 row should preserve incomplete candle truth');

  evaluateRecommendationOutcomeDay({
    db,
    date: lateEntryDate,
    contextRow: lateEntryContext,
    sessions: {
      [lateEntryDate]: buildLateEntryExtensionCandles(lateEntryDate, '11:40'),
    },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [lateEntryDate]: {
              wouldTrade: false,
              noTradeReason: 'entry_after_max_hour',
              tradeResult: null,
              tradePnlDollars: 0,
              tradePnlTicks: 0,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  const lateEntryRowCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND policy_version = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
  `).get(lateEntryDate, LATE_ENTRY_POLICY_EXPERIMENT_KEY, LATE_ENTRY_POLICY_EXPERIMENT_VERSION)?.c || 0);
  assert(lateEntryRowCount === 1, 'late-entry policy ledger should upsert deterministically with one row per day/policy/source/phase');
  const lateSummarySynthetic = summarizeLateEntryPolicyExperiment([
    lateEntryDaily,
    db.prepare(`
      SELECT outcome_json
      FROM jarvis_recommendation_outcome_history
      WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
      LIMIT 1
    `).get(lateAfterNoonDate)
      ? JSON.parse(db.prepare(`
        SELECT outcome_json
        FROM jarvis_recommendation_outcome_history
        WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
        LIMIT 1
      `).get(lateAfterNoonDate).outcome_json || '{}')
      : null,
  ].filter(Boolean), { db });
  assert(lateSummarySynthetic && typeof lateSummarySynthetic === 'object', 'late-entry summary helper should return object');
  assert(Number(lateSummarySynthetic.trackedDays || 0) >= 1, 'late-entry summary trackedDays should be populated');
  assert(
    LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM.includes(String(lateSummarySynthetic.promotionReadinessStatus || '')),
    'late-entry summary promotion readiness status should be bounded'
  );

  const shadowDate = '2026-03-12';
  upsertTodayRecommendationContext({
    db,
    recDate: shadowDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${shadowDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 64,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: shadowDate, time: '09:25' },
      sessionPhase: 'outside_window',
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 280,
    },
  });
  const shadowContextRow = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(shadowDate);
  assert(shadowContextRow, 'shadow test context row should be persisted');
  const shadowDaily = evaluateRecommendationOutcomeDay({
    db,
    date: shadowDate,
    contextRow: shadowContextRow,
    sessions: { [shadowDate]: buildFailedExtensionReversalShadowCandles(shadowDate) },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [shadowDate]: {
              wouldTrade: true,
              tradeResult: 'loss',
              tradePnlDollars: -90,
              tradePnlTicks: -18,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  assert(shadowDaily && typeof shadowDaily === 'object', 'shadow day should evaluate');
  assert(shadowDaily.shadowPlaybook && typeof shadowDaily.shadowPlaybook === 'object', 'shadow playbook payload missing');
  assert(
    String(shadowDaily.shadowPlaybook.playbookKey || '') === SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    'shadow playbook key mismatch'
  );
  assert(
    String(shadowDaily.shadowPlaybook.playbookVersion || '') === SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
    'shadow playbook version mismatch'
  );
  assert(
    SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_ENUM.includes(String(shadowDaily.shadowPlaybook.hypotheticalResult || '')),
    'shadow hypothetical result should be bounded'
  );
  const persistedShadow = db.prepare(`
    SELECT *
    FROM jarvis_shadow_playbook_daily
    WHERE trade_date = ?
      AND playbook_key = ?
      AND playbook_version = ?
    LIMIT 1
  `).get(
    shadowDate,
    SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION
  );
  assert(persistedShadow, 'shadow playbook row should be persisted');
  assert(Number.isFinite(Number(persistedShadow.fit_score)), 'shadow fit_score should persist');
  assert(String(persistedShadow.orb_overlap_label || '').length > 0, 'shadow ORB overlap label should persist');
  const shadowDuplicate = evaluateRecommendationOutcomeDay({
    db,
    date: shadowDate,
    contextRow: shadowContextRow,
    sessions: { [shadowDate]: buildFailedExtensionReversalShadowCandles(shadowDate) },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [shadowDate]: {
              wouldTrade: true,
              tradeResult: 'loss',
              tradePnlDollars: -90,
              tradePnlTicks: -18,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  assert(shadowDuplicate && typeof shadowDuplicate === 'object', 'shadow duplicate evaluation should succeed');
  const shadowCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_shadow_playbook_daily
    WHERE trade_date = ?
      AND playbook_key = ?
      AND playbook_version = ?
  `).get(
    shadowDate,
    SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION
  )?.c || 0);
  assert(shadowCount === 1, 'shadow upsert should remain deterministic with one row per day/playbook/version');

  const nestedRegimeShadowDate = '2026-03-18';
  upsertTodayRecommendationContext({
    db,
    recDate: nestedRegimeShadowDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${nestedRegimeShadowDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 63,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: nestedRegimeShadowDate, time: '09:25' },
      sessionPhase: 'outside_window',
      regime: {
        regime_trend: 'ranging',
        regime_vol: 'extreme',
        regime_orb_size: 'wide',
        metrics: {
          orb_range_ticks: 320,
        },
      },
    },
  });
  const nestedRegimeContextRow = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(nestedRegimeShadowDate);
  assert(nestedRegimeContextRow, 'nested-regime context row should be persisted');
  const nestedRegimeDaily = evaluateRecommendationOutcomeDay({
    db,
    date: nestedRegimeShadowDate,
    contextRow: nestedRegimeContextRow,
    sessions: { [nestedRegimeShadowDate]: buildFailedExtensionReversalShadowCandles(nestedRegimeShadowDate) },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [nestedRegimeShadowDate]: {
              wouldTrade: true,
              tradeResult: 'loss',
              tradePnlDollars: -70,
              tradePnlTicks: -14,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  assert(nestedRegimeDaily && nestedRegimeDaily.shadowPlaybook, 'nested-regime shadow payload should exist');
  assert(
    nestedRegimeDaily.shadowPlaybook.eligible === true,
    'nested regime fallback fields should produce an operationally eligible shadow case'
  );
  assert(
    !nestedRegimeDaily.shadowPlaybook.skipReason,
    'nested regime fallback case should not be rejected as context_not_ranging_extreme_wide'
  );

  const shadowOverlapRepairDate = '2026-03-19';
  upsertTodayRecommendationContext({
    db,
    recDate: shadowOverlapRepairDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    generatedAt: `${shadowOverlapRepairDate}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Nearest',
      confidenceLabel: 'medium',
      confidenceScore: 62,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: shadowOverlapRepairDate, time: '09:25' },
      sessionPhase: 'outside_window',
      regimeTrend: 'ranging',
      regimeVolatility: 'extreme',
      regimeOrbSize: 'wide',
      orbRangeTicks: 300,
    },
  });
  const shadowOverlapContextRow = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(shadowOverlapRepairDate);
  assert(shadowOverlapContextRow, 'shadow overlap repair context row should be persisted');
  evaluateRecommendationOutcomeDay({
    db,
    date: shadowOverlapRepairDate,
    contextRow: shadowOverlapContextRow,
    sessions: { [shadowOverlapRepairDate]: buildFailedExtensionReversalShadowCandles(shadowOverlapRepairDate) },
    strategySnapshot: {
      layers: {
        original: {
          key: 'original_plan_orb_3130',
          name: 'Original Trading Plan',
          perDate: {
            [shadowOverlapRepairDate]: {
              wouldTrade: true,
              tradeResult: 'win',
              tradePnlDollars: 125,
              tradePnlTicks: 25,
            },
          },
        },
        variants: { tested: [] },
      },
    },
    runTradeMechanicsVariantTool,
  });
  const repairedOverlap = upsertShadowPlaybookEvaluation({
    db,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    evaluation: {
      tradeDate: shadowOverlapRepairDate,
      playbookKey: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
      playbookVersion: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
      eligible: true,
      fitScore: 96,
      skipReason: null,
      contextSnapshot: { trend: 'ranging', volatility: 'extreme', orbProfile: 'wide' },
      hypotheticalDirection: 'short',
      hypotheticalResult: 'loss',
      hypotheticalPnl: -22.5,
      orbOverlapLabel: 'orb_outcome_unavailable',
      dataQualityStatus: 'ok',
      evaluation: {},
    },
  });
  assert(repairedOverlap, 'shadow overlap repair upsert should return row metadata');
  assert(
    String(repairedOverlap.orbOverlapLabel || '') === 'orb_win_shadow_loss',
    'shadow overlap should be rebuilt from persisted ORB outcome when stale unavailable label is provided'
  );
  const repairedOverlapRow = db.prepare(`
    SELECT orb_overlap_label
    FROM jarvis_shadow_playbook_daily
    WHERE trade_date = ?
      AND playbook_key = ?
      AND playbook_version = ?
    LIMIT 1
  `).get(
    shadowOverlapRepairDate,
    SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION
  );
  assert(repairedOverlapRow, 'repaired shadow overlap row should persist');
  assert(
    String(repairedOverlapRow.orb_overlap_label || '') === 'orb_win_shadow_loss',
    'persisted shadow overlap label should be rebuilt from ORB history instead of remaining unavailable'
  );

  const greenLane = classifyFailedExtensionReversalFadeShadowLane({
    eligible: true,
    highRiskContext: true,
    blockerState: 'blocked',
    divergenceDetected: true,
    orbOverlapLabel: 'shadow_win_orb_no_trade',
    orbWouldTrade: false,
    orbTradeResult: null,
    orbPnlDollars: 0,
    hypotheticalResult: 'win',
  });
  assert(
    String(greenLane.laneLabel || '') === 'green_lane',
    'blocked/divergence/orb-no-trade lane should classify as green_lane'
  );
  assert(greenLane.highConvictionLaneMatch === true, 'green lane should be marked high-conviction');

  const redLane = classifyFailedExtensionReversalFadeShadowLane({
    eligible: true,
    highRiskContext: true,
    blockerState: 'clear',
    divergenceDetected: false,
    orbOverlapLabel: 'orb_win_shadow_loss',
    orbWouldTrade: true,
    orbTradeResult: 'win',
    orbPnlDollars: 139,
    hypotheticalResult: 'loss',
  });
  assert(
    String(redLane.laneLabel || '') === 'red_lane',
    'orb-win + shadow-loss conflict should classify as red_lane'
  );
  assert(redLane.highConvictionLaneMatch === false, 'red lane should not be marked high-conviction');

  const neutralLane = classifyFailedExtensionReversalFadeShadowLane({
    eligible: false,
    highRiskContext: true,
    blockerState: 'clear',
    divergenceDetected: false,
    orbOverlapLabel: 'orb_outcome_unavailable',
    hypotheticalResult: 'no_trade',
  });
  assert(
    String(neutralLane.laneLabel || '') === 'neutral_lane',
    'ineligible shadow day should classify as neutral_lane'
  );
  assert(Array.isArray(SHADOW_PLAYBOOK_LANE_LABEL_ENUM), 'lane enum should be exported as array');
  assert(SHADOW_PLAYBOOK_LANE_LABEL_ENUM.includes('green_lane'), 'lane enum should include green_lane');
  assert(SHADOW_PLAYBOOK_LANE_LABEL_ENUM.includes('red_lane'), 'lane enum should include red_lane');
  assert(SHADOW_PLAYBOOK_LANE_LABEL_ENUM.includes('neutral_lane'), 'lane enum should include neutral_lane');
  assert(
    SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET instanceof Set,
    'predecision-safe reason-code set should be exported'
  );
  assert(
    SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET.has('high_risk_context_support'),
    'predecision-safe reasons should include high_risk_context_support'
  );
  assert(
    SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET.has('blocked_day_support'),
    'predecision-safe reasons should include blocked_day_support'
  );
  assert(
    !SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET.has('shadow_win_support'),
    'predecision-safe reasons should exclude hindsight result-support reason'
  );

  const split = splitFailedExtensionLaneReasonCodes([
    'high_risk_context_support',
    'blocked_day_support',
    'shadow_win_support',
    'orb_win_conflict',
  ]);
  assert(
    JSON.stringify(split.preDecisionSafeReasonCodes)
    === JSON.stringify(['high_risk_context_support', 'blocked_day_support']),
    'lane reason split should keep only pre-decision-safe reasons'
  );
  assert(
    JSON.stringify(split.removedHindsightReasonCodes)
    === JSON.stringify(['shadow_win_support', 'orb_win_conflict']),
    'lane reason split should remove hindsight-contaminated reasons'
  );

  const predecisionGreen = classifyFailedExtensionReversalFadeShadowPredecisionLane({
    eligible: true,
    highRiskContext: true,
    blockerState: 'blocked',
  });
  assert(
    String(predecisionGreen.laneLabel || '') === 'green_lane',
    'predecision lane should classify blocked high-risk setup as green_lane'
  );
  const predecisionNeutral = classifyFailedExtensionReversalFadeShadowPredecisionLane({
    eligible: true,
    highRiskContext: true,
    blockerState: 'clear',
  });
  assert(
    String(predecisionNeutral.laneLabel || '') === 'neutral_lane',
    'predecision lane should not force green when blocker support is absent'
  );
  const syntheticDurabilityRows = [];
  for (let day = 1; day <= 10; day += 1) {
    const recDate = `2026-02-${String(day).padStart(2, '0')}`;
    const recentWindow = day >= 6;
    syntheticDurabilityRows.push({
      date: recDate,
      timeBucket: 'outside_window',
      shadowPlaybookComparisonSummary: {
        eligible: true,
        hypotheticalResult: 'win',
        hypotheticalPnl: recentWindow ? 20 : 2,
        orbPnlDollars: 0,
        predecisionLaneLabel: 'green_lane',
        blockerState: 'blocked',
      },
      assistantDecisionOutcomeCheckpoint: {
        blockerState: 'blocked',
        posture: 'stand_down',
        externalExecutionOutcome: {
          hasRows: true,
          sourceBacked: true,
          sourceInUse: 'topstep_linked_truth',
          trustClassification: 'safe_to_trust_without_topstep',
          sourceAttribution: {
            sourceFreshness: {
              targetDateInStaleWindow: false,
            },
          },
        },
      },
    });
  }
  const syntheticDurability = summarizeShadowPlaybookLaneDurability(syntheticDurabilityRows, {
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    db,
  });
  assert(syntheticDurability && typeof syntheticDurability === 'object', 'synthetic durability summary should build');
  assert(Number(syntheticDurability.totalEligibleDays || 0) === 10, 'synthetic durability totalEligibleDays mismatch');
  assert(Number(syntheticDurability?.rolling5DayStats?.totalEligibleDays || 0) === 5, 'synthetic rolling5 eligible days mismatch');
  assert(Number(syntheticDurability?.rolling10DayStats?.totalEligibleDays || 0) === 10, 'synthetic rolling10 eligible days mismatch');
  assert(
    SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM.includes(String(syntheticDurability.trendVerdict || '')),
    'durability trend verdict should be bounded'
  );
  assert(
    String(syntheticDurability.trendVerdict || '') === 'improving',
    'synthetic durability trend should classify as improving when rolling expectancy exceeds full sample'
  );
  assert(
    SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM.includes(String(syntheticDurability?.durabilityTrust?.overall || '')),
    'synthetic durability trust verdict should be bounded'
  );
  assert(
    SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM.includes(
      String(syntheticDurability?.promotionReadinessStatus || '')
    ),
    'synthetic durability promotion readiness should be bounded'
  );
  assert(
    Number(syntheticDurability?.externalFinalizedDays || 0) === 10,
    'synthetic durability should count externally finalized days'
  );
  assert(
    Number(syntheticDurability?.externalCoveragePct || 0) === 100,
    'synthetic durability external coverage should be 100 when all rows are source-backed'
  );
  assert(
    Number(syntheticDurability?.externallyFinalizedEligibleDays || 0) === 10,
    'synthetic durability should track externally finalized eligible sample'
  );
  assert(
    syntheticDurability?.truthGapDiagnostics
      && typeof syntheticDurability.truthGapDiagnostics === 'object',
    'synthetic durability should expose latest-day truth gap diagnostics'
  );
  assert(
    typeof syntheticDurability?.latestDayAccountabilityStatus === 'string',
    'synthetic durability should expose latest-day accountability status'
  );
  assert(
    typeof syntheticDurability?.latestDayAccountabilityLine === 'string',
    'synthetic durability should expose latest-day accountability line'
  );
  assert(
    syntheticDurability?.durabilityTrust?.realizedTruthFallback
    && typeof syntheticDurability.durabilityTrust.realizedTruthFallback === 'object',
    'synthetic durability trust should expose realized-truth fallback summary'
  );
  if (String(syntheticDurability?.promotionReadinessStatus || '') === 'ready_for_promotion_review') {
    assert(
      Array.isArray(syntheticDurability?.promotionReadinessBlockReasons)
        && syntheticDurability.promotionReadinessBlockReasons.length === 0,
      'promotion-ready synthetic durability should not retain block reasons'
    );
  } else {
    assert(
      Array.isArray(syntheticDurability?.promotionReadinessBlockReasons)
        && syntheticDurability.promotionReadinessBlockReasons.length > 0,
      'blocked synthetic durability should expose at least one promotion block reason'
    );
  }

  db.prepare(`
    INSERT INTO topstep_sync_runs (status, created_at)
    VALUES ('error', datetime('now'))
  `).run();
  const syntheticDegradedRows = [];
  for (let day = 1; day <= 6; day += 1) {
    syntheticDegradedRows.push({
      date: `2026-01-${String(day).padStart(2, '0')}`,
      shadowPlaybookComparisonSummary: {
        eligible: false,
        skipReason: 'missing_session_candles',
        dataQualityStatus: 'missing_session_candles',
        hypotheticalResult: 'no_trade',
        hypotheticalPnl: 0,
        orbPnlDollars: 0,
        predecisionLaneLabel: 'neutral_lane',
      },
    });
  }
  const syntheticDegradedDurability = summarizeShadowPlaybookLaneDurability(syntheticDegradedRows, {
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    db,
  });
  assert(
    String(syntheticDegradedDurability?.durabilityTrust?.overall || '') === 'not_trustworthy_until_topstep_returns',
    'missing-session dominated durability sample should be marked untrustworthy'
  );
  assert(
    Number(syntheticDegradedDurability?.durabilityTrust?.missingSessionCandlesRows || 0) === 6,
    'missing session candle rows should be counted in durability trust payload'
  );
  assert(
    String(syntheticDegradedDurability?.durabilityTrust?.topstepDependency?.topstepSync?.status || '') === 'degraded',
    'topstep sync degradation should surface in durability trust payload'
  );
  assert(
    Array.isArray(syntheticDegradedDurability?.durabilityTrust?.realizedTruthFallback?.deterministicActions)
      && syntheticDegradedDurability.durabilityTrust.realizedTruthFallback.deterministicActions.length >= 4,
    'degraded durability trust should expose deterministic recovery actions'
  );
  assert(
    String(syntheticDegradedDurability?.promotionReadinessStatus || '') === 'blocked_due_to_truth_coverage',
    'degraded durability should block promotion readiness'
  );
  assert(
    Array.isArray(syntheticDegradedDurability?.promotionReadinessBlockReasons)
      && syntheticDegradedDurability.promotionReadinessBlockReasons.length > 0,
    'degraded durability should expose promotion block reasons'
  );
  assert(
    Number(syntheticDegradedDurability?.externallyFinalizedEligibleDays || 0) === 0,
    'degraded durability should expose externally finalized eligible sample count'
  );
  assert(
    Number(syntheticDegradedDurability?.externallyUnfinalizedEligibleDays || 0) === 0,
    'degraded durability should expose externally unfinalized eligible sample count'
  );

  db.prepare(`
    INSERT OR REPLACE INTO jarvis_assistant_decision_outcome_checkpoints (
      trade_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
      realized_outcome_classification,
      outcome_json
    ) VALUES (
      '2026-12-10',
      'live',
      'live_intraday',
      'live_v1',
      'insufficient_evidence',
      '{}'
    )
  `).run();
  db.prepare(`
    INSERT INTO jarvis_complaints (
      created_at,
      prompt,
      reply,
      metadata_json
    ) VALUES (
      '2026-12-10 16:00:00',
      'today trade won',
      'ok',
      '{}'
    )
  `).run();
  const staleWindowRows = [];
  for (let day = 6; day <= 10; day += 1) {
    staleWindowRows.push({
      date: `2026-12-${String(day).padStart(2, '0')}`,
      shadowPlaybookComparisonSummary: {
        eligible: true,
        hypotheticalResult: 'win',
        hypotheticalPnl: 5,
        orbPnlDollars: 0,
        predecisionLaneLabel: 'green_lane',
        blockerState: 'blocked',
      },
      assistantDecisionOutcomeCheckpoint: {
        blockerState: 'blocked',
        posture: 'stand_down',
        externalExecutionOutcome: {
          hasRows: false,
          sourceBacked: false,
          sourceInUse: 'unavailable',
          trustClassification: 'not_trustworthy_until_topstep_returns',
          sourceAttribution: {
            sourceFreshness: {
              targetDateInStaleWindow: true,
            },
          },
        },
      },
    });
  }
  const staleWindowDurability = summarizeShadowPlaybookLaneDurability(staleWindowRows, {
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    db,
  });
  assert(
    Array.isArray(staleWindowDurability?.promotionReadinessBlockReasons)
      && staleWindowDurability.promotionReadinessBlockReasons.includes('stale_window_overlaps_rolling_5'),
    'promotion gate should block when stale window overlaps rolling-5 sample'
  );
  assert(
    staleWindowDurability?.promotionReadinessBlockReasons?.includes('stale_window_overlaps_rolling_10'),
    'promotion gate should block when stale window overlaps rolling-10 sample'
  );
  assert(
    staleWindowDurability?.promotionReadinessBlockReasons?.includes('latest_eligible_shadow_day_not_externally_finalized'),
    'promotion gate should block when latest eligible failed-extension row is not externally finalized'
  );
  assert(
    String(staleWindowDurability?.latestDayAccountabilityStatus || '') === 'user_claimed_but_unverified',
    'latest-day accountability should surface user-claimed but unverified state when external truth is missing'
  );
  assert(
    String(staleWindowDurability?.truthGapDiagnostics?.user_claim_verification?.status || '')
      === 'user_claim_pending_external_verification',
    'truth-gap diagnostics should preserve user claim as pending external verification only'
  );
  assert(
    Number(staleWindowDurability?.truthGapDiagnostics?.latest_day_layer_trace?.topstep_auto_journal_links_rows || 0) === 0
      && Number(staleWindowDurability?.truthGapDiagnostics?.latest_day_layer_trace?.trade_outcome_feedback_rows || 0) === 0
      && Number(staleWindowDurability?.truthGapDiagnostics?.latest_day_layer_trace?.checkpoint_rows || 0) >= 1,
    'truth-gap diagnostics should not contaminate external-finalized rows with internal checkpoint rows'
  );

  const classifierCases = [
    {
      label: 'too_conservative',
      input: {
        actionNow: "Don't trade yet.",
        posture: 'stand_down',
        actualTradeTaken: false,
        actualPnl: 0,
        bestPossiblePnl: 120,
        recommendationDelta: -120,
        strategyScoreLabel: 'incorrect',
        tpScoreLabel: 'unknown',
      },
      expected: 'too_conservative',
    },
    {
      label: 'too_aggressive',
      input: {
        actionNow: 'Trade selectively.',
        posture: 'trade_selectively',
        actualTradeTaken: true,
        actualPnl: -80,
        bestPossiblePnl: 0,
        recommendationDelta: -80,
        strategyScoreLabel: 'incorrect',
        tpScoreLabel: 'incorrect',
      },
      expected: 'too_aggressive',
    },
    {
      label: 'insufficient_evidence',
      input: {
        actionNow: 'Wait for clearance.',
        posture: 'wait_for_clearance',
        actualTradeTaken: false,
        actualPnl: 0,
        bestPossiblePnl: 0,
        recommendationDelta: 0,
        strategyScoreLabel: 'unknown',
        tpScoreLabel: 'unknown',
        bestStrategyOutcome: null,
        bestMechanicsOutcome: null,
      },
      expected: 'insufficient_evidence',
    },
    {
      label: 'correct',
      input: {
        actionNow: 'Trade selectively.',
        posture: 'trade_selectively',
        actualTradeTaken: true,
        actualPnl: 110,
        bestPossiblePnl: 120,
        recommendationDelta: -10,
        strategyScoreLabel: 'correct',
        tpScoreLabel: 'correct',
      },
      expected: 'correct',
    },
  ];
  for (const testCase of classifierCases) {
    const out = classifyAssistantDecisionOutcomeCheckpoint(testCase.input);
    assert(
      String(out?.classification || '') === testCase.expected,
      `checkpoint classifier should return ${testCase.expected} for ${testCase.label}`
    );
  }

  const divergenceCase = classifyModelVsRealizedDivergence({
    classification: 'correct',
    actionNow: "Don't trade yet.",
    posture: 'stand_down',
    blockerState: 'blocked',
    actualTradeTaken: false,
    externalExecutionOutcome: {
      hasRows: true,
      tradeCount: 3,
      wins: 2,
      losses: 1,
      breakeven: 0,
      netPnlDollars: 112,
      sourceBacked: true,
      sourceTable: 'trade_outcome_feedback',
    },
  });
  assert(
    MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_ENUM.includes(String(divergenceCase.classification || '')),
    'divergence classification should be bounded'
  );
  assert(
    String(divergenceCase.classification || '') === 'external_profitable_opportunity_while_model_defensive',
    'defensive correct call with profitable external outcomes should be divergence-classified'
  );
  const nonDivergenceTooConservative = classifyModelVsRealizedDivergence({
    classification: 'too_conservative',
    actionNow: "Don't trade yet.",
    posture: 'stand_down',
    blockerState: 'blocked',
    actualTradeTaken: false,
    externalExecutionOutcome: {
      hasRows: true,
      tradeCount: 2,
      wins: 2,
      losses: 0,
      breakeven: 0,
      netPnlDollars: 80,
      sourceBacked: true,
      sourceTable: 'trade_outcome_feedback',
    },
  });
  assert(
    String(nonDivergenceTooConservative.classification || '') === 'none',
    'explicit too_conservative classification should not be re-labeled as divergence'
  );

  db.prepare(`
    INSERT INTO jarvis_assistant_decision_outcome_checkpoints (
      trade_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
      front_line_action_now,
      posture,
      recommended_strategy_key,
      recommended_strategy_name,
      recommended_tp_mode,
      confidence_label,
      confidence_score,
      projected_win_chance,
      blocker_state,
      blocker_reason,
      clearance_guidance_snapshot_json,
      assistant_brief_text,
      realized_outcome_classification,
      realized_outcome_reason,
      actual_trade_taken,
      actual_pnl,
      best_possible_pnl,
      recommendation_delta,
      posture_evaluation,
      strategy_score_label,
      tp_score_label,
      snapshot_json,
      outcome_json,
      created_at,
      updated_at
    ) VALUES (
      '2099-01-11',
      'live',
      'live_intraday',
      'live_v1',
      'Trade selectively.',
      'trade_normally',
      'original_plan_orb_3130',
      'Original Trading Plan',
      'Skip 2',
      'medium',
      70.22,
      60.88,
      'clear',
      NULL,
      '{}',
      'Action now: Trade selectively.',
      'too_aggressive',
      'Call leaned trade-forward while realized outcome was weak.',
      1,
      -80,
      0,
      -80,
      'incorrect',
      'incorrect',
      'incorrect',
      '{}',
      '{}',
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT(trade_date) DO UPDATE SET
      realized_outcome_classification = excluded.realized_outcome_classification,
      posture = excluded.posture,
      recommended_tp_mode = excluded.recommended_tp_mode,
      confidence_label = excluded.confidence_label,
      confidence_score = excluded.confidence_score,
      blocker_state = excluded.blocker_state
  `).run();

  db.prepare(`
    INSERT INTO jarvis_assistant_decision_outcome_checkpoints (
      trade_date,
      source_type,
      reconstruction_phase,
      reconstruction_version,
      front_line_action_now,
      posture,
      recommended_strategy_key,
      recommended_strategy_name,
      recommended_tp_mode,
      confidence_label,
      confidence_score,
      projected_win_chance,
      blocker_state,
      blocker_reason,
      clearance_guidance_snapshot_json,
      assistant_brief_text,
      realized_outcome_classification,
      realized_outcome_reason,
      actual_trade_taken,
      actual_pnl,
      best_possible_pnl,
      recommendation_delta,
      posture_evaluation,
      strategy_score_label,
      tp_score_label,
      snapshot_json,
      outcome_json,
      created_at,
      updated_at
    ) VALUES (
      '2099-01-12',
      'live',
      'live_intraday',
      'live_v1',
      'Trade selectively.',
      'trade_normally',
      'original_plan_orb_3130',
      'Original Trading Plan',
      'Skip 2',
      'medium',
      68.5,
      58.0,
      'clear',
      NULL,
      '{}',
      'Action now: Trade selectively.',
      'correct',
      'Call aligned with realized conditions for the day.',
      1,
      40,
      45,
      -5,
      'correct',
      'correct',
      'correct',
      '{}',
      '{}',
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT(trade_date) DO UPDATE SET
      realized_outcome_classification = excluded.realized_outcome_classification
  `).run();

  const noSentinelWhenLatestCorrect = getLatestTooAggressiveCheckpointSentinel({
    db,
    asOfDate: '2099-01-13',
  });
  assert(!noSentinelWhenLatestCorrect, 'latest checkpoint is correct so sentinel should not trigger');

  db.prepare(`
    UPDATE jarvis_assistant_decision_outcome_checkpoints
    SET realized_outcome_classification = 'too_aggressive',
        realized_outcome_reason = 'Call leaned trade-forward while realized outcome was weak.',
        posture = 'trade_normally',
        recommended_tp_mode = 'Skip 2',
        confidence_label = 'medium',
        confidence_score = 70.22,
        blocker_state = 'clear'
    WHERE trade_date = '2099-01-12'
  `).run();

  const sentinel = getLatestTooAggressiveCheckpointSentinel({
    db,
    asOfDate: '2099-01-13',
  });
  assert(sentinel && typeof sentinel === 'object', 'latest too_aggressive checkpoint should produce sentinel');
  assert(String(sentinel.tradeDate || '') === '2099-01-12', 'sentinel should point at latest checkpoint date');
  assert(String(sentinel.classification || '') === 'too_aggressive', 'sentinel classification should be too_aggressive');
  assert(String(sentinel.blockerState || '') === 'clear', 'sentinel should include blocker state context');
  assert(String(sentinel.posture || '') === 'trade_normally', 'sentinel should include posture context');
  assert(String(sentinel.recommendedTpMode || '') === 'Skip 2', 'sentinel should include tp-mode context');
  assert(String(sentinel.confidenceLabel || '') === 'medium', 'sentinel should include confidence label context');
  assert(Number(sentinel.confidenceScore || 0) === 70.22, 'sentinel should include confidence score context');

  const sentinelSameDayBlocked = getLatestTooAggressiveCheckpointSentinel({
    db,
    asOfDate: '2099-01-12',
  });
  assert(!sentinelSameDayBlocked, 'sentinel should not emit for same-day checkpoint when includeSameDay=false');

  db.prepare('DELETE FROM trades WHERE date = ?').run(date);
  insertTrade(db, {
    date,
    direction: 'long',
    entry_price: 22100,
    entry_time: `${date} 10:00`,
    exit_time: `${date} 10:20`,
    result: 'loss',
    pnl_ticks: -16,
    pnl_dollars: -80,
  });
  const duplicateRun = evaluateRecommendationOutcomeDay({
    db,
    date,
    contextRow: row,
    sessions,
    strategySnapshot,
    runTradeMechanicsVariantTool,
  });
  assert(duplicateRun && typeof duplicateRun === 'object', 'duplicate-day re-evaluation should succeed');
  const checkpointCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_assistant_decision_outcome_checkpoints
    WHERE trade_date = ?
  `).get(date)?.c || 0);
  assert(checkpointCount === 1, 'checkpoint upsert should remain deterministic with one row per day');
  const checkpointAfterDuplicate = db.prepare(`
    SELECT realized_outcome_classification
    FROM jarvis_assistant_decision_outcome_checkpoints
    WHERE trade_date = ?
    LIMIT 1
  `).get(date);
  assert(
    String(checkpointAfterDuplicate?.realized_outcome_classification || '') === 'too_aggressive',
    'duplicate-day upsert should deterministically update checkpoint classification'
  );

  const divergenceDate = '2026-03-11';
  upsertTodayRecommendationContext({
    db,
    recDate: divergenceDate,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    todayRecommendation: {
      posture: 'stand_down',
      recommendedStrategy: 'Original Trading Plan',
      recommendedTpMode: 'Nearest',
      confidenceLabel: 'medium',
      confidenceScore: 69.76,
      actionNow: "Don't trade yet.",
      blockerReason: 'Range overextension is still blocking this setup.',
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
      },
    },
    context: {
      nowEt: { date: divergenceDate, time: '10:30' },
      sessionPhase: 'outside_window',
    },
  });
  const fb1 = insertTradeOutcomeFeedback(db, {
    trade_date: divergenceDate,
    setup_id: 'topstep_live',
    setup_name: 'Topstep Live Auto Journal',
    outcome: 'loss',
    pnl_dollars: -6,
    source: 'topstep_auto',
  });
  const fb2 = insertTradeOutcomeFeedback(db, {
    trade_date: divergenceDate,
    setup_id: 'topstep_live',
    setup_name: 'Topstep Live Auto Journal',
    outcome: 'win',
    pnl_dollars: 12,
    source: 'topstep_auto',
  });
  const fb3 = insertTradeOutcomeFeedback(db, {
    trade_date: divergenceDate,
    setup_id: 'topstep_live',
    setup_name: 'Topstep Live Auto Journal',
    outcome: 'win',
    pnl_dollars: 106,
    source: 'topstep_auto',
  });
  db.prepare(`
    INSERT INTO topstep_auto_journal_links (
      journal_run_id, external_fill_id, feedback_id, trade_date, symbol, order_id, pnl_dollars
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'fill_a', Number(fb1.lastInsertRowid), divergenceDate, 'MNQ', 'ord1', -6);
  db.prepare(`
    INSERT INTO topstep_auto_journal_links (
      journal_run_id, external_fill_id, feedback_id, trade_date, symbol, order_id, pnl_dollars
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'fill_b', Number(fb2.lastInsertRowid), divergenceDate, 'MNQ', 'ord2', 12);
  db.prepare(`
    INSERT INTO topstep_auto_journal_links (
      journal_run_id, external_fill_id, feedback_id, trade_date, symbol, order_id, pnl_dollars
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'fill_c', Number(fb3.lastInsertRowid), divergenceDate, 'MNQ', 'ord3', 106);
  const divergenceContextRow = db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(divergenceDate);
  assert(divergenceContextRow, 'divergence test context row should be persisted');
  const divergenceStrategySnapshot = {
    layers: {
      original: {
        key: 'original_plan_orb_3130',
        name: 'Original Trading Plan',
        perDate: {
          [divergenceDate]: {
            wouldTrade: false,
            tradeResult: null,
            tradePnlDollars: 0,
            tradePnlTicks: 0,
          },
        },
      },
      variants: { tested: [] },
    },
  };
  const divergenceDaily = evaluateRecommendationOutcomeDay({
    db,
    date: divergenceDate,
    contextRow: divergenceContextRow,
    sessions: buildSessionsByDate([divergenceDate]),
    strategySnapshot: divergenceStrategySnapshot,
    runTradeMechanicsVariantTool,
  });
  assert(divergenceDaily && typeof divergenceDaily === 'object', 'divergence daily outcome should be computed');
  const divergenceCheckpoint = divergenceDaily.assistantDecisionOutcomeCheckpoint;
  assert(divergenceCheckpoint && typeof divergenceCheckpoint === 'object', 'divergence checkpoint should be persisted');
  assert(
    String(divergenceCheckpoint.realizedOutcomeClassification || '') === 'correct',
    'divergence case should preserve internal model classification as correct'
  );
  assert(
    String(divergenceCheckpoint?.modelVsRealizedDivergence?.classification || '') === 'external_profitable_opportunity_while_model_defensive',
    'divergence case should set explicit model-vs-realized divergence classification'
  );
  assert(
    divergenceCheckpoint?.modelVsRealizedDivergence?.detected === true,
    'divergence case should set divergence flag true'
  );
  assert(
    Number(divergenceCheckpoint?.externalExecutionOutcome?.netPnlDollars || 0) === 112,
    'divergence case should carry external net pnl summary'
  );
  assert(
    String(divergenceCheckpoint?.externalExecutionOutcome?.sourceInUse || '') === 'topstep_linked_truth',
    'divergence case should use primary topstep-linked truth when journal links are present'
  );
  assert(
    String(divergenceCheckpoint?.externalExecutionOutcome?.trustClassification || '') === 'safe_to_trust_without_topstep',
    'divergence case should mark primary topstep-linked truth as safe'
  );
  assert(
    Array.isArray(divergenceCheckpoint?.externalExecutionOutcome?.sourceAttribution?.recoveryPlan?.deterministicActions),
    'divergence case should carry deterministic recovery actions in source attribution'
  );
  const persistedDivergence = db.prepare(`
    SELECT outcome_json
    FROM jarvis_assistant_decision_outcome_checkpoints
    WHERE trade_date = ?
    LIMIT 1
  `).get(divergenceDate);
  assert(persistedDivergence && persistedDivergence.outcome_json, 'divergence outcome json should be persisted');
  const persistedDivergenceJson = JSON.parse(String(persistedDivergence.outcome_json || '{}'));
  assert(
    String(persistedDivergenceJson?.modelVsRealizedDivergence?.classification || '') === 'external_profitable_opportunity_while_model_defensive',
    'persisted divergence classification should match expected enum'
  );
  const persistedHistoryRow = db.prepare(`
    SELECT outcome_json
    FROM jarvis_recommendation_outcome_history
    WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
    LIMIT 1
  `).get(divergenceDate);
  assert(persistedHistoryRow && persistedHistoryRow.outcome_json, 'recommendation outcome history row should be persisted');
  const persistedHistoryJson = JSON.parse(String(persistedHistoryRow.outcome_json || '{}'));
  assert(
    String(persistedHistoryJson?.externalExecutionOutcome?.sourceInUse || '') === 'topstep_linked_truth',
    'history outcome_json should persist external truth source from checkpoint enrichment'
  );
  assert(
    Number(persistedHistoryJson?.externalExecutionOutcome?.netPnlDollars || 0) === 112,
    'history outcome_json should persist external net pnl from checkpoint enrichment'
  );
  assert(
    String(persistedHistoryJson?.modelVsRealizedDivergence?.classification || '') === 'external_profitable_opportunity_while_model_defensive',
    'history outcome_json should persist model-vs-realized divergence classification'
  );

  const contexts = db.prepare('SELECT * FROM jarvis_recommendation_context_history ORDER BY rec_date DESC').all();
  const perf = buildRecommendationPerformance({
    db,
    contextRows: contexts,
    sessions,
    strategySnapshot,
    runTradeMechanicsVariantTool,
    maxRecords: 120,
  });

  assert(perf && perf.summary && typeof perf.summary === 'object', 'performance summary missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'postureAccuracy30d'), 'postureAccuracy30d missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'strategyAccuracy30d'), 'strategyAccuracy30d missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'tpAccuracy30d'), 'tpAccuracy30d missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'avgRecommendationDelta'), 'avgRecommendationDelta missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'rowCountUsed'), 'rowCountUsed missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'oldestRecordDate'), 'oldestRecordDate missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'newestRecordDate'), 'newestRecordDate missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'provenanceSummary'), 'provenanceSummary missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'shadowPlaybookComparisonSummary'), 'shadowPlaybookComparisonSummary missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'lateEntryPolicyExperiment'), 'lateEntryPolicyExperiment missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'lateEntryPolicyLine'), 'lateEntryPolicyLine missing');
  assert(Object.prototype.hasOwnProperty.call(perf.summary, 'lateEntryReplayReferenceLine'), 'lateEntryReplayReferenceLine missing');
  assert(
    perf.summary?.shadowPlaybookComparisonSummary?.laneBreakdown
    && typeof perf.summary.shadowPlaybookComparisonSummary.laneBreakdown === 'object',
    'shadow lane breakdown summary missing'
  );
  assert(
    perf.summary?.shadowPlaybookComparisonSummary?.laneFilterImpact
    && typeof perf.summary.shadowPlaybookComparisonSummary.laneFilterImpact === 'object',
    'shadow lane filter impact summary missing'
  );
  assert(
    perf.summary?.shadowPlaybookComparisonSummary?.predecisionLaneBreakdown
    && typeof perf.summary.shadowPlaybookComparisonSummary.predecisionLaneBreakdown === 'object',
    'shadow predecision lane breakdown summary missing'
  );
  assert(
    perf.summary?.shadowPlaybookComparisonSummary?.predecisionLaneFilterImpact
    && typeof perf.summary.shadowPlaybookComparisonSummary.predecisionLaneFilterImpact === 'object',
    'shadow predecision lane filter impact summary missing'
  );
  assert(
    perf.summary?.shadowPlaybookComparisonSummary?.laneStability
    && typeof perf.summary.shadowPlaybookComparisonSummary.laneStability === 'object',
    'shadow lane stability summary missing'
  );
  assert(
    perf.summary?.shadowPlaybookLaneDurability
    && typeof perf.summary.shadowPlaybookLaneDurability === 'object',
    'shadow durability summary missing'
  );
  assert(
    perf.summary?.shadowPlaybookLaneDurability?.rolling5DayStats
    && typeof perf.summary.shadowPlaybookLaneDurability.rolling5DayStats === 'object',
    'shadow rolling5 durability stats missing'
  );
  assert(
    perf.summary?.shadowPlaybookLaneDurability?.rolling10DayStats
    && typeof perf.summary.shadowPlaybookLaneDurability.rolling10DayStats === 'object',
    'shadow rolling10 durability stats missing'
  );
  assert(
    SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM.includes(
      String(perf.summary?.shadowPlaybookLaneDurability?.trendVerdict || '')
    ),
    'shadow durability trend verdict should be bounded'
  );
  assert(
    SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM.includes(
      String(perf.summary?.shadowPlaybookLaneDurability?.durabilityTrust?.overall || '')
    ),
    'shadow durability trust verdict should be bounded'
  );
  assert(
    SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM.includes(
      String(perf.summary?.shadowPlaybookLaneDurability?.promotionReadinessStatus || '')
    ),
    'shadow durability promotion readiness should be bounded'
  );
  assert(
    Object.prototype.hasOwnProperty.call(perf.summary?.shadowPlaybookLaneDurability || {}, 'externalFinalizedDays'),
    'shadow durability should expose externalFinalizedDays'
  );
  assert(
    Object.prototype.hasOwnProperty.call(perf.summary?.shadowPlaybookLaneDurability || {}, 'rolling5ExternalCoveragePct'),
    'shadow durability should expose rolling5ExternalCoveragePct'
  );
  assert(
    Object.prototype.hasOwnProperty.call(perf.summary?.shadowPlaybookLaneDurability || {}, 'rolling10ExternalCoveragePct'),
    'shadow durability should expose rolling10ExternalCoveragePct'
  );
  assert(
    Object.prototype.hasOwnProperty.call(perf.summary?.shadowPlaybookLaneDurability || {}, 'externallyFinalizedEligibleDays'),
    'shadow durability should expose externallyFinalizedEligibleDays'
  );
  assert(
    Object.prototype.hasOwnProperty.call(perf.summary?.shadowPlaybookLaneDurability || {}, 'promotableExpectancyView'),
    'shadow durability should expose promotableExpectancyView'
  );
  assert(
    perf.summary?.shadowPlaybookLaneDurability?.truthGapDiagnostics
      && typeof perf.summary.shadowPlaybookLaneDurability.truthGapDiagnostics === 'object',
    'shadow durability should expose latest-day truth gap diagnostics'
  );
  assert(
    typeof perf.summary?.shadowPlaybookLaneDurability?.latestDayAccountabilityStatus === 'string',
    'shadow durability should expose latest-day accountability status'
  );
  assert(
    typeof perf.summary?.shadowPlaybookLaneDurability?.latestEligibleShadowTruthStatus === 'string',
    'shadow durability should expose latest eligible shadow truth status'
  );
  assert(
    perf.summary?.lateEntryPolicyExperiment
      && typeof perf.summary.lateEntryPolicyExperiment === 'object',
    'late-entry policy experiment summary should be populated'
  );
  assert(
    LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM.includes(
      String(perf.summary?.lateEntryPolicyExperiment?.promotionReadinessStatus || '')
    ),
    'late-entry promotion readiness status should be bounded'
  );
  assert(
    typeof perf.summary?.lateEntryPolicyLine === 'string',
    'late-entry policy summary line should be surfaced'
  );
  assert(
    typeof perf.summary?.lateEntryReplayReferenceLine === 'string',
    'late-entry replay reference line should be surfaced'
  );
  assert(
    perf.summary?.lateEntryPolicyExperiment?.broadReplayReference
      && typeof perf.summary.lateEntryPolicyExperiment.broadReplayReference === 'object',
    'late-entry policy experiment should include broad replay reference lane'
  );
  assert(Number(perf.summary.rowCountUsed || 0) === Number(perf.summary.sourceBreakdown?.total || 0), 'rowCountUsed should match source total');
  const durabilityRowsBefore = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_shadow_playbook_durability_summary
  `).get()?.c || 0);
  assert(durabilityRowsBefore >= 1, 'shadow durability summary should persist at least one row');
  const latestDurability = db.prepare(`
    SELECT *
    FROM jarvis_shadow_playbook_durability_summary
    ORDER BY as_of_trade_date DESC, id DESC
    LIMIT 1
  `).get();
  assert(latestDurability, 'latest shadow durability row should exist');
  assert(
    SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM.includes(String(latestDurability.trend_verdict || '')),
    'persisted shadow durability trend verdict should be bounded'
  );
  assert(Number(latestDurability.total_eligible_days || 0) >= 0, 'persisted durability total_eligible_days missing');
  assert(Number(latestDurability.total_predecision_green_days || 0) >= 0, 'persisted durability total_predecision_green_days missing');
  assert(
    SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM.includes(
      String(latestDurability.promotion_readiness_status || '')
    ),
    'persisted promotion_readiness_status should be bounded'
  );
  assert(
    Number(latestDurability.external_finalized_days || 0) >= 0
      && Number(latestDurability.unfinalized_days || 0) >= 0,
    'persisted external/unfinalized day counts should be present'
  );
  assert(
    Number(latestDurability.externally_finalized_eligible_days || 0) >= 0
      && Number(latestDurability.externally_unfinalized_eligible_days || 0) >= 0,
    'persisted externally finalized/unfinalized eligible counts should be present'
  );
  assert.doesNotThrow(
    () => JSON.parse(String(latestDurability.promotion_readiness_block_reasons_json || '[]')),
    'persisted promotion_readiness_block_reasons_json should be valid JSON'
  );
  assert.doesNotThrow(
    () => JSON.parse(String(latestDurability.promotion_readiness_thresholds_json || '{}')),
    'persisted promotion_readiness_thresholds_json should be valid JSON'
  );
  assert.doesNotThrow(
    () => JSON.parse(String(latestDurability.unfinalized_trade_dates_json || '[]')),
    'persisted unfinalized_trade_dates_json should be valid JSON'
  );
  assert.doesNotThrow(() => JSON.parse(String(latestDurability.full_sample_json || '{}')), 'persisted full_sample_json should be valid JSON');
  assert.doesNotThrow(() => JSON.parse(String(latestDurability.rolling5_json || '{}')), 'persisted rolling5_json should be valid JSON');
  assert.doesNotThrow(() => JSON.parse(String(latestDurability.rolling10_json || '{}')), 'persisted rolling10_json should be valid JSON');

  const perfRecompute = buildRecommendationPerformance({
    db,
    contextRows: contexts,
    sessions,
    strategySnapshot,
    runTradeMechanicsVariantTool,
    maxRecords: 120,
  });
  assert(perfRecompute && perfRecompute.summary, 'recomputed performance summary missing');
  const durabilityRowsAfter = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_shadow_playbook_durability_summary
  `).get()?.c || 0);
  assert(
    durabilityRowsAfter === durabilityRowsBefore,
    'shadow durability summary recompute should be idempotent (no duplicate rows)'
  );

  db.close();
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

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3173,
  });

  try {
    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1');
    assert(center?.status === 'ok', 'command-center must return ok');
    assert(center?.commandCenter && typeof center.commandCenter === 'object', 'commandCenter payload missing');
    assert(center?.commandCenter?.recommendationPerformanceSummary && typeof center.commandCenter.recommendationPerformanceSummary === 'object', 'recommendationPerformanceSummary missing from command center');
    assert(
      center?.commandCenter?.recommendationPerformanceSummary?.shadowPlaybookComparisonSummary
      && typeof center.commandCenter.recommendationPerformanceSummary.shadowPlaybookComparisonSummary === 'object',
      'shadowPlaybookComparisonSummary missing from command center'
    );
    assert(
      center?.commandCenter?.recommendationPerformanceSummary?.shadowPlaybookLaneDurability
      && typeof center.commandCenter.recommendationPerformanceSummary.shadowPlaybookLaneDurability === 'object',
      'shadowPlaybookLaneDurability missing from command-center recommendationPerformanceSummary'
    );
    assert(
      center?.commandCenter?.shadowPlaybookLaneDurability
      && typeof center.commandCenter.shadowPlaybookLaneDurability === 'object',
      'top-level command-center shadowPlaybookLaneDurability missing'
    );
    assert(typeof center?.commandCenter?.shadowPlaybookLaneDurabilityLine === 'string', 'shadowPlaybookLaneDurabilityLine missing from command center');
    assert(
      SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM.includes(
        String(center?.commandCenter?.shadowPlaybookLaneDurabilityTrust || '')
      ),
      'command-center shadowPlaybookLaneDurabilityTrust should be bounded'
    );
    assert(
      center?.commandCenter?.shadowPlaybookRealizedTruthStatus
      && typeof center.commandCenter.shadowPlaybookRealizedTruthStatus === 'object',
      'command-center shadowPlaybookRealizedTruthStatus missing'
    );
    assert(
      typeof center?.commandCenter?.shadowPlaybookRealizedTruthLine === 'string',
      'command-center shadowPlaybookRealizedTruthLine missing'
    );
    assert(
      SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM.includes(
        String(center?.commandCenter?.shadowPlaybookPromotionReadinessStatus || '')
      ),
      'command-center shadowPlaybookPromotionReadinessStatus should be bounded'
    );
    assert(
      typeof center?.commandCenter?.shadowPlaybookPromotionReadinessLine === 'string',
      'command-center shadowPlaybookPromotionReadinessLine missing'
    );
    assert(
      center?.commandCenter?.shadowPlaybookPromotionReadinessLine.toLowerCase().includes('blocked')
      || center?.commandCenter?.shadowPlaybookPromotionReadinessLine.toLowerCase().includes('eligible'),
      'command-center promotion readiness line should state blocked vs eligible clearly'
    );
    assert(
      center?.commandCenter?.shadowPlaybookTruthGap
      && typeof center.commandCenter.shadowPlaybookTruthGap === 'object',
      'command-center shadowPlaybookTruthGap diagnostics missing'
    );
    assert(
      typeof center?.commandCenter?.shadowPlaybookLatestDayAccountabilityStatus === 'string',
      'command-center latest-day accountability status missing'
    );
    assert(
      typeof center?.commandCenter?.shadowPlaybookLatestDayAccountabilityLine === 'string',
      'command-center latest-day accountability line missing'
    );
    assert(
      typeof center?.commandCenter?.shadowPlaybookLatestEligibleTruthStatus === 'string',
      'command-center latest eligible shadow truth status missing'
    );
    assert(typeof center?.commandCenter?.recommendationPerformanceLine === 'string', 'recommendationPerformanceLine missing from command center');
    assert(
      typeof center?.commandCenter?.jarvisSimulatedTradeLine === 'string',
      'command-center jarvisSimulatedTradeLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyLine === 'string',
      'command-center lateEntryPolicyLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryReplayReferenceLine === 'string',
      'command-center lateEntryReplayReferenceLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyCommonDateLine === 'string',
      'command-center lateEntryPolicyCommonDateLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyMissingDateAuditLine === 'string',
      'command-center lateEntryPolicyMissingDateAuditLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV1VsV4GapLine === 'string',
      'command-center lateEntryPolicyV1VsV4GapLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTrustIfV4MissingDatesRepairedLine === 'string',
      'command-center lateEntryPolicyTrustIfV4MissingDatesRepairedLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV2Line === 'string',
      'command-center lateEntryPolicyV2Line missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV3Line === 'string',
      'command-center lateEntryPolicyV3Line missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV4Line === 'string',
      'command-center lateEntryPolicyV4Line missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV5Line === 'string',
      'command-center lateEntryPolicyV5Line missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryShadowLeaderLine === 'string',
      'command-center lateEntryShadowLeaderLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyPromotionReadinessLine === 'string',
      'command-center lateEntryPolicyPromotionReadinessLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV5LatestDayLine === 'string',
      'command-center lateEntryPolicyV5LatestDayLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyV5PocketMapLine === 'string',
      'command-center lateEntryPolicyV5PocketMapLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthCoverageBacklogLine === 'string',
      'command-center lateEntryPolicyTruthCoverageBacklogLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthCoverageLedgerLine === 'string',
      'command-center lateEntryPolicyTruthCoverageLedgerLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthFinalizationQueueLine === 'string',
      'command-center lateEntryPolicyTruthFinalizationQueueLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthBlockerDiagnosticsLine === 'string',
      'command-center lateEntryPolicyTruthBlockerDiagnosticsLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthBlockerAuditLine === 'string',
      'command-center lateEntryPolicyTruthBlockerAuditLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyContextGapAuditLine === 'string',
      'command-center lateEntryPolicyContextGapAuditLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyContextBackfillRunLine === 'string',
      'command-center lateEntryPolicyContextBackfillRunLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthRepairPlannerLine === 'string',
      'command-center lateEntryPolicyTruthRepairPlannerLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthDependencySplitLine === 'string',
      'command-center lateEntryPolicyTruthDependencySplitLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthBackfillRunLine === 'string',
      'command-center lateEntryPolicyTruthBackfillRunLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyCoverageAccelerationSummaryLine === 'string',
      'command-center lateEntryPolicyCoverageAccelerationSummaryLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyPromotionDossierLine === 'string',
      'command-center lateEntryPolicyPromotionDossierLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyManualReviewTriggerLine === 'string',
      'command-center lateEntryPolicyManualReviewTriggerLine missing'
    );
    assert(
      typeof center?.commandCenter?.lateEntryPolicyTruthAccumulationTrendLine === 'string',
      'command-center lateEntryPolicyTruthAccumulationTrendLine missing'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyExperimentV2 === null
      || typeof center.commandCenter.lateEntryPolicyExperimentV2 === 'object',
      'command-center lateEntryPolicyExperimentV2 should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyExperimentV3 === null
      || typeof center.commandCenter.lateEntryPolicyExperimentV3 === 'object',
      'command-center lateEntryPolicyExperimentV3 should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyExperimentV4 === null
      || typeof center.commandCenter.lateEntryPolicyExperimentV4 === 'object',
      'command-center lateEntryPolicyExperimentV4 should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyExperimentV5 === null
      || typeof center.commandCenter.lateEntryPolicyExperimentV5 === 'object',
      'command-center lateEntryPolicyExperimentV5 should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyCommonDateComparison === null
      || typeof center.commandCenter.lateEntryPolicyCommonDateComparison === 'object',
      'command-center lateEntryPolicyCommonDateComparison should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyMissingDateAudit === null
      || typeof center.commandCenter.lateEntryPolicyMissingDateAudit === 'object',
      'command-center lateEntryPolicyMissingDateAudit should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV1VsV4MissedTradeLedger === null
      || typeof center.commandCenter.lateEntryPolicyV1VsV4MissedTradeLedger === 'object',
      'command-center lateEntryPolicyV1VsV4MissedTradeLedger should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTrustIfV4MissingDatesRepaired === null
      || typeof center.commandCenter.lateEntryPolicyTrustIfV4MissingDatesRepaired === 'object',
      'command-center lateEntryPolicyTrustIfV4MissingDatesRepaired should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryShadowLeader === null
      || typeof center.commandCenter.lateEntryShadowLeader === 'object',
      'command-center lateEntryShadowLeader should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyPromotionReadiness === null
      || typeof center.commandCenter.lateEntryPolicyPromotionReadiness === 'object',
      'command-center lateEntryPolicyPromotionReadiness should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5LatestDay === null
      || typeof center.commandCenter.lateEntryPolicyV5LatestDay === 'object',
      'command-center lateEntryPolicyV5LatestDay should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5RecentShadowScore === null
      || typeof center.commandCenter.lateEntryPolicyV5RecentShadowScore === 'object',
      'command-center lateEntryPolicyV5RecentShadowScore should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5PocketMap === null
      || typeof center.commandCenter.lateEntryPolicyV5PocketMap === 'object',
      'command-center lateEntryPolicyV5PocketMap should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthCoverageBacklog === null
      || typeof center.commandCenter.lateEntryPolicyTruthCoverageBacklog === 'object',
      'command-center lateEntryPolicyTruthCoverageBacklog should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthCoverageLedger === null
      || typeof center.commandCenter.lateEntryPolicyTruthCoverageLedger === 'object',
      'command-center lateEntryPolicyTruthCoverageLedger should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthFinalizationQueue === null
      || typeof center.commandCenter.lateEntryPolicyTruthFinalizationQueue === 'object',
      'command-center lateEntryPolicyTruthFinalizationQueue should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthBlockerDiagnostics === null
      || typeof center.commandCenter.lateEntryPolicyTruthBlockerDiagnostics === 'object',
      'command-center lateEntryPolicyTruthBlockerDiagnostics should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthBlockerAudit === null
      || typeof center.commandCenter.lateEntryPolicyTruthBlockerAudit === 'object',
      'command-center lateEntryPolicyTruthBlockerAudit should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyContextGapAudit === null
      || typeof center.commandCenter.lateEntryPolicyContextGapAudit === 'object',
      'command-center lateEntryPolicyContextGapAudit should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyContextBackfillRun === null
      || typeof center.commandCenter.lateEntryPolicyContextBackfillRun === 'object',
      'command-center lateEntryPolicyContextBackfillRun should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthRepairPlanner === null
      || typeof center.commandCenter.lateEntryPolicyTruthRepairPlanner === 'object',
      'command-center lateEntryPolicyTruthRepairPlanner should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthDependencySplit === null
      || typeof center.commandCenter.lateEntryPolicyTruthDependencySplit === 'object',
      'command-center lateEntryPolicyTruthDependencySplit should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthBackfillRun === null
      || typeof center.commandCenter.lateEntryPolicyTruthBackfillRun === 'object',
      'command-center lateEntryPolicyTruthBackfillRun should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyCoverageAccelerationSummary === null
      || typeof center.commandCenter.lateEntryPolicyCoverageAccelerationSummary === 'object',
      'command-center lateEntryPolicyCoverageAccelerationSummary should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyPromotionDossier === null
      || typeof center.commandCenter.lateEntryPolicyPromotionDossier === 'object',
      'command-center lateEntryPolicyPromotionDossier should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyManualReviewTrigger === null
      || typeof center.commandCenter.lateEntryPolicyManualReviewTrigger === 'object',
      'command-center lateEntryPolicyManualReviewTrigger should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyTruthAccumulationTrend === null
      || typeof center.commandCenter.lateEntryPolicyTruthAccumulationTrend === 'object',
      'command-center lateEntryPolicyTruthAccumulationTrend should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV2VsV1Delta === null
      || typeof center.commandCenter.lateEntryPolicyV2VsV1Delta === 'object',
      'command-center lateEntryPolicyV2VsV1Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV3VsV2Delta === null
      || typeof center.commandCenter.lateEntryPolicyV3VsV2Delta === 'object',
      'command-center lateEntryPolicyV3VsV2Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV3VsV1Delta === null
      || typeof center.commandCenter.lateEntryPolicyV3VsV1Delta === 'object',
      'command-center lateEntryPolicyV3VsV1Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV4VsV3Delta === null
      || typeof center.commandCenter.lateEntryPolicyV4VsV3Delta === 'object',
      'command-center lateEntryPolicyV4VsV3Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV4VsV2Delta === null
      || typeof center.commandCenter.lateEntryPolicyV4VsV2Delta === 'object',
      'command-center lateEntryPolicyV4VsV2Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV4VsV1Delta === null
      || typeof center.commandCenter.lateEntryPolicyV4VsV1Delta === 'object',
      'command-center lateEntryPolicyV4VsV1Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5VsV4Delta === null
      || typeof center.commandCenter.lateEntryPolicyV5VsV4Delta === 'object',
      'command-center lateEntryPolicyV5VsV4Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5VsV3Delta === null
      || typeof center.commandCenter.lateEntryPolicyV5VsV3Delta === 'object',
      'command-center lateEntryPolicyV5VsV3Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5VsV2Delta === null
      || typeof center.commandCenter.lateEntryPolicyV5VsV2Delta === 'object',
      'command-center lateEntryPolicyV5VsV2Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyV5VsV1Delta === null
      || typeof center.commandCenter.lateEntryPolicyV5VsV1Delta === 'object',
      'command-center lateEntryPolicyV5VsV1Delta should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyExperiment === null
      || typeof center.commandCenter.lateEntryPolicyExperiment === 'object',
      'command-center lateEntryPolicyExperiment should be object or null'
    );
    assert(
      center?.commandCenter?.lateEntryPolicyPromotionReadinessStatus == null
      || LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM.includes(
        String(center.commandCenter.lateEntryPolicyPromotionReadinessStatus || '')
      ),
      'command-center late-entry promotion readiness status should be bounded'
    );
    assert(
      center?.commandCenter?.jarvisSimulatedTrade === null
      || typeof center.commandCenter.jarvisSimulatedTrade === 'object',
      'command-center jarvisSimulatedTrade should be object or null'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || typeof center.commandCenter.todayRecommendation?.lateEntryShadowLeaderLine === 'string',
      'todayRecommendation should surface lateEntryShadowLeaderLine'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || typeof center.commandCenter.todayRecommendation?.lateEntryPolicyV5LatestDayLine === 'string',
      'todayRecommendation should surface lateEntryPolicyV5LatestDayLine'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyV5PocketMapLine === 'string',
      'decisionBoard should surface lateEntryPolicyV5PocketMapLine'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || center.commandCenter.decisionBoard?.lateEntryPolicyPromotionReadiness === null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyPromotionReadiness === 'object',
      'decisionBoard should surface lateEntryPolicyPromotionReadiness object'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || center.commandCenter.decisionBoard?.lateEntryPolicyManualReviewTrigger === null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyManualReviewTrigger === 'object',
      'decisionBoard should surface lateEntryPolicyManualReviewTrigger object'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || center.commandCenter.todayRecommendation?.lateEntryPolicyTruthCoverageBacklog === null
      || typeof center.commandCenter.todayRecommendation?.lateEntryPolicyTruthCoverageBacklog === 'object',
      'todayRecommendation should surface lateEntryPolicyTruthCoverageBacklog object'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || center.commandCenter.todayRecommendation?.lateEntryPolicyTruthFinalizationQueue === null
      || typeof center.commandCenter.todayRecommendation?.lateEntryPolicyTruthFinalizationQueue === 'object',
      'todayRecommendation should surface lateEntryPolicyTruthFinalizationQueue object'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || center.commandCenter.todayRecommendation?.lateEntryPolicyTruthBlockerDiagnostics === null
      || typeof center.commandCenter.todayRecommendation?.lateEntryPolicyTruthBlockerDiagnostics === 'object',
      'todayRecommendation should surface lateEntryPolicyTruthBlockerDiagnostics object'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || center.commandCenter.todayRecommendation?.lateEntryPolicyTruthBlockerAudit === null
      || typeof center.commandCenter.todayRecommendation?.lateEntryPolicyTruthBlockerAudit === 'object',
      'todayRecommendation should surface lateEntryPolicyTruthBlockerAudit object'
    );
    assert(
      center?.commandCenter?.todayRecommendation == null
      || center.commandCenter.todayRecommendation?.lateEntryPolicyContextGapAudit === null
      || typeof center.commandCenter.todayRecommendation?.lateEntryPolicyContextGapAudit === 'object',
      'todayRecommendation should surface lateEntryPolicyContextGapAudit object'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || center.commandCenter.decisionBoard?.lateEntryPolicyContextBackfillRun === null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyContextBackfillRun === 'object',
      'decisionBoard should surface lateEntryPolicyContextBackfillRun object'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || center.commandCenter.decisionBoard?.lateEntryPolicyTruthRepairPlanner === null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyTruthRepairPlanner === 'object',
      'decisionBoard should surface lateEntryPolicyTruthRepairPlanner object'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || center.commandCenter.decisionBoard?.lateEntryPolicyTruthDependencySplit === null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyTruthDependencySplit === 'object',
      'decisionBoard should surface lateEntryPolicyTruthDependencySplit object'
    );
    assert(
      center?.commandCenter?.decisionBoard == null
      || center.commandCenter.decisionBoard?.lateEntryPolicyCoverageAccelerationSummary === null
      || typeof center.commandCenter.decisionBoard?.lateEntryPolicyCoverageAccelerationSummary === 'object',
      'decisionBoard should surface lateEntryPolicyCoverageAccelerationSummary object'
    );

    const perf = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?force=1');
    assert(perf?.status === 'ok', 'recommendation performance endpoint must return ok');
    assert(perf?.recommendationPerformance && typeof perf.recommendationPerformance === 'object', 'recommendationPerformance payload missing');
    const summary = perf.recommendationPerformance;
    const required = [
      'postureAccuracy30d',
      'strategyAccuracy30d',
      'tpAccuracy30d',
      'avgRecommendationDelta',
      'rowCountUsed',
      'oldestRecordDate',
      'newestRecordDate',
      'provenanceSummary',
      'shadowPlaybookComparisonSummary',
      'shadowPlaybookLaneDurability',
      'lateEntryPolicyExperiment',
      'lateEntryPolicyExperimentV2',
      'lateEntryPolicyExperimentV3',
      'lateEntryPolicyExperimentV4',
      'lateEntryPolicyExperimentV5',
      'lateEntryPolicyV2VsV1Delta',
      'lateEntryPolicyV3VsV2Delta',
      'lateEntryPolicyV3VsV1Delta',
      'lateEntryPolicyV4VsV3Delta',
      'lateEntryPolicyV4VsV2Delta',
      'lateEntryPolicyV4VsV1Delta',
      'lateEntryPolicyV5VsV4Delta',
      'lateEntryPolicyV5VsV3Delta',
      'lateEntryPolicyV5VsV2Delta',
      'lateEntryPolicyV5VsV1Delta',
      'lateEntryPolicyLine',
      'lateEntryPolicyV2Line',
      'lateEntryPolicyV3Line',
      'lateEntryPolicyV4Line',
      'lateEntryPolicyV5Line',
      'lateEntryReplayReferenceLine',
      'lateEntryPolicyCommonDateComparison',
      'lateEntryPolicyCommonDateLine',
      'lateEntryPolicyMissingDateAudit',
      'lateEntryPolicyV1VsV4MissedTradeLedger',
      'lateEntryPolicyTrustIfV4MissingDatesRepaired',
      'lateEntryPolicyMissingDateAuditLine',
      'lateEntryPolicyV1VsV4GapLine',
      'lateEntryPolicyTrustIfV4MissingDatesRepairedLine',
      'lateEntryShadowLeader',
      'lateEntryPolicyPromotionReadiness',
      'lateEntryPolicyV5LatestDay',
      'lateEntryPolicyV5RecentShadowScore',
      'lateEntryPolicyV5PocketMap',
      'lateEntryPolicyTruthCoverageBacklog',
      'lateEntryPolicyTruthCoverageLedger',
      'lateEntryPolicyTruthFinalizationQueue',
      'lateEntryPolicyTruthBlockerDiagnostics',
      'lateEntryPolicyTruthBlockerAudit',
      'lateEntryPolicyContextGapAudit',
      'lateEntryPolicyContextBackfillRun',
      'lateEntryPolicyTruthRepairPlanner',
      'lateEntryPolicyTruthDependencySplit',
      'lateEntryPolicyTruthBackfillRun',
      'lateEntryPolicyCoverageAccelerationSummary',
      'lateEntryPolicyPromotionDossier',
      'lateEntryPolicyManualReviewTrigger',
      'lateEntryPolicyTruthAccumulationTrend',
      'lateEntryShadowLeaderLine',
      'lateEntryPolicyPromotionReadinessLine',
      'lateEntryPolicyV5LatestDayLine',
      'lateEntryPolicyV5PocketMapLine',
      'lateEntryPolicyTruthCoverageBacklogLine',
      'lateEntryPolicyTruthCoverageLedgerLine',
      'lateEntryPolicyTruthFinalizationQueueLine',
      'lateEntryPolicyTruthBlockerDiagnosticsLine',
      'lateEntryPolicyTruthBlockerAuditLine',
      'lateEntryPolicyContextGapAuditLine',
      'lateEntryPolicyContextBackfillRunLine',
      'lateEntryPolicyTruthRepairPlannerLine',
      'lateEntryPolicyTruthDependencySplitLine',
      'lateEntryPolicyTruthBackfillRunLine',
      'lateEntryPolicyCoverageAccelerationSummaryLine',
      'lateEntryPolicyPromotionDossierLine',
      'lateEntryPolicyManualReviewTriggerLine',
      'lateEntryPolicyTruthAccumulationTrendLine',
    ];
    for (const key of required) {
      assert(Object.prototype.hasOwnProperty.call(summary, key), `missing ${key} in recommendationPerformance`, { summary });
    }
    assert(
      SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM.includes(
        String(summary?.shadowPlaybookLaneDurability?.promotionReadinessStatus || '')
      ),
      'recommendation-performance payload should include bounded promotion readiness status'
    );
    assert(
      Object.prototype.hasOwnProperty.call(summary?.shadowPlaybookLaneDurability || {}, 'externalCoveragePct'),
      'recommendation-performance payload should include externalCoveragePct for shadow durability'
    );
    assert(
      summary?.shadowPlaybookLaneDurability?.truthGapDiagnostics
      && typeof summary.shadowPlaybookLaneDurability.truthGapDiagnostics === 'object',
      'recommendation-performance payload should include truth gap diagnostics'
    );
    assert(
      typeof summary?.shadowPlaybookLaneDurability?.latestDayAccountabilityStatus === 'string',
      'recommendation-performance payload should include latest-day accountability status'
    );
    assert(
      typeof summary?.shadowPlaybookLaneDurability?.latestEligibleShadowTruthStatus === 'string',
      'recommendation-performance payload should include latest eligible shadow truth status'
    );
    assert(
      typeof summary?.jarvisSimulatedTradeLine === 'string',
      'recommendation-performance payload should include jarvisSimulatedTradeLine'
    );
    assert(
      summary?.lateEntryPolicyExperiment
      && typeof summary.lateEntryPolicyExperiment === 'object',
      'recommendation-performance payload should include lateEntryPolicyExperiment'
    );
    assert(
      LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM.includes(
        String(summary?.lateEntryPolicyExperiment?.promotionReadinessStatus || '')
      ),
      'recommendation-performance payload should include bounded late-entry promotion readiness'
    );
    assert(
      summary?.lateEntryPolicyExperiment?.broadReplayReference
      && typeof summary.lateEntryPolicyExperiment.broadReplayReference === 'object',
      'recommendation-performance payload should include broad replay reference lane'
    );
    assert(
      summary?.lateEntryPolicyExperiment?.replayClassificationCounts
      && typeof summary.lateEntryPolicyExperiment.replayClassificationCounts === 'object',
      'recommendation-performance payload should include replay classification counts'
    );
    assert(
      summary?.lateEntryPolicyExperimentV2
      && typeof summary.lateEntryPolicyExperimentV2 === 'object',
      'recommendation-performance payload should include lateEntryPolicyExperimentV2'
    );
    assert(
      summary?.lateEntryPolicyExperimentV3
      && typeof summary.lateEntryPolicyExperimentV3 === 'object',
      'recommendation-performance payload should include lateEntryPolicyExperimentV3'
    );
    assert(
      summary?.lateEntryPolicyExperimentV4
      && typeof summary.lateEntryPolicyExperimentV4 === 'object',
      'recommendation-performance payload should include lateEntryPolicyExperimentV4'
    );
    assert(
      summary?.lateEntryPolicyExperimentV5
      && typeof summary.lateEntryPolicyExperimentV5 === 'object',
      'recommendation-performance payload should include lateEntryPolicyExperimentV5'
    );
    assert(
      summary?.lateEntryPolicyV2VsV1Delta
      && typeof summary.lateEntryPolicyV2VsV1Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV2VsV1Delta'
    );
    assert(
      summary?.lateEntryPolicyV3VsV2Delta
      && typeof summary.lateEntryPolicyV3VsV2Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV3VsV2Delta'
    );
    assert(
      summary?.lateEntryPolicyV3VsV1Delta
      && typeof summary.lateEntryPolicyV3VsV1Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV3VsV1Delta'
    );
    assert(
      summary?.lateEntryPolicyV4VsV3Delta
      && typeof summary.lateEntryPolicyV4VsV3Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV4VsV3Delta'
    );
    assert(
      summary?.lateEntryPolicyV4VsV2Delta
      && typeof summary.lateEntryPolicyV4VsV2Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV4VsV2Delta'
    );
    assert(
      summary?.lateEntryPolicyV4VsV1Delta
      && typeof summary.lateEntryPolicyV4VsV1Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV4VsV1Delta'
    );
    assert(
      summary?.lateEntryPolicyV5VsV4Delta
      && typeof summary.lateEntryPolicyV5VsV4Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5VsV4Delta'
    );
    assert(
      summary?.lateEntryPolicyV5VsV3Delta
      && typeof summary.lateEntryPolicyV5VsV3Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5VsV3Delta'
    );
    assert(
      summary?.lateEntryPolicyV5VsV2Delta
      && typeof summary.lateEntryPolicyV5VsV2Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5VsV2Delta'
    );
    assert(
      summary?.lateEntryPolicyV5VsV1Delta
      && typeof summary.lateEntryPolicyV5VsV1Delta === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5VsV1Delta'
    );
    assert(
      summary?.lateEntryPolicyCommonDateComparison
      && typeof summary.lateEntryPolicyCommonDateComparison === 'object',
      'recommendation-performance payload should include lateEntryPolicyCommonDateComparison'
    );
    assert(
      summary?.lateEntryPolicyMissingDateAudit
      && typeof summary.lateEntryPolicyMissingDateAudit === 'object',
      'recommendation-performance payload should include lateEntryPolicyMissingDateAudit'
    );
    assert(
      summary?.lateEntryPolicyV1VsV4MissedTradeLedger
      && typeof summary.lateEntryPolicyV1VsV4MissedTradeLedger === 'object',
      'recommendation-performance payload should include lateEntryPolicyV1VsV4MissedTradeLedger'
    );
    assert(
      summary?.lateEntryPolicyTrustIfV4MissingDatesRepaired
      && typeof summary.lateEntryPolicyTrustIfV4MissingDatesRepaired === 'object',
      'recommendation-performance payload should include lateEntryPolicyTrustIfV4MissingDatesRepaired'
    );
    assert(
      summary?.lateEntryShadowLeader
      && typeof summary.lateEntryShadowLeader === 'object',
      'recommendation-performance payload should include lateEntryShadowLeader'
    );
    assert(
      summary?.lateEntryPolicyPromotionReadiness
      && typeof summary.lateEntryPolicyPromotionReadiness === 'object',
      'recommendation-performance payload should include lateEntryPolicyPromotionReadiness'
    );
    assert(
      summary?.lateEntryPolicyV5LatestDay === null
      || typeof summary.lateEntryPolicyV5LatestDay === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5LatestDay object or null'
    );
    assert(
      summary?.lateEntryPolicyV5RecentShadowScore === null
      || typeof summary.lateEntryPolicyV5RecentShadowScore === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5RecentShadowScore object or null'
    );
    assert(
      summary?.lateEntryPolicyV5PocketMap === null
      || typeof summary.lateEntryPolicyV5PocketMap === 'object',
      'recommendation-performance payload should include lateEntryPolicyV5PocketMap object or null'
    );
    assert(
      summary?.lateEntryPolicyTruthCoverageBacklog
      && typeof summary.lateEntryPolicyTruthCoverageBacklog === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthCoverageBacklog'
    );
    assert(
      summary?.lateEntryPolicyTruthCoverageLedger
      && typeof summary.lateEntryPolicyTruthCoverageLedger === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthCoverageLedger'
    );
    assert(
      summary?.lateEntryPolicyTruthFinalizationQueue
      && typeof summary.lateEntryPolicyTruthFinalizationQueue === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthFinalizationQueue'
    );
    assert(
      summary?.lateEntryPolicyTruthBlockerDiagnostics
      && typeof summary.lateEntryPolicyTruthBlockerDiagnostics === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthBlockerDiagnostics'
    );
    assert(
      summary?.lateEntryPolicyTruthBlockerAudit
      && typeof summary.lateEntryPolicyTruthBlockerAudit === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthBlockerAudit'
    );
    assert(
      summary?.lateEntryPolicyContextGapAudit
      && typeof summary.lateEntryPolicyContextGapAudit === 'object',
      'recommendation-performance payload should include lateEntryPolicyContextGapAudit'
    );
    assert(
      summary?.lateEntryPolicyContextBackfillRun
      && typeof summary.lateEntryPolicyContextBackfillRun === 'object',
      'recommendation-performance payload should include lateEntryPolicyContextBackfillRun'
    );
    assert(
      summary?.lateEntryPolicyTruthRepairPlanner
      && typeof summary.lateEntryPolicyTruthRepairPlanner === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthRepairPlanner'
    );
    assert(
      summary?.lateEntryPolicyTruthDependencySplit
      && typeof summary.lateEntryPolicyTruthDependencySplit === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthDependencySplit'
    );
    assert(
      summary?.lateEntryPolicyTruthBackfillRun
      && typeof summary.lateEntryPolicyTruthBackfillRun === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthBackfillRun'
    );
    assert(
      summary?.lateEntryPolicyCoverageAccelerationSummary
      && typeof summary.lateEntryPolicyCoverageAccelerationSummary === 'object',
      'recommendation-performance payload should include lateEntryPolicyCoverageAccelerationSummary'
    );
    assert(
      summary?.lateEntryPolicyPromotionDossier
      && typeof summary.lateEntryPolicyPromotionDossier === 'object',
      'recommendation-performance payload should include lateEntryPolicyPromotionDossier'
    );
    assert(
      summary?.lateEntryPolicyManualReviewTrigger
      && typeof summary.lateEntryPolicyManualReviewTrigger === 'object',
      'recommendation-performance payload should include lateEntryPolicyManualReviewTrigger'
    );
    assert(
      summary?.lateEntryPolicyTruthAccumulationTrend
      && typeof summary.lateEntryPolicyTruthAccumulationTrend === 'object',
      'recommendation-performance payload should include lateEntryPolicyTruthAccumulationTrend'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyPromotionReadiness?.remainingToUnlock?.externalCoveragePctGap)),
      'recommendation-performance payload should include numeric external coverage gap'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyTruthCoverageBacklog?.externallyUnfinalizedEligibleDays || 0)),
      'truth coverage backlog should include sane numeric unfinalized eligible days'
    );
    assert(
      Array.isArray(summary?.lateEntryPolicyTruthCoverageLedger?.recentMissingDates),
      'truth coverage ledger should include recentMissingDates'
    );
    assert(
      Array.isArray(summary?.lateEntryPolicyTruthCoverageLedger?.highPriorityMissingDates),
      'truth coverage ledger should include highPriorityMissingDates'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyTruthFinalizationQueue?.readyNowCount || 0)),
      'truth finalization queue should expose numeric readyNowCount'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyTruthBlockerDiagnostics?.blockedCount || 0)),
      'truth blocker diagnostics should expose deterministic blockedCount'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyTruthBlockerAudit?.blockedCount || 0)),
      'truth blocker audit should expose deterministic blockedCount'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyContextGapAudit?.missingContextCount || 0)),
      'context gap audit should expose deterministic missingContextCount'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyContextBackfillRun?.scannedDates || 0)),
      'context backfill run should expose deterministic scannedDates'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyTruthRepairPlanner?.blockedCount || 0)),
      'truth repair planner should expose deterministic blockedCount'
    );
    assert(
      Number.isFinite(Number(summary?.lateEntryPolicyTruthDependencySplit?.externalTruthRequiredDays || 0)),
      'truth dependency split should expose deterministic externalTruthRequiredDays'
    );
    assert(
      Array.isArray(summary?.lateEntryPolicyTruthFinalizationQueue?.readyNowDates),
      'truth finalization queue should expose readyNowDates'
    );
    assert(
      summary?.lateEntryPolicyTruthBackfillRun?.advisoryOnly === true,
      'truth backfill run should remain advisory-only'
    );
    assert(
      ['true', 'false'].includes(String(summary?.lateEntryPolicyCoverageAccelerationSummary?.movedNeedle)),
      'coverage acceleration summary should expose boolean movedNeedle'
    );
    assert(
      ['not_ready', 'ready_for_manual_review'].includes(
        String(summary?.lateEntryPolicyPromotionDossier?.manualReviewVerdict || '')
      ),
      'promotion dossier should expose bounded manualReviewVerdict'
    );
    if (String(summary?.lateEntryPolicyPromotionReadiness?.status || '') !== 'promotable_for_review') {
      assert(
        summary?.lateEntryPolicyManualReviewTrigger?.shouldOpenManualReview === false,
        'manual review trigger should remain false while coverage thresholds are not met'
      );
    }
    assert(
      ['improving', 'flat', 'worsening'].includes(
        String(summary?.lateEntryPolicyTruthAccumulationTrend?.deltaDirection || '')
      ),
      'truth accumulation trend should expose deterministic delta direction'
    );
    assert(
      String(summary?.lateEntryShadowLeader?.strictCommonDateTrustStatus || '')
      === String(summary?.lateEntryPolicyCommonDateComparison?.trustworthiness?.status || ''),
      'shadow leader trust status should match strict common-date trust status'
    );
    const strictTopPnlLane = String(
      summary?.lateEntryPolicyCommonDateComparison?.commonDatePolicyRanking?.byTotalPnl?.[0]?.laneKey || ''
    ).toLowerCase();
    if (strictTopPnlLane === 'v5') {
      assert(
        String(summary?.lateEntryShadowLeader?.laneKey || '').toLowerCase() === 'v5',
        'shadow leader should identify v5 when strict common-date top PnL lane is v5'
      );
    }
    if (summary?.lateEntryPolicyV5LatestDay && typeof summary.lateEntryPolicyV5LatestDay === 'object') {
      assert(
        typeof summary.lateEntryPolicyV5LatestDay.baselineWouldTrade === 'boolean',
        'lateEntryPolicyV5LatestDay should include baselineWouldTrade'
      );
      assert(
        typeof summary.lateEntryPolicyV5LatestDay.v4WouldTrade === 'boolean',
        'lateEntryPolicyV5LatestDay should include v4WouldTrade'
      );
      assert(
        typeof summary.lateEntryPolicyV5LatestDay.v5WouldTrade === 'boolean',
        'lateEntryPolicyV5LatestDay should include v5WouldTrade'
      );
    }
    assert(
      typeof summary?.lateEntryPolicyLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyLine'
    );
    assert(
      typeof summary?.lateEntryPolicyV2Line === 'string',
      'recommendation-performance payload should include lateEntryPolicyV2Line'
    );
    assert(
      typeof summary?.lateEntryPolicyV3Line === 'string',
      'recommendation-performance payload should include lateEntryPolicyV3Line'
    );
    assert(
      typeof summary?.lateEntryPolicyV4Line === 'string',
      'recommendation-performance payload should include lateEntryPolicyV4Line'
    );
    assert(
      typeof summary?.lateEntryPolicyV5Line === 'string',
      'recommendation-performance payload should include lateEntryPolicyV5Line'
    );
    assert(
      typeof summary?.lateEntryReplayReferenceLine === 'string',
      'recommendation-performance payload should include lateEntryReplayReferenceLine'
    );
    assert(
      typeof summary?.lateEntryPolicyCommonDateLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyCommonDateLine'
    );
    assert(
      typeof summary?.lateEntryPolicyMissingDateAuditLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyMissingDateAuditLine'
    );
    assert(
      typeof summary?.lateEntryPolicyV1VsV4GapLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyV1VsV4GapLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTrustIfV4MissingDatesRepairedLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTrustIfV4MissingDatesRepairedLine'
    );
    assert(
      typeof summary?.lateEntryShadowLeaderLine === 'string',
      'recommendation-performance payload should include lateEntryShadowLeaderLine'
    );
    assert(
      typeof summary?.lateEntryPolicyPromotionReadinessLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyPromotionReadinessLine'
    );
    assert(
      typeof summary?.lateEntryPolicyV5LatestDayLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyV5LatestDayLine'
    );
    assert(
      typeof summary?.lateEntryPolicyV5PocketMapLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyV5PocketMapLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthCoverageBacklogLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthCoverageBacklogLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthCoverageLedgerLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthCoverageLedgerLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthFinalizationQueueLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthFinalizationQueueLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthBlockerDiagnosticsLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthBlockerDiagnosticsLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthBlockerAuditLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthBlockerAuditLine'
    );
    assert(
      typeof summary?.lateEntryPolicyContextGapAuditLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyContextGapAuditLine'
    );
    assert(
      typeof summary?.lateEntryPolicyContextBackfillRunLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyContextBackfillRunLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthRepairPlannerLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthRepairPlannerLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthDependencySplitLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthDependencySplitLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthBackfillRunLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthBackfillRunLine'
    );
    assert(
      typeof summary?.lateEntryPolicyCoverageAccelerationSummaryLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyCoverageAccelerationSummaryLine'
    );
    assert(
      typeof summary?.lateEntryPolicyPromotionDossierLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyPromotionDossierLine'
    );
    assert(
      typeof summary?.lateEntryPolicyManualReviewTriggerLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyManualReviewTriggerLine'
    );
    assert(
      typeof summary?.lateEntryPolicyTruthAccumulationTrendLine === 'string',
      'recommendation-performance payload should include lateEntryPolicyTruthAccumulationTrendLine'
    );
    assert(
      summary?.jarvisSimulatedTrade === null || typeof summary.jarvisSimulatedTrade === 'object',
      'recommendation-performance payload should include jarvisSimulatedTrade object or null'
    );
    assert(perf.advisoryOnly === true, 'recommendation performance endpoint must be advisory-only');

    const simulated = await getJson(server.baseUrl, '/api/jarvis/simulated-trade-outcome?date=2026-03-06');
    assert(
      simulated?.status === 'ok' || simulated?.status === 'no_data',
      'simulated-trade-outcome endpoint should return ok or no_data'
    );
    if (simulated?.status === 'ok') {
      assert(simulated.simulatedTradeOutcome && typeof simulated.simulatedTradeOutcome === 'object', 'simulated-trade-outcome payload missing object');
      assert(typeof simulated.simulatedTradeOutcome.didJarvisTakeTrade === 'boolean', 'simulated-trade-outcome didJarvisTakeTrade missing');
      assert(typeof simulated.simulatedTradeOutcome.simulatedStatusLine === 'string', 'simulated-trade-outcome simulatedStatusLine missing');
    }

    const latePolicy = await getJson(server.baseUrl, '/api/jarvis/late-entry-policy-experiment?date=2026-04-09');
    assert(
      latePolicy?.status === 'ok' || latePolicy?.status === 'no_data',
      'late-entry-policy endpoint should return ok or no_data'
    );
    if (latePolicy?.status === 'ok') {
      assert(
        latePolicy.lateEntryPolicyExperiment && typeof latePolicy.lateEntryPolicyExperiment === 'object',
        'late-entry-policy payload should include experiment object'
      );
      assert(
        typeof latePolicy.lateEntryPolicyExperiment.wouldBaselineTakeTrade === 'boolean',
        'late-entry-policy payload should include wouldBaselineTakeTrade'
      );
      assert(
        typeof latePolicy.lateEntryPolicyExperiment.wouldExtensionPolicyTakeTrade === 'boolean',
        'late-entry-policy payload should include wouldExtensionPolicyTakeTrade'
      );
      assert(
        latePolicy.lateEntryPolicyExperiment.nearestTpOutcome
          && typeof latePolicy.lateEntryPolicyExperiment.nearestTpOutcome === 'object',
        'late-entry-policy payload should include nearestTpOutcome object'
      );
      assert(
        latePolicy.lateEntryPolicyExperiment.baselineDecision
          && typeof latePolicy.lateEntryPolicyExperiment.baselineDecision === 'object',
        'late-entry-policy payload should include baselineDecision section'
      );
      assert(
        latePolicy.lateEntryPolicyExperiment.extensionPolicyDecision
          && typeof latePolicy.lateEntryPolicyExperiment.extensionPolicyDecision === 'object',
        'late-entry-policy payload should include extensionPolicyDecision section'
      );
      assert(
        latePolicy.lateEntryPolicyExperiment.hard1200Replay
          && typeof latePolicy.lateEntryPolicyExperiment.hard1200Replay === 'object',
        'late-entry-policy payload should include hard1200Replay section'
      );
      assert(
        latePolicy.lateEntryPolicyExperiment.noCutoffReplay
          && typeof latePolicy.lateEntryPolicyExperiment.noCutoffReplay === 'object',
        'late-entry-policy payload should include noCutoffReplay section'
      );
      assert(
        latePolicy.lateEntryPolicyExperiment.tpReplayComparison
          && typeof latePolicy.lateEntryPolicyExperiment.tpReplayComparison === 'object',
        'late-entry-policy payload should include tpReplayComparison section'
      );
      assert(
        latePolicy.lateEntryPolicyAnswer && typeof latePolicy.lateEntryPolicyAnswer === 'object',
        'late-entry-policy payload should include lateEntryPolicyAnswer object'
      );
      assert(
        latePolicy.lateEntryPolicyExperimentV2 === null
        || typeof latePolicy.lateEntryPolicyExperimentV2 === 'object',
        'late-entry-policy payload should include lateEntryPolicyExperimentV2 object or null'
      );
      assert(
        latePolicy.lateEntryPolicyExperimentV3 === null
        || typeof latePolicy.lateEntryPolicyExperimentV3 === 'object',
        'late-entry-policy payload should include lateEntryPolicyExperimentV3 object or null'
      );
      assert(
        latePolicy.lateEntryPolicyExperimentV4 === null
        || typeof latePolicy.lateEntryPolicyExperimentV4 === 'object',
        'late-entry-policy payload should include lateEntryPolicyExperimentV4 object or null'
      );
      assert(
        latePolicy.lateEntryPolicyExperimentV5 === null
        || typeof latePolicy.lateEntryPolicyExperimentV5 === 'object',
        'late-entry-policy payload should include lateEntryPolicyExperimentV5 object or null'
      );
      assert(
        latePolicy.lateEntryPolicyCommonDateComparison === null
        || typeof latePolicy.lateEntryPolicyCommonDateComparison === 'object',
        'late-entry-policy payload should include lateEntryPolicyCommonDateComparison object or null'
      );
      if (latePolicy.lateEntryPolicyCommonDateComparison) {
        assert(
          latePolicy.lateEntryPolicyCommonDateComparison.v4MissingDateAudit == null
          || typeof latePolicy.lateEntryPolicyCommonDateComparison.v4MissingDateAudit === 'object',
          'late-entry-policy common-date comparison should include v4MissingDateAudit object'
        );
        assert(
          latePolicy.lateEntryPolicyCommonDateComparison.v1VsV4MissedTradeLedger == null
          || typeof latePolicy.lateEntryPolicyCommonDateComparison.v1VsV4MissedTradeLedger === 'object',
          'late-entry-policy common-date comparison should include v1VsV4MissedTradeLedger object'
        );
      }
      assert(
        typeof latePolicy.lateEntryPolicyAnswer.didBaselineTakeTrade === 'boolean'
        && typeof latePolicy.lateEntryPolicyAnswer.didExtensionPolicyTakeTrade === 'boolean'
        && typeof latePolicy.lateEntryPolicyAnswer.didHard1200ReplayTakeTrade === 'boolean',
        'late-entry-policy answer booleans should be present'
      );
      assert(
        latePolicy.lateEntryPolicyAnswer.v2 == null
        || typeof latePolicy.lateEntryPolicyAnswer.v2 === 'object',
        'late-entry-policy answer should include v2 split answer object when available'
      );
      assert(
        latePolicy.lateEntryPolicyAnswer.v3 == null
        || typeof latePolicy.lateEntryPolicyAnswer.v3 === 'object',
        'late-entry-policy answer should include v3 split answer object when available'
      );
      assert(
        latePolicy.lateEntryPolicyAnswer.v4 == null
        || typeof latePolicy.lateEntryPolicyAnswer.v4 === 'object',
        'late-entry-policy answer should include v4 split answer object when available'
      );
      assert(
        latePolicy.lateEntryPolicyAnswer.v5 == null
        || typeof latePolicy.lateEntryPolicyAnswer.v5 === 'object',
        'late-entry-policy answer should include v5 split answer object when available'
      );
      assert(
        typeof latePolicy.lateEntryPolicyAnswer.isInStrictCommonDateUniverse === 'boolean',
        'late-entry-policy answer should include strict common-date inclusion flag'
      );
      if (latePolicy.lateEntryPolicyAnswer.v2) {
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v2.wouldTrade === 'boolean',
          'late-entry-policy answer v2 should include wouldTrade'
        );
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v2.policyReplayClassification === 'string'
          || latePolicy.lateEntryPolicyAnswer.v2.policyReplayClassification === null,
          'late-entry-policy answer v2 should include policyReplayClassification'
        );
      }
      if (latePolicy.lateEntryPolicyAnswer.v3) {
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v3.wouldTrade === 'boolean',
          'late-entry-policy answer v3 should include wouldTrade'
        );
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v3.policyReplayClassification === 'string'
          || latePolicy.lateEntryPolicyAnswer.v3.policyReplayClassification === null,
          'late-entry-policy answer v3 should include policyReplayClassification'
        );
      }
      if (latePolicy.lateEntryPolicyAnswer.v4) {
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v4.wouldTrade === 'boolean',
          'late-entry-policy answer v4 should include wouldTrade'
        );
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v4.policyReplayClassification === 'string'
          || latePolicy.lateEntryPolicyAnswer.v4.policyReplayClassification === null,
          'late-entry-policy answer v4 should include policyReplayClassification'
        );
      }
      if (latePolicy.lateEntryPolicyAnswer.v5) {
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v5.wouldTrade === 'boolean',
          'late-entry-policy answer v5 should include wouldTrade'
        );
        assert(
          typeof latePolicy.lateEntryPolicyAnswer.v5.policyReplayClassification === 'string'
          || latePolicy.lateEntryPolicyAnswer.v5.policyReplayClassification === null,
          'late-entry-policy answer v5 should include policyReplayClassification'
        );
      }
      assert(
        typeof latePolicy.lateEntryPolicyAnswer.policyReplayStatusLine === 'string'
        || latePolicy.lateEntryPolicyAnswer.policyReplayStatusLine === null,
        'late-entry-policy answer should include plain-English status line'
      );
    }
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis recommendation outcome tests passed.');
  } catch (err) {
    console.error(`Jarvis recommendation outcome test failed: ${err.message}`);
    process.exit(1);
  }
})();
