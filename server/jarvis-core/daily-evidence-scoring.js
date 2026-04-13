'use strict';

const {
  evaluateRecommendationOutcomeDay,
  listRecommendationContexts,
  ensureRecommendationOutcomeSchema,
  auditAndSuppressInvalidLiveContexts,
} = require('./recommendation-outcome');
const {
  ORIGINAL_PLAN_SPEC,
  DEFAULT_VARIANT_SPECS,
  runPlanBacktest,
} = require('./strategy-layers');
const {
  ensureDataFoundationTables,
  normalizeDate,
  toText,
  upsertScoredTradeOutcome,
} = require('./data-foundation-storage');
const {
  LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM,
  LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM,
  buildPreferredOwnerOperatorSnapshot,
  buildPreferredOwnerMonitorSummary,
} = require('./preferred-owner-monitor');
const {
  NEXT_NATURAL_DAY_READINESS_RESULT_ENUM,
  runNextNaturalDayReadinessWatchdogMonitor,
} = require('./preferred-owner-next-natural-day-readiness-watchdog');

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeFromSet(value, set, fallback) {
  const key = String(value || '').trim().toLowerCase();
  if (key && set instanceof Set && set.has(key)) return key;
  return fallback;
}

function toUtcMs(isoDate = '') {
  const date = normalizeDate(isoDate);
  if (!date) return null;
  const parts = date.split('-').map((n) => Number(n));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function addDays(isoDate = '', days = 0) {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (Math.round(Number(days || 0)) * 86400000)).toISOString().slice(0, 10);
}

const LIVE_DAY_CONVERSION_REASON_ENUM = Object.freeze([
  'eligible_and_inserted',
  'eligible_and_updated',
  'already_scored',
  'awaiting_outcome_window',
  'missing_market_session_data',
  'missing_context_alignment',
  'missing_trade_window_close',
  'source_type_mismatch',
  'invalid_live_session_mapping',
  'duplicate_live_identity',
  'manual_insert_deferred_to_autonomous_window',
  'autonomous_insert_deferred_to_preferred_owner',
  'other_blocked',
]);

const LIVE_DAY_CONVERSION_REASON_SET = new Set(LIVE_DAY_CONVERSION_REASON_ENUM);

const LIVE_OUTCOME_FINALIZATION_REASON_ENUM = Object.freeze([
  'finalized_and_inserted',
  'finalized_and_updated',
  'already_finalized',
  'awaiting_session_close',
  'awaiting_next_day_window',
  'awaiting_required_market_data',
  'invalid_trading_day_mapping',
  'missing_live_context_alignment',
  'duplicate_finalization_identity',
  'non_trading_day',
  'other_blocked',
]);

const LIVE_OUTCOME_FINALIZATION_REASON_SET = new Set(LIVE_OUTCOME_FINALIZATION_REASON_ENUM);

const TRADING_DAY_CLASSIFICATION_ENUM = Object.freeze([
  'valid_trading_day',
  'non_trading_day',
  'invalid_mapping',
]);

const TRADING_DAY_CLASSIFICATION_SET = new Set(TRADING_DAY_CLASSIFICATION_ENUM);

const LIVE_FINALIZATION_READINESS_STATE_ENUM = Object.freeze([
  'awaiting_session_close',
  'awaiting_outcome_window',
  'awaiting_required_market_data',
  'ready_to_finalize',
  'already_finalized',
  'blocked_invalid_day',
]);

const LIVE_FINALIZATION_READINESS_STATE_SET = new Set(LIVE_FINALIZATION_READINESS_STATE_ENUM);

const LIVE_FINALIZATION_SWEEP_SOURCE_ENUM = Object.freeze([
  'startup_reconciliation',
  'post_close_checkpoint',
  'close_complete_checkpoint',
  'late_data_recovery',
  'next_morning_recovery',
  'manual_api_run',
]);

const LIVE_FINALIZATION_SWEEP_SOURCE_SET = new Set(LIVE_FINALIZATION_SWEEP_SOURCE_ENUM);

const LIVE_CHECKPOINT_STATUS_ENUM = Object.freeze([
  'success_inserted',
  'success_already_finalized',
  'waiting_valid',
  'blocked_invalid_day',
  'failure_missing_context',
  'failure_missing_market_data',
  'failure_scheduler_miss',
  'failure_duplicate_state',
  'failure_unknown',
]);

const LIVE_CHECKPOINT_STATUS_SET = new Set(LIVE_CHECKPOINT_STATUS_ENUM);

const NEXT_NATURAL_DAY_READINESS_RESULT_SET = new Set(
  NEXT_NATURAL_DAY_READINESS_RESULT_ENUM || []
);

const LIVE_CHECKPOINT_REASON_ENUM = Object.freeze([
  'inserted_new_live_outcome',
  'already_finalized_live_outcome',
  'waiting_for_session_close',
  'waiting_for_outcome_window',
  'waiting_for_required_market_data',
  'blocked_non_trading_day',
  'blocked_invalid_day_mapping',
  'missing_live_context',
  'missing_required_market_data',
  'scheduler_checkpoint_miss',
  'duplicate_live_identity_conflict',
  'unknown_checkpoint_state',
]);

const LIVE_CHECKPOINT_REASON_SET = new Set(LIVE_CHECKPOINT_REASON_ENUM);

const LIVE_CHECKPOINT_AWAITING_REASON_ENUM = Object.freeze([
  'awaiting_session_close',
  'awaiting_next_day_window',
  'awaiting_required_market_data',
  'awaiting_post_close_checkpoint_window',
]);

const LIVE_CHECKPOINT_AWAITING_REASON_SET = new Set(LIVE_CHECKPOINT_AWAITING_REASON_ENUM);

const LIVE_CHECKPOINT_FAILURE_REASON_ENUM = Object.freeze([
  'missing_live_context',
  'missing_required_market_data',
  'checkpoint_not_run',
  'finalization_logic_rejected_valid_day',
  'duplicate_live_identity_conflict',
  'unresolved_wait_past_deadline',
  'insert_not_attempted_when_ready',
  'insert_attempt_failed',
  'duplicate_identity_conflict',
  'live_context_missing_when_ready',
  'market_data_incomplete_when_marked_ready',
  'unknown_ready_state_failure',
  'unknown_failure',
]);

const LIVE_CHECKPOINT_FAILURE_REASON_SET = new Set(LIVE_CHECKPOINT_FAILURE_REASON_ENUM);

const CLOSE_COMPLETE_REASON_ENUM = Object.freeze([
  'close_data_complete',
  'awaiting_session_close',
  'awaiting_required_market_data',
  'awaiting_close_bar_completion',
  'invalid_trading_day',
  'non_trading_day',
  'unknown_incomplete_state',
]);

const CLOSE_COMPLETE_REASON_SET = new Set(CLOSE_COMPLETE_REASON_ENUM);

const FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_ENUM = Object.freeze([
  'insert_not_attempted_when_ready',
  'insert_attempt_failed',
  'duplicate_identity_conflict',
  'live_context_missing_when_ready',
  'market_data_incomplete_when_marked_ready',
  'unknown_ready_state_failure',
]);

const FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_SET = new Set(FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_ENUM);

const CHECKPOINT_WINDOW_REASON_ENUM = Object.freeze([
  'within_checkpoint_window',
  'before_checkpoint_window',
  'after_checkpoint_deadline',
  'awaiting_close_complete',
  'awaiting_required_market_data',
  'checkpoint_window_missed',
]);

const CHECKPOINT_WINDOW_REASON_SET = new Set(CHECKPOINT_WINDOW_REASON_ENUM);

const RUNTIME_CHECKPOINT_OUTCOME_ENUM = Object.freeze([
  'success_inserted',
  'success_already_finalized',
  'waiting_valid',
  'blocked_invalid_day',
  'failure_insert_not_attempted',
  'failure_insert_attempt_failed',
  'failure_missing_context',
  'failure_duplicate_identity',
  'failure_missing_market_data',
  'failure_scheduler_miss',
]);

const RUNTIME_CHECKPOINT_OUTCOME_SET = new Set(RUNTIME_CHECKPOINT_OUTCOME_ENUM);

const LIVE_INSERTION_SLA_OUTCOME_ENUM = Object.freeze([
  'insert_not_required_already_finalized',
  'insert_required_waiting_window',
  'insert_required_success_on_time',
  'insert_required_success_late',
  'insert_required_missed',
  'insert_required_failed_attempt',
  'insert_required_blocked_invalid_day',
  'insert_required_missing_context',
  'insert_required_missing_market_data',
]);

const LIVE_INSERTION_SLA_OUTCOME_SET = new Set(LIVE_INSERTION_SLA_OUTCOME_ENUM);

const LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM = Object.freeze([
  'first_autonomous_insert_of_day',
  'already_inserted_before_this_cycle',
  'already_inserted_by_manual_run',
  'already_inserted_by_prior_autonomous_run',
  'target_day_not_inserted_yet',
  'insert_not_required_invalid_day',
  'insert_not_required_missing_context',
  'insert_not_required_missing_market_data',
]);

const LIVE_INSERTION_OWNERSHIP_OUTCOME_SET = new Set(LIVE_INSERTION_OWNERSHIP_OUTCOME_ENUM);

const LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM = Object.freeze([
  'first_autonomous_insert_by_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_reconciliation',
  'first_autonomous_insert_by_recovery_path',
  'first_manual_insert_of_day',
  'target_day_not_inserted_yet',
  'insert_not_required_invalid_day',
  'insert_not_required_missing_context',
  'insert_not_required_missing_market_data',
  'ownership_source_unknown',
]);

const LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET = new Set(
  LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_ENUM
);

const LIVE_INSERTION_OWNERSHIP_PRECEDENCE = Object.freeze([
  'first_autonomous_insert_of_day',
  'already_inserted_by_manual_run',
  'already_inserted_by_prior_autonomous_run',
  'already_inserted_before_this_cycle',
  'target_day_not_inserted_yet',
  'insert_not_required_invalid_day',
  'insert_not_required_missing_context',
  'insert_not_required_missing_market_data',
]);

const LIVE_INSERTION_OWNERSHIP_PRECEDENCE_MAP = LIVE_INSERTION_OWNERSHIP_PRECEDENCE.reduce((acc, key, idx) => {
  acc[key] = idx;
  return acc;
}, Object.create(null));

const LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE = Object.freeze([
  'first_autonomous_insert_by_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_close_complete_checkpoint',
  'first_autonomous_insert_by_startup_reconciliation',
  'first_autonomous_insert_by_recovery_path',
  'first_manual_insert_of_day',
  'target_day_not_inserted_yet',
  'insert_not_required_missing_context',
  'insert_not_required_missing_market_data',
  'insert_not_required_invalid_day',
  'ownership_source_unknown',
]);

const LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE_MAP = (
  LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE.reduce((acc, key, idx) => {
    acc[key] = idx;
    return acc;
  }, Object.create(null))
);

const LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM = Object.freeze([
  'target_day',
  'broader_cycle',
]);

const LIVE_INSERTION_OWNERSHIP_SCOPE_SET = new Set(LIVE_INSERTION_OWNERSHIP_SCOPE_ENUM);

const LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM = Object.freeze([
  'no_mismatch',
  'target_day_scope_mismatch',
  'scope_broader_cycle',
  'target_day_zero_actual_claims_inserted',
  'target_day_actual_present_but_not_owned',
  'insert_delta_identity_mismatch',
  'first_right_disagrees_with_ownership',
  'unknown_mismatch',
]);

const LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_SET = new Set(LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_ENUM);

const LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM = Object.freeze([
  'proof_waiting_for_close',
  'proof_waiting_for_market_data',
  'proof_waiting_for_context',
  'proof_eligible_not_attempted_bug',
  'proof_attempted_success',
  'proof_attempted_failure',
  'proof_blocked_existing_row',
  'proof_blocked_invalid_day',
  'proof_blocked_first_right',
  'proof_scope_mismatch',
]);

const LIVE_AUTONOMOUS_PROOF_OUTCOME_SET = new Set(LIVE_AUTONOMOUS_PROOF_OUTCOME_ENUM);

const LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM = Object.freeze([
  'none',
  'waiting_for_close',
  'waiting_for_market_data',
  'waiting_for_context',
  'eligible_not_attempted_bug',
  'attempted_failure',
  'blocked_existing_row',
  'blocked_invalid_day',
  'blocked_first_right',
  'scope_mismatch',
  'unknown_failure',
]);

const LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_SET = new Set(LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_ENUM);

const LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM = Object.freeze([
  'none',
  'waiting_for_close',
  'waiting_for_market_data',
  'waiting_for_context',
  'blocked_existing_row',
  'blocked_invalid_day',
  'blocked_first_right',
  'scope_mismatch',
  'unknown_blocked_state',
]);

const LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_SET = new Set(LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_ENUM);

const LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM = Object.freeze([
  'attempt_insert',
  'wait_for_close_complete',
  'wait_for_market_data',
  'wait_for_context',
  'wait_for_first_right_window',
  'no_insert_required_existing_row',
  'no_insert_required_invalid_day',
  'reconcile_scope',
  'investigate_unknown',
]);

const LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_SET = new Set(LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_ENUM);

const LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM = Object.freeze([
  'attempt_not_required',
  'attempt_waiting_for_close',
  'attempt_waiting_for_market_data',
  'attempt_waiting_for_context',
  'attempt_blocked_existing_row',
  'attempt_executed_success',
  'attempt_executed_failure',
  'attempt_skipped_bug',
]);

const LIVE_AUTONOMOUS_ATTEMPT_RESULT_SET = new Set(LIVE_AUTONOMOUS_ATTEMPT_RESULT_ENUM);

const LIVE_INSERTION_OWNERSHIP_INSERTED_OUTCOMES = new Set([
  'first_autonomous_insert_of_day',
  'already_inserted_before_this_cycle',
  'already_inserted_by_manual_run',
  'already_inserted_by_prior_autonomous_run',
]);

const LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM = Object.freeze([
  'autonomous_first_right_reserved',
  'manual_insert_deferred_to_autonomous_window',
  'manual_insert_allowed_after_autonomous_window',
  'manual_insert_preempted_autonomous_window',
]);

const LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_SET = new Set(LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_ENUM);

const LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM = Object.freeze([
  'autonomous_window_not_open',
  'autonomous_window_open',
  'autonomous_window_expired',
]);

const LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_SET = new Set(LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_ENUM);

const LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM = Object.freeze([
  'none',
  'preferred_owner_not_yet_eligible',
  'startup_owner_preempted_before_close_complete',
  'manual_owner_preempted',
  'existing_row_before_preferred_owner',
  'preferred_owner_attempt_failed',
  'preferred_owner_not_run',
  'unknown_owner_precedence_failure',
]);

const LIVE_PREFERRED_OWNER_FAILURE_REASON_SET = new Set(LIVE_PREFERRED_OWNER_FAILURE_REASON_ENUM);

const LIVE_PREFERRED_OWNER_RESERVATION_STATE_ENUM = Object.freeze([
  'reservation_not_applicable',
  'reservation_waiting_for_preferred_owner',
  'reservation_preferred_owner_executing',
  'reservation_released_after_preferred_owner_win',
  'reservation_released_after_preferred_owner_loss',
  'reservation_expired_without_preferred_owner',
  'reservation_bypassed_bug',
]);

const LIVE_PREFERRED_OWNER_RESERVATION_STATE_SET = new Set(LIVE_PREFERRED_OWNER_RESERVATION_STATE_ENUM);

const LIVE_PREFERRED_OWNER_RESERVATION_BLOCK_REASON_ENUM = Object.freeze([
  'none',
  'preferred_owner_not_run_yet',
  'preferred_owner_not_yet_eligible',
  'waiting_for_close_complete',
  'waiting_for_required_market_data',
  'waiting_for_live_context',
  'preferred_owner_window_still_open',
  'reservation_should_have_blocked_but_did_not',
]);

const LIVE_PREFERRED_OWNER_RESERVATION_BLOCK_REASON_SET = new Set(
  LIVE_PREFERRED_OWNER_RESERVATION_BLOCK_REASON_ENUM
);

const LIVE_PREFERRED_OWNER_KPI_MISMATCH_REASON_ENUM = Object.freeze([
  'none',
  'proof_rows_unavailable',
  'preferred_owner_won_today_mismatch',
  'preferred_owner_missed_today_mismatch',
  'rolling5d_win_rate_mismatch',
  'consecutive_win_streak_mismatch',
  'consecutive_miss_streak_mismatch',
]);

const LIVE_PREFERRED_OWNER_KPI_MISMATCH_REASON_SET = new Set(LIVE_PREFERRED_OWNER_KPI_MISMATCH_REASON_ENUM);

const DAILY_SCORING_RUN_ORIGIN_ENUM = Object.freeze([
  'natural',
  'manual',
]);

const DAILY_SCORING_RUN_ORIGIN_SET = new Set(DAILY_SCORING_RUN_ORIGIN_ENUM);

const PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM = Object.freeze([
  'pass',
  'fail',
]);

const PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_SET = new Set(
  PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_ENUM
);

const PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM = Object.freeze([
  'none',
  'checkpoint_not_resolved',
  'preferred_owner_not_winner',
  'ownership_source_specific_mismatch',
  'natural_win_row_missing',
  'natural_win_row_duplicate',
  'fallback_preemption_detected',
  'proof_row_missing',
  'kpi_table_mismatch',
  'target_day_mismatch',
  'unknown_failure',
]);

const PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_SET = new Set(
  PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_ENUM
);

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

const CHECKPOINT_WINDOW_OPEN_TIME_ET = '16:05';
const CHECKPOINT_WINDOW_DEADLINE_TIME_ET = '09:45';

function normalizeLiveReason(reason) {
  const r = toText(reason || '').trim().toLowerCase();
  return LIVE_DAY_CONVERSION_REASON_SET.has(r) ? r : 'other_blocked';
}

function normalizeDailyScoringRunOrigin(label) {
  const v = toText(label || '').trim().toLowerCase();
  return DAILY_SCORING_RUN_ORIGIN_SET.has(v) ? v : 'manual';
}

function normalizePreferredOwnerPostCloseProofStatus(label) {
  const v = toText(label || '').trim().toLowerCase();
  return PREFERRED_OWNER_POST_CLOSE_PROOF_STATUS_SET.has(v) ? v : 'fail';
}

function normalizePreferredOwnerPostCloseProofFailReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  if (!v) return 'none';
  return PREFERRED_OWNER_POST_CLOSE_PROOF_FAIL_REASON_SET.has(v)
    ? v
    : 'unknown_failure';
}

function normalizePreferredOwnerNaturalDrillWatcherOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_SET.has(v)
    ? v
    : 'waiting_for_resolution';
}

function normalizeNextNaturalDayReadinessResult(label) {
  const v = toText(label || '').trim().toLowerCase();
  return NEXT_NATURAL_DAY_READINESS_RESULT_SET.has(v)
    ? v
    : 'next_natural_day_not_in_data_yet';
}

function deriveNextNaturalDayWatchdogPipelineStateFromResult(result) {
  const normalized = normalizeNextNaturalDayReadinessResult(result);
  if (normalized === 'next_natural_day_fully_completed') return 'healthy';
  if (
    normalized === 'next_natural_day_not_in_data_yet'
    || normalized === 'next_natural_day_in_data_not_seen_in_scoring'
    || normalized === 'next_natural_day_seen_but_not_resolved'
  ) {
    return 'waiting';
  }
  return 'broken';
}

function buildNextNaturalDayTerminalStatus(watchdog = null, fallbackBaselineDate = '2026-03-13') {
  const result = normalizeNextNaturalDayReadinessResult(
    watchdog?.result || 'next_natural_day_not_in_data_yet'
  );
  const pipelineState = normalizeFromSet(
    watchdog?.pipelineState || '',
    new Set(['waiting', 'broken', 'healthy']),
    deriveNextNaturalDayWatchdogPipelineStateFromResult(result)
  );
  const stateRow = (
    watchdog?.watchdogStateRow
    && typeof watchdog.watchdogStateRow === 'object'
  )
    ? { ...watchdog.watchdogStateRow }
    : (
      watchdog?.latestWatchdogStateRow
      && typeof watchdog.latestWatchdogStateRow === 'object'
      ? { ...watchdog.latestWatchdogStateRow }
      : null
    );
  const terminalAlertRow = (
    watchdog?.watchdogTerminalAlertRow
    && typeof watchdog.watchdogTerminalAlertRow === 'object'
  )
    ? { ...watchdog.watchdogTerminalAlertRow }
    : (
      watchdog?.latestWatchdogTerminalAlertRow
      && typeof watchdog.latestWatchdogTerminalAlertRow === 'object'
      ? { ...watchdog.latestWatchdogTerminalAlertRow }
      : null
    );
  const waitingForNextDay = (
    watchdog?.waitingForNextDay === true
    || pipelineState === 'waiting'
    || result === 'next_natural_day_not_in_data_yet'
  );
  const actuallyBrokenOnNextDay = (
    watchdog?.actuallyBrokenOnNextDay === true
    || pipelineState === 'broken'
  );
  const nextNaturalDayDiscoveredInPersistedData = (
    watchdog?.nextNaturalDayDiscoveredInPersistedData === true
    || !!normalizeDate(watchdog?.targetTradingDay || watchdog?.nextNaturalTradingDayAfterBaseline || '')
  );
  const terminalAlertEmittedForDiscoveredDay = (
    watchdog?.terminalAlertEmittedForDiscoveredDay === true
    || (nextNaturalDayDiscoveredInPersistedData && watchdog?.alertEmitted === true)
  );

  return {
    baselineDate: (
      normalizeDate(watchdog?.baselineDate || '')
      || normalizeDate(fallbackBaselineDate || '')
      || '2026-03-13'
    ),
    targetTradingDay: (
      normalizeDate(watchdog?.targetTradingDay || '')
      || normalizeDate(watchdog?.nextNaturalTradingDayAfterBaseline || '')
      || null
    ),
    result,
    firstMissingLayer: toText(watchdog?.firstMissingLayer || '') || 'none',
    pipelineState,
    waitingForNextDay,
    actuallyBrokenOnNextDay,
    waitingOrBroken: actuallyBrokenOnNextDay ? 'broken' : 'waiting',
    completed: watchdog?.completed === true,
    terminalAlertAlreadyEmitted: watchdog?.alertEmitted === true,
    terminalAlertPersistedThisRun: watchdog?.alertPersistedThisRun === true,
    nextNaturalDayDiscoveredInPersistedData,
    terminalAlertEmittedForDiscoveredDay,
    latestCheckedAt: stateRow?.latestCheckedAt || null,
    completedAt: stateRow?.completedAt || null,
    stateRow,
    terminalAlertRow,
    rowsUsed: {
      watchdogStateRow: stateRow,
      watchdogTerminalAlertRow: terminalAlertRow,
    },
    advisoryOnly: true,
  };
}

function inferDailyScoringRunOrigin(input = {}) {
  const explicit = normalizeDailyScoringRunOrigin(input.runOrigin || '');
  if (input.runOrigin) return explicit;
  if (input.runtimeTriggered === true && input.force !== true) return 'natural';
  if (input.force === true) return 'manual';
  return 'manual';
}

function normalizeFinalizationReason(reason) {
  const r = toText(reason || '').trim().toLowerCase();
  return LIVE_OUTCOME_FINALIZATION_REASON_SET.has(r) ? r : 'other_blocked';
}

function normalizeTradingDayClassification(label) {
  const v = toText(label || '').trim().toLowerCase();
  return TRADING_DAY_CLASSIFICATION_SET.has(v) ? v : 'invalid_mapping';
}

function normalizeFinalizationReadinessState(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_FINALIZATION_READINESS_STATE_SET.has(v) ? v : 'blocked_invalid_day';
}

function normalizeFinalizationSweepSource(label) {
  const v = toText(label || '').trim().toLowerCase();
  if (v === 'post_close_same_day') return 'post_close_checkpoint';
  return LIVE_FINALIZATION_SWEEP_SOURCE_SET.has(v) ? v : 'manual_api_run';
}

function deriveFinalizationSweepSource(mode = '', finalizationOnly = false) {
  const m = toText(mode || '').trim().toLowerCase();
  if (m.includes('startup_close_complete')) return 'close_complete_checkpoint';
  if (m.includes('close_complete')) return 'close_complete_checkpoint';
  if (m.includes('startup')) return 'startup_reconciliation';
  if (m.includes('late_data')) return 'late_data_recovery';
  if (m.includes('morning') || m.includes('next_morning')) return 'next_morning_recovery';
  if (m.includes('manual') || m.includes('api') || m.includes('integration')) return 'manual_api_run';
  if (m.includes('post_close') || m.includes('close_window') || m.includes('checkpoint')) return 'post_close_checkpoint';
  if (finalizationOnly) return 'post_close_checkpoint';
  return 'manual_api_run';
}

function normalizeCloseCompleteReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return CLOSE_COMPLETE_REASON_SET.has(v) ? v : 'unknown_incomplete_state';
}

function normalizeFirstEligibleCycleFailureReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return FIRST_ELIGIBLE_CYCLE_FAILURE_REASON_SET.has(v) ? v : null;
}

function normalizeCheckpointWindowReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return CHECKPOINT_WINDOW_REASON_SET.has(v) ? v : 'checkpoint_window_missed';
}

function normalizeRuntimeCheckpointOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return RUNTIME_CHECKPOINT_OUTCOME_SET.has(v) ? v : 'failure_insert_attempt_failed';
}

function normalizeLiveInsertionSlaOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_INSERTION_SLA_OUTCOME_SET.has(v) ? v : 'insert_required_failed_attempt';
}

function normalizeLiveInsertionOwnershipOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_INSERTION_OWNERSHIP_OUTCOME_SET.has(v) ? v : 'already_inserted_before_this_cycle';
}

function normalizeLiveInsertionOwnershipScope(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_INSERTION_OWNERSHIP_SCOPE_SET.has(v) ? v : 'target_day';
}

function normalizeLiveInsertionOwnershipSourceSpecificOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_OUTCOME_SET.has(v)
    ? v
    : 'ownership_source_unknown';
}

function normalizeLiveTargetDayOwnershipMismatchReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_TARGET_DAY_OWNERSHIP_MISMATCH_REASON_SET.has(v) ? v : 'unknown_mismatch';
}

function normalizeLiveAutonomousProofOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_PROOF_OUTCOME_SET.has(v) ? v : 'proof_attempted_failure';
}

function normalizeLiveAutonomousProofFailureReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_PROOF_FAILURE_REASON_SET.has(v) ? v : 'unknown_failure';
}

function normalizeLiveAutonomousInsertBlockReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_INSERT_BLOCK_REASON_SET.has(v) ? v : 'unknown_blocked_state';
}

function normalizeLiveAutonomousInsertNextTransition(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_INSERT_NEXT_TRANSITION_SET.has(v) ? v : 'investigate_unknown';
}

function normalizeLiveAutonomousAttemptResult(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_ATTEMPT_RESULT_SET.has(v) ? v : 'attempt_not_required';
}

function normalizeLiveAutonomousFirstRightOutcome(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_FIRST_RIGHT_OUTCOME_SET.has(v)
    ? v
    : 'manual_insert_allowed_after_autonomous_window';
}

function normalizeLiveAutonomousFirstRightWindowState(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_AUTONOMOUS_FIRST_RIGHT_WINDOW_STATE_SET.has(v)
    ? v
    : 'autonomous_window_not_open';
}

function normalizeLivePreferredOwnerFailureReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  if (!v) return 'none';
  return LIVE_PREFERRED_OWNER_FAILURE_REASON_SET.has(v)
    ? v
    : 'unknown_owner_precedence_failure';
}

function normalizeLivePreferredOwnerReservationState(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_PREFERRED_OWNER_RESERVATION_STATE_SET.has(v)
    ? v
    : 'reservation_not_applicable';
}

function normalizeLivePreferredOwnerReservationBlockReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  if (!v) return 'none';
  return LIVE_PREFERRED_OWNER_RESERVATION_BLOCK_REASON_SET.has(v)
    ? v
    : 'preferred_owner_not_run_yet';
}

function normalizeLivePreferredOwnerKpiMismatchReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  if (!v) return 'none';
  return LIVE_PREFERRED_OWNER_KPI_MISMATCH_REASON_SET.has(v)
    ? v
    : 'proof_rows_unavailable';
}

function resolveMostPreciseOwnershipOutcome(candidates = []) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((value) => normalizeLiveInsertionOwnershipOutcome(value))
    .filter((value) => !!value);
  if (!normalized.length) return 'already_inserted_before_this_cycle';
  let winner = normalized[0];
  let bestScore = Number(LIVE_INSERTION_OWNERSHIP_PRECEDENCE_MAP[winner]);
  if (!Number.isFinite(bestScore)) bestScore = Number.MAX_SAFE_INTEGER;
  for (const value of normalized.slice(1)) {
    let score = Number(LIVE_INSERTION_OWNERSHIP_PRECEDENCE_MAP[value]);
    if (!Number.isFinite(score)) score = Number.MAX_SAFE_INTEGER;
    if (score < bestScore) {
      winner = value;
      bestScore = score;
    }
  }
  return winner;
}

function resolveMostPreciseOwnershipSourceSpecificOutcome(candidates = []) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((value) => normalizeLiveInsertionOwnershipSourceSpecificOutcome(value))
    .filter((value) => !!value);
  if (!normalized.length) return 'ownership_source_unknown';
  let winner = normalized[0];
  let bestScore = Number(LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE_MAP[winner]);
  if (!Number.isFinite(bestScore)) bestScore = Number.MAX_SAFE_INTEGER;
  for (const value of normalized.slice(1)) {
    let score = Number(LIVE_INSERTION_OWNERSHIP_SOURCE_SPECIFIC_PRECEDENCE_MAP[value]);
    if (!Number.isFinite(score)) score = Number.MAX_SAFE_INTEGER;
    if (score < bestScore) {
      winner = value;
      bestScore = score;
    }
  }
  return winner;
}

function isCloseCompleteOwnershipSourceSpecificOutcome(label = '') {
  const normalized = normalizeLiveInsertionOwnershipSourceSpecificOutcome(label);
  return (
    normalized === 'first_autonomous_insert_by_close_complete_checkpoint'
    || normalized === 'first_autonomous_insert_by_startup_close_complete_checkpoint'
  );
}

const AUTONOMOUS_OWNER_SOURCE_PRIORITY_MAP = Object.freeze({
  close_complete_checkpoint: 1,
  post_close_checkpoint: 2,
  startup_reconciliation: 3,
  late_data_recovery: 4,
  next_morning_recovery: 4,
  manual_api_run: 99,
});

function getAutonomousOwnerSourcePriority(source = '') {
  const normalized = normalizeFinalizationSweepSource(source);
  const score = Number(AUTONOMOUS_OWNER_SOURCE_PRIORITY_MAP[normalized]);
  return Number.isFinite(score) ? score : 999;
}

function shouldDeferToPreferredAutonomousOwner(currentSource = '', preferredSource = '') {
  const current = normalizeFinalizationSweepSource(currentSource);
  const preferred = normalizeFinalizationSweepSource(preferredSource || 'close_complete_checkpoint');
  if (!current || !preferred || current === preferred) return false;
  if (current === 'manual_api_run') return false;
  return getAutonomousOwnerSourcePriority(current) > getAutonomousOwnerSourcePriority(preferred);
}

function isStartupFallbackSource(source = '', mode = '') {
  const normalizedSource = normalizeFinalizationSweepSource(source || '');
  const normalizedMode = toText(mode || '').trim().toLowerCase();
  if (normalizedSource === 'startup_reconciliation') return true;
  if (!normalizedMode.includes('startup')) return false;
  if (normalizedMode.includes('close_complete')) return false;
  return true;
}

function classifyOwnershipSourceSpecificOutcome(input = {}) {
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  const tradingDayClassification = normalizeTradingDayClassification(input.tradingDayClassification || 'invalid_mapping');
  const firstInsertedBySource = normalizeFinalizationSweepSource(input.firstInsertedBySource || '');
  const firstInsertedAutonomous = input.firstInsertedAutonomous === true;
  const firstRunMode = toText(input.firstRunMode || '').trim().toLowerCase();
  const ownershipOutcome = normalizeLiveInsertionOwnershipOutcome(input.ownershipOutcome || '');

  if (!targetTradingDay || tradingDayClassification !== 'valid_trading_day') {
    return 'insert_not_required_invalid_day';
  }
  if (ownershipOutcome === 'insert_not_required_missing_context') {
    return 'insert_not_required_missing_context';
  }
  if (ownershipOutcome === 'insert_not_required_missing_market_data') {
    return 'insert_not_required_missing_market_data';
  }
  if (ownershipOutcome === 'target_day_not_inserted_yet' || !firstInsertedBySource) {
    return 'target_day_not_inserted_yet';
  }
  if (firstInsertedAutonomous !== true || firstInsertedBySource === 'manual_api_run') {
    return 'first_manual_insert_of_day';
  }
  if (firstInsertedBySource === 'close_complete_checkpoint') {
    if (firstRunMode.includes('startup_close_complete')) {
      return 'first_autonomous_insert_by_startup_close_complete_checkpoint';
    }
    return 'first_autonomous_insert_by_close_complete_checkpoint';
  }
  if (firstInsertedBySource === 'startup_reconciliation') {
    return 'first_autonomous_insert_by_startup_reconciliation';
  }
  if (
    firstInsertedBySource === 'post_close_checkpoint'
    || firstInsertedBySource === 'late_data_recovery'
    || firstInsertedBySource === 'next_morning_recovery'
  ) {
    return 'first_autonomous_insert_by_recovery_path';
  }
  return 'ownership_source_unknown';
}

function normalizeCheckpointStatus(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_CHECKPOINT_STATUS_SET.has(v) ? v : 'failure_unknown';
}

function normalizeCheckpointReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_CHECKPOINT_REASON_SET.has(v) ? v : 'unknown_checkpoint_state';
}

function normalizeCheckpointAwaitingReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_CHECKPOINT_AWAITING_REASON_SET.has(v) ? v : null;
}

function normalizeCheckpointFailureReason(label) {
  const v = toText(label || '').trim().toLowerCase();
  return LIVE_CHECKPOINT_FAILURE_REASON_SET.has(v) ? v : null;
}

function safeJsonParseObject(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseCandleMinute(candle = {}) {
  const rawTime = String(candle?.time || candle?.timestamp || '').trim();
  if (!rawTime) return null;
  let hh = NaN;
  let mm = NaN;
  if (/^\d{2}:\d{2}/.test(rawTime)) {
    hh = Number(rawTime.slice(0, 2));
    mm = Number(rawTime.slice(3, 5));
  } else {
    const part = rawTime.includes('T')
      ? rawTime.split('T')[1] || ''
      : (rawTime.includes(' ') ? rawTime.split(' ')[1] || '' : rawTime);
    if (/^\d{2}:\d{2}/.test(part)) {
      hh = Number(part.slice(0, 2));
      mm = Number(part.slice(3, 5));
    }
  }
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return (hh * 60) + mm;
}

function hasTradeWindowClose(sessionCandles = []) {
  if (!Array.isArray(sessionCandles) || sessionCandles.length === 0) return false;
  for (const candle of sessionCandles) {
    const minute = parseCandleMinute(candle);
    if (Number.isFinite(minute) && minute >= ((15 * 60) + 55)) return true;
  }
  return false;
}

function isWeekendDate(isoDate = '') {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return false;
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

function isoFromUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function observedUsHolidayDate(year, month, day) {
  const ms = Date.UTC(year, month - 1, day);
  const dow = new Date(ms).getUTCDay();
  if (dow === 6) return new Date(ms - 86400000).toISOString().slice(0, 10);
  if (dow === 0) return new Date(ms + 86400000).toISOString().slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = first.getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + ((nth - 1) * 7);
  return isoFromUtc(year, month, day);
}

function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset)).toISOString().slice(0, 10);
}

function easterSundayDate(year) {
  // Meeus/Jones/Butcher Gregorian algorithm.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + (2 * e) + (2 * i) - h - k) % 7;
  const m = Math.floor((a + (11 * h) + (22 * l)) / 451);
  const month = Math.floor((h + l - (7 * m) + 114) / 31);
  const day = ((h + l - (7 * m) + 114) % 31) + 1;
  return isoFromUtc(year, month, day);
}

const US_MARKET_HOLIDAY_CACHE = new Map();

function buildUsMarketHolidaySet(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return new Set();
  if (US_MARKET_HOLIDAY_CACHE.has(y)) return US_MARKET_HOLIDAY_CACHE.get(y);
  const easter = easterSundayDate(y);
  const easterMs = toUtcMs(easter);
  const goodFriday = Number.isFinite(easterMs)
    ? new Date(easterMs - (2 * 86400000)).toISOString().slice(0, 10)
    : null;
  const holidays = new Set([
    observedUsHolidayDate(y, 1, 1), // New Year's Day (observed)
    nthWeekdayOfMonth(y, 1, 1, 3), // MLK Day
    nthWeekdayOfMonth(y, 2, 1, 3), // Presidents Day
    goodFriday, // Good Friday
    lastWeekdayOfMonth(y, 5, 1), // Memorial Day
    observedUsHolidayDate(y, 6, 19), // Juneteenth (observed)
    observedUsHolidayDate(y, 7, 4), // Independence Day (observed)
    nthWeekdayOfMonth(y, 9, 1, 1), // Labor Day
    nthWeekdayOfMonth(y, 11, 4, 4), // Thanksgiving
    observedUsHolidayDate(y, 12, 25), // Christmas (observed)
  ].filter(Boolean));
  US_MARKET_HOLIDAY_CACHE.set(y, holidays);
  return holidays;
}

function isUsMarketHoliday(isoDate = '') {
  const date = normalizeDate(isoDate);
  if (!date) return false;
  const year = Number(date.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  const set = buildUsMarketHolidaySet(year);
  return set.has(date);
}

function classifyTradingDay(input = {}) {
  const date = normalizeDate(input.date || '');
  const sessionForDate = Array.isArray(input.sessionForDate) ? input.sessionForDate : [];
  if (!date) {
    return {
      classification: 'invalid_mapping',
      classificationReason: 'invalid_or_missing_date',
    };
  }
  const weekend = isWeekendDate(date);
  const holiday = isUsMarketHoliday(date);
  if (weekend || holiday) {
    if (sessionForDate.length > 0) {
      return {
        classification: 'invalid_mapping',
        classificationReason: weekend ? 'weekend_has_session_data' : 'holiday_has_session_data',
      };
    }
    return {
      classification: 'non_trading_day',
      classificationReason: weekend ? 'weekend' : 'us_market_holiday',
    };
  }
  return {
    classification: 'valid_trading_day',
    classificationReason: sessionForDate.length > 0 ? 'weekday_with_session_data' : 'weekday_without_session_data',
  };
}

function compareIsoDates(a = '', b = '') {
  const aMs = toUtcMs(a);
  const bMs = toUtcMs(b);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return 0;
  if (aMs === bMs) return 0;
  return aMs > bMs ? 1 : -1;
}

function isSameDate(a = '', b = '') {
  return normalizeDate(a) && normalizeDate(a) === normalizeDate(b);
}

function normalizeTimeOfDay(timeText = '', fallback = '00:00') {
  const raw = toText(timeText || '').trim();
  const match = raw.match(/^(\d{2}):(\d{2})/);
  if (!match) return fallback;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return fallback;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function toMinuteOfDay(timeText = '') {
  const normalized = normalizeTimeOfDay(timeText, '00:00');
  const hh = Number(normalized.slice(0, 2));
  const mm = Number(normalized.slice(3, 5));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  return (hh * 60) + mm;
}

function compareEtDateTime(aDate = '', aTime = '00:00', bDate = '', bTime = '00:00') {
  const dateCmp = compareIsoDates(aDate, bDate);
  if (dateCmp !== 0) return dateCmp;
  const minuteCmp = toMinuteOfDay(aTime) - toMinuteOfDay(bTime);
  if (minuteCmp === 0) return 0;
  return minuteCmp > 0 ? 1 : -1;
}

function findNextCalendarValidTradingDay(startDate = '', maxLookaheadDays = 7) {
  const normalizedStart = normalizeDate(startDate);
  if (!normalizedStart) return null;
  const maxLookahead = clampInt(maxLookaheadDays, 1, 14, 7);
  for (let i = 1; i <= maxLookahead; i += 1) {
    const candidate = addDays(normalizedStart, i);
    if (!candidate) continue;
    const cls = classifyTradingDay({
      date: candidate,
      sessionForDate: [],
    });
    if (normalizeTradingDayClassification(cls.classification) === 'valid_trading_day') {
      return candidate;
    }
  }
  return null;
}

function buildEtDateTimeLabel(isoDate = '', time = '00:00') {
  const date = normalizeDate(isoDate);
  const tod = normalizeTimeOfDay(time, '00:00');
  if (!date) return null;
  return `${date} ${tod} America/New_York`;
}

function parseEtDateTimeLabel(label = '') {
  const txt = toText(label || '').trim();
  const match = txt.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (!match) return null;
  const date = normalizeDate(match[1]);
  const time = normalizeTimeOfDay(match[2], '00:00');
  if (!date) return null;
  return { date, time };
}

function diffEtDateTimeLabelMinutes(laterLabel = '', earlierLabel = '') {
  const later = parseEtDateTimeLabel(laterLabel);
  const earlier = parseEtDateTimeLabel(earlierLabel);
  if (!later || !earlier) return null;
  const laterMs = toUtcMs(later.date);
  const earlierMs = toUtcMs(earlier.date);
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return null;
  const dayDiffMinutes = Math.round((laterMs - earlierMs) / 60000);
  const minuteDiff = toMinuteOfDay(later.time) - toMinuteOfDay(earlier.time);
  return Number(dayDiffMinutes + minuteDiff);
}

function mapCheckpointToRuntimeOutcome(checkpoint = {}) {
  const status = normalizeCheckpointStatus(checkpoint?.checkpointStatus || '');
  const firstEligibleCycleFailureReason = normalizeFirstEligibleCycleFailureReason(
    checkpoint?.firstEligibleCycleFailureReason
  );
  if (status === 'success_inserted') return 'success_inserted';
  if (status === 'success_already_finalized') return 'success_already_finalized';
  if (status === 'waiting_valid') return 'waiting_valid';
  if (status === 'blocked_invalid_day') return 'blocked_invalid_day';
  if (status === 'failure_missing_context') return 'failure_missing_context';
  if (status === 'failure_duplicate_state') return 'failure_duplicate_identity';
  if (status === 'failure_missing_market_data') return 'failure_missing_market_data';
  if (status === 'failure_scheduler_miss') return 'failure_scheduler_miss';
  if (firstEligibleCycleFailureReason === 'insert_not_attempted_when_ready') {
    return 'failure_insert_not_attempted';
  }
  return 'failure_insert_attempt_failed';
}

function readAutonomousCheckpointResolution(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!db || typeof db.prepare !== 'function' || !target) {
    return {
      hasAutonomousSuccess: false,
      latestAutonomousOutcome: null,
      latestAutonomousSweepSource: null,
      latestAutonomousTriggeredAt: null,
    };
  }
  try {
    const row = db.prepare(`
      SELECT
        json_extract(details_json, '$.liveCheckpoint.checkpointStatus') AS checkpoint_status,
        json_extract(details_json, '$.liveCheckpoint.sweepSource') AS sweep_source,
        json_extract(details_json, '$.liveCheckpoint.checkpointCompletedAt') AS checkpoint_completed_at,
        created_at
      FROM jarvis_daily_scoring_runs
      WHERE json_extract(details_json, '$.liveCheckpoint.targetTradingDay') = ?
        AND COALESCE(json_extract(details_json, '$.liveCheckpoint.sweepSource'), '') != 'manual_api_run'
      ORDER BY id DESC
      LIMIT 1
    `).get(target);
    if (!row) {
      return {
        hasAutonomousSuccess: false,
        latestAutonomousOutcome: null,
        latestAutonomousSweepSource: null,
        latestAutonomousTriggeredAt: null,
      };
    }
    const latestAutonomousOutcome = mapCheckpointToRuntimeOutcome({
      checkpointStatus: row.checkpoint_status,
    });
    const hasAutonomousSuccess = (
      latestAutonomousOutcome === 'success_inserted'
      || latestAutonomousOutcome === 'success_already_finalized'
    );
    return {
      hasAutonomousSuccess,
      latestAutonomousOutcome,
      latestAutonomousSweepSource: normalizeFinalizationSweepSource(row.sweep_source || ''),
      latestAutonomousTriggeredAt: toText(row.checkpoint_completed_at || row.created_at || '') || null,
    };
  } catch {
    return {
      hasAutonomousSuccess: false,
      latestAutonomousOutcome: null,
      latestAutonomousSweepSource: null,
      latestAutonomousTriggeredAt: null,
    };
  }
}

function findMostRecentCalendarValidTradingDay(startDate = '', maxLookbackDays = 10) {
  const normalizedStart = normalizeDate(startDate);
  if (!normalizedStart) return null;
  const maxLookback = clampInt(maxLookbackDays, 1, 30, 10);
  for (let i = 0; i <= maxLookback; i += 1) {
    const candidate = i === 0 ? normalizedStart : addDays(normalizedStart, -i);
    if (!candidate) continue;
    const cls = classifyTradingDay({
      date: candidate,
      sessionForDate: [],
    });
    if (normalizeTradingDayClassification(cls.classification) === 'valid_trading_day') {
      return candidate;
    }
  }
  return null;
}

function deriveCheckpointTargetTradingDay(nowDate = '', sweepSource = '', overrideTargetDate = '') {
  const normalizedNow = normalizeDate(nowDate);
  const overrideDate = normalizeDate(overrideTargetDate);
  if (overrideDate) return overrideDate;
  if (!normalizedNow) return null;
  const source = normalizeFinalizationSweepSource(sweepSource);
  if (source === 'next_morning_recovery') {
    const previousDate = addDays(normalizedNow, -1);
    return findMostRecentCalendarValidTradingDay(previousDate || normalizedNow, 10)
      || findMostRecentCalendarValidTradingDay(normalizedNow, 10);
  }
  return findMostRecentCalendarValidTradingDay(normalizedNow, 10);
}

function evaluateCloseCompleteContract(input = {}) {
  const date = normalizeDate(input.date || '');
  const nowDate = normalizeDate(input.nowDate || '');
  const sessionForDate = Array.isArray(input.sessionForDate) ? input.sessionForDate : [];
  const contextRow = input.contextRow || {};
  const readiness = evaluateLiveFinalizationReadiness({
    date,
    nowDate,
    contextRow,
    sessionForDate,
  });
  const classification = normalizeTradingDayClassification(readiness.classification || classifyTradingDay({ date, sessionForDate }).classification);
  const classificationReason = toText(readiness.classificationReason || classifyTradingDay({ date, sessionForDate }).classificationReason) || 'unknown';
  const requiredCloseDataPresent = sessionForDate.length > 0;
  const requiredCloseBarsPresent = requiredCloseDataPresent && hasTradeWindowClose(sessionForDate);
  let closeComplete = false;
  let closeCompleteReason = 'unknown_incomplete_state';

  if (!date) {
    closeComplete = false;
    closeCompleteReason = 'unknown_incomplete_state';
  } else if (classification === 'non_trading_day') {
    closeComplete = false;
    closeCompleteReason = 'non_trading_day';
  } else if (classification === 'invalid_mapping') {
    closeComplete = false;
    closeCompleteReason = 'invalid_trading_day';
  } else if (readiness.ready === true) {
    closeComplete = true;
    closeCompleteReason = 'close_data_complete';
  } else {
    const readinessReason = normalizeFinalizationReason(readiness.reason || '');
    if (readinessReason === 'awaiting_session_close') {
      closeComplete = false;
      closeCompleteReason = 'awaiting_session_close';
    } else if (readinessReason === 'awaiting_required_market_data') {
      closeComplete = false;
      closeCompleteReason = requiredCloseDataPresent && !requiredCloseBarsPresent
        ? 'awaiting_close_bar_completion'
        : 'awaiting_required_market_data';
    } else if (readinessReason === 'awaiting_next_day_window') {
      closeComplete = false;
      closeCompleteReason = 'awaiting_session_close';
    } else if (readinessReason === 'invalid_trading_day_mapping') {
      closeComplete = false;
      closeCompleteReason = 'invalid_trading_day';
    } else if (readinessReason === 'non_trading_day') {
      closeComplete = false;
      closeCompleteReason = 'non_trading_day';
    } else {
      closeComplete = false;
      closeCompleteReason = 'unknown_incomplete_state';
    }
  }

  return {
    date,
    readiness,
    classification,
    classificationReason,
    closeComplete: closeComplete === true,
    closeCompleteReason: normalizeCloseCompleteReason(closeCompleteReason),
    requiredCloseDataPresent: requiredCloseDataPresent === true,
    requiredCloseBarsPresent: requiredCloseBarsPresent === true,
  };
}

function readPriorCheckpointMeta(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!db || typeof db.prepare !== 'function' || !target) {
    return null;
  }
  try {
    return db.prepare(`
      SELECT
        json_extract(details_json, '$.liveCheckpoint.closeComplete') AS close_complete,
        json_extract(details_json, '$.liveCheckpoint.firstEligibleCycleAt') AS first_eligible_cycle_at,
        json_extract(details_json, '$.liveCheckpoint.sweepSource') AS sweep_source,
        created_at
      FROM jarvis_daily_scoring_runs
      WHERE json_extract(details_json, '$.liveCheckpoint.targetTradingDay') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function buildCheckpointWindowContract(input = {}) {
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  const nowDate = normalizeDate(input.nowDate || '');
  const nowTime = normalizeTimeOfDay(input.nowTime || '00:00', '00:00');
  const closeCompleteReason = normalizeCloseCompleteReason(input.closeCompleteReason);
  const checkpointStatus = normalizeCheckpointStatus(input.checkpointStatus || '');
  const checkpointReason = normalizeCheckpointReason(input.checkpointReason || '');
  const checkpointExpectedOutcomeCount = Number(input.checkpointExpectedOutcomeCount || 0);
  const checkpointActualOutcomeCount = Number(input.checkpointActualOutcomeCount || 0);

  if (!targetTradingDay || !nowDate) {
    return {
      checkpointWindowOpenedAt: null,
      checkpointDeadlineAt: null,
      checkpointWindowClosedAt: null,
      checkpointWithinAllowedWindow: false,
      checkpointPastDeadline: false,
      checkpointWindowReason: 'awaiting_close_complete',
    };
  }

  const nextValidTradingDay = findNextCalendarValidTradingDay(targetTradingDay, 7)
    || addDays(targetTradingDay, 1)
    || targetTradingDay;
  const checkpointWindowOpenedAt = buildEtDateTimeLabel(targetTradingDay, CHECKPOINT_WINDOW_OPEN_TIME_ET);
  const checkpointDeadlineAt = buildEtDateTimeLabel(nextValidTradingDay, CHECKPOINT_WINDOW_DEADLINE_TIME_ET);
  const checkpointWindowClosedAt = checkpointDeadlineAt;

  const beforeWindowOpen = compareEtDateTime(nowDate, nowTime, targetTradingDay, CHECKPOINT_WINDOW_OPEN_TIME_ET) < 0;
  const pastDeadline = compareEtDateTime(nowDate, nowTime, nextValidTradingDay, CHECKPOINT_WINDOW_DEADLINE_TIME_ET) > 0;
  const withinAllowedWindow = !beforeWindowOpen && !pastDeadline;
  const unresolvedExpectedInsert = checkpointExpectedOutcomeCount > checkpointActualOutcomeCount;

  let checkpointWindowReason = 'within_checkpoint_window';
  if (beforeWindowOpen) {
    checkpointWindowReason = 'before_checkpoint_window';
  } else if (pastDeadline) {
    checkpointWindowReason = 'after_checkpoint_deadline';
  }

  if (closeCompleteReason === 'awaiting_session_close') {
    checkpointWindowReason = 'awaiting_close_complete';
  } else if (
    closeCompleteReason === 'awaiting_required_market_data'
    || closeCompleteReason === 'awaiting_close_bar_completion'
  ) {
    checkpointWindowReason = 'awaiting_required_market_data';
  }

  if (
    pastDeadline
    && (
      checkpointStatus === 'waiting_valid'
      || (checkpointStatus !== 'blocked_invalid_day' && unresolvedExpectedInsert)
      || checkpointReason === 'waiting_for_required_market_data'
      || checkpointReason === 'waiting_for_session_close'
      || checkpointReason === 'waiting_for_outcome_window'
    )
  ) {
    checkpointWindowReason = 'checkpoint_window_missed';
  }

  return {
    checkpointWindowOpenedAt,
    checkpointDeadlineAt,
    checkpointWindowClosedAt,
    checkpointWithinAllowedWindow: withinAllowedWindow === true,
    checkpointPastDeadline: pastDeadline === true,
    checkpointWindowReason: normalizeCheckpointWindowReason(checkpointWindowReason),
  };
}

function buildLiveAutonomousFirstRightContract(input = {}) {
  const db = input.db;
  const nowDate = normalizeDate(input.nowDate || '');
  const nowTime = normalizeTimeOfDay(input.nowTime || '00:00', '00:00');
  const mode = toText(input.mode || '').trim().toLowerCase();
  const sweepSource = normalizeFinalizationSweepSource(input.sweepSource || '');
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const targetTradingDay = deriveCheckpointTargetTradingDay(
    nowDate,
    sweepSource,
    input.targetTradingDay
  );
  const targetKey = normalizeDate(targetTradingDay || '') || null;
  const sessionForTarget = targetKey && Array.isArray(sessions?.[targetKey]) ? sessions[targetKey] : [];
  const classification = normalizeTradingDayClassification(
    classifyTradingDay({ date: targetKey, sessionForDate: sessionForTarget }).classification
  );
  const windowContract = buildCheckpointWindowContract({
    targetTradingDay: targetKey,
    nowDate,
    nowTime,
    closeCompleteReason: input.closeCompleteReason || 'close_data_complete',
    checkpointStatus: 'waiting_valid',
    checkpointReason: 'waiting_for_outcome_window',
    checkpointExpectedOutcomeCount: classification === 'valid_trading_day' ? 1 : 0,
    checkpointActualOutcomeCount: 0,
  });
  const windowState = windowContract.checkpointPastDeadline === true
    ? 'autonomous_window_expired'
    : (windowContract.checkpointWithinAllowedWindow === true
      ? 'autonomous_window_open'
      : 'autonomous_window_not_open');
  const active = (
    classification === 'valid_trading_day'
    && windowState === 'autonomous_window_open'
  );
  const isManualPath = (
    sweepSource === 'manual_api_run'
    || mode.includes('manual')
    || mode.includes('integration')
    || mode.includes('api')
  );
  const finalizationOnly = input.finalizationOnly === true;
  const liveOutcomeRow = readLiveOutcomeRowByIdentity(db, targetKey || '');
  const ownershipRow = readLiveInsertionOwnershipRow(db, targetKey || '');
  const ownershipSource = ownershipRow?.first_run_source
    ? normalizeFinalizationSweepSource(ownershipRow.first_run_source)
    : null;
  const closeCompleteContract = evaluateCloseCompleteContract({
    date: targetKey,
    nowDate,
    contextRow: (db && typeof db.prepare === 'function' && targetKey)
      ? (db.prepare(`
        SELECT id, rec_date, source_type, reconstruction_phase, context_json
        FROM jarvis_recommendation_context_history
        WHERE rec_date = ?
          AND source_type = 'live'
          AND reconstruction_phase = 'live_intraday'
        LIMIT 1
      `).get(targetKey) || {})
      : {},
    sessionForDate: sessionForTarget,
  });
  const wouldPreempt = (
    isManualPath
    && !finalizationOnly
    && active
    && closeCompleteContract.closeComplete === true
    && !liveOutcomeRow
    && classification === 'valid_trading_day'
  );
  const manualDeferred = wouldPreempt;
  let outcome = 'manual_insert_allowed_after_autonomous_window';
  if (manualDeferred) outcome = 'manual_insert_deferred_to_autonomous_window';
  else if (active && liveOutcomeRow && ownershipSource === 'manual_api_run') outcome = 'manual_insert_preempted_autonomous_window';
  else if (active) outcome = 'autonomous_first_right_reserved';

  return {
    liveAutonomousFirstRightTargetTradingDay: targetKey,
    liveAutonomousFirstRightWindowOpenedAt: windowContract.checkpointWindowOpenedAt || null,
    liveAutonomousFirstRightWindowExpiresAt: windowContract.checkpointDeadlineAt || null,
    liveAutonomousFirstRightWindowState: normalizeLiveAutonomousFirstRightWindowState(windowState),
    liveAutonomousFirstRightActive: active === true,
    liveAutonomousFirstRightReservedForSource: 'close_complete_checkpoint',
    liveAutonomousFirstRightOutcome: normalizeLiveAutonomousFirstRightOutcome(outcome),
    liveManualInsertDeferred: manualDeferred === true,
    liveManualInsertDeferredReason: manualDeferred === true
      ? 'manual_insert_deferred_to_autonomous_window'
      : null,
    liveManualInsertWouldHavePreemptedAutonomous: wouldPreempt === true,
    liveOwnershipConsistencyOk: true,
    advisoryOnly: true,
  };
}

function buildLivePreferredOwnerReservation(input = {}) {
  const db = input.db;
  const mode = toText(input.mode || '').trim().toLowerCase();
  const liveAutonomousFirstRight = input.liveAutonomousFirstRight && typeof input.liveAutonomousFirstRight === 'object'
    ? input.liveAutonomousFirstRight
    : {};
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const livePreferredOwnerProof = input.livePreferredOwnerProof && typeof input.livePreferredOwnerProof === 'object'
    ? input.livePreferredOwnerProof
    : {};
  const nowDate = normalizeDate(
    input.nowDate
    || liveCheckpoint.targetTradingDay
    || ''
  ) || null;
  const targetTradingDay = normalizeDate(
    input.targetTradingDay
    || liveAutonomousFirstRight.liveAutonomousFirstRightTargetTradingDay
    || liveCheckpoint.targetTradingDay
    || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || livePreferredOwnerProof.livePreferredOwnerTargetTradingDay
    || ''
  ) || null;
  const expectedSource = normalizeFinalizationSweepSource(
    input.expectedSource
    || liveAutonomousFirstRight.liveAutonomousFirstRightReservedForSource
    || livePreferredOwnerProof.livePreferredOwnerExpectedSource
    || 'close_complete_checkpoint'
  );
  const sweepSource = normalizeFinalizationSweepSource(
    input.sweepSource
    || liveCheckpoint.runtimeCheckpointSource
    || liveCheckpoint.sweepSource
    || deriveFinalizationSweepSource(mode, input.finalizationOnly === true)
  );
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const sessionForTarget = targetTradingDay && Array.isArray(sessions?.[targetTradingDay])
    ? sessions[targetTradingDay]
    : [];
  let contextRow = null;
  if (db && typeof db.prepare === 'function' && targetTradingDay) {
    contextRow = db.prepare(`
      SELECT id, rec_date, source_type, reconstruction_phase, context_json
      FROM jarvis_recommendation_context_history
      WHERE rec_date = ?
        AND source_type = 'live'
        AND reconstruction_phase = 'live_intraday'
      LIMIT 1
    `).get(targetTradingDay) || null;
  }
  const closeCompleteContract = targetTradingDay
    ? evaluateCloseCompleteContract({
      date: targetTradingDay,
      nowDate: nowDate || targetTradingDay,
      contextRow: contextRow || {},
      sessionForDate: sessionForTarget,
    })
    : {
      classification: 'invalid_mapping',
      closeComplete: false,
      requiredCloseDataPresent: false,
      requiredCloseBarsPresent: false,
      closeCompleteReason: 'unknown_incomplete_state',
    };
  const tradingDayClassification = normalizeTradingDayClassification(
    closeCompleteContract.classification || 'invalid_mapping'
  );
  const existingLiveRow = readLiveOutcomeRowByIdentity(db, targetTradingDay || '');
  const ownershipRow = readLiveInsertionOwnershipRow(db, targetTradingDay || '');
  const preferredOwnerProofRow = readLivePreferredOwnerProofRow(db, targetTradingDay || '');
  const firstCreatorSourceRaw = toText(
    preferredOwnerProofRow?.first_creator_source
    || ownershipRow?.first_run_source
    || livePreferredOwnerProof.livePreferredOwnerActualSource
    || ''
  );
  const firstCreatorSource = firstCreatorSourceRaw
    ? normalizeFinalizationSweepSource(firstCreatorSourceRaw)
    : null;
  const firstCreatorAutonomous = (
    Number(preferredOwnerProofRow?.first_creator_autonomous || ownershipRow?.first_inserted_autonomous || 0) === 1
    || String(preferredOwnerProofRow?.first_creator_autonomous || ownershipRow?.first_inserted_autonomous || '').trim().toLowerCase() === 'true'
    || livePreferredOwnerProof.livePreferredOwnerFirstCreatorAutonomous === true
  );
  const preferredOwnerWon = (
    Number(preferredOwnerProofRow?.preferred_owner_won || 0) === 1
    || String(preferredOwnerProofRow?.preferred_owner_won || '').trim().toLowerCase() === 'true'
    || livePreferredOwnerProof.livePreferredOwnerWon === true
    || (firstCreatorSource === expectedSource && firstCreatorAutonomous === true)
  );
  const windowOpenedAt = toText(
    liveAutonomousFirstRight.liveAutonomousFirstRightWindowOpenedAt
    || liveCheckpoint.checkpointWindowOpenedAt
    || ''
  ) || null;
  const windowExpiresAt = toText(
    liveAutonomousFirstRight.liveAutonomousFirstRightWindowExpiresAt
    || liveCheckpoint.checkpointDeadlineAt
    || ''
  ) || null;
  const windowState = normalizeLiveAutonomousFirstRightWindowState(
    liveAutonomousFirstRight.liveAutonomousFirstRightWindowState
    || (liveCheckpoint.checkpointPastDeadline === true
      ? 'autonomous_window_expired'
      : (liveCheckpoint.checkpointWithinAllowedWindow === true
        ? 'autonomous_window_open'
        : 'autonomous_window_not_open'))
  );
  let state = 'reservation_not_applicable';
  let active = false;
  let releasedAt = null;
  if (!targetTradingDay || tradingDayClassification !== 'valid_trading_day') {
    state = 'reservation_not_applicable';
  } else if (firstCreatorSource) {
    if (preferredOwnerWon) {
      state = 'reservation_released_after_preferred_owner_win';
    } else {
      state = 'reservation_released_after_preferred_owner_loss';
    }
    releasedAt = toText(
      preferredOwnerProofRow?.preferred_owner_proof_captured_at
      || preferredOwnerProofRow?.updated_at
      || preferredOwnerProofRow?.first_creation_timestamp
      || ownershipRow?.first_inserted_at
      || livePreferredOwnerProof.livePreferredOwnerProofCapturedAt
      || livePreferredOwnerProof.livePreferredOwnerFirstCreationTimestamp
      || ''
    ) || null;
  } else if (windowState === 'autonomous_window_expired') {
    state = 'reservation_expired_without_preferred_owner';
    releasedAt = windowExpiresAt;
  } else if (sweepSource === expectedSource) {
    state = 'reservation_preferred_owner_executing';
    active = true;
  } else {
    state = 'reservation_waiting_for_preferred_owner';
    active = true;
  }

  const contextPresent = !!contextRow;
  const requiredMarketDataPresent = (
    closeCompleteContract.requiredCloseDataPresent === true
    && closeCompleteContract.requiredCloseBarsPresent === true
  );
  const shouldBlockCurrentSource = (
    active
    && isStartupFallbackSource(sweepSource, mode)
    && sweepSource !== expectedSource
    && !existingLiveRow
  );
  let blockReason = 'none';
  if (active) {
    if (!contextPresent) blockReason = 'waiting_for_live_context';
    else if (closeCompleteContract.closeComplete !== true) blockReason = 'waiting_for_close_complete';
    else if (!requiredMarketDataPresent) blockReason = 'waiting_for_required_market_data';
    else if (shouldBlockCurrentSource) blockReason = 'preferred_owner_window_still_open';
    else if (sweepSource === expectedSource) blockReason = 'preferred_owner_not_run_yet';
    else blockReason = 'preferred_owner_not_yet_eligible';
  }
  const deferredFallbackSource = input.livePreferredOwnerDeferredFallbackSource
    ? normalizeFinalizationSweepSource(input.livePreferredOwnerDeferredFallbackSource)
    : null;
  const deferredFallbackReason = input.livePreferredOwnerDeferredFallbackReason
    ? normalizeLivePreferredOwnerReservationBlockReason(input.livePreferredOwnerDeferredFallbackReason)
    : null;
  const deferredFallbackAt = toText(input.livePreferredOwnerDeferredFallbackAt || '') || null;
  const fallbackInsertedWhileReserved = (
    shouldBlockCurrentSource
    && (
      liveInsertionOwnership.liveInsertionOwnershipCurrentRunCreatedRow === true
      || liveCheckpoint.liveOutcomeInsertedThisCheckpoint === true
    )
  );
  if (fallbackInsertedWhileReserved) {
    state = 'reservation_bypassed_bug';
    active = false;
    blockReason = 'reservation_should_have_blocked_but_did_not';
    releasedAt = toText(liveCheckpoint.checkpointCompletedAt || new Date().toISOString()) || null;
  }
  if (
    (state === 'reservation_released_after_preferred_owner_win'
      || state === 'reservation_released_after_preferred_owner_loss')
    && !releasedAt
  ) {
    releasedAt = toText(liveCheckpoint.checkpointCompletedAt || new Date().toISOString()) || null;
  }
  const blockedSource = shouldBlockCurrentSource
    ? sweepSource
    : (deferredFallbackSource || null);

  return {
    livePreferredOwnerReservationTargetTradingDay: targetTradingDay,
    livePreferredOwnerReservationExpectedSource: expectedSource,
    livePreferredOwnerReservationActive: active === true,
    livePreferredOwnerReservationWindowOpenedAt: windowOpenedAt,
    livePreferredOwnerReservationWindowExpiresAt: windowExpiresAt,
    livePreferredOwnerReservationState: normalizeLivePreferredOwnerReservationState(state),
    livePreferredOwnerReservationBlockedSource: blockedSource,
    livePreferredOwnerReservationBlockReason: normalizeLivePreferredOwnerReservationBlockReason(
      deferredFallbackReason || blockReason
    ),
    livePreferredOwnerReservationReleasedAt: releasedAt,
    livePreferredOwnerDeferredFallbackSource: deferredFallbackSource,
    livePreferredOwnerDeferredFallbackReason: deferredFallbackReason,
    livePreferredOwnerDeferredFallbackAt: deferredFallbackAt,
    livePreferredOwnerReservationShouldBlockCurrentSource: shouldBlockCurrentSource === true,
    advisoryOnly: true,
  };
}

function buildLiveCheckpoint(input = {}) {
  const db = input.db;
  const nowDate = normalizeDate(input.nowDate || '');
  const nowTime = normalizeTimeOfDay(
    input.nowTime
    || input.nowEt?.time
    || input.nowEtTime
    || '00:00',
    '00:00'
  );
  const mode = toText(input.mode || '').trim().toLowerCase() || 'auto';
  const checkpointEvaluatedAt = new Date().toISOString();
  const sweepSource = normalizeFinalizationSweepSource(input.sweepSource || '');
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const targetTradingDay = deriveCheckpointTargetTradingDay(
    nowDate,
    sweepSource,
    input.targetTradingDay
  );
  const sessionForDate = targetTradingDay && Array.isArray(sessions?.[targetTradingDay])
    ? sessions[targetTradingDay]
    : [];
  const classificationRaw = classifyTradingDay({
    date: targetTradingDay,
    sessionForDate,
  });
  const tradingDayClassification = normalizeTradingDayClassification(classificationRaw.classification);
  const tradingDayClassificationReason = toText(classificationRaw.classificationReason || '') || 'unknown';
  const targetKey = normalizeDate(targetTradingDay || '');
  const scoringByDate = input.scoringByDate instanceof Map ? input.scoringByDate : new Map();
  const finalizationByDate = input.finalizationByDate instanceof Map ? input.finalizationByDate : new Map();
  const scoringDecision = targetKey ? (scoringByDate.get(targetKey) || null) : null;
  const finalizationDecision = targetKey ? (finalizationByDate.get(targetKey) || null) : null;
  const finalizationReason = normalizeFinalizationReason(finalizationDecision?.reason || '');
  const finalizationState = normalizeFinalizationReadinessState(
    finalizationDecision?.state || mapFinalizationReasonToReadinessState(finalizationReason || 'other_blocked')
  );

  let liveContextRow = null;
  let suppressionRow = null;
  let outcomeCount = 0;
  if (db && typeof db.prepare === 'function' && targetKey) {
    liveContextRow = db.prepare(`
      SELECT id, rec_date, source_type, reconstruction_phase
      FROM jarvis_recommendation_context_history
      WHERE rec_date = ?
        AND source_type = 'live'
        AND reconstruction_phase = 'live_intraday'
      LIMIT 1
    `).get(targetKey) || null;
    suppressionRow = db.prepare(`
      SELECT id, is_active, suppression_status, reason_code, classification
      FROM jarvis_live_context_suppression
      WHERE rec_date = ?
        AND source_type = 'live'
        AND reconstruction_phase = 'live_intraday'
      LIMIT 1
    `).get(targetKey) || null;
    outcomeCount = Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_scored_trade_outcomes
      WHERE score_date = ?
        AND source_type = 'live'
        AND reconstruction_phase = 'live_intraday'
    `).get(targetKey)?.c || 0);
  }

  const closeCompleteContract = evaluateCloseCompleteContract({
    date: targetKey,
    nowDate,
    contextRow: liveContextRow || {},
    sessionForDate,
  });
  const closeComplete = closeCompleteContract.closeComplete === true;
  const closeCompleteReason = normalizeCloseCompleteReason(closeCompleteContract.closeCompleteReason);
  const requiredCloseDataPresent = closeCompleteContract.requiredCloseDataPresent === true;
  const requiredCloseBarsPresent = closeCompleteContract.requiredCloseBarsPresent === true;
  const closeCheckpointEligible = (
    tradingDayClassification === 'valid_trading_day'
    && closeComplete === true
  );
  const closeCheckpointEligibilityReason = normalizeCloseCompleteReason(
    closeCheckpointEligible ? 'close_data_complete' : closeCompleteReason
  );
  const priorCheckpointMeta = readPriorCheckpointMeta(db, targetKey);
  const priorCloseComplete = (
    Number(priorCheckpointMeta?.close_complete || 0) === 1
    || String(priorCheckpointMeta?.close_complete || '').trim().toLowerCase() === 'true'
  );
  let firstEligibleCycleAt = toText(priorCheckpointMeta?.first_eligible_cycle_at || '') || null;
  if (closeCheckpointEligible && !firstEligibleCycleAt) {
    firstEligibleCycleAt = checkpointEvaluatedAt;
  }
  let resolvedSweepSource = sweepSource;
  if (
    resolvedSweepSource === 'post_close_checkpoint'
    && closeCheckpointEligible
    && !priorCloseComplete
  ) {
    resolvedSweepSource = 'close_complete_checkpoint';
  }

  const runtimeCheckpointWasAutonomous = (
    resolvedSweepSource !== 'manual_api_run'
    && !mode.includes('manual')
    && !mode.includes('api')
    && !mode.includes('integration')
  );

  const expectedLiveContextExists = tradingDayClassification === 'valid_trading_day';
  const liveContextSuppressed = Number(suppressionRow?.is_active || 0) === 1;
  const liveOutcomeExists = outcomeCount > 0;
  const liveOutcomeInsertedThisCheckpoint = Number(scoringDecision?.inserted || 0) > 0
    || finalizationReason === 'finalized_and_inserted';
  const liveOutcomeUpdatedThisCheckpoint = Number(scoringDecision?.updated || 0) > 0
    || finalizationReason === 'finalized_and_updated';
  const checkpointExpectedOutcomeCount = (tradingDayClassification === 'valid_trading_day' && !liveContextSuppressed) ? 1 : 0;
  const checkpointActualOutcomeCount = liveOutcomeExists ? 1 : 0;
  const checkpointInsertDelta = Number(checkpointActualOutcomeCount - checkpointExpectedOutcomeCount);
  const checkpointDuplicateCount = Math.max(0, Number(outcomeCount || 0) - 1);
  const waitingFinalizationReason = (
    finalizationReason === 'awaiting_session_close'
    || finalizationReason === 'awaiting_next_day_window'
    || finalizationReason === 'awaiting_required_market_data'
  );
  const firstEligibleCycleExpectedInsert = (
    closeCheckpointEligible
    && checkpointExpectedOutcomeCount === 1
    && !!liveContextRow
    && !liveContextSuppressed
    && (!liveOutcomeExists || liveOutcomeInsertedThisCheckpoint)
  );
  const firstEligibleCycleInsertAttempted = firstEligibleCycleExpectedInsert
    && (
      Number(scoringDecision?.inserted || 0) > 0
      || Number(scoringDecision?.updated || 0) > 0
      || (!!finalizationDecision && !waitingFinalizationReason)
      || liveOutcomeInsertedThisCheckpoint
      || liveOutcomeUpdatedThisCheckpoint
    );
  const firstEligibleCycleInsertSucceeded = firstEligibleCycleExpectedInsert
    && liveOutcomeInsertedThisCheckpoint;
  let firstEligibleCycleFailureReason = null;
  if (firstEligibleCycleExpectedInsert && !firstEligibleCycleInsertSucceeded) {
    if (waitingFinalizationReason) firstEligibleCycleFailureReason = null;
    else if (!liveContextRow) firstEligibleCycleFailureReason = 'live_context_missing_when_ready';
    else if (checkpointDuplicateCount > 0 || finalizationReason === 'duplicate_finalization_identity') firstEligibleCycleFailureReason = 'duplicate_identity_conflict';
    else if (!requiredCloseDataPresent || !requiredCloseBarsPresent) firstEligibleCycleFailureReason = 'market_data_incomplete_when_marked_ready';
    else if (!firstEligibleCycleInsertAttempted) firstEligibleCycleFailureReason = 'insert_not_attempted_when_ready';
    else if (liveOutcomeUpdatedThisCheckpoint || liveOutcomeExists) firstEligibleCycleFailureReason = null;
    else firstEligibleCycleFailureReason = 'insert_attempt_failed';
  }

  let checkpointStatus = 'failure_unknown';
  let checkpointReason = 'unknown_checkpoint_state';
  let awaitingReason = null;
  let failureReason = null;

  if (!targetKey) {
    checkpointStatus = 'failure_unknown';
    checkpointReason = 'unknown_checkpoint_state';
    failureReason = 'unknown_failure';
  } else if (tradingDayClassification === 'non_trading_day') {
    checkpointStatus = 'blocked_invalid_day';
    checkpointReason = 'blocked_non_trading_day';
  } else if (tradingDayClassification === 'invalid_mapping' || liveContextSuppressed) {
    checkpointStatus = 'blocked_invalid_day';
    checkpointReason = 'blocked_invalid_day_mapping';
    if (liveContextSuppressed) {
      failureReason = 'finalization_logic_rejected_valid_day';
    }
  } else if (checkpointDuplicateCount > 0 || finalizationReason === 'duplicate_finalization_identity') {
    checkpointStatus = 'failure_duplicate_state';
    checkpointReason = 'duplicate_live_identity_conflict';
    failureReason = 'duplicate_live_identity_conflict';
  } else if (firstEligibleCycleFailureReason) {
    if (firstEligibleCycleFailureReason === 'live_context_missing_when_ready') {
      checkpointStatus = 'failure_missing_context';
      checkpointReason = 'missing_live_context';
      failureReason = 'live_context_missing_when_ready';
    } else if (firstEligibleCycleFailureReason === 'market_data_incomplete_when_marked_ready') {
      checkpointStatus = 'failure_missing_market_data';
      checkpointReason = 'missing_required_market_data';
      failureReason = 'market_data_incomplete_when_marked_ready';
    } else if (firstEligibleCycleFailureReason === 'duplicate_identity_conflict') {
      checkpointStatus = 'failure_duplicate_state';
      checkpointReason = 'duplicate_live_identity_conflict';
      failureReason = 'duplicate_identity_conflict';
    } else if (firstEligibleCycleFailureReason === 'insert_not_attempted_when_ready') {
      checkpointStatus = 'failure_scheduler_miss';
      checkpointReason = 'scheduler_checkpoint_miss';
      failureReason = 'insert_not_attempted_when_ready';
    } else {
      checkpointStatus = 'failure_unknown';
      checkpointReason = 'unknown_checkpoint_state';
      failureReason = 'insert_attempt_failed';
    }
  } else if (!liveContextRow) {
    checkpointStatus = 'failure_missing_context';
    checkpointReason = 'missing_live_context';
    failureReason = 'missing_live_context';
  } else if (liveOutcomeInsertedThisCheckpoint) {
    checkpointStatus = 'success_inserted';
    checkpointReason = 'inserted_new_live_outcome';
  } else if (
    liveOutcomeExists
    && (
      liveOutcomeUpdatedThisCheckpoint
      || finalizationReason === 'already_finalized'
      || finalizationReason === 'finalized_and_updated'
    )
  ) {
    checkpointStatus = 'success_already_finalized';
    checkpointReason = 'already_finalized_live_outcome';
  } else if (!closeCheckpointEligible) {
    if (closeCompleteReason === 'awaiting_session_close') {
      checkpointStatus = 'waiting_valid';
      checkpointReason = 'waiting_for_session_close';
      awaitingReason = 'awaiting_session_close';
    } else if (closeCompleteReason === 'awaiting_required_market_data' || closeCompleteReason === 'awaiting_close_bar_completion') {
      checkpointStatus = 'waiting_valid';
      checkpointReason = 'waiting_for_required_market_data';
      awaitingReason = 'awaiting_required_market_data';
    } else if (closeCompleteReason === 'non_trading_day') {
      checkpointStatus = 'blocked_invalid_day';
      checkpointReason = 'blocked_non_trading_day';
    } else if (closeCompleteReason === 'invalid_trading_day') {
      checkpointStatus = 'blocked_invalid_day';
      checkpointReason = 'blocked_invalid_day_mapping';
    } else {
      checkpointStatus = 'waiting_valid';
      checkpointReason = 'waiting_for_outcome_window';
      awaitingReason = 'awaiting_post_close_checkpoint_window';
    }
    if (
      checkpointStatus === 'waiting_valid'
      && resolvedSweepSource === 'next_morning_recovery'
    ) {
      checkpointStatus = 'failure_scheduler_miss';
      checkpointReason = 'scheduler_checkpoint_miss';
      failureReason = 'unresolved_wait_past_deadline';
    }
  } else if (
    finalizationReason === 'awaiting_session_close'
    || finalizationReason === 'awaiting_next_day_window'
    || finalizationReason === 'awaiting_required_market_data'
  ) {
    awaitingReason = normalizeCheckpointAwaitingReason(finalizationReason);
    if (resolvedSweepSource === 'next_morning_recovery') {
      checkpointStatus = 'failure_scheduler_miss';
      checkpointReason = 'scheduler_checkpoint_miss';
      failureReason = 'unresolved_wait_past_deadline';
    } else {
      checkpointStatus = 'waiting_valid';
      if (awaitingReason === 'awaiting_session_close') checkpointReason = 'waiting_for_session_close';
      else if (awaitingReason === 'awaiting_next_day_window') checkpointReason = 'waiting_for_outcome_window';
      else checkpointReason = 'waiting_for_required_market_data';
    }
  } else if (!sessionForDate.length) {
    checkpointStatus = 'failure_missing_market_data';
    checkpointReason = 'missing_required_market_data';
    failureReason = 'missing_required_market_data';
  } else if (!finalizationDecision) {
    if (
      resolvedSweepSource === 'post_close_checkpoint'
      || resolvedSweepSource === 'close_complete_checkpoint'
      || resolvedSweepSource === 'late_data_recovery'
      || resolvedSweepSource === 'next_morning_recovery'
    ) {
      checkpointStatus = 'failure_scheduler_miss';
      checkpointReason = 'scheduler_checkpoint_miss';
      failureReason = 'checkpoint_not_run';
    } else {
      checkpointStatus = 'waiting_valid';
      checkpointReason = 'waiting_for_outcome_window';
      awaitingReason = 'awaiting_post_close_checkpoint_window';
    }
  } else if (!liveOutcomeExists) {
    checkpointStatus = 'failure_unknown';
    checkpointReason = 'unknown_checkpoint_state';
    failureReason = 'unknown_failure';
  } else {
    checkpointStatus = 'success_already_finalized';
    checkpointReason = 'already_finalized_live_outcome';
  }

  let checkpointWindowContract = buildCheckpointWindowContract({
    targetTradingDay: targetKey,
    nowDate,
    nowTime,
    closeCompleteReason,
    checkpointStatus,
    checkpointReason,
    checkpointExpectedOutcomeCount,
    checkpointActualOutcomeCount,
  });
  const autonomousResolution = readAutonomousCheckpointResolution(db, targetKey);
  const currentRunRuntimeOutcome = mapCheckpointToRuntimeOutcome({
    checkpointStatus,
    firstEligibleCycleFailureReason,
  });
  const currentRunAutonomousSuccess = (
    runtimeCheckpointWasAutonomous
    && (
      currentRunRuntimeOutcome === 'success_inserted'
      || currentRunRuntimeOutcome === 'success_already_finalized'
    )
  );
  const autonomousSuccessResolved = currentRunAutonomousSuccess || autonomousResolution.hasAutonomousSuccess === true;

  if (
    tradingDayClassification === 'valid_trading_day'
    && checkpointExpectedOutcomeCount === 1
    && checkpointWindowContract.checkpointPastDeadline === true
    && !autonomousSuccessResolved
  ) {
    checkpointStatus = 'failure_scheduler_miss';
    checkpointReason = 'scheduler_checkpoint_miss';
    if (!failureReason) {
      if (!liveContextRow) failureReason = 'checkpoint_not_run';
      else if (
        closeCompleteReason === 'awaiting_required_market_data'
        || closeCompleteReason === 'awaiting_close_bar_completion'
      ) failureReason = 'missing_required_market_data';
      else failureReason = 'unresolved_wait_past_deadline';
    }
    awaitingReason = null;
    checkpointWindowContract = buildCheckpointWindowContract({
      targetTradingDay: targetKey,
      nowDate,
      nowTime,
      closeCompleteReason,
      checkpointStatus,
      checkpointReason,
      checkpointExpectedOutcomeCount,
      checkpointActualOutcomeCount,
    });
  }

  checkpointStatus = normalizeCheckpointStatus(checkpointStatus);
  checkpointReason = normalizeCheckpointReason(checkpointReason);
  awaitingReason = normalizeCheckpointAwaitingReason(awaitingReason);
  failureReason = normalizeCheckpointFailureReason(failureReason);
  firstEligibleCycleFailureReason = normalizeFirstEligibleCycleFailureReason(firstEligibleCycleFailureReason);
  checkpointWindowContract = {
    checkpointWindowOpenedAt: checkpointWindowContract.checkpointWindowOpenedAt || null,
    checkpointDeadlineAt: checkpointWindowContract.checkpointDeadlineAt || null,
    checkpointWindowClosedAt: checkpointWindowContract.checkpointWindowClosedAt || null,
    checkpointWithinAllowedWindow: checkpointWindowContract.checkpointWithinAllowedWindow === true,
    checkpointPastDeadline: checkpointWindowContract.checkpointPastDeadline === true,
    checkpointWindowReason: normalizeCheckpointWindowReason(checkpointWindowContract.checkpointWindowReason),
  };

  let runtimeCheckpointOutcome = normalizeRuntimeCheckpointOutcome(
    mapCheckpointToRuntimeOutcome({
      checkpointStatus,
      firstEligibleCycleFailureReason,
    })
  );
  let runtimeCheckpointMissed = false;
  let runtimeCheckpointMissReason = null;
  if (
    checkpointWindowContract.checkpointPastDeadline === true
    && tradingDayClassification === 'valid_trading_day'
    && checkpointExpectedOutcomeCount === 1
    && !autonomousSuccessResolved
  ) {
    runtimeCheckpointOutcome = 'failure_scheduler_miss';
    runtimeCheckpointMissed = true;
    runtimeCheckpointMissReason = checkpointWindowContract.checkpointWindowReason === 'checkpoint_window_missed'
      ? 'checkpoint_window_missed'
      : 'after_checkpoint_deadline';
  } else if (runtimeCheckpointOutcome === 'failure_scheduler_miss') {
    runtimeCheckpointMissed = true;
    runtimeCheckpointMissReason = checkpointWindowContract.checkpointWindowReason === 'checkpoint_window_missed'
      ? 'checkpoint_window_missed'
      : 'after_checkpoint_deadline';
  } else if (
    checkpointWindowContract.checkpointWindowReason === 'awaiting_close_complete'
    || checkpointWindowContract.checkpointWindowReason === 'awaiting_required_market_data'
  ) {
    runtimeCheckpointMissReason = checkpointWindowContract.checkpointWindowReason;
  }

  return {
    targetTradingDay: targetKey || null,
    tradingDayClassification,
    tradingDayClassificationReason,
    closeComplete: closeComplete === true,
    closeCompleteReason,
    requiredCloseDataPresent: requiredCloseDataPresent === true,
    requiredCloseBarsPresent: requiredCloseBarsPresent === true,
    closeCheckpointEligible: closeCheckpointEligible === true,
    closeCheckpointEligibilityReason,
    firstEligibleCycleAt: firstEligibleCycleAt || null,
    checkpointEvaluatedAt,
    checkpointStatus,
    checkpointReason,
    expectedLiveContextExists: expectedLiveContextExists === true,
    liveContextSuppressed: liveContextSuppressed === true,
    liveOutcomeExists: liveOutcomeExists === true,
    liveOutcomeInsertedThisCheckpoint: liveOutcomeInsertedThisCheckpoint === true,
    liveOutcomeUpdatedThisCheckpoint: liveOutcomeUpdatedThisCheckpoint === true,
    awaitingReason: awaitingReason || null,
    failureReason: failureReason || null,
    firstEligibleCycleExpectedInsert: firstEligibleCycleExpectedInsert === true,
    firstEligibleCycleInsertAttempted: firstEligibleCycleInsertAttempted === true,
    firstEligibleCycleInsertSucceeded: firstEligibleCycleInsertSucceeded === true,
    firstEligibleCycleFailureReason: firstEligibleCycleFailureReason || null,
    checkpointWindowOpenedAt: checkpointWindowContract.checkpointWindowOpenedAt,
    checkpointDeadlineAt: checkpointWindowContract.checkpointDeadlineAt,
    checkpointWindowClosedAt: checkpointWindowContract.checkpointWindowClosedAt,
    checkpointWithinAllowedWindow: checkpointWindowContract.checkpointWithinAllowedWindow === true,
    checkpointPastDeadline: checkpointWindowContract.checkpointPastDeadline === true,
    checkpointWindowReason: checkpointWindowContract.checkpointWindowReason,
    runtimeCheckpointTriggered: true,
    runtimeCheckpointTriggeredAt: checkpointEvaluatedAt,
    runtimeCheckpointSource: resolvedSweepSource,
    runtimeCheckpointTargetTradingDay: targetKey || null,
    runtimeCheckpointOutcome,
    runtimeCheckpointWasAutonomous: runtimeCheckpointWasAutonomous === true,
    runtimeCheckpointMissed: runtimeCheckpointMissed === true,
    runtimeCheckpointMissReason: runtimeCheckpointMissReason || null,
    autonomousCheckpointSuccessResolved: autonomousSuccessResolved === true,
    autonomousCheckpointLatestOutcome: autonomousResolution.latestAutonomousOutcome || null,
    autonomousCheckpointLatestTriggeredAt: autonomousResolution.latestAutonomousTriggeredAt || null,
    autonomousCheckpointLatestSweepSource: autonomousResolution.latestAutonomousSweepSource || null,
    sweepSource: resolvedSweepSource,
    checkpointExpectedOutcomeCount: Number(checkpointExpectedOutcomeCount || 0),
    checkpointActualOutcomeCount: Number(checkpointActualOutcomeCount || 0),
    checkpointInsertDelta: Number(checkpointInsertDelta || 0),
    checkpointDuplicateCount: Number(checkpointDuplicateCount || 0),
    checkpointResolvedState: checkpointStatus,
    checkpointCompletedAt: checkpointEvaluatedAt,
    advisoryOnly: true,
  };
}

function isLiveContextAlreadyScored(db, contextRow = {}) {
  const date = normalizeDate(contextRow?.rec_date || '');
  const sourceType = toText(contextRow?.source_type || '').toLowerCase() || 'live';
  const reconstructionPhase = toText(contextRow?.reconstruction_phase || '').toLowerCase() || 'live_intraday';
  if (!date) return false;
  const row = db.prepare(`
    SELECT id
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ? AND source_type = ? AND reconstruction_phase = ?
    LIMIT 1
  `).get(date, sourceType, reconstructionPhase);
  return !!row;
}

function evaluateLiveFinalizationReadiness(input = {}) {
  const date = normalizeDate(input.date || '');
  const nowDate = normalizeDate(input.nowDate || '');
  const contextRow = input.contextRow || {};
  const sessionForDate = Array.isArray(input.sessionForDate) ? input.sessionForDate : [];
  const tradingDayClassification = classifyTradingDay({ date, sessionForDate });
  const classification = normalizeTradingDayClassification(tradingDayClassification.classification);
  const classificationReason = toText(tradingDayClassification.classificationReason || '') || 'unknown';
  const contextJson = safeJsonParseObject(contextRow?.context_json);
  const contextDate = normalizeDate(
    contextJson?.nowEt?.date
    || contextJson?.nowEt
    || contextJson?.date
    || date
  );
  if (!date || !nowDate) {
    return {
      ready: false,
      reason: 'other_blocked',
      state: 'blocked_invalid_day',
      classification: 'invalid_mapping',
      classificationReason: 'missing_now_or_target_date',
    };
  }
  if (contextDate && contextDate !== date) {
    return {
      ready: false,
      reason: 'missing_live_context_alignment',
      state: 'blocked_invalid_day',
      classification: 'invalid_mapping',
      classificationReason: 'context_date_mismatch',
    };
  }
  const dateCmp = compareIsoDates(date, nowDate);
  if (dateCmp > 0) {
    return {
      ready: false,
      reason: 'awaiting_next_day_window',
      state: 'awaiting_outcome_window',
      classification,
      classificationReason,
    };
  }
  if (classification === 'non_trading_day') {
    return {
      ready: false,
      reason: 'non_trading_day',
      state: 'blocked_invalid_day',
      classification,
      classificationReason,
    };
  }
  if (classification === 'invalid_mapping') {
    return {
      ready: false,
      reason: 'invalid_trading_day_mapping',
      state: 'blocked_invalid_day',
      classification,
      classificationReason,
    };
  }
  if (!sessionForDate.length) {
    return {
      ready: false,
      reason: 'awaiting_required_market_data',
      state: 'awaiting_required_market_data',
      classification,
      classificationReason,
    };
  }
  if (!hasTradeWindowClose(sessionForDate)) {
    if (dateCmp === 0) {
      return {
        ready: false,
        reason: 'awaiting_session_close',
        state: 'awaiting_session_close',
        classification,
        classificationReason,
      };
    }
    if (dateCmp < 0) {
      return {
        ready: false,
        reason: 'awaiting_required_market_data',
        state: 'awaiting_required_market_data',
        classification,
        classificationReason,
      };
    }
    return {
      ready: false,
      reason: 'awaiting_next_day_window',
      state: 'awaiting_outcome_window',
      classification,
      classificationReason,
    };
  }
  return {
    ready: true,
    reason: null,
    state: 'ready_to_finalize',
    classification,
    classificationReason,
  };
}

function mapFinalizationReasonToReadinessState(reason = '') {
  const r = normalizeFinalizationReason(reason);
  if (r === 'finalized_and_inserted' || r === 'finalized_and_updated') return 'ready_to_finalize';
  if (r === 'already_finalized') return 'already_finalized';
  if (r === 'awaiting_session_close') return 'awaiting_session_close';
  if (r === 'awaiting_next_day_window') return 'awaiting_outcome_window';
  if (r === 'awaiting_required_market_data') return 'awaiting_required_market_data';
  return 'blocked_invalid_day';
}

function ensureDailyScoringTables(db) {
  ensureDataFoundationTables(db);
  ensureRecommendationOutcomeSchema(db);
}

function listUnscoredLiveRecommendationContexts(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  ensureDailyScoringTables(db);
  const sinceDate = normalizeDate(options.sinceDate || '');
  const limit = Math.max(1, Math.min(200, Number(options.limit || 60)));
  if (!sinceDate) return [];
  return db.prepare(`
    SELECT c.*
    FROM jarvis_recommendation_context_history c
    LEFT JOIN jarvis_scored_trade_outcomes s
      ON s.score_date = c.rec_date
      AND s.source_type = c.source_type
      AND s.reconstruction_phase = c.reconstruction_phase
    LEFT JOIN jarvis_live_context_suppression sup
      ON sup.rec_date = c.rec_date
      AND sup.source_type = c.source_type
      AND sup.reconstruction_phase = c.reconstruction_phase
      AND sup.is_active = 1
    WHERE c.source_type = 'live'
      AND c.reconstruction_phase = 'live_intraday'
      AND c.rec_date >= ?
      AND s.id IS NULL
      AND sup.id IS NULL
    ORDER BY c.rec_date ASC, c.id ASC
    LIMIT ?
  `).all(sinceDate, limit);
}

function mergeContextRowsByIdentity(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const recDate = normalizeDate(row?.rec_date || '');
    const sourceType = toText(row?.source_type || '').toLowerCase() || 'live';
    const reconstructionPhase = toText(row?.reconstruction_phase || '').toLowerCase() || 'live_intraday';
    if (!recDate) continue;
    const key = `${recDate}|${sourceType}|${reconstructionPhase}`;
    if (!map.has(key)) {
      map.set(key, row);
      continue;
    }
    const current = map.get(key) || {};
    const rowId = Number(row?.id || 0);
    const currentId = Number(current?.id || 0);
    if (rowId >= currentId) map.set(key, row);
  }
  return Array.from(map.values());
}

function countNetNewLiveRowsByCreatedWindow(db, nowDate = '', days = 1) {
  const normalizedNow = normalizeDate(nowDate);
  const windowDays = clampInt(days, 1, 30, 1);
  if (!normalizedNow) return 0;
  const sinceDate = addDays(normalizedNow, -(windowDays - 1)) || normalizedNow;
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live'
      AND substr(COALESCE(created_at, ''), 1, 10) >= ?
  `).get(sinceDate);
  return Number(row?.c || 0);
}

function readLiveOutcomeRowByIdentity(db, scoreDate = '') {
  const date = normalizeDate(scoreDate);
  if (!db || typeof db.prepare !== 'function' || !date) return null;
  try {
    return db.prepare(`
      SELECT id, score_date, source_type, reconstruction_phase, created_at, updated_at
      FROM jarvis_scored_trade_outcomes
      WHERE score_date = ?
        AND source_type = 'live'
        AND reconstruction_phase = 'live_intraday'
      LIMIT 1
    `).get(date) || null;
  } catch {
    return null;
  }
}

function readLiveInsertionOwnershipRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!db || typeof db.prepare !== 'function' || !target) return null;
  try {
    return db.prepare(`
      SELECT
        target_trading_day,
        created_row_id,
        first_run_id,
        first_run_mode,
        first_run_source,
        first_insert_sla_outcome,
        first_inserted_at,
        first_inserted_autonomous
      FROM jarvis_live_outcome_ownership
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function listLiveInsertionOwnershipRows(db, targetTradingDays = []) {
  if (!db || typeof db.prepare !== 'function') return new Map();
  const dates = Array.isArray(targetTradingDays)
    ? targetTradingDays.map((date) => normalizeDate(date)).filter(Boolean)
    : [];
  if (!dates.length) return new Map();
  const map = new Map();
  for (const date of dates) {
    if (map.has(date)) continue;
    const row = readLiveInsertionOwnershipRow(db, date);
    if (row) map.set(date, row);
  }
  return map;
}

function readDailyScoringRunMetaById(db, runId) {
  const id = Number(runId || 0);
  if (!db || typeof db.prepare !== 'function' || !Number.isFinite(id) || id <= 0) return null;
  try {
    const row = db.prepare(`
      SELECT id, mode, created_at, details_json
      FROM jarvis_daily_scoring_runs
      WHERE id = ?
      LIMIT 1
    `).get(id);
    if (!row) return null;
    const details = safeJsonParseObject(row.details_json);
    const checkpoint = details?.liveCheckpoint && typeof details.liveCheckpoint === 'object'
      ? details.liveCheckpoint
      : {};
    const transition = details?.liveAutonomousAttemptTransition && typeof details.liveAutonomousAttemptTransition === 'object'
      ? details.liveAutonomousAttemptTransition
      : {};
    const proof = details?.liveAutonomousProof && typeof details.liveAutonomousProof === 'object'
      ? details.liveAutonomousProof
      : {};
    const ownership = details?.liveInsertionOwnership && typeof details.liveInsertionOwnership === 'object'
      ? details.liveInsertionOwnership
      : {};
    return {
      runId: Number(row.id || 0) || null,
      mode: toText(row.mode || '') || null,
      createdAt: toText(row.created_at || '') || null,
      checkpointStatus: normalizeCheckpointStatus(checkpoint.checkpointStatus),
      checkpointReason: normalizeCheckpointReason(checkpoint.checkpointReason),
      checkpointTargetTradingDay: normalizeDate(checkpoint.targetTradingDay || '') || null,
      checkpointSource: normalizeFinalizationSweepSource(
        checkpoint.runtimeCheckpointSource
        || checkpoint.sweepSource
        || ''
      ),
      attemptResult: normalizeLiveAutonomousAttemptResult(transition.attemptResult || ''),
      attemptExecuted: transition.attemptExecuted === true,
      proofOutcome: normalizeLiveAutonomousProofOutcome(proof.liveAutonomousProofOutcome || ''),
      proofAttempted: proof.liveAutonomousProofAttempted === true,
      proofSucceeded: proof.liveAutonomousProofSucceeded === true,
      ownershipOutcome: normalizeLiveInsertionOwnershipOutcome(ownership.liveInsertionOwnershipOutcome || ''),
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        ownership.liveInsertionOwnershipSourceSpecificOutcome || ''
      ),
      details,
    };
  } catch {
    return null;
  }
}

function readLivePreferredOwnerProofRow(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!db || typeof db.prepare !== 'function' || !target) return null;
  try {
    return db.prepare(`
      SELECT
        rowid AS proof_row_id,
        target_trading_day,
        preferred_owner_expected_source,
        first_row_id,
        first_creator_run_id,
        first_creator_mode,
        first_creator_source,
        first_creator_autonomous,
        first_creation_timestamp,
        first_creation_checkpoint_status,
        first_creation_attempt_result,
        first_creation_proof_outcome,
        first_creation_ownership_outcome,
        first_creation_ownership_source_specific_outcome,
        preferred_owner_won,
        preferred_owner_won_first_eligible_cycle,
        preferred_owner_failure_reason,
        preferred_owner_proof_captured_at,
        updated_at
      FROM jarvis_live_preferred_owner_proof
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function listLivePreferredOwnerProofRows(db, targetTradingDays = []) {
  if (!db || typeof db.prepare !== 'function') return new Map();
  const dates = Array.isArray(targetTradingDays)
    ? targetTradingDays.map((date) => normalizeDate(date)).filter(Boolean)
    : [];
  if (!dates.length) return new Map();
  const out = new Map();
  for (const date of dates) {
    if (out.has(date)) continue;
    const row = readLivePreferredOwnerProofRow(db, date);
    if (row) out.set(date, row);
  }
  return out;
}

function listRecentLivePreferredOwnerProofRows(db, limit = 40) {
  if (!db || typeof db.prepare !== 'function') return [];
  const bounded = clampInt(limit, 1, 500, 40);
  try {
    return db.prepare(`
      SELECT
        rowid AS proof_row_id,
        target_trading_day,
        preferred_owner_expected_source,
        first_row_id,
        first_creator_run_id,
        first_creator_mode,
        first_creator_source,
        first_creator_autonomous,
        first_creation_timestamp,
        first_creation_checkpoint_status,
        first_creation_attempt_result,
        first_creation_proof_outcome,
        first_creation_ownership_outcome,
        first_creation_ownership_source_specific_outcome,
        preferred_owner_won,
        preferred_owner_won_first_eligible_cycle,
        preferred_owner_failure_reason,
        preferred_owner_proof_captured_at,
        updated_at
      FROM jarvis_live_preferred_owner_proof
      ORDER BY target_trading_day DESC
      LIMIT ?
    `).all(bounded) || [];
  } catch {
    return [];
  }
}

function upsertLivePreferredOwnerProofRow(db, input = {}) {
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!db || typeof db.prepare !== 'function' || !targetTradingDay) {
    return readLivePreferredOwnerProofRow(db, targetTradingDay);
  }
  const preferredOwnerExpectedSource = normalizeFinalizationSweepSource(
    input.preferredOwnerExpectedSource || 'close_complete_checkpoint'
  );
  const firstRowId = Number(input.firstRowId || 0) || null;
  const firstCreatorRunId = Number(input.firstCreatorRunId || 0) || null;
  const firstCreatorMode = toText(input.firstCreatorMode || '') || null;
  const firstCreatorSource = input.firstCreatorSource
    ? normalizeFinalizationSweepSource(input.firstCreatorSource)
    : null;
  const firstCreatorAutonomous = input.firstCreatorAutonomous === true ? 1 : 0;
  const firstCreationTimestamp = toText(input.firstCreationTimestamp || '') || null;
  const firstCreationCheckpointStatus = input.firstCreationCheckpointStatus
    ? normalizeCheckpointStatus(input.firstCreationCheckpointStatus)
    : null;
  const firstCreationAttemptResult = input.firstCreationAttemptResult
    ? normalizeLiveAutonomousAttemptResult(input.firstCreationAttemptResult)
    : null;
  const firstCreationProofOutcome = input.firstCreationProofOutcome
    ? normalizeLiveAutonomousProofOutcome(input.firstCreationProofOutcome)
    : null;
  const firstCreationOwnershipOutcome = input.firstCreationOwnershipOutcome
    ? normalizeLiveInsertionOwnershipOutcome(input.firstCreationOwnershipOutcome)
    : null;
  const firstCreationOwnershipSourceSpecificOutcome = input.firstCreationOwnershipSourceSpecificOutcome
    ? normalizeLiveInsertionOwnershipSourceSpecificOutcome(input.firstCreationOwnershipSourceSpecificOutcome)
    : null;
  const preferredOwnerWon = input.preferredOwnerWon === true ? 1 : 0;
  const preferredOwnerWonFirstEligibleCycle = input.preferredOwnerWonFirstEligibleCycle === true ? 1 : 0;
  const preferredOwnerFailureReason = normalizeLivePreferredOwnerFailureReason(input.preferredOwnerFailureReason);
  const preferredOwnerProofCapturedAt = toText(input.preferredOwnerProofCapturedAt || new Date().toISOString()) || new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO jarvis_live_preferred_owner_proof (
        target_trading_day,
        preferred_owner_expected_source,
        first_row_id,
        first_creator_run_id,
        first_creator_mode,
        first_creator_source,
        first_creator_autonomous,
        first_creation_timestamp,
        first_creation_checkpoint_status,
        first_creation_attempt_result,
        first_creation_proof_outcome,
        first_creation_ownership_outcome,
        first_creation_ownership_source_specific_outcome,
        preferred_owner_won,
        preferred_owner_won_first_eligible_cycle,
        preferred_owner_failure_reason,
        preferred_owner_proof_captured_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(target_trading_day) DO UPDATE SET
        preferred_owner_expected_source = excluded.preferred_owner_expected_source,
        first_row_id = COALESCE(jarvis_live_preferred_owner_proof.first_row_id, excluded.first_row_id),
        first_creator_run_id = COALESCE(jarvis_live_preferred_owner_proof.first_creator_run_id, excluded.first_creator_run_id),
        first_creator_mode = COALESCE(jarvis_live_preferred_owner_proof.first_creator_mode, excluded.first_creator_mode),
        first_creator_source = COALESCE(jarvis_live_preferred_owner_proof.first_creator_source, excluded.first_creator_source),
        first_creator_autonomous = CASE
          WHEN jarvis_live_preferred_owner_proof.first_creator_run_id IS NULL THEN excluded.first_creator_autonomous
          ELSE jarvis_live_preferred_owner_proof.first_creator_autonomous
        END,
        first_creation_timestamp = COALESCE(jarvis_live_preferred_owner_proof.first_creation_timestamp, excluded.first_creation_timestamp),
        first_creation_checkpoint_status = COALESCE(jarvis_live_preferred_owner_proof.first_creation_checkpoint_status, excluded.first_creation_checkpoint_status),
        first_creation_attempt_result = COALESCE(jarvis_live_preferred_owner_proof.first_creation_attempt_result, excluded.first_creation_attempt_result),
        first_creation_proof_outcome = COALESCE(jarvis_live_preferred_owner_proof.first_creation_proof_outcome, excluded.first_creation_proof_outcome),
        first_creation_ownership_outcome = COALESCE(jarvis_live_preferred_owner_proof.first_creation_ownership_outcome, excluded.first_creation_ownership_outcome),
        first_creation_ownership_source_specific_outcome = CASE
          WHEN excluded.first_creation_ownership_source_specific_outcome IS NULL
            THEN jarvis_live_preferred_owner_proof.first_creation_ownership_source_specific_outcome
          WHEN excluded.preferred_owner_won = 1
            AND lower(trim(excluded.first_creation_ownership_source_specific_outcome))
              != 'ownership_source_unknown'
            THEN excluded.first_creation_ownership_source_specific_outcome
          WHEN jarvis_live_preferred_owner_proof.first_creation_ownership_source_specific_outcome IS NULL
            THEN excluded.first_creation_ownership_source_specific_outcome
          WHEN lower(trim(jarvis_live_preferred_owner_proof.first_creation_ownership_source_specific_outcome))
              = 'ownership_source_unknown'
            AND lower(trim(excluded.first_creation_ownership_source_specific_outcome))
              != 'ownership_source_unknown'
            THEN excluded.first_creation_ownership_source_specific_outcome
          ELSE jarvis_live_preferred_owner_proof.first_creation_ownership_source_specific_outcome
        END,
        preferred_owner_won = excluded.preferred_owner_won,
        preferred_owner_won_first_eligible_cycle = excluded.preferred_owner_won_first_eligible_cycle,
        preferred_owner_failure_reason = excluded.preferred_owner_failure_reason,
        preferred_owner_proof_captured_at = excluded.preferred_owner_proof_captured_at,
        updated_at = datetime('now')
    `).run(
      targetTradingDay,
      preferredOwnerExpectedSource,
      firstRowId,
      firstCreatorRunId,
      firstCreatorMode,
      firstCreatorSource,
      firstCreatorAutonomous,
      firstCreationTimestamp,
      firstCreationCheckpointStatus,
      firstCreationAttemptResult,
      firstCreationProofOutcome,
      firstCreationOwnershipOutcome,
      firstCreationOwnershipSourceSpecificOutcome,
      preferredOwnerWon,
      preferredOwnerWonFirstEligibleCycle,
      preferredOwnerFailureReason,
      preferredOwnerProofCapturedAt
    );
  } catch {}
  return readLivePreferredOwnerProofRow(db, targetTradingDay);
}

function recordPreferredOwnerDeferralEvent(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  const fallbackSource = normalizeFinalizationSweepSource(input.fallbackSource || '');
  const deferralReason = normalizeLivePreferredOwnerReservationBlockReason(input.deferralReason || 'preferred_owner_window_still_open');
  const reservationState = normalizeLivePreferredOwnerReservationState(input.reservationState || 'reservation_not_applicable');
  const runId = Number(input.runId || 0) || null;
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const ts = toText(input.timestamp || new Date().toISOString()) || new Date().toISOString();
  if (!targetTradingDay || !fallbackSource) return null;
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_deferrals (
        target_trading_day,
        fallback_source,
        deferral_reason,
        reservation_state,
        run_id,
        run_origin,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_trading_day, run_id, fallback_source) DO NOTHING
    `).run(
      targetTradingDay,
      fallbackSource,
      deferralReason,
      reservationState,
      runId,
      runOrigin,
      ts
    );
  } catch {
    return null;
  }
  try {
    return db.prepare(`
      SELECT id, target_trading_day, fallback_source, deferral_reason, reservation_state, run_id, run_origin, timestamp
      FROM jarvis_preferred_owner_deferrals
      WHERE target_trading_day = ?
        AND fallback_source = ?
        AND run_id IS ?
      ORDER BY id DESC
      LIMIT 1
    `).get(targetTradingDay, fallbackSource, runId) || null;
  } catch {
    return null;
  }
}

function recordPreferredOwnerNaturalWinEvent(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  const runId = Number(input.runId || 0) || null;
  const firstCreatorSource = normalizeFinalizationSweepSource(input.firstCreatorSource || '');
  const reservationState = normalizeLivePreferredOwnerReservationState(input.reservationState || 'reservation_not_applicable');
  const reservationBlockedFallback = input.reservationBlockedFallback === true ? 1 : 0;
  const proofRowId = Number(input.proofRowId || 0) || null;
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const ts = toText(input.timestamp || new Date().toISOString()) || new Date().toISOString();
  if (!targetTradingDay || !runId || !firstCreatorSource) return null;
  let existingRowId = null;
  try {
    const existing = db.prepare(`
      SELECT id
      FROM jarvis_preferred_owner_natural_wins
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(targetTradingDay);
    existingRowId = Number(existing?.id || 0) || null;
  } catch {}
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_natural_wins (
        target_trading_day,
        run_id,
        first_creator_source,
        reservation_state,
        reservation_blocked_fallback,
        proof_row_id,
        run_origin,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_trading_day) DO NOTHING
    `).run(
      targetTradingDay,
      runId,
      firstCreatorSource,
      reservationState,
      reservationBlockedFallback,
      proofRowId,
      runOrigin,
      ts
    );
  } catch {
    return null;
  }
  try {
    const row = db.prepare(`
      SELECT id, target_trading_day, run_id, first_creator_source, reservation_state, reservation_blocked_fallback, proof_row_id, run_origin, timestamp
      FROM jarvis_preferred_owner_natural_wins
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(targetTradingDay) || null;
    if (!row) return null;
    return {
      ...row,
      wasNewRowPersisted: existingRowId === null,
      previousRowId: existingRowId,
    };
  } catch {
    return null;
  }
}

function readPreferredOwnerNaturalWinMetrics(db, nowDate = '') {
  if (!db || typeof db.prepare !== 'function') {
    return {
      naturalPreferredOwnerWinsLast5d: 0,
      naturalPreferredOwnerWinsTotal: 0,
      lastNaturalPreferredOwnerWinDay: null,
    };
  }
  const anchorDate = normalizeDate(nowDate || new Date().toISOString()) || normalizeDate(new Date().toISOString());
  const sinceDate = addDays(anchorDate, -4) || anchorDate;
  let total = 0;
  let last5d = 0;
  let lastDay = null;
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN target_trading_day >= ? THEN 1 ELSE 0 END) AS last_5d_count
      FROM jarvis_preferred_owner_natural_wins
      WHERE lower(run_origin) = 'natural'
    `).get(sinceDate);
    total = Number(row?.total_count || 0);
    last5d = Number(row?.last_5d_count || 0);
  } catch {}
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_natural_wins
      WHERE lower(run_origin) = 'natural'
      ORDER BY target_trading_day DESC
      LIMIT 1
    `).get();
    lastDay = normalizeDate(row?.target_trading_day || '') || null;
  } catch {}
  return {
    naturalPreferredOwnerWinsLast5d: Number(last5d || 0),
    naturalPreferredOwnerWinsTotal: Number(total || 0),
    lastNaturalPreferredOwnerWinDay: lastDay,
  };
}

function readPreferredOwnerVerifierMetrics(db, nowDate = '') {
  if (!db || typeof db.prepare !== 'function') {
    return {
      naturalPreferredOwnerVerifierPassesLast5d: 0,
      naturalPreferredOwnerVerifierFailsLast5d: 0,
    };
  }
  const anchorDate = normalizeDate(nowDate || new Date().toISOString()) || normalizeDate(new Date().toISOString());
  const sinceDate = addDays(anchorDate, -4) || anchorDate;
  let passCount = 0;
  let failCount = 0;
  try {
    const row = db.prepare(`
      SELECT
        SUM(
          CASE
            WHEN target_trading_day >= ?
              AND lower(run_origin) = 'natural'
              AND lower(runtime_source) = 'close_complete_checkpoint'
              AND lower(verifier_status) = 'pass'
            THEN 1 ELSE 0
          END
        ) AS pass_count,
        SUM(
          CASE
            WHEN target_trading_day >= ?
              AND lower(run_origin) = 'natural'
              AND lower(runtime_source) = 'close_complete_checkpoint'
              AND lower(verifier_status) = 'fail'
            THEN 1 ELSE 0
          END
        ) AS fail_count
      FROM jarvis_preferred_owner_post_close_verifier
    `).get(sinceDate, sinceDate);
    passCount = Number(row?.pass_count || 0);
    failCount = Number(row?.fail_count || 0);
  } catch {}
  return {
    naturalPreferredOwnerVerifierPassesLast5d: Number(passCount || 0),
    naturalPreferredOwnerVerifierFailsLast5d: Number(failCount || 0),
  };
}

function readPreferredOwnerPostCloseProofVerifierRowByTargetDay(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!db || typeof db.prepare !== 'function' || !target) return null;
  try {
    const row = db.prepare(`
      SELECT
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
      FROM jarvis_preferred_owner_post_close_verifier
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target);
    if (!row) return null;
    let failureReasons = [];
    let summary = {};
    try { failureReasons = JSON.parse(String(row.failure_reasons_json || '[]')); } catch {}
    try { summary = JSON.parse(String(row.summary_json || '{}')); } catch {}
    const normalizedFailureReasons = (Array.isArray(failureReasons) ? failureReasons : [])
      .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
      .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
    return {
      targetTradingDay: normalizeDate(row.target_trading_day || '') || null,
      runId: Number(row.run_id || 0) || null,
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      runtimeSource: normalizeFinalizationSweepSource(row.runtime_source || 'manual_api_run'),
      checkpointStatus: normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid'),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(row.verifier_status || 'fail'),
      verifierPass: (
        Number(row.verifier_pass || 0) === 1
        || String(row.verifier_pass || '').trim().toLowerCase() === 'true'
      ),
      failureReasons: normalizedFailureReasons,
      summary: summary && typeof summary === 'object' ? summary : {},
      verifiedAt: toText(row.verified_at || '') || null,
      livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
        row.run_origin || 'manual'
      ),
      livePreferredOwnerPostCloseProofResolvedNaturally: (
        normalizeDailyScoringRunOrigin(row.run_origin || 'manual') === 'natural'
        && normalizeFinalizationSweepSource(row.runtime_source || 'manual_api_run') === 'close_complete_checkpoint'
        && normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid') !== 'waiting_valid'
      ),
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readLatestPreferredOwnerPostCloseProofVerifierRow(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_post_close_verifier
      ORDER BY target_trading_day DESC, verified_at DESC
      LIMIT 1
    `).get();
    if (!row?.target_trading_day) return null;
    return readPreferredOwnerPostCloseProofVerifierRowByTargetDay(db, row.target_trading_day);
  } catch {
    return null;
  }
}

function persistPreferredOwnerPostCloseProofVerifierRow(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!targetTradingDay) return null;
  const runId = Number(input.runId || 0) || null;
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const runtimeSource = normalizeFinalizationSweepSource(input.runtimeSource || 'manual_api_run');
  const checkpointStatus = normalizeCheckpointStatus(input.checkpointStatus || 'waiting_valid');
  const verifierStatus = normalizePreferredOwnerPostCloseProofStatus(input.verifierStatus || 'fail');
  const verifierPass = input.verifierPass === true ? 1 : 0;
  const failureReasons = (Array.isArray(input.failureReasons) ? input.failureReasons : [])
    .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
    .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
  const summary = input.summary && typeof input.summary === 'object'
    ? input.summary
    : {};
  const verifiedAt = toText(input.verifiedAt || new Date().toISOString()) || new Date().toISOString();
  try {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_trading_day) DO NOTHING
    `).run(
      targetTradingDay,
      runId,
      runOrigin,
      runtimeSource,
      checkpointStatus,
      verifierStatus,
      verifierPass,
      JSON.stringify(failureReasons),
      JSON.stringify(summary),
      verifiedAt
    );
  } catch {
    return null;
  }
  return readPreferredOwnerPostCloseProofVerifierRowByTargetDay(db, targetTradingDay);
}

function readPreferredOwnerOperationalVerdictRowByTargetDay(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!db || typeof db.prepare !== 'function' || !target) return null;
  try {
    const row = db.prepare(`
      SELECT
        id,
        target_trading_day,
        run_id,
        run_origin,
        runtime_checkpoint_source,
        checkpoint_status,
        preferred_owner_expected_source,
        preferred_owner_actual_source,
        verifier_status,
        verifier_pass,
        verifier_failure_reasons_json,
        ownership_source_specific_outcome,
        natural_preferred_owner_wins_last5d,
        natural_preferred_owner_wins_total,
        natural_preferred_owner_verifier_passes_last5d,
        natural_preferred_owner_verifier_fails_last5d,
        reported_at
      FROM jarvis_preferred_owner_operational_verdicts
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target);
    if (!row) return null;
    let reasons = [];
    try { reasons = JSON.parse(String(row.verifier_failure_reasons_json || '[]')); } catch {}
    const normalizedReasons = (Array.isArray(reasons) ? reasons : [])
      .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
      .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
    return {
      id: Number(row.id || 0) || null,
      targetTradingDay: normalizeDate(row.target_trading_day || '') || null,
      runId: Number(row.run_id || 0) || null,
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(row.runtime_checkpoint_source || 'manual_api_run'),
      checkpointStatus: normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid'),
      preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
        row.preferred_owner_expected_source || 'close_complete_checkpoint'
      ),
      preferredOwnerActualSource: row.preferred_owner_actual_source
        ? normalizeFinalizationSweepSource(row.preferred_owner_actual_source)
        : null,
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(row.verifier_status || 'fail'),
      verifierPass: (
        Number(row.verifier_pass || 0) === 1
        || String(row.verifier_pass || '').trim().toLowerCase() === 'true'
      ),
      verifierFailureReasons: normalizedReasons,
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        row.ownership_source_specific_outcome || 'ownership_source_unknown'
      ),
      naturalPreferredOwnerWinsLast5d: Number(row.natural_preferred_owner_wins_last5d || 0),
      naturalPreferredOwnerWinsTotal: Number(row.natural_preferred_owner_wins_total || 0),
      naturalPreferredOwnerVerifierPassesLast5d: Number(row.natural_preferred_owner_verifier_passes_last5d || 0),
      naturalPreferredOwnerVerifierFailsLast5d: Number(row.natural_preferred_owner_verifier_fails_last5d || 0),
      reportedAt: toText(row.reported_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readLatestPreferredOwnerOperationalVerdictRow(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_operational_verdicts
      ORDER BY target_trading_day DESC, reported_at DESC
      LIMIT 1
    `).get();
    if (!row?.target_trading_day) return null;
    return readPreferredOwnerOperationalVerdictRowByTargetDay(db, row.target_trading_day);
  } catch {
    return null;
  }
}

function persistPreferredOwnerOperationalVerdictRow(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!targetTradingDay) return null;
  const runId = Number(input.runId || 0) || null;
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const runtimeCheckpointSource = normalizeFinalizationSweepSource(
    input.runtimeCheckpointSource || 'manual_api_run'
  );
  const checkpointStatus = normalizeCheckpointStatus(input.checkpointStatus || 'waiting_valid');
  const preferredOwnerExpectedSource = normalizeFinalizationSweepSource(
    input.preferredOwnerExpectedSource || 'close_complete_checkpoint'
  );
  const preferredOwnerActualSource = input.preferredOwnerActualSource
    ? normalizeFinalizationSweepSource(input.preferredOwnerActualSource)
    : null;
  const verifierStatus = normalizePreferredOwnerPostCloseProofStatus(input.verifierStatus || 'fail');
  const verifierPass = input.verifierPass === true ? 1 : 0;
  const verifierFailureReasons = (Array.isArray(input.verifierFailureReasons) ? input.verifierFailureReasons : [])
    .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
    .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
  const ownershipSourceSpecificOutcome = normalizeLiveInsertionOwnershipSourceSpecificOutcome(
    input.ownershipSourceSpecificOutcome || 'ownership_source_unknown'
  );
  const naturalPreferredOwnerWinsLast5d = Number(input.naturalPreferredOwnerWinsLast5d || 0);
  const naturalPreferredOwnerWinsTotal = Number(input.naturalPreferredOwnerWinsTotal || 0);
  const naturalPreferredOwnerVerifierPassesLast5d = Number(
    input.naturalPreferredOwnerVerifierPassesLast5d || 0
  );
  const naturalPreferredOwnerVerifierFailsLast5d = Number(
    input.naturalPreferredOwnerVerifierFailsLast5d || 0
  );
  const reportedAt = toText(input.reportedAt || new Date().toISOString()) || new Date().toISOString();
  let existingId = null;
  try {
    const existing = db.prepare(`
      SELECT id
      FROM jarvis_preferred_owner_operational_verdicts
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(targetTradingDay);
    existingId = Number(existing?.id || 0) || null;
  } catch {}
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_operational_verdicts (
        target_trading_day,
        run_id,
        run_origin,
        runtime_checkpoint_source,
        checkpoint_status,
        preferred_owner_expected_source,
        preferred_owner_actual_source,
        verifier_status,
        verifier_pass,
        verifier_failure_reasons_json,
        ownership_source_specific_outcome,
        natural_preferred_owner_wins_last5d,
        natural_preferred_owner_wins_total,
        natural_preferred_owner_verifier_passes_last5d,
        natural_preferred_owner_verifier_fails_last5d,
        reported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_trading_day) DO NOTHING
    `).run(
      targetTradingDay,
      runId,
      runOrigin,
      runtimeCheckpointSource,
      checkpointStatus,
      preferredOwnerExpectedSource,
      preferredOwnerActualSource,
      verifierStatus,
      verifierPass,
      JSON.stringify(verifierFailureReasons),
      ownershipSourceSpecificOutcome,
      naturalPreferredOwnerWinsLast5d,
      naturalPreferredOwnerWinsTotal,
      naturalPreferredOwnerVerifierPassesLast5d,
      naturalPreferredOwnerVerifierFailsLast5d,
      reportedAt
    );
  } catch {
    return null;
  }
  const row = readPreferredOwnerOperationalVerdictRowByTargetDay(db, targetTradingDay);
  if (!row) return null;
  return {
    ...row,
    wasNewRowPersisted: existingId === null,
    previousRowId: existingId,
    advisoryOnly: true,
  };
}

function capturePreferredOwnerLatestOperationalVerdict(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      livePreferredOwnerLatestOperationalVerdict: null,
      livePreferredOwnerLatestOperationalVerdictCapturedThisRun: false,
      livePreferredOwnerLatestOperationalVerdictSkipReason: 'storage_unavailable',
      advisoryOnly: true,
    };
  }
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const livePreferredOwnerProof = input.livePreferredOwnerProof && typeof input.livePreferredOwnerProof === 'object'
    ? input.livePreferredOwnerProof
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const livePreferredOwnerPostCloseProofVerifier = (
    input.livePreferredOwnerPostCloseProofVerifier
    && typeof input.livePreferredOwnerPostCloseProofVerifier === 'object'
  )
    ? input.livePreferredOwnerPostCloseProofVerifier
    : {};
  const livePreferredOwnerNaturalWinMetrics = (
    input.livePreferredOwnerNaturalWinMetrics
    && typeof input.livePreferredOwnerNaturalWinMetrics === 'object'
  )
    ? input.livePreferredOwnerNaturalWinMetrics
    : {};
  const livePreferredOwnerVerifierMetrics = (
    input.livePreferredOwnerVerifierMetrics
    && typeof input.livePreferredOwnerVerifierMetrics === 'object'
  )
    ? input.livePreferredOwnerVerifierMetrics
    : {};
  const runId = Number(input.runId || 0) || null;
  const targetTradingDay = normalizeDate(
    livePreferredOwnerPostCloseProofVerifier.targetTradingDay
    || liveCheckpoint.targetTradingDay
    || livePreferredOwnerProof.livePreferredOwnerTargetTradingDay
    || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || ''
  ) || null;
  const checkpointStatus = normalizeCheckpointStatus(liveCheckpoint.checkpointStatus || 'waiting_valid');
  const runtimeCheckpointSource = normalizeFinalizationSweepSource(
    liveCheckpoint.runtimeCheckpointSource
    || liveCheckpoint.sweepSource
    || livePreferredOwnerPostCloseProofVerifier.runtimeSource
    || 'manual_api_run'
  );
  const latestVerdict = readLatestPreferredOwnerOperationalVerdictRow(db);
  if (runOrigin !== 'natural') {
    return {
      livePreferredOwnerLatestOperationalVerdict: latestVerdict,
      livePreferredOwnerLatestOperationalVerdictCapturedThisRun: false,
      livePreferredOwnerLatestOperationalVerdictSkipReason: 'run_origin_not_natural',
      advisoryOnly: true,
    };
  }
  if (!targetTradingDay) {
    return {
      livePreferredOwnerLatestOperationalVerdict: latestVerdict,
      livePreferredOwnerLatestOperationalVerdictCapturedThisRun: false,
      livePreferredOwnerLatestOperationalVerdictSkipReason: 'target_day_missing',
      advisoryOnly: true,
    };
  }
  if (checkpointStatus === 'waiting_valid') {
    return {
      livePreferredOwnerLatestOperationalVerdict: latestVerdict,
      livePreferredOwnerLatestOperationalVerdictCapturedThisRun: false,
      livePreferredOwnerLatestOperationalVerdictSkipReason: 'checkpoint_not_resolved',
      advisoryOnly: true,
    };
  }
  const persistedVerifierRow = readPreferredOwnerPostCloseProofVerifierRowByTargetDay(db, targetTradingDay);
  const verifierResolvedNaturally = (
    persistedVerifierRow
    && normalizeDailyScoringRunOrigin(persistedVerifierRow.runOrigin || 'manual') === 'natural'
    && normalizeFinalizationSweepSource(persistedVerifierRow.runtimeSource || 'manual_api_run')
      === 'close_complete_checkpoint'
    && normalizeCheckpointStatus(persistedVerifierRow.checkpointStatus || 'waiting_valid') !== 'waiting_valid'
  );
  if (!verifierResolvedNaturally) {
    return {
      livePreferredOwnerLatestOperationalVerdict: latestVerdict,
      livePreferredOwnerLatestOperationalVerdictCapturedThisRun: false,
      livePreferredOwnerLatestOperationalVerdictSkipReason: 'verifier_row_missing_or_not_natural_resolved',
      advisoryOnly: true,
    };
  }
  const persistedProofRow = readLivePreferredOwnerProofRow(db, targetTradingDay);
  const persistedOwnershipRow = readLiveInsertionOwnershipRow(db, targetTradingDay);
  const sourceSpecificOutcome = normalizeLiveInsertionOwnershipSourceSpecificOutcome(
    persistedProofRow?.first_creation_ownership_source_specific_outcome
    || classifyOwnershipSourceSpecificOutcome({
      targetTradingDay,
      tradingDayClassification: liveCheckpoint.tradingDayClassification || 'invalid_mapping',
      firstInsertedBySource: persistedOwnershipRow?.first_run_source || persistedProofRow?.first_creator_source || '',
      firstInsertedAutonomous: (
        Number(
          persistedOwnershipRow?.first_inserted_autonomous
          || persistedProofRow?.first_creator_autonomous
          || 0
        ) === 1
      ),
      firstRunMode: toText(
        persistedOwnershipRow?.first_run_mode
        || persistedProofRow?.first_creator_mode
        || ''
      ),
      ownershipOutcome: normalizeLiveInsertionOwnershipOutcome(
        persistedProofRow?.first_creation_ownership_outcome
        || liveInsertionOwnership.liveInsertionOwnershipOutcome
        || 'target_day_not_inserted_yet'
      ),
    })
  );
  const verdictRow = persistPreferredOwnerOperationalVerdictRow(db, {
    targetTradingDay,
    runId,
    runOrigin,
    runtimeCheckpointSource,
    checkpointStatus,
    preferredOwnerExpectedSource: persistedProofRow?.preferred_owner_expected_source
      || livePreferredOwnerProof.livePreferredOwnerExpectedSource
      || 'close_complete_checkpoint',
    preferredOwnerActualSource: persistedProofRow?.first_creator_source
      || livePreferredOwnerProof.livePreferredOwnerActualSource
      || null,
    verifierStatus: persistedVerifierRow.verifierStatus || livePreferredOwnerPostCloseProofVerifier.verifierStatus || 'fail',
    verifierPass: persistedVerifierRow.verifierPass === true,
    verifierFailureReasons: persistedVerifierRow.failureReasons || [],
    ownershipSourceSpecificOutcome: sourceSpecificOutcome,
    naturalPreferredOwnerWinsLast5d: Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsLast5d || 0),
    naturalPreferredOwnerWinsTotal: Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsTotal || 0),
    naturalPreferredOwnerVerifierPassesLast5d: Number(
      livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierPassesLast5d || 0
    ),
    naturalPreferredOwnerVerifierFailsLast5d: Number(
      livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierFailsLast5d || 0
    ),
    reportedAt: new Date().toISOString(),
  });
  const latestAfterCapture = readLatestPreferredOwnerOperationalVerdictRow(db);
  return {
    livePreferredOwnerLatestOperationalVerdict: verdictRow || latestAfterCapture || latestVerdict,
    livePreferredOwnerLatestOperationalVerdictCapturedThisRun: verdictRow?.wasNewRowPersisted === true,
    livePreferredOwnerLatestOperationalVerdictSkipReason: verdictRow
      ? 'captured_or_existing_for_target_day'
      : 'capture_failed',
    advisoryOnly: true,
  };
}

function readPreferredOwnerOperationalProofBundleRowByTargetDay(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!db || typeof db.prepare !== 'function' || !target) return null;
  try {
    const row = db.prepare(`
      SELECT
        id,
        target_trading_day,
        run_id,
        run_origin,
        checkpoint_status,
        checkpoint_reason,
        runtime_checkpoint_source,
        preferred_owner_expected_source,
        preferred_owner_actual_source,
        preferred_owner_won,
        preferred_owner_failure_reason,
        ownership_source_specific_outcome,
        verifier_status,
        verifier_pass,
        verifier_failure_reasons_json,
        natural_preferred_owner_wins_last5d,
        natural_preferred_owner_wins_total,
        natural_preferred_owner_verifier_passes_last5d,
        natural_preferred_owner_verifier_fails_last5d,
        captured_at
      FROM jarvis_preferred_owner_operational_proof_bundles
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(target);
    if (!row) return null;
    let reasons = [];
    try { reasons = JSON.parse(String(row.verifier_failure_reasons_json || '[]')); } catch {}
    const normalizedReasons = (Array.isArray(reasons) ? reasons : [])
      .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
      .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
    return {
      id: Number(row.id || 0) || null,
      targetTradingDay: normalizeDate(row.target_trading_day || '') || null,
      runId: Number(row.run_id || 0) || null,
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      checkpointStatus: normalizeCheckpointStatus(row.checkpoint_status || 'waiting_valid'),
      checkpointReason: normalizeCheckpointReason(row.checkpoint_reason || 'unknown_checkpoint_state'),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(row.runtime_checkpoint_source || 'manual_api_run'),
      preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
        row.preferred_owner_expected_source || 'close_complete_checkpoint'
      ),
      preferredOwnerActualSource: row.preferred_owner_actual_source
        ? normalizeFinalizationSweepSource(row.preferred_owner_actual_source)
        : null,
      preferredOwnerWon: (
        Number(row.preferred_owner_won || 0) === 1
        || String(row.preferred_owner_won || '').trim().toLowerCase() === 'true'
      ),
      preferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
        row.preferred_owner_failure_reason || 'none'
      ),
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        row.ownership_source_specific_outcome || 'ownership_source_unknown'
      ),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(row.verifier_status || 'fail'),
      verifierPass: (
        Number(row.verifier_pass || 0) === 1
        || String(row.verifier_pass || '').trim().toLowerCase() === 'true'
      ),
      verifierFailureReasons: normalizedReasons,
      naturalPreferredOwnerWinsLast5d: Number(row.natural_preferred_owner_wins_last5d || 0),
      naturalPreferredOwnerWinsTotal: Number(row.natural_preferred_owner_wins_total || 0),
      naturalPreferredOwnerVerifierPassesLast5d: Number(row.natural_preferred_owner_verifier_passes_last5d || 0),
      naturalPreferredOwnerVerifierFailsLast5d: Number(row.natural_preferred_owner_verifier_fails_last5d || 0),
      capturedAt: toText(row.captured_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readLatestPreferredOwnerOperationalProofBundleRow(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_operational_proof_bundles
      ORDER BY target_trading_day DESC, captured_at DESC
      LIMIT 1
    `).get();
    if (!row?.target_trading_day) return null;
    return readPreferredOwnerOperationalProofBundleRowByTargetDay(db, row.target_trading_day);
  } catch {
    return null;
  }
}

function readPreferredOwnerNaturalDrillWatchRunRowByTargetDay(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay || '');
  if (!db || typeof db.prepare !== 'function' || !target) return null;
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
      id: Number(row.id || 0) || null,
      targetTradingDay: normalizeDate(row.target_trading_day || '') || null,
      triggerRunId: Number(row.trigger_run_id || 0) || null,
      triggerRunOrigin: normalizeDailyScoringRunOrigin(row.trigger_run_origin || 'manual'),
      triggerRuntimeSource: normalizeFinalizationSweepSource(row.trigger_runtime_source || 'manual_api_run'),
      preTransitionCheckpointStatus: normalizeCheckpointStatus(
        row.pre_transition_checkpoint_status || 'waiting_valid'
      ),
      postTransitionCheckpointStatus: normalizeCheckpointStatus(
        row.post_transition_checkpoint_status || 'waiting_valid'
      ),
      drillOutcome: toText(row.drill_outcome || '').trim().toLowerCase() || null,
      executed: (
        Number(row.executed || 0) === 1
        || String(row.executed || '').trim().toLowerCase() === 'true'
      ),
      executedAt: toText(row.executed_at || '') || null,
      createdAt: toText(row.created_at || '') || null,
      advisoryOnly: true,
    };
  } catch {
    return null;
  }
}

function readLatestPreferredOwnerNaturalDrillWatchRunRow(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`
      SELECT target_trading_day
      FROM jarvis_preferred_owner_natural_drill_watch_runs
      ORDER BY target_trading_day DESC, id DESC
      LIMIT 1
    `).get();
    if (!row?.target_trading_day) return null;
    return readPreferredOwnerNaturalDrillWatchRunRowByTargetDay(db, row.target_trading_day);
  } catch {
    return null;
  }
}

function persistPreferredOwnerOperationalProofBundleRow(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!targetTradingDay) return null;
  const runId = Number(input.runId || 0) || null;
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const checkpointStatus = normalizeCheckpointStatus(input.checkpointStatus || 'waiting_valid');
  const checkpointReason = normalizeCheckpointReason(input.checkpointReason || 'unknown_checkpoint_state');
  const runtimeCheckpointSource = normalizeFinalizationSweepSource(
    input.runtimeCheckpointSource || 'manual_api_run'
  );
  const preferredOwnerExpectedSource = normalizeFinalizationSweepSource(
    input.preferredOwnerExpectedSource || 'close_complete_checkpoint'
  );
  const preferredOwnerActualSource = input.preferredOwnerActualSource
    ? normalizeFinalizationSweepSource(input.preferredOwnerActualSource)
    : null;
  const preferredOwnerWon = input.preferredOwnerWon === true ? 1 : 0;
  const preferredOwnerFailureReason = normalizeLivePreferredOwnerFailureReason(
    input.preferredOwnerFailureReason || 'none'
  );
  const ownershipSourceSpecificOutcome = normalizeLiveInsertionOwnershipSourceSpecificOutcome(
    input.ownershipSourceSpecificOutcome || 'ownership_source_unknown'
  );
  const verifierStatus = normalizePreferredOwnerPostCloseProofStatus(input.verifierStatus || 'fail');
  const verifierPass = input.verifierPass === true ? 1 : 0;
  const verifierFailureReasons = (Array.isArray(input.verifierFailureReasons) ? input.verifierFailureReasons : [])
    .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
    .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
  const naturalPreferredOwnerWinsLast5d = Number(input.naturalPreferredOwnerWinsLast5d || 0);
  const naturalPreferredOwnerWinsTotal = Number(input.naturalPreferredOwnerWinsTotal || 0);
  const naturalPreferredOwnerVerifierPassesLast5d = Number(
    input.naturalPreferredOwnerVerifierPassesLast5d || 0
  );
  const naturalPreferredOwnerVerifierFailsLast5d = Number(
    input.naturalPreferredOwnerVerifierFailsLast5d || 0
  );
  const capturedAt = toText(input.capturedAt || new Date().toISOString()) || new Date().toISOString();
  let existingId = null;
  try {
    const existing = db.prepare(`
      SELECT id
      FROM jarvis_preferred_owner_operational_proof_bundles
      WHERE target_trading_day = ?
      LIMIT 1
    `).get(targetTradingDay);
    existingId = Number(existing?.id || 0) || null;
  } catch {}
  try {
    db.prepare(`
      INSERT INTO jarvis_preferred_owner_operational_proof_bundles (
        target_trading_day,
        run_id,
        run_origin,
        checkpoint_status,
        checkpoint_reason,
        runtime_checkpoint_source,
        preferred_owner_expected_source,
        preferred_owner_actual_source,
        preferred_owner_won,
        preferred_owner_failure_reason,
        ownership_source_specific_outcome,
        verifier_status,
        verifier_pass,
        verifier_failure_reasons_json,
        natural_preferred_owner_wins_last5d,
        natural_preferred_owner_wins_total,
        natural_preferred_owner_verifier_passes_last5d,
        natural_preferred_owner_verifier_fails_last5d,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_trading_day) DO NOTHING
    `).run(
      targetTradingDay,
      runId,
      runOrigin,
      checkpointStatus,
      checkpointReason,
      runtimeCheckpointSource,
      preferredOwnerExpectedSource,
      preferredOwnerActualSource,
      preferredOwnerWon,
      preferredOwnerFailureReason,
      ownershipSourceSpecificOutcome,
      verifierStatus,
      verifierPass,
      JSON.stringify(verifierFailureReasons),
      naturalPreferredOwnerWinsLast5d,
      naturalPreferredOwnerWinsTotal,
      naturalPreferredOwnerVerifierPassesLast5d,
      naturalPreferredOwnerVerifierFailsLast5d,
      capturedAt
    );
  } catch {
    return null;
  }
  const row = readPreferredOwnerOperationalProofBundleRowByTargetDay(db, targetTradingDay);
  if (!row) return null;
  return {
    ...row,
    wasNewRowPersisted: existingId === null,
    previousRowId: existingId,
    advisoryOnly: true,
  };
}

function capturePreferredOwnerOperationalProofBundle(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      livePreferredOwnerOperationalProofBundle: null,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'storage_unavailable',
      advisoryOnly: true,
    };
  }
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const runtimeCheckpointSource = normalizeFinalizationSweepSource(
    liveCheckpoint.runtimeCheckpointSource
    || liveCheckpoint.sweepSource
    || 'manual_api_run'
  );
  const checkpointStatus = normalizeCheckpointStatus(liveCheckpoint.checkpointStatus || 'waiting_valid');
  const checkpointReason = normalizeCheckpointReason(liveCheckpoint.checkpointReason || 'unknown_checkpoint_state');
  const targetTradingDay = normalizeDate(
    liveCheckpoint.targetTradingDay
    || input.targetTradingDay
    || ''
  ) || null;
  const latestBundle = readLatestPreferredOwnerOperationalProofBundleRow(db);
  if (runOrigin !== 'natural') {
    return {
      livePreferredOwnerOperationalProofBundle: latestBundle,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'run_origin_not_natural',
      advisoryOnly: true,
    };
  }
  if (runtimeCheckpointSource !== 'close_complete_checkpoint') {
    return {
      livePreferredOwnerOperationalProofBundle: latestBundle,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'runtime_source_not_close_complete_checkpoint',
      advisoryOnly: true,
    };
  }
  if (!targetTradingDay) {
    return {
      livePreferredOwnerOperationalProofBundle: latestBundle,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'target_day_missing',
      advisoryOnly: true,
    };
  }
  if (checkpointStatus === 'waiting_valid') {
    return {
      livePreferredOwnerOperationalProofBundle: latestBundle,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'checkpoint_not_resolved',
      advisoryOnly: true,
    };
  }
  const verifierRow = readPreferredOwnerPostCloseProofVerifierRowByTargetDay(db, targetTradingDay);
  if (!verifierRow) {
    return {
      livePreferredOwnerOperationalProofBundle: latestBundle,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'verifier_row_missing',
      advisoryOnly: true,
    };
  }
  let operationalVerdict = readPreferredOwnerOperationalVerdictRowByTargetDay(db, targetTradingDay);
  if (!operationalVerdict) {
    const fallbackPersisted = persistPreferredOwnerOperationalVerdictRow(db, {
      targetTradingDay,
      runId: Number(input.runId || 0) || null,
      runOrigin,
      runtimeCheckpointSource,
      checkpointStatus,
      preferredOwnerExpectedSource: input.livePreferredOwnerProof?.livePreferredOwnerExpectedSource
        || 'close_complete_checkpoint',
      preferredOwnerActualSource: input.livePreferredOwnerProof?.livePreferredOwnerActualSource || null,
      verifierStatus: verifierRow.verifierStatus || 'fail',
      verifierPass: verifierRow.verifierPass === true,
      verifierFailureReasons: verifierRow.failureReasons || [],
      ownershipSourceSpecificOutcome: (
        input.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome
        || 'ownership_source_unknown'
      ),
      naturalPreferredOwnerWinsLast5d: Number(
        input.livePreferredOwnerNaturalWinMetrics?.naturalPreferredOwnerWinsLast5d || 0
      ),
      naturalPreferredOwnerWinsTotal: Number(
        input.livePreferredOwnerNaturalWinMetrics?.naturalPreferredOwnerWinsTotal || 0
      ),
      naturalPreferredOwnerVerifierPassesLast5d: Number(
        input.livePreferredOwnerVerifierMetrics?.naturalPreferredOwnerVerifierPassesLast5d || 0
      ),
      naturalPreferredOwnerVerifierFailsLast5d: Number(
        input.livePreferredOwnerVerifierMetrics?.naturalPreferredOwnerVerifierFailsLast5d || 0
      ),
      reportedAt: new Date().toISOString(),
    });
    operationalVerdict = fallbackPersisted || readPreferredOwnerOperationalVerdictRowByTargetDay(db, targetTradingDay);
  }
  if (!operationalVerdict) {
    return {
      livePreferredOwnerOperationalProofBundle: latestBundle,
      livePreferredOwnerOperationalProofBundleCapturedThisRun: false,
      livePreferredOwnerOperationalProofBundleSkipReason: 'operational_verdict_missing',
      advisoryOnly: true,
    };
  }
  const preferredOwnerProof = readLivePreferredOwnerProofRow(db, targetTradingDay);
  const proofBundleRow = persistPreferredOwnerOperationalProofBundleRow(db, {
    targetTradingDay,
    runId: Number(input.runId || 0) || verifierRow.runId || null,
    runOrigin,
    checkpointStatus,
    checkpointReason,
    runtimeCheckpointSource,
    preferredOwnerExpectedSource: preferredOwnerProof?.preferred_owner_expected_source
      || input.livePreferredOwnerProof?.livePreferredOwnerExpectedSource
      || operationalVerdict.preferredOwnerExpectedSource
      || 'close_complete_checkpoint',
    preferredOwnerActualSource: preferredOwnerProof?.first_creator_source
      || input.livePreferredOwnerProof?.livePreferredOwnerActualSource
      || operationalVerdict.preferredOwnerActualSource
      || null,
    preferredOwnerWon: (
      Number(preferredOwnerProof?.preferred_owner_won || 0) === 1
      || input.livePreferredOwnerProof?.livePreferredOwnerWon === true
    ),
    preferredOwnerFailureReason: preferredOwnerProof?.preferred_owner_failure_reason
      || input.livePreferredOwnerProof?.livePreferredOwnerFailureReason
      || 'none',
    ownershipSourceSpecificOutcome: preferredOwnerProof?.first_creation_ownership_source_specific_outcome
      || input.liveInsertionOwnership?.liveInsertionOwnershipSourceSpecificOutcome
      || operationalVerdict.ownershipSourceSpecificOutcome
      || 'ownership_source_unknown',
    verifierStatus: verifierRow.verifierStatus || operationalVerdict.verifierStatus || 'fail',
    verifierPass: verifierRow.verifierPass === true,
    verifierFailureReasons: verifierRow.failureReasons || [],
    naturalPreferredOwnerWinsLast5d: Number(
      input.livePreferredOwnerNaturalWinMetrics?.naturalPreferredOwnerWinsLast5d
      || operationalVerdict.naturalPreferredOwnerWinsLast5d
      || 0
    ),
    naturalPreferredOwnerWinsTotal: Number(
      input.livePreferredOwnerNaturalWinMetrics?.naturalPreferredOwnerWinsTotal
      || operationalVerdict.naturalPreferredOwnerWinsTotal
      || 0
    ),
    naturalPreferredOwnerVerifierPassesLast5d: Number(
      input.livePreferredOwnerVerifierMetrics?.naturalPreferredOwnerVerifierPassesLast5d
      || operationalVerdict.naturalPreferredOwnerVerifierPassesLast5d
      || 0
    ),
    naturalPreferredOwnerVerifierFailsLast5d: Number(
      input.livePreferredOwnerVerifierMetrics?.naturalPreferredOwnerVerifierFailsLast5d
      || operationalVerdict.naturalPreferredOwnerVerifierFailsLast5d
      || 0
    ),
    capturedAt: new Date().toISOString(),
  });
  const latestAfterCapture = readLatestPreferredOwnerOperationalProofBundleRow(db);
  return {
    livePreferredOwnerOperationalProofBundle: proofBundleRow || latestAfterCapture || latestBundle,
    livePreferredOwnerOperationalProofBundleCapturedThisRun: proofBundleRow?.wasNewRowPersisted === true,
    livePreferredOwnerOperationalProofBundleSkipReason: proofBundleRow
      ? 'captured_or_existing_for_target_day'
      : 'capture_failed',
    advisoryOnly: true,
  };
}

function buildPreferredOwnerPostCloseProofVerifier(input = {}) {
  const db = input.db;
  const runId = Number(input.runId || 0) || null;
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || 'manual');
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const livePreferredOwnerProof = input.livePreferredOwnerProof && typeof input.livePreferredOwnerProof === 'object'
    ? input.livePreferredOwnerProof
    : {};
  const livePreferredOwnerReservation = input.livePreferredOwnerReservation && typeof input.livePreferredOwnerReservation === 'object'
    ? input.livePreferredOwnerReservation
    : {};
  const livePreferredOwnerMetrics = input.livePreferredOwnerMetrics && typeof input.livePreferredOwnerMetrics === 'object'
    ? input.livePreferredOwnerMetrics
    : {};
  const livePreferredOwnerNaturalWinMetrics = input.livePreferredOwnerNaturalWinMetrics && typeof input.livePreferredOwnerNaturalWinMetrics === 'object'
    ? input.livePreferredOwnerNaturalWinMetrics
    : {};
  const livePreferredOwnerVerifierMetrics = input.livePreferredOwnerVerifierMetrics
    && typeof input.livePreferredOwnerVerifierMetrics === 'object'
    ? input.livePreferredOwnerVerifierMetrics
    : {};

  const targetTradingDay = normalizeDate(
    liveCheckpoint.targetTradingDay
    || livePreferredOwnerProof.livePreferredOwnerTargetTradingDay
    || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || ''
  ) || null;
  const runtimeSource = normalizeFinalizationSweepSource(
    liveCheckpoint.runtimeCheckpointSource
    || liveCheckpoint.sweepSource
    || ''
  );
  const checkpointStatus = normalizeCheckpointStatus(
    liveCheckpoint.checkpointStatus || 'waiting_valid'
  );
  const tradingDayClassification = normalizeTradingDayClassification(
    liveCheckpoint.tradingDayClassification || 'invalid_mapping'
  );
  const cycleResolved = checkpointStatus !== 'waiting_valid';
  const isNaturalCloseCompleteCycle = (
    runOrigin === 'natural'
    && runtimeSource === 'close_complete_checkpoint'
    && !!targetTradingDay
    && tradingDayClassification === 'valid_trading_day'
    && cycleResolved
  );
  if (!isNaturalCloseCompleteCycle) return null;

  const existingForTarget = readPreferredOwnerPostCloseProofVerifierRowByTargetDay(db, targetTradingDay);
  if (existingForTarget) {
    return {
      ...existingForTarget,
      livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
        existingForTarget.runOrigin || 'manual'
      ),
      livePreferredOwnerPostCloseProofResolvedNaturally: (
        normalizeDailyScoringRunOrigin(existingForTarget.runOrigin || 'manual') === 'natural'
        && normalizeFinalizationSweepSource(existingForTarget.runtimeSource || 'manual_api_run') === 'close_complete_checkpoint'
        && normalizeCheckpointStatus(existingForTarget.checkpointStatus || 'waiting_valid') !== 'waiting_valid'
      ),
      verifierPersistedThisRun: false,
      advisoryOnly: true,
    };
  }

  const proofRow = readLivePreferredOwnerProofRow(db, targetTradingDay);
  const ownershipRow = readLiveInsertionOwnershipRow(db, targetTradingDay);
  const preferredOwnerWon = (
    Number(proofRow?.preferred_owner_won || 0) === 1
    || String(proofRow?.preferred_owner_won || '').trim().toLowerCase() === 'true'
  );
  const proofFailureReason = normalizeLivePreferredOwnerFailureReason(
    proofRow?.preferred_owner_failure_reason || 'none'
  );
  const rawSourceSpecific = normalizeLiveInsertionOwnershipSourceSpecificOutcome(
    proofRow?.first_creation_ownership_source_specific_outcome
    || liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome
    || 'ownership_source_unknown'
  );
  const derivedSourceSpecific = classifyOwnershipSourceSpecificOutcome({
    targetTradingDay,
    tradingDayClassification,
    firstInsertedBySource: ownershipRow?.first_run_source || proofRow?.first_creator_source || '',
    firstInsertedAutonomous: (
      Number(ownershipRow?.first_inserted_autonomous || proofRow?.first_creator_autonomous || 0) === 1
      || String(ownershipRow?.first_inserted_autonomous || proofRow?.first_creator_autonomous || '').trim().toLowerCase() === 'true'
    ),
    firstRunMode: toText(ownershipRow?.first_run_mode || proofRow?.first_creator_mode || ''),
    ownershipOutcome: normalizeLiveInsertionOwnershipOutcome(
      proofRow?.first_creation_ownership_outcome
      || liveInsertionOwnership.liveInsertionOwnershipOutcome
      || 'already_inserted_before_this_cycle'
    ),
  });
  const sourceSpecificOutcome = (
    rawSourceSpecific === 'ownership_source_unknown'
      ? derivedSourceSpecific
      : rawSourceSpecific
  );
  const ownershipIsPreferred = isCloseCompleteOwnershipSourceSpecificOutcome(
    sourceSpecificOutcome
  );
  let naturalWinRows = [];
  try {
    naturalWinRows = db.prepare(`
      SELECT id, target_trading_day, run_id, first_creator_source, run_origin, timestamp
      FROM jarvis_preferred_owner_natural_wins
      WHERE target_trading_day = ?
        AND lower(run_origin) = 'natural'
      ORDER BY id ASC
    `).all(targetTradingDay);
  } catch {}
  const naturalWinRowCount = Array.isArray(naturalWinRows) ? naturalWinRows.length : 0;
  const naturalWinRow = naturalWinRowCount > 0 ? naturalWinRows[0] : null;
  const naturalWinRowSourceSpecificOutcome = normalizeLiveInsertionOwnershipSourceSpecificOutcome(
    naturalWinRow?.first_creator_source
      ? classifyOwnershipSourceSpecificOutcome({
        targetTradingDay,
        tradingDayClassification,
        firstInsertedBySource: naturalWinRow.first_creator_source,
        firstInsertedAutonomous: true,
        firstRunMode: 'scheduled_close_complete_checkpoint',
        ownershipOutcome: 'first_autonomous_insert_of_day',
      })
      : 'ownership_source_unknown'
  );
  let naturalDeferrals = [];
  try {
    naturalDeferrals = db.prepare(`
      SELECT id
      FROM jarvis_preferred_owner_deferrals
      WHERE target_trading_day = ?
        AND lower(run_origin) = 'natural'
      ORDER BY id DESC
    `).all(targetTradingDay);
  } catch {}
  const naturalDeferralCount = Array.isArray(naturalDeferrals) ? naturalDeferrals.length : 0;
  const fallbackPreemptionDetected = (
    proofFailureReason === 'manual_owner_preempted'
    || proofFailureReason === 'startup_owner_preempted_before_close_complete'
    || proofFailureReason === 'existing_row_before_preferred_owner'
    || (
      ownershipIsPreferred !== true
      && normalizeFinalizationSweepSource(
        ownershipRow?.first_run_source
        || proofRow?.first_creator_source
        || ''
      ) !== 'close_complete_checkpoint'
      && Number(ownershipRow?.created_row_id || proofRow?.first_row_id || 0) > 0
    )
  );
  const targetDayMatch = (
    normalizeDate(proofRow?.target_trading_day || '') === targetTradingDay
    && (naturalWinRowCount === 0 || normalizeDate(naturalWinRow?.target_trading_day || '') === targetTradingDay)
  );
  const persistedNaturalWinMetrics = readPreferredOwnerNaturalWinMetrics(db, targetTradingDay);
  const persistedVerifierMetrics = readPreferredOwnerVerifierMetrics(db, targetTradingDay);
  const countersFromProofTable = (
    Number(persistedNaturalWinMetrics.naturalPreferredOwnerWinsLast5d || 0)
      === Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsLast5d || 0)
    && Number(persistedNaturalWinMetrics.naturalPreferredOwnerWinsTotal || 0)
      === Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsTotal || 0)
    && String(persistedNaturalWinMetrics.lastNaturalPreferredOwnerWinDay || '')
      === String(livePreferredOwnerNaturalWinMetrics.lastNaturalPreferredOwnerWinDay || '')
    && Number(persistedVerifierMetrics.naturalPreferredOwnerVerifierPassesLast5d || 0)
      === Number(livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierPassesLast5d || 0)
    && Number(persistedVerifierMetrics.naturalPreferredOwnerVerifierFailsLast5d || 0)
      === Number(livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierFailsLast5d || 0)
  );
  const kpiSourceProofTable = (
    String(livePreferredOwnerMetrics.livePreferredOwnerKpiSource || '').trim().toLowerCase()
      === 'jarvis_live_preferred_owner_proof'
  );
  const proofRowPresent = Number(proofRow?.proof_row_id || 0) > 0;

  const failureReasons = [];
  if (!targetDayMatch) failureReasons.push('target_day_mismatch');
  if (!proofRowPresent) failureReasons.push('proof_row_missing');
  if (!preferredOwnerWon) failureReasons.push('preferred_owner_not_winner');
  if (!ownershipIsPreferred) failureReasons.push('ownership_source_specific_mismatch');
  if (naturalWinRowCount === 0) failureReasons.push('natural_win_row_missing');
  if (naturalWinRowCount > 1) failureReasons.push('natural_win_row_duplicate');
  if (naturalWinRowCount === 1 && naturalWinRowSourceSpecificOutcome !== 'first_autonomous_insert_by_close_complete_checkpoint') {
    failureReasons.push('ownership_source_specific_mismatch');
  }
  if (fallbackPreemptionDetected) failureReasons.push('fallback_preemption_detected');
  if (!countersFromProofTable || !kpiSourceProofTable) failureReasons.push('kpi_table_mismatch');
  const normalizedFailureReasons = failureReasons
    .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
    .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx);
  const pass = normalizedFailureReasons.length === 0;
  const summary = {
    targetTradingDay,
    runId,
    runOrigin,
    runtimeSource,
    checkpointStatus,
    livePreferredOwnerWon: preferredOwnerWon,
    liveInsertionOwnershipSourceSpecificOutcome: sourceSpecificOutcome,
    naturalWinRowCount,
    naturalWinRowPersistedThisRun: naturalWinRowCount === 1,
    noFallbackPreemption: fallbackPreemptionDetected !== true,
    naturalDeferralCount,
    commandCenterCountersFromProofTablesOnly: countersFromProofTable,
    livePreferredOwnerKpiSourceFromProofTable: kpiSourceProofTable,
    commandCenterKpiSource: toText(livePreferredOwnerMetrics.livePreferredOwnerKpiSource || '') || 'unknown',
    proofRowPresent: proofRowPresent === true,
    targetDayMatch: targetDayMatch === true,
    naturalWinCountersFromStatus: {
      last5d: Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsLast5d || 0),
      total: Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsTotal || 0),
      lastDay: livePreferredOwnerNaturalWinMetrics.lastNaturalPreferredOwnerWinDay || null,
    },
    naturalWinCountersFromTable: persistedNaturalWinMetrics,
    naturalVerifierCountersFromStatus: {
      passesLast5d: Number(livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierPassesLast5d || 0),
      failsLast5d: Number(livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierFailsLast5d || 0),
    },
    naturalVerifierCountersFromTable: persistedVerifierMetrics,
    advisoryOnly: true,
  };

  const persisted = persistPreferredOwnerPostCloseProofVerifierRow(db, {
    targetTradingDay,
    runId,
    runOrigin,
    runtimeSource,
    checkpointStatus,
    verifierStatus: pass ? 'pass' : 'fail',
    verifierPass: pass,
    failureReasons: normalizedFailureReasons,
    summary,
    verifiedAt: new Date().toISOString(),
  });
  if (!persisted) {
    return {
      targetTradingDay,
      runId,
      runOrigin,
      runtimeSource,
      checkpointStatus,
      verifierStatus: pass ? 'pass' : 'fail',
      verifierPass: pass,
      failureReasons: normalizedFailureReasons,
      summary,
      livePreferredOwnerPostCloseProofVerifierRunOrigin: runOrigin,
      livePreferredOwnerPostCloseProofResolvedNaturally: true,
      verifierPersistedThisRun: false,
      advisoryOnly: true,
    };
  }
  return {
    ...persisted,
    livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
      persisted.runOrigin || 'manual'
    ),
    livePreferredOwnerPostCloseProofResolvedNaturally: (
      normalizeDailyScoringRunOrigin(persisted.runOrigin || 'manual') === 'natural'
      && normalizeFinalizationSweepSource(persisted.runtimeSource || 'manual_api_run') === 'close_complete_checkpoint'
      && normalizeCheckpointStatus(persisted.checkpointStatus || 'waiting_valid') !== 'waiting_valid'
    ),
    verifierPersistedThisRun: true,
    advisoryOnly: true,
  };
}

function findEarliestRunInsertForTargetDay(db, targetTradingDay = '') {
  const target = normalizeDate(targetTradingDay);
  if (!db || typeof db.prepare !== 'function' || !target) return null;
  try {
    return db.prepare(`
      SELECT
        id,
        run_date,
        mode,
        created_at,
        json_extract(details_json, '$.liveCheckpoint.runtimeCheckpointSource') AS runtime_checkpoint_source,
        json_extract(details_json, '$.liveCheckpoint.sweepSource') AS checkpoint_sweep_source,
        json_extract(details_json, '$.liveCheckpoint.runtimeCheckpointWasAutonomous') AS runtime_checkpoint_was_autonomous,
        json_extract(details_json, '$.liveInsertionSla.liveInsertionSlaOutcome') AS live_insertion_sla_outcome
      FROM jarvis_daily_scoring_runs
      WHERE json_extract(details_json, '$.liveCheckpoint.targetTradingDay') = ?
        AND (
          COALESCE(json_extract(details_json, '$.liveCheckpoint.liveOutcomeInsertedThisCheckpoint'), 0) = 1
          OR COALESCE(json_extract(details_json, '$.liveInsertionSla.liveInsertionSlaNetNewRowCreated'), 0) = 1
        )
      ORDER BY id ASC
      LIMIT 1
    `).get(target) || null;
  } catch {
    return null;
  }
}

function insertLiveInsertionOwnershipIfMissing(db, input = {}) {
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  const createdRowId = Number(input.createdRowId || 0) || null;
  const firstRunId = Number(input.firstRunId || 0) || null;
  const firstRunMode = toText(input.firstRunMode || '') || null;
  const firstRunSource = normalizeFinalizationSweepSource(input.firstRunSource || '');
  const firstInsertSlaOutcome = normalizeLiveInsertionSlaOutcome(input.firstInsertSlaOutcome || '');
  const firstInsertedAt = toText(input.firstInsertedAt || '') || null;
  const firstInsertedAutonomous = input.firstInsertedAutonomous === true ? 1 : 0;
  if (!db || typeof db.prepare !== 'function' || !targetTradingDay || !createdRowId) {
    return readLiveInsertionOwnershipRow(db, targetTradingDay);
  }
  try {
    db.prepare(`
      INSERT INTO jarvis_live_outcome_ownership (
        target_trading_day,
        created_row_id,
        first_run_id,
        first_run_mode,
        first_run_source,
        first_insert_sla_outcome,
        first_inserted_at,
        first_inserted_autonomous,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(target_trading_day) DO NOTHING
    `).run(
      targetTradingDay,
      createdRowId,
      firstRunId,
      firstRunMode,
      firstRunSource,
      firstInsertSlaOutcome,
      firstInsertedAt,
      firstInsertedAutonomous
    );
  } catch {}
  return readLiveInsertionOwnershipRow(db, targetTradingDay);
}

function hydrateOwnershipFromRunHistoryIfMissing(db, input = {}) {
  const targetTradingDay = normalizeDate(input.targetTradingDay || '');
  if (!targetTradingDay) return null;
  const existing = readLiveInsertionOwnershipRow(db, targetTradingDay);
  if (existing) return existing;
  const liveOutcomeRow = readLiveOutcomeRowByIdentity(db, targetTradingDay);
  if (!liveOutcomeRow) return null;
  const earliestInsertRun = findEarliestRunInsertForTargetDay(db, targetTradingDay);
  return insertLiveInsertionOwnershipIfMissing(db, {
    targetTradingDay,
    createdRowId: Number(liveOutcomeRow.id || 0) || null,
    firstRunId: Number(earliestInsertRun?.id || 0) || null,
    firstRunMode: earliestInsertRun?.mode || null,
    firstRunSource: earliestInsertRun?.runtime_checkpoint_source || earliestInsertRun?.checkpoint_sweep_source || 'manual_api_run',
    firstInsertSlaOutcome: earliestInsertRun?.live_insertion_sla_outcome || 'insert_not_required_already_finalized',
    firstInsertedAt: earliestInsertRun?.created_at || liveOutcomeRow.created_at || null,
    firstInsertedAutonomous: (
      Number(earliestInsertRun?.runtime_checkpoint_was_autonomous || 0) === 1
      || String(earliestInsertRun?.runtime_checkpoint_was_autonomous || '').trim().toLowerCase() === 'true'
    ),
  });
}

function buildLiveInsertionOwnership(input = {}) {
  const db = input.db;
  const runId = Number(input.runId || 0) || null;
  const runMode = toText(input.runMode || '') || null;
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionSla = input.liveInsertionSla && typeof input.liveInsertionSla === 'object'
    ? input.liveInsertionSla
    : {};
  const targetTradingDay = normalizeDate(
    liveInsertionSla.liveInsertionSlaTargetTradingDay
    || liveCheckpoint.targetTradingDay
    || ''
  ) || null;
  const tradingDayClassification = normalizeTradingDayClassification(
    liveInsertionSla.tradingDayClassification
    || liveCheckpoint.tradingDayClassification
    || 'invalid_mapping'
  );
  const liveOutcomeRow = readLiveOutcomeRowByIdentity(db, targetTradingDay || '');
  const currentRunCreatedRow = (
    liveCheckpoint.liveOutcomeInsertedThisCheckpoint === true
    || liveInsertionSla.liveInsertionSlaNetNewRowCreated === true
  ) && !!liveOutcomeRow;
  const currentRunCreatedRowId = currentRunCreatedRow
    ? Number(liveOutcomeRow?.id || 0) || null
    : null;
  const currentRunAutonomous = liveInsertionSla.liveInsertionSlaWasAutonomous === true;
  const currentRunSource = normalizeFinalizationSweepSource(
    liveInsertionSla.liveInsertionSlaSource
    || liveCheckpoint.runtimeCheckpointSource
    || liveCheckpoint.sweepSource
    || 'manual_api_run'
  );
  const currentRunTriggeredAt = toText(
    liveInsertionSla.liveInsertionSlaTriggeredAt
    || liveCheckpoint.runtimeCheckpointTriggeredAt
    || liveCheckpoint.checkpointCompletedAt
    || ''
  ) || null;
  let ownershipRow = hydrateOwnershipFromRunHistoryIfMissing(db, {
    targetTradingDay,
  });
  if (!ownershipRow && currentRunCreatedRow && currentRunCreatedRowId) {
    ownershipRow = insertLiveInsertionOwnershipIfMissing(db, {
      targetTradingDay,
      createdRowId: currentRunCreatedRowId,
      firstRunId: runId,
      firstRunMode: runMode,
      firstRunSource: currentRunSource,
      firstInsertSlaOutcome: liveInsertionSla.liveInsertionSlaOutcome,
      firstInsertedAt: currentRunTriggeredAt || liveOutcomeRow?.created_at || null,
      firstInsertedAutonomous: currentRunAutonomous,
    });
  }
  const firstInsertedAutonomous = (
    Number(ownershipRow?.first_inserted_autonomous || 0) === 1
    || String(ownershipRow?.first_inserted_autonomous || '').trim().toLowerCase() === 'true'
  );
  const firstInsertedBySource = ownershipRow?.first_run_source
    ? normalizeFinalizationSweepSource(ownershipRow.first_run_source)
    : null;
  const firstInsertedAt = toText(ownershipRow?.first_inserted_at || '') || null;
  const firstInsertSlaOutcome = ownershipRow?.first_insert_sla_outcome
    ? normalizeLiveInsertionSlaOutcome(ownershipRow.first_insert_sla_outcome)
    : null;
  const firstRunId = Number(ownershipRow?.first_run_id || 0) || null;
  const currentRunWasFirstCreator = (
    currentRunCreatedRow === true
    && currentRunCreatedRowId
    && Number(ownershipRow?.created_row_id || 0) === Number(currentRunCreatedRowId || 0)
    && (!firstRunId || Number(firstRunId) === Number(runId || 0))
  );
  const ownershipScope = normalizeLiveInsertionOwnershipScope(
    ownershipRow
      ? 'target_day'
      : (liveOutcomeRow ? 'broader_cycle' : 'target_day')
  );
  let outcome = 'already_inserted_before_this_cycle';
  if (!targetTradingDay || tradingDayClassification !== 'valid_trading_day') {
    outcome = 'insert_not_required_invalid_day';
  } else if (normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_missing_context') {
    outcome = 'insert_not_required_missing_context';
  } else if (normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_missing_market_data') {
    outcome = 'insert_not_required_missing_market_data';
  } else if (currentRunWasFirstCreator && currentRunAutonomous) {
    outcome = 'first_autonomous_insert_of_day';
  } else if (ownershipRow || liveOutcomeRow) {
    if (firstInsertedAutonomous) outcome = 'already_inserted_by_prior_autonomous_run';
    else if (firstInsertedBySource === 'manual_api_run' || firstInsertedAutonomous !== true) outcome = 'already_inserted_by_manual_run';
    else outcome = 'already_inserted_before_this_cycle';
  } else {
    outcome = 'target_day_not_inserted_yet';
  }
  outcome = resolveMostPreciseOwnershipOutcome([outcome]);
  const liveOwnershipConsistencyOk = !(
    outcome === 'already_inserted_before_this_cycle'
    && (
      firstInsertedBySource === 'manual_api_run'
      || firstInsertedAutonomous === true
      || currentRunWasFirstCreator === true
    )
  );
  const sourceSpecificOutcome = classifyOwnershipSourceSpecificOutcome({
    targetTradingDay,
    tradingDayClassification,
    firstInsertedBySource,
    firstInsertedAutonomous,
    firstRunMode: toText(ownershipRow?.first_run_mode || runMode || ''),
    ownershipOutcome: outcome,
  });
  return {
    liveInsertionOwnershipTargetTradingDay: targetTradingDay,
    liveInsertionOwnershipScope: ownershipScope,
    liveInsertionOwnershipOutcome: outcome,
    liveInsertionOwnershipSourceSpecificOutcome: sourceSpecificOutcome,
    liveInsertionOwnershipFirstInsertedAt: firstInsertedAt,
    liveInsertionOwnershipFirstInsertedBySource: firstInsertedBySource,
    liveInsertionOwnershipFirstInsertedAutonomous: firstInsertedAutonomous === true,
    liveInsertionOwnershipFirstInsertSlaOutcome: firstInsertSlaOutcome,
    liveInsertionOwnershipCurrentRunCreatedRow: currentRunCreatedRow === true,
    liveInsertionOwnershipCurrentRunCreatedRowId: currentRunCreatedRowId || null,
    liveInsertionOwnershipCurrentRunWasFirstCreator: currentRunWasFirstCreator === true,
    liveInsertionOwnershipFirstRunId: firstRunId,
    liveOwnershipConsistencyOk: liveOwnershipConsistencyOk === true,
    advisoryOnly: true,
  };
}

function buildTargetDayOwnershipInvariant(input = {}) {
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const liveAutonomousFirstRight = input.liveAutonomousFirstRight && typeof input.liveAutonomousFirstRight === 'object'
    ? input.liveAutonomousFirstRight
    : {};
  const targetTradingDay = normalizeDate(liveCheckpoint.targetTradingDay || '');
  const ownershipTargetTradingDay = normalizeDate(liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay || '');
  const ownershipScope = normalizeLiveInsertionOwnershipScope(liveInsertionOwnership.liveInsertionOwnershipScope || 'target_day');
  const ownershipOutcome = normalizeLiveInsertionOwnershipOutcome(liveInsertionOwnership.liveInsertionOwnershipOutcome || '');
  const firstRightOutcome = normalizeLiveAutonomousFirstRightOutcome(
    liveAutonomousFirstRight.liveAutonomousFirstRightOutcome || ''
  );
  const checkpointExpectedOutcomeCount = Number(liveCheckpoint.checkpointExpectedOutcomeCount || 0);
  const checkpointActualOutcomeCount = Number(liveCheckpoint.checkpointActualOutcomeCount || 0);
  const checkpointInsertDelta = Number(liveCheckpoint.checkpointInsertDelta || (checkpointActualOutcomeCount - checkpointExpectedOutcomeCount));
  let reason = 'no_mismatch';

  if (!targetTradingDay || !ownershipTargetTradingDay || targetTradingDay !== ownershipTargetTradingDay) {
    reason = 'target_day_scope_mismatch';
  } else if (ownershipScope !== 'target_day') {
    reason = 'scope_broader_cycle';
  } else if (checkpointActualOutcomeCount === 0 && LIVE_INSERTION_OWNERSHIP_INSERTED_OUTCOMES.has(ownershipOutcome)) {
    reason = 'target_day_zero_actual_claims_inserted';
  } else if (checkpointActualOutcomeCount > 0 && ownershipOutcome === 'target_day_not_inserted_yet') {
    reason = 'target_day_actual_present_but_not_owned';
  } else if ((checkpointActualOutcomeCount - checkpointExpectedOutcomeCount) !== checkpointInsertDelta) {
    reason = 'insert_delta_identity_mismatch';
  } else if (
    liveAutonomousFirstRight.liveAutonomousFirstRightActive === true
    && firstRightOutcome === 'autonomous_first_right_reserved'
    && ownershipOutcome === 'already_inserted_by_manual_run'
  ) {
    reason = 'first_right_disagrees_with_ownership';
  }

  return {
    liveTargetDayOwnershipConsistent: reason === 'no_mismatch',
    liveTargetDayOwnershipMismatchReason: normalizeLiveTargetDayOwnershipMismatchReason(reason),
    advisoryOnly: true,
  };
}

function buildLiveAutonomousInsertReadiness(input = {}) {
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const liveAutonomousFirstRight = input.liveAutonomousFirstRight && typeof input.liveAutonomousFirstRight === 'object'
    ? input.liveAutonomousFirstRight
    : {};
  const targetDayInvariant = input.liveTargetDayOwnershipInvariant && typeof input.liveTargetDayOwnershipInvariant === 'object'
    ? input.liveTargetDayOwnershipInvariant
    : { liveTargetDayOwnershipConsistent: true, liveTargetDayOwnershipMismatchReason: 'no_mismatch' };

  const targetTradingDay = normalizeDate(
    liveCheckpoint.targetTradingDay
    || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || liveAutonomousFirstRight.liveAutonomousFirstRightTargetTradingDay
    || ''
  ) || null;
  const classification = normalizeTradingDayClassification(liveCheckpoint.tradingDayClassification || 'invalid_mapping');
  const validTradingDay = classification === 'valid_trading_day';
  const ownershipScope = normalizeLiveInsertionOwnershipScope(liveInsertionOwnership.liveInsertionOwnershipScope || 'target_day');
  const ownershipOutcome = normalizeLiveInsertionOwnershipOutcome(liveInsertionOwnership.liveInsertionOwnershipOutcome || '');
  const firstRightActive = liveAutonomousFirstRight.liveAutonomousFirstRightActive === true;
  const firstRightOutcome = normalizeLiveAutonomousFirstRightOutcome(
    liveAutonomousFirstRight.liveAutonomousFirstRightOutcome || ''
  );
  const closeComplete = liveCheckpoint.closeComplete === true;
  const requiredCloseDataPresent = liveCheckpoint.requiredCloseDataPresent === true;
  const requiredCloseBarsPresent = liveCheckpoint.requiredCloseBarsPresent === true;
  const requiredMarketDataPresent = requiredCloseDataPresent && requiredCloseBarsPresent;
  const expectedLiveContextExists = liveCheckpoint.expectedLiveContextExists === true;
  const liveContextSuppressed = liveCheckpoint.liveContextSuppressed === true;
  const liveContextPresent = expectedLiveContextExists && !liveContextSuppressed;
  const existingLiveRowPresent = (
    Number(liveCheckpoint.checkpointActualOutcomeCount || 0) > 0
    || liveCheckpoint.liveOutcomeExists === true
    || LIVE_INSERTION_OWNERSHIP_INSERTED_OUTCOMES.has(ownershipOutcome)
  );
  const firstRightSatisfied = (
    firstRightActive !== true
    || firstRightOutcome === 'autonomous_first_right_reserved'
    || firstRightOutcome === 'manual_insert_deferred_to_autonomous_window'
  );
  const scopeConsistent = (
    ownershipScope === 'target_day'
    && targetDayInvariant.liveTargetDayOwnershipConsistent === true
  );
  const autonomousInsertEligible = (
    validTradingDay
    && liveContextPresent
    && closeComplete
    && requiredMarketDataPresent
    && firstRightSatisfied
    && !existingLiveRowPresent
    && scopeConsistent
  );

  let autonomousInsertBlockReason = 'none';
  let autonomousInsertNextTransition = 'attempt_insert';

  if (!validTradingDay) {
    autonomousInsertBlockReason = 'blocked_invalid_day';
    autonomousInsertNextTransition = 'no_insert_required_invalid_day';
  } else if (!scopeConsistent) {
    autonomousInsertBlockReason = 'scope_mismatch';
    autonomousInsertNextTransition = 'reconcile_scope';
  } else if (!liveContextPresent) {
    autonomousInsertBlockReason = 'waiting_for_context';
    autonomousInsertNextTransition = 'wait_for_context';
  } else if (firstRightSatisfied !== true) {
    autonomousInsertBlockReason = 'blocked_first_right';
    autonomousInsertNextTransition = 'wait_for_first_right_window';
  } else if (!closeComplete) {
    autonomousInsertBlockReason = 'waiting_for_close';
    autonomousInsertNextTransition = 'wait_for_close_complete';
  } else if (!requiredMarketDataPresent) {
    autonomousInsertBlockReason = 'waiting_for_market_data';
    autonomousInsertNextTransition = 'wait_for_market_data';
  } else if (existingLiveRowPresent) {
    autonomousInsertBlockReason = 'blocked_existing_row';
    autonomousInsertNextTransition = 'no_insert_required_existing_row';
  } else if (!autonomousInsertEligible) {
    autonomousInsertBlockReason = 'unknown_blocked_state';
    autonomousInsertNextTransition = 'investigate_unknown';
  }

  return {
    targetTradingDay,
    validTradingDay: validTradingDay === true,
    liveContextPresent: liveContextPresent === true,
    closeComplete: closeComplete === true,
    requiredMarketDataPresent: requiredMarketDataPresent === true,
    firstRightSatisfied: firstRightSatisfied === true,
    existingLiveRowPresent: existingLiveRowPresent === true,
    autonomousInsertEligible: autonomousInsertEligible === true,
    autonomousInsertBlockReason: normalizeLiveAutonomousInsertBlockReason(autonomousInsertBlockReason),
    autonomousInsertNextTransition: normalizeLiveAutonomousInsertNextTransition(autonomousInsertNextTransition),
    advisoryOnly: true,
  };
}

function buildLiveAutonomousProofContract(input = {}) {
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const liveAutonomousFirstRight = input.liveAutonomousFirstRight && typeof input.liveAutonomousFirstRight === 'object'
    ? input.liveAutonomousFirstRight
    : {};
  const targetDayInvariant = input.liveTargetDayOwnershipInvariant && typeof input.liveTargetDayOwnershipInvariant === 'object'
    ? input.liveTargetDayOwnershipInvariant
    : { liveTargetDayOwnershipConsistent: true, liveTargetDayOwnershipMismatchReason: 'no_mismatch' };
  const readiness = input.liveAutonomousInsertReadiness && typeof input.liveAutonomousInsertReadiness === 'object'
    ? input.liveAutonomousInsertReadiness
    : buildLiveAutonomousInsertReadiness({
      liveCheckpoint,
      liveInsertionOwnership,
      liveAutonomousFirstRight,
      liveTargetDayOwnershipInvariant: targetDayInvariant,
    });
  const targetTradingDay = normalizeDate(
    readiness.targetTradingDay
    || liveCheckpoint.targetTradingDay
    || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || liveAutonomousFirstRight.liveAutonomousFirstRightTargetTradingDay
    || ''
  ) || null;
  const ownershipOutcome = normalizeLiveInsertionOwnershipOutcome(liveInsertionOwnership.liveInsertionOwnershipOutcome || '');
  const checkpointExpectedOutcomeCount = Number(liveCheckpoint.checkpointExpectedOutcomeCount || 0);
  const checkpointActualOutcomeCount = Number(liveCheckpoint.checkpointActualOutcomeCount || 0);
  const currentRunCreatedRowId = Number(liveInsertionOwnership.liveInsertionOwnershipCurrentRunCreatedRowId || 0) || null;
  const currentRunWasFirstCreator = liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator === true;
  const firstEligibleCycleFailureReason = normalizeFirstEligibleCycleFailureReason(
    liveCheckpoint.firstEligibleCycleFailureReason || ''
  );
  const attempted = (
    liveCheckpoint.firstEligibleCycleInsertAttempted === true
    || (liveCheckpoint.liveOutcomeInsertedThisCheckpoint === true && liveCheckpoint.runtimeCheckpointWasAutonomous === true)
    || (
      liveCheckpoint.firstEligibleCycleExpectedInsert === true
      && !!firstEligibleCycleFailureReason
      && firstEligibleCycleFailureReason !== 'insert_not_attempted_when_ready'
    )
  );
  const succeeded = (
    liveCheckpoint.liveOutcomeInsertedThisCheckpoint === true
    && liveCheckpoint.runtimeCheckpointWasAutonomous === true
    && checkpointExpectedOutcomeCount === 1
    && checkpointActualOutcomeCount === 1
    && ownershipOutcome === 'first_autonomous_insert_of_day'
    && currentRunWasFirstCreator === true
    && currentRunCreatedRowId !== null
  );
  const eligible = readiness.autonomousInsertEligible === true;
  const existingLiveRowPresent = readiness.existingLiveRowPresent === true;

  let outcome = 'proof_waiting_for_close';
  if (targetDayInvariant.liveTargetDayOwnershipConsistent !== true) outcome = 'proof_scope_mismatch';
  else if (readiness.validTradingDay !== true) outcome = 'proof_blocked_invalid_day';
  else if (readiness.firstRightSatisfied !== true) outcome = 'proof_blocked_first_right';
  else if (succeeded) outcome = 'proof_attempted_success';
  else if (existingLiveRowPresent) outcome = 'proof_blocked_existing_row';
  else if (readiness.liveContextPresent !== true) outcome = 'proof_waiting_for_context';
  else if (readiness.closeComplete !== true) outcome = 'proof_waiting_for_close';
  else if (readiness.requiredMarketDataPresent !== true) outcome = 'proof_waiting_for_market_data';
  else if (eligible && attempted !== true) outcome = 'proof_eligible_not_attempted_bug';
  else if (eligible && attempted) outcome = 'proof_attempted_failure';
  else outcome = 'proof_attempted_failure';

  let failureReason = 'none';
  if (outcome === 'proof_waiting_for_close') failureReason = 'waiting_for_close';
  else if (outcome === 'proof_waiting_for_market_data') failureReason = 'waiting_for_market_data';
  else if (outcome === 'proof_waiting_for_context') failureReason = 'waiting_for_context';
  else if (outcome === 'proof_eligible_not_attempted_bug') failureReason = 'eligible_not_attempted_bug';
  else if (outcome === 'proof_attempted_failure') failureReason = 'attempted_failure';
  else if (outcome === 'proof_blocked_existing_row') failureReason = 'blocked_existing_row';
  else if (outcome === 'proof_blocked_invalid_day') failureReason = 'blocked_invalid_day';
  else if (outcome === 'proof_blocked_first_right') failureReason = 'blocked_first_right';
  else if (outcome === 'proof_scope_mismatch') failureReason = 'scope_mismatch';

  return {
    liveAutonomousProofTargetTradingDay: targetTradingDay,
    liveAutonomousProofOutcome: normalizeLiveAutonomousProofOutcome(outcome),
    liveAutonomousProofEligible: eligible === true,
    liveAutonomousProofAttempted: attempted === true,
    liveAutonomousProofSucceeded: succeeded === true,
    liveAutonomousProofFailureReason: normalizeLiveAutonomousProofFailureReason(failureReason),
    advisoryOnly: true,
  };
}

function buildLiveAutonomousAttemptTransition(input = {}) {
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const readiness = input.liveAutonomousInsertReadiness && typeof input.liveAutonomousInsertReadiness === 'object'
    ? input.liveAutonomousInsertReadiness
    : buildLiveAutonomousInsertReadiness({
      liveCheckpoint,
      liveInsertionOwnership,
      liveAutonomousFirstRight: input.liveAutonomousFirstRight,
      liveTargetDayOwnershipInvariant: input.liveTargetDayOwnershipInvariant,
    });
  const proof = input.liveAutonomousProof && typeof input.liveAutonomousProof === 'object'
    ? input.liveAutonomousProof
    : buildLiveAutonomousProofContract({
      liveCheckpoint,
      liveInsertionOwnership,
      liveAutonomousFirstRight: input.liveAutonomousFirstRight,
      liveTargetDayOwnershipInvariant: input.liveTargetDayOwnershipInvariant,
      liveAutonomousInsertReadiness: readiness,
    });

  const targetTradingDay = normalizeDate(
    readiness.targetTradingDay
    || liveCheckpoint.targetTradingDay
    || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || ''
  ) || null;
  const checkpointExpectedOutcomeCount = Number(liveCheckpoint.checkpointExpectedOutcomeCount || 0);
  const firstEligibleCycleExpectedInsert = liveCheckpoint.firstEligibleCycleExpectedInsert === true;
  const firstEligibleCycleInsertAttempted = liveCheckpoint.firstEligibleCycleInsertAttempted === true;
  const liveOutcomeInsertedThisCheckpoint = liveCheckpoint.liveOutcomeInsertedThisCheckpoint === true;
  const liveOutcomeUpdatedThisCheckpoint = liveCheckpoint.liveOutcomeUpdatedThisCheckpoint === true;
  const existingLiveRowPresent = readiness.existingLiveRowPresent === true;
  const inferredExistingRowAtAttemptTime = liveOutcomeInsertedThisCheckpoint
    ? false
    : (
      liveOutcomeUpdatedThisCheckpoint
      || liveCheckpoint.liveOutcomeExists === true
      || existingLiveRowPresent
    );
  const autonomousInsertEligible = readiness.autonomousInsertEligible === true;
  const attemptRequired = (
    firstEligibleCycleExpectedInsert
    || (autonomousInsertEligible && !inferredExistingRowAtAttemptTime && checkpointExpectedOutcomeCount === 1)
  );
  const attemptExecuted = proof.liveAutonomousProofAttempted === true || firstEligibleCycleInsertAttempted;
  const rowInsertedByThisAttempt = (
    proof.liveAutonomousProofSucceeded === true
    && liveOutcomeInsertedThisCheckpoint
    && liveCheckpoint.runtimeCheckpointWasAutonomous === true
    && liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator === true
  );
  const insertedRowId = rowInsertedByThisAttempt
    ? (Number(liveInsertionOwnership.liveInsertionOwnershipCurrentRunCreatedRowId || 0) || null)
    : null;
  const attemptExecutionPath = normalizeFinalizationSweepSource(
    liveCheckpoint.runtimeCheckpointSource
    || liveCheckpoint.sweepSource
    || ''
  );
  const eligibleAt = (attemptRequired || firstEligibleCycleExpectedInsert)
    ? (toText(liveCheckpoint.firstEligibleCycleAt || liveCheckpoint.checkpointEvaluatedAt || '') || null)
    : null;

  let attemptResult = 'attempt_not_required';
  let attemptSkippedReason = null;
  if (attemptRequired) {
    if (attemptExecuted && rowInsertedByThisAttempt) attemptResult = 'attempt_executed_success';
    else if (attemptExecuted) {
      attemptResult = 'attempt_executed_failure';
      attemptSkippedReason = normalizeLiveAutonomousProofFailureReason(
        proof.liveAutonomousProofFailureReason || 'attempted_failure'
      );
    } else {
      attemptResult = 'attempt_skipped_bug';
      attemptSkippedReason = 'eligible_not_attempted_bug';
    }
  } else if (readiness.closeComplete !== true) {
    attemptResult = 'attempt_waiting_for_close';
    attemptSkippedReason = 'waiting_for_close';
  } else if (readiness.requiredMarketDataPresent !== true) {
    attemptResult = 'attempt_waiting_for_market_data';
    attemptSkippedReason = 'waiting_for_market_data';
  } else if (readiness.liveContextPresent !== true) {
    attemptResult = 'attempt_waiting_for_context';
    attemptSkippedReason = 'waiting_for_context';
  } else if (inferredExistingRowAtAttemptTime) {
    attemptResult = 'attempt_blocked_existing_row';
    attemptSkippedReason = 'existing_row_present';
  }

  return {
    targetTradingDay,
    eligibleAt,
    attemptRequired: attemptRequired === true,
    attemptExecuted: attemptExecuted === true,
    attemptExecutionPath,
    attemptSkippedReason: attemptSkippedReason || null,
    existingRowDetectedAtAttemptTime: inferredExistingRowAtAttemptTime === true,
    rowInsertedByThisAttempt: rowInsertedByThisAttempt === true,
    insertedRowId,
    attemptResult: normalizeLiveAutonomousAttemptResult(attemptResult),
    advisoryOnly: true,
  };
}

function enforceEligibleAttemptOrBugContract(input = {}) {
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const readiness = input.liveAutonomousInsertReadiness && typeof input.liveAutonomousInsertReadiness === 'object'
    ? input.liveAutonomousInsertReadiness
    : {};
  const proof = input.liveAutonomousProof && typeof input.liveAutonomousProof === 'object'
    ? input.liveAutonomousProof
    : {};
  const transition = input.liveAutonomousAttemptTransition && typeof input.liveAutonomousAttemptTransition === 'object'
    ? input.liveAutonomousAttemptTransition
    : {};

  const targetTradingDay = normalizeDate(
    transition.targetTradingDay
    || proof.liveAutonomousProofTargetTradingDay
    || readiness.targetTradingDay
    || liveCheckpoint.targetTradingDay
    || ''
  ) || null;
  const contractEligible = (
    readiness.autonomousInsertEligible === true
    && readiness.existingLiveRowPresent !== true
    && Number(liveCheckpoint.checkpointExpectedOutcomeCount || 0) === 1
  );
  if (!contractEligible) {
    return {
      liveAutonomousProof: {
        ...proof,
        liveAutonomousProofTargetTradingDay: targetTradingDay,
        liveAutonomousProofOutcome: normalizeLiveAutonomousProofOutcome(proof.liveAutonomousProofOutcome || 'proof_attempted_failure'),
        liveAutonomousProofEligible: proof.liveAutonomousProofEligible === true,
        liveAutonomousProofAttempted: proof.liveAutonomousProofAttempted === true,
        liveAutonomousProofSucceeded: proof.liveAutonomousProofSucceeded === true,
        liveAutonomousProofFailureReason: normalizeLiveAutonomousProofFailureReason(proof.liveAutonomousProofFailureReason || 'none'),
        advisoryOnly: true,
      },
      liveAutonomousAttemptTransition: {
        ...transition,
        targetTradingDay,
        attemptResult: normalizeLiveAutonomousAttemptResult(transition.attemptResult || 'attempt_not_required'),
        attemptRequired: transition.attemptRequired === true,
        attemptExecuted: transition.attemptExecuted === true,
        attemptExecutionPath: normalizeFinalizationSweepSource(transition.attemptExecutionPath || 'manual_api_run'),
        attemptSkippedReason: toText(transition.attemptSkippedReason || '') || null,
        existingRowDetectedAtAttemptTime: transition.existingRowDetectedAtAttemptTime === true,
        rowInsertedByThisAttempt: transition.rowInsertedByThisAttempt === true,
        insertedRowId: Number(transition.insertedRowId || 0) || null,
        advisoryOnly: true,
      },
    };
  }

  const transitionAttempted = transition.attemptExecuted === true;
  const transitionSucceeded = transition.rowInsertedByThisAttempt === true
    && normalizeLiveAutonomousAttemptResult(transition.attemptResult || '') === 'attempt_executed_success';
  const normalizedTransition = {
    ...transition,
    targetTradingDay,
    attemptRequired: true,
    attemptExecuted: transitionAttempted,
    attemptExecutionPath: normalizeFinalizationSweepSource(
      transition.attemptExecutionPath
      || liveCheckpoint.runtimeCheckpointSource
      || liveCheckpoint.sweepSource
      || 'manual_api_run'
    ),
    existingRowDetectedAtAttemptTime: transition.existingRowDetectedAtAttemptTime === true,
    rowInsertedByThisAttempt: transition.rowInsertedByThisAttempt === true,
    insertedRowId: Number(transition.insertedRowId || 0) || null,
    advisoryOnly: true,
  };

  let enforcedTransition = normalizedTransition;
  let enforcedProof = {
    ...proof,
    liveAutonomousProofTargetTradingDay: targetTradingDay,
    liveAutonomousProofEligible: true,
    advisoryOnly: true,
  };
  if (!transitionAttempted) {
    enforcedTransition = {
      ...enforcedTransition,
      attemptResult: 'attempt_skipped_bug',
      attemptSkippedReason: 'eligible_not_attempted_bug',
      rowInsertedByThisAttempt: false,
      insertedRowId: null,
    };
    enforcedProof = {
      ...enforcedProof,
      liveAutonomousProofOutcome: 'proof_eligible_not_attempted_bug',
      liveAutonomousProofAttempted: false,
      liveAutonomousProofSucceeded: false,
      liveAutonomousProofFailureReason: 'eligible_not_attempted_bug',
    };
  } else if (transitionSucceeded) {
    enforcedTransition = {
      ...enforcedTransition,
      attemptResult: 'attempt_executed_success',
      attemptSkippedReason: null,
    };
    enforcedProof = {
      ...enforcedProof,
      liveAutonomousProofOutcome: 'proof_attempted_success',
      liveAutonomousProofAttempted: true,
      liveAutonomousProofSucceeded: true,
      liveAutonomousProofFailureReason: 'none',
    };
  } else {
    enforcedTransition = {
      ...enforcedTransition,
      attemptResult: 'attempt_executed_failure',
      attemptSkippedReason: normalizeLiveAutonomousProofFailureReason(
        proof.liveAutonomousProofFailureReason || 'attempted_failure'
      ),
      rowInsertedByThisAttempt: false,
      insertedRowId: null,
    };
    enforcedProof = {
      ...enforcedProof,
      liveAutonomousProofOutcome: 'proof_attempted_failure',
      liveAutonomousProofAttempted: true,
      liveAutonomousProofSucceeded: false,
      liveAutonomousProofFailureReason: normalizeLiveAutonomousProofFailureReason(
        proof.liveAutonomousProofFailureReason || 'attempted_failure'
      ),
    };
  }

  return {
    liveAutonomousProof: {
      ...enforcedProof,
      liveAutonomousProofOutcome: normalizeLiveAutonomousProofOutcome(
        enforcedProof.liveAutonomousProofOutcome || 'proof_attempted_failure'
      ),
      liveAutonomousProofFailureReason: normalizeLiveAutonomousProofFailureReason(
        enforcedProof.liveAutonomousProofFailureReason || 'none'
      ),
      advisoryOnly: true,
    },
    liveAutonomousAttemptTransition: {
      ...enforcedTransition,
      attemptResult: normalizeLiveAutonomousAttemptResult(enforcedTransition.attemptResult || 'attempt_not_required'),
      advisoryOnly: true,
    },
  };
}

function listRecentLiveInsertionSlaSnapshots(db, limit = 180) {
  if (!db || typeof db.prepare !== 'function') return [];
  const runLimit = clampInt(limit, 20, 500, 180);
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, run_date, mode, status, details_json, created_at
      FROM jarvis_daily_scoring_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(runLimit);
  } catch {
    return [];
  }
  const byTargetDay = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const details = safeJsonParseObject(row?.details_json);
    const sla = details?.liveInsertionSla && typeof details.liveInsertionSla === 'object'
      ? details.liveInsertionSla
      : null;
    if (!sla) continue;
    const targetTradingDay = normalizeDate(sla.liveInsertionSlaTargetTradingDay || '');
    if (!targetTradingDay) continue;
    if (byTargetDay.has(targetTradingDay)) continue;
    byTargetDay.set(targetTradingDay, {
      runId: Number(row?.id || 0),
      runDate: normalizeDate(row?.run_date || '') || null,
      mode: toText(row?.mode || '') || 'auto',
      runStatus: toText(row?.status || '') || 'noop',
      createdAt: toText(row?.created_at || '') || null,
      targetTradingDay,
      tradingDayClassification: normalizeTradingDayClassification(sla.tradingDayClassification || 'invalid_mapping'),
      outcome: normalizeLiveInsertionSlaOutcome(sla.liveInsertionSlaOutcome),
      required: sla.liveInsertionSlaRequired === true,
      netNewRowCreated: sla.liveInsertionSlaNetNewRowCreated === true,
      wasAutonomous: sla.liveInsertionSlaWasAutonomous === true,
    });
  }
  return Array.from(byTargetDay.values())
    .sort((a, b) => String(b.targetTradingDay || '').localeCompare(String(a.targetTradingDay || '')));
}

function isLiveInsertionSlaMissOutcome(outcome = '') {
  const normalized = normalizeLiveInsertionSlaOutcome(outcome);
  return normalized === 'insert_required_missed'
    || normalized === 'insert_required_failed_attempt'
    || normalized === 'insert_required_missing_context'
    || normalized === 'insert_required_missing_market_data';
}

function buildLiveInsertionGrowthMetrics(input = {}) {
  const db = input.db;
  const liveInsertionSla = input.liveInsertionSla && typeof input.liveInsertionSla === 'object'
    ? input.liveInsertionSla
    : {};
  const recentSnapshots = listRecentLiveInsertionSlaSnapshots(db, 200);
  const validDaySnapshots = recentSnapshots
    .filter((row) => normalizeTradingDayClassification(row?.tradingDayClassification || '') === 'valid_trading_day');
  const rolling = validDaySnapshots.slice(0, 5);
  const rolling5dValidDays = Number(rolling.length || 0);
  let rolling5dRequiredInserts = 0;
  let rolling5dOnTimeInserts = 0;
  let rolling5dLateInserts = 0;
  let rolling5dMissedInserts = 0;
  let rolling5dAlreadyFinalized = 0;
  for (const row of rolling) {
    const outcome = normalizeLiveInsertionSlaOutcome(row?.outcome);
    if (row?.required === true) rolling5dRequiredInserts += 1;
    if (outcome === 'insert_required_success_on_time') rolling5dOnTimeInserts += 1;
    else if (outcome === 'insert_required_success_late') rolling5dLateInserts += 1;
    else if (isLiveInsertionSlaMissOutcome(outcome)) rolling5dMissedInserts += 1;
    else if (outcome === 'insert_not_required_already_finalized') rolling5dAlreadyFinalized += 1;
  }
  const rolling5dOnTimeRatePct = rolling5dRequiredInserts > 0
    ? round2((rolling5dOnTimeInserts / rolling5dRequiredInserts) * 100)
    : 0;
  let consecutiveValidDaysWithOnTimeInsert = 0;
  for (const row of validDaySnapshots) {
    if (normalizeLiveInsertionSlaOutcome(row?.outcome) !== 'insert_required_success_on_time') break;
    consecutiveValidDaysWithOnTimeInsert += 1;
  }
  let consecutiveValidDaysMissed = 0;
  for (const row of validDaySnapshots) {
    if (!isLiveInsertionSlaMissOutcome(row?.outcome)) break;
    consecutiveValidDaysMissed += 1;
  }

  const latestOutcome = normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome);
  const requiredToday = liveInsertionSla.liveInsertionSlaRequired === true ? 1 : 0;
  const deliveredToday = liveInsertionSla.liveInsertionSlaNetNewRowCreated === true ? 1 : 0;
  const lateToday = latestOutcome === 'insert_required_success_late' ? 1 : 0;
  const missedToday = isLiveInsertionSlaMissOutcome(latestOutcome) ? 1 : 0;

  return {
    liveNetNewRequiredToday: requiredToday,
    liveNetNewDeliveredToday: deliveredToday,
    liveNetNewMissedToday: missedToday,
    liveNetNewLateToday: lateToday,
    consecutiveValidDaysWithOnTimeInsert,
    consecutiveValidDaysMissed,
    rolling5dValidDays,
    rolling5dRequiredInserts,
    rolling5dOnTimeInserts,
    rolling5dLateInserts,
    rolling5dMissedInserts,
    rolling5dAlreadyFinalized,
    rolling5dOnTimeRatePct,
    advisoryOnly: true,
  };
}

function listRecentLiveInsertionAutonomousSnapshots(db, limit = 180) {
  if (!db || typeof db.prepare !== 'function') return [];
  const runLimit = clampInt(limit, 20, 800, 260);
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, run_date, mode, details_json, created_at
      FROM jarvis_daily_scoring_runs
      WHERE json_extract(details_json, '$.liveInsertionSla.liveInsertionSlaTargetTradingDay') IS NOT NULL
      ORDER BY id DESC
      LIMIT ?
    `).all(runLimit);
  } catch {
    return [];
  }

  const byTargetDay = new Map();
  for (const row of rows) {
    const details = safeJsonParseObject(row?.details_json);
    const sla = details?.liveInsertionSla && typeof details.liveInsertionSla === 'object'
      ? details.liveInsertionSla
      : null;
    const checkpoint = details?.liveCheckpoint && typeof details.liveCheckpoint === 'object'
      ? details.liveCheckpoint
      : {};
    const ownership = details?.liveInsertionOwnership && typeof details.liveInsertionOwnership === 'object'
      ? details.liveInsertionOwnership
      : {};
    if (!sla) continue;
    const targetTradingDay = normalizeDate(sla.liveInsertionSlaTargetTradingDay || '');
    if (!targetTradingDay) continue;

    const slaOutcome = normalizeLiveInsertionSlaOutcome(sla.liveInsertionSlaOutcome);
    const runSource = normalizeFinalizationSweepSource(
      checkpoint.runtimeCheckpointSource
      || checkpoint.sweepSource
      || sla.liveInsertionSlaSource
      || ''
    );
    const entry = byTargetDay.get(targetTradingDay) || {
      targetTradingDay,
      runId: Number(row?.id || 0),
      runDate: normalizeDate(row?.run_date || '') || null,
      runCreatedAt: toText(row?.created_at || '') || null,
      mode: toText(row?.mode || '') || 'auto',
      runSource,
      tradingDayClassification: normalizeTradingDayClassification(sla.tradingDayClassification || 'invalid_mapping'),
      latestSlaRequired: sla.liveInsertionSlaRequired === true,
      latestSlaOutcome: slaOutcome,
      latestSlaPastDeadline: sla.liveInsertionSlaPastDeadline === true,
      latestOwnershipOutcome: normalizeLiveInsertionOwnershipOutcome(
        ownership?.liveInsertionOwnershipOutcome || 'already_inserted_before_this_cycle'
      ),
      latestOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        ownership?.liveInsertionOwnershipSourceSpecificOutcome || 'ownership_source_unknown'
      ),
      latestOwnershipFirstInsertedAutonomous: ownership?.liveInsertionOwnershipFirstInsertedAutonomous === true,
      latestOwnershipFirstInsertSlaOutcome: normalizeLiveInsertionSlaOutcome(
        ownership?.liveInsertionOwnershipFirstInsertSlaOutcome || 'insert_required_failed_attempt'
      ),
      latestOwnershipFirstInsertedBySource: ownership?.liveInsertionOwnershipFirstInsertedBySource
        ? normalizeFinalizationSweepSource(ownership.liveInsertionOwnershipFirstInsertedBySource)
        : null,
      latestOwnershipFirstInsertedAt: toText(ownership?.liveInsertionOwnershipFirstInsertedAt || '') || null,
      slaRequiredAny: false,
      hadOnTimeSuccess: false,
      hadLateSuccess: false,
      hadMissOutcome: false,
      hadPastDeadline: false,
      hadAutonomousSuccessRun: false,
    };

    entry.slaRequiredAny = entry.slaRequiredAny || (sla.liveInsertionSlaRequired === true);
    entry.hadPastDeadline = entry.hadPastDeadline || (sla.liveInsertionSlaPastDeadline === true);
    if (sla.liveInsertionSlaRequired === true && slaOutcome === 'insert_required_success_on_time') {
      entry.hadOnTimeSuccess = true;
    }
    if (sla.liveInsertionSlaRequired === true && slaOutcome === 'insert_required_success_late') {
      entry.hadLateSuccess = true;
    }
    if (sla.liveInsertionSlaRequired === true && isLiveInsertionSlaMissOutcome(slaOutcome)) {
      entry.hadMissOutcome = true;
    }
    if (
      ownership?.liveInsertionOwnershipCurrentRunWasFirstCreator === true
      && ownership?.liveInsertionOwnershipFirstInsertedAutonomous === true
      && slaOutcome === 'insert_required_success_on_time'
    ) {
      entry.hadAutonomousSuccessRun = true;
    }

    byTargetDay.set(targetTradingDay, entry);
  }

  const targets = Array.from(byTargetDay.keys());
  const ownershipMap = listLiveInsertionOwnershipRows(db, targets);
  const merged = Array.from(byTargetDay.values()).map((entry) => {
    const ownershipRow = ownershipMap.get(entry.targetTradingDay) || null;
    const ownershipFirstInsertedAutonomous = ownershipRow
      ? (
        Number(ownershipRow?.first_inserted_autonomous || 0) === 1
        || String(ownershipRow?.first_inserted_autonomous || '').trim().toLowerCase() === 'true'
      )
      : (entry.latestOwnershipFirstInsertedAutonomous === true);
    const ownershipFirstInsertedBySource = ownershipRow?.first_run_source
      ? normalizeFinalizationSweepSource(ownershipRow.first_run_source)
      : (entry.latestOwnershipFirstInsertedBySource || null);
    const ownershipFirstInsertSlaOutcome = ownershipRow?.first_insert_sla_outcome
      ? normalizeLiveInsertionSlaOutcome(ownershipRow.first_insert_sla_outcome)
      : normalizeLiveInsertionSlaOutcome(entry.latestOwnershipFirstInsertSlaOutcome || 'insert_required_failed_attempt');
    const ownershipFirstInsertedAt = ownershipRow?.first_inserted_at
      ? toText(ownershipRow.first_inserted_at)
      : (entry.latestOwnershipFirstInsertedAt || null);
    const ownershipSourceSpecificOutcome = classifyOwnershipSourceSpecificOutcome({
      targetTradingDay: entry.targetTradingDay,
      tradingDayClassification: entry.tradingDayClassification,
      firstInsertedBySource: ownershipFirstInsertedBySource,
      firstInsertedAutonomous: ownershipFirstInsertedAutonomous,
      firstRunMode: toText(ownershipRow?.first_run_mode || entry.mode || ''),
      ownershipOutcome: entry.latestOwnershipOutcome,
    });
    return {
      targetTradingDay: entry.targetTradingDay,
      runId: entry.runId,
      runDate: entry.runDate,
      runCreatedAt: entry.runCreatedAt,
      mode: entry.mode,
      runSource: entry.runSource,
      tradingDayClassification: entry.tradingDayClassification,
      slaRequiredLatest: entry.latestSlaRequired === true,
      slaRequiredAny: entry.slaRequiredAny === true,
      slaOutcomeLatest: normalizeLiveInsertionSlaOutcome(entry.latestSlaOutcome),
      slaPastDeadlineLatest: entry.latestSlaPastDeadline === true,
      hadOnTimeSuccess: entry.hadOnTimeSuccess === true,
      hadLateSuccess: entry.hadLateSuccess === true,
      hadMissOutcome: entry.hadMissOutcome === true,
      hadPastDeadline: entry.hadPastDeadline === true,
      hadAutonomousSuccessRun: entry.hadAutonomousSuccessRun === true,
      ownershipOutcomeLatest: normalizeLiveInsertionOwnershipOutcome(entry.latestOwnershipOutcome),
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(ownershipSourceSpecificOutcome),
      ownershipFirstInsertedAutonomous: ownershipFirstInsertedAutonomous === true,
      ownershipFirstInsertedBySource: ownershipFirstInsertedBySource || null,
      ownershipFirstInsertSlaOutcome,
      ownershipFirstInsertedAt: ownershipFirstInsertedAt || null,
      ownershipFirstRunId: Number(ownershipRow?.first_run_id || 0) || null,
      ownershipFirstRunMode: toText(ownershipRow?.first_run_mode || '') || null,
      ownershipCreatedRowId: Number(ownershipRow?.created_row_id || 0) || null,
    };
  });

  return merged
    .sort((a, b) => String(b.targetTradingDay || '').localeCompare(String(a.targetTradingDay || '')));
}

function buildLiveAutonomousInsertionMetrics(input = {}) {
  const db = input.db;
  const liveInsertionSla = input.liveInsertionSla && typeof input.liveInsertionSla === 'object'
    ? input.liveInsertionSla
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const latestDayRequired = liveInsertionSla.liveInsertionSlaRequired === true;
  const latestDayDelivered = liveInsertionOwnership.liveInsertionOwnershipOutcome === 'first_autonomous_insert_of_day';
  const latestDayLate = latestDayDelivered
    && normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_success_late';
  const latestDayMissed = latestDayRequired
    && !latestDayDelivered
    && (
      normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_missed'
      || normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_failed_attempt'
      || normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_missing_context'
      || normalizeLiveInsertionSlaOutcome(liveInsertionSla.liveInsertionSlaOutcome) === 'insert_required_missing_market_data'
      || liveInsertionSla.liveInsertionSlaPastDeadline === true
      || liveInsertionOwnership.liveInsertionOwnershipOutcome === 'already_inserted_by_manual_run'
    );
  const snapshots = listRecentLiveInsertionAutonomousSnapshots(db, 220)
    .filter((row) => normalizeTradingDayClassification(row?.tradingDayClassification || '') === 'valid_trading_day');
  const rolling = snapshots.slice(0, 5);
  let rolling5dAutonomousInsertRequired = 0;
  let rolling5dAutonomousInsertDelivered = 0;
  let rolling5dAutonomousInsertLate = 0;
  let rolling5dAutonomousInsertMissed = 0;
  for (const row of rolling) {
    const required = row.slaRequiredAny === true;
    if (required) rolling5dAutonomousInsertRequired += 1;
    const delivered = row.ownershipFirstInsertedAutonomous === true;
    if (required && delivered) {
      rolling5dAutonomousInsertDelivered += 1;
      const late = normalizeLiveInsertionSlaOutcome(
        row.ownershipFirstInsertSlaOutcome || row.slaOutcomeLatest
      ) === 'insert_required_success_late';
      if (late) rolling5dAutonomousInsertLate += 1;
    } else if (required) {
      const missed = (
        row.hadMissOutcome === true
        || row.hadPastDeadline === true
        || row.slaPastDeadlineLatest === true
        || row.ownershipFirstInsertedBySource === 'manual_api_run'
      );
      if (missed) rolling5dAutonomousInsertMissed += 1;
    }
  }
  const rolling5dAutonomousInsertRatePct = rolling5dAutonomousInsertRequired > 0
    ? round2((rolling5dAutonomousInsertDelivered / rolling5dAutonomousInsertRequired) * 100)
    : 0;
  let consecutiveAutonomousInsertDays = 0;
  for (const row of snapshots) {
    if (row.slaRequiredAny !== true) break;
    const delivered = row.ownershipFirstInsertedAutonomous === true;
    if (!delivered) break;
    consecutiveAutonomousInsertDays += 1;
  }
  let consecutiveAutonomousInsertMissDays = 0;
  for (const row of snapshots) {
    if (row.slaRequiredAny !== true) break;
    const delivered = row.ownershipFirstInsertedAutonomous === true;
    if (delivered) break;
    const missed = (
      row.hadMissOutcome === true
      || row.hadPastDeadline === true
      || row.slaPastDeadlineLatest === true
      || row.ownershipFirstInsertedBySource === 'manual_api_run'
    );
    if (!missed) break;
    consecutiveAutonomousInsertMissDays += 1;
  }

  return {
    liveAutonomousInsertRequiredToday: latestDayRequired ? 1 : 0,
    liveAutonomousInsertDeliveredToday: latestDayDelivered ? 1 : 0,
    liveAutonomousInsertMissedToday: latestDayMissed ? 1 : 0,
    liveAutonomousInsertLateToday: latestDayLate ? 1 : 0,
    rolling5dAutonomousInsertRequired,
    rolling5dAutonomousInsertDelivered,
    rolling5dAutonomousInsertLate,
    rolling5dAutonomousInsertMissed,
    rolling5dAutonomousInsertRatePct,
    consecutiveAutonomousInsertDays,
    consecutiveAutonomousInsertMissDays,
    advisoryOnly: true,
  };
}

function buildLivePreferredOwnerProof(input = {}) {
  const db = input.db;
  const liveCheckpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const liveInsertionOwnership = input.liveInsertionOwnership && typeof input.liveInsertionOwnership === 'object'
    ? input.liveInsertionOwnership
    : {};
  const liveAutonomousInsertReadiness = input.liveAutonomousInsertReadiness && typeof input.liveAutonomousInsertReadiness === 'object'
    ? input.liveAutonomousInsertReadiness
    : {};
  const liveAutonomousAttemptTransition = input.liveAutonomousAttemptTransition && typeof input.liveAutonomousAttemptTransition === 'object'
    ? input.liveAutonomousAttemptTransition
    : {};
  const liveAutonomousProof = input.liveAutonomousProof && typeof input.liveAutonomousProof === 'object'
    ? input.liveAutonomousProof
    : {};
  const preferredOwnerExpectedSource = normalizeFinalizationSweepSource(
    input.preferredOwnerExpectedSource || 'close_complete_checkpoint'
  );
  const proofCapturedAt = toText(input.proofCapturedAt || new Date().toISOString()) || new Date().toISOString();
  const targetTradingDay = normalizeDate(
    liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || liveCheckpoint.targetTradingDay
    || liveAutonomousInsertReadiness.targetTradingDay
    || liveAutonomousProof.liveAutonomousProofTargetTradingDay
    || ''
  ) || null;
  const tradingDayClassification = normalizeTradingDayClassification(
    liveCheckpoint.tradingDayClassification || 'invalid_mapping'
  );

  const ownershipRow = targetTradingDay
    ? hydrateOwnershipFromRunHistoryIfMissing(db, { targetTradingDay })
    : null;
  const firstRowId = Number(ownershipRow?.created_row_id || 0) || null;
  const firstCreatorRunId = Number(ownershipRow?.first_run_id || 0) || null;
  const firstCreatorMode = toText(ownershipRow?.first_run_mode || '') || null;
  const firstCreatorSource = ownershipRow?.first_run_source
    ? normalizeFinalizationSweepSource(ownershipRow.first_run_source)
    : null;
  const firstCreatorAutonomous = (
    Number(ownershipRow?.first_inserted_autonomous || 0) === 1
    || String(ownershipRow?.first_inserted_autonomous || '').trim().toLowerCase() === 'true'
  );
  const firstCreationTimestamp = toText(ownershipRow?.first_inserted_at || '') || null;
  const firstCreatorRunMeta = readDailyScoringRunMetaById(db, firstCreatorRunId);
  const creationCheckpointStatus = firstCreatorRunMeta?.checkpointStatus
    || (Number(firstCreatorRunId || 0) === Number(input.runId || 0)
      ? normalizeCheckpointStatus(liveCheckpoint.checkpointStatus || '')
      : null);
  const creationAttemptResult = firstCreatorRunMeta?.attemptResult
    || (Number(firstCreatorRunId || 0) === Number(input.runId || 0)
      ? normalizeLiveAutonomousAttemptResult(liveAutonomousAttemptTransition.attemptResult || '')
      : null);
  const creationProofOutcome = firstCreatorRunMeta?.proofOutcome
    || (Number(firstCreatorRunId || 0) === Number(input.runId || 0)
      ? normalizeLiveAutonomousProofOutcome(liveAutonomousProof.liveAutonomousProofOutcome || '')
      : null);
  const currentRunOwnershipOutcome = Number(firstCreatorRunId || 0) === Number(input.runId || 0)
    ? normalizeLiveInsertionOwnershipOutcome(liveInsertionOwnership.liveInsertionOwnershipOutcome || '')
    : null;
  let creationOwnershipOutcome = resolveMostPreciseOwnershipOutcome([
    firstCreatorRunMeta?.ownershipOutcome || '',
    currentRunOwnershipOutcome || '',
  ]);
  if (
    firstCreatorAutonomous === true
    && firstCreatorSource
    && normalizeFinalizationSweepSource(firstCreatorSource) !== 'manual_api_run'
  ) {
    creationOwnershipOutcome = resolveMostPreciseOwnershipOutcome([
      creationOwnershipOutcome,
      'first_autonomous_insert_of_day',
    ]);
  }
  const derivedOwnershipSourceSpecificOutcome = classifyOwnershipSourceSpecificOutcome({
    targetTradingDay,
    tradingDayClassification,
    firstInsertedBySource: firstCreatorSource || '',
    firstInsertedAutonomous: firstCreatorAutonomous === true,
    firstRunMode: firstCreatorMode || '',
    ownershipOutcome: creationOwnershipOutcome || '',
  });
  let creationOwnershipSourceSpecificOutcome = resolveMostPreciseOwnershipSourceSpecificOutcome([
    firstCreatorRunMeta?.ownershipSourceSpecificOutcome || '',
    Number(firstCreatorRunId || 0) === Number(input.runId || 0)
      ? normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || ''
      )
      : '',
    derivedOwnershipSourceSpecificOutcome || '',
  ]);
  if (
    firstCreatorAutonomous === true
    && firstCreatorSource
    && normalizeFinalizationSweepSource(firstCreatorSource) !== 'manual_api_run'
  ) {
    creationOwnershipSourceSpecificOutcome = classifyOwnershipSourceSpecificOutcome({
      targetTradingDay,
      tradingDayClassification,
      firstInsertedBySource: firstCreatorSource,
      firstInsertedAutonomous: true,
      firstRunMode: firstCreatorMode || '',
      ownershipOutcome: 'first_autonomous_insert_of_day',
    });
  }

  const firstCreatorMatchedPreferredOwner = (
    firstCreatorAutonomous === true
    && firstCreatorSource === preferredOwnerExpectedSource
  );
  const preferredOwnerWon = firstCreatorMatchedPreferredOwner === true;
  const preferredOwnerWonFirstEligibleCycle = (
    preferredOwnerWon === true
    && creationCheckpointStatus === 'success_inserted'
    && creationAttemptResult === 'attempt_executed_success'
    && creationProofOutcome === 'proof_attempted_success'
    && creationOwnershipOutcome === 'first_autonomous_insert_of_day'
  );

  let preferredOwnerFailureReason = 'none';
  if (!preferredOwnerWon) {
    if (!targetTradingDay || tradingDayClassification !== 'valid_trading_day') {
      preferredOwnerFailureReason = 'preferred_owner_not_yet_eligible';
    } else if (firstCreatorSource === 'manual_api_run') {
      preferredOwnerFailureReason = 'manual_owner_preempted';
    } else if (
      firstCreatorSource === 'startup_reconciliation'
      || (firstCreatorMode && firstCreatorMode.includes('startup'))
    ) {
      preferredOwnerFailureReason = 'startup_owner_preempted_before_close_complete';
    } else if (firstCreatorSource && firstCreatorSource !== preferredOwnerExpectedSource) {
      preferredOwnerFailureReason = 'existing_row_before_preferred_owner';
    } else if (
      normalizeLiveAutonomousAttemptResult(liveAutonomousAttemptTransition.attemptResult || '')
      === 'attempt_executed_failure'
      || normalizeLiveAutonomousProofOutcome(liveAutonomousProof.liveAutonomousProofOutcome || '')
      === 'proof_attempted_failure'
    ) {
      preferredOwnerFailureReason = 'preferred_owner_attempt_failed';
    } else if (
      normalizeLiveAutonomousProofOutcome(liveAutonomousProof.liveAutonomousProofOutcome || '')
      === 'proof_eligible_not_attempted_bug'
      || normalizeLiveAutonomousAttemptResult(liveAutonomousAttemptTransition.attemptResult || '')
      === 'attempt_skipped_bug'
      || (
        liveAutonomousInsertReadiness.autonomousInsertEligible === true
        && liveAutonomousProof.liveAutonomousProofAttempted !== true
      )
    ) {
      preferredOwnerFailureReason = 'preferred_owner_not_run';
    } else if (
      liveAutonomousInsertReadiness.autonomousInsertEligible !== true
      || liveAutonomousInsertReadiness.closeComplete !== true
      || liveAutonomousInsertReadiness.requiredMarketDataPresent !== true
      || liveAutonomousInsertReadiness.liveContextPresent !== true
    ) {
      preferredOwnerFailureReason = 'preferred_owner_not_yet_eligible';
    } else {
      preferredOwnerFailureReason = 'unknown_owner_precedence_failure';
    }
  }
  preferredOwnerFailureReason = normalizeLivePreferredOwnerFailureReason(preferredOwnerFailureReason);

  const persistedRow = targetTradingDay
    ? upsertLivePreferredOwnerProofRow(db, {
      targetTradingDay,
      preferredOwnerExpectedSource,
      firstRowId,
      firstCreatorRunId,
      firstCreatorMode,
      firstCreatorSource,
      firstCreatorAutonomous,
      firstCreationTimestamp,
      firstCreationCheckpointStatus: creationCheckpointStatus,
      firstCreationAttemptResult: creationAttemptResult,
      firstCreationProofOutcome: creationProofOutcome,
      firstCreationOwnershipOutcome: creationOwnershipOutcome,
      firstCreationOwnershipSourceSpecificOutcome: creationOwnershipSourceSpecificOutcome,
      preferredOwnerWon,
      preferredOwnerWonFirstEligibleCycle,
      preferredOwnerFailureReason,
      preferredOwnerProofCapturedAt: proofCapturedAt,
    })
    : null;

  const materializedRow = persistedRow || {
    target_trading_day: targetTradingDay,
    preferred_owner_expected_source: preferredOwnerExpectedSource,
    first_row_id: firstRowId,
    first_creator_run_id: firstCreatorRunId,
    first_creator_mode: firstCreatorMode,
    first_creator_source: firstCreatorSource,
    first_creator_autonomous: firstCreatorAutonomous ? 1 : 0,
    first_creation_timestamp: firstCreationTimestamp,
    first_creation_checkpoint_status: creationCheckpointStatus,
    first_creation_attempt_result: creationAttemptResult,
    first_creation_proof_outcome: creationProofOutcome,
    first_creation_ownership_outcome: creationOwnershipOutcome,
    first_creation_ownership_source_specific_outcome: creationOwnershipSourceSpecificOutcome,
    preferred_owner_won: preferredOwnerWon ? 1 : 0,
    preferred_owner_won_first_eligible_cycle: preferredOwnerWonFirstEligibleCycle ? 1 : 0,
    preferred_owner_failure_reason: preferredOwnerFailureReason,
    preferred_owner_proof_captured_at: proofCapturedAt,
  };

  const actualSource = materializedRow?.first_creator_source
    ? normalizeFinalizationSweepSource(materializedRow.first_creator_source)
    : null;
  const won = (
    Number(materializedRow?.preferred_owner_won || 0) === 1
    || String(materializedRow?.preferred_owner_won || '').trim().toLowerCase() === 'true'
  );
  const wonFirstEligibleCycle = (
    Number(materializedRow?.preferred_owner_won_first_eligible_cycle || 0) === 1
    || String(materializedRow?.preferred_owner_won_first_eligible_cycle || '').trim().toLowerCase() === 'true'
  );

  return {
    livePreferredOwnerTargetTradingDay: normalizeDate(materializedRow?.target_trading_day || targetTradingDay || '') || null,
    livePreferredOwnerProofRowId: Number(materializedRow?.proof_row_id || 0) || null,
    livePreferredOwnerExpectedSource: normalizeFinalizationSweepSource(
      materializedRow?.preferred_owner_expected_source || preferredOwnerExpectedSource
    ),
    livePreferredOwnerActualSource: actualSource,
    livePreferredOwnerWon: won === true,
    livePreferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
      materializedRow?.preferred_owner_failure_reason || preferredOwnerFailureReason
    ),
    livePreferredOwnerProofCapturedAt: toText(
      materializedRow?.preferred_owner_proof_captured_at || proofCapturedAt
    ) || null,
    livePreferredOwnerFirstRowId: Number(materializedRow?.first_row_id || 0) || null,
    livePreferredOwnerFirstCreatorRunId: Number(materializedRow?.first_creator_run_id || 0) || null,
    livePreferredOwnerFirstCreatorMode: toText(materializedRow?.first_creator_mode || firstCreatorMode || '') || null,
    livePreferredOwnerFirstCreatorSource: actualSource,
    livePreferredOwnerFirstCreatorAutonomous: (
      Number(materializedRow?.first_creator_autonomous || 0) === 1
      || String(materializedRow?.first_creator_autonomous || '').trim().toLowerCase() === 'true'
    ),
    livePreferredOwnerFirstCreatorMatchedPreferredOwner: (
      actualSource === normalizeFinalizationSweepSource(materializedRow?.preferred_owner_expected_source || preferredOwnerExpectedSource)
      && (
        Number(materializedRow?.first_creator_autonomous || 0) === 1
        || String(materializedRow?.first_creator_autonomous || '').trim().toLowerCase() === 'true'
      )
    ),
    livePreferredOwnerWonFirstEligibleCycle: wonFirstEligibleCycle === true,
    livePreferredOwnerFirstCreationTimestamp: toText(materializedRow?.first_creation_timestamp || firstCreationTimestamp || '') || null,
    livePreferredOwnerCreationCheckpointStatus: materializedRow?.first_creation_checkpoint_status
      ? normalizeCheckpointStatus(materializedRow.first_creation_checkpoint_status)
      : null,
    livePreferredOwnerCreationAttemptResult: materializedRow?.first_creation_attempt_result
      ? normalizeLiveAutonomousAttemptResult(materializedRow.first_creation_attempt_result)
      : null,
    livePreferredOwnerCreationProofOutcome: materializedRow?.first_creation_proof_outcome
      ? normalizeLiveAutonomousProofOutcome(materializedRow.first_creation_proof_outcome)
      : null,
    livePreferredOwnerCreationOwnershipOutcome: materializedRow?.first_creation_ownership_outcome
      ? normalizeLiveInsertionOwnershipOutcome(materializedRow.first_creation_ownership_outcome)
      : null,
    livePreferredOwnerCreationOwnershipSourceSpecificOutcome: materializedRow?.first_creation_ownership_source_specific_outcome
      ? normalizeLiveInsertionOwnershipSourceSpecificOutcome(materializedRow.first_creation_ownership_source_specific_outcome)
      : null,
    advisoryOnly: true,
  };
}

function buildLivePreferredOwnerMetrics(input = {}) {
  const db = input.db;
  const livePreferredOwnerProof = input.livePreferredOwnerProof && typeof input.livePreferredOwnerProof === 'object'
    ? input.livePreferredOwnerProof
    : {};
  const legacyMetrics = input.legacyMetrics && typeof input.legacyMetrics === 'object'
    ? input.legacyMetrics
    : {};
  const targetRows = listRecentLivePreferredOwnerProofRows(db, 80)
    .map((row) => ({
      targetTradingDay: normalizeDate(row?.target_trading_day || ''),
      preferredOwnerWon: (
        Number(row?.preferred_owner_won || 0) === 1
        || String(row?.preferred_owner_won || '').trim().toLowerCase() === 'true'
      ),
      failureReason: normalizeLivePreferredOwnerFailureReason(row?.preferred_owner_failure_reason || 'none'),
      firstCreatorSource: normalizeFinalizationSweepSource(row?.first_creator_source || ''),
      proofCapturedAt: toText(row?.preferred_owner_proof_captured_at || row?.updated_at || '') || null,
    }))
    .filter((row) => !!row.targetTradingDay)
    .sort((a, b) => String(b.targetTradingDay || '').localeCompare(String(a.targetTradingDay || '')));

  const isRequired = (row = {}) => {
    if (!row || !row.targetTradingDay) return false;
    if (row.preferredOwnerWon === true) return true;
    if (row.firstCreatorSource) return true;
    if (row.failureReason && row.failureReason !== 'none' && row.failureReason !== 'preferred_owner_not_yet_eligible') return true;
    return false;
  };
  const isWon = (row = {}) => row.preferredOwnerWon === true;
  const isMissed = (row = {}) => {
    if (!isRequired(row)) return false;
    if (isWon(row)) return false;
    return row.failureReason !== 'none' && row.failureReason !== 'preferred_owner_not_yet_eligible';
  };

  const requiredRows = targetRows.filter((row) => isRequired(row));
  const rolling = requiredRows.slice(0, 5);
  let rollingRequired = 0;
  let rollingWins = 0;
  let rollingMisses = 0;
  for (const row of rolling) {
    rollingRequired += 1;
    if (isWon(row)) rollingWins += 1;
    else if (isMissed(row)) rollingMisses += 1;
  }
  const rolling5dPreferredOwnerWinRatePct = rollingRequired > 0
    ? round2((rollingWins / rollingRequired) * 100)
    : 0;
  let consecutivePreferredOwnerWinDays = 0;
  for (const row of requiredRows) {
    if (!isWon(row)) break;
    consecutivePreferredOwnerWinDays += 1;
  }
  let consecutivePreferredOwnerMissDays = 0;
  for (const row of requiredRows) {
    if (!isMissed(row)) break;
    consecutivePreferredOwnerMissDays += 1;
  }

  const todayTarget = normalizeDate(
    livePreferredOwnerProof.livePreferredOwnerTargetTradingDay
    || ''
  ) || null;
  const todayRow = todayTarget
    ? targetRows.find((row) => row.targetTradingDay === todayTarget) || null
    : null;
  const preferredOwnerWonToday = todayRow && isWon(todayRow) ? 1 : 0;
  const preferredOwnerMissedToday = todayRow && isMissed(todayRow) ? 1 : 0;

  const normalizedLegacy = {
    preferredOwnerWonToday: Number(legacyMetrics.preferredOwnerWonToday || 0),
    preferredOwnerMissedToday: Number(legacyMetrics.preferredOwnerMissedToday || 0),
    rolling5dPreferredOwnerWinRatePct: round2(legacyMetrics.rolling5dPreferredOwnerWinRatePct || 0),
    consecutivePreferredOwnerWinDays: Number(legacyMetrics.consecutivePreferredOwnerWinDays || 0),
    consecutivePreferredOwnerMissDays: Number(legacyMetrics.consecutivePreferredOwnerMissDays || 0),
  };
  let livePreferredOwnerKpiConsistent = true;
  let livePreferredOwnerKpiMismatchReason = 'none';
  if (!targetRows.length) {
    livePreferredOwnerKpiConsistent = true;
    livePreferredOwnerKpiMismatchReason = 'proof_rows_unavailable';
  } else if (Object.keys(legacyMetrics).length > 0) {
    if (normalizedLegacy.preferredOwnerWonToday !== preferredOwnerWonToday) {
      livePreferredOwnerKpiConsistent = false;
      livePreferredOwnerKpiMismatchReason = 'preferred_owner_won_today_mismatch';
    } else if (normalizedLegacy.preferredOwnerMissedToday !== preferredOwnerMissedToday) {
      livePreferredOwnerKpiConsistent = false;
      livePreferredOwnerKpiMismatchReason = 'preferred_owner_missed_today_mismatch';
    } else if (Math.abs(normalizedLegacy.rolling5dPreferredOwnerWinRatePct - rolling5dPreferredOwnerWinRatePct) > 0.01) {
      livePreferredOwnerKpiConsistent = false;
      livePreferredOwnerKpiMismatchReason = 'rolling5d_win_rate_mismatch';
    } else if (normalizedLegacy.consecutivePreferredOwnerWinDays !== consecutivePreferredOwnerWinDays) {
      livePreferredOwnerKpiConsistent = false;
      livePreferredOwnerKpiMismatchReason = 'consecutive_win_streak_mismatch';
    } else if (normalizedLegacy.consecutivePreferredOwnerMissDays !== consecutivePreferredOwnerMissDays) {
      livePreferredOwnerKpiConsistent = false;
      livePreferredOwnerKpiMismatchReason = 'consecutive_miss_streak_mismatch';
    }
  }

  return {
    preferredOwnerWonToday,
    preferredOwnerMissedToday,
    rolling5dPreferredOwnerWinRatePct,
    consecutivePreferredOwnerWinDays,
    consecutivePreferredOwnerMissDays,
    rolling5dPreferredOwnerRequired: rollingRequired,
    rolling5dPreferredOwnerWins: rollingWins,
    rolling5dPreferredOwnerMisses: rollingMisses,
    livePreferredOwnerKpiConsistent: livePreferredOwnerKpiConsistent === true,
    livePreferredOwnerKpiMismatchReason: normalizeLivePreferredOwnerKpiMismatchReason(
      livePreferredOwnerKpiMismatchReason
    ),
    livePreferredOwnerKpiSource: 'jarvis_live_preferred_owner_proof',
    advisoryOnly: true,
  };
}

function buildLiveInsertionSla(input = {}) {
  const db = input.db;
  const checkpoint = input.liveCheckpoint && typeof input.liveCheckpoint === 'object'
    ? input.liveCheckpoint
    : {};
  const nowDate = normalizeDate(input.nowDate || checkpoint.runtimeCheckpointTriggeredAt || checkpoint.checkpointCompletedAt || '');
  const nowTime = normalizeTimeOfDay(
    input.nowTime
    || input.nowEt?.time
    || '00:00',
    '00:00'
  );
  const targetTradingDay = normalizeDate(
    checkpoint.targetTradingDay
    || checkpoint.runtimeCheckpointTargetTradingDay
    || ''
  ) || null;
  const tradingDayClassification = normalizeTradingDayClassification(
    checkpoint.tradingDayClassification
    || (targetTradingDay ? classifyTradingDay({ date: targetTradingDay, sessionForDate: [] }).classification : 'invalid_mapping')
  );
  const checkpointStatus = normalizeCheckpointStatus(checkpoint.checkpointStatus || '');
  const checkpointReason = normalizeCheckpointReason(checkpoint.checkpointReason || '');
  const closeCompleteReason = normalizeCloseCompleteReason(checkpoint.closeCompleteReason);
  const windowOpenedAt = toText(checkpoint.checkpointWindowOpenedAt || '') || null;
  const deadlineAt = toText(checkpoint.checkpointDeadlineAt || '') || null;
  const runtimeSource = normalizeFinalizationSweepSource(
    checkpoint.runtimeCheckpointSource
    || checkpoint.sweepSource
    || 'manual_api_run'
  );
  const runtimeTriggeredAt = toText(
    checkpoint.runtimeCheckpointTriggeredAt
    || checkpoint.checkpointCompletedAt
    || checkpoint.checkpointEvaluatedAt
    || ''
  ) || null;
  const withinWindow = checkpoint.checkpointWithinAllowedWindow === true;
  const pastDeadline = checkpoint.checkpointPastDeadline === true;
  const liveOutcomeRow = readLiveOutcomeRowByIdentity(db, targetTradingDay || '');
  const liveOutcomeExists = checkpoint.liveOutcomeExists === true || !!liveOutcomeRow;
  const liveOutcomeInsertedThisCheckpoint = checkpoint.liveOutcomeInsertedThisCheckpoint === true;
  const expectedLiveContextExists = checkpoint.expectedLiveContextExists === true;
  const liveContextSuppressed = checkpoint.liveContextSuppressed === true;
  const closeComplete = checkpoint.closeComplete === true;
  const requiredCloseDataPresent = checkpoint.requiredCloseDataPresent === true;
  const requiredCloseBarsPresent = checkpoint.requiredCloseBarsPresent === true;

  let liveInsertionSlaRequired = false;
  let liveInsertionSlaOutcome = 'insert_required_waiting_window';
  let liveInsertionSlaFailureReason = null;
  const liveInsertionSlaAlreadyFinalizedBeforeWindow = (
    checkpointStatus === 'success_already_finalized'
    && liveOutcomeExists
    && !liveOutcomeInsertedThisCheckpoint
  );

  if (!targetTradingDay || tradingDayClassification !== 'valid_trading_day') {
    liveInsertionSlaRequired = false;
    liveInsertionSlaOutcome = 'insert_required_blocked_invalid_day';
    liveInsertionSlaFailureReason = checkpointReason === 'blocked_non_trading_day'
      ? 'non_trading_day'
      : 'invalid_trading_day_mapping';
  } else if (!expectedLiveContextExists || liveContextSuppressed) {
    liveInsertionSlaRequired = true;
    liveInsertionSlaOutcome = 'insert_required_missing_context';
    liveInsertionSlaFailureReason = 'missing_live_context';
  } else if (liveInsertionSlaAlreadyFinalizedBeforeWindow) {
    liveInsertionSlaRequired = false;
    liveInsertionSlaOutcome = 'insert_not_required_already_finalized';
  } else {
    liveInsertionSlaRequired = true;
    if (!closeComplete) {
      if (
        closeCompleteReason === 'awaiting_required_market_data'
        || closeCompleteReason === 'awaiting_close_bar_completion'
        || checkpointStatus === 'failure_missing_market_data'
      ) {
        liveInsertionSlaOutcome = 'insert_required_missing_market_data';
        liveInsertionSlaFailureReason = 'missing_required_market_data';
      } else if (pastDeadline || checkpointStatus === 'failure_scheduler_miss') {
        liveInsertionSlaOutcome = 'insert_required_missed';
        liveInsertionSlaFailureReason = 'checkpoint_window_missed';
      } else {
        liveInsertionSlaOutcome = 'insert_required_waiting_window';
      }
    } else if (liveOutcomeInsertedThisCheckpoint) {
      liveInsertionSlaOutcome = withinWindow
        ? 'insert_required_success_on_time'
        : 'insert_required_success_late';
    } else if (checkpointStatus === 'failure_missing_context') {
      liveInsertionSlaOutcome = 'insert_required_missing_context';
      liveInsertionSlaFailureReason = normalizeCheckpointFailureReason(checkpoint.failureReason) || 'missing_live_context';
    } else if (checkpointStatus === 'failure_missing_market_data') {
      liveInsertionSlaOutcome = 'insert_required_missing_market_data';
      liveInsertionSlaFailureReason = normalizeCheckpointFailureReason(checkpoint.failureReason) || 'missing_required_market_data';
    } else if (checkpointStatus === 'failure_duplicate_state' || checkpointStatus === 'failure_unknown') {
      liveInsertionSlaOutcome = 'insert_required_failed_attempt';
      liveInsertionSlaFailureReason = normalizeCheckpointFailureReason(checkpoint.failureReason) || 'insert_attempt_failed';
    } else if (checkpointStatus === 'failure_scheduler_miss' || pastDeadline) {
      liveInsertionSlaOutcome = 'insert_required_missed';
      liveInsertionSlaFailureReason = normalizeCheckpointFailureReason(checkpoint.failureReason) || 'checkpoint_window_missed';
    } else if (liveOutcomeExists && checkpointStatus === 'success_already_finalized') {
      liveInsertionSlaOutcome = 'insert_not_required_already_finalized';
      liveInsertionSlaRequired = false;
    } else {
      liveInsertionSlaOutcome = 'insert_required_failed_attempt';
      liveInsertionSlaFailureReason = normalizeCheckpointFailureReason(checkpoint.failureReason) || 'insert_attempt_failed';
    }
  }

  const liveInsertionSlaNetNewRowCreated = liveOutcomeInsertedThisCheckpoint === true;
  const liveInsertionSlaCreatedRowId = liveInsertionSlaNetNewRowCreated
    ? Number(liveOutcomeRow?.id || 0) || null
    : null;
  const currentEtLabel = buildEtDateTimeLabel(nowDate, nowTime);
  const lateByMinutes = (
    normalizeLiveInsertionSlaOutcome(liveInsertionSlaOutcome) === 'insert_required_success_late'
    && currentEtLabel
    && deadlineAt
  )
    ? Math.max(0, Number(diffEtDateTimeLabelMinutes(currentEtLabel, deadlineAt) || 0))
    : 0;

  return {
    liveInsertionSlaTargetTradingDay: targetTradingDay,
    tradingDayClassification,
    liveInsertionSlaRequired: liveInsertionSlaRequired === true,
    liveInsertionSlaOutcome: normalizeLiveInsertionSlaOutcome(liveInsertionSlaOutcome),
    liveInsertionSlaWasAutonomous: checkpoint.runtimeCheckpointWasAutonomous === true && runtimeSource !== 'manual_api_run',
    liveInsertionSlaSource: runtimeSource,
    liveInsertionSlaTriggeredAt: runtimeTriggeredAt,
    liveInsertionSlaWindowOpenedAt: windowOpenedAt,
    liveInsertionSlaDeadlineAt: deadlineAt,
    liveInsertionSlaWithinWindow: withinWindow === true,
    liveInsertionSlaPastDeadline: pastDeadline === true,
    liveInsertionSlaNetNewRowCreated: liveInsertionSlaNetNewRowCreated === true,
    liveInsertionSlaCreatedRowId,
    liveInsertionSlaFailureReason: liveInsertionSlaFailureReason || null,
    liveInsertionSlaLateByMinutes: Number(lateByMinutes || 0),
    liveInsertionSlaAlreadyFinalizedBeforeWindow: liveInsertionSlaAlreadyFinalizedBeforeWindow === true,
    liveInsertionSlaCloseComplete: closeComplete === true,
    liveInsertionSlaRequiredCloseDataPresent: requiredCloseDataPresent === true,
    liveInsertionSlaRequiredCloseBarsPresent: requiredCloseBarsPresent === true,
    liveInsertionSlaExpectedOutcomeCount: Number(checkpoint.checkpointExpectedOutcomeCount || 0),
    liveInsertionSlaActualOutcomeCount: Number(checkpoint.checkpointActualOutcomeCount || 0),
    advisoryOnly: true,
  };
}

function buildPerDateStrategySnapshotForScoring(date, sessions = {}) {
  const day = normalizeDate(date);
  const candles = Array.isArray(sessions?.[day]) ? sessions[day] : null;
  if (!day || !candles || candles.length === 0) return { layers: {} };
  const singleSession = { [day]: candles };
  const original = runPlanBacktest(singleSession, ORIGINAL_PLAN_SPEC, { includePerDate: true });
  const variants = (Array.isArray(DEFAULT_VARIANT_SPECS) ? DEFAULT_VARIANT_SPECS : [])
    .map((spec) => runPlanBacktest(singleSession, spec, { includePerDate: true }));
  return {
    layers: {
      original: {
        key: original?.key,
        name: original?.name,
        perDate: original?.perDate || {},
      },
      variants: {
        tested: variants.map((report) => ({
          key: report?.key,
          name: report?.name,
          perDate: report?.perDate || {},
        })),
      },
    },
  };
}

function persistDailyScoringRun(db, input = {}) {
  ensureDailyScoringTables(db);
  const runOrigin = normalizeDailyScoringRunOrigin(input.runOrigin || '');
  const row = db.prepare(`
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
      details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizeDate(input.runDate || new Date().toISOString()),
    toText(input.mode || 'auto') || 'auto',
    runOrigin,
    Number(input.windowDays || 0),
    Number(input.contextsSeen || 0),
    Number(input.scoredRows || 0),
    Number(input.insertedRows || 0),
    Number(input.updatedRows || 0),
    toText(input.status || 'noop') || 'noop',
    toText(input.errorMessage || '') || null,
    JSON.stringify(input.details || {})
  );
  return Number(row.lastInsertRowid || 0) || 0;
}

function updateDailyScoringRunDetails(db, runId, details = {}) {
  const id = Number(runId || 0);
  if (!db || typeof db.prepare !== 'function' || !Number.isFinite(id) || id <= 0) return false;
  try {
    const out = db.prepare(`
      UPDATE jarvis_daily_scoring_runs
      SET details_json = ?
      WHERE id = ?
    `).run(JSON.stringify(details || {}), id);
    return Number(out?.changes || 0) > 0;
  } catch {
    return false;
  }
}

function getLatestDailyScoringRun(db) {
  ensureDailyScoringTables(db);
  const row = db.prepare(`
    SELECT *
    FROM jarvis_daily_scoring_runs
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  let details = {};
  try { details = JSON.parse(String(row.details_json || '{}')); } catch {}
  return {
    id: row.id,
    runDate: normalizeDate(row.run_date),
    mode: toText(row.mode || '') || 'auto',
    runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
    windowDays: Number(row.window_days || 0),
    contextsSeen: Number(row.contexts_seen || 0),
    scoredRows: Number(row.scored_rows || 0),
    insertedRows: Number(row.inserted_rows || 0),
    updatedRows: Number(row.updated_rows || 0),
    status: toText(row.status || '') || 'noop',
    errorMessage: toText(row.error_message || '') || null,
    details,
    createdAt: toText(row.created_at || '') || null,
  };
}

function shouldSkipExistingScore(db, contextRow = {}, force = false) {
  if (force) return false;
  const date = normalizeDate(contextRow?.rec_date || '');
  const sourceType = toText(contextRow?.source_type || '').toLowerCase() || 'live';
  const reconstructionPhase = toText(contextRow?.reconstruction_phase || '').toLowerCase() || 'live_intraday';
  if (!date) return false;
  const row = db.prepare(`
    SELECT id
    FROM jarvis_scored_trade_outcomes
    WHERE score_date = ? AND source_type = ? AND reconstruction_phase = ?
    LIMIT 1
  `).get(date, sourceType, reconstructionPhase);
  return !!row;
}

function runAutomaticDailyScoring(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'error',
      error: 'db_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDailyScoringTables(db);
  const nowDate = normalizeDate(input.nowDate || new Date().toISOString());
  const mode = toText(input.mode || 'auto') || 'auto';
  const nowTime = normalizeTimeOfDay(input.nowTime || input.nowEt?.time || '00:00', '00:00');
  const windowDays = clampInt(input.windowDays, 1, 60, 3);
  const force = input.force === true;
  const runOrigin = inferDailyScoringRunOrigin({
    runOrigin: input.runOrigin,
    runtimeTriggered: input.runtimeTriggered === true,
    mode,
    force,
  });
  const finalizationOnly = input.finalizationOnly === true
    || mode.toLowerCase().includes('finalization');
  const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const liveFinalizationSweepSource = normalizeFinalizationSweepSource(
    input.finalizationSweepSource || deriveFinalizationSweepSource(mode, finalizationOnly)
  );
  const liveAutonomousFirstRight = buildLiveAutonomousFirstRightContract({
    db,
    nowDate,
    nowTime,
    mode,
    sweepSource: liveFinalizationSweepSource,
    targetTradingDay: input.checkpointTargetTradingDay,
    finalizationOnly,
    sessions,
  });
  const initialLivePreferredOwnerReservation = buildLivePreferredOwnerReservation({
    db,
    nowDate,
    mode,
    nowTime,
    sweepSource: liveFinalizationSweepSource,
    targetTradingDay: liveAutonomousFirstRight.liveAutonomousFirstRightTargetTradingDay
      || input.checkpointTargetTradingDay
      || null,
    liveAutonomousFirstRight,
    sessions,
    finalizationOnly,
  });
  let livePreferredOwnerDeferredFallbackSource = null;
  let livePreferredOwnerDeferredFallbackReason = null;
  let livePreferredOwnerDeferredFallbackAt = null;
  const sinceDate = addDays(nowDate, -(windowDays - 1)) || nowDate;
  const liveContextAudit = auditAndSuppressInvalidLiveContexts({
    db,
    sessions,
    nowDate,
    lookbackDays: Number(input.liveContextAuditLookbackDays || 60),
    triggerSource: `daily_scoring_${toText(mode || 'auto').toLowerCase() || 'auto'}`,
  });
  const runTradeMechanicsVariantTool = typeof input.runTradeMechanicsVariantTool === 'function'
    ? input.runTradeMechanicsVariantTool
    : null;

  const contexts = finalizationOnly
    ? []
    : listRecommendationContexts(db, {
      limit: windowDays * 8,
      sinceDate,
      source: 'all',
    });
  const liveWindowContexts = listRecommendationContexts(db, {
    limit: Math.max(30, windowDays * 10),
    sinceDate,
    source: 'live',
    reconstructionPhase: 'live_intraday',
  });
  const liveBridgeLookbackDays = clampInt(
    input.liveBridgeLookbackDays,
    7,
    60,
    Math.max(14, windowDays + 7)
  );
  const liveBridgeSinceDate = addDays(nowDate, -(liveBridgeLookbackDays - 1)) || sinceDate;
  const unresolvedLiveContexts = listUnscoredLiveRecommendationContexts(db, {
    sinceDate: liveBridgeSinceDate,
    limit: Math.max(30, windowDays * 12),
  });
  const mergedContexts = mergeContextRowsByIdentity([
    ...contexts,
    ...liveWindowContexts,
    ...unresolvedLiveContexts,
  ]);
  const sorted = mergedContexts
    .slice()
    .sort((a, b) => String(a.rec_date || '').localeCompare(String(b.rec_date || '')));

  let scoredRows = 0;
  let insertedRows = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  const warnings = [];
  const skipReasonBuckets = {};
  const sourceTypeMetrics = {
    live: {
      contextsSeen: 0,
      contextsEligibleForScoring: 0,
      contextsScored: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      contextsSkipped: 0,
      skipReasonBuckets: {},
    },
    backfill: {
      contextsSeen: 0,
      contextsEligibleForScoring: 0,
      contextsScored: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      contextsSkipped: 0,
      skipReasonBuckets: {},
    },
  };
  const liveContextDecisions = [];
  const liveReasonBuckets = {};
  const liveBlockedReasonBuckets = {};
  const liveIdentitySeen = new Set();
  const liveUnconvertedDateReasonMap = new Map();
  let liveContextsFreshInserted = 0;
  let liveContextsUpdatedOnly = 0;
  let liveContextsBlocked = 0;
  const liveFinalizationReasonBuckets = {};
  const liveFinalizationWaitingBuckets = {};
  const liveFinalizationBlockedBuckets = {};
  const liveFinalizationStateBuckets = {};
  const liveTradingDayClassificationBuckets = {};
  const latestReadyButUninsertedMap = new Map();
  const latestWaitingMap = new Map();
  const latestBlockedMap = new Map();
  const liveFinalizationPendingDateReasonMap = new Map();
  const liveFinalizationByDate = new Map();
  const liveScoringByDate = new Map();
  let finalizedInsertedCount = 0;
  let finalizedUpdatedCount = 0;
  let alreadyFinalizedCount = 0;
  let waitingFinalizationCount = 0;
  let blockedFinalizationCount = 0;
  let validLiveDaysSeen = 0;
  let validLiveDaysReadyToFinalize = 0;
  let validLiveDaysFinalizedInserted = 0;
  let validLiveDaysFinalizedUpdated = 0;
  let validLiveDaysStillWaiting = 0;
  let validLiveDaysBlocked = 0;
  let validLiveDaysMissedByScheduler = 0;

  const bump = (obj, key) => {
    const k = toText(key || '').toLowerCase();
    if (!k) return;
    obj[k] = Number(obj[k] || 0) + 1;
  };

  const isWaitingFinalizationReason = (reason = '') => (
    reason === 'awaiting_session_close'
    || reason === 'awaiting_next_day_window'
    || reason === 'awaiting_required_market_data'
  );

  const isBlockedFinalizationReason = (reason = '') => (
    reason !== 'finalized_and_inserted'
    && reason !== 'finalized_and_updated'
    && reason !== 'already_finalized'
    && !isWaitingFinalizationReason(reason)
  );

  const recordLiveFinalizationDecision = (decision = {}) => {
    const reason = normalizeFinalizationReason(decision.reason || '');
    const state = normalizeFinalizationReadinessState(
      decision.state || mapFinalizationReasonToReadinessState(reason)
    );
    const classification = normalizeTradingDayClassification(decision.classification || '');
    const classificationReason = toText(decision.classificationReason || '') || 'unknown';
    const recDate = normalizeDate(decision.recDate || '');
    bump(liveFinalizationReasonBuckets, reason);
    bump(liveFinalizationStateBuckets, state);
    bump(liveTradingDayClassificationBuckets, classification);
    if (classification === 'valid_trading_day') validLiveDaysSeen += 1;
    if (classification === 'valid_trading_day' && state === 'ready_to_finalize') validLiveDaysReadyToFinalize += 1;
    if (reason === 'finalized_and_inserted') finalizedInsertedCount += 1;
    else if (reason === 'finalized_and_updated') finalizedUpdatedCount += 1;
    else if (reason === 'already_finalized') alreadyFinalizedCount += 1;
    if (classification === 'valid_trading_day' && reason === 'finalized_and_inserted') validLiveDaysFinalizedInserted += 1;
    if (classification === 'valid_trading_day' && reason === 'finalized_and_updated') validLiveDaysFinalizedUpdated += 1;
    if (classification === 'valid_trading_day' && isWaitingFinalizationReason(reason)) validLiveDaysStillWaiting += 1;
    if (classification === 'valid_trading_day' && isBlockedFinalizationReason(reason)) validLiveDaysBlocked += 1;
    if (recDate) {
      liveFinalizationByDate.set(recDate, {
        recDate,
        reason,
        state,
        classification,
        classificationReason,
      });
    }
    if (recDate && classification === 'valid_trading_day' && state === 'ready_to_finalize') {
      const unresolvedReadyInsert = (
        reason !== 'finalized_and_inserted'
        && reason !== 'finalized_and_updated'
        && reason !== 'already_finalized'
      );
      if (unresolvedReadyInsert) {
        validLiveDaysMissedByScheduler += 1;
        latestReadyButUninsertedMap.set(recDate, {
          date: recDate,
          reason,
          classification,
          classificationReason,
        });
      } else {
        latestReadyButUninsertedMap.delete(recDate);
      }
    } else if (isWaitingFinalizationReason(reason)) {
      waitingFinalizationCount += 1;
      bump(liveFinalizationWaitingBuckets, reason);
      if (recDate) {
        liveFinalizationPendingDateReasonMap.set(recDate, reason);
        latestWaitingMap.set(recDate, {
          date: recDate,
          reason,
          classification,
          classificationReason,
        });
      }
    } else if (isBlockedFinalizationReason(reason)) {
      blockedFinalizationCount += 1;
      bump(liveFinalizationBlockedBuckets, reason);
      if (recDate) {
        liveFinalizationPendingDateReasonMap.set(recDate, reason);
        latestBlockedMap.set(recDate, {
          date: recDate,
          reason,
          classification,
          classificationReason,
        });
      }
    }
  };

  const recordLiveDecision = (decision = {}) => {
    const reason = normalizeLiveReason(decision.reason || decision.skipReason);
    const recDate = normalizeDate(decision.recDate || '');
    const inserted = Number(decision.inserted || 0);
    const updated = Number(decision.updated || 0);
    const eligibleForScoring = decision.eligibleForScoring === true;
    const scored = decision.scored === true;
    bump(liveReasonBuckets, reason);
    const insertedFresh = inserted > 0 && reason === 'eligible_and_inserted';
    if (insertedFresh) {
      liveContextsFreshInserted += 1;
    } else {
      liveUnconvertedDateReasonMap.set(recDate, reason);
      if (reason !== 'eligible_and_inserted') bump(liveBlockedReasonBuckets, reason);
      if (reason === 'eligible_and_updated') liveContextsUpdatedOnly += 1;
      if (!eligibleForScoring || !scored || reason !== 'eligible_and_updated') liveContextsBlocked += 1;
    }
    if (liveContextDecisions.length < 120) {
      liveContextDecisions.push({
        recDate,
        sourceType: 'live',
        eligibleForScoring,
        scored,
        inserted,
        updated,
        reason,
        readinessState: normalizeFinalizationReadinessState(decision.readinessState || mapFinalizationReasonToReadinessState(decision.finalizationReason || 'other_blocked')),
        tradingDayClassification: normalizeTradingDayClassification(decision.tradingDayClassification || 'invalid_mapping'),
      });
    }
    if (recDate) {
      liveScoringByDate.set(recDate, {
        recDate,
        reason,
        inserted: Number(inserted || 0),
        updated: Number(updated || 0),
        eligibleForScoring: eligibleForScoring === true,
        scored: scored === true,
      });
    }
  };

  const markSkip = (sourceType, reason, date = '', extra = {}, finalizationMeta = {}) => {
    const src = sourceType === 'backfill' ? 'backfill' : 'live';
    skippedRows += 1;
    sourceTypeMetrics[src].contextsSkipped += 1;
    bump(skipReasonBuckets, reason);
    bump(sourceTypeMetrics[src].skipReasonBuckets, reason);
    if (src === 'live') {
      const finalizationReasonMap = {
        eligible_and_inserted: 'finalized_and_inserted',
        eligible_and_updated: 'finalized_and_updated',
        already_scored: 'already_finalized',
        awaiting_outcome_window: isSameDate(date, nowDate) ? 'awaiting_session_close' : 'awaiting_next_day_window',
        missing_market_session_data: 'awaiting_required_market_data',
        missing_trade_window_close: isSameDate(date, nowDate) ? 'awaiting_session_close' : 'awaiting_required_market_data',
        missing_context_alignment: 'missing_live_context_alignment',
        source_type_mismatch: 'other_blocked',
        invalid_live_session_mapping: 'invalid_trading_day_mapping',
        duplicate_live_identity: 'duplicate_finalization_identity',
        manual_insert_deferred_to_autonomous_window: 'awaiting_next_day_window',
        autonomous_insert_deferred_to_preferred_owner: 'awaiting_next_day_window',
      };
      const finalizationReason = normalizeFinalizationReason(
        finalizationReasonMap[String(reason || '').trim().toLowerCase()] || 'other_blocked'
      );
      const fallbackClassification = classifyTradingDay({
        date,
        sessionForDate: Array.isArray(extra?.sessionForDate) ? extra.sessionForDate : [],
      });
      const classification = normalizeTradingDayClassification(
        finalizationMeta.classification
          || fallbackClassification.classification
      );
      const classificationReason = toText(
        finalizationMeta.classificationReason
          || fallbackClassification.classificationReason
      ) || 'unknown';
      const state = normalizeFinalizationReadinessState(
        finalizationMeta.state || mapFinalizationReasonToReadinessState(finalizationReason)
      );
      recordLiveDecision({
        recDate: normalizeDate(date || ''),
        eligibleForScoring: false,
        scored: false,
        inserted: 0,
        updated: 0,
        reason,
        extra,
        finalizationReason,
        readinessState: state,
        tradingDayClassification: classification,
      });
      recordLiveFinalizationDecision({
        recDate: normalizeDate(date || ''),
        reason: finalizationReason,
        state,
        classification,
        classificationReason,
      });
    }
  };

  for (const contextRow of sorted) {
    const sourceType = toText(contextRow?.source_type || '').toLowerCase() === 'backfill'
      ? 'backfill'
      : 'live';
    sourceTypeMetrics[sourceType].contextsSeen += 1;
    const date = normalizeDate(contextRow?.rec_date || '');
    if (!date) {
      markSkip(sourceType, 'context_missing_date', date);
      warnings.push('context_missing_date');
      continue;
    }
    const sessionForDate = Array.isArray(sessions?.[date]) ? sessions[date] : [];
    let finalizationReadiness = null;
    if (sourceType === 'live') {
      finalizationReadiness = evaluateLiveFinalizationReadiness({
        date,
        nowDate,
        contextRow,
        sessionForDate,
      });
      const finalizationMeta = {
        classification: normalizeTradingDayClassification(finalizationReadiness.classification),
        classificationReason: toText(finalizationReadiness.classificationReason || '') || 'unknown',
      };
      const phase = toText(contextRow?.reconstruction_phase || '').toLowerCase() || 'live_intraday';
      const identity = `${date}|live|${phase}`;
      if (liveIdentitySeen.has(identity)) {
        markSkip(sourceType, 'duplicate_live_identity', date, { sessionForDate }, {
          ...finalizationMeta,
          state: 'blocked_invalid_day',
        });
        continue;
      }
      liveIdentitySeen.add(identity);
      const alreadyScored = shouldSkipExistingScore(db, contextRow, force);
      const allowIdempotentReadyUpdate = finalizationOnly === true && alreadyScored && finalizationReadiness?.ready === true;
      if (alreadyScored && !allowIdempotentReadyUpdate) {
        markSkip(sourceType, 'already_scored', date, { sessionForDate }, {
          ...finalizationMeta,
          state: 'already_finalized',
        });
        continue;
      }
      if (!finalizationReadiness.ready) {
        const reason = normalizeFinalizationReason(finalizationReadiness.reason);
        if (reason === 'awaiting_session_close' || reason === 'awaiting_next_day_window') {
          markSkip(sourceType, 'awaiting_outcome_window', date, { sessionForDate }, {
            ...finalizationMeta,
            state: normalizeFinalizationReadinessState(finalizationReadiness.state || 'awaiting_outcome_window'),
          });
        } else if (reason === 'awaiting_required_market_data') {
          markSkip(sourceType, 'missing_market_session_data', date, { sessionForDate }, {
            ...finalizationMeta,
            state: 'awaiting_required_market_data',
          });
          warnings.push(`${date}:session_missing_for_scoring`);
        } else if (reason === 'missing_live_context_alignment') {
          markSkip(sourceType, 'missing_context_alignment', date, { sessionForDate }, {
            ...finalizationMeta,
            state: 'blocked_invalid_day',
          });
        } else if (reason === 'invalid_trading_day_mapping' || reason === 'non_trading_day') {
          markSkip(sourceType, 'invalid_live_session_mapping', date, { sessionForDate }, {
            ...finalizationMeta,
            state: 'blocked_invalid_day',
          });
        } else if (reason === 'duplicate_finalization_identity') {
          markSkip(sourceType, 'duplicate_live_identity', date, { sessionForDate }, {
            ...finalizationMeta,
            state: 'blocked_invalid_day',
          });
        } else {
          markSkip(sourceType, 'other_blocked', date, { sessionForDate }, {
            ...finalizationMeta,
            state: 'blocked_invalid_day',
          });
        }
        continue;
      }
      if (
        liveAutonomousFirstRight.liveManualInsertDeferred === true
        && finalizationOnly !== true
        && normalizeDate(date) === normalizeDate(liveAutonomousFirstRight.liveAutonomousFirstRightTargetTradingDay || '')
      ) {
        markSkip(sourceType, 'manual_insert_deferred_to_autonomous_window', date, { sessionForDate }, {
          ...finalizationMeta,
          state: 'awaiting_outcome_window',
        });
        continue;
      }
      const targetForPreferredOwner = normalizeDate(
        liveAutonomousFirstRight.liveAutonomousFirstRightTargetTradingDay || ''
      );
      const preferredOwnerSource = normalizeFinalizationSweepSource(
        liveAutonomousFirstRight.liveAutonomousFirstRightReservedForSource || 'close_complete_checkpoint'
      );
      const preferredOwnerReservationTarget = normalizeDate(
        initialLivePreferredOwnerReservation.livePreferredOwnerReservationTargetTradingDay
          || targetForPreferredOwner
          || ''
      );
      const preferredOwnerReservationExpectedSource = normalizeFinalizationSweepSource(
        initialLivePreferredOwnerReservation.livePreferredOwnerReservationExpectedSource
          || preferredOwnerSource
          || 'close_complete_checkpoint'
      );
      const preferredOwnerReservationActive = initialLivePreferredOwnerReservation.livePreferredOwnerReservationActive === true;
      const preferredOwnerReservationBlocksCurrentSource = (
        initialLivePreferredOwnerReservation.livePreferredOwnerReservationShouldBlockCurrentSource === true
      );
      let effectiveSweepSource = liveFinalizationSweepSource;
      if (
        effectiveSweepSource === 'post_close_checkpoint'
        && finalizationReadiness?.ready === true
        && !!targetForPreferredOwner
        && normalizeDate(date) === targetForPreferredOwner
      ) {
        effectiveSweepSource = 'close_complete_checkpoint';
      }
      const shouldDeferToPreferredAutonomous = (
        finalizationReadiness?.ready === true
        && liveAutonomousFirstRight.liveAutonomousFirstRightActive === true
        && !!targetForPreferredOwner
        && normalizeDate(date) === targetForPreferredOwner
        && shouldDeferToPreferredAutonomousOwner(effectiveSweepSource, preferredOwnerSource)
      );
      const shouldDeferByReservation = (
        finalizationReadiness?.ready === true
        && preferredOwnerReservationActive
        && preferredOwnerReservationBlocksCurrentSource
        && !!preferredOwnerReservationTarget
        && normalizeDate(date) === preferredOwnerReservationTarget
        && preferredOwnerReservationExpectedSource === 'close_complete_checkpoint'
        && isStartupFallbackSource(effectiveSweepSource, mode)
      );
      if (shouldDeferToPreferredAutonomous || shouldDeferByReservation) {
        const existingLiveOutcome = readLiveOutcomeRowByIdentity(db, date);
        if (!existingLiveOutcome) {
          livePreferredOwnerDeferredFallbackSource = normalizeFinalizationSweepSource(effectiveSweepSource);
          livePreferredOwnerDeferredFallbackReason = normalizeLivePreferredOwnerReservationBlockReason(
            initialLivePreferredOwnerReservation.livePreferredOwnerReservationBlockReason
              || 'preferred_owner_window_still_open'
          );
          livePreferredOwnerDeferredFallbackAt = new Date().toISOString();
          markSkip(sourceType, 'autonomous_insert_deferred_to_preferred_owner', date, { sessionForDate }, {
            ...finalizationMeta,
            state: 'awaiting_outcome_window',
          });
          continue;
        }
      }
      sourceTypeMetrics[sourceType].contextsEligibleForScoring += 1;
    } else {
      if (!sessionForDate.length) {
        markSkip(sourceType, 'session_missing_for_scoring', date);
        warnings.push(`${date}:session_missing_for_scoring`);
        continue;
      }
      if (shouldSkipExistingScore(db, contextRow, force)) {
        markSkip(sourceType, 'already_scored', date);
        continue;
      }
      sourceTypeMetrics[sourceType].contextsEligibleForScoring += 1;
    }

    const strategySnapshot = buildPerDateStrategySnapshotForScoring(date, sessions);
    const score = evaluateRecommendationOutcomeDay({
      db,
      date,
      contextRow,
      sessions,
      strategySnapshot,
      runTradeMechanicsVariantTool,
      sourceType: contextRow?.source_type,
      reconstructionPhase: contextRow?.reconstruction_phase,
      reconstructionVersion: contextRow?.reconstruction_version,
    });
    if (!score) {
      if (sourceType === 'live') {
        markSkip(sourceType, 'other_blocked', date, { sessionForDate }, {
          classification: finalizationReadiness?.classification,
          classificationReason: finalizationReadiness?.classificationReason,
          state: finalizationReadiness?.state || 'blocked_invalid_day',
        });
      } else {
        markSkip(sourceType, 'score_unavailable', date);
      }
      warnings.push(`${date}:score_unavailable`);
      continue;
    }

    const upsert = upsertScoredTradeOutcome(db, {
      scoreDate: date,
      sourceType: score.sourceType,
      reconstructionPhase: score.reconstructionPhase,
      regimeLabel: toText(score?.integrity?.regimeLabel || ''),
      strategyKey: toText(score?.recommendedStrategyKey || ''),
      posture: toText(score?.posture || ''),
      confidenceLabel: toText(contextRow?.confidence_label || ''),
      confidenceScore: toNumber(contextRow?.confidence_score, null),
      recommendation: {
        posture: score.posture,
        strategyKey: score.recommendedStrategyKey,
        tpMode: score.recommendedTpMode,
      },
      outcome: score,
      scoreLabel: score.postureEvaluation,
      recommendationDelta: score.recommendationDelta,
      actualPnl: score.actualPnL,
      bestPossiblePnl: score.bestPossiblePnL,
    });
    insertedRows += Number(upsert.inserted || 0);
    updatedRows += Number(upsert.updated || 0);
    scoredRows += 1;
    sourceTypeMetrics[sourceType].contextsScored += 1;
    sourceTypeMetrics[sourceType].rowsInserted += Number(upsert.inserted || 0);
    sourceTypeMetrics[sourceType].rowsUpdated += Number(upsert.updated || 0);
    if (sourceType === 'live') {
      const inserted = Number(upsert.inserted || 0);
      const updated = Number(upsert.updated || 0);
      let reason = 'other_blocked';
      if (inserted > 0) reason = 'eligible_and_inserted';
      else if (updated > 0) reason = 'eligible_and_updated';
      const readinessState = normalizeFinalizationReadinessState(
        finalizationReadiness?.state || 'ready_to_finalize'
      );
      const tradingDayClassification = normalizeTradingDayClassification(
        finalizationReadiness?.classification || classifyTradingDay({ date, sessionForDate }).classification
      );
      const classificationReason = toText(
        finalizationReadiness?.classificationReason
        || classifyTradingDay({ date, sessionForDate }).classificationReason
      ) || 'unknown';
      recordLiveDecision({
        recDate: date,
        eligibleForScoring: true,
        scored: true,
        inserted,
        updated,
        reason,
        readinessState,
        tradingDayClassification,
      });
      const finalizationReason = inserted > 0
        ? 'finalized_and_inserted'
        : (updated > 0 ? 'finalized_and_updated' : 'other_blocked');
      recordLiveFinalizationDecision({
        recDate: date,
        reason: finalizationReason,
        state: readinessState,
        classification: tradingDayClassification,
        classificationReason,
      });
    }
  }

  const liveMetrics = sourceTypeMetrics.live;
  const liveSkipEntries = Object.entries(liveMetrics.skipReasonBuckets || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const liveTopSkipReason = liveSkipEntries.length ? String(liveSkipEntries[0][0] || '') : null;
  const liveBlockedEntries = Object.entries(liveBlockedReasonBuckets || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const liveTopBlockedReason = liveBlockedEntries.length ? String(liveBlockedEntries[0][0] || '') : null;
  const liveContextsWithoutFreshInsertDates = Array.from(liveUnconvertedDateReasonMap.entries())
    .map(([date, reason]) => ({
      date: normalizeDate(date),
      reason: normalizeLiveReason(reason),
    }))
    .filter((row) => !!row.date)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 12);
  const pendingLiveDates = Array.from(liveFinalizationPendingDateReasonMap.entries())
    .map(([date, reason]) => ({
      date: normalizeDate(date),
      reason: normalizeFinalizationReason(reason),
      classification: 'valid_trading_day',
    }))
    .filter((row) => !!row.date)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 12);
  const toDiagnosticRows = (mapRef) => Array.from(mapRef.entries())
    .map(([date, payload]) => ({
      date: normalizeDate(date),
      reason: normalizeFinalizationReason(payload?.reason || ''),
      classification: normalizeTradingDayClassification(payload?.classification || ''),
    }))
    .filter((row) => !!row.date)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 12);
  const latestReadyButUninsertedDates = toDiagnosticRows(latestReadyButUninsertedMap);
  const latestWaitingDates = toDiagnosticRows(latestWaitingMap);
  const latestBlockedDates = toDiagnosticRows(latestBlockedMap);
  const waitingEntries = Object.entries(liveFinalizationWaitingBuckets || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const blockedEntries = Object.entries(liveFinalizationBlockedBuckets || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const topWaitingReason = waitingEntries.length ? String(waitingEntries[0][0] || '') : null;
  const topFinalizationBlockedReason = blockedEntries.length ? String(blockedEntries[0][0] || '') : null;
  const netNewLiveRows = {
    oneDay: countNetNewLiveRowsByCreatedWindow(db, nowDate, 1),
    threeDay: countNetNewLiveRowsByCreatedWindow(db, nowDate, 3),
    sevenDay: countNetNewLiveRowsByCreatedWindow(db, nowDate, 7),
  };
  const liveCheckpoint = buildLiveCheckpoint({
    db,
    nowDate,
    nowTime: normalizeTimeOfDay(input.nowTime || input.nowEt?.time || '00:00', '00:00'),
    mode,
    sweepSource: liveFinalizationSweepSource,
    targetTradingDay: input.checkpointTargetTradingDay,
    sessions,
    finalizationByDate: liveFinalizationByDate,
    scoringByDate: liveScoringByDate,
  });
  const liveInsertionSla = buildLiveInsertionSla({
    db,
    nowDate,
    nowTime: normalizeTimeOfDay(input.nowTime || input.nowEt?.time || '00:00', '00:00'),
    liveCheckpoint,
  });
  const liveInsertionGrowth = buildLiveInsertionGrowthMetrics({
    db,
    liveInsertionSla,
  });
  const resolvedLiveFinalizationSweepSource = normalizeFinalizationSweepSource(
    liveCheckpoint?.sweepSource || liveFinalizationSweepSource
  );
  const latestCheckpointFailures = [];
  const latestMissedCheckpointDates = [];
  if (String(liveCheckpoint?.checkpointStatus || '').startsWith('failure_')) {
    latestCheckpointFailures.push({
      date: normalizeDate(liveCheckpoint.targetTradingDay || '') || null,
      status: normalizeCheckpointStatus(liveCheckpoint.checkpointStatus),
      reason: normalizeCheckpointReason(liveCheckpoint.checkpointReason),
      failureReason: normalizeCheckpointFailureReason(liveCheckpoint.failureReason),
      firstEligibleCycleFailureReason: normalizeFirstEligibleCycleFailureReason(liveCheckpoint.firstEligibleCycleFailureReason),
      sweepSource: normalizeFinalizationSweepSource(liveCheckpoint.sweepSource || ''),
    });
  }
  if (
    normalizeCheckpointStatus(liveCheckpoint?.checkpointStatus || '') === 'failure_scheduler_miss'
    && normalizeDate(liveCheckpoint?.targetTradingDay || '')
  ) {
    latestMissedCheckpointDates.push({
      date: normalizeDate(liveCheckpoint.targetTradingDay),
      reason: normalizeCheckpointFailureReason(liveCheckpoint.failureReason) || 'checkpoint_not_run',
      status: 'failure_scheduler_miss',
    });
  }
  const missedValidCheckpointDaysCount = latestMissedCheckpointDates.length;
  const autoFinalizationHealthy = (
    blockedFinalizationCount <= 0
    || (
      blockedFinalizationCount > 0
      && Object.keys(liveFinalizationBlockedBuckets || {}).every((reason) => (
        reason === 'non_trading_day'
        || reason === 'already_finalized'
      ))
    )
  );
  const liveFinalization = {
    contextsConsidered: Number(liveMetrics.contextsSeen || 0),
    pendingLiveContextsCount: Number(waitingFinalizationCount || 0),
    finalizedInsertedCount: Number(finalizedInsertedCount || 0),
    finalizedUpdatedCount: Number(finalizedUpdatedCount || 0),
    finalizedTodayCount: Number(finalizedInsertedCount || 0),
    alreadyFinalizedCount: Number(alreadyFinalizedCount || 0),
    waitingCount: Number(waitingFinalizationCount || 0),
    blockedCount: Number(blockedFinalizationCount || 0),
    topWaitingReason: topWaitingReason || null,
    topBlockedReason: topFinalizationBlockedReason || null,
    latestPendingLiveDates: pendingLiveDates,
    latestReadyButUninsertedDates,
    latestWaitingDates,
    latestBlockedDates,
    reasonBuckets: liveFinalizationReasonBuckets,
    readinessStateBuckets: liveFinalizationStateBuckets,
    tradingDayClassificationBuckets: liveTradingDayClassificationBuckets,
    waitingReasonBuckets: liveFinalizationWaitingBuckets,
    blockedReasonBuckets: liveFinalizationBlockedBuckets,
    sweepSource: resolvedLiveFinalizationSweepSource,
    validLiveDaysSeen: Number(validLiveDaysSeen || 0),
    validLiveDaysReadyToFinalize: Number(validLiveDaysReadyToFinalize || 0),
    validLiveDaysFinalizedInserted: Number(validLiveDaysFinalizedInserted || 0),
    validLiveDaysFinalizedUpdated: Number(validLiveDaysFinalizedUpdated || 0),
    validLiveDaysStillWaiting: Number(validLiveDaysStillWaiting || 0),
    validLiveDaysBlocked: Number(validLiveDaysBlocked || 0),
    validLiveDaysMissedByScheduler: Number(validLiveDaysMissedByScheduler || 0),
    liveCheckpoint,
    missedValidCheckpointDaysCount: Number(missedValidCheckpointDaysCount || 0),
    latestMissedCheckpointDates,
    latestCheckpointFailures,
    automaticFinalizationHealthy: autoFinalizationHealthy === true,
    netNewLiveRows,
    liveInsertionSla,
    liveInsertionGrowth,
    advisoryOnly: true,
  };
  const status = scoredRows > 0
    ? (warnings.length > 0 ? 'partial' : 'ok')
    : (warnings.length > 0 ? 'noop' : 'noop');
  const details = {
    runOrigin,
    sinceDate,
    contextsSeen: sorted.length,
    scoredRows,
    skippedRows,
    insertedRows,
    updatedRows,
    skipReasonBuckets,
    sourceTypeMetrics,
    liveGeneration: {
      contextsSeen: Number(liveMetrics.contextsSeen || 0),
      contextsEligibleForScoring: Number(liveMetrics.contextsEligibleForScoring || 0),
      contextsScored: Number(liveMetrics.contextsScored || 0),
      rowsInserted: Number(liveMetrics.rowsInserted || 0),
      rowsUpdated: Number(liveMetrics.rowsUpdated || 0),
      contextsSkipped: Number(liveMetrics.contextsSkipped || 0),
      skipReasonBuckets: liveMetrics.skipReasonBuckets || {},
      topSkipReason: liveTopSkipReason,
      reasonBuckets: liveReasonBuckets,
      blockedReasonBuckets: liveBlockedReasonBuckets,
      topBlockedReason: liveTopBlockedReason,
      contextsFreshInserted: liveContextsFreshInserted,
      contextsUpdatedOnly: liveContextsUpdatedOnly,
      contextsBlocked: liveContextsBlocked,
      contextsWithoutFreshInsertDates: liveContextsWithoutFreshInsertDates,
      bridgeLookbackDays: liveBridgeLookbackDays,
      contextDecisions: liveContextDecisions,
    },
    liveFinalization,
    liveInsertionSla,
    liveInsertionGrowth,
    liveFinalizationSweepSource: resolvedLiveFinalizationSweepSource,
    validLiveDaysSeen: Number(validLiveDaysSeen || 0),
    validLiveDaysReadyToFinalize: Number(validLiveDaysReadyToFinalize || 0),
    validLiveDaysFinalizedInserted: Number(validLiveDaysFinalizedInserted || 0),
    validLiveDaysFinalizedUpdated: Number(validLiveDaysFinalizedUpdated || 0),
    validLiveDaysStillWaiting: Number(validLiveDaysStillWaiting || 0),
    validLiveDaysBlocked: Number(validLiveDaysBlocked || 0),
    validLiveDaysMissedByScheduler: Number(validLiveDaysMissedByScheduler || 0),
    liveCheckpoint,
    liveInsertionSla,
    liveInsertionGrowth,
    missedValidCheckpointDaysCount: Number(missedValidCheckpointDaysCount || 0),
    latestMissedCheckpointDates,
    latestCheckpointFailures,
    netNewLiveRows1d: Number(netNewLiveRows.oneDay || 0),
    netNewLiveRows3d: Number(netNewLiveRows.threeDay || 0),
    netNewLiveRows7d: Number(netNewLiveRows.sevenDay || 0),
    liveContextAudit: liveContextAudit && typeof liveContextAudit === 'object'
      ? liveContextAudit
      : null,
    contextCapture: input.contextCapture && typeof input.contextCapture === 'object'
      ? input.contextCapture
      : null,
    warnings,
  };
  const liveDayConversion = {
    liveContextsSeen: Number(liveMetrics.contextsSeen || 0),
    liveContextsEligibleForScoring: Number(liveMetrics.contextsEligibleForScoring || 0),
    liveContextsScored: Number(liveMetrics.contextsScored || 0),
    liveRowsInserted: Number(liveMetrics.rowsInserted || 0),
    liveRowsUpdated: Number(liveMetrics.rowsUpdated || 0),
    liveContextsSkipped: Number(liveMetrics.contextsSkipped || 0),
    liveContextsFreshInserted,
    liveContextsUpdatedOnly,
    liveContextsBlocked,
    liveTopSkipReason,
    liveTopBlockedReason,
    liveEligibilityReasonBuckets: liveReasonBuckets,
    liveBlockedReasonBuckets,
    latestLiveContextsWithoutFreshInsertDates: liveContextsWithoutFreshInsertDates,
    liveFinalizationReasonBuckets,
    liveFinalizationReadinessStateBuckets: liveFinalizationStateBuckets,
    liveFinalizationTradingDayClassificationBuckets: liveTradingDayClassificationBuckets,
    liveFinalizationWaitingReasonBuckets: liveFinalizationWaitingBuckets,
    liveFinalizationBlockedReasonBuckets: liveFinalizationBlockedBuckets,
    liveFinalizationTopWaitingReason: topWaitingReason,
    liveFinalizationTopBlockedReason: topFinalizationBlockedReason,
    liveFinalizationPendingLiveDates: pendingLiveDates,
    liveFinalizationSweepSource: resolvedLiveFinalizationSweepSource,
    latestReadyButUninsertedDates,
    latestWaitingDates,
    latestBlockedDates,
    liveFinalizationPendingCount: Number(waitingFinalizationCount || 0),
    liveFinalizationFinalizedTodayCount: Number(finalizedInsertedCount || 0),
    liveFinalizationAlreadyFinalizedCount: Number(alreadyFinalizedCount || 0),
    validLiveDaysSeen: Number(validLiveDaysSeen || 0),
    validLiveDaysReadyToFinalize: Number(validLiveDaysReadyToFinalize || 0),
    validLiveDaysFinalizedInserted: Number(validLiveDaysFinalizedInserted || 0),
    validLiveDaysFinalizedUpdated: Number(validLiveDaysFinalizedUpdated || 0),
    validLiveDaysStillWaiting: Number(validLiveDaysStillWaiting || 0),
    validLiveDaysBlocked: Number(validLiveDaysBlocked || 0),
    validLiveDaysMissedByScheduler: Number(validLiveDaysMissedByScheduler || 0),
    liveCheckpoint,
    missedValidCheckpointDaysCount: Number(missedValidCheckpointDaysCount || 0),
    latestMissedCheckpointDates,
    latestCheckpointFailures,
    invalidLiveContextsCreatedToday: Number(liveContextAudit?.invalidLiveContextsCreatedToday || 0),
    invalidLiveContextsSuppressedToday: Number(liveContextAudit?.invalidLiveContextsSuppressedToday || 0),
    latestInvalidLiveContextDates: Array.isArray(liveContextAudit?.latestInvalidLiveContextDates)
      ? liveContextAudit.latestInvalidLiveContextDates.slice(0, 12)
      : [],
    liveFinalizationAutomaticHealthy: autoFinalizationHealthy === true,
    netNewLiveRows1d: Number(netNewLiveRows.oneDay || 0),
    netNewLiveRows3d: Number(netNewLiveRows.threeDay || 0),
    netNewLiveRows7d: Number(netNewLiveRows.sevenDay || 0),
    advisoryOnly: true,
  };
  const runId = persistDailyScoringRun(db, {
    runDate: nowDate,
    mode,
    runOrigin,
    windowDays,
    contextsSeen: sorted.length,
    scoredRows,
    insertedRows,
    updatedRows,
    status,
    errorMessage: null,
    details,
  });
  const liveInsertionOwnership = buildLiveInsertionOwnership({
    db,
    runId,
    runMode: mode,
    liveCheckpoint,
    liveInsertionSla,
  });
  const liveTargetDayOwnershipInvariant = buildTargetDayOwnershipInvariant({
    liveCheckpoint,
    liveInsertionOwnership,
    liveAutonomousFirstRight,
  });
  const liveAutonomousInsertReadiness = buildLiveAutonomousInsertReadiness({
    liveCheckpoint,
    liveInsertionOwnership,
    liveAutonomousFirstRight,
    liveTargetDayOwnershipInvariant,
  });
  const rawLiveAutonomousProof = buildLiveAutonomousProofContract({
    liveCheckpoint,
    liveInsertionOwnership,
    liveAutonomousFirstRight,
    liveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness,
  });
  const rawLiveAutonomousAttemptTransition = buildLiveAutonomousAttemptTransition({
    liveCheckpoint,
    liveInsertionOwnership,
    liveAutonomousFirstRight,
    liveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness,
    liveAutonomousProof: rawLiveAutonomousProof,
  });
  const enforcedAttemptContract = enforceEligibleAttemptOrBugContract({
    liveCheckpoint,
    liveAutonomousInsertReadiness,
    liveAutonomousProof: rawLiveAutonomousProof,
    liveAutonomousAttemptTransition: rawLiveAutonomousAttemptTransition,
  });
  const liveAutonomousProof = enforcedAttemptContract.liveAutonomousProof;
  const liveAutonomousAttemptTransition = enforcedAttemptContract.liveAutonomousAttemptTransition;
  const liveAutonomousInsertionMetrics = buildLiveAutonomousInsertionMetrics({
    db,
    liveInsertionSla,
    liveInsertionOwnership,
  });
  const livePreferredOwnerProof = buildLivePreferredOwnerProof({
    db,
    runId,
    runMode: mode,
    liveCheckpoint,
    liveInsertionOwnership,
    liveAutonomousInsertReadiness,
    liveAutonomousAttemptTransition,
    liveAutonomousProof,
  });
  const livePreferredOwnerMetrics = buildLivePreferredOwnerMetrics({
    db,
    livePreferredOwnerProof,
    liveInsertionSla,
  });
  const liveOwnershipConsistencyOk = (
    liveInsertionOwnership.liveOwnershipConsistencyOk === true
    && liveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent === true
  );
  const enrichedLiveAutonomousFirstRight = {
    ...liveAutonomousFirstRight,
    liveAutonomousFirstRightReachedExecution: (
      liveAutonomousAttemptTransition.attemptExecuted === true
      && normalizeFinalizationSweepSource(
        liveAutonomousAttemptTransition.attemptExecutionPath
        || ''
      ) === normalizeFinalizationSweepSource(
        liveAutonomousFirstRight.liveAutonomousFirstRightReservedForSource
        || 'close_complete_checkpoint'
      )
    ),
    liveOwnershipConsistencyOk,
  };
  const livePreferredOwnerReservation = buildLivePreferredOwnerReservation({
    db,
    nowDate,
    nowTime,
    mode,
    sweepSource: resolvedLiveFinalizationSweepSource,
    targetTradingDay: liveCheckpoint.targetTradingDay
      || liveAutonomousInsertReadiness.targetTradingDay
      || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
      || null,
    liveAutonomousFirstRight: enrichedLiveAutonomousFirstRight,
    liveCheckpoint,
    liveInsertionOwnership,
    livePreferredOwnerProof,
    sessions,
    finalizationOnly,
    livePreferredOwnerDeferredFallbackSource,
    livePreferredOwnerDeferredFallbackReason,
    livePreferredOwnerDeferredFallbackAt,
  });
  const livePreferredOwnerDeferralEvent = (
    livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackSource
    && Number(liveReasonBuckets.autonomous_insert_deferred_to_preferred_owner || 0) > 0
    && !!(livePreferredOwnerReservation.livePreferredOwnerReservationTargetTradingDay || liveCheckpoint.targetTradingDay)
  )
    ? recordPreferredOwnerDeferralEvent(db, {
      targetTradingDay: livePreferredOwnerReservation.livePreferredOwnerReservationTargetTradingDay
        || liveCheckpoint.targetTradingDay
        || null,
      fallbackSource: livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackSource,
      deferralReason: livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackReason
        || livePreferredOwnerReservation.livePreferredOwnerReservationBlockReason
        || 'preferred_owner_window_still_open',
      reservationState: livePreferredOwnerReservation.livePreferredOwnerReservationState
        || 'reservation_not_applicable',
      runId,
      runOrigin,
      timestamp: livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackAt || new Date().toISOString(),
    })
    : null;
  const naturalWinTargetTradingDay = normalizeDate(
    livePreferredOwnerProof.livePreferredOwnerTargetTradingDay
    || liveCheckpoint.targetTradingDay
    || ''
  ) || null;
  let existingNaturalWinRowForTarget = null;
  if (naturalWinTargetTradingDay) {
    try {
      existingNaturalWinRowForTarget = db.prepare(`
        SELECT id
        FROM jarvis_preferred_owner_natural_wins
        WHERE target_trading_day = ?
        LIMIT 1
      `).get(naturalWinTargetTradingDay) || null;
    } catch {}
  }
  const naturalWinSourceSpecificOutcome = normalizeLiveInsertionOwnershipSourceSpecificOutcome(
    liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome
    || livePreferredOwnerProof.livePreferredOwnerCreationOwnershipSourceSpecificOutcome
    || ''
  );
  const naturalWinFirstCreatorSource = normalizeFinalizationSweepSource(
    livePreferredOwnerProof.livePreferredOwnerActualSource
    || liveInsertionOwnership.liveInsertionOwnershipFirstInsertedBySource
    || ''
  );
  const canonicalPreferredOwnerWinEvidencePresent = (
    livePreferredOwnerProof.livePreferredOwnerWon === true
    && normalizeFinalizationSweepSource(
      livePreferredOwnerProof.livePreferredOwnerExpectedSource || 'close_complete_checkpoint'
    ) === 'close_complete_checkpoint'
    && naturalWinFirstCreatorSource === 'close_complete_checkpoint'
    && (
      isCloseCompleteOwnershipSourceSpecificOutcome(naturalWinSourceSpecificOutcome)
      || naturalWinSourceSpecificOutcome === 'ownership_source_unknown'
    )
  );
  const livePreferredOwnerNaturalWinEvent = (
    runOrigin === 'natural'
    && canonicalPreferredOwnerWinEvidencePresent
    && (
      liveInsertionOwnership.liveInsertionOwnershipCurrentRunWasFirstCreator === true
      || !existingNaturalWinRowForTarget
    )
  )
    ? recordPreferredOwnerNaturalWinEvent(db, {
      targetTradingDay: naturalWinTargetTradingDay,
      runId: Number(
        livePreferredOwnerProof.livePreferredOwnerFirstCreatorRunId
        || runId
        || 0
      ) || runId,
      firstCreatorSource: naturalWinFirstCreatorSource
        || 'close_complete_checkpoint',
      reservationState: livePreferredOwnerReservation.livePreferredOwnerReservationState
        || 'reservation_not_applicable',
      reservationBlockedFallback: !!livePreferredOwnerDeferralEvent,
      proofRowId: Number(livePreferredOwnerProof.livePreferredOwnerProofRowId || 0) || null,
      runOrigin,
      timestamp: livePreferredOwnerProof.livePreferredOwnerProofCapturedAt || new Date().toISOString(),
    })
    : null;
  const livePreferredOwnerNaturalWinMetrics = readPreferredOwnerNaturalWinMetrics(db, nowDate);
  const livePreferredOwnerVerifierMetricsBefore = readPreferredOwnerVerifierMetrics(db, nowDate);
  let livePreferredOwnerPostCloseProofVerifier = buildPreferredOwnerPostCloseProofVerifier({
    db,
    runId,
    runOrigin,
    liveCheckpoint,
    liveInsertionOwnership,
    livePreferredOwnerProof,
    livePreferredOwnerReservation,
    livePreferredOwnerMetrics,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics: livePreferredOwnerVerifierMetricsBefore,
    livePreferredOwnerNaturalWinEvent,
  });
  if (!livePreferredOwnerPostCloseProofVerifier) {
    const fallbackTargetDay = normalizeDate(
      livePreferredOwnerProof.livePreferredOwnerTargetTradingDay
      || liveCheckpoint.targetTradingDay
      || liveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
      || ''
    ) || null;
    const fallbackReasons = [];
    if (!fallbackTargetDay) fallbackReasons.push('target_day_mismatch');
    else if (normalizeCheckpointStatus(liveCheckpoint.checkpointStatus || 'waiting_valid') === 'waiting_valid') {
      fallbackReasons.push('checkpoint_not_resolved');
    } else {
      fallbackReasons.push('proof_row_missing');
    }
    livePreferredOwnerPostCloseProofVerifier = {
      targetTradingDay: fallbackTargetDay,
      runId,
      runOrigin,
      runtimeSource: normalizeFinalizationSweepSource(
        liveCheckpoint.runtimeCheckpointSource
        || liveCheckpoint.sweepSource
        || resolvedLiveFinalizationSweepSource
        || 'manual_api_run'
      ),
      checkpointStatus: normalizeCheckpointStatus(liveCheckpoint.checkpointStatus || 'waiting_valid'),
      verifierStatus: 'fail',
      verifierPass: false,
      failureReasons: fallbackReasons
        .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
        .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx),
      summary: {
        targetTradingDay: fallbackTargetDay,
        runId,
        runOrigin,
        runtimeSource: normalizeFinalizationSweepSource(
          liveCheckpoint.runtimeCheckpointSource
          || liveCheckpoint.sweepSource
          || resolvedLiveFinalizationSweepSource
          || 'manual_api_run'
        ),
        checkpointStatus: normalizeCheckpointStatus(liveCheckpoint.checkpointStatus || 'waiting_valid'),
        advisoryOnly: true,
      },
      verifiedAt: new Date().toISOString(),
      livePreferredOwnerPostCloseProofVerifierRunOrigin: runOrigin,
      livePreferredOwnerPostCloseProofResolvedNaturally: false,
      verifierPersistedThisRun: false,
      advisoryOnly: true,
    };
  }
  const livePreferredOwnerVerifierMetrics = readPreferredOwnerVerifierMetrics(db, nowDate);
  const livePreferredOwnerLatestOperationalVerdictCapture = capturePreferredOwnerLatestOperationalVerdict({
    db,
    runId,
    runOrigin,
    liveCheckpoint,
    livePreferredOwnerProof,
    liveInsertionOwnership,
    livePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics,
  });
  const livePreferredOwnerLatestOperationalVerdict = (
    livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdict
    && typeof livePreferredOwnerLatestOperationalVerdictCapture.livePreferredOwnerLatestOperationalVerdict === 'object'
  )
    ? livePreferredOwnerLatestOperationalVerdictCapture.livePreferredOwnerLatestOperationalVerdict
    : null;
  const livePreferredOwnerOperationalProofBundleCapture = capturePreferredOwnerOperationalProofBundle({
    db,
    runId,
    runOrigin,
    liveCheckpoint,
    liveInsertionOwnership,
    livePreferredOwnerProof,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics,
    livePreferredOwnerPostCloseProofVerifier,
  });
  const livePreferredOwnerOperationalProofBundle = (
    livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundle
    && typeof livePreferredOwnerOperationalProofBundleCapture.livePreferredOwnerOperationalProofBundle === 'object'
  )
    ? livePreferredOwnerOperationalProofBundleCapture.livePreferredOwnerOperationalProofBundle
    : null;
  const enrichedLiveFinalization = {
    ...liveFinalization,
    liveInsertionOwnership,
    liveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness,
    liveAutonomousAttemptTransition,
    liveAutonomousProof,
    liveAutonomousInsertionMetrics,
    livePreferredOwnerProof,
    livePreferredOwnerMetrics,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics,
    livePreferredOwnerNaturalWinEvent,
    livePreferredOwnerDeferralEvent,
    livePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerLatestOperationalVerdict,
    livePreferredOwnerLatestOperationalVerdictCapturedThisRun: (
      livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictCapturedThisRun === true
    ),
    livePreferredOwnerLatestOperationalVerdictSkipReason: (
      toText(livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictSkipReason || '')
      || null
    ),
    livePreferredOwnerOperationalProofBundle,
    livePreferredOwnerOperationalProofBundleCapturedThisRun: (
      livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleCapturedThisRun === true
    ),
    livePreferredOwnerOperationalProofBundleSkipReason: (
      toText(livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleSkipReason || '')
      || null
    ),
    livePreferredOwnerReservation,
    liveAutonomousFirstRight: enrichedLiveAutonomousFirstRight,
  };
  const enrichedLiveDayConversion = {
    ...liveDayConversion,
    liveInsertionOwnership,
    liveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness,
    liveAutonomousAttemptTransition,
    liveAutonomousProof,
    liveAutonomousInsertionMetrics,
    livePreferredOwnerProof,
    livePreferredOwnerMetrics,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics,
    livePreferredOwnerNaturalWinEvent,
    livePreferredOwnerDeferralEvent,
    livePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerLatestOperationalVerdict,
    livePreferredOwnerLatestOperationalVerdictCapturedThisRun: (
      livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictCapturedThisRun === true
    ),
    livePreferredOwnerLatestOperationalVerdictSkipReason: (
      toText(livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictSkipReason || '')
      || null
    ),
    livePreferredOwnerOperationalProofBundle,
    livePreferredOwnerOperationalProofBundleCapturedThisRun: (
      livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleCapturedThisRun === true
    ),
    livePreferredOwnerOperationalProofBundleSkipReason: (
      toText(livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleSkipReason || '')
      || null
    ),
    livePreferredOwnerReservation,
    liveAutonomousFirstRight: enrichedLiveAutonomousFirstRight,
  };
  const enrichedDetails = {
    ...details,
    liveFinalization: enrichedLiveFinalization,
    liveDayConversion: enrichedLiveDayConversion,
    liveInsertionOwnership,
    liveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness,
    liveAutonomousAttemptTransition,
    liveAutonomousProof,
    liveAutonomousInsertionMetrics,
    livePreferredOwnerProof,
    livePreferredOwnerMetrics,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics,
    livePreferredOwnerNaturalWinEvent,
    livePreferredOwnerDeferralEvent,
    livePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerLatestOperationalVerdict,
    livePreferredOwnerLatestOperationalVerdictCapturedThisRun: (
      livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictCapturedThisRun === true
    ),
    livePreferredOwnerLatestOperationalVerdictSkipReason: (
      toText(livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictSkipReason || '')
      || null
    ),
    livePreferredOwnerOperationalProofBundle,
    livePreferredOwnerOperationalProofBundleCapturedThisRun: (
      livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleCapturedThisRun === true
    ),
    livePreferredOwnerOperationalProofBundleSkipReason: (
      toText(livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleSkipReason || '')
      || null
    ),
    livePreferredOwnerReservation,
    liveAutonomousFirstRight: enrichedLiveAutonomousFirstRight,
    liveAutonomousFirstRightReachedExecution: enrichedLiveAutonomousFirstRight.liveAutonomousFirstRightReachedExecution === true,
    liveOwnershipConsistencyOk,
    runOrigin,
  };
  updateDailyScoringRunDetails(db, runId, enrichedDetails);
  return {
    generatedAt: new Date().toISOString(),
    runId,
    runDate: nowDate,
    mode,
    runOrigin,
    windowDays,
    contextsSeen: sorted.length,
    scoredRows,
    insertedRows,
    updatedRows,
    skippedRows,
    skipReasonBuckets,
    sourceTypeMetrics,
    liveContextsSeen: Number(liveMetrics.contextsSeen || 0),
    liveContextsEligibleForScoring: Number(liveMetrics.contextsEligibleForScoring || 0),
    liveContextsScored: Number(liveMetrics.contextsScored || 0),
    liveRowsInserted: Number(liveMetrics.rowsInserted || 0),
    liveRowsUpdated: Number(liveMetrics.rowsUpdated || 0),
    liveContextsSkipped: Number(liveMetrics.contextsSkipped || 0),
    liveSkipReasonBuckets: liveMetrics.skipReasonBuckets || {},
    liveTopSkipReason,
    liveEligibilityReasonBuckets: liveReasonBuckets,
    liveBlockedReasonBuckets,
    liveTopBlockedReason,
    liveContextsFreshInserted,
    liveContextsUpdatedOnly,
    liveContextsBlocked,
    liveContextsWithoutFreshInsertDates,
    liveBridgeLookbackDays,
    liveContextDecisions,
    liveDayConversion: enrichedLiveDayConversion,
    liveFinalization: enrichedLiveFinalization,
    liveInsertionSla,
    liveInsertionGrowth,
    liveInsertionOwnership,
    liveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness,
    liveAutonomousAttemptTransition,
    liveAutonomousProof,
    liveAutonomousInsertionMetrics,
    livePreferredOwnerProof,
    livePreferredOwnerMetrics,
    livePreferredOwnerReservation,
    liveAutonomousFirstRight: enrichedLiveAutonomousFirstRight,
    liveOwnershipConsistencyOk,
    liveInsertionOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
      liveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || 'ownership_source_unknown'
    ),
    liveAutonomousInsertReadinessTargetTradingDay: liveAutonomousInsertReadiness.targetTradingDay || null,
    liveAutonomousInsertReadinessEligible: liveAutonomousInsertReadiness.autonomousInsertEligible === true,
    liveAutonomousInsertReadinessBlockReason: liveAutonomousInsertReadiness.autonomousInsertBlockReason,
    liveAutonomousInsertReadinessNextTransition: liveAutonomousInsertReadiness.autonomousInsertNextTransition,
    liveAutonomousAttemptResult: liveAutonomousAttemptTransition.attemptResult,
    liveAutonomousAttemptRequired: liveAutonomousAttemptTransition.attemptRequired === true,
    liveAutonomousAttemptExecuted: liveAutonomousAttemptTransition.attemptExecuted === true,
    liveAutonomousAttemptExecutionPath: liveAutonomousAttemptTransition.attemptExecutionPath || null,
    liveAutonomousAttemptSkippedReason: liveAutonomousAttemptTransition.attemptSkippedReason || null,
    liveAutonomousAttemptInsertedRowId: Number(liveAutonomousAttemptTransition.insertedRowId || 0) || null,
    liveAutonomousAttemptRowInsertedByThisAttempt: liveAutonomousAttemptTransition.rowInsertedByThisAttempt === true,
    liveAutonomousAttemptTargetTradingDay: liveAutonomousAttemptTransition.targetTradingDay || null,
    liveAutonomousProofOutcome: liveAutonomousProof.liveAutonomousProofOutcome,
    liveAutonomousProofEligible: liveAutonomousProof.liveAutonomousProofEligible === true,
    liveAutonomousProofAttempted: liveAutonomousProof.liveAutonomousProofAttempted === true,
    liveAutonomousProofSucceeded: liveAutonomousProof.liveAutonomousProofSucceeded === true,
    liveAutonomousProofFailureReason: liveAutonomousProof.liveAutonomousProofFailureReason,
    liveAutonomousProofTargetTradingDay: liveAutonomousProof.liveAutonomousProofTargetTradingDay || null,
    livePreferredOwnerProof,
    livePreferredOwnerMetrics,
    livePreferredOwnerNaturalWinMetrics,
    livePreferredOwnerVerifierMetrics,
    livePreferredOwnerNaturalWinEvent,
    livePreferredOwnerDeferralEvent,
    livePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerTargetTradingDay: livePreferredOwnerProof.livePreferredOwnerTargetTradingDay || null,
    livePreferredOwnerExpectedSource: livePreferredOwnerProof.livePreferredOwnerExpectedSource || 'close_complete_checkpoint',
    livePreferredOwnerActualSource: livePreferredOwnerProof.livePreferredOwnerActualSource || null,
    livePreferredOwnerWon: livePreferredOwnerProof.livePreferredOwnerWon === true,
    livePreferredOwnerFailureReason: livePreferredOwnerProof.livePreferredOwnerFailureReason || 'none',
    livePreferredOwnerProofCapturedAt: livePreferredOwnerProof.livePreferredOwnerProofCapturedAt || null,
    preferredOwnerWonToday: Number(livePreferredOwnerMetrics.preferredOwnerWonToday || 0),
    preferredOwnerMissedToday: Number(livePreferredOwnerMetrics.preferredOwnerMissedToday || 0),
    rolling5dPreferredOwnerWinRatePct: Number(livePreferredOwnerMetrics.rolling5dPreferredOwnerWinRatePct || 0),
    consecutivePreferredOwnerWinDays: Number(livePreferredOwnerMetrics.consecutivePreferredOwnerWinDays || 0),
    consecutivePreferredOwnerMissDays: Number(livePreferredOwnerMetrics.consecutivePreferredOwnerMissDays || 0),
    livePreferredOwnerKpiConsistent: livePreferredOwnerMetrics.livePreferredOwnerKpiConsistent !== false,
    livePreferredOwnerKpiMismatchReason: normalizeLivePreferredOwnerKpiMismatchReason(
      livePreferredOwnerMetrics.livePreferredOwnerKpiMismatchReason || 'none'
    ),
    livePreferredOwnerKpiSource: toText(livePreferredOwnerMetrics.livePreferredOwnerKpiSource || '') || 'jarvis_live_preferred_owner_proof',
    naturalPreferredOwnerWinsLast5d: Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsLast5d || 0),
    naturalPreferredOwnerWinsTotal: Number(livePreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsTotal || 0),
    lastNaturalPreferredOwnerWinDay: livePreferredOwnerNaturalWinMetrics.lastNaturalPreferredOwnerWinDay || null,
    naturalPreferredOwnerVerifierPassesLast5d: Number(livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierPassesLast5d || 0),
    naturalPreferredOwnerVerifierFailsLast5d: Number(livePreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierFailsLast5d || 0),
    livePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerLatestOperationalVerdict,
    livePreferredOwnerLatestOperationalVerdictCapturedThisRun: (
      livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictCapturedThisRun === true
    ),
    livePreferredOwnerLatestOperationalVerdictSkipReason: (
      toText(livePreferredOwnerLatestOperationalVerdictCapture?.livePreferredOwnerLatestOperationalVerdictSkipReason || '')
      || null
    ),
    livePreferredOwnerLatestOperationalVerdictTargetTradingDay: (
      livePreferredOwnerLatestOperationalVerdict?.targetTradingDay || null
    ),
    livePreferredOwnerLatestOperationalVerdictStatus: normalizePreferredOwnerPostCloseProofStatus(
      livePreferredOwnerLatestOperationalVerdict?.verifierStatus || 'fail'
    ),
    livePreferredOwnerLatestOperationalVerdictPass: (
      livePreferredOwnerLatestOperationalVerdict?.verifierPass === true
    ),
    livePreferredOwnerLatestOperationalVerdictReasons: Array.isArray(
      livePreferredOwnerLatestOperationalVerdict?.verifierFailureReasons
    )
      ? livePreferredOwnerLatestOperationalVerdict.verifierFailureReasons
      : [],
    livePreferredOwnerLatestOperationalVerdictReportedAt: (
      livePreferredOwnerLatestOperationalVerdict?.reportedAt || null
    ),
    livePreferredOwnerLatestOperationalVerdictRunOrigin: normalizeDailyScoringRunOrigin(
      livePreferredOwnerLatestOperationalVerdict?.runOrigin || 'manual'
    ),
    livePreferredOwnerLatestOperationalVerdictRuntimeSource: normalizeFinalizationSweepSource(
      livePreferredOwnerLatestOperationalVerdict?.runtimeCheckpointSource || 'manual_api_run'
    ),
    livePreferredOwnerOperationalProofBundle,
    livePreferredOwnerOperationalProofBundleCapturedThisRun: (
      livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleCapturedThisRun === true
    ),
    livePreferredOwnerOperationalProofBundleSkipReason: (
      toText(livePreferredOwnerOperationalProofBundleCapture?.livePreferredOwnerOperationalProofBundleSkipReason || '')
      || null
    ),
    livePreferredOwnerOperationalProofBundleTargetTradingDay: (
      livePreferredOwnerOperationalProofBundle?.targetTradingDay || null
    ),
    livePreferredOwnerOperationalProofBundleRunId: Number(
      livePreferredOwnerOperationalProofBundle?.runId || 0
    ) || null,
    livePreferredOwnerOperationalProofBundleRunOrigin: normalizeDailyScoringRunOrigin(
      livePreferredOwnerOperationalProofBundle?.runOrigin || 'manual'
    ),
    livePreferredOwnerOperationalProofBundleCheckpointStatus: normalizeCheckpointStatus(
      livePreferredOwnerOperationalProofBundle?.checkpointStatus || 'waiting_valid'
    ),
    livePreferredOwnerOperationalProofBundleCheckpointReason: normalizeCheckpointReason(
      livePreferredOwnerOperationalProofBundle?.checkpointReason || 'unknown_checkpoint_state'
    ),
    livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource: normalizeFinalizationSweepSource(
      livePreferredOwnerOperationalProofBundle?.runtimeCheckpointSource || 'manual_api_run'
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerExpectedSource: normalizeFinalizationSweepSource(
      livePreferredOwnerOperationalProofBundle?.preferredOwnerExpectedSource || 'close_complete_checkpoint'
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerActualSource: (
      livePreferredOwnerOperationalProofBundle?.preferredOwnerActualSource || null
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerWon: (
      livePreferredOwnerOperationalProofBundle?.preferredOwnerWon === true
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
      livePreferredOwnerOperationalProofBundle?.preferredOwnerFailureReason || 'none'
    ),
    livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
      livePreferredOwnerOperationalProofBundle?.ownershipSourceSpecificOutcome || 'ownership_source_unknown'
    ),
    livePreferredOwnerOperationalProofBundleVerifierStatus: normalizePreferredOwnerPostCloseProofStatus(
      livePreferredOwnerOperationalProofBundle?.verifierStatus || 'fail'
    ),
    livePreferredOwnerOperationalProofBundleVerifierPass: (
      livePreferredOwnerOperationalProofBundle?.verifierPass === true
    ),
    livePreferredOwnerOperationalProofBundleVerifierFailureReasons: Array.isArray(
      livePreferredOwnerOperationalProofBundle?.verifierFailureReasons
    )
      ? livePreferredOwnerOperationalProofBundle.verifierFailureReasons
      : [],
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d: Number(
      livePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerWinsLast5d || 0
    ),
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal: Number(
      livePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerWinsTotal || 0
    ),
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierPassesLast5d: Number(
      livePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerVerifierPassesLast5d || 0
    ),
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierFailsLast5d: Number(
      livePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerVerifierFailsLast5d || 0
    ),
    livePreferredOwnerOperationalProofBundleCapturedAt: (
      livePreferredOwnerOperationalProofBundle?.capturedAt || null
    ),
    livePreferredOwnerPostCloseProofVerifierStatus: normalizePreferredOwnerPostCloseProofStatus(
      livePreferredOwnerPostCloseProofVerifier?.verifierStatus || 'fail'
    ),
    livePreferredOwnerPostCloseProofVerifierPass: livePreferredOwnerPostCloseProofVerifier?.verifierPass === true,
    livePreferredOwnerPostCloseProofVerifierFailureReasons: Array.isArray(livePreferredOwnerPostCloseProofVerifier?.failureReasons)
      ? livePreferredOwnerPostCloseProofVerifier.failureReasons
      : [],
    livePreferredOwnerPostCloseProofVerifierTargetTradingDay: livePreferredOwnerPostCloseProofVerifier?.targetTradingDay || null,
    livePreferredOwnerPostCloseProofVerifierRunId: Number(livePreferredOwnerPostCloseProofVerifier?.runId || 0) || null,
    livePreferredOwnerPostCloseProofVerifierVerifiedAt: livePreferredOwnerPostCloseProofVerifier?.verifiedAt || null,
    livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
      livePreferredOwnerPostCloseProofVerifier?.livePreferredOwnerPostCloseProofVerifierRunOrigin
      || livePreferredOwnerPostCloseProofVerifier?.runOrigin
      || runOrigin
    ),
    livePreferredOwnerPostCloseProofResolvedNaturally: (
      livePreferredOwnerPostCloseProofVerifier?.livePreferredOwnerPostCloseProofResolvedNaturally === true
    ),
    livePreferredOwnerReservation,
    livePreferredOwnerReservationTargetTradingDay: livePreferredOwnerReservation.livePreferredOwnerReservationTargetTradingDay || null,
    livePreferredOwnerReservationExpectedSource: livePreferredOwnerReservation.livePreferredOwnerReservationExpectedSource || 'close_complete_checkpoint',
    livePreferredOwnerReservationActive: livePreferredOwnerReservation.livePreferredOwnerReservationActive === true,
    livePreferredOwnerReservationWindowOpenedAt: livePreferredOwnerReservation.livePreferredOwnerReservationWindowOpenedAt || null,
    livePreferredOwnerReservationWindowExpiresAt: livePreferredOwnerReservation.livePreferredOwnerReservationWindowExpiresAt || null,
    livePreferredOwnerReservationState: livePreferredOwnerReservation.livePreferredOwnerReservationState || 'reservation_not_applicable',
    livePreferredOwnerReservationBlockedSource: livePreferredOwnerReservation.livePreferredOwnerReservationBlockedSource || null,
    livePreferredOwnerReservationBlockReason: livePreferredOwnerReservation.livePreferredOwnerReservationBlockReason || 'none',
    livePreferredOwnerReservationReleasedAt: livePreferredOwnerReservation.livePreferredOwnerReservationReleasedAt || null,
    livePreferredOwnerDeferredFallbackSource: livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackSource || null,
    livePreferredOwnerDeferredFallbackReason: livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackReason || null,
    livePreferredOwnerDeferredFallbackAt: livePreferredOwnerReservation.livePreferredOwnerDeferredFallbackAt || null,
    liveFinalizationPendingCount: Number(waitingFinalizationCount || 0),
    liveFinalizationFinalizedTodayCount: Number(finalizedInsertedCount || 0),
    liveFinalizationAlreadyFinalizedCount: Number(alreadyFinalizedCount || 0),
    liveFinalizationTopWaitingReason: topWaitingReason || null,
    liveFinalizationTopBlockedReason: topFinalizationBlockedReason || null,
    liveFinalizationReasonBuckets,
    liveFinalizationReadinessStateBuckets: liveFinalizationStateBuckets,
    liveFinalizationTradingDayClassificationBuckets: liveTradingDayClassificationBuckets,
    liveFinalizationWaitingReasonBuckets: liveFinalizationWaitingBuckets,
    liveFinalizationBlockedReasonBuckets: liveFinalizationBlockedBuckets,
    liveFinalizationPendingLiveDates: pendingLiveDates,
    liveFinalizationSweepSource: resolvedLiveFinalizationSweepSource,
    latestReadyButUninsertedDates,
    latestWaitingDates,
    latestBlockedDates,
    validLiveDaysSeen: Number(validLiveDaysSeen || 0),
    validLiveDaysReadyToFinalize: Number(validLiveDaysReadyToFinalize || 0),
    validLiveDaysFinalizedInserted: Number(validLiveDaysFinalizedInserted || 0),
    validLiveDaysFinalizedUpdated: Number(validLiveDaysFinalizedUpdated || 0),
    validLiveDaysStillWaiting: Number(validLiveDaysStillWaiting || 0),
    validLiveDaysBlocked: Number(validLiveDaysBlocked || 0),
    validLiveDaysMissedByScheduler: Number(validLiveDaysMissedByScheduler || 0),
    liveCheckpoint,
    liveInsertionSla,
    liveInsertionGrowth,
    liveInsertionOwnership,
    liveTargetDayOwnershipInvariant,
    liveAutonomousProof,
    liveAutonomousInsertionMetrics,
    liveAutonomousFirstRight: enrichedLiveAutonomousFirstRight,
    liveOwnershipConsistencyOk,
    missedValidCheckpointDaysCount: Number(missedValidCheckpointDaysCount || 0),
    latestMissedCheckpointDates,
    latestCheckpointFailures,
    invalidLiveContextsCreatedToday: Number(liveContextAudit?.invalidLiveContextsCreatedToday || 0),
    invalidLiveContextsSuppressedToday: Number(liveContextAudit?.invalidLiveContextsSuppressedToday || 0),
    latestInvalidLiveContextDates: Array.isArray(liveContextAudit?.latestInvalidLiveContextDates)
      ? liveContextAudit.latestInvalidLiveContextDates.slice(0, 12)
      : [],
    netNewLiveRows1d: Number(netNewLiveRows.oneDay || 0),
    netNewLiveRows3d: Number(netNewLiveRows.threeDay || 0),
    netNewLiveRows7d: Number(netNewLiveRows.sevenDay || 0),
    liveContextAudit,
    contextCapture: details.contextCapture,
    scoreWriteRatePct: sorted.length > 0 ? round2((scoredRows / sorted.length) * 100) : 0,
    status,
    warnings,
    advisoryOnly: true,
  };
}

function buildDailyScoringStatus(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'error',
      error: 'db_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDailyScoringTables(db);
  const latestRun = getLatestDailyScoringRun(db);
  const latestLive = latestRun?.details?.liveGeneration && typeof latestRun.details.liveGeneration === 'object'
    ? latestRun.details.liveGeneration
    : {};
  const latestFinalization = latestRun?.details?.liveFinalization && typeof latestRun.details.liveFinalization === 'object'
    ? latestRun.details.liveFinalization
    : {};
  const latestCheckpoint = latestRun?.details?.liveCheckpoint && typeof latestRun.details.liveCheckpoint === 'object'
    ? latestRun.details.liveCheckpoint
    : {};
  const latestInsertionSlaFromRun = latestRun?.details?.liveInsertionSla && typeof latestRun.details.liveInsertionSla === 'object'
    ? latestRun.details.liveInsertionSla
    : {};
  const latestInsertionGrowthFromRun = latestRun?.details?.liveInsertionGrowth && typeof latestRun.details.liveInsertionGrowth === 'object'
    ? latestRun.details.liveInsertionGrowth
    : {};
  const latestInsertionOwnershipFromRun = latestRun?.details?.liveInsertionOwnership && typeof latestRun.details.liveInsertionOwnership === 'object'
    ? latestRun.details.liveInsertionOwnership
    : {};
  const latestPreferredOwnerProofFromRun = latestRun?.details?.livePreferredOwnerProof && typeof latestRun.details.livePreferredOwnerProof === 'object'
    ? latestRun.details.livePreferredOwnerProof
    : {};
  const latestPreferredOwnerMetricsFromRun = latestRun?.details?.livePreferredOwnerMetrics && typeof latestRun.details.livePreferredOwnerMetrics === 'object'
    ? latestRun.details.livePreferredOwnerMetrics
    : {};
  const latestPreferredOwnerReservationFromRun = latestRun?.details?.livePreferredOwnerReservation
    && typeof latestRun.details.livePreferredOwnerReservation === 'object'
    ? latestRun.details.livePreferredOwnerReservation
    : {};
  const latestPreferredOwnerPostCloseVerifierFromRun = latestRun?.details?.livePreferredOwnerPostCloseProofVerifier
    && typeof latestRun.details.livePreferredOwnerPostCloseProofVerifier === 'object'
    ? latestRun.details.livePreferredOwnerPostCloseProofVerifier
    : {};
  const latestPreferredOwnerOperationalVerdictFromRun = latestRun?.details?.livePreferredOwnerLatestOperationalVerdict
    && typeof latestRun.details.livePreferredOwnerLatestOperationalVerdict === 'object'
    ? latestRun.details.livePreferredOwnerLatestOperationalVerdict
    : {};
  const latestPreferredOwnerOperationalProofBundleFromRun = latestRun?.details?.livePreferredOwnerOperationalProofBundle
    && typeof latestRun.details.livePreferredOwnerOperationalProofBundle === 'object'
    ? latestRun.details.livePreferredOwnerOperationalProofBundle
    : {};
  const latestAutonomousFirstRightFromRun = latestRun?.details?.liveAutonomousFirstRight
    && typeof latestRun.details.liveAutonomousFirstRight === 'object'
    ? latestRun.details.liveAutonomousFirstRight
    : {};
  const latestAutonomousInsertReadinessFromRun = latestRun?.details?.liveAutonomousInsertReadiness
    && typeof latestRun.details.liveAutonomousInsertReadiness === 'object'
    ? latestRun.details.liveAutonomousInsertReadiness
    : {};
  const latestAutonomousAttemptTransitionFromRun = latestRun?.details?.liveAutonomousAttemptTransition
    && typeof latestRun.details.liveAutonomousAttemptTransition === 'object'
    ? latestRun.details.liveAutonomousAttemptTransition
    : {};
  const latestLiveContextAudit = latestRun?.details?.liveContextAudit && typeof latestRun.details.liveContextAudit === 'object'
    ? latestRun.details.liveContextAudit
    : {};
  const recentRuns = db.prepare(`
    SELECT id, run_date, mode, run_origin, status, contexts_seen, scored_rows, inserted_rows, updated_rows, details_json, created_at
    FROM jarvis_daily_scoring_runs
    ORDER BY id DESC
    LIMIT 20
  `).all().map((row) => {
    let details = {};
    try { details = JSON.parse(String(row.details_json || '{}')); } catch {}
    const live = details?.liveGeneration && typeof details.liveGeneration === 'object'
      ? details.liveGeneration
      : {};
    return {
      id: Number(row.id || 0),
      runDate: normalizeDate(row.run_date),
      mode: toText(row.mode || '') || 'auto',
      runOrigin: normalizeDailyScoringRunOrigin(row.run_origin || 'manual'),
      status: toText(row.status || '') || 'noop',
      contextsSeen: Number(row.contexts_seen || 0),
      scoredRows: Number(row.scored_rows || 0),
      insertedRows: Number(row.inserted_rows || 0),
      updatedRows: Number(row.updated_rows || 0),
      liveContextsSeen: Number(live.contextsSeen || 0),
      liveContextsEligibleForScoring: Number(live.contextsEligibleForScoring || 0),
      liveContextsScored: Number(live.contextsScored || 0),
      liveRowsInserted: Number(live.rowsInserted || 0),
      liveRowsUpdated: Number(live.rowsUpdated || 0),
      liveContextsSkipped: Number(live.contextsSkipped || 0),
      liveTopSkipReason: toText(live.topSkipReason || '') || null,
      liveFinalizationPendingCount: Number(details?.liveFinalization?.pendingLiveContextsCount || 0),
      liveFinalizationFinalizedTodayCount: Number(details?.liveFinalization?.finalizedTodayCount || 0),
      liveFinalizationTopWaitingReason: toText(details?.liveFinalization?.topWaitingReason || '') || null,
      liveFinalizationSweepSource: normalizeFinalizationSweepSource(
        details?.liveFinalization?.sweepSource
        || details?.liveFinalizationSweepSource
        || ''
      ),
      liveCheckpoint: details?.liveCheckpoint && typeof details.liveCheckpoint === 'object'
        ? details.liveCheckpoint
        : null,
      createdAt: toText(row.created_at || '') || null,
    };
  });
  const finalizationSweepSourceBuckets = {};
  for (const row of recentRuns) {
    const src = normalizeFinalizationSweepSource(row?.liveFinalizationSweepSource || '');
    finalizationSweepSourceBuckets[src] = Number(finalizationSweepSourceBuckets[src] || 0) + 1;
  }
  const checkpointFailureMap = new Map();
  const missedCheckpointMap = new Map();
  for (const row of recentRuns) {
    const checkpoint = row?.liveCheckpoint && typeof row.liveCheckpoint === 'object'
      ? row.liveCheckpoint
      : null;
    if (!checkpoint) continue;
    const status = normalizeCheckpointStatus(checkpoint.checkpointStatus);
    const failureReason = normalizeCheckpointFailureReason(checkpoint.failureReason);
    const firstEligibleCycleFailureReason = normalizeFirstEligibleCycleFailureReason(
      checkpoint.firstEligibleCycleFailureReason
    );
    const reason = normalizeCheckpointReason(checkpoint.checkpointReason);
    const targetDate = normalizeDate(checkpoint.targetTradingDay || '');
    const sweepSource = normalizeFinalizationSweepSource(
      checkpoint.sweepSource
      || row?.liveFinalizationSweepSource
      || ''
    );
    if (String(status).startsWith('failure_')) {
      const key = `${targetDate || 'unknown'}|${status}|${failureReason || 'none'}|${sweepSource}`;
      if (!checkpointFailureMap.has(key)) {
        checkpointFailureMap.set(key, {
          date: targetDate || null,
          status,
          reason,
          failureReason: failureReason || 'unknown_failure',
          firstEligibleCycleFailureReason: firstEligibleCycleFailureReason || null,
          sweepSource,
        });
      }
    }
    if (status === 'failure_scheduler_miss' && targetDate) {
      const key = `${targetDate}|${failureReason || 'checkpoint_not_run'}`;
      if (!missedCheckpointMap.has(key)) {
        missedCheckpointMap.set(key, {
          date: targetDate,
          reason: failureReason || 'checkpoint_not_run',
          status,
        });
      }
    }
  }
  const latestCheckpointFailures = Array.from(checkpointFailureMap.values())
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 12);
  const latestMissedCheckpointDates = Array.from(missedCheckpointMap.values())
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 12);
  const missedValidCheckpointDaysCount = Number(latestMissedCheckpointDates.length || 0);
  const recentOutcomes = db.prepare(`
    SELECT
      score_date,
      source_type,
      reconstruction_phase,
      score_label,
      recommendation_delta,
      actual_pnl,
      best_possible_pnl,
      updated_at
    FROM jarvis_scored_trade_outcomes
    ORDER BY score_date DESC, updated_at DESC
    LIMIT 20
  `).all().map((row) => ({
    scoreDate: normalizeDate(row.score_date),
    sourceType: toText(row.source_type || '') || 'live',
    reconstructionPhase: toText(row.reconstruction_phase || '') || 'live_intraday',
    scoreLabel: toText(row.score_label || '') || null,
    recommendationDelta: toNumber(row.recommendation_delta, null),
    actualPnl: toNumber(row.actual_pnl, null),
    bestPossiblePnl: toNumber(row.best_possible_pnl, null),
    updatedAt: toText(row.updated_at || '') || null,
  }));
  const latestWithoutFreshInsertDates = Array.isArray(latestLive.contextsWithoutFreshInsertDates)
    ? latestLive.contextsWithoutFreshInsertDates.slice(0, 12).map((row) => ({
      date: normalizeDate(row?.date || ''),
      reason: normalizeLiveReason(row?.reason || ''),
    })).filter((row) => !!row.date)
    : [];
  const latestPendingFinalizationDates = Array.isArray(latestFinalization.latestPendingLiveDates)
    ? latestFinalization.latestPendingLiveDates.slice(0, 12).map((row) => ({
      date: normalizeDate(row?.date || ''),
      reason: normalizeFinalizationReason(row?.reason || ''),
      classification: normalizeTradingDayClassification(row?.classification || 'valid_trading_day'),
    })).filter((row) => !!row.date)
    : [];
  const latestReadyButUninsertedDates = Array.isArray(latestFinalization.latestReadyButUninsertedDates)
    ? latestFinalization.latestReadyButUninsertedDates.slice(0, 12).map((row) => ({
      date: normalizeDate(row?.date || ''),
      reason: normalizeFinalizationReason(row?.reason || ''),
      classification: normalizeTradingDayClassification(row?.classification || 'valid_trading_day'),
    })).filter((row) => !!row.date)
    : [];
  const latestWaitingDates = Array.isArray(latestFinalization.latestWaitingDates)
    ? latestFinalization.latestWaitingDates.slice(0, 12).map((row) => ({
      date: normalizeDate(row?.date || ''),
      reason: normalizeFinalizationReason(row?.reason || ''),
      classification: normalizeTradingDayClassification(row?.classification || 'valid_trading_day'),
    })).filter((row) => !!row.date)
    : [];
  const latestBlockedDates = Array.isArray(latestFinalization.latestBlockedDates)
    ? latestFinalization.latestBlockedDates.slice(0, 12).map((row) => ({
      date: normalizeDate(row?.date || ''),
      reason: normalizeFinalizationReason(row?.reason || ''),
      classification: normalizeTradingDayClassification(row?.classification || 'invalid_mapping'),
    })).filter((row) => !!row.date)
    : [];
  const statusRunDate = latestRun?.runDate || normalizeDate(new Date().toISOString());
  const statusNetNewLiveRows = {
    oneDay: countNetNewLiveRowsByCreatedWindow(db, statusRunDate, 1),
    threeDay: countNetNewLiveRowsByCreatedWindow(db, statusRunDate, 3),
    sevenDay: countNetNewLiveRowsByCreatedWindow(db, statusRunDate, 7),
  };
  const statusPreferredOwnerNaturalWinMetrics = readPreferredOwnerNaturalWinMetrics(db, statusRunDate);
  const statusPreferredOwnerVerifierMetrics = readPreferredOwnerVerifierMetrics(db, statusRunDate);
  const statusPreferredOwnerOperationalVerdictFromTable = readLatestPreferredOwnerOperationalVerdictRow(db);
  const statusPreferredOwnerOperationalProofBundleFromTable = readLatestPreferredOwnerOperationalProofBundleRow(db);
  const statusLiveCheckpoint = {
    targetTradingDay: normalizeDate(latestCheckpoint.targetTradingDay || '') || null,
    tradingDayClassification: normalizeTradingDayClassification(latestCheckpoint.tradingDayClassification || 'invalid_mapping'),
    tradingDayClassificationReason: toText(latestCheckpoint.tradingDayClassificationReason || '') || 'unknown',
    closeComplete: latestCheckpoint.closeComplete === true,
    closeCompleteReason: normalizeCloseCompleteReason(latestCheckpoint.closeCompleteReason),
    requiredCloseDataPresent: latestCheckpoint.requiredCloseDataPresent === true,
    requiredCloseBarsPresent: latestCheckpoint.requiredCloseBarsPresent === true,
    closeCheckpointEligible: latestCheckpoint.closeCheckpointEligible === true,
    closeCheckpointEligibilityReason: normalizeCloseCompleteReason(
      latestCheckpoint.closeCheckpointEligibilityReason
      || latestCheckpoint.closeCompleteReason
    ),
    firstEligibleCycleAt: toText(latestCheckpoint.firstEligibleCycleAt || '') || null,
    checkpointEvaluatedAt: toText(latestCheckpoint.checkpointEvaluatedAt || '') || null,
    checkpointStatus: normalizeCheckpointStatus(latestCheckpoint.checkpointStatus),
    checkpointReason: normalizeCheckpointReason(latestCheckpoint.checkpointReason),
    expectedLiveContextExists: latestCheckpoint.expectedLiveContextExists === true,
    liveContextSuppressed: latestCheckpoint.liveContextSuppressed === true,
    liveOutcomeExists: latestCheckpoint.liveOutcomeExists === true,
    liveOutcomeInsertedThisCheckpoint: latestCheckpoint.liveOutcomeInsertedThisCheckpoint === true,
    liveOutcomeUpdatedThisCheckpoint: latestCheckpoint.liveOutcomeUpdatedThisCheckpoint === true,
    awaitingReason: normalizeCheckpointAwaitingReason(latestCheckpoint.awaitingReason),
    failureReason: normalizeCheckpointFailureReason(latestCheckpoint.failureReason),
    firstEligibleCycleExpectedInsert: latestCheckpoint.firstEligibleCycleExpectedInsert === true,
    firstEligibleCycleInsertAttempted: latestCheckpoint.firstEligibleCycleInsertAttempted === true,
    firstEligibleCycleInsertSucceeded: latestCheckpoint.firstEligibleCycleInsertSucceeded === true,
    firstEligibleCycleFailureReason: normalizeFirstEligibleCycleFailureReason(latestCheckpoint.firstEligibleCycleFailureReason),
    checkpointWindowOpenedAt: toText(latestCheckpoint.checkpointWindowOpenedAt || '') || null,
    checkpointDeadlineAt: toText(latestCheckpoint.checkpointDeadlineAt || '') || null,
    checkpointWindowClosedAt: toText(latestCheckpoint.checkpointWindowClosedAt || '') || null,
    checkpointWithinAllowedWindow: latestCheckpoint.checkpointWithinAllowedWindow === true,
    checkpointPastDeadline: latestCheckpoint.checkpointPastDeadline === true,
    checkpointWindowReason: normalizeCheckpointWindowReason(latestCheckpoint.checkpointWindowReason),
    runtimeCheckpointTriggered: latestCheckpoint.runtimeCheckpointTriggered === true,
    runtimeCheckpointTriggeredAt: toText(latestCheckpoint.runtimeCheckpointTriggeredAt || '') || null,
    runtimeCheckpointSource: normalizeFinalizationSweepSource(
      latestCheckpoint.runtimeCheckpointSource
      || latestCheckpoint.sweepSource
      || ''
    ),
    runtimeCheckpointTargetTradingDay: normalizeDate(
      latestCheckpoint.runtimeCheckpointTargetTradingDay
      || latestCheckpoint.targetTradingDay
      || ''
    ) || null,
    runtimeCheckpointOutcome: normalizeRuntimeCheckpointOutcome(
      latestCheckpoint.runtimeCheckpointOutcome
      || mapCheckpointToRuntimeOutcome(latestCheckpoint)
    ),
    runtimeCheckpointWasAutonomous: latestCheckpoint.runtimeCheckpointWasAutonomous === true,
    runtimeCheckpointMissed: latestCheckpoint.runtimeCheckpointMissed === true,
    runtimeCheckpointMissReason: latestCheckpoint.runtimeCheckpointMissReason
      ? normalizeCheckpointWindowReason(latestCheckpoint.runtimeCheckpointMissReason)
      : null,
    autonomousCheckpointSuccessResolved: latestCheckpoint.autonomousCheckpointSuccessResolved === true,
    autonomousCheckpointLatestOutcome: latestCheckpoint.autonomousCheckpointLatestOutcome
      ? normalizeRuntimeCheckpointOutcome(latestCheckpoint.autonomousCheckpointLatestOutcome)
      : null,
    autonomousCheckpointLatestTriggeredAt: toText(latestCheckpoint.autonomousCheckpointLatestTriggeredAt || '') || null,
    autonomousCheckpointLatestSweepSource: latestCheckpoint.autonomousCheckpointLatestSweepSource
      ? normalizeFinalizationSweepSource(latestCheckpoint.autonomousCheckpointLatestSweepSource)
      : null,
    sweepSource: normalizeFinalizationSweepSource(
      latestCheckpoint.sweepSource
      || latestFinalization.sweepSource
      || latestRun?.details?.liveFinalizationSweepSource
      || ''
    ),
    checkpointExpectedOutcomeCount: Number(latestCheckpoint.checkpointExpectedOutcomeCount || 0),
    checkpointActualOutcomeCount: Number(latestCheckpoint.checkpointActualOutcomeCount || 0),
    checkpointInsertDelta: Number(latestCheckpoint.checkpointInsertDelta || 0),
    checkpointDuplicateCount: Number(latestCheckpoint.checkpointDuplicateCount || 0),
    checkpointResolvedState: normalizeCheckpointStatus(
      latestCheckpoint.checkpointResolvedState
      || latestCheckpoint.checkpointStatus
      || 'failure_unknown'
    ),
    checkpointCompletedAt: toText(latestCheckpoint.checkpointCompletedAt || '') || null,
    advisoryOnly: true,
  };
  const statusLiveInsertionSla = (
    latestInsertionSlaFromRun && Object.keys(latestInsertionSlaFromRun).length > 0
      ? {
        ...latestInsertionSlaFromRun,
        liveInsertionSlaTargetTradingDay: normalizeDate(latestInsertionSlaFromRun.liveInsertionSlaTargetTradingDay || '') || null,
        tradingDayClassification: normalizeTradingDayClassification(latestInsertionSlaFromRun.tradingDayClassification || 'invalid_mapping'),
        liveInsertionSlaRequired: latestInsertionSlaFromRun.liveInsertionSlaRequired === true,
        liveInsertionSlaOutcome: normalizeLiveInsertionSlaOutcome(latestInsertionSlaFromRun.liveInsertionSlaOutcome),
        liveInsertionSlaWasAutonomous: latestInsertionSlaFromRun.liveInsertionSlaWasAutonomous === true,
        liveInsertionSlaSource: normalizeFinalizationSweepSource(latestInsertionSlaFromRun.liveInsertionSlaSource || statusLiveCheckpoint.runtimeCheckpointSource || 'manual_api_run'),
        liveInsertionSlaTriggeredAt: toText(latestInsertionSlaFromRun.liveInsertionSlaTriggeredAt || '') || null,
        liveInsertionSlaWindowOpenedAt: toText(latestInsertionSlaFromRun.liveInsertionSlaWindowOpenedAt || '') || null,
        liveInsertionSlaDeadlineAt: toText(latestInsertionSlaFromRun.liveInsertionSlaDeadlineAt || '') || null,
        liveInsertionSlaWithinWindow: latestInsertionSlaFromRun.liveInsertionSlaWithinWindow === true,
        liveInsertionSlaPastDeadline: latestInsertionSlaFromRun.liveInsertionSlaPastDeadline === true,
        liveInsertionSlaNetNewRowCreated: latestInsertionSlaFromRun.liveInsertionSlaNetNewRowCreated === true,
        liveInsertionSlaCreatedRowId: Number(latestInsertionSlaFromRun.liveInsertionSlaCreatedRowId || 0) || null,
        liveInsertionSlaFailureReason: toText(latestInsertionSlaFromRun.liveInsertionSlaFailureReason || '') || null,
        liveInsertionSlaLateByMinutes: Number(latestInsertionSlaFromRun.liveInsertionSlaLateByMinutes || 0),
        liveInsertionSlaAlreadyFinalizedBeforeWindow: latestInsertionSlaFromRun.liveInsertionSlaAlreadyFinalizedBeforeWindow === true,
        liveInsertionSlaCloseComplete: latestInsertionSlaFromRun.liveInsertionSlaCloseComplete === true,
        liveInsertionSlaRequiredCloseDataPresent: latestInsertionSlaFromRun.liveInsertionSlaRequiredCloseDataPresent === true,
        liveInsertionSlaRequiredCloseBarsPresent: latestInsertionSlaFromRun.liveInsertionSlaRequiredCloseBarsPresent === true,
        liveInsertionSlaExpectedOutcomeCount: Number(latestInsertionSlaFromRun.liveInsertionSlaExpectedOutcomeCount || 0),
        liveInsertionSlaActualOutcomeCount: Number(latestInsertionSlaFromRun.liveInsertionSlaActualOutcomeCount || 0),
        advisoryOnly: true,
      }
      : buildLiveInsertionSla({
        db,
        nowDate: statusRunDate,
        nowTime: '00:00',
        liveCheckpoint: statusLiveCheckpoint,
      })
  );
  const statusLiveInsertionGrowth = (
    latestInsertionGrowthFromRun && Object.keys(latestInsertionGrowthFromRun).length > 0
      ? {
        liveNetNewRequiredToday: Number(latestInsertionGrowthFromRun.liveNetNewRequiredToday || 0),
        liveNetNewDeliveredToday: Number(latestInsertionGrowthFromRun.liveNetNewDeliveredToday || 0),
        liveNetNewMissedToday: Number(latestInsertionGrowthFromRun.liveNetNewMissedToday || 0),
        liveNetNewLateToday: Number(latestInsertionGrowthFromRun.liveNetNewLateToday || 0),
        consecutiveValidDaysWithOnTimeInsert: Number(latestInsertionGrowthFromRun.consecutiveValidDaysWithOnTimeInsert || 0),
        consecutiveValidDaysMissed: Number(latestInsertionGrowthFromRun.consecutiveValidDaysMissed || 0),
        rolling5dValidDays: Number(latestInsertionGrowthFromRun.rolling5dValidDays || 0),
        rolling5dRequiredInserts: Number(latestInsertionGrowthFromRun.rolling5dRequiredInserts || 0),
        rolling5dOnTimeInserts: Number(latestInsertionGrowthFromRun.rolling5dOnTimeInserts || 0),
        rolling5dLateInserts: Number(latestInsertionGrowthFromRun.rolling5dLateInserts || 0),
        rolling5dMissedInserts: Number(latestInsertionGrowthFromRun.rolling5dMissedInserts || 0),
        rolling5dAlreadyFinalized: Number(latestInsertionGrowthFromRun.rolling5dAlreadyFinalized || 0),
        rolling5dOnTimeRatePct: round2(latestInsertionGrowthFromRun.rolling5dOnTimeRatePct || 0),
        advisoryOnly: true,
      }
      : buildLiveInsertionGrowthMetrics({
        db,
        liveInsertionSla: statusLiveInsertionSla,
      })
  );
  const statusLiveInsertionOwnership = (
    latestInsertionOwnershipFromRun && Object.keys(latestInsertionOwnershipFromRun).length > 0
      ? (() => {
        const ownershipScope = normalizeLiveInsertionOwnershipScope(
          latestInsertionOwnershipFromRun.liveInsertionOwnershipScope || 'target_day'
        );
        const checkpointActualOutcomeCount = Number(statusLiveCheckpoint.checkpointActualOutcomeCount || 0);
        let normalizedOutcome = resolveMostPreciseOwnershipOutcome([
          latestInsertionOwnershipFromRun.liveInsertionOwnershipOutcome,
        ]);
        if (ownershipScope === 'target_day' && checkpointActualOutcomeCount === 0) {
          normalizedOutcome = 'target_day_not_inserted_yet';
        }
        const firstInsertedBySource = latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertedBySource
          ? normalizeFinalizationSweepSource(latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertedBySource)
          : null;
        const sourceSpecificOutcome = classifyOwnershipSourceSpecificOutcome({
          targetTradingDay: normalizeDate(
            latestInsertionOwnershipFromRun.liveInsertionOwnershipTargetTradingDay
            || statusLiveInsertionSla.liveInsertionSlaTargetTradingDay
            || ''
          ) || null,
          tradingDayClassification: normalizeTradingDayClassification(
            statusLiveInsertionSla.tradingDayClassification || statusLiveCheckpoint.tradingDayClassification || 'invalid_mapping'
          ),
          firstInsertedBySource,
          firstInsertedAutonomous: latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertedAutonomous === true,
          firstRunMode: toText(latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstRunMode || latestRun?.mode || ''),
          ownershipOutcome: normalizedOutcome,
        });
        const liveOwnershipConsistencyOk = !(
          normalizedOutcome === 'already_inserted_before_this_cycle'
          && (
            firstInsertedBySource === 'manual_api_run'
            || latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertedAutonomous === true
            || latestInsertionOwnershipFromRun.liveInsertionOwnershipCurrentRunWasFirstCreator === true
          )
        );
        return {
          liveInsertionOwnershipTargetTradingDay: normalizeDate(
            latestInsertionOwnershipFromRun.liveInsertionOwnershipTargetTradingDay
            || statusLiveInsertionSla.liveInsertionSlaTargetTradingDay
            || ''
          ) || null,
          liveInsertionOwnershipScope: ownershipScope,
          liveInsertionOwnershipOutcome: normalizedOutcome,
          liveInsertionOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
            latestInsertionOwnershipFromRun.liveInsertionOwnershipSourceSpecificOutcome || sourceSpecificOutcome
          ),
          liveInsertionOwnershipFirstInsertedAt: toText(
            latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertedAt || ''
          ) || null,
          liveInsertionOwnershipFirstInsertedBySource: firstInsertedBySource,
          liveInsertionOwnershipFirstInsertedAutonomous: latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertedAutonomous === true,
          liveInsertionOwnershipFirstInsertSlaOutcome: latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertSlaOutcome
            ? normalizeLiveInsertionSlaOutcome(latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstInsertSlaOutcome)
            : null,
          liveInsertionOwnershipCurrentRunCreatedRow: latestInsertionOwnershipFromRun.liveInsertionOwnershipCurrentRunCreatedRow === true,
          liveInsertionOwnershipCurrentRunCreatedRowId: Number(
            latestInsertionOwnershipFromRun.liveInsertionOwnershipCurrentRunCreatedRowId || 0
          ) || null,
          liveInsertionOwnershipCurrentRunWasFirstCreator: latestInsertionOwnershipFromRun.liveInsertionOwnershipCurrentRunWasFirstCreator === true,
          liveInsertionOwnershipFirstRunId: Number(latestInsertionOwnershipFromRun.liveInsertionOwnershipFirstRunId || 0) || null,
          liveOwnershipConsistencyOk: liveOwnershipConsistencyOk === true,
          advisoryOnly: true,
        };
      })()
      : buildLiveInsertionOwnership({
        db,
        runId: Number(latestRun?.id || 0) || null,
        runMode: latestRun?.mode || 'auto',
        liveCheckpoint: statusLiveCheckpoint,
        liveInsertionSla: statusLiveInsertionSla,
      })
  );
  const statusLiveAutonomousInsertionMetrics = buildLiveAutonomousInsertionMetrics({
    db,
    liveInsertionSla: statusLiveInsertionSla,
    liveInsertionOwnership: statusLiveInsertionOwnership,
  });
  const statusLiveAutonomousFirstRight = (
    latestAutonomousFirstRightFromRun && Object.keys(latestAutonomousFirstRightFromRun).length > 0
      ? {
        liveAutonomousFirstRightTargetTradingDay: normalizeDate(
          latestAutonomousFirstRightFromRun.liveAutonomousFirstRightTargetTradingDay
          || statusLiveCheckpoint.targetTradingDay
          || ''
        ) || null,
        liveAutonomousFirstRightWindowOpenedAt: toText(
          latestAutonomousFirstRightFromRun.liveAutonomousFirstRightWindowOpenedAt
          || statusLiveCheckpoint.checkpointWindowOpenedAt
          || ''
        ) || null,
        liveAutonomousFirstRightWindowExpiresAt: toText(
          latestAutonomousFirstRightFromRun.liveAutonomousFirstRightWindowExpiresAt
          || statusLiveCheckpoint.checkpointDeadlineAt
          || ''
        ) || null,
        liveAutonomousFirstRightWindowState: normalizeLiveAutonomousFirstRightWindowState(
          latestAutonomousFirstRightFromRun.liveAutonomousFirstRightWindowState
        ),
        liveAutonomousFirstRightActive: latestAutonomousFirstRightFromRun.liveAutonomousFirstRightActive === true,
        liveAutonomousFirstRightReservedForSource: normalizeFinalizationSweepSource(
          latestAutonomousFirstRightFromRun.liveAutonomousFirstRightReservedForSource || 'close_complete_checkpoint'
        ),
        liveAutonomousFirstRightOutcome: normalizeLiveAutonomousFirstRightOutcome(
          latestAutonomousFirstRightFromRun.liveAutonomousFirstRightOutcome
        ),
        liveManualInsertDeferred: latestAutonomousFirstRightFromRun.liveManualInsertDeferred === true,
        liveManualInsertDeferredReason: latestAutonomousFirstRightFromRun.liveManualInsertDeferredReason
          ? normalizeLiveAutonomousFirstRightOutcome(latestAutonomousFirstRightFromRun.liveManualInsertDeferredReason)
          : null,
        liveManualInsertWouldHavePreemptedAutonomous: latestAutonomousFirstRightFromRun.liveManualInsertWouldHavePreemptedAutonomous === true,
        liveOwnershipConsistencyOk: latestAutonomousFirstRightFromRun.liveOwnershipConsistencyOk === true
          && statusLiveInsertionOwnership.liveOwnershipConsistencyOk === true,
        advisoryOnly: true,
      }
      : {
        liveAutonomousFirstRightTargetTradingDay: statusLiveCheckpoint.targetTradingDay || null,
        liveAutonomousFirstRightWindowOpenedAt: statusLiveCheckpoint.checkpointWindowOpenedAt || null,
        liveAutonomousFirstRightWindowExpiresAt: statusLiveCheckpoint.checkpointDeadlineAt || null,
        liveAutonomousFirstRightWindowState: normalizeLiveAutonomousFirstRightWindowState(
          statusLiveCheckpoint.checkpointPastDeadline === true
            ? 'autonomous_window_expired'
            : (statusLiveCheckpoint.checkpointWithinAllowedWindow === true
              ? 'autonomous_window_open'
              : 'autonomous_window_not_open')
        ),
        liveAutonomousFirstRightActive: statusLiveCheckpoint.checkpointWithinAllowedWindow === true
          && statusLiveCheckpoint.tradingDayClassification === 'valid_trading_day',
        liveAutonomousFirstRightReservedForSource: 'close_complete_checkpoint',
        liveAutonomousFirstRightOutcome: normalizeLiveAutonomousFirstRightOutcome(
          statusLiveCheckpoint.checkpointWithinAllowedWindow === true
            ? 'autonomous_first_right_reserved'
            : 'manual_insert_allowed_after_autonomous_window'
        ),
        liveManualInsertDeferred: false,
        liveManualInsertDeferredReason: null,
        liveManualInsertWouldHavePreemptedAutonomous: false,
        liveOwnershipConsistencyOk: statusLiveInsertionOwnership.liveOwnershipConsistencyOk === true,
        advisoryOnly: true,
      }
  );
  const statusLiveTargetDayOwnershipInvariant = buildTargetDayOwnershipInvariant({
    liveCheckpoint: statusLiveCheckpoint,
    liveInsertionOwnership: statusLiveInsertionOwnership,
    liveAutonomousFirstRight: statusLiveAutonomousFirstRight,
  });
  const statusLiveOwnershipConsistencyOk = (
    statusLiveInsertionOwnership.liveOwnershipConsistencyOk === true
    && statusLiveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent === true
  );
  const enrichedStatusLiveAutonomousFirstRight = {
    ...statusLiveAutonomousFirstRight,
    liveOwnershipConsistencyOk: statusLiveOwnershipConsistencyOk,
  };
  const statusLiveAutonomousInsertReadiness = (
    latestAutonomousInsertReadinessFromRun && Object.keys(latestAutonomousInsertReadinessFromRun).length > 0
      ? {
        targetTradingDay: normalizeDate(
          latestAutonomousInsertReadinessFromRun.targetTradingDay
          || statusLiveCheckpoint.targetTradingDay
          || ''
        ) || null,
        validTradingDay: latestAutonomousInsertReadinessFromRun.validTradingDay === true,
        liveContextPresent: latestAutonomousInsertReadinessFromRun.liveContextPresent === true,
        closeComplete: latestAutonomousInsertReadinessFromRun.closeComplete === true,
        requiredMarketDataPresent: latestAutonomousInsertReadinessFromRun.requiredMarketDataPresent === true,
        firstRightSatisfied: latestAutonomousInsertReadinessFromRun.firstRightSatisfied === true,
        existingLiveRowPresent: latestAutonomousInsertReadinessFromRun.existingLiveRowPresent === true,
        autonomousInsertEligible: latestAutonomousInsertReadinessFromRun.autonomousInsertEligible === true,
        autonomousInsertBlockReason: normalizeLiveAutonomousInsertBlockReason(
          latestAutonomousInsertReadinessFromRun.autonomousInsertBlockReason || 'unknown_blocked_state'
        ),
        autonomousInsertNextTransition: normalizeLiveAutonomousInsertNextTransition(
          latestAutonomousInsertReadinessFromRun.autonomousInsertNextTransition || 'investigate_unknown'
        ),
        advisoryOnly: true,
      }
      : buildLiveAutonomousInsertReadiness({
        liveCheckpoint: statusLiveCheckpoint,
        liveInsertionOwnership: statusLiveInsertionOwnership,
        liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRight,
        liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
      })
  );
  const rawStatusLiveAutonomousProof = buildLiveAutonomousProofContract({
    liveCheckpoint: statusLiveCheckpoint,
    liveInsertionOwnership: statusLiveInsertionOwnership,
    liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRight,
    liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
  });
  const rawStatusLiveAutonomousAttemptTransition = (
    latestAutonomousAttemptTransitionFromRun && Object.keys(latestAutonomousAttemptTransitionFromRun).length > 0
      ? {
        targetTradingDay: normalizeDate(
          latestAutonomousAttemptTransitionFromRun.targetTradingDay
          || statusLiveAutonomousInsertReadiness.targetTradingDay
          || statusLiveCheckpoint.targetTradingDay
          || ''
        ) || null,
        eligibleAt: toText(latestAutonomousAttemptTransitionFromRun.eligibleAt || '') || null,
        attemptRequired: latestAutonomousAttemptTransitionFromRun.attemptRequired === true,
        attemptExecuted: latestAutonomousAttemptTransitionFromRun.attemptExecuted === true,
        attemptExecutionPath: normalizeFinalizationSweepSource(
          latestAutonomousAttemptTransitionFromRun.attemptExecutionPath || 'manual_api_run'
        ),
        attemptSkippedReason: toText(latestAutonomousAttemptTransitionFromRun.attemptSkippedReason || '') || null,
        existingRowDetectedAtAttemptTime: latestAutonomousAttemptTransitionFromRun.existingRowDetectedAtAttemptTime === true,
        rowInsertedByThisAttempt: latestAutonomousAttemptTransitionFromRun.rowInsertedByThisAttempt === true,
        insertedRowId: Number(latestAutonomousAttemptTransitionFromRun.insertedRowId || 0) || null,
        attemptResult: normalizeLiveAutonomousAttemptResult(
          latestAutonomousAttemptTransitionFromRun.attemptResult || 'attempt_not_required'
        ),
        advisoryOnly: true,
      }
      : buildLiveAutonomousAttemptTransition({
        liveCheckpoint: statusLiveCheckpoint,
        liveInsertionOwnership: statusLiveInsertionOwnership,
        liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRight,
        liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
        liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
        liveAutonomousProof: rawStatusLiveAutonomousProof,
      })
  );
  const enforcedStatusAttemptContract = enforceEligibleAttemptOrBugContract({
    liveCheckpoint: statusLiveCheckpoint,
    liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
    liveAutonomousProof: rawStatusLiveAutonomousProof,
    liveAutonomousAttemptTransition: rawStatusLiveAutonomousAttemptTransition,
  });
  const statusLiveAutonomousProof = enforcedStatusAttemptContract.liveAutonomousProof;
  const statusLiveAutonomousAttemptTransition = enforcedStatusAttemptContract.liveAutonomousAttemptTransition;
  const enrichedStatusLiveAutonomousFirstRightWithExecution = {
    ...enrichedStatusLiveAutonomousFirstRight,
    liveAutonomousFirstRightReachedExecution: (
      statusLiveAutonomousAttemptTransition.attemptExecuted === true
      && normalizeFinalizationSweepSource(
        statusLiveAutonomousAttemptTransition.attemptExecutionPath || ''
      ) === normalizeFinalizationSweepSource(
        enrichedStatusLiveAutonomousFirstRight.liveAutonomousFirstRightReservedForSource || 'close_complete_checkpoint'
      )
    ),
  };
  const statusLivePreferredOwnerProof = (
    latestPreferredOwnerProofFromRun && Object.keys(latestPreferredOwnerProofFromRun).length > 0
      ? {
        livePreferredOwnerTargetTradingDay: normalizeDate(
          latestPreferredOwnerProofFromRun.livePreferredOwnerTargetTradingDay
          || statusLiveCheckpoint.targetTradingDay
          || ''
        ) || null,
        livePreferredOwnerProofRowId: Number(latestPreferredOwnerProofFromRun.livePreferredOwnerProofRowId || 0) || null,
        livePreferredOwnerExpectedSource: normalizeFinalizationSweepSource(
          latestPreferredOwnerProofFromRun.livePreferredOwnerExpectedSource || 'close_complete_checkpoint'
        ),
        livePreferredOwnerActualSource: latestPreferredOwnerProofFromRun.livePreferredOwnerActualSource
          ? normalizeFinalizationSweepSource(latestPreferredOwnerProofFromRun.livePreferredOwnerActualSource)
          : null,
        livePreferredOwnerWon: latestPreferredOwnerProofFromRun.livePreferredOwnerWon === true,
        livePreferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
          latestPreferredOwnerProofFromRun.livePreferredOwnerFailureReason || 'none'
        ),
        livePreferredOwnerProofCapturedAt: toText(
          latestPreferredOwnerProofFromRun.livePreferredOwnerProofCapturedAt || ''
        ) || null,
        livePreferredOwnerFirstRowId: Number(latestPreferredOwnerProofFromRun.livePreferredOwnerFirstRowId || 0) || null,
        livePreferredOwnerFirstCreatorRunId: Number(latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreatorRunId || 0) || null,
        livePreferredOwnerFirstCreatorMode: toText(latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreatorMode || '') || null,
        livePreferredOwnerFirstCreatorSource: latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreatorSource
          ? normalizeFinalizationSweepSource(latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreatorSource)
          : null,
        livePreferredOwnerFirstCreatorAutonomous: latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreatorAutonomous === true,
        livePreferredOwnerFirstCreatorMatchedPreferredOwner: latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreatorMatchedPreferredOwner === true,
        livePreferredOwnerWonFirstEligibleCycle: latestPreferredOwnerProofFromRun.livePreferredOwnerWonFirstEligibleCycle === true,
        livePreferredOwnerFirstCreationTimestamp: toText(
          latestPreferredOwnerProofFromRun.livePreferredOwnerFirstCreationTimestamp || ''
        ) || null,
        livePreferredOwnerCreationCheckpointStatus: latestPreferredOwnerProofFromRun.livePreferredOwnerCreationCheckpointStatus
          ? normalizeCheckpointStatus(latestPreferredOwnerProofFromRun.livePreferredOwnerCreationCheckpointStatus)
          : null,
        livePreferredOwnerCreationAttemptResult: latestPreferredOwnerProofFromRun.livePreferredOwnerCreationAttemptResult
          ? normalizeLiveAutonomousAttemptResult(latestPreferredOwnerProofFromRun.livePreferredOwnerCreationAttemptResult)
          : null,
        livePreferredOwnerCreationProofOutcome: latestPreferredOwnerProofFromRun.livePreferredOwnerCreationProofOutcome
          ? normalizeLiveAutonomousProofOutcome(latestPreferredOwnerProofFromRun.livePreferredOwnerCreationProofOutcome)
          : null,
        livePreferredOwnerCreationOwnershipOutcome: latestPreferredOwnerProofFromRun.livePreferredOwnerCreationOwnershipOutcome
          ? normalizeLiveInsertionOwnershipOutcome(latestPreferredOwnerProofFromRun.livePreferredOwnerCreationOwnershipOutcome)
          : null,
        livePreferredOwnerCreationOwnershipSourceSpecificOutcome: latestPreferredOwnerProofFromRun.livePreferredOwnerCreationOwnershipSourceSpecificOutcome
          ? normalizeLiveInsertionOwnershipSourceSpecificOutcome(
            latestPreferredOwnerProofFromRun.livePreferredOwnerCreationOwnershipSourceSpecificOutcome
          )
          : null,
        advisoryOnly: true,
      }
      : buildLivePreferredOwnerProof({
        db,
        runId: Number(latestRun?.id || 0) || null,
        runMode: latestRun?.mode || 'auto',
        liveCheckpoint: statusLiveCheckpoint,
        liveInsertionOwnership: statusLiveInsertionOwnership,
        liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
        liveAutonomousAttemptTransition: statusLiveAutonomousAttemptTransition,
        liveAutonomousProof: statusLiveAutonomousProof,
      })
  );
  const statusLivePreferredOwnerMetrics = buildLivePreferredOwnerMetrics({
    db,
    livePreferredOwnerProof: statusLivePreferredOwnerProof,
    liveInsertionSla: statusLiveInsertionSla,
    legacyMetrics: latestPreferredOwnerMetricsFromRun,
  });
  const statusLivePreferredOwnerReservation = (
    latestPreferredOwnerReservationFromRun && Object.keys(latestPreferredOwnerReservationFromRun).length > 0
      ? {
        livePreferredOwnerReservationTargetTradingDay: normalizeDate(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationTargetTradingDay
          || statusLiveCheckpoint.targetTradingDay
          || ''
        ) || null,
        livePreferredOwnerReservationExpectedSource: normalizeFinalizationSweepSource(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationExpectedSource
          || 'close_complete_checkpoint'
        ),
        livePreferredOwnerReservationActive: latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationActive === true,
        livePreferredOwnerReservationWindowOpenedAt: toText(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationWindowOpenedAt || ''
        ) || null,
        livePreferredOwnerReservationWindowExpiresAt: toText(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationWindowExpiresAt || ''
        ) || null,
        livePreferredOwnerReservationState: normalizeLivePreferredOwnerReservationState(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationState
        ),
        livePreferredOwnerReservationBlockedSource: latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationBlockedSource
          ? normalizeFinalizationSweepSource(latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationBlockedSource)
          : null,
        livePreferredOwnerReservationBlockReason: normalizeLivePreferredOwnerReservationBlockReason(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationBlockReason
        ),
        livePreferredOwnerReservationReleasedAt: toText(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationReleasedAt || ''
        ) || null,
        livePreferredOwnerDeferredFallbackSource: latestPreferredOwnerReservationFromRun.livePreferredOwnerDeferredFallbackSource
          ? normalizeFinalizationSweepSource(latestPreferredOwnerReservationFromRun.livePreferredOwnerDeferredFallbackSource)
          : null,
        livePreferredOwnerDeferredFallbackReason: latestPreferredOwnerReservationFromRun.livePreferredOwnerDeferredFallbackReason
          ? normalizeLivePreferredOwnerReservationBlockReason(latestPreferredOwnerReservationFromRun.livePreferredOwnerDeferredFallbackReason)
          : null,
        livePreferredOwnerDeferredFallbackAt: toText(
          latestPreferredOwnerReservationFromRun.livePreferredOwnerDeferredFallbackAt || ''
        ) || null,
        livePreferredOwnerReservationShouldBlockCurrentSource: (
          latestPreferredOwnerReservationFromRun.livePreferredOwnerReservationShouldBlockCurrentSource === true
        ),
        advisoryOnly: true,
      }
      : buildLivePreferredOwnerReservation({
        db,
        nowDate: statusRunDate,
        nowTime: '00:00',
        mode: latestRun?.mode || 'auto',
        sweepSource: statusLiveCheckpoint.runtimeCheckpointSource
          || statusLiveCheckpoint.sweepSource
          || latestRun?.details?.liveFinalizationSweepSource
          || 'manual_api_run',
        targetTradingDay: statusLiveCheckpoint.targetTradingDay
          || statusLiveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
          || null,
        liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRightWithExecution,
        liveCheckpoint: statusLiveCheckpoint,
        liveInsertionOwnership: statusLiveInsertionOwnership,
        livePreferredOwnerProof: statusLivePreferredOwnerProof,
        sessions: input.sessions && typeof input.sessions === 'object' ? input.sessions : {},
        finalizationOnly: false,
      })
  );
  const statusRunDerivedPreferredOwnerPostCloseProofVerifier = (() => {
    if (
      !latestPreferredOwnerPostCloseVerifierFromRun
      || Object.keys(latestPreferredOwnerPostCloseVerifierFromRun).length === 0
    ) {
      return null;
    }
    const targetTradingDay = normalizeDate(
      latestPreferredOwnerPostCloseVerifierFromRun.targetTradingDay
      || latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofVerifierTargetTradingDay
      || ''
    ) || null;
    if (!targetTradingDay) return null;
    const failureReasons = Array.isArray(
      latestPreferredOwnerPostCloseVerifierFromRun.failureReasons
        || latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofVerifierFailureReasons
    )
      ? (latestPreferredOwnerPostCloseVerifierFromRun.failureReasons
        || latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofVerifierFailureReasons)
      : [];
    return {
      targetTradingDay,
      runId: Number(
        latestPreferredOwnerPostCloseVerifierFromRun.runId
        || latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofVerifierRunId
        || 0
      ) || null,
      runOrigin: normalizeDailyScoringRunOrigin(
        latestPreferredOwnerPostCloseVerifierFromRun.runOrigin || 'manual'
      ),
      runtimeSource: normalizeFinalizationSweepSource(
        latestPreferredOwnerPostCloseVerifierFromRun.runtimeSource || 'manual_api_run'
      ),
      checkpointStatus: normalizeCheckpointStatus(
        latestPreferredOwnerPostCloseVerifierFromRun.checkpointStatus || 'waiting_valid'
      ),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(
        latestPreferredOwnerPostCloseVerifierFromRun.verifierStatus || 'fail'
      ),
      verifierPass: latestPreferredOwnerPostCloseVerifierFromRun.verifierPass === true,
      failureReasons: failureReasons
        .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
        .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx),
      summary: latestPreferredOwnerPostCloseVerifierFromRun.summary
        && typeof latestPreferredOwnerPostCloseVerifierFromRun.summary === 'object'
        ? latestPreferredOwnerPostCloseVerifierFromRun.summary
        : {},
      verifiedAt: toText(
        latestPreferredOwnerPostCloseVerifierFromRun.verifiedAt
        || latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofVerifierVerifiedAt
        || ''
      ) || null,
      livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
        latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofVerifierRunOrigin
        || latestPreferredOwnerPostCloseVerifierFromRun.runOrigin
        || 'manual'
      ),
      livePreferredOwnerPostCloseProofResolvedNaturally: (
        latestPreferredOwnerPostCloseVerifierFromRun.livePreferredOwnerPostCloseProofResolvedNaturally === true
      ),
      verifierPersistedThisRun: latestPreferredOwnerPostCloseVerifierFromRun.verifierPersistedThisRun === true,
      advisoryOnly: true,
    };
  })();
  const statusCanonicalPreferredOwnerVerifierTargetDay = normalizeDate(
    statusPreferredOwnerOperationalProofBundleFromTable?.targetTradingDay
    || statusPreferredOwnerOperationalVerdictFromTable?.targetTradingDay
    || statusLivePreferredOwnerProof.livePreferredOwnerTargetTradingDay
    || statusLiveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
    || statusLiveCheckpoint.targetTradingDay
    || statusRunDerivedPreferredOwnerPostCloseProofVerifier?.targetTradingDay
    || ''
  ) || null;
  const statusCanonicalPreferredOwnerVerifierRow = statusCanonicalPreferredOwnerVerifierTargetDay
    ? readPreferredOwnerPostCloseProofVerifierRowByTargetDay(
      db,
      statusCanonicalPreferredOwnerVerifierTargetDay
    )
    : null;
  const statusRunTargetPreferredOwnerVerifierRow = (
    !statusCanonicalPreferredOwnerVerifierRow
    && statusRunDerivedPreferredOwnerPostCloseProofVerifier?.targetTradingDay
  )
    ? readPreferredOwnerPostCloseProofVerifierRowByTargetDay(
      db,
      statusRunDerivedPreferredOwnerPostCloseProofVerifier.targetTradingDay
    )
    : null;
  let statusLivePreferredOwnerPostCloseProofVerifier = (
    statusCanonicalPreferredOwnerVerifierRow
    || statusRunTargetPreferredOwnerVerifierRow
    || statusRunDerivedPreferredOwnerPostCloseProofVerifier
    || readLatestPreferredOwnerPostCloseProofVerifierRow(db)
    || null
  );
  if (!statusLivePreferredOwnerPostCloseProofVerifier) {
    const fallbackTargetDay = normalizeDate(
      statusLivePreferredOwnerProof.livePreferredOwnerTargetTradingDay
      || statusLiveCheckpoint.targetTradingDay
      || statusLiveInsertionOwnership.liveInsertionOwnershipTargetTradingDay
      || ''
    ) || null;
    const fallbackReasons = [];
    if (!fallbackTargetDay) fallbackReasons.push('target_day_mismatch');
    else if (normalizeCheckpointStatus(statusLiveCheckpoint.checkpointStatus || 'waiting_valid') === 'waiting_valid') {
      fallbackReasons.push('checkpoint_not_resolved');
    } else {
      fallbackReasons.push('proof_row_missing');
    }
    statusLivePreferredOwnerPostCloseProofVerifier = {
      targetTradingDay: fallbackTargetDay,
      runId: Number(latestRun?.id || 0) || null,
      runOrigin: normalizeDailyScoringRunOrigin(latestRun?.runOrigin || latestRun?.details?.runOrigin || 'manual'),
      runtimeSource: normalizeFinalizationSweepSource(
        statusLiveCheckpoint.runtimeCheckpointSource
        || statusLiveCheckpoint.sweepSource
        || 'manual_api_run'
      ),
      checkpointStatus: normalizeCheckpointStatus(statusLiveCheckpoint.checkpointStatus || 'waiting_valid'),
      verifierStatus: 'fail',
      verifierPass: false,
      failureReasons: fallbackReasons
        .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
        .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx),
      summary: {
        targetTradingDay: fallbackTargetDay,
        runId: Number(latestRun?.id || 0) || null,
        runOrigin: normalizeDailyScoringRunOrigin(latestRun?.runOrigin || latestRun?.details?.runOrigin || 'manual'),
        runtimeSource: normalizeFinalizationSweepSource(
          statusLiveCheckpoint.runtimeCheckpointSource
          || statusLiveCheckpoint.sweepSource
          || 'manual_api_run'
        ),
        checkpointStatus: normalizeCheckpointStatus(statusLiveCheckpoint.checkpointStatus || 'waiting_valid'),
        advisoryOnly: true,
      },
      verifiedAt: toText(latestRun?.createdAt || '') || new Date().toISOString(),
      livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
        latestRun?.runOrigin || latestRun?.details?.runOrigin || 'manual'
      ),
      livePreferredOwnerPostCloseProofResolvedNaturally: false,
      verifierPersistedThisRun: false,
      advisoryOnly: true,
    };
  }
  const statusLivePreferredOwnerLatestOperationalVerdict = (() => {
    const fromTable = statusPreferredOwnerOperationalVerdictFromTable
      && typeof statusPreferredOwnerOperationalVerdictFromTable === 'object'
      ? statusPreferredOwnerOperationalVerdictFromTable
      : null;
    if (fromTable) return fromTable;
    const fromRun = (
      latestPreferredOwnerOperationalVerdictFromRun
      && typeof latestPreferredOwnerOperationalVerdictFromRun === 'object'
      && Object.keys(latestPreferredOwnerOperationalVerdictFromRun).length > 0
    )
      ? latestPreferredOwnerOperationalVerdictFromRun
      : null;
    if (!fromRun) return null;
    const failureReasons = Array.isArray(fromRun.verifierFailureReasons)
      ? fromRun.verifierFailureReasons
      : (Array.isArray(fromRun.livePreferredOwnerLatestOperationalVerdictReasons)
        ? fromRun.livePreferredOwnerLatestOperationalVerdictReasons
        : []);
    return {
      id: Number(fromRun.id || 0) || null,
      targetTradingDay: normalizeDate(
        fromRun.targetTradingDay
        || fromRun.livePreferredOwnerLatestOperationalVerdictTargetTradingDay
        || ''
      ) || null,
      runId: Number(fromRun.runId || 0) || null,
      runOrigin: normalizeDailyScoringRunOrigin(
        fromRun.runOrigin
        || fromRun.livePreferredOwnerLatestOperationalVerdictRunOrigin
        || 'manual'
      ),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(
        fromRun.runtimeCheckpointSource
        || fromRun.livePreferredOwnerLatestOperationalVerdictRuntimeSource
        || 'manual_api_run'
      ),
      checkpointStatus: normalizeCheckpointStatus(fromRun.checkpointStatus || 'waiting_valid'),
      preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
        fromRun.preferredOwnerExpectedSource || 'close_complete_checkpoint'
      ),
      preferredOwnerActualSource: fromRun.preferredOwnerActualSource
        ? normalizeFinalizationSweepSource(fromRun.preferredOwnerActualSource)
        : null,
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(
        fromRun.verifierStatus
        || fromRun.livePreferredOwnerLatestOperationalVerdictStatus
        || 'fail'
      ),
      verifierPass: (
        fromRun.verifierPass === true
        || fromRun.livePreferredOwnerLatestOperationalVerdictPass === true
      ),
      verifierFailureReasons: failureReasons
        .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
        .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx),
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        fromRun.ownershipSourceSpecificOutcome || 'ownership_source_unknown'
      ),
      naturalPreferredOwnerWinsLast5d: Number(fromRun.naturalPreferredOwnerWinsLast5d || 0),
      naturalPreferredOwnerWinsTotal: Number(fromRun.naturalPreferredOwnerWinsTotal || 0),
      naturalPreferredOwnerVerifierPassesLast5d: Number(fromRun.naturalPreferredOwnerVerifierPassesLast5d || 0),
      naturalPreferredOwnerVerifierFailsLast5d: Number(fromRun.naturalPreferredOwnerVerifierFailsLast5d || 0),
      reportedAt: toText(
        fromRun.reportedAt
        || fromRun.livePreferredOwnerLatestOperationalVerdictReportedAt
        || ''
      ) || null,
      advisoryOnly: true,
    };
  })();
  const statusLivePreferredOwnerOperationalProofBundle = (() => {
    const fromTable = statusPreferredOwnerOperationalProofBundleFromTable
      && typeof statusPreferredOwnerOperationalProofBundleFromTable === 'object'
      ? statusPreferredOwnerOperationalProofBundleFromTable
      : null;
    if (fromTable) return fromTable;
    const fromRun = (
      latestPreferredOwnerOperationalProofBundleFromRun
      && typeof latestPreferredOwnerOperationalProofBundleFromRun === 'object'
      && Object.keys(latestPreferredOwnerOperationalProofBundleFromRun).length > 0
    )
      ? latestPreferredOwnerOperationalProofBundleFromRun
      : null;
    if (!fromRun) return null;
    const verifierFailureReasons = Array.isArray(fromRun.verifierFailureReasons)
      ? fromRun.verifierFailureReasons
      : (Array.isArray(fromRun.livePreferredOwnerOperationalProofBundleVerifierFailureReasons)
        ? fromRun.livePreferredOwnerOperationalProofBundleVerifierFailureReasons
        : []);
    return {
      id: Number(fromRun.id || 0) || null,
      targetTradingDay: normalizeDate(
        fromRun.targetTradingDay
        || fromRun.livePreferredOwnerOperationalProofBundleTargetTradingDay
        || ''
      ) || null,
      runId: Number(
        fromRun.runId
        || fromRun.livePreferredOwnerOperationalProofBundleRunId
        || 0
      ) || null,
      runOrigin: normalizeDailyScoringRunOrigin(
        fromRun.runOrigin
        || fromRun.livePreferredOwnerOperationalProofBundleRunOrigin
        || 'manual'
      ),
      checkpointStatus: normalizeCheckpointStatus(
        fromRun.checkpointStatus
        || fromRun.livePreferredOwnerOperationalProofBundleCheckpointStatus
        || 'waiting_valid'
      ),
      checkpointReason: normalizeCheckpointReason(
        fromRun.checkpointReason
        || fromRun.livePreferredOwnerOperationalProofBundleCheckpointReason
        || 'unknown_checkpoint_state'
      ),
      runtimeCheckpointSource: normalizeFinalizationSweepSource(
        fromRun.runtimeCheckpointSource
        || fromRun.livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource
        || 'manual_api_run'
      ),
      preferredOwnerExpectedSource: normalizeFinalizationSweepSource(
        fromRun.preferredOwnerExpectedSource
        || fromRun.livePreferredOwnerOperationalProofBundlePreferredOwnerExpectedSource
        || 'close_complete_checkpoint'
      ),
      preferredOwnerActualSource: (
        fromRun.preferredOwnerActualSource
        || fromRun.livePreferredOwnerOperationalProofBundlePreferredOwnerActualSource
        || null
      ),
      preferredOwnerWon: (
        fromRun.preferredOwnerWon === true
        || fromRun.livePreferredOwnerOperationalProofBundlePreferredOwnerWon === true
      ),
      preferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
        fromRun.preferredOwnerFailureReason
        || fromRun.livePreferredOwnerOperationalProofBundlePreferredOwnerFailureReason
        || 'none'
      ),
      ownershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
        fromRun.ownershipSourceSpecificOutcome
        || fromRun.livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome
        || 'ownership_source_unknown'
      ),
      verifierStatus: normalizePreferredOwnerPostCloseProofStatus(
        fromRun.verifierStatus
        || fromRun.livePreferredOwnerOperationalProofBundleVerifierStatus
        || 'fail'
      ),
      verifierPass: (
        fromRun.verifierPass === true
        || fromRun.livePreferredOwnerOperationalProofBundleVerifierPass === true
      ),
      verifierFailureReasons: verifierFailureReasons
        .map((reason) => normalizePreferredOwnerPostCloseProofFailReason(reason))
        .filter((reason, idx, arr) => !!reason && reason !== 'none' && arr.indexOf(reason) === idx),
      naturalPreferredOwnerWinsLast5d: Number(
        fromRun.naturalPreferredOwnerWinsLast5d
        || fromRun.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d
        || 0
      ),
      naturalPreferredOwnerWinsTotal: Number(
        fromRun.naturalPreferredOwnerWinsTotal
        || fromRun.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal
        || 0
      ),
      naturalPreferredOwnerVerifierPassesLast5d: Number(
        fromRun.naturalPreferredOwnerVerifierPassesLast5d
        || fromRun.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierPassesLast5d
        || 0
      ),
      naturalPreferredOwnerVerifierFailsLast5d: Number(
        fromRun.naturalPreferredOwnerVerifierFailsLast5d
        || fromRun.livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierFailsLast5d
        || 0
      ),
      capturedAt: toText(
        fromRun.capturedAt
        || fromRun.livePreferredOwnerOperationalProofBundleCapturedAt
        || ''
      ) || null,
      advisoryOnly: true,
    };
  })();
  const statusLivePreferredOwnerNaturalDrillWatcher = (() => {
    const targetTradingDay = normalizeDate(
      statusLiveCheckpoint.targetTradingDay
      || statusLivePreferredOwnerPostCloseProofVerifier?.targetTradingDay
      || statusLivePreferredOwnerProof?.livePreferredOwnerTargetTradingDay
      || ''
    ) || null;
    const checkpointStatus = normalizeCheckpointStatus(statusLiveCheckpoint.checkpointStatus || 'waiting_valid');
    const runtimeSource = normalizeFinalizationSweepSource(
      statusLiveCheckpoint.runtimeCheckpointSource
      || statusLiveCheckpoint.sweepSource
      || 'manual_api_run'
    );
    const runOrigin = normalizeDailyScoringRunOrigin(
      latestRun?.runOrigin
      || latestRun?.details?.runOrigin
      || 'manual'
    );
    const targetRow = targetTradingDay
      ? readPreferredOwnerNaturalDrillWatchRunRowByTargetDay(db, targetTradingDay)
      : null;
    const latestRow = readLatestPreferredOwnerNaturalDrillWatchRunRow(db);
    const row = targetRow || null;
    if (row && row.targetTradingDay === targetTradingDay) {
      return {
        livePreferredOwnerNaturalDrillWatcherStatus: 'already_executed_for_target_day',
        livePreferredOwnerNaturalDrillWatcherTargetTradingDay: row.targetTradingDay,
        livePreferredOwnerNaturalDrillWatcherExecuted: row.executed === true,
        livePreferredOwnerNaturalDrillWatcherExecutedAt: row.executedAt || row.createdAt || null,
        livePreferredOwnerNaturalDrillWatcherOutcome: 'already_executed_for_target_day',
        livePreferredOwnerNaturalDrillWatcherRow: row,
        advisoryOnly: true,
      };
    }
    let status = 'waiting_for_resolution';
    if (runOrigin === 'natural' && checkpointStatus !== 'waiting_valid') {
      if (runtimeSource !== 'close_complete_checkpoint') {
        status = 'resolved_but_not_close_complete_source';
      } else {
        status = 'resolved_but_drill_failed';
      }
    }
    return {
      livePreferredOwnerNaturalDrillWatcherStatus: normalizePreferredOwnerNaturalDrillWatcherOutcome(status),
      livePreferredOwnerNaturalDrillWatcherTargetTradingDay: targetTradingDay
        || latestRow?.targetTradingDay
        || null,
      livePreferredOwnerNaturalDrillWatcherExecuted: false,
      livePreferredOwnerNaturalDrillWatcherExecutedAt: null,
      livePreferredOwnerNaturalDrillWatcherOutcome: normalizePreferredOwnerNaturalDrillWatcherOutcome(status),
      livePreferredOwnerNaturalDrillWatcherRow: row || latestRow || null,
      advisoryOnly: true,
    };
  })();
  const statusLivePreferredOwnerMonitor = buildPreferredOwnerMonitorSummary({
    db,
    nowDate: (
      normalizeDate(input.nowDate || '')
      || normalizeDate(latestRun?.runDate || '')
      || normalizeDate(new Date().toISOString())
    ),
  });
  const statusLivePreferredOwnerOperatorSnapshot = (
    statusLivePreferredOwnerMonitor?.livePreferredOwnerOperatorSnapshot
    && typeof statusLivePreferredOwnerMonitor.livePreferredOwnerOperatorSnapshot === 'object'
  )
    ? { ...statusLivePreferredOwnerMonitor.livePreferredOwnerOperatorSnapshot }
    : buildPreferredOwnerOperatorSnapshot({
      db,
      nowDate: (
        normalizeDate(input.nowDate || '')
        || normalizeDate(latestRun?.runDate || '')
        || normalizeDate(new Date().toISOString())
      ),
    });
  const statusNextNaturalDayWatchdog = runNextNaturalDayReadinessWatchdogMonitor({
    db,
    baselineDate: normalizeDate(input.nextNaturalDayBaselineDate || input.baselineDate || '2026-03-13') || '2026-03-13',
    nowTs: new Date().toISOString(),
  });
  const statusNextNaturalDayTerminalStatus = buildNextNaturalDayTerminalStatus(
    statusNextNaturalDayWatchdog,
    normalizeDate(input.nextNaturalDayBaselineDate || input.baselineDate || '2026-03-13') || '2026-03-13'
  );
  return {
    generatedAt: new Date().toISOString(),
    latestRun,
    recentRuns,
    runOrigin: normalizeDailyScoringRunOrigin(latestRun?.runOrigin || latestRun?.details?.runOrigin || 'manual'),
    liveOutcomeFinalization: {
      contextsConsidered: Number(latestFinalization.contextsConsidered || latestLive.contextsSeen || 0),
      pendingLiveContextsCount: Number(latestFinalization.pendingLiveContextsCount || 0),
      finalizedInsertedCount: Number(latestFinalization.finalizedInsertedCount || 0),
      finalizedUpdatedCount: Number(latestFinalization.finalizedUpdatedCount || 0),
      finalizedTodayCount: Number(latestFinalization.finalizedTodayCount || latestFinalization.finalizedInsertedCount || 0),
      alreadyFinalizedCount: Number(latestFinalization.alreadyFinalizedCount || 0),
      waitingCount: Number(latestFinalization.waitingCount || 0),
      blockedCount: Number(latestFinalization.blockedCount || 0),
      topWaitingReason: toText(latestFinalization.topWaitingReason || '') || null,
      topBlockedReason: toText(latestFinalization.topBlockedReason || '') || null,
      latestPendingLiveDates: latestPendingFinalizationDates,
      latestReadyButUninsertedDates,
      latestWaitingDates,
      latestBlockedDates,
      finalizationReasonBuckets: latestFinalization.reasonBuckets || {},
      readinessStateBuckets: latestFinalization.readinessStateBuckets || {},
      tradingDayClassificationBuckets: latestFinalization.tradingDayClassificationBuckets || {},
      finalizationSweepSourceBuckets,
      latestSweepSource: normalizeFinalizationSweepSource(
        latestFinalization.sweepSource
        || latestRun?.details?.liveFinalizationSweepSource
        || ''
      ),
      waitingReasonBuckets: latestFinalization.waitingReasonBuckets || {},
      blockedReasonBuckets: latestFinalization.blockedReasonBuckets || {},
      validLiveDaysSeen: Number(latestFinalization.validLiveDaysSeen || 0),
      validLiveDaysReadyToFinalize: Number(latestFinalization.validLiveDaysReadyToFinalize || 0),
      validLiveDaysFinalizedInserted: Number(latestFinalization.validLiveDaysFinalizedInserted || 0),
      validLiveDaysFinalizedUpdated: Number(latestFinalization.validLiveDaysFinalizedUpdated || 0),
      validLiveDaysStillWaiting: Number(latestFinalization.validLiveDaysStillWaiting || 0),
      validLiveDaysBlocked: Number(latestFinalization.validLiveDaysBlocked || 0),
      validLiveDaysMissedByScheduler: Number(latestFinalization.validLiveDaysMissedByScheduler || latestRun?.details?.validLiveDaysMissedByScheduler || 0),
      liveCheckpoint: statusLiveCheckpoint,
      missedValidCheckpointDaysCount,
      latestMissedCheckpointDates,
      latestCheckpointFailures,
      invalidLiveContextsCreatedToday: Number(latestLiveContextAudit.invalidLiveContextsCreatedToday || 0),
      invalidLiveContextsSuppressedToday: Number(latestLiveContextAudit.invalidLiveContextsSuppressedToday || 0),
      latestInvalidLiveContextDates: Array.isArray(latestLiveContextAudit.latestInvalidLiveContextDates)
        ? latestLiveContextAudit.latestInvalidLiveContextDates.slice(0, 12)
        : [],
      automaticFinalizationHealthy: latestFinalization.automaticFinalizationHealthy === true,
      netNewLiveRows: {
        oneDay: Number(statusNetNewLiveRows.oneDay || 0),
        threeDay: Number(statusNetNewLiveRows.threeDay || 0),
        sevenDay: Number(statusNetNewLiveRows.sevenDay || 0),
      },
      liveInsertionSla: statusLiveInsertionSla,
      liveInsertionGrowth: statusLiveInsertionGrowth,
      liveInsertionOwnership: statusLiveInsertionOwnership,
      liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
      liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
      liveAutonomousAttemptTransition: statusLiveAutonomousAttemptTransition,
      liveAutonomousProof: statusLiveAutonomousProof,
      liveAutonomousInsertionMetrics: statusLiveAutonomousInsertionMetrics,
      livePreferredOwnerProof: statusLivePreferredOwnerProof,
      livePreferredOwnerMetrics: statusLivePreferredOwnerMetrics,
      livePreferredOwnerNaturalWinMetrics: statusPreferredOwnerNaturalWinMetrics,
      livePreferredOwnerPostCloseProofVerifier: statusLivePreferredOwnerPostCloseProofVerifier,
      livePreferredOwnerLatestOperationalVerdict: statusLivePreferredOwnerLatestOperationalVerdict,
      livePreferredOwnerOperationalProofBundle: statusLivePreferredOwnerOperationalProofBundle,
      livePreferredOwnerNaturalDrillWatcher: statusLivePreferredOwnerNaturalDrillWatcher,
      livePreferredOwnerMonitor: statusLivePreferredOwnerMonitor,
      liveNextNaturalDayWatchdog: statusNextNaturalDayWatchdog,
      liveNextNaturalDayTerminalStatus: statusNextNaturalDayTerminalStatus,
      livePreferredOwnerReservation: statusLivePreferredOwnerReservation,
      liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRightWithExecution,
      liveOwnershipConsistencyOk: statusLiveOwnershipConsistencyOk,
      advisoryOnly: true,
    },
    liveDayConversion: {
      liveContextsSeen: Number(latestLive.contextsSeen || 0),
      liveContextsEligibleForScoring: Number(latestLive.contextsEligibleForScoring || 0),
      liveContextsScored: Number(latestLive.contextsScored || 0),
      liveRowsInserted: Number(latestLive.rowsInserted || 0),
      liveRowsUpdated: Number(latestLive.rowsUpdated || 0),
      liveContextsSkipped: Number(latestLive.contextsSkipped || 0),
      liveContextsFreshInserted: Number(latestLive.contextsFreshInserted || 0),
      liveContextsUpdatedOnly: Number(latestLive.contextsUpdatedOnly || 0),
      liveContextsBlocked: Number(latestLive.contextsBlocked || 0),
      liveTopSkipReason: toText(latestLive.topSkipReason || '') || null,
      liveTopBlockedReason: toText(latestLive.topBlockedReason || '') || null,
      liveEligibilityReasonBuckets: latestLive.reasonBuckets || {},
      liveBlockedReasonBuckets: latestLive.blockedReasonBuckets || {},
      latestLiveContextsWithoutFreshInsertDates: latestWithoutFreshInsertDates,
      latestReadyButUninsertedDates,
      latestWaitingDates,
      latestBlockedDates,
      validLiveDaysSeen: Number(latestFinalization.validLiveDaysSeen || 0),
      validLiveDaysReadyToFinalize: Number(latestFinalization.validLiveDaysReadyToFinalize || 0),
      validLiveDaysFinalizedInserted: Number(latestFinalization.validLiveDaysFinalizedInserted || 0),
      validLiveDaysFinalizedUpdated: Number(latestFinalization.validLiveDaysFinalizedUpdated || 0),
      validLiveDaysStillWaiting: Number(latestFinalization.validLiveDaysStillWaiting || 0),
      validLiveDaysBlocked: Number(latestFinalization.validLiveDaysBlocked || 0),
      validLiveDaysMissedByScheduler: Number(latestFinalization.validLiveDaysMissedByScheduler || latestRun?.details?.validLiveDaysMissedByScheduler || 0),
      liveCheckpoint: statusLiveCheckpoint,
      missedValidCheckpointDaysCount,
      latestMissedCheckpointDates,
      latestCheckpointFailures,
      liveInsertionSla: statusLiveInsertionSla,
      liveInsertionGrowth: statusLiveInsertionGrowth,
      liveInsertionOwnership: statusLiveInsertionOwnership,
      liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
      liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
      liveAutonomousAttemptTransition: statusLiveAutonomousAttemptTransition,
      liveAutonomousProof: statusLiveAutonomousProof,
      liveAutonomousInsertionMetrics: statusLiveAutonomousInsertionMetrics,
      livePreferredOwnerProof: statusLivePreferredOwnerProof,
      livePreferredOwnerMetrics: statusLivePreferredOwnerMetrics,
      livePreferredOwnerNaturalWinMetrics: statusPreferredOwnerNaturalWinMetrics,
      livePreferredOwnerPostCloseProofVerifier: statusLivePreferredOwnerPostCloseProofVerifier,
      livePreferredOwnerLatestOperationalVerdict: statusLivePreferredOwnerLatestOperationalVerdict,
      livePreferredOwnerOperationalProofBundle: statusLivePreferredOwnerOperationalProofBundle,
      livePreferredOwnerNaturalDrillWatcher: statusLivePreferredOwnerNaturalDrillWatcher,
      livePreferredOwnerMonitor: statusLivePreferredOwnerMonitor,
      liveNextNaturalDayWatchdog: statusNextNaturalDayWatchdog,
      liveNextNaturalDayTerminalStatus: statusNextNaturalDayTerminalStatus,
      livePreferredOwnerReservation: statusLivePreferredOwnerReservation,
      liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRightWithExecution,
      liveOwnershipConsistencyOk: statusLiveOwnershipConsistencyOk,
      invalidLiveContextsCreatedToday: Number(latestLiveContextAudit.invalidLiveContextsCreatedToday || 0),
      invalidLiveContextsSuppressedToday: Number(latestLiveContextAudit.invalidLiveContextsSuppressedToday || 0),
      latestInvalidLiveContextDates: Array.isArray(latestLiveContextAudit.latestInvalidLiveContextDates)
        ? latestLiveContextAudit.latestInvalidLiveContextDates.slice(0, 12)
        : [],
      advisoryOnly: true,
    },
    liveEvidenceGeneration: {
      runDate: latestRun?.runDate || null,
      runOrigin: normalizeDailyScoringRunOrigin(latestRun?.runOrigin || latestRun?.details?.runOrigin || 'manual'),
      status: latestRun?.status || 'noop',
      liveContextsSeen: Number(latestLive.contextsSeen || 0),
      liveContextsEligibleForScoring: Number(latestLive.contextsEligibleForScoring || 0),
      liveContextsScored: Number(latestLive.contextsScored || 0),
      liveRowsInserted: Number(latestLive.rowsInserted || 0),
      liveRowsUpdated: Number(latestLive.rowsUpdated || 0),
      liveContextsSkipped: Number(latestLive.contextsSkipped || 0),
      liveSkipReasonBuckets: latestLive.skipReasonBuckets || {},
      liveTopSkipReason: toText(latestLive.topSkipReason || '') || null,
      liveEligibilityReasonBuckets: latestLive.reasonBuckets || {},
      liveBlockedReasonBuckets: latestLive.blockedReasonBuckets || {},
      liveTopBlockedReason: toText(latestLive.topBlockedReason || '') || null,
      liveContextsFreshInserted: Number(latestLive.contextsFreshInserted || 0),
      liveContextsUpdatedOnly: Number(latestLive.contextsUpdatedOnly || 0),
      liveContextsBlocked: Number(latestLive.contextsBlocked || 0),
      liveBridgeLookbackDays: Number(latestLive.bridgeLookbackDays || 0),
      latestLiveContextsWithoutFreshInsertDates: latestWithoutFreshInsertDates,
      latestReadyButUninsertedDates,
      latestWaitingDates,
      latestBlockedDates,
      validLiveDaysSeen: Number(latestFinalization.validLiveDaysSeen || 0),
      validLiveDaysReadyToFinalize: Number(latestFinalization.validLiveDaysReadyToFinalize || 0),
      validLiveDaysFinalizedInserted: Number(latestFinalization.validLiveDaysFinalizedInserted || 0),
      validLiveDaysFinalizedUpdated: Number(latestFinalization.validLiveDaysFinalizedUpdated || 0),
      validLiveDaysStillWaiting: Number(latestFinalization.validLiveDaysStillWaiting || 0),
      validLiveDaysBlocked: Number(latestFinalization.validLiveDaysBlocked || 0),
      validLiveDaysMissedByScheduler: Number(latestFinalization.validLiveDaysMissedByScheduler || latestRun?.details?.validLiveDaysMissedByScheduler || 0),
      liveCheckpoint: statusLiveCheckpoint,
      missedValidCheckpointDaysCount,
      latestMissedCheckpointDates,
      latestCheckpointFailures,
      liveFinalizationSweepSource: normalizeFinalizationSweepSource(
        latestFinalization.sweepSource
        || latestRun?.details?.liveFinalizationSweepSource
        || ''
      ),
      invalidLiveContextsCreatedToday: Number(latestLiveContextAudit.invalidLiveContextsCreatedToday || 0),
      invalidLiveContextsSuppressedToday: Number(latestLiveContextAudit.invalidLiveContextsSuppressedToday || 0),
      latestInvalidLiveContextDates: Array.isArray(latestLiveContextAudit.latestInvalidLiveContextDates)
        ? latestLiveContextAudit.latestInvalidLiveContextDates.slice(0, 12)
        : [],
      readinessStateBuckets: latestFinalization.readinessStateBuckets || {},
      tradingDayClassificationBuckets: latestFinalization.tradingDayClassificationBuckets || {},
      netNewLiveRows1d: Number(statusNetNewLiveRows.oneDay || 0),
      netNewLiveRows3d: Number(statusNetNewLiveRows.threeDay || 0),
      netNewLiveRows7d: Number(statusNetNewLiveRows.sevenDay || 0),
      liveInsertionSla: statusLiveInsertionSla,
      liveInsertionGrowth: statusLiveInsertionGrowth,
      liveInsertionOwnership: statusLiveInsertionOwnership,
      liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
      liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
      liveAutonomousAttemptTransition: statusLiveAutonomousAttemptTransition,
      liveAutonomousProof: statusLiveAutonomousProof,
      liveAutonomousInsertionMetrics: statusLiveAutonomousInsertionMetrics,
      livePreferredOwnerProof: statusLivePreferredOwnerProof,
      livePreferredOwnerMetrics: statusLivePreferredOwnerMetrics,
      livePreferredOwnerNaturalWinMetrics: statusPreferredOwnerNaturalWinMetrics,
      livePreferredOwnerPostCloseProofVerifier: statusLivePreferredOwnerPostCloseProofVerifier,
      livePreferredOwnerLatestOperationalVerdict: statusLivePreferredOwnerLatestOperationalVerdict,
      livePreferredOwnerOperationalProofBundle: statusLivePreferredOwnerOperationalProofBundle,
      livePreferredOwnerNaturalDrillWatcher: statusLivePreferredOwnerNaturalDrillWatcher,
      livePreferredOwnerMonitor: statusLivePreferredOwnerMonitor,
      liveNextNaturalDayWatchdog: statusNextNaturalDayWatchdog,
      liveNextNaturalDayTerminalStatus: statusNextNaturalDayTerminalStatus,
      livePreferredOwnerReservation: statusLivePreferredOwnerReservation,
      liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRightWithExecution,
      liveOwnershipConsistencyOk: statusLiveOwnershipConsistencyOk,
      latestLiveContextDecisions: Array.isArray(latestLive.contextDecisions)
        ? latestLive.contextDecisions.slice(0, 20)
        : [],
      latestContextCapture: latestRun?.details?.contextCapture && typeof latestRun.details.contextCapture === 'object'
        ? latestRun.details.contextCapture
        : null,
    },
    liveContextAudit: {
      invalidLiveContextsFound: Number(latestLiveContextAudit.invalidLiveContextsFound || 0),
      invalidLiveContextsActive: Number(latestLiveContextAudit.invalidLiveContextsActive || 0),
      invalidLiveContextsSuppressed: Number(latestLiveContextAudit.invalidLiveContextsSuppressed || 0),
      invalidLiveContextsCreatedToday: Number(latestLiveContextAudit.invalidLiveContextsCreatedToday || 0),
      invalidLiveContextsSuppressedToday: Number(latestLiveContextAudit.invalidLiveContextsSuppressedToday || 0),
      latestInvalidLiveContextDates: Array.isArray(latestLiveContextAudit.latestInvalidLiveContextDates)
        ? latestLiveContextAudit.latestInvalidLiveContextDates.slice(0, 12)
        : [],
      advisoryOnly: true,
    },
    liveCheckpoint: {
      ...statusLiveCheckpoint,
      missedValidCheckpointDaysCount,
      latestMissedCheckpointDates,
      latestCheckpointFailures,
      checkpointFailureCount: Number(latestCheckpointFailures.length || 0),
      advisoryOnly: true,
    },
    liveInsertionSla: statusLiveInsertionSla,
    liveInsertionGrowth: statusLiveInsertionGrowth,
    liveInsertionOwnership: statusLiveInsertionOwnership,
    liveTargetDayOwnershipInvariant: statusLiveTargetDayOwnershipInvariant,
    liveAutonomousInsertReadiness: statusLiveAutonomousInsertReadiness,
    liveAutonomousAttemptTransition: statusLiveAutonomousAttemptTransition,
    liveAutonomousProof: statusLiveAutonomousProof,
    liveAutonomousInsertionMetrics: statusLiveAutonomousInsertionMetrics,
    livePreferredOwnerProof: statusLivePreferredOwnerProof,
    livePreferredOwnerMetrics: statusLivePreferredOwnerMetrics,
    livePreferredOwnerNaturalWinMetrics: statusPreferredOwnerNaturalWinMetrics,
    livePreferredOwnerPostCloseProofVerifier: statusLivePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerLatestOperationalVerdict: statusLivePreferredOwnerLatestOperationalVerdict,
    livePreferredOwnerOperationalProofBundle: statusLivePreferredOwnerOperationalProofBundle,
    livePreferredOwnerNaturalDrillWatcher: statusLivePreferredOwnerNaturalDrillWatcher,
    livePreferredOwnerMonitor: statusLivePreferredOwnerMonitor,
    liveNextNaturalDayWatchdog: statusNextNaturalDayWatchdog,
    liveNextNaturalDayTerminalStatus: statusNextNaturalDayTerminalStatus,
    livePreferredOwnerReservation: statusLivePreferredOwnerReservation,
    liveAutonomousFirstRight: enrichedStatusLiveAutonomousFirstRightWithExecution,
    liveAutonomousFirstRightReachedExecution: enrichedStatusLiveAutonomousFirstRightWithExecution.liveAutonomousFirstRightReachedExecution === true,
    liveOwnershipConsistencyOk: statusLiveOwnershipConsistencyOk,
    liveInsertionOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
      statusLiveInsertionOwnership.liveInsertionOwnershipSourceSpecificOutcome || 'ownership_source_unknown'
    ),
    liveTargetDayOwnershipConsistent: statusLiveTargetDayOwnershipInvariant.liveTargetDayOwnershipConsistent === true,
    liveTargetDayOwnershipMismatchReason: statusLiveTargetDayOwnershipInvariant.liveTargetDayOwnershipMismatchReason,
    liveAutonomousInsertReadinessTargetTradingDay: statusLiveAutonomousInsertReadiness.targetTradingDay || null,
    liveAutonomousInsertReadinessEligible: statusLiveAutonomousInsertReadiness.autonomousInsertEligible === true,
    liveAutonomousInsertReadinessBlockReason: statusLiveAutonomousInsertReadiness.autonomousInsertBlockReason,
    liveAutonomousInsertReadinessNextTransition: statusLiveAutonomousInsertReadiness.autonomousInsertNextTransition,
    liveAutonomousAttemptResult: statusLiveAutonomousAttemptTransition.attemptResult,
    liveAutonomousAttemptRequired: statusLiveAutonomousAttemptTransition.attemptRequired === true,
    liveAutonomousAttemptExecuted: statusLiveAutonomousAttemptTransition.attemptExecuted === true,
    liveAutonomousAttemptExecutionPath: statusLiveAutonomousAttemptTransition.attemptExecutionPath || null,
    liveAutonomousAttemptSkippedReason: statusLiveAutonomousAttemptTransition.attemptSkippedReason || null,
    liveAutonomousAttemptInsertedRowId: Number(statusLiveAutonomousAttemptTransition.insertedRowId || 0) || null,
    liveAutonomousAttemptRowInsertedByThisAttempt: statusLiveAutonomousAttemptTransition.rowInsertedByThisAttempt === true,
    liveAutonomousAttemptTargetTradingDay: statusLiveAutonomousAttemptTransition.targetTradingDay || null,
    liveAutonomousProofOutcome: statusLiveAutonomousProof.liveAutonomousProofOutcome,
    liveAutonomousProofEligible: statusLiveAutonomousProof.liveAutonomousProofEligible === true,
    liveAutonomousProofAttempted: statusLiveAutonomousProof.liveAutonomousProofAttempted === true,
    liveAutonomousProofSucceeded: statusLiveAutonomousProof.liveAutonomousProofSucceeded === true,
    liveAutonomousProofFailureReason: statusLiveAutonomousProof.liveAutonomousProofFailureReason,
    liveAutonomousProofTargetTradingDay: statusLiveAutonomousProof.liveAutonomousProofTargetTradingDay || null,
    livePreferredOwnerTargetTradingDay: statusLivePreferredOwnerProof.livePreferredOwnerTargetTradingDay || null,
    livePreferredOwnerExpectedSource: statusLivePreferredOwnerProof.livePreferredOwnerExpectedSource || 'close_complete_checkpoint',
    livePreferredOwnerActualSource: statusLivePreferredOwnerProof.livePreferredOwnerActualSource || null,
    livePreferredOwnerWon: statusLivePreferredOwnerProof.livePreferredOwnerWon === true,
    livePreferredOwnerFailureReason: statusLivePreferredOwnerProof.livePreferredOwnerFailureReason || 'none',
    livePreferredOwnerProofCapturedAt: statusLivePreferredOwnerProof.livePreferredOwnerProofCapturedAt || null,
    preferredOwnerWonToday: Number(statusLivePreferredOwnerMetrics.preferredOwnerWonToday || 0),
    preferredOwnerMissedToday: Number(statusLivePreferredOwnerMetrics.preferredOwnerMissedToday || 0),
    rolling5dPreferredOwnerWinRatePct: Number(statusLivePreferredOwnerMetrics.rolling5dPreferredOwnerWinRatePct || 0),
    consecutivePreferredOwnerWinDays: Number(statusLivePreferredOwnerMetrics.consecutivePreferredOwnerWinDays || 0),
    consecutivePreferredOwnerMissDays: Number(statusLivePreferredOwnerMetrics.consecutivePreferredOwnerMissDays || 0),
    livePreferredOwnerKpiConsistent: statusLivePreferredOwnerMetrics.livePreferredOwnerKpiConsistent !== false,
    livePreferredOwnerKpiMismatchReason: normalizeLivePreferredOwnerKpiMismatchReason(
      statusLivePreferredOwnerMetrics.livePreferredOwnerKpiMismatchReason || 'none'
    ),
    livePreferredOwnerKpiSource: toText(statusLivePreferredOwnerMetrics.livePreferredOwnerKpiSource || '') || 'jarvis_live_preferred_owner_proof',
    naturalPreferredOwnerWinsLast5d: Number(statusPreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsLast5d || 0),
    naturalPreferredOwnerWinsTotal: Number(statusPreferredOwnerNaturalWinMetrics.naturalPreferredOwnerWinsTotal || 0),
    lastNaturalPreferredOwnerWinDay: statusPreferredOwnerNaturalWinMetrics.lastNaturalPreferredOwnerWinDay || null,
    naturalPreferredOwnerVerifierPassesLast5d: Number(statusPreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierPassesLast5d || 0),
    naturalPreferredOwnerVerifierFailsLast5d: Number(statusPreferredOwnerVerifierMetrics.naturalPreferredOwnerVerifierFailsLast5d || 0),
    livePreferredOwnerPostCloseProofVerifier: statusLivePreferredOwnerPostCloseProofVerifier,
    livePreferredOwnerLatestOperationalVerdict: statusLivePreferredOwnerLatestOperationalVerdict,
    livePreferredOwnerLatestOperationalVerdictTargetTradingDay: (
      statusLivePreferredOwnerLatestOperationalVerdict?.targetTradingDay || null
    ),
    livePreferredOwnerLatestOperationalVerdictStatus: normalizePreferredOwnerPostCloseProofStatus(
      statusLivePreferredOwnerLatestOperationalVerdict?.verifierStatus || 'fail'
    ),
    livePreferredOwnerLatestOperationalVerdictPass: (
      statusLivePreferredOwnerLatestOperationalVerdict?.verifierPass === true
    ),
    livePreferredOwnerLatestOperationalVerdictReasons: Array.isArray(
      statusLivePreferredOwnerLatestOperationalVerdict?.verifierFailureReasons
    )
      ? statusLivePreferredOwnerLatestOperationalVerdict.verifierFailureReasons
      : [],
    livePreferredOwnerLatestOperationalVerdictReportedAt: (
      statusLivePreferredOwnerLatestOperationalVerdict?.reportedAt || null
    ),
    livePreferredOwnerLatestOperationalVerdictRunOrigin: normalizeDailyScoringRunOrigin(
      statusLivePreferredOwnerLatestOperationalVerdict?.runOrigin || 'manual'
    ),
    livePreferredOwnerLatestOperationalVerdictRuntimeSource: normalizeFinalizationSweepSource(
      statusLivePreferredOwnerLatestOperationalVerdict?.runtimeCheckpointSource || 'manual_api_run'
    ),
    livePreferredOwnerOperationalProofBundleCapturedThisRun: (
      latestRun?.details?.livePreferredOwnerOperationalProofBundleCapturedThisRun === true
    ),
    livePreferredOwnerOperationalProofBundleSkipReason: (
      toText(latestRun?.details?.livePreferredOwnerOperationalProofBundleSkipReason || '')
      || null
    ),
    livePreferredOwnerOperationalProofBundleTargetTradingDay: (
      statusLivePreferredOwnerOperationalProofBundle?.targetTradingDay || null
    ),
    livePreferredOwnerOperationalProofBundleRunId: Number(
      statusLivePreferredOwnerOperationalProofBundle?.runId || 0
    ) || null,
    livePreferredOwnerOperationalProofBundleRunOrigin: normalizeDailyScoringRunOrigin(
      statusLivePreferredOwnerOperationalProofBundle?.runOrigin || 'manual'
    ),
    livePreferredOwnerOperationalProofBundleCheckpointStatus: normalizeCheckpointStatus(
      statusLivePreferredOwnerOperationalProofBundle?.checkpointStatus || 'waiting_valid'
    ),
    livePreferredOwnerOperationalProofBundleCheckpointReason: normalizeCheckpointReason(
      statusLivePreferredOwnerOperationalProofBundle?.checkpointReason || 'unknown_checkpoint_state'
    ),
    livePreferredOwnerOperationalProofBundleRuntimeCheckpointSource: normalizeFinalizationSweepSource(
      statusLivePreferredOwnerOperationalProofBundle?.runtimeCheckpointSource || 'manual_api_run'
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerExpectedSource: normalizeFinalizationSweepSource(
      statusLivePreferredOwnerOperationalProofBundle?.preferredOwnerExpectedSource || 'close_complete_checkpoint'
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerActualSource: (
      statusLivePreferredOwnerOperationalProofBundle?.preferredOwnerActualSource || null
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerWon: (
      statusLivePreferredOwnerOperationalProofBundle?.preferredOwnerWon === true
    ),
    livePreferredOwnerOperationalProofBundlePreferredOwnerFailureReason: normalizeLivePreferredOwnerFailureReason(
      statusLivePreferredOwnerOperationalProofBundle?.preferredOwnerFailureReason || 'none'
    ),
    livePreferredOwnerOperationalProofBundleOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
      statusLivePreferredOwnerOperationalProofBundle?.ownershipSourceSpecificOutcome || 'ownership_source_unknown'
    ),
    livePreferredOwnerOperationalProofBundleVerifierStatus: normalizePreferredOwnerPostCloseProofStatus(
      statusLivePreferredOwnerOperationalProofBundle?.verifierStatus || 'fail'
    ),
    livePreferredOwnerOperationalProofBundleVerifierPass: (
      statusLivePreferredOwnerOperationalProofBundle?.verifierPass === true
    ),
    livePreferredOwnerOperationalProofBundleVerifierFailureReasons: Array.isArray(
      statusLivePreferredOwnerOperationalProofBundle?.verifierFailureReasons
    )
      ? statusLivePreferredOwnerOperationalProofBundle.verifierFailureReasons
      : [],
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsLast5d: Number(
      statusLivePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerWinsLast5d || 0
    ),
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerWinsTotal: Number(
      statusLivePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerWinsTotal || 0
    ),
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierPassesLast5d: Number(
      statusLivePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerVerifierPassesLast5d || 0
    ),
    livePreferredOwnerOperationalProofBundleNaturalPreferredOwnerVerifierFailsLast5d: Number(
      statusLivePreferredOwnerOperationalProofBundle?.naturalPreferredOwnerVerifierFailsLast5d || 0
    ),
    livePreferredOwnerOperationalProofBundleCapturedAt: (
      statusLivePreferredOwnerOperationalProofBundle?.capturedAt || null
    ),
    livePreferredOwnerOperatorSnapshot: (
      statusLivePreferredOwnerOperatorSnapshot
      && typeof statusLivePreferredOwnerOperatorSnapshot === 'object'
    )
      ? { ...statusLivePreferredOwnerOperatorSnapshot }
      : null,
    livePreferredOwnerNaturalDrillWatcherStatus: normalizePreferredOwnerNaturalDrillWatcherOutcome(
      statusLivePreferredOwnerOperatorSnapshot?.watcherStatus
      || statusLivePreferredOwnerNaturalDrillWatcher.livePreferredOwnerNaturalDrillWatcherStatus
      || 'waiting_for_resolution'
    ),
    livePreferredOwnerNaturalDrillWatcherTargetTradingDay: (
      statusLivePreferredOwnerOperatorSnapshot?.targetTradingDay
      || statusLivePreferredOwnerNaturalDrillWatcher.livePreferredOwnerNaturalDrillWatcherTargetTradingDay
      || null
    ),
    livePreferredOwnerNaturalDrillWatcherExecuted: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.watcherExecuted === true
        : statusLivePreferredOwnerNaturalDrillWatcher.livePreferredOwnerNaturalDrillWatcherExecuted === true
    ),
    livePreferredOwnerNaturalDrillWatcherExecutedAt: (
      statusLivePreferredOwnerNaturalDrillWatcher.livePreferredOwnerNaturalDrillWatcherExecutedAt || null
    ),
    livePreferredOwnerNaturalDrillWatcherOutcome: normalizePreferredOwnerNaturalDrillWatcherOutcome(
      statusLivePreferredOwnerOperatorSnapshot?.watcherOutcome
      || statusLivePreferredOwnerNaturalDrillWatcher.livePreferredOwnerNaturalDrillWatcherOutcome
      || 'waiting_for_resolution'
    ),
    livePreferredOwnerMonitorLatestTargetTradingDay: (
      statusLivePreferredOwnerOperatorSnapshot?.targetTradingDay
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestTargetTradingDay
      || null
    ),
    livePreferredOwnerMonitorLatestRunOrigin: normalizeDailyScoringRunOrigin(
      statusLivePreferredOwnerOperatorSnapshot?.runOrigin
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestRunOrigin
      || 'manual'
    ),
    livePreferredOwnerMonitorLatestRuntimeSource: normalizeFinalizationSweepSource(
      statusLivePreferredOwnerOperatorSnapshot?.runtimeSource
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestRuntimeSource
      || 'manual_api_run'
    ),
    livePreferredOwnerMonitorLatestOwnershipSourceSpecificOutcome: normalizeLiveInsertionOwnershipSourceSpecificOutcome(
      statusLivePreferredOwnerOperatorSnapshot?.ownershipSourceSpecificOutcome
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestOwnershipSourceSpecificOutcome
      || 'ownership_source_unknown'
    ),
    livePreferredOwnerMonitorLatestVerifierStatus: normalizeFromSet(
      statusLivePreferredOwnerOperatorSnapshot?.verifierStatus
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestVerifierStatus
      || 'missing',
      new Set(['pass', 'fail', 'missing']),
      'missing'
    ),
    livePreferredOwnerMonitorLatestVerifierPass: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.verifierPass === true
        : statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestVerifierPass === true
    ),
    livePreferredOwnerMonitorLatestWatcherStatus: normalizePreferredOwnerNaturalDrillWatcherOutcome(
      statusLivePreferredOwnerOperatorSnapshot?.watcherStatus
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestWatcherStatus
      || 'waiting_for_resolution'
    ),
    livePreferredOwnerMonitorLatestWatcherExecuted: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.watcherExecuted === true
        : statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestWatcherExecuted === true
    ),
    livePreferredOwnerMonitorLatestProofBundleStatus: normalizeFromSet(
      statusLivePreferredOwnerOperatorSnapshot?.proofBundleStatus
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestProofBundleStatus
      || 'missing',
      new Set(['pass', 'fail', 'missing']),
      'missing'
    ),
    livePreferredOwnerMonitorLatestProofBundlePass: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.proofBundlePass === true
        : statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestProofBundlePass === true
    ),
    livePreferredOwnerMonitorLatestSummaryLabel: normalizeFromSet(
      statusLivePreferredOwnerOperatorSnapshot?.monitorSummaryLabel
      || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorLatestSummaryLabel
      || 'healthy_waiting_next_day',
      new Set(LIVE_PREFERRED_OWNER_MONITOR_SUMMARY_LABEL_ENUM),
      'healthy_waiting_next_day'
    ),
    livePreferredOwnerMonitorResolvedSuccess: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.monitorResolvedSuccess === true
        : statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorResolvedSuccess === true
    ),
    livePreferredOwnerMonitorConsistent: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.monitorConsistent !== false
        : statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorConsistent !== false
    ),
    livePreferredOwnerMonitorMismatchReasons: Array.isArray(
      statusLivePreferredOwnerOperatorSnapshot?.monitorMismatchReasons
        || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorMismatchReasons
    )
      ? (
        statusLivePreferredOwnerOperatorSnapshot?.monitorMismatchReasons
        || statusLivePreferredOwnerMonitor.livePreferredOwnerMonitorMismatchReasons
      )
        .map((reason) => normalizeFromSet(
          reason,
          new Set(LIVE_PREFERRED_OWNER_MONITOR_MISMATCH_REASON_ENUM),
          null
        ))
        .filter((reason, idx, arr) => !!reason && arr.indexOf(reason) === idx)
      : [],
    liveNextNaturalDayWatchdogBaselineDate: (
      statusNextNaturalDayWatchdog?.baselineDate
      || normalizeDate(input.nextNaturalDayBaselineDate || input.baselineDate || '2026-03-13')
      || '2026-03-13'
    ),
    liveNextNaturalDayWatchdogTargetTradingDay: (
      statusNextNaturalDayWatchdog?.targetTradingDay
      || statusNextNaturalDayWatchdog?.nextNaturalTradingDayAfterBaseline
      || null
    ),
    liveNextNaturalDayWatchdogResult: normalizeNextNaturalDayReadinessResult(
      statusNextNaturalDayWatchdog?.result || 'next_natural_day_not_in_data_yet'
    ),
    liveNextNaturalDayWatchdogFirstMissingLayer: (
      toText(statusNextNaturalDayWatchdog?.firstMissingLayer || '') || 'none'
    ),
    liveNextNaturalDayWatchdogCompleted: statusNextNaturalDayWatchdog?.completed === true,
    liveNextNaturalDayWatchdogAlertEmitted: statusNextNaturalDayWatchdog?.alertEmitted === true,
    liveNextNaturalDayWatchdogAlertPersistedThisRun: statusNextNaturalDayWatchdog?.alertPersistedThisRun === true,
    liveNextNaturalDayDiscoveredInPersistedData: (
      statusNextNaturalDayTerminalStatus?.nextNaturalDayDiscoveredInPersistedData === true
    ),
    liveNextNaturalDayTerminalAlertEmittedForDiscoveredDay: (
      statusNextNaturalDayTerminalStatus?.terminalAlertEmittedForDiscoveredDay === true
    ),
    liveNextNaturalDayWatchdogPipelineState: normalizeFromSet(
      statusNextNaturalDayWatchdog?.pipelineState || '',
      new Set(['waiting', 'broken', 'healthy']),
      'waiting'
    ),
    liveNextNaturalDayWatchdogWaitingForNextDay: statusNextNaturalDayWatchdog?.waitingForNextDay === true,
    liveNextNaturalDayWatchdogActuallyBrokenOnNextDay: statusNextNaturalDayWatchdog?.actuallyBrokenOnNextDay === true,
    liveNextNaturalDayWatchdogLatestCheckedAt: (
      statusNextNaturalDayWatchdog?.watchdogStateRow?.latestCheckedAt
      || statusNextNaturalDayWatchdog?.latestWatchdogStateRow?.latestCheckedAt
      || null
    ),
    liveNextNaturalDayWatchdogCompletedAt: (
      statusNextNaturalDayWatchdog?.watchdogStateRow?.completedAt
      || statusNextNaturalDayWatchdog?.latestWatchdogStateRow?.completedAt
      || null
    ),
    liveNextNaturalDayWatchdogStateRow: (
      statusNextNaturalDayWatchdog?.watchdogStateRow
      && typeof statusNextNaturalDayWatchdog.watchdogStateRow === 'object'
    )
      ? { ...statusNextNaturalDayWatchdog.watchdogStateRow }
      : null,
    liveNextNaturalDayWatchdogTerminalAlertRow: (
      statusNextNaturalDayWatchdog?.watchdogTerminalAlertRow
      && typeof statusNextNaturalDayWatchdog.watchdogTerminalAlertRow === 'object'
    )
      ? { ...statusNextNaturalDayWatchdog.watchdogTerminalAlertRow }
      : null,
    liveNextNaturalDayTerminalStatus: statusNextNaturalDayTerminalStatus,
    livePreferredOwnerPostCloseProofVerifierStatus: normalizePreferredOwnerPostCloseProofStatus(
      statusLivePreferredOwnerOperatorSnapshot?.verifierStatus
      || statusLivePreferredOwnerPostCloseProofVerifier?.verifierStatus
      || 'fail'
    ),
    livePreferredOwnerPostCloseProofVerifierPass: (
      statusLivePreferredOwnerOperatorSnapshot
        ? statusLivePreferredOwnerOperatorSnapshot.verifierPass === true
        : statusLivePreferredOwnerPostCloseProofVerifier?.verifierPass === true
    ),
    livePreferredOwnerPostCloseProofVerifierFailureReasons: Array.isArray(
      statusLivePreferredOwnerOperatorSnapshot?.verifierFailureReasons
        || statusLivePreferredOwnerPostCloseProofVerifier?.failureReasons
    )
      ? (
        statusLivePreferredOwnerOperatorSnapshot?.verifierFailureReasons
        || statusLivePreferredOwnerPostCloseProofVerifier?.failureReasons
      )
      : [],
    livePreferredOwnerPostCloseProofVerifierTargetTradingDay: (
      statusLivePreferredOwnerOperatorSnapshot?.targetTradingDay
      || statusLivePreferredOwnerPostCloseProofVerifier?.targetTradingDay
      || null
    ),
    livePreferredOwnerPostCloseProofVerifierRunId: Number(
      statusLivePreferredOwnerOperatorSnapshot?.verifierRunId
      || statusLivePreferredOwnerPostCloseProofVerifier?.runId
      || 0
    ) || null,
    livePreferredOwnerPostCloseProofVerifierVerifiedAt: statusLivePreferredOwnerPostCloseProofVerifier?.verifiedAt || null,
    livePreferredOwnerPostCloseProofVerifierRunOrigin: normalizeDailyScoringRunOrigin(
      statusLivePreferredOwnerOperatorSnapshot?.runOrigin
      || statusLivePreferredOwnerPostCloseProofVerifier?.livePreferredOwnerPostCloseProofVerifierRunOrigin
      || statusLivePreferredOwnerPostCloseProofVerifier?.runOrigin
      || 'manual'
    ),
    livePreferredOwnerPostCloseProofResolvedNaturally: (
      normalizeDailyScoringRunOrigin(
        statusLivePreferredOwnerOperatorSnapshot?.runOrigin
        || statusLivePreferredOwnerPostCloseProofVerifier?.livePreferredOwnerPostCloseProofVerifierRunOrigin
        || statusLivePreferredOwnerPostCloseProofVerifier?.runOrigin
        || 'manual'
      ) === 'natural'
      && normalizeFinalizationSweepSource(
        statusLivePreferredOwnerOperatorSnapshot?.runtimeSource
        || statusLivePreferredOwnerPostCloseProofVerifier?.runtimeSource
        || 'manual_api_run'
      ) === 'close_complete_checkpoint'
      && (
        statusLivePreferredOwnerOperatorSnapshot?.verifierStatus === 'pass'
        || statusLivePreferredOwnerOperatorSnapshot?.verifierStatus === 'fail'
        || statusLivePreferredOwnerPostCloseProofVerifier?.livePreferredOwnerPostCloseProofResolvedNaturally === true
      )
    ),
    livePreferredOwnerReservation: statusLivePreferredOwnerReservation,
    livePreferredOwnerReservationTargetTradingDay: statusLivePreferredOwnerReservation.livePreferredOwnerReservationTargetTradingDay || null,
    livePreferredOwnerReservationExpectedSource: statusLivePreferredOwnerReservation.livePreferredOwnerReservationExpectedSource || 'close_complete_checkpoint',
    livePreferredOwnerReservationActive: statusLivePreferredOwnerReservation.livePreferredOwnerReservationActive === true,
    livePreferredOwnerReservationWindowOpenedAt: statusLivePreferredOwnerReservation.livePreferredOwnerReservationWindowOpenedAt || null,
    livePreferredOwnerReservationWindowExpiresAt: statusLivePreferredOwnerReservation.livePreferredOwnerReservationWindowExpiresAt || null,
    livePreferredOwnerReservationState: statusLivePreferredOwnerReservation.livePreferredOwnerReservationState || 'reservation_not_applicable',
    livePreferredOwnerReservationBlockedSource: statusLivePreferredOwnerReservation.livePreferredOwnerReservationBlockedSource || null,
    livePreferredOwnerReservationBlockReason: statusLivePreferredOwnerReservation.livePreferredOwnerReservationBlockReason || 'none',
    livePreferredOwnerReservationReleasedAt: statusLivePreferredOwnerReservation.livePreferredOwnerReservationReleasedAt || null,
    livePreferredOwnerDeferredFallbackSource: statusLivePreferredOwnerReservation.livePreferredOwnerDeferredFallbackSource || null,
    livePreferredOwnerDeferredFallbackReason: statusLivePreferredOwnerReservation.livePreferredOwnerDeferredFallbackReason || null,
    livePreferredOwnerDeferredFallbackAt: statusLivePreferredOwnerReservation.livePreferredOwnerDeferredFallbackAt || null,
    recentOutcomes,
    advisoryOnly: true,
  };
}

module.exports = {
  ensureDailyScoringTables,
  runAutomaticDailyScoring,
  buildDailyScoringStatus,
  buildLiveAutonomousInsertReadiness,
  buildLiveAutonomousProofContract,
  buildLiveAutonomousAttemptTransition,
  buildLivePreferredOwnerReservation,
  enforceEligibleAttemptOrBugContract,
  buildPerDateStrategySnapshotForScoring,
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
};
