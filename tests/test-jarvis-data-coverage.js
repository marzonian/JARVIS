#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  ensureDataFoundationTables,
} = require('../server/jarvis-core/data-foundation-storage');
const {
  buildDataCoverageSummary,
} = require('../server/jarvis-core/data-coverage');

const TIMEOUT_MS = 240000;

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  return db;
}

function insertBar(db, symbol, tsEvent, open = 100, high = 101, low = 99, close = 100.5) {
  db.prepare(`
    INSERT INTO jarvis_market_bars_raw (
      provider, dataset, schema_name, stype_in, symbol, ts_event,
      open, high, low, close, volume, raw_json, source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'databento',
    'GLBX.MDP3',
    'ohlcv-1m',
    'continuous',
    symbol,
    tsEvent,
    open,
    high,
    low,
    close,
    1000,
    '{}',
    'historical'
  );
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

function assertCoverageContract(coverage) {
  assert(coverage && typeof coverage === 'object', 'coverage payload missing');
  assert(coverage.advisoryOnly === true, 'coverage must be advisoryOnly');
  assert(coverage.coverageWindow && typeof coverage.coverageWindow === 'object', 'coverageWindow missing');
  assert(coverage.historicalDates && typeof coverage.historicalDates === 'object', 'historicalDates missing');
  assert(Array.isArray(coverage.symbolsCovered), 'symbolsCovered missing');
  assert(Array.isArray(coverage.missingDateRanges), 'missingDateRanges missing');
  assert(coverage.liveFeeds && typeof coverage.liveFeeds === 'object', 'liveFeeds missing');
  assert(coverage.evidenceReadiness && typeof coverage.evidenceReadiness === 'object', 'evidenceReadiness missing');
  assert(typeof coverage.dataCoverageInsight === 'string' && coverage.dataCoverageInsight.length > 0, 'dataCoverageInsight missing');
}

async function runUnitChecks() {
  const db = makeDb();

  insertBar(db, 'MNQ.c.0', '2026-02-02T14:30:00.000Z');
  insertBar(db, 'MNQ.c.0', '2026-02-04T14:30:00.000Z');
  insertBar(db, 'MES.c.0', '2026-02-02T14:30:00.000Z');
  insertBar(db, 'MES.c.0', '2026-02-04T14:30:00.000Z');

  const coverage = buildDataCoverageSummary({
    db,
    nowDate: '2026-02-05',
    startDate: '2026-02-02',
    endDate: '2026-02-05',
    lookbackDays: 10,
    symbols: ['MNQ.c.0', 'MES.c.0'],
    topstepAudit: {
      keyStatus: 'missing',
      authStatus: 'failure',
      currentLiveFeedStatus: 'error',
      lastSuccessfulFetchAt: null,
      lastErrorMessage: 'topstep_api_key_missing',
    },
    recommendationPerformanceSummary: {
      sampleSize30d: 12,
      sourceBreakdown: { live: 3, backfill: 9, total: 12 },
    },
    regimePerformanceFeedback: {
      dataQuality: {
        isThinSample: true,
        coverage: { withProvenance: 1 },
      },
    },
    regimePersistenceTrustOverride: {
      confidencePolicy: 'suppress_confidence',
      overrideLabel: 'suppressed',
    },
  });

  assertCoverageContract(coverage);
  assert(Array.isArray(coverage.symbolsCovered) && coverage.symbolsCovered.length === 2, 'expected 2 symbol coverage rows');
  assert(coverage.historicalDates.firstDate === '2026-02-02', 'first historical date should be detected');
  assert(coverage.historicalDates.lastDate === '2026-02-04', 'last historical date should be detected');
  assert(coverage.missingDateRanges.length > 0, 'missingDateRanges should detect missing weekdays');
  assert(coverage.warnings.includes('historical_gaps_detected'), 'gap warning expected');
  assert(coverage.warnings.includes('topstep_key_missing'), 'topstep key warning expected');
  assert(coverage.evidenceReadiness.strategyModule && typeof coverage.evidenceReadiness.strategyModule === 'object', 'strategy evidence readiness missing');
  assert(coverage.evidenceReadiness.regimeModule && typeof coverage.evidenceReadiness.regimeModule === 'object', 'regime evidence readiness missing');
  assert(coverage.evidenceReadiness.persistenceModule && typeof coverage.evidenceReadiness.persistenceModule === 'object', 'persistence evidence readiness missing');

  db.close();
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3209,
    env: {
      DATABENTO_AUTO_INGEST_ENABLED: 'false',
    },
  });

  try {
    const coverageOut = await getJson(server.baseUrl, '/api/jarvis/data/coverage?force=1&lookbackDays=120');
    assert(coverageOut?.status === 'ok', 'data coverage endpoint should return ok');
    assertCoverageContract(coverageOut?.dataCoverage);

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command-center endpoint should return ok');
    assert(centerOut?.dataCoverage && typeof centerOut.dataCoverage === 'object', 'top-level dataCoverage missing from command-center response');

    const cc = centerOut?.commandCenter || {};
    assert(typeof cc.dataCoverageInsight === 'string' && cc.dataCoverageInsight.length > 0, 'commandCenter.dataCoverageInsight missing');
    assert(cc.dataCoverageStatus && typeof cc.dataCoverageStatus === 'object', 'commandCenter.dataCoverageStatus missing');
    assert(Array.isArray(cc.dataMissingRanges), 'commandCenter.dataMissingRanges missing');
    assert(typeof cc.liveFeedStatus === 'string' && cc.liveFeedStatus.length > 0, 'commandCenter.liveFeedStatus missing');
    assert(cc.evidenceReadiness && typeof cc.evidenceReadiness === 'object', 'commandCenter.evidenceReadiness missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    await runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ data coverage checks passed');
  } catch (err) {
    console.error('❌ data coverage checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
