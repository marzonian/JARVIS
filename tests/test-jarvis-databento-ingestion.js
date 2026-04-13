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
  runDatabentoIngestion,
  buildDatabentoIngestionStatus,
  buildIngestionPlanForSymbol,
  DEFAULT_RECENT_CLAMP_DAYS,
} = require('../server/jarvis-core/databento-ingestion');

const TIMEOUT_MS = 240000;

function makeDb() {
  const db = new Database(':memory:');
  ensureDataFoundationTables(db);
  return db;
}

function normalizeDate(value) {
  return String(value || '').trim().slice(0, 10);
}

function toUtcMs(isoDate) {
  const [y, m, d] = String(isoDate || '').split('-').map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return Date.UTC(y, m - 1, d);
}

function addDays(isoDate, days) {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + (Math.round(Number(days || 0)) * 86400000)).toISOString().slice(0, 10);
}

function enumerateWeekdays(startDate, endDate) {
  const out = [];
  let cursor = normalizeDate(startDate);
  const stop = normalizeDate(endDate);
  let guard = 0;
  while (cursor && cursor <= stop && guard < 2000) {
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

function buildCsvForRange(symbol, startDate, endDate, options = {}) {
  const skip = new Set(Array.isArray(options.skipDates) ? options.skipDates.map((d) => normalizeDate(d)) : []);
  const dates = enumerateWeekdays(startDate, endDate);
  const lines = ['ts_event,symbol,open,high,low,close,volume'];
  let px = Number(options.startPrice || 100);
  for (const date of dates) {
    if (skip.has(date)) continue;
    const ts = `${date}T14:30:00.000Z`;
    const open = px;
    const close = px + 0.5;
    const high = close + 0.25;
    const low = open - 0.25;
    const vol = 1000;
    lines.push(`${ts},${symbol},${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${vol}`);
    px += 1;
  }
  return lines.join('\n');
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

async function postJson(baseUrl, endpoint, body) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function runUnitChecks() {
  {
    const db = makeDb();
    const out = await runDatabentoIngestion({
      db,
      apiKey: '',
      mode: 'auto',
      symbols: ['MNQ.c.0'],
      startDate: '2026-02-02',
      endDate: '2026-02-06',
    });
    assert(out.status === 'disabled', 'missing key should disable ingestion');
    assert(Array.isArray(out.warnings) && out.warnings.includes('databento_api_key_missing'), 'missing key warning expected');
    db.close();
  }

  {
    const db = makeDb();
    const fetchCalls = [];
    const out1 = await runDatabentoIngestion({
      db,
      apiKey: 'db_test_key',
      mode: 'full_backfill',
      symbols: ['MNQ.c.0'],
      startDate: '2026-02-02',
      endDate: '2026-02-06',
      fetchRangeFn: async ({ symbol, start, end }) => {
        fetchCalls.push({ symbol, start, end });
        return {
          csvText: buildCsvForRange(symbol, normalizeDate(start), normalizeDate(end)),
        };
      },
    });
    assert(['ok', 'partial'].includes(String(out1.status)), 'full backfill should run');
    assert(Number(out1.totalInserted || 0) > 0, 'full backfill should insert rows');
    assert(fetchCalls.length > 0, 'full backfill should fetch at least one range');

    const count1 = Number(db.prepare('SELECT COUNT(*) AS c FROM jarvis_market_bars_raw WHERE symbol = ?').get('MNQ.c.0')?.c || 0);
    assert(count1 > 0, 'bar table should contain inserted rows');

    const out2 = await runDatabentoIngestion({
      db,
      apiKey: 'db_test_key',
      mode: 'incremental',
      symbols: ['MNQ.c.0'],
      endDate: '2026-02-10',
      fetchRangeFn: async ({ symbol, start, end }) => ({
        csvText: buildCsvForRange(symbol, normalizeDate(start), normalizeDate(end), { startPrice: 140 }),
      }),
    });
    assert(['ok', 'partial', 'noop'].includes(String(out2.status)), 'incremental run should complete');
    const count2 = Number(db.prepare('SELECT COUNT(*) AS c FROM jarvis_market_bars_raw WHERE symbol = ?').get('MNQ.c.0')?.c || 0);
    assert(count2 >= count1, 'incremental append should not shrink row count');
    assert(Number(out2.totalInserted || 0) > 0, 'incremental append should insert new rows');

    const state = db.prepare(`
      SELECT last_success_ts, last_status
      FROM jarvis_databento_ingestion_state
      WHERE symbol = ?
    `).get('MNQ.c.0');
    assert(state && state.last_success_ts, 'ingestion state should keep last_success_ts');
    assert(String(state.last_status || '').length > 0, 'ingestion state should keep status');

    const status = buildDatabentoIngestionStatus({
      db,
      symbols: ['MNQ.c.0'],
      endDate: '2026-02-10',
    });
    assert(status && Array.isArray(status.symbolsStatus), 'status should include symbolsStatus');
    assert(status.symbolsStatus.length === 1, 'status should include requested symbol');
    assert(status.symbolsStatus[0].coverage && Number(status.symbolsStatus[0].coverage.barCount || 0) >= count2, 'status coverage should reflect stored bars');

    db.close();
  }

  {
    const db = makeDb();
    await runDatabentoIngestion({
      db,
      apiKey: 'db_test_key',
      mode: 'full_backfill',
      symbols: ['MES.c.0'],
      startDate: '2026-02-02',
      endDate: '2026-02-06',
      fetchRangeFn: async ({ symbol, start, end }) => ({
        csvText: buildCsvForRange(symbol, normalizeDate(start), normalizeDate(end), { skipDates: ['2026-02-04'] }),
      }),
    });

    const plan = buildIngestionPlanForSymbol(db, {
      mode: 'auto',
      symbol: 'MES.c.0',
      startDate: '2026-02-02',
      endDate: '2026-02-06',
      gapLookbackDays: 10,
    });
    const hasGapRange = Array.isArray(plan.plannedRanges)
      && plan.plannedRanges.some((r) => String(r.reason || '').toLowerCase() === 'gap_recovery');
    assert(hasGapRange, 'gap recovery range should be planned when day is missing');

    const out = await runDatabentoIngestion({
      db,
      apiKey: 'db_test_key',
      mode: 'auto',
      symbols: ['MES.c.0'],
      startDate: '2026-02-02',
      endDate: '2026-02-06',
      gapLookbackDays: 10,
      fetchRangeFn: async ({ symbol, start, end }) => ({
        csvText: buildCsvForRange(symbol, normalizeDate(start), normalizeDate(end), { startPrice: 220 }),
      }),
    });
    assert(['ok', 'partial', 'noop'].includes(String(out.status)), 'gap-recovery run should complete');

    const recovered = Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_market_bars_raw
      WHERE symbol = ? AND substr(ts_event, 1, 10) = ?
    `).get('MES.c.0', '2026-02-04')?.c || 0);
    assert(recovered > 0, 'missing gap date should be inserted during recovery');

    const openGapCount = Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM jarvis_databento_gap_audit
      WHERE symbol = ? AND status = 'open'
    `).get('MES.c.0')?.c || 0);
    assert(openGapCount === 0, 'resolved gap should not remain open in gap audit');

    db.close();
  }

  {
    const db = makeDb();
    const plan = buildIngestionPlanForSymbol(db, {
      mode: 'auto',
      symbol: 'MNQ.c.0',
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      nowDate: '2026-03-10',
      recentClampDays: DEFAULT_RECENT_CLAMP_DAYS,
    });
    assert(plan.rangeClampApplied === true || plan.clampApplied === true, 'near-current plan should clamp requested range');
    assert(plan.requestedEndDate === '2026-03-10', 'requested end date should be retained');
    assert(plan.endDate === '2026-03-09', 'effective end date should clamp away from near-current date');
    assert(Array.isArray(plan.deferredRanges) && plan.deferredRanges.length > 0, 'deferred recent range should be surfaced');

    const run = await runDatabentoIngestion({
      db,
      apiKey: 'db_test_key',
      mode: 'auto',
      symbols: ['MNQ.c.0'],
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      nowDate: '2026-03-10',
      recentClampDays: DEFAULT_RECENT_CLAMP_DAYS,
      fetchRangeFn: async ({ symbol, start, end }) => ({
        csvText: buildCsvForRange(symbol, normalizeDate(start), normalizeDate(end), { startPrice: 130 }),
      }),
    });
    assert(['ok', 'partial', 'noop'].includes(String(run.status || '')), 'clamped ingestion run should complete without hard failure');
    const symbolRow = Array.isArray(run.perSymbol) ? run.perSymbol.find((r) => r.symbol === 'MNQ.c.0') : null;
    assert(symbolRow, 'symbol summary missing');
    assert(symbolRow.rangeClampApplied === true, 'symbol summary should report rangeClampApplied');
    assert(Array.isArray(symbolRow.deferredRanges) && symbolRow.deferredRanges.length > 0, 'symbol summary should expose deferred ranges');
    assert(symbolRow.fetchedRanges.every((r) => normalizeDate(r.endDate) <= '2026-03-09'), 'fetched ranges must stay inside clamped window');
    db.close();
  }

  {
    const db = makeDb();
    const run = await runDatabentoIngestion({
      db,
      apiKey: 'db_test_key',
      mode: 'full_backfill',
      symbols: ['MES.c.0'],
      startDate: '2026-03-09',
      endDate: '2026-03-10',
      nowDate: '2026-03-10',
      recentClampDays: 0,
      fetchRangeFn: async () => {
        const err = new Error('databento_http_422');
        err.statusCode = 422;
        throw err;
      },
    });
    assert(['noop', 'partial', 'ok'].includes(String(run.status || '')), 'near-current retryable 422 should not hard-fail run');
    const latestGap = db.prepare(`
      SELECT status, details_json
      FROM jarvis_databento_gap_audit
      WHERE symbol = ?
      ORDER BY id DESC
      LIMIT 1
    `).get('MES.c.0');
    assert(latestGap, 'gap audit row should exist for retryable recent fetch');
    assert(String(latestGap.status || '') === 'retryable', 'near-current 422 should record retryable gap status');
    const details = JSON.parse(String(latestGap.details_json || '{}'));
    assert(String(details.reasonCode || '').length > 0, 'gap details should include reasonCode');
    db.close();
  }
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3206,
    env: {
      DATABENTO_API_KEY: '',
      DATABENTO_API_ENABLED: 'true',
      DATABENTO_AUTO_INGEST_ENABLED: 'false',
    },
  });

  try {
    const statusOut = await getJson(server.baseUrl, '/api/jarvis/databento/ingestion?force=1');
    assert(statusOut?.status === 'ok', 'databento ingestion status endpoint should return ok');
    assert(statusOut?.databentoIngestionStatus && typeof statusOut.databentoIngestionStatus === 'object', 'databentoIngestionStatus missing');
    assert(Array.isArray(statusOut.databentoIngestionStatus.symbolsStatus), 'symbolsStatus missing from databento status');

    const runOut = await postJson(server.baseUrl, '/api/jarvis/databento/ingestion/run', {
      mode: 'auto',
      symbols: ['MNQ.c.0'],
      force: false,
    });
    assert(runOut?.status === 'ok', 'databento ingestion run endpoint should return ok');
    assert(runOut?.databentoIngestionRun && typeof runOut.databentoIngestionRun === 'object', 'databentoIngestionRun payload missing');
    assert(['disabled', 'ok', 'partial', 'noop', 'error'].includes(String(runOut.databentoIngestionRun.status || '')), 'unexpected ingestion run status');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    await runUnitChecks();
    await runIntegrationChecks();
    console.log('✅ databento ingestion checks passed');
  } catch (err) {
    console.error('❌ databento ingestion checks failed');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();
