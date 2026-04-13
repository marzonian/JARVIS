'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  toNumber,
  toText,
} = require('./data-foundation-storage');
const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const ALLOWED_EVIDENCE_TIERS = new Set([
  'not_ready',
  'early_live_build',
  'limited_use',
  'intelligence_candidate',
  'intelligence_ready',
]);

const ALLOWED_TARGET_REACHABILITY_LABELS = new Set([
  'blocked',
  'distant',
  'plausible',
  'near',
]);

const ALLOWED_ESTIMATED_TIER_DISTANCE = new Set([
  'far',
  'medium',
  'close',
]);

const ALLOWED_ESTIMATED_DAYS_TO_NEXT_TIER_LABELS = new Set([
  'unknown',
  'gt_20_days',
  'days_10_20',
  'days_5_10',
  'lt_5_days',
]);

const ALLOWED_REQUIREMENT_ENUM = new Set([
  'raise_live_outcomes',
  'raise_live_pct',
  'extend_live_streak',
  'improve_regime_provenance',
  'lift_persistence_from_suppressed',
  'reduce_backfill_dominance',
  'clear_databento_recent_gap',
  'extend_topstep_live_window',
  'maintain_daily_scoring_consistency',
  'maintain_databento_foundation',
  'maintain_topstep_health',
  'improve_live_growth_rate',
]);

const ALLOWED_PROGRESS_SIGNALS = new Set([
  'live_count_rising',
  'live_pct_rising',
  'daily_scoring_stable',
  'databento_live',
  'topstep_healthy',
  'persistence_improving',
  'regime_provenance_improving',
]);

const ALLOWED_STALLED_SIGNALS = new Set([
  'live_count_flat',
  'live_pct_flat',
  'persistence_still_suppressed',
  'regime_provenance_thin',
  'databento_recent_gap_present',
  'topstep_window_thin',
  'backfill_still_dominant',
]);

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizePerformanceSource(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live' || txt === 'backfill') return txt;
  return 'all';
}

function toIsoDate(value) {
  return normalizeDate(value);
}

function toUtcMs(dateValue = '') {
  const iso = toIsoDate(dateValue);
  if (!iso) return null;
  const parts = iso.split('-').map((p) => Number(p));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function daysBetween(leftDate = '', rightDate = '') {
  const leftMs = toUtcMs(leftDate);
  const rightMs = toUtcMs(rightDate);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs) || rightMs < leftMs) return null;
  return Math.floor((rightMs - leftMs) / 86_400_000);
}

function normalizeEvidenceTier(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_EVIDENCE_TIERS.has(txt)) return txt;
  return 'not_ready';
}

function normalizeReachabilityLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_TARGET_REACHABILITY_LABELS.has(txt)) return txt;
  return 'blocked';
}

function normalizeTierDistance(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_ESTIMATED_TIER_DISTANCE.has(txt)) return txt;
  return 'far';
}

function normalizeDaysLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_ESTIMATED_DAYS_TO_NEXT_TIER_LABELS.has(txt)) return txt;
  return 'unknown';
}

function normalizeRegimeLabel(value) {
  const txt = toText(value).toLowerCase();
  if (SUPPORTED_REGIME_LABELS.includes(txt)) return txt;
  return 'unknown';
}

function uniqueBounded(values = [], allowedSet = new Set()) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(values) ? values : [])) {
    const value = toText(raw).toLowerCase();
    if (!value || seen.has(value) || !allowedSet.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function nextTierFromCurrent(currentTier = 'not_ready') {
  const tier = normalizeEvidenceTier(currentTier);
  if (tier === 'not_ready') return 'early_live_build';
  if (tier === 'early_live_build') return 'limited_use';
  if (tier === 'limited_use') return 'intelligence_candidate';
  if (tier === 'intelligence_candidate') return 'intelligence_ready';
  return 'intelligence_ready';
}

function queryLiveDistinctScoreDates(db) {
  if (!db || typeof db.prepare !== 'function') return 0;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT score_date) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live'
  `).get() || {};
  return Math.max(0, Number(row.c || 0));
}

function queryLiveScoreDatesDescending(db, limit = 120) {
  if (!db || typeof db.prepare !== 'function') return [];
  const rows = db.prepare(`
    SELECT DISTINCT score_date
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live'
    ORDER BY score_date DESC
    LIMIT ?
  `).all(Number(limit) || 120);
  return rows
    .map((row) => toIsoDate(row?.score_date))
    .filter(Boolean);
}

function computeLiveStreakDays(datesDesc = []) {
  const dates = Array.isArray(datesDesc) ? datesDesc : [];
  if (!dates.length) return 0;
  let streak = 1;
  for (let i = 1; i < dates.length; i += 1) {
    const prev = dates[i - 1];
    const curr = dates[i];
    const gap = daysBetween(curr, prev);
    if (gap === 1) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function queryLiveSessionDistinctDays(db) {
  if (!db || typeof db.prepare !== 'function') return 0;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT substr(snapshot_at, 1, 10)) AS c
    FROM jarvis_live_session_data
    WHERE source = 'topstep_sync'
  `).get() || {};
  return Math.max(0, Number(row.c || 0));
}

