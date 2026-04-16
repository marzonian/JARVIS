#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  buildTopstepIntegrationAuditSummary,
} = require('../server/jarvis-core/topstep-integration-audit');

const TIMEOUT_MS = 180000;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS topstep_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT,
      error_message TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertSyncRun(db, status, errorMessage = null, createdAt = null, detailsJson = null) {
  db.prepare(`
    INSERT INTO topstep_sync_runs (status, error_message, details_json, created_at)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')))
  `).run(status, errorMessage, detailsJson, createdAt);
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertAuditContract(audit) {
  assert(audit && typeof audit === 'object', 'audit payload missing');
  assert(['present', 'missing'].includes(String(audit.keyStatus || '')), `invalid keyStatus: ${audit.keyStatus}`);
  assert(['success', 'failure', 'unknown', 'missing_key'].includes(String(audit.authStatus || '')), `invalid authStatus: ${audit.authStatus}`);
  assert(['healthy', 'degraded', 'error', 'stale', 'disabled', 'unknown', 'never_synced'].includes(String(audit.currentLiveFeedStatus || '')), `invalid currentLiveFeedStatus: ${audit.currentLiveFeedStatus}`);
  assert(Object.prototype.hasOwnProperty.call(audit, 'lastSuccessfulFetchAt'), 'lastSuccessfulFetchAt missing');
  assert(Object.prototype.hasOwnProperty.call(audit, 'lastErrorMessage'), 'lastErrorMessage missing');
  assert(Object.prototype.hasOwnProperty.call(audit, 'lastFailureMessage'), 'lastFailureMessage missing');
  assert(Object.prototype.hasOwnProperty.call(audit, 'lastFailureAt'), 'lastFailureAt missing');
  assert(typeof audit.isFailureActive === 'boolean', 'isFailureActive missing');
  assert(typeof audit.historicalFailureRetained === 'boolean', 'historicalFailureRetained missing');
  assert(typeof String(audit.failureClass || '') === 'string', 'failureClass missing');
  assert(audit.recoveryWindow && typeof audit.recoveryWindow === 'object', 'recoveryWindow missing');
  assert(audit.recoveryChecklist && typeof audit.recoveryChecklist === 'object', 'recoveryChecklist missing');
  assert(Array.isArray(audit.recoveryChecklist.rerunJobs), 'recoveryChecklist.rerunJobs missing');
  assert(Array.isArray(audit.recoveryChecklist.mustFix), 'recoveryChecklist.mustFix missing');
  assert(audit.advisoryOnly === true, 'audit must be advisoryOnly');
}

async function runUnitChecks() {
  {
    const db = makeDb();
    insertSyncRun(db, 'error', 'auth_failed', '2026-03-08 15:30:00');
    const audit = buildTopstepIntegrationAuditSummary({
      db,
      apiKey: '',
      hasAuthToken: false,
      syncWatch: {
        consecutiveFailures: 2,
        lastFailureAt: '2026-03-08T15:31:00Z',
        lastFailureReason: 'auth_failed',
      },
    });
    assertAuditContract(audit);
    assert(audit.keyStatus === 'missing', 'missing key should be reported');
    assert(audit.authStatus === 'missing_key', 'missing key should force missing_key authStatus');
    assert(audit.lastErrorMessage, 'error message should be populated from failed sync');
    db.close();
  }

  {
    const db = makeDb();
    insertSyncRun(db, 'error', 'commandCenter is not defined', '2026-03-07 15:30:00');
    insertSyncRun(db, 'ok', null, null);
    const audit = buildTopstepIntegrationAuditSummary({
      db,
      apiKey: 'topstep_test_key',
      hasAuthToken: true,
      syncWatch: {
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureReason: null,
      },
    });
    assertAuditContract(audit);
    assert(audit.keyStatus === 'present', 'key should be marked present');
    assert(audit.authStatus === 'success', 'recent successful sync should mark auth success');
    assert(['healthy', 'stale', 'degraded'].includes(String(audit.currentLiveFeedStatus || '')), 'success path should produce non-error live status');
    assert(audit.lastErrorMessage === null, 'stale historical failure should not appear as current lastErrorMessage');
    assert(String(audit.lastFailureMessage || '').length > 0, 'historical failure should remain in lastFailureMessage');
    assert(audit.isFailureActive === false, 'historical failure should not be marked active');
    assert(audit.historicalFailureRetained === true, 'historical failure should be marked as retained');
    db.close();
  }

  {
    const audit = buildTopstepIntegrationAuditSummary({
      db: null,
      apiKey: '',
    });
    assertAuditContract(audit);
    assert(audit.currentLiveFeedStatus === 'error', 'db unavailable should surface error feed status');
  }

  {
    const db = makeDb();
    insertSyncRun(db, 'error', 'accounts_fetch_failed:http_401', '2026-03-08 16:00:00');
    const audit = buildTopstepIntegrationAuditSummary({
      db,
      apiKey: 'topstep_test_key',
      hasAuthToken: false,
      liveSnapshot: {
        sync: {
          status: 'error',
          errorMessage: 'accounts_fetch_failed:http_401',
          details: {
            authError: 'auth_error:invalid_credentials',
            accountFetchError: 'http_401',
          },
        },
      },
      credentialDiagnostics: {
        validation: { hardIssues: [], warnings: ['runtime_env_mismatch_restart_required'] },
        runtimeVsEnvFile: { likelyStaleRuntime: true },
      },
    });
    assertAuditContract(audit);
    assert(audit.failureClass === 'runtime_stale_config', 'runtime mismatch should classify as runtime_stale_config');
    assert(String(audit.failureReason || '').includes('Runtime Topstep credentials do not match'), 'runtime mismatch reason missing');
    assert(Array.isArray(audit.recoveryChecklist.mustFix), 'mustFix checklist missing');
    db.close();
  }

  {
    const db = makeDb();
    const audit = buildTopstepIntegrationAuditSummary({
      db,
      apiEnabled: false,
      apiConfigured: true,
      apiDisableReason: 'topstep_disabled_by_config',
      apiKey: 'topstep_test_key',
      hasAuthToken: false,
    });
    assertAuditContract(audit);
    assert(audit.currentLiveFeedStatus === 'disabled', 'disabled config should surface disabled feed status');
    assert(audit.runtimeConfig && audit.runtimeConfig.apiEnabled === false, 'runtimeConfig.apiEnabled should be false');
    assert(audit.runtimeConfig.apiDisableReason === 'topstep_disabled_by_config', 'disabled reason should be preserved');
    db.close();
  }
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3207,
    env: {
      TOPSTEP_API_ENABLED: 'true',
      TOPSTEP_API_KEY: '',
    },
  });

  try {
    const out = await getJson(server.baseUrl, '/api/topstep/live/audit?force=1');
    assert(out?.status === 'ok', 'topstep live audit endpoint should return ok');
    assertAuditContract(out?.topstepIntegrationAudit);
    assert(out?.runtimeConfig && typeof out.runtimeConfig === 'object', 'runtimeConfig should be surfaced on live audit endpoint');
    assert(typeof out.runtimeConfig.enabled === 'boolean', 'runtimeConfig.enabled should be boolean');
  } finally {
    await server.stop();
  }
}

