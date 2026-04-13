#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 22000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBody(message, sessionId, auditMock = null) {
  return {
    message: String(message || ''),
    strategy: 'original',
    activeModule: 'bridge',
    contextHint: 'bridge',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    includeTrace: true,
    sessionId,
    clientId: sessionId,
    ...(auditMock && typeof auditMock === 'object' ? { auditMock } : {}),
  };
}

async function getJson(baseUrl, endpoint, timeoutMs = 12000) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text || '{}'); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${endpoint} http_${res.status}: ${text.slice(0, 500)}`);
  return data;
}

(async () => {
  const markerFile = path.join(os.tmpdir(), `jarvis-runtime-freshness-marker-${Date.now().toString(36)}.txt`);
  fs.writeFileSync(markerFile, 'runtime_freshness_marker:boot\n', 'utf8');

  const server = await startAuditServer({
    useExisting: false,
    env: {
      DEBUG_JARVIS_AUDIT: '1',
      JARVIS_AUDIT_ALLOW_MOCKS: '1',
      RUNTIME_FRESHNESS_AUTO_REPAIR: '0',
      RUNTIME_FRESHNESS_EXTRA_CHECK_FILES: markerFile,
    },
  });

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  const replayWinMock = {
    healthStatus: 'STALE',
    replay: {
      ok: true,
      data: {
        available: true,
        targetDate: '2026-03-03',
        source: 'db_5m',
        orb: { rangeTicks: 180 },
        replay: {
          wouldTrade: true,
          result: 'win',
          direction: 'long',
          retestTime: '2026-03-03 10:00',
          mfeTicks: 140,
          maeTicks: 32,
        },
      },
      warnings: [],
    },
  };

  try {
    const health = await getJson(server.baseUrl, '/api/health', TIMEOUT_MS);
    const freshness = health.runtimeFreshness || {};
    assert(String(freshness.status || '') === 'current', 'fresh server should report current runtime freshness', { health });
    assert(freshness.staleCodeDetected !== true, 'fresh server should not report stale code', { health });
    pass('runtime/code freshness starts as current');
  } catch (err) {
    fail('runtime/code freshness starts as current', err);
  }

  try {
    const out = await postJson(
      server.baseUrl,
      '/api/jarvis/query',
      buildBody('did we win today', `runtime-freshness-review-stale-health-${Date.now().toString(36)}`, replayWinMock),
      TIMEOUT_MS
    );
    assert(out?.success === true, 'query should succeed', { out });
    assert(String(out.intent || '') === 'trading_review', 'review query must route to trading_review', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'review query must use TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'review query must use replay route', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'review reply must answer from replay truth', { out });
    pass('persisted-truth review query still works with stale live market health');
  } catch (err) {
    fail('persisted-truth review query still works with stale live market health', err);
  }

  try {
    await sleep(15);
    fs.appendFileSync(markerFile, `runtime_freshness_marker:update:${Date.now()}\n`, 'utf8');
    await sleep(15);
    const health = await getJson(server.baseUrl, '/api/health', TIMEOUT_MS);
    const freshness = health.runtimeFreshness || {};
    assert(freshness.staleCodeDetected === true, 'stale marker update should trigger stale runtime detection', { health });
    assert(String(freshness.status || '') === 'stale', 'stale marker update should report stale status', { health });
    assert(
      freshness.fingerprintMismatchDetected === true || String(freshness.staleReason || '') !== 'none',
      'stale runtime should expose mismatch reason',
      { health }
    );
    pass('stale daemon/old-runtime condition is detected');
  } catch (err) {
    fail('stale daemon/old-runtime condition is detected', err);
  }

  try {
    const out = await postJson(
      server.baseUrl,
      '/api/jarvis/query',
      buildBody('did we make money today', `runtime-freshness-review-stale-runtime-${Date.now().toString(36)}`, replayWinMock),
      TIMEOUT_MS
    );
    assert(out?.success === true, 'query should succeed under stale runtime', { out });
    assert(String(out.intent || '') === 'trading_review', 'stale runtime review query must still route to trading_review', { out });
    assert(out.runtimeStaleCodeDetected === true, 'stale runtime should be surfaced in query payload', { out });
    assert(['stale', 'repaired'].includes(String(out.runtimeFreshnessStatus || '')), 'runtime freshness status should be surfaced', { out });
    assert(/runtime note:/i.test(String(out.reply || '')), 'stale runtime should be surfaced in assistant reply text', { out });
    pass('stale state is surfaced in assistant path instead of hidden');
  } catch (err) {
    fail('stale state is surfaced in assistant path instead of hidden', err);
  }

  try {
    fs.unlinkSync(markerFile);
  } catch {}
  await server.stop();

  if (failures > 0) {
    console.error(`\nJarvis runtime freshness tests failed with ${failures} case(s).`);
    process.exit(1);
  }
  console.log('\nJarvis runtime freshness tests passed.');
})();
