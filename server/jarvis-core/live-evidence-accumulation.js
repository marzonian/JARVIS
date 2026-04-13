'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  toNumber,
  toText,
} = require('./data-foundation-storage');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const ALLOWED_EVIDENCE_DEPTH_LABELS = new Set([
  'insufficient',
  'building',
  'usable',
  'strong',
]);

const ALLOWED_EVIDENCE_FRESHNESS_LABELS = new Set([
  'stale',
  'mixed',
  'recent',
  'highly_recent',
]);

const ALLOWED_EVIDENCE_RELIABILITY_LABELS = new Set([
  'weak',
  'cautious',
  'credible',
  'strong',
]);

const ALLOWED_INTELLIGENCE_READINESS_LABELS = new Set([
  'not_ready',
  'early_live_build',
  'limited_use',
  'intelligence_candidate',
]);

const ALLOWED_GROWTH_DIRECTIONS = new Set([
  'improving',
  'flat',
  'regressing',
]);

const ALLOWED_BLOCKERS = new Set([
  'live_sample_too_small',
  'live_pct_too_low',
  'backfill_dominant',
  'regime_provenance_thin',
  'persistence_still_suppressed',
  'databento_recent_gap_present',
  'live_scoring_history_too_short',
  'topstep_live_window_too_short',
]);

const ALLOWED_SUPPORTS = new Set([
  'live_evidence_growing',
  'daily_scoring_consistent',
  'databento_foundation_live',
  'topstep_live_healthy',
  'persistence_blockers_reducing',
  'regime_provenance_improving',
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

function normalizeDirection(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_GROWTH_DIRECTIONS.has(txt)) return txt;
  return 'flat';
}

function normalizeDepthLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_EVIDENCE_DEPTH_LABELS.has(txt)) return txt;
  return 'insufficient';
}

function normalizeFreshnessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_EVIDENCE_FRESHNESS_LABELS.has(txt)) return txt;
  return 'stale';
}

function normalizeReliabilityLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_EVIDENCE_RELIABILITY_LABELS.has(txt)) return txt;
  return 'weak';
}

function normalizeIntelligenceReadinessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (ALLOWED_INTELLIGENCE_READINESS_LABELS.has(txt)) return txt;
  return 'not_ready';
}

function toIsoDate(value) {
  const txt = normalizeDate(value);
  if (!txt) return '';
  return txt;
}

function toUtcMs(isoDate = '') {
  const normalized = toIsoDate(isoDate);
  if (!normalized) return null;
  const parts = normalized.split('-').map((part) => Number(part));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function addDays(isoDate = '', days = 0) {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return '';
  const shift = Math.round(Number(days || 0));
  return new Date(ms + (shift * 86_400_000)).toISOString().slice(0, 10);
}

function daysBetween(leftDate = '', rightDate = '') {
  const leftMs = toUtcMs(leftDate);
  const rightMs = toUtcMs(rightDate);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs) || rightMs < leftMs) return null;
  return Math.floor((rightMs - leftMs) / 86_400_000);
}

