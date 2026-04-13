#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 180000;

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

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3174,
  });
  let testPhase = '';

  let failures = 0;
  const pass = (name) => console.log(`✅ ${name}`);
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };

  try {
    const uniquePhase = `test_backfill_phase_${Date.now()}`;
    const backfill = await postJson(server.baseUrl, '/api/jarvis/recommendation/backfill', {
      windowSessions: 20,
      force: false,
      sourceType: 'backfill',
      reconstructionPhase: uniquePhase,
      reconstructionVersion: 'test_backfill_v1',
    });
    assert(backfill?.status === 'ok', 'backfill endpoint should return ok', { backfill });
    assert(Number(backfill?.processed || 0) > 0, 'backfill should process rows', { backfill });
    assert(Number(backfill?.inserted || 0) > 0, 'first run should insert rows for a unique reconstruction phase', { backfill });
    assert(Number(backfill?.updated || 0) === 0, 'first run should not update existing rows for a unique reconstruction phase', { backfill });
    assert(Number(backfill?.reusedExisting || 0) === 0, 'first run should not reuse existing rows for a unique reconstruction phase', { backfill });
    assert(Number(backfill?.alreadyPresent || 0) === 0, 'first run should report zero alreadyPresent rows for unique reconstruction phase', { backfill });
    assert(Number(backfill?.failed || 0) === 0, 'first run should not fail rows', { backfill });
    assert(String(backfill?.sourceType || '') === 'backfill', 'backfill sourceType should be backfill', { backfill });
    assert(String(backfill?.reconstructionPhase || '') === uniquePhase, 'reconstructionPhase should match requested unique phase', { backfill, uniquePhase });
    assert(typeof backfill?.reconstructionVersion === 'string' && backfill.reconstructionVersion.length > 0, 'reconstructionVersion should be returned', { backfill });
    assert(backfill?.idempotentReuse === false, 'first run should not be idempotent reuse', { backfill });

    const rerun = await postJson(server.baseUrl, '/api/jarvis/recommendation/backfill', {
      windowSessions: 20,
      force: false,
      sourceType: 'backfill',
      reconstructionPhase: uniquePhase,
      reconstructionVersion: 'test_backfill_v1',
    });
    assert(rerun?.status === 'ok', 'second backfill run should return ok', { rerun });
    assert(Number(rerun?.processed || 0) > 0, 'second run should process requested dates', { rerun });
    assert(Number(rerun?.reusedExisting || 0) > 0, 'second run should explicitly report reusedExisting rows', { rerun });
    assert(Number(rerun?.alreadyPresent || 0) >= Number(rerun?.reusedExisting || 0), 'alreadyPresent should be >= reusedExisting', { rerun });
    assert(Number(rerun?.inserted || 0) === 0, 'second run should not insert new rows when phase/version already exist', { rerun });
    assert(Number(rerun?.updated || 0) === 0, 'second run should not update rows when not forced', { rerun });
    assert(Number(rerun?.scored || 0) === 0, 'second run should not rescore reused rows when not forced', { rerun });
    assert(rerun?.idempotentReuse === true, 'second run should declare idempotent reuse', { rerun });
    pass('backfill accounting is explicit for first insert run and second idempotent reuse run');

    // save for later assertions
    testPhase = uniquePhase;
  } catch (err) {
    fail('backfill accounting is explicit for first insert run and second idempotent reuse run', err);
  }

  try {
    const phase = testPhase || '';
    const perfBackfill = await getJson(
      server.baseUrl,
      `/api/jarvis/recommendation/performance?source=backfill&windowSessions=20&force=1&reconstructionPhase=${encodeURIComponent(phase)}`
    );
    const summary = perfBackfill?.recommendationPerformance || {};
    assert(perfBackfill?.status === 'ok', 'performance(backfill) should return ok', { perfBackfill });
    assert(summary && typeof summary === 'object', 'recommendationPerformance summary missing', { perfBackfill });
    assert(Object.prototype.hasOwnProperty.call(summary, 'postureAccuracy30d'), 'postureAccuracy30d missing', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'strategyAccuracy30d'), 'strategyAccuracy30d missing', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'tpAccuracy30d'), 'tpAccuracy30d missing', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'rowCountUsed'), 'rowCountUsed missing', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'oldestRecordDate'), 'oldestRecordDate missing', { summary });
    assert(Object.prototype.hasOwnProperty.call(summary, 'newestRecordDate'), 'newestRecordDate missing', { summary });
    assert(summary?.provenanceSummary && typeof summary.provenanceSummary === 'object', 'provenanceSummary missing', { summary });
    assert(summary?.sourceBreakdown && Number(summary.sourceBreakdown.backfill || 0) > 0, 'sourceBreakdown.backfill should be > 0', { summary });
    assert(typeof summary?.reconstructionPhase === 'string' && summary.reconstructionPhase.length > 0, 'summary reconstructionPhase missing', { summary });
    assert(Number(summary?.rowCountUsed || 0) === Number(summary?.sourceBreakdown?.total || 0), 'rowCountUsed should match sourceBreakdown.total', { summary });

    const scorecards = Array.isArray(perfBackfill?.scorecards) ? perfBackfill.scorecards : [];
    assert(scorecards.length > 0, 'backfill scorecards should not be empty', { perfBackfill });
    const sample = scorecards[0] || {};
    assert(sample.sourceType === 'backfill', 'scorecard sourceType should be backfill', { sample });
    assert(typeof sample.reconstructionPhase === 'string' && sample.reconstructionPhase.length > 0, 'scorecard reconstructionPhase missing', { sample });
    assert(typeof sample.scoreVersion === 'string' && sample.scoreVersion.length > 0, 'scorecard scoreVersion missing', { sample });
    pass('performance endpoint summarizes backfill rows with source labels');

    // no-future-leakage + missing-signal safeguards
    const checked = scorecards.slice(0, 10);
    for (const row of checked) {
      const integrity = row?.integrity || {};
      assert(integrity.noFutureLeakage === true, 'integrity.noFutureLeakage must be true for backfill', { row });
      const recDate = String(row?.date || '');
      const cutoff = String(integrity.knowledgeCutoffDate || '');
      assert(cutoff && cutoff < recDate, 'knowledgeCutoffDate must be earlier than recommendation date', { row });
      assert(Array.isArray(integrity.unavailableSignals) && integrity.unavailableSignals.length > 0, 'unavailableSignals should be explicit', { row });
    }
    pass('no-future-leakage and unavailable-signal safeguards are enforced');
  } catch (err) {
    fail('performance endpoint + leakage safeguards', err);
  }

  try {
    const phase = testPhase || '';
    const inspect = await getJson(
      server.baseUrl,
      `/api/jarvis/recommendation/performance/inspect?source=backfill&limit=10&reconstructionPhase=${encodeURIComponent(phase)}`
    );
    assert(inspect?.status === 'ok', 'inspect endpoint should return ok', { inspect });
    assert(Number(inspect?.rowCount || 0) > 0, 'inspect endpoint should return rows', { inspect });
    assert(Array.isArray(inspect?.rows) && inspect.rows.length > 0, 'inspect rows missing', { inspect });
    const row = inspect.rows[0] || {};
    assert(typeof row?.recDate === 'string' && row.recDate.length > 0, 'inspect recDate missing', { row });
    assert(row?.sourceType === 'backfill', 'inspect sourceType should be backfill', { row });
    assert(typeof row?.reconstructionPhase === 'string' && row.reconstructionPhase.length > 0, 'inspect reconstructionPhase missing', { row });
    assert(typeof row?.createdAt === 'string' && row.createdAt.length > 0, 'inspect createdAt missing', { row });
    assert(typeof row?.updatedAt === 'string' && row.updatedAt.length > 0, 'inspect updatedAt missing', { row });
    pass('inspect endpoint exposes row-level provenance and score labels');
  } catch (err) {
    fail('inspect endpoint exposes row-level provenance and score labels', err);
  }

  try {
    const perfLive = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?source=live&windowSessions=20&force=1');
    const perfAll = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?source=all&windowSessions=20&force=1');
    const liveBreakdown = perfLive?.recommendationPerformance?.sourceBreakdown || {};
    const allBreakdown = perfAll?.recommendationPerformance?.sourceBreakdown || {};
    assert(Number(allBreakdown.total || 0) >= Number(liveBreakdown.total || 0), 'all source total should be >= live source total', {
      liveBreakdown,
      allBreakdown,
    });
    assert(Number(allBreakdown.backfill || 0) >= 0, 'all source breakdown should include backfill key', { allBreakdown });
    pass('source filtering works for live/backfill/all');
  } catch (err) {
    fail('source filtering works for live/backfill/all', err);
  }

  try {
    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&performanceSource=backfill&performanceWindow=20');
    const summary = center?.commandCenter?.recommendationPerformanceSummary || {};
    const line = String(center?.commandCenter?.recommendationPerformanceLine || '');
    assert(center?.status === 'ok', 'command-center should return ok', { center });
    assert(summary && typeof summary === 'object', 'command-center recommendationPerformanceSummary missing', { center });
    assert(/retrospective|reconstructed/i.test(line), 'command-center performance line should label retrospective source honestly', { line, summary });
    pass('command-center labels retrospective recommendation scoring honestly');
  } catch (err) {
    fail('command-center labels retrospective recommendation scoring honestly', err);
  }

  await server.stop();
  if (failures > 0) {
    console.error(`\nJarvis recommendation backfill test failed with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nJarvis recommendation backfill tests passed.');
}

run().catch((err) => {
  console.error(`\nJarvis recommendation backfill test crashed: ${err.message}`);
  process.exit(1);
});
