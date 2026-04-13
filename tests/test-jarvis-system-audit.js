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
  buildSystemAuditSummary,
} = require('../server/jarvis-core/system-audit');

const TIMEOUT_MS = 240000;

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  return db;
}

function insertFoundationRows(db) {
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
    'MNQ.c.0',
    '2026-03-07T14:30:00.000Z',
    100,
    101,
    99,
    100.5,
    1000,
    '{}',
    'historical'
  );
  db.prepare(`
    INSERT INTO jarvis_daily_scoring_runs (
      run_date, mode, window_days, contexts_seen, scored_rows, inserted_rows, updated_rows, status, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('2026-03-07', 'test', 3, 4, 4, 2, 2, 'ok', '{}');
  db.prepare(`
    INSERT INTO jarvis_scored_trade_outcomes (
      score_date, source_type, reconstruction_phase, recommendation_json, outcome_json, score_label
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('2026-03-07', 'live', 'live_intraday', '{}', '{}', 'win');
  db.prepare(`
    INSERT INTO jarvis_databento_ingestion_runs (
      provider, mode, dataset, schema_name, stype_in, symbol, range_start, range_end,
      rows_fetched, rows_inserted, missing_ranges_json, status, details_json, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'databento',
    'auto',
    'GLBX.MDP3',
    'ohlcv-1m',
    'continuous',
    'MNQ.c.0',
    '2026-03-07',
    '2026-03-07',
    1,
    1,
    '[]',
    'ok',
    '{}',
    '2026-03-07T18:00:00.000Z',
    '2026-03-07T18:00:02.000Z'
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

function assertSystemAuditContract(audit) {
  assert(audit && typeof audit === 'object', 'jarvisSystemAudit payload missing');
  assert(audit.advisoryOnly === true, 'jarvisSystemAudit must be advisoryOnly');
  assert(Array.isArray(audit.providerInventory), 'providerInventory missing');
  assert(audit.providerInventory.length >= 6, 'providerInventory should include foundation providers');
  assert(audit.providerSummary && typeof audit.providerSummary === 'object', 'providerSummary missing');
  assert(audit.dataFoundationState && typeof audit.dataFoundationState === 'object', 'dataFoundationState missing');
  assert(audit.evidenceReadiness && typeof audit.evidenceReadiness === 'object', 'evidenceReadiness missing');
  assert(audit.evidenceReadinessSnapshot && typeof audit.evidenceReadinessSnapshot === 'object', 'evidenceReadinessSnapshot missing');
  assert(Array.isArray(audit.majorBlockers), 'majorBlockers missing');
  const providerNames = new Set(audit.providerInventory.map((p) => String(p.providerName || '')));
  for (const required of ['OpenAI', 'Anthropic', 'Databento', 'Topstep', 'Discord', 'News Calendar Feed']) {
    assert(providerNames.has(required), `providerInventory missing ${required}`);
  }
  for (const provider of audit.providerInventory) {
    assert(typeof provider.keyPresent === 'boolean', `provider.keyPresent missing for ${provider.providerName}`);
    assert(typeof provider.loadedFrom === 'string' && provider.loadedFrom.length > 0, `provider.loadedFrom missing for ${provider.providerName}`);
    assert(typeof provider.validationAttempted === 'boolean', `provider.validationAttempted missing for ${provider.providerName}`);
    assert(['working', 'failing', 'missing', 'unknown'].includes(String(provider.validationResult || '')), `provider.validationResult invalid for ${provider.providerName}`);
    assert(Object.prototype.hasOwnProperty.call(provider, 'lastValidationTimestamp'), `provider.lastValidationTimestamp missing for ${provider.providerName}`);
    assert(typeof provider.purposeInJarvis === 'string' || provider.purposeInJarvis === null, `provider.purposeInJarvis missing for ${provider.providerName}`);
    assert(typeof provider.systemImpactIfMissing === 'string' || provider.systemImpactIfMissing === null, `provider.systemImpactIfMissing missing for ${provider.providerName}`);
  }
}

async function runUnitChecks() {
  const db = makeDb();
  insertFoundationRows(db);

  const summary = buildSystemAuditSummary({
    db,
    config: {
      anthropicKey: 'present',
      databento: { api: { key: 'present' } },
      topstep: { api: { key: 'present' } },
      discord: { botToken: 'present' },
      news: { enabled: true, calendarUrl: 'https://example.com/calendar.xml' },
    },
    openaiKeyPresent: true,
    envPresence: {
      OPENAI_API_KEY: true,
      ANTHROPIC_API_KEY: false,
      DATABENTO_API_KEY: false,
      TOPSTEP_API_KEY: false,
      DISCORD_BOT_TOKEN: true,
      NEWS_CALENDAR_URL: true,
    },
    topstepIntegrationAudit: {
      authStatus: 'success',
      currentLiveFeedStatus: 'healthy',
      lastSuccessfulFetchAt: '2026-03-07T18:10:00.000Z',
      isFailureActive: false,
      historicalFailureRetained: false,
    },
    databentoIngestionStatus: {
      latestRuns: [{ status: 'ok', createdAt: '2026-03-07T18:11:00.000Z' }],
      warnings: [],
    },
    dailyEvidenceScoringStatus: {
      latestRun: {
        status: 'ok',
        runDate: '2026-03-07',
        createdAt: '2026-03-07T20:30:00.000Z',
        scoredRows: 4,
      },
    },
    dataCoverage: {
      symbols: ['MNQ.c.0'],
      missingDateRanges: [],
      warnings: [],
      evidenceReadiness: {
        strategyModule: { enoughEvidence: true, sampleSize30d: 40, liveSampleSize: 10 },
        regimeModule: { enoughEvidence: true, coverageWithProvenance: 4, thinSample: false },
        persistenceModule: { enoughEvidence: false, confidencePolicy: 'suppress_confidence', overrideLabel: 'suppressed' },
      },
    },
    discordRuntime: {
      connected: true,
      ready: true,
      lastReadyAt: '2026-03-07T20:00:00.000Z',
    },
    discordReady: true,
    newsValidation: {
      attempted: true,
      result: 'working',
      lastSuccessfulValidationAt: '2026-03-07T19:40:00.000Z',
    },
  });

  assertSystemAuditContract(summary);
  assert(typeof summary.highestPriorityBlocker === 'string' || summary.highestPriorityBlocker === null, 'highestPriorityBlocker missing');
  db.close();
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3211,
  });

  try {
    const auditOut = await getJson(server.baseUrl, '/api/jarvis/system/audit?force=1');
    assert(auditOut?.status === 'ok', 'system audit endpoint should return ok');
    assertSystemAuditContract(auditOut?.jarvisSystemAudit);

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command-center endpoint should return ok');
    assert(centerOut?.jarvisSystemAudit && typeof centerOut.jarvisSystemAudit === 'object', 'top-level jarvisSystemAudit missing from command-center response');
    const cc = centerOut?.commandCenter || {};
    assert(cc.systemAuditSummary && typeof cc.systemAuditSummary === 'object', 'commandCenter.systemAuditSummary missing');
    assert(Array.isArray(cc.systemAuditHealthyProviders), 'commandCenter.systemAuditHealthyProviders missing');
    assert(Object.prototype.hasOwnProperty.call(cc, 'systemAuditHighestPriorityBlocker'), 'commandCenter.systemAuditHighestPriorityBlocker missing');
    assert(typeof cc.systemAuditInsight === 'string' && cc.systemAuditInsight.length > 0, 'commandCenter.systemAuditInsight missing');
    assert(cc.systemAuditSummary.keysPresent && typeof cc.systemAuditSummary.keysPresent === 'object', 'commandCenter.systemAuditSummary.keysPresent missing');
    assert(Object.prototype.hasOwnProperty.call(cc.systemAuditSummary, 'databentoIngestionLive'), 'commandCenter.systemAuditSummary.databentoIngestionLive missing');
    assert(Object.prototype.hasOwnProperty.call(cc.systemAuditSummary, 'topstepLiveHealthy'), 'commandCenter.systemAuditSummary.topstepLiveHealthy missing');
    assert(Object.prototype.hasOwnProperty.call(cc.systemAuditSummary, 'dailyScoringRunning'), 'commandCenter.systemAuditSummary.dailyScoringRunning missing');
    assert(Object.prototype.hasOwnProperty.call(cc.systemAuditSummary, 'evidenceStillThin'), 'commandCenter.systemAuditSummary.evidenceStillThin missing');
    assert(Object.prototype.hasOwnProperty.call(cc.systemAuditSummary, 'highestPriorityBlocker'), 'commandCenter.systemAuditSummary.highestPriorityBlocker missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    await runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ jarvis system audit checks passed');
  } catch (err) {
    console.error('❌ jarvis system audit checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