function uniqueBounded(values = [], allowed = new Set()) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = toText(raw).toLowerCase();
    if (!value || !allowed.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function queryOutcomeCounts(db, nowDate = '') {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN source_type = 'live' THEN 1 ELSE 0 END) AS live_count,
      SUM(CASE WHEN source_type = 'backfill' THEN 1 ELSE 0 END) AS backfill_count,
      COUNT(DISTINCT CASE WHEN source_type = 'live' THEN score_date END) AS live_distinct_dates,
      MAX(CASE WHEN source_type = 'live' THEN score_date END) AS last_live_date
    FROM jarvis_scored_trade_outcomes
  `).get() || {};

  const start7 = addDays(nowDate, -6);
  const start14 = addDays(nowDate, -13);
  const start30 = addDays(nowDate, -29);
  const prev7Start = addDays(nowDate, -13);
  const prev7End = addDays(nowDate, -7);

  const live7 = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live' AND score_date >= ? AND score_date <= ?
  `).get(start7, nowDate)?.c || 0);

  const live14 = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live' AND score_date >= ? AND score_date <= ?
  `).get(start14, nowDate)?.c || 0);

  const live30 = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live' AND score_date >= ? AND score_date <= ?
  `).get(start30, nowDate)?.c || 0);

  const prev7 = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_scored_trade_outcomes
    WHERE source_type = 'live' AND score_date >= ? AND score_date <= ?
  `).get(prev7Start, prev7End)?.c || 0);

  return {
    totalEvidenceCount: Number(totals.total_count || 0),
    liveEvidenceCount: Number(totals.live_count || 0),
    backfillEvidenceCount: Number(totals.backfill_count || 0),
    liveDistinctScoreDates: Number(totals.live_distinct_dates || 0),
    lastLiveScoreDate: toIsoDate(totals.last_live_date),
    liveEvidence7d: live7,
    liveEvidence14d: live14,
    liveEvidence30d: live30,
    previousLiveEvidence7d: prev7,
  };
}

function queryDailyScoringWindow(db, nowDate = '') {
  const startDate = addDays(nowDate, -14);
  const window = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status IN ('ok', 'noop') THEN 1 ELSE 0 END) AS healthy_runs,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_runs,
      MAX(run_date) AS latest_run_date
    FROM jarvis_daily_scoring_runs
    WHERE run_date >= ?
  `).get(startDate) || {};

  return {
    totalRuns14d: Number(window.total_runs || 0),
    healthyRuns14d: Number(window.healthy_runs || 0),
    okRuns14d: Number(window.ok_runs || 0),
    latestRunDate: toIsoDate(window.latest_run_date),
  };
}

function queryLiveSessionWindow(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT substr(snapshot_at, 1, 10)) AS distinct_days,
      MAX(substr(snapshot_at, 1, 10)) AS last_date
    FROM jarvis_live_session_data
    WHERE source = 'topstep_sync'
  `).get() || {};

  return {
    liveSessionRows: Number(row.total_rows || 0),
    liveSessionDistinctDays: Number(row.distinct_days || 0),
    lastLiveSessionDate: toIsoDate(row.last_date),
  };
}

function queryDatabentoGapState(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS unresolved_count,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'deferred_recent' THEN 1 ELSE 0 END) AS deferred_recent_count
    FROM jarvis_databento_gap_audit
    WHERE resolved_at IS NULL
  `).get() || {};

  return {
    unresolvedCount: Number(row.unresolved_count || 0),
    openCount: Number(row.open_count || 0),
    deferredRecentCount: Number(row.deferred_recent_count || 0),
  };
}

function computeGrowthDirection(current7 = 0, previous7 = 0) {
  const current = Math.max(0, Number(current7 || 0));
  const previous = Math.max(0, Number(previous7 || 0));
  const delta = current - previous;
  let ratePct = 0;
  if (previous > 0) {
    ratePct = ((delta / previous) * 100);
  } else if (current > 0) {
    ratePct = 100;
  }
  ratePct = round2(ratePct);

  let direction = 'flat';
  if (delta >= 2 && ratePct > 15) direction = 'improving';
  if (delta <= -2 && ratePct < -15) direction = 'regressing';

  return {
    liveEvidenceGrowthDirection: normalizeDirection(direction),
    liveEvidenceGrowthRatePct: ratePct,
  };
}

function classifyDepthLabel(liveEvidenceCount = 0, liveEvidencePct = 0) {
  const live = Math.max(0, Number(liveEvidenceCount || 0));
  const pct = Math.max(0, Number(liveEvidencePct || 0));
  if (live < 8 || pct < 20) return 'insufficient';
  if (live < 24 || pct < 40) return 'building';
  if (live >= 60 && pct >= 60) return 'strong';
  return 'usable';
}

function classifyFreshnessLabel(lastLiveScoreDate = '', nowDate = '', live7 = 0, live14 = 0, live30 = 0) {
  const gapDays = daysBetween(lastLiveScoreDate, nowDate);
  if (!lastLiveScoreDate || !Number.isFinite(gapDays)) return 'stale';
  if (gapDays <= 1 && Number(live7 || 0) >= 5) return 'highly_recent';
  if (gapDays <= 3 && Number(live14 || 0) >= 5) return 'recent';
  if (gapDays <= 10 && Number(live30 || 0) > 0) return 'mixed';
  return 'stale';
}