async function runStartupStatusChecks() {
  {
    const server = await startAuditServer({
      useExisting: false,
      port: process.env.JARVIS_AUDIT_PORT ? Number(process.env.JARVIS_AUDIT_PORT) + 1 : 3208,
      env: {
        TOPSTEP_API_ENABLED: 'false',
        TOPSTEP_API_KEY: 'topstep_test_key_disabled',
        TOPSTEP_API_USERNAME: 'tester',
      },
    });
    try {
      await wait(900);
      const status = await getJson(server.baseUrl, '/api/topstep/sync/status');
      assert(status?.status === 'ok', 'sync status endpoint should return ok');
      assert(status?.runtimeConfig && typeof status.runtimeConfig === 'object', 'runtimeConfig missing from sync status');
      assert(status.runtimeConfig.enabled === false, 'TOPSTEP_API_ENABLED=false should disable runtime config');
      assert(
        String(status.runtimeConfig.disableReason || '') === 'topstep_disabled_by_config',
        `unexpected disable reason: ${status.runtimeConfig.disableReason}`
      );
      const startupLogs = (server.logs || []).join('');
      assert(
        !startupLogs.includes('[Contract Roll] startup warm-up failed: topstep_api_disabled'),
        'disabled config should not log contract-roll warm-up as failure'
      );
      assert(
        startupLogs.includes('Contract roll warm-up: skipped (topstep_disabled_by_config)'),
        'disabled config should log contract-roll warm-up as skipped'
      );
      assert(
        !startupLogs.includes('Runtime/.env mismatch detected'),
        'legacy mismatch warning should not be emitted'
      );
    } finally {
      await server.stop();
    }
  }

  {
    const server = await startAuditServer({
      useExisting: false,
      port: process.env.JARVIS_AUDIT_PORT ? Number(process.env.JARVIS_AUDIT_PORT) + 2 : 3209,
      env: {
        TOPSTEP_API_ENABLED: 'TRUE',
        TOPSTEP_API_KEY: 'topstep_test_key_enabled',
        TOPSTEP_API_USERNAME: 'tester',
      },
    });
    try {
      await wait(900);
      const status = await getJson(server.baseUrl, '/api/topstep/sync/status');
      assert(status?.runtimeConfig?.enabled === true, 'TOPSTEP_API_ENABLED=TRUE should resolve enabled=true');
      assert(status?.runtimeConfig?.configured === true, 'enabled config should be marked configured');
    } finally {
      await server.stop();
    }
  }
}

(async () => {
  try {
    await runUnitChecks();
    await runIntegrationChecks();
    await runStartupStatusChecks();
    console.log('✅ topstep live audit checks passed');
  } catch (err) {
    console.error('❌ topstep live audit checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
