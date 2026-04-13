'use strict';

const { processSession } = require('../engine/orb');

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeDate(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function weekdayFromDate(dateValue = '') {
  const date = normalizeDate(dateValue);
  if (!date) return null;
  const dt = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

function normalizeStrategyKey(value) {
  return toText(value).toLowerCase();
}

function normalizeTpMode(value) {
  const key = toText(value).toLowerCase();
  if (!key) return '';
  if (key.includes('nearest')) return 'Nearest';
  if (key.includes('skip 1') || key === 'skip1') return 'Skip 1';
  if (key.includes('skip 2') || key === 'skip2') return 'Skip 2';
  return toText(value);
}

function normalizeToken(value) {
  return toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function scoreLabelToNumeric(value) {
  const key = toText(value).toLowerCase();
  if (key === 'correct') return 1;
  if (key === 'partially_correct') return 0.5;
  if (key === 'incorrect') return 0;
  return null;
}

const SOURCE_LIVE = 'live';
const SOURCE_BACKFILL = 'backfill';
const PHASE_LIVE_INTRADAY = 'live_intraday';
const PHASE_PRE_ORB = 'pre_orb_recommendation';
const VERSION_LIVE = 'live_v1';
const VERSION_BACKFILL = 'backfill_pre_orb_v1';
const SCORE_VERSION = 'recommendation_outcome_v1';
const SIMULATED_TRADE_LEDGER_VERSION = 'jarvis_simulated_trade_outcome_v1';
const LATE_ENTRY_POLICY_EXPERIMENT_KEY = 'late_entry_skip2_extension';
const LATE_ENTRY_POLICY_EXPERIMENT_VERSION = 'v1';
const LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY = 'late_entry_skip2_extension_v2';
const LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION = 'v1';
const LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY = 'late_entry_skip2_extension_v3';
const LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION = 'v1';
const LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY = 'late_entry_skip2_extension_v4';
const LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION = 'v1';
const LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY = 'late_entry_skip2_extension_v5';
const LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION = 'v1';
const LATE_ENTRY_BROAD_REPLAY_REFERENCE_KEY = 'late_entry_broad_replay_reference';
const LATE_ENTRY_POLICY_BASELINE_CUTOFF = '11:00';
const LATE_ENTRY_POLICY_EXTENSION_START = '11:00';
const LATE_ENTRY_POLICY_EXTENSION_END = '12:00';
const LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115 = '11:00-11:15';
const LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130 = '11:15-11:30';
const LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200 = '11:30-12:00';
const LATE_ENTRY_POLICY_TIME_BUCKET_BEFORE_1100 = 'before_11:00';
const LATE_ENTRY_POLICY_TIME_BUCKET_AFTER_1200 = 'after_12:00';
const LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN = 'unknown';
const LATE_ENTRY_POLICY_PROMOTION_BLOCK_TRUTH_COVERAGE = 'blocked_due_to_truth_coverage';
const LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY = 'blocked_due_to_sample_instability';
const LATE_ENTRY_POLICY_PROMOTION_BLOCK_POST_1130_DRAG = 'blocked_due_to_post_1130_drag';
const LATE_ENTRY_POLICY_PROMOTION_SHADOW_POSITIVE_NOT_READY = 'shadow_positive_not_ready';
const LATE_ENTRY_POLICY_PROMOTION_PROMOTABLE_FOR_REVIEW = 'promotable_for_review';
const LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM = Object.freeze([
  LATE_ENTRY_POLICY_PROMOTION_BLOCK_TRUTH_COVERAGE,
  LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY,
  LATE_ENTRY_POLICY_PROMOTION_BLOCK_POST_1130_DRAG,
  LATE_ENTRY_POLICY_PROMOTION_SHADOW_POSITIVE_NOT_READY,
  LATE_ENTRY_POLICY_PROMOTION_PROMOTABLE_FOR_REVIEW,
]);
const LATE_ENTRY_POLICY_PROMOTION_STATUS_SET = new Set(LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM);
const LATE_ENTRY_POLICY_MIN_SAMPLE_DAYS = 12;
const LATE_ENTRY_POLICY_MIN_POLICY_ADDED_TRADES = 6;
const LATE_ENTRY_POLICY_MIN_EXTERNAL_COVERAGE_PCT = 80;
const LATE_ENTRY_POLICY_MIN_ROLLING5_EXTERNAL_COVERAGE_PCT = 100;
const LATE_ENTRY_POLICY_MIN_ROLLING10_EXTERNAL_COVERAGE_PCT = 100;
const LATE_ENTRY_POLICY_POST_1130_DRAG_WARN_PNL = -20;
const LATE_ENTRY_TRUTH_REPAIR_SCOPE_LATEST_ONLY = 'latest_only';
const LATE_ENTRY_TRUTH_REPAIR_SCOPE_LATEST_10 = 'latest_10';
const LATE_ENTRY_TRUTH_REPAIR_SCOPE_ALL_ELIGIBLE = 'all_eligible';
const LATE_ENTRY_TRUTH_REPAIR_SCOPE_ENUM = Object.freeze([
  LATE_ENTRY_TRUTH_REPAIR_SCOPE_LATEST_ONLY,
  LATE_ENTRY_TRUTH_REPAIR_SCOPE_LATEST_10,
  LATE_ENTRY_TRUTH_REPAIR_SCOPE_ALL_ELIGIBLE,
]);
const LATE_ENTRY_TRUTH_REPAIR_SCOPE_SET = new Set(LATE_ENTRY_TRUTH_REPAIR_SCOPE_ENUM);
const LATE_ENTRY_TRUTH_BLOCKER_MISSING_CONTEXT = 'missing_context_row';
const LATE_ENTRY_TRUTH_BLOCKER_NEEDS_EXTERNAL = 'needs_external_close_truth';
const LATE_ENTRY_TRUTH_BLOCKER_MISSING_REPLAY = 'missing_replay_row';
const LATE_ENTRY_TRUTH_BLOCKER_INCOMPLETE_POLICY = 'incomplete_policy_rows';
const LATE_ENTRY_TRUTH_BLOCKER_MISSING_CANDLES = 'missing_session_candles_for_checkpoint_rebuild';
const LATE_ENTRY_TRUTH_BLOCKER_ALREADY_FINALIZED = 'already_externally_finalized';
const LATE_ENTRY_TRUTH_BLOCKER_INSUFFICIENT_LOCAL = 'insufficient_local_evidence_for_safe_repair';
const LATE_ENTRY_TRUTH_BLOCKER_UNKNOWN = 'unknown_block_reason';
const LATE_ENTRY_TRUTH_EXTERNAL_BLOCKER_SET = new Set([
  LATE_ENTRY_TRUTH_BLOCKER_NEEDS_EXTERNAL,
]);
const LATE_ENTRY_TRUTH_LOCAL_BLOCKER_SET = new Set([
  LATE_ENTRY_TRUTH_BLOCKER_MISSING_CONTEXT,
  LATE_ENTRY_TRUTH_BLOCKER_MISSING_REPLAY,
  LATE_ENTRY_TRUTH_BLOCKER_INCOMPLETE_POLICY,
  LATE_ENTRY_TRUTH_BLOCKER_MISSING_CANDLES,
  LATE_ENTRY_TRUTH_BLOCKER_INSUFFICIENT_LOCAL,
]);
const LATE_ENTRY_CONTEXT_GAP_ROOT_NOT_PERSISTED = 'not_persisted';
const LATE_ENTRY_CONTEXT_GAP_ROOT_SCOPE_MISMATCH = 'scope_mismatch';
const LATE_ENTRY_CONTEXT_GAP_ROOT_SCHEMA_MISMATCH = 'schema_mismatch';
const LATE_ENTRY_CONTEXT_GAP_ROOT_UNKNOWN = 'unknown';
const LATE_ENTRY_POLICY_REPLAY_STATUS_REPLAY_POLICY_REJECTED = 'replay_would_have_traded_but_policy_rejected';
const LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_RESCUED_OPPORTUNITY = 'policy_rescued_opportunity';
const LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_REJECTED_REPLAY_LOSS = 'policy_rejected_replay_loss';
const LATE_ENTRY_POLICY_REPLAY_STATUS_NO_REPLAY_TRADE_EXISTS = 'no_replay_trade_exists';
const LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_NO_TRADE = 'baseline_and_policy_agree_no_trade';
const LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_TRADE = 'baseline_and_policy_agree_trade';
const LATE_ENTRY_POLICY_REPLAY_STATUS_ENUM = Object.freeze([
  LATE_ENTRY_POLICY_REPLAY_STATUS_REPLAY_POLICY_REJECTED,
  LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_RESCUED_OPPORTUNITY,
  LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_REJECTED_REPLAY_LOSS,
  LATE_ENTRY_POLICY_REPLAY_STATUS_NO_REPLAY_TRADE_EXISTS,
  LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_NO_TRADE,
  LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_TRADE,
]);
const LATE_ENTRY_POLICY_REPLAY_STATUS_SET = new Set(LATE_ENTRY_POLICY_REPLAY_STATUS_ENUM);
const LATE_ENTRY_POLICY_V2_COMPARISON_RESCUED_OPPORTUNITY = 'v2_rescued_opportunity';
const LATE_ENTRY_POLICY_V2_COMPARISON_ADDED_LOSS = 'v2_added_loss';
const LATE_ENTRY_POLICY_V2_COMPARISON_AGREED_WITH_V1 = 'v2_agreed_with_v1';
const LATE_ENTRY_POLICY_V2_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE = 'v2_agreed_with_replay_no_trade';
const LATE_ENTRY_POLICY_V2_COMPARISON_ADDED_TRADE_NEUTRAL = 'v2_added_trade_neutral';
const LATE_ENTRY_POLICY_V2_COMPARISON_MORE_CONSERVATIVE = 'v2_more_conservative_than_v1';
const LATE_ENTRY_POLICY_V2_COMPARISON_MIXED = 'v2_mixed';
const LATE_ENTRY_POLICY_V2_COMPARISON_ENUM = Object.freeze([
  LATE_ENTRY_POLICY_V2_COMPARISON_RESCUED_OPPORTUNITY,
  LATE_ENTRY_POLICY_V2_COMPARISON_ADDED_LOSS,
  LATE_ENTRY_POLICY_V2_COMPARISON_AGREED_WITH_V1,
  LATE_ENTRY_POLICY_V2_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE,
  LATE_ENTRY_POLICY_V2_COMPARISON_ADDED_TRADE_NEUTRAL,
  LATE_ENTRY_POLICY_V2_COMPARISON_MORE_CONSERVATIVE,
  LATE_ENTRY_POLICY_V2_COMPARISON_MIXED,
]);
const LATE_ENTRY_POLICY_V2_COMPARISON_SET = new Set(LATE_ENTRY_POLICY_V2_COMPARISON_ENUM);
const LATE_ENTRY_POLICY_V3_COMPARISON_RESCUED_OPPORTUNITY = 'v3_rescued_opportunity';
const LATE_ENTRY_POLICY_V3_COMPARISON_ADDED_LOSS = 'v3_added_loss';
const LATE_ENTRY_POLICY_V3_COMPARISON_AGREED_WITH_V2 = 'v3_agreed_with_v2';
const LATE_ENTRY_POLICY_V3_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE = 'v3_agreed_with_replay_no_trade';
const LATE_ENTRY_POLICY_V3_COMPARISON_ADDED_TRADE_NEUTRAL = 'v3_added_trade_neutral';
const LATE_ENTRY_POLICY_V3_COMPARISON_MORE_AGGRESSIVE = 'v3_more_aggressive_than_v2';
const LATE_ENTRY_POLICY_V3_COMPARISON_MORE_CONSERVATIVE = 'v3_more_conservative_than_v2';
const LATE_ENTRY_POLICY_V3_COMPARISON_MIXED = 'v3_mixed';
const LATE_ENTRY_POLICY_V3_COMPARISON_ENUM = Object.freeze([
  LATE_ENTRY_POLICY_V3_COMPARISON_RESCUED_OPPORTUNITY,
  LATE_ENTRY_POLICY_V3_COMPARISON_ADDED_LOSS,
  LATE_ENTRY_POLICY_V3_COMPARISON_AGREED_WITH_V2,
  LATE_ENTRY_POLICY_V3_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE,
  LATE_ENTRY_POLICY_V3_COMPARISON_ADDED_TRADE_NEUTRAL,
  LATE_ENTRY_POLICY_V3_COMPARISON_MORE_AGGRESSIVE,
  LATE_ENTRY_POLICY_V3_COMPARISON_MORE_CONSERVATIVE,
  LATE_ENTRY_POLICY_V3_COMPARISON_MIXED,
]);
const LATE_ENTRY_POLICY_V3_COMPARISON_SET = new Set(LATE_ENTRY_POLICY_V3_COMPARISON_ENUM);
const LATE_ENTRY_POLICY_V4_COMPARISON_RESCUED_OPPORTUNITY = 'v4_rescued_opportunity';
const LATE_ENTRY_POLICY_V4_COMPARISON_ADDED_LOSS = 'v4_added_loss';
const LATE_ENTRY_POLICY_V4_COMPARISON_AGREED_WITH_V3 = 'v4_agreed_with_v3';
const LATE_ENTRY_POLICY_V4_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE = 'v4_agreed_with_replay_no_trade';
const LATE_ENTRY_POLICY_V4_COMPARISON_ADDED_TRADE_NEUTRAL = 'v4_added_trade_neutral';
const LATE_ENTRY_POLICY_V4_COMPARISON_MORE_AGGRESSIVE = 'v4_more_aggressive_than_v3';
const LATE_ENTRY_POLICY_V4_COMPARISON_MORE_CONSERVATIVE = 'v4_more_conservative_than_v3';
const LATE_ENTRY_POLICY_V4_COMPARISON_MIXED = 'v4_mixed';
const LATE_ENTRY_POLICY_V4_COMPARISON_ENUM = Object.freeze([
  LATE_ENTRY_POLICY_V4_COMPARISON_RESCUED_OPPORTUNITY,
  LATE_ENTRY_POLICY_V4_COMPARISON_ADDED_LOSS,
  LATE_ENTRY_POLICY_V4_COMPARISON_AGREED_WITH_V3,
  LATE_ENTRY_POLICY_V4_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE,
  LATE_ENTRY_POLICY_V4_COMPARISON_ADDED_TRADE_NEUTRAL,
  LATE_ENTRY_POLICY_V4_COMPARISON_MORE_AGGRESSIVE,
  LATE_ENTRY_POLICY_V4_COMPARISON_MORE_CONSERVATIVE,
  LATE_ENTRY_POLICY_V4_COMPARISON_MIXED,
]);
const LATE_ENTRY_POLICY_V4_COMPARISON_SET = new Set(LATE_ENTRY_POLICY_V4_COMPARISON_ENUM);
const LATE_ENTRY_POLICY_V5_COMPARISON_RESCUED_OPPORTUNITY = 'v5_rescued_opportunity';
const LATE_ENTRY_POLICY_V5_COMPARISON_ADDED_LOSS = 'v5_added_loss';
const LATE_ENTRY_POLICY_V5_COMPARISON_AGREED_WITH_V4 = 'v5_agreed_with_v4';
const LATE_ENTRY_POLICY_V5_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE = 'v5_agreed_with_replay_no_trade';
const LATE_ENTRY_POLICY_V5_COMPARISON_ADDED_TRADE_NEUTRAL = 'v5_added_trade_neutral';
const LATE_ENTRY_POLICY_V5_COMPARISON_MORE_AGGRESSIVE = 'v5_more_aggressive_than_v4';
const LATE_ENTRY_POLICY_V5_COMPARISON_MORE_CONSERVATIVE = 'v5_more_conservative_than_v4';
const LATE_ENTRY_POLICY_V5_COMPARISON_MIXED = 'v5_mixed';
const LATE_ENTRY_POLICY_V5_COMPARISON_ENUM = Object.freeze([
  LATE_ENTRY_POLICY_V5_COMPARISON_RESCUED_OPPORTUNITY,
  LATE_ENTRY_POLICY_V5_COMPARISON_ADDED_LOSS,
  LATE_ENTRY_POLICY_V5_COMPARISON_AGREED_WITH_V4,
  LATE_ENTRY_POLICY_V5_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE,
  LATE_ENTRY_POLICY_V5_COMPARISON_ADDED_TRADE_NEUTRAL,
  LATE_ENTRY_POLICY_V5_COMPARISON_MORE_AGGRESSIVE,
  LATE_ENTRY_POLICY_V5_COMPARISON_MORE_CONSERVATIVE,
  LATE_ENTRY_POLICY_V5_COMPARISON_MIXED,
]);
const LATE_ENTRY_POLICY_V5_COMPARISON_SET = new Set(LATE_ENTRY_POLICY_V5_COMPARISON_ENUM);
const ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_CORRECT = 'correct';
const ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_CONSERVATIVE = 'too_conservative';
const ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_AGGRESSIVE = 'too_aggressive';
const ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_INSUFFICIENT_EVIDENCE = 'insufficient_evidence';
const ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_ENUM = Object.freeze([
  ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_CORRECT,
  ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_CONSERVATIVE,
  ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_AGGRESSIVE,
  ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_INSUFFICIENT_EVIDENCE,
]);
const ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_SET = new Set(ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_ENUM);
const MODEL_VS_REALIZED_DIVERGENCE_NONE = 'none';
const MODEL_VS_REALIZED_DIVERGENCE_EXTERNAL_PROFIT_WHILE_MODEL_DEFENSIVE = 'external_profitable_opportunity_while_model_defensive';
const MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_ENUM = Object.freeze([
  MODEL_VS_REALIZED_DIVERGENCE_NONE,
  MODEL_VS_REALIZED_DIVERGENCE_EXTERNAL_PROFIT_WHILE_MODEL_DEFENSIVE,
]);
const MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_SET = new Set(MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_ENUM);
const EXTERNAL_PROFIT_OPPORTUNITY_MIN_PNL_DOLLARS = 50;
const LIVE_CONTEXT_GUARD_STATUS_ALLOWED = 'allowed_live_context';
const LIVE_CONTEXT_GUARD_STATUS_REJECT_NON_TRADING = 'rejected_non_trading_day';
const LIVE_CONTEXT_GUARD_STATUS_REJECT_INVALID_MAPPING = 'rejected_invalid_mapping';
const LIVE_CONTEXT_GUARD_STATUS_REJECT_MISSING_SESSION = 'rejected_missing_session_definition';
const LIVE_CONTEXT_GUARD_STATUS_ENUM = Object.freeze([
  LIVE_CONTEXT_GUARD_STATUS_ALLOWED,
  LIVE_CONTEXT_GUARD_STATUS_REJECT_NON_TRADING,
  LIVE_CONTEXT_GUARD_STATUS_REJECT_INVALID_MAPPING,
  LIVE_CONTEXT_GUARD_STATUS_REJECT_MISSING_SESSION,
]);
const LIVE_CONTEXT_GUARD_STATUS_SET = new Set(LIVE_CONTEXT_GUARD_STATUS_ENUM);
const SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY = 'failed_extension_reversal_fade';
const SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION = 'v1';
const SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE = 'no_trade';
const SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN = 'win';
const SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS = 'loss';
const SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT = 'flat';
const SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_ENUM = Object.freeze([
  SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
  SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN,
  SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS,
  SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT,
]);
const SHADOW_PLAYBOOK_LANE_GREEN = 'green_lane';
const SHADOW_PLAYBOOK_LANE_RED = 'red_lane';
const SHADOW_PLAYBOOK_LANE_NEUTRAL = 'neutral_lane';
const SHADOW_PLAYBOOK_LANE_LABEL_ENUM = Object.freeze([
  SHADOW_PLAYBOOK_LANE_GREEN,
  SHADOW_PLAYBOOK_LANE_RED,
  SHADOW_PLAYBOOK_LANE_NEUTRAL,
]);
const SHADOW_PLAYBOOK_LANE_LABEL_SET = new Set(SHADOW_PLAYBOOK_LANE_LABEL_ENUM);
const SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET = new Set([
  'high_risk_context_support',
  'blocked_day_support',
]);
const SHADOW_PLAYBOOK_DURABILITY_TREND_IMPROVING = 'improving';
const SHADOW_PLAYBOOK_DURABILITY_TREND_FLAT = 'flat';
const SHADOW_PLAYBOOK_DURABILITY_TREND_DEGRADING = 'degrading';
const SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM = Object.freeze([
  SHADOW_PLAYBOOK_DURABILITY_TREND_IMPROVING,
  SHADOW_PLAYBOOK_DURABILITY_TREND_FLAT,
  SHADOW_PLAYBOOK_DURABILITY_TREND_DEGRADING,
]);
const SHADOW_PLAYBOOK_DURABILITY_TREND_SET = new Set(SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM);
const SHADOW_PLAYBOOK_DURABILITY_ROLLING_5 = 5;
const SHADOW_PLAYBOOK_DURABILITY_ROLLING_10 = 10;
const SHADOW_PLAYBOOK_DURABILITY_TREND_DELTA_THRESHOLD_PNL = 5;
const SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE = 'safe_to_trust_without_topstep';
const SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL = 'partially_degraded';
const SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY = 'not_trustworthy_until_topstep_returns';
const SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM = Object.freeze([
  SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE,
  SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL,
  SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY,
]);
const SHADOW_PLAYBOOK_DURABILITY_TRUST_SET = new Set(SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM);
const SHADOW_PLAYBOOK_PROMOTION_READINESS_READY = 'ready_for_promotion_review';
const SHADOW_PLAYBOOK_PROMOTION_READINESS_BLOCKED = 'blocked_due_to_truth_coverage';
const SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM = Object.freeze([
  SHADOW_PLAYBOOK_PROMOTION_READINESS_READY,
  SHADOW_PLAYBOOK_PROMOTION_READINESS_BLOCKED,
]);
const SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_SET = new Set(
  SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM
);
const SHADOW_PLAYBOOK_PROMOTION_MIN_FULL_EXTERNAL_COVERAGE_PCT = 80;
const SHADOW_PLAYBOOK_PROMOTION_MIN_ROLLING5_EXTERNAL_COVERAGE_PCT = 100;
const SHADOW_PLAYBOOK_PROMOTION_MIN_ROLLING10_EXTERNAL_COVERAGE_PCT = 100;
const SHADOW_PLAYBOOK_PROMOTION_MIN_EXTERNALLY_FINALIZED_ELIGIBLE_DAYS = 5;
const SHADOW_PLAYBOOK_PROMOTION_MIN_ELIGIBLE_DAYS = 5;
const TOPSTEP_SYNC_STALE_THRESHOLD_MINUTES = 180;
const TOPSTEP_DEPENDENCY_CACHE_TTL_MS = 30 * 1000;
const REALIZED_TRUTH_SOURCE_PRIMARY = 'topstep_linked_truth';
const REALIZED_TRUTH_SOURCE_SECONDARY = 'trade_outcome_feedback_topstep_auto';
const REALIZED_TRUTH_SOURCE_TERTIARY = 'internal_trades_table';
const REALIZED_TRUTH_SOURCE_NONE = 'unavailable';
const REALIZED_TRUTH_SOURCE_ENUM = Object.freeze([
  REALIZED_TRUTH_SOURCE_PRIMARY,
  REALIZED_TRUTH_SOURCE_SECONDARY,
  REALIZED_TRUTH_SOURCE_TERTIARY,
  REALIZED_TRUTH_SOURCE_NONE,
]);
const REALIZED_TRUTH_TRUST_SAFE = SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE;
const REALIZED_TRUTH_TRUST_PARTIAL = SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL;
const REALIZED_TRUTH_TRUST_UNTRUSTWORTHY = SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY;

const topstepDependencyCache = {
  db: null,
  fetchedAtMs: 0,
  value: null,
};
const topstepRecoveryWindowCache = {
  db: null,
  fetchedAtMs: 0,
  value: null,
};

function normalizeAssistantDecisionOutcomeClassification(value) {
  const key = toText(value).toLowerCase();
  if (ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_SET.has(key)) return key;
  return ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_INSUFFICIENT_EVIDENCE;
}

function normalizeModelVsRealizedDivergenceClassification(value) {
  const key = toText(value).toLowerCase();
  if (MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_SET.has(key)) return key;
  return MODEL_VS_REALIZED_DIVERGENCE_NONE;
}

function normalizeShadowPlaybookDurabilityTrend(value) {
  const key = toText(value).toLowerCase();
  if (SHADOW_PLAYBOOK_DURABILITY_TREND_SET.has(key)) return key;
  return SHADOW_PLAYBOOK_DURABILITY_TREND_FLAT;
}

function normalizeShadowPlaybookDurabilityTrust(value) {
  const key = toText(value).toLowerCase();
  if (SHADOW_PLAYBOOK_DURABILITY_TRUST_SET.has(key)) return key;
  return SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL;
}

function normalizeShadowPlaybookPromotionReadinessStatus(value) {
  const key = toText(value).toLowerCase();
  if (SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_SET.has(key)) return key;
  return SHADOW_PLAYBOOK_PROMOTION_READINESS_BLOCKED;
}

function normalizeLateEntryPolicyPromotionStatus(value) {
  const key = toText(value).toLowerCase();
  if (LATE_ENTRY_POLICY_PROMOTION_STATUS_SET.has(key)) return key;
  return LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY;
}

function normalizeLateEntryPolicyReplayStatus(value) {
  const key = toText(value).toLowerCase();
  if (LATE_ENTRY_POLICY_REPLAY_STATUS_SET.has(key)) return key;
  return LATE_ENTRY_POLICY_REPLAY_STATUS_NO_REPLAY_TRADE_EXISTS;
}

function normalizeLateEntryPolicyV2Comparison(value) {
  const key = toText(value).toLowerCase();
  if (LATE_ENTRY_POLICY_V2_COMPARISON_SET.has(key)) return key;
  return LATE_ENTRY_POLICY_V2_COMPARISON_MIXED;
}

function normalizeLateEntryPolicyV3Comparison(value) {
  const key = toText(value).toLowerCase();
  if (LATE_ENTRY_POLICY_V3_COMPARISON_SET.has(key)) return key;
  return LATE_ENTRY_POLICY_V3_COMPARISON_MIXED;
}

function normalizeLateEntryPolicyV4Comparison(value) {
  const key = toText(value).toLowerCase();
  if (LATE_ENTRY_POLICY_V4_COMPARISON_SET.has(key)) return key;
  return LATE_ENTRY_POLICY_V4_COMPARISON_MIXED;
}

function normalizeLateEntryPolicyV5Comparison(value) {
  const key = toText(value).toLowerCase();
  if (LATE_ENTRY_POLICY_V5_COMPARISON_SET.has(key)) return key;
  return LATE_ENTRY_POLICY_V5_COMPARISON_MIXED;
}

function isV2PolicyKey(value = '') {
  return toText(value).toLowerCase() === LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY;
}

function isV3PolicyKey(value = '') {
  return toText(value).toLowerCase() === LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY;
}

function isV4PolicyKey(value = '') {
  return toText(value).toLowerCase() === LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY;
}

function isV5PolicyKey(value = '') {
  return toText(value).toLowerCase() === LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY;
}

function normalizeSourceType(value) {
  const key = toText(value).toLowerCase();
  if (key === SOURCE_BACKFILL) return SOURCE_BACKFILL;
  return SOURCE_LIVE;
}

function normalizeReconstructionPhase(value, sourceType = SOURCE_LIVE) {
  const txt = toText(value).toLowerCase();
  if (txt) return txt;
  return sourceType === SOURCE_BACKFILL ? PHASE_PRE_ORB : PHASE_LIVE_INTRADAY;
}

function normalizeReconstructionVersion(value, sourceType = SOURCE_LIVE) {
  const txt = toText(value);
  if (txt) return txt;
  return sourceType === SOURCE_BACKFILL ? VERSION_BACKFILL : VERSION_LIVE;
}

function tableExists(db, tableName = '') {
  if (!db || typeof db.prepare !== 'function') return false;
  const name = toText(tableName);
  if (!name) return false;
  try {
    const row = db.prepare(`
      SELECT 1 AS ok
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(name);
    return !!row;
  } catch {
    return false;
  }
}

function tableHasColumn(db, tableName = '', columnName = '') {
  if (!db || typeof db.prepare !== 'function') return false;
  const table = toText(tableName);
  const column = toText(columnName).toLowerCase();
  if (!table || !column) return false;
  if (!/^[a-z0-9_]+$/i.test(table) || !/^[a-z0-9_]+$/i.test(column)) return false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => toText(row?.name || '').toLowerCase() === column);
  } catch {
    return false;
  }
}

function sqliteTimestampToMs(value = '') {
  const raw = toText(value);
  if (!raw) return null;
  let iso = raw;
  if (!iso.includes('T')) iso = iso.replace(' ', 'T');
  if (!/[zZ]$/.test(iso) && !/[+-]\d{2}:?\d{2}$/.test(iso)) iso = `${iso}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function inspectTopstepDurabilityDependency(db) {
  const out = {
    topstepSync: {
      tablePresent: false,
      latestStatus: null,
      latestSyncAt: null,
      latestSyncAgeMinutes: null,
      latestOkAt: null,
      latestErrorAt: null,
      stale: false,
      status: 'unknown',
    },
    topstepAutoFeedback: {
      tablePresent: false,
      totalRows: 0,
      latestTradeDate: null,
      latestCreatedAt: null,
    },
  };
  if (!db || typeof db.prepare !== 'function') return out;

  if (tableExists(db, 'topstep_sync_runs')) {
    out.topstepSync.tablePresent = true;
    try {
      const latest = db.prepare(`
        SELECT lower(trim(status)) AS status, created_at
        FROM topstep_sync_runs
        ORDER BY id DESC
        LIMIT 1
      `).get();
      const latestOk = db.prepare(`
        SELECT created_at
        FROM topstep_sync_runs
        WHERE lower(trim(status)) = 'ok'
        ORDER BY id DESC
        LIMIT 1
      `).get();
      const latestError = db.prepare(`
        SELECT created_at
        FROM topstep_sync_runs
        WHERE lower(trim(status)) = 'error'
        ORDER BY id DESC
        LIMIT 1
      `).get();
      const latestStatus = toText(latest?.status || '').toLowerCase() || null;
      const latestSyncAt = toText(latest?.created_at || '') || null;
      const latestSyncMs = sqliteTimestampToMs(latestSyncAt);
      const latestAgeMinutes = Number.isFinite(latestSyncMs)
        ? Math.max(0, round2((Date.now() - latestSyncMs) / (60 * 1000)))
        : null;
      const stale = Number.isFinite(latestAgeMinutes) && latestAgeMinutes > TOPSTEP_SYNC_STALE_THRESHOLD_MINUTES;
      let syncStatus = 'unknown';
      if (latestStatus === 'ok' && !stale) syncStatus = 'healthy';
      else if (latestStatus === 'ok' && stale) syncStatus = 'degraded';
      else if (latestStatus === 'error' || latestStatus === 'partial') syncStatus = 'degraded';
      out.topstepSync = {
        ...out.topstepSync,
        latestStatus,
        latestSyncAt,
        latestSyncAgeMinutes: latestAgeMinutes,
        latestOkAt: toText(latestOk?.created_at || '') || null,
        latestErrorAt: toText(latestError?.created_at || '') || null,
        stale,
        status: syncStatus,
      };
    } catch {}
  }

  if (tableExists(db, 'trade_outcome_feedback')) {
    out.topstepAutoFeedback.tablePresent = true;
    try {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS total_rows,
          MAX(trade_date) AS latest_trade_date,
          MAX(created_at) AS latest_created_at
        FROM trade_outcome_feedback
        WHERE lower(COALESCE(source, '')) = 'topstep_auto'
      `).get();
      out.topstepAutoFeedback.totalRows = Number(row?.total_rows || 0);
      out.topstepAutoFeedback.latestTradeDate = normalizeDate(row?.latest_trade_date || '');
      out.topstepAutoFeedback.latestCreatedAt = toText(row?.latest_created_at || '') || null;
    } catch {}
  }

  return out;
}

function normalizeRealizedTruthSource(value = '') {
  const key = toText(value).toLowerCase();
  if (REALIZED_TRUTH_SOURCE_ENUM.includes(key)) return key;
  return REALIZED_TRUTH_SOURCE_NONE;
}

function toIsoDateMs(value = '') {
  const date = normalizeDate(value);
  if (!date) return null;
  const parts = date.split('-').map((n) => Number(n));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function isoDateDiffDays(laterDate = '', earlierDate = '') {
  const laterMs = toIsoDateMs(laterDate);
  const earlierMs = toIsoDateMs(earlierDate);
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return null;
  return Math.round((laterMs - earlierMs) / 86400000);
}

function addIsoDays(dateValue = '', deltaDays = 0) {
  const ms = toIsoDateMs(dateValue);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + (Number(deltaDays || 0) * 86400000));
  return d.toISOString().slice(0, 10);
}

function buildExternalExecutionAggregate(row = {}, options = {}) {
  const tradeCount = Number(row?.trade_count || 0);
  const wins = Number(row?.wins || 0);
  const losses = Number(row?.losses || 0);
  const breakeven = Number(row?.breakeven || 0);
  const netPnlDollars = round2(Number(row?.net_pnl || 0));
  return {
    hasRows: tradeCount > 0,
    tradeCount,
    wins,
    losses,
    breakeven,
    netPnlDollars,
    sourceBacked: options.sourceBacked === true,
    sourceTable: toText(options.sourceTable || '') || null,
    sourceInUse: normalizeRealizedTruthSource(options.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
  };
}

function emptyExternalExecutionOutcome(options = {}) {
  return {
    hasRows: false,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    netPnlDollars: 0,
    sourceBacked: options.sourceBacked === true,
    sourceTable: toText(options.sourceTable || '') || null,
    sourceInUse: normalizeRealizedTruthSource(options.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
  };
}

function getTopstepDurabilityDependencyCached(db, forceFresh = false) {
  const now = Date.now();
  if (
    !forceFresh
    &&
    topstepDependencyCache.db === db
    && topstepDependencyCache.value
    && (now - Number(topstepDependencyCache.fetchedAtMs || 0)) <= TOPSTEP_DEPENDENCY_CACHE_TTL_MS
  ) {
    return topstepDependencyCache.value;
  }
  const dependency = inspectTopstepDurabilityDependency(db);
  topstepDependencyCache.db = db;
  topstepDependencyCache.fetchedAtMs = now;
  topstepDependencyCache.value = dependency;
  return dependency;
}

function inspectTopstepRecoveryWindow(db, topstepDependency = null) {
  const out = {
    topstepLatestTradeDate: null,
    checkpointLatestTradeDate: null,
    staleWindowStartDate: null,
    staleWindowEndDate: null,
    backfillPending: false,
    staleWindowDays: 0,
  };
  if (!db || typeof db.prepare !== 'function') return out;
  const dependency = topstepDependency || inspectTopstepDurabilityDependency(db);
  const fromFeedback = normalizeDate(dependency?.topstepAutoFeedback?.latestTradeDate || '');
  let fromLinks = '';
  if (tableExists(db, 'topstep_auto_journal_links')) {
    try {
      const row = db.prepare(`
        SELECT MAX(trade_date) AS latest_trade_date
        FROM topstep_auto_journal_links
      `).get();
      fromLinks = normalizeDate(row?.latest_trade_date || '');
    } catch {}
  }
  let checkpointLatest = '';
  if (tableExists(db, 'jarvis_assistant_decision_outcome_checkpoints')) {
    try {
      const row = db.prepare(`
        SELECT MAX(trade_date) AS latest_trade_date
        FROM jarvis_assistant_decision_outcome_checkpoints
      `).get();
      checkpointLatest = normalizeDate(row?.latest_trade_date || '');
    } catch {}
  }
  const topstepLatest = [fromFeedback, fromLinks]
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)))
    .pop() || '';
  out.topstepLatestTradeDate = topstepLatest || null;
  out.checkpointLatestTradeDate = checkpointLatest || null;
  if (checkpointLatest && (!topstepLatest || checkpointLatest > topstepLatest)) {
    out.backfillPending = true;
    out.staleWindowStartDate = topstepLatest ? addIsoDays(topstepLatest, 1) : checkpointLatest;
    out.staleWindowEndDate = checkpointLatest;
    const staleDays = isoDateDiffDays(out.staleWindowEndDate, out.staleWindowStartDate);
    out.staleWindowDays = Number.isFinite(staleDays) ? Math.max(1, staleDays + 1) : 1;
  }
  return out;
}

function getTopstepRecoveryWindowCached(db, topstepDependency = null, forceFresh = false) {
  const now = Date.now();
  if (
    !forceFresh
    &&
    topstepRecoveryWindowCache.db === db
    && topstepRecoveryWindowCache.value
    && (now - Number(topstepRecoveryWindowCache.fetchedAtMs || 0)) <= TOPSTEP_DEPENDENCY_CACHE_TTL_MS
  ) {
    return topstepRecoveryWindowCache.value;
  }
  const recovery = inspectTopstepRecoveryWindow(db, topstepDependency);
  topstepRecoveryWindowCache.db = db;
  topstepRecoveryWindowCache.fetchedAtMs = now;
  topstepRecoveryWindowCache.value = recovery;
  return recovery;
}

function maxIsoDate(values = []) {
  return values
    .map((value) => normalizeDate(value))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)))
    .pop() || '';
}

function minIsoDate(values = []) {
  return values
    .map((value) => normalizeDate(value))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)))
    .shift() || '';
}

function parseUserClaimOutcomeType(text = '') {
  const raw = toText(text).toLowerCase();
  if (!raw) return null;
  if (/\b(won|win|winner|worked|make money|made money|profitable|profit)\b/.test(raw)) return 'win';
  if (/\b(lost|loss|loser|failed|didn't work|didnt work|negative|red day)\b/.test(raw)) return 'loss';
  return null;
}

function parseClaimedTradeDateFromPrompt(prompt = '', createdAt = '', metadata = {}) {
  const raw = toText(prompt).toLowerCase();
  if (!raw) return '';
  const metadataDate = normalizeDate(
    metadata?.tradeDate
    || metadata?.trade_date
    || metadata?.targetTradeDate
    || metadata?.target_trade_date
    || metadata?.date
    || ''
  );
  if (metadataDate) return metadataDate;
  const explicitDate = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (explicitDate?.[1]) return normalizeDate(explicitDate[1]);
  const createdDate = normalizeDate(createdAt);
  if (!createdDate) return '';
  if (/\byesterday\b/.test(raw)) return addIsoDays(createdDate, -1);
  if (/\btoday\b/.test(raw)) return createdDate;
  return createdDate;
}

function detectLatestUserClaimedOutcome(db) {
  const out = {
    latestUserClaimedTradeDate: null,
    claimedOutcomeType: null,
    sourceTable: null,
    claimCreatedAt: null,
    claimPrompt: null,
    status: 'no_user_claim_persisted',
    reason: 'no_persisted_user_claim_detected',
  };
  if (!db || typeof db.prepare !== 'function') return out;
  if (!tableExists(db, 'jarvis_complaints')) return out;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT created_at, prompt, metadata_json
      FROM jarvis_complaints
      ORDER BY id DESC
      LIMIT 200
    `).all();
  } catch {
    return out;
  }
  for (const row of rows) {
    const prompt = toText(row?.prompt || '');
    if (!prompt) continue;
    const promptLower = prompt.toLowerCase();
    const isQuestion = prompt.includes('?')
      || /^(did|do|does|was|were|why|how|what|should|would|can|could|is|are)\b/i.test(promptLower);
    if (isQuestion) continue;
    const outcomeType = parseUserClaimOutcomeType(promptLower);
    if (!outcomeType) continue;
    const metadata = safeJsonParse(row?.metadata_json || '{}', {});
    const claimedTradeDate = parseClaimedTradeDateFromPrompt(promptLower, row?.created_at, metadata);
    if (!claimedTradeDate) continue;
    out.latestUserClaimedTradeDate = claimedTradeDate;
    out.claimedOutcomeType = outcomeType;
    out.sourceTable = 'jarvis_complaints';
    out.claimCreatedAt = toText(row?.created_at || '') || null;
    out.claimPrompt = prompt.slice(0, 240);
    out.status = 'user_claim_detected';
    out.reason = 'persisted_user_claim_detected_from_jarvis_complaints';
    break;
  }
  return out;
}

function buildLatestDayTruthGapDiagnostics(db, input = {}) {
  const out = {
    latest_internal_trade_date: null,
    latest_external_finalized_trade_date: null,
    latest_user_claimed_trade_date: null,
    truth_gap_days: null,
    truth_gap_status: 'unavailable',
    truth_gap_reason: 'insufficient_latest_day_data',
    truth_gap_blocking_layer: 'unknown',
    truth_gap_repair_path: [
      'run_topstep_sync',
      'run_topstep_auto_journal',
      'recompute_recommendation_performance',
    ],
    latest_day_accountability_status: 'unavailable',
    latest_day_accountability_line: 'Latest day accountability is unavailable.',
    latest_day_layer_trace: {},
    user_claim_verification: {
      status: 'no_user_claim_persisted',
      reason: 'no_persisted_user_claim_detected',
      source: null,
      claimed_outcome: null,
      claimed_trade_date: null,
    },
  };
  if (!db || typeof db.prepare !== 'function') return out;

  const queryMaxDate = (sql, params = []) => {
    try {
      const row = db.prepare(sql).get(...params);
      return normalizeDate(row?.v || row?.max_date || row?.trade_date || row?.rec_date || '');
    } catch {
      return '';
    }
  };
  const countForDate = (sql, params = []) => {
    try {
      const row = db.prepare(sql).get(...params);
      return Number(row?.c || 0);
    } catch {
      return 0;
    }
  };
  const parseTopstepDate = (value = '') => {
    const txt = toText(value);
    if (!txt) return '';
    if (txt.includes('T')) return normalizeDate(txt);
    if (txt.includes(' ')) return normalizeDate(txt);
    return normalizeDate(txt);
  };

  let topstepFillsMax = '';
  if (tableExists(db, 'topstep_fills')) {
    try {
      const row = db.prepare(`SELECT MAX(fill_time) AS v FROM topstep_fills`).get();
      topstepFillsMax = parseTopstepDate(row?.v || '');
    } catch {}
  }
  const topstepLinksMax = tableExists(db, 'topstep_auto_journal_links')
    ? queryMaxDate(`SELECT MAX(trade_date) AS v FROM topstep_auto_journal_links`)
    : '';
  const topstepFeedbackMax = tableExists(db, 'trade_outcome_feedback')
    ? queryMaxDate(`SELECT MAX(trade_date) AS v FROM trade_outcome_feedback WHERE lower(COALESCE(source,'')) = 'topstep_auto'`)
    : '';
  const checkpointMax = tableExists(db, 'jarvis_assistant_decision_outcome_checkpoints')
    ? queryMaxDate(`SELECT MAX(trade_date) AS v FROM jarvis_assistant_decision_outcome_checkpoints`)
    : '';
  const historyMax = tableExists(db, 'jarvis_recommendation_outcome_history')
    ? queryMaxDate(`
      SELECT MAX(rec_date) AS v
      FROM jarvis_recommendation_outcome_history
      WHERE lower(COALESCE(source_type,'')) = 'live'
        AND lower(COALESCE(reconstruction_phase,'')) = 'live_intraday'
    `)
    : '';
  const shadowMax = tableExists(db, 'jarvis_shadow_playbook_daily')
    ? queryMaxDate(`
      SELECT MAX(trade_date) AS v
      FROM jarvis_shadow_playbook_daily
      WHERE playbook_key = ?
        AND playbook_version = ?
    `, [
      SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
      SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
    ])
    : '';
  const durabilityMax = tableExists(db, 'jarvis_shadow_playbook_durability_summary')
    ? queryMaxDate(`
      SELECT MAX(as_of_trade_date) AS v
      FROM jarvis_shadow_playbook_durability_summary
      WHERE playbook_key = ?
        AND playbook_version = ?
    `, [
      SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
      SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
    ])
    : '';

  const latestInternalTradeDate = maxIsoDate([checkpointMax, historyMax, shadowMax]);
  const latestExternalTradeDate = maxIsoDate([topstepFillsMax, topstepLinksMax, topstepFeedbackMax]);
  out.latest_internal_trade_date = latestInternalTradeDate || null;
  out.latest_external_finalized_trade_date = latestExternalTradeDate || null;
  out.truth_gap_days = Number.isFinite(isoDateDiffDays(latestInternalTradeDate, latestExternalTradeDate))
    ? Math.max(0, Number(isoDateDiffDays(latestInternalTradeDate, latestExternalTradeDate)))
    : null;

  const latestUserClaim = detectLatestUserClaimedOutcome(db);
  out.latest_user_claimed_trade_date = latestUserClaim.latestUserClaimedTradeDate || null;

  const targetDate = latestInternalTradeDate || latestExternalTradeDate || latestUserClaim.latestUserClaimedTradeDate || '';
  const layerTrace = {
    target_trade_date: targetDate || null,
    topstep_fills_rows: targetDate && tableExists(db, 'topstep_fills')
      ? countForDate(`SELECT COUNT(*) AS c FROM topstep_fills WHERE date(fill_time) = ?`, [targetDate])
      : 0,
    topstep_auto_journal_links_rows: targetDate && tableExists(db, 'topstep_auto_journal_links')
      ? countForDate(`SELECT COUNT(*) AS c FROM topstep_auto_journal_links WHERE trade_date = ?`, [targetDate])
      : 0,
    trade_outcome_feedback_rows: targetDate && tableExists(db, 'trade_outcome_feedback')
      ? countForDate(`
        SELECT COUNT(*) AS c
        FROM trade_outcome_feedback
        WHERE trade_date = ?
          AND lower(COALESCE(source,'')) = 'topstep_auto'
      `, [targetDate])
      : 0,
    checkpoint_rows: targetDate && tableExists(db, 'jarvis_assistant_decision_outcome_checkpoints')
      ? countForDate(`SELECT COUNT(*) AS c FROM jarvis_assistant_decision_outcome_checkpoints WHERE trade_date = ?`, [targetDate])
      : 0,
    recommendation_outcome_history_rows: targetDate && tableExists(db, 'jarvis_recommendation_outcome_history')
      ? countForDate(`
        SELECT COUNT(*) AS c
        FROM jarvis_recommendation_outcome_history
        WHERE rec_date = ?
          AND lower(COALESCE(source_type,'')) = 'live'
          AND lower(COALESCE(reconstruction_phase,'')) = 'live_intraday'
      `, [targetDate])
      : 0,
    shadow_playbook_rows: targetDate && tableExists(db, 'jarvis_shadow_playbook_daily')
      ? countForDate(`
        SELECT COUNT(*) AS c
        FROM jarvis_shadow_playbook_daily
        WHERE trade_date = ?
          AND playbook_key = ?
          AND playbook_version = ?
      `, [targetDate, SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY, SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION])
      : 0,
    durability_summary_rows: targetDate && tableExists(db, 'jarvis_shadow_playbook_durability_summary')
      ? countForDate(`
        SELECT COUNT(*) AS c
        FROM jarvis_shadow_playbook_durability_summary
        WHERE as_of_trade_date = ?
          AND playbook_key = ?
          AND playbook_version = ?
      `, [targetDate, SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY, SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION])
      : 0,
    latest_dates: {
      topstep_fills: topstepFillsMax || null,
      topstep_auto_journal_links: topstepLinksMax || null,
      trade_outcome_feedback: topstepFeedbackMax || null,
      checkpoint: checkpointMax || null,
      recommendation_outcome_history: historyMax || null,
      shadow_playbook: shadowMax || null,
      durability_summary: durabilityMax || null,
    },
  };
  out.latest_day_layer_trace = layerTrace;

  const externalFinalizedForTarget = (
    Number(layerTrace.topstep_auto_journal_links_rows || 0) > 0
    || Number(layerTrace.trade_outcome_feedback_rows || 0) > 0
    || Number(layerTrace.topstep_fills_rows || 0) > 0
  );
  const hasInternalInferenceForTarget = (
    Number(layerTrace.checkpoint_rows || 0) > 0
    || Number(layerTrace.recommendation_outcome_history_rows || 0) > 0
  );
  const hasShadowForTarget = Number(layerTrace.shadow_playbook_rows || 0) > 0;

  if (latestInternalTradeDate && latestExternalTradeDate && latestInternalTradeDate > latestExternalTradeDate) {
    out.truth_gap_status = 'external_truth_lagging_internal';
    out.truth_gap_reason = 'latest_internal_trade_date_exceeds_latest_external_finalized_trade_date';
    out.truth_gap_blocking_layer = 'upstream_external_realized_truth_absence';
  } else if (latestInternalTradeDate && latestExternalTradeDate && latestInternalTradeDate <= latestExternalTradeDate) {
    out.truth_gap_status = 'no_gap';
    out.truth_gap_reason = 'latest_external_truth_covers_latest_internal_trade_date';
    out.truth_gap_blocking_layer = 'none';
  } else if (latestInternalTradeDate && !latestExternalTradeDate) {
    out.truth_gap_status = 'external_truth_unavailable';
    out.truth_gap_reason = 'no_external_finalized_truth_available';
    out.truth_gap_blocking_layer = 'upstream_external_realized_truth_absence';
  } else if (!latestInternalTradeDate && latestExternalTradeDate) {
    out.truth_gap_status = 'internal_layers_missing_latest_trade_date';
    out.truth_gap_reason = 'external_truth_exists_but_internal_latest_trade_date_missing';
    out.truth_gap_blocking_layer = 'internal_propagation';
  }

  if (latestUserClaim.latestUserClaimedTradeDate) {
    const claimDate = latestUserClaim.latestUserClaimedTradeDate;
    const claimOutcome = latestUserClaim.claimedOutcomeType;
    let externalNetForClaim = null;
    if (tableExists(db, 'topstep_auto_journal_links')) {
      try {
        const row = db.prepare(`
          SELECT COUNT(*) AS trade_count, ROUND(SUM(COALESCE(pnl_dollars, 0)), 2) AS net_pnl
          FROM topstep_auto_journal_links
          WHERE trade_date = ?
        `).get(claimDate);
        if (Number(row?.trade_count || 0) > 0) {
          externalNetForClaim = toNumber(row?.net_pnl, null);
        }
      } catch {}
    }
    if (!Number.isFinite(externalNetForClaim) && tableExists(db, 'trade_outcome_feedback')) {
      try {
        const row = db.prepare(`
          SELECT COUNT(*) AS trade_count, ROUND(SUM(COALESCE(pnl_dollars, 0)), 2) AS net_pnl
          FROM trade_outcome_feedback
          WHERE trade_date = ?
            AND lower(COALESCE(source,'')) = 'topstep_auto'
        `).get(claimDate);
        if (Number(row?.trade_count || 0) > 0) {
          externalNetForClaim = toNumber(row?.net_pnl, null);
        }
      } catch {}
    }
    let userClaimStatus = 'user_claim_pending_external_verification';
    let userClaimReason = 'external_truth_missing_for_claimed_trade_date';
    if (Number.isFinite(externalNetForClaim)) {
      if (claimOutcome === 'win' && externalNetForClaim > 0) {
        userClaimStatus = 'user_claim_matches_external_truth';
        userClaimReason = 'claim_direction_matches_external_net_pnl';
      } else if (claimOutcome === 'loss' && externalNetForClaim < 0) {
        userClaimStatus = 'user_claim_matches_external_truth';
        userClaimReason = 'claim_direction_matches_external_net_pnl';
      } else if (claimOutcome && externalNetForClaim !== 0) {
        userClaimStatus = 'user_claim_conflicts_with_external_truth';
        userClaimReason = 'claim_direction_conflicts_with_external_net_pnl';
      } else {
        userClaimStatus = 'user_claim_present_external_truth_inconclusive';
        userClaimReason = 'external_net_pnl_is_flat_or_claim_outcome_unknown';
      }
    } else if (latestExternalTradeDate && claimDate <= latestExternalTradeDate) {
      userClaimStatus = 'user_claim_conflicts_with_persisted_truth_availability';
      userClaimReason = 'claim_date_within_external_coverage_window_but_no_rows_present';
    }
    out.user_claim_verification = {
      status: userClaimStatus,
      reason: userClaimReason,
      source: latestUserClaim.sourceTable || null,
      claimed_outcome: claimOutcome || null,
      claimed_trade_date: claimDate,
      claim_created_at: latestUserClaim.claimCreatedAt || null,
      claim_prompt_excerpt: latestUserClaim.claimPrompt || null,
    };
    if (
      userClaimStatus === 'user_claim_pending_external_verification'
      || userClaimStatus === 'user_claim_conflicts_with_persisted_truth_availability'
    ) {
      out.truth_gap_status = 'user_claim_pending_external_verification';
      out.truth_gap_reason = userClaimReason;
      out.truth_gap_blocking_layer = 'upstream_external_realized_truth_absence';
    }
  }

  if (externalFinalizedForTarget) {
    out.latest_day_accountability_status = 'externally_finalized';
    out.latest_day_accountability_line = `Latest day ${targetDate || 'unknown'} is externally finalized by Topstep-linked truth.`;
  } else if (
    out.user_claim_verification.status === 'user_claim_pending_external_verification'
    || out.user_claim_verification.status === 'user_claim_conflicts_with_persisted_truth_availability'
  ) {
    out.latest_day_accountability_status = 'user_claimed_but_unverified';
    out.latest_day_accountability_line = `Latest day ${targetDate || out.user_claim_verification.claimed_trade_date || 'unknown'} has a user-claimed outcome, but external finalized truth is still unavailable.`;
  } else if (hasInternalInferenceForTarget) {
    out.latest_day_accountability_status = hasShadowForTarget ? 'internally_inferred_only' : 'internally_inferred_only';
    out.latest_day_accountability_line = `Latest day ${targetDate || 'unknown'} is internally inferred only (checkpoint/history${hasShadowForTarget ? ' + shadow' : ''}), not externally finalized.`;
  } else if (hasShadowForTarget) {
    out.latest_day_accountability_status = 'shadow_only';
    out.latest_day_accountability_line = `Latest day ${targetDate || 'unknown'} has shadow-only evaluation and is not externally finalized.`;
  } else {
    out.latest_day_accountability_status = 'unavailable';
    out.latest_day_accountability_line = `Latest day ${targetDate || 'unknown'} has no externally finalized or internal accountability rows.`;
  }

  if (out.truth_gap_blocking_layer === 'upstream_external_realized_truth_absence') {
    out.truth_gap_repair_path = [
      'run_topstep_sync',
      'run_topstep_auto_journal',
      'recompute_recommendation_performance',
      'refresh_command_center_surfaces',
    ];
  } else if (out.truth_gap_blocking_layer === 'internal_propagation') {
    out.truth_gap_repair_path = [
      'recompute_recommendation_performance',
      'recompute_daily_scoring_finalization',
      'refresh_command_center_surfaces',
    ];
  } else if (out.truth_gap_blocking_layer === 'none') {
    out.truth_gap_repair_path = [];
  }

  return out;
}

function resolveExternalExecutionOutcomeForDate(db, recDate = '') {
  const date = normalizeDate(recDate);
  if (!date || !db || typeof db.prepare !== 'function') {
    return {
      ...emptyExternalExecutionOutcome({
        sourceTable: 'trade_outcome_feedback',
        sourceInUse: REALIZED_TRUTH_SOURCE_NONE,
      }),
      trustClassification: REALIZED_TRUTH_TRUST_UNTRUSTWORTHY,
      trustReasonCodes: ['db_or_date_unavailable'],
      sourceAttribution: {
        primarySource: REALIZED_TRUTH_SOURCE_PRIMARY,
        sourceInUse: REALIZED_TRUTH_SOURCE_NONE,
        fallbackSourceInUse: null,
        sourceLevel: 'none',
        sourceFreshness: {
          latestTopstepSyncAt: null,
          latestTopstepTruthTradeDate: null,
          targetTradeDate: date || null,
          targetDateInStaleWindow: false,
        },
        sourceLadder: {},
        recoveryPlan: {
          backfillPending: false,
          staleWindowStartDate: null,
          staleWindowEndDate: null,
          staleWindowDays: 0,
          targetDateInStaleWindow: false,
          deterministicActions: [
            'restore_topstep_credentials_or_access',
            'run_topstep_sync',
            'run_topstep_auto_journal',
            'recompute_recommendation_performance',
          ],
        },
      },
    };
  }

  const topstepDependency = getTopstepDurabilityDependencyCached(db);
  const recoveryWindow = getTopstepRecoveryWindowCached(db, topstepDependency);

  let primary = emptyExternalExecutionOutcome({
    sourceTable: 'topstep_auto_journal_links',
    sourceInUse: REALIZED_TRUTH_SOURCE_PRIMARY,
    sourceBacked: true,
  });
  if (tableExists(db, 'topstep_auto_journal_links')) {
    try {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS trade_count,
          SUM(CASE WHEN t.pnl_dollars > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN t.pnl_dollars < 0 THEN 1 ELSE 0 END) AS losses,
          SUM(CASE WHEN ABS(t.pnl_dollars) < 0.000001 THEN 1 ELSE 0 END) AS breakeven,
          ROUND(SUM(COALESCE(t.pnl_dollars, 0)), 2) AS net_pnl
        FROM (
          SELECT
            COALESCE(l.feedback_id, l.external_fill_id) AS trade_key,
            COALESCE(MAX(f.pnl_dollars), MAX(l.pnl_dollars), 0) AS pnl_dollars
          FROM topstep_auto_journal_links l
          LEFT JOIN trade_outcome_feedback f ON f.id = l.feedback_id
          WHERE l.trade_date = ?
          GROUP BY COALESCE(l.feedback_id, l.external_fill_id)
        ) t
      `).get(date);
      primary = buildExternalExecutionAggregate(row, {
        sourceBacked: true,
        sourceTable: 'topstep_auto_journal_links',
        sourceInUse: REALIZED_TRUTH_SOURCE_PRIMARY,
      });
    } catch {}
  }

  let secondary = emptyExternalExecutionOutcome({
    sourceTable: 'trade_outcome_feedback',
    sourceInUse: REALIZED_TRUTH_SOURCE_SECONDARY,
    sourceBacked: true,
  });
  if (tableExists(db, 'trade_outcome_feedback')) {
    try {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS trade_count,
          SUM(CASE WHEN lower(outcome) = 'win' THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN lower(outcome) = 'loss' THEN 1 ELSE 0 END) AS losses,
          SUM(CASE WHEN lower(outcome) = 'breakeven' THEN 1 ELSE 0 END) AS breakeven,
          ROUND(SUM(COALESCE(pnl_dollars, 0)), 2) AS net_pnl
        FROM trade_outcome_feedback
        WHERE trade_date = ?
          AND lower(COALESCE(source, '')) = 'topstep_auto'
          AND lower(COALESCE(setup_id, '')) NOT LIKE 'deep_reliability_%'
      `).get(date);
      secondary = buildExternalExecutionAggregate(row, {
        sourceBacked: true,
        sourceTable: 'trade_outcome_feedback',
        sourceInUse: REALIZED_TRUTH_SOURCE_SECONDARY,
      });
    } catch {}
  }

  let tertiary = emptyExternalExecutionOutcome({
    sourceTable: 'trades',
    sourceInUse: REALIZED_TRUTH_SOURCE_TERTIARY,
    sourceBacked: false,
  });
  if (tableExists(db, 'trades')) {
    try {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS trade_count,
          SUM(CASE WHEN lower(COALESCE(result, '')) = 'win' OR COALESCE(pnl_dollars, 0) > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN lower(COALESCE(result, '')) = 'loss' OR COALESCE(pnl_dollars, 0) < 0 THEN 1 ELSE 0 END) AS losses,
          SUM(CASE WHEN lower(COALESCE(result, '')) = 'breakeven' OR ABS(COALESCE(pnl_dollars, 0)) < 0.000001 THEN 1 ELSE 0 END) AS breakeven,
          ROUND(SUM(COALESCE(pnl_dollars, 0)), 2) AS net_pnl
        FROM trades
        WHERE date = ?
      `).get(date);
      tertiary = buildExternalExecutionAggregate(row, {
        sourceBacked: false,
        sourceTable: 'trades',
        sourceInUse: REALIZED_TRUTH_SOURCE_TERTIARY,
      });
    } catch {}
  }

  let chosen = emptyExternalExecutionOutcome({
    sourceTable: 'trade_outcome_feedback',
    sourceInUse: REALIZED_TRUTH_SOURCE_NONE,
  });
  let sourceLevel = 'none';
  let fallbackSourceInUse = null;
  if (primary.hasRows) {
    chosen = { ...primary };
    sourceLevel = 'primary';
  } else if (secondary.hasRows) {
    chosen = { ...secondary };
    sourceLevel = 'secondary';
    fallbackSourceInUse = REALIZED_TRUTH_SOURCE_SECONDARY;
  } else if (tertiary.hasRows) {
    chosen = { ...tertiary };
    sourceLevel = 'tertiary';
    fallbackSourceInUse = REALIZED_TRUTH_SOURCE_TERTIARY;
  }

  const targetDateInStaleWindow = recoveryWindow.backfillPending === true
    && !!date
    && !!recoveryWindow.staleWindowStartDate
    && !!recoveryWindow.staleWindowEndDate
    && date >= String(recoveryWindow.staleWindowStartDate)
    && date <= String(recoveryWindow.staleWindowEndDate);
  const topstepSyncStatus = toText(topstepDependency?.topstepSync?.status || '').toLowerCase() || 'unknown';
  const trustReasonCodes = [];
  let trustClassification = REALIZED_TRUTH_TRUST_SAFE;
  if (sourceLevel === 'secondary') {
    trustClassification = REALIZED_TRUTH_TRUST_PARTIAL;
    trustReasonCodes.push('primary_topstep_link_unavailable');
  } else if (sourceLevel === 'tertiary') {
    trustClassification = REALIZED_TRUTH_TRUST_UNTRUSTWORTHY;
    trustReasonCodes.push('external_topstep_truth_unavailable_internal_only');
  } else if (sourceLevel === 'none') {
    trustClassification = targetDateInStaleWindow || topstepSyncStatus === 'degraded'
      ? REALIZED_TRUTH_TRUST_UNTRUSTWORTHY
      : REALIZED_TRUTH_TRUST_PARTIAL;
    trustReasonCodes.push('no_realized_outcome_rows_for_date');
  }
  if (topstepSyncStatus === 'degraded' && sourceLevel !== 'primary') {
    if (trustClassification === REALIZED_TRUTH_TRUST_SAFE) {
      trustClassification = REALIZED_TRUTH_TRUST_PARTIAL;
    }
    trustReasonCodes.push('topstep_sync_degraded');
  }
  if (targetDateInStaleWindow) trustReasonCodes.push('target_date_in_topstep_stale_window');

  const sourceLadder = {
    [REALIZED_TRUTH_SOURCE_PRIMARY]: {
      source: REALIZED_TRUTH_SOURCE_PRIMARY,
      table: primary.sourceTable || 'topstep_auto_journal_links',
      hasRows: primary.hasRows === true,
      tradeCount: Number(primary.tradeCount || 0),
      netPnlDollars: round2(Number(primary.netPnlDollars || 0)),
      sourceBacked: true,
    },
    [REALIZED_TRUTH_SOURCE_SECONDARY]: {
      source: REALIZED_TRUTH_SOURCE_SECONDARY,
      table: secondary.sourceTable || 'trade_outcome_feedback',
      hasRows: secondary.hasRows === true,
      tradeCount: Number(secondary.tradeCount || 0),
      netPnlDollars: round2(Number(secondary.netPnlDollars || 0)),
      sourceBacked: true,
    },
    [REALIZED_TRUTH_SOURCE_TERTIARY]: {
      source: REALIZED_TRUTH_SOURCE_TERTIARY,
      table: tertiary.sourceTable || 'trades',
      hasRows: tertiary.hasRows === true,
      tradeCount: Number(tertiary.tradeCount || 0),
      netPnlDollars: round2(Number(tertiary.netPnlDollars || 0)),
      sourceBacked: false,
    },
  };

  return {
    ...chosen,
    trustClassification,
    trustReasonCodes: Array.from(new Set(trustReasonCodes)),
    sourceAttribution: {
      primarySource: REALIZED_TRUTH_SOURCE_PRIMARY,
      sourceInUse: chosen.sourceInUse || REALIZED_TRUTH_SOURCE_NONE,
      fallbackSourceInUse,
      sourceLevel,
      sourceFreshness: {
        latestTopstepSyncAt: topstepDependency?.topstepSync?.latestSyncAt || null,
        latestTopstepSyncStatus: topstepSyncStatus,
        latestTopstepTruthTradeDate: recoveryWindow.topstepLatestTradeDate || null,
        targetTradeDate: date || null,
        targetDateInStaleWindow,
        sourceLagDays: Number.isFinite(isoDateDiffDays(date, recoveryWindow.topstepLatestTradeDate))
          ? Math.max(0, Number(isoDateDiffDays(date, recoveryWindow.topstepLatestTradeDate)))
          : null,
      },
      sourceLadder,
      recoveryPlan: {
        backfillPending: recoveryWindow.backfillPending === true,
        staleWindowStartDate: recoveryWindow.staleWindowStartDate || null,
        staleWindowEndDate: recoveryWindow.staleWindowEndDate || null,
        staleWindowDays: Number(recoveryWindow.staleWindowDays || 0),
        targetDateInStaleWindow,
        deterministicActions: [
          'restore_topstep_credentials_or_access',
          'run_topstep_sync',
          'run_topstep_auto_journal',
          'recompute_recommendation_performance',
        ],
      },
    },
  };
}

function parseMinuteOfDay(value = '') {
  const token = toText(value);
  if (!token) return null;
  const parts = token.split(':').map((n) => Number(n));
  if (parts.length < 2 || !parts.every((n, idx) => idx < 2 ? Number.isFinite(n) : true)) return null;
  const hh = parts[0];
  const mm = parts[1];
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return (hh * 60) + mm;
}

function extractCandleTimeToken(candle = {}) {
  const explicit = toText(candle?.time || '');
  if (explicit) {
    const m = explicit.match(/(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  const stamp = toText(candle?.timestamp || candle?.ts || candle?.datetime || '');
  if (!stamp) return '';
  const m = stamp.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function normalizeShadowCandleRows(candles = []) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((candle, idx) => {
      const open = toNumber(candle?.open, null);
      const high = toNumber(candle?.high, null);
      const low = toNumber(candle?.low, null);
      const close = toNumber(candle?.close, null);
      const timeToken = extractCandleTimeToken(candle);
      const minuteOfDay = parseMinuteOfDay(timeToken);
      const validOhlc = Number.isFinite(open)
        && Number.isFinite(high)
        && Number.isFinite(low)
        && Number.isFinite(close)
        && high >= low;
      return {
        idx,
        timestamp: toText(candle?.timestamp || candle?.ts || candle?.datetime || '') || null,
        timeToken: timeToken || null,
        minuteOfDay,
        open,
        high,
        low,
        close,
        validOhlc,
      };
    })
    .filter((row) => row.minuteOfDay != null)
    .sort((a, b) => {
      if (a.minuteOfDay !== b.minuteOfDay) return a.minuteOfDay - b.minuteOfDay;
      return a.idx - b.idx;
    });
}

function resolveContextSignalContext(contextJson = {}) {
  const ctx = contextJson && typeof contextJson === 'object' ? contextJson : {};
  const nestedRegime = ctx.regime && typeof ctx.regime === 'object'
    ? ctx.regime
    : {};
  const nestedRegimeMetrics = nestedRegime.metrics && typeof nestedRegime.metrics === 'object'
    ? nestedRegime.metrics
    : {};
  const recommendationBasis = ctx.recommendationBasis && typeof ctx.recommendationBasis === 'object'
    ? ctx.recommendationBasis
    : {};
  const regimeDetection = ctx.regimeDetection && typeof ctx.regimeDetection === 'object'
    ? ctx.regimeDetection
    : {};
  const evidenceSignals = regimeDetection.evidenceSignals && typeof regimeDetection.evidenceSignals === 'object'
    ? regimeDetection.evidenceSignals
    : {};
  const trend = normalizeToken(
    ctx.regimeTrend
    || ctx.regime_trend
    || nestedRegime.regime_trend
    || evidenceSignals.trendProfile
    || recommendationBasis.regimeTrend
    || ctx.trend
  );
  const volatility = normalizeToken(
    ctx.regimeVolatility
    || ctx.regime_volatility
    || nestedRegime.regime_vol
    || evidenceSignals.volatilityProfile
    || recommendationBasis.regimeVolatility
    || ctx.volatility
  );
  const orbProfile = normalizeToken(
    ctx.regimeOrbSize
    || ctx.regime_orb_size
    || nestedRegime.regime_orb_size
    || evidenceSignals.orbProfile
    || recommendationBasis.regimeOrbSize
    || ctx.orbProfile
  );
  const orbRangeTicks = toNumber(
    ctx.orbRangeTicks
    ?? ctx.orb_range_ticks
    ?? nestedRegime.orbRangeTicks
    ?? nestedRegime.orb_range_ticks
    ?? nestedRegimeMetrics.orbRangeTicks
    ?? nestedRegimeMetrics.orb_range_ticks
    ?? evidenceSignals.orbRangeTicks
    ?? evidenceSignals.orb_range_ticks
    ?? recommendationBasis.orbRangeTicks
    ?? recommendationBasis.orb_range_ticks,
    null
  );
  const wideOrb = orbProfile === 'wide' || (Number.isFinite(orbRangeTicks) && orbRangeTicks >= 240);
  return {
    trend,
    volatility,
    orbProfile,
    orbRangeTicks: Number.isFinite(orbRangeTicks) ? round2(orbRangeTicks) : null,
    wideOrb,
    highRiskContext: trend === 'ranging' && volatility === 'extreme' && wideOrb,
  };
}

function buildShadowPlaybookOrbOverlapLabel(input = {}) {
  const shadowResult = toText(input.shadowResult || '').toLowerCase();
  const orb = input.orbOutcome && typeof input.orbOutcome === 'object' ? input.orbOutcome : null;
  if (!orb) return 'orb_outcome_unavailable';
  const orbWouldTrade = orb.wouldTrade === true;
  const orbPnl = toNumber(orb.pnlDollars, 0);
  const orbWin = orbWouldTrade && orbPnl > 0;
  if (!orbWouldTrade) {
    if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) return 'shadow_win_orb_no_trade';
    if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) return 'shadow_loss_orb_no_trade';
    if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) return 'shadow_flat_orb_no_trade';
    return 'both_no_trade';
  }
  if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN && orbWin) return 'both_win';
  if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS && !orbWin) return 'both_loss';
  if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN && !orbWin) return 'shadow_win_orb_loss';
  if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS && orbWin) return 'orb_win_shadow_loss';
  if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT && orbWin) return 'orb_win_shadow_flat';
  if (shadowResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT && !orbWin) return 'shadow_flat_orb_loss_or_flat';
  return 'mixed_or_unclear';
}

function normalizeShadowPlaybookLaneLabel(value) {
  const key = toText(value).toLowerCase();
  if (SHADOW_PLAYBOOK_LANE_LABEL_SET.has(key)) return key;
  return SHADOW_PLAYBOOK_LANE_NEUTRAL;
}

function classifyFailedExtensionReversalFadeShadowLane(input = {}) {
  const eligible = input.eligible === true;
  const highRiskContext = input.highRiskContext === true;
  const blockerState = normalizeToken(input.blockerState || '');
  const blocked = blockerState === 'blocked';
  const divergenceDetected = input.divergenceDetected === true;
  const overlap = toText(input.orbOverlapLabel || '').toLowerCase();
  const hypotheticalResult = toText(input.hypotheticalResult || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE).toLowerCase();
  const orbWouldTrade = input.orbWouldTrade === true;
  const orbTradeResult = normalizeToken(input.orbTradeResult || '');
  const orbPnlDollars = toNumber(input.orbPnlDollars, null);

  const reasonCodes = [];
  let greenScore = 0;
  let redScore = 0;

  if (!eligible) {
    reasonCodes.push('shadow_not_eligible');
    return {
      laneLabel: SHADOW_PLAYBOOK_LANE_NEUTRAL,
      laneReasonCodes: reasonCodes,
      laneScore: 0,
      highConvictionLaneMatch: false,
    };
  }

  if (highRiskContext) {
    greenScore += 18;
    reasonCodes.push('high_risk_context_support');
  }
  if (blocked) {
    greenScore += 20;
    reasonCodes.push('blocked_day_support');
  }
  if (divergenceDetected) {
    greenScore += 24;
    reasonCodes.push('divergence_day_support');
  }

  const orbNoTradeOverlap = overlap === 'shadow_win_orb_no_trade'
    || overlap === 'shadow_loss_orb_no_trade'
    || overlap === 'shadow_flat_orb_no_trade'
    || overlap === 'both_no_trade';
  const orbWinOverlap = overlap === 'orb_win_shadow_loss'
    || overlap === 'orb_win_shadow_flat'
    || overlap === 'both_win';
  const orbWinFromOutcome = orbWouldTrade
    && (orbTradeResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN || (Number.isFinite(orbPnlDollars) && orbPnlDollars > 0));
  const orbNoTradeFromOutcome = !orbWouldTrade && (orbTradeResult === '' || orbTradeResult === 'no_trade');

  if (orbNoTradeOverlap || orbNoTradeFromOutcome) {
    greenScore += 28;
    reasonCodes.push('orb_no_trade_support');
  }
  if (orbWinOverlap || orbWinFromOutcome) {
    redScore += 34;
    reasonCodes.push('orb_win_conflict');
  }

  if (hypotheticalResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) {
    greenScore += 10;
    reasonCodes.push('shadow_win_support');
  } else if (hypotheticalResult === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) {
    redScore += 12;
    reasonCodes.push('shadow_loss_risk');
  }

  if (overlap === 'shadow_win_orb_loss') {
    greenScore += 8;
    reasonCodes.push('shadow_beats_orb');
  } else if (overlap === 'both_loss') {
    redScore += 10;
    reasonCodes.push('both_loss_risk');
  } else if (overlap === 'mixed_or_unclear' || overlap === 'orb_outcome_unavailable') {
    redScore += 6;
    reasonCodes.push('overlap_unclear');
  }

  let laneLabel = SHADOW_PLAYBOOK_LANE_NEUTRAL;
  const scoreGap = greenScore - redScore;
  if (scoreGap >= 8 && greenScore >= 35) laneLabel = SHADOW_PLAYBOOK_LANE_GREEN;
  else if (scoreGap <= -8 && redScore >= 35) laneLabel = SHADOW_PLAYBOOK_LANE_RED;

  const laneScore = round2(Math.max(0, Math.min(100, Math.max(greenScore, redScore))));
  const highConvictionLaneMatch = laneLabel === SHADOW_PLAYBOOK_LANE_GREEN
    && (blocked || divergenceDetected || orbNoTradeOverlap || orbNoTradeFromOutcome);
  return {
    laneLabel,
    laneReasonCodes: Array.from(new Set(reasonCodes)),
    laneScore,
    highConvictionLaneMatch,
  };
}

function splitFailedExtensionLaneReasonCodes(reasonCodes = []) {
  const codes = Array.isArray(reasonCodes)
    ? reasonCodes.map((code) => toText(code)).filter(Boolean)
    : [];
  const preDecisionSafeReasonCodes = [];
  const removedHindsightReasonCodes = [];
  for (const code of codes) {
    if (SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET.has(code)) {
      preDecisionSafeReasonCodes.push(code);
    } else {
      removedHindsightReasonCodes.push(code);
    }
  }
  return {
    preDecisionSafeReasonCodes: Array.from(new Set(preDecisionSafeReasonCodes)),
    removedHindsightReasonCodes: Array.from(new Set(removedHindsightReasonCodes)),
  };
}

function classifyFailedExtensionReversalFadeShadowPredecisionLane(input = {}) {
  const eligible = input.eligible === true;
  const highRiskContext = input.highRiskContext === true;
  const blockerState = normalizeToken(input.blockerState || '');
  const blocked = blockerState === 'blocked';
  const reasonCodes = [];
  let greenScore = 0;
  if (!eligible) {
    return {
      laneLabel: SHADOW_PLAYBOOK_LANE_NEUTRAL,
      laneReasonCodes: ['shadow_not_eligible'],
      laneScore: 0,
      highConvictionLaneMatch: false,
    };
  }
  if (highRiskContext) {
    greenScore += 18;
    reasonCodes.push('high_risk_context_support');
  }
  if (blocked) {
    greenScore += 20;
    reasonCodes.push('blocked_day_support');
  }
  const laneLabel = greenScore >= 35
    ? SHADOW_PLAYBOOK_LANE_GREEN
    : SHADOW_PLAYBOOK_LANE_NEUTRAL;
  return {
    laneLabel,
    laneReasonCodes: reasonCodes,
    laneScore: round2(Math.max(0, Math.min(100, greenScore))),
    highConvictionLaneMatch: laneLabel === SHADOW_PLAYBOOK_LANE_GREEN,
  };
}

function evaluateFailedExtensionReversalFadeShadow(input = {}) {
  const date = normalizeDate(input.date || '');
  const contextJson = input.contextJson && typeof input.contextJson === 'object'
    ? input.contextJson
    : {};
  const orbOutcome = input.orbOutcome && typeof input.orbOutcome === 'object'
    ? input.orbOutcome
    : null;
  const normalizedCandles = normalizeShadowCandleRows(input.candles || []);
  const signalContext = resolveContextSignalContext(contextJson);

  const shadow = {
    tradeDate: date || null,
    playbookKey: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    playbookVersion: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
    eligible: false,
    fitScore: 0,
    skipReason: null,
    contextSnapshot: {
      trend: signalContext.trend || 'unknown',
      volatility: signalContext.volatility || 'unknown',
      orbProfile: signalContext.orbProfile || 'unknown',
      orbRangeTicks: signalContext.orbRangeTicks,
      highRiskContext: signalContext.highRiskContext === true,
      candleCount: normalizedCandles.length,
    },
    hypotheticalDirection: null,
    entryReference: null,
    invalidationReference: null,
    targetReference: null,
    hypotheticalResult: SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    hypotheticalPnl: 0,
    orbOverlapLabel: 'orb_outcome_unavailable',
    dataQualityStatus: 'ok',
    evaluation: {},
  };

  const finalizeShadow = () => {
    const lane = classifyFailedExtensionReversalFadeShadowLane({
      eligible: shadow.eligible === true,
      highRiskContext: shadow?.contextSnapshot?.highRiskContext === true,
      blockerState: shadow.blockerState || null,
      divergenceDetected: shadow.divergenceDetected === true,
      orbOverlapLabel: shadow.orbOverlapLabel,
      orbWouldTrade: shadow?.evaluation?.orbWouldTrade === true,
      orbTradeResult: shadow?.evaluation?.orbTradeResult || null,
      orbPnlDollars: shadow?.evaluation?.orbPnlDollars,
      hypotheticalResult: shadow.hypotheticalResult,
    });
    shadow.laneLabel = normalizeShadowPlaybookLaneLabel(lane.laneLabel);
    shadow.laneReasonCodes = Array.isArray(lane.laneReasonCodes) ? lane.laneReasonCodes.filter(Boolean) : [];
    shadow.laneScore = Number.isFinite(toNumber(lane.laneScore, null)) ? round2(toNumber(lane.laneScore, null)) : 0;
    shadow.highConvictionLaneMatch = lane.highConvictionLaneMatch === true;
    const split = splitFailedExtensionLaneReasonCodes(shadow.laneReasonCodes);
    const predecisionLane = classifyFailedExtensionReversalFadeShadowPredecisionLane({
      eligible: shadow.eligible === true,
      highRiskContext: shadow?.contextSnapshot?.highRiskContext === true,
      blockerState: shadow.blockerState || null,
    });
    shadow.predecisionLaneLabel = normalizeShadowPlaybookLaneLabel(predecisionLane.laneLabel);
    shadow.predecisionLaneReasonCodes = Array.isArray(predecisionLane.laneReasonCodes)
      ? predecisionLane.laneReasonCodes.filter(Boolean)
      : [];
    shadow.predecisionLaneScore = Number.isFinite(toNumber(predecisionLane.laneScore, null))
      ? round2(toNumber(predecisionLane.laneScore, null))
      : 0;
    shadow.predecisionHighConvictionLaneMatch = predecisionLane.highConvictionLaneMatch === true;
    shadow.predecisionRemovedReasonCodes = Array.isArray(split.removedHindsightReasonCodes)
      ? split.removedHindsightReasonCodes
      : [];
    shadow.predecisionKeptReasonCodes = Array.isArray(split.preDecisionSafeReasonCodes)
      ? split.preDecisionSafeReasonCodes
      : [];
    shadow.evaluation = {
      ...(shadow.evaluation && typeof shadow.evaluation === 'object' ? shadow.evaluation : {}),
      laneLabel: shadow.laneLabel,
      laneReasonCodes: shadow.laneReasonCodes,
      laneScore: shadow.laneScore,
      highConvictionLaneMatch: shadow.highConvictionLaneMatch,
      predecisionLaneLabel: shadow.predecisionLaneLabel,
      predecisionLaneReasonCodes: shadow.predecisionLaneReasonCodes,
      predecisionLaneScore: shadow.predecisionLaneScore,
      predecisionHighConvictionLaneMatch: shadow.predecisionHighConvictionLaneMatch,
      predecisionRemovedReasonCodes: shadow.predecisionRemovedReasonCodes,
      predecisionKeptReasonCodes: shadow.predecisionKeptReasonCodes,
    };
    return shadow;
  };

  if (!date) {
    shadow.dataQualityStatus = 'missing_trade_date';
    shadow.skipReason = 'missing_trade_date';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  if (!normalizedCandles.length) {
    shadow.dataQualityStatus = 'missing_session_candles';
    shadow.skipReason = 'missing_session_candles';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const invalidOhlc = normalizedCandles.some((row) => row.validOhlc !== true);
  if (invalidOhlc) {
    shadow.dataQualityStatus = 'invalid_candle_values';
    shadow.skipReason = 'invalid_candle_values';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const sessionCandles = normalizedCandles.filter((row) => row.minuteOfDay >= 570 && row.minuteOfDay <= 960);
  if (sessionCandles.length < 6) {
    shadow.dataQualityStatus = 'insufficient_session_candles';
    shadow.skipReason = 'insufficient_session_candles';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const orbWindowCandles = sessionCandles.filter((row) => row.minuteOfDay >= 570 && row.minuteOfDay <= 584);
  let orbCandles = orbWindowCandles;
  let orbWindowMode = 'standard_0930_0944';
  if (orbCandles.length < 3) {
    orbCandles = sessionCandles.slice(0, 3);
    orbWindowMode = 'fallback_first_three_candles';
    shadow.dataQualityStatus = 'fallback_orb_window_used';
  }
  if (orbCandles.length < 3) {
    shadow.dataQualityStatus = 'insufficient_orb_window';
    shadow.skipReason = 'insufficient_orb_window';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const orbLast = orbCandles[orbCandles.length - 1];
  const postOrb = sessionCandles.filter((row) => row.idx > orbLast.idx);
  if (postOrb.length < 3) {
    shadow.dataQualityStatus = 'insufficient_post_orb_candles';
    shadow.skipReason = 'insufficient_post_orb_candles';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const orbHigh = Math.max(...orbCandles.map((row) => row.high));
  const orbLow = Math.min(...orbCandles.map((row) => row.low));
  const orbRange = Math.max(orbHigh - orbLow, 0);
  const orbMid = orbLow + (orbRange / 2);
  const upBreakIndex = postOrb.findIndex((row) => row.high > orbHigh);
  const downBreakIndex = postOrb.findIndex((row) => row.low < orbLow);
  const twoSidedBreak = upBreakIndex >= 0 && downBreakIndex >= 0;
  const extensionSide = upBreakIndex >= 0 && (downBreakIndex < 0 || upBreakIndex <= downBreakIndex)
    ? 'up'
    : (downBreakIndex >= 0 ? 'down' : null);

  let fitScore = 0;
  if (signalContext.trend === 'ranging') fitScore += 18;
  if (signalContext.volatility === 'extreme') fitScore += 18;
  if (signalContext.wideOrb) fitScore += 18;
  if (twoSidedBreak) fitScore += 18;

  shadow.contextSnapshot.orbWindowMode = orbWindowMode;
  shadow.contextSnapshot.orbHigh = round2(orbHigh);
  shadow.contextSnapshot.orbLow = round2(orbLow);
  shadow.contextSnapshot.orbRange = round2(orbRange);
  shadow.contextSnapshot.orbMid = round2(orbMid);
  shadow.contextSnapshot.twoSidedBreak = twoSidedBreak;

  if (!signalContext.highRiskContext) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore)));
    shadow.skipReason = 'context_not_ranging_extreme_wide';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }
  if (!twoSidedBreak || !extensionSide) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore)));
    shadow.skipReason = 'no_two_sided_break_context';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const extensionIdx = extensionSide === 'up' ? upBreakIndex : downBreakIndex;
  const extensionCandle = extensionIdx >= 0 ? postOrb[extensionIdx] : null;
  if (!extensionCandle) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore)));
    shadow.skipReason = 'extension_reference_missing';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  let reclaimIdx = -1;
  for (let i = extensionIdx + 1; i < postOrb.length; i += 1) {
    const row = postOrb[i];
    if (extensionSide === 'up' && row.close < orbHigh) {
      reclaimIdx = i;
      break;
    }
    if (extensionSide === 'down' && row.close > orbLow) {
      reclaimIdx = i;
      break;
    }
  }
  if (reclaimIdx < 0) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore + 8)));
    shadow.skipReason = 'failed_extension_reclaim_missing';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  let confirmIdx = -1;
  for (let i = reclaimIdx; i < postOrb.length; i += 1) {
    const row = postOrb[i];
    if (extensionSide === 'up' && row.close <= orbHigh) {
      confirmIdx = i;
      break;
    }
    if (extensionSide === 'down' && row.close >= orbLow) {
      confirmIdx = i;
      break;
    }
  }
  if (confirmIdx < 0) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore + 12)));
    shadow.skipReason = 'reclaim_confirmation_missing';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const entryCandle = postOrb[confirmIdx];
  const direction = extensionSide === 'up' ? 'short' : 'long';
  const stopBuffer = Math.max(0.1 * orbRange, 0.01);
  const stopPrice = direction === 'short'
    ? round2(extensionCandle.high + stopBuffer)
    : round2(extensionCandle.low - stopBuffer);
  const midTarget = round2(orbMid);
  const fallbackTarget = round2(direction === 'short'
    ? (entryCandle.close - (Math.max(orbRange, 0.25) * 0.2))
    : (entryCandle.close + (Math.max(orbRange, 0.25) * 0.2)));
  const targetPrice = direction === 'short'
    ? round2(Math.min(midTarget, fallbackTarget))
    : round2(Math.max(midTarget, fallbackTarget));
  const entryPrice = round2(entryCandle.close);
  const hasTargetDistance = direction === 'short'
    ? targetPrice < entryPrice
    : targetPrice > entryPrice;
  const hasStopDistance = direction === 'short'
    ? stopPrice > entryPrice
    : stopPrice < entryPrice;
  if (!hasTargetDistance || !hasStopDistance) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore + 14)));
    shadow.skipReason = 'invalid_trade_geometry';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  const future = postOrb.filter((row) => row.idx > entryCandle.idx);
  if (!future.length) {
    shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore + 16)));
    shadow.skipReason = 'insufficient_forward_candles';
    shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
      shadowResult: shadow.hypotheticalResult,
      orbOutcome,
    });
    return finalizeShadow();
  }

  fitScore += 24;
  shadow.eligible = true;
  shadow.fitScore = Math.max(0, Math.min(100, round2(fitScore)));
  shadow.hypotheticalDirection = direction;
  shadow.entryReference = {
    timestamp: entryCandle.timestamp || `${date} ${entryCandle.timeToken || ''}`.trim(),
    price: entryPrice,
    trigger: 'reclaim_confirmation',
  };
  shadow.invalidationReference = {
    price: stopPrice,
    trigger: 'extension_extreme_invalidated',
  };
  shadow.targetReference = {
    mode: 'orb_mid_reversion',
    price: targetPrice,
  };

  let exitReason = 'end_of_session_mark';
  let result = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT;
  let pnl = direction === 'short'
    ? round2(entryPrice - future[future.length - 1].close)
    : round2(future[future.length - 1].close - entryPrice);

  for (const row of future) {
    const stopHit = direction === 'short'
      ? row.high >= stopPrice
      : row.low <= stopPrice;
    const targetHit = direction === 'short'
      ? row.low <= targetPrice
      : row.high >= targetPrice;
    if (stopHit && targetHit) {
      result = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS;
      pnl = round2(-Math.abs(stopPrice - entryPrice));
      exitReason = 'same_bar_conflict_stop_first';
      break;
    }
    if (stopHit) {
      result = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS;
      pnl = round2(-Math.abs(stopPrice - entryPrice));
      exitReason = 'stop_hit';
      break;
    }
    if (targetHit) {
      result = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN;
      pnl = round2(Math.abs(targetPrice - entryPrice));
      exitReason = 'target_hit';
      break;
    }
  }
  if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT && Math.abs(pnl) < 0.01) {
    pnl = 0;
  } else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT && pnl < 0) {
    result = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS;
  } else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT && pnl > 0) {
    result = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN;
  }

  shadow.hypotheticalResult = SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_ENUM.includes(result)
    ? result
    : SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
  shadow.hypotheticalPnl = round2(pnl);
  shadow.orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
    shadowResult: shadow.hypotheticalResult,
    orbOutcome,
  });
  shadow.evaluation = {
    extensionSide,
    extensionCandleTimestamp: extensionCandle.timestamp || `${date} ${extensionCandle.timeToken || ''}`.trim(),
    reclaimCandleTimestamp: postOrb[reclaimIdx]?.timestamp || null,
    confirmationCandleTimestamp: entryCandle.timestamp || null,
    orbHigh: round2(orbHigh),
    orbLow: round2(orbLow),
    orbMid: round2(orbMid),
    orbRange: round2(orbRange),
    exitReason,
    orbWouldTrade: orbOutcome?.wouldTrade === true,
    orbTradeResult: toText(orbOutcome?.tradeResult || '') || null,
    orbPnlDollars: Number.isFinite(toNumber(orbOutcome?.pnlDollars, null))
      ? round2(toNumber(orbOutcome?.pnlDollars, null))
      : null,
  };
  return finalizeShadow();
}

function upsertShadowPlaybookEvaluation(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const evaluation = input.evaluation && typeof input.evaluation === 'object'
    ? input.evaluation
    : null;
  if (!evaluation) return null;
  const tradeDate = normalizeDate(evaluation.tradeDate || input.tradeDate || '');
  if (!tradeDate) return null;
  const playbookKey = toText(evaluation.playbookKey || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY) || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY;
  const playbookVersion = toText(evaluation.playbookVersion || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION) || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION;
  const sourceType = normalizeSourceType(input.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(input.reconstructionPhase, sourceType);
  const hypotheticalResult = toText(evaluation.hypotheticalResult || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
  const laneLabel = normalizeShadowPlaybookLaneLabel(evaluation.laneLabel);
  const laneReasonCodes = Array.isArray(evaluation.laneReasonCodes)
    ? evaluation.laneReasonCodes.map((code) => toText(code)).filter(Boolean)
    : [];
  const laneScore = Number.isFinite(toNumber(evaluation.laneScore, null))
    ? round2(toNumber(evaluation.laneScore, null))
    : 0;
  const highConvictionLaneMatch = evaluation.highConvictionLaneMatch === true;
  const predecisionLaneLabel = normalizeShadowPlaybookLaneLabel(
    evaluation.predecisionLaneLabel || SHADOW_PLAYBOOK_LANE_NEUTRAL
  );
  const predecisionLaneReasonCodes = Array.isArray(evaluation.predecisionLaneReasonCodes)
    ? evaluation.predecisionLaneReasonCodes.map((code) => toText(code)).filter(Boolean)
    : [];
  const predecisionLaneScore = Number.isFinite(toNumber(evaluation.predecisionLaneScore, null))
    ? round2(toNumber(evaluation.predecisionLaneScore, null))
    : 0;
  const predecisionHighConvictionLaneMatch = evaluation.predecisionHighConvictionLaneMatch === true;
  const predecisionRemovedReasonCodes = Array.isArray(evaluation.predecisionRemovedReasonCodes)
    ? evaluation.predecisionRemovedReasonCodes.map((code) => toText(code)).filter(Boolean)
    : [];
  const predecisionKeptReasonCodes = Array.isArray(evaluation.predecisionKeptReasonCodes)
    ? evaluation.predecisionKeptReasonCodes.map((code) => toText(code)).filter(Boolean)
    : [];

  let orbOverlapLabel = toText(evaluation.orbOverlapLabel || '') || 'orb_outcome_unavailable';
  if (orbOverlapLabel === 'orb_outcome_unavailable') {
    const orbOutcomeRow = db.prepare(`
      SELECT outcome_json
      FROM jarvis_recommendation_outcome_history
      WHERE rec_date = @rec_date
      ORDER BY
        CASE
          WHEN source_type = @source_type AND reconstruction_phase = @reconstruction_phase THEN 0
          WHEN source_type = @live_source_type AND reconstruction_phase = @live_phase THEN 1
          WHEN source_type = @source_type THEN 2
          ELSE 3
        END,
        datetime(calculated_at) DESC,
        id DESC
      LIMIT 1
    `).get({
      rec_date: tradeDate,
      source_type: sourceType,
      reconstruction_phase: reconstructionPhase,
      live_source_type: SOURCE_LIVE,
      live_phase: PHASE_LIVE_INTRADAY,
    });
    const orbOutcomeJson = orbOutcomeRow
      ? safeJsonParse(orbOutcomeRow.outcome_json, {})
      : {};
    const orbOutcome = orbOutcomeJson?.recommendedStrategyOutcome
      && typeof orbOutcomeJson.recommendedStrategyOutcome === 'object'
      ? orbOutcomeJson.recommendedStrategyOutcome
      : null;
    if (orbOutcome) {
      orbOverlapLabel = buildShadowPlaybookOrbOverlapLabel({
        shadowResult: hypotheticalResult,
        orbOutcome,
      });
    }
  }
  const evaluationPayload = {
    ...(evaluation.evaluation && typeof evaluation.evaluation === 'object' ? evaluation.evaluation : {}),
    laneLabel,
    laneReasonCodes,
    laneScore,
    highConvictionLaneMatch,
    predecisionLaneLabel,
    predecisionLaneReasonCodes,
    predecisionLaneScore,
    predecisionHighConvictionLaneMatch,
    predecisionRemovedReasonCodes,
    predecisionKeptReasonCodes,
  };

  db.prepare(`
    INSERT INTO jarvis_shadow_playbook_daily (
      trade_date,
      playbook_key,
      playbook_version,
      source_type,
      reconstruction_phase,
      eligible,
      fit_score,
      skip_reason,
      context_snapshot_json,
      hypothetical_direction,
      entry_reference_json,
      invalidation_reference_json,
      target_reference_json,
      hypothetical_result,
      hypothetical_pnl,
      orb_overlap_label,
      data_quality_status,
      evaluation_json,
      updated_at
    ) VALUES (
      @trade_date,
      @playbook_key,
      @playbook_version,
      @source_type,
      @reconstruction_phase,
      @eligible,
      @fit_score,
      @skip_reason,
      @context_snapshot_json,
      @hypothetical_direction,
      @entry_reference_json,
      @invalidation_reference_json,
      @target_reference_json,
      @hypothetical_result,
      @hypothetical_pnl,
      @orb_overlap_label,
      @data_quality_status,
      @evaluation_json,
      datetime('now')
    )
    ON CONFLICT(trade_date, playbook_key, playbook_version) DO UPDATE SET
      source_type = excluded.source_type,
      reconstruction_phase = excluded.reconstruction_phase,
      eligible = excluded.eligible,
      fit_score = excluded.fit_score,
      skip_reason = excluded.skip_reason,
      context_snapshot_json = excluded.context_snapshot_json,
      hypothetical_direction = excluded.hypothetical_direction,
      entry_reference_json = excluded.entry_reference_json,
      invalidation_reference_json = excluded.invalidation_reference_json,
      target_reference_json = excluded.target_reference_json,
      hypothetical_result = excluded.hypothetical_result,
      hypothetical_pnl = excluded.hypothetical_pnl,
      orb_overlap_label = excluded.orb_overlap_label,
      data_quality_status = excluded.data_quality_status,
      evaluation_json = excluded.evaluation_json,
      updated_at = datetime('now')
  `).run({
    trade_date: tradeDate,
    playbook_key: playbookKey,
    playbook_version: playbookVersion,
    source_type: sourceType,
    reconstruction_phase: reconstructionPhase,
    eligible: evaluation.eligible === true ? 1 : 0,
    fit_score: Number.isFinite(toNumber(evaluation.fitScore, null)) ? round2(toNumber(evaluation.fitScore, null)) : 0,
    skip_reason: toText(evaluation.skipReason || '') || null,
    context_snapshot_json: JSON.stringify(evaluation.contextSnapshot || {}),
    hypothetical_direction: toText(evaluation.hypotheticalDirection || '') || null,
    entry_reference_json: JSON.stringify(evaluation.entryReference || {}),
    invalidation_reference_json: JSON.stringify(evaluation.invalidationReference || {}),
    target_reference_json: JSON.stringify(evaluation.targetReference || {}),
    hypothetical_result: hypotheticalResult,
    hypothetical_pnl: Number.isFinite(toNumber(evaluation.hypotheticalPnl, null)) ? round2(toNumber(evaluation.hypotheticalPnl, null)) : 0,
    orb_overlap_label: orbOverlapLabel,
    data_quality_status: toText(evaluation.dataQualityStatus || '') || 'ok',
    evaluation_json: JSON.stringify(evaluationPayload),
  });
  return {
    tradeDate,
    playbookKey,
    playbookVersion,
    eligible: evaluation.eligible === true,
    hypotheticalResult,
    hypotheticalPnl: Number.isFinite(toNumber(evaluation.hypotheticalPnl, null)) ? round2(toNumber(evaluation.hypotheticalPnl, null)) : 0,
    orbOverlapLabel,
    laneLabel,
    laneReasonCodes,
    laneScore,
    highConvictionLaneMatch,
    predecisionLaneLabel,
    predecisionLaneReasonCodes,
    predecisionLaneScore,
    predecisionHighConvictionLaneMatch,
    predecisionRemovedReasonCodes,
    predecisionKeptReasonCodes,
  };
}

function upsertShadowPlaybookDurabilitySummary(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const summary = input.summary && typeof input.summary === 'object'
    ? input.summary
    : null;
  if (!summary) return null;
  const asOfTradeDate = normalizeDate(summary.asOfTradeDate || input.asOfTradeDate || '');
  if (!asOfTradeDate) return null;
  const playbookKey = toText(
    summary.playbookKey
    || input.playbookKey
    || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY
  ) || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY;
  const playbookVersion = toText(
    summary.playbookVersion
    || input.playbookVersion
    || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION
  ) || SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION;
  const sourceType = toText(summary.sourceType || input.sourceType || 'all').toLowerCase() || 'all';
  const reconstructionPhase = toText(
    summary.reconstructionPhase
    || input.reconstructionPhase
    || 'mixed'
  ).toLowerCase() || 'mixed';
  const trendVerdict = normalizeShadowPlaybookDurabilityTrend(summary.trendVerdict);
  const promotionReadinessStatus = normalizeShadowPlaybookPromotionReadinessStatus(
    summary.promotionReadinessStatus
  );
  const promotionReadinessBlockReason = toText(summary.promotionReadinessBlockReason || '') || null;
  const promotionReadinessBlockReasons = Array.isArray(summary.promotionReadinessBlockReasons)
    ? summary.promotionReadinessBlockReasons.map((item) => toText(item)).filter(Boolean)
    : [];
  const promotionReadinessThresholds = (
    summary.promotionReadinessThresholds && typeof summary.promotionReadinessThresholds === 'object'
  )
    ? summary.promotionReadinessThresholds
    : {};
  const externalFinalizedDays = Number.isFinite(toNumber(summary.externalFinalizedDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.externalFinalizedDays, 0)))
    : 0;
  const unfinalizedDays = Number.isFinite(toNumber(summary.unfinalizedDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.unfinalizedDays, 0)))
    : 0;
  const externalCoveragePct = Number.isFinite(toNumber(summary.externalCoveragePct, null))
    ? round2(toNumber(summary.externalCoveragePct, 0))
    : null;
  const rolling5ExternalFinalizedDays = Number.isFinite(toNumber(summary.rolling5ExternalFinalizedDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.rolling5ExternalFinalizedDays, 0)))
    : 0;
  const rolling5ExternalCoveragePct = Number.isFinite(toNumber(summary.rolling5ExternalCoveragePct, null))
    ? round2(toNumber(summary.rolling5ExternalCoveragePct, 0))
    : null;
  const rolling10ExternalFinalizedDays = Number.isFinite(toNumber(summary.rolling10ExternalFinalizedDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.rolling10ExternalFinalizedDays, 0)))
    : 0;
  const rolling10ExternalCoveragePct = Number.isFinite(toNumber(summary.rolling10ExternalCoveragePct, null))
    ? round2(toNumber(summary.rolling10ExternalCoveragePct, 0))
    : null;
  const externallyFinalizedEligibleDays = Number.isFinite(toNumber(summary.externallyFinalizedEligibleDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.externallyFinalizedEligibleDays, 0)))
    : 0;
  const externallyUnfinalizedEligibleDays = Number.isFinite(
    toNumber(summary.externallyUnfinalizedEligibleDays, null)
  )
    ? Math.max(0, Math.trunc(toNumber(summary.externallyUnfinalizedEligibleDays, 0)))
    : 0;
  const unfinalizedTradeDates = Array.isArray(summary.unfinalizedTradeDates)
    ? summary.unfinalizedTradeDates.map((date) => normalizeDate(date)).filter(Boolean)
    : [];
  const coverageAwareTrustClassification = normalizeShadowPlaybookDurabilityTrust(
    summary.coverageAwareTrustClassification || summary?.durabilityTrust?.coverageAwareTrustClassification
  );
  const latestDayProvisional = summary.latestDayProvisional === true;
  const latestDayProvisionalReason = toText(summary.latestDayProvisionalReason || '') || null;
  const totalEligibleDays = Number.isFinite(toNumber(summary.totalEligibleDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.totalEligibleDays, 0)))
    : 0;
  const totalPredecisionGreenDays = Number.isFinite(toNumber(summary.totalPredecisionGreenDays, null))
    ? Math.max(0, Math.trunc(toNumber(summary.totalPredecisionGreenDays, 0)))
    : 0;
  const shadowBeatsOrbCount = Number.isFinite(toNumber(summary.shadowBeatsOrbCount, null))
    ? Math.max(0, Math.trunc(toNumber(summary.shadowBeatsOrbCount, 0)))
    : 0;
  const orbBeatsShadowCount = Number.isFinite(toNumber(summary.orbBeatsShadowCount, null))
    ? Math.max(0, Math.trunc(toNumber(summary.orbBeatsShadowCount, 0)))
    : 0;
  const fullSampleStats = summary.fullSampleStats && typeof summary.fullSampleStats === 'object'
    ? summary.fullSampleStats
    : {};
  const rolling5DayStats = summary.rolling5DayStats && typeof summary.rolling5DayStats === 'object'
    ? summary.rolling5DayStats
    : {};
  const rolling10DayStats = summary.rolling10DayStats && typeof summary.rolling10DayStats === 'object'
    ? summary.rolling10DayStats
    : {};
  const payload = {
    ...summary,
    asOfTradeDate,
    playbookKey,
    playbookVersion,
    sourceType,
    reconstructionPhase,
    trendVerdict,
    promotionReadinessStatus,
    promotionReadinessBlockReason,
    promotionReadinessBlockReasons,
    promotionReadinessThresholds,
    externalFinalizedDays,
    unfinalizedDays,
    externalCoveragePct,
    rolling5ExternalFinalizedDays,
    rolling5ExternalCoveragePct,
    rolling10ExternalFinalizedDays,
    rolling10ExternalCoveragePct,
    externallyFinalizedEligibleDays,
    externallyUnfinalizedEligibleDays,
    unfinalizedTradeDates,
    coverageAwareTrustClassification,
    latestDayProvisional,
    latestDayProvisionalReason,
    totalEligibleDays,
    totalPredecisionGreenDays,
    shadowBeatsOrbCount,
    orbBeatsShadowCount,
  };
  db.prepare(`
    INSERT INTO jarvis_shadow_playbook_durability_summary (
      as_of_trade_date,
      playbook_key,
      playbook_version,
      source_type,
      reconstruction_phase,
      total_eligible_days,
      total_predecision_green_days,
      shadow_beats_orb_count,
      orb_beats_shadow_count,
      trend_verdict,
      promotion_readiness_status,
      promotion_readiness_block_reason,
      promotion_readiness_block_reasons_json,
      promotion_readiness_thresholds_json,
      external_finalized_days,
      unfinalized_days,
      external_coverage_pct,
      rolling5_external_finalized_days,
      rolling5_external_coverage_pct,
      rolling10_external_finalized_days,
      rolling10_external_coverage_pct,
      externally_finalized_eligible_days,
      externally_unfinalized_eligible_days,
      unfinalized_trade_dates_json,
      coverage_aware_trust_classification,
      latest_day_provisional,
      latest_day_provisional_reason,
      full_sample_json,
      rolling5_json,
      rolling10_json,
      summary_json,
      calculated_at,
      updated_at
    ) VALUES (
      @as_of_trade_date,
      @playbook_key,
      @playbook_version,
      @source_type,
      @reconstruction_phase,
      @total_eligible_days,
      @total_predecision_green_days,
      @shadow_beats_orb_count,
      @orb_beats_shadow_count,
      @trend_verdict,
      @promotion_readiness_status,
      @promotion_readiness_block_reason,
      @promotion_readiness_block_reasons_json,
      @promotion_readiness_thresholds_json,
      @external_finalized_days,
      @unfinalized_days,
      @external_coverage_pct,
      @rolling5_external_finalized_days,
      @rolling5_external_coverage_pct,
      @rolling10_external_finalized_days,
      @rolling10_external_coverage_pct,
      @externally_finalized_eligible_days,
      @externally_unfinalized_eligible_days,
      @unfinalized_trade_dates_json,
      @coverage_aware_trust_classification,
      @latest_day_provisional,
      @latest_day_provisional_reason,
      @full_sample_json,
      @rolling5_json,
      @rolling10_json,
      @summary_json,
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT(as_of_trade_date, playbook_key, playbook_version, source_type, reconstruction_phase) DO UPDATE SET
      total_eligible_days = excluded.total_eligible_days,
      total_predecision_green_days = excluded.total_predecision_green_days,
      shadow_beats_orb_count = excluded.shadow_beats_orb_count,
      orb_beats_shadow_count = excluded.orb_beats_shadow_count,
      trend_verdict = excluded.trend_verdict,
      promotion_readiness_status = excluded.promotion_readiness_status,
      promotion_readiness_block_reason = excluded.promotion_readiness_block_reason,
      promotion_readiness_block_reasons_json = excluded.promotion_readiness_block_reasons_json,
      promotion_readiness_thresholds_json = excluded.promotion_readiness_thresholds_json,
      external_finalized_days = excluded.external_finalized_days,
      unfinalized_days = excluded.unfinalized_days,
      external_coverage_pct = excluded.external_coverage_pct,
      rolling5_external_finalized_days = excluded.rolling5_external_finalized_days,
      rolling5_external_coverage_pct = excluded.rolling5_external_coverage_pct,
      rolling10_external_finalized_days = excluded.rolling10_external_finalized_days,
      rolling10_external_coverage_pct = excluded.rolling10_external_coverage_pct,
      externally_finalized_eligible_days = excluded.externally_finalized_eligible_days,
      externally_unfinalized_eligible_days = excluded.externally_unfinalized_eligible_days,
      unfinalized_trade_dates_json = excluded.unfinalized_trade_dates_json,
      coverage_aware_trust_classification = excluded.coverage_aware_trust_classification,
      latest_day_provisional = excluded.latest_day_provisional,
      latest_day_provisional_reason = excluded.latest_day_provisional_reason,
      full_sample_json = excluded.full_sample_json,
      rolling5_json = excluded.rolling5_json,
      rolling10_json = excluded.rolling10_json,
      summary_json = excluded.summary_json,
      calculated_at = datetime('now'),
      updated_at = datetime('now')
  `).run({
    as_of_trade_date: asOfTradeDate,
    playbook_key: playbookKey,
    playbook_version: playbookVersion,
    source_type: sourceType,
    reconstruction_phase: reconstructionPhase,
    total_eligible_days: totalEligibleDays,
    total_predecision_green_days: totalPredecisionGreenDays,
    shadow_beats_orb_count: shadowBeatsOrbCount,
    orb_beats_shadow_count: orbBeatsShadowCount,
    trend_verdict: trendVerdict,
    promotion_readiness_status: promotionReadinessStatus,
    promotion_readiness_block_reason: promotionReadinessBlockReason,
    promotion_readiness_block_reasons_json: JSON.stringify(promotionReadinessBlockReasons),
    promotion_readiness_thresholds_json: JSON.stringify(promotionReadinessThresholds),
    external_finalized_days: externalFinalizedDays,
    unfinalized_days: unfinalizedDays,
    external_coverage_pct: externalCoveragePct,
    rolling5_external_finalized_days: rolling5ExternalFinalizedDays,
    rolling5_external_coverage_pct: rolling5ExternalCoveragePct,
    rolling10_external_finalized_days: rolling10ExternalFinalizedDays,
    rolling10_external_coverage_pct: rolling10ExternalCoveragePct,
    externally_finalized_eligible_days: externallyFinalizedEligibleDays,
    externally_unfinalized_eligible_days: externallyUnfinalizedEligibleDays,
    unfinalized_trade_dates_json: JSON.stringify(unfinalizedTradeDates),
    coverage_aware_trust_classification: coverageAwareTrustClassification,
    latest_day_provisional: latestDayProvisional ? 1 : 0,
    latest_day_provisional_reason: latestDayProvisionalReason,
    full_sample_json: JSON.stringify(fullSampleStats || {}),
    rolling5_json: JSON.stringify(rolling5DayStats || {}),
    rolling10_json: JSON.stringify(rolling10DayStats || {}),
    summary_json: JSON.stringify(payload || {}),
  });
  const row = db.prepare(`
    SELECT *
    FROM jarvis_shadow_playbook_durability_summary
    WHERE as_of_trade_date = ?
      AND playbook_key = ?
      AND playbook_version = ?
      AND source_type = ?
      AND reconstruction_phase = ?
    LIMIT 1
  `).get(asOfTradeDate, playbookKey, playbookVersion, sourceType, reconstructionPhase);
  if (!row) return null;
  return {
    asOfTradeDate: normalizeDate(row.as_of_trade_date || asOfTradeDate),
    playbookKey: toText(row.playbook_key || playbookKey) || playbookKey,
    playbookVersion: toText(row.playbook_version || playbookVersion) || playbookVersion,
    sourceType: toText(row.source_type || sourceType).toLowerCase() || sourceType,
    reconstructionPhase: toText(row.reconstruction_phase || reconstructionPhase).toLowerCase() || reconstructionPhase,
    totalEligibleDays: Number(row.total_eligible_days || totalEligibleDays),
    totalPredecisionGreenDays: Number(row.total_predecision_green_days || totalPredecisionGreenDays),
    shadowBeatsOrbCount: Number(row.shadow_beats_orb_count || shadowBeatsOrbCount),
    orbBeatsShadowCount: Number(row.orb_beats_shadow_count || orbBeatsShadowCount),
    trendVerdict: normalizeShadowPlaybookDurabilityTrend(row.trend_verdict || trendVerdict),
    promotionReadinessStatus: normalizeShadowPlaybookPromotionReadinessStatus(
      row.promotion_readiness_status || promotionReadinessStatus
    ),
    promotionReadinessBlockReason: toText(row.promotion_readiness_block_reason || promotionReadinessBlockReason) || null,
    promotionReadinessBlockReasons: (() => {
      try { return JSON.parse(String(row.promotion_readiness_block_reasons_json || '[]')); } catch { return promotionReadinessBlockReasons; }
    })(),
    promotionReadinessThresholds: (() => {
      try { return JSON.parse(String(row.promotion_readiness_thresholds_json || '{}')); } catch { return promotionReadinessThresholds; }
    })(),
    externalFinalizedDays: Number(row.external_finalized_days || externalFinalizedDays),
    unfinalizedDays: Number(row.unfinalized_days || unfinalizedDays),
    externalCoveragePct: row.external_coverage_pct == null ? externalCoveragePct : Number(row.external_coverage_pct),
    rolling5ExternalFinalizedDays: Number(row.rolling5_external_finalized_days || rolling5ExternalFinalizedDays),
    rolling5ExternalCoveragePct: row.rolling5_external_coverage_pct == null
      ? rolling5ExternalCoveragePct
      : Number(row.rolling5_external_coverage_pct),
    rolling10ExternalFinalizedDays: Number(row.rolling10_external_finalized_days || rolling10ExternalFinalizedDays),
    rolling10ExternalCoveragePct: row.rolling10_external_coverage_pct == null
      ? rolling10ExternalCoveragePct
      : Number(row.rolling10_external_coverage_pct),
    externallyFinalizedEligibleDays: Number(
      row.externally_finalized_eligible_days || externallyFinalizedEligibleDays
    ),
    externallyUnfinalizedEligibleDays: Number(
      row.externally_unfinalized_eligible_days || externallyUnfinalizedEligibleDays
    ),
    unfinalizedTradeDates: (() => {
      try { return JSON.parse(String(row.unfinalized_trade_dates_json || '[]')); } catch { return unfinalizedTradeDates; }
    })(),
    coverageAwareTrustClassification: normalizeShadowPlaybookDurabilityTrust(
      row.coverage_aware_trust_classification || coverageAwareTrustClassification
    ),
    latestDayProvisional: Number(row.latest_day_provisional || 0) > 0 || latestDayProvisional,
    latestDayProvisionalReason: toText(row.latest_day_provisional_reason || latestDayProvisionalReason) || null,
    calculatedAt: toText(row.calculated_at || '') || null,
    updatedAt: toText(row.updated_at || '') || null,
  };
}

function toUtcMs(isoDate = '') {
  const date = normalizeDate(isoDate);
  if (!date) return null;
  const parts = date.split('-').map((n) => Number(n));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function isWeekendDate(isoDate = '') {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return false;
  const dow = new Date(ms).getUTCDay();
  return dow === 0 || dow === 6;
}

function observedHolidayDate(year, monthIndex, day) {
  const base = new Date(Date.UTC(year, monthIndex, day));
  const dow = base.getUTCDay();
  if (dow === 6) {
    base.setUTCDate(base.getUTCDate() - 1);
  } else if (dow === 0) {
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return base.toISOString().slice(0, 10);
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstDow = first.getUTCDay();
  const delta = (weekday - firstDow + 7) % 7;
  const day = 1 + delta + ((Math.max(1, nth) - 1) * 7);
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const lastDow = last.getUTCDay();
  const delta = (lastDow - weekday + 7) % 7;
  last.setUTCDate(last.getUTCDate() - delta);
  return last.toISOString().slice(0, 10);
}

function easterSundayUtc(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = ((19 * a) + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + (2 * e) + (2 * i) - h - k) % 7;
  const m = Math.floor((a + (11 * h) + (22 * l)) / 451);
  const month = Math.floor((h + l - (7 * m) + 114) / 31);
  const day = ((h + l - (7 * m) + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function buildUsMarketHolidaySet(year) {
  const holidays = new Set();
  holidays.add(observedHolidayDate(year, 0, 1)); // New Year's Day
  holidays.add(nthWeekdayOfMonth(year, 0, 1, 3)); // MLK Day
  holidays.add(nthWeekdayOfMonth(year, 1, 1, 3)); // Presidents' Day
  const easter = easterSundayUtc(year);
  const goodFriday = new Date(easter.getTime() - (2 * 86400000));
  holidays.add(goodFriday.toISOString().slice(0, 10)); // Good Friday
  holidays.add(lastWeekdayOfMonth(year, 4, 1)); // Memorial Day
  holidays.add(observedHolidayDate(year, 6, 4)); // Independence Day
  holidays.add(nthWeekdayOfMonth(year, 8, 1, 1)); // Labor Day
  holidays.add(nthWeekdayOfMonth(year, 10, 4, 4)); // Thanksgiving
  holidays.add(observedHolidayDate(year, 11, 25)); // Christmas
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

function normalizeLiveContextGuardStatus(value) {
  const key = toText(value).toLowerCase();
  if (LIVE_CONTEXT_GUARD_STATUS_SET.has(key)) return key;
  return LIVE_CONTEXT_GUARD_STATUS_REJECT_INVALID_MAPPING;
}

function resolveSessionForDate(recDate = '', input = {}) {
  const sessionForDate = Array.isArray(input.sessionForDate)
    ? input.sessionForDate
    : null;
  if (sessionForDate) return sessionForDate;
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : null;
  if (!sessions || !recDate) return null;
  const row = sessions[recDate];
  return Array.isArray(row) ? row : null;
}

function evaluateLiveContextCreationGuard(input = {}) {
  const recDate = normalizeDate(input.recDate || input.date || '');
  const contextDate = normalizeDate(
    input.contextDate
    || input.context?.nowEt?.date
    || input.context?.nowEt
    || input.context?.date
    || ''
  );
  const sessionForDate = resolveSessionForDate(recDate, input);
  if (!recDate) {
    return {
      status: LIVE_CONTEXT_GUARD_STATUS_REJECT_MISSING_SESSION,
      reasonCode: 'missing_rec_date',
      classification: 'invalid_mapping',
      recDate: '',
      contextDate: contextDate || null,
      hasSessionForDate: Array.isArray(sessionForDate),
      sessionCount: Array.isArray(sessionForDate) ? sessionForDate.length : 0,
    };
  }
  if (contextDate && contextDate !== recDate) {
    return {
      status: LIVE_CONTEXT_GUARD_STATUS_REJECT_INVALID_MAPPING,
      reasonCode: 'context_date_mismatch',
      classification: 'invalid_mapping',
      recDate,
      contextDate,
      hasSessionForDate: Array.isArray(sessionForDate),
      sessionCount: Array.isArray(sessionForDate) ? sessionForDate.length : 0,
    };
  }
  const weekend = isWeekendDate(recDate);
  const holiday = isUsMarketHoliday(recDate);
  if (weekend || holiday) {
    if (Array.isArray(sessionForDate) && sessionForDate.length > 0) {
      return {
        status: LIVE_CONTEXT_GUARD_STATUS_REJECT_INVALID_MAPPING,
        reasonCode: weekend ? 'weekend_has_session_data' : 'holiday_has_session_data',
        classification: 'invalid_mapping',
        recDate,
        contextDate: contextDate || recDate,
        hasSessionForDate: true,
        sessionCount: sessionForDate.length,
      };
    }
    return {
      status: LIVE_CONTEXT_GUARD_STATUS_REJECT_NON_TRADING,
      reasonCode: weekend ? 'weekend' : 'us_market_holiday',
      classification: 'non_trading_day',
      recDate,
      contextDate: contextDate || recDate,
      hasSessionForDate: Array.isArray(sessionForDate),
      sessionCount: Array.isArray(sessionForDate) ? sessionForDate.length : 0,
    };
  }
  return {
    status: LIVE_CONTEXT_GUARD_STATUS_ALLOWED,
    reasonCode: 'weekday_trading_day',
    classification: 'valid_trading_day',
    recDate,
    contextDate: contextDate || recDate,
    hasSessionForDate: Array.isArray(sessionForDate),
    sessionCount: Array.isArray(sessionForDate) ? sessionForDate.length : 0,
  };
}

function recordLiveContextCreationAudit(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const recDate = normalizeDate(input.recDate || input.date || '');
  const sourceType = normalizeSourceType(input.sourceType);
  const reconstructionPhase = normalizeReconstructionPhase(input.reconstructionPhase, sourceType);
  const status = normalizeLiveContextGuardStatus(input.status || '');
  if (!recDate || sourceType !== SOURCE_LIVE || reconstructionPhase !== PHASE_LIVE_INTRADAY) return null;
  const reasonCode = toText(input.reasonCode || '').toLowerCase() || 'unknown';
  const classification = toText(input.classification || '').toLowerCase() || null;
  const triggerSource = toText(input.triggerSource || '').toLowerCase() || 'unknown';
  const details = input.details && typeof input.details === 'object'
    ? input.details
    : {};
  db.prepare(`
    INSERT INTO jarvis_live_context_creation_audit (
      rec_date,
      source_type,
      reconstruction_phase,
      creation_status,
      classification,
      reason_code,
      trigger_source,
      details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recDate,
    sourceType,
    reconstructionPhase,
    status,
    classification,
    reasonCode,
    triggerSource,
    JSON.stringify(details || {})
  );
  return {
    recDate,
    sourceType,
    reconstructionPhase,
    creationStatus: status,
    classification,
    reasonCode,
    triggerSource,
  };
}

function upsertLiveContextSuppression(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const recDate = normalizeDate(input.recDate || input.date || '');
  if (!recDate) return null;
  const sourceType = normalizeSourceType(input.sourceType);
  const reconstructionPhase = normalizeReconstructionPhase(input.reconstructionPhase, sourceType);
  const isActive = input.isActive === true ? 1 : 0;
  const reasonCode = toText(input.reasonCode || '').toLowerCase() || 'unknown';
  const classification = toText(input.classification || '').toLowerCase() || null;
  const suppressionStatus = isActive ? 'suppressed' : 'inactive';
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const out = db.prepare(`
    INSERT INTO jarvis_live_context_suppression (
      rec_date,
      source_type,
      reconstruction_phase,
      suppression_status,
      classification,
      reason_code,
      is_active,
      details_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(rec_date, source_type, reconstruction_phase) DO UPDATE SET
      suppression_status = excluded.suppression_status,
      classification = excluded.classification,
      reason_code = excluded.reason_code,
      is_active = excluded.is_active,
      details_json = excluded.details_json,
      updated_at = datetime('now')
  `).run(
    recDate,
    sourceType,
    reconstructionPhase,
    suppressionStatus,
    classification,
    reasonCode,
    isActive,
    JSON.stringify(details || {})
  );
  return {
    recDate,
    sourceType,
    reconstructionPhase,
    suppressionStatus,
    isActive: isActive === 1,
    changes: Number(out?.changes || 0),
  };
}

function auditAndSuppressInvalidLiveContexts(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      invalidLiveContextsFound: 0,
      invalidLiveContextsActive: 0,
      invalidLiveContextsSuppressed: 0,
      invalidLiveContextsCreatedToday: 0,
      invalidLiveContextsSuppressedToday: 0,
      latestInvalidLiveContextDates: [],
      advisoryOnly: true,
    };
  }
  ensureRecommendationOutcomeSchema(db);
  const nowDate = normalizeDate(input.nowDate || new Date().toISOString());
  const lookbackDaysRaw = Number(input.lookbackDays || 45);
  const lookbackDays = Number.isFinite(lookbackDaysRaw)
    ? Math.max(7, Math.min(180, Math.round(lookbackDaysRaw)))
    : 45;
  const nowMs = toUtcMs(nowDate);
  const sinceDate = Number.isFinite(nowMs)
    ? new Date(nowMs - ((lookbackDays - 1) * 86400000)).toISOString().slice(0, 10)
    : nowDate;
  const triggerSource = toText(input.triggerSource || '').toLowerCase() || 'daily_scoring_audit';
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const rows = db.prepare(`
    SELECT id, rec_date, source_type, reconstruction_phase, context_json, created_at, updated_at
    FROM jarvis_recommendation_context_history
    WHERE source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
      AND rec_date >= ?
    ORDER BY rec_date DESC, id DESC
  `).all(sinceDate);
  let invalidLiveContextsFound = 0;
  let invalidLiveContextsSuppressed = 0;
  const latestInvalidMap = new Map();
  for (const row of rows) {
    const recDate = normalizeDate(row?.rec_date || '');
    if (!recDate) continue;
    let context = {};
    try { context = JSON.parse(String(row?.context_json || '{}')); } catch {}
    const guard = evaluateLiveContextCreationGuard({
      recDate,
      context,
      sessions,
      sessionForDate: Array.isArray(sessions?.[recDate]) ? sessions[recDate] : null,
    });
    if (guard.status === LIVE_CONTEXT_GUARD_STATUS_ALLOWED) {
      upsertLiveContextSuppression(db, {
        recDate,
        sourceType: SOURCE_LIVE,
        reconstructionPhase: PHASE_LIVE_INTRADAY,
        isActive: false,
        reasonCode: 'valid_trading_day_context',
        classification: 'valid_trading_day',
        details: {
          triggerSource,
          clearedAt: new Date().toISOString(),
        },
      });
      continue;
    }
    invalidLiveContextsFound += 1;
    const current = db.prepare(`
      SELECT is_active
      FROM jarvis_live_context_suppression
      WHERE rec_date = ? AND source_type = 'live' AND reconstruction_phase = 'live_intraday'
      LIMIT 1
    `).get(recDate);
    const wasActive = Number(current?.is_active || 0) === 1;
    const out = upsertLiveContextSuppression(db, {
      recDate,
      sourceType: SOURCE_LIVE,
      reconstructionPhase: PHASE_LIVE_INTRADAY,
      isActive: true,
      reasonCode: guard.reasonCode,
      classification: guard.classification,
      details: {
        triggerSource,
        guardStatus: guard.status,
        contextDate: guard.contextDate,
        sessionCount: guard.sessionCount,
        auditedAt: new Date().toISOString(),
      },
    });
    if (!wasActive && Number(out?.changes || 0) > 0) invalidLiveContextsSuppressed += 1;
    latestInvalidMap.set(recDate, {
      date: recDate,
      reason: guard.reasonCode,
      classification: guard.classification,
      status: guard.status,
    });
  }
  const invalidLiveContextsActive = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_live_context_suppression
    WHERE source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
      AND is_active = 1
  `).get()?.c || 0);
  const invalidLiveContextsCreatedToday = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_live_context_creation_audit
    WHERE rec_date = ?
      AND source_type = 'live'
      AND reconstruction_phase = 'live_intraday'
      AND creation_status <> ?
  `).get(nowDate, LIVE_CONTEXT_GUARD_STATUS_ALLOWED)?.c || 0);
  return {
    generatedAt: new Date().toISOString(),
    nowDate,
    lookbackDays,
    invalidLiveContextsFound,
    invalidLiveContextsActive,
    invalidLiveContextsSuppressed,
    invalidLiveContextsCreatedToday,
    invalidLiveContextsSuppressedToday: invalidLiveContextsSuppressed,
    latestInvalidLiveContextDates: Array.from(latestInvalidMap.values())
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 12),
    advisoryOnly: true,
  };
}

function ensureRecommendationOutcomeSchema(db) {
  if (!db || typeof db.exec !== 'function') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS jarvis_recommendation_context (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_date                    TEXT NOT NULL UNIQUE,
      posture                     TEXT,
      recommended_strategy_key    TEXT,
      recommended_strategy_name   TEXT,
      recommended_tp_mode         TEXT,
      confidence_label            TEXT,
      confidence_score            REAL,
      recommendation_json         TEXT NOT NULL DEFAULT '{}',
      strategy_layers_json        TEXT NOT NULL DEFAULT '{}',
      mechanics_json              TEXT NOT NULL DEFAULT '{}',
      context_json                TEXT NOT NULL DEFAULT '{}',
      created_at                  TEXT DEFAULT (datetime('now')),
      updated_at                  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_rec_context_date
      ON jarvis_recommendation_context(rec_date DESC);

    CREATE TABLE IF NOT EXISTS jarvis_recommendation_outcome_daily (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_date                    TEXT NOT NULL UNIQUE,
      posture_evaluation          TEXT,
      strategy_score_label        TEXT,
      tp_score_label              TEXT,
      actual_pnl                  REAL,
      best_possible_pnl           REAL,
      recommendation_delta        REAL,
      outcome_json                TEXT NOT NULL DEFAULT '{}',
      calculated_at               TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_rec_outcome_date
      ON jarvis_recommendation_outcome_daily(rec_date DESC);

    CREATE TABLE IF NOT EXISTS jarvis_recommendation_context_history (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_date                    TEXT NOT NULL,
      source_type                 TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase        TEXT NOT NULL DEFAULT 'live_intraday',
      reconstruction_version      TEXT NOT NULL DEFAULT 'live_v1',
      generated_at                TEXT,
      posture                     TEXT,
      recommended_strategy_key    TEXT,
      recommended_strategy_name   TEXT,
      recommended_tp_mode         TEXT,
      confidence_label            TEXT,
      confidence_score            REAL,
      recommendation_json         TEXT NOT NULL DEFAULT '{}',
      strategy_layers_json        TEXT NOT NULL DEFAULT '{}',
      mechanics_json              TEXT NOT NULL DEFAULT '{}',
      context_json                TEXT NOT NULL DEFAULT '{}',
      created_at                  TEXT DEFAULT (datetime('now')),
      updated_at                  TEXT DEFAULT (datetime('now')),
      UNIQUE(rec_date, source_type, reconstruction_phase)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_rec_ctx_hist_date
      ON jarvis_recommendation_context_history(rec_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_rec_ctx_hist_source
      ON jarvis_recommendation_context_history(source_type, reconstruction_phase, rec_date DESC);

    CREATE TABLE IF NOT EXISTS jarvis_recommendation_outcome_history (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_date                    TEXT NOT NULL,
      source_type                 TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase        TEXT NOT NULL DEFAULT 'live_intraday',
      reconstruction_version      TEXT NOT NULL DEFAULT 'live_v1',
      posture_evaluation          TEXT,
      strategy_score_label        TEXT,
      tp_score_label              TEXT,
      actual_pnl                  REAL,
      best_possible_pnl           REAL,
      recommendation_delta        REAL,
      outcome_json                TEXT NOT NULL DEFAULT '{}',
      calculated_at               TEXT DEFAULT (datetime('now')),
      UNIQUE(rec_date, source_type, reconstruction_phase)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_rec_out_hist_date
      ON jarvis_recommendation_outcome_history(rec_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_rec_out_hist_source
      ON jarvis_recommendation_outcome_history(source_type, reconstruction_phase, rec_date DESC);

    CREATE TABLE IF NOT EXISTS jarvis_assistant_decision_outcome_checkpoints (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                    TEXT NOT NULL UNIQUE,
      source_type                   TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase          TEXT NOT NULL DEFAULT 'live_intraday',
      reconstruction_version        TEXT NOT NULL DEFAULT 'live_v1',
      front_line_action_now         TEXT,
      posture                       TEXT,
      recommended_strategy_key      TEXT,
      recommended_strategy_name     TEXT,
      recommended_tp_mode           TEXT,
      confidence_label              TEXT,
      confidence_score              REAL,
      projected_win_chance          REAL,
      blocker_state                 TEXT,
      blocker_reason                TEXT,
      clearance_guidance_snapshot_json TEXT NOT NULL DEFAULT '{}',
      assistant_brief_text          TEXT,
      realized_outcome_classification TEXT NOT NULL,
      realized_outcome_reason       TEXT,
      actual_trade_taken            INTEGER NOT NULL DEFAULT 0,
      actual_pnl                    REAL,
      best_possible_pnl             REAL,
      recommendation_delta          REAL,
      posture_evaluation            TEXT,
      strategy_score_label          TEXT,
      tp_score_label                TEXT,
      snapshot_json                 TEXT NOT NULL DEFAULT '{}',
      outcome_json                  TEXT NOT NULL DEFAULT '{}',
      created_at                    TEXT DEFAULT (datetime('now')),
      updated_at                    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_assistant_decision_checkpoint_date
      ON jarvis_assistant_decision_outcome_checkpoints(trade_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_assistant_decision_checkpoint_class
      ON jarvis_assistant_decision_outcome_checkpoints(realized_outcome_classification, trade_date DESC);

    CREATE TABLE IF NOT EXISTS jarvis_shadow_playbook_daily (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                    TEXT NOT NULL,
      playbook_key                  TEXT NOT NULL,
      playbook_version              TEXT NOT NULL DEFAULT 'v1',
      source_type                   TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase          TEXT NOT NULL DEFAULT 'live_intraday',
      eligible                      INTEGER NOT NULL DEFAULT 0,
      fit_score                     REAL,
      skip_reason                   TEXT,
      context_snapshot_json         TEXT NOT NULL DEFAULT '{}',
      hypothetical_direction        TEXT,
      entry_reference_json          TEXT NOT NULL DEFAULT '{}',
      invalidation_reference_json   TEXT NOT NULL DEFAULT '{}',
      target_reference_json         TEXT NOT NULL DEFAULT '{}',
      hypothetical_result           TEXT NOT NULL DEFAULT 'no_trade',
      hypothetical_pnl              REAL,
      orb_overlap_label             TEXT,
      data_quality_status           TEXT NOT NULL DEFAULT 'ok',
      evaluation_json               TEXT NOT NULL DEFAULT '{}',
      created_at                    TEXT DEFAULT (datetime('now')),
      updated_at                    TEXT DEFAULT (datetime('now')),
      UNIQUE(trade_date, playbook_key, playbook_version)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_shadow_playbook_daily_date
      ON jarvis_shadow_playbook_daily(trade_date DESC, playbook_key, playbook_version);

    CREATE TABLE IF NOT EXISTS jarvis_shadow_playbook_durability_summary (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_trade_date              TEXT NOT NULL,
      playbook_key                  TEXT NOT NULL,
      playbook_version              TEXT NOT NULL DEFAULT 'v1',
      source_type                   TEXT NOT NULL DEFAULT 'all',
      reconstruction_phase          TEXT NOT NULL DEFAULT 'mixed',
      total_eligible_days           INTEGER NOT NULL DEFAULT 0,
      total_predecision_green_days  INTEGER NOT NULL DEFAULT 0,
      shadow_beats_orb_count        INTEGER NOT NULL DEFAULT 0,
      orb_beats_shadow_count        INTEGER NOT NULL DEFAULT 0,
      trend_verdict                 TEXT NOT NULL DEFAULT 'flat',
      promotion_readiness_status    TEXT NOT NULL DEFAULT 'blocked_due_to_truth_coverage',
      promotion_readiness_block_reason TEXT,
      promotion_readiness_block_reasons_json TEXT NOT NULL DEFAULT '[]',
      promotion_readiness_thresholds_json TEXT NOT NULL DEFAULT '{}',
      external_finalized_days       INTEGER NOT NULL DEFAULT 0,
      unfinalized_days              INTEGER NOT NULL DEFAULT 0,
      external_coverage_pct         REAL,
      rolling5_external_finalized_days INTEGER NOT NULL DEFAULT 0,
      rolling5_external_coverage_pct REAL,
      rolling10_external_finalized_days INTEGER NOT NULL DEFAULT 0,
      rolling10_external_coverage_pct REAL,
      externally_finalized_eligible_days INTEGER NOT NULL DEFAULT 0,
      externally_unfinalized_eligible_days INTEGER NOT NULL DEFAULT 0,
      unfinalized_trade_dates_json  TEXT NOT NULL DEFAULT '[]',
      coverage_aware_trust_classification TEXT NOT NULL DEFAULT 'not_trustworthy_until_topstep_returns',
      latest_day_provisional        INTEGER NOT NULL DEFAULT 0,
      latest_day_provisional_reason TEXT,
      full_sample_json              TEXT NOT NULL DEFAULT '{}',
      rolling5_json                 TEXT NOT NULL DEFAULT '{}',
      rolling10_json                TEXT NOT NULL DEFAULT '{}',
      summary_json                  TEXT NOT NULL DEFAULT '{}',
      calculated_at                 TEXT DEFAULT (datetime('now')),
      updated_at                    TEXT DEFAULT (datetime('now')),
      UNIQUE(as_of_trade_date, playbook_key, playbook_version, source_type, reconstruction_phase)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_shadow_playbook_durability_summary_date
      ON jarvis_shadow_playbook_durability_summary(as_of_trade_date DESC, playbook_key, playbook_version, source_type, reconstruction_phase);

    CREATE TABLE IF NOT EXISTS jarvis_simulated_trade_outcome_ledger_daily (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                    TEXT NOT NULL,
      source_type                   TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase          TEXT NOT NULL DEFAULT 'live_intraday',
      simulation_version            TEXT NOT NULL DEFAULT 'jarvis_simulated_trade_outcome_v1',
      did_jarvis_take_trade         INTEGER NOT NULL DEFAULT 0,
      no_trade_reason               TEXT,
      strategy_key                  TEXT,
      strategy_name                 TEXT,
      tp_mode_selected              TEXT,
      entry_price                   REAL,
      stop_price                    REAL,
      nearest_tp_price              REAL,
      skip1_tp_price                REAL,
      skip2_tp_price                REAL,
      selected_target_price         REAL,
      selected_path_outcome         TEXT,
      selected_path_pnl             REAL,
      nearest_tp_outcome            TEXT,
      skip1_tp_outcome              TEXT,
      skip2_tp_outcome              TEXT,
      max_favorable_excursion       REAL,
      max_adverse_excursion         REAL,
      source_candles_complete       INTEGER NOT NULL DEFAULT 0,
      simulation_confidence         REAL,
      snapshot_json                 TEXT NOT NULL DEFAULT '{}',
      created_at                    TEXT DEFAULT (datetime('now')),
      updated_at                    TEXT DEFAULT (datetime('now')),
      UNIQUE(trade_date, source_type, reconstruction_phase, simulation_version)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_sim_trade_ledger_date
      ON jarvis_simulated_trade_outcome_ledger_daily(trade_date DESC, source_type, reconstruction_phase, simulation_version);

    CREATE TABLE IF NOT EXISTS late_entry_policy_experiment_daily (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                    TEXT NOT NULL,
      policy_key                    TEXT NOT NULL,
      policy_version                TEXT NOT NULL DEFAULT 'v1',
      source_type                   TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase          TEXT NOT NULL DEFAULT 'live_intraday',
      baseline_would_trade          INTEGER NOT NULL DEFAULT 0,
      baseline_no_trade_reason      TEXT,
      extension_would_trade         INTEGER NOT NULL DEFAULT 0,
      extension_decision_reason     TEXT,
      extension_reason_codes_json   TEXT NOT NULL DEFAULT '[]',
      entry_time                    TEXT,
      direction                     TEXT,
      strategy_key                  TEXT,
      strategy_name                 TEXT,
      selected_tp_mode              TEXT,
      selected_outcome              TEXT,
      selected_pnl                  REAL,
      nearest_outcome               TEXT,
      nearest_pnl                   REAL,
      skip1_outcome                 TEXT,
      skip1_pnl                     REAL,
      skip2_outcome                 TEXT,
      skip2_pnl                     REAL,
      regime_label                  TEXT,
      weekday                       TEXT,
      orb_range_ticks               REAL,
      confirmation_time_bucket      TEXT,
      source_candles_complete       INTEGER NOT NULL DEFAULT 0,
      simulation_confidence         REAL,
      summary_json                  TEXT NOT NULL DEFAULT '{}',
      created_at                    TEXT DEFAULT (datetime('now')),
      updated_at                    TEXT DEFAULT (datetime('now')),
      UNIQUE(trade_date, policy_key, policy_version, source_type, reconstruction_phase)
    );

    CREATE INDEX IF NOT EXISTS idx_late_entry_policy_experiment_date
      ON late_entry_policy_experiment_daily(trade_date DESC, policy_key, policy_version, source_type, reconstruction_phase);

    CREATE TABLE IF NOT EXISTS jarvis_live_context_creation_audit (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_date                    TEXT NOT NULL,
      source_type                 TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase        TEXT NOT NULL DEFAULT 'live_intraday',
      creation_status             TEXT NOT NULL,
      classification              TEXT,
      reason_code                 TEXT,
      trigger_source              TEXT,
      details_json                TEXT NOT NULL DEFAULT '{}',
      created_at                  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_live_ctx_creation_audit_date
      ON jarvis_live_context_creation_audit(rec_date DESC, creation_status, created_at DESC);

    CREATE TABLE IF NOT EXISTS jarvis_live_context_suppression (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_date                    TEXT NOT NULL,
      source_type                 TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase        TEXT NOT NULL DEFAULT 'live_intraday',
      suppression_status          TEXT NOT NULL DEFAULT 'suppressed',
      classification              TEXT,
      reason_code                 TEXT,
      is_active                   INTEGER NOT NULL DEFAULT 1,
      details_json                TEXT NOT NULL DEFAULT '{}',
      created_at                  TEXT DEFAULT (datetime('now')),
      updated_at                  TEXT DEFAULT (datetime('now')),
      UNIQUE(rec_date, source_type, reconstruction_phase)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_live_ctx_suppression_active
      ON jarvis_live_context_suppression(is_active, rec_date DESC);
  `);

  const ensureColumn = (tableName, columnName, definition) => {
    if (!tableHasColumn(db, tableName, columnName)) {
      try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      } catch {}
    }
  };
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'promotion_readiness_status', `TEXT NOT NULL DEFAULT '${SHADOW_PLAYBOOK_PROMOTION_READINESS_BLOCKED}'`);
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'promotion_readiness_block_reason', 'TEXT');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'promotion_readiness_block_reasons_json', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'promotion_readiness_thresholds_json', `TEXT NOT NULL DEFAULT '{}'`);
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'external_finalized_days', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'unfinalized_days', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'external_coverage_pct', 'REAL');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'rolling5_external_finalized_days', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'rolling5_external_coverage_pct', 'REAL');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'rolling10_external_finalized_days', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'rolling10_external_coverage_pct', 'REAL');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'externally_finalized_eligible_days', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'externally_unfinalized_eligible_days', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'unfinalized_trade_dates_json', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'coverage_aware_trust_classification', `TEXT NOT NULL DEFAULT '${SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY}'`);
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'latest_day_provisional', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jarvis_shadow_playbook_durability_summary', 'latest_day_provisional_reason', 'TEXT');
}

function safeJsonParse(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return fallback;
}

function upsertTodayRecommendationContext(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const recDate = normalizeDate(input.recDate || input.date);
  if (!recDate) return null;
  const sourceType = normalizeSourceType(input.sourceType);
  const reconstructionPhase = normalizeReconstructionPhase(input.reconstructionPhase, sourceType);
  const reconstructionVersion = normalizeReconstructionVersion(input.reconstructionVersion, sourceType);
  const generatedAt = toText(input.generatedAt || '') || new Date().toISOString();

  const recommendation = input.todayRecommendation && typeof input.todayRecommendation === 'object'
    ? input.todayRecommendation
    : {};
  const strategyLayers = input.strategyLayers && typeof input.strategyLayers === 'object'
    ? input.strategyLayers
    : {};
  const mechanics = input.mechanicsResearchSummary && typeof input.mechanicsResearchSummary === 'object'
    ? input.mechanicsResearchSummary
    : {};
  const context = input.context && typeof input.context === 'object'
    ? input.context
    : {};
  const triggerSource = toText(input.triggerSource || '').toLowerCase() || 'unknown';

  if (sourceType === SOURCE_LIVE && reconstructionPhase === PHASE_LIVE_INTRADAY) {
    const guard = evaluateLiveContextCreationGuard({
      recDate,
      context,
      sessions: input.sessions && typeof input.sessions === 'object'
        ? input.sessions
        : null,
      sessionForDate: Array.isArray(input.sessionForDate) ? input.sessionForDate : null,
    });
    recordLiveContextCreationAudit(db, {
      recDate,
      sourceType,
      reconstructionPhase,
      status: guard.status,
      classification: guard.classification,
      reasonCode: guard.reasonCode,
      triggerSource,
      details: {
        contextDate: guard.contextDate,
        sessionCount: guard.sessionCount,
        hasSessionForDate: guard.hasSessionForDate === true,
      },
    });
    if (guard.status !== LIVE_CONTEXT_GUARD_STATUS_ALLOWED) {
      upsertLiveContextSuppression(db, {
        recDate,
        sourceType,
        reconstructionPhase,
        isActive: true,
        reasonCode: guard.reasonCode,
        classification: guard.classification,
        details: {
          triggerSource,
          guardStatus: guard.status,
          contextDate: guard.contextDate,
          sessionCount: guard.sessionCount,
          hasSessionForDate: guard.hasSessionForDate === true,
        },
      });
      return {
        recDate,
        sourceType,
        reconstructionPhase,
        reconstructionVersion,
        contextCreationStatus: guard.status,
        contextCreationReason: guard.reasonCode,
        contextCreationAllowed: false,
        advisoryOnly: true,
      };
    }
    upsertLiveContextSuppression(db, {
      recDate,
      sourceType,
      reconstructionPhase,
      isActive: false,
      reasonCode: 'valid_trading_day_context',
      classification: guard.classification,
      details: {
        triggerSource,
        guardStatus: guard.status,
      },
    });
  }

  const legacyInsert = db.prepare(`
    INSERT INTO jarvis_recommendation_context (
      rec_date,
      posture,
      recommended_strategy_key,
      recommended_strategy_name,
      recommended_tp_mode,
      confidence_label,
      confidence_score,
      recommendation_json,
      strategy_layers_json,
      mechanics_json,
      context_json,
      updated_at
    ) VALUES (
      @rec_date,
      @posture,
      @recommended_strategy_key,
      @recommended_strategy_name,
      @recommended_tp_mode,
      @confidence_label,
      @confidence_score,
      @recommendation_json,
      @strategy_layers_json,
      @mechanics_json,
      @context_json,
      datetime('now')
    )
    ON CONFLICT(rec_date) DO UPDATE SET
      posture = excluded.posture,
      recommended_strategy_key = excluded.recommended_strategy_key,
      recommended_strategy_name = excluded.recommended_strategy_name,
      recommended_tp_mode = excluded.recommended_tp_mode,
      confidence_label = excluded.confidence_label,
      confidence_score = excluded.confidence_score,
      recommendation_json = excluded.recommendation_json,
      strategy_layers_json = excluded.strategy_layers_json,
      mechanics_json = excluded.mechanics_json,
      context_json = excluded.context_json,
      updated_at = datetime('now')
  `);
  const insert = db.prepare(`
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
      context_json,
      updated_at
    ) VALUES (
      @rec_date,
      @source_type,
      @reconstruction_phase,
      @reconstruction_version,
      @generated_at,
      @posture,
      @recommended_strategy_key,
      @recommended_strategy_name,
      @recommended_tp_mode,
      @confidence_label,
      @confidence_score,
      @recommendation_json,
      @strategy_layers_json,
      @mechanics_json,
      @context_json,
      datetime('now')
    )
    ON CONFLICT(rec_date, source_type, reconstruction_phase) DO UPDATE SET
      reconstruction_version = excluded.reconstruction_version,
      generated_at = excluded.generated_at,
      posture = excluded.posture,
      recommended_strategy_key = excluded.recommended_strategy_key,
      recommended_strategy_name = excluded.recommended_strategy_name,
      recommended_tp_mode = excluded.recommended_tp_mode,
      confidence_label = excluded.confidence_label,
      confidence_score = excluded.confidence_score,
      recommendation_json = excluded.recommendation_json,
      strategy_layers_json = excluded.strategy_layers_json,
      mechanics_json = excluded.mechanics_json,
      context_json = excluded.context_json,
      updated_at = datetime('now')
  `);

  const strategyKey = toText(strategyLayers?.recommendationBasis?.recommendedStrategyKey)
    || toText(recommendation.recommendedStrategy);
  const confidenceScore = toNumber(recommendation.confidenceScore, null);

  const params = {
    rec_date: recDate,
    source_type: sourceType,
    reconstruction_phase: reconstructionPhase,
    reconstruction_version: reconstructionVersion,
    generated_at: generatedAt,
    posture: toText(recommendation.posture || ''),
    recommended_strategy_key: strategyKey || null,
    recommended_strategy_name: toText(recommendation.recommendedStrategy || strategyLayers?.recommendationBasis?.recommendedStrategyName || '') || null,
    recommended_tp_mode: normalizeTpMode(recommendation.recommendedTpMode || mechanics?.recommendedTpMode || ''),
    confidence_label: toText(recommendation.confidenceLabel || '') || null,
    confidence_score: Number.isFinite(confidenceScore) ? confidenceScore : null,
    recommendation_json: JSON.stringify(recommendation || {}),
    strategy_layers_json: JSON.stringify(strategyLayers || {}),
    mechanics_json: JSON.stringify(mechanics || {}),
    context_json: JSON.stringify(context || {}),
  };
  insert.run(params);
  // Keep legacy single-row table updated for backward compatibility with older diagnostics.
  if (sourceType === SOURCE_LIVE && reconstructionPhase === PHASE_LIVE_INTRADAY) {
    legacyInsert.run(params);
  }

  return {
    recDate,
    sourceType,
    reconstructionPhase,
    reconstructionVersion,
    contextCreationStatus: LIVE_CONTEXT_GUARD_STATUS_ALLOWED,
    contextCreationAllowed: true,
    posture: toText(recommendation.posture || ''),
    recommendedStrategyKey: strategyKey || null,
    recommendedTpMode: normalizeTpMode(recommendation.recommendedTpMode || mechanics?.recommendedTpMode || ''),
  };
}

function getRecommendationContextRow(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const recDate = normalizeDate(options.recDate || options.date);
  if (!recDate) return null;
  const sourceType = normalizeSourceType(options.sourceType);
  const reconstructionPhase = normalizeReconstructionPhase(options.reconstructionPhase, sourceType);
  return db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    WHERE rec_date = ? AND source_type = ? AND reconstruction_phase = ?
    LIMIT 1
  `).get(recDate, sourceType, reconstructionPhase);
}

function listRecommendationContexts(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  ensureRecommendationOutcomeSchema(db);
  const limit = Math.max(1, Math.min(500, Number(options.limit || options.windowSessions || 120)));
  const sinceDate = normalizeDate(options.sinceDate || '');
  const source = toText(options.source || 'all').toLowerCase();
  const sourceFilter = source === SOURCE_LIVE || source === SOURCE_BACKFILL
    ? source
    : null;
  const reconstructionPhaseRaw = toText(options.reconstructionPhase || '').toLowerCase();
  const reconstructionPhase = reconstructionPhaseRaw === 'mixed' ? '' : reconstructionPhaseRaw;
  const includeSuppressed = options.includeSuppressed === true;

  const where = [];
  const params = [];
  if (sinceDate) {
    where.push('rec_date >= ?');
    params.push(sinceDate);
  }
  if (sourceFilter) {
    where.push('source_type = ?');
    params.push(sourceFilter);
  }
  if (reconstructionPhase) {
    where.push('reconstruction_phase = ?');
    params.push(reconstructionPhase);
  }
  if (!includeSuppressed) {
    where.push(`NOT EXISTS (
      SELECT 1
      FROM jarvis_live_context_suppression s
      WHERE s.rec_date = jarvis_recommendation_context_history.rec_date
        AND s.source_type = jarvis_recommendation_context_history.source_type
        AND s.reconstruction_phase = jarvis_recommendation_context_history.reconstruction_phase
        AND s.is_active = 1
    )`);
  }
  params.push(limit);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM jarvis_recommendation_context_history
    ${clause}
    ORDER BY rec_date DESC
    LIMIT ?
  `).all(...params);
}

function inspectRecommendationPerformanceRows(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  ensureRecommendationOutcomeSchema(db);
  const limit = Math.max(1, Math.min(200, Number(options.limit || 10)));
  const source = toText(options.source || 'all').toLowerCase();
  const sourceFilter = source === SOURCE_LIVE || source === SOURCE_BACKFILL
    ? source
    : null;
  const reconstructionPhaseRaw = toText(options.reconstructionPhase || '').toLowerCase();
  const reconstructionPhase = reconstructionPhaseRaw === 'mixed' ? '' : reconstructionPhaseRaw;
  const where = [];
  const params = [];

  if (sourceFilter) {
    where.push('c.source_type = ?');
    params.push(sourceFilter);
  }
  if (reconstructionPhase) {
    where.push('c.reconstruction_phase = ?');
    params.push(reconstructionPhase);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);

  const rows = db.prepare(`
    SELECT
      c.rec_date,
      c.source_type,
      c.reconstruction_phase,
      c.reconstruction_version,
      c.generated_at,
      c.created_at AS context_created_at,
      c.updated_at AS context_updated_at,
      o.posture_evaluation,
      o.strategy_score_label,
      o.tp_score_label,
      o.calculated_at
    FROM jarvis_recommendation_context_history c
    LEFT JOIN jarvis_recommendation_outcome_history o
      ON o.rec_date = c.rec_date
      AND o.source_type = c.source_type
      AND o.reconstruction_phase = c.reconstruction_phase
    ${clause}
    ORDER BY c.rec_date DESC
    LIMIT ?
  `).all(...params);

  return rows.map((row) => ({
    recDate: normalizeDate(row.rec_date),
    sourceType: normalizeSourceType(row.source_type),
    reconstructionPhase: normalizeReconstructionPhase(row.reconstruction_phase, row.source_type),
    reconstructionVersion: normalizeReconstructionVersion(row.reconstruction_version, row.source_type),
    postureEvaluation: toText(row.posture_evaluation || '') || null,
    strategyScoreLabel: toText(row.strategy_score_label || '') || null,
    tpScoreLabel: toText(row.tp_score_label || '') || null,
    scoreVersion: SCORE_VERSION,
    createdAt: toText(row.context_created_at || '') || null,
    updatedAt: toText(row.context_updated_at || '') || null,
    generatedAt: toText(row.generated_at || '') || null,
    scoredAt: toText(row.calculated_at || '') || null,
  }));
}

function scorePosture({ posture, actualPnl, bestPossiblePnl, actualTradeTaken }) {
  const p = toText(posture).toLowerCase();
  const pnl = toNumber(actualPnl, 0);
  const best = toNumber(bestPossiblePnl, pnl);
  const tookTrade = !!actualTradeTaken;

  if (p === 'stand_down') {
    if (best <= 0 || pnl <= -50) return 'correct';
    if (best <= 75) return 'partially_correct';
    return 'incorrect';
  }
  if (p === 'wait_for_news') {
    if (pnl < 0) return 'correct';
    if (best > 0 && pnl >= 0) return 'partially_correct';
    return 'partially_correct';
  }
  if (p === 'trade_normally') {
    if (tookTrade && pnl > 0) return 'correct';
    if (!tookTrade && best > 0) return 'incorrect';
    if (pnl >= -25) return 'partially_correct';
    return 'incorrect';
  }
  // trade_selectively and fallback
  if (best >= 100 && pnl > 0) return 'partially_correct';
  if (pnl > 0 && best < 100) return 'correct';
  if (pnl <= 0 && best <= 0) return 'correct';
  if (pnl >= -25) return 'partially_correct';
  return 'incorrect';
}

function isDefensivePostureForCheckpoint(posture = '') {
  const key = toText(posture).toLowerCase();
  if (!key) return false;
  return key === 'stand_down'
    || key === 'wait_for_clearance'
    || key === 'wait_for_news'
    || key === 'use_caution'
    || key === 'cleaner_move_only'
    || key === 'degraded_target_bias';
}

function isDefensiveActionForCheckpoint(actionNow = '') {
  const text = toText(actionNow).toLowerCase();
  if (!text) return false;
  return /\bwait\b/.test(text)
    || /\bdon['’]?t trade\b/.test(text)
    || /\bdo not trade\b/.test(text)
    || /\bstand down\b/.test(text)
    || /\bsit out\b/.test(text)
    || /\bskip\b/.test(text);
}

function classifyAssistantDecisionOutcomeCheckpoint(input = {}) {
  const actionNow = toText(input.actionNow || '');
  const posture = toText(input.posture || '');
  const actualTradeTaken = input.actualTradeTaken === true;
  const actualPnl = toNumber(input.actualPnl, 0);
  const bestPossiblePnl = toNumber(input.bestPossiblePnl, actualPnl);
  const recommendationDelta = toNumber(input.recommendationDelta, null);
  const strategyScoreLabel = toText(input.strategyScoreLabel || '').toLowerCase();
  const tpScoreLabel = toText(input.tpScoreLabel || '').toLowerCase();
  const postureEvaluation = toText(input.postureEvaluation || '').toLowerCase();
  const hasUnknownScores = strategyScoreLabel === 'unknown' && tpScoreLabel === 'unknown';
  const noStrategyEvidence = !input.bestStrategyOutcome && !input.bestMechanicsOutcome;
  if (hasUnknownScores && noStrategyEvidence && !actualTradeTaken) {
    return {
      classification: ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_INSUFFICIENT_EVIDENCE,
      reason: 'Not enough realized outcome evidence to grade this call yet.',
    };
  }

  const defensiveCall = isDefensiveActionForCheckpoint(actionNow) || isDefensivePostureForCheckpoint(posture);
  const positiveOpportunity = bestPossiblePnl > 0;
  const negativeRealized = actualPnl < 0;
  if (defensiveCall && positiveOpportunity && (!actualTradeTaken || Number(recommendationDelta || 0) < 0)) {
    return {
      classification: ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_CONSERVATIVE,
      reason: 'Call stayed defensive while realized opportunity was positive.',
    };
  }
  if (!defensiveCall && (negativeRealized || postureEvaluation === 'incorrect')) {
    return {
      classification: ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_AGGRESSIVE,
      reason: 'Call leaned trade-forward while realized outcome was weak.',
    };
  }
  return {
    classification: ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_CORRECT,
    reason: 'Call aligned with realized conditions for the day.',
  };
}

function classifyModelVsRealizedDivergence(input = {}) {
  const classification = normalizeAssistantDecisionOutcomeClassification(input.classification || '');
  const posture = toText(input.posture || '');
  const actionNow = toText(input.actionNow || '');
  const blockerState = toText(input.blockerState || '').toLowerCase();
  const actualTradeTaken = input.actualTradeTaken === true;
  const external = input.externalExecutionOutcome && typeof input.externalExecutionOutcome === 'object'
    ? input.externalExecutionOutcome
    : {};
  const externalTradeCount = Number(external.tradeCount || 0);
  const externalNetPnl = toNumber(external.netPnlDollars, 0);
  const defensiveCall = blockerState === 'blocked'
    || isDefensivePostureForCheckpoint(posture)
    || isDefensiveActionForCheckpoint(actionNow);
  const hasMeaningfulExternalProfit = externalTradeCount > 0
    && Number.isFinite(externalNetPnl)
    && externalNetPnl >= EXTERNAL_PROFIT_OPPORTUNITY_MIN_PNL_DOLLARS;

  if (
    classification === ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_CORRECT
    && defensiveCall
    && !actualTradeTaken
    && hasMeaningfulExternalProfit
  ) {
    return {
      classification: MODEL_VS_REALIZED_DIVERGENCE_EXTERNAL_PROFIT_WHILE_MODEL_DEFENSIVE,
      detected: true,
      reason: `Model stayed defensive and graded correct, but external executed outcomes were profitable (+$${round2(externalNetPnl)}).`,
    };
  }
  return {
    classification: MODEL_VS_REALIZED_DIVERGENCE_NONE,
    detected: false,
    reason: null,
  };
}

function getLatestTooAggressiveCheckpointSentinel(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const asOfDate = normalizeDate(input.asOfDate || input.date || '');
  const includeSameDay = input.includeSameDay === true;
  const latest = db.prepare(`
    SELECT
      trade_date,
      realized_outcome_classification,
      blocker_state,
      posture,
      recommended_tp_mode,
      confidence_label,
      confidence_score,
      front_line_action_now
    FROM jarvis_assistant_decision_outcome_checkpoints
    ORDER BY trade_date DESC, id DESC
    LIMIT 1
  `).get();
  if (!latest) return null;
  const classification = normalizeAssistantDecisionOutcomeClassification(
    latest.realized_outcome_classification
  );
  if (classification !== ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_TOO_AGGRESSIVE) return null;
  const tradeDate = normalizeDate(latest.trade_date || '');
  if (asOfDate && !includeSameDay && tradeDate && tradeDate >= asOfDate) return null;
  return {
    tradeDate: tradeDate || null,
    classification,
    blockerState: toText(latest.blocker_state || '').toLowerCase() || null,
    posture: toText(latest.posture || '').toLowerCase() || null,
    recommendedTpMode: normalizeTpMode(latest.recommended_tp_mode || '') || null,
    confidenceLabel: toText(latest.confidence_label || '').toLowerCase() || null,
    confidenceScore: Number.isFinite(toNumber(latest.confidence_score, null))
      ? round2(toNumber(latest.confidence_score, null))
      : null,
    frontLineActionNow: toText(latest.front_line_action_now || '') || null,
  };
}

function resolveProjectedWinChanceForCheckpoint(recommendationJson = {}, strategyLayersJson = {}, contextJson = {}) {
  const candidates = [
    recommendationJson?.projectedWinChance,
    recommendationJson?.projectedWinChancePct,
    recommendationJson?.winChance,
    recommendationJson?.eliteWinModelPoint,
    strategyLayersJson?.jarvisBrief?.projectedWinChance,
    strategyLayersJson?.jarvisBrief?.eliteProjectedWinChance,
    strategyLayersJson?.todayRecommendation?.projectedWinChance,
    strategyLayersJson?.todayRecommendation?.projectedWinChancePct,
    strategyLayersJson?.commandCenter?.projectedWinChance,
    contextJson?.projectedWinChance,
  ];
  for (const candidate of candidates) {
    const value = toNumber(candidate, null);
    if (Number.isFinite(value)) return round2(value);
  }
  return null;
}

function buildCheckpointExternalExecutionPayload(externalExecutionOutcome = {}, tradeDate = '') {
  return {
    hasRows: externalExecutionOutcome?.hasRows === true,
    tradeCount: Number(externalExecutionOutcome?.tradeCount || 0),
    wins: Number(externalExecutionOutcome?.wins || 0),
    losses: Number(externalExecutionOutcome?.losses || 0),
    breakeven: Number(externalExecutionOutcome?.breakeven || 0),
    netPnlDollars: round2(Number(externalExecutionOutcome?.netPnlDollars || 0)),
    sourceBacked: externalExecutionOutcome?.sourceBacked === true,
    sourceTable: toText(externalExecutionOutcome?.sourceTable || '') || 'trade_outcome_feedback',
    sourceInUse: normalizeRealizedTruthSource(externalExecutionOutcome?.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
    trustClassification: normalizeShadowPlaybookDurabilityTrust(
      externalExecutionOutcome?.trustClassification || REALIZED_TRUTH_TRUST_PARTIAL
    ),
    trustReasonCodes: Array.isArray(externalExecutionOutcome?.trustReasonCodes)
      ? externalExecutionOutcome.trustReasonCodes.map((code) => toText(code)).filter(Boolean)
      : [],
    sourceAttribution: externalExecutionOutcome?.sourceAttribution
      && typeof externalExecutionOutcome.sourceAttribution === 'object'
      ? externalExecutionOutcome.sourceAttribution
      : {
        primarySource: REALIZED_TRUTH_SOURCE_PRIMARY,
        sourceInUse: normalizeRealizedTruthSource(externalExecutionOutcome?.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
        fallbackSourceInUse: null,
        sourceLevel: 'none',
        sourceFreshness: {
          latestTopstepSyncAt: null,
          latestTopstepSyncStatus: 'unknown',
          latestTopstepTruthTradeDate: null,
          targetTradeDate: normalizeDate(tradeDate) || null,
          targetDateInStaleWindow: false,
          sourceLagDays: null,
        },
        sourceLadder: {},
        recoveryPlan: {
          backfillPending: false,
          staleWindowStartDate: null,
          staleWindowEndDate: null,
          staleWindowDays: 0,
          targetDateInStaleWindow: false,
          deterministicActions: [
            'restore_topstep_credentials_or_access',
            'run_topstep_sync',
            'run_topstep_auto_journal',
            'recompute_recommendation_performance',
          ],
        },
      },
  };
}

function upsertAssistantDecisionOutcomeCheckpoint(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const daily = input.daily && typeof input.daily === 'object' ? input.daily : {};
  const tradeDate = normalizeDate(input.tradeDate || input.date || input.recDate || daily.date);
  if (!tradeDate) return null;
  const sourceType = normalizeSourceType(input.sourceType || daily.sourceType);
  const reconstructionPhase = normalizeReconstructionPhase(
    input.reconstructionPhase || daily.reconstructionPhase,
    sourceType
  );
  const reconstructionVersion = normalizeReconstructionVersion(
    input.reconstructionVersion || daily.reconstructionVersion,
    sourceType
  );
  if (sourceType !== SOURCE_LIVE || reconstructionPhase !== PHASE_LIVE_INTRADAY) return null;

  const contextRow = input.contextRow && typeof input.contextRow === 'object'
    ? input.contextRow
    : {};
  const recommendationJson = safeJsonParse(contextRow?.recommendation_json, {});
  const strategyLayersJson = safeJsonParse(contextRow?.strategy_layers_json, {});
  const contextJson = safeJsonParse(contextRow?.context_json, {});
  const assistantDecisionBrief = recommendationJson?.assistantDecisionBrief
    && typeof recommendationJson.assistantDecisionBrief === 'object'
    ? recommendationJson.assistantDecisionBrief
    : {};
  const primaryGuidance = recommendationJson?.frontLinePrimaryBlockerGuidance
    && typeof recommendationJson.frontLinePrimaryBlockerGuidance === 'object'
    ? recommendationJson.frontLinePrimaryBlockerGuidance
    : null;

  const actionNow = toText(
    assistantDecisionBrief?.actionNow
    || recommendationJson?.actionNow
    || recommendationJson?.frontLineActionNow
    || ''
  ) || null;
  const blockerReason = toText(
    primaryGuidance?.blockedBy
    || recommendationJson?.frontLinePrimaryBlockerReason
    || recommendationJson?.blockerReason
    || ''
  ) || null;
  const blockerState = blockerReason ? 'blocked' : 'clear';
  const classificationResult = classifyAssistantDecisionOutcomeCheckpoint({
    actionNow,
    posture: daily.posture || contextRow?.posture || recommendationJson?.posture || '',
    actualTradeTaken: daily.actualTradeTaken === true,
    actualPnl: daily.actualPnL,
    bestPossiblePnl: daily.bestPossiblePnL,
    recommendationDelta: daily.recommendationDelta,
    strategyScoreLabel: daily?.strategyRecommendationScore?.scoreLabel || '',
    tpScoreLabel: daily?.tpRecommendationScore?.scoreLabel || '',
    postureEvaluation: daily.postureEvaluation || '',
    bestStrategyOutcome: daily.bestStrategyOutcome || null,
    bestMechanicsOutcome: daily.bestMechanicsOutcome || null,
  });
  const classification = normalizeAssistantDecisionOutcomeClassification(classificationResult.classification);
  const externalExecutionOutcome = resolveExternalExecutionOutcomeForDate(db, tradeDate);
  const modelVsRealizedDivergence = classifyModelVsRealizedDivergence({
    classification,
    actionNow,
    posture: daily.posture || contextRow?.posture || recommendationJson?.posture || '',
    blockerState,
    actualTradeTaken: daily.actualTradeTaken === true,
    externalExecutionOutcome,
  });
  const shadowComparison = daily?.shadowPlaybookComparisonSummary && typeof daily.shadowPlaybookComparisonSummary === 'object'
    ? {
      ...daily.shadowPlaybookComparisonSummary,
      laneReasonCodes: Array.isArray(daily.shadowPlaybookComparisonSummary.laneReasonCodes)
        ? daily.shadowPlaybookComparisonSummary.laneReasonCodes
        : [],
    }
    : null;
  if (shadowComparison) {
    const lane = classifyFailedExtensionReversalFadeShadowLane({
      eligible: shadowComparison.eligible === true,
      highRiskContext: daily?.shadowPlaybook?.contextSnapshot?.highRiskContext === true,
      blockerState,
      divergenceDetected: modelVsRealizedDivergence.detected === true,
      orbOverlapLabel: shadowComparison.orbOverlapLabel,
      orbWouldTrade: shadowComparison.orbWouldTrade === true,
      orbTradeResult: shadowComparison.orbTradeResult || null,
      orbPnlDollars: shadowComparison.orbPnlDollars,
      hypotheticalResult: shadowComparison.hypotheticalResult,
    });
    shadowComparison.laneLabel = normalizeShadowPlaybookLaneLabel(lane.laneLabel);
    shadowComparison.laneReasonCodes = Array.isArray(lane.laneReasonCodes)
      ? lane.laneReasonCodes
      : [];
    shadowComparison.laneScore = Number.isFinite(toNumber(lane.laneScore, null))
      ? round2(toNumber(lane.laneScore, null))
      : 0;
    shadowComparison.highConvictionLaneMatch = lane.highConvictionLaneMatch === true;
    const split = splitFailedExtensionLaneReasonCodes(shadowComparison.laneReasonCodes);
    const predecisionLane = classifyFailedExtensionReversalFadeShadowPredecisionLane({
      eligible: shadowComparison.eligible === true,
      highRiskContext: daily?.shadowPlaybook?.contextSnapshot?.highRiskContext === true,
      blockerState,
    });
    shadowComparison.predecisionLaneLabel = normalizeShadowPlaybookLaneLabel(predecisionLane.laneLabel);
    shadowComparison.predecisionLaneReasonCodes = Array.isArray(predecisionLane.laneReasonCodes)
      ? predecisionLane.laneReasonCodes
      : [];
    shadowComparison.predecisionLaneScore = Number.isFinite(toNumber(predecisionLane.laneScore, null))
      ? round2(toNumber(predecisionLane.laneScore, null))
      : 0;
    shadowComparison.predecisionHighConvictionLaneMatch = predecisionLane.highConvictionLaneMatch === true;
    shadowComparison.predecisionRemovedReasonCodes = Array.isArray(split.removedHindsightReasonCodes)
      ? split.removedHindsightReasonCodes
      : [];
    shadowComparison.predecisionKeptReasonCodes = Array.isArray(split.preDecisionSafeReasonCodes)
      ? split.preDecisionSafeReasonCodes
      : [];
    shadowComparison.blockerState = blockerState;
    shadowComparison.posture = toText(daily.posture || contextRow?.posture || recommendationJson?.posture || '').toLowerCase() || null;
    shadowComparison.sessionPhase = toText(daily.timeBucket || contextJson?.sessionPhase || '').toLowerCase() || null;
    shadowComparison.divergenceDetected = modelVsRealizedDivergence.detected === true;

    daily.shadowPlaybookComparisonSummary = shadowComparison;
    if (daily.shadowPlaybook && typeof daily.shadowPlaybook === 'object') {
      daily.shadowPlaybook.blockerState = blockerState;
      daily.shadowPlaybook.divergenceDetected = modelVsRealizedDivergence.detected === true;
      daily.shadowPlaybook.laneLabel = shadowComparison.laneLabel;
      daily.shadowPlaybook.laneReasonCodes = shadowComparison.laneReasonCodes;
      daily.shadowPlaybook.laneScore = shadowComparison.laneScore;
      daily.shadowPlaybook.highConvictionLaneMatch = shadowComparison.highConvictionLaneMatch;
      daily.shadowPlaybook.predecisionLaneLabel = shadowComparison.predecisionLaneLabel;
      daily.shadowPlaybook.predecisionLaneReasonCodes = shadowComparison.predecisionLaneReasonCodes;
      daily.shadowPlaybook.predecisionLaneScore = shadowComparison.predecisionLaneScore;
      daily.shadowPlaybook.predecisionHighConvictionLaneMatch = shadowComparison.predecisionHighConvictionLaneMatch;
      daily.shadowPlaybook.predecisionRemovedReasonCodes = shadowComparison.predecisionRemovedReasonCodes;
      daily.shadowPlaybook.predecisionKeptReasonCodes = shadowComparison.predecisionKeptReasonCodes;
      daily.shadowPlaybook.evaluation = {
        ...(daily.shadowPlaybook.evaluation && typeof daily.shadowPlaybook.evaluation === 'object'
          ? daily.shadowPlaybook.evaluation
          : {}),
        laneLabel: shadowComparison.laneLabel,
        laneReasonCodes: shadowComparison.laneReasonCodes,
        laneScore: shadowComparison.laneScore,
        highConvictionLaneMatch: shadowComparison.highConvictionLaneMatch,
        predecisionLaneLabel: shadowComparison.predecisionLaneLabel,
        predecisionLaneReasonCodes: shadowComparison.predecisionLaneReasonCodes,
        predecisionLaneScore: shadowComparison.predecisionLaneScore,
        predecisionHighConvictionLaneMatch: shadowComparison.predecisionHighConvictionLaneMatch,
        predecisionRemovedReasonCodes: shadowComparison.predecisionRemovedReasonCodes,
        predecisionKeptReasonCodes: shadowComparison.predecisionKeptReasonCodes,
        blockerState,
        divergenceDetected: modelVsRealizedDivergence.detected === true,
      };
      try {
        upsertShadowPlaybookEvaluation({
          db,
          evaluation: daily.shadowPlaybook,
          sourceType,
          reconstructionPhase,
        });
      } catch {}
    }
  }
  const projectedWinChance = resolveProjectedWinChanceForCheckpoint(
    recommendationJson,
    strategyLayersJson,
    contextJson
  );
  const assistantBriefText = toText(
    recommendationJson?.assistantDecisionBriefText
    || assistantDecisionBrief?.assistantText
    || ''
  ) || null;
  const clearanceGuidanceSnapshot = primaryGuidance && typeof primaryGuidance === 'object'
    ? {
      blockerCode: toText(primaryGuidance?.blockerCode || '') || null,
      blockedBy: toText(primaryGuidance?.blockedBy || '') || null,
      clearanceCondition: toText(primaryGuidance?.clearanceCondition || '') || null,
      nextCheckWindow: toText(primaryGuidance?.nextCheckWindow || '') || null,
      riskIfIgnored: toText(primaryGuidance?.riskIfIgnored || '') || null,
      currentValue: Number.isFinite(toNumber(primaryGuidance?.currentValue, null))
        ? round2(toNumber(primaryGuidance?.currentValue, null))
        : null,
      threshold: Number.isFinite(toNumber(primaryGuidance?.threshold, null))
        ? round2(toNumber(primaryGuidance?.threshold, null))
        : null,
      deltaToClear: Number.isFinite(toNumber(primaryGuidance?.deltaToClear, null))
        ? round2(toNumber(primaryGuidance?.deltaToClear, null))
        : null,
      clearanceState: toText(primaryGuidance?.clearanceState || '') || null,
      mapped: primaryGuidance?.mapped === true,
    }
    : {};

  const checkpoint = {
    tradeDate,
    sourceType,
    reconstructionPhase,
    reconstructionVersion,
    frontLineActionNow: actionNow,
    posture: toText(daily.posture || contextRow?.posture || recommendationJson?.posture || '') || null,
    recommendedStrategyKey: toText(
      daily.recommendedStrategyKey
      || contextRow?.recommended_strategy_key
      || recommendationJson?.recommendedStrategyKey
      || ''
    ) || null,
    recommendedStrategyName: toText(
      contextRow?.recommended_strategy_name
      || recommendationJson?.recommendedStrategy
      || ''
    ) || null,
    recommendedTpMode: toText(
      daily.recommendedTpMode
      || contextRow?.recommended_tp_mode
      || recommendationJson?.recommendedTpMode
      || ''
    ) || null,
    confidenceLabel: toText(
      contextRow?.confidence_label
      || recommendationJson?.confidenceLabel
      || ''
    ) || null,
    confidenceScore: Number.isFinite(toNumber(
      contextRow?.confidence_score
      ?? recommendationJson?.confidenceScore,
      null
    ))
      ? round2(toNumber(contextRow?.confidence_score ?? recommendationJson?.confidenceScore, null))
      : null,
    projectedWinChance,
    blockerState,
    blockerReason,
    clearanceGuidanceSnapshot,
    assistantBriefText,
    realizedOutcomeClassification: classification,
    realizedOutcomeReason: toText(classificationResult.reason || '') || null,
    actualTradeTaken: daily.actualTradeTaken === true,
    actualPnl: Number.isFinite(toNumber(daily.actualPnL, null)) ? round2(toNumber(daily.actualPnL, null)) : null,
    bestPossiblePnl: Number.isFinite(toNumber(daily.bestPossiblePnL, null)) ? round2(toNumber(daily.bestPossiblePnL, null)) : null,
    recommendationDelta: Number.isFinite(toNumber(daily.recommendationDelta, null)) ? round2(toNumber(daily.recommendationDelta, null)) : null,
    postureEvaluation: toText(daily.postureEvaluation || '') || null,
    strategyScoreLabel: toText(daily?.strategyRecommendationScore?.scoreLabel || '') || null,
    tpScoreLabel: toText(daily?.tpRecommendationScore?.scoreLabel || '') || null,
    snapshotJson: {
      actionNow,
      posture: toText(daily.posture || contextRow?.posture || recommendationJson?.posture || '') || null,
      confidenceLabel: toText(contextRow?.confidence_label || recommendationJson?.confidenceLabel || '') || null,
      confidenceScore: Number.isFinite(toNumber(
        contextRow?.confidence_score ?? recommendationJson?.confidenceScore,
        null
      ))
        ? round2(toNumber(contextRow?.confidence_score ?? recommendationJson?.confidenceScore, null))
        : null,
      blockerReason,
      clearanceCondition: toText(primaryGuidance?.clearanceCondition || '') || null,
      assistantBriefText,
      projectedWinChance,
    },
    outcomeJson: {
      postureEvaluation: toText(daily.postureEvaluation || '') || null,
      strategyScoreLabel: toText(daily?.strategyRecommendationScore?.scoreLabel || '') || null,
      tpScoreLabel: toText(daily?.tpRecommendationScore?.scoreLabel || '') || null,
      actualTradeTaken: daily.actualTradeTaken === true,
      actualPnl: Number.isFinite(toNumber(daily.actualPnL, null)) ? round2(toNumber(daily.actualPnL, null)) : null,
      bestPossiblePnl: Number.isFinite(toNumber(daily.bestPossiblePnL, null)) ? round2(toNumber(daily.bestPossiblePnL, null)) : null,
      recommendationDelta: Number.isFinite(toNumber(daily.recommendationDelta, null)) ? round2(toNumber(daily.recommendationDelta, null)) : null,
      classification,
      classificationReason: toText(classificationResult.reason || '') || null,
      modelVsRealizedDivergence: {
        classification: normalizeModelVsRealizedDivergenceClassification(modelVsRealizedDivergence.classification),
        detected: modelVsRealizedDivergence.detected === true,
        reason: toText(modelVsRealizedDivergence.reason || '') || null,
      },
      externalExecutionOutcome: buildCheckpointExternalExecutionPayload(
        externalExecutionOutcome,
        tradeDate
      ),
      shadowPlaybookComparison: daily?.shadowPlaybookComparisonSummary
        && typeof daily.shadowPlaybookComparisonSummary === 'object'
        ? daily.shadowPlaybookComparisonSummary
        : null,
    },
  };
  checkpoint.modelVsRealizedDivergence = checkpoint.outcomeJson.modelVsRealizedDivergence;
  checkpoint.externalExecutionOutcome = checkpoint.outcomeJson.externalExecutionOutcome;

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
      updated_at
    ) VALUES (
      @trade_date,
      @source_type,
      @reconstruction_phase,
      @reconstruction_version,
      @front_line_action_now,
      @posture,
      @recommended_strategy_key,
      @recommended_strategy_name,
      @recommended_tp_mode,
      @confidence_label,
      @confidence_score,
      @projected_win_chance,
      @blocker_state,
      @blocker_reason,
      @clearance_guidance_snapshot_json,
      @assistant_brief_text,
      @realized_outcome_classification,
      @realized_outcome_reason,
      @actual_trade_taken,
      @actual_pnl,
      @best_possible_pnl,
      @recommendation_delta,
      @posture_evaluation,
      @strategy_score_label,
      @tp_score_label,
      @snapshot_json,
      @outcome_json,
      datetime('now')
    )
    ON CONFLICT(trade_date) DO UPDATE SET
      source_type = excluded.source_type,
      reconstruction_phase = excluded.reconstruction_phase,
      reconstruction_version = excluded.reconstruction_version,
      front_line_action_now = excluded.front_line_action_now,
      posture = excluded.posture,
      recommended_strategy_key = excluded.recommended_strategy_key,
      recommended_strategy_name = excluded.recommended_strategy_name,
      recommended_tp_mode = excluded.recommended_tp_mode,
      confidence_label = excluded.confidence_label,
      confidence_score = excluded.confidence_score,
      projected_win_chance = excluded.projected_win_chance,
      blocker_state = excluded.blocker_state,
      blocker_reason = excluded.blocker_reason,
      clearance_guidance_snapshot_json = excluded.clearance_guidance_snapshot_json,
      assistant_brief_text = excluded.assistant_brief_text,
      realized_outcome_classification = excluded.realized_outcome_classification,
      realized_outcome_reason = excluded.realized_outcome_reason,
      actual_trade_taken = excluded.actual_trade_taken,
      actual_pnl = excluded.actual_pnl,
      best_possible_pnl = excluded.best_possible_pnl,
      recommendation_delta = excluded.recommendation_delta,
      posture_evaluation = excluded.posture_evaluation,
      strategy_score_label = excluded.strategy_score_label,
      tp_score_label = excluded.tp_score_label,
      snapshot_json = excluded.snapshot_json,
      outcome_json = excluded.outcome_json,
      updated_at = datetime('now')
  `).run({
    trade_date: checkpoint.tradeDate,
    source_type: checkpoint.sourceType,
    reconstruction_phase: checkpoint.reconstructionPhase,
    reconstruction_version: checkpoint.reconstructionVersion,
    front_line_action_now: checkpoint.frontLineActionNow,
    posture: checkpoint.posture,
    recommended_strategy_key: checkpoint.recommendedStrategyKey,
    recommended_strategy_name: checkpoint.recommendedStrategyName,
    recommended_tp_mode: checkpoint.recommendedTpMode,
    confidence_label: checkpoint.confidenceLabel,
    confidence_score: checkpoint.confidenceScore,
    projected_win_chance: checkpoint.projectedWinChance,
    blocker_state: checkpoint.blockerState,
    blocker_reason: checkpoint.blockerReason,
    clearance_guidance_snapshot_json: JSON.stringify(checkpoint.clearanceGuidanceSnapshot || {}),
    assistant_brief_text: checkpoint.assistantBriefText,
    realized_outcome_classification: checkpoint.realizedOutcomeClassification,
    realized_outcome_reason: checkpoint.realizedOutcomeReason,
    actual_trade_taken: checkpoint.actualTradeTaken ? 1 : 0,
    actual_pnl: checkpoint.actualPnl,
    best_possible_pnl: checkpoint.bestPossiblePnl,
    recommendation_delta: checkpoint.recommendationDelta,
    posture_evaluation: checkpoint.postureEvaluation,
    strategy_score_label: checkpoint.strategyScoreLabel,
    tp_score_label: checkpoint.tpScoreLabel,
    snapshot_json: JSON.stringify(checkpoint.snapshotJson || {}),
    outcome_json: JSON.stringify(checkpoint.outcomeJson || {}),
  });

  return checkpoint;
}

function resolveStrategyOutcomesForDate(strategySnapshot = {}, date = '') {
  const normalizedDate = normalizeDate(date);
  const entries = [];
  const layers = strategySnapshot?.layers || {};
  const original = layers.original;
  if (original?.perDate && original.perDate[normalizedDate]) {
    entries.push({
      key: original.key,
      name: original.name,
      row: original.perDate[normalizedDate],
    });
  }
  const variants = Array.isArray(layers?.variants?.tested) ? layers.variants.tested : [];
  for (const report of variants) {
    if (report?.perDate && report.perDate[normalizedDate]) {
      entries.push({
        key: report.key,
        name: report.name,
        row: report.perDate[normalizedDate],
      });
    }
  }

  const normalized = entries.map((entry) => {
    const row = entry.row || {};
    let pnl = toNumber(row.tradePnlDollars, null);
    if (!Number.isFinite(pnl)) {
      const result = toText(row.tradeResult).toLowerCase();
      if (result === 'win') pnl = 1;
      else if (result === 'loss') pnl = -1;
      else pnl = 0;
    }
    return {
      strategyKey: entry.key,
      strategyName: entry.name,
      wouldTrade: row.wouldTrade === true,
      noTradeReason: toText(row.noTradeReason || '') || null,
      tradeResult: toText(row.tradeResult).toLowerCase() || null,
      pnlDollars: Number.isFinite(pnl) ? round2(pnl) : 0,
      estimatedPnl: !Number.isFinite(toNumber(row.tradePnlDollars, null)),
      tradeDirection: toText(row.tradeDirection || '').toLowerCase() || null,
      tradeEntryTime: toText(row.tradeEntryTime || '') || null,
      tradeEntryPrice: Number.isFinite(toFiniteNumberOrNull(row.tradeEntryPrice))
        ? round2(toFiniteNumberOrNull(row.tradeEntryPrice))
        : null,
      tradeExitTime: toText(row.tradeExitTime || '') || null,
      tradeStopPrice: Number.isFinite(toFiniteNumberOrNull(row.tradeStopPrice))
        ? round2(toFiniteNumberOrNull(row.tradeStopPrice))
        : null,
      tradeTargetPrice: Number.isFinite(toFiniteNumberOrNull(row.tradeTargetPrice))
        ? round2(toFiniteNumberOrNull(row.tradeTargetPrice))
        : null,
    };
  });

  normalized.sort((a, b) => Number(b.pnlDollars || 0) - Number(a.pnlDollars || 0));
  return normalized;
}

function resolveMechanicsForDate({
  date,
  sessions = {},
  tradesForDate = [],
  runTradeMechanicsVariantTool,
  recommendedTpMode,
}) {
  const candles = Array.isArray(sessions?.[date]) ? sessions[date] : [];
  const firstTrade = Array.isArray(tradesForDate) ? tradesForDate[0] : null;
  if (!firstTrade || !candles.length || typeof runTradeMechanicsVariantTool !== 'function') {
    return {
      available: false,
      bestMechanicsOutcome: null,
      recommendedMechanicsOutcome: null,
      tpRecommendationScore: {
        tpCorrect: null,
        tpRelativeTicks: null,
        tpRelativePnL: null,
        scoreLabel: 'unknown',
      },
      variants: [],
    };
  }

  const trade = {
    direction: toText(firstTrade.direction || 'long').toLowerCase(),
    entry_price: toNumber(firstTrade.entry_price, null),
    entry_time: toText(firstTrade.entry_time || ''),
  };
  if (!Number.isFinite(trade.entry_price) || !trade.entry_time) {
    return {
      available: false,
      bestMechanicsOutcome: null,
      recommendedMechanicsOutcome: null,
      tpRecommendationScore: {
        tpCorrect: null,
        tpRelativeTicks: null,
        tpRelativePnL: null,
        scoreLabel: 'unknown',
      },
      variants: [],
    };
  }

  const toolOut = runTradeMechanicsVariantTool({
    candles,
    trade,
    originalPlanEligible: true,
  });
  const variants = Array.isArray(toolOut?.data?.mechanicsVariants) ? toolOut.data.mechanicsVariants : [];
  if (!variants.length) {
    return {
      available: false,
      bestMechanicsOutcome: null,
      recommendedMechanicsOutcome: null,
      tpRecommendationScore: {
        tpCorrect: null,
        tpRelativeTicks: null,
        tpRelativePnL: null,
        scoreLabel: 'unknown',
      },
      variants: [],
    };
  }

  const ranked = variants.slice().sort((a, b) => Number(b?.pnlTicks || 0) - Number(a?.pnlTicks || 0));
  const best = ranked[0] || null;
  const recMode = normalizeTpMode(recommendedTpMode);
  const recommended = variants.find((v) => normalizeTpMode(v?.tpMode) === recMode) || null;

  const tpCorrect = best && recommended
    ? normalizeTpMode(best.tpMode) === normalizeTpMode(recommended.tpMode)
    : null;
  const tpRelativeTicks = best && recommended
    ? round2(Number(recommended.pnlTicks || 0) - Number(best.pnlTicks || 0))
    : null;
  const tpRelativePnL = best && recommended
    ? round2(Number(recommended.pnlDollars || 0) - Number(best.pnlDollars || 0))
    : null;
  let scoreLabel = 'unknown';
  if (tpCorrect === true) scoreLabel = 'correct';
  else if (tpCorrect === false) scoreLabel = Number(tpRelativeTicks || 0) >= -8 ? 'partially_correct' : 'incorrect';

  return {
    available: true,
    bestMechanicsOutcome: best,
    recommendedMechanicsOutcome: recommended,
    tpRecommendationScore: {
      tpCorrect,
      tpRelativeTicks,
      tpRelativePnL,
      scoreLabel,
    },
    variants,
  };
}

function normalizeTimestampForMatch(value) {
  const raw = toText(value);
  if (!raw) return '';
  return raw.replace('T', ' ').replace(/Z$/i, '');
}

function findEntryPriceFromCandles(candles = [], entryTime = '') {
  const normalizedEntryTime = normalizeTimestampForMatch(entryTime);
  if (!normalizedEntryTime || !Array.isArray(candles) || candles.length === 0) return null;
  const exact = candles.find((row) =>
    normalizeTimestampForMatch(row?.timestamp || `${toText(row?.date)} ${toText(row?.time)}`) === normalizedEntryTime
  );
  if (exact && Number.isFinite(toFiniteNumberOrNull(exact?.close))) {
    return round2(toFiniteNumberOrNull(exact.close));
  }
  const fallback = candles.find((row) => {
    const token = normalizeTimestampForMatch(row?.timestamp || `${toText(row?.date)} ${toText(row?.time)}`);
    return token && token >= normalizedEntryTime;
  });
  if (fallback && Number.isFinite(toFiniteNumberOrNull(fallback?.close))) {
    return round2(toFiniteNumberOrNull(fallback.close));
  }
  return null;
}

function resolveSimulatedTradeInputForDate({
  recommendedStrategyOutcome,
  tradesForDate = [],
  candles = [],
}) {
  const strategy = recommendedStrategyOutcome && typeof recommendedStrategyOutcome === 'object'
    ? recommendedStrategyOutcome
    : null;
  const firstTrade = Array.isArray(tradesForDate) && tradesForDate.length > 0
    ? tradesForDate[0]
    : null;
  const shouldTrade = strategy?.wouldTrade === true;
  const noTradeReason = !shouldTrade
    ? (toText(strategy?.noTradeReason || '') || 'strategy_no_trade')
    : null;
  const direction = toText(strategy?.tradeDirection || firstTrade?.direction || '').toLowerCase() || null;
  const entryTime = toText(strategy?.tradeEntryTime || firstTrade?.entry_time || '') || null;
  let entryPrice = Number.isFinite(toFiniteNumberOrNull(strategy?.tradeEntryPrice))
    ? round2(toFiniteNumberOrNull(strategy.tradeEntryPrice))
    : (Number.isFinite(toFiniteNumberOrNull(firstTrade?.entry_price)) ? round2(toFiniteNumberOrNull(firstTrade.entry_price)) : null);
  if (!Number.isFinite(toFiniteNumberOrNull(entryPrice)) && entryTime) {
    entryPrice = findEntryPriceFromCandles(candles, entryTime);
  }
  const stopPrice = Number.isFinite(toFiniteNumberOrNull(strategy?.tradeStopPrice))
    ? round2(toFiniteNumberOrNull(strategy.tradeStopPrice))
    : null;
  const targetPrice = Number.isFinite(toFiniteNumberOrNull(strategy?.tradeTargetPrice))
    ? round2(toFiniteNumberOrNull(strategy.tradeTargetPrice))
    : null;
  const validTradeInput = (
    shouldTrade === true
    && !!direction
    && !!entryTime
    && Number.isFinite(toFiniteNumberOrNull(entryPrice))
  );
  return {
    shouldTrade,
    noTradeReason,
    direction,
    entryTime,
    entryPrice,
    stopPrice,
    targetPrice,
    validTradeInput,
  };
}

function mapMechanicsVariantsByMode(variants = []) {
  const out = new Map();
  for (const variant of (Array.isArray(variants) ? variants : [])) {
    const key = normalizeTpMode(variant?.tpMode);
    if (!key) continue;
    out.set(key, variant);
  }
  return out;
}

function normalizeSimulatedPathOutcome(value) {
  const key = toText(value).toLowerCase();
  if (key === 'win' || key === 'loss' || key === 'breakeven' || key === 'flat') return key;
  if (key === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) return SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
  return key || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
}

function buildJarvisVsTopstepMatchStatus({
  didJarvisTakeTrade,
  selectedPathOutcome,
  externalTopstepOutcome,
}) {
  const external = externalTopstepOutcome && typeof externalTopstepOutcome === 'object'
    ? externalTopstepOutcome
    : null;
  if (!external || external.hasRows !== true) {
    return didJarvisTakeTrade ? 'jarvis_only_no_external_truth' : 'external_truth_unavailable';
  }
  const externalNet = toNumber(external.netPnlDollars, 0) || 0;
  const externalDirection = externalNet > 0 ? 'win' : (externalNet < 0 ? 'loss' : 'flat');
  const selected = normalizeSimulatedPathOutcome(selectedPathOutcome);
  if (didJarvisTakeTrade !== true) {
    return 'mismatch_jarvis_no_trade_external_traded';
  }
  if (selected === 'win' && externalDirection === 'win') return 'match_win';
  if ((selected === 'loss' || selected === 'flat' || selected === 'breakeven') && externalDirection !== 'win') {
    return 'match_non_win';
  }
  return 'mismatch_outcome_direction';
}

function buildJarvisSimulatedTradeStatusLine(simulated = null) {
  if (!simulated || typeof simulated !== 'object') {
    return 'Jarvis simulated today: unavailable.';
  }
  if (simulated.didJarvisTakeTrade !== true) {
    const reason = toText(simulated.noTradeReason || '').replace(/_/g, ' ');
    return reason
      ? `Jarvis simulated today: NO TRADE (${reason}).`
      : 'Jarvis simulated today: NO TRADE.';
  }
  const direction = toText(simulated?.chosenTradeSummary?.direction || '').toUpperCase() || 'UNKNOWN';
  const tp = toText(simulated?.chosenTradeSummary?.tpMode || simulated?.tpModeSelected || '') || 'Unknown TP';
  const selectedOutcome = toText(simulated?.selectedOutcome?.outcome || simulated?.selectedPathOutcome || '').toUpperCase() || 'UNKNOWN';
  return `Jarvis simulated today: ${direction} / ${tp} / ${selectedOutcome}.`;
}

function normalizeOrbReplayCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => {
      const open = toNumber(candle?.open, null);
      const high = toNumber(candle?.high, null);
      const low = toNumber(candle?.low, null);
      const close = toNumber(candle?.close, null);
      const timestamp = toText(candle?.timestamp || `${toText(candle?.date)} ${toText(candle?.time)}`) || null;
      return {
        timestamp,
        open,
        high,
        low,
        close,
      };
    })
    .filter((row) => row.timestamp && Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function extractClockToken(value = '') {
  const token = toText(value);
  if (!token) return '';
  const m = token.match(/(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function minuteFromTimestamp(value = '') {
  return parseMinuteOfDay(extractClockToken(value));
}

function buildLateEntryTimeBucket(minuteOfDay) {
  const minute = Number(minuteOfDay);
  if (!Number.isFinite(minute)) return LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN;
  if (minute < 660) return LATE_ENTRY_POLICY_TIME_BUCKET_BEFORE_1100;
  if (minute < 675) return LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115;
  if (minute < 690) return LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130;
  if (minute < 720) return LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200;
  return LATE_ENTRY_POLICY_TIME_BUCKET_AFTER_1200;
}

function normalizePolicyPathOutcome(value = '') {
  const key = toText(value).toLowerCase();
  if (key === 'win' || key === 'loss' || key === 'breakeven' || key === 'open') return key;
  if (key === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) return SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
  return key || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
}

function makeNoTradeModeOutcome() {
  return {
    outcome: SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    pnl: null,
    targetPrice: null,
    stopPrice: null,
    barsToResolution: null,
    exitReason: null,
  };
}

function mapMechanicsVariantOutcome(variant = null) {
  if (!variant || typeof variant !== 'object') return makeNoTradeModeOutcome();
  return {
    outcome: normalizePolicyPathOutcome(variant?.outcome || ''),
    pnl: Number.isFinite(toFiniteNumberOrNull(variant?.pnlDollars))
      ? round2(toFiniteNumberOrNull(variant.pnlDollars))
      : null,
    targetPrice: Number.isFinite(toFiniteNumberOrNull(variant?.tpPx))
      ? round2(toFiniteNumberOrNull(variant.tpPx))
      : null,
    stopPrice: Number.isFinite(toFiniteNumberOrNull(variant?.slPx))
      ? round2(toFiniteNumberOrNull(variant.slPx))
      : null,
    barsToResolution: Number.isFinite(toFiniteNumberOrNull(variant?.barsToResolution))
      ? Number(toFiniteNumberOrNull(variant.barsToResolution))
      : null,
    exitReason: toText(variant?.exitReason || variant?._meta?.exitReason || '') || null,
  };
}

function buildTpModeOutcomesForTrade({
  candles = [],
  trade = null,
  runTradeMechanicsVariantTool,
}) {
  const empty = {
    nearest: makeNoTradeModeOutcome(),
    skip1: makeNoTradeModeOutcome(),
    skip2: makeNoTradeModeOutcome(),
  };
  if (!trade || typeof trade !== 'object' || typeof runTradeMechanicsVariantTool !== 'function') return empty;
  const entryPrice = toFiniteNumberOrNull(trade?.entry_price);
  const entryTime = toText(trade?.entry_time || '');
  const direction = toText(trade?.direction || '').toLowerCase();
  if (!Number.isFinite(entryPrice) || !entryTime || (direction !== 'long' && direction !== 'short')) return empty;
  const out = runTradeMechanicsVariantTool({
    candles,
    trade: {
      direction,
      entry_price: entryPrice,
      entry_time: entryTime,
    },
    originalPlanEligible: true,
  });
  const variants = Array.isArray(out?.data?.mechanicsVariants) ? out.data.mechanicsVariants : [];
  const byMode = mapMechanicsVariantsByMode(variants);
  return {
    nearest: mapMechanicsVariantOutcome(byMode.get('Nearest')),
    skip1: mapMechanicsVariantOutcome(byMode.get('Skip 1')),
    skip2: mapMechanicsVariantOutcome(byMode.get('Skip 2')),
  };
}

function toReplayTradeSummary(result = null) {
  const trade = result?.trade && typeof result.trade === 'object' ? result.trade : null;
  if (!trade) {
    return {
      wouldTrade: false,
      noTradeReason: toText(result?.no_trade_reason || '') || 'no_trade',
      direction: null,
      entryTime: null,
      entryMinute: null,
      confirmationTime: null,
      confirmationMinute: null,
      breakoutTime: null,
      retestTime: null,
      breakoutClose: null,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      baselineReplay: result,
    };
  }
  const signals = Array.isArray(result?.signals) ? result.signals : [];
  const invalidationBeforeConfirmation = signals.some((signal) => (
    signal
    && signal.invalidation
    && !signal.entry
  ));
  return {
    wouldTrade: true,
    noTradeReason: null,
    direction: toText(trade.direction || '').toLowerCase() || null,
    entryTime: toText(trade.entry_time || '') || null,
    entryMinute: minuteFromTimestamp(trade.entry_time),
    confirmationTime: toText(trade.confirmation_time || '') || null,
    confirmationMinute: minuteFromTimestamp(trade.confirmation_time),
    breakoutTime: toText(trade.breakout_time || '') || null,
    retestTime: toText(trade.retest_time || '') || null,
    breakoutClose: Number.isFinite(toFiniteNumberOrNull(trade.breakout_candle_close))
      ? round2(toFiniteNumberOrNull(trade.breakout_candle_close))
      : null,
    entryPrice: Number.isFinite(toFiniteNumberOrNull(trade.entry_price))
      ? round2(toFiniteNumberOrNull(trade.entry_price))
      : null,
    stopPrice: Number.isFinite(toFiniteNumberOrNull(trade.sl_price))
      ? round2(toFiniteNumberOrNull(trade.sl_price))
      : null,
    targetPrice: Number.isFinite(toFiniteNumberOrNull(trade.tp_price))
      ? round2(toFiniteNumberOrNull(trade.tp_price))
      : null,
    invalidationBeforeConfirmation,
    baselineReplay: result,
  };
}

function runOrbReplayVariantForPolicy({
  candles = [],
  maxEntryHour = null,
}) {
  const settings = {
    longOnly: true,
    skipMonday: true,
    tpMode: 'skip2',
    maxEntryHour,
  };
  const replay = processSession(candles, settings);
  return toReplayTradeSummary(replay);
}

function evaluateLateEntrySkip2ExtensionGate(input = {}) {
  const baseline = input.baseline && typeof input.baseline === 'object'
    ? input.baseline
    : {};
  const hard12 = input.hard12 && typeof input.hard12 === 'object'
    ? input.hard12
    : {};
  const noCutoff = input.noCutoff && typeof input.noCutoff === 'object'
    ? input.noCutoff
    : {};
  const sourceCandlesComplete = input.sourceCandlesComplete === true;
  const selectedTpMode = normalizeTpMode(input.selectedTpMode || '');
  const reasonCodes = [];
  const extensionStartMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_START);
  const extensionEndMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_END);

  if (!sourceCandlesComplete) reasonCodes.push('missing_session_candles');
  if (selectedTpMode !== 'Skip 2') reasonCodes.push('selected_tp_mode_not_skip2');
  if (baseline?.wouldTrade === true) {
    reasonCodes.push('baseline_already_trades_before_1100');
  } else if (toText(baseline?.noTradeReason || '') !== 'entry_after_max_hour') {
    reasonCodes.push('baseline_not_rejected_by_1100_cutoff');
  }

  if (hard12?.wouldTrade !== true) {
    const noCutoffConfirmationMinute = Number.isFinite(Number(noCutoff?.confirmationMinute))
      ? Number(noCutoff.confirmationMinute)
      : null;
    if (noCutoff?.wouldTrade === true && Number.isFinite(noCutoffConfirmationMinute) && noCutoffConfirmationMinute >= extensionEndMinute) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    } else {
      reasonCodes.push('no_replay_trade_under_1200_extension');
    }
  } else {
    const confirmationMinute = Number(hard12?.confirmationMinute);
    if (!Number.isFinite(confirmationMinute)) {
      reasonCodes.push('confirmation_time_unavailable');
    } else if (
      !Number.isFinite(extensionStartMinute)
      || !Number.isFinite(extensionEndMinute)
      || confirmationMinute < extensionStartMinute
      || confirmationMinute >= extensionEndMinute
    ) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    }
    if (hard12?.invalidationBeforeConfirmation === true) {
      reasonCodes.push('invalidation_before_confirmation');
    }
  }

  const breakoutMinute = minuteFromTimestamp(hard12?.breakoutTime || '');
  const retestMinute = minuteFromTimestamp(hard12?.retestTime || '');
  const confirmationMinute = Number.isFinite(Number(hard12?.confirmationMinute))
    ? Number(hard12.confirmationMinute)
    : null;
  const entryMinute = Number.isFinite(Number(hard12?.entryMinute))
    ? Number(hard12.entryMinute)
    : null;
  const breakoutToRetestDelayMinutes = Number.isFinite(breakoutMinute) && Number.isFinite(retestMinute)
    ? Math.max(0, retestMinute - breakoutMinute)
    : null;
  const retestToConfirmationDelayMinutes = Number.isFinite(retestMinute) && Number.isFinite(confirmationMinute)
    ? Math.max(0, confirmationMinute - retestMinute)
    : null;
  const confirmationDistanceBeyondBreakoutClose = (
    Number.isFinite(toFiniteNumberOrNull(hard12?.entryPrice))
    && Number.isFinite(toFiniteNumberOrNull(hard12?.breakoutClose))
  )
    ? round2(Math.abs(toFiniteNumberOrNull(hard12.entryPrice) - toFiniteNumberOrNull(hard12.breakoutClose)))
    : null;
  const confirmationTimeBucket = buildLateEntryTimeBucket(confirmationMinute);
  const historicallyStrongerCluster = (
    input.highRiskContext === true
    && (
      confirmationTimeBucket === LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115
      || confirmationTimeBucket === LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130
    )
  );
  const historicallyWeakerCluster = (
    confirmationTimeBucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
    || confirmationTimeBucket === LATE_ENTRY_POLICY_TIME_BUCKET_AFTER_1200
  );
  const eligible = reasonCodes.length === 0;
  return {
    eligible,
    reasonCodes,
    decision: eligible ? 'allow_extension_1100_1200' : 'reject_extension',
    supportingMetrics: {
      sourceCandlesComplete,
      selectedTpMode,
      baselineWouldTrade: baseline?.wouldTrade === true,
      baselineNoTradeReason: baseline?.noTradeReason || null,
      hard12WouldTrade: hard12?.wouldTrade === true,
      noCutoffWouldTrade: noCutoff?.wouldTrade === true,
      confirmationMinute,
      entryMinute,
      breakoutMinute: Number.isFinite(breakoutMinute) ? breakoutMinute : null,
      retestMinute: Number.isFinite(retestMinute) ? retestMinute : null,
      breakoutToRetestDelayMinutes,
      retestToConfirmationDelayMinutes,
      confirmationDistanceBeyondBreakoutClose,
      confirmationTimeBucket,
      historicallyStrongerCluster,
      historicallyWeakerCluster,
      invalidationBeforeConfirmation: hard12?.invalidationBeforeConfirmation === true,
    },
  };
}

function evaluateLateEntrySkip2ExtensionV2Gate(input = {}) {
  const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {};
  const hard12 = input.hard12 && typeof input.hard12 === 'object' ? input.hard12 : {};
  const noCutoff = input.noCutoff && typeof input.noCutoff === 'object' ? input.noCutoff : {};
  const sourceCandlesComplete = input.sourceCandlesComplete === true;
  const selectedTpMode = normalizeTpMode(input.selectedTpMode || '');
  const highRiskContext = input.highRiskContext === true;
  const weekday = toText(input.weekday || '').toLowerCase();
  const orbRangeTicks = Number.isFinite(toFiniteNumberOrNull(input.orbRangeTicks))
    ? toFiniteNumberOrNull(input.orbRangeTicks)
    : null;
  const reasonCodes = [];
  const extensionStartMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_START);
  const extensionEndMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_END);
  const confirmationMinute = Number.isFinite(Number(hard12?.confirmationMinute))
    ? Number(hard12.confirmationMinute)
    : null;
  const bucket = buildLateEntryTimeBucket(confirmationMinute);
  const breakoutMinute = minuteFromTimestamp(hard12?.breakoutTime || '');
  const retestMinute = minuteFromTimestamp(hard12?.retestTime || '');
  const breakoutToRetestDelayMinutes = Number.isFinite(breakoutMinute) && Number.isFinite(retestMinute)
    ? Math.max(0, retestMinute - breakoutMinute)
    : null;
  const retestToConfirmationDelayMinutes = Number.isFinite(retestMinute) && Number.isFinite(confirmationMinute)
    ? Math.max(0, confirmationMinute - retestMinute)
    : null;
  const confirmationDistanceBeyondBreakoutClose = (
    Number.isFinite(toFiniteNumberOrNull(hard12?.entryPrice))
    && Number.isFinite(toFiniteNumberOrNull(hard12?.breakoutClose))
  )
    ? round2(Math.abs(toFiniteNumberOrNull(hard12.entryPrice) - toFiniteNumberOrNull(hard12.breakoutClose)))
    : null;
  if (!sourceCandlesComplete) reasonCodes.push('missing_session_candles');
  if (baseline?.wouldTrade === true) {
    reasonCodes.push('baseline_already_trades_before_1100');
  } else if (toText(baseline?.noTradeReason || '') !== 'entry_after_max_hour') {
    reasonCodes.push('baseline_not_rejected_by_1100_cutoff');
  }
  if (!highRiskContext) reasonCodes.push('context_not_high_risk');
  if (hard12?.wouldTrade !== true) {
    const noCutoffConfirmationMinute = Number.isFinite(Number(noCutoff?.confirmationMinute))
      ? Number(noCutoff.confirmationMinute)
      : null;
    if (noCutoff?.wouldTrade === true && Number.isFinite(noCutoffConfirmationMinute) && noCutoffConfirmationMinute >= extensionEndMinute) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    } else {
      reasonCodes.push('no_replay_trade_under_1200_extension');
    }
  } else {
    if (!Number.isFinite(confirmationMinute)) {
      reasonCodes.push('confirmation_time_unavailable');
    } else if (
      !Number.isFinite(extensionStartMinute)
      || !Number.isFinite(extensionEndMinute)
      || confirmationMinute < extensionStartMinute
      || confirmationMinute >= extensionEndMinute
    ) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    }
    if (hard12?.invalidationBeforeConfirmation === true) {
      reasonCodes.push('invalidation_before_confirmation');
    }
  }

  const nearModeAllowed = selectedTpMode === 'Nearest';
  const skip2ModeAllowed = selectedTpMode === 'Skip 2';
  if (!nearModeAllowed && !skip2ModeAllowed) {
    reasonCodes.push('selected_tp_mode_not_enabled_v2');
  }

  // Time-bucket laneing:
  // - 11:00-11:30 allows Skip2 or Nearest in high-risk with minimal delay controls.
  // - 11:30-12:00 is stricter and only allows Nearest with tighter structural controls.
  if (bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200) {
    if (!nearModeAllowed) reasonCodes.push('post_1130_requires_nearest_mode');
    if (!Number.isFinite(orbRangeTicks) || orbRangeTicks < 300) reasonCodes.push('post_1130_requires_wide_orb_range');
    if (!['tuesday', 'thursday'].includes(weekday)) reasonCodes.push('post_1130_weekday_not_allowed');
    if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes > 10) {
      reasonCodes.push('post_1130_confirmation_delay_too_long');
    }
    if (Number.isFinite(confirmationDistanceBeyondBreakoutClose) && confirmationDistanceBeyondBreakoutClose > 5) {
      reasonCodes.push('post_1130_confirmation_distance_too_wide');
    }
  } else if (bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115 || bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130) {
    if (!Number.isFinite(orbRangeTicks) || orbRangeTicks < 240) reasonCodes.push('requires_min_orb_range_for_late_entry');
    if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes > 15) {
      reasonCodes.push('confirmation_delay_too_long');
    }
  } else {
    reasonCodes.push('confirmation_bucket_not_supported_v2');
  }

  const eligible = reasonCodes.length === 0;
  return {
    eligible,
    reasonCodes,
    decision: eligible ? 'allow_extension_v2' : 'reject_extension_v2',
    supportingMetrics: {
      sourceCandlesComplete,
      selectedTpMode,
      highRiskContext,
      weekday,
      orbRangeTicks: Number.isFinite(orbRangeTicks) ? round2(orbRangeTicks) : null,
      baselineWouldTrade: baseline?.wouldTrade === true,
      baselineNoTradeReason: baseline?.noTradeReason || null,
      hard12WouldTrade: hard12?.wouldTrade === true,
      noCutoffWouldTrade: noCutoff?.wouldTrade === true,
      confirmationMinute,
      entryMinute: Number.isFinite(Number(hard12?.entryMinute)) ? Number(hard12.entryMinute) : null,
      breakoutMinute: Number.isFinite(breakoutMinute) ? breakoutMinute : null,
      retestMinute: Number.isFinite(retestMinute) ? retestMinute : null,
      breakoutToRetestDelayMinutes,
      retestToConfirmationDelayMinutes,
      confirmationDistanceBeyondBreakoutClose,
      confirmationTimeBucket: bucket,
      invalidationBeforeConfirmation: hard12?.invalidationBeforeConfirmation === true,
      post1130StrictLane: bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200,
    },
  };
}

function evaluateLateEntrySkip2ExtensionV3Gate(input = {}) {
  const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {};
  const hard12 = input.hard12 && typeof input.hard12 === 'object' ? input.hard12 : {};
  const noCutoff = input.noCutoff && typeof input.noCutoff === 'object' ? input.noCutoff : {};
  const sourceCandlesComplete = input.sourceCandlesComplete === true;
  const selectedTpMode = normalizeTpMode(input.selectedTpMode || '');
  const highRiskContext = input.highRiskContext === true;
  const weekday = toText(input.weekday || '').toLowerCase();
  const regimeLabel = toText(input.regimeLabel || '').toLowerCase();
  const orbRangeTicks = Number.isFinite(toFiniteNumberOrNull(input.orbRangeTicks))
    ? toFiniteNumberOrNull(input.orbRangeTicks)
    : null;
  const reasonCodes = [];
  const extensionStartMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_START);
  const extensionEndMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_END);
  const confirmationMinute = Number.isFinite(Number(hard12?.confirmationMinute))
    ? Number(hard12.confirmationMinute)
    : null;
  const bucket = buildLateEntryTimeBucket(confirmationMinute);
  const breakoutMinute = minuteFromTimestamp(hard12?.breakoutTime || '');
  const retestMinute = minuteFromTimestamp(hard12?.retestTime || '');
  const breakoutToRetestDelayMinutes = Number.isFinite(breakoutMinute) && Number.isFinite(retestMinute)
    ? Math.max(0, retestMinute - breakoutMinute)
    : null;
  const retestToConfirmationDelayMinutes = Number.isFinite(retestMinute) && Number.isFinite(confirmationMinute)
    ? Math.max(0, confirmationMinute - retestMinute)
    : null;
  const confirmationDistanceBeyondBreakoutClose = (
    Number.isFinite(toFiniteNumberOrNull(hard12?.entryPrice))
    && Number.isFinite(toFiniteNumberOrNull(hard12?.breakoutClose))
  )
    ? round2(Math.abs(toFiniteNumberOrNull(hard12.entryPrice) - toFiniteNumberOrNull(hard12.breakoutClose)))
    : null;
  const nearModeAllowed = selectedTpMode === 'Nearest';
  const skip2ModeAllowed = selectedTpMode === 'Skip 2';
  const skip1ModeCandidate = selectedTpMode === 'Skip 1';

  if (!sourceCandlesComplete) reasonCodes.push('missing_session_candles');
  if (baseline?.wouldTrade === true) {
    reasonCodes.push('baseline_already_trades_before_1100');
  } else if (toText(baseline?.noTradeReason || '') !== 'entry_after_max_hour') {
    reasonCodes.push('baseline_not_rejected_by_1100_cutoff');
  }
  if (!highRiskContext) reasonCodes.push('context_not_high_risk');
  if (hard12?.wouldTrade !== true) {
    const noCutoffConfirmationMinute = Number.isFinite(Number(noCutoff?.confirmationMinute))
      ? Number(noCutoff.confirmationMinute)
      : null;
    if (noCutoff?.wouldTrade === true && Number.isFinite(noCutoffConfirmationMinute) && noCutoffConfirmationMinute >= extensionEndMinute) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    } else {
      reasonCodes.push('no_replay_trade_under_1200_extension');
    }
  } else {
    if (!Number.isFinite(confirmationMinute)) {
      reasonCodes.push('confirmation_time_unavailable');
    } else if (
      !Number.isFinite(extensionStartMinute)
      || !Number.isFinite(extensionEndMinute)
      || confirmationMinute < extensionStartMinute
      || confirmationMinute >= extensionEndMinute
    ) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    }
    if (hard12?.invalidationBeforeConfirmation === true) {
      reasonCodes.push('invalidation_before_confirmation');
    }
  }

  if (!nearModeAllowed && !skip2ModeAllowed && !skip1ModeCandidate) {
    reasonCodes.push('selected_tp_mode_not_enabled_v3');
  }

  if (bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200) {
    if (skip1ModeCandidate) reasonCodes.push('post_1130_skip1_not_allowed_v3');
    if (!nearModeAllowed && !skip2ModeAllowed) reasonCodes.push('post_1130_requires_nearest_or_skip2_mode');
    if (!Number.isFinite(orbRangeTicks) || orbRangeTicks < 270) {
      reasonCodes.push('post_1130_requires_wide_orb_range_v3');
    }
    if (!['tuesday', 'wednesday', 'thursday'].includes(weekday)) reasonCodes.push('post_1130_weekday_not_allowed_v3');
    if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes > 22) {
      reasonCodes.push('post_1130_confirmation_delay_too_long_v3');
    }
    if (
      !Number.isFinite(confirmationDistanceBeyondBreakoutClose)
      || confirmationDistanceBeyondBreakoutClose > 8
    ) {
      reasonCodes.push('post_1130_confirmation_distance_too_wide_v3');
    }
    if (
      skip2ModeAllowed
      && Number.isFinite(orbRangeTicks)
      && orbRangeTicks < 300
      && !['tuesday', 'thursday'].includes(weekday)
    ) {
      reasonCodes.push('post_1130_skip2_requires_stronger_cluster_v3');
    }
    if (regimeLabel && !regimeLabel.includes('ranging')) {
      reasonCodes.push('post_1130_regime_not_ranging_v3');
    }
  } else if (bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115) {
    if (!Number.isFinite(orbRangeTicks) || orbRangeTicks < 220) reasonCodes.push('requires_min_orb_range_for_late_entry_v3');
    if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes > 18) {
      reasonCodes.push('confirmation_delay_too_long_v3');
    }
    if (Number.isFinite(confirmationDistanceBeyondBreakoutClose) && confirmationDistanceBeyondBreakoutClose > 10) {
      reasonCodes.push('confirmation_distance_too_wide_v3');
    }
    if (skip1ModeCandidate) {
      if (!['tuesday', 'thursday'].includes(weekday)) reasonCodes.push('skip1_weekday_not_allowed_v3');
      if (!Number.isFinite(orbRangeTicks) || orbRangeTicks < 260) reasonCodes.push('skip1_orb_range_too_small_v3');
      if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes > 12) {
        reasonCodes.push('skip1_confirmation_delay_too_long_v3');
      }
      if (Number.isFinite(confirmationDistanceBeyondBreakoutClose) && confirmationDistanceBeyondBreakoutClose > 6) {
        reasonCodes.push('skip1_confirmation_distance_too_wide_v3');
      }
    }
  } else if (bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130) {
    if (!Number.isFinite(orbRangeTicks) || orbRangeTicks < 230) reasonCodes.push('requires_min_orb_range_for_mid_late_entry_v3');
    if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes > 18) {
      reasonCodes.push('mid_confirmation_delay_too_long_v3');
    }
    if (Number.isFinite(confirmationDistanceBeyondBreakoutClose) && confirmationDistanceBeyondBreakoutClose > 11) {
      reasonCodes.push('mid_confirmation_distance_too_wide_v3');
    }
    if (skip1ModeCandidate) reasonCodes.push('skip1_only_allowed_1100_1115_v3');
  } else {
    reasonCodes.push('confirmation_bucket_not_supported_v3');
  }

  const eligible = reasonCodes.length === 0;
  return {
    eligible,
    reasonCodes,
    decision: eligible ? 'allow_extension_v3' : 'reject_extension_v3',
    supportingMetrics: {
      sourceCandlesComplete,
      selectedTpMode,
      highRiskContext,
      weekday,
      regimeLabel,
      orbRangeTicks: Number.isFinite(orbRangeTicks) ? round2(orbRangeTicks) : null,
      baselineWouldTrade: baseline?.wouldTrade === true,
      baselineNoTradeReason: baseline?.noTradeReason || null,
      hard12WouldTrade: hard12?.wouldTrade === true,
      noCutoffWouldTrade: noCutoff?.wouldTrade === true,
      confirmationMinute,
      entryMinute: Number.isFinite(Number(hard12?.entryMinute)) ? Number(hard12.entryMinute) : null,
      breakoutMinute: Number.isFinite(breakoutMinute) ? breakoutMinute : null,
      retestMinute: Number.isFinite(retestMinute) ? retestMinute : null,
      breakoutToRetestDelayMinutes,
      retestToConfirmationDelayMinutes,
      confirmationDistanceBeyondBreakoutClose,
      confirmationTimeBucket: bucket,
      invalidationBeforeConfirmation: hard12?.invalidationBeforeConfirmation === true,
      post1130ExpandedLane: bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200,
      skip1NarrowLane: skip1ModeCandidate
        && bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115
        && ['tuesday', 'thursday'].includes(weekday),
    },
  };
}

function evaluateLateEntrySkip2ExtensionV4Gate(input = {}) {
  const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {};
  const hard12 = input.hard12 && typeof input.hard12 === 'object' ? input.hard12 : {};
  const noCutoff = input.noCutoff && typeof input.noCutoff === 'object' ? input.noCutoff : {};
  const sourceCandlesComplete = input.sourceCandlesComplete === true;
  const selectedTpMode = normalizeTpMode(input.selectedTpMode || '');
  const highRiskContext = input.highRiskContext === true;
  const weekday = toText(input.weekday || '').toLowerCase();
  const reasonCodes = [];
  const extensionStartMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_START);
  const extensionEndMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_END);
  const confirmationMinute = Number.isFinite(Number(hard12?.confirmationMinute))
    ? Number(hard12.confirmationMinute)
    : null;
  const bucket = buildLateEntryTimeBucket(confirmationMinute);
  const breakoutMinute = minuteFromTimestamp(hard12?.breakoutTime || '');
  const retestMinute = minuteFromTimestamp(hard12?.retestTime || '');
  const breakoutToRetestDelayMinutes = Number.isFinite(breakoutMinute) && Number.isFinite(retestMinute)
    ? Math.max(0, retestMinute - breakoutMinute)
    : null;
  const retestToConfirmationDelayMinutes = Number.isFinite(retestMinute) && Number.isFinite(confirmationMinute)
    ? Math.max(0, confirmationMinute - retestMinute)
    : null;
  const confirmationDistanceBeyondBreakoutClose = (
    Number.isFinite(toFiniteNumberOrNull(hard12?.entryPrice))
    && Number.isFinite(toFiniteNumberOrNull(hard12?.breakoutClose))
  )
    ? round2(Math.abs(toFiniteNumberOrNull(hard12.entryPrice) - toFiniteNumberOrNull(hard12.breakoutClose)))
    : null;
  const invalidationBeforeConfirmation = hard12?.invalidationBeforeConfirmation === true;
  const gateV3 = input.gateV3 && typeof input.gateV3 === 'object'
    ? input.gateV3
    : evaluateLateEntrySkip2ExtensionV3Gate({
      baseline,
      hard12,
      noCutoff,
      selectedTpMode,
      sourceCandlesComplete,
      highRiskContext,
      weekday,
      regimeLabel: input.regimeLabel || '',
      orbRangeTicks: input.orbRangeTicks,
    });

  // Preserve all v3-approved trades. V4 only adds a mined rescue pocket for v3-rejected cases.
  if (gateV3?.eligible === true) {
    return {
      eligible: true,
      reasonCodes: ['v3_gate_passed'],
      decision: 'allow_extension_v4',
      supportingMetrics: {
        ...(gateV3?.supportingMetrics && typeof gateV3.supportingMetrics === 'object'
          ? gateV3.supportingMetrics
          : {}),
        highRiskContext,
        v3Eligible: true,
        v3ReasonCodes: Array.isArray(gateV3?.reasonCodes) ? gateV3.reasonCodes.slice(0, 16) : [],
        v4RescuePocketMatched: false,
        v4RescuePocketKey: null,
      },
    };
  }

  if (!sourceCandlesComplete) reasonCodes.push('missing_session_candles');
  if (baseline?.wouldTrade === true) {
    reasonCodes.push('baseline_already_trades_before_1100');
  } else if (toText(baseline?.noTradeReason || '') !== 'entry_after_max_hour') {
    reasonCodes.push('baseline_not_rejected_by_1100_cutoff');
  }
  if (hard12?.wouldTrade !== true) {
    const noCutoffConfirmationMinute = Number.isFinite(Number(noCutoff?.confirmationMinute))
      ? Number(noCutoff.confirmationMinute)
      : null;
    if (noCutoff?.wouldTrade === true && Number.isFinite(noCutoffConfirmationMinute) && noCutoffConfirmationMinute >= extensionEndMinute) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    } else {
      reasonCodes.push('no_replay_trade_under_1200_extension');
    }
  } else {
    if (!Number.isFinite(confirmationMinute)) {
      reasonCodes.push('confirmation_time_unavailable');
    } else if (
      !Number.isFinite(extensionStartMinute)
      || !Number.isFinite(extensionEndMinute)
      || confirmationMinute < extensionStartMinute
      || confirmationMinute >= extensionEndMinute
    ) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    }
  }
  if (selectedTpMode !== 'Skip 2') {
    reasonCodes.push('selected_tp_mode_not_skip2_v4');
  }

  // Evidence-mined rescue pocket from v3 rejected winners/losses:
  // Pocket A: Thursday 11:15-11:30, no invalidation.
  const pocketA = (
    weekday === 'thursday'
    && bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130
    && invalidationBeforeConfirmation !== true
  );
  // Pocket B: Thursday 11:30-12:00, no invalidation, tighter delay/distance.
  const pocketB = (
    weekday === 'thursday'
    && bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
    && invalidationBeforeConfirmation !== true
    && Number.isFinite(retestToConfirmationDelayMinutes)
    && retestToConfirmationDelayMinutes <= 15
    && Number.isFinite(confirmationDistanceBeyondBreakoutClose)
    && confirmationDistanceBeyondBreakoutClose <= 10
  );
  const rescuePocketMatched = pocketA || pocketB;
  if (!rescuePocketMatched) {
    if (weekday !== 'thursday') reasonCodes.push('v4_weekday_not_in_mined_cluster');
    if (
      bucket !== LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130
      && bucket !== LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
    ) {
      reasonCodes.push('v4_bucket_not_in_mined_cluster');
    }
    if (invalidationBeforeConfirmation === true) reasonCodes.push('v4_invalidation_before_confirmation');
    if (
      bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
      && Number.isFinite(retestToConfirmationDelayMinutes)
      && retestToConfirmationDelayMinutes > 15
    ) {
      reasonCodes.push('v4_post_1130_delay_too_long');
    }
    if (
      bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
      && Number.isFinite(confirmationDistanceBeyondBreakoutClose)
      && confirmationDistanceBeyondBreakoutClose > 10
    ) {
      reasonCodes.push('v4_post_1130_confirmation_distance_too_wide');
    }
    if (highRiskContext === true) reasonCodes.push('v4_rescue_not_needed_high_risk_context');
  }

  const eligible = reasonCodes.length === 0;
  return {
    eligible,
    reasonCodes,
    decision: eligible ? 'allow_extension_v4' : 'reject_extension_v4',
    supportingMetrics: {
      sourceCandlesComplete,
      selectedTpMode,
      highRiskContext,
      weekday,
      baselineWouldTrade: baseline?.wouldTrade === true,
      baselineNoTradeReason: baseline?.noTradeReason || null,
      hard12WouldTrade: hard12?.wouldTrade === true,
      noCutoffWouldTrade: noCutoff?.wouldTrade === true,
      confirmationMinute,
      entryMinute: Number.isFinite(Number(hard12?.entryMinute)) ? Number(hard12.entryMinute) : null,
      breakoutMinute: Number.isFinite(breakoutMinute) ? breakoutMinute : null,
      retestMinute: Number.isFinite(retestMinute) ? retestMinute : null,
      breakoutToRetestDelayMinutes,
      retestToConfirmationDelayMinutes,
      confirmationDistanceBeyondBreakoutClose,
      confirmationTimeBucket: bucket,
      invalidationBeforeConfirmation,
      v3Eligible: gateV3?.eligible === true,
      v3ReasonCodes: Array.isArray(gateV3?.reasonCodes) ? gateV3.reasonCodes.slice(0, 16) : [],
      v4RescuePocketMatched: rescuePocketMatched,
      v4RescuePocketKey: pocketA
        ? 'thursday_1115_1130_no_invalidation'
        : (pocketB ? 'thursday_1130_1200_tight_structure' : null),
    },
  };
}

function evaluateLateEntrySkip2ExtensionV5Gate(input = {}) {
  const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {};
  const hard12 = input.hard12 && typeof input.hard12 === 'object' ? input.hard12 : {};
  const noCutoff = input.noCutoff && typeof input.noCutoff === 'object' ? input.noCutoff : {};
  const sourceCandlesComplete = input.sourceCandlesComplete === true;
  const selectedTpMode = normalizeTpMode(input.selectedTpMode || '');
  const weekday = toText(input.weekday || '').toLowerCase();
  const reasonCodes = [];
  const extensionStartMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_START);
  const extensionEndMinute = parseMinuteOfDay(LATE_ENTRY_POLICY_EXTENSION_END);
  const confirmationMinute = Number.isFinite(Number(hard12?.confirmationMinute))
    ? Number(hard12.confirmationMinute)
    : null;
  const bucket = buildLateEntryTimeBucket(confirmationMinute);
  const breakoutMinute = minuteFromTimestamp(hard12?.breakoutTime || '');
  const retestMinute = minuteFromTimestamp(hard12?.retestTime || '');
  const breakoutToRetestDelayMinutes = Number.isFinite(breakoutMinute) && Number.isFinite(retestMinute)
    ? Math.max(0, retestMinute - breakoutMinute)
    : null;
  const retestToConfirmationDelayMinutes = Number.isFinite(retestMinute) && Number.isFinite(confirmationMinute)
    ? Math.max(0, confirmationMinute - retestMinute)
    : null;
  const confirmationDistanceBeyondBreakoutClose = (
    Number.isFinite(toFiniteNumberOrNull(hard12?.entryPrice))
    && Number.isFinite(toFiniteNumberOrNull(hard12?.breakoutClose))
  )
    ? round2(Math.abs(toFiniteNumberOrNull(hard12.entryPrice) - toFiniteNumberOrNull(hard12.breakoutClose)))
    : null;
  const invalidationBeforeConfirmation = hard12?.invalidationBeforeConfirmation === true;
  const gateV4 = input.gateV4 && typeof input.gateV4 === 'object'
    ? input.gateV4
    : evaluateLateEntrySkip2ExtensionV4Gate({
      baseline,
      hard12,
      noCutoff,
      selectedTpMode,
      sourceCandlesComplete,
      highRiskContext: input.highRiskContext === true,
      weekday,
      regimeLabel: input.regimeLabel || '',
      orbRangeTicks: input.orbRangeTicks,
      gateV3: input.gateV3,
    });

  // Preserve all v4-approved trades. V5 only reopens a tighter, evidence-mined subset of v4 rejections.
  if (gateV4?.eligible === true) {
    return {
      eligible: true,
      reasonCodes: ['v4_gate_passed'],
      decision: 'allow_extension_v5',
      supportingMetrics: {
        ...(gateV4?.supportingMetrics && typeof gateV4.supportingMetrics === 'object'
          ? gateV4.supportingMetrics
          : {}),
        v4Eligible: true,
        v4ReasonCodes: Array.isArray(gateV4?.reasonCodes) ? gateV4.reasonCodes.slice(0, 16) : [],
        v5ReopenPocketMatched: false,
        v5ReopenPocketKey: null,
      },
    };
  }

  if (!sourceCandlesComplete) reasonCodes.push('missing_session_candles');
  if (baseline?.wouldTrade === true) {
    reasonCodes.push('baseline_already_trades_before_1100');
  } else if (toText(baseline?.noTradeReason || '') !== 'entry_after_max_hour') {
    reasonCodes.push('baseline_not_rejected_by_1100_cutoff');
  }
  if (hard12?.wouldTrade !== true) {
    const noCutoffConfirmationMinute = Number.isFinite(Number(noCutoff?.confirmationMinute))
      ? Number(noCutoff.confirmationMinute)
      : null;
    if (noCutoff?.wouldTrade === true && Number.isFinite(noCutoffConfirmationMinute) && noCutoffConfirmationMinute >= extensionEndMinute) {
      reasonCodes.push('confirmation_outside_1100_1200_window');
    } else {
      reasonCodes.push('no_replay_trade_under_1200_extension');
    }
  } else if (
    !Number.isFinite(confirmationMinute)
    || !Number.isFinite(extensionStartMinute)
    || !Number.isFinite(extensionEndMinute)
    || confirmationMinute < extensionStartMinute
    || confirmationMinute >= extensionEndMinute
  ) {
    reasonCodes.push('confirmation_outside_1100_1200_window');
  }
  if (selectedTpMode !== 'Skip 2') reasonCodes.push('selected_tp_mode_not_skip2_v5');
  if (invalidationBeforeConfirmation) reasonCodes.push('invalidation_before_confirmation_v5');

  // V5 evidence-mined reopen pockets from strict common-date v1-over-v4 profitable misses.
  // Pocket A: Wednesday 11:00-11:30 Skip2 continuation-fade pocket.
  const pocketA = (
    weekday === 'wednesday'
    && (
      bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115
      || bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130
    )
    && invalidationBeforeConfirmation !== true
  );
  // Pocket B: Tuesday 11:30-12:00 with non-immediate retest->confirmation (>=3m) and capped extension distance.
  const pocketB = (
    weekday === 'tuesday'
    && bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
    && invalidationBeforeConfirmation !== true
    && Number.isFinite(retestToConfirmationDelayMinutes)
    && retestToConfirmationDelayMinutes >= 3
    && retestToConfirmationDelayMinutes <= 50
    && Number.isFinite(confirmationDistanceBeyondBreakoutClose)
    && confirmationDistanceBeyondBreakoutClose <= 9.5
  );
  const reopenPocketMatched = pocketA || pocketB;
  if (!reopenPocketMatched) {
    if (weekday !== 'wednesday' && weekday !== 'tuesday') reasonCodes.push('v5_weekday_not_in_reopen_cluster');
    if (
      bucket !== LATE_ENTRY_POLICY_TIME_BUCKET_1100_1115
      && bucket !== LATE_ENTRY_POLICY_TIME_BUCKET_1115_1130
      && bucket !== LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200
    ) {
      reasonCodes.push('v5_bucket_not_in_reopen_cluster');
    }
    if (weekday === 'tuesday' && bucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200) {
      if (Number.isFinite(retestToConfirmationDelayMinutes) && retestToConfirmationDelayMinutes < 3) {
        reasonCodes.push('v5_tue_1130_retest_to_confirmation_too_fast');
      }
      if (Number.isFinite(confirmationDistanceBeyondBreakoutClose) && confirmationDistanceBeyondBreakoutClose > 9.5) {
        reasonCodes.push('v5_tue_1130_confirmation_distance_too_wide');
      }
    }
  }

  const eligible = reasonCodes.length === 0;
  return {
    eligible,
    reasonCodes,
    decision: eligible ? 'allow_extension_v5' : 'reject_extension_v5',
    supportingMetrics: {
      sourceCandlesComplete,
      selectedTpMode,
      weekday,
      baselineWouldTrade: baseline?.wouldTrade === true,
      baselineNoTradeReason: baseline?.noTradeReason || null,
      hard12WouldTrade: hard12?.wouldTrade === true,
      noCutoffWouldTrade: noCutoff?.wouldTrade === true,
      confirmationMinute,
      entryMinute: Number.isFinite(Number(hard12?.entryMinute)) ? Number(hard12.entryMinute) : null,
      breakoutMinute: Number.isFinite(breakoutMinute) ? breakoutMinute : null,
      retestMinute: Number.isFinite(retestMinute) ? retestMinute : null,
      breakoutToRetestDelayMinutes,
      retestToConfirmationDelayMinutes,
      confirmationDistanceBeyondBreakoutClose,
      confirmationTimeBucket: bucket,
      invalidationBeforeConfirmation,
      v4Eligible: gateV4?.eligible === true,
      v4ReasonCodes: Array.isArray(gateV4?.reasonCodes) ? gateV4.reasonCodes.slice(0, 16) : [],
      v5ReopenPocketMatched: reopenPocketMatched,
      v5ReopenPocketKey: pocketA
        ? 'wednesday_1100_1130_skip2_reopen'
        : (pocketB ? 'tuesday_1130_1200_delay_ge3_distance_le95' : null),
    },
  };
}

function classifyLateEntryPolicyComparison(input = {}) {
  const baselineWouldTrade = input.baselineWouldTrade === true;
  const extensionWouldTrade = input.extensionWouldTrade === true;
  const extensionSelectedOutcome = normalizePolicyPathOutcome(input.extensionSelectedOutcome || '');
  const baselineSelectedPnl = toFiniteNumberOrNull(input.baselineSelectedPnl);
  const extensionSelectedPnl = toFiniteNumberOrNull(input.extensionSelectedPnl);

  if (!baselineWouldTrade && !extensionWouldTrade) return 'no_difference';
  if (baselineWouldTrade && !extensionWouldTrade) return 'worse_than_baseline';
  if (!baselineWouldTrade && extensionWouldTrade) {
    if (extensionSelectedOutcome === 'win') return 'rescued_opportunity';
    if (extensionSelectedOutcome === 'loss') return 'rescued_loss';
    return 'no_difference';
  }
  if (Number.isFinite(extensionSelectedPnl) && Number.isFinite(baselineSelectedPnl)) {
    if (extensionSelectedPnl > baselineSelectedPnl) return 'rescued_opportunity';
    if (extensionSelectedPnl < baselineSelectedPnl) return 'worse_than_baseline';
  }
  return 'no_difference';
}

function buildPolicyReplayModeComparisonMap(modeOutcomes = {}) {
  const nearest = modeOutcomes?.nearest || makeNoTradeModeOutcome();
  const skip1 = modeOutcomes?.skip1 || makeNoTradeModeOutcome();
  const skip2 = modeOutcomes?.skip2 || makeNoTradeModeOutcome();
  return {
    Nearest: { ...nearest },
    Skip1: { ...skip1 },
    Skip2: { ...skip2 },
  };
}

function selectLateEntryBroadReplayReference(input = {}) {
  const hard1200 = input.hard1200 && typeof input.hard1200 === 'object' ? input.hard1200 : {};
  if (hard1200?.wouldTrade === true) {
    return {
      laneKey: LATE_ENTRY_BROAD_REPLAY_REFERENCE_KEY,
      sourceVariant: 'hard_1200',
      wouldTrade: true,
      noTradeReason: null,
      entryTime: toText(hard1200.entryTime || '') || null,
      confirmationTime: toText(hard1200.confirmationTime || '') || null,
      breakoutTime: toText(hard1200.breakoutTime || '') || null,
      retestTime: toText(hard1200.retestTime || '') || null,
      modeOutcomes: hard1200.modeOutcomes && typeof hard1200.modeOutcomes === 'object'
        ? { ...hard1200.modeOutcomes }
        : {
          nearest: makeNoTradeModeOutcome(),
          skip1: makeNoTradeModeOutcome(),
          skip2: makeNoTradeModeOutcome(),
        },
    };
  }
  return {
    laneKey: LATE_ENTRY_BROAD_REPLAY_REFERENCE_KEY,
    sourceVariant: 'none',
    wouldTrade: false,
    noTradeReason: toText(hard1200?.noTradeReason || 'no_replay_trade') || 'no_replay_trade',
    entryTime: null,
    confirmationTime: null,
    breakoutTime: null,
    retestTime: null,
    modeOutcomes: {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    },
  };
}

function classifyLateEntryPolicyReplayStatus(input = {}) {
  const baselineWouldTrade = input.baselineWouldTrade === true;
  const extensionWouldTrade = input.extensionWouldTrade === true;
  const broadReplayWouldTrade = input.broadReplayWouldTrade === true;
  const broadReplaySelectedOutcome = normalizePolicyPathOutcome(input.broadReplaySelectedOutcome || '');
  const extensionSelectedOutcome = normalizePolicyPathOutcome(input.extensionSelectedOutcome || '');

  if (!broadReplayWouldTrade) return LATE_ENTRY_POLICY_REPLAY_STATUS_NO_REPLAY_TRADE_EXISTS;
  if (!extensionWouldTrade) {
    if (broadReplaySelectedOutcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) {
      return LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_REJECTED_REPLAY_LOSS;
    }
    return LATE_ENTRY_POLICY_REPLAY_STATUS_REPLAY_POLICY_REJECTED;
  }
  if (!baselineWouldTrade && extensionWouldTrade && extensionSelectedOutcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) {
    return LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_RESCUED_OPPORTUNITY;
  }
  if (baselineWouldTrade === extensionWouldTrade && baselineWouldTrade === true) {
    return LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_TRADE;
  }
  if (baselineWouldTrade === extensionWouldTrade && baselineWouldTrade === false) {
    return LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_NO_TRADE;
  }
  return LATE_ENTRY_POLICY_REPLAY_STATUS_NO_REPLAY_TRADE_EXISTS;
}

function buildBaselinePolicyAlignmentStatus(input = {}) {
  const baselineWouldTrade = input.baselineWouldTrade === true;
  const extensionWouldTrade = input.extensionWouldTrade === true;
  if (baselineWouldTrade === true && extensionWouldTrade === true) {
    return LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_TRADE;
  }
  if (baselineWouldTrade === false && extensionWouldTrade === false) {
    return LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_NO_TRADE;
  }
  return null;
}

function classifyLateEntryPolicyV2Comparison(input = {}) {
  const v1WouldTrade = input.v1WouldTrade === true;
  const v2WouldTrade = input.v2WouldTrade === true;
  const broadReplayWouldTrade = input.broadReplayWouldTrade === true;
  const v2Outcome = normalizePolicyPathOutcome(input.v2SelectedOutcome || '');

  if (!broadReplayWouldTrade && !v2WouldTrade) return LATE_ENTRY_POLICY_V2_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE;
  if (v1WouldTrade === v2WouldTrade) return LATE_ENTRY_POLICY_V2_COMPARISON_AGREED_WITH_V1;
  if (!v1WouldTrade && v2WouldTrade) {
    if (v2Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) return LATE_ENTRY_POLICY_V2_COMPARISON_RESCUED_OPPORTUNITY;
    if (v2Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) return LATE_ENTRY_POLICY_V2_COMPARISON_ADDED_LOSS;
    return LATE_ENTRY_POLICY_V2_COMPARISON_ADDED_TRADE_NEUTRAL;
  }
  if (v1WouldTrade && !v2WouldTrade) return LATE_ENTRY_POLICY_V2_COMPARISON_MORE_CONSERVATIVE;
  return LATE_ENTRY_POLICY_V2_COMPARISON_MIXED;
}

function classifyLateEntryPolicyV3Comparison(input = {}) {
  const v2WouldTrade = input.v2WouldTrade === true;
  const v3WouldTrade = input.v3WouldTrade === true;
  const broadReplayWouldTrade = input.broadReplayWouldTrade === true;
  const v3Outcome = normalizePolicyPathOutcome(input.v3SelectedOutcome || '');

  if (!broadReplayWouldTrade && !v3WouldTrade) return LATE_ENTRY_POLICY_V3_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE;
  if (v2WouldTrade === v3WouldTrade) return LATE_ENTRY_POLICY_V3_COMPARISON_AGREED_WITH_V2;
  if (!v2WouldTrade && v3WouldTrade) {
    if (v3Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) return LATE_ENTRY_POLICY_V3_COMPARISON_RESCUED_OPPORTUNITY;
    if (v3Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) return LATE_ENTRY_POLICY_V3_COMPARISON_ADDED_LOSS;
    if (v3Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) return LATE_ENTRY_POLICY_V3_COMPARISON_ADDED_TRADE_NEUTRAL;
    return LATE_ENTRY_POLICY_V3_COMPARISON_MORE_AGGRESSIVE;
  }
  if (v2WouldTrade && !v3WouldTrade) return LATE_ENTRY_POLICY_V3_COMPARISON_MORE_CONSERVATIVE;
  return LATE_ENTRY_POLICY_V3_COMPARISON_MIXED;
}

function classifyLateEntryPolicyV4Comparison(input = {}) {
  const v3WouldTrade = input.v3WouldTrade === true;
  const v4WouldTrade = input.v4WouldTrade === true;
  const broadReplayWouldTrade = input.broadReplayWouldTrade === true;
  const v4Outcome = normalizePolicyPathOutcome(input.v4SelectedOutcome || '');

  if (!broadReplayWouldTrade && !v4WouldTrade) return LATE_ENTRY_POLICY_V4_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE;
  if (v3WouldTrade === v4WouldTrade) return LATE_ENTRY_POLICY_V4_COMPARISON_AGREED_WITH_V3;
  if (!v3WouldTrade && v4WouldTrade) {
    if (v4Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) return LATE_ENTRY_POLICY_V4_COMPARISON_RESCUED_OPPORTUNITY;
    if (v4Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) return LATE_ENTRY_POLICY_V4_COMPARISON_ADDED_LOSS;
    if (v4Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) return LATE_ENTRY_POLICY_V4_COMPARISON_ADDED_TRADE_NEUTRAL;
    return LATE_ENTRY_POLICY_V4_COMPARISON_MORE_AGGRESSIVE;
  }
  if (v3WouldTrade && !v4WouldTrade) return LATE_ENTRY_POLICY_V4_COMPARISON_MORE_CONSERVATIVE;
  return LATE_ENTRY_POLICY_V4_COMPARISON_MIXED;
}

function classifyLateEntryPolicyV5Comparison(input = {}) {
  const v4WouldTrade = input.v4WouldTrade === true;
  const v5WouldTrade = input.v5WouldTrade === true;
  const broadReplayWouldTrade = input.broadReplayWouldTrade === true;
  const v5Outcome = normalizePolicyPathOutcome(input.v5SelectedOutcome || '');

  if (!broadReplayWouldTrade && !v5WouldTrade) return LATE_ENTRY_POLICY_V5_COMPARISON_AGREED_WITH_REPLAY_NO_TRADE;
  if (v4WouldTrade === v5WouldTrade) return LATE_ENTRY_POLICY_V5_COMPARISON_AGREED_WITH_V4;
  if (!v4WouldTrade && v5WouldTrade) {
    if (v5Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) return LATE_ENTRY_POLICY_V5_COMPARISON_RESCUED_OPPORTUNITY;
    if (v5Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) return LATE_ENTRY_POLICY_V5_COMPARISON_ADDED_LOSS;
    if (v5Outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) return LATE_ENTRY_POLICY_V5_COMPARISON_ADDED_TRADE_NEUTRAL;
    return LATE_ENTRY_POLICY_V5_COMPARISON_MORE_AGGRESSIVE;
  }
  if (v4WouldTrade && !v5WouldTrade) return LATE_ENTRY_POLICY_V5_COMPARISON_MORE_CONSERVATIVE;
  return LATE_ENTRY_POLICY_V5_COMPARISON_MIXED;
}

function buildLateEntryPolicyReplayStatusLine(input = {}) {
  const baselineWouldTrade = input.baselineWouldTrade === true;
  const baselineReason = toText(input.baselineNoTradeReason || '') || 'unknown_reason';
  const extensionWouldTrade = input.extensionWouldTrade === true;
  const extensionDecisionReason = toText(input.extensionDecisionReason || '') || null;
  const extensionReasonCodes = Array.isArray(input.extensionReasonCodes) ? input.extensionReasonCodes.map((code) => toText(code)).filter(Boolean) : [];
  const policyLane = toText(input.policyLane || '').toLowerCase() || 'v1';
  const broadReplay = input.broadReplayReference && typeof input.broadReplayReference === 'object'
    ? input.broadReplayReference
    : { wouldTrade: false, sourceVariant: 'none', entryTime: null };
  const tpReplayComparison = input.tpReplayComparison && typeof input.tpReplayComparison === 'object'
    ? input.tpReplayComparison
    : {};
  const nearest = toText(tpReplayComparison?.Nearest?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE);
  const skip1 = toText(tpReplayComparison?.Skip1?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE);
  const skip2 = toText(tpReplayComparison?.Skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE);

  const baselineText = baselineWouldTrade
    ? 'Baseline 11:00 would have traded.'
    : `Baseline 11:00 rejected it (${baselineReason}).`;
  const extensionLabel = policyLane === 'v5'
    ? 'Extension v5'
    : (policyLane === 'v4'
      ? 'Extension v4'
      : (policyLane === 'v3'
        ? 'Extension v3'
        : (policyLane === 'v2' ? 'Extension v2' : 'Extension v1')));
  const extensionText = extensionWouldTrade
    ? `${extensionLabel} approved the trade.`
    : `${extensionLabel} rejected it${extensionReasonCodes.length ? ` (${extensionReasonCodes.join(', ')})` : (extensionDecisionReason ? ` (${extensionDecisionReason})` : '')}.`;
  if (broadReplay?.wouldTrade === true) {
    const replayVariant = toText(broadReplay.sourceVariant || 'replay').replace(/_/g, '-');
    const replayEntry = toText(broadReplay.entryTime || '') || 'unknown_time';
    return `${baselineText} ${extensionText} Broader ${replayVariant} replay shows a valid ${replayEntry} entry; Nearest=${nearest}, Skip1=${skip1}, Skip2=${skip2}.`;
  }
  return `${baselineText} ${extensionText} No broader 11:00-12:00 replay trade exists.`;
}

function resolveSelectedModeResult(modeOutcomes = {}, selectedTpMode = '') {
  const normalizedSelected = normalizeTpMode(selectedTpMode || '');
  if (normalizedSelected === 'Nearest') return modeOutcomes?.nearest || makeNoTradeModeOutcome();
  if (normalizedSelected === 'Skip 1') return modeOutcomes?.skip1 || makeNoTradeModeOutcome();
  return modeOutcomes?.skip2 || makeNoTradeModeOutcome();
}

function buildLateEntryPolicyExperimentRow(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  const tradeDate = normalizeDate(input.tradeDate || input.date || '');
  if (!tradeDate) return null;
  const sourceType = normalizeSourceType(input.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(input.reconstructionPhase, sourceType);
  const policyKey = toText(input.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const policyVersion = toText(input.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION;
  const selectedTpMode = normalizeTpMode(input.selectedTpMode || '');
  const strategyKey = toText(input.strategyKey || '') || null;
  const strategyName = toText(input.strategyName || '') || null;
  const candles = normalizeOrbReplayCandles(input.candles || []);
  const normalizedShadowCandles = normalizeShadowCandleRows(candles);
  const orbWindowCandles = normalizedShadowCandles.filter((row) => row.minuteOfDay >= 570 && row.minuteOfDay <= 584);
  const sourceCandlesComplete = normalizedShadowCandles.length >= 6 && orbWindowCandles.length >= 3;

  const baseline = runOrbReplayVariantForPolicy({
    candles,
    maxEntryHour: 11,
  });
  const hard12 = runOrbReplayVariantForPolicy({
    candles,
    maxEntryHour: 12,
  });
  const noCutoff = runOrbReplayVariantForPolicy({
    candles,
    maxEntryHour: null,
  });

  const signalContext = resolveContextSignalContext(input.contextJson || {});
  const regimeLabel = [
    signalContext.trend || 'unknown',
    signalContext.volatility || 'unknown',
    signalContext.orbProfile || 'unknown',
  ].join('|');
  const weekday = weekdayFromDate(tradeDate);
  const isV2Policy = isV2PolicyKey(policyKey);
  const isV3Policy = isV3PolicyKey(policyKey);
  const isV4Policy = isV4PolicyKey(policyKey);
  const isV5Policy = isV5PolicyKey(policyKey);
  const gateV1 = evaluateLateEntrySkip2ExtensionGate({
    baseline,
    hard12,
    noCutoff,
    selectedTpMode,
    sourceCandlesComplete,
    highRiskContext: signalContext.highRiskContext === true,
  });
  const gateV2 = evaluateLateEntrySkip2ExtensionV2Gate({
    baseline,
    hard12,
    noCutoff,
    selectedTpMode,
    sourceCandlesComplete,
    highRiskContext: signalContext.highRiskContext === true,
    weekday,
    orbRangeTicks: signalContext.orbRangeTicks,
  });
  const gateV3 = evaluateLateEntrySkip2ExtensionV3Gate({
    baseline,
    hard12,
    noCutoff,
    selectedTpMode,
    sourceCandlesComplete,
    highRiskContext: signalContext.highRiskContext === true,
    weekday,
    regimeLabel,
    orbRangeTicks: signalContext.orbRangeTicks,
  });
  const gateV4 = evaluateLateEntrySkip2ExtensionV4Gate({
    baseline,
    hard12,
    noCutoff,
    selectedTpMode,
    sourceCandlesComplete,
    highRiskContext: signalContext.highRiskContext === true,
    weekday,
    regimeLabel,
    orbRangeTicks: signalContext.orbRangeTicks,
    gateV3,
  });
  const gateV5 = evaluateLateEntrySkip2ExtensionV5Gate({
    baseline,
    hard12,
    noCutoff,
    selectedTpMode,
    sourceCandlesComplete,
    highRiskContext: signalContext.highRiskContext === true,
    weekday,
    regimeLabel,
    orbRangeTicks: signalContext.orbRangeTicks,
    gateV3,
    gateV4,
  });
  const gate = isV3Policy
    ? gateV3
    : (isV2Policy
      ? gateV2
      : (isV4Policy
        ? gateV4
        : (isV5Policy ? gateV5 : gateV1)));

  const decideExtensionReplay = (gateInput = {}, decisionTag = 'v1') => {
    let decisionReason = 'baseline_rule_preserved';
    let reasonCodes = Array.isArray(gateInput.reasonCodes) ? gateInput.reasonCodes.slice() : [];
    let replay = baseline;
    if (baseline.wouldTrade !== true) {
      if (gateInput.eligible === true) {
        replay = hard12;
        if (decisionTag === 'v5') decisionReason = 'extension_gate_passed_v5';
        else if (decisionTag === 'v4') decisionReason = 'extension_gate_passed_v4';
        else if (decisionTag === 'v3') decisionReason = 'extension_gate_passed_v3';
        else if (decisionTag === 'v2') decisionReason = 'extension_gate_passed_v2';
        else decisionReason = 'extension_gate_passed_skip2_1100_1200';
        reasonCodes = [decisionReason];
      } else {
        replay = {
          wouldTrade: false,
          noTradeReason: toText(baseline.noTradeReason || 'entry_after_max_hour') || 'entry_after_max_hour',
        };
        if (decisionTag === 'v5') decisionReason = 'extension_gate_rejected_v5';
        else if (decisionTag === 'v4') decisionReason = 'extension_gate_rejected_v4';
        else if (decisionTag === 'v3') decisionReason = 'extension_gate_rejected_v3';
        else if (decisionTag === 'v2') decisionReason = 'extension_gate_rejected_v2';
        else decisionReason = 'extension_gate_rejected';
      }
    }
    return {
      replay,
      decisionReason,
      reasonCodes,
    };
  };
  const v1Decision = decideExtensionReplay(gateV1, 'v1');
  const v2Decision = decideExtensionReplay(gateV2, 'v2');
  const v3Decision = decideExtensionReplay(gateV3, 'v3');
  const v4Decision = decideExtensionReplay(gateV4, 'v4');
  const v5Decision = decideExtensionReplay(gateV5, 'v5');
  const policyDecision = isV3Policy
    ? v3Decision
    : (isV2Policy
      ? v2Decision
      : (isV4Policy
        ? v4Decision
        : (isV5Policy ? v5Decision : v1Decision)));
  let extensionDecisionReason = policyDecision.decisionReason;
  let extensionReasonCodes = policyDecision.reasonCodes;
  let extensionReplay = policyDecision.replay;

  const baselineModeOutcomes = baseline.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: baseline?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const hard12ModeOutcomes = hard12.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: hard12?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const noCutoffModeOutcomes = noCutoff.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: noCutoff?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const v1ModeOutcomes = v1Decision?.replay?.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: v1Decision?.replay?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const v2ModeOutcomes = v2Decision?.replay?.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: v2Decision?.replay?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const v3ModeOutcomes = v3Decision?.replay?.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: v3Decision?.replay?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const v4ModeOutcomes = v4Decision?.replay?.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: v4Decision?.replay?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const extensionModeOutcomes = extensionReplay?.wouldTrade === true
    ? buildTpModeOutcomesForTrade({
      candles,
      trade: extensionReplay?.baselineReplay?.trade || null,
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    })
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const selectedOutcome = resolveSelectedModeResult(extensionModeOutcomes, selectedTpMode || 'Skip 2');
  const baselineSelectedOutcome = resolveSelectedModeResult(baselineModeOutcomes, selectedTpMode || 'Skip 2');
  const v1SelectedOutcome = resolveSelectedModeResult(v1ModeOutcomes, selectedTpMode || 'Skip 2');
  const v2SelectedOutcome = resolveSelectedModeResult(v2ModeOutcomes, selectedTpMode || 'Skip 2');
  const v3SelectedOutcome = resolveSelectedModeResult(v3ModeOutcomes, selectedTpMode || 'Skip 2');
  const v4SelectedOutcome = resolveSelectedModeResult(v4ModeOutcomes, selectedTpMode || 'Skip 2');
  const comparisonLabel = classifyLateEntryPolicyComparison({
    baselineWouldTrade: baseline.wouldTrade === true,
    extensionWouldTrade: extensionReplay?.wouldTrade === true,
    extensionSelectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    baselineSelectedPnl: baselineSelectedOutcome?.pnl,
    extensionSelectedPnl: selectedOutcome?.pnl,
  });
  const broadReplayReference = selectLateEntryBroadReplayReference({
    hard1200: {
      wouldTrade: hard12.wouldTrade === true,
      noTradeReason: hard12.noTradeReason || null,
      entryTime: hard12.entryTime || null,
      confirmationTime: hard12.confirmationTime || null,
      breakoutTime: hard12.breakoutTime || null,
      retestTime: hard12.retestTime || null,
      modeOutcomes: hard12ModeOutcomes,
    },
    noCutoff: {
      wouldTrade: noCutoff.wouldTrade === true,
      noTradeReason: noCutoff.noTradeReason || null,
      entryTime: noCutoff.entryTime || null,
      confirmationTime: noCutoff.confirmationTime || null,
      breakoutTime: noCutoff.breakoutTime || null,
      retestTime: noCutoff.retestTime || null,
      modeOutcomes: noCutoffModeOutcomes,
    },
  });
  const broadReplayModeOutcomes = broadReplayReference?.modeOutcomes && typeof broadReplayReference.modeOutcomes === 'object'
    ? broadReplayReference.modeOutcomes
    : {
      nearest: makeNoTradeModeOutcome(),
      skip1: makeNoTradeModeOutcome(),
      skip2: makeNoTradeModeOutcome(),
    };
  const broadReplaySelectedOutcome = resolveSelectedModeResult(broadReplayModeOutcomes, selectedTpMode || 'Skip 2');
  const tpReplayComparison = buildPolicyReplayModeComparisonMap(broadReplayModeOutcomes);
  const policyReplayClassification = normalizeLateEntryPolicyReplayStatus(
    classifyLateEntryPolicyReplayStatus({
      baselineWouldTrade: baseline.wouldTrade === true,
      extensionWouldTrade: extensionReplay?.wouldTrade === true,
      broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
      broadReplaySelectedOutcome: broadReplaySelectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      extensionSelectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    })
  );
  const baselinePolicyAlignment = buildBaselinePolicyAlignmentStatus({
    baselineWouldTrade: baseline.wouldTrade === true,
    extensionWouldTrade: extensionReplay?.wouldTrade === true,
  });
  const replayWouldHaveTradedButPolicyRejected = broadReplayReference?.wouldTrade === true && extensionReplay?.wouldTrade !== true;
  const policyReplayStatusLine = buildLateEntryPolicyReplayStatusLine({
    policyLane: isV5Policy ? 'v5' : (isV4Policy ? 'v4' : (isV3Policy ? 'v3' : (isV2Policy ? 'v2' : 'v1'))),
    baselineWouldTrade: baseline.wouldTrade === true,
    baselineNoTradeReason: baseline.noTradeReason || null,
    extensionWouldTrade: extensionReplay?.wouldTrade === true,
    extensionDecisionReason,
    extensionReasonCodes,
    broadReplayReference,
    tpReplayComparison,
  });
  const v2ComparisonClassification = isV2Policy
    ? normalizeLateEntryPolicyV2Comparison(
      classifyLateEntryPolicyV2Comparison({
        v1WouldTrade: v1Decision?.replay?.wouldTrade === true,
        v2WouldTrade: extensionReplay?.wouldTrade === true,
        broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
        v2SelectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      })
    )
    : null;
  const v3ComparisonClassification = isV3Policy
    ? normalizeLateEntryPolicyV3Comparison(
      classifyLateEntryPolicyV3Comparison({
        v2WouldTrade: v2Decision?.replay?.wouldTrade === true,
        v3WouldTrade: extensionReplay?.wouldTrade === true,
        broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
        v3SelectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      })
    )
    : null;
  const v4ComparisonClassification = isV4Policy
    ? normalizeLateEntryPolicyV4Comparison(
      classifyLateEntryPolicyV4Comparison({
        v3WouldTrade: v3Decision?.replay?.wouldTrade === true,
        v4WouldTrade: extensionReplay?.wouldTrade === true,
        broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
        v4SelectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      })
    )
    : null;
  const v5ComparisonClassification = isV5Policy
    ? normalizeLateEntryPolicyV5Comparison(
      classifyLateEntryPolicyV5Comparison({
        v4WouldTrade: v4Decision?.replay?.wouldTrade === true,
        v5WouldTrade: extensionReplay?.wouldTrade === true,
        broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
        v5SelectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      })
    )
    : null;
  const confirmationMinute = Number.isFinite(Number(extensionReplay?.confirmationMinute))
    ? Number(extensionReplay.confirmationMinute)
    : Number(gate?.supportingMetrics?.confirmationMinute);
  const confirmationTimeBucket = buildLateEntryTimeBucket(confirmationMinute);
  const extensionEntryTime = toText(extensionReplay?.entryTime || '') || null;
  const extensionDirection = toText(extensionReplay?.direction || '').toLowerCase() || null;

  let simulationConfidence = 0.82;
  if (!sourceCandlesComplete) simulationConfidence = 0.3;
  else if (extensionReplay?.wouldTrade === true && gate.eligible === true) simulationConfidence = 0.95;
  else if (baseline.wouldTrade === true) simulationConfidence = 0.88;
  else if (
    extensionReasonCodes.includes('selected_tp_mode_not_skip2')
    || extensionReasonCodes.includes('selected_tp_mode_not_enabled_v2')
    || extensionReasonCodes.includes('selected_tp_mode_not_enabled_v3')
  ) simulationConfidence = 0.9;

  const summaryJson = {
    tradeDate,
    policyKey,
    policyVersion,
    policyLane: isV5Policy ? 'v5' : (isV4Policy ? 'v4' : (isV3Policy ? 'v3' : (isV2Policy ? 'v2' : 'v1'))),
    policyBaseCutoff: LATE_ENTRY_POLICY_BASELINE_CUTOFF,
    extensionWindow: {
      start: LATE_ENTRY_POLICY_EXTENSION_START,
      end: LATE_ENTRY_POLICY_EXTENSION_END,
      hardStop: LATE_ENTRY_POLICY_EXTENSION_END,
    },
    baseline: {
      wouldTrade: baseline.wouldTrade === true,
      noTradeReason: baseline.noTradeReason || null,
      entryTime: baseline.entryTime || null,
      confirmationTime: baseline.confirmationTime || null,
      breakoutTime: baseline.breakoutTime || null,
      retestTime: baseline.retestTime || null,
      modeOutcomes: baselineModeOutcomes,
    },
    extensionPolicy: {
      wouldTrade: extensionReplay?.wouldTrade === true,
      decisionReason: extensionDecisionReason,
      reasonCodes: extensionReasonCodes,
      comparisonLabel,
      entryTime: extensionEntryTime,
      direction: extensionDirection,
      confirmationTime: extensionReplay?.confirmationTime || null,
      breakoutTime: extensionReplay?.breakoutTime || null,
      retestTime: extensionReplay?.retestTime || null,
      modeOutcomes: extensionModeOutcomes,
    },
    v1Reference: {
      wouldTrade: v1Decision?.replay?.wouldTrade === true,
      decisionReason: v1Decision?.decisionReason || null,
      reasonCodes: Array.isArray(v1Decision?.reasonCodes) ? v1Decision.reasonCodes : [],
      selectedTpMode: selectedTpMode || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(v1SelectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(v1SelectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(v1SelectedOutcome?.pnl))
          : null,
      },
      entryTime: toText(v1Decision?.replay?.entryTime || '') || null,
      confirmationTime: toText(v1Decision?.replay?.confirmationTime || '') || null,
    },
    v2Reference: {
      wouldTrade: v2Decision?.replay?.wouldTrade === true,
      decisionReason: v2Decision?.decisionReason || null,
      reasonCodes: Array.isArray(v2Decision?.reasonCodes) ? v2Decision.reasonCodes : [],
      selectedTpMode: selectedTpMode || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(v2SelectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(v2SelectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(v2SelectedOutcome?.pnl))
          : null,
      },
      entryTime: toText(v2Decision?.replay?.entryTime || '') || null,
      confirmationTime: toText(v2Decision?.replay?.confirmationTime || '') || null,
    },
    v3Reference: {
      wouldTrade: v3Decision?.replay?.wouldTrade === true,
      decisionReason: v3Decision?.decisionReason || null,
      reasonCodes: Array.isArray(v3Decision?.reasonCodes) ? v3Decision.reasonCodes : [],
      selectedTpMode: selectedTpMode || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(v3SelectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(v3SelectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(v3SelectedOutcome?.pnl))
          : null,
      },
      entryTime: toText(v3Decision?.replay?.entryTime || '') || null,
      confirmationTime: toText(v3Decision?.replay?.confirmationTime || '') || null,
    },
    v4Reference: {
      wouldTrade: v4Decision?.replay?.wouldTrade === true,
      decisionReason: v4Decision?.decisionReason || null,
      reasonCodes: Array.isArray(v4Decision?.reasonCodes) ? v4Decision.reasonCodes : [],
      selectedTpMode: selectedTpMode || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(v4SelectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(v4SelectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(v4SelectedOutcome?.pnl))
          : null,
      },
      entryTime: toText(v4Decision?.replay?.entryTime || '') || null,
      confirmationTime: toText(v4Decision?.replay?.confirmationTime || '') || null,
    },
    hard1200: {
      wouldTrade: hard12.wouldTrade === true,
      noTradeReason: hard12.noTradeReason || null,
      entryTime: hard12.entryTime || null,
      confirmationTime: hard12.confirmationTime || null,
      breakoutTime: hard12.breakoutTime || null,
      retestTime: hard12.retestTime || null,
      modeOutcomes: hard12ModeOutcomes,
    },
    noCutoff: {
      wouldTrade: noCutoff.wouldTrade === true,
      noTradeReason: noCutoff.noTradeReason || null,
      entryTime: noCutoff.entryTime || null,
      confirmationTime: noCutoff.confirmationTime || null,
      breakoutTime: noCutoff.breakoutTime || null,
      retestTime: noCutoff.retestTime || null,
      modeOutcomes: noCutoffModeOutcomes,
    },
    baselineDecision: {
      wouldTrade: baseline.wouldTrade === true,
      noTradeReason: baseline.noTradeReason || null,
      entryTime: baseline.entryTime || null,
      confirmationTime: baseline.confirmationTime || null,
      breakoutTime: baseline.breakoutTime || null,
      retestTime: baseline.retestTime || null,
      selectedTpMode: selectedTpMode || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(baselineSelectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(baselineSelectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(baselineSelectedOutcome?.pnl))
          : null,
      },
    },
    extensionPolicyDecision: {
      wouldTrade: extensionReplay?.wouldTrade === true,
      decisionReason: extensionDecisionReason,
      reasonCodes: extensionReasonCodes,
      selectedTpMode: selectedTpMode || null,
      entryTime: extensionEntryTime,
      confirmationTime: extensionReplay?.confirmationTime || null,
      breakoutTime: extensionReplay?.breakoutTime || null,
      retestTime: extensionReplay?.retestTime || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(selectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(selectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(selectedOutcome?.pnl))
          : null,
      },
    },
    hard1200Replay: {
      wouldTrade: hard12.wouldTrade === true,
      noTradeReason: hard12.noTradeReason || null,
      entryTime: hard12.entryTime || null,
      confirmationTime: hard12.confirmationTime || null,
      breakoutTime: hard12.breakoutTime || null,
      retestTime: hard12.retestTime || null,
      modeOutcomes: hard12ModeOutcomes,
    },
    noCutoffReplay: {
      wouldTrade: noCutoff.wouldTrade === true,
      noTradeReason: noCutoff.noTradeReason || null,
      entryTime: noCutoff.entryTime || null,
      confirmationTime: noCutoff.confirmationTime || null,
      breakoutTime: noCutoff.breakoutTime || null,
      retestTime: noCutoff.retestTime || null,
      modeOutcomes: noCutoffModeOutcomes,
    },
    broadReplayReference: {
      laneKey: LATE_ENTRY_BROAD_REPLAY_REFERENCE_KEY,
      sourceVariant: broadReplayReference?.sourceVariant || 'none',
      wouldTrade: broadReplayReference?.wouldTrade === true,
      noTradeReason: broadReplayReference?.noTradeReason || null,
      entryTime: broadReplayReference?.entryTime || null,
      confirmationTime: broadReplayReference?.confirmationTime || null,
      breakoutTime: broadReplayReference?.breakoutTime || null,
      retestTime: broadReplayReference?.retestTime || null,
      selectedTpMode: selectedTpMode || null,
      selectedOutcome: {
        outcome: normalizePolicyPathOutcome(broadReplaySelectedOutcome?.outcome || ''),
        pnl: Number.isFinite(toFiniteNumberOrNull(broadReplaySelectedOutcome?.pnl))
          ? round2(toFiniteNumberOrNull(broadReplaySelectedOutcome?.pnl))
          : null,
      },
      modeOutcomes: broadReplayModeOutcomes,
    },
    tpReplayComparison,
    broaderReplayWouldTrade: broadReplayReference?.wouldTrade === true,
    replayWouldHaveTradedButPolicyRejected,
    policyReplayClassification,
    baselinePolicyAlignment,
    v2ComparisonClassification,
    v3ComparisonClassification,
    v4ComparisonClassification,
    v5ComparisonClassification,
    policyReplayStatusLine,
    extensionGate: gate,
    sourceCandlesComplete,
    selectedTpMode: selectedTpMode || null,
    selectedModeIsSkip2: selectedTpMode === 'Skip 2',
    policyAddedTrade: baseline.wouldTrade !== true && extensionReplay?.wouldTrade === true,
    strongerClusterCandidate: gate?.supportingMetrics?.historicallyStrongerCluster === true,
    weakerClusterCandidate: gate?.supportingMetrics?.historicallyWeakerCluster === true,
    regimeLabel,
    weekday,
    orbRangeTicks: Number.isFinite(toFiniteNumberOrNull(signalContext.orbRangeTicks))
      ? round2(toFiniteNumberOrNull(signalContext.orbRangeTicks))
      : null,
    diagnostics: {
      breakoutToRetestDelayMinutes: gate?.supportingMetrics?.breakoutToRetestDelayMinutes ?? null,
      retestToConfirmationDelayMinutes: gate?.supportingMetrics?.retestToConfirmationDelayMinutes ?? null,
      confirmationDistanceBeyondBreakoutClose: gate?.supportingMetrics?.confirmationDistanceBeyondBreakoutClose ?? null,
      confirmationTimeBucket,
      entryMinute: gate?.supportingMetrics?.entryMinute ?? null,
      confirmationMinute: gate?.supportingMetrics?.confirmationMinute ?? null,
      baselineRejectedReason: baseline.noTradeReason || null,
      extensionAllowedReason: gate.eligible === true ? extensionDecisionReason : null,
    },
  };

  return {
    tradeDate,
    policyKey,
    policyVersion,
    sourceType,
    reconstructionPhase,
    baselineWouldTrade: baseline.wouldTrade === true,
    baselineNoTradeReason: baseline.noTradeReason || null,
    extensionWouldTrade: extensionReplay?.wouldTrade === true,
    extensionDecisionReason,
    extensionReasonCodes,
    entryTime: extensionEntryTime,
    direction: extensionDirection,
    strategyKey,
    strategyName,
    selectedTpMode: selectedTpMode || null,
    selectedOutcome: selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    selectedPnl: Number.isFinite(toFiniteNumberOrNull(selectedOutcome?.pnl))
      ? round2(toFiniteNumberOrNull(selectedOutcome?.pnl))
      : null,
    nearestOutcome: extensionModeOutcomes?.nearest?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    nearestPnl: Number.isFinite(toFiniteNumberOrNull(extensionModeOutcomes?.nearest?.pnl))
      ? round2(toFiniteNumberOrNull(extensionModeOutcomes?.nearest?.pnl))
      : null,
    skip1Outcome: extensionModeOutcomes?.skip1?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    skip1Pnl: Number.isFinite(toFiniteNumberOrNull(extensionModeOutcomes?.skip1?.pnl))
      ? round2(toFiniteNumberOrNull(extensionModeOutcomes?.skip1?.pnl))
      : null,
    skip2Outcome: extensionModeOutcomes?.skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    skip2Pnl: Number.isFinite(toFiniteNumberOrNull(extensionModeOutcomes?.skip2?.pnl))
      ? round2(toFiniteNumberOrNull(extensionModeOutcomes?.skip2?.pnl))
      : null,
    regimeLabel,
    weekday,
    orbRangeTicks: Number.isFinite(toFiniteNumberOrNull(signalContext.orbRangeTicks))
      ? round2(toFiniteNumberOrNull(signalContext.orbRangeTicks))
      : null,
    confirmationTimeBucket,
    sourceCandlesComplete: sourceCandlesComplete === true,
    simulationConfidence: round2(simulationConfidence),
    summaryJson,
  };
}

function upsertLateEntryPolicyExperimentRow(input = {}) {
  const db = input.db;
  const row = input.row && typeof input.row === 'object' ? input.row : null;
  if (!db || typeof db.prepare !== 'function' || !row) return null;
  ensureRecommendationOutcomeSchema(db);
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
      summary_json,
      updated_at
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
      @summary_json,
      datetime('now')
    )
    ON CONFLICT(trade_date, policy_key, policy_version, source_type, reconstruction_phase) DO UPDATE SET
      baseline_would_trade = excluded.baseline_would_trade,
      baseline_no_trade_reason = excluded.baseline_no_trade_reason,
      extension_would_trade = excluded.extension_would_trade,
      extension_decision_reason = excluded.extension_decision_reason,
      extension_reason_codes_json = excluded.extension_reason_codes_json,
      entry_time = excluded.entry_time,
      direction = excluded.direction,
      strategy_key = excluded.strategy_key,
      strategy_name = excluded.strategy_name,
      selected_tp_mode = excluded.selected_tp_mode,
      selected_outcome = excluded.selected_outcome,
      selected_pnl = excluded.selected_pnl,
      nearest_outcome = excluded.nearest_outcome,
      nearest_pnl = excluded.nearest_pnl,
      skip1_outcome = excluded.skip1_outcome,
      skip1_pnl = excluded.skip1_pnl,
      skip2_outcome = excluded.skip2_outcome,
      skip2_pnl = excluded.skip2_pnl,
      regime_label = excluded.regime_label,
      weekday = excluded.weekday,
      orb_range_ticks = excluded.orb_range_ticks,
      confirmation_time_bucket = excluded.confirmation_time_bucket,
      source_candles_complete = excluded.source_candles_complete,
      simulation_confidence = excluded.simulation_confidence,
      summary_json = excluded.summary_json,
      updated_at = datetime('now')
  `).run({
    trade_date: row.tradeDate,
    policy_key: toText(row.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    policy_version: toText(row.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    source_type: normalizeSourceType(row.sourceType || SOURCE_LIVE),
    reconstruction_phase: normalizeReconstructionPhase(row.reconstructionPhase, row.sourceType || SOURCE_LIVE),
    baseline_would_trade: row.baselineWouldTrade ? 1 : 0,
    baseline_no_trade_reason: toText(row.baselineNoTradeReason || '') || null,
    extension_would_trade: row.extensionWouldTrade ? 1 : 0,
    extension_decision_reason: toText(row.extensionDecisionReason || '') || null,
    extension_reason_codes_json: JSON.stringify(Array.isArray(row.extensionReasonCodes) ? row.extensionReasonCodes : []),
    entry_time: toText(row.entryTime || '') || null,
    direction: toText(row.direction || '') || null,
    strategy_key: toText(row.strategyKey || '') || null,
    strategy_name: toText(row.strategyName || '') || null,
    selected_tp_mode: toText(row.selectedTpMode || '') || null,
    selected_outcome: toText(row.selectedOutcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    selected_pnl: Number.isFinite(toFiniteNumberOrNull(row.selectedPnl)) ? round2(toFiniteNumberOrNull(row.selectedPnl)) : null,
    nearest_outcome: toText(row.nearestOutcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    nearest_pnl: Number.isFinite(toFiniteNumberOrNull(row.nearestPnl)) ? round2(toFiniteNumberOrNull(row.nearestPnl)) : null,
    skip1_outcome: toText(row.skip1Outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    skip1_pnl: Number.isFinite(toFiniteNumberOrNull(row.skip1Pnl)) ? round2(toFiniteNumberOrNull(row.skip1Pnl)) : null,
    skip2_outcome: toText(row.skip2Outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    skip2_pnl: Number.isFinite(toFiniteNumberOrNull(row.skip2Pnl)) ? round2(toFiniteNumberOrNull(row.skip2Pnl)) : null,
    regime_label: toText(row.regimeLabel || '') || null,
    weekday: toText(row.weekday || '') || null,
    orb_range_ticks: Number.isFinite(toFiniteNumberOrNull(row.orbRangeTicks)) ? round2(toFiniteNumberOrNull(row.orbRangeTicks)) : null,
    confirmation_time_bucket: toText(row.confirmationTimeBucket || '') || null,
    source_candles_complete: row.sourceCandlesComplete ? 1 : 0,
    simulation_confidence: Number.isFinite(toFiniteNumberOrNull(row.simulationConfidence))
      ? round2(toFiniteNumberOrNull(row.simulationConfidence))
      : null,
    summary_json: JSON.stringify(row.summaryJson || {}),
  });
  return db.prepare(`
    SELECT *
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND policy_version = ?
      AND source_type = ?
      AND reconstruction_phase = ?
    LIMIT 1
  `).get(
    row.tradeDate,
    toText(row.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    toText(row.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    normalizeSourceType(row.sourceType || SOURCE_LIVE),
    normalizeReconstructionPhase(row.reconstructionPhase, row.sourceType || SOURCE_LIVE)
  ) || null;
}

function formatLateEntryPolicyExperimentRow(row = null) {
  if (!row || typeof row !== 'object') return null;
  const summary = safeJsonParse(row.summary_json, {});
  const rowPolicyKey = toText(row.policy_key || '') || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const rowIsV2Policy = isV2PolicyKey(rowPolicyKey);
  const rowIsV3Policy = isV3PolicyKey(rowPolicyKey);
  const rowIsV4Policy = isV4PolicyKey(rowPolicyKey);
  const rowIsV5Policy = isV5PolicyKey(rowPolicyKey);
  const rowPolicyLane = toText(summary?.policyLane || '') || (
    rowIsV5Policy
      ? 'v5'
      : (
      rowIsV4Policy
      ? 'v4'
      : (rowIsV3Policy ? 'v3' : (rowIsV2Policy ? 'v2' : 'v1'))
      )
  );
  const extensionReasonCodes = (() => {
    try {
      const parsed = JSON.parse(String(row.extension_reason_codes_json || '[]'));
      return Array.isArray(parsed) ? parsed.map((code) => toText(code)).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  const sourceType = toText(row.source_type || '') || SOURCE_LIVE;
  const reconstructionPhase = toText(row.reconstruction_phase || '') || PHASE_LIVE_INTRADAY;
  const tradeDate = normalizeDate(row.trade_date || '');
  const external = resolveExternalExecutionOutcomeForDate(
    row.__db || null,
    tradeDate
  );
  const externalTopstepOutcomeIfAvailable = (
    external?.hasRows === true
    && (
      external?.sourceInUse === REALIZED_TRUTH_SOURCE_PRIMARY
      || external?.sourceInUse === REALIZED_TRUTH_SOURCE_SECONDARY
    )
  )
    ? {
      tradeCount: Number(external.tradeCount || 0),
      wins: Number(external.wins || 0),
      losses: Number(external.losses || 0),
      breakeven: Number(external.breakeven || 0),
      netPnlDollars: round2(Number(external.netPnlDollars || 0)),
      sourceInUse: normalizeRealizedTruthSource(external.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
      sourceBacked: external.sourceBacked === true,
      trustClassification: normalizeShadowPlaybookDurabilityTrust(external.trustClassification || REALIZED_TRUTH_TRUST_PARTIAL),
    }
    : null;
  const baselineDecision = summary?.baselineDecision && typeof summary.baselineDecision === 'object'
    ? { ...summary.baselineDecision }
    : (
      summary?.baseline && typeof summary.baseline === 'object'
        ? { ...summary.baseline }
        : {
          wouldTrade: Number(row.baseline_would_trade || 0) === 1,
          noTradeReason: toText(row.baseline_no_trade_reason || '') || null,
        }
    );
  const extensionPolicyDecision = summary?.extensionPolicyDecision && typeof summary.extensionPolicyDecision === 'object'
    ? { ...summary.extensionPolicyDecision }
    : (
      summary?.extensionPolicy && typeof summary.extensionPolicy === 'object'
        ? { ...summary.extensionPolicy }
        : {
          wouldTrade: Number(row.extension_would_trade || 0) === 1,
          decisionReason: toText(row.extension_decision_reason || '') || null,
          reasonCodes: extensionReasonCodes,
        }
    );
  const hard1200Replay = summary?.hard1200Replay && typeof summary.hard1200Replay === 'object'
    ? { ...summary.hard1200Replay }
    : (
      summary?.hard1200 && typeof summary.hard1200 === 'object'
        ? { ...summary.hard1200 }
        : { wouldTrade: false, noTradeReason: null }
    );
  const noCutoffReplay = summary?.noCutoffReplay && typeof summary.noCutoffReplay === 'object'
    ? { ...summary.noCutoffReplay }
    : (
      summary?.noCutoff && typeof summary.noCutoff === 'object'
        ? { ...summary.noCutoff }
        : { wouldTrade: false, noTradeReason: null }
    );
  const broadReplayReference = summary?.broadReplayReference && typeof summary.broadReplayReference === 'object'
    ? { ...summary.broadReplayReference }
    : selectLateEntryBroadReplayReference({
      hard1200: hard1200Replay,
      noCutoff: noCutoffReplay,
    });
  const tpReplayComparison = summary?.tpReplayComparison && typeof summary.tpReplayComparison === 'object'
    ? { ...summary.tpReplayComparison }
    : buildPolicyReplayModeComparisonMap(broadReplayReference?.modeOutcomes || {});
  const replayWouldHaveTradedButPolicyRejected = summary?.replayWouldHaveTradedButPolicyRejected === true
    || (broadReplayReference?.wouldTrade === true && extensionPolicyDecision?.wouldTrade !== true);
  const baselinePolicyAlignmentRaw = summary?.baselinePolicyAlignment
    || buildBaselinePolicyAlignmentStatus({
      baselineWouldTrade: baselineDecision?.wouldTrade === true,
      extensionWouldTrade: extensionPolicyDecision?.wouldTrade === true,
    });
  const baselinePolicyAlignment = baselinePolicyAlignmentRaw
    ? normalizeLateEntryPolicyReplayStatus(baselinePolicyAlignmentRaw)
    : null;
  const policyReplayClassification = normalizeLateEntryPolicyReplayStatus(
    summary?.policyReplayClassification
      || classifyLateEntryPolicyReplayStatus({
        baselineWouldTrade: baselineDecision?.wouldTrade === true,
        extensionWouldTrade: extensionPolicyDecision?.wouldTrade === true,
        broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
        broadReplaySelectedOutcome: (
          broadReplayReference?.selectedOutcome?.outcome
          || resolveSelectedModeResult(
            broadReplayReference?.modeOutcomes && typeof broadReplayReference.modeOutcomes === 'object'
              ? broadReplayReference.modeOutcomes
              : {},
            toText(row.selected_tp_mode || '') || 'Skip 2'
          )?.outcome
        ),
        extensionSelectedOutcome: normalizePolicyPathOutcome(row.selected_outcome || ''),
      })
  );
  const policyReplayStatusLine = toText(summary?.policyReplayStatusLine || '')
    || buildLateEntryPolicyReplayStatusLine({
      policyLane: rowPolicyLane,
      baselineWouldTrade: baselineDecision?.wouldTrade === true,
      baselineNoTradeReason: baselineDecision?.noTradeReason || toText(row.baseline_no_trade_reason || '') || null,
      extensionWouldTrade: extensionPolicyDecision?.wouldTrade === true,
      extensionDecisionReason: extensionPolicyDecision?.decisionReason || toText(row.extension_decision_reason || '') || null,
      extensionReasonCodes: extensionPolicyDecision?.reasonCodes || extensionReasonCodes,
      broadReplayReference,
      tpReplayComparison,
    });
  const v2ComparisonClassification = rowIsV2Policy
    ? normalizeLateEntryPolicyV2Comparison(summary?.v2ComparisonClassification || '')
    : null;
  const v3ComparisonClassification = rowIsV3Policy
    ? normalizeLateEntryPolicyV3Comparison(summary?.v3ComparisonClassification || '')
    : null;
  const v4ComparisonClassification = rowIsV4Policy
    ? normalizeLateEntryPolicyV4Comparison(summary?.v4ComparisonClassification || '')
    : null;
  const v5ComparisonClassification = rowIsV5Policy
    ? normalizeLateEntryPolicyV5Comparison(summary?.v5ComparisonClassification || '')
    : null;
  const v1Reference = summary?.v1Reference && typeof summary.v1Reference === 'object'
    ? { ...summary.v1Reference }
    : null;
  const v2Reference = summary?.v2Reference && typeof summary.v2Reference === 'object'
    ? { ...summary.v2Reference }
    : null;
  const v3Reference = summary?.v3Reference && typeof summary.v3Reference === 'object'
    ? { ...summary.v3Reference }
    : null;
  const v4Reference = summary?.v4Reference && typeof summary.v4Reference === 'object'
    ? { ...summary.v4Reference }
    : null;
  return {
    tradeDate,
    policyKey: rowPolicyKey,
    policyVersion: toText(row.policy_version || '') || LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    policyLane: rowPolicyLane,
    sourceType,
    reconstructionPhase,
    wouldBaselineTakeTrade: Number(row.baseline_would_trade || 0) === 1,
    baselineNoTradeReason: toText(row.baseline_no_trade_reason || '') || null,
    wouldExtensionPolicyTakeTrade: Number(row.extension_would_trade || 0) === 1,
    extensionDecisionReason: toText(row.extension_decision_reason || '') || null,
    extensionReasonCodes,
    entryTimestamp: toText(row.entry_time || '') || null,
    direction: toText(row.direction || '').toLowerCase() || null,
    strategyKey: toText(row.strategy_key || '') || null,
    strategyName: toText(row.strategy_name || '') || null,
    selectedTpMode: toText(row.selected_tp_mode || '') || null,
    selectedOutcome: {
      outcome: normalizePolicyPathOutcome(row.selected_outcome || ''),
      pnl: Number.isFinite(toFiniteNumberOrNull(row.selected_pnl)) ? round2(toFiniteNumberOrNull(row.selected_pnl)) : null,
    },
    nearestTpOutcome: {
      outcome: normalizePolicyPathOutcome(row.nearest_outcome || ''),
      pnl: Number.isFinite(toFiniteNumberOrNull(row.nearest_pnl)) ? round2(toFiniteNumberOrNull(row.nearest_pnl)) : null,
    },
    skip1Outcome: {
      outcome: normalizePolicyPathOutcome(row.skip1_outcome || ''),
      pnl: Number.isFinite(toFiniteNumberOrNull(row.skip1_pnl)) ? round2(toFiniteNumberOrNull(row.skip1_pnl)) : null,
    },
    skip2Outcome: {
      outcome: normalizePolicyPathOutcome(row.skip2_outcome || ''),
      pnl: Number.isFinite(toFiniteNumberOrNull(row.skip2_pnl)) ? round2(toFiniteNumberOrNull(row.skip2_pnl)) : null,
    },
    confirmationTimeBucket: toText(row.confirmation_time_bucket || '') || null,
    regimeLabel: toText(row.regime_label || '') || null,
    weekday: toText(row.weekday || '') || null,
    orbRangeTicks: Number.isFinite(toFiniteNumberOrNull(row.orb_range_ticks)) ? round2(toFiniteNumberOrNull(row.orb_range_ticks)) : null,
    sourceCandlesComplete: Number(row.source_candles_complete || 0) === 1,
    simulationConfidence: Number.isFinite(toFiniteNumberOrNull(row.simulation_confidence))
      ? round2(toFiniteNumberOrNull(row.simulation_confidence))
      : null,
    policyComparisonLabel: toText(summary?.extensionPolicy?.comparisonLabel || '') || null,
    diagnostics: summary?.diagnostics && typeof summary.diagnostics === 'object'
      ? { ...summary.diagnostics }
      : {},
    extensionGate: summary?.extensionGate && typeof summary.extensionGate === 'object'
      ? { ...summary.extensionGate }
      : null,
    baselineDecision,
    extensionPolicyDecision,
    hard1200Replay,
    noCutoffReplay,
    tpReplayComparison,
    broadReplayReference,
    broaderReplayWouldTrade: broadReplayReference?.wouldTrade === true,
    replayWouldHaveTradedButPolicyRejected,
    policyReplayClassification,
    baselinePolicyAlignment,
    v2ComparisonClassification,
    v3ComparisonClassification,
    v4ComparisonClassification,
    v5ComparisonClassification,
    v1Reference,
    v2Reference,
    v3Reference,
    v4Reference,
    policyReplayStatusLine,
    baseline: summary?.baseline && typeof summary.baseline === 'object'
      ? { ...summary.baseline }
      : baselineDecision,
    extensionPolicy: summary?.extensionPolicy && typeof summary.extensionPolicy === 'object'
      ? { ...summary.extensionPolicy }
      : extensionPolicyDecision,
    hard1200: summary?.hard1200 && typeof summary.hard1200 === 'object'
      ? { ...summary.hard1200 }
      : hard1200Replay,
    noCutoff: summary?.noCutoff && typeof summary.noCutoff === 'object'
      ? { ...summary.noCutoff }
      : noCutoffReplay,
    externalTopstepOutcomeIfAvailable,
    jarvisVsTopstepMatchStatus: buildJarvisVsTopstepMatchStatus({
      didJarvisTakeTrade: Number(row.extension_would_trade || 0) === 1,
      selectedPathOutcome: row.selected_outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      externalTopstepOutcome: externalTopstepOutcomeIfAvailable,
    }),
    summaryJson: summary,
  };
}

function getLateEntryPolicyExperimentForDate(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const tradeDate = normalizeDate(options.tradeDate || options.date || '');
  if (!tradeDate) return null;
  const sourceType = normalizeSourceType(options.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(options.reconstructionPhase, sourceType);
  const policyKey = toText(options.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const policyVersion = toText(options.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION;
  let row = db.prepare(`
    SELECT *
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND policy_version = ?
      AND source_type = ?
      AND reconstruction_phase = ?
    LIMIT 1
  `).get(
    tradeDate,
    policyKey,
    policyVersion,
    sourceType,
    reconstructionPhase
  ) || null;
  if (!row) {
    row = db.prepare(`
      SELECT *
      FROM late_entry_policy_experiment_daily
      WHERE trade_date = ?
        AND policy_key = ?
        AND policy_version = ?
      ORDER BY
        CASE WHEN source_type = 'live' AND reconstruction_phase = 'live_intraday' THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `).get(
      tradeDate,
      policyKey,
      policyVersion
    ) || null;
  }
  if (!row) return null;
  row.__db = db;
  const out = formatLateEntryPolicyExperimentRow(row);
  delete row.__db;
  return out;
}

function listLateEntryPolicyExperimentRows(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  ensureRecommendationOutcomeSchema(db);
  const policyKey = toText(options.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const policyVersion = toText(options.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION;
  const source = toText(options.source || options.sourceType || 'all').toLowerCase();
  const sourceFilter = source === SOURCE_BACKFILL || source === SOURCE_LIVE
    ? source
    : null;
  const reconstructionPhaseRaw = toText(options.reconstructionPhase || '').toLowerCase();
  const reconstructionPhase = reconstructionPhaseRaw === 'mixed' ? '' : reconstructionPhaseRaw;
  const limit = Math.max(1, Math.min(5000, Number(options.limit || options.maxRows || 2500)));
  const where = [
    'policy_key = ?',
    'policy_version = ?',
  ];
  const params = [policyKey, policyVersion];
  if (sourceFilter) {
    where.push('source_type = ?');
    params.push(sourceFilter);
  }
  if (reconstructionPhase) {
    where.push('reconstruction_phase = ?');
    params.push(reconstructionPhase);
  }
  params.push(limit);
  const rows = db.prepare(`
    SELECT *
    FROM late_entry_policy_experiment_daily
    WHERE ${where.join(' AND ')}
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(...params);
  return Array.isArray(rows) ? rows : [];
}

function computePnLStatsFromSeries(series = []) {
  const rows = Array.isArray(series) ? series.filter(Boolean) : [];
  const out = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRatePct: null,
    totalPnl: 0,
    averagePnl: null,
    profitFactor: null,
    maxDrawdown: 0,
    bestDay: null,
    worstDay: null,
    tradesAfter1100: 0,
  };
  let grossProfit = 0;
  let grossLoss = 0;
  let runningEquity = 0;
  let peakEquity = 0;
  for (const row of rows) {
    const pnl = Number.isFinite(toFiniteNumberOrNull(row.pnl)) ? round2(toFiniteNumberOrNull(row.pnl)) : null;
    const outcome = normalizePolicyPathOutcome(row.outcome || '');
    if (outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE || !Number.isFinite(pnl)) continue;
    out.totalTrades += 1;
    out.totalPnl = round2(out.totalPnl + pnl);
    if (outcome === 'win') out.wins += 1;
    else if (outcome === 'loss') out.losses += 1;
    else out.breakeven += 1;
    if (pnl > 0) grossProfit += pnl;
    else if (pnl < 0) grossLoss += Math.abs(pnl);
    if (row.after1100 === true) out.tradesAfter1100 += 1;
    runningEquity += pnl;
    peakEquity = Math.max(peakEquity, runningEquity);
    out.maxDrawdown = round2(Math.max(out.maxDrawdown, peakEquity - runningEquity));
    if (!out.bestDay || pnl > Number(out.bestDay.pnl || Number.NEGATIVE_INFINITY)) {
      out.bestDay = {
        tradeDate: normalizeDate(row.tradeDate || ''),
        pnl: round2(pnl),
      };
    }
    if (!out.worstDay || pnl < Number(out.worstDay.pnl || Number.POSITIVE_INFINITY)) {
      out.worstDay = {
        tradeDate: normalizeDate(row.tradeDate || ''),
        pnl: round2(pnl),
      };
    }
  }
  const judgedTrades = out.wins + out.losses;
  out.winRatePct = judgedTrades > 0 ? round2((out.wins / judgedTrades) * 100) : null;
  out.averagePnl = out.totalTrades > 0 ? round2(out.totalPnl / out.totalTrades) : null;
  out.profitFactor = grossLoss > 0
    ? round2(grossProfit / grossLoss)
    : (grossProfit > 0 ? null : null);
  out.totalPnl = round2(out.totalPnl);
  return out;
}

const LATE_ENTRY_COMMON_DATE_LANE_KEYS = Object.freeze([
  'baseline_1100',
  'v1',
  'v2',
  'v3',
  'v4',
  'v5',
  'hard_1200',
  'no_cutoff',
  'broad_replay_reference',
]);

const LATE_ENTRY_V4_MISSING_AUDIT_TARGET_DATES = Object.freeze([
  '2026-03-07',
  '2026-03-14',
  '2026-03-15',
]);

const LATE_ENTRY_V1_V4_MISSED_SKIP_ENUM = Object.freeze([
  'good_skip',
  'bad_skip',
  'ambiguous_skip',
]);

function classifyLateEntryV1V4SkippedTrade(outcome = '') {
  const normalized = normalizePolicyPathOutcome(outcome || '');
  if (normalized === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) return 'bad_skip';
  if (normalized === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) return 'good_skip';
  return 'ambiguous_skip';
}

function normalizeLateEntryAuditDateList(input = []) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(input) ? input : [])) {
    const date = normalizeDate(raw);
    if (!date || seen.has(date)) continue;
    seen.add(date);
    out.push(date);
  }
  out.sort((a, b) => String(a).localeCompare(String(b)));
  return out;
}

function summarizeLateEntryCategoryStats(rows = [], keyAccessor = null) {
  const grouped = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const keyRaw = typeof keyAccessor === 'function' ? keyAccessor(row) : 'unknown';
    const key = toText(keyRaw || '').trim() || 'unknown';
    const pnl = Number.isFinite(toFiniteNumberOrNull(row?.replayPnl))
      ? round2(toFiniteNumberOrNull(row.replayPnl))
      : null;
    const outcome = normalizePolicyPathOutcome(row?.replayOutcome || '');
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        count: 0,
        wins: 0,
        losses: 0,
        ambiguous: 0,
        totalPnl: 0,
      });
    }
    const bucket = grouped.get(key);
    bucket.count += 1;
    if (outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) bucket.wins += 1;
    else if (outcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) bucket.losses += 1;
    else bucket.ambiguous += 1;
    if (Number.isFinite(pnl)) bucket.totalPnl = round2(bucket.totalPnl + pnl);
  }
  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      avgPnl: row.count > 0 ? round2(row.totalPnl / row.count) : null,
    }))
    .sort((a, b) => (
      Number(b.totalPnl || 0) - Number(a.totalPnl || 0)
      || Number(b.count || 0) - Number(a.count || 0)
      || String(a.key || '').localeCompare(String(b.key || ''))
    ));
}

function parseLateEntrySummaryJson(summaryJson = '{}') {
  const raw = toText(summaryJson || '{}');
  try {
    const parsed = JSON.parse(raw);
    return {
      parsed: parsed && typeof parsed === 'object' ? parsed : {},
      malformed: false,
    };
  } catch {
    return {
      parsed: {},
      malformed: true,
    };
  }
}

function buildLateEntryLanePoint(formattedRow = null, laneKey = '') {
  if (!formattedRow || typeof formattedRow !== 'object') return null;
  const tradeDate = normalizeDate(formattedRow.tradeDate || '');
  if (!tradeDate) return null;
  const getAfter1100 = (timeText = '') => {
    const minute = minuteFromTimestamp(timeText);
    return Number.isFinite(minute) && minute >= 660;
  };
  if (laneKey === 'v1' || laneKey === 'v2' || laneKey === 'v3' || laneKey === 'v4' || laneKey === 'v5') {
    return {
      tradeDate,
      outcome: normalizePolicyPathOutcome(formattedRow?.selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE),
      pnl: Number.isFinite(toFiniteNumberOrNull(formattedRow?.selectedOutcome?.pnl))
        ? round2(toFiniteNumberOrNull(formattedRow.selectedOutcome.pnl))
        : null,
      after1100: getAfter1100(
        formattedRow?.extensionPolicyDecision?.entryTime
        || formattedRow?.entryTimestamp
        || ''
      ),
    };
  }
  if (laneKey === 'baseline_1100') {
    const baselineMode = formattedRow?.baseline?.modeOutcomes && typeof formattedRow.baseline.modeOutcomes === 'object'
      ? formattedRow.baseline.modeOutcomes
      : {};
    const skip2 = baselineMode?.skip2 || makeNoTradeModeOutcome();
    return {
      tradeDate,
      outcome: normalizePolicyPathOutcome(skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE),
      pnl: Number.isFinite(toFiniteNumberOrNull(skip2?.pnl))
        ? round2(toFiniteNumberOrNull(skip2.pnl))
        : null,
      after1100: getAfter1100(
        formattedRow?.baselineDecision?.entryTime
        || formattedRow?.baseline?.entryTime
        || ''
      ),
    };
  }
  if (laneKey === 'hard_1200') {
    const modeOutcomes = formattedRow?.hard1200?.modeOutcomes && typeof formattedRow.hard1200.modeOutcomes === 'object'
      ? formattedRow.hard1200.modeOutcomes
      : (
        formattedRow?.hard1200Replay?.modeOutcomes && typeof formattedRow.hard1200Replay.modeOutcomes === 'object'
          ? formattedRow.hard1200Replay.modeOutcomes
          : {}
      );
    const skip2 = modeOutcomes?.skip2 || makeNoTradeModeOutcome();
    return {
      tradeDate,
      outcome: normalizePolicyPathOutcome(skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE),
      pnl: Number.isFinite(toFiniteNumberOrNull(skip2?.pnl))
        ? round2(toFiniteNumberOrNull(skip2.pnl))
        : null,
      after1100: getAfter1100(
        formattedRow?.hard1200Replay?.entryTime
        || formattedRow?.hard1200?.entryTime
        || ''
      ),
    };
  }
  if (laneKey === 'no_cutoff') {
    const modeOutcomes = formattedRow?.noCutoff?.modeOutcomes && typeof formattedRow.noCutoff.modeOutcomes === 'object'
      ? formattedRow.noCutoff.modeOutcomes
      : (
        formattedRow?.noCutoffReplay?.modeOutcomes && typeof formattedRow.noCutoffReplay.modeOutcomes === 'object'
          ? formattedRow.noCutoffReplay.modeOutcomes
          : {}
      );
    const skip2 = modeOutcomes?.skip2 || makeNoTradeModeOutcome();
    return {
      tradeDate,
      outcome: normalizePolicyPathOutcome(skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE),
      pnl: Number.isFinite(toFiniteNumberOrNull(skip2?.pnl))
        ? round2(toFiniteNumberOrNull(skip2.pnl))
        : null,
      after1100: getAfter1100(
        formattedRow?.noCutoffReplay?.entryTime
        || formattedRow?.noCutoff?.entryTime
        || ''
      ),
    };
  }
  if (laneKey === 'broad_replay_reference') {
    const broadRef = formattedRow?.broadReplayReference && typeof formattedRow.broadReplayReference === 'object'
      ? formattedRow.broadReplayReference
      : null;
    const modeOutcomes = broadRef?.modeOutcomes && typeof broadRef.modeOutcomes === 'object'
      ? broadRef.modeOutcomes
      : {};
    const skip2 = modeOutcomes?.skip2 || makeNoTradeModeOutcome();
    return {
      tradeDate,
      outcome: normalizePolicyPathOutcome(skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE),
      pnl: Number.isFinite(toFiniteNumberOrNull(skip2?.pnl))
        ? round2(toFiniteNumberOrNull(skip2.pnl))
        : null,
      after1100: getAfter1100(broadRef?.entryTime || ''),
    };
  }
  return null;
}

function buildLateEntryPolicyCommonDateDelta(referenceStats = null, candidateStats = null) {
  const ref = referenceStats && typeof referenceStats === 'object' ? referenceStats : {};
  const cand = candidateStats && typeof candidateStats === 'object' ? candidateStats : {};
  return {
    totalPnlDelta: (
      Number.isFinite(toFiniteNumberOrNull(cand?.totalPnl))
      && Number.isFinite(toFiniteNumberOrNull(ref?.totalPnl))
    )
      ? round2(toFiniteNumberOrNull(cand.totalPnl) - toFiniteNumberOrNull(ref.totalPnl))
      : null,
    winRateDeltaPct: (
      Number.isFinite(toFiniteNumberOrNull(cand?.winRatePct))
      && Number.isFinite(toFiniteNumberOrNull(ref?.winRatePct))
    )
      ? round2(toFiniteNumberOrNull(cand.winRatePct) - toFiniteNumberOrNull(ref.winRatePct))
      : null,
    profitFactorDelta: (
      Number.isFinite(toFiniteNumberOrNull(cand?.profitFactor))
      && Number.isFinite(toFiniteNumberOrNull(ref?.profitFactor))
    )
      ? round2(toFiniteNumberOrNull(cand.profitFactor) - toFiniteNumberOrNull(ref.profitFactor))
      : null,
    maxDrawdownDelta: (
      Number.isFinite(toFiniteNumberOrNull(cand?.maxDrawdown))
      && Number.isFinite(toFiniteNumberOrNull(ref?.maxDrawdown))
    )
      ? round2(toFiniteNumberOrNull(cand.maxDrawdown) - toFiniteNumberOrNull(ref.maxDrawdown))
      : null,
    tradesDelta: Number(cand?.totalTrades || 0) - Number(ref?.totalTrades || 0),
  };
}

function buildLateEntryV4MissingDateAudit(db, options = {}) {
  const sourceType = normalizeSourceType(options.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(options.reconstructionPhase, sourceType);
  const laneDateSets = options.laneDateSets && typeof options.laneDateSets === 'object'
    ? options.laneDateSets
    : {};
  const policyFormattedByDate = options.policyFormattedByDate && typeof options.policyFormattedByDate === 'object'
    ? options.policyFormattedByDate
    : {};
  const missingAuditDates = normalizeLateEntryAuditDateList(
    Array.isArray(options.missingAuditDates) && options.missingAuditDates.length > 0
      ? options.missingAuditDates
      : LATE_ENTRY_V4_MISSING_AUDIT_TARGET_DATES
  );
  const rows = [];
  if (!db || typeof db.prepare !== 'function' || missingAuditDates.length === 0) {
    return {
      targetDates: missingAuditDates,
      rowCount: 0,
      rows,
      missingV4DateCount: 0,
      summaryLine: 'V4 missing-date audit unavailable.',
      advisoryOnly: true,
    };
  }
  const scopedV4Stmt = db.prepare(`
    SELECT *
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND policy_version = ?
      AND source_type = ?
      AND reconstruction_phase = ?
    LIMIT 1
  `);
  const anyScopeV4Stmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM late_entry_policy_experiment_daily
    WHERE trade_date = ?
      AND policy_key = ?
      AND policy_version = ?
  `);
  const contextExistsStmt = tableExists(db, 'jarvis_recommendation_context')
    ? db.prepare(`SELECT 1 AS ok FROM jarvis_recommendation_context WHERE rec_date = ? LIMIT 1`)
    : null;
  const sessionInfoStmt = tableExists(db, 'sessions')
    ? db.prepare(`
      SELECT id, candle_count, orb_range_ticks
      FROM sessions
      WHERE date = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    : null;
  const sessionCandleCountStmt = (
    tableExists(db, 'sessions')
    && tableExists(db, 'candles')
  )
    ? db.prepare(`
      SELECT COUNT(c.id) AS c
      FROM sessions s
      LEFT JOIN candles c ON c.session_id = s.id
      WHERE s.date = ?
    `)
    : null;

  for (const tradeDate of missingAuditDates) {
    const scopedV4Row = scopedV4Stmt.get(
      tradeDate,
      LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
      LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
      sourceType,
      reconstructionPhase
    ) || null;
    const anyScopeCount = Number(anyScopeV4Stmt.get(
      tradeDate,
      LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
      LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION
    )?.c || 0);
    const v4PresentAnyScope = anyScopeCount > 0;
    const lanePresence = {
      baseline_1100: (laneDateSets?.baseline_1100 || new Set()).has(tradeDate),
      v1: (laneDateSets?.v1 || new Set()).has(tradeDate),
      v2: (laneDateSets?.v2 || new Set()).has(tradeDate),
      v3: (laneDateSets?.v3 || new Set()).has(tradeDate),
      v4: (laneDateSets?.v4 || new Set()).has(tradeDate),
      v5: (laneDateSets?.v5 || new Set()).has(tradeDate),
      hard_1200: (laneDateSets?.hard_1200 || new Set()).has(tradeDate),
      no_cutoff: (laneDateSets?.no_cutoff || new Set()).has(tradeDate),
      broad_replay_reference: (laneDateSets?.broad_replay_reference || new Set()).has(tradeDate),
    };
    const contextExists = contextExistsStmt ? !!contextExistsStmt.get(tradeDate) : null;
    const sessionInfo = sessionInfoStmt ? (sessionInfoStmt.get(tradeDate) || null) : null;
    const sessionCandleCount = sessionCandleCountStmt
      ? Number(sessionCandleCountStmt.get(tradeDate)?.c || 0)
      : null;
    const parsedSummary = scopedV4Row
      ? parseLateEntrySummaryJson(scopedV4Row.summary_json)
      : { parsed: {}, malformed: false };
    const scopedMalformed = scopedV4Row ? parsedSummary.malformed === true : false;
    const scopedIncomplete = scopedV4Row
      ? (
        !toText(scopedV4Row?.selected_tp_mode || '')
        || !toText(scopedV4Row?.selected_outcome || '')
      )
      : false;

    let rowStatus = 'present';
    if (!scopedV4Row) {
      rowStatus = v4PresentAnyScope ? 'filtered_out_by_scope' : 'absent';
    } else if (scopedMalformed) {
      rowStatus = 'malformed';
    } else if (scopedIncomplete) {
      rowStatus = 'incomplete';
    }

    const shouldLogicallyExistInV4 = (
      lanePresence.v1
      || lanePresence.v2
      || lanePresence.v3
      || contextExists === true
    );
    const otherLanesPresent = LATE_ENTRY_COMMON_DATE_LANE_KEYS
      .filter((lane) => lane !== 'v4')
      .every((lane) => lanePresence[lane] === true);
    const shouldBeInCommonSetIfRepaired = (
      rowStatus !== 'present'
      && shouldLogicallyExistInV4
      && otherLanesPresent
    );

    let rootCauseLayer = 'none';
    let rootCause = 'none';
    if (rowStatus === 'absent') {
      if (shouldLogicallyExistInV4) {
        rootCauseLayer = 'persistence_path';
        rootCause = 'v4_row_missing_in_persistence_scope';
      } else {
        rootCauseLayer = 'build_path';
        rootCause = 'no_context_or_lane_inputs_for_date';
      }
    } else if (rowStatus === 'filtered_out_by_scope') {
      rootCauseLayer = 'summary_path';
      rootCause = 'present_outside_scope_filtered_from_comparison';
    } else if (rowStatus === 'malformed') {
      rootCauseLayer = 'summary_path';
      rootCause = 'malformed_summary_json';
    } else if (rowStatus === 'incomplete') {
      rootCauseLayer = 'summary_path';
      rootCause = 'incomplete_persisted_row';
    }

    const v1Row = policyFormattedByDate?.v1?.get(tradeDate) || null;
    const v1ReplayPnl = Number.isFinite(toFiniteNumberOrNull(v1Row?.selectedOutcome?.pnl))
      ? round2(toFiniteNumberOrNull(v1Row.selectedOutcome.pnl))
      : 0;
    const v1ReplayOutcome = normalizePolicyPathOutcome(v1Row?.selectedOutcome?.outcome || '');
    let missingnessBias = 'neutral';
    if (Number.isFinite(v1ReplayPnl) && v1ReplayPnl > 0) missingnessBias = 'favors_v4';
    else if (Number.isFinite(v1ReplayPnl) && v1ReplayPnl < 0) missingnessBias = 'favors_v1';

    rows.push({
      tradeDate,
      v4RowStatus: rowStatus,
      v4ScopedRowPresent: !!scopedV4Row,
      v4PresentAnyScope,
      v4MalformedSummary: scopedMalformed,
      v4IncompleteRow: scopedIncomplete,
      shouldLogicallyExistInV4,
      shouldBeInCommonSetIfRepaired,
      rootCauseLayer,
      rootCause,
      lanePresence,
      contextExists,
      sessionExists: !!sessionInfo,
      sessionCandleCount: Number.isFinite(sessionCandleCount) ? sessionCandleCount : null,
      sessionOrbRangeTicks: Number.isFinite(toFiniteNumberOrNull(sessionInfo?.orb_range_ticks))
        ? round2(toFiniteNumberOrNull(sessionInfo.orb_range_ticks))
        : null,
      sessionRecordedCandleCount: Number.isFinite(toFiniteNumberOrNull(sessionInfo?.candle_count))
        ? Number(toFiniteNumberOrNull(sessionInfo.candle_count))
        : null,
      v1SelectedOutcome: v1ReplayOutcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      v1SelectedPnl: Number.isFinite(v1ReplayPnl) ? v1ReplayPnl : null,
      missingnessBiasDirection: missingnessBias,
    });
  }

  const missingRows = rows.filter((row) => row.v4RowStatus !== 'present');
  const statusCounts = missingRows.reduce((acc, row) => {
    const key = toText(row.v4RowStatus || 'unknown') || 'unknown';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
  const repairableDates = rows
    .filter((row) => row.shouldBeInCommonSetIfRepaired)
    .map((row) => row.tradeDate);
  const summaryLine = missingRows.length > 0
    ? `V4 is missing ${missingRows.length} audited date(s): ${missingRows.map((row) => row.tradeDate).join(', ')}.`
    : 'V4 missing-date audit found no missing dates in the target set.';
  return {
    targetDates: missingAuditDates,
    rowCount: rows.length,
    rows,
    missingV4DateCount: missingRows.length,
    missingV4Dates: missingRows.map((row) => row.tradeDate),
    statusCounts,
    repairableCommonDateCount: repairableDates.length,
    repairableCommonDates: repairableDates,
    summaryLine,
    advisoryOnly: true,
  };
}

function buildLateEntryV4TrustIfRepaired(input = {}) {
  const coverageDiagnosticsByLane = input.coverageDiagnosticsByLane && typeof input.coverageDiagnosticsByLane === 'object'
    ? input.coverageDiagnosticsByLane
    : {};
  const commonDateCount = Number(input.commonDateCount || 0);
  const unionDateCount = Number(input.unionDateCount || 0);
  const missingDateAudit = input.missingDateAudit && typeof input.missingDateAudit === 'object'
    ? input.missingDateAudit
    : { repairableCommonDateCount: 0, missingV4DateCount: 0, missingV4Dates: [] };
  const v4Coverage = coverageDiagnosticsByLane?.v4 && typeof coverageDiagnosticsByLane.v4 === 'object'
    ? coverageDiagnosticsByLane.v4
    : {};
  const missingVsV1 = Number(v4Coverage?.missingDateCountVsV1Universe || 0);
  const repairableCount = Number(missingDateAudit?.repairableCommonDateCount || 0);
  const projectedFixCount = Math.min(Math.max(0, missingVsV1), Math.max(0, repairableCount));
  const hiddenCoverageLanes = LATE_ENTRY_COMMON_DATE_LANE_KEYS
    .filter((lane) => lane !== 'v4')
    .filter((lane) => Number(coverageDiagnosticsByLane?.[lane]?.missingDateCountVsV1Universe || 0) > 0);
  const projectedCommonDateCount = commonDateCount + projectedFixCount;
  const projectedTrustworthy = (
    missingVsV1 > 0
    && projectedFixCount === missingVsV1
    && hiddenCoverageLanes.length === 0
  );
  const reason = projectedTrustworthy
    ? 'repairing_v4_missing_dates_should_equalize_common_universe'
    : (
      hiddenCoverageLanes.length > 0
        ? 'other_lanes_still_have_coverage_mismatch'
        : (
          missingVsV1 <= 0
            ? 'no_v4_missing_dates_to_repair'
            : 'repairable_set_does_not_cover_all_missing_v4_dates'
        )
    );
  const projectedStatus = projectedTrustworthy
    ? 'trustworthy'
    : 'partially_trustworthy';
  const summaryLine = projectedTrustworthy
    ? `If v4 repairs ${projectedFixCount} missing date(s), common-date comparison should become trustworthy (${projectedCommonDateCount} shared dates).`
    : (
      missingVsV1 > 0
        ? `Even after repairing ${projectedFixCount}/${missingVsV1} v4 date(s), comparison remains partially trustworthy.`
        : 'No repair-based trust upgrade is available from the current missing-date set.'
    );
  return {
    projectedStatus,
    projectedTrustworthy,
    projectedCommonDateCount,
    currentCommonDateCount: commonDateCount,
    unionDateCount,
    missingVsV1,
    repairableCount,
    projectedFixCount,
    hiddenCoverageLanes,
    reason,
    summaryLine,
    advisoryOnly: true,
  };
}

function buildLateEntryV1VsV4MissedTradeLedger(input = {}) {
  const commonDates = Array.isArray(input.commonDates) ? input.commonDates : [];
  const policyFormattedByDate = input.policyFormattedByDate && typeof input.policyFormattedByDate === 'object'
    ? input.policyFormattedByDate
    : {};
  const v1ByDate = policyFormattedByDate?.v1 instanceof Map ? policyFormattedByDate.v1 : new Map();
  const v4ByDate = policyFormattedByDate?.v4 instanceof Map ? policyFormattedByDate.v4 : new Map();
  const rows = [];
  for (const tradeDate of commonDates) {
    const v1 = v1ByDate.get(tradeDate) || null;
    const v4 = v4ByDate.get(tradeDate) || null;
    if (!v1 || !v4) continue;
    const v1WouldTrade = (
      v1?.extensionPolicyDecision?.wouldTrade === true
      || v1?.wouldExtensionPolicyTakeTrade === true
    );
    const v4WouldTrade = (
      v4?.extensionPolicyDecision?.wouldTrade === true
      || v4?.wouldExtensionPolicyTakeTrade === true
    );
    if (!v1WouldTrade || v4WouldTrade) continue;
    const replayOutcome = normalizePolicyPathOutcome(v1?.selectedOutcome?.outcome || '');
    const replayPnl = Number.isFinite(toFiniteNumberOrNull(v1?.selectedOutcome?.pnl))
      ? round2(toFiniteNumberOrNull(v1.selectedOutcome.pnl))
      : null;
    const skippedClassification = classifyLateEntryV1V4SkippedTrade(replayOutcome);
    const v4ReasonCodes = Array.isArray(v4?.extensionReasonCodes)
      ? v4.extensionReasonCodes
      : (
        Array.isArray(v4?.extensionPolicyDecision?.reasonCodes)
          ? v4.extensionPolicyDecision.reasonCodes
          : []
      );
    rows.push({
      tradeDate,
      weekday: toText(v1?.weekday || v4?.weekday || '') || 'unknown',
      regimeLabel: toText(v1?.regimeLabel || v4?.regimeLabel || '') || 'unknown',
      confirmationTimeBucket: toText(v1?.confirmationTimeBucket || v4?.confirmationTimeBucket || '') || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN,
      selectedTpMode: toText(v1?.selectedTpMode || v4?.selectedTpMode || '') || 'unknown',
      replayOutcome: replayOutcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      replayPnl,
      breakoutToRetestDelayMinutes: Number.isFinite(toFiniteNumberOrNull(
        v4?.diagnostics?.breakoutToRetestDelayMinutes ?? v1?.diagnostics?.breakoutToRetestDelayMinutes
      ))
        ? round2(toFiniteNumberOrNull(
          v4?.diagnostics?.breakoutToRetestDelayMinutes ?? v1?.diagnostics?.breakoutToRetestDelayMinutes
        ))
        : null,
      retestToConfirmationDelayMinutes: Number.isFinite(toFiniteNumberOrNull(
        v4?.diagnostics?.retestToConfirmationDelayMinutes ?? v1?.diagnostics?.retestToConfirmationDelayMinutes
      ))
        ? round2(toFiniteNumberOrNull(
          v4?.diagnostics?.retestToConfirmationDelayMinutes ?? v1?.diagnostics?.retestToConfirmationDelayMinutes
        ))
        : null,
      confirmationDistanceBeyondBreakoutClose: Number.isFinite(toFiniteNumberOrNull(
        v4?.diagnostics?.confirmationDistanceBeyondBreakoutClose ?? v1?.diagnostics?.confirmationDistanceBeyondBreakoutClose
      ))
        ? round2(toFiniteNumberOrNull(
          v4?.diagnostics?.confirmationDistanceBeyondBreakoutClose ?? v1?.diagnostics?.confirmationDistanceBeyondBreakoutClose
        ))
        : null,
      invalidationBeforeConfirmation: (
        v4?.extensionGate?.supportingMetrics?.invalidationBeforeConfirmation === true
        || v1?.extensionGate?.supportingMetrics?.invalidationBeforeConfirmation === true
      ),
      v4DecisionReason: toText(v4?.extensionDecisionReason || v4?.extensionPolicyDecision?.decisionReason || '') || null,
      v4ReasonCodes,
      skipClassification: skippedClassification,
    });
  }
  rows.sort((a, b) => String(a.tradeDate || '').localeCompare(String(b.tradeDate || '')));
  const totals = {
    missedTradeCount: rows.length,
    badSkips: 0,
    goodSkips: 0,
    ambiguousSkips: 0,
    badSkipTotalPnl: 0,
    goodSkipTotalPnl: 0,
    ambiguousSkipTotalPnl: 0,
    goodSkipLossAvoided: 0,
  };
  for (const row of rows) {
    const pnl = Number.isFinite(toFiniteNumberOrNull(row.replayPnl))
      ? round2(toFiniteNumberOrNull(row.replayPnl))
      : 0;
    if (row.skipClassification === 'bad_skip') {
      totals.badSkips += 1;
      totals.badSkipTotalPnl = round2(totals.badSkipTotalPnl + pnl);
    } else if (row.skipClassification === 'good_skip') {
      totals.goodSkips += 1;
      totals.goodSkipTotalPnl = round2(totals.goodSkipTotalPnl + pnl);
      totals.goodSkipLossAvoided = round2(totals.goodSkipLossAvoided + Math.abs(Math.min(0, pnl)));
    } else {
      totals.ambiguousSkips += 1;
      totals.ambiguousSkipTotalPnl = round2(totals.ambiguousSkipTotalPnl + pnl);
    }
  }
  const byWeekday = summarizeLateEntryCategoryStats(rows, (row) => row.weekday);
  const byTimeBucket = summarizeLateEntryCategoryStats(rows, (row) => row.confirmationTimeBucket);
  const byRegime = summarizeLateEntryCategoryStats(rows, (row) => row.regimeLabel);
  const byTpMode = summarizeLateEntryCategoryStats(rows, (row) => row.selectedTpMode);
  const byCompositeCluster = summarizeLateEntryCategoryStats(rows, (row) => (
    `${toText(row.weekday || 'unknown') || 'unknown'}|${toText(row.confirmationTimeBucket || 'unknown') || 'unknown'}|${toText(row.regimeLabel || 'unknown') || 'unknown'}|${toText(row.selectedTpMode || 'unknown') || 'unknown'}`
  ));
  const topProfitableMissedClusters = byCompositeCluster
    .filter((row) => Number(row.totalPnl || 0) > 0)
    .slice(0, 5);
  const topUnprofitableSkippedClusters = byCompositeCluster
    .filter((row) => Number(row.totalPnl || 0) < 0)
    .slice(0, 5);
  let gapVerdict = 'mixed_skips';
  if (totals.missedTradeCount === 0) {
    gapVerdict = 'no_v1_over_v4_gap_in_common_scope';
  } else if (totals.badSkipTotalPnl > (totals.goodSkipLossAvoided + 25)) {
    gapVerdict = 'too_tight';
  } else if (totals.goodSkipLossAvoided > (totals.badSkipTotalPnl + 25)) {
    gapVerdict = 'correctly_tight';
  }
  const summaryLine = totals.missedTradeCount > 0
    ? `Strict common-date v1-over-v4 missed trades: ${totals.missedTradeCount} (bad skips ${totals.badSkips}, good skips ${totals.goodSkips}, ambiguous ${totals.ambiguousSkips}).`
    : 'Strict common-date v1-over-v4 missed trades: none.';
  return {
    strictCommonDateScopeApplied: true,
    strictCommonDateCount: commonDates.length,
    rows,
    totals,
    byWeekday,
    byTimeBucket,
    byRegime,
    byTpMode,
    byCompositeCluster,
    topProfitableMissedClusters,
    topUnprofitableSkippedClusters,
    dominantProfitableMissedCluster: topProfitableMissedClusters[0] || null,
    dominantUnprofitableMissedCluster: topUnprofitableSkippedClusters[0] || null,
    gapVerdict,
    summaryLine,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyCommonDateComparison(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const source = toText(options.sourceType || options.source || SOURCE_LIVE).toLowerCase();
  const sourceFilter = source === SOURCE_BACKFILL || source === SOURCE_LIVE ? source : SOURCE_LIVE;
  const reconstructionPhase = normalizeReconstructionPhase(
    options.reconstructionPhase || PHASE_LIVE_INTRADAY,
    sourceFilter
  );
  const maxRows = Math.max(1, Math.min(10000, Number(options.maxRows || 5000)));
  const targetDate = normalizeDate(options.targetDate || options.date || '');
  const missingPreviewLimit = Math.max(1, Math.min(50, Number(options.missingPreviewLimit || 25)));

  const lanePolicyConfigs = [
    { lane: 'v1', policyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY, policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION },
    { lane: 'v2', policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY, policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION },
    { lane: 'v3', policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY, policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION },
    { lane: 'v4', policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY, policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION },
    { lane: 'v5', policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY, policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION },
  ];
  const laneSeries = {};
  const laneDateSets = {};
  const policyFormattedByDate = {};
  for (const lane of LATE_ENTRY_COMMON_DATE_LANE_KEYS) {
    laneSeries[lane] = [];
    laneDateSets[lane] = new Set();
  }

  for (const config of lanePolicyConfigs) {
    const rawRows = listLateEntryPolicyExperimentRows(db, {
      policyKey: config.policyKey,
      policyVersion: config.policyVersion,
      source: sourceFilter,
      reconstructionPhase,
      maxRows,
    });
    const byDate = new Map();
    for (const rawRow of rawRows) {
      if (!rawRow || typeof rawRow !== 'object') continue;
      rawRow.__db = db;
      const formatted = formatLateEntryPolicyExperimentRow(rawRow);
      delete rawRow.__db;
      const date = normalizeDate(formatted?.tradeDate || '');
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, formatted);
    }
    policyFormattedByDate[config.lane] = byDate;
    for (const [date, formatted] of byDate.entries()) {
      const lanePoint = buildLateEntryLanePoint(formatted, config.lane);
      if (lanePoint) {
        laneSeries[config.lane].push(lanePoint);
        laneDateSets[config.lane].add(date);
      }
    }
  }

  const v1ByDate = policyFormattedByDate.v1 || new Map();
  for (const [date, formatted] of v1ByDate.entries()) {
    for (const laneKey of ['baseline_1100', 'hard_1200', 'no_cutoff', 'broad_replay_reference']) {
      const lanePoint = buildLateEntryLanePoint(formatted, laneKey);
      if (!lanePoint) continue;
      laneSeries[laneKey].push(lanePoint);
      laneDateSets[laneKey].add(date);
    }
  }

  for (const laneKey of Object.keys(laneSeries)) {
    laneSeries[laneKey].sort((a, b) => String(a.tradeDate || '').localeCompare(String(b.tradeDate || '')));
  }

  const unionDateSet = new Set();
  for (const laneKey of LATE_ENTRY_COMMON_DATE_LANE_KEYS) {
    for (const date of laneDateSets[laneKey]) unionDateSet.add(date);
  }
  const unionDates = Array.from(unionDateSet).sort((a, b) => String(a).localeCompare(String(b)));
  const commonDates = unionDates.filter((date) => (
    LATE_ENTRY_COMMON_DATE_LANE_KEYS.every((laneKey) => laneDateSets[laneKey].has(date))
  ));
  const commonDateSet = new Set(commonDates);

  const baselineUniverseSet = laneDateSets.baseline_1100 || new Set();
  const v1UniverseSet = laneDateSets.v1 || new Set();
  const v4UniverseSet = laneDateSets.v4 || new Set();

  const rawTrackedSummaryByLane = {};
  const strictCommonDateSummaryByLane = {};
  const coverageDiagnosticsByLane = {};
  for (const laneKey of LATE_ENTRY_COMMON_DATE_LANE_KEYS) {
    const laneRows = laneSeries[laneKey];
    const laneDateSet = laneDateSets[laneKey];
    const commonRows = laneRows.filter((row) => commonDateSet.has(normalizeDate(row.tradeDate || '')));
    const rawStats = computePnLStatsFromSeries(laneRows);
    const commonStats = computePnLStatsFromSeries(commonRows);
    rawTrackedSummaryByLane[laneKey] = {
      trackedDays: laneDateSet.size,
      firstDate: laneRows[0]?.tradeDate || null,
      lastDate: laneRows[laneRows.length - 1]?.tradeDate || null,
      stats: rawStats,
    };
    strictCommonDateSummaryByLane[laneKey] = {
      commonDateCount: commonRows.length,
      firstDate: commonRows[0]?.tradeDate || null,
      lastDate: commonRows[commonRows.length - 1]?.tradeDate || null,
      stats: commonStats,
    };
    const missingVsCommon = commonDates.filter((date) => !laneDateSet.has(date));
    const missingVsBaseline = Array.from(baselineUniverseSet).filter((date) => !laneDateSet.has(date)).sort((a, b) => String(a).localeCompare(String(b)));
    const missingVsV1 = Array.from(v1UniverseSet).filter((date) => !laneDateSet.has(date)).sort((a, b) => String(a).localeCompare(String(b)));
    const missingVsV4 = Array.from(v4UniverseSet).filter((date) => !laneDateSet.has(date)).sort((a, b) => String(a).localeCompare(String(b)));
    coverageDiagnosticsByLane[laneKey] = {
      trackedDays: laneDateSet.size,
      commonDateCount: commonDates.length,
      missingDateCountVsCommon: missingVsCommon.length,
      firstDate: laneRows[0]?.tradeDate || null,
      lastDate: laneRows[laneRows.length - 1]?.tradeDate || null,
      coveragePct: unionDates.length > 0 ? round2((laneDateSet.size / unionDates.length) * 100) : null,
      missingDateCountVsBaselineUniverse: missingVsBaseline.length,
      missingDateCountVsV1Universe: missingVsV1.length,
      missingDateCountVsV4Universe: missingVsV4.length,
      missingDatesVsBaselineUniverse: missingVsBaseline.slice(0, missingPreviewLimit),
      missingDatesVsV1Universe: missingVsV1.slice(0, missingPreviewLimit),
      missingDatesVsV4Universe: missingVsV4.slice(0, missingPreviewLimit),
    };
  }

  const metricRanking = (metricKey, direction = 'desc') => {
    const ranked = LATE_ENTRY_COMMON_DATE_LANE_KEYS.map((laneKey) => ({
      laneKey,
      value: toFiniteNumberOrNull(strictCommonDateSummaryByLane?.[laneKey]?.stats?.[metricKey]),
    })).sort((a, b) => {
      const av = Number.isFinite(a.value) ? a.value : (direction === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
      const bv = Number.isFinite(b.value) ? b.value : (direction === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
      return direction === 'desc' ? (bv - av) : (av - bv);
    });
    return ranked.map((row, idx) => ({
      rank: idx + 1,
      laneKey: row.laneKey,
      value: row.value,
    }));
  };

  const commonDatePolicyRanking = {
    byTotalPnl: metricRanking('totalPnl', 'desc'),
    byWinRatePct: metricRanking('winRatePct', 'desc'),
    byProfitFactor: metricRanking('profitFactor', 'desc'),
    byMaxDrawdown: metricRanking('maxDrawdown', 'asc'),
    byAveragePnl: metricRanking('averagePnl', 'desc'),
    byTotalTrades: metricRanking('totalTrades', 'desc'),
  };

  const commonDateDeltas = {
    v5_vs_v4: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v4?.stats,
      strictCommonDateSummaryByLane?.v5?.stats
    ),
    v5_vs_v3: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v3?.stats,
      strictCommonDateSummaryByLane?.v5?.stats
    ),
    v5_vs_v2: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v2?.stats,
      strictCommonDateSummaryByLane?.v5?.stats
    ),
    v5_vs_v1: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v1?.stats,
      strictCommonDateSummaryByLane?.v5?.stats
    ),
    v4_vs_v3: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v3?.stats,
      strictCommonDateSummaryByLane?.v4?.stats
    ),
    v4_vs_v2: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v2?.stats,
      strictCommonDateSummaryByLane?.v4?.stats
    ),
    v4_vs_v1: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v1?.stats,
      strictCommonDateSummaryByLane?.v4?.stats
    ),
    v3_vs_v2: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v2?.stats,
      strictCommonDateSummaryByLane?.v3?.stats
    ),
    v2_vs_v1: buildLateEntryPolicyCommonDateDelta(
      strictCommonDateSummaryByLane?.v1?.stats,
      strictCommonDateSummaryByLane?.v2?.stats
    ),
  };

  const coverageValues = LATE_ENTRY_COMMON_DATE_LANE_KEYS
    .map((laneKey) => toFiniteNumberOrNull(coverageDiagnosticsByLane?.[laneKey]?.coveragePct))
    .filter((n) => Number.isFinite(n));
  const minCoveragePct = coverageValues.length > 0 ? round2(Math.min(...coverageValues)) : null;
  const allTrackedEqual = LATE_ENTRY_COMMON_DATE_LANE_KEYS.every((laneKey) => (
    Number(coverageDiagnosticsByLane?.[laneKey]?.trackedDays || 0)
    === Number(coverageDiagnosticsByLane?.v1?.trackedDays || 0)
  ));
  const trustReasons = [];
  let trustStatus = 'not_trustworthy';
  if (commonDates.length === 0) {
    trustReasons.push('no_common_dates');
  } else if (allTrackedEqual && minCoveragePct === 100) {
    trustStatus = 'trustworthy';
    trustReasons.push('all_lanes_share_identical_date_universe');
  } else if (Number.isFinite(minCoveragePct) && minCoveragePct >= 95 && commonDates.length >= 30) {
    trustStatus = 'partially_trustworthy';
    trustReasons.push('high_but_not_identical_coverage');
  } else {
    trustStatus = 'not_trustworthy';
    trustReasons.push('date_universe_mismatch');
  }

  const summaryLine = (
    trustStatus === 'trustworthy'
      ? `Late-entry common-date comparison is trustworthy across ${commonDates.length} shared dates.`
      : (
        trustStatus === 'partially_trustworthy'
          ? `Late-entry common-date comparison is partially trustworthy (${commonDates.length} shared dates, min coverage ${Number.isFinite(minCoveragePct) ? `${minCoveragePct}%` : 'N/A'}).`
          : `Late-entry common-date comparison is not trustworthy yet (${commonDates.length} shared dates, min coverage ${Number.isFinite(minCoveragePct) ? `${minCoveragePct}%` : 'N/A'}).`
      )
  );
  const missingDateAudit = buildLateEntryV4MissingDateAudit(db, {
    sourceType: sourceFilter,
    reconstructionPhase,
    laneDateSets,
    policyFormattedByDate,
    missingAuditDates: options.missingAuditDates,
  });
  const trustIfV4MissingDatesRepaired = buildLateEntryV4TrustIfRepaired({
    coverageDiagnosticsByLane,
    missingDateAudit,
    commonDateCount: commonDates.length,
    unionDateCount: unionDates.length,
  });
  const v1VsV4MissedTradeLedger = buildLateEntryV1VsV4MissedTradeLedger({
    commonDates,
    policyFormattedByDate,
  });

  return {
    sourceType: sourceFilter,
    reconstructionPhase,
    laneKeys: [...LATE_ENTRY_COMMON_DATE_LANE_KEYS],
    rawTrackedSummaryByLane,
    strictCommonDateSummaryByLane,
    coverageDiagnosticsByLane,
    commonDateDeltas,
    commonDatePolicyRanking,
    unionDateCount: unionDates.length,
    commonDateCount: commonDates.length,
    commonDateFirst: commonDates[0] || null,
    commonDateLast: commonDates[commonDates.length - 1] || null,
    commonDateSampleStart: commonDates.slice(0, 10),
    commonDateSampleEnd: commonDates.slice(-10),
    targetDate,
    targetDateInCommonDateUniverse: targetDate ? commonDateSet.has(targetDate) : null,
    v4MissingDateAudit: missingDateAudit,
    v4MissingDateAuditLine: toText(missingDateAudit?.summaryLine || '') || 'V4 missing-date audit unavailable.',
    trustIfV4MissingDatesRepaired,
    trustIfV4MissingDatesRepairedLine: toText(trustIfV4MissingDatesRepaired?.summaryLine || '')
      || 'Trust-repair projection unavailable.',
    v1VsV4MissedTradeLedger,
    v1VsV4GapLine: toText(v1VsV4MissedTradeLedger?.summaryLine || '')
      || 'V1-v4 strict gap ledger unavailable.',
    v1VsV4GapVerdict: toText(v1VsV4MissedTradeLedger?.gapVerdict || '') || 'unknown',
    trustworthiness: {
      status: trustStatus,
      reasons: trustReasons,
      minCoveragePct,
      allTrackedEqual,
      commonDateCount: commonDates.length,
      unionDateCount: unionDates.length,
    },
    summaryLine,
    advisoryOnly: true,
  };
}

function getLateEntryPolicyConfigByLane(laneKey = '') {
  const lane = toText(laneKey || '').toLowerCase();
  if (lane === 'v1') {
    return {
      lane: 'v1',
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    };
  }
  if (lane === 'v2') {
    return {
      lane: 'v2',
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    };
  }
  if (lane === 'v3') {
    return {
      lane: 'v3',
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    };
  }
  if (lane === 'v4') {
    return {
      lane: 'v4',
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    };
  }
  if (lane === 'v5') {
    return {
      lane: 'v5',
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    };
  }
  return null;
}

function getLateEntryLaneRank(rankedRows = [], laneKey = '') {
  if (!Array.isArray(rankedRows)) return null;
  const target = toText(laneKey || '').toLowerCase();
  const row = rankedRows.find((entry) => toText(entry?.laneKey || '').toLowerCase() === target);
  return Number.isFinite(toFiniteNumberOrNull(row?.rank)) ? Number(toFiniteNumberOrNull(row.rank)) : null;
}

function buildLateEntryShadowLeader(input = {}) {
  const commonDateComparison = input?.commonDateComparison && typeof input.commonDateComparison === 'object'
    ? input.commonDateComparison
    : null;
  if (!commonDateComparison) return null;
  const ranking = commonDateComparison?.commonDatePolicyRanking && typeof commonDateComparison.commonDatePolicyRanking === 'object'
    ? commonDateComparison.commonDatePolicyRanking
    : {};
  const strictSummaryByLane = commonDateComparison?.strictCommonDateSummaryByLane
    && typeof commonDateComparison.strictCommonDateSummaryByLane === 'object'
    ? commonDateComparison.strictCommonDateSummaryByLane
    : {};
  const trustStatus = toText(commonDateComparison?.trustworthiness?.status || '').toLowerCase() || 'not_trustworthy';
  const candidateLanes = ['v1', 'v2', 'v3', 'v4', 'v5'];
  const pnlRanking = Array.isArray(ranking?.byTotalPnl) ? ranking.byTotalPnl : [];
  const leaderRankingRow = pnlRanking.find((row) => candidateLanes.includes(toText(row?.laneKey || '').toLowerCase())) || null;
  const leaderLane = toText(leaderRankingRow?.laneKey || '').toLowerCase() || null;
  const leaderPolicy = getLateEntryPolicyConfigByLane(leaderLane);
  const statsByLane = {};
  for (const lane of ['baseline_1100', ...candidateLanes]) {
    statsByLane[lane] = strictSummaryByLane?.[lane]?.stats && typeof strictSummaryByLane[lane].stats === 'object'
      ? strictSummaryByLane[lane].stats
      : {};
  }
  const leaderTotalPnl = Number.isFinite(toFiniteNumberOrNull(statsByLane?.[leaderLane]?.totalPnl))
    ? round2(toFiniteNumberOrNull(statsByLane[leaderLane].totalPnl))
    : null;
  const beatsByPnl = {};
  for (const lane of ['baseline_1100', 'v1', 'v2', 'v3', 'v4']) {
    const lanePnl = Number.isFinite(toFiniteNumberOrNull(statsByLane?.[lane]?.totalPnl))
      ? round2(toFiniteNumberOrNull(statsByLane[lane].totalPnl))
      : null;
    beatsByPnl[lane] = (
      Number.isFinite(leaderTotalPnl)
      && Number.isFinite(lanePnl)
      && leaderTotalPnl > lanePnl
    );
  }
  const totalPnlRank = getLateEntryLaneRank(ranking?.byTotalPnl, leaderLane);
  const winRateRank = getLateEntryLaneRank(ranking?.byWinRatePct, leaderLane);
  const profitFactorRank = getLateEntryLaneRank(ranking?.byProfitFactor, leaderLane);
  const maxDrawdownRank = getLateEntryLaneRank(ranking?.byMaxDrawdown, leaderLane);
  const leadsAllPrimaryMetrics = (
    totalPnlRank === 1
    && winRateRank === 1
    && profitFactorRank === 1
    && maxDrawdownRank === 1
  );
  const commonDateCount = Number(commonDateComparison?.commonDateCount || 0);
  const unionDateCount = Number(commonDateComparison?.unionDateCount || 0);
  const summaryLine = leaderLane
    ? (
      trustStatus === 'trustworthy'
        ? (
          leadsAllPrimaryMetrics
            ? `Late-entry shadow leader: ${leaderLane} leads strict common-date on PnL, win rate, PF, and drawdown across ${commonDateCount}/${unionDateCount} dates.`
            : `Late-entry shadow leader: ${leaderLane} leads strict common-date total PnL across ${commonDateCount}/${unionDateCount} dates (trustworthy universe).`
        )
        : `Late-entry shadow leader is provisional: ${leaderLane} leads strict common-date total PnL, but trust status is ${trustStatus.replace(/_/g, ' ')}.`
    )
    : 'Late-entry shadow leader is unavailable because strict common-date ranking data is missing.';
  return {
    laneKey: leaderLane,
    policyKey: leaderPolicy?.policyKey || null,
    policyVersion: leaderPolicy?.policyVersion || null,
    leaderReason: leaderLane ? 'best_strict_common_date_total_pnl' : 'leader_unavailable',
    strictCommonDateTrustStatus: trustStatus,
    commonDateCount: Number.isFinite(commonDateCount) ? commonDateCount : 0,
    unionDateCount: Number.isFinite(unionDateCount) ? unionDateCount : 0,
    beats: beatsByPnl,
    ranking: {
      totalPnlRank,
      winRateRank,
      profitFactorRank,
      maxDrawdownRank,
    },
    trustworthyComparison: trustStatus === 'trustworthy',
    summaryLine,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyPromotionReadinessPanel(input = {}) {
  const v5Summary = input?.v5Summary && typeof input.v5Summary === 'object'
    ? input.v5Summary
    : null;
  const shadowLeader = input?.shadowLeader && typeof input.shadowLeader === 'object'
    ? input.shadowLeader
    : null;
  if (!v5Summary) return null;
  const thresholds = v5Summary?.promotionReadinessThresholds && typeof v5Summary.promotionReadinessThresholds === 'object'
    ? { ...v5Summary.promotionReadinessThresholds }
    : {
      minSampleDays: LATE_ENTRY_POLICY_MIN_SAMPLE_DAYS,
      minPolicyAddedTrades: LATE_ENTRY_POLICY_MIN_POLICY_ADDED_TRADES,
      minExternalCoveragePct: LATE_ENTRY_POLICY_MIN_EXTERNAL_COVERAGE_PCT,
      minRolling5ExternalCoveragePct: LATE_ENTRY_POLICY_MIN_ROLLING5_EXTERNAL_COVERAGE_PCT,
      minRolling10ExternalCoveragePct: LATE_ENTRY_POLICY_MIN_ROLLING10_EXTERNAL_COVERAGE_PCT,
      post1130DragWarnPnl: LATE_ENTRY_POLICY_POST_1130_DRAG_WARN_PNL,
    };
  const observed = {
    trackedDays: Number(v5Summary?.trackedDays || 0),
    policyAddedTrades: Number(v5Summary?.policyAddedTrades || 0),
    externalCoveragePct: Number.isFinite(toFiniteNumberOrNull(v5Summary?.externalCoveragePct))
      ? round2(toFiniteNumberOrNull(v5Summary.externalCoveragePct))
      : null,
    rolling5ExternalCoveragePct: Number.isFinite(toFiniteNumberOrNull(v5Summary?.rolling5ExternalCoveragePct))
      ? round2(toFiniteNumberOrNull(v5Summary.rolling5ExternalCoveragePct))
      : null,
    rolling10ExternalCoveragePct: Number.isFinite(toFiniteNumberOrNull(v5Summary?.rolling10ExternalCoveragePct))
      ? round2(toFiniteNumberOrNull(v5Summary.rolling10ExternalCoveragePct))
      : null,
    externallyFinalizedEligibleDays: Number(v5Summary?.externallyFinalizedEligibleDays || 0),
    externallyUnfinalizedEligibleDays: Number(v5Summary?.externallyUnfinalizedEligibleDays || 0),
  };
  const gapPct = (threshold, value) => {
    if (!Number.isFinite(toFiniteNumberOrNull(threshold))) return null;
    if (!Number.isFinite(toFiniteNumberOrNull(value))) return round2(toFiniteNumberOrNull(threshold));
    return round2(Math.max(0, toFiniteNumberOrNull(threshold) - toFiniteNumberOrNull(value)));
  };
  const gapCount = (threshold, value) => {
    if (!Number.isFinite(toFiniteNumberOrNull(threshold))) return null;
    const observedValue = Number.isFinite(toFiniteNumberOrNull(value)) ? toFiniteNumberOrNull(value) : 0;
    return Math.max(0, Math.round(toFiniteNumberOrNull(threshold) - observedValue));
  };
  const remainingToUnlock = {
    externalCoveragePctGap: gapPct(thresholds.minExternalCoveragePct, observed.externalCoveragePct),
    rolling5CoverageGap: gapPct(thresholds.minRolling5ExternalCoveragePct, observed.rolling5ExternalCoveragePct),
    rolling10CoverageGap: gapPct(thresholds.minRolling10ExternalCoveragePct, observed.rolling10ExternalCoveragePct),
    minSampleGap: gapCount(thresholds.minSampleDays, observed.trackedDays),
    minAddedTradesGap: gapCount(thresholds.minPolicyAddedTrades, observed.policyAddedTrades),
  };
  const status = normalizeLateEntryPolicyPromotionStatus(
    v5Summary?.promotionReadinessStatus || LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY
  );
  const blockReasons = Array.isArray(v5Summary?.promotionReadinessBlockReasons)
    ? Array.from(new Set(v5Summary.promotionReadinessBlockReasons.map((reason) => toText(reason || '').toLowerCase()).filter(Boolean)))
    : [];
  const summaryLine = status === LATE_ENTRY_POLICY_PROMOTION_PROMOTABLE_FOR_REVIEW
    ? `Late-entry promotion readiness: v5 is ready for manual review (truth coverage gates satisfied).`
    : `Promotion blocked: ${blockReasons.length > 0 ? blockReasons.join(', ') : status}. Coverage full ${Number.isFinite(observed.externalCoveragePct) ? `${observed.externalCoveragePct}%` : 'N/A'}, rolling-5 ${Number.isFinite(observed.rolling5ExternalCoveragePct) ? `${observed.rolling5ExternalCoveragePct}%` : 'N/A'}, rolling-10 ${Number.isFinite(observed.rolling10ExternalCoveragePct) ? `${observed.rolling10ExternalCoveragePct}%` : 'N/A'}.`;
  return {
    activeCandidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    status,
    blockReasons,
    thresholds,
    observed,
    remainingToUnlock,
    strictCommonDateTrustStatus: toText(shadowLeader?.strictCommonDateTrustStatus || '').toLowerCase() || null,
    summaryLine,
    advisoryOnly: true,
  };
}

function isLateEntryExternalOutcomeFinalized(externalOutcome = {}) {
  const source = normalizeRealizedTruthSource(
    externalOutcome?.sourceInUse
    || externalOutcome?.sourceAttribution?.sourceInUse
    || REALIZED_TRUTH_SOURCE_NONE
  );
  const stale = externalOutcome?.sourceAttribution?.sourceFreshness?.targetDateInStaleWindow === true
    || externalOutcome?.sourceAttribution?.recoveryPlan?.targetDateInStaleWindow === true;
  if (stale) return false;
  if (source !== REALIZED_TRUTH_SOURCE_PRIMARY && source !== REALIZED_TRUTH_SOURCE_SECONDARY) return false;
  return externalOutcome?.sourceBacked === true && externalOutcome?.hasRows === true;
}

function listFormattedLateEntryPolicyRows(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  const policyKey = toText(options.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const policyVersion = toText(options.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION;
  const sourceType = toText(options.sourceType || options.source || SOURCE_LIVE).toLowerCase() || SOURCE_LIVE;
  const sourceFilter = sourceType === SOURCE_BACKFILL || sourceType === SOURCE_LIVE ? sourceType : SOURCE_LIVE;
  const reconstructionPhase = normalizeReconstructionPhase(options.reconstructionPhase || PHASE_LIVE_INTRADAY, sourceFilter);
  const maxRows = Math.max(1, Math.min(10000, Number(options.maxRows || 5000)));
  const rawRows = listLateEntryPolicyExperimentRows(db, {
    policyKey,
    policyVersion,
    source: sourceFilter,
    reconstructionPhase,
    maxRows,
  });
  const rows = [];
  for (const rawRow of rawRows) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    rawRow.__db = db;
    const formatted = formatLateEntryPolicyExperimentRow(rawRow);
    delete rawRow.__db;
    if (!formatted || typeof formatted !== 'object') continue;
    if (!formatted.tradeDate) continue;
    rows.push(formatted);
  }
  rows.sort((a, b) => String(a.tradeDate || '').localeCompare(String(b.tradeDate || '')));
  return rows;
}

function buildLateEntryLaneRowsByDate(db, options = {}) {
  const sourceType = toText(options.sourceType || options.source || SOURCE_LIVE).toLowerCase() || SOURCE_LIVE;
  const sourceFilter = sourceType === SOURCE_BACKFILL || sourceType === SOURCE_LIVE ? sourceType : SOURCE_LIVE;
  const reconstructionPhase = normalizeReconstructionPhase(options.reconstructionPhase || PHASE_LIVE_INTRADAY, sourceFilter);
  const maxRows = Math.max(1, Math.min(10000, Number(options.maxRows || 5000)));
  const laneConfigs = ['v1', 'v2', 'v3', 'v4', 'v5']
    .map((lane) => getLateEntryPolicyConfigByLane(lane))
    .filter(Boolean);
  const laneRows = {};
  const laneRowsByDate = {};
  const laneDateSets = {};
  for (const config of laneConfigs) {
    const rows = listFormattedLateEntryPolicyRows(db, {
      policyKey: config.policyKey,
      policyVersion: config.policyVersion,
      sourceType: sourceFilter,
      reconstructionPhase,
      maxRows,
    });
    laneRows[config.lane] = rows;
    const byDate = new Map();
    for (const row of rows) {
      const tradeDate = normalizeDate(row?.tradeDate || '');
      if (!tradeDate || byDate.has(tradeDate)) continue;
      byDate.set(tradeDate, row);
    }
    laneRowsByDate[config.lane] = byDate;
    laneDateSets[config.lane] = new Set(Array.from(byDate.keys()));
  }
  return {
    sourceType: sourceFilter,
    reconstructionPhase,
    laneRows,
    laneRowsByDate,
    laneDateSets,
  };
}

function isLateEntryRelevantDayRow(row = null) {
  if (!row || typeof row !== 'object') return false;
  return (
    row.broaderReplayWouldTrade === true
    || row.wouldExtensionPolicyTakeTrade === true
    || row.replayWouldHaveTradedButPolicyRejected === true
    || row.wouldBaselineTakeTrade === true
  );
}

function buildLateEntryPolicyV5ShadowTracking(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return { latestDay: null, recentShadowScore: null };
  const laneData = buildLateEntryLaneRowsByDate(db, options);
  const v5Rows = Array.isArray(laneData?.laneRows?.v5) ? laneData.laneRows.v5 : [];
  const relevantRows = v5Rows.filter((row) => isLateEntryRelevantDayRow(row));
  const relevantDates = relevantRows.map((row) => normalizeDate(row?.tradeDate || '')).filter(Boolean);
  const externalFinalizedByDate = new Map();
  for (const date of relevantDates) {
    const externalOutcome = resolveExternalExecutionOutcomeForDate(db, date);
    externalFinalizedByDate.set(date, isLateEntryExternalOutcomeFinalized(externalOutcome));
  }
  const latest = relevantRows.length > 0 ? relevantRows[relevantRows.length - 1] : null;
  const latestTradeDate = normalizeDate(latest?.tradeDate || '');
  const v1Row = latestTradeDate ? laneData?.laneRowsByDate?.v1?.get(latestTradeDate) || null : null;
  const v4Row = latestTradeDate ? laneData?.laneRowsByDate?.v4?.get(latestTradeDate) || null : null;
  const inStrictCommonDateUniverse = latestTradeDate
    ? ['v1', 'v2', 'v3', 'v4', 'v5'].every((lane) => laneData?.laneDateSets?.[lane]?.has(latestTradeDate))
    : false;
  const latestExternallyFinalized = latestTradeDate
    ? externalFinalizedByDate.get(latestTradeDate) === true
    : null;

  const latestDay = latest
    ? {
      tradeDate: latestTradeDate,
      inStrictCommonDateUniverse,
      baselineWouldTrade: latest?.baselineDecision?.wouldTrade === true,
      v4WouldTrade: v4Row?.extensionPolicyDecision?.wouldTrade === true,
      v5WouldTrade: latest?.extensionPolicyDecision?.wouldTrade === true,
      broadReplayExists: latest?.broaderReplayWouldTrade === true,
      selectedTpMode: toText(latest?.selectedTpMode || '') || null,
      replayOutcome: normalizePolicyPathOutcome(latest?.selectedOutcome?.outcome || ''),
      replayPnl: Number.isFinite(toFiniteNumberOrNull(latest?.selectedOutcome?.pnl))
        ? round2(toFiniteNumberOrNull(latest.selectedOutcome.pnl))
        : null,
      classificationVsBaseline: toText(latest?.policyReplayClassification || '').toLowerCase() || null,
      classificationVsV4: toText(latest?.v5ComparisonClassification || '').toLowerCase() || null,
      externallyFinalized: latestExternallyFinalized,
      statusLine: `Latest relevant day ${latestTradeDate}: baseline ${latest?.baselineDecision?.wouldTrade === true ? 'trade' : 'no trade'}, v4 ${v4Row?.extensionPolicyDecision?.wouldTrade === true ? 'trade' : 'no trade'}, v5 ${latest?.extensionPolicyDecision?.wouldTrade === true ? 'trade' : 'no trade'}, replay ${normalizePolicyPathOutcome(latest?.selectedOutcome?.outcome || '') || 'unknown'}${Number.isFinite(toFiniteNumberOrNull(latest?.selectedOutcome?.pnl)) ? ` ($${round2(toFiniteNumberOrNull(latest.selectedOutcome.pnl))})` : ''}${latestExternallyFinalized === true ? ', externally finalized.' : ', external finalization pending.'}`,
      advisoryOnly: true,
    }
    : null;

  const computeWindowStats = (windowSize) => {
    const slice = relevantRows.slice(-windowSize);
    const stats = {
      considered: slice.length,
      rescuedWins: 0,
      addedLosses: 0,
      agreedNoTrade: 0,
      agreedTrade: 0,
      externallyFinalizedDays: 0,
      externallyUnfinalizedDays: 0,
      coveragePct: null,
    };
    for (const row of slice) {
      const tradeDate = normalizeDate(row?.tradeDate || '');
      const baselineWouldTrade = row?.baselineDecision?.wouldTrade === true;
      const extensionWouldTrade = row?.extensionPolicyDecision?.wouldTrade === true;
      const selectedOutcome = normalizePolicyPathOutcome(row?.selectedOutcome?.outcome || '');
      if (!baselineWouldTrade && extensionWouldTrade && selectedOutcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) {
        stats.rescuedWins += 1;
      } else if (!baselineWouldTrade && extensionWouldTrade && selectedOutcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) {
        stats.addedLosses += 1;
      } else if (!baselineWouldTrade && !extensionWouldTrade) {
        stats.agreedNoTrade += 1;
      } else if (baselineWouldTrade && extensionWouldTrade) {
        stats.agreedTrade += 1;
      }
      if (externalFinalizedByDate.get(tradeDate) === true) stats.externallyFinalizedDays += 1;
      else stats.externallyUnfinalizedDays += 1;
    }
    stats.coveragePct = stats.considered > 0
      ? round2((stats.externallyFinalizedDays / stats.considered) * 100)
      : null;
    return stats;
  };

  const last5RelevantDays = computeWindowStats(5);
  const last10RelevantDays = computeWindowStats(10);
  const truthAccumulationDirection = (() => {
    if (!Number.isFinite(toFiniteNumberOrNull(last5RelevantDays.coveragePct)) || !Number.isFinite(toFiniteNumberOrNull(last10RelevantDays.coveragePct))) {
      return 'unknown';
    }
    const delta = round2(toFiniteNumberOrNull(last5RelevantDays.coveragePct) - toFiniteNumberOrNull(last10RelevantDays.coveragePct));
    if (delta > 5) return 'improving';
    if (delta < -5) return 'degrading';
    return 'flat';
  })();
  const recentShadowScore = {
    latestRelevantTradeDate: latestTradeDate || null,
    relevantDayCount: relevantRows.length,
    last5RelevantDays,
    last10RelevantDays,
    truthAccumulationDirection,
    summaryLine: `Recent v5 shadow score: last5 relevant ${last5RelevantDays.considered} (rescued wins ${last5RelevantDays.rescuedWins}, added losses ${last5RelevantDays.addedLosses}, external ${last5RelevantDays.externallyFinalizedDays}/${last5RelevantDays.considered || 0}), last10 relevant ${last10RelevantDays.considered} (rescued wins ${last10RelevantDays.rescuedWins}, added losses ${last10RelevantDays.addedLosses}, external ${last10RelevantDays.externallyFinalizedDays}/${last10RelevantDays.considered || 0}); truth accumulation ${truthAccumulationDirection}.`,
    advisoryOnly: true,
  };

  return {
    latestDay,
    recentShadowScore,
  };
}

function parseLateEntryCompositeClusterKey(key = '') {
  const parts = String(key || '').split('|');
  if (parts.length < 4) {
    return {
      weekday: toText(parts[0] || '') || 'unknown',
      confirmationTimeBucket: toText(parts[1] || '') || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN,
      regimeLabel: toText(parts[2] || '') || 'unknown',
      selectedTpMode: toText(parts[3] || '') || 'unknown',
    };
  }
  return {
    weekday: toText(parts[0] || '') || 'unknown',
    confirmationTimeBucket: toText(parts[1] || '') || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN,
    regimeLabel: toText(parts.slice(2, parts.length - 1).join('|') || '') || 'unknown',
    selectedTpMode: toText(parts[parts.length - 1] || '') || 'unknown',
  };
}

function classifyLateEntryPocketSignal(cluster = {}, type = 'positive') {
  const totalPnl = Number.isFinite(toFiniteNumberOrNull(cluster?.totalPnl)) ? round2(toFiniteNumberOrNull(cluster.totalPnl)) : 0;
  const wins = Number(cluster?.wins || 0);
  const losses = Number(cluster?.losses || 0);
  const judged = wins + losses;
  const winRatePct = judged > 0 ? round2((wins / judged) * 100) : null;
  if (type === 'negative') {
    if (totalPnl <= -250 || (Number.isFinite(winRatePct) && winRatePct <= 35)) return 'strong_negative';
    return 'negative';
  }
  if (totalPnl >= 250 || (Number.isFinite(winRatePct) && winRatePct >= 70)) return 'strong_positive';
  return 'positive';
}

function buildLateEntryPolicyV5PocketMap(input = {}) {
  const ledger = input?.v1VsV4MissedTradeLedger && typeof input.v1VsV4MissedTradeLedger === 'object'
    ? input.v1VsV4MissedTradeLedger
    : null;
  const v5VsV4Delta = input?.v5VsV4Delta && typeof input.v5VsV4Delta === 'object'
    ? input.v5VsV4Delta
    : null;
  if (!ledger) return null;
  const strongestPockets = (Array.isArray(ledger?.topProfitableMissedClusters) ? ledger.topProfitableMissedClusters : [])
    .slice(0, 3)
    .map((cluster) => {
      const parsed = parseLateEntryCompositeClusterKey(cluster?.key || '');
      const wins = Number(cluster?.wins || 0);
      const losses = Number(cluster?.losses || 0);
      const judged = wins + losses;
      return {
        weekday: parsed.weekday,
        bucket: parsed.confirmationTimeBucket,
        regimeLabel: parsed.regimeLabel,
        tpMode: parsed.selectedTpMode,
        signal: classifyLateEntryPocketSignal(cluster, 'positive'),
        count: Number(cluster?.count || 0),
        wins,
        losses,
        winRatePct: judged > 0 ? round2((wins / judged) * 100) : null,
        netPnl: Number.isFinite(toFiniteNumberOrNull(cluster?.totalPnl)) ? round2(toFiniteNumberOrNull(cluster.totalPnl)) : null,
        avgPnl: Number.isFinite(toFiniteNumberOrNull(cluster?.avgPnl)) ? round2(toFiniteNumberOrNull(cluster.avgPnl)) : null,
      };
    });
  const blockedRiskPockets = (Array.isArray(ledger?.topUnprofitableSkippedClusters) ? ledger.topUnprofitableSkippedClusters : [])
    .slice(0, 3)
    .map((cluster) => {
      const parsed = parseLateEntryCompositeClusterKey(cluster?.key || '');
      const wins = Number(cluster?.wins || 0);
      const losses = Number(cluster?.losses || 0);
      const judged = wins + losses;
      return {
        weekday: parsed.weekday,
        bucket: parsed.confirmationTimeBucket,
        regimeLabel: parsed.regimeLabel,
        tpMode: parsed.selectedTpMode,
        signal: classifyLateEntryPocketSignal(cluster, 'negative'),
        count: Number(cluster?.count || 0),
        wins,
        losses,
        winRatePct: judged > 0 ? round2((wins / judged) * 100) : null,
        netPnl: Number.isFinite(toFiniteNumberOrNull(cluster?.totalPnl)) ? round2(toFiniteNumberOrNull(cluster.totalPnl)) : null,
        avgPnl: Number.isFinite(toFiniteNumberOrNull(cluster?.avgPnl)) ? round2(toFiniteNumberOrNull(cluster.avgPnl)) : null,
      };
    });
  const strongest = strongestPockets[0] || null;
  const blocked = blockedRiskPockets[0] || null;
  const currentRead = strongest && blocked
    ? `Pocket map: strongest ${strongest.weekday} ${strongest.bucket}; keep ${blocked.weekday} ${blocked.bucket} blocked.`
    : (
      strongest
        ? `Pocket map: strongest ${strongest.weekday} ${strongest.bucket}.`
        : (
          blocked
            ? `Pocket map: keep ${blocked.weekday} ${blocked.bucket} blocked.`
            : 'Pocket map: no strong cluster signal available.'
        )
    );
  return {
    source: 'strict_common_date_v1_vs_v4_missed_trade_ledger',
    strongestPockets,
    blockedRiskPockets,
    rescuedWinners: Number(v5VsV4Delta?.rescuedWinners || 0),
    addedLosers: Number(v5VsV4Delta?.addedLosers || 0),
    dominantRescuedWeekday: toText(v5VsV4Delta?.dominantRescuedWeekday || '') || null,
    dominantRescuedRegime: toText(v5VsV4Delta?.dominantRescuedRegime || '') || null,
    currentRead,
    advisoryOnly: true,
  };
}

function toIsoDateMs(date = '') {
  const normalized = normalizeDate(date);
  if (!normalized) return null;
  const ms = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function bucketLateEntryBacklogAge(asOfTradeDate = '', tradeDate = '') {
  const asOfMs = toIsoDateMs(asOfTradeDate);
  const tradeMs = toIsoDateMs(tradeDate);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(tradeMs)) return 'old';
  const ageDays = Math.max(0, Math.floor((asOfMs - tradeMs) / (24 * 60 * 60 * 1000)));
  if (ageDays <= 3) return 'recent';
  if (ageDays <= 10) return 'medium';
  return 'old';
}

function buildLateEntryPolicyTruthCoverageBacklog(input = {}) {
  const v5Summary = input?.v5Summary && typeof input.v5Summary === 'object'
    ? input.v5Summary
    : null;
  if (!v5Summary) return null;
  const v5ShadowTracking = input?.v5ShadowTracking && typeof input.v5ShadowTracking === 'object'
    ? input.v5ShadowTracking
    : {};
  const recentShadowScore = v5ShadowTracking?.recentShadowScore
    && typeof v5ShadowTracking.recentShadowScore === 'object'
    ? v5ShadowTracking.recentShadowScore
    : {};
  const last5 = recentShadowScore?.last5RelevantDays
    && typeof recentShadowScore.last5RelevantDays === 'object'
    ? recentShadowScore.last5RelevantDays
    : {};
  const last10 = recentShadowScore?.last10RelevantDays
    && typeof recentShadowScore.last10RelevantDays === 'object'
    ? recentShadowScore.last10RelevantDays
    : {};
  const trackedDays = Number(v5Summary?.trackedDays || 0);
  const externallyFinalizedEligibleDays = Number(v5Summary?.externallyFinalizedEligibleDays || 0);
  const externallyUnfinalizedEligibleDays = Number(v5Summary?.externallyUnfinalizedEligibleDays || 0);
  const eligibleDays = externallyFinalizedEligibleDays + externallyUnfinalizedEligibleDays;
  const unfinalizedTradeDates = Array.isArray(v5Summary?.unfinalizedTradeDates)
    ? v5Summary.unfinalizedTradeDates.map((date) => normalizeDate(date)).filter(Boolean)
    : [];
  unfinalizedTradeDates.sort((a, b) => String(a).localeCompare(String(b)));
  const asOfTradeDate = normalizeDate(
    input?.asOfTradeDate
    || recentShadowScore?.latestRelevantTradeDate
    || unfinalizedTradeDates[unfinalizedTradeDates.length - 1]
    || ''
  );
  const backlogBuckets = { recent: 0, medium: 0, old: 0 };
  for (const date of unfinalizedTradeDates) {
    const bucket = bucketLateEntryBacklogAge(asOfTradeDate, date);
    backlogBuckets[bucket] = Number(backlogBuckets[bucket] || 0) + 1;
  }
  const rolling5RelevantDays = Number(last5?.considered || 0);
  const rolling10RelevantDays = Number(last10?.considered || 0);
  const rolling5ExternallyFinalizedDays = Number(last5?.externallyFinalizedDays || 0);
  const rolling10ExternallyFinalizedDays = Number(last10?.externallyFinalizedDays || 0);
  const coveragePct = Number.isFinite(toFiniteNumberOrNull(v5Summary?.externalCoveragePct))
    ? round2(toFiniteNumberOrNull(v5Summary.externalCoveragePct))
    : null;
  const rolling5CoveragePct = Number.isFinite(toFiniteNumberOrNull(last5?.coveragePct))
    ? round2(toFiniteNumberOrNull(last5.coveragePct))
    : (rolling5RelevantDays > 0 ? round2((rolling5ExternallyFinalizedDays / rolling5RelevantDays) * 100) : null);
  const rolling10CoveragePct = Number.isFinite(toFiniteNumberOrNull(last10?.coveragePct))
    ? round2(toFiniteNumberOrNull(last10.coveragePct))
    : (rolling10RelevantDays > 0 ? round2((rolling10ExternallyFinalizedDays / rolling10RelevantDays) * 100) : null);
  const oldestUnfinalizedTradeDate = unfinalizedTradeDates[0] || null;
  const newestUnfinalizedTradeDate = unfinalizedTradeDates[unfinalizedTradeDates.length - 1] || null;
  return {
    activeCandidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    trackedDays,
    eligibleDays,
    externallyFinalizedEligibleDays,
    externallyUnfinalizedEligibleDays,
    oldestUnfinalizedTradeDate,
    newestUnfinalizedTradeDate,
    rolling5RelevantDays,
    rolling5ExternallyFinalizedDays,
    rolling10RelevantDays,
    rolling10ExternallyFinalizedDays,
    coveragePct,
    rolling5CoveragePct,
    rolling10CoveragePct,
    backlogBuckets,
    summaryLine: `Truth backlog: ${externallyUnfinalizedEligibleDays}/${eligibleDays || 0} eligible days pending external finalization; rolling-5 relevant ${rolling5ExternallyFinalizedDays}/${rolling5RelevantDays || 0}, rolling-10 relevant ${rolling10ExternallyFinalizedDays}/${rolling10RelevantDays || 0}.`,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyTruthCoverageLedger(input = {}) {
  const backlog = input?.backlog && typeof input.backlog === 'object'
    ? input.backlog
    : null;
  if (!backlog) return null;
  const maxRecent = Math.max(1, Math.min(20, Number(input.maxRecent || 12)));
  const maxPriority = Math.max(1, Math.min(20, Number(input.maxPriority || 10)));
  const unfinalizedTradeDates = Array.isArray(input?.unfinalizedTradeDates)
    ? input.unfinalizedTradeDates.map((date) => normalizeDate(date)).filter(Boolean)
    : (
      Array.isArray(backlog?.unfinalizedTradeDates)
        ? backlog.unfinalizedTradeDates.map((date) => normalizeDate(date)).filter(Boolean)
        : []
    );
  unfinalizedTradeDates.sort((a, b) => String(a).localeCompare(String(b)));
  const newestFirst = [...unfinalizedTradeDates].sort((a, b) => String(b).localeCompare(String(a)));
  const recentMissingDates = newestFirst.slice(0, maxRecent);
  const highPriorityMissingDates = newestFirst.slice(0, maxPriority);
  const oldest = unfinalizedTradeDates.length > 0
    ? [...unfinalizedTradeDates].sort((a, b) => String(a).localeCompare(String(b)))[0]
    : null;
  const newest = newestFirst[0] || null;
  return {
    activeCandidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    count: unfinalizedTradeDates.length,
    oldest,
    newest,
    recentMissingDates,
    highPriorityMissingDates,
    summaryLine: `Truth coverage ledger: ${unfinalizedTradeDates.length} pending dates (newest ${newest || 'N/A'}, oldest ${oldest || 'N/A'}).`,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyTruthAccumulationTrend(input = {}) {
  const v5ShadowTracking = input?.v5ShadowTracking && typeof input.v5ShadowTracking === 'object'
    ? input.v5ShadowTracking
    : {};
  const recentShadowScore = v5ShadowTracking?.recentShadowScore
    && typeof v5ShadowTracking.recentShadowScore === 'object'
    ? v5ShadowTracking.recentShadowScore
    : {};
  const normalizeWindow = (window) => {
    const considered = Number(window?.considered || 0);
    const finalized = Number(window?.externallyFinalizedDays || 0);
    const pending = Math.max(0, considered - finalized);
    const coveragePct = considered > 0 ? round2((finalized / considered) * 100) : null;
    return { finalized, pending, coveragePct };
  };
  const last5RelevantDays = normalizeWindow(recentShadowScore?.last5RelevantDays || {});
  const last10RelevantDays = normalizeWindow(recentShadowScore?.last10RelevantDays || {});
  const last5Coverage = toFiniteNumberOrNull(last5RelevantDays.coveragePct);
  const last10Coverage = toFiniteNumberOrNull(last10RelevantDays.coveragePct);
  let deltaDirection = 'flat';
  if (Number.isFinite(last5Coverage) && Number.isFinite(last10Coverage)) {
    const delta = round2(last5Coverage - last10Coverage);
    if (delta > 5) deltaDirection = 'improving';
    else if (delta < -5) deltaDirection = 'worsening';
  }
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    last5RelevantDays,
    last10RelevantDays,
    deltaDirection,
    summaryLine: `Truth accumulation trend: last5 ${last5RelevantDays.finalized}/${last5RelevantDays.finalized + last5RelevantDays.pending || 0} finalized vs last10 ${last10RelevantDays.finalized}/${last10RelevantDays.finalized + last10RelevantDays.pending || 0}; direction ${deltaDirection}.`,
    advisoryOnly: true,
  };
}

function normalizeLateEntryTruthRepairScope(value = '') {
  const normalized = toText(value || '').toLowerCase();
  if (LATE_ENTRY_TRUTH_REPAIR_SCOPE_SET.has(normalized)) return normalized;
  return LATE_ENTRY_TRUTH_REPAIR_SCOPE_ALL_ELIGIBLE;
}

function getAssistantDecisionCheckpointRowForDate(db, tradeDate = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const normalizedDate = normalizeDate(tradeDate);
  if (!normalizedDate) return null;
  if (!tableExists(db, 'jarvis_assistant_decision_outcome_checkpoints')) return null;
  try {
    return db.prepare(`
      SELECT
        trade_date,
        source_type,
        reconstruction_phase,
        front_line_action_now,
        posture,
        blocker_state,
        realized_outcome_classification,
        actual_trade_taken,
        outcome_json
      FROM jarvis_assistant_decision_outcome_checkpoints
      WHERE trade_date = ?
      LIMIT 1
    `).get(normalizedDate) || null;
  } catch {
    return null;
  }
}

function listRecommendationContextRowsForDateAnyScope(db, recDate = '') {
  if (!db || typeof db.prepare !== 'function') return [];
  const normalizedDate = normalizeDate(recDate);
  if (!normalizedDate) return [];
  if (!tableExists(db, 'jarvis_recommendation_context_history')) return [];
  try {
    return db.prepare(`
      SELECT
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
        context_json,
        created_at,
        updated_at
      FROM jarvis_recommendation_context_history
      WHERE rec_date = ?
      ORDER BY datetime(updated_at) DESC, id DESC
    `).all(normalizedDate) || [];
  } catch {
    return [];
  }
}

function getRecommendationLegacyContextRowForDate(db, recDate = '') {
  if (!db || typeof db.prepare !== 'function') return null;
  const normalizedDate = normalizeDate(recDate);
  if (!normalizedDate) return null;
  if (!tableExists(db, 'jarvis_recommendation_context')) return null;
  try {
    return db.prepare(`
      SELECT
        rec_date,
        posture,
        recommended_strategy_key,
        recommended_strategy_name,
        recommended_tp_mode,
        confidence_label,
        confidence_score,
        recommendation_json,
        strategy_layers_json,
        mechanics_json,
        context_json,
        created_at,
        updated_at
      FROM jarvis_recommendation_context
      WHERE rec_date = ?
      LIMIT 1
    `).get(normalizedDate) || null;
  } catch {
    return null;
  }
}

function listRecommendationOutcomeRowsForDateAnyScope(db, recDate = '') {
  if (!db || typeof db.prepare !== 'function') return [];
  const normalizedDate = normalizeDate(recDate);
  if (!normalizedDate) return [];
  if (!tableExists(db, 'jarvis_recommendation_outcome_history')) return [];
  try {
    return db.prepare(`
      SELECT
        rec_date,
        source_type,
        reconstruction_phase,
        reconstruction_version,
        outcome_json,
        calculated_at
      FROM jarvis_recommendation_outcome_history
      WHERE rec_date = ?
      ORDER BY datetime(calculated_at) DESC, id DESC
    `).all(normalizedDate) || [];
  } catch {
    return [];
  }
}

function hasContextBackfillCoreFields(input = {}) {
  const posture = toText(input?.posture || input?.recommendation?.posture || '');
  const strategyName = toText(
    input?.recommendedStrategyName
    || input?.recommendedStrategyKey
    || input?.recommendation?.recommendedStrategy
    || input?.recommendation?.recommendedStrategyName
    || input?.recommendation?.recommendedStrategyKey
    || ''
  );
  const tpMode = normalizeTpMode(
    input?.recommendedTpMode
    || input?.recommendation?.recommendedTpMode
    || input?.recommendation?.recommended_tp_mode
    || ''
  );
  return Boolean(posture || strategyName || tpMode);
}

function buildContextBackfillPayloadFromRecommendationRow(input = {}) {
  const row = input?.row && typeof input.row === 'object' ? input.row : null;
  if (!row) return null;
  const tradeDate = normalizeDate(input?.tradeDate || row?.rec_date || '');
  if (!tradeDate) return null;
  const recommendation = safeJsonParse(row?.recommendation_json, {});
  const strategyLayers = safeJsonParse(row?.strategy_layers_json, {});
  const mechanics = safeJsonParse(row?.mechanics_json, {});
  const context = safeJsonParse(row?.context_json, {});
  if (!hasContextBackfillCoreFields({
    posture: row?.posture,
    recommendedStrategyName: row?.recommended_strategy_name,
    recommendedStrategyKey: row?.recommended_strategy_key,
    recommendedTpMode: row?.recommended_tp_mode,
    recommendation,
  })) {
    return null;
  }
  if (!toText(recommendation?.posture || '')) {
    recommendation.posture = toText(row?.posture || '') || 'trade_selectively';
  }
  if (!toText(recommendation?.recommendedStrategy || '')) {
    recommendation.recommendedStrategy = toText(row?.recommended_strategy_name || row?.recommended_strategy_key || '') || null;
  }
  if (!toText(recommendation?.recommendedTpMode || '')) {
    recommendation.recommendedTpMode = normalizeTpMode(row?.recommended_tp_mode || '');
  }
  if (!toText(recommendation?.confidenceLabel || '')) {
    recommendation.confidenceLabel = toText(row?.confidence_label || '') || null;
  }
  if (!Number.isFinite(toFiniteNumberOrNull(recommendation?.confidenceScore))) {
    recommendation.confidenceScore = Number.isFinite(toFiniteNumberOrNull(row?.confidence_score))
      ? round2(toFiniteNumberOrNull(row.confidence_score))
      : null;
  }
  if (!context?.nowEt || typeof context.nowEt !== 'object') {
    context.nowEt = { date: tradeDate };
  } else if (!toText(context?.nowEt?.date || '')) {
    context.nowEt.date = tradeDate;
  }
  return {
    recommendation,
    strategyLayers,
    mechanics,
    context,
    generatedAt: toText(row?.generated_at || row?.updated_at || row?.created_at || '') || new Date().toISOString(),
    reconstructionVersion: toText(row?.reconstruction_version || '') || VERSION_LIVE,
  };
}

function buildContextBackfillPayloadFromOutcomeRow(input = {}) {
  const row = input?.row && typeof input.row === 'object' ? input.row : null;
  if (!row) return null;
  const tradeDate = normalizeDate(input?.tradeDate || row?.rec_date || '');
  if (!tradeDate) return null;
  const outcome = safeJsonParse(row?.outcome_json, {});
  const checkpoint = outcome?.assistantDecisionOutcomeCheckpoint
    && typeof outcome.assistantDecisionOutcomeCheckpoint === 'object'
    ? outcome.assistantDecisionOutcomeCheckpoint
    : {};
  const recommendedStrategyOutcome = outcome?.recommendedStrategyOutcome
    && typeof outcome.recommendedStrategyOutcome === 'object'
    ? outcome.recommendedStrategyOutcome
    : {};
  const recommendation = {
    posture: toText(outcome?.posture || checkpoint?.posture || '') || 'trade_selectively',
    recommendedStrategy: toText(
      recommendedStrategyOutcome?.strategyName
      || outcome?.recommendedStrategyName
      || checkpoint?.recommendedStrategyName
      || outcome?.recommendedStrategyKey
      || checkpoint?.recommendedStrategyKey
      || ''
    ) || null,
    recommendedTpMode: normalizeTpMode(
      outcome?.recommendedTpMode
      || checkpoint?.recommendedTpMode
      || ''
    ),
    confidenceLabel: toText(checkpoint?.confidenceLabel || '') || null,
    confidenceScore: Number.isFinite(toFiniteNumberOrNull(checkpoint?.confidenceScore))
      ? round2(toFiniteNumberOrNull(checkpoint.confidenceScore))
      : null,
    assistantDecisionBrief: {
      actionNow: toText(checkpoint?.frontLineActionNow || ''),
    },
  };
  if (!hasContextBackfillCoreFields({ recommendation })) return null;
  const recommendationDate = normalizeDate(outcome?.recommendationDate || tradeDate) || tradeDate;
  const context = {
    nowEt: { date: recommendationDate },
    sessionPhase: toText(outcome?.timeBucket || '') || null,
    reconstructedFrom: 'recommendation_outcome_history',
    reconstructedSourceType: toText(row?.source_type || '') || null,
    reconstructedReconstructionPhase: toText(row?.reconstruction_phase || '') || null,
  };
  if (outcome?.integrity && typeof outcome.integrity === 'object') {
    context.integrity = { ...outcome.integrity };
  }
  return {
    recommendation,
    strategyLayers: {},
    mechanics: {},
    context,
    generatedAt: toText(row?.calculated_at || '') || new Date().toISOString(),
    reconstructionVersion: toText(row?.reconstruction_version || '') || VERSION_LIVE,
  };
}

function buildContextBackfillPayloadFromCheckpointRow(input = {}) {
  const row = input?.row && typeof input.row === 'object' ? input.row : null;
  if (!row) return null;
  const tradeDate = normalizeDate(input?.tradeDate || row?.trade_date || '');
  if (!tradeDate) return null;
  const snapshot = safeJsonParse(row?.snapshot_json, {});
  const recommendation = {
    posture: toText(row?.posture || '') || 'trade_selectively',
    recommendedStrategy: toText(row?.recommended_strategy_name || row?.recommended_strategy_key || '') || null,
    recommendedTpMode: normalizeTpMode(row?.recommended_tp_mode || ''),
    confidenceLabel: toText(row?.confidence_label || '') || null,
    confidenceScore: Number.isFinite(toFiniteNumberOrNull(row?.confidence_score))
      ? round2(toFiniteNumberOrNull(row.confidence_score))
      : null,
    assistantDecisionBrief: {
      actionNow: toText(row?.front_line_action_now || ''),
    },
  };
  if (!hasContextBackfillCoreFields({ recommendation })) return null;
  const context = snapshot && typeof snapshot === 'object' ? { ...snapshot } : {};
  if (!context?.nowEt || typeof context.nowEt !== 'object') {
    context.nowEt = { date: tradeDate };
  } else if (!toText(context?.nowEt?.date || '')) {
    context.nowEt.date = tradeDate;
  }
  return {
    recommendation,
    strategyLayers: {},
    mechanics: {},
    context,
    generatedAt: toText(row?.updated_at || row?.created_at || '') || new Date().toISOString(),
    reconstructionVersion: toText(row?.reconstruction_version || '') || VERSION_LIVE,
  };
}

function classifyLateEntryPolicyContextGap(input = {}) {
  const db = input?.db;
  if (!db || typeof db.prepare !== 'function') return null;
  const tradeDate = normalizeDate(input?.tradeDate || '');
  if (!tradeDate) return null;
  const sourceType = normalizeSourceType(input?.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(input?.reconstructionPhase || PHASE_LIVE_INTRADAY, sourceType);
  const strictContextRow = getRecommendationContextRow(db, {
    recDate: tradeDate,
    sourceType,
    reconstructionPhase,
  });
  const allContextRows = listRecommendationContextRowsForDateAnyScope(db, tradeDate);
  const altContextRows = allContextRows.filter((row) => !(
    normalizeSourceType(row?.source_type || '') === sourceType
    && normalizeReconstructionPhase(row?.reconstruction_phase || '', sourceType) === reconstructionPhase
  ));
  const legacyContextRow = getRecommendationLegacyContextRowForDate(db, tradeDate);
  const checkpointRow = getAssistantDecisionCheckpointRowForDate(db, tradeDate);
  const allOutcomeRows = listRecommendationOutcomeRowsForDateAnyScope(db, tradeDate);
  const strictOutcomeRow = allOutcomeRows.find((row) => (
    normalizeSourceType(row?.source_type || '') === sourceType
    && normalizeReconstructionPhase(row?.reconstruction_phase || '', sourceType) === reconstructionPhase
  )) || null;
  const preferredContextCandidate = altContextRows
    .slice()
    .sort((a, b) => {
      const aScore = (
        normalizeSourceType(a?.source_type || '') === sourceType ? 0 : 1
      );
      const bScore = (
        normalizeSourceType(b?.source_type || '') === sourceType ? 0 : 1
      );
      if (aScore !== bScore) return aScore - bScore;
      return String(b?.updated_at || '').localeCompare(String(a?.updated_at || ''));
    })[0] || null;
  const contextPayloadFromLegacy = legacyContextRow
    ? buildContextBackfillPayloadFromRecommendationRow({
      row: legacyContextRow,
      tradeDate,
    })
    : null;
  const contextPayloadFromPreferred = preferredContextCandidate
    ? buildContextBackfillPayloadFromRecommendationRow({
      row: preferredContextCandidate,
      tradeDate,
    })
    : null;
  const contextPayloadFromCheckpoint = checkpointRow
    ? buildContextBackfillPayloadFromCheckpointRow({
      row: checkpointRow,
      tradeDate,
    })
    : null;
  const contextPayloadFromOutcome = strictOutcomeRow
    ? buildContextBackfillPayloadFromOutcomeRow({
      row: strictOutcomeRow,
      tradeDate,
    })
    : (
      allOutcomeRows.length > 0
        ? buildContextBackfillPayloadFromOutcomeRow({
          row: allOutcomeRows[0],
          tradeDate,
        })
        : null
    );
  const hasAnyContextEvidence = altContextRows.length > 0 || !!legacyContextRow;
  const hasAnyAuxEvidence = !!checkpointRow || allOutcomeRows.length > 0;
  const rebuildPayload = contextPayloadFromLegacy
    || contextPayloadFromPreferred
    || contextPayloadFromCheckpoint
    || contextPayloadFromOutcome
    || null;
  let rootCause = LATE_ENTRY_CONTEXT_GAP_ROOT_UNKNOWN;
  if (strictContextRow) {
    rootCause = LATE_ENTRY_CONTEXT_GAP_ROOT_UNKNOWN;
  } else if (hasAnyContextEvidence) {
    rootCause = rebuildPayload
      ? LATE_ENTRY_CONTEXT_GAP_ROOT_SCOPE_MISMATCH
      : LATE_ENTRY_CONTEXT_GAP_ROOT_SCHEMA_MISMATCH;
  } else if (hasAnyAuxEvidence) {
    rootCause = rebuildPayload
      ? LATE_ENTRY_CONTEXT_GAP_ROOT_NOT_PERSISTED
      : LATE_ENTRY_CONTEXT_GAP_ROOT_SCHEMA_MISMATCH;
  } else {
    rootCause = LATE_ENTRY_CONTEXT_GAP_ROOT_NOT_PERSISTED;
  }
  const rebuildSource = contextPayloadFromLegacy
    ? 'legacy_context'
    : contextPayloadFromPreferred
    ? 'alternate_scope_context'
    : contextPayloadFromCheckpoint
    ? 'assistant_checkpoint'
    : contextPayloadFromOutcome
    ? 'recommendation_outcome_history'
    : null;
  return {
    tradeDate,
    sourceType,
    reconstructionPhase,
    hasStrictContextRow: !!strictContextRow,
    hasAnyContextEvidence,
    hasAnyAuxEvidence,
    altContextRowCount: altContextRows.length,
    outcomeRowCount: allOutcomeRows.length,
    hasCheckpointRow: !!checkpointRow,
    rebuildable: !strictContextRow && !!rebuildPayload,
    rootCause,
    rebuildSource,
    rebuildPayload,
    summaryLine: strictContextRow
      ? `Context gap audit ${tradeDate}: strict scope context already present.`
      : `Context gap audit ${tradeDate}: ${rootCause}${rebuildPayload ? ` (rebuildable via ${rebuildSource}).` : ' (not rebuildable from local evidence).'}`,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyContextGapAudit(input = {}) {
  const candidateRows = Array.isArray(input?.candidateRows) ? input.candidateRows : [];
  const db = input?.db;
  const sourceType = normalizeSourceType(input?.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(input?.reconstructionPhase || PHASE_LIVE_INTRADAY, sourceType);
  const missingContextRows = candidateRows.filter((row) => (
    Array.isArray(row?.blockReasons)
    && row.blockReasons.includes(LATE_ENTRY_TRUTH_BLOCKER_MISSING_CONTEXT)
  ));
  const audits = missingContextRows
    .map((row) => classifyLateEntryPolicyContextGap({
      db,
      tradeDate: row?.tradeDate,
      sourceType,
      reconstructionPhase,
    }))
    .filter(Boolean);
  const rootCauseCounts = {
    [LATE_ENTRY_CONTEXT_GAP_ROOT_NOT_PERSISTED]: 0,
    [LATE_ENTRY_CONTEXT_GAP_ROOT_SCOPE_MISMATCH]: 0,
    [LATE_ENTRY_CONTEXT_GAP_ROOT_SCHEMA_MISMATCH]: 0,
    [LATE_ENTRY_CONTEXT_GAP_ROOT_UNKNOWN]: 0,
  };
  for (const audit of audits) {
    const key = toText(audit?.rootCause || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(rootCauseCounts, key)) {
      rootCauseCounts[key] = Number(rootCauseCounts[key] || 0) + 1;
    } else {
      rootCauseCounts[LATE_ENTRY_CONTEXT_GAP_ROOT_UNKNOWN] = Number(rootCauseCounts[LATE_ENTRY_CONTEXT_GAP_ROOT_UNKNOWN] || 0) + 1;
    }
  }
  const rebuildableCount = audits.filter((audit) => audit.rebuildable === true).length;
  const missingContextCount = audits.length;
  const sampleDates = audits
    .slice()
    .sort((a, b) => String(b.tradeDate || '').localeCompare(String(a.tradeDate || '')))
    .slice(0, Math.max(1, Math.min(20, Number(input?.maxSample || 12))))
    .map((audit) => ({
      tradeDate: audit.tradeDate,
      rootCause: audit.rootCause,
      rebuildable: audit.rebuildable === true,
      rebuildSource: audit.rebuildSource || null,
      summaryLine: audit.summaryLine,
    }));
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    missingContextCount,
    rebuildableCount,
    unrebuildableCount: Math.max(0, missingContextCount - rebuildableCount),
    rootCauseCounts,
    sampleDates,
    summaryLine: `Context gap audit: ${rebuildableCount}/${missingContextCount || 0} missing-context dates are locally rebuildable.`,
    advisoryOnly: true,
  };
}

function runLateEntryPolicyContextBackfillRun(input = {}) {
  const db = input?.db;
  if (!db || typeof db.prepare !== 'function') return null;
  const sourceType = normalizeSourceType(input?.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(input?.reconstructionPhase || PHASE_LIVE_INTRADAY, sourceType);
  const reconstructionVersion = normalizeReconstructionVersion(input?.reconstructionVersion || VERSION_LIVE, sourceType);
  const candidateRows = Array.isArray(input?.candidateRows) ? input.candidateRows : [];
  const sessions = input?.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const scannedRows = candidateRows.filter((row) => (
    Array.isArray(row?.blockReasons)
    && row.blockReasons.includes(LATE_ENTRY_TRUTH_BLOCKER_MISSING_CONTEXT)
  ));
  const rebuiltDates = [];
  let unchangedDates = 0;
  const skippedDates = [];
  const skipReasonCounts = {};
  for (const row of scannedRows) {
    const tradeDate = normalizeDate(row?.tradeDate || '');
    if (!tradeDate) {
      skipReasonCounts.invalid_trade_date = Number(skipReasonCounts.invalid_trade_date || 0) + 1;
      continue;
    }
    const strictContext = getRecommendationContextRow(db, {
      recDate: tradeDate,
      sourceType,
      reconstructionPhase,
    });
    if (strictContext) {
      unchangedDates += 1;
      continue;
    }
    const audit = classifyLateEntryPolicyContextGap({
      db,
      tradeDate,
      sourceType,
      reconstructionPhase,
    });
    if (!audit?.rebuildable || !audit?.rebuildPayload) {
      skippedDates.push(tradeDate);
      const reason = toText(audit?.rootCause || 'not_rebuildable').toLowerCase() || 'not_rebuildable';
      skipReasonCounts[reason] = Number(skipReasonCounts[reason] || 0) + 1;
      continue;
    }
    const payload = audit.rebuildPayload;
    const upsertResult = upsertTodayRecommendationContext({
      db,
      recDate: tradeDate,
      sourceType,
      reconstructionPhase,
      reconstructionVersion: payload.reconstructionVersion || reconstructionVersion,
      generatedAt: payload.generatedAt || new Date().toISOString(),
      todayRecommendation: payload.recommendation || {},
      strategyLayers: payload.strategyLayers || {},
      mechanicsResearchSummary: payload.mechanics || {},
      context: payload.context || { nowEt: { date: tradeDate } },
      triggerSource: 'late_entry_truth_context_backfill',
      sessions,
      sessionForDate: Array.isArray(sessions?.[tradeDate]) ? sessions[tradeDate] : null,
    });
    const strictContextAfter = getRecommendationContextRow(db, {
      recDate: tradeDate,
      sourceType,
      reconstructionPhase,
    });
    if (strictContextAfter) {
      rebuiltDates.push(tradeDate);
      continue;
    }
    skippedDates.push(tradeDate);
    const reason = toText(
      upsertResult?.contextCreationReason
      || upsertResult?.contextCreationStatus
      || 'context_backfill_not_persisted'
    ).toLowerCase() || 'context_backfill_not_persisted';
    skipReasonCounts[reason] = Number(skipReasonCounts[reason] || 0) + 1;
  }
  const rebuiltSorted = rebuiltDates
    .map((date) => normalizeDate(date))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    scannedDates: scannedRows.length,
    rebuiltDates: rebuiltSorted.length,
    unchangedDates,
    skippedDates: skippedDates.length,
    skipReasonCounts,
    firstRebuiltDate: rebuiltSorted[0] || null,
    lastRebuiltDate: rebuiltSorted[rebuiltSorted.length - 1] || null,
    rebuiltTradeDates: rebuiltSorted,
    summaryLine: `Context backfill run: rebuilt ${rebuiltSorted.length}/${scannedRows.length || 0} missing-context dates.`,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyTruthBlockerDiagnostics(input = {}) {
  const candidateRows = Array.isArray(input?.candidateRows) ? input.candidateRows : [];
  const blockerCounts = {};
  let readyNowCount = 0;
  let blockedCount = 0;
  let locallyRepairable = 0;
  let externalDependency = 0;
  let mixed = 0;
  for (const row of candidateRows) {
    const reasons = Array.isArray(row?.blockReasons)
      ? row.blockReasons.map((reason) => toText(reason || '').toLowerCase() || LATE_ENTRY_TRUTH_BLOCKER_UNKNOWN).filter(Boolean)
      : [];
    if (row?.isReadyNow === true) {
      readyNowCount += 1;
    } else {
      blockedCount += 1;
      if (reasons.length === 0) {
        blockerCounts[LATE_ENTRY_TRUTH_BLOCKER_UNKNOWN] = Number(blockerCounts[LATE_ENTRY_TRUTH_BLOCKER_UNKNOWN] || 0) + 1;
      }
      for (const reason of reasons) {
        blockerCounts[reason] = Number(blockerCounts[reason] || 0) + 1;
      }
    }
    const hasExternal = reasons.some((reason) => LATE_ENTRY_TRUTH_EXTERNAL_BLOCKER_SET.has(reason));
    const hasLocal = reasons.some((reason) => LATE_ENTRY_TRUTH_LOCAL_BLOCKER_SET.has(reason));
    if (hasExternal && hasLocal) mixed += 1;
    else if (hasExternal) externalDependency += 1;
    else if (hasLocal || row?.isReadyNow === true) locallyRepairable += 1;
  }
  const dominantBlocker = Object.entries(blockerCounts)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0] || null;
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    eligibleDays: candidateRows.length,
    readyNowCount,
    blockedCount,
    blockerCounts,
    blockerBuckets: {
      locallyRepairable,
      externalDependency,
      mixed,
    },
    dominantBlocker,
    summaryLine: `Truth blocker diagnostics: ${readyNowCount}/${candidateRows.length || 0} ready; dominant blocker ${dominantBlocker || 'none'}.`,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyTruthDependencySplit(input = {}) {
  const candidateRows = Array.isArray(input?.candidateRows) ? input.candidateRows : [];
  const maxSample = Math.max(1, Math.min(20, Number(input?.maxSample || 10)));
  const locallyUnlockable = [];
  const externalTruthRequired = [];
  const fullyBlocked = [];
  for (const row of candidateRows) {
    const reasons = Array.isArray(row?.blockReasons)
      ? row.blockReasons.map((reason) => toText(reason || '').toLowerCase()).filter(Boolean)
      : [];
    const hasExternal = reasons.some((reason) => LATE_ENTRY_TRUTH_EXTERNAL_BLOCKER_SET.has(reason));
    const hasLocal = reasons.some((reason) => LATE_ENTRY_TRUTH_LOCAL_BLOCKER_SET.has(reason));
    const entry = {
      tradeDate: normalizeDate(row?.tradeDate || ''),
      blockReasons: reasons,
    };
    if (!entry.tradeDate) continue;
    if (row?.isReadyNow === true || (!hasExternal && hasLocal)) {
      locallyUnlockable.push(entry);
    } else if (hasExternal && !hasLocal) {
      externalTruthRequired.push(entry);
    } else {
      fullyBlocked.push(entry);
    }
  }
  const byDesc = (a, b) => String(b.tradeDate || '').localeCompare(String(a.tradeDate || ''));
  locallyUnlockable.sort(byDesc);
  externalTruthRequired.sort(byDesc);
  fullyBlocked.sort(byDesc);
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    totalEligibleDays: candidateRows.length,
    locallyUnlockableDays: locallyUnlockable.length,
    externalTruthRequiredDays: externalTruthRequired.length,
    fullyBlockedDays: fullyBlocked.length,
    locallyUnlockableSample: locallyUnlockable.slice(0, maxSample),
    externalTruthRequiredSample: externalTruthRequired.slice(0, maxSample),
    summaryLine: `Truth dependency split: local ${locallyUnlockable.length}, external ${externalTruthRequired.length}, fully blocked ${fullyBlocked.length}.`,
    advisoryOnly: true,
  };
}

function classifyLateEntryPolicyTruthFinalizationBlocker(input = {}) {
  const tradeDate = normalizeDate(input?.tradeDate || '') || null;
  const hasReplayRow = input?.hasReplayRow === true;
  const hasPolicyRows = input?.hasPolicyRows === true;
  const hasContextRow = input?.hasContextRow === true;
  const hasSessionCandles = input?.hasSessionCandles === true;
  const hasExternalTruth = input?.hasExternalTruth === true;
  const hasCheckpointRow = input?.hasCheckpointRow === true;
  const checkpointExternallyFinalized = input?.checkpointExternallyFinalized === true;
  const needsExternalCloseTruth = !hasExternalTruth;
  const canDeriveOutcomeFromExistingData = (
    hasCheckpointRow
    || (hasReplayRow && hasPolicyRows && hasContextRow && hasSessionCandles)
  );
  const needsBackfillRepair = hasExternalTruth && !checkpointExternallyFinalized;
  const blockReasons = [];
  if (!hasReplayRow) blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_MISSING_REPLAY);
  if (!hasPolicyRows) blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_INCOMPLETE_POLICY);
  if (!hasContextRow) blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_MISSING_CONTEXT);
  if (!hasCheckpointRow && !hasSessionCandles) blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_MISSING_CANDLES);
  if (needsExternalCloseTruth) blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_NEEDS_EXTERNAL);
  if (checkpointExternallyFinalized) blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_ALREADY_FINALIZED);
  if (needsBackfillRepair && !canDeriveOutcomeFromExistingData) {
    blockReasons.push(LATE_ENTRY_TRUTH_BLOCKER_INSUFFICIENT_LOCAL);
  }
  const isReadyNow = (
    needsBackfillRepair
    && canDeriveOutcomeFromExistingData
    && !needsExternalCloseTruth
  );
  const summaryLine = isReadyNow
    ? `Truth finalization candidate ${tradeDate || 'unknown'} is ready now.`
    : `Truth finalization candidate ${tradeDate || 'unknown'} is blocked: ${blockReasons.join(', ') || 'unknown_reason'}.`;
  return {
    tradeDate,
    isReadyNow,
    blockReasons,
    hasReplayRow,
    hasPolicyRows,
    hasContextRow,
    hasSessionCandles,
    hasExternalTruth,
    hasCheckpointRow,
    checkpointExternallyFinalized,
    canDeriveOutcomeFromExistingData,
    needsExternalCloseTruth,
    needsBackfillRepair,
    summaryLine,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyTruthFinalizationQueue(input = {}) {
  const db = input?.db;
  if (!db || typeof db.prepare !== 'function') return { queue: null, candidateRows: [], scopedCandidateRows: [] };
  const sourceType = normalizeSourceType(input?.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(
    input?.reconstructionPhase || PHASE_LIVE_INTRADAY,
    sourceType
  );
  const repairScope = normalizeLateEntryTruthRepairScope(input?.repairScope);
  const maxReadyDates = Math.max(1, Math.min(100, Number(input?.maxReadyDates || 25)));
  const maxBlockedSample = Math.max(1, Math.min(100, Number(input?.maxBlockedSample || 20)));
  const laneData = input?.laneData && typeof input.laneData === 'object'
    ? input.laneData
    : buildLateEntryLaneRowsByDate(db, {
      sourceType,
      reconstructionPhase,
      maxRows: Number(input?.maxRows || 10000),
    });
  const v5ByDate = laneData?.laneRowsByDate?.v5 instanceof Map ? laneData.laneRowsByDate.v5 : new Map();
  const eligibleDates = Array.from(v5ByDate.entries())
    .filter(([, row]) => row?.wouldExtensionPolicyTakeTrade === true || row?.extensionPolicyDecision?.wouldTrade === true)
    .map(([date]) => normalizeDate(date))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const scopedDates = (() => {
    if (repairScope === LATE_ENTRY_TRUTH_REPAIR_SCOPE_LATEST_ONLY) return eligibleDates.slice(-1);
    if (repairScope === LATE_ENTRY_TRUTH_REPAIR_SCOPE_LATEST_10) return eligibleDates.slice(-10);
    return eligibleDates.slice();
  })();
  const scopedSet = new Set(scopedDates);
  const candidateRows = [];
  for (const tradeDate of eligibleDates) {
    const v5Row = v5ByDate.get(tradeDate) || null;
    const hasReplayRow = !!v5Row;
    const hasPolicyRows = ['v1', 'v2', 'v3', 'v4', 'v5'].every((lane) => laneData?.laneRowsByDate?.[lane]?.has(tradeDate));
    const contextRow = getRecommendationContextRow(db, {
      recDate: tradeDate,
      sourceType,
      reconstructionPhase,
    });
    const hasContextRow = !!contextRow;
    const hasSessionCandles = (
      (Array.isArray(input?.sessions?.[tradeDate]) && input.sessions[tradeDate].length > 0)
      || v5Row?.sourceCandlesComplete === true
    );
    const externalOutcome = resolveExternalExecutionOutcomeForDate(db, tradeDate);
    const hasExternalTruth = (
      externalOutcome?.hasRows === true
      && externalOutcome?.sourceBacked === true
      && (
        externalOutcome?.sourceInUse === REALIZED_TRUTH_SOURCE_PRIMARY
        || externalOutcome?.sourceInUse === REALIZED_TRUTH_SOURCE_SECONDARY
      )
    );
    const checkpointRow = getAssistantDecisionCheckpointRowForDate(db, tradeDate);
    const checkpointOutcomeJson = checkpointRow
      ? safeJsonParse(checkpointRow.outcome_json, {})
      : {};
    const checkpointExternal = checkpointOutcomeJson?.externalExecutionOutcome
      && typeof checkpointOutcomeJson.externalExecutionOutcome === 'object'
      ? checkpointOutcomeJson.externalExecutionOutcome
      : {};
    const checkpointExternallyFinalized = isLateEntryExternalOutcomeFinalized(checkpointExternal);
    const classified = classifyLateEntryPolicyTruthFinalizationBlocker({
      tradeDate,
      hasReplayRow,
      hasPolicyRows,
      hasContextRow,
      hasSessionCandles,
      hasExternalTruth,
      hasCheckpointRow: !!checkpointRow,
      checkpointExternallyFinalized,
    });
    candidateRows.push({
      ...classified,
      repairScopeIncluded: scopedSet.has(tradeDate),
      externalSourceInUse: normalizeRealizedTruthSource(externalOutcome?.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
      externalTrustClassification: normalizeShadowPlaybookDurabilityTrust(
        externalOutcome?.trustClassification || REALIZED_TRUTH_TRUST_UNTRUSTWORTHY
      ),
      advisoryOnly: true,
    });
  }
  const scopedCandidateRows = candidateRows.filter((row) => row.repairScopeIncluded === true);
  const readyAll = candidateRows.filter((row) => row.isReadyNow === true);
  const blockedAll = candidateRows.filter((row) => row.isReadyNow !== true);
  const readyScoped = scopedCandidateRows.filter((row) => row.isReadyNow === true);
  const blockReasonCounts = blockedAll.reduce((acc, row) => {
    const reasons = Array.isArray(row?.blockReasons) ? row.blockReasons : ['unknown_block_reason'];
    for (const reasonRaw of reasons) {
      const reason = toText(reasonRaw || '').toLowerCase() || 'unknown_block_reason';
      acc[reason] = Number(acc[reason] || 0) + 1;
    }
    return acc;
  }, {});
  const readyNowDates = readyScoped
    .map((row) => row.tradeDate)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))
    .slice(0, maxReadyDates);
  const blockedDatesSample = scopedCandidateRows
    .filter((row) => row.isReadyNow !== true)
    .sort((a, b) => String(b.tradeDate || '').localeCompare(String(a.tradeDate || '')))
    .slice(0, maxBlockedSample)
    .map((row) => ({
      tradeDate: row.tradeDate,
      blockReasons: Array.isArray(row.blockReasons) ? row.blockReasons : [],
      summaryLine: row.summaryLine,
    }));
  const queue = {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    repairScope,
    totalCandidates: candidateRows.length,
    scopedCandidates: scopedCandidateRows.length,
    readyNowCount: readyAll.length,
    scopedReadyNowCount: readyScoped.length,
    blockedCount: blockedAll.length,
    oldestReadyDate: readyAll.length > 0
      ? readyAll.map((row) => row.tradeDate).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)))[0]
      : null,
    newestReadyDate: readyAll.length > 0
      ? readyAll.map((row) => row.tradeDate).filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0]
      : null,
    readyNowDates,
    blockedDatesSample,
    blockReasonCounts,
    summaryLine: `Truth finalization queue (${repairScope}): ${readyScoped.length}/${scopedCandidateRows.length || 0} scoped candidates ready now (${readyAll.length}/${candidateRows.length || 0} across all eligible dates).`,
    advisoryOnly: true,
  };
  return {
    queue,
    candidateRows,
    scopedCandidateRows,
  };
}

function refreshAssistantCheckpointExternalExecutionOutcome(input = {}) {
  const db = input?.db;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, status: 'db_unavailable', changed: false, beforeFinalized: false, afterFinalized: false };
  }
  const tradeDate = normalizeDate(input?.tradeDate || '');
  if (!tradeDate) {
    return { ok: false, status: 'invalid_trade_date', changed: false, beforeFinalized: false, afterFinalized: false };
  }
  const row = getAssistantDecisionCheckpointRowForDate(db, tradeDate);
  if (!row) {
    return { ok: false, status: 'checkpoint_missing', changed: false, beforeFinalized: false, afterFinalized: false };
  }
  const outcomeJson = safeJsonParse(row?.outcome_json, {});
  const previousExternal = outcomeJson?.externalExecutionOutcome
    && typeof outcomeJson.externalExecutionOutcome === 'object'
    ? outcomeJson.externalExecutionOutcome
    : {};
  const beforeFinalized = isLateEntryExternalOutcomeFinalized(previousExternal);
  const externalExecutionOutcome = resolveExternalExecutionOutcomeForDate(db, tradeDate);
  const refreshedExternal = buildCheckpointExternalExecutionPayload(externalExecutionOutcome, tradeDate);
  const divergence = classifyModelVsRealizedDivergence({
    classification: normalizeAssistantDecisionOutcomeClassification(row?.realized_outcome_classification || ''),
    actionNow: toText(row?.front_line_action_now || '') || null,
    posture: toText(row?.posture || '') || null,
    blockerState: toText(row?.blocker_state || '') || null,
    actualTradeTaken: Number(row?.actual_trade_taken || 0) === 1,
    externalExecutionOutcome,
  });
  const refreshedDivergence = {
    classification: normalizeModelVsRealizedDivergenceClassification(divergence.classification),
    detected: divergence.detected === true,
    reason: toText(divergence.reason || '') || null,
  };
  const previousDivergence = outcomeJson?.modelVsRealizedDivergence
    && typeof outcomeJson.modelVsRealizedDivergence === 'object'
    ? outcomeJson.modelVsRealizedDivergence
    : {};
  const externalChanged = JSON.stringify(previousExternal) !== JSON.stringify(refreshedExternal);
  const divergenceChanged = JSON.stringify(previousDivergence) !== JSON.stringify(refreshedDivergence);
  const changed = externalChanged || divergenceChanged;
  if (changed) {
    const nextOutcomeJson = {
      ...(outcomeJson && typeof outcomeJson === 'object' ? outcomeJson : {}),
      externalExecutionOutcome: refreshedExternal,
      modelVsRealizedDivergence: refreshedDivergence,
    };
    db.prepare(`
      UPDATE jarvis_assistant_decision_outcome_checkpoints
      SET outcome_json = ?, updated_at = datetime('now')
      WHERE trade_date = ?
    `).run(JSON.stringify(nextOutcomeJson), tradeDate);
  }
  const afterFinalized = isLateEntryExternalOutcomeFinalized(refreshedExternal);
  return {
    ok: true,
    status: changed ? 'updated' : 'unchanged',
    changed,
    beforeFinalized,
    afterFinalized,
    externalSourceInUse: normalizeRealizedTruthSource(refreshedExternal?.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
    tradeDate,
  };
}

function runLateEntryPolicyTruthBackfillRun(input = {}) {
  const db = input?.db;
  if (!db || typeof db.prepare !== 'function') return null;
  const candidateRows = Array.isArray(input?.candidateRows) ? input.candidateRows : [];
  const sourceType = normalizeSourceType(input?.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(
    input?.reconstructionPhase || PHASE_LIVE_INTRADAY,
    sourceType
  );
  const sessions = input?.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const strategySnapshot = input?.strategySnapshot && typeof input.strategySnapshot === 'object'
    ? input.strategySnapshot
    : {};
  const runTradeMechanicsVariantTool = input?.runTradeMechanicsVariantTool;

  const repairedTradeDates = [];
  const finalizedTradeDates = [];
  const skippedTradeDates = [];
  const skipReasonCounts = {};
  let unchangedDates = 0;
  for (const candidate of candidateRows) {
    const tradeDate = normalizeDate(candidate?.tradeDate || '');
    if (!tradeDate) {
      skippedTradeDates.push(null);
      skipReasonCounts.invalid_trade_date = Number(skipReasonCounts.invalid_trade_date || 0) + 1;
      continue;
    }
    if (candidate?.isReadyNow !== true) {
      skippedTradeDates.push(tradeDate);
      const reasons = Array.isArray(candidate?.blockReasons) ? candidate.blockReasons : ['blocked'];
      for (const reasonRaw of reasons) {
        const reason = toText(reasonRaw || '').toLowerCase() || 'blocked';
        skipReasonCounts[reason] = Number(skipReasonCounts[reason] || 0) + 1;
      }
      continue;
    }
    let beforeFinalized = candidate?.checkpointExternallyFinalized === true;
    let afterFinalized = beforeFinalized;
    let repaired = false;
    if (candidate?.hasCheckpointRow === true) {
      const refreshResult = refreshAssistantCheckpointExternalExecutionOutcome({
        db,
        tradeDate,
      });
      if (refreshResult?.ok === true) {
        repaired = refreshResult.changed === true;
        beforeFinalized = refreshResult.beforeFinalized === true;
        afterFinalized = refreshResult.afterFinalized === true;
      } else {
        skippedTradeDates.push(tradeDate);
        const reason = toText(refreshResult?.status || 'checkpoint_refresh_failed').toLowerCase() || 'checkpoint_refresh_failed';
        skipReasonCounts[reason] = Number(skipReasonCounts[reason] || 0) + 1;
        continue;
      }
    } else {
      const contextRow = getRecommendationContextRow(db, {
        recDate: tradeDate,
        sourceType,
        reconstructionPhase,
      });
      if (!contextRow) {
        skippedTradeDates.push(tradeDate);
        skipReasonCounts.missing_context_row = Number(skipReasonCounts.missing_context_row || 0) + 1;
        continue;
      }
      try {
        evaluateRecommendationOutcomeDay({
          db,
          date: tradeDate,
          contextRow,
          sessions,
          strategySnapshot,
          runTradeMechanicsVariantTool,
        });
      } catch {
        skippedTradeDates.push(tradeDate);
        skipReasonCounts.checkpoint_rebuild_failed = Number(skipReasonCounts.checkpoint_rebuild_failed || 0) + 1;
        continue;
      }
      const refreshResult = refreshAssistantCheckpointExternalExecutionOutcome({
        db,
        tradeDate,
      });
      if (refreshResult?.ok === true) {
        repaired = true;
        beforeFinalized = refreshResult.beforeFinalized === true;
        afterFinalized = refreshResult.afterFinalized === true;
      } else {
        skippedTradeDates.push(tradeDate);
        const reason = toText(refreshResult?.status || 'checkpoint_refresh_failed').toLowerCase() || 'checkpoint_refresh_failed';
        skipReasonCounts[reason] = Number(skipReasonCounts[reason] || 0) + 1;
        continue;
      }
    }
    if (repaired) repairedTradeDates.push(tradeDate);
    else unchangedDates += 1;
    if (!beforeFinalized && afterFinalized) finalizedTradeDates.push(tradeDate);
  }

  const repairedSorted = repairedTradeDates
    .map((date) => normalizeDate(date))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const summary = {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    repairScope: normalizeLateEntryTruthRepairScope(input?.repairScope),
    scannedDates: candidateRows.length,
    repairedDates: repairedSorted.length,
    newlyFinalizedDates: finalizedTradeDates.length,
    unchangedDates,
    skippedDates: skippedTradeDates.filter(Boolean).length,
    skipReasonCounts,
    firstRepairedDate: repairedSorted[0] || null,
    lastRepairedDate: repairedSorted[repairedSorted.length - 1] || null,
    repairedTradeDates: repairedSorted,
    newlyFinalizedTradeDates: finalizedTradeDates
      .map((date) => normalizeDate(date))
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b))),
    summaryLine: `Truth backfill run (${normalizeLateEntryTruthRepairScope(input?.repairScope)}): repaired ${repairedSorted.length}/${candidateRows.length || 0} scoped candidates, newly finalized ${finalizedTradeDates.length}.`,
    advisoryOnly: true,
  };
  return summary;
}

function buildLateEntryPolicyCoverageAccelerationSummary(input = {}) {
  const before = input?.before && typeof input.before === 'object' ? input.before : {};
  const after = input?.after && typeof input.after === 'object' ? input.after : {};
  const toPct = (value) => Number.isFinite(toFiniteNumberOrNull(value)) ? round2(toFiniteNumberOrNull(value)) : null;
  const toCount = (value) => Number.isFinite(toFiniteNumberOrNull(value)) ? Number(toFiniteNumberOrNull(value)) : 0;
  const beforeObj = {
    externallyFinalizedEligibleDays: toCount(before?.externallyFinalizedEligibleDays),
    externalCoveragePct: toPct(before?.externalCoveragePct),
    rolling5CoveragePct: toPct(before?.rolling5CoveragePct),
    rolling10CoveragePct: toPct(before?.rolling10CoveragePct),
  };
  const afterObj = {
    externallyFinalizedEligibleDays: toCount(after?.externallyFinalizedEligibleDays),
    externalCoveragePct: toPct(after?.externalCoveragePct),
    rolling5CoveragePct: toPct(after?.rolling5CoveragePct),
    rolling10CoveragePct: toPct(after?.rolling10CoveragePct),
  };
  const deltaNum = (a, b) => {
    if (!Number.isFinite(toFiniteNumberOrNull(a)) || !Number.isFinite(toFiniteNumberOrNull(b))) return null;
    return round2(toFiniteNumberOrNull(b) - toFiniteNumberOrNull(a));
  };
  const deltas = {
    externallyFinalizedEligibleDaysDelta: toCount(afterObj.externallyFinalizedEligibleDays) - toCount(beforeObj.externallyFinalizedEligibleDays),
    externalCoveragePctDelta: deltaNum(beforeObj.externalCoveragePct, afterObj.externalCoveragePct),
    rolling5CoveragePctDelta: deltaNum(beforeObj.rolling5CoveragePct, afterObj.rolling5CoveragePct),
    rolling10CoveragePctDelta: deltaNum(beforeObj.rolling10CoveragePct, afterObj.rolling10CoveragePct),
  };
  const movedNeedle = (
    Number(deltas.externallyFinalizedEligibleDaysDelta || 0) > 0
    || Number(deltas.externalCoveragePctDelta || 0) > 0
    || Number(deltas.rolling5CoveragePctDelta || 0) > 0
    || Number(deltas.rolling10CoveragePctDelta || 0) > 0
  );
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    before: beforeObj,
    after: afterObj,
    deltas,
    movedNeedle,
    summaryLine: movedNeedle
      ? `Coverage acceleration moved the needle: finalized eligible +${deltas.externallyFinalizedEligibleDaysDelta}, coverage ${deltas.externalCoveragePctDelta >= 0 ? '+' : ''}${deltas.externalCoveragePctDelta || 0} pts.`
      : 'Coverage acceleration did not move finalized-truth coverage in this run.',
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyPromotionDossier(input = {}) {
  const shadowLeader = input?.shadowLeader && typeof input.shadowLeader === 'object'
    ? input.shadowLeader
    : null;
  const commonDateComparison = input?.commonDateComparison && typeof input.commonDateComparison === 'object'
    ? input.commonDateComparison
    : null;
  const readinessPanel = input?.readinessPanel && typeof input.readinessPanel === 'object'
    ? input.readinessPanel
    : null;
  if (!readinessPanel) return null;
  const strictSummaryByLane = commonDateComparison?.strictCommonDateSummaryByLane
    && typeof commonDateComparison.strictCommonDateSummaryByLane === 'object'
    ? commonDateComparison.strictCommonDateSummaryByLane
    : {};
  const commonDateDeltas = commonDateComparison?.commonDateDeltas
    && typeof commonDateComparison.commonDateDeltas === 'object'
    ? commonDateComparison.commonDateDeltas
    : {};
  const pocketMap = input?.pocketMap && typeof input.pocketMap === 'object'
    ? input.pocketMap
    : null;
  const v5VsV4Delta = input?.v5VsV4Delta && typeof input.v5VsV4Delta === 'object'
    ? input.v5VsV4Delta
    : null;
  const v5LaneIsLeader = toText(shadowLeader?.laneKey || '').toLowerCase() === 'v5';
  const strictTrustStatus = toText(shadowLeader?.strictCommonDateTrustStatus || '').toLowerCase() || 'not_trustworthy';
  const readinessStatus = normalizeLateEntryPolicyPromotionStatus(
    readinessPanel?.status || LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY
  );
  const readyForManualReview = (
    readinessStatus === LATE_ENTRY_POLICY_PROMOTION_PROMOTABLE_FOR_REVIEW
    && strictTrustStatus === 'trustworthy'
    && v5LaneIsLeader
  );
  const manualReviewReason = readyForManualReview
    ? 'coverage_and_trust_thresholds_satisfied_for_manual_review'
    : (
      !v5LaneIsLeader
        ? 'v5_not_current_shadow_leader'
        : (
          strictTrustStatus !== 'trustworthy'
            ? 'strict_common_date_trust_not_clean'
            : (
              Array.isArray(readinessPanel?.blockReasons) && readinessPanel.blockReasons.length > 0
                ? readinessPanel.blockReasons[0]
                : readinessStatus
            )
        )
    );
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    strictCommonDateTrustStatus: strictTrustStatus,
    performanceSnapshot: {
      baseline_1100: strictSummaryByLane?.baseline_1100?.stats || null,
      v1: strictSummaryByLane?.v1?.stats || null,
      v4: strictSummaryByLane?.v4?.stats || null,
      v5: strictSummaryByLane?.v5?.stats || null,
      deltas: {
        v5_vs_v4: commonDateDeltas?.v5_vs_v4 || input?.v5VsV4Delta || null,
        v5_vs_v1: commonDateDeltas?.v5_vs_v1 || input?.v5VsV1Delta || null,
      },
    },
    truthCoverageSnapshot: {
      status: readinessStatus,
      blockReasons: Array.isArray(readinessPanel?.blockReasons) ? [...readinessPanel.blockReasons] : [],
      observed: readinessPanel?.observed && typeof readinessPanel.observed === 'object'
        ? { ...readinessPanel.observed }
        : {},
      thresholds: readinessPanel?.thresholds && typeof readinessPanel.thresholds === 'object'
        ? { ...readinessPanel.thresholds }
        : {},
    },
    evidenceSummary: {
      rescuedWinnersVsV4: Number(v5VsV4Delta?.rescuedWinners || 0),
      addedLosersVsV4: Number(v5VsV4Delta?.addedLosers || 0),
      strongestPockets: Array.isArray(pocketMap?.strongestPockets) ? pocketMap.strongestPockets.slice(0, 3) : [],
      blockedRiskPockets: Array.isArray(pocketMap?.blockedRiskPockets) ? pocketMap.blockedRiskPockets.slice(0, 3) : [],
    },
    manualReviewVerdict: readyForManualReview ? 'ready_for_manual_review' : 'not_ready',
    manualReviewReason,
    summaryLine: readyForManualReview
      ? 'Promotion dossier ready: v5 meets manual review prerequisites.'
      : `Promotion dossier blocked: ${manualReviewReason.replace(/_/g, ' ')}.`,
    advisoryOnly: true,
  };
}

function buildLateEntryPolicyManualReviewTrigger(input = {}) {
  const readinessPanel = input?.readinessPanel && typeof input.readinessPanel === 'object'
    ? input.readinessPanel
    : null;
  const shadowLeader = input?.shadowLeader && typeof input.shadowLeader === 'object'
    ? input.shadowLeader
    : null;
  const dossier = input?.dossier && typeof input.dossier === 'object'
    ? input.dossier
    : null;
  if (!readinessPanel || !dossier) return null;
  const thresholds = readinessPanel?.thresholds && typeof readinessPanel.thresholds === 'object'
    ? readinessPanel.thresholds
    : {};
  const observed = readinessPanel?.observed && typeof readinessPanel.observed === 'object'
    ? readinessPanel.observed
    : {};
  const checks = [
    {
      key: 'v5_is_shadow_leader',
      pass: toText(shadowLeader?.laneKey || '').toLowerCase() === 'v5',
      failReason: 'v5_not_current_shadow_leader',
    },
    {
      key: 'strict_common_date_trustworthy',
      pass: toText(shadowLeader?.strictCommonDateTrustStatus || '').toLowerCase() === 'trustworthy',
      failReason: 'strict_common_date_trust_not_clean',
    },
    {
      key: 'sample_days_threshold',
      pass: Number(observed?.trackedDays || 0) >= Number(thresholds?.minSampleDays || 0),
      failReason: 'sample_days_below_threshold',
    },
    {
      key: 'policy_added_trades_threshold',
      pass: Number(observed?.policyAddedTrades || 0) >= Number(thresholds?.minPolicyAddedTrades || 0),
      failReason: 'policy_added_trades_below_threshold',
    },
    {
      key: 'external_coverage_threshold',
      pass: Number(observed?.externalCoveragePct || 0) >= Number(thresholds?.minExternalCoveragePct || 0),
      failReason: 'external_coverage_below_threshold',
    },
    {
      key: 'rolling5_coverage_threshold',
      pass: Number(observed?.rolling5ExternalCoveragePct || 0) >= Number(thresholds?.minRolling5ExternalCoveragePct || 0),
      failReason: 'rolling5_coverage_below_threshold',
    },
    {
      key: 'rolling10_coverage_threshold',
      pass: Number(observed?.rolling10ExternalCoveragePct || 0) >= Number(thresholds?.minRolling10ExternalCoveragePct || 0),
      failReason: 'rolling10_coverage_below_threshold',
    },
  ];
  const satisfiedChecks = checks.filter((check) => check.pass).map((check) => check.key);
  const unsatisfiedChecks = checks.filter((check) => !check.pass).map((check) => check.key);
  const shouldOpenManualReview = (
    dossier?.manualReviewVerdict === 'ready_for_manual_review'
    && unsatisfiedChecks.length === 0
  );
  const nextUnlockCondition = unsatisfiedChecks[0]
    || (Array.isArray(readinessPanel?.blockReasons) && readinessPanel.blockReasons[0])
    || null;
  return {
    candidateLane: 'v5',
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    shouldOpenManualReview,
    status: shouldOpenManualReview ? 'ready_for_manual_review' : normalizeLateEntryPolicyPromotionStatus(readinessPanel?.status || ''),
    satisfiedChecks,
    unsatisfiedChecks,
    nextUnlockCondition,
    summaryLine: shouldOpenManualReview
      ? 'Manual review trigger: ready to open v5 promotion review.'
      : `Manual review trigger blocked: next unlock condition ${toText(nextUnlockCondition || 'unknown').replace(/_/g, ' ')}.`,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyExperiment(scorecards = [], options = {}) {
  const rows = [];
  const policyKeyInput = toText(options?.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const isV2Policy = isV2PolicyKey(policyKeyInput);
  const isV3Policy = isV3PolicyKey(policyKeyInput);
  const isV4Policy = isV4PolicyKey(policyKeyInput);
  const isV5Policy = isV5PolicyKey(policyKeyInput);
  const policyLinePrefix = isV5Policy
    ? 'Late-entry Skip 2 extension v5 (shadow)'
    : (isV4Policy
      ? 'Late-entry Skip 2 extension v4 (shadow)'
      : (isV3Policy
        ? 'Late-entry Skip 2 extension v3 (shadow)'
        : (isV2Policy
          ? 'Late-entry Skip 2 extension v2 (shadow)'
          : 'Late-entry Skip 2 extension (shadow)')));
  const db = options?.db;
  const persistedRows = db && typeof db.prepare === 'function'
    ? listLateEntryPolicyExperimentRows(db, {
      policyKey: options?.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY,
      policyVersion: options?.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
      source: options?.sourceType || options?.source || 'all',
      reconstructionPhase: options?.reconstructionPhase || '',
      maxRows: options?.maxRows || 5000,
    })
    : [];
  const externalExecutionByDate = new Map();
  if (db && typeof db.prepare === 'function' && persistedRows.length > 0 && tableExists(db, 'jarvis_assistant_decision_outcome_checkpoints')) {
    try {
      const checkpointRows = db.prepare(`
        SELECT trade_date, outcome_json
        FROM jarvis_assistant_decision_outcome_checkpoints
      `).all();
      for (const checkpointRow of checkpointRows) {
        const tradeDate = normalizeDate(checkpointRow?.trade_date || '');
        if (!tradeDate) continue;
        const outcomeJson = safeJsonParse(checkpointRow?.outcome_json, {});
        const externalExecution = outcomeJson?.externalExecutionOutcome
          && typeof outcomeJson.externalExecutionOutcome === 'object'
          ? outcomeJson.externalExecutionOutcome
          : {};
        externalExecutionByDate.set(tradeDate, externalExecution);
      }
    } catch {}
  }
  if (persistedRows.length > 0) {
    for (const persistedRow of persistedRows) {
      const summary = safeJsonParse(persistedRow?.summary_json, {});
      const tradeDate = normalizeDate(persistedRow?.trade_date || '');
      if (!tradeDate) continue;
      rows.push({
        tradeDate,
        policyKey: toText(persistedRow?.policy_key || LATE_ENTRY_POLICY_EXPERIMENT_KEY),
        policyVersion: toText(persistedRow?.policy_version || LATE_ENTRY_POLICY_EXPERIMENT_VERSION),
        policyLane: toText(summary?.policyLane || '') || (
          isV5PolicyKey(toText(persistedRow?.policy_key || ''))
            ? 'v5'
            : (
              isV4PolicyKey(toText(persistedRow?.policy_key || ''))
                ? 'v4'
                : (
                  isV3PolicyKey(toText(persistedRow?.policy_key || ''))
                    ? 'v3'
                    : (isV2PolicyKey(toText(persistedRow?.policy_key || '')) ? 'v2' : 'v1')
                )
            )
        ),
        weekday: toText(persistedRow?.weekday || summary?.weekday || '') || null,
        regimeLabel: toText(persistedRow?.regime_label || summary?.regimeLabel || '') || null,
        confirmationTimeBucket: toText(persistedRow?.confirmation_time_bucket || summary?.diagnostics?.confirmationTimeBucket || '') || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN,
        baselineWouldTrade: Number(persistedRow?.baseline_would_trade || 0) === 1,
        extensionWouldTrade: Number(persistedRow?.extension_would_trade || 0) === 1,
        selectedOutcome: toText(persistedRow?.selected_outcome || '') || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        selectedPnl: Number.isFinite(toFiniteNumberOrNull(persistedRow?.selected_pnl))
          ? round2(toFiniteNumberOrNull(persistedRow.selected_pnl))
          : null,
        nearestOutcome: toText(persistedRow?.nearest_outcome || '') || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        nearestPnl: Number.isFinite(toFiniteNumberOrNull(persistedRow?.nearest_pnl))
          ? round2(toFiniteNumberOrNull(persistedRow.nearest_pnl))
          : null,
        skip1Outcome: toText(persistedRow?.skip1_outcome || '') || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        skip1Pnl: Number.isFinite(toFiniteNumberOrNull(persistedRow?.skip1_pnl))
          ? round2(toFiniteNumberOrNull(persistedRow.skip1_pnl))
          : null,
        skip2Outcome: toText(persistedRow?.skip2_outcome || '') || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        skip2Pnl: Number.isFinite(toFiniteNumberOrNull(persistedRow?.skip2_pnl))
          ? round2(toFiniteNumberOrNull(persistedRow.skip2_pnl))
          : null,
        policyComparisonLabel: toText(summary?.extensionPolicy?.comparisonLabel || '') || null,
        sourceCandlesComplete: Number(persistedRow?.source_candles_complete || 0) === 1,
        extensionGateEligible: summary?.extensionGate?.eligible === true,
        strongerClusterCandidate: summary?.extensionGate?.supportingMetrics?.historicallyStrongerCluster === true
          || summary?.strongerClusterCandidate === true,
        weakerClusterCandidate: summary?.extensionGate?.supportingMetrics?.historicallyWeakerCluster === true
          || summary?.weakerClusterCandidate === true,
        baselineDecision: summary?.baselineDecision && typeof summary.baselineDecision === 'object'
          ? summary.baselineDecision
          : (summary?.baseline && typeof summary.baseline === 'object' ? summary.baseline : {}),
        extensionPolicyDecision: summary?.extensionPolicyDecision && typeof summary.extensionPolicyDecision === 'object'
          ? summary.extensionPolicyDecision
          : (summary?.extensionPolicy && typeof summary.extensionPolicy === 'object' ? summary.extensionPolicy : {}),
        hard1200Replay: summary?.hard1200Replay && typeof summary.hard1200Replay === 'object'
          ? summary.hard1200Replay
          : (summary?.hard1200 && typeof summary.hard1200 === 'object' ? summary.hard1200 : {}),
        noCutoffReplay: summary?.noCutoffReplay && typeof summary.noCutoffReplay === 'object'
          ? summary.noCutoffReplay
          : (summary?.noCutoff && typeof summary.noCutoff === 'object' ? summary.noCutoff : {}),
        broadReplayReference: summary?.broadReplayReference && typeof summary.broadReplayReference === 'object'
          ? summary.broadReplayReference
          : null,
        tpReplayComparison: summary?.tpReplayComparison && typeof summary.tpReplayComparison === 'object'
          ? summary.tpReplayComparison
          : null,
        policyReplayClassification: normalizeLateEntryPolicyReplayStatus(summary?.policyReplayClassification || ''),
        v2ComparisonClassification: normalizeLateEntryPolicyV2Comparison(summary?.v2ComparisonClassification || ''),
        v3ComparisonClassification: normalizeLateEntryPolicyV3Comparison(summary?.v3ComparisonClassification || ''),
        v4ComparisonClassification: normalizeLateEntryPolicyV4Comparison(summary?.v4ComparisonClassification || ''),
        v5ComparisonClassification: normalizeLateEntryPolicyV5Comparison(summary?.v5ComparisonClassification || ''),
        v1Reference: summary?.v1Reference && typeof summary.v1Reference === 'object'
          ? summary.v1Reference
          : null,
        v3Reference: summary?.v3Reference && typeof summary.v3Reference === 'object'
          ? summary.v3Reference
          : null,
        replayWouldHaveTradedButPolicyRejected: summary?.replayWouldHaveTradedButPolicyRejected === true,
        policyReplayStatusLine: toText(summary?.policyReplayStatusLine || '') || null,
        baseline: summary?.baseline && typeof summary.baseline === 'object' ? summary.baseline : {},
        hard1200: summary?.hard1200 && typeof summary.hard1200 === 'object' ? summary.hard1200 : {},
        noCutoff: summary?.noCutoff && typeof summary.noCutoff === 'object' ? summary.noCutoff : {},
        externalExecution: externalExecutionByDate.get(tradeDate) || {},
      });
    }
  } else {
    for (const score of (Array.isArray(scorecards) ? scorecards : [])) {
      const summary = score?.lateEntryPolicyExperimentSummary && typeof score.lateEntryPolicyExperimentSummary === 'object'
        ? score.lateEntryPolicyExperimentSummary
        : null;
      if (!summary) continue;
      rows.push({
        tradeDate: normalizeDate(score?.date || summary.tradeDate || ''),
        policyKey: toText(summary?.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY),
        policyVersion: toText(summary?.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION),
        policyLane: toText(summary?.policyLane || '') || (
          isV5PolicyKey(toText(summary?.policyKey || ''))
            ? 'v5'
            : (
              isV4PolicyKey(toText(summary?.policyKey || ''))
                ? 'v4'
                : (
                  isV3PolicyKey(toText(summary?.policyKey || ''))
                    ? 'v3'
                    : (isV2PolicyKey(toText(summary?.policyKey || '')) ? 'v2' : 'v1')
                )
            )
        ),
        weekday: toText(summary.weekday || score?.weekday || '') || null,
        regimeLabel: toText(summary.regimeLabel || '') || null,
        confirmationTimeBucket: toText(summary.confirmationTimeBucket || '') || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN,
        baselineWouldTrade: summary.wouldBaselineTakeTrade === true,
        extensionWouldTrade: summary.wouldExtensionPolicyTakeTrade === true,
        selectedOutcome: summary?.selectedOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        selectedPnl: summary?.selectedOutcome?.pnl,
        nearestOutcome: summary?.nearestTpOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        nearestPnl: summary?.nearestTpOutcome?.pnl,
        skip1Outcome: summary?.skip1Outcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        skip1Pnl: summary?.skip1Outcome?.pnl,
        skip2Outcome: summary?.skip2Outcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        skip2Pnl: summary?.skip2Outcome?.pnl,
        policyComparisonLabel: toText(summary.policyComparisonLabel || '') || null,
        sourceCandlesComplete: summary.sourceCandlesComplete === true,
        extensionGateEligible: summary?.extensionGate?.eligible === true,
        strongerClusterCandidate: summary?.extensionGate?.supportingMetrics?.historicallyStrongerCluster === true
          || summary?.summaryJson?.strongerClusterCandidate === true,
        weakerClusterCandidate: summary?.extensionGate?.supportingMetrics?.historicallyWeakerCluster === true
          || summary?.summaryJson?.weakerClusterCandidate === true,
        baselineDecision: summary?.baselineDecision && typeof summary.baselineDecision === 'object'
          ? summary.baselineDecision
          : (summary?.baseline && typeof summary.baseline === 'object' ? summary.baseline : {}),
        extensionPolicyDecision: summary?.extensionPolicyDecision && typeof summary.extensionPolicyDecision === 'object'
          ? summary.extensionPolicyDecision
          : (summary?.extensionPolicy && typeof summary.extensionPolicy === 'object' ? summary.extensionPolicy : {}),
        hard1200Replay: summary?.hard1200Replay && typeof summary.hard1200Replay === 'object'
          ? summary.hard1200Replay
          : (summary?.hard1200 && typeof summary.hard1200 === 'object' ? summary.hard1200 : {}),
        noCutoffReplay: summary?.noCutoffReplay && typeof summary.noCutoffReplay === 'object'
          ? summary.noCutoffReplay
          : (summary?.noCutoff && typeof summary.noCutoff === 'object' ? summary.noCutoff : {}),
        broadReplayReference: summary?.broadReplayReference && typeof summary.broadReplayReference === 'object'
          ? summary.broadReplayReference
          : null,
        tpReplayComparison: summary?.tpReplayComparison && typeof summary.tpReplayComparison === 'object'
          ? summary.tpReplayComparison
          : null,
        policyReplayClassification: normalizeLateEntryPolicyReplayStatus(summary?.policyReplayClassification || ''),
        v2ComparisonClassification: normalizeLateEntryPolicyV2Comparison(summary?.v2ComparisonClassification || ''),
        v3ComparisonClassification: normalizeLateEntryPolicyV3Comparison(summary?.v3ComparisonClassification || ''),
        v4ComparisonClassification: normalizeLateEntryPolicyV4Comparison(summary?.v4ComparisonClassification || ''),
        v5ComparisonClassification: normalizeLateEntryPolicyV5Comparison(summary?.v5ComparisonClassification || ''),
        v1Reference: summary?.v1Reference && typeof summary.v1Reference === 'object'
          ? summary.v1Reference
          : null,
        v3Reference: summary?.v3Reference && typeof summary.v3Reference === 'object'
          ? summary.v3Reference
          : null,
        replayWouldHaveTradedButPolicyRejected: summary?.replayWouldHaveTradedButPolicyRejected === true,
        policyReplayStatusLine: toText(summary?.policyReplayStatusLine || '') || null,
        baseline: summary?.baseline && typeof summary.baseline === 'object' ? summary.baseline : {},
        hard1200: summary?.hard1200 && typeof summary.hard1200 === 'object' ? summary.hard1200 : {},
        noCutoff: summary?.noCutoff && typeof summary.noCutoff === 'object' ? summary.noCutoff : {},
        externalExecution: score?.assistantDecisionOutcomeCheckpoint?.externalExecutionOutcome
          && typeof score.assistantDecisionOutcomeCheckpoint.externalExecutionOutcome === 'object'
          ? score.assistantDecisionOutcomeCheckpoint.externalExecutionOutcome
          : {},
      });
    }
  }
  rows.sort((a, b) => String(a.tradeDate || '').localeCompare(String(b.tradeDate || '')));
  const modeKeys = [
    { key: 'Nearest', accessor: 'nearest' },
    { key: 'Skip 1', accessor: 'skip1' },
    { key: 'Skip 2', accessor: 'skip2' },
  ];
  const variantSeries = {
    baseline_1100: [],
    extension_policy: [],
    hard_1200: [],
    no_cutoff: [],
    broad_replay_reference: [],
  };
  const variantModeSeries = {
    baseline_1100: { Nearest: [], 'Skip 1': [], 'Skip 2': [] },
    extension_policy: { Nearest: [], 'Skip 1': [], 'Skip 2': [] },
    hard_1200: { Nearest: [], 'Skip 1': [], 'Skip 2': [] },
    no_cutoff: { Nearest: [], 'Skip 1': [], 'Skip 2': [] },
    broad_replay_reference: { Nearest: [], 'Skip 1': [], 'Skip 2': [] },
  };
  const lateEntrySubset = [];
  let rescuedOpportunities = 0;
  let rescuedLosses = 0;
  let policyAddedTrades = 0;
  let shadowBeatsBaselineCount = 0;
  let baselineBeatsShadowCount = 0;
  let equalToBaselineCount = 0;
  const replayClassificationCounts = {
    [LATE_ENTRY_POLICY_REPLAY_STATUS_REPLAY_POLICY_REJECTED]: 0,
    [LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_RESCUED_OPPORTUNITY]: 0,
    [LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_REJECTED_REPLAY_LOSS]: 0,
    [LATE_ENTRY_POLICY_REPLAY_STATUS_NO_REPLAY_TRADE_EXISTS]: 0,
    [LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_NO_TRADE]: 0,
    [LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_TRADE]: 0,
  };
  const baselinePolicyAlignmentCounts = {
    [LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_NO_TRADE]: 0,
    [LATE_ENTRY_POLICY_REPLAY_STATUS_BASELINE_POLICY_AGREE_TRADE]: 0,
  };

  const isExternallyFinalized = (externalOutcome = {}) => {
    const source = normalizeRealizedTruthSource(
      externalOutcome?.sourceInUse
      || externalOutcome?.sourceAttribution?.sourceInUse
      || REALIZED_TRUTH_SOURCE_NONE
    );
    const stale = externalOutcome?.sourceAttribution?.sourceFreshness?.targetDateInStaleWindow === true
      || externalOutcome?.sourceAttribution?.recoveryPlan?.targetDateInStaleWindow === true;
    if (stale) return false;
    if (source !== REALIZED_TRUTH_SOURCE_PRIMARY && source !== REALIZED_TRUTH_SOURCE_SECONDARY) return false;
    return externalOutcome?.sourceBacked === true && externalOutcome?.hasRows === true;
  };

  const externalFinalizedByDate = new Map();
  for (const row of rows) {
    externalFinalizedByDate.set(row.tradeDate, isExternallyFinalized(row.externalExecution));
    const baselineMode = row?.baseline?.modeOutcomes && typeof row.baseline.modeOutcomes === 'object'
      ? row.baseline.modeOutcomes
      : {};
    const hard12Mode = row?.hard1200?.modeOutcomes && typeof row.hard1200.modeOutcomes === 'object'
      ? row.hard1200.modeOutcomes
      : {};
    const noCutoffMode = row?.noCutoff?.modeOutcomes && typeof row.noCutoff.modeOutcomes === 'object'
      ? row.noCutoff.modeOutcomes
      : {};
    const broadReplayReference = row?.broadReplayReference && typeof row.broadReplayReference === 'object'
      ? row.broadReplayReference
      : selectLateEntryBroadReplayReference({
        hard1200: row?.hard1200Replay && typeof row.hard1200Replay === 'object' ? row.hard1200Replay : row?.hard1200,
        noCutoff: row?.noCutoffReplay && typeof row.noCutoffReplay === 'object' ? row.noCutoffReplay : row?.noCutoff,
      });
    const broadReplayMode = broadReplayReference?.modeOutcomes && typeof broadReplayReference.modeOutcomes === 'object'
      ? broadReplayReference.modeOutcomes
      : {};
    const baselineSkip2 = baselineMode?.skip2 || makeNoTradeModeOutcome();
    const extensionSkip2 = {
      outcome: row.skip2Outcome,
      pnl: row.skip2Pnl,
    };
    const hard12Skip2 = hard12Mode?.skip2 || makeNoTradeModeOutcome();
    const noCutoffSkip2 = noCutoffMode?.skip2 || makeNoTradeModeOutcome();
    const broadReplaySkip2 = broadReplayMode?.skip2 || makeNoTradeModeOutcome();
    const entryMinuteNoCutoff = minuteFromTimestamp(row?.noCutoff?.entryTime || '');
    const after1100NoCutoff = Number.isFinite(entryMinuteNoCutoff) && entryMinuteNoCutoff >= 660;
    const replayClassification = normalizeLateEntryPolicyReplayStatus(
      row?.policyReplayClassification
      || classifyLateEntryPolicyReplayStatus({
        baselineWouldTrade: row?.baselineWouldTrade === true,
        extensionWouldTrade: row?.extensionWouldTrade === true,
        broadReplayWouldTrade: broadReplayReference?.wouldTrade === true,
        broadReplaySelectedOutcome: resolveSelectedModeResult(
          broadReplayMode,
          row?.selectedTpMode || 'Skip 2'
        )?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        extensionSelectedOutcome: row?.selectedOutcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      })
    );
    replayClassificationCounts[replayClassification] = Number(replayClassificationCounts[replayClassification] || 0) + 1;
    const baselinePolicyAlignment = buildBaselinePolicyAlignmentStatus({
      baselineWouldTrade: row?.baselineWouldTrade === true,
      extensionWouldTrade: row?.extensionWouldTrade === true,
    });
    if (baselinePolicyAlignment) {
      baselinePolicyAlignmentCounts[baselinePolicyAlignment] = Number(baselinePolicyAlignmentCounts[baselinePolicyAlignment] || 0) + 1;
    }

    variantSeries.baseline_1100.push({
      tradeDate: row.tradeDate,
      outcome: baselineSkip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: baselineSkip2?.pnl,
      after1100: Number.isFinite(minuteFromTimestamp(row?.baseline?.entryTime || '')) && minuteFromTimestamp(row?.baseline?.entryTime || '') >= 660,
    });
    variantSeries.extension_policy.push({
      tradeDate: row.tradeDate,
      outcome: extensionSkip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: extensionSkip2?.pnl,
      after1100: Number.isFinite(minuteFromTimestamp(row?.entryTimestamp || row?.extensionPolicy?.entryTime || '')) && minuteFromTimestamp(row?.entryTimestamp || row?.extensionPolicy?.entryTime || '') >= 660,
    });
    variantSeries.hard_1200.push({
      tradeDate: row.tradeDate,
      outcome: hard12Skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: hard12Skip2?.pnl,
      after1100: Number.isFinite(minuteFromTimestamp(row?.hard1200?.entryTime || '')) && minuteFromTimestamp(row?.hard1200?.entryTime || '') >= 660,
    });
    variantSeries.no_cutoff.push({
      tradeDate: row.tradeDate,
      outcome: noCutoffSkip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: noCutoffSkip2?.pnl,
      after1100: after1100NoCutoff,
    });
    variantSeries.broad_replay_reference.push({
      tradeDate: row.tradeDate,
      outcome: broadReplaySkip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: broadReplaySkip2?.pnl,
      after1100: Number.isFinite(minuteFromTimestamp(broadReplayReference?.entryTime || ''))
        && minuteFromTimestamp(broadReplayReference?.entryTime || '') >= 660,
    });

    for (const mode of modeKeys) {
      const baselineModeOutcome = baselineMode?.[mode.accessor] || makeNoTradeModeOutcome();
      const hard12ModeOutcome = hard12Mode?.[mode.accessor] || makeNoTradeModeOutcome();
      const noCutoffModeOutcome = noCutoffMode?.[mode.accessor] || makeNoTradeModeOutcome();
      const broadReplayModeOutcome = broadReplayMode?.[mode.accessor] || makeNoTradeModeOutcome();
      const extensionModeOutcome = (
        mode.key === 'Nearest'
          ? { outcome: row.nearestOutcome, pnl: row.nearestPnl }
          : (mode.key === 'Skip 1'
            ? { outcome: row.skip1Outcome, pnl: row.skip1Pnl }
            : { outcome: row.skip2Outcome, pnl: row.skip2Pnl })
      );
      variantModeSeries.baseline_1100[mode.key].push({
        tradeDate: row.tradeDate,
        outcome: baselineModeOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        pnl: baselineModeOutcome?.pnl,
      });
      variantModeSeries.extension_policy[mode.key].push({
        tradeDate: row.tradeDate,
        outcome: extensionModeOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        pnl: extensionModeOutcome?.pnl,
      });
      variantModeSeries.hard_1200[mode.key].push({
        tradeDate: row.tradeDate,
        outcome: hard12ModeOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        pnl: hard12ModeOutcome?.pnl,
      });
      variantModeSeries.no_cutoff[mode.key].push({
        tradeDate: row.tradeDate,
        outcome: noCutoffModeOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        pnl: noCutoffModeOutcome?.pnl,
      });
      variantModeSeries.broad_replay_reference[mode.key].push({
        tradeDate: row.tradeDate,
        outcome: broadReplayModeOutcome?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        pnl: broadReplayModeOutcome?.pnl,
      });
    }

    if (row.policyComparisonLabel === 'rescued_opportunity') rescuedOpportunities += 1;
    if (row.policyComparisonLabel === 'rescued_loss') rescuedLosses += 1;
    if (row.baselineWouldTrade !== true && row.extensionWouldTrade === true) policyAddedTrades += 1;
    const extPnl = toFiniteNumberOrNull(row.skip2Pnl);
    const basePnl = toFiniteNumberOrNull(baselineSkip2?.pnl);
    if (Number.isFinite(extPnl) && Number.isFinite(basePnl)) {
      if (extPnl > basePnl) shadowBeatsBaselineCount += 1;
      else if (extPnl < basePnl) baselineBeatsShadowCount += 1;
      else equalToBaselineCount += 1;
    } else {
      equalToBaselineCount += 1;
    }
    if (row.noCutoff?.wouldTrade === true && after1100NoCutoff) {
      lateEntrySubset.push(row);
    }
  }

  const variantStats = {
    baseline_1100: computePnLStatsFromSeries(variantSeries.baseline_1100),
    extension_policy: computePnLStatsFromSeries(variantSeries.extension_policy),
    hard_1200: computePnLStatsFromSeries(variantSeries.hard_1200),
    no_cutoff: computePnLStatsFromSeries(variantSeries.no_cutoff),
    broad_replay_reference: computePnLStatsFromSeries(variantSeries.broad_replay_reference),
  };
  const variantModeStats = {};
  for (const [variantKey, modes] of Object.entries(variantModeSeries)) {
    variantModeStats[variantKey] = {};
    for (const mode of modeKeys) {
      variantModeStats[variantKey][mode.key] = computePnLStatsFromSeries(modes[mode.key]);
    }
  }

  const lateEntryModeSeries = {
    Nearest: [],
    'Skip 1': [],
    'Skip 2': [],
  };
  const weekdayBreakdown = {};
  const regimeBreakdown = {};
  for (const row of lateEntrySubset) {
    const noCutoffMode = row?.noCutoff?.modeOutcomes && typeof row.noCutoff.modeOutcomes === 'object'
      ? row.noCutoff.modeOutcomes
      : {};
    lateEntryModeSeries.Nearest.push({
      tradeDate: row.tradeDate,
      outcome: noCutoffMode?.nearest?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: noCutoffMode?.nearest?.pnl,
    });
    lateEntryModeSeries['Skip 1'].push({
      tradeDate: row.tradeDate,
      outcome: noCutoffMode?.skip1?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: noCutoffMode?.skip1?.pnl,
    });
    lateEntryModeSeries['Skip 2'].push({
      tradeDate: row.tradeDate,
      outcome: noCutoffMode?.skip2?.outcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      pnl: noCutoffMode?.skip2?.pnl,
    });
    const weekday = row.weekday || 'unknown';
    const regimeLabel = row.regimeLabel || 'unknown';
    weekdayBreakdown[weekday] = Number(weekdayBreakdown[weekday] || 0) + 1;
    regimeBreakdown[regimeLabel] = Number(regimeBreakdown[regimeLabel] || 0) + 1;
  }
  const lateEntryStats = {
    count: lateEntrySubset.length,
    profile: computePnLStatsFromSeries(lateEntryModeSeries['Skip 2']),
    tpModeComparison: {
      Nearest: computePnLStatsFromSeries(lateEntryModeSeries.Nearest),
      'Skip 1': computePnLStatsFromSeries(lateEntryModeSeries['Skip 1']),
      'Skip 2': computePnLStatsFromSeries(lateEntryModeSeries['Skip 2']),
    },
    dominantWeekday: Object.entries(weekdayBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    dominantRegime: Object.entries(regimeBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    weekdayBreakdown,
    regimeBreakdown,
  };
  const trackedDates = rows.map((row) => row.tradeDate).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
  const rolling5Dates = trackedDates.slice(-5);
  const rolling10Dates = trackedDates.slice(-10);
  const finalizedDates = trackedDates.filter((date) => externalFinalizedByDate.get(date) === true);
  const externalCoveragePct = trackedDates.length > 0
    ? round2((finalizedDates.length / trackedDates.length) * 100)
    : null;
  const rolling5Finalized = rolling5Dates.filter((date) => externalFinalizedByDate.get(date) === true);
  const rolling10Finalized = rolling10Dates.filter((date) => externalFinalizedByDate.get(date) === true);
  const rolling5ExternalCoveragePct = rolling5Dates.length > 0
    ? round2((rolling5Finalized.length / rolling5Dates.length) * 100)
    : null;
  const rolling10ExternalCoveragePct = rolling10Dates.length > 0
    ? round2((rolling10Finalized.length / rolling10Dates.length) * 100)
    : null;
  const unfinalizedTradeDates = trackedDates.filter((date) => externalFinalizedByDate.get(date) !== true);
  const externallyFinalizedEligibleDays = rows.filter((row) => row.extensionWouldTrade === true && externalFinalizedByDate.get(row.tradeDate) === true).length;
  const externallyUnfinalizedEligibleDays = rows.filter((row) => row.extensionWouldTrade === true && externalFinalizedByDate.get(row.tradeDate) !== true).length;

  let promotionReadinessStatus = LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY;
  const promotionReadinessBlockReasons = [];
  if (trackedDates.length < LATE_ENTRY_POLICY_MIN_SAMPLE_DAYS) {
    promotionReadinessBlockReasons.push('sample_size_below_threshold');
  }
  if (policyAddedTrades < LATE_ENTRY_POLICY_MIN_POLICY_ADDED_TRADES) {
    promotionReadinessBlockReasons.push('policy_added_trades_below_threshold');
  }
  if (!Number.isFinite(externalCoveragePct) || externalCoveragePct < LATE_ENTRY_POLICY_MIN_EXTERNAL_COVERAGE_PCT) {
    promotionReadinessBlockReasons.push('external_coverage_below_threshold');
  }
  if (
    rolling5Dates.length > 0
    && (
      !Number.isFinite(rolling5ExternalCoveragePct)
      || rolling5ExternalCoveragePct < LATE_ENTRY_POLICY_MIN_ROLLING5_EXTERNAL_COVERAGE_PCT
    )
  ) {
    promotionReadinessBlockReasons.push('stale_window_overlaps_rolling_5');
  }
  if (
    rolling10Dates.length > 0
    && (
      !Number.isFinite(rolling10ExternalCoveragePct)
      || rolling10ExternalCoveragePct < LATE_ENTRY_POLICY_MIN_ROLLING10_EXTERNAL_COVERAGE_PCT
    )
  ) {
    promotionReadinessBlockReasons.push('stale_window_overlaps_rolling_10');
  }
  const post1130Rows = rows.filter((row) => row.confirmationTimeBucket === LATE_ENTRY_POLICY_TIME_BUCKET_1130_1200);
  const post1130Stats = computePnLStatsFromSeries(post1130Rows.map((row) => ({
    tradeDate: row.tradeDate,
    outcome: row.skip2Outcome,
    pnl: row.skip2Pnl,
  })));
  if (
    post1130Rows.length >= 2
    && Number.isFinite(toFiniteNumberOrNull(post1130Stats.totalPnl))
    && Number(post1130Stats.totalPnl) <= LATE_ENTRY_POLICY_POST_1130_DRAG_WARN_PNL
  ) {
    promotionReadinessBlockReasons.push('post_1130_drag_detected');
  }
  const extensionVsBaselineDelta = (
    Number.isFinite(toFiniteNumberOrNull(variantStats.extension_policy.totalPnl))
    && Number.isFinite(toFiniteNumberOrNull(variantStats.baseline_1100.totalPnl))
  )
    ? round2(toFiniteNumberOrNull(variantStats.extension_policy.totalPnl) - toFiniteNumberOrNull(variantStats.baseline_1100.totalPnl))
    : null;

  const uniqueBlockReasons = Array.from(new Set(promotionReadinessBlockReasons));
  if (uniqueBlockReasons.length === 0) {
    promotionReadinessStatus = LATE_ENTRY_POLICY_PROMOTION_PROMOTABLE_FOR_REVIEW;
  } else if (
    uniqueBlockReasons.includes('external_coverage_below_threshold')
    || uniqueBlockReasons.includes('stale_window_overlaps_rolling_5')
    || uniqueBlockReasons.includes('stale_window_overlaps_rolling_10')
  ) {
    promotionReadinessStatus = LATE_ENTRY_POLICY_PROMOTION_BLOCK_TRUTH_COVERAGE;
  } else if (uniqueBlockReasons.includes('post_1130_drag_detected')) {
    promotionReadinessStatus = LATE_ENTRY_POLICY_PROMOTION_BLOCK_POST_1130_DRAG;
  } else if (
    Number.isFinite(extensionVsBaselineDelta)
    && extensionVsBaselineDelta > 0
  ) {
    promotionReadinessStatus = LATE_ENTRY_POLICY_PROMOTION_SHADOW_POSITIVE_NOT_READY;
  } else {
    promotionReadinessStatus = LATE_ENTRY_POLICY_PROMOTION_BLOCK_SAMPLE_INSTABILITY;
  }
  promotionReadinessStatus = normalizeLateEntryPolicyPromotionStatus(promotionReadinessStatus);

  let statusLine = `${policyLinePrefix}: unavailable.`;
  let replayReferenceLine = 'Late-entry broad replay reference: unavailable.';
  const replayWouldHaveTradedButPolicyRejectedCount = Number(
    replayClassificationCounts[LATE_ENTRY_POLICY_REPLAY_STATUS_REPLAY_POLICY_REJECTED]
    + replayClassificationCounts[LATE_ENTRY_POLICY_REPLAY_STATUS_POLICY_REJECTED_REPLAY_LOSS]
  );
  if (rows.length > 0) {
    const deltaText = Number.isFinite(extensionVsBaselineDelta)
      ? `${extensionVsBaselineDelta >= 0 ? '+' : ''}$${round2(extensionVsBaselineDelta)}`
      : 'N/A';
    const strongestRegime = lateEntryStats.dominantRegime || 'mixed';
    const strongestBucket = Object.entries(rows.reduce((acc, row) => {
      const key = row.confirmationTimeBucket || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN;
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {})).sort((a, b) => b[1] - a[1])[0]?.[0] || LATE_ENTRY_POLICY_TIME_BUCKET_UNKNOWN;
    statusLine = `${policyLinePrefix}: ${deltaText} vs baseline, ${policyAddedTrades} added trades, strongest around ${strongestBucket} in ${strongestRegime}.`;
    if (promotionReadinessStatus !== LATE_ENTRY_POLICY_PROMOTION_PROMOTABLE_FOR_REVIEW) {
      statusLine = `${statusLine} Not promotable yet (${promotionReadinessStatus.replace(/_/g, ' ')}).`;
    }
    const broadDelta = (
      Number.isFinite(toFiniteNumberOrNull(variantStats.broad_replay_reference.totalPnl))
      && Number.isFinite(toFiniteNumberOrNull(variantStats.baseline_1100.totalPnl))
    )
      ? round2(toFiniteNumberOrNull(variantStats.broad_replay_reference.totalPnl) - toFiniteNumberOrNull(variantStats.baseline_1100.totalPnl))
      : null;
    replayReferenceLine = `Late-entry broad replay reference (shadow): ${
      Number.isFinite(broadDelta) ? `${broadDelta >= 0 ? '+' : ''}$${broadDelta}` : 'N/A'
    } vs baseline, ${replayWouldHaveTradedButPolicyRejectedCount} replay trades rejected by current policy.`;
  }

  return {
    policyKey: toText(options?.policyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    policyVersion: toText(options?.policyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    trackedDays: rows.length,
    policyAddedTrades,
    rescuedOpportunities,
    rescuedLosses,
    replayClassificationCounts,
    baselinePolicyAlignmentCounts,
    replayWouldHaveTradedButPolicyRejectedCount,
    shadowBeatsBaselineCount,
    baselineBeatsShadowCount,
    equalToBaselineCount,
    variantStats,
    cutoffComparisonByTpMode: variantModeStats,
    broadReplayReference: {
      laneKey: LATE_ENTRY_BROAD_REPLAY_REFERENCE_KEY,
      variantKey: 'broad_replay_reference',
      stats: variantStats.broad_replay_reference,
      cutoffComparisonByTpMode: variantModeStats.broad_replay_reference,
      replayWouldHaveTradedButPolicyRejectedCount,
      line: replayReferenceLine,
      advisoryOnly: true,
    },
    lateEntryTradesOnly: lateEntryStats,
    externalFinalizedDays: finalizedDates.length,
    unfinalizedDays: unfinalizedTradeDates.length,
    externalCoveragePct,
    rolling5ExternalFinalizedDays: rolling5Finalized.length,
    rolling5ExternalCoveragePct,
    rolling10ExternalFinalizedDays: rolling10Finalized.length,
    rolling10ExternalCoveragePct,
    externallyFinalizedEligibleDays,
    externallyUnfinalizedEligibleDays,
    unfinalizedTradeDates,
    promotionReadinessStatus,
    promotionReadinessBlockReasons: uniqueBlockReasons,
    promotionReadinessThresholds: {
      minSampleDays: LATE_ENTRY_POLICY_MIN_SAMPLE_DAYS,
      minPolicyAddedTrades: LATE_ENTRY_POLICY_MIN_POLICY_ADDED_TRADES,
      minExternalCoveragePct: LATE_ENTRY_POLICY_MIN_EXTERNAL_COVERAGE_PCT,
      minRolling5ExternalCoveragePct: LATE_ENTRY_POLICY_MIN_ROLLING5_EXTERNAL_COVERAGE_PCT,
      minRolling10ExternalCoveragePct: LATE_ENTRY_POLICY_MIN_ROLLING10_EXTERNAL_COVERAGE_PCT,
      post1130DragWarnPnl: LATE_ENTRY_POLICY_POST_1130_DRAG_WARN_PNL,
    },
    summaryLine: statusLine,
    replayReferenceLine,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyDeltaCore(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  const source = options?.sourceType || options?.source || 'all';
  const reconstructionPhase = options?.reconstructionPhase || '';
  const maxRows = options?.maxRows || 5000;
  const referencePolicyKey = toText(options?.referencePolicyKey || LATE_ENTRY_POLICY_EXPERIMENT_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_KEY;
  const referencePolicyVersion = toText(options?.referencePolicyVersion || LATE_ENTRY_POLICY_EXPERIMENT_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_VERSION;
  const candidatePolicyKey = toText(options?.candidatePolicyKey || LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY) || LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY;
  const candidatePolicyVersion = toText(options?.candidatePolicyVersion || LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION) || LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION;

  const rowsReference = listLateEntryPolicyExperimentRows(db, {
    policyKey: referencePolicyKey,
    policyVersion: referencePolicyVersion,
    source,
    reconstructionPhase,
    maxRows,
  });
  const rowsCandidate = listLateEntryPolicyExperimentRows(db, {
    policyKey: candidatePolicyKey,
    policyVersion: candidatePolicyVersion,
    source,
    reconstructionPhase,
    maxRows,
  });
  const referenceByDate = new Map();
  const candidateByDate = new Map();
  for (const row of (Array.isArray(rowsReference) ? rowsReference : [])) {
    const date = normalizeDate(row?.trade_date || '');
    if (date) referenceByDate.set(date, row);
  }
  for (const row of (Array.isArray(rowsCandidate) ? rowsCandidate : [])) {
    const date = normalizeDate(row?.trade_date || '');
    if (date) candidateByDate.set(date, row);
  }
  const unionDates = Array.from(new Set([...referenceByDate.keys(), ...candidateByDate.keys()])).sort((a, b) => String(a).localeCompare(String(b)));

  const toSeries = (rows = []) => rows.map((row) => ({
    tradeDate: normalizeDate(row?.trade_date || ''),
    outcome: normalizePolicyPathOutcome(row?.selected_outcome || ''),
    pnl: Number.isFinite(toFiniteNumberOrNull(row?.selected_pnl)) ? round2(toFiniteNumberOrNull(row.selected_pnl)) : null,
  }));
  const referenceStats = computePnLStatsFromSeries(toSeries(rowsReference));
  const candidateStats = computePnLStatsFromSeries(toSeries(rowsCandidate));

  const classificationEnum = Array.isArray(options?.classificationEnum) ? options.classificationEnum : [];
  const normalizeClassification = typeof options?.normalizeClassification === 'function'
    ? options.normalizeClassification
    : ((value) => toText(value).toLowerCase() || null);
  const readClassificationFromSummary = typeof options?.readClassificationFromSummary === 'function'
    ? options.readClassificationFromSummary
    : (() => null);
  const missingCandidateFallbackClassification = toText(options?.missingCandidateFallbackClassification || '').toLowerCase() || null;
  const defaultClassification = toText(options?.defaultClassification || '').toLowerCase() || null;
  const classificationCounts = {};
  for (const key of classificationEnum) {
    classificationCounts[key] = 0;
  }
  let addedTrades = 0;
  let rescuedWinners = 0;
  let addedLosers = 0;
  const rescuedWinnersByWeekday = {};
  const rescuedWinnersByRegime = {};
  const relationshipCounts = {
    candidateMoreAggressive: 0,
    candidateMoreConservative: 0,
    agreement: 0,
  };

  for (const date of unionDates) {
    const rowReference = referenceByDate.get(date) || null;
    const rowCandidate = candidateByDate.get(date) || null;
    const referenceWouldTrade = Number(rowReference?.extension_would_trade || 0) === 1;
    const candidateWouldTrade = Number(rowCandidate?.extension_would_trade || 0) === 1;
    const candidateOutcome = normalizePolicyPathOutcome(rowCandidate?.selected_outcome || '');

    if (!referenceWouldTrade && candidateWouldTrade) relationshipCounts.candidateMoreAggressive += 1;
    else if (referenceWouldTrade && !candidateWouldTrade) relationshipCounts.candidateMoreConservative += 1;
    else relationshipCounts.agreement += 1;

    if (classificationEnum.length > 0) {
      let label = defaultClassification;
      if (rowCandidate) {
        const summaryCandidate = safeJsonParse(rowCandidate?.summary_json, {});
        label = normalizeClassification(readClassificationFromSummary(summaryCandidate) || label);
      } else if (rowReference && !candidateWouldTrade && missingCandidateFallbackClassification) {
        label = missingCandidateFallbackClassification;
      }
      if (label && Object.prototype.hasOwnProperty.call(classificationCounts, label)) {
        classificationCounts[label] = Number(classificationCounts[label] || 0) + 1;
      }
    }

    if (!referenceWouldTrade && candidateWouldTrade) {
      addedTrades += 1;
      if (candidateOutcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) {
        rescuedWinners += 1;
        const wd = toText(rowCandidate?.weekday || '').trim() || 'unknown';
        const regime = toText(rowCandidate?.regime_label || '').trim() || 'unknown';
        rescuedWinnersByWeekday[wd] = Number(rescuedWinnersByWeekday[wd] || 0) + 1;
        rescuedWinnersByRegime[regime] = Number(rescuedWinnersByRegime[regime] || 0) + 1;
      } else if (candidateOutcome === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) {
        addedLosers += 1;
      }
    }
  }

  return {
    trackedDaysReference: rowsReference.length,
    trackedDaysCandidate: rowsCandidate.length,
    referencePolicyKey,
    referencePolicyVersion,
    candidatePolicyKey,
    candidatePolicyVersion,
    referenceStats,
    candidateStats,
    deltas: {
      totalPnlDelta: (
        Number.isFinite(toFiniteNumberOrNull(candidateStats?.totalPnl))
        && Number.isFinite(toFiniteNumberOrNull(referenceStats?.totalPnl))
      )
        ? round2(toFiniteNumberOrNull(candidateStats.totalPnl) - toFiniteNumberOrNull(referenceStats.totalPnl))
        : null,
      winRateDeltaPct: (
        Number.isFinite(toFiniteNumberOrNull(candidateStats?.winRatePct))
        && Number.isFinite(toFiniteNumberOrNull(referenceStats?.winRatePct))
      )
        ? round2(toFiniteNumberOrNull(candidateStats.winRatePct) - toFiniteNumberOrNull(referenceStats.winRatePct))
        : null,
      profitFactorDelta: (
        Number.isFinite(toFiniteNumberOrNull(candidateStats?.profitFactor))
        && Number.isFinite(toFiniteNumberOrNull(referenceStats?.profitFactor))
      )
        ? round2(toFiniteNumberOrNull(candidateStats.profitFactor) - toFiniteNumberOrNull(referenceStats.profitFactor))
        : null,
      maxDrawdownDelta: (
        Number.isFinite(toFiniteNumberOrNull(candidateStats?.maxDrawdown))
        && Number.isFinite(toFiniteNumberOrNull(referenceStats?.maxDrawdown))
      )
        ? round2(toFiniteNumberOrNull(candidateStats.maxDrawdown) - toFiniteNumberOrNull(referenceStats.maxDrawdown))
        : null,
      addedTradesDelta: Number(candidateStats?.totalTrades || 0) - Number(referenceStats?.totalTrades || 0),
    },
    addedTrades,
    rescuedWinners,
    addedLosers,
    classificationCounts: classificationEnum.length > 0 ? classificationCounts : null,
    relationshipCounts,
    rescuedWinnersByWeekday,
    rescuedWinnersByRegime,
    dominantRescuedWeekday: Object.entries(rescuedWinnersByWeekday).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    dominantRescuedRegime: Object.entries(rescuedWinnersByRegime).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV2VsV1Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    classificationEnum: LATE_ENTRY_POLICY_V2_COMPARISON_ENUM,
    normalizeClassification: normalizeLateEntryPolicyV2Comparison,
    readClassificationFromSummary: (summary) => summary?.v2ComparisonClassification || '',
    missingCandidateFallbackClassification: LATE_ENTRY_POLICY_V2_COMPARISON_MORE_CONSERVATIVE,
    defaultClassification: LATE_ENTRY_POLICY_V2_COMPARISON_MIXED,
  });
  if (!core) return null;
  return {
    trackedDaysV1: core.trackedDaysReference,
    trackedDaysV2: core.trackedDaysCandidate,
    v1Stats: core.referenceStats,
    v2Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    classificationCounts: core.classificationCounts || {},
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV3VsV2Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    classificationEnum: LATE_ENTRY_POLICY_V3_COMPARISON_ENUM,
    normalizeClassification: normalizeLateEntryPolicyV3Comparison,
    readClassificationFromSummary: (summary) => summary?.v3ComparisonClassification || '',
    missingCandidateFallbackClassification: LATE_ENTRY_POLICY_V3_COMPARISON_MORE_CONSERVATIVE,
    defaultClassification: LATE_ENTRY_POLICY_V3_COMPARISON_MIXED,
  });
  if (!core) return null;
  return {
    trackedDaysV2: core.trackedDaysReference,
    trackedDaysV3: core.trackedDaysCandidate,
    v2Stats: core.referenceStats,
    v3Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    classificationCounts: core.classificationCounts || {},
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV3VsV1Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
  });
  if (!core) return null;
  return {
    trackedDaysV1: core.trackedDaysReference,
    trackedDaysV3: core.trackedDaysCandidate,
    v1Stats: core.referenceStats,
    v3Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV4VsV3Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    classificationEnum: LATE_ENTRY_POLICY_V4_COMPARISON_ENUM,
    normalizeClassification: normalizeLateEntryPolicyV4Comparison,
    readClassificationFromSummary: (summary) => summary?.v4ComparisonClassification || '',
    missingCandidateFallbackClassification: LATE_ENTRY_POLICY_V4_COMPARISON_MORE_CONSERVATIVE,
    defaultClassification: LATE_ENTRY_POLICY_V4_COMPARISON_MIXED,
  });
  if (!core) return null;
  return {
    trackedDaysV3: core.trackedDaysReference,
    trackedDaysV4: core.trackedDaysCandidate,
    v3Stats: core.referenceStats,
    v4Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    classificationCounts: core.classificationCounts || {},
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV4VsV2Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
  });
  if (!core) return null;
  return {
    trackedDaysV2: core.trackedDaysReference,
    trackedDaysV4: core.trackedDaysCandidate,
    v2Stats: core.referenceStats,
    v4Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV4VsV1Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
  });
  if (!core) return null;
  return {
    trackedDaysV1: core.trackedDaysReference,
    trackedDaysV4: core.trackedDaysCandidate,
    v1Stats: core.referenceStats,
    v4Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV5VsV4Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    classificationEnum: LATE_ENTRY_POLICY_V5_COMPARISON_ENUM,
    normalizeClassification: normalizeLateEntryPolicyV5Comparison,
    readClassificationFromSummary: (summary) => summary?.v5ComparisonClassification || '',
    missingCandidateFallbackClassification: LATE_ENTRY_POLICY_V5_COMPARISON_MORE_CONSERVATIVE,
    defaultClassification: LATE_ENTRY_POLICY_V5_COMPARISON_MIXED,
  });
  if (!core) return null;
  return {
    trackedDaysV4: core.trackedDaysReference,
    trackedDaysV5: core.trackedDaysCandidate,
    v4Stats: core.referenceStats,
    v5Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    classificationCounts: core.classificationCounts || {},
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV5VsV3Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  });
  if (!core) return null;
  return {
    trackedDaysV3: core.trackedDaysReference,
    trackedDaysV5: core.trackedDaysCandidate,
    v3Stats: core.referenceStats,
    v5Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV5VsV2Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  });
  if (!core) return null;
  return {
    trackedDaysV2: core.trackedDaysReference,
    trackedDaysV5: core.trackedDaysCandidate,
    v2Stats: core.referenceStats,
    v5Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function summarizeLateEntryPolicyV5VsV1Delta(db, options = {}) {
  const core = summarizeLateEntryPolicyDeltaCore(db, {
    ...options,
    referencePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    referencePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    candidatePolicyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    candidatePolicyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
  });
  if (!core) return null;
  return {
    trackedDaysV1: core.trackedDaysReference,
    trackedDaysV5: core.trackedDaysCandidate,
    v1Stats: core.referenceStats,
    v5Stats: core.candidateStats,
    deltas: core.deltas,
    addedTrades: core.addedTrades,
    rescuedWinners: core.rescuedWinners,
    addedLosers: core.addedLosers,
    relationshipCounts: core.relationshipCounts || {},
    rescuedWinnersByWeekday: core.rescuedWinnersByWeekday || {},
    rescuedWinnersByRegime: core.rescuedWinnersByRegime || {},
    dominantRescuedWeekday: core.dominantRescuedWeekday || null,
    dominantRescuedRegime: core.dominantRescuedRegime || null,
    advisoryOnly: true,
  };
}

function buildJarvisSimulatedTradeLedgerRow(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  const tradeDate = normalizeDate(input.tradeDate || input.date);
  if (!tradeDate) return null;
  const sourceType = normalizeSourceType(input.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(input.reconstructionPhase, sourceType);
  const simulationVersion = toText(input.simulationVersion || SIMULATED_TRADE_LEDGER_VERSION) || SIMULATED_TRADE_LEDGER_VERSION;
  const recommendedTpMode = normalizeTpMode(input.recommendedTpMode || '');
  const recommendedStrategyOutcome = input.recommendedStrategyOutcome && typeof input.recommendedStrategyOutcome === 'object'
    ? input.recommendedStrategyOutcome
    : null;
  const candles = Array.isArray(input.candles) ? input.candles : [];
  const sourceCandlesComplete = candles.length >= 3;
  const tradeInput = resolveSimulatedTradeInputForDate({
    recommendedStrategyOutcome,
    tradesForDate: input.tradesForDate,
    candles,
  });
  const didJarvisTakeTrade = tradeInput.shouldTrade === true;
  let noTradeReason = didJarvisTakeTrade
    ? null
    : toText(tradeInput.noTradeReason || 'strategy_no_trade') || 'strategy_no_trade';
  const runTradeMechanicsVariantTool = input.runTradeMechanicsVariantTool;
  let mechanicsVariants = [];
  if (didJarvisTakeTrade && sourceCandlesComplete && tradeInput.validTradeInput && typeof runTradeMechanicsVariantTool === 'function') {
    const mechanicsOut = runTradeMechanicsVariantTool({
      candles,
      trade: {
        direction: tradeInput.direction,
        entry_price: tradeInput.entryPrice,
        entry_time: tradeInput.entryTime,
      },
      originalPlanEligible: true,
    });
    mechanicsVariants = Array.isArray(mechanicsOut?.data?.mechanicsVariants)
      ? mechanicsOut.data.mechanicsVariants
      : [];
  }
  const variantsByMode = mapMechanicsVariantsByMode(mechanicsVariants);
  const nearestVariant = variantsByMode.get('Nearest') || null;
  const skip1Variant = variantsByMode.get('Skip 1') || null;
  const skip2Variant = variantsByMode.get('Skip 2') || null;
  let selectedVariant = variantsByMode.get(recommendedTpMode) || null;
  if (!selectedVariant && variantsByMode.size > 0) {
    selectedVariant = variantsByMode.get('Skip 2') || variantsByMode.values().next().value || null;
  }
  const selectedPathOutcome = didJarvisTakeTrade
    ? normalizeSimulatedPathOutcome(
      selectedVariant?.outcome
      || recommendedStrategyOutcome?.tradeResult
      || 'unknown'
    )
    : SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE;
  const selectedPathPnl = didJarvisTakeTrade
    ? (
      Number.isFinite(toFiniteNumberOrNull(selectedVariant?.pnlDollars))
        ? round2(toFiniteNumberOrNull(selectedVariant?.pnlDollars))
        : (
          Number.isFinite(toFiniteNumberOrNull(recommendedStrategyOutcome?.pnlDollars))
            ? round2(toFiniteNumberOrNull(recommendedStrategyOutcome?.pnlDollars))
            : null
        )
    )
    : null;
  const simulationConfidence = (() => {
    if (!sourceCandlesComplete) return 0.35;
    if (!didJarvisTakeTrade) return noTradeReason ? 0.9 : 0.75;
    if (selectedVariant) return 0.95;
    if (tradeInput.validTradeInput) return 0.7;
    return 0.45;
  })();
  if (didJarvisTakeTrade && !selectedVariant && !tradeInput.validTradeInput) {
    noTradeReason = null;
  }
  return {
    tradeDate,
    sourceType,
    reconstructionPhase,
    simulationVersion,
    didJarvisTakeTrade: didJarvisTakeTrade ? 1 : 0,
    noTradeReason: didJarvisTakeTrade ? null : noTradeReason,
    strategyKey: toText(input.recommendedStrategyKey || recommendedStrategyOutcome?.strategyKey || '') || null,
    strategyName: toText(input.recommendedStrategyName || recommendedStrategyOutcome?.strategyName || '') || null,
    tpModeSelected: recommendedTpMode || null,
    entryPrice: Number.isFinite(toFiniteNumberOrNull(tradeInput.entryPrice)) ? round2(toFiniteNumberOrNull(tradeInput.entryPrice)) : null,
    stopPrice: Number.isFinite(toFiniteNumberOrNull(selectedVariant?.slPx))
      ? round2(toFiniteNumberOrNull(selectedVariant.slPx))
      : (Number.isFinite(toFiniteNumberOrNull(tradeInput.stopPrice)) ? round2(toFiniteNumberOrNull(tradeInput.stopPrice)) : null),
    nearestTpPrice: Number.isFinite(toFiniteNumberOrNull(nearestVariant?.tpPx)) ? round2(toFiniteNumberOrNull(nearestVariant.tpPx)) : null,
    skip1TpPrice: Number.isFinite(toFiniteNumberOrNull(skip1Variant?.tpPx)) ? round2(toFiniteNumberOrNull(skip1Variant.tpPx)) : null,
    skip2TpPrice: Number.isFinite(toFiniteNumberOrNull(skip2Variant?.tpPx)) ? round2(toFiniteNumberOrNull(skip2Variant.tpPx)) : null,
    selectedTargetPrice: Number.isFinite(toFiniteNumberOrNull(selectedVariant?.tpPx))
      ? round2(toFiniteNumberOrNull(selectedVariant.tpPx))
      : (Number.isFinite(toFiniteNumberOrNull(tradeInput.targetPrice)) ? round2(toFiniteNumberOrNull(tradeInput.targetPrice)) : null),
    selectedPathOutcome,
    selectedPathPnl: Number.isFinite(toFiniteNumberOrNull(selectedPathPnl)) ? round2(toFiniteNumberOrNull(selectedPathPnl)) : null,
    nearestTpOutcome: normalizeSimulatedPathOutcome(nearestVariant?.outcome),
    skip1TpOutcome: normalizeSimulatedPathOutcome(skip1Variant?.outcome),
    skip2TpOutcome: normalizeSimulatedPathOutcome(skip2Variant?.outcome),
    maxFavorableExcursion: Number.isFinite(toFiniteNumberOrNull(selectedVariant?.mfe))
      ? round2(toFiniteNumberOrNull(selectedVariant.mfe))
      : null,
    maxAdverseExcursion: Number.isFinite(toFiniteNumberOrNull(selectedVariant?.mae))
      ? round2(toFiniteNumberOrNull(selectedVariant.mae))
      : null,
    sourceCandlesComplete: sourceCandlesComplete ? 1 : 0,
    simulationConfidence: round2(simulationConfidence),
    snapshotJson: {
      tradeDate,
      sourceType,
      reconstructionPhase,
      simulationVersion,
      recommendedTpMode: recommendedTpMode || null,
      strategyOutcome: recommendedStrategyOutcome || null,
      tradeInput,
      mechanicsVariants,
      selectedVariant: selectedVariant || null,
    },
  };
}

function upsertJarvisSimulatedTradeOutcomeLedgerRow(input = {}) {
  const db = input.db;
  const row = input.row && typeof input.row === 'object' ? input.row : null;
  if (!db || typeof db.prepare !== 'function' || !row) return null;
  ensureRecommendationOutcomeSchema(db);
  db.prepare(`
    INSERT INTO jarvis_simulated_trade_outcome_ledger_daily (
      trade_date,
      source_type,
      reconstruction_phase,
      simulation_version,
      did_jarvis_take_trade,
      no_trade_reason,
      strategy_key,
      strategy_name,
      tp_mode_selected,
      entry_price,
      stop_price,
      nearest_tp_price,
      skip1_tp_price,
      skip2_tp_price,
      selected_target_price,
      selected_path_outcome,
      selected_path_pnl,
      nearest_tp_outcome,
      skip1_tp_outcome,
      skip2_tp_outcome,
      max_favorable_excursion,
      max_adverse_excursion,
      source_candles_complete,
      simulation_confidence,
      snapshot_json,
      updated_at
    ) VALUES (
      @trade_date,
      @source_type,
      @reconstruction_phase,
      @simulation_version,
      @did_jarvis_take_trade,
      @no_trade_reason,
      @strategy_key,
      @strategy_name,
      @tp_mode_selected,
      @entry_price,
      @stop_price,
      @nearest_tp_price,
      @skip1_tp_price,
      @skip2_tp_price,
      @selected_target_price,
      @selected_path_outcome,
      @selected_path_pnl,
      @nearest_tp_outcome,
      @skip1_tp_outcome,
      @skip2_tp_outcome,
      @max_favorable_excursion,
      @max_adverse_excursion,
      @source_candles_complete,
      @simulation_confidence,
      @snapshot_json,
      datetime('now')
    )
    ON CONFLICT(trade_date, source_type, reconstruction_phase, simulation_version) DO UPDATE SET
      did_jarvis_take_trade = excluded.did_jarvis_take_trade,
      no_trade_reason = excluded.no_trade_reason,
      strategy_key = excluded.strategy_key,
      strategy_name = excluded.strategy_name,
      tp_mode_selected = excluded.tp_mode_selected,
      entry_price = excluded.entry_price,
      stop_price = excluded.stop_price,
      nearest_tp_price = excluded.nearest_tp_price,
      skip1_tp_price = excluded.skip1_tp_price,
      skip2_tp_price = excluded.skip2_tp_price,
      selected_target_price = excluded.selected_target_price,
      selected_path_outcome = excluded.selected_path_outcome,
      selected_path_pnl = excluded.selected_path_pnl,
      nearest_tp_outcome = excluded.nearest_tp_outcome,
      skip1_tp_outcome = excluded.skip1_tp_outcome,
      skip2_tp_outcome = excluded.skip2_tp_outcome,
      max_favorable_excursion = excluded.max_favorable_excursion,
      max_adverse_excursion = excluded.max_adverse_excursion,
      source_candles_complete = excluded.source_candles_complete,
      simulation_confidence = excluded.simulation_confidence,
      snapshot_json = excluded.snapshot_json,
      updated_at = datetime('now')
  `).run({
    trade_date: row.tradeDate,
    source_type: row.sourceType,
    reconstruction_phase: row.reconstructionPhase,
    simulation_version: row.simulationVersion,
    did_jarvis_take_trade: row.didJarvisTakeTrade ? 1 : 0,
    no_trade_reason: toText(row.noTradeReason || '') || null,
    strategy_key: toText(row.strategyKey || '') || null,
    strategy_name: toText(row.strategyName || '') || null,
    tp_mode_selected: toText(row.tpModeSelected || '') || null,
    entry_price: Number.isFinite(toFiniteNumberOrNull(row.entryPrice)) ? round2(toFiniteNumberOrNull(row.entryPrice)) : null,
    stop_price: Number.isFinite(toFiniteNumberOrNull(row.stopPrice)) ? round2(toFiniteNumberOrNull(row.stopPrice)) : null,
    nearest_tp_price: Number.isFinite(toFiniteNumberOrNull(row.nearestTpPrice)) ? round2(toFiniteNumberOrNull(row.nearestTpPrice)) : null,
    skip1_tp_price: Number.isFinite(toFiniteNumberOrNull(row.skip1TpPrice)) ? round2(toFiniteNumberOrNull(row.skip1TpPrice)) : null,
    skip2_tp_price: Number.isFinite(toFiniteNumberOrNull(row.skip2TpPrice)) ? round2(toFiniteNumberOrNull(row.skip2TpPrice)) : null,
    selected_target_price: Number.isFinite(toFiniteNumberOrNull(row.selectedTargetPrice)) ? round2(toFiniteNumberOrNull(row.selectedTargetPrice)) : null,
    selected_path_outcome: toText(row.selectedPathOutcome || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
    selected_path_pnl: Number.isFinite(toFiniteNumberOrNull(row.selectedPathPnl)) ? round2(toFiniteNumberOrNull(row.selectedPathPnl)) : null,
    nearest_tp_outcome: toText(row.nearestTpOutcome || '') || null,
    skip1_tp_outcome: toText(row.skip1TpOutcome || '') || null,
    skip2_tp_outcome: toText(row.skip2TpOutcome || '') || null,
    max_favorable_excursion: Number.isFinite(toFiniteNumberOrNull(row.maxFavorableExcursion)) ? round2(toFiniteNumberOrNull(row.maxFavorableExcursion)) : null,
    max_adverse_excursion: Number.isFinite(toFiniteNumberOrNull(row.maxAdverseExcursion)) ? round2(toFiniteNumberOrNull(row.maxAdverseExcursion)) : null,
    source_candles_complete: row.sourceCandlesComplete ? 1 : 0,
    simulation_confidence: Number.isFinite(toFiniteNumberOrNull(row.simulationConfidence))
      ? round2(toFiniteNumberOrNull(row.simulationConfidence))
      : null,
    snapshot_json: JSON.stringify(row.snapshotJson || {}),
  });
  return db.prepare(`
    SELECT *
    FROM jarvis_simulated_trade_outcome_ledger_daily
    WHERE trade_date = ?
      AND source_type = ?
      AND reconstruction_phase = ?
      AND simulation_version = ?
    LIMIT 1
  `).get(
    row.tradeDate,
    row.sourceType,
    row.reconstructionPhase,
    row.simulationVersion
  ) || null;
}

function getJarvisSimulatedTradeOutcomeForDate(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const tradeDate = normalizeDate(options.tradeDate || options.date || '');
  if (!tradeDate) return null;
  const requestedSourceType = normalizeSourceType(options.sourceType || SOURCE_LIVE);
  const requestedReconstructionPhase = normalizeReconstructionPhase(
    options.reconstructionPhase,
    requestedSourceType
  );
  const simulationVersion = toText(options.simulationVersion || SIMULATED_TRADE_LEDGER_VERSION)
    || SIMULATED_TRADE_LEDGER_VERSION;
  let row = db.prepare(`
    SELECT *
    FROM jarvis_simulated_trade_outcome_ledger_daily
    WHERE trade_date = ?
      AND source_type = ?
      AND reconstruction_phase = ?
      AND simulation_version = ?
    LIMIT 1
  `).get(
    tradeDate,
    requestedSourceType,
    requestedReconstructionPhase,
    simulationVersion
  ) || null;
  if (!row) {
    row = db.prepare(`
      SELECT *
      FROM jarvis_simulated_trade_outcome_ledger_daily
      WHERE trade_date = ?
      ORDER BY
        CASE WHEN source_type = 'live' AND reconstruction_phase = 'live_intraday' THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `).get(tradeDate) || null;
  }
  if (!row) return null;

  const didJarvisTakeTrade = Number(row.did_jarvis_take_trade || 0) === 1;
  const snapshot = safeJsonParse(row.snapshot_json, {});
  const variants = Array.isArray(snapshot?.mechanicsVariants) ? snapshot.mechanicsVariants : [];
  const variantsByMode = mapMechanicsVariantsByMode(variants);
  const selectedMode = normalizeTpMode(row.tp_mode_selected || '');
  const selectedVariant = variantsByMode.get(selectedMode) || variantsByMode.get('Skip 2') || null;
  const external = resolveExternalExecutionOutcomeForDate(db, tradeDate);
  const externalTopstepOutcomeIfAvailable = (
    external?.hasRows === true
    && (
      external?.sourceInUse === REALIZED_TRUTH_SOURCE_PRIMARY
      || external?.sourceInUse === REALIZED_TRUTH_SOURCE_SECONDARY
    )
  )
    ? {
      tradeCount: Number(external.tradeCount || 0),
      wins: Number(external.wins || 0),
      losses: Number(external.losses || 0),
      breakeven: Number(external.breakeven || 0),
      netPnlDollars: round2(Number(external.netPnlDollars || 0)),
      sourceInUse: normalizeRealizedTruthSource(external.sourceInUse || REALIZED_TRUTH_SOURCE_NONE),
      sourceBacked: external.sourceBacked === true,
      trustClassification: normalizeShadowPlaybookDurabilityTrust(external.trustClassification || REALIZED_TRUTH_TRUST_PARTIAL),
    }
    : null;
  const selectedPathOutcome = normalizeSimulatedPathOutcome(row.selected_path_outcome || '');
  const out = {
    tradeDate,
    sourceType: toText(row.source_type || '') || SOURCE_LIVE,
    reconstructionPhase: toText(row.reconstruction_phase || '') || PHASE_LIVE_INTRADAY,
    simulationVersion: toText(row.simulation_version || '') || SIMULATED_TRADE_LEDGER_VERSION,
    didJarvisTakeTrade,
    noTradeReason: toText(row.no_trade_reason || '') || null,
    strategyKey: toText(row.strategy_key || '') || null,
    strategyName: toText(row.strategy_name || '') || null,
    tpModeSelected: toText(row.tp_mode_selected || '') || null,
    chosenTradeSummary: didJarvisTakeTrade
      ? {
        direction: toText(snapshot?.tradeInput?.direction || snapshot?.strategyOutcome?.tradeDirection || '').toLowerCase() || 'unknown',
        strategyKey: toText(row.strategy_key || '') || null,
        strategyName: toText(row.strategy_name || '') || null,
        tpMode: toText(row.tp_mode_selected || '') || null,
        entryPrice: Number.isFinite(toFiniteNumberOrNull(row.entry_price)) ? round2(toFiniteNumberOrNull(row.entry_price)) : null,
        stopPrice: Number.isFinite(toFiniteNumberOrNull(row.stop_price)) ? round2(toFiniteNumberOrNull(row.stop_price)) : null,
        selectedTargetPrice: Number.isFinite(toFiniteNumberOrNull(row.selected_target_price)) ? round2(toFiniteNumberOrNull(row.selected_target_price)) : null,
      }
      : {
        direction: null,
        strategyKey: toText(row.strategy_key || '') || null,
        strategyName: toText(row.strategy_name || '') || null,
        tpMode: toText(row.tp_mode_selected || '') || null,
    },
    selectedOutcome: {
      outcome: selectedPathOutcome,
      pnl: Number.isFinite(toFiniteNumberOrNull(row.selected_path_pnl)) ? round2(toFiniteNumberOrNull(row.selected_path_pnl)) : null,
      targetPrice: Number.isFinite(toFiniteNumberOrNull(row.selected_target_price)) ? round2(toFiniteNumberOrNull(row.selected_target_price)) : null,
      stopPrice: Number.isFinite(toFiniteNumberOrNull(row.stop_price)) ? round2(toFiniteNumberOrNull(row.stop_price)) : null,
      entryPrice: Number.isFinite(toFiniteNumberOrNull(row.entry_price)) ? round2(toFiniteNumberOrNull(row.entry_price)) : null,
    },
    nearestTpOutcome: {
      outcome: normalizeSimulatedPathOutcome(row.nearest_tp_outcome || ''),
      targetPrice: Number.isFinite(toFiniteNumberOrNull(row.nearest_tp_price)) ? round2(toFiniteNumberOrNull(row.nearest_tp_price)) : null,
      pnl: Number.isFinite(toFiniteNumberOrNull(variantsByMode.get('Nearest')?.pnlDollars))
        ? round2(toFiniteNumberOrNull(variantsByMode.get('Nearest').pnlDollars))
        : null,
    },
    skip1Outcome: {
      outcome: normalizeSimulatedPathOutcome(row.skip1_tp_outcome || ''),
      targetPrice: Number.isFinite(toFiniteNumberOrNull(row.skip1_tp_price)) ? round2(toFiniteNumberOrNull(row.skip1_tp_price)) : null,
      pnl: Number.isFinite(toFiniteNumberOrNull(variantsByMode.get('Skip 1')?.pnlDollars))
        ? round2(toFiniteNumberOrNull(variantsByMode.get('Skip 1').pnlDollars))
        : null,
    },
    skip2Outcome: {
      outcome: normalizeSimulatedPathOutcome(row.skip2_tp_outcome || ''),
      targetPrice: Number.isFinite(toFiniteNumberOrNull(row.skip2_tp_price)) ? round2(toFiniteNumberOrNull(row.skip2_tp_price)) : null,
      pnl: Number.isFinite(toFiniteNumberOrNull(variantsByMode.get('Skip 2')?.pnlDollars))
        ? round2(toFiniteNumberOrNull(variantsByMode.get('Skip 2').pnlDollars))
        : null,
    },
    maxFavorableExcursion: Number.isFinite(toFiniteNumberOrNull(row.max_favorable_excursion))
      ? round2(toFiniteNumberOrNull(row.max_favorable_excursion))
      : null,
    maxAdverseExcursion: Number.isFinite(toFiniteNumberOrNull(row.max_adverse_excursion))
      ? round2(toFiniteNumberOrNull(row.max_adverse_excursion))
      : null,
    sourceCandlesComplete: Number(row.source_candles_complete || 0) === 1,
    simulationConfidence: Number.isFinite(toFiniteNumberOrNull(row.simulation_confidence))
      ? round2(toFiniteNumberOrNull(row.simulation_confidence))
      : null,
    externalTopstepOutcomeIfAvailable,
    jarvisVsTopstepMatchStatus: buildJarvisVsTopstepMatchStatus({
      didJarvisTakeTrade,
      selectedPathOutcome,
      externalTopstepOutcome: externalTopstepOutcomeIfAvailable,
    }),
    tpComparisons: {
      selected: {
        tpMode: toText(row.tp_mode_selected || '') || null,
        outcome: selectedPathOutcome,
        targetPrice: Number.isFinite(toFiniteNumberOrNull(row.selected_target_price)) ? round2(toFiniteNumberOrNull(row.selected_target_price)) : null,
      },
      nearest: {
        outcome: normalizeSimulatedPathOutcome(row.nearest_tp_outcome || ''),
        targetPrice: Number.isFinite(toFiniteNumberOrNull(row.nearest_tp_price)) ? round2(toFiniteNumberOrNull(row.nearest_tp_price)) : null,
      },
      skip1: {
        outcome: normalizeSimulatedPathOutcome(row.skip1_tp_outcome || ''),
        targetPrice: Number.isFinite(toFiniteNumberOrNull(row.skip1_tp_price)) ? round2(toFiniteNumberOrNull(row.skip1_tp_price)) : null,
      },
      skip2: {
        outcome: normalizeSimulatedPathOutcome(row.skip2_tp_outcome || ''),
        targetPrice: Number.isFinite(toFiniteNumberOrNull(row.skip2_tp_price)) ? round2(toFiniteNumberOrNull(row.skip2_tp_price)) : null,
      },
    },
    snapshot,
  };
  out.simulatedStatusLine = buildJarvisSimulatedTradeStatusLine(out);
  return out;
}

function evaluateRecommendationOutcomeDay(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') return null;
  ensureRecommendationOutcomeSchema(db);
  const date = normalizeDate(input.date || input.recDate);
  if (!date) return null;
  const contextRow = input.contextRow || null;
  const sourceType = normalizeSourceType(contextRow?.source_type || input.sourceType || SOURCE_LIVE);
  const reconstructionPhase = normalizeReconstructionPhase(contextRow?.reconstruction_phase || input.reconstructionPhase, sourceType);
  const reconstructionVersion = normalizeReconstructionVersion(contextRow?.reconstruction_version || input.reconstructionVersion, sourceType);
  const generatedAt = toText(contextRow?.generated_at || input.generatedAt || '') || null;
  const recommendationJson = contextRow ? safeJsonParse(contextRow.recommendation_json, {}) : {};
  const contextJson = contextRow ? safeJsonParse(contextRow.context_json, {}) : {};
  const posture = toText(contextRow?.posture || recommendationJson.posture || '').toLowerCase() || 'trade_selectively';
  const recommendedStrategyKey = normalizeStrategyKey(contextRow?.recommended_strategy_key || recommendationJson.recommendedStrategy || '');
  const recommendedStrategyName = toText(contextRow?.recommended_strategy_name || recommendationJson.recommendedStrategy || '');
  const recommendedTpMode = normalizeTpMode(contextRow?.recommended_tp_mode || recommendationJson.recommendedTpMode || '');
  const recommendationDate = normalizeDate(
    contextJson?.nowEt?.date
    || contextJson?.nowEt
    || contextJson?.date
    || contextRow?.rec_date
    || date
  ) || date;
  const weekday = weekdayFromDate(recommendationDate);
  const timeBucket = toText(contextJson?.sessionPhase || contextJson?.timeBucket || '').toLowerCase() || null;

  const tradeRows = db.prepare(`
    SELECT direction, entry_price, entry_time, exit_time, result, pnl_ticks, pnl_dollars
    FROM trades
    WHERE date = ?
    ORDER BY id ASC
  `).all(date);
  const actualTradeTaken = tradeRows.length > 0;
  const actualPnl = round2(tradeRows.reduce((sum, row) => {
    if (Number.isFinite(Number(row?.pnl_dollars))) return sum + Number(row.pnl_dollars);
    if (Number.isFinite(Number(row?.pnl_ticks))) return sum + ((Number(row.pnl_ticks) * 0.5) - 4.5);
    return sum;
  }, 0));

  const strategyOutcomes = resolveStrategyOutcomesForDate(input.strategySnapshot || {}, date);
  const orbBaselineOutcome = strategyOutcomes.find(
    (row) => normalizeStrategyKey(row?.strategyKey || '') === 'original_plan_orb_3130'
  ) || null;
  const bestStrategyOutcome = strategyOutcomes[0] || null;
  let recommendedStrategyOutcome = strategyOutcomes.find((row) => normalizeStrategyKey(row.strategyKey) === recommendedStrategyKey) || null;
  if (!recommendedStrategyOutcome && recommendedStrategyName) {
    recommendedStrategyOutcome = strategyOutcomes.find((row) => normalizeStrategyKey(row.strategyName) === normalizeStrategyKey(recommendedStrategyName)) || null;
  }
  if (!recommendedStrategyOutcome && strategyOutcomes.length > 0) {
    recommendedStrategyOutcome = strategyOutcomes.find((row) => normalizeStrategyKey(row.strategyKey) === 'original_plan_orb_3130')
      || strategyOutcomes[0];
  }

  const strategyRelativePnL = bestStrategyOutcome && recommendedStrategyOutcome
    ? round2(Number(recommendedStrategyOutcome.pnlDollars || 0) - Number(bestStrategyOutcome.pnlDollars || 0))
    : null;
  const strategyCorrect = bestStrategyOutcome && recommendedStrategyOutcome
    ? normalizeStrategyKey(bestStrategyOutcome.strategyKey) === normalizeStrategyKey(recommendedStrategyOutcome.strategyKey)
    : null;
  const strategyImprovementPotential = bestStrategyOutcome && recommendedStrategyOutcome
    ? round2(Math.max(0, Number(bestStrategyOutcome.pnlDollars || 0) - Number(recommendedStrategyOutcome.pnlDollars || 0)))
    : null;
  let strategyScoreLabel = 'unknown';
  if (strategyCorrect === true) strategyScoreLabel = 'correct';
  else if (strategyCorrect === false) strategyScoreLabel = Number(strategyRelativePnL || 0) >= -25 ? 'partially_correct' : 'incorrect';

  const mechanics = resolveMechanicsForDate({
    date,
    sessions: input.sessions || {},
    tradesForDate: tradeRows,
    runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    recommendedTpMode,
  });

  const bestPossiblePnl = round2(Math.max(
    Number(actualPnl || 0),
    Number(bestStrategyOutcome?.pnlDollars || Number.NEGATIVE_INFINITY),
    Number(mechanics?.bestMechanicsOutcome?.pnlDollars || Number.NEGATIVE_INFINITY)
  ));
  const recommendedPnl = round2(Number.isFinite(Number(recommendedStrategyOutcome?.pnlDollars))
    ? Number(recommendedStrategyOutcome.pnlDollars)
    : Number(actualPnl || 0));
  const recommendationDelta = round2(recommendedPnl - bestPossiblePnl);

  const postureEvaluation = scorePosture({
    posture,
    actualPnl,
    bestPossiblePnl,
    actualTradeTaken,
  });
  const calculatedAt = new Date().toISOString();

  const daily = {
    date,
    sourceType,
    reconstructionPhase,
    reconstructionVersion,
    scoreVersion: SCORE_VERSION,
    generatedAt,
    createdAt: toText(contextRow?.created_at || '') || null,
    updatedAt: toText(contextRow?.updated_at || '') || null,
    calculatedAt,
    recommendationDate,
    weekday,
    timeBucket,
    posture,
    recommendedStrategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
    recommendedTpMode: recommendedTpMode || null,
    postureEvaluation,
    strategyRecommendationScore: {
      strategyCorrect,
      strategyImprovementPotential,
      strategyRelativePnL,
      scoreLabel: strategyScoreLabel,
      recommendedStrategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      bestStrategyKey: bestStrategyOutcome?.strategyKey || null,
    },
    tpRecommendationScore: mechanics.tpRecommendationScore,
    actualTradeTaken,
    actualPnL: actualPnl,
    bestPossiblePnL: bestPossiblePnl,
    recommendationDelta,
    tradeDirection: toText(tradeRows[0]?.direction || '') || null,
    entryTime: toText(tradeRows[0]?.entry_time || '') || null,
    exitTime: toText(tradeRows[0]?.exit_time || '') || null,
    bestMechanicsOutcome: mechanics.bestMechanicsOutcome || null,
    bestStrategyOutcome: bestStrategyOutcome || null,
    recommendedStrategyOutcome: recommendedStrategyOutcome || null,
    integrity: contextJson?.integrity && typeof contextJson.integrity === 'object'
      ? contextJson.integrity
      : null,
  };

  try {
    const shadowPlaybook = evaluateFailedExtensionReversalFadeShadow({
      date,
      contextJson,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      orbOutcome: orbBaselineOutcome,
    });
    if (shadowPlaybook && typeof shadowPlaybook === 'object') {
      daily.shadowPlaybook = shadowPlaybook;
      daily.shadowPlaybookComparisonSummary = {
        playbookKey: shadowPlaybook.playbookKey,
        playbookVersion: shadowPlaybook.playbookVersion,
        eligible: shadowPlaybook.eligible === true,
        fitScore: Number.isFinite(toNumber(shadowPlaybook.fitScore, null))
          ? round2(toNumber(shadowPlaybook.fitScore, null))
          : 0,
        skipReason: toText(shadowPlaybook.skipReason || '') || null,
        hypotheticalDirection: toText(shadowPlaybook.hypotheticalDirection || '') || null,
        hypotheticalResult: toText(shadowPlaybook.hypotheticalResult || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE) || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        hypotheticalPnl: Number.isFinite(toNumber(shadowPlaybook.hypotheticalPnl, null))
          ? round2(toNumber(shadowPlaybook.hypotheticalPnl, null))
          : 0,
        orbOverlapLabel: toText(shadowPlaybook.orbOverlapLabel || '') || 'orb_outcome_unavailable',
        orbWouldTrade: shadowPlaybook?.evaluation?.orbWouldTrade === true,
        orbTradeResult: toText(shadowPlaybook?.evaluation?.orbTradeResult || '') || null,
        orbPnlDollars: Number.isFinite(toNumber(shadowPlaybook?.evaluation?.orbPnlDollars, null))
          ? round2(toNumber(shadowPlaybook?.evaluation?.orbPnlDollars, null))
          : 0,
        laneLabel: normalizeShadowPlaybookLaneLabel(shadowPlaybook?.laneLabel),
        laneReasonCodes: Array.isArray(shadowPlaybook?.laneReasonCodes)
          ? shadowPlaybook.laneReasonCodes.map((code) => toText(code)).filter(Boolean)
          : [],
        laneScore: Number.isFinite(toNumber(shadowPlaybook?.laneScore, null))
          ? round2(toNumber(shadowPlaybook?.laneScore, null))
          : 0,
        highConvictionLaneMatch: shadowPlaybook?.highConvictionLaneMatch === true,
        predecisionLaneLabel: normalizeShadowPlaybookLaneLabel(
          shadowPlaybook?.predecisionLaneLabel || SHADOW_PLAYBOOK_LANE_NEUTRAL
        ),
        predecisionLaneReasonCodes: Array.isArray(shadowPlaybook?.predecisionLaneReasonCodes)
          ? shadowPlaybook.predecisionLaneReasonCodes.map((code) => toText(code)).filter(Boolean)
          : [],
        predecisionLaneScore: Number.isFinite(toNumber(shadowPlaybook?.predecisionLaneScore, null))
          ? round2(toNumber(shadowPlaybook?.predecisionLaneScore, null))
          : 0,
        predecisionHighConvictionLaneMatch: shadowPlaybook?.predecisionHighConvictionLaneMatch === true,
        predecisionRemovedReasonCodes: Array.isArray(shadowPlaybook?.predecisionRemovedReasonCodes)
          ? shadowPlaybook.predecisionRemovedReasonCodes.map((code) => toText(code)).filter(Boolean)
          : [],
        predecisionKeptReasonCodes: Array.isArray(shadowPlaybook?.predecisionKeptReasonCodes)
          ? shadowPlaybook.predecisionKeptReasonCodes.map((code) => toText(code)).filter(Boolean)
          : [],
        dataQualityStatus: toText(shadowPlaybook.dataQualityStatus || '') || 'ok',
      };
      if (sourceType === SOURCE_LIVE && reconstructionPhase === PHASE_LIVE_INTRADAY) {
        upsertShadowPlaybookEvaluation({
          db,
          evaluation: shadowPlaybook,
          sourceType,
          reconstructionPhase,
        });
      }
    }
  } catch {}

  try {
    const checkpoint = upsertAssistantDecisionOutcomeCheckpoint({
      db,
      date,
      daily,
      contextRow,
      sourceType,
      reconstructionPhase,
      reconstructionVersion,
    });
    if (checkpoint) {
      daily.assistantDecisionOutcomeCheckpoint = checkpoint;
      daily.realizedOutcomeClassification = checkpoint.realizedOutcomeClassification || null;
      daily.realizedOutcomeReason = checkpoint.realizedOutcomeReason || null;
      daily.modelVsRealizedDivergence = checkpoint.modelVsRealizedDivergence || null;
      daily.externalExecutionOutcome = checkpoint.externalExecutionOutcome || null;
    }
  } catch {}

  try {
    const simulatedLedgerRow = buildJarvisSimulatedTradeLedgerRow({
      db,
      tradeDate: date,
      sourceType,
      reconstructionPhase,
      simulationVersion: SIMULATED_TRADE_LEDGER_VERSION,
      recommendedTpMode,
      recommendedStrategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      recommendedStrategyName: recommendedStrategyOutcome?.strategyName || recommendedStrategyName || null,
      recommendedStrategyOutcome,
      tradesForDate: tradeRows,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    });
    if (simulatedLedgerRow) {
      const persistedLedger = upsertJarvisSimulatedTradeOutcomeLedgerRow({
        db,
        row: simulatedLedgerRow,
      });
      daily.jarvisSimulatedTradeLedgerRow = persistedLedger || null;
      daily.jarvisSimulatedTradeOutcome = getJarvisSimulatedTradeOutcomeForDate(db, {
        tradeDate: date,
        sourceType,
        reconstructionPhase,
        simulationVersion: SIMULATED_TRADE_LEDGER_VERSION,
      });
    }
  } catch {}

  try {
    const lateEntryPolicyRow = buildLateEntryPolicyExperimentRow({
      db,
      tradeDate: date,
      sourceType,
      reconstructionPhase,
      selectedTpMode: recommendedTpMode || 'Skip 2',
      strategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      strategyName: recommendedStrategyOutcome?.strategyName || recommendedStrategyName || null,
      contextJson,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    });
    if (lateEntryPolicyRow) {
      const persistedLateEntryPolicy = upsertLateEntryPolicyExperimentRow({
        db,
        row: lateEntryPolicyRow,
      });
      if (persistedLateEntryPolicy) {
        persistedLateEntryPolicy.__db = db;
        daily.lateEntryPolicyExperimentRow = persistedLateEntryPolicy;
        daily.lateEntryPolicyExperimentSummary = formatLateEntryPolicyExperimentRow(persistedLateEntryPolicy);
        delete persistedLateEntryPolicy.__db;
      } else {
        daily.lateEntryPolicyExperimentSummary = null;
        daily.lateEntryPolicyExperimentRow = null;
      }
    }
  } catch {}
  try {
    const lateEntryPolicyV2Row = buildLateEntryPolicyExperimentRow({
      db,
      tradeDate: date,
      sourceType,
      reconstructionPhase,
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
      selectedTpMode: recommendedTpMode || 'Skip 2',
      strategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      strategyName: recommendedStrategyOutcome?.strategyName || recommendedStrategyName || null,
      contextJson,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    });
    if (lateEntryPolicyV2Row) {
      const persistedLateEntryPolicyV2 = upsertLateEntryPolicyExperimentRow({
        db,
        row: lateEntryPolicyV2Row,
      });
      if (persistedLateEntryPolicyV2) {
        persistedLateEntryPolicyV2.__db = db;
        daily.lateEntryPolicyExperimentV2Row = persistedLateEntryPolicyV2;
        daily.lateEntryPolicyExperimentV2Summary = formatLateEntryPolicyExperimentRow(persistedLateEntryPolicyV2);
        delete persistedLateEntryPolicyV2.__db;
      } else {
        daily.lateEntryPolicyExperimentV2Summary = null;
        daily.lateEntryPolicyExperimentV2Row = null;
      }
    }
  } catch {}
  try {
    const lateEntryPolicyV3Row = buildLateEntryPolicyExperimentRow({
      db,
      tradeDate: date,
      sourceType,
      reconstructionPhase,
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
      selectedTpMode: recommendedTpMode || 'Skip 2',
      strategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      strategyName: recommendedStrategyOutcome?.strategyName || recommendedStrategyName || null,
      contextJson,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    });
    if (lateEntryPolicyV3Row) {
      const persistedLateEntryPolicyV3 = upsertLateEntryPolicyExperimentRow({
        db,
        row: lateEntryPolicyV3Row,
      });
      if (persistedLateEntryPolicyV3) {
        persistedLateEntryPolicyV3.__db = db;
        daily.lateEntryPolicyExperimentV3Row = persistedLateEntryPolicyV3;
        daily.lateEntryPolicyExperimentV3Summary = formatLateEntryPolicyExperimentRow(persistedLateEntryPolicyV3);
        delete persistedLateEntryPolicyV3.__db;
      } else {
        daily.lateEntryPolicyExperimentV3Summary = null;
        daily.lateEntryPolicyExperimentV3Row = null;
      }
    }
  } catch {}
  try {
    const lateEntryPolicyV4Row = buildLateEntryPolicyExperimentRow({
      db,
      tradeDate: date,
      sourceType,
      reconstructionPhase,
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
      selectedTpMode: recommendedTpMode || 'Skip 2',
      strategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      strategyName: recommendedStrategyOutcome?.strategyName || recommendedStrategyName || null,
      contextJson,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    });
    if (lateEntryPolicyV4Row) {
      const persistedLateEntryPolicyV4 = upsertLateEntryPolicyExperimentRow({
        db,
        row: lateEntryPolicyV4Row,
      });
      if (persistedLateEntryPolicyV4) {
        persistedLateEntryPolicyV4.__db = db;
        daily.lateEntryPolicyExperimentV4Row = persistedLateEntryPolicyV4;
        daily.lateEntryPolicyExperimentV4Summary = formatLateEntryPolicyExperimentRow(persistedLateEntryPolicyV4);
        delete persistedLateEntryPolicyV4.__db;
      } else {
        daily.lateEntryPolicyExperimentV4Summary = null;
        daily.lateEntryPolicyExperimentV4Row = null;
      }
    }
  } catch {}
  try {
    const lateEntryPolicyV5Row = buildLateEntryPolicyExperimentRow({
      db,
      tradeDate: date,
      sourceType,
      reconstructionPhase,
      policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
      policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
      selectedTpMode: recommendedTpMode || 'Skip 2',
      strategyKey: recommendedStrategyOutcome?.strategyKey || recommendedStrategyKey || null,
      strategyName: recommendedStrategyOutcome?.strategyName || recommendedStrategyName || null,
      contextJson,
      candles: Array.isArray(input.sessions?.[date]) ? input.sessions[date] : [],
      runTradeMechanicsVariantTool: input.runTradeMechanicsVariantTool,
    });
    if (lateEntryPolicyV5Row) {
      const persistedLateEntryPolicyV5 = upsertLateEntryPolicyExperimentRow({
        db,
        row: lateEntryPolicyV5Row,
      });
      if (persistedLateEntryPolicyV5) {
        persistedLateEntryPolicyV5.__db = db;
        daily.lateEntryPolicyExperimentV5Row = persistedLateEntryPolicyV5;
        daily.lateEntryPolicyExperimentV5Summary = formatLateEntryPolicyExperimentRow(persistedLateEntryPolicyV5);
        delete persistedLateEntryPolicyV5.__db;
      } else {
        daily.lateEntryPolicyExperimentV5Summary = null;
        daily.lateEntryPolicyExperimentV5Row = null;
      }
    }
  } catch {}

  try {
    const legacyInsert = db.prepare(`
      INSERT INTO jarvis_recommendation_outcome_daily (
        rec_date, posture_evaluation, strategy_score_label, tp_score_label,
        actual_pnl, best_possible_pnl, recommendation_delta, outcome_json, calculated_at
      ) VALUES (
        @rec_date, @posture_evaluation, @strategy_score_label, @tp_score_label,
        @actual_pnl, @best_possible_pnl, @recommendation_delta, @outcome_json, datetime('now')
      )
      ON CONFLICT(rec_date) DO UPDATE SET
        posture_evaluation = excluded.posture_evaluation,
        strategy_score_label = excluded.strategy_score_label,
        tp_score_label = excluded.tp_score_label,
        actual_pnl = excluded.actual_pnl,
        best_possible_pnl = excluded.best_possible_pnl,
        recommendation_delta = excluded.recommendation_delta,
        outcome_json = excluded.outcome_json,
        calculated_at = datetime('now')
    `);
    db.prepare(`
      INSERT INTO jarvis_recommendation_outcome_history (
        rec_date, source_type, reconstruction_phase, reconstruction_version,
        posture_evaluation, strategy_score_label, tp_score_label,
        actual_pnl, best_possible_pnl, recommendation_delta, outcome_json, calculated_at
      ) VALUES (
        @rec_date, @source_type, @reconstruction_phase, @reconstruction_version,
        @posture_evaluation, @strategy_score_label, @tp_score_label,
        @actual_pnl, @best_possible_pnl, @recommendation_delta, @outcome_json, datetime('now')
      )
      ON CONFLICT(rec_date, source_type, reconstruction_phase) DO UPDATE SET
        reconstruction_version = excluded.reconstruction_version,
        posture_evaluation = excluded.posture_evaluation,
        strategy_score_label = excluded.strategy_score_label,
        tp_score_label = excluded.tp_score_label,
        actual_pnl = excluded.actual_pnl,
        best_possible_pnl = excluded.best_possible_pnl,
        recommendation_delta = excluded.recommendation_delta,
        outcome_json = excluded.outcome_json,
        calculated_at = datetime('now')
    `).run({
      rec_date: date,
      source_type: sourceType,
      reconstruction_phase: reconstructionPhase,
      reconstruction_version: reconstructionVersion,
      posture_evaluation: daily.postureEvaluation,
      strategy_score_label: daily.strategyRecommendationScore.scoreLabel,
      tp_score_label: daily.tpRecommendationScore.scoreLabel,
      actual_pnl: daily.actualPnL,
      best_possible_pnl: daily.bestPossiblePnL,
      recommendation_delta: daily.recommendationDelta,
      outcome_json: JSON.stringify(daily),
    });
    if (sourceType === SOURCE_LIVE && reconstructionPhase === PHASE_LIVE_INTRADAY) {
      legacyInsert.run({
        rec_date: date,
        posture_evaluation: daily.postureEvaluation,
        strategy_score_label: daily.strategyRecommendationScore.scoreLabel,
        tp_score_label: daily.tpRecommendationScore.scoreLabel,
        actual_pnl: daily.actualPnL,
        best_possible_pnl: daily.bestPossiblePnL,
        recommendation_delta: daily.recommendationDelta,
        outcome_json: JSON.stringify(daily),
      });
    }
  } catch {}

  return daily;
}

function summarizeWindow(scorecards = []) {
  const rows = Array.isArray(scorecards) ? scorecards.filter(Boolean) : [];
  if (!rows.length) {
    return {
      sampleSize: 0,
      postureAccuracyPct: null,
      strategyAccuracyPct: null,
      tpAccuracyPct: null,
      avgRecommendationDelta: null,
    };
  }
  const posture = rows.map((row) => scoreLabelToNumeric(row.postureEvaluation)).filter((n) => Number.isFinite(n));
  const strategy = rows.map((row) => scoreLabelToNumeric(row?.strategyRecommendationScore?.scoreLabel)).filter((n) => Number.isFinite(n));
  const tp = rows.map((row) => scoreLabelToNumeric(row?.tpRecommendationScore?.scoreLabel)).filter((n) => Number.isFinite(n));
  const deltas = rows.map((row) => toNumber(row.recommendationDelta, null)).filter((n) => Number.isFinite(n));
  const avg = (arr) => (arr.length ? round2((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) : null);
  const avgNumber = (arr) => (arr.length ? round2(arr.reduce((s, n) => s + n, 0) / arr.length) : null);
  return {
    sampleSize: rows.length,
    postureAccuracyPct: avg(posture),
    strategyAccuracyPct: avg(strategy),
    tpAccuracyPct: avg(tp),
    avgRecommendationDelta: avgNumber(deltas),
  };
}

function buildProvenanceSummary(scorecards = []) {
  const rows = Array.isArray(scorecards) ? scorecards.filter(Boolean) : [];
  const bySource = {};
  const byPhase = {};
  const byReconstructionVersion = {};
  for (const row of rows) {
    const source = normalizeSourceType(row?.sourceType);
    const phase = normalizeReconstructionPhase(row?.reconstructionPhase, source);
    const version = normalizeReconstructionVersion(row?.reconstructionVersion, source);
    bySource[source] = Number(bySource[source] || 0) + 1;
    byPhase[phase] = Number(byPhase[phase] || 0) + 1;
    byReconstructionVersion[version] = Number(byReconstructionVersion[version] || 0) + 1;
  }
  return {
    bySource,
    byPhase,
    byReconstructionVersion,
    scoreVersion: SCORE_VERSION,
  };
}

function summarizeShadowPlaybookComparison(scorecards = []) {
  const rows = Array.isArray(scorecards) ? scorecards.filter(Boolean) : [];
  const createLaneBucket = (laneLabel) => ({
    laneLabel,
    eligibleDays: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    noTrade: 0,
    judgedDays: 0,
    winRatePct: null,
    netHypotheticalPnl: 0,
    avgHypotheticalPnl: null,
    shadowBeatsOrbByPnl: 0,
    orbBeatsShadowByPnl: 0,
    pnlTies: 0,
  });
  const updateLaneBucket = (laneBucket, result, pnl, orbPnl) => {
    if (!laneBucket || typeof laneBucket !== 'object') return;
    laneBucket.eligibleDays += 1;
    if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) laneBucket.wins += 1;
    else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) laneBucket.losses += 1;
    else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) laneBucket.flats += 1;
    else laneBucket.noTrade += 1;
    if (Number.isFinite(pnl)) laneBucket.netHypotheticalPnl = round2(laneBucket.netHypotheticalPnl + pnl);
    if (Number.isFinite(pnl) && Number.isFinite(orbPnl)) {
      if (pnl > orbPnl) laneBucket.shadowBeatsOrbByPnl += 1;
      else if (pnl < orbPnl) laneBucket.orbBeatsShadowByPnl += 1;
      else laneBucket.pnlTies += 1;
    }
  };
  const finalizeLaneBucket = (laneBucket) => {
    laneBucket.judgedDays = laneBucket.wins + laneBucket.losses;
    laneBucket.winRatePct = laneBucket.judgedDays > 0
      ? round2((laneBucket.wins / laneBucket.judgedDays) * 100)
      : null;
    laneBucket.avgHypotheticalPnl = laneBucket.eligibleDays > 0
      ? round2(laneBucket.netHypotheticalPnl / laneBucket.eligibleDays)
      : null;
  };
  const buildLaneFilterImpact = (allEligibleDays, allNetPnl, allLosses, laneBreakdown) => {
    const greenLane = laneBreakdown[SHADOW_PLAYBOOK_LANE_GREEN];
    const redLane = laneBreakdown[SHADOW_PLAYBOOK_LANE_RED];
    const allEligibleAvg = allEligibleDays > 0
      ? round2(allNetPnl / allEligibleDays)
      : null;
    return {
      allEligibleAvgHypotheticalPnl: allEligibleAvg,
      greenLaneAvgHypotheticalPnl: greenLane.avgHypotheticalPnl,
      expectancyImprovedVsAll: Number.isFinite(greenLane.avgHypotheticalPnl) && Number.isFinite(allEligibleAvg)
        ? greenLane.avgHypotheticalPnl > allEligibleAvg
        : null,
      redLaneLossSharePct: allLosses > 0
        ? round2((redLane.losses / allLosses) * 100)
        : null,
    };
  };
  const out = {
    playbookKey: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    playbookVersion: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
    trackedDays: 0,
    eligibleDays: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    noTrade: 0,
    netHypotheticalPnl: 0,
    shadowWinOrbLossDays: 0,
    shadowWinOrbNoTradeDays: 0,
    laneBreakdown: {
      [SHADOW_PLAYBOOK_LANE_GREEN]: createLaneBucket(SHADOW_PLAYBOOK_LANE_GREEN),
      [SHADOW_PLAYBOOK_LANE_RED]: createLaneBucket(SHADOW_PLAYBOOK_LANE_RED),
      [SHADOW_PLAYBOOK_LANE_NEUTRAL]: createLaneBucket(SHADOW_PLAYBOOK_LANE_NEUTRAL),
    },
    laneFilterImpact: {
      allEligibleAvgHypotheticalPnl: null,
      greenLaneAvgHypotheticalPnl: null,
      expectancyImprovedVsAll: null,
      redLaneLossSharePct: null,
    },
    predecisionLaneBreakdown: {
      [SHADOW_PLAYBOOK_LANE_GREEN]: createLaneBucket(SHADOW_PLAYBOOK_LANE_GREEN),
      [SHADOW_PLAYBOOK_LANE_RED]: createLaneBucket(SHADOW_PLAYBOOK_LANE_RED),
      [SHADOW_PLAYBOOK_LANE_NEUTRAL]: createLaneBucket(SHADOW_PLAYBOOK_LANE_NEUTRAL),
    },
    predecisionLaneFilterImpact: {
      allEligibleAvgHypotheticalPnl: null,
      greenLaneAvgHypotheticalPnl: null,
      expectancyImprovedVsAll: null,
      redLaneLossSharePct: null,
    },
    laneStability: {
      greenSurvivalCount: 0,
      redSurvivalCount: 0,
      labelsCollapsedToNeutralCount: 0,
      labelsReclassifiedCount: 0,
    },
    latest: null,
  };

  for (const row of rows) {
    const summary = row?.shadowPlaybookComparisonSummary && typeof row.shadowPlaybookComparisonSummary === 'object'
      ? row.shadowPlaybookComparisonSummary
      : null;
    if (!summary) continue;
    out.trackedDays += 1;
    if (summary.eligible === true) out.eligibleDays += 1;
    const result = toText(summary.hypotheticalResult || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE).toLowerCase();
    if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) out.wins += 1;
    else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) out.losses += 1;
    else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) out.flats += 1;
    else out.noTrade += 1;

    const pnl = toNumber(summary.hypotheticalPnl, null);
    if (Number.isFinite(pnl)) out.netHypotheticalPnl = round2(out.netHypotheticalPnl + pnl);
    const overlap = toText(summary.orbOverlapLabel || '').toLowerCase();
    const laneLabel = normalizeShadowPlaybookLaneLabel(summary.laneLabel);
    const predecisionLaneLabel = normalizeShadowPlaybookLaneLabel(summary.predecisionLaneLabel);
    if (overlap === 'shadow_win_orb_loss') out.shadowWinOrbLossDays += 1;
    if (overlap === 'shadow_win_orb_no_trade') out.shadowWinOrbNoTradeDays += 1;
    if (summary.eligible === true) {
      const orbPnl = toNumber(summary.orbPnlDollars, null);
      const lane = out.laneBreakdown[laneLabel] || out.laneBreakdown[SHADOW_PLAYBOOK_LANE_NEUTRAL];
      const predecisionLane = out.predecisionLaneBreakdown[predecisionLaneLabel]
        || out.predecisionLaneBreakdown[SHADOW_PLAYBOOK_LANE_NEUTRAL];
      updateLaneBucket(lane, result, pnl, orbPnl);
      updateLaneBucket(predecisionLane, result, pnl, orbPnl);
      if (laneLabel === SHADOW_PLAYBOOK_LANE_GREEN && predecisionLaneLabel === SHADOW_PLAYBOOK_LANE_GREEN) {
        out.laneStability.greenSurvivalCount += 1;
      }
      if (laneLabel === SHADOW_PLAYBOOK_LANE_RED && predecisionLaneLabel === SHADOW_PLAYBOOK_LANE_RED) {
        out.laneStability.redSurvivalCount += 1;
      }
      if (laneLabel !== SHADOW_PLAYBOOK_LANE_NEUTRAL && predecisionLaneLabel === SHADOW_PLAYBOOK_LANE_NEUTRAL) {
        out.laneStability.labelsCollapsedToNeutralCount += 1;
      }
      if (laneLabel !== predecisionLaneLabel) {
        out.laneStability.labelsReclassifiedCount += 1;
      }
    }
    if (!out.latest || String(row?.date || '') > String(out.latest.tradeDate || '')) {
      out.latest = {
        tradeDate: normalizeDate(row?.date || ''),
        eligible: summary.eligible === true,
        hypotheticalResult: result || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
        hypotheticalPnl: Number.isFinite(pnl) ? round2(pnl) : 0,
        orbOverlapLabel: overlap || 'orb_outcome_unavailable',
        laneLabel,
        laneReasonCodes: Array.isArray(summary.laneReasonCodes) ? summary.laneReasonCodes : [],
        laneScore: Number.isFinite(toNumber(summary.laneScore, null)) ? round2(toNumber(summary.laneScore, null)) : 0,
        highConvictionLaneMatch: summary.highConvictionLaneMatch === true,
        predecisionLaneLabel,
        predecisionLaneReasonCodes: Array.isArray(summary.predecisionLaneReasonCodes)
          ? summary.predecisionLaneReasonCodes
          : [],
        predecisionLaneScore: Number.isFinite(toNumber(summary.predecisionLaneScore, null))
          ? round2(toNumber(summary.predecisionLaneScore, null))
          : 0,
        predecisionHighConvictionLaneMatch: summary.predecisionHighConvictionLaneMatch === true,
        predecisionRemovedReasonCodes: Array.isArray(summary.predecisionRemovedReasonCodes)
          ? summary.predecisionRemovedReasonCodes
          : [],
        predecisionKeptReasonCodes: Array.isArray(summary.predecisionKeptReasonCodes)
          ? summary.predecisionKeptReasonCodes
          : [],
      };
    }
  }
  out.netHypotheticalPnl = round2(out.netHypotheticalPnl);
  for (const lane of Object.values(out.laneBreakdown)) finalizeLaneBucket(lane);
  for (const lane of Object.values(out.predecisionLaneBreakdown)) finalizeLaneBucket(lane);
  out.laneFilterImpact = buildLaneFilterImpact(
    out.eligibleDays,
    out.netHypotheticalPnl,
    out.losses,
    out.laneBreakdown
  );
  out.predecisionLaneFilterImpact = buildLaneFilterImpact(
    out.eligibleDays,
    out.netHypotheticalPnl,
    out.losses,
    out.predecisionLaneBreakdown
  );
  return out;
}

function summarizeShadowPlaybookLaneDurability(scorecards = [], options = {}) {
  const rows = Array.isArray(scorecards) ? scorecards.filter(Boolean) : [];
  const sourceType = toText(options.sourceType || 'all').toLowerCase() || 'all';
  const reconstructionPhase = toText(options.reconstructionPhase || '').toLowerCase()
    || (sourceType === 'all' ? 'mixed' : null);
  const topstepDependency = getTopstepDurabilityDependencyCached(options.db, true);
  const topstepRecoveryWindow = getTopstepRecoveryWindowCached(options.db, topstepDependency, true);
  const truthGapDiagnostics = buildLatestDayTruthGapDiagnostics(options.db, {
    playbookKey: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    playbookVersion: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
  });
  const isExternallyFinalizedRow = (row) => {
    if (!row || typeof row !== 'object') return false;
    if (row.externalExecutionTargetDateInStaleWindow === true) return false;
    const sourceInUse = normalizeRealizedTruthSource(
      row.externalExecutionSourceInUse || REALIZED_TRUTH_SOURCE_NONE
    );
    if (sourceInUse !== REALIZED_TRUTH_SOURCE_PRIMARY && sourceInUse !== REALIZED_TRUTH_SOURCE_SECONDARY) {
      return false;
    }
    return row.externalExecutionSourceBacked === true && row.externalExecutionHasRows === true;
  };
  const uniqueTradeDates = (inputRows = []) => Array.from(
    new Set((Array.isArray(inputRows) ? inputRows : []).map((row) => normalizeDate(row?.tradeDate)).filter(Boolean))
  );
  const calcCoveragePct = (finalizedDays = 0, trackedDays = 0) => (
    trackedDays > 0 ? round2((Number(finalizedDays || 0) / Number(trackedDays || 0)) * 100) : null
  );
  const parseDurabilityRow = (row) => {
    const summary = row?.shadowPlaybookComparisonSummary && typeof row.shadowPlaybookComparisonSummary === 'object'
      ? row.shadowPlaybookComparisonSummary
      : null;
    if (!summary) return null;
    const tradeDate = normalizeDate(row?.date || row?.recDate || summary.tradeDate || '');
    const checkpoint = row?.assistantDecisionOutcomeCheckpoint && typeof row.assistantDecisionOutcomeCheckpoint === 'object'
      ? row.assistantDecisionOutcomeCheckpoint
      : null;
    const external = checkpoint?.externalExecutionOutcome && typeof checkpoint.externalExecutionOutcome === 'object'
      ? checkpoint.externalExecutionOutcome
      : {};
    const externalSourceAttribution = external?.sourceAttribution && typeof external.sourceAttribution === 'object'
      ? external.sourceAttribution
      : {};
    const result = toText(summary.hypotheticalResult || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE).toLowerCase();
    let orbPnl = toNumber(summary.orbPnlDollars, null);
    const overlap = toText(summary.orbOverlapLabel || '').toLowerCase();
    if (!Number.isFinite(orbPnl) && overlap.includes('orb_no_trade')) orbPnl = 0;
    return {
      tradeDate,
      eligible: summary.eligible === true,
      hypotheticalResult: SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_ENUM.includes(result)
        ? result
        : SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE,
      hypotheticalPnl: Number.isFinite(toNumber(summary.hypotheticalPnl, null))
        ? round2(toNumber(summary.hypotheticalPnl, null))
        : null,
      orbPnlDollars: Number.isFinite(orbPnl) ? round2(orbPnl) : null,
      predecisionLaneLabel: normalizeShadowPlaybookLaneLabel(summary.predecisionLaneLabel || SHADOW_PLAYBOOK_LANE_NEUTRAL),
      blockerState: toText(summary.blockerState || checkpoint?.blockerState || '').toLowerCase() || 'unknown',
      posture: toText(summary.posture || checkpoint?.posture || row?.posture || '').toLowerCase() || 'unknown',
      sessionPhase: toText(summary.sessionPhase || row?.timeBucket || '').toLowerCase() || 'unknown',
      skipReason: toText(summary.skipReason || '').toLowerCase() || null,
      dataQualityStatus: toText(summary.dataQualityStatus || '').toLowerCase() || null,
      externalExecutionHasRows: external?.hasRows === true,
      externalExecutionSourceBacked: external?.sourceBacked === true,
      externalExecutionSourceInUse: normalizeRealizedTruthSource(
        external?.sourceInUse
        || externalSourceAttribution?.sourceInUse
        || REALIZED_TRUTH_SOURCE_NONE
      ),
      externalExecutionTrustClassification: normalizeShadowPlaybookDurabilityTrust(
        external?.trustClassification || SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL
      ),
      externalExecutionTargetDateInStaleWindow: externalSourceAttribution?.sourceFreshness?.targetDateInStaleWindow === true
        || externalSourceAttribution?.recoveryPlan?.targetDateInStaleWindow === true,
    };
  };
  const summarizeBucket = (bucketRows = []) => {
    const out = {
      eligibleDays: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      noTrade: 0,
      judgedDays: 0,
      winRatePct: null,
      netHypotheticalPnl: 0,
      avgHypotheticalPnl: null,
      shadowBeatsOrbCount: 0,
      orbBeatsShadowCount: 0,
      pnlTies: 0,
    };
    for (const row of bucketRows) {
      out.eligibleDays += 1;
      const result = toText(row?.hypotheticalResult || SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_NO_TRADE).toLowerCase();
      if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_WIN) out.wins += 1;
      else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_LOSS) out.losses += 1;
      else if (result === SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_FLAT) out.flats += 1;
      else out.noTrade += 1;
      const pnl = toNumber(row?.hypotheticalPnl, null);
      if (Number.isFinite(pnl)) out.netHypotheticalPnl = round2(out.netHypotheticalPnl + pnl);
      const orbPnl = toNumber(row?.orbPnlDollars, null);
      if (Number.isFinite(pnl) && Number.isFinite(orbPnl)) {
        if (pnl > orbPnl) out.shadowBeatsOrbCount += 1;
        else if (pnl < orbPnl) out.orbBeatsShadowCount += 1;
        else out.pnlTies += 1;
      }
    }
    out.judgedDays = out.wins + out.losses;
    out.winRatePct = out.judgedDays > 0 ? round2((out.wins / out.judgedDays) * 100) : null;
    out.avgHypotheticalPnl = out.eligibleDays > 0 ? round2(out.netHypotheticalPnl / out.eligibleDays) : null;
    return out;
  };
  const summarizeWindow = (windowRows = [], windowName = 'full_sample') => {
    const trackedRows = Array.isArray(windowRows) ? windowRows.filter(Boolean) : [];
    const eligibleRows = trackedRows.filter((row) => row.eligible === true);
    const blockedRows = eligibleRows.filter((row) => row.blockerState === 'blocked');
    const predecisionGreenRows = eligibleRows.filter(
      (row) => normalizeShadowPlaybookLaneLabel(row.predecisionLaneLabel) === SHADOW_PLAYBOOK_LANE_GREEN
    );
    const externallyFinalizedRows = trackedRows.filter((row) => isExternallyFinalizedRow(row));
    const externallyUnfinalizedRows = trackedRows.filter((row) => !isExternallyFinalizedRow(row));
    const externallyFinalizedEligibleRows = eligibleRows.filter((row) => isExternallyFinalizedRow(row));
    const externallyUnfinalizedEligibleRows = eligibleRows.filter((row) => !isExternallyFinalizedRow(row));
    const allEligible = summarizeBucket(eligibleRows);
    const blockedOnly = summarizeBucket(blockedRows);
    const predecisionGreen = summarizeBucket(predecisionGreenRows);
    const externallyFinalizedEligible = summarizeBucket(externallyFinalizedEligibleRows);
    const externallyUnfinalizedEligible = summarizeBucket(externallyUnfinalizedEligibleRows);
    const trackedTradeDates = uniqueTradeDates(trackedRows);
    const unfinalizedTradeDates = uniqueTradeDates(externallyUnfinalizedRows);
    return {
      windowName,
      trackedDays: trackedRows.length,
      totalEligibleDays: allEligible.eligibleDays,
      totalPredecisionGreenDays: predecisionGreen.eligibleDays,
      externalFinalizedDays: externallyFinalizedRows.length,
      unfinalizedDays: externallyUnfinalizedRows.length,
      externalCoveragePct: calcCoveragePct(externallyFinalizedRows.length, trackedRows.length),
      externallyFinalizedEligibleDays: externallyFinalizedEligible.eligibleDays,
      externallyUnfinalizedEligibleDays: externallyUnfinalizedEligible.eligibleDays,
      shadowBeatsOrbCount: allEligible.shadowBeatsOrbCount,
      orbBeatsShadowCount: allEligible.orbBeatsShadowCount,
      allEligible,
      blockedOnly,
      predecisionGreen,
      externallyFinalizedEligible,
      externallyUnfinalizedEligible,
      rawShadowExpectancy: allEligible.avgHypotheticalPnl,
      externallyFinalizedExpectancy: externallyFinalizedEligible.avgHypotheticalPnl,
      tradeDates: trackedTradeDates,
      unfinalizedTradeDates,
    };
  };
  const selectExpectancyMetric = (windowSummary = {}) => {
    const candidates = [
      {
        metric: 'predecision_green_avg_hypothetical_pnl',
        value: toNumber(windowSummary?.predecisionGreen?.avgHypotheticalPnl, null),
        sampleSize: Number(windowSummary?.predecisionGreen?.eligibleDays || 0),
      },
      {
        metric: 'blocked_only_avg_hypothetical_pnl',
        value: toNumber(windowSummary?.blockedOnly?.avgHypotheticalPnl, null),
        sampleSize: Number(windowSummary?.blockedOnly?.eligibleDays || 0),
      },
      {
        metric: 'all_eligible_avg_hypothetical_pnl',
        value: toNumber(windowSummary?.allEligible?.avgHypotheticalPnl, null),
        sampleSize: Number(windowSummary?.allEligible?.eligibleDays || 0),
      },
    ];
    return candidates.find((entry) => Number.isFinite(entry.value) && entry.sampleSize > 0) || null;
  };

  const parsedRows = rows
    .map(parseDurabilityRow)
    .filter(Boolean)
    .sort((a, b) => String(b.tradeDate || '').localeCompare(String(a.tradeDate || '')));
  const latestEligibleShadowRow = parsedRows.find((row) => row.eligible === true) || null;
  const latestEligibleShadowTradeDate = normalizeDate(latestEligibleShadowRow?.tradeDate || '');
  const latestEligibleShadowExternallyFinalized = latestEligibleShadowRow
    ? isExternallyFinalizedRow(latestEligibleShadowRow)
    : false;
  const latestEligibleShadowTruthStatus = !latestEligibleShadowRow
    ? 'unavailable'
    : (
      latestEligibleShadowExternallyFinalized
        ? 'externally_finalized'
        : (
          latestEligibleShadowRow?.externalExecutionTargetDateInStaleWindow === true
            ? 'provisional_external_unfinalized'
            : 'internally_inferred_only'
        )
    );
  const latestEligibleShadowTruthLine = !latestEligibleShadowRow
    ? 'Failed-extension has no eligible shadow row yet.'
    : (
      latestEligibleShadowExternallyFinalized
        ? `Latest eligible failed-extension row (${latestEligibleShadowTradeDate || 'unknown'}) is externally finalized.`
        : (
          latestEligibleShadowRow?.externalExecutionTargetDateInStaleWindow === true
            ? `Latest eligible failed-extension row (${latestEligibleShadowTradeDate || 'unknown'}) is provisional only because external truth is still in the stale window.`
            : `Latest eligible failed-extension row (${latestEligibleShadowTradeDate || 'unknown'}) is internal/shadow only and not externally finalized.`
        )
    );
  const skipReasonBreakdown = {};
  let missingSessionCandlesRows = 0;
  let checkpointRows = 0;
  let externalExecutionRowsWithTrades = 0;
  let externalExecutionSourceBackedRows = 0;
  const externalExecutionSourceInUseBreakdown = {
    [REALIZED_TRUTH_SOURCE_PRIMARY]: 0,
    [REALIZED_TRUTH_SOURCE_SECONDARY]: 0,
    [REALIZED_TRUTH_SOURCE_TERTIARY]: 0,
    [REALIZED_TRUTH_SOURCE_NONE]: 0,
  };
  const externalExecutionTrustBreakdown = {
    [SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE]: 0,
    [SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL]: 0,
    [SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY]: 0,
  };
  let externalExecutionStaleWindowRows = 0;
  for (const row of parsedRows) {
    const skipReason = toText(row?.skipReason || '').toLowerCase();
    if (skipReason) {
      skipReasonBreakdown[skipReason] = Number(skipReasonBreakdown[skipReason] || 0) + 1;
      if (skipReason === 'missing_session_candles') missingSessionCandlesRows += 1;
    }
    if (row?.externalExecutionHasRows === true) externalExecutionRowsWithTrades += 1;
    if (row?.externalExecutionSourceBacked === true) externalExecutionSourceBackedRows += 1;
    if (row?.externalExecutionHasRows === true || row?.externalExecutionSourceBacked === true) checkpointRows += 1;
    const sourceInUse = normalizeRealizedTruthSource(row?.externalExecutionSourceInUse || REALIZED_TRUTH_SOURCE_NONE);
    externalExecutionSourceInUseBreakdown[sourceInUse] = Number(
      externalExecutionSourceInUseBreakdown[sourceInUse] || 0
    ) + 1;
    const trustClass = normalizeShadowPlaybookDurabilityTrust(
      row?.externalExecutionTrustClassification || SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL
    );
    externalExecutionTrustBreakdown[trustClass] = Number(
      externalExecutionTrustBreakdown[trustClass] || 0
    ) + 1;
    if (row?.externalExecutionTargetDateInStaleWindow === true) externalExecutionStaleWindowRows += 1;
  }
  const shadowRowsPresent = parsedRows.length;
  const shadowRowsMissingSummary = Math.max(0, rows.length - shadowRowsPresent);
  const asOfTradeDate = parsedRows.length > 0 ? normalizeDate(parsedRows[0].tradeDate) : null;
  const fullSampleStats = summarizeWindow(parsedRows, 'full_sample');
  const rolling5DayStats = summarizeWindow(
    parsedRows.slice(0, SHADOW_PLAYBOOK_DURABILITY_ROLLING_5),
    'rolling_5_day'
  );
  const rolling10DayStats = summarizeWindow(
    parsedRows.slice(0, SHADOW_PLAYBOOK_DURABILITY_ROLLING_10),
    'rolling_10_day'
  );
  const fullExpectancy = selectExpectancyMetric(fullSampleStats);
  const rolling5Expectancy = selectExpectancyMetric(rolling5DayStats);
  const rolling10Expectancy = selectExpectancyMetric(rolling10DayStats);
  const recentExpectancy = rolling5Expectancy || rolling10Expectancy;
  const recentWindowUsed = rolling5Expectancy ? 'rolling_5_day' : (rolling10Expectancy ? 'rolling_10_day' : null);
  const trendDeltaAvgHypotheticalPnl = (
    fullExpectancy && recentExpectancy
  )
    ? round2(recentExpectancy.value - fullExpectancy.value)
    : null;
  let trendVerdict = SHADOW_PLAYBOOK_DURABILITY_TREND_FLAT;
  if (Number.isFinite(trendDeltaAvgHypotheticalPnl)) {
    if (trendDeltaAvgHypotheticalPnl >= SHADOW_PLAYBOOK_DURABILITY_TREND_DELTA_THRESHOLD_PNL) {
      trendVerdict = SHADOW_PLAYBOOK_DURABILITY_TREND_IMPROVING;
    } else if (trendDeltaAvgHypotheticalPnl <= -SHADOW_PLAYBOOK_DURABILITY_TREND_DELTA_THRESHOLD_PNL) {
      trendVerdict = SHADOW_PLAYBOOK_DURABILITY_TREND_DEGRADING;
    }
  }

  const promotionReadinessThresholds = {
    minFullExternalCoveragePct: Number.isFinite(toNumber(options.minFullExternalCoveragePct, null))
      ? Math.max(0, Math.min(100, round2(toNumber(options.minFullExternalCoveragePct, 0))))
      : SHADOW_PLAYBOOK_PROMOTION_MIN_FULL_EXTERNAL_COVERAGE_PCT,
    minRolling5ExternalCoveragePct: Number.isFinite(toNumber(options.minRolling5ExternalCoveragePct, null))
      ? Math.max(0, Math.min(100, round2(toNumber(options.minRolling5ExternalCoveragePct, 0))))
      : SHADOW_PLAYBOOK_PROMOTION_MIN_ROLLING5_EXTERNAL_COVERAGE_PCT,
    minRolling10ExternalCoveragePct: Number.isFinite(toNumber(options.minRolling10ExternalCoveragePct, null))
      ? Math.max(0, Math.min(100, round2(toNumber(options.minRolling10ExternalCoveragePct, 0))))
      : SHADOW_PLAYBOOK_PROMOTION_MIN_ROLLING10_EXTERNAL_COVERAGE_PCT,
    minExternallyFinalizedEligibleDays: Number.isFinite(toNumber(options.minExternallyFinalizedEligibleDays, null))
      ? Math.max(1, Math.trunc(toNumber(options.minExternallyFinalizedEligibleDays, 1)))
      : SHADOW_PLAYBOOK_PROMOTION_MIN_EXTERNALLY_FINALIZED_ELIGIBLE_DAYS,
    minEligibleDays: Number.isFinite(toNumber(options.minEligibleDays, null))
      ? Math.max(1, Math.trunc(toNumber(options.minEligibleDays, 1)))
      : SHADOW_PLAYBOOK_PROMOTION_MIN_ELIGIBLE_DAYS,
  };
  const staleWindowStartDate = normalizeDate(topstepRecoveryWindow?.staleWindowStartDate || '');
  const staleWindowEndDate = normalizeDate(topstepRecoveryWindow?.staleWindowEndDate || '');
  const isDateInStaleWindow = (isoDate = '') => {
    const date = normalizeDate(isoDate);
    if (!date) return false;
    if (topstepRecoveryWindow?.backfillPending !== true) return false;
    if (!staleWindowStartDate || !staleWindowEndDate) return false;
    return date >= staleWindowStartDate && date <= staleWindowEndDate;
  };
  const staleWindowOverlapDatesForWindow = (windowSummary = {}) => {
    const dates = Array.isArray(windowSummary?.tradeDates)
      ? windowSummary.tradeDates.map((date) => normalizeDate(date)).filter(Boolean)
      : [];
    return dates.filter((date) => isDateInStaleWindow(date));
  };
  const rolling5StaleOverlapDates = staleWindowOverlapDatesForWindow(rolling5DayStats);
  const rolling10StaleOverlapDates = staleWindowOverlapDatesForWindow(rolling10DayStats);
  const staleWindowOverlapsRolling5 = rolling5StaleOverlapDates.length > 0;
  const staleWindowOverlapsRolling10 = rolling10StaleOverlapDates.length > 0;
  const latestDayProvisional = isDateInStaleWindow(asOfTradeDate);
  const latestDayProvisionalReason = latestDayProvisional
    ? 'latest_trade_date_is_in_external_stale_window'
    : null;
  const fullExternalCoveragePct = toNumber(fullSampleStats.externalCoveragePct, 0) || 0;
  const rolling5ExternalCoveragePct = toNumber(rolling5DayStats.externalCoveragePct, 0) || 0;
  const rolling10ExternalCoveragePct = toNumber(rolling10DayStats.externalCoveragePct, 0) || 0;
  const externallyFinalizedEligibleDays = Number(fullSampleStats.externallyFinalizedEligibleDays || 0);
  const externallyUnfinalizedEligibleDays = Number(fullSampleStats.externallyUnfinalizedEligibleDays || 0);
  const promotionReadinessBlockReasons = [];
  const addPromotionBlockReason = (reason) => {
    const token = toText(reason).toLowerCase();
    if (token && !promotionReadinessBlockReasons.includes(token)) promotionReadinessBlockReasons.push(token);
  };
  if (staleWindowOverlapsRolling5) addPromotionBlockReason('stale_window_overlaps_rolling_5');
  if (staleWindowOverlapsRolling10) addPromotionBlockReason('stale_window_overlaps_rolling_10');
  if (fullExternalCoveragePct < promotionReadinessThresholds.minFullExternalCoveragePct) {
    addPromotionBlockReason('full_external_coverage_below_threshold');
  }
  if (rolling5ExternalCoveragePct < promotionReadinessThresholds.minRolling5ExternalCoveragePct) {
    addPromotionBlockReason('rolling5_external_coverage_below_threshold');
  }
  if (rolling10ExternalCoveragePct < promotionReadinessThresholds.minRolling10ExternalCoveragePct) {
    addPromotionBlockReason('rolling10_external_coverage_below_threshold');
  }
  if (externallyFinalizedEligibleDays < promotionReadinessThresholds.minExternallyFinalizedEligibleDays) {
    addPromotionBlockReason('externally_finalized_eligible_sample_too_small');
  }
  if (Number(fullSampleStats.totalEligibleDays || 0) < promotionReadinessThresholds.minEligibleDays) {
    addPromotionBlockReason('raw_eligible_sample_too_small');
  }
  if (latestEligibleShadowRow && !latestEligibleShadowExternallyFinalized) {
    addPromotionBlockReason('latest_eligible_shadow_day_not_externally_finalized');
  }
  if (latestDayProvisional) addPromotionBlockReason('latest_day_provisional');
  const promotionReadinessStatus = promotionReadinessBlockReasons.length > 0
    ? SHADOW_PLAYBOOK_PROMOTION_READINESS_BLOCKED
    : SHADOW_PLAYBOOK_PROMOTION_READINESS_READY;
  const promotionReadinessBlockReason = promotionReadinessBlockReasons[0] || null;
  let coverageAwareTrustClassification = SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE;
  if (promotionReadinessBlockReasons.length > 0) {
    const severePromotionCoverageReasons = new Set([
      'stale_window_overlaps_rolling_5',
      'stale_window_overlaps_rolling_10',
      'full_external_coverage_below_threshold',
      'rolling5_external_coverage_below_threshold',
      'rolling10_external_coverage_below_threshold',
      'latest_day_provisional',
    ]);
    coverageAwareTrustClassification = promotionReadinessBlockReasons.some((reason) => severePromotionCoverageReasons.has(reason))
      ? SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY
      : SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL;
  }
  const promotableExpectancyView = promotionReadinessStatus === SHADOW_PLAYBOOK_PROMOTION_READINESS_READY
    ? {
      metric: 'externally_finalized_eligible_avg_hypothetical_pnl',
      value: Number.isFinite(toNumber(fullSampleStats?.externallyFinalizedEligible?.avgHypotheticalPnl, null))
        ? round2(toNumber(fullSampleStats.externallyFinalizedEligible.avgHypotheticalPnl, 0))
        : null,
      sampleSize: externallyFinalizedEligibleDays,
      qualifiesForPromotionInterpretation: true,
    }
    : {
      metric: 'externally_finalized_eligible_avg_hypothetical_pnl',
      value: null,
      sampleSize: externallyFinalizedEligibleDays,
      qualifiesForPromotionInterpretation: false,
      blockedReason: promotionReadinessBlockReason,
    };

  const trustSeverity = {
    [SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE]: 0,
    [SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL]: 1,
    [SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY]: 2,
  };
  let trustOverall = SHADOW_PLAYBOOK_DURABILITY_TRUST_SAFE;
  const reasonCodes = [];
  const safeSections = [];
  const degradedSections = [];
  const unavailableSections = [];
  const addReason = (reason) => {
    const token = toText(reason).toLowerCase();
    if (token && !reasonCodes.includes(token)) reasonCodes.push(token);
  };
  const addSection = (list, section) => {
    const token = toText(section).toLowerCase();
    if (token && !list.includes(token)) list.push(token);
  };
  const degradeTo = (target) => {
    const next = normalizeShadowPlaybookDurabilityTrust(target);
    if ((trustSeverity[next] || 0) > (trustSeverity[trustOverall] || 0)) trustOverall = next;
  };

  if (shadowRowsPresent > 0) {
    addSection(safeSections, 'shadow_tracking_rows');
    addSection(safeSections, 'shadow_skip_reason_breakdown');
  } else {
    addReason('no_shadow_rows_in_scope');
    addSection(unavailableSections, 'shadow_tracking_rows');
    addSection(unavailableSections, 'shadow_lane_expectancy');
    addSection(unavailableSections, 'shadow_lane_trend');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY);
  }

  if (fullSampleStats.totalEligibleDays > 0) {
    addSection(safeSections, 'shadow_lane_expectancy');
    addSection(safeSections, 'rolling_lane_trend');
  } else {
    addReason('no_eligible_shadow_days_in_scope');
    addSection(unavailableSections, 'shadow_lane_expectancy');
    addSection(unavailableSections, 'rolling_lane_trend');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY);
  }

  if (missingSessionCandlesRows > 0) {
    addReason('missing_session_candles_present');
    addSection(degradedSections, 'session_candle_coverage');
    const missingRatio = shadowRowsPresent > 0
      ? (missingSessionCandlesRows / shadowRowsPresent)
      : 0;
    if (missingRatio >= 0.5) {
      addReason('missing_session_candles_dominant');
      degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY);
    } else {
      degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
    }
  }

  if (fullSampleStats.totalEligibleDays > 0 && fullSampleStats.totalEligibleDays < 5) {
    addReason('thin_eligible_sample');
    addSection(degradedSections, 'durability_confidence');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
  }

  if (topstepDependency?.topstepSync?.status === 'degraded') {
    addReason('topstep_sync_unhealthy');
    addSection(degradedSections, 'external_execution_alignment');
    addSection(degradedSections, 'divergence_overlay');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
  }

  if (topstepRecoveryWindow?.backfillPending === true && checkpointRows > 0) {
    addReason('topstep_backfill_pending');
    addSection(degradedSections, 'external_execution_backfill_window');
    if (externalExecutionStaleWindowRows > 0) {
      addReason('stale_window_rows_detected');
      degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY);
    } else {
      degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
    }
  }

  if (checkpointRows > 0 && externalExecutionRowsWithTrades === 0) {
    addReason('no_external_execution_rows_with_trades_in_scope');
    addSection(degradedSections, 'external_execution_alignment');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
  }

  if (checkpointRows > 0 && externalExecutionSourceBackedRows === 0) {
    addReason('external_execution_not_source_backed_in_scope');
    addSection(degradedSections, 'external_execution_alignment');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
  }

  if (Number(externalExecutionSourceInUseBreakdown[REALIZED_TRUTH_SOURCE_TERTIARY] || 0) > 0) {
    addReason('tertiary_realized_truth_fallback_used');
    addSection(degradedSections, 'external_execution_alignment');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY);
  }

  if (Number(externalExecutionSourceInUseBreakdown[REALIZED_TRUTH_SOURCE_SECONDARY] || 0) > 0) {
    addReason('secondary_realized_truth_fallback_used');
    addSection(degradedSections, 'external_execution_alignment');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_PARTIAL);
  }

  if (promotionReadinessStatus === SHADOW_PLAYBOOK_PROMOTION_READINESS_BLOCKED) {
    addSection(degradedSections, 'promotion_readiness_truth_coverage');
    for (const reason of promotionReadinessBlockReasons) addReason(`promotion_block_${reason}`);
    degradeTo(coverageAwareTrustClassification);
  }
  if (latestDayProvisional) {
    addReason('latest_day_provisional');
    addSection(degradedSections, 'latest_day_interpretation');
    degradeTo(SHADOW_PLAYBOOK_DURABILITY_TRUST_UNTRUSTWORTHY);
  }

  return {
    playbookKey: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
    playbookVersion: SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
    sourceType,
    reconstructionPhase,
    asOfTradeDate,
    trackedDays: fullSampleStats.trackedDays,
    totalEligibleDays: fullSampleStats.totalEligibleDays,
    totalPredecisionGreenDays: fullSampleStats.totalPredecisionGreenDays,
    externalFinalizedDays: Number(fullSampleStats.externalFinalizedDays || 0),
    unfinalizedDays: Number(fullSampleStats.unfinalizedDays || 0),
    externalCoveragePct: fullSampleStats.externalCoveragePct,
    rolling5ExternalFinalizedDays: Number(rolling5DayStats.externalFinalizedDays || 0),
    rolling5ExternalCoveragePct: rolling5DayStats.externalCoveragePct,
    rolling10ExternalFinalizedDays: Number(rolling10DayStats.externalFinalizedDays || 0),
    rolling10ExternalCoveragePct: rolling10DayStats.externalCoveragePct,
    unfinalizedTradeDates: Array.isArray(fullSampleStats.unfinalizedTradeDates)
      ? fullSampleStats.unfinalizedTradeDates
      : [],
    truthGapDiagnostics,
    latestDayAccountabilityStatus: truthGapDiagnostics.latest_day_accountability_status,
    latestDayAccountabilityLine: truthGapDiagnostics.latest_day_accountability_line,
    latestEligibleShadowTradeDate: latestEligibleShadowTradeDate || null,
    latestEligibleShadowTruthStatus,
    latestEligibleShadowExternallyFinalized,
    latestEligibleShadowProvisional: latestEligibleShadowTruthStatus === 'provisional_external_unfinalized',
    latestEligibleShadowTruthLine,
    externallyFinalizedEligibleDays,
    externallyUnfinalizedEligibleDays,
    promotionReadinessStatus,
    promotionReadinessBlockReason,
    promotionReadinessBlockReasons,
    promotionReadinessThresholds,
    coverageAwareTrustClassification,
    latestDayProvisional,
    latestDayProvisionalReason,
    shadowBeatsOrbCount: fullSampleStats.shadowBeatsOrbCount,
    orbBeatsShadowCount: fullSampleStats.orbBeatsShadowCount,
    rawShadowExpectancy: fullSampleStats.rawShadowExpectancy,
    externallyFinalizedExpectancy: fullSampleStats.externallyFinalizedExpectancy,
    promotableExpectancyView,
    fullSampleStats,
    rolling5DayStats,
    rolling10DayStats,
    trendVerdict,
    durabilityTrust: {
      overall: trustOverall,
      coverageAwareTrustClassification,
      reasonCodes,
      safeSections,
      degradedSections,
      unavailableSections,
      trackedScorecards: rows.length,
      shadowRowsPresent,
      shadowRowsMissingSummary,
      eligibleDays: Number(fullSampleStats.totalEligibleDays || 0),
      checkpointRows,
      externalExecutionRowsWithTrades,
      externalExecutionSourceBackedRows,
      externalExecutionSourceInUseBreakdown,
      externalExecutionTrustBreakdown,
      externalExecutionStaleWindowRows,
      skipReasonBreakdown,
      missingSessionCandlesRows,
      topstepDependency,
      topstepRecoveryWindow,
      promotionReadinessStatus,
      promotionReadinessBlockReason,
      promotionReadinessBlockReasons,
      promotionReadinessThresholds,
      externallyFinalizedEligibleDays,
      externallyUnfinalizedEligibleDays,
      latestDayProvisional,
      latestDayProvisionalReason,
      latestDayAccountabilityStatus: truthGapDiagnostics.latest_day_accountability_status,
      latestDayAccountabilityLine: truthGapDiagnostics.latest_day_accountability_line,
      latestEligibleShadowTradeDate: latestEligibleShadowTradeDate || null,
      latestEligibleShadowTruthStatus,
      latestEligibleShadowExternallyFinalized,
      latestEligibleShadowProvisional: latestEligibleShadowTruthStatus === 'provisional_external_unfinalized',
      latestEligibleShadowTruthLine,
      truthGapDiagnostics,
      staleWindowOverlapsRolling5,
      staleWindowOverlapsRolling10,
      rolling5StaleOverlapDates,
      rolling10StaleOverlapDates,
      realizedTruthFallback: {
        primarySource: REALIZED_TRUTH_SOURCE_PRIMARY,
        sourceInUseBreakdown: externalExecutionSourceInUseBreakdown,
        trustBreakdown: externalExecutionTrustBreakdown,
        staleWindowRows: externalExecutionStaleWindowRows,
        backfillPending: topstepRecoveryWindow?.backfillPending === true,
        staleWindowStartDate: topstepRecoveryWindow?.staleWindowStartDate || null,
        staleWindowEndDate: topstepRecoveryWindow?.staleWindowEndDate || null,
        staleWindowDays: Number(topstepRecoveryWindow?.staleWindowDays || 0),
        deterministicActions: [
          'restore_topstep_credentials_or_access',
          'run_topstep_sync',
          'run_topstep_auto_journal',
          'recompute_recommendation_performance',
        ],
      },
    },
    trendComputation: {
      thresholdPnl: SHADOW_PLAYBOOK_DURABILITY_TREND_DELTA_THRESHOLD_PNL,
      fullExpectancyMetric: fullExpectancy,
      recentExpectancyMetric: recentExpectancy,
      recentWindowUsed,
      trendDeltaAvgHypotheticalPnl,
    },
    advisoryOnly: true,
  };
}

function summarizeRecommendationPerformance(perf = {}) {
  const s30 = summarizeWindow(perf?.scorecards30d || []);
  const s90 = summarizeWindow(perf?.scorecards90d || []);
  const sourceBreakdown = perf?.sourceBreakdown && typeof perf.sourceBreakdown === 'object'
    ? perf.sourceBreakdown
    : { live: 0, backfill: 0, total: 0 };
  const rowCountUsed = Number.isFinite(Number(perf?.rowCountUsed))
    ? Number(perf.rowCountUsed)
    : Number(sourceBreakdown.total || 0);
  const oldestRecordDate = toText(perf?.oldestRecordDate || '') || null;
  const newestRecordDate = toText(perf?.newestRecordDate || '') || null;
  const provenanceSummary = perf?.provenanceSummary && typeof perf.provenanceSummary === 'object'
    ? perf.provenanceSummary
    : buildProvenanceSummary(perf?.scorecards || []);
  const reconstructionPhase = toText(perf?.reconstructionPhase || '') || null;
  const calibrationWarnings = Array.isArray(perf?.calibrationWarnings)
    ? perf.calibrationWarnings
    : [];
  const shadowPlaybookComparisonSummary = summarizeShadowPlaybookComparison(perf?.scorecards || []);
  const shadowPlaybookLaneDurability = perf?.shadowPlaybookLaneDurability
    && typeof perf.shadowPlaybookLaneDurability === 'object'
    ? perf.shadowPlaybookLaneDurability
    : summarizeShadowPlaybookLaneDurability(perf?.scorecards || [], {
      sourceType: perf?.sourceBreakdown?.backfill > 0 && Number(perf?.sourceBreakdown?.live || 0) === 0
        ? SOURCE_BACKFILL
        : 'all',
      reconstructionPhase: perf?.reconstructionPhase || null,
    });
  return {
    postureAccuracy30d: s30.postureAccuracyPct,
    strategyAccuracy30d: s30.strategyAccuracyPct,
    tpAccuracy30d: s30.tpAccuracyPct,
    postureAccuracy90d: s90.postureAccuracyPct,
    strategyAccuracy90d: s90.strategyAccuracyPct,
    tpAccuracy90d: s90.tpAccuracyPct,
    avgRecommendationDelta: s30.avgRecommendationDelta,
    sampleSize30d: s30.sampleSize,
    sampleSize90d: s90.sampleSize,
    lastEvaluatedDate: perf?.scorecards?.[0]?.date || null,
    rowCountUsed,
    oldestRecordDate,
    newestRecordDate,
    sourceBreakdown,
    provenanceSummary,
    shadowPlaybookComparisonSummary,
    shadowPlaybookLaneDurability,
    lateEntryPolicyExperiment: null,
    lateEntryPolicyExperimentV2: null,
    lateEntryPolicyExperimentV3: null,
    lateEntryPolicyExperimentV4: null,
    lateEntryPolicyExperimentV5: null,
    lateEntryPolicyV2VsV1Delta: null,
    lateEntryPolicyV3VsV2Delta: null,
    lateEntryPolicyV3VsV1Delta: null,
    lateEntryPolicyV4VsV3Delta: null,
    lateEntryPolicyV4VsV2Delta: null,
    lateEntryPolicyV4VsV1Delta: null,
    lateEntryPolicyV5VsV4Delta: null,
    lateEntryPolicyV5VsV3Delta: null,
    lateEntryPolicyV5VsV2Delta: null,
    lateEntryPolicyV5VsV1Delta: null,
    lateEntryPolicyCommonDateComparison: null,
    lateEntryShadowLeader: null,
    lateEntryPolicyPromotionReadiness: null,
    lateEntryPolicyV5LatestDay: null,
    lateEntryPolicyV5RecentShadowScore: null,
    lateEntryPolicyV5PocketMap: null,
    lateEntryPolicyTruthCoverageBacklog: null,
    lateEntryPolicyTruthCoverageLedger: null,
    lateEntryPolicyTruthFinalizationQueue: null,
    lateEntryPolicyTruthBlockerDiagnostics: null,
    lateEntryPolicyContextGapAudit: null,
    lateEntryPolicyContextBackfillRun: null,
    lateEntryPolicyTruthDependencySplit: null,
    lateEntryPolicyTruthBackfillRun: null,
    lateEntryPolicyCoverageAccelerationSummary: null,
    lateEntryPolicyPromotionDossier: null,
    lateEntryPolicyManualReviewTrigger: null,
    lateEntryPolicyTruthAccumulationTrend: null,
    lateEntryPolicyMissingDateAudit: null,
    lateEntryPolicyV1VsV4MissedTradeLedger: null,
    lateEntryPolicyTrustIfV4MissingDatesRepaired: null,
    lateEntryPolicyLine: 'Late-entry Skip 2 extension (shadow): unavailable.',
    lateEntryPolicyV2Line: 'Late-entry Skip 2 extension v2 (shadow): unavailable.',
    lateEntryPolicyV3Line: 'Late-entry Skip 2 extension v3 (shadow): unavailable.',
    lateEntryPolicyV4Line: 'Late-entry Skip 2 extension v4 (shadow): unavailable.',
    lateEntryPolicyV5Line: 'Late-entry Skip 2 extension v5 (shadow): unavailable.',
    lateEntryReplayReferenceLine: 'Late-entry broad replay reference: unavailable.',
    lateEntryPolicyCommonDateLine: 'Late-entry common-date comparison: unavailable.',
    lateEntryShadowLeaderLine: 'Late-entry shadow leader: unavailable.',
    lateEntryPolicyPromotionReadinessLine: 'Late-entry promotion readiness: unavailable.',
    lateEntryPolicyV5LatestDayLine: 'Late-entry v5 latest relevant day: unavailable.',
    lateEntryPolicyV5PocketMapLine: 'Late-entry v5 pocket map: unavailable.',
    lateEntryPolicyTruthCoverageBacklogLine: 'Late-entry truth coverage backlog: unavailable.',
    lateEntryPolicyTruthCoverageLedgerLine: 'Late-entry truth coverage ledger: unavailable.',
    lateEntryPolicyTruthFinalizationQueueLine: 'Late-entry truth finalization queue: unavailable.',
    lateEntryPolicyTruthBlockerDiagnosticsLine: 'Late-entry truth blocker diagnostics: unavailable.',
    lateEntryPolicyContextGapAuditLine: 'Late-entry context gap audit: unavailable.',
    lateEntryPolicyContextBackfillRunLine: 'Late-entry context backfill run: unavailable.',
    lateEntryPolicyTruthDependencySplitLine: 'Late-entry truth dependency split: unavailable.',
    lateEntryPolicyTruthBackfillRunLine: 'Late-entry truth backfill run: unavailable.',
    lateEntryPolicyCoverageAccelerationSummaryLine: 'Late-entry coverage acceleration: unavailable.',
    lateEntryPolicyPromotionDossierLine: 'Late-entry promotion dossier: unavailable.',
    lateEntryPolicyManualReviewTriggerLine: 'Late-entry manual review trigger: unavailable.',
    lateEntryPolicyTruthAccumulationTrendLine: 'Late-entry truth accumulation trend: unavailable.',
    lateEntryPolicyMissingDateAuditLine: 'Late-entry v4 missing-date audit: unavailable.',
    lateEntryPolicyV1VsV4GapLine: 'Late-entry strict v1-v4 gap: unavailable.',
    lateEntryPolicyTrustIfV4MissingDatesRepairedLine: 'Late-entry trust-repair projection: unavailable.',
    jarvisSimulatedTrade: null,
    jarvisSimulatedTradeLine: 'Jarvis simulated today: unavailable.',
    jarvisSimulatedTradeTpComparison: null,
    reconstructionPhase,
    calibrationWarnings,
    advisoryOnly: true,
    warnings: perf?.warnings || [],
  };
}

function buildRecommendationPerformance(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      generatedAt: new Date().toISOString(),
      scorecards: [],
      scorecards30d: [],
      scorecards90d: [],
      summary: summarizeRecommendationPerformance({ scorecards: [] }),
      warnings: ['db_unavailable'],
    };
  }
  ensureRecommendationOutcomeSchema(db);
  const maxRecords = Math.max(1, Math.min(500, Number(input.maxRecords || input.windowSessions || 120)));
  const source = toText(input.source || 'all').toLowerCase();
  const sourceFilter = source === SOURCE_LIVE || source === SOURCE_BACKFILL ? source : 'all';
  const reconstructionPhaseFilter = toText(input.reconstructionPhase || '').toLowerCase();
  const contexts = Array.isArray(input.contextRows)
    ? input.contextRows.slice(0, maxRecords)
    : listRecommendationContexts(db, {
      limit: maxRecords,
      source: sourceFilter,
      reconstructionPhase: reconstructionPhaseFilter || undefined,
    });
  const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const strategySnapshot = input.strategySnapshot || {};
  const runTradeMechanicsVariantTool = input.runTradeMechanicsVariantTool;

  const scorecards = [];
  for (const row of contexts) {
    const score = evaluateRecommendationOutcomeDay({
      db,
      date: row.rec_date,
      contextRow: row,
      sessions,
      strategySnapshot,
      runTradeMechanicsVariantTool,
    });
    if (score) scorecards.push(score);
  }
  scorecards.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const scorecards30d = scorecards.slice(0, 30);
  const scorecards90d = scorecards.slice(0, 90);
  const warnings = [];
  const calibrationWarnings = [];
  if (scorecards30d.length < 10) warnings.push('thin_sample_30d');
  if (scorecards90d.length < 20) warnings.push('thin_sample_90d');
  if (scorecards.length < 30) calibrationWarnings.push('insufficient_calibration_sample');
  if (sourceFilter === SOURCE_BACKFILL) calibrationWarnings.push('retrospective_scoring_only');
  if (sourceFilter === 'all' && scorecards.some((s) => s.sourceType === SOURCE_BACKFILL)) {
    calibrationWarnings.push('mixed_live_and_backfill_sources');
  }

  const sourceBreakdown = scorecards.reduce((acc, row) => {
    const src = normalizeSourceType(row?.sourceType);
    if (src === SOURCE_BACKFILL) acc.backfill += 1;
    else acc.live += 1;
    acc.total += 1;
    return acc;
  }, { live: 0, backfill: 0, total: 0 });
  const uniquePhases = Array.from(new Set(scorecards.map((s) => toText(s?.reconstructionPhase || '')).filter(Boolean)));
  const reconstructionPhase = uniquePhases.length === 1
    ? uniquePhases[0]
    : (uniquePhases.length > 1 ? 'mixed' : (reconstructionPhaseFilter || null));
  const rowCountUsed = scorecards.length;
  const newestRecordDate = rowCountUsed ? normalizeDate(scorecards[0]?.date) : null;
  const oldestRecordDate = rowCountUsed ? normalizeDate(scorecards[rowCountUsed - 1]?.date) : null;
  const provenanceSummary = buildProvenanceSummary(scorecards);

  const summary = summarizeRecommendationPerformance({
    scorecards,
    scorecards30d,
    scorecards90d,
    rowCountUsed,
    oldestRecordDate,
    newestRecordDate,
    sourceBreakdown,
    provenanceSummary,
    reconstructionPhase,
    calibrationWarnings,
    warnings,
  });
  const shadowPlaybookLaneDurability = summarizeShadowPlaybookLaneDurability(scorecards, {
    db,
    sourceType: sourceFilter,
    reconstructionPhase,
  });
  let shadowPlaybookLaneDurabilityPersisted = null;
  try {
    shadowPlaybookLaneDurabilityPersisted = upsertShadowPlaybookDurabilitySummary({
      db,
      summary: shadowPlaybookLaneDurability,
      sourceType: sourceFilter,
      reconstructionPhase,
    });
  } catch {}
  const shadowPlaybookLaneDurabilitySummary = {
    ...shadowPlaybookLaneDurability,
    persistence: shadowPlaybookLaneDurabilityPersisted
      ? { ...shadowPlaybookLaneDurabilityPersisted }
      : null,
  };
  summary.shadowPlaybookLaneDurability = shadowPlaybookLaneDurabilitySummary;
  try {
    const ledgerSourceType = sourceFilter === SOURCE_BACKFILL ? SOURCE_BACKFILL : SOURCE_LIVE;
    const ledgerReconstructionPhase = reconstructionPhaseFilter
      || (ledgerSourceType === SOURCE_BACKFILL ? PHASE_PRE_ORB : PHASE_LIVE_INTRADAY);
    const contextRowsForPolicy = listRecommendationContexts(db, {
      limit: 5000,
      source: sourceFilter,
      includeSuppressed: true,
    });
    const contextByDate = new Map();
    const rankContext = (row) => {
      const rowSource = normalizeSourceType(row?.source_type || SOURCE_LIVE);
      const rowPhase = normalizeReconstructionPhase(row?.reconstruction_phase, rowSource);
      if (rowSource === ledgerSourceType && rowPhase === ledgerReconstructionPhase) return 0;
      if (rowSource === SOURCE_LIVE && rowPhase === PHASE_LIVE_INTRADAY) return 1;
      if (rowSource === ledgerSourceType) return 2;
      return 3;
    };
    for (const row of contextRowsForPolicy) {
      const tradeDate = normalizeDate(row?.rec_date || '');
      if (!tradeDate) continue;
      const existing = contextByDate.get(tradeDate);
      const currentRank = rankContext(row);
      if (!existing || currentRank < existing.rank) {
        contextByDate.set(tradeDate, { row, rank: currentRank });
      }
    }
    const sessionDates = Object.keys(sessions || {})
      .map((date) => normalizeDate(date))
      .filter(Boolean);
    const contextDates = Array.from(contextByDate.keys())
      .map((date) => normalizeDate(date))
      .filter(Boolean);
    const existingPolicyDates = db.prepare(`
      SELECT DISTINCT trade_date
      FROM late_entry_policy_experiment_daily
      WHERE source_type = ?
        AND reconstruction_phase = ?
    `).all(ledgerSourceType, ledgerReconstructionPhase)
      .map((row) => normalizeDate(row?.trade_date || ''))
      .filter(Boolean);
    const policyDates = Array.from(new Set([...sessionDates, ...contextDates, ...existingPolicyDates]))
      .sort((a, b) => String(a).localeCompare(String(b)));
    for (const tradeDate of policyDates) {
      const contextCandidate = contextByDate.get(tradeDate)?.row || null;
      const recommendationJson = contextCandidate
        ? safeJsonParse(contextCandidate.recommendation_json, {})
        : {};
      const contextJson = contextCandidate
        ? safeJsonParse(contextCandidate.context_json, {})
        : {};
      const selectedTpMode = normalizeTpMode(
        contextCandidate?.recommended_tp_mode
        || recommendationJson?.recommendedTpMode
        || 'Skip 2'
      );
      const sourceTypeForRow = contextCandidate
        ? normalizeSourceType(contextCandidate.source_type || ledgerSourceType)
        : ledgerSourceType;
      const reconstructionPhaseForRow = contextCandidate
        ? normalizeReconstructionPhase(contextCandidate.reconstruction_phase, sourceTypeForRow)
        : ledgerReconstructionPhase;
      const policyRow = buildLateEntryPolicyExperimentRow({
        db,
        tradeDate,
        sourceType: sourceTypeForRow,
        reconstructionPhase: reconstructionPhaseForRow,
        selectedTpMode: selectedTpMode || 'Skip 2',
        strategyKey: toText(
          contextCandidate?.recommended_strategy_key
          || recommendationJson?.recommendedStrategy
          || 'original_plan_orb_3130'
        ) || 'original_plan_orb_3130',
        strategyName: toText(
          contextCandidate?.recommended_strategy_name
          || recommendationJson?.recommendedStrategy
          || 'Original Trading Plan'
        ) || 'Original Trading Plan',
        contextJson,
        candles: Array.isArray(sessions?.[tradeDate]) ? sessions[tradeDate] : [],
        runTradeMechanicsVariantTool,
      });
      if (policyRow) {
        upsertLateEntryPolicyExperimentRow({
          db,
          row: policyRow,
        });
      }
      const policyV2Row = buildLateEntryPolicyExperimentRow({
        db,
        tradeDate,
        sourceType: sourceTypeForRow,
        reconstructionPhase: reconstructionPhaseForRow,
        policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
        policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
        selectedTpMode: selectedTpMode || 'Skip 2',
        strategyKey: toText(
          contextCandidate?.recommended_strategy_key
          || recommendationJson?.recommendedStrategy
          || 'original_plan_orb_3130'
        ) || 'original_plan_orb_3130',
        strategyName: toText(
          contextCandidate?.recommended_strategy_name
          || recommendationJson?.recommendedStrategy
          || 'Original Trading Plan'
        ) || 'Original Trading Plan',
        contextJson,
        candles: Array.isArray(sessions?.[tradeDate]) ? sessions[tradeDate] : [],
        runTradeMechanicsVariantTool,
      });
      if (policyV2Row) {
        upsertLateEntryPolicyExperimentRow({
          db,
          row: policyV2Row,
        });
      }
      const policyV3Row = buildLateEntryPolicyExperimentRow({
        db,
        tradeDate,
        sourceType: sourceTypeForRow,
        reconstructionPhase: reconstructionPhaseForRow,
        policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
        policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
        selectedTpMode: selectedTpMode || 'Skip 2',
        strategyKey: toText(
          contextCandidate?.recommended_strategy_key
          || recommendationJson?.recommendedStrategy
          || 'original_plan_orb_3130'
        ) || 'original_plan_orb_3130',
        strategyName: toText(
          contextCandidate?.recommended_strategy_name
          || recommendationJson?.recommendedStrategy
          || 'Original Trading Plan'
        ) || 'Original Trading Plan',
        contextJson,
        candles: Array.isArray(sessions?.[tradeDate]) ? sessions[tradeDate] : [],
        runTradeMechanicsVariantTool,
      });
      if (policyV3Row) {
        upsertLateEntryPolicyExperimentRow({
          db,
          row: policyV3Row,
        });
      }
      const policyV4Row = buildLateEntryPolicyExperimentRow({
        db,
        tradeDate,
        sourceType: sourceTypeForRow,
        reconstructionPhase: reconstructionPhaseForRow,
        policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
        policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
        selectedTpMode: selectedTpMode || 'Skip 2',
        strategyKey: toText(
          contextCandidate?.recommended_strategy_key
          || recommendationJson?.recommendedStrategy
          || 'original_plan_orb_3130'
        ) || 'original_plan_orb_3130',
        strategyName: toText(
          contextCandidate?.recommended_strategy_name
          || recommendationJson?.recommendedStrategy
          || 'Original Trading Plan'
        ) || 'Original Trading Plan',
        contextJson,
        candles: Array.isArray(sessions?.[tradeDate]) ? sessions[tradeDate] : [],
        runTradeMechanicsVariantTool,
      });
      if (policyV4Row) {
        upsertLateEntryPolicyExperimentRow({
          db,
          row: policyV4Row,
        });
      }
      const policyV5Row = buildLateEntryPolicyExperimentRow({
        db,
        tradeDate,
        sourceType: sourceTypeForRow,
        reconstructionPhase: reconstructionPhaseForRow,
        policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
        policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
        selectedTpMode: selectedTpMode || 'Skip 2',
        strategyKey: toText(
          contextCandidate?.recommended_strategy_key
          || recommendationJson?.recommendedStrategy
          || 'original_plan_orb_3130'
        ) || 'original_plan_orb_3130',
        strategyName: toText(
          contextCandidate?.recommended_strategy_name
          || recommendationJson?.recommendedStrategy
          || 'Original Trading Plan'
        ) || 'Original Trading Plan',
        contextJson,
        candles: Array.isArray(sessions?.[tradeDate]) ? sessions[tradeDate] : [],
        runTradeMechanicsVariantTool,
      });
      if (policyV5Row) {
        upsertLateEntryPolicyExperimentRow({
          db,
          row: policyV5Row,
        });
      }
    }
  } catch {}
  const lateEntrySourceScope = sourceFilter === SOURCE_BACKFILL ? SOURCE_BACKFILL : SOURCE_LIVE;
  const lateEntryReconstructionScope = lateEntrySourceScope === SOURCE_BACKFILL
    ? PHASE_PRE_ORB
    : PHASE_LIVE_INTRADAY;

  const lateEntryPolicyExperiment = summarizeLateEntryPolicyExperiment(scorecards, {
    db,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_VERSION,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
  });
  const lateEntryPolicyExperimentV2 = summarizeLateEntryPolicyExperiment(scorecards, {
    db,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V2_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V2_VERSION,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
  });
  const lateEntryPolicyExperimentV3 = summarizeLateEntryPolicyExperiment(scorecards, {
    db,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V3_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V3_VERSION,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
  });
  const lateEntryPolicyExperimentV4 = summarizeLateEntryPolicyExperiment(scorecards, {
    db,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V4_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V4_VERSION,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
  });
  const lateEntryPolicyExperimentV5 = summarizeLateEntryPolicyExperiment(scorecards, {
    db,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
  });
  const lateEntryPolicyV2VsV1Delta = summarizeLateEntryPolicyV2VsV1Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV3VsV2Delta = summarizeLateEntryPolicyV3VsV2Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV3VsV1Delta = summarizeLateEntryPolicyV3VsV1Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV4VsV3Delta = summarizeLateEntryPolicyV4VsV3Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV4VsV2Delta = summarizeLateEntryPolicyV4VsV2Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV4VsV1Delta = summarizeLateEntryPolicyV4VsV1Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV5VsV4Delta = summarizeLateEntryPolicyV5VsV4Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV5VsV3Delta = summarizeLateEntryPolicyV5VsV3Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV5VsV2Delta = summarizeLateEntryPolicyV5VsV2Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyV5VsV1Delta = summarizeLateEntryPolicyV5VsV1Delta(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryPolicyCommonDateComparison = buildLateEntryPolicyCommonDateComparison(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
    targetDate: newestRecordDate || null,
  });
  summary.lateEntryPolicyExperiment = lateEntryPolicyExperiment;
  summary.lateEntryPolicyExperimentV2 = lateEntryPolicyExperimentV2;
  summary.lateEntryPolicyExperimentV3 = lateEntryPolicyExperimentV3;
  summary.lateEntryPolicyExperimentV4 = lateEntryPolicyExperimentV4;
  summary.lateEntryPolicyExperimentV5 = lateEntryPolicyExperimentV5;
  summary.lateEntryPolicyV2VsV1Delta = lateEntryPolicyV2VsV1Delta;
  summary.lateEntryPolicyV3VsV2Delta = lateEntryPolicyV3VsV2Delta;
  summary.lateEntryPolicyV3VsV1Delta = lateEntryPolicyV3VsV1Delta;
  summary.lateEntryPolicyV4VsV3Delta = lateEntryPolicyV4VsV3Delta;
  summary.lateEntryPolicyV4VsV2Delta = lateEntryPolicyV4VsV2Delta;
  summary.lateEntryPolicyV4VsV1Delta = lateEntryPolicyV4VsV1Delta;
  summary.lateEntryPolicyV5VsV4Delta = lateEntryPolicyV5VsV4Delta;
  summary.lateEntryPolicyV5VsV3Delta = lateEntryPolicyV5VsV3Delta;
  summary.lateEntryPolicyV5VsV2Delta = lateEntryPolicyV5VsV2Delta;
  summary.lateEntryPolicyV5VsV1Delta = lateEntryPolicyV5VsV1Delta;
  summary.lateEntryPolicyCommonDateComparison = lateEntryPolicyCommonDateComparison;
  summary.lateEntryPolicyMissingDateAudit = lateEntryPolicyCommonDateComparison?.v4MissingDateAudit
    && typeof lateEntryPolicyCommonDateComparison.v4MissingDateAudit === 'object'
    ? lateEntryPolicyCommonDateComparison.v4MissingDateAudit
    : null;
  summary.lateEntryPolicyV1VsV4MissedTradeLedger = lateEntryPolicyCommonDateComparison?.v1VsV4MissedTradeLedger
    && typeof lateEntryPolicyCommonDateComparison.v1VsV4MissedTradeLedger === 'object'
    ? lateEntryPolicyCommonDateComparison.v1VsV4MissedTradeLedger
    : null;
  summary.lateEntryPolicyTrustIfV4MissingDatesRepaired = lateEntryPolicyCommonDateComparison?.trustIfV4MissingDatesRepaired
    && typeof lateEntryPolicyCommonDateComparison.trustIfV4MissingDatesRepaired === 'object'
    ? lateEntryPolicyCommonDateComparison.trustIfV4MissingDatesRepaired
    : null;
  summary.lateEntryPolicyLine = toText(lateEntryPolicyExperiment?.summaryLine || '')
    || 'Late-entry Skip 2 extension (shadow): unavailable.';
  summary.lateEntryPolicyV2Line = toText(lateEntryPolicyExperimentV2?.summaryLine || '')
    || 'Late-entry Skip 2 extension v2 (shadow): unavailable.';
  summary.lateEntryPolicyV3Line = toText(lateEntryPolicyExperimentV3?.summaryLine || '')
    || 'Late-entry Skip 2 extension v3 (shadow): unavailable.';
  summary.lateEntryPolicyV4Line = toText(lateEntryPolicyExperimentV4?.summaryLine || '')
    || 'Late-entry Skip 2 extension v4 (shadow): unavailable.';
  summary.lateEntryPolicyV5Line = toText(lateEntryPolicyExperimentV5?.summaryLine || '')
    || 'Late-entry Skip 2 extension v5 (shadow): unavailable.';
  summary.lateEntryReplayReferenceLine = toText(
    lateEntryPolicyExperiment?.replayReferenceLine
    || lateEntryPolicyExperiment?.broadReplayReference?.line
    || ''
  ) || 'Late-entry broad replay reference: unavailable.';
  summary.lateEntryPolicyCommonDateLine = toText(
    lateEntryPolicyCommonDateComparison?.summaryLine || ''
  ) || 'Late-entry common-date comparison: unavailable.';
  summary.lateEntryPolicyMissingDateAuditLine = toText(
    lateEntryPolicyCommonDateComparison?.v4MissingDateAuditLine || ''
  ) || 'Late-entry v4 missing-date audit: unavailable.';
  summary.lateEntryPolicyV1VsV4GapLine = toText(
    lateEntryPolicyCommonDateComparison?.v1VsV4GapLine || ''
  ) || 'Late-entry strict v1-v4 gap: unavailable.';
  summary.lateEntryPolicyTrustIfV4MissingDatesRepairedLine = toText(
    lateEntryPolicyCommonDateComparison?.trustIfV4MissingDatesRepairedLine || ''
  ) || 'Late-entry trust-repair projection: unavailable.';
  const lateEntryShadowLeader = buildLateEntryShadowLeader({
    commonDateComparison: lateEntryPolicyCommonDateComparison,
  });
  const lateEntryPolicyV5ShadowTrackingBeforeRepair = buildLateEntryPolicyV5ShadowTracking(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryCoverageBeforeSnapshot = {
    externallyFinalizedEligibleDays: Number(lateEntryPolicyExperimentV5?.externallyFinalizedEligibleDays || 0),
    externalCoveragePct: Number.isFinite(toFiniteNumberOrNull(lateEntryPolicyExperimentV5?.externalCoveragePct))
      ? round2(toFiniteNumberOrNull(lateEntryPolicyExperimentV5.externalCoveragePct))
      : null,
    rolling5CoveragePct: Number.isFinite(toFiniteNumberOrNull(lateEntryPolicyExperimentV5?.rolling5ExternalCoveragePct))
      ? round2(toFiniteNumberOrNull(lateEntryPolicyExperimentV5.rolling5ExternalCoveragePct))
      : (
        Number(lateEntryPolicyV5ShadowTrackingBeforeRepair?.recentShadowScore?.last5RelevantDays?.considered || 0) > 0
          ? round2(
            (
              Number(lateEntryPolicyV5ShadowTrackingBeforeRepair?.recentShadowScore?.last5RelevantDays?.externallyFinalizedDays || 0)
              / Number(lateEntryPolicyV5ShadowTrackingBeforeRepair?.recentShadowScore?.last5RelevantDays?.considered || 1)
            ) * 100
          )
          : null
      ),
    rolling10CoveragePct: Number.isFinite(toFiniteNumberOrNull(lateEntryPolicyExperimentV5?.rolling10ExternalCoveragePct))
      ? round2(toFiniteNumberOrNull(lateEntryPolicyExperimentV5.rolling10ExternalCoveragePct))
      : (
        Number(lateEntryPolicyV5ShadowTrackingBeforeRepair?.recentShadowScore?.last10RelevantDays?.considered || 0) > 0
          ? round2(
            (
              Number(lateEntryPolicyV5ShadowTrackingBeforeRepair?.recentShadowScore?.last10RelevantDays?.externallyFinalizedDays || 0)
              / Number(lateEntryPolicyV5ShadowTrackingBeforeRepair?.recentShadowScore?.last10RelevantDays?.considered || 1)
            ) * 100
          )
          : null
      ),
  };
  const lateEntryTruthRepairScope = normalizeLateEntryTruthRepairScope(
    input?.lateEntryTruthRepairScope || input?.repairScope
  );
  const lateEntryTruthQueueResult = buildLateEntryPolicyTruthFinalizationQueue({
    db,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    sessions,
    repairScope: lateEntryTruthRepairScope,
    maxRows: 10000,
    maxReadyDates: 25,
    maxBlockedSample: 15,
  });
  const lateEntryPolicyTruthQueueBeforeContext = lateEntryTruthQueueResult?.queue || null;
  const lateEntryPolicyContextGapAudit = buildLateEntryPolicyContextGapAudit({
    db,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    candidateRows: Array.isArray(lateEntryTruthQueueResult?.candidateRows)
      ? lateEntryTruthQueueResult.candidateRows
      : [],
    maxSample: 12,
  });
  const lateEntryPolicyContextBackfillRun = runLateEntryPolicyContextBackfillRun({
    db,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    reconstructionVersion: VERSION_LIVE,
    candidateRows: Array.isArray(lateEntryTruthQueueResult?.scopedCandidateRows)
      ? lateEntryTruthQueueResult.scopedCandidateRows
      : [],
    sessions,
  });
  const lateEntryTruthQueueAfterContextResult = buildLateEntryPolicyTruthFinalizationQueue({
    db,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    sessions,
    repairScope: lateEntryTruthRepairScope,
    maxRows: 10000,
    maxReadyDates: 25,
    maxBlockedSample: 15,
  });
  const lateEntryPolicyTruthBlockerDiagnosticsBeforeBackfill = buildLateEntryPolicyTruthBlockerDiagnostics({
    candidateRows: Array.isArray(lateEntryTruthQueueAfterContextResult?.candidateRows)
      ? lateEntryTruthQueueAfterContextResult.candidateRows
      : [],
  });
  const lateEntryPolicyTruthDependencySplitBeforeBackfill = buildLateEntryPolicyTruthDependencySplit({
    candidateRows: Array.isArray(lateEntryTruthQueueAfterContextResult?.candidateRows)
      ? lateEntryTruthQueueAfterContextResult.candidateRows
      : [],
    maxSample: 12,
  });
  const lateEntryPolicyTruthBackfillRun = runLateEntryPolicyTruthBackfillRun({
    db,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    candidateRows: Array.isArray(lateEntryTruthQueueAfterContextResult?.scopedCandidateRows)
      ? lateEntryTruthQueueAfterContextResult.scopedCandidateRows
      : [],
    sessions,
    strategySnapshot,
    runTradeMechanicsVariantTool,
    repairScope: lateEntryTruthRepairScope,
  });
  const lateEntryTruthQueueFinalResult = buildLateEntryPolicyTruthFinalizationQueue({
    db,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    sessions,
    repairScope: lateEntryTruthRepairScope,
    maxRows: 10000,
    maxReadyDates: 25,
    maxBlockedSample: 15,
  });
  const lateEntryPolicyTruthFinalizationQueue = lateEntryTruthQueueFinalResult?.queue
    || lateEntryTruthQueueAfterContextResult?.queue
    || lateEntryPolicyTruthQueueBeforeContext
    || null;
  const lateEntryPolicyTruthBlockerDiagnostics = buildLateEntryPolicyTruthBlockerDiagnostics({
    candidateRows: Array.isArray(lateEntryTruthQueueFinalResult?.candidateRows)
      ? lateEntryTruthQueueFinalResult.candidateRows
      : (
        Array.isArray(lateEntryTruthQueueAfterContextResult?.candidateRows)
          ? lateEntryTruthQueueAfterContextResult.candidateRows
          : []
      ),
  });
  const lateEntryPolicyTruthDependencySplit = buildLateEntryPolicyTruthDependencySplit({
    candidateRows: Array.isArray(lateEntryTruthQueueFinalResult?.candidateRows)
      ? lateEntryTruthQueueFinalResult.candidateRows
      : (
        Array.isArray(lateEntryTruthQueueAfterContextResult?.candidateRows)
          ? lateEntryTruthQueueAfterContextResult.candidateRows
          : []
      ),
    maxSample: 12,
  });
  const lateEntryPolicyExperimentV5AfterRepair = summarizeLateEntryPolicyExperiment(scorecards, {
    db,
    policyKey: LATE_ENTRY_POLICY_EXPERIMENT_V5_KEY,
    policyVersion: LATE_ENTRY_POLICY_EXPERIMENT_V5_VERSION,
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
  });
  const lateEntryPolicyExperimentV5Final = lateEntryPolicyExperimentV5AfterRepair || lateEntryPolicyExperimentV5;
  const lateEntryPolicyV5ShadowTracking = buildLateEntryPolicyV5ShadowTracking(db, {
    sourceType: lateEntrySourceScope,
    reconstructionPhase: lateEntryReconstructionScope,
    maxRows: 5000,
  });
  const lateEntryCoverageAfterSnapshot = {
    externallyFinalizedEligibleDays: Number(lateEntryPolicyExperimentV5Final?.externallyFinalizedEligibleDays || 0),
    externalCoveragePct: Number.isFinite(toFiniteNumberOrNull(lateEntryPolicyExperimentV5Final?.externalCoveragePct))
      ? round2(toFiniteNumberOrNull(lateEntryPolicyExperimentV5Final.externalCoveragePct))
      : null,
    rolling5CoveragePct: Number.isFinite(toFiniteNumberOrNull(lateEntryPolicyExperimentV5Final?.rolling5ExternalCoveragePct))
      ? round2(toFiniteNumberOrNull(lateEntryPolicyExperimentV5Final.rolling5ExternalCoveragePct))
      : (
        Number(lateEntryPolicyV5ShadowTracking?.recentShadowScore?.last5RelevantDays?.considered || 0) > 0
          ? round2(
            (
              Number(lateEntryPolicyV5ShadowTracking?.recentShadowScore?.last5RelevantDays?.externallyFinalizedDays || 0)
              / Number(lateEntryPolicyV5ShadowTracking?.recentShadowScore?.last5RelevantDays?.considered || 1)
            ) * 100
          )
          : null
      ),
    rolling10CoveragePct: Number.isFinite(toFiniteNumberOrNull(lateEntryPolicyExperimentV5Final?.rolling10ExternalCoveragePct))
      ? round2(toFiniteNumberOrNull(lateEntryPolicyExperimentV5Final.rolling10ExternalCoveragePct))
      : (
        Number(lateEntryPolicyV5ShadowTracking?.recentShadowScore?.last10RelevantDays?.considered || 0) > 0
          ? round2(
            (
              Number(lateEntryPolicyV5ShadowTracking?.recentShadowScore?.last10RelevantDays?.externallyFinalizedDays || 0)
              / Number(lateEntryPolicyV5ShadowTracking?.recentShadowScore?.last10RelevantDays?.considered || 1)
            ) * 100
          )
          : null
      ),
  };
  const lateEntryPolicyCoverageAccelerationSummary = buildLateEntryPolicyCoverageAccelerationSummary({
    before: lateEntryCoverageBeforeSnapshot,
    after: lateEntryCoverageAfterSnapshot,
  });
  const lateEntryPolicyPromotionReadiness = buildLateEntryPolicyPromotionReadinessPanel({
    v5Summary: lateEntryPolicyExperimentV5Final,
    shadowLeader: lateEntryShadowLeader,
  });
  const lateEntryPolicyV5PocketMap = buildLateEntryPolicyV5PocketMap({
    v1VsV4MissedTradeLedger: summary.lateEntryPolicyV1VsV4MissedTradeLedger
      || lateEntryPolicyCommonDateComparison?.v1VsV4MissedTradeLedger
      || null,
    v5VsV4Delta: lateEntryPolicyV5VsV4Delta,
  });
  summary.lateEntryShadowLeader = lateEntryShadowLeader;
  summary.lateEntryPolicyPromotionReadiness = lateEntryPolicyPromotionReadiness;
  summary.lateEntryPolicyV5LatestDay = lateEntryPolicyV5ShadowTracking?.latestDay
    && typeof lateEntryPolicyV5ShadowTracking.latestDay === 'object'
    ? { ...lateEntryPolicyV5ShadowTracking.latestDay }
    : null;
  summary.lateEntryPolicyV5RecentShadowScore = lateEntryPolicyV5ShadowTracking?.recentShadowScore
    && typeof lateEntryPolicyV5ShadowTracking.recentShadowScore === 'object'
    ? { ...lateEntryPolicyV5ShadowTracking.recentShadowScore }
    : null;
  summary.lateEntryPolicyV5PocketMap = lateEntryPolicyV5PocketMap;
  summary.lateEntryShadowLeaderLine = toText(lateEntryShadowLeader?.summaryLine || '')
    || 'Late-entry shadow leader: unavailable.';
  summary.lateEntryPolicyPromotionReadinessLine = toText(lateEntryPolicyPromotionReadiness?.summaryLine || '')
    || 'Late-entry promotion readiness: unavailable.';
  summary.lateEntryPolicyV5LatestDayLine = toText(summary.lateEntryPolicyV5LatestDay?.statusLine || '')
    || 'Late-entry v5 latest relevant day: unavailable.';
  summary.lateEntryPolicyV5PocketMapLine = toText(lateEntryPolicyV5PocketMap?.currentRead || '')
    || 'Late-entry v5 pocket map: unavailable.';
  const lateEntryTruthAsOfTradeDate = normalizeDate(
    input?.nowEt?.date
    || newestRecordDate
    || summary?.lateEntryPolicyV5LatestDay?.tradeDate
    || ''
  );
  const lateEntryPolicyTruthCoverageBacklog = buildLateEntryPolicyTruthCoverageBacklog({
    v5Summary: lateEntryPolicyExperimentV5Final,
    v5ShadowTracking: lateEntryPolicyV5ShadowTracking,
    asOfTradeDate: lateEntryTruthAsOfTradeDate,
  });
  const lateEntryPolicyTruthCoverageLedger = buildLateEntryPolicyTruthCoverageLedger({
    backlog: lateEntryPolicyTruthCoverageBacklog,
    unfinalizedTradeDates: Array.isArray(lateEntryPolicyExperimentV5Final?.unfinalizedTradeDates)
      ? lateEntryPolicyExperimentV5Final.unfinalizedTradeDates
      : [],
    maxRecent: 12,
    maxPriority: 10,
  });
  const lateEntryPolicyTruthAccumulationTrend = buildLateEntryPolicyTruthAccumulationTrend({
    v5ShadowTracking: lateEntryPolicyV5ShadowTracking,
  });
  const lateEntryPolicyPromotionDossier = buildLateEntryPolicyPromotionDossier({
    shadowLeader: lateEntryShadowLeader,
    commonDateComparison: lateEntryPolicyCommonDateComparison,
    readinessPanel: lateEntryPolicyPromotionReadiness,
    pocketMap: lateEntryPolicyV5PocketMap,
    v5VsV4Delta: lateEntryPolicyV5VsV4Delta,
    v5VsV1Delta: lateEntryPolicyV5VsV1Delta,
  });
  const lateEntryPolicyManualReviewTrigger = buildLateEntryPolicyManualReviewTrigger({
    readinessPanel: lateEntryPolicyPromotionReadiness,
    shadowLeader: lateEntryShadowLeader,
    dossier: lateEntryPolicyPromotionDossier,
  });
  summary.lateEntryPolicyExperimentV5 = lateEntryPolicyExperimentV5Final;
  summary.lateEntryPolicyV5Line = toText(lateEntryPolicyExperimentV5Final?.summaryLine || '')
    || 'Late-entry Skip 2 extension v5 (shadow): unavailable.';
  summary.lateEntryPolicyTruthFinalizationQueue = lateEntryPolicyTruthFinalizationQueue;
  summary.lateEntryPolicyTruthBlockerDiagnostics = lateEntryPolicyTruthBlockerDiagnostics
    || lateEntryPolicyTruthBlockerDiagnosticsBeforeBackfill;
  summary.lateEntryPolicyContextGapAudit = lateEntryPolicyContextGapAudit;
  summary.lateEntryPolicyContextBackfillRun = lateEntryPolicyContextBackfillRun;
  summary.lateEntryPolicyTruthDependencySplit = lateEntryPolicyTruthDependencySplit
    || lateEntryPolicyTruthDependencySplitBeforeBackfill;
  summary.lateEntryPolicyTruthBackfillRun = lateEntryPolicyTruthBackfillRun;
  summary.lateEntryPolicyCoverageAccelerationSummary = lateEntryPolicyCoverageAccelerationSummary;
  summary.lateEntryPolicyTruthCoverageBacklog = lateEntryPolicyTruthCoverageBacklog;
  summary.lateEntryPolicyTruthCoverageLedger = lateEntryPolicyTruthCoverageLedger;
  summary.lateEntryPolicyPromotionDossier = lateEntryPolicyPromotionDossier;
  summary.lateEntryPolicyManualReviewTrigger = lateEntryPolicyManualReviewTrigger;
  summary.lateEntryPolicyTruthAccumulationTrend = lateEntryPolicyTruthAccumulationTrend;
  summary.lateEntryPolicyTruthFinalizationQueueLine = toText(lateEntryPolicyTruthFinalizationQueue?.summaryLine || '')
    || 'Late-entry truth finalization queue: unavailable.';
  summary.lateEntryPolicyTruthBlockerDiagnosticsLine = toText(
    summary?.lateEntryPolicyTruthBlockerDiagnostics?.summaryLine || ''
  ) || 'Late-entry truth blocker diagnostics: unavailable.';
  summary.lateEntryPolicyContextGapAuditLine = toText(lateEntryPolicyContextGapAudit?.summaryLine || '')
    || 'Late-entry context gap audit: unavailable.';
  summary.lateEntryPolicyContextBackfillRunLine = toText(lateEntryPolicyContextBackfillRun?.summaryLine || '')
    || 'Late-entry context backfill run: unavailable.';
  summary.lateEntryPolicyTruthDependencySplitLine = toText(
    summary?.lateEntryPolicyTruthDependencySplit?.summaryLine || ''
  ) || 'Late-entry truth dependency split: unavailable.';
  summary.lateEntryPolicyTruthBackfillRunLine = toText(lateEntryPolicyTruthBackfillRun?.summaryLine || '')
    || 'Late-entry truth backfill run: unavailable.';
  summary.lateEntryPolicyCoverageAccelerationSummaryLine = toText(lateEntryPolicyCoverageAccelerationSummary?.summaryLine || '')
    || 'Late-entry coverage acceleration: unavailable.';
  summary.lateEntryPolicyTruthCoverageBacklogLine = toText(lateEntryPolicyTruthCoverageBacklog?.summaryLine || '')
    || 'Late-entry truth coverage backlog: unavailable.';
  summary.lateEntryPolicyTruthCoverageLedgerLine = toText(lateEntryPolicyTruthCoverageLedger?.summaryLine || '')
    || 'Late-entry truth coverage ledger: unavailable.';
  summary.lateEntryPolicyPromotionDossierLine = toText(lateEntryPolicyPromotionDossier?.summaryLine || '')
    || 'Late-entry promotion dossier: unavailable.';
  summary.lateEntryPolicyManualReviewTriggerLine = toText(lateEntryPolicyManualReviewTrigger?.summaryLine || '')
    || 'Late-entry manual review trigger: unavailable.';
  summary.lateEntryPolicyTruthAccumulationTrendLine = toText(lateEntryPolicyTruthAccumulationTrend?.summaryLine || '')
    || 'Late-entry truth accumulation trend: unavailable.';
  const simulatedTargetDate = normalizeDate(
    input?.nowEt?.date
    || newestRecordDate
    || (Array.isArray(contexts) && contexts[0] ? contexts[0].rec_date : '')
    || ''
  );
  let jarvisSimulatedTrade = null;
  if (simulatedTargetDate) {
    jarvisSimulatedTrade = getJarvisSimulatedTradeOutcomeForDate(db, {
      tradeDate: simulatedTargetDate,
      sourceType: sourceFilter === SOURCE_BACKFILL ? SOURCE_BACKFILL : SOURCE_LIVE,
      reconstructionPhase: reconstructionPhaseFilter || undefined,
    });
  }
  summary.jarvisSimulatedTrade = jarvisSimulatedTrade;
  summary.jarvisSimulatedTradeLine = jarvisSimulatedTrade
    ? String(jarvisSimulatedTrade.simulatedStatusLine || '').trim() || 'Jarvis simulated today: unavailable.'
    : 'Jarvis simulated today: unavailable.';
  summary.jarvisSimulatedTradeTpComparison = jarvisSimulatedTrade?.tpComparisons || null;

  return {
    generatedAt: new Date().toISOString(),
    scorecards,
    scorecards30d,
    scorecards90d,
    rowCountUsed,
    oldestRecordDate,
    newestRecordDate,
    sourceBreakdown,
    provenanceSummary,
    reconstructionPhase,
    calibrationWarnings,
    shadowPlaybookLaneDurability: shadowPlaybookLaneDurabilitySummary,
    lateEntryPolicyExperiment,
    lateEntryPolicyExperimentV2,
    lateEntryPolicyExperimentV3,
    lateEntryPolicyExperimentV4,
    lateEntryPolicyExperimentV5: lateEntryPolicyExperimentV5Final,
    lateEntryPolicyV2VsV1Delta,
    lateEntryPolicyV3VsV2Delta,
    lateEntryPolicyV3VsV1Delta,
    lateEntryPolicyV4VsV3Delta,
    lateEntryPolicyV4VsV2Delta,
    lateEntryPolicyV4VsV1Delta,
    lateEntryPolicyV5VsV4Delta,
    lateEntryPolicyV5VsV3Delta,
    lateEntryPolicyV5VsV2Delta,
    lateEntryPolicyV5VsV1Delta,
    lateEntryPolicyCommonDateComparison,
    jarvisSimulatedTrade,
    summary,
    warnings,
  };
}

module.exports = {
  SOURCE_LIVE,
  SOURCE_BACKFILL,
  PHASE_LIVE_INTRADAY,
  PHASE_PRE_ORB,
  VERSION_LIVE,
  VERSION_BACKFILL,
  SCORE_VERSION,
  SIMULATED_TRADE_LEDGER_VERSION,
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
  LATE_ENTRY_BROAD_REPLAY_REFERENCE_KEY,
  LATE_ENTRY_POLICY_PROMOTION_STATUS_ENUM,
  LATE_ENTRY_POLICY_REPLAY_STATUS_ENUM,
  LATE_ENTRY_POLICY_V2_COMPARISON_ENUM,
  LATE_ENTRY_POLICY_V3_COMPARISON_ENUM,
  LATE_ENTRY_POLICY_V4_COMPARISON_ENUM,
  LATE_ENTRY_POLICY_V5_COMPARISON_ENUM,
  SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_KEY,
  SHADOW_PLAYBOOK_FAILED_EXTENSION_REVERSAL_FADE_VERSION,
  SHADOW_PLAYBOOK_LANE_LABEL_ENUM,
  SHADOW_PLAYBOOK_PREDECISION_SAFE_REASON_CODE_SET,
  SHADOW_PLAYBOOK_DURABILITY_TREND_ENUM,
  SHADOW_PLAYBOOK_DURABILITY_TRUST_ENUM,
  SHADOW_PLAYBOOK_PROMOTION_READINESS_STATUS_ENUM,
  REALIZED_TRUTH_SOURCE_ENUM,
  ASSISTANT_DECISION_OUTCOME_CLASSIFICATION_ENUM,
  MODEL_VS_REALIZED_DIVERGENCE_CLASSIFICATION_ENUM,
  SHADOW_PLAYBOOK_HYPOTHETICAL_RESULT_ENUM,
  classifyAssistantDecisionOutcomeCheckpoint,
  classifyModelVsRealizedDivergence,
  classifyFailedExtensionReversalFadeShadowLane,
  classifyFailedExtensionReversalFadeShadowPredecisionLane,
  splitFailedExtensionLaneReasonCodes,
  evaluateFailedExtensionReversalFadeShadow,
  upsertShadowPlaybookEvaluation,
  upsertShadowPlaybookDurabilitySummary,
  summarizeShadowPlaybookLaneDurability,
  upsertAssistantDecisionOutcomeCheckpoint,
  buildJarvisSimulatedTradeLedgerRow,
  upsertJarvisSimulatedTradeOutcomeLedgerRow,
  getJarvisSimulatedTradeOutcomeForDate,
  buildLateEntryPolicyExperimentRow,
  upsertLateEntryPolicyExperimentRow,
  getLateEntryPolicyExperimentForDate,
  listLateEntryPolicyExperimentRows,
  buildLateEntryPolicyCommonDateComparison,
  buildLateEntryShadowLeader,
  buildLateEntryPolicyPromotionReadinessPanel,
  buildLateEntryPolicyV5ShadowTracking,
  buildLateEntryPolicyV5PocketMap,
  classifyLateEntryPolicyTruthFinalizationBlocker,
  buildLateEntryPolicyTruthFinalizationQueue,
  buildLateEntryPolicyTruthBlockerDiagnostics,
  classifyLateEntryPolicyContextGap,
  buildLateEntryPolicyContextGapAudit,
  runLateEntryPolicyContextBackfillRun,
  buildLateEntryPolicyTruthDependencySplit,
  runLateEntryPolicyTruthBackfillRun,
  buildLateEntryPolicyCoverageAccelerationSummary,
  buildLateEntryPolicyTruthCoverageBacklog,
  buildLateEntryPolicyTruthCoverageLedger,
  buildLateEntryPolicyPromotionDossier,
  buildLateEntryPolicyManualReviewTrigger,
  buildLateEntryPolicyTruthAccumulationTrend,
  summarizeLateEntryPolicyExperiment,
  getLatestTooAggressiveCheckpointSentinel,
  LIVE_CONTEXT_GUARD_STATUS_ENUM,
  evaluateLiveContextCreationGuard,
  recordLiveContextCreationAudit,
  auditAndSuppressInvalidLiveContexts,
  ensureRecommendationOutcomeSchema,
  upsertTodayRecommendationContext,
  getRecommendationContextRow,
  listRecommendationContexts,
  inspectRecommendationPerformanceRows,
  evaluateRecommendationOutcomeDay,
  buildRecommendationPerformance,
  summarizeRecommendationPerformance,
};
