'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  toNumber,
  toText,
} = require('./data-foundation-storage');

const DEFAULT_LOOKBACK_DAYS = 120;

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

function toUtcMs(isoDate = '') {
  const normalized = normalizeDate(isoDate);
  if (!normalized) return null;
  const parts = normalized.split('-').map((n) => Number(n));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function addDays(isoDate = '', days = 0) {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (Math.round(Number(days || 0)) * 86400000)).toISOString().slice(0, 10);
}

function compareIsoDate(a = '', b = '') {
  const left = normalizeDate(a);
  const right = normalizeDate(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function enumerateWeekdays(startDate = '', endDate = '') {
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  if (!start || !end || compareIsoDate(start, end) > 0) return [];
  const out = [];
  let cursor = start;
  let guard = 0;
  while (cursor && compareIsoDate(cursor, end) <= 0 && guard < 2000) {
    const ms = toUtcMs(cursor);
    if (Number.isFinite(ms)) {
      const day = new Date(ms).getUTCDay();
      if (day >= 1 && day <= 5) out.push(cursor);
    }
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}

function collapseDateRanges(dates = []) {
  const sorted = Array.from(new Set((Array.isArray(dates) ? dates : []).map((d) => normalizeDate(d)).filter(Boolean))).sort();
  const out = [];
  let start = null;
  let prev = null;
  for (const d of sorted) {
    if (!start) {
      start = d;
      prev = d;
      continue;
    }
    const next = addDays(prev, 1);
    if (next && compareIsoDate(d, next) === 0) {
      prev = d;
      continue;
    }
    out.push({ startDate: start, endDate: prev });
    start = d;
    prev = d;
  }
  if (start) out.push({ startDate: start, endDate: prev || start });
  return out;
}

function normalizeSymbols(input) {
  if (Array.isArray(input)) return input.map((s) => toText(s)).filter(Boolean);
  const txt = toText(input);
  if (!txt) return [];
  return txt.split(',').map((s) => toText(s)).filter(Boolean);
}

function computeSymbolCoverage(db, symbol, input = {}) {
  const provider = toText(input.provider || 'databento');
  const dataset = toText(input.dataset || 'GLBX.MDP3');
  const schemaName = toText(input.schemaName || 'ohlcv-1m');
  const row = db.prepare(`
    SELECT
      MIN(substr(ts_event, 1, 10)) AS first_date,
      MAX(substr(ts_event, 1, 10)) AS last_date,
      COUNT(*) AS bar_count
    FROM jarvis_market_bars_raw
    WHERE provider = ? AND dataset = ? AND schema_name = ? AND symbol = ?
  `).get(provider, dataset, schemaName, symbol) || {};
  const byDate = db.prepare(`
    SELECT
      substr(ts_event, 1, 10) AS d,
      COUNT(*) AS bars
    FROM jarvis_market_bars_raw
    WHERE provider = ? AND dataset = ? AND schema_name = ? AND symbol = ?
    GROUP BY substr(ts_event, 1, 10)
    ORDER BY d ASC
  `).all(provider, dataset, schemaName, symbol);
  const coveredDates = byDate.map((r) => normalizeDate(r.d)).filter(Boolean);
  return {
    symbol,
    firstDate: normalizeDate(row.first_date),
    lastDate: normalizeDate(row.last_date),
    totalBars: Number(row.bar_count || 0),
    coveredDates,
    coveredDateCount: coveredDates.length,
  };
}

function computeMissingRanges(coveredDates = [], startDate = '', endDate = '') {
  const expected = enumerateWeekdays(startDate, endDate);
  const coveredSet = new Set((Array.isArray(coveredDates) ? coveredDates : []).map((d) => normalizeDate(d)).filter(Boolean));
  const missing = expected.filter((d) => !coveredSet.has(d));
  return collapseDateRanges(missing);
}

function summarizeEvidenceReadiness(input = {}) {
  const recommendationSummary = input.recommendationPerformanceSummary && typeof input.recommendationPerformanceSummary === 'object'
    ? input.recommendationPerformanceSummary
    : {};
  const regimeFeedback = input.regimePerformanceFeedback && typeof input.regimePerformanceFeedback === 'object'
    ? input.regimePerformanceFeedback
    : {};
  const trustOverride = input.regimePersistenceTrustOverride && typeof input.regimePersistenceTrustOverride === 'object'
    ? input.regimePersistenceTrustOverride
    : {};

  const strategySample = Number(recommendationSummary.sampleSize30d || 0);
  const liveSample = Number(recommendationSummary?.sourceBreakdown?.live || 0);
  const regimeCoverageWithProvenance = Number(regimeFeedback?.dataQuality?.coverage?.withProvenance || 0);
  const regimeThin = regimeFeedback?.dataQuality?.isThinSample === true;
  const persistencePolicy = toText(trustOverride.confidencePolicy || '');
  const persistenceEnabled = persistencePolicy === 'allow_structured_confidence';

  return {
    strategyModule: {
      enoughEvidence: strategySample >= 30,
      sampleSize30d: strategySample,
      liveSampleSize: liveSample,
    },
    regimeModule: {
      enoughEvidence: regimeCoverageWithProvenance >= 3 && !regimeThin,
      coverageWithProvenance: regimeCoverageWithProvenance,
      thinSample: regimeThin,
    },
    persistenceModule: {
      enoughEvidence: persistenceEnabled,
      confidencePolicy: persistencePolicy || 'suppress_confidence',
      overrideLabel: toText(trustOverride.overrideLabel || '') || 'suppressed',
    },
  };
}

function buildCoverageInsight(input = {}) {
  const symbols = Array.isArray(input.symbols) ? input.symbols : [];
  const liveFeedStatus = toText(input.liveFeedStatus || 'unknown').toLowerCase();
  const evidence = input.evidenceReadiness && typeof input.evidenceReadiness === 'object'
    ? input.evidenceReadiness
    : {};
  const weakModules = [];
  if (evidence?.strategyModule?.enoughEvidence !== true) weakModules.push('strategy');
  if (evidence?.regimeModule?.enoughEvidence !== true) weakModules.push('regime');
  if (evidence?.persistenceModule?.enoughEvidence !== true) weakModules.push('persistence');
  const symbolsPart = symbols.length > 0
    ? `${symbols.length} symbol${symbols.length === 1 ? '' : 's'} covered`
    : 'no symbols covered';
  const missingPart = Number(input.missingRangesCount || 0) > 0
    ? `${Number(input.missingRangesCount || 0)} missing range${Number(input.missingRangesCount || 0) === 1 ? '' : 's'} detected`
    : 'no missing weekday ranges detected';
  const modulePart = weakModules.length > 0
    ? `${weakModules.join(', ')} evidence still thin`
    : 'strategy/regime evidence thresholds satisfied';
  return `${symbolsPart}; ${missingPart}; live feed ${liveFeedStatus || 'unknown'}; ${modulePart}.`;
}

function buildDataCoverageSummary(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'error',
      error: 'db_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDataFoundationTables(db);
  const nowDate = normalizeDate(input.nowDate || new Date().toISOString());
  const lookbackDays = clampInt(input.lookbackDays, 20, 720, DEFAULT_LOOKBACK_DAYS);
  const startDate = normalizeDate(input.startDate || addDays(nowDate, -(lookbackDays - 1)) || nowDate);
  const endDate = normalizeDate(input.endDate || nowDate);
  const requestedSymbols = normalizeSymbols(input.symbols || input.symbol);
  const storedSymbols = db.prepare(`
    SELECT DISTINCT symbol
    FROM jarvis_market_bars_raw
    ORDER BY symbol ASC
  `).all().map((r) => toText(r.symbol)).filter(Boolean);
  const symbols = requestedSymbols.length > 0
    ? requestedSymbols
    : (storedSymbols.length > 0 ? storedSymbols : ['MNQ.c.0', 'MES.c.0']);

  const rows = symbols.map((symbol) => {
    const coverage = computeSymbolCoverage(db, symbol, input);
    const missingDateRanges = computeMissingRanges(coverage.coveredDates, startDate, endDate);
    return {
      symbol,
      firstDate: coverage.firstDate || null,
      lastDate: coverage.lastDate || null,
      totalBars: coverage.totalBars,
      coveredDateCount: coverage.coveredDateCount,
      missingDateRanges,
      missingDateCount: missingDateRanges.reduce((acc, range) => {
        const s = toUtcMs(range.startDate);
        const e = toUtcMs(range.endDate);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return acc;
        return acc + (Math.round((e - s) / 86400000) + 1);
      }, 0),
      advisoryOnly: true,
    };
  });

  const allMissing = [];
  for (const row of rows) {
    for (const range of row.missingDateRanges) allMissing.push(range.startDate);
  }
  const missingRangesCollapsed = collapseDateRanges(allMissing);

  const dateRow = db.prepare(`
    SELECT
      MIN(substr(ts_event, 1, 10)) AS first_date,
      MAX(substr(ts_event, 1, 10)) AS last_date,
      COUNT(DISTINCT substr(ts_event, 1, 10)) AS distinct_dates,
      COUNT(*) AS total_bars
    FROM jarvis_market_bars_raw
  `).get() || {};

  const latestLiveRow = db.prepare(`
    SELECT source, symbol, snapshot_at, feed_status
    FROM jarvis_live_session_data
    ORDER BY id DESC
    LIMIT 1
  `).get() || null;

  const topstepAudit = input.topstepAudit && typeof input.topstepAudit === 'object'
    ? input.topstepAudit
    : {};
  const liveFeeds = {
    topstep: {
      keyStatus: toText(topstepAudit.keyStatus || '') || 'unknown',
      authStatus: toText(topstepAudit.authStatus || '') || 'unknown',
      lastSuccessfulFetchAt: toText(topstepAudit.lastSuccessfulFetchAt || '') || null,
      currentLiveFeedStatus: toText(topstepAudit.currentLiveFeedStatus || '') || 'unknown',
      lastErrorMessage: toText(topstepAudit.lastErrorMessage || '') || null,
      active: toText(topstepAudit.currentLiveFeedStatus || '').toLowerCase() === 'healthy',
    },
    latestPersistedLiveSnapshot: latestLiveRow ? {
      source: toText(latestLiveRow.source || ''),
      symbol: toText(latestLiveRow.symbol || '') || null,
      snapshotAt: toText(latestLiveRow.snapshot_at || '') || null,
      feedStatus: toText(latestLiveRow.feed_status || '') || null,
    } : null,
  };

  const evidenceReadiness = summarizeEvidenceReadiness({
    recommendationPerformanceSummary: input.recommendationPerformanceSummary,
    regimePerformanceFeedback: input.regimePerformanceFeedback,
    regimePersistenceTrustOverride: input.regimePersistenceTrustOverride,
  });
  const insight = buildCoverageInsight({
    symbols: rows,
    missingRangesCount: missingRangesCollapsed.length,
    liveFeedStatus: liveFeeds?.topstep?.currentLiveFeedStatus || 'unknown',
    evidenceReadiness,
  });

  const warnings = [];
  if (rows.every((r) => Number(r.totalBars || 0) === 0)) warnings.push('no_historical_bars');
  if (missingRangesCollapsed.length > 0) warnings.push('historical_gaps_detected');
  if (liveFeeds.topstep.keyStatus === 'missing') warnings.push('topstep_key_missing');
  if (liveFeeds.topstep.authStatus === 'failure') warnings.push('topstep_auth_failure');
  if (liveFeeds.topstep.currentLiveFeedStatus === 'error' || liveFeeds.topstep.currentLiveFeedStatus === 'stale') {
    warnings.push('topstep_live_feed_unhealthy');
  }

  return {
    generatedAt: new Date().toISOString(),
    coverageWindow: {
      startDate,
      endDate,
      lookbackDays,
    },
    historicalDates: {
      firstDate: normalizeDate(dateRow.first_date) || null,
      lastDate: normalizeDate(dateRow.last_date) || null,
      distinctDates: Number(dateRow.distinct_dates || 0),
      totalBars: Number(dateRow.total_bars || 0),
    },
    symbolsCovered: rows,
    symbols: rows.map((r) => r.symbol),
    missingDateRanges: missingRangesCollapsed,
    liveFeeds,
    evidenceReadiness,
    dataCoverageInsight: insight,
    warnings,
    advisoryOnly: true,
  };
}

module.exports = {
  buildDataCoverageSummary,
};