function classifyModuleQuality({ enoughEvidence = false, liveEvidenceCount = 0, liveEvidencePct = 0, totalEvidenceCount = 0 } = {}) {
  const live = Math.max(0, Number(liveEvidenceCount || 0));
  const total = Math.max(0, Number(totalEvidenceCount || 0));
  const pct = Math.max(0, Number(liveEvidencePct || 0));
  if (total <= 0 || live <= 0) return 'weak';
  if (live < 5 || pct < 20) return 'weak';
  if (enoughEvidence !== true || live < 15 || pct < 40) return 'cautious';
  if (live >= 40 && pct >= 60) return 'strong';
  return 'credible';
}

function classifyReliabilityLabel(input = {}) {
  const depthLabel = normalizeDepthLabel(input.evidenceDepthLabel);
  const livePct = Math.max(0, Number(input.liveEvidencePct || 0));
  const blockers = uniqueBounded(input.blockers, ALLOWED_BLOCKERS);
  const growthDirection = normalizeDirection(input.liveEvidenceGrowthDirection);
  const persistenceSuppressed = blockers.includes('persistence_still_suppressed');
  const regimeThin = blockers.includes('regime_provenance_thin');

  if (depthLabel === 'insufficient' || livePct < 20) return 'weak';
  if (depthLabel === 'building') return 'cautious';
  if (persistenceSuppressed || regimeThin) return 'cautious';
  if (growthDirection === 'regressing') return 'cautious';
  if (depthLabel === 'strong' && blockers.length <= 1 && livePct >= 60) return 'strong';
  if (livePct >= 40 && blockers.length <= 3) return 'credible';
  return 'cautious';
}

function classifyIntelligenceReadinessLabel(input = {}) {
  const depthLabel = normalizeDepthLabel(input.evidenceDepthLabel);
  const reliabilityLabel = normalizeReliabilityLabel(input.evidenceReliabilityLabel);
  const strategyReady = input.strategyModule?.enoughEvidence === true;
  const regimeReady = input.regimeModule?.enoughEvidence === true;
  const persistenceReady = input.persistenceModule?.enoughEvidence === true;
  const growthDirection = normalizeDirection(input.liveEvidenceGrowthDirection);

  if (reliabilityLabel === 'weak' || depthLabel === 'insufficient') return 'not_ready';
  if (depthLabel === 'building' || persistenceReady !== true) return 'early_live_build';
  if (reliabilityLabel === 'cautious') return 'limited_use';
  if (strategyReady && regimeReady && persistenceReady && growthDirection !== 'regressing') {
    return 'intelligence_candidate';
  }
  return 'limited_use';
}

function buildModuleReadiness(input = {}) {
  const name = toText(input.name || 'module');
  const enoughEvidence = input.enoughEvidence === true;
  const totalEvidenceCount = Math.max(0, Number(input.totalEvidenceCount || 0));
  const liveEvidenceCount = Math.max(0, Number(input.liveEvidenceCount || 0));
  const liveEvidencePct = totalEvidenceCount > 0
    ? round2((liveEvidenceCount / totalEvidenceCount) * 100)
    : 0;

  const blockers = [];
  const supports = [];

  if (liveEvidenceCount < 5) blockers.push('live_sample_too_small');
  if (liveEvidencePct < 25) blockers.push('live_pct_too_low');
  if (totalEvidenceCount > liveEvidenceCount) blockers.push('backfill_dominant');

  if (name === 'regimeModule' && enoughEvidence !== true) {
    blockers.push('regime_provenance_thin');
  }

  if (name === 'persistenceModule') {
    if (toText(input.persistencePolicy || '').toLowerCase() === 'suppress_confidence') {
      blockers.push('persistence_still_suppressed');
    }
    if (Number(input.currentRegimeLiveCapturedTenureDays || 0) < 3) {
      blockers.push('live_scoring_history_too_short');
    }
  }

  if (input.liveGrowthDirection === 'improving') supports.push('live_evidence_growing');
  if (input.dailyScoringConsistent === true) supports.push('daily_scoring_consistent');
  if (name === 'regimeModule' && Number(input.coverageWithProvenance || 0) >= 1) {
    supports.push('regime_provenance_improving');
  }
  if (name === 'persistenceModule' && input.persistencePolicy !== 'suppress_confidence') {
    supports.push('persistence_blockers_reducing');
  }

  const boundedBlockers = uniqueBounded(blockers, ALLOWED_BLOCKERS);
  const boundedSupports = uniqueBounded(supports, ALLOWED_SUPPORTS);
  return {
    enoughEvidence,
    liveEvidenceCount,
    totalEvidenceCount,
    liveEvidencePct,
    evidenceQualityLabel: normalizeReliabilityLabel(
      classifyModuleQuality({
        enoughEvidence,
        liveEvidenceCount,
        liveEvidencePct,
        totalEvidenceCount,
      })
    ),
    blockerReasons: boundedBlockers,
    supportingReasons: boundedSupports,
    advisoryOnly: true,
  };
}