function queryDailyScoringStability(db, nowDate = '') {
  if (!db || typeof db.prepare !== 'function') {
    return {
      totalRuns14d: 0,
      healthyRuns14d: 0,
      latestRunDate: '',
      isStable: false,
    };
  }
  const now = toIsoDate(nowDate);
  const startDate = now
    ? new Date((toUtcMs(now) || Date.now()) - (13 * 86_400_000)).toISOString().slice(0, 10)
    : '';
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status IN ('ok', 'noop') THEN 1 ELSE 0 END) AS healthy_runs,
      MAX(run_date) AS latest_run_date
    FROM jarvis_daily_scoring_runs
    WHERE run_date >= ?
  `).get(startDate || '1970-01-01') || {};

  const totalRuns14d = Math.max(0, Number(row.total_runs || 0));
  const healthyRuns14d = Math.max(0, Number(row.healthy_runs || 0));
  const latestRunDate = toIsoDate(row.latest_run_date);
  const latestGapDays = now && latestRunDate ? daysBetween(latestRunDate, now) : null;
  const isStable = (
    totalRuns14d >= 3
    && healthyRuns14d >= Math.max(2, Math.floor(totalRuns14d * 0.8))
    && Number.isFinite(latestGapDays)
    && latestGapDays <= 2
  );

  return {
    totalRuns14d,
    healthyRuns14d,
    latestRunDate,
    isStable,
  };
}

function deriveDatabentoStatus(databentoIngestionStatus = {}) {
  const latestStatus = toText(databentoIngestionStatus?.latestRuns?.[0]?.status || '').toLowerCase();
  if (latestStatus === 'ok' || latestStatus === 'noop') return 'live';
  if (latestStatus === 'warning') return 'degraded';
  if (latestStatus === 'error' || latestStatus === 'failed') return 'failing';
  if (!latestStatus) return 'unknown';
  return latestStatus;
}

function hasDatabentoRecentGap(liveEvidenceAccumulation = {}, databentoIngestionStatus = {}) {
  const fromBlocker = Array.isArray(liveEvidenceAccumulation?.blockers)
    && liveEvidenceAccumulation.blockers.includes('databento_recent_gap_present');
  if (fromBlocker) return true;
  const symbolsStatus = Array.isArray(databentoIngestionStatus?.symbolsStatus)
    ? databentoIngestionStatus.symbolsStatus
    : [];
  return symbolsStatus.some((row) => Array.isArray(row?.deferredRanges) && row.deferredRanges.length > 0);
}

function hasTopstepWindowThin(liveEvidenceAccumulation = {}, liveSessionDistinctDays = 0) {
  const fromBlocker = Array.isArray(liveEvidenceAccumulation?.blockers)
    && liveEvidenceAccumulation.blockers.includes('topstep_live_window_too_short');
  return fromBlocker || Number(liveSessionDistinctDays || 0) < 3;
}

function classifyCurrentTier(input = {}) {
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const liveDistinct = Math.max(0, Number(input.liveDistinct || 0));
  const liveStreak = Math.max(0, Number(input.liveStreak || 0));
  const provenance = Math.max(0, Number(input.regimeCoverageWithProvenance || 0));
  const persistencePolicy = toText(input.persistencePolicy || '').toLowerCase();
  const persistenceOverrideLabel = toText(input.persistenceOverrideLabel || '').toLowerCase();
  const persistenceSuppressed = persistencePolicy === 'suppress_confidence' || persistenceOverrideLabel === 'suppressed';
  const topstepHealthy = input.topstepHealthy === true;
  const databentoLive = input.databentoLive === true;
  const dailyStable = input.dailyStable === true;
  const databentoGapPresent = input.databentoGapPresent === true;
  const topstepWindowThin = input.topstepWindowThin === true;
  const readinessBase = toText(input.baseReadinessLabel || '').toLowerCase();

  const canIntelligenceReady = (
    liveCount >= 120
    && livePct >= 65
    && liveDistinct >= 25
    && liveStreak >= 15
    && provenance >= 8
    && persistencePolicy === 'allow_structured_confidence'
    && persistenceOverrideLabel === 'enabled'
    && topstepHealthy
    && databentoLive
    && dailyStable
    && !databentoGapPresent
    && !topstepWindowThin
  );
  if (canIntelligenceReady) return 'intelligence_ready';

  const canCandidate = (
    liveCount >= 30
    && livePct >= 40
    && liveDistinct >= 8
    && provenance >= 2
    && !persistenceSuppressed
    && topstepHealthy
    && databentoLive
    && dailyStable
    && !databentoGapPresent
    && !topstepWindowThin
  );
  if (canCandidate || readinessBase === 'intelligence_candidate') return 'intelligence_candidate';

  const canLimited = (
    liveCount >= 15
    && livePct >= 25
    && liveDistinct >= 5
    && provenance >= 1
    && !persistenceSuppressed
    && topstepHealthy
    && databentoLive
    && dailyStable
  );
  if (canLimited || readinessBase === 'limited_use') return 'limited_use';

  const canEarly = (
    liveCount >= 5
    && livePct >= 12
    && liveDistinct >= 3
    && topstepHealthy
    && databentoLive
    && dailyStable
  );
  if (canEarly || readinessBase === 'early_live_build') return 'early_live_build';

  return 'not_ready';
}

function getTierThresholds(targetTier = 'early_live_build') {
  const tier = normalizeEvidenceTier(targetTier);
  if (tier === 'early_live_build') {
    return {
      liveCount: 5,
      livePct: 12,
      liveDistinct: 3,
      provenance: 1,
      requirePersistenceUnsuppressed: false,
      requireNoDatabentoGap: false,
      requireTopstepHealthy: true,
      requireDatabentoLive: true,
      requireDailyStable: true,
    };
  }
  if (tier === 'limited_use') {
    return {
      liveCount: 15,
      livePct: 25,
      liveDistinct: 5,
      provenance: 1,
      requirePersistenceUnsuppressed: true,
      requireNoDatabentoGap: false,
      requireTopstepHealthy: true,
      requireDatabentoLive: true,
      requireDailyStable: true,
    };
  }
  if (tier === 'intelligence_candidate') {
    return {
      liveCount: 30,
      livePct: 40,
      liveDistinct: 8,
      provenance: 2,
      requirePersistenceUnsuppressed: true,
      requireNoDatabentoGap: true,
      requireTopstepHealthy: true,
      requireDatabentoLive: true,
      requireDailyStable: true,
    };
  }
  if (tier === 'intelligence_ready') {
    return {
      liveCount: 120,
      livePct: 65,
      liveDistinct: 25,
      liveStreak: 15,
      provenance: 8,
      requirePersistenceUnsuppressed: true,
      requireStructuredPersistence: true,
      requireNoDatabentoGap: true,
      requireTopstepHealthy: true,
      requireDatabentoLive: true,
      requireDailyStable: true,
    };
  }
  return {
    liveCount: 5,
    livePct: 12,
    liveDistinct: 3,
    provenance: 1,
    requirePersistenceUnsuppressed: false,
    requireNoDatabentoGap: false,
    requireTopstepHealthy: true,
    requireDatabentoLive: true,
    requireDailyStable: true,
  };
}

function buildRequirementStatus(input = {}) {
  const target = getTierThresholds(input.nextTargetTier);
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const backfillCount = Math.max(0, Number(input.backfillCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const liveDistinct = Math.max(0, Number(input.liveDistinct || 0));
  const liveStreak = Math.max(0, Number(input.liveStreak || 0));
  const provenance = Math.max(0, Number(input.regimeCoverageWithProvenance || 0));
  const persistencePolicy = toText(input.persistencePolicy || '').toLowerCase();
  const persistenceOverrideLabel = toText(input.persistenceOverrideLabel || '').toLowerCase();
  const persistenceSuppressed = persistencePolicy === 'suppress_confidence' || persistenceOverrideLabel === 'suppressed';
  const persistenceStructured = persistencePolicy === 'allow_structured_confidence' && persistenceOverrideLabel === 'enabled';
  const topstepHealthy = input.topstepHealthy === true;
  const databentoLive = input.databentoLive === true;
  const dailyStable = input.dailyStable === true;
  const databentoGapPresent = input.databentoGapPresent === true;
  const topstepWindowThin = input.topstepWindowThin === true;
  const growthDirection = toText(input.liveGrowthDirection || '').toLowerCase();
  const growthRate = Number(input.liveGrowthRatePct || 0);

  const streakTarget = Number(target.liveStreak || target.liveDistinct || 1);

  return {
    raise_live_outcomes: liveCount >= Number(target.liveCount || 1),
    raise_live_pct: livePct >= Number(target.livePct || 1),
    extend_live_streak: (target.liveStreak ? liveStreak >= target.liveStreak : liveDistinct >= streakTarget),
    improve_regime_provenance: provenance >= Number(target.provenance || 1),
    lift_persistence_from_suppressed: target.requirePersistenceUnsuppressed ? !persistenceSuppressed : true,
    reduce_backfill_dominance: (livePct >= 50 || liveCount >= backfillCount),
    clear_databento_recent_gap: target.requireNoDatabentoGap ? !databentoGapPresent : true,
    extend_topstep_live_window: (!topstepWindowThin && topstepHealthy),
    maintain_daily_scoring_consistency: dailyStable,
    maintain_databento_foundation: databentoLive,
    maintain_topstep_health: topstepHealthy,
    improve_live_growth_rate: growthDirection === 'improving' && growthRate > 0,
    __structuredPersistenceSatisfied: target.requireStructuredPersistence ? persistenceStructured : true,
  };
}

function computeReadinessProgressPct(input = {}) {
  const target = getTierThresholds(input.nextTargetTier);
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const liveDistinct = Math.max(0, Number(input.liveDistinct || 0));
  const liveStreak = Math.max(0, Number(input.liveStreak || 0));
  const provenance = Math.max(0, Number(input.regimeCoverageWithProvenance || 0));

  const requirementStatus = buildRequirementStatus(input);
  const ratioLiveCount = clamp(liveCount / Math.max(1, Number(target.liveCount || 1)), 0, 1);
  const ratioLivePct = clamp(livePct / Math.max(1, Number(target.livePct || 1)), 0, 1);
  const ratioLiveDistinct = clamp((target.liveStreak ? liveStreak : liveDistinct) / Math.max(1, Number(target.liveStreak || target.liveDistinct || 1)), 0, 1);
  const ratioProvenance = clamp(provenance / Math.max(1, Number(target.provenance || 1)), 0, 1);

  const persistenceRatio = requirementStatus.lift_persistence_from_suppressed ? 1 : 0;
  const infraParts = [
    requirementStatus.maintain_topstep_health ? 1 : 0,
    requirementStatus.maintain_databento_foundation ? 1 : 0,
    requirementStatus.maintain_daily_scoring_consistency ? 1 : 0,
    requirementStatus.clear_databento_recent_gap ? 1 : 0,
    requirementStatus.extend_topstep_live_window ? 1 : 0,
    requirementStatus.__structuredPersistenceSatisfied ? 1 : 0,
  ];
  const infraRatio = infraParts.reduce((acc, value) => acc + value, 0) / Math.max(1, infraParts.length);

  let pct = (
    ratioLiveCount * 35
    + ratioLivePct * 25
    + ratioLiveDistinct * 15
    + ratioProvenance * 10
    + persistenceRatio * 8
    + infraRatio * 7
  );

  if (input.nextTargetTier === 'intelligence_ready') {
    pct = Math.min(pct, 85);
  }

  const hardBlockersCount = Math.max(0, Number(input.hardBlockersCount || 0));
  const growthDirection = toText(input.liveGrowthDirection || '').toLowerCase();
  if (hardBlockersCount >= 4 && growthDirection !== 'improving') {
    pct = Math.min(pct, 45);
  }
  if (hardBlockersCount >= 2 && growthDirection === 'flat') {
    pct = Math.min(pct, 60);
  }

  return round2(clamp(pct, 0, 100));
}

function applyReadinessCaps(rawPct, input = {}) {
  const currentTier = normalizeEvidenceTier(input.currentEvidenceTier || 'not_ready');
  const nextTier = normalizeEvidenceTier(input.nextTargetTier || 'early_live_build');
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const provenance = Math.max(0, Number(input.regimeCoverageWithProvenance || 0));
  const persistencePolicy = toText(input.persistencePolicy || '').toLowerCase();
  const persistenceOverrideLabel = toText(input.persistenceOverrideLabel || '').toLowerCase();
  const persistenceSuppressed = persistencePolicy === 'suppress_confidence' || persistenceOverrideLabel === 'suppressed';
  const topstepWindowThin = input.topstepWindowThin === true;
  const databentoGapPresent = input.databentoGapPresent === true;
  const hardBlockers = Array.isArray(input.hardBlockers) ? input.hardBlockers : [];
  const hardBlockersCount = hardBlockers.length;
  const growthDirection = toText(input.liveGrowthDirection || '').toLowerCase();
  const hasRaiseLiveOutcomes = hardBlockers.includes('raise_live_outcomes');
  const hasRaiseLivePct = hardBlockers.includes('raise_live_pct');

  const caps = [];

  if (currentTier === 'not_ready') caps.push(55);
  if (currentTier === 'not_ready' && liveCount < 5) caps.push(30);
  if (currentTier === 'not_ready' && liveCount < 3) caps.push(20);

  if (livePct < 15) caps.push(28);
  if (livePct < 10) caps.push(22);

  if (hasRaiseLiveOutcomes) caps.push(32);
  if (hasRaiseLivePct) caps.push(32);
  if (hasRaiseLiveOutcomes && hasRaiseLivePct) caps.push(24);

  if (persistenceSuppressed) caps.push(nextTier === 'early_live_build' ? 36 : 30);
  if (provenance < 1) caps.push(34);
  if (topstepWindowThin) caps.push(34);
  if (databentoGapPresent && nextTier !== 'early_live_build') caps.push(36);

  if (hardBlockersCount >= 4) caps.push(24);
  else if (hardBlockersCount >= 3) caps.push(30);
  else if (hardBlockersCount >= 2 && growthDirection !== 'improving') caps.push(34);

  let capped = clamp(Number(rawPct || 0), 0, 100);
  if (caps.length) {
    capped = Math.min(capped, ...caps);
  }
  return round2(clamp(capped, 0, 100));
}

function classifyReachability(input = {}) {
  const currentTier = normalizeEvidenceTier(input.currentEvidenceTier || 'not_ready');
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const hardBlockersCount = Math.max(0, Number(input.hardBlockersCount || 0));
  const hardBlockers = Array.isArray(input.hardBlockers) ? input.hardBlockers : [];
  const progressPct = clamp(Number(input.readinessProgressPct || 0), 0, 100);
  const growthDirection = toText(input.liveGrowthDirection || '').toLowerCase();
  const nextTier = normalizeEvidenceTier(input.nextTargetTier || 'early_live_build');
  const hasRaiseLiveOutcomes = hardBlockers.includes('raise_live_outcomes');
  const hasRaiseLivePct = hardBlockers.includes('raise_live_pct');

  if (nextTier === 'intelligence_ready' && progressPct < 85) return 'distant';
  if (input.topstepHealthy !== true || input.databentoLive !== true || input.dailyStable !== true) return 'blocked';
  if (currentTier === 'not_ready' && (liveCount < 5 || livePct < 15)) {
    if (hasRaiseLiveOutcomes || hasRaiseLivePct || hardBlockersCount >= 2) return 'blocked';
    return 'distant';
  }
  if (hardBlockersCount >= 4) return 'blocked';
  if (hardBlockersCount >= 3) return 'distant';
  if (currentTier === 'not_ready' && hardBlockersCount >= 2) return 'distant';
  if (currentTier === 'not_ready' && progressPct < 65) return 'distant';
  if (hardBlockersCount <= 1 && progressPct >= 70 && growthDirection === 'improving') return 'near';
  if (progressPct >= 45) return 'plausible';
  return 'distant';
}

function classifyTierDistance(input = {}) {
  const safeReachability = normalizeReachabilityLabel(input.targetReachabilityLabel || 'blocked');
  const pct = clamp(Number(input.readinessProgressPct || 0), 0, 100);
  const currentTier = normalizeEvidenceTier(input.currentEvidenceTier || 'not_ready');
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const hardBlockersCount = Math.max(0, Number(input.hardBlockersCount || 0));

  if (currentTier === 'not_ready' && (liveCount < 5 || livePct < 15)) return 'far';
  if (safeReachability === 'blocked' || pct < 35) return 'far';
  if (safeReachability === 'distant' && (hardBlockersCount >= 2 || pct < 75)) return 'far';
  if (pct < 70) return 'medium';
  return 'close';
}

function classifyDaysLabel(input = {}) {
  const reachability = normalizeReachabilityLabel(input.targetReachabilityLabel || 'blocked');
  const distance = normalizeTierDistance(input.estimatedTierDistance || 'far');
  const currentTier = normalizeEvidenceTier(input.currentEvidenceTier || 'not_ready');
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = clamp(Number(input.livePct || 0), 0, 100);
  const growthDirection = toText(input.liveGrowthDirection || '').toLowerCase();
  const hardBlockersCount = Math.max(0, Number(input.hardBlockersCount || 0));

  if (reachability === 'blocked') return 'unknown';
  if (currentTier === 'not_ready' && (liveCount < 5 || livePct < 15)) return 'gt_20_days';
  if (distance === 'far') return 'gt_20_days';
  if (distance === 'medium') {
    if (growthDirection === 'improving') return 'days_10_20';
    return 'gt_20_days';
  }
  if (hardBlockersCount === 0 && growthDirection === 'improving') return 'lt_5_days';
  return 'days_5_10';
}

function buildPlannerInsight(input = {}) {
  const currentTier = normalizeEvidenceTier(input.currentEvidenceTier || 'not_ready');
  const nextTier = normalizeEvidenceTier(input.nextTargetTier || 'early_live_build');
  const reachability = normalizeReachabilityLabel(input.targetReachabilityLabel || 'blocked');
  const liveCount = Math.max(0, Number(input.liveCount || 0));
  const livePct = round2(input.livePct || 0);
  const liveSummary = `${Math.max(0, Number(input.liveCount || 0))}/${Math.max(0, Number(input.totalCount || 0))} live (${round2(input.livePct || 0)}%)`;
  const actions = Array.isArray(input.shortestPathActions) ? input.shortestPathActions : [];
  const blockers = Array.isArray(input.hardBlockers) ? input.hardBlockers : [];

  if (currentTier === 'intelligence_ready') {
    return 'Live evidence meets intelligence-ready thresholds; continue monitoring for regression conservatively.';
  }
  if (currentTier === 'not_ready' && (liveCount < 5 || livePct < 15)) {
    return `Jarvis is firmly not_ready: live evidence is only ${liveSummary}. Infrastructure is ahead of evidence; the next step is accumulating live outcomes before intelligence work.`;
  }
  if (reachability === 'blocked') {
    return `Jarvis is blocked from ${nextTier}; live evidence is ${liveSummary} and hard blockers are ${blockers.slice(0, 3).join(', ') || 'unspecified'}.`;
  }
  if (reachability === 'distant') {
    return `Jarvis is still distant from ${nextTier}; live evidence is ${liveSummary} and shortest path actions are ${actions.slice(0, 3).join(', ') || 'raise_live_outcomes, raise_live_pct, extend_live_streak'}.`;
  }
  if (reachability === 'near') {
    return `Jarvis is near ${nextTier}; maintain momentum on ${actions.slice(0, 2).join(', ') || 'maintain_daily_scoring_consistency, improve_live_growth_rate'}.`;
  }
  return `Jarvis is plausibly progressing from ${currentTier} toward ${nextTier}; shortest path is ${actions.slice(0, 3).join(', ') || 'raise_live_outcomes, raise_live_pct, extend_live_streak'}.`;
}

function buildLiveEvidenceGrowthPlannerSummary(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      generatedAt: new Date().toISOString(),
      windowSessions: clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS),
      performanceSource: normalizePerformanceSource(input.performanceSource || input.source || 'all'),
      currentRegimeLabel: normalizeRegimeLabel(input.currentRegimeLabel || 'unknown'),
      currentEvidenceTier: 'not_ready',
      nextTargetTier: 'early_live_build',
      targetReachabilityLabel: 'blocked',
      readinessProgressPct: 0,
      currentLiveEvidenceCount: 0,
      currentBackfillEvidenceCount: 0,
      currentTotalEvidenceCount: 0,
      currentLiveEvidencePct: 0,
      currentLiveEvidence7d: 0,
      currentLiveEvidence14d: 0,
      currentLiveEvidence30d: 0,
      currentLiveDistinctScoreDates: 0,
      currentRegimeCoverageWithProvenance: 0,
      currentPersistenceConfidencePolicy: 'suppress_confidence',
      currentPersistenceOverrideLabel: 'suppressed',
      currentTopstepLiveHealth: 'unknown',
      currentDatabentoFoundationStatus: 'unknown',
      requirementsSatisfied: [],
      requirementsRemaining: ['raise_live_outcomes', 'raise_live_pct', 'extend_live_streak'],
      hardBlockers: ['raise_live_outcomes', 'raise_live_pct', 'extend_live_streak'],
      softBlockers: ['improve_regime_provenance'],
      growthSupports: [],
      shortestPathActions: ['raise_live_outcomes', 'raise_live_pct', 'extend_live_streak'],
      progressSignals: [],
      stalledSignals: ['live_count_flat', 'live_pct_flat', 'backfill_still_dominant'],
      estimatedTierDistance: 'far',
      estimatedDaysToNextTierLabel: 'unknown',
      plannerInsight: 'Live evidence growth planner unavailable because database access failed.',
      warnings: ['db_unavailable'],
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);

  const nowDate = toIsoDate(input.nowDate || input.snapshotDate || new Date().toISOString()) || toIsoDate(new Date().toISOString());
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');

  const liveEvidenceAccumulation = input.liveEvidenceAccumulation && typeof input.liveEvidenceAccumulation === 'object'
    ? input.liveEvidenceAccumulation
    : {};
  const dataCoverage = input.dataCoverage && typeof input.dataCoverage === 'object'
    ? input.dataCoverage
    : {};
  const topstepIntegrationAudit = input.topstepIntegrationAudit && typeof input.topstepIntegrationAudit === 'object'
    ? input.topstepIntegrationAudit
    : {};
  const databentoIngestionStatus = input.databentoIngestionStatus && typeof input.databentoIngestionStatus === 'object'
    ? input.databentoIngestionStatus
    : {};
  const dailyEvidenceScoringStatus = input.dailyEvidenceScoringStatus && typeof input.dailyEvidenceScoringStatus === 'object'
    ? input.dailyEvidenceScoringStatus
    : {};
  const regimePerformanceFeedback = input.regimePerformanceFeedback && typeof input.regimePerformanceFeedback === 'object'
    ? input.regimePerformanceFeedback
    : {};
  const regimePersistenceTrustOverride = input.regimePersistenceTrustOverride && typeof input.regimePersistenceTrustOverride === 'object'
    ? input.regimePersistenceTrustOverride
    : {};
  const regimePersistenceTrustOverrideDelta = input.regimePersistenceTrustOverrideDelta && typeof input.regimePersistenceTrustOverrideDelta === 'object'
    ? input.regimePersistenceTrustOverrideDelta
    : {};
  const regimeLivePersistenceQuality = input.regimeLivePersistenceQuality && typeof input.regimeLivePersistenceQuality === 'object'
    ? input.regimeLivePersistenceQuality
    : {};

  const currentRegimeLabel = normalizeRegimeLabel(
    input.currentRegimeLabel
      || input.regimeDetection?.regimeLabel
      || dataCoverage?.evidenceReadiness?.regimeModule?.currentRegimeLabel
      || 'unknown'
  );

  const currentLiveEvidenceCount = Math.max(0, Number(
    liveEvidenceAccumulation.liveEvidenceCount
      ?? dataCoverage?.evidenceReadiness?.strategyModule?.liveSampleSize
      ?? 0
  ));
  const currentBackfillEvidenceCount = Math.max(0, Number(liveEvidenceAccumulation.backfillEvidenceCount || 0));
  const currentTotalEvidenceCount = Math.max(0, Number(
    liveEvidenceAccumulation.totalEvidenceCount
      ?? (currentLiveEvidenceCount + currentBackfillEvidenceCount)
      ?? 0
  ));
  const currentLiveEvidencePct = currentTotalEvidenceCount > 0
    ? round2((currentLiveEvidenceCount / currentTotalEvidenceCount) * 100)
    : 0;

  const currentLiveEvidence7d = Math.max(0, Number(liveEvidenceAccumulation.liveEvidence7d || 0));
  const currentLiveEvidence14d = Math.max(0, Number(liveEvidenceAccumulation.liveEvidence14d || 0));
  const currentLiveEvidence30d = Math.max(0, Number(liveEvidenceAccumulation.liveEvidence30d || 0));
  const currentLiveDistinctScoreDates = queryLiveDistinctScoreDates(db);
  const liveScoreDatesDesc = queryLiveScoreDatesDescending(db, 180);
  const currentLiveStreakDays = computeLiveStreakDays(liveScoreDatesDesc);

  const currentRegimeCoverageWithProvenance = Math.max(0, Number(
    regimePerformanceFeedback?.dataQuality?.coverage?.withProvenance
      ?? dataCoverage?.evidenceReadiness?.regimeModule?.coverageWithProvenance
      ?? 0
  ));

  const currentPersistenceConfidencePolicy = toText(
    regimePersistenceTrustOverride?.confidencePolicy
      || dataCoverage?.evidenceReadiness?.persistenceModule?.confidencePolicy
      || 'suppress_confidence'
  ).toLowerCase() || 'suppress_confidence';

  const currentPersistenceOverrideLabel = toText(
    regimePersistenceTrustOverride?.overrideLabel
      || dataCoverage?.evidenceReadiness?.persistenceModule?.overrideLabel
      || 'suppressed'
  ).toLowerCase() || 'suppressed';

  const currentTopstepLiveHealth = toText(
    topstepIntegrationAudit?.currentLiveFeedStatus
      || dataCoverage?.liveFeeds?.topstep?.currentLiveFeedStatus
      || 'unknown'
  ).toLowerCase() || 'unknown';

  const currentDatabentoFoundationStatus = deriveDatabentoStatus(databentoIngestionStatus);

  const liveGrowthDirection = toText(liveEvidenceAccumulation.liveEvidenceGrowthDirection || 'flat').toLowerCase() || 'flat';
  const liveGrowthRatePct = Number(toNumber(liveEvidenceAccumulation.liveEvidenceGrowthRatePct, 0) || 0);

  const liveSessionDistinctDays = queryLiveSessionDistinctDays(db);
  const dailyStabilityFromDb = queryDailyScoringStability(db, nowDate);
  const latestRunDate = toIsoDate(dailyEvidenceScoringStatus?.latestRun?.runDate || dailyEvidenceScoringStatus?.latestRun?.run_date);
  const latestRunGapDays = latestRunDate ? daysBetween(latestRunDate, nowDate) : null;
  const dailyStable = (
    dailyStabilityFromDb.isStable === true
    || (
      toText(dailyEvidenceScoringStatus?.latestRun?.status || '').toLowerCase() === 'ok'
      && Number.isFinite(latestRunGapDays)
      && latestRunGapDays <= 2
    )
  );

  const topstepHealthy = currentTopstepLiveHealth === 'healthy';
  const databentoLive = currentDatabentoFoundationStatus === 'live';
  const databentoGapPresent = hasDatabentoRecentGap(liveEvidenceAccumulation, databentoIngestionStatus);
  const topstepWindowThin = hasTopstepWindowThin(liveEvidenceAccumulation, liveSessionDistinctDays);

  const baseReadinessLabel = toText(liveEvidenceAccumulation.intelligenceReadinessLabel || 'not_ready').toLowerCase();
  const currentEvidenceTier = classifyCurrentTier({
    liveCount: currentLiveEvidenceCount,
    livePct: currentLiveEvidencePct,
    liveDistinct: currentLiveDistinctScoreDates,
    liveStreak: currentLiveStreakDays,
    regimeCoverageWithProvenance: currentRegimeCoverageWithProvenance,
    persistencePolicy: currentPersistenceConfidencePolicy,
    persistenceOverrideLabel: currentPersistenceOverrideLabel,
    topstepHealthy,
    databentoLive,
    dailyStable,
    databentoGapPresent,
    topstepWindowThin,
    baseReadinessLabel,
  });

  const nextTargetTier = nextTierFromCurrent(currentEvidenceTier);

  const requirementStatus = buildRequirementStatus({
    nextTargetTier,
    liveCount: currentLiveEvidenceCount,
    backfillCount: currentBackfillEvidenceCount,
    livePct: currentLiveEvidencePct,
    liveDistinct: currentLiveDistinctScoreDates,
    liveStreak: currentLiveStreakDays,
    regimeCoverageWithProvenance: currentRegimeCoverageWithProvenance,
    persistencePolicy: currentPersistenceConfidencePolicy,
    persistenceOverrideLabel: currentPersistenceOverrideLabel,
    topstepHealthy,
    databentoLive,
    dailyStable,
    databentoGapPresent,
    topstepWindowThin,
    liveGrowthDirection,
    liveGrowthRatePct,
  });

  const requirementEntries = Object.entries(requirementStatus)
    .filter(([key]) => ALLOWED_REQUIREMENT_ENUM.has(key));

  const requirementsSatisfied = uniqueBounded(
    requirementEntries.filter(([, ok]) => ok === true).map(([key]) => key),
    ALLOWED_REQUIREMENT_ENUM
  );
  const requirementsRemaining = uniqueBounded(
    requirementEntries.filter(([, ok]) => ok !== true).map(([key]) => key),
    ALLOWED_REQUIREMENT_ENUM
  );

  const hardBlockerPriority = [
    'raise_live_outcomes',
    'raise_live_pct',
    'extend_live_streak',
    'lift_persistence_from_suppressed',
    'clear_databento_recent_gap',
    'extend_topstep_live_window',
    'maintain_databento_foundation',
    'maintain_topstep_health',
  ];

  const hardBlockers = uniqueBounded(
    hardBlockerPriority.filter((key) => requirementsRemaining.includes(key)),
    ALLOWED_REQUIREMENT_ENUM
  );

  const softBlockers = uniqueBounded(
    requirementsRemaining.filter((key) => !hardBlockers.includes(key)),
    ALLOWED_REQUIREMENT_ENUM
  );

  const growthSupports = uniqueBounded(
    requirementsSatisfied.filter((key) => (
      key === 'maintain_daily_scoring_consistency'
      || key === 'maintain_databento_foundation'
      || key === 'maintain_topstep_health'
      || key === 'improve_live_growth_rate'
      || key === 'reduce_backfill_dominance'
      || key === 'improve_regime_provenance'
      || key === 'lift_persistence_from_suppressed'
    )),
    ALLOWED_REQUIREMENT_ENUM
  );

  const shortestPathPriority = [
    'raise_live_outcomes',
    'raise_live_pct',
    'extend_live_streak',
    'lift_persistence_from_suppressed',
    'improve_regime_provenance',
    'clear_databento_recent_gap',
    'extend_topstep_live_window',
    'reduce_backfill_dominance',
    'improve_live_growth_rate',
    'maintain_daily_scoring_consistency',
    'maintain_databento_foundation',
    'maintain_topstep_health',
  ];
  let shortestPathActions = uniqueBounded(
    shortestPathPriority.filter((key) => requirementsRemaining.includes(key)),
    ALLOWED_REQUIREMENT_ENUM
  );
  if (!shortestPathActions.length && nextTargetTier !== currentEvidenceTier) {
    shortestPathActions = ['raise_live_outcomes'];
  }
  shortestPathActions = shortestPathActions.slice(0, 5);

  const progressSignals = uniqueBounded([
    liveGrowthDirection === 'improving' && currentLiveEvidence7d > 0 ? 'live_count_rising' : null,
    liveGrowthDirection === 'improving' && (currentLiveEvidencePct >= 20 || requirementsSatisfied.includes('raise_live_pct')) ? 'live_pct_rising' : null,
    dailyStable ? 'daily_scoring_stable' : null,
    databentoLive ? 'databento_live' : null,
    topstepHealthy ? 'topstep_healthy' : null,
    (currentPersistenceConfidencePolicy !== 'suppress_confidence' || toText(regimePersistenceTrustOverrideDelta?.deltaDirection || '').toLowerCase() === 'improving')
      ? 'persistence_improving'
      : null,
    currentRegimeCoverageWithProvenance >= 1 ? 'regime_provenance_improving' : null,
  ], ALLOWED_PROGRESS_SIGNALS);

  const stalledSignals = uniqueBounded([
    liveGrowthDirection === 'flat' ? 'live_count_flat' : null,
    (!requirementsSatisfied.includes('raise_live_pct') && liveGrowthDirection !== 'improving') ? 'live_pct_flat' : null,
    currentPersistenceConfidencePolicy === 'suppress_confidence' ? 'persistence_still_suppressed' : null,
    currentRegimeCoverageWithProvenance < 1 ? 'regime_provenance_thin' : null,
    databentoGapPresent ? 'databento_recent_gap_present' : null,
    topstepWindowThin ? 'topstep_window_thin' : null,
    currentBackfillEvidenceCount > currentLiveEvidenceCount ? 'backfill_still_dominant' : null,
  ], ALLOWED_STALLED_SIGNALS);

  let readinessProgressPct = nextTargetTier === currentEvidenceTier
    ? 100
    : computeReadinessProgressPct({
      nextTargetTier,
      liveCount: currentLiveEvidenceCount,
      livePct: currentLiveEvidencePct,
      liveDistinct: currentLiveDistinctScoreDates,
      liveStreak: currentLiveStreakDays,
      regimeCoverageWithProvenance: currentRegimeCoverageWithProvenance,
      persistencePolicy: currentPersistenceConfidencePolicy,
      persistenceOverrideLabel: currentPersistenceOverrideLabel,
      topstepHealthy,
      databentoLive,
      dailyStable,
      databentoGapPresent,
      topstepWindowThin,
      hardBlockersCount: hardBlockers.length,
      liveGrowthDirection,
    });

  readinessProgressPct = applyReadinessCaps(readinessProgressPct, {
    currentEvidenceTier,
    nextTargetTier,
    liveCount: currentLiveEvidenceCount,
    livePct: currentLiveEvidencePct,
    regimeCoverageWithProvenance: currentRegimeCoverageWithProvenance,
    persistencePolicy: currentPersistenceConfidencePolicy,
    persistenceOverrideLabel: currentPersistenceOverrideLabel,
    topstepWindowThin,
    databentoGapPresent,
    hardBlockers,
    liveGrowthDirection,
  });

  let targetReachabilityLabel = classifyReachability({
    currentEvidenceTier,
    liveCount: currentLiveEvidenceCount,
    livePct: currentLiveEvidencePct,
    nextTargetTier,
    hardBlockersCount: hardBlockers.length,
    hardBlockers,
    readinessProgressPct,
    liveGrowthDirection,
    topstepHealthy,
    databentoLive,
    dailyStable,
  });

  if (nextTargetTier === currentEvidenceTier && currentEvidenceTier === 'intelligence_ready') {
    targetReachabilityLabel = 'near';
    readinessProgressPct = 100;
  }

  const estimatedTierDistance = classifyTierDistance({
    targetReachabilityLabel,
    readinessProgressPct,
    currentEvidenceTier,
    liveCount: currentLiveEvidenceCount,
    livePct: currentLiveEvidencePct,
    hardBlockersCount: hardBlockers.length,
  });
  const estimatedDaysToNextTierLabel = classifyDaysLabel({
    targetReachabilityLabel,
    estimatedTierDistance,
    currentEvidenceTier,
    liveCount: currentLiveEvidenceCount,
    livePct: currentLiveEvidencePct,
    liveGrowthDirection,
    hardBlockersCount: hardBlockers.length,
  });

  const plannerInsight = buildPlannerInsight({
    currentEvidenceTier,
    nextTargetTier,
    targetReachabilityLabel,
    liveCount: currentLiveEvidenceCount,
    totalCount: currentTotalEvidenceCount,
    livePct: currentLiveEvidencePct,
    shortestPathActions,
    hardBlockers,
  });

  const warnings = [];
  if (currentLiveEvidenceCount <= 0) warnings.push('no_live_evidence');
  if (currentBackfillEvidenceCount > currentLiveEvidenceCount) warnings.push('backfill_dominant');
  if (currentPersistenceConfidencePolicy === 'suppress_confidence') warnings.push('persistence_suppressed');
  if (currentLiveDistinctScoreDates < 3) warnings.push('thin_growth_history');
  if (targetReachabilityLabel === 'blocked') warnings.push('next_tier_blocked');

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,

    currentEvidenceTier,
    nextTargetTier,
    targetReachabilityLabel: normalizeReachabilityLabel(targetReachabilityLabel),
    readinessProgressPct: round2(clamp(readinessProgressPct, 0, 100)),

    currentLiveEvidenceCount,
    currentBackfillEvidenceCount,
    currentTotalEvidenceCount,
    currentLiveEvidencePct,
    currentLiveEvidence7d,
    currentLiveEvidence14d,
    currentLiveEvidence30d,
    currentLiveDistinctScoreDates,

    currentRegimeCoverageWithProvenance,
    currentPersistenceConfidencePolicy,
    currentPersistenceOverrideLabel,
    currentTopstepLiveHealth,
    currentDatabentoFoundationStatus,

    requirementsSatisfied,
    requirementsRemaining,
    hardBlockers,
    softBlockers,
    growthSupports,

    shortestPathActions,
    progressSignals,
    stalledSignals,

    estimatedTierDistance: normalizeTierDistance(estimatedTierDistance),
    estimatedDaysToNextTierLabel: normalizeDaysLabel(estimatedDaysToNextTierLabel),

    plannerInsight,
    warnings,
    advisoryOnly: true,
  };
}

module.exports = {
  buildLiveEvidenceGrowthPlannerSummary,
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  ALLOWED_EVIDENCE_TIERS,
  ALLOWED_TARGET_REACHABILITY_LABELS,
  ALLOWED_ESTIMATED_TIER_DISTANCE,
  ALLOWED_ESTIMATED_DAYS_TO_NEXT_TIER_LABELS,
  ALLOWED_REQUIREMENT_ENUM,
  ALLOWED_PROGRESS_SIGNALS,
  ALLOWED_STALLED_SIGNALS,
};