function buildInsight(input = {}) {
  const live = Math.max(0, Number(input.liveEvidenceCount || 0));
  const total = Math.max(0, Number(input.totalEvidenceCount || 0));
  const livePct = round2(Number(input.liveEvidencePct || 0));
  const readiness = normalizeIntelligenceReadinessLabel(input.intelligenceReadinessLabel);
  const growth = normalizeDirection(input.liveEvidenceGrowthDirection);
  const highestBlocker = toText(input.highestBlocker || '');

  if (total <= 0) {
    return 'No scored evidence is available yet; intelligence must remain conservative.';
  }
  if (readiness === 'not_ready') {
    return `Live evidence remains thin (${live}/${total}, ${livePct}% live); highest blocker: ${highestBlocker || 'live_sample_too_small'}.`;
  }
  if (readiness === 'early_live_build') {
    return `Live evidence is building (${live}/${total}, ${livePct}% live) but not yet deep enough for strong intelligence confidence.`;
  }
  if (readiness === 'limited_use') {
    return `Evidence is usable with caution (${livePct}% live) and growth is ${growth}; keep advisory confidence bounded.`;
  }
  return `Evidence quality is approaching intelligence-candidate status with ${livePct}% live coverage and ${growth} growth.`;
}

function buildLiveEvidenceAccumulationSummary(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      generatedAt: new Date().toISOString(),
      windowSessions: clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS),
      performanceSource: normalizePerformanceSource(input.performanceSource || input.source || 'all'),
      currentRegimeLabel: toText(input.currentRegimeLabel || 'unknown').toLowerCase() || 'unknown',
      totalEvidenceCount: 0,
      liveEvidenceCount: 0,
      backfillEvidenceCount: 0,
      liveEvidencePct: 0,
      backfillEvidencePct: 0,
      liveEvidence7d: 0,
      liveEvidence14d: 0,
      liveEvidence30d: 0,
      liveEvidenceGrowthDirection: 'flat',
      liveEvidenceGrowthRatePct: 0,
      strategyModule: {
        enoughEvidence: false,
        liveEvidenceCount: 0,
        totalEvidenceCount: 0,
        liveEvidencePct: 0,
        evidenceQualityLabel: 'weak',
        blockerReasons: ['live_sample_too_small'],
        supportingReasons: [],
        advisoryOnly: true,
      },
      regimeModule: {
        enoughEvidence: false,
        liveEvidenceCount: 0,
        totalEvidenceCount: 0,
        liveEvidencePct: 0,
        evidenceQualityLabel: 'weak',
        blockerReasons: ['regime_provenance_thin'],
        supportingReasons: [],
        advisoryOnly: true,
      },
      persistenceModule: {
        enoughEvidence: false,
        liveEvidenceCount: 0,
        totalEvidenceCount: 0,
        liveEvidencePct: 0,
        evidenceQualityLabel: 'weak',
        blockerReasons: ['persistence_still_suppressed'],
        supportingReasons: [],
        advisoryOnly: true,
      },
      moduleReadiness: null,
      evidenceDepthLabel: 'insufficient',
      evidenceFreshnessLabel: 'stale',
      evidenceReliabilityLabel: 'weak',
      intelligenceReadinessLabel: 'not_ready',
      highestBlocker: 'live_sample_too_small',
      blockers: ['live_sample_too_small'],
      supports: [],
      liveEvidenceSummary: '0/0 live (0%)',
      liveEvidenceInsight: 'Live evidence accumulation summary unavailable because database access failed.',
      warnings: ['db_unavailable'],
      advisoryOnly: true,
    };
  }

  ensureDataFoundationTables(db);
  const nowDate = toIsoDate(input.nowDate || input.snapshotDate || new Date().toISOString()) || toIsoDate(new Date().toISOString());
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');
  const currentRegimeLabel = toText(input.currentRegimeLabel || input.regimeDetection?.regimeLabel || 'unknown').toLowerCase() || 'unknown';

  const evidenceCounts = queryOutcomeCounts(db, nowDate);
  const dailyWindow = queryDailyScoringWindow(db, nowDate);
  const topstepWindow = queryLiveSessionWindow(db);
  const gapState = queryDatabentoGapState(db);

  const liveEvidencePct = evidenceCounts.totalEvidenceCount > 0
    ? round2((evidenceCounts.liveEvidenceCount / evidenceCounts.totalEvidenceCount) * 100)
    : 0;
  const backfillEvidencePct = evidenceCounts.totalEvidenceCount > 0
    ? round2((evidenceCounts.backfillEvidenceCount / evidenceCounts.totalEvidenceCount) * 100)
    : 0;

  const growth = computeGrowthDirection(evidenceCounts.liveEvidence7d, evidenceCounts.previousLiveEvidence7d);

  const recommendationSummary = input.recommendationPerformanceSummary && typeof input.recommendationPerformanceSummary === 'object'
    ? input.recommendationPerformanceSummary
    : {};
  const dataCoverage = input.dataCoverage && typeof input.dataCoverage === 'object'
    ? input.dataCoverage
    : {};
  const coverageReadiness = dataCoverage.evidenceReadiness && typeof dataCoverage.evidenceReadiness === 'object'
    ? dataCoverage.evidenceReadiness
    : {};
  const strategyCoverage = coverageReadiness.strategyModule && typeof coverageReadiness.strategyModule === 'object'
    ? coverageReadiness.strategyModule
    : {};
  const regimeCoverage = coverageReadiness.regimeModule && typeof coverageReadiness.regimeModule === 'object'
    ? coverageReadiness.regimeModule
    : {};
  const persistenceCoverage = coverageReadiness.persistenceModule && typeof coverageReadiness.persistenceModule === 'object'
    ? coverageReadiness.persistenceModule
    : {};

  const regimeFeedback = input.regimePerformanceFeedback && typeof input.regimePerformanceFeedback === 'object'
    ? input.regimePerformanceFeedback
    : {};
  const regimeQuality = regimeFeedback.dataQuality && typeof regimeFeedback.dataQuality === 'object'
    ? regimeFeedback.dataQuality
    : {};
  const regimeSourceBreakdown = regimeQuality.sourceBreakdown && typeof regimeQuality.sourceBreakdown === 'object'
    ? regimeQuality.sourceBreakdown
    : {};
  const regimeCoverageWithProvenance = Number(regimeQuality?.coverage?.withProvenance || 0);

  const persistenceTrustOverride = input.regimePersistenceTrustOverride && typeof input.regimePersistenceTrustOverride === 'object'
    ? input.regimePersistenceTrustOverride
    : {};
  const persistenceTrustOverrideDelta = input.regimePersistenceTrustOverrideDelta && typeof input.regimePersistenceTrustOverrideDelta === 'object'
    ? input.regimePersistenceTrustOverrideDelta
    : {};
  const persistenceQuality = input.regimeLivePersistenceQuality && typeof input.regimeLivePersistenceQuality === 'object'
    ? input.regimeLivePersistenceQuality
    : {};

  const topstepAudit = input.topstepIntegrationAudit && typeof input.topstepIntegrationAudit === 'object'
    ? input.topstepIntegrationAudit
    : {};
  const topstepHealthy = toText(topstepAudit.currentLiveFeedStatus || '').toLowerCase() === 'healthy';

  const databentoStatus = input.databentoIngestionStatus && typeof input.databentoIngestionStatus === 'object'
    ? input.databentoIngestionStatus
    : {};
  const databentoLatestStatus = toText(databentoStatus.latestRuns?.[0]?.status || '').toLowerCase();
  const databentoLive = databentoLatestStatus === 'ok' || databentoLatestStatus === 'noop';

  const latestDailyRun = input.dailyEvidenceScoringStatus?.latestRun && typeof input.dailyEvidenceScoringStatus.latestRun === 'object'
    ? input.dailyEvidenceScoringStatus.latestRun
    : {};
  const dailyConsistent = (
    dailyWindow.totalRuns14d >= 3
    && dailyWindow.healthyRuns14d >= Math.max(2, Math.floor(dailyWindow.totalRuns14d * 0.8))
    && Number(daysBetween(dailyWindow.latestRunDate || toIsoDate(latestDailyRun.runDate), nowDate) || 99) <= 2
  );

  const strategyTotal = Math.max(0, Number(strategyCoverage.sampleSize30d || recommendationSummary.sampleSize30d || evidenceCounts.totalEvidenceCount));
  const strategyLive = Math.max(0, Number(strategyCoverage.liveSampleSize || recommendationSummary?.sourceBreakdown?.live || evidenceCounts.liveEvidenceCount));

  const regimeTotal = Math.max(0, Number(regimeSourceBreakdown.total || recommendationSummary?.sourceBreakdown?.total || evidenceCounts.totalEvidenceCount));
  const regimeLive = Math.max(0, Number(regimeSourceBreakdown.live || recommendationSummary?.sourceBreakdown?.live || 0));

  const persistenceTotal = Math.max(0, Number(persistenceQuality.recentWindowDays || evidenceCounts.totalEvidenceCount));
  const persistenceLive = Math.max(0, Number(persistenceQuality.currentRegimeLiveCapturedTenureDays || 0));
  const persistencePolicy = toText(persistenceTrustOverride.confidencePolicy || persistenceCoverage.confidencePolicy || 'suppress_confidence').toLowerCase() || 'suppress_confidence';

  const strategyModule = buildModuleReadiness({
    name: 'strategyModule',
    enoughEvidence: strategyCoverage.enoughEvidence === true,
    totalEvidenceCount: strategyTotal,
    liveEvidenceCount: strategyLive,
    liveGrowthDirection: growth.liveEvidenceGrowthDirection,
    dailyScoringConsistent: dailyConsistent,
  });

  const regimeModule = buildModuleReadiness({
    name: 'regimeModule',
    enoughEvidence: regimeCoverage.enoughEvidence === true,
    totalEvidenceCount: regimeTotal,
    liveEvidenceCount: regimeLive,
    liveGrowthDirection: growth.liveEvidenceGrowthDirection,
    dailyScoringConsistent: dailyConsistent,
    coverageWithProvenance: regimeCoverageWithProvenance,
  });

  const persistenceModule = buildModuleReadiness({
    name: 'persistenceModule',
    enoughEvidence: persistenceCoverage.enoughEvidence === true,
    totalEvidenceCount: persistenceTotal,
    liveEvidenceCount: persistenceLive,
    liveGrowthDirection: growth.liveEvidenceGrowthDirection,
    dailyScoringConsistent: dailyConsistent,
    persistencePolicy,
    currentRegimeLiveCapturedTenureDays: persistenceQuality.currentRegimeLiveCapturedTenureDays,
  });

  const blockers = [];
  const supports = [];

  if (evidenceCounts.liveEvidenceCount < 10) blockers.push('live_sample_too_small');
  if (liveEvidencePct < 35) blockers.push('live_pct_too_low');
  if (evidenceCounts.backfillEvidenceCount > evidenceCounts.liveEvidenceCount) blockers.push('backfill_dominant');
  if (regimeModule.enoughEvidence !== true) blockers.push('regime_provenance_thin');
  if (persistencePolicy === 'suppress_confidence') blockers.push('persistence_still_suppressed');
  if (gapState.unresolvedCount > 0 || Number(databentoStatus?.symbolsStatus?.reduce((acc, row) => acc + (Array.isArray(row?.deferredRanges) ? row.deferredRanges.length : 0), 0) || 0) > 0) {
    blockers.push('databento_recent_gap_present');
  }
  if (evidenceCounts.liveDistinctScoreDates < 5) blockers.push('live_scoring_history_too_short');
  if (topstepWindow.liveSessionDistinctDays < 3) blockers.push('topstep_live_window_too_short');

  if (growth.liveEvidenceGrowthDirection === 'improving') supports.push('live_evidence_growing');
  if (dailyConsistent) supports.push('daily_scoring_consistent');
  if (databentoLive) supports.push('databento_foundation_live');
  if (topstepHealthy) supports.push('topstep_live_healthy');
  if (
    toText(persistenceTrustOverrideDelta.deltaDirection || '').toLowerCase() === 'improving'
    || toText(persistenceTrustOverride.overrideLabel || '').toLowerCase() === 'cautious'
    || toText(persistenceTrustOverride.overrideLabel || '').toLowerCase() === 'enabled'
  ) {
    supports.push('persistence_blockers_reducing');
  }
  if (regimeCoverageWithProvenance >= 1) supports.push('regime_provenance_improving');

  const boundedBlockers = uniqueBounded(blockers, ALLOWED_BLOCKERS);
  const boundedSupports = uniqueBounded(supports, ALLOWED_SUPPORTS);

  const evidenceDepthLabel = normalizeDepthLabel(
    classifyDepthLabel(evidenceCounts.liveEvidenceCount, liveEvidencePct)
  );
  const evidenceFreshnessLabel = normalizeFreshnessLabel(
    classifyFreshnessLabel(
      evidenceCounts.lastLiveScoreDate,
      nowDate,
      evidenceCounts.liveEvidence7d,
      evidenceCounts.liveEvidence14d,
      evidenceCounts.liveEvidence30d
    )
  );
  const evidenceReliabilityLabel = normalizeReliabilityLabel(
    classifyReliabilityLabel({
      evidenceDepthLabel,
      liveEvidencePct,
      blockers: boundedBlockers,
      liveEvidenceGrowthDirection: growth.liveEvidenceGrowthDirection,
    })
  );

  const intelligenceReadinessLabel = normalizeIntelligenceReadinessLabel(
    classifyIntelligenceReadinessLabel({
      evidenceDepthLabel,
      evidenceReliabilityLabel,
      strategyModule,
      regimeModule,
      persistenceModule,
      liveEvidenceGrowthDirection: growth.liveEvidenceGrowthDirection,
    })
  );

  const highestBlocker = boundedBlockers[0] || null;
  const moduleReadiness = {
    strategyModule,
    regimeModule,
    persistenceModule,
  };

  const liveEvidenceSummary = `${evidenceCounts.liveEvidenceCount}/${evidenceCounts.totalEvidenceCount} live (${liveEvidencePct}%)`;
  const warnings = [];
  if (boundedBlockers.includes('databento_recent_gap_present')) warnings.push('databento_recent_gap_present');
  if (boundedBlockers.includes('topstep_live_window_too_short')) warnings.push('topstep_live_window_too_short');
  if (boundedBlockers.includes('live_sample_too_small')) warnings.push('live_sample_too_small');

  const summary = {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    totalEvidenceCount: evidenceCounts.totalEvidenceCount,
    liveEvidenceCount: evidenceCounts.liveEvidenceCount,
    backfillEvidenceCount: evidenceCounts.backfillEvidenceCount,
    liveEvidencePct,
    backfillEvidencePct,
    liveEvidence7d: evidenceCounts.liveEvidence7d,
    liveEvidence14d: evidenceCounts.liveEvidence14d,
    liveEvidence30d: evidenceCounts.liveEvidence30d,
    liveEvidenceGrowthDirection: growth.liveEvidenceGrowthDirection,
    liveEvidenceGrowthRatePct: growth.liveEvidenceGrowthRatePct,
    strategyModule,
    regimeModule,
    persistenceModule,
    moduleReadiness,
    evidenceDepthLabel,
    evidenceFreshnessLabel,
    evidenceReliabilityLabel,
    intelligenceReadinessLabel,
    highestBlocker,
    blockers: boundedBlockers,
    supports: boundedSupports,
    liveEvidenceSummary,
    liveEvidenceInsight: '',
    warnings,
    advisoryOnly: true,
  };

  summary.liveEvidenceInsight = buildInsight(summary);

  return summary;
}

module.exports = {
  buildLiveEvidenceAccumulationSummary,
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  ALLOWED_EVIDENCE_DEPTH_LABELS,
  ALLOWED_EVIDENCE_FRESHNESS_LABELS,
  ALLOWED_EVIDENCE_RELIABILITY_LABELS,
  ALLOWED_INTELLIGENCE_READINESS_LABELS,
  ALLOWED_GROWTH_DIRECTIONS,
  ALLOWED_BLOCKERS,
  ALLOWED_SUPPORTS,
};
