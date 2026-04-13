#!/usr/bin/env node
/* eslint-disable no-console */
const { assert, postJson, startAuditServer } = require('./jarvis-audit-common');

const DEFAULT_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonAllowStatus(url, options = {}, allowedStatuses = []) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text || '{}');
  } catch {
    body = { raw: text };
  }
  if (!res.ok && !allowedStatuses.includes(res.status)) {
    throw new Error(`http_${res.status}: ${text.slice(0, 400)}`);
  }
  return { status: res.status, body };
}

function buildVoiceBody(message, sessionId, extra = {}) {
  return {
    message,
    strategy: 'original',
    activeModule: 'bridge',
    contextHint: 'bridge',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    includeTrace: true,
    sessionId,
    clientId: sessionId,
    ...extra,
  };
}

async function runCase(name, env, fn) {
  const server = await startAuditServer({
    useExisting: false,
    env: env || {},
  });
  try {
    await fn(server.baseUrl);
    console.log(`✅ ${name}`);
  } finally {
    await server.stop();
  }
}

async function caseMissingSession(baseUrl) {
  const out = await fetchJsonAllowStatus(`${baseUrl}/api/jarvis/location/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: 40.7,
      lon: -74.2,
      source: 'failure_test',
    }),
  }, [400]);
  assert(out.status === 400, 'missing-session should return 400', out);
  assert(/sessionId is required/i.test(String(out.body?.error || '')), 'missing-session should be explicit', out);
}

async function caseLocationTtlExpired(baseUrl) {
  const sessionId = `failure-ttl-${Date.now()}`;
  const update = await postJson(baseUrl, '/api/jarvis/location/update', {
    sessionId,
    clientId: sessionId,
    lat: 40.7175,
    lon: -74.21,
    accuracy: 10,
    timestamp: new Date().toISOString(),
    source: 'failure_ttl',
    consent: true,
  });
  assert(update?.ok === true, 'ttl update failed', { update });
  const freshStatus = await fetchJsonAllowStatus(`${baseUrl}/api/jarvis/location/status?sessionId=${encodeURIComponent(sessionId)}&clientId=${encodeURIComponent(sessionId)}`, {
    method: 'GET',
  });
  assert(freshStatus.body?.hasLocation === true, 'ttl status should be present before expiry', { freshStatus });
  await sleep(1600);
  const after = await fetchJsonAllowStatus(`${baseUrl}/api/jarvis/location/status?sessionId=${encodeURIComponent(sessionId)}&clientId=${encodeURIComponent(sessionId)}`, {
    method: 'GET',
  });
  assert(after.status === 200, 'ttl status endpoint should return 200', after);
  assert(after.body?.hasLocation === false, 'ttl expired location should be cleared', after);
}

async function caseConsentPendingUnrelated(baseUrl) {
  const sessionId = `failure-consent-${Date.now()}`;
  const start = await postJson(baseUrl, '/api/jarvis/query', buildVoiceBody('nearest coffee shop', sessionId));
  assert(start?.intent === 'local_search', 'consent-start intent mismatch', { start });
  assert(start?.consentPending === true, 'consent-start should set pending', { start });
  const unrelated = await postJson(baseUrl, '/api/jarvis/query', buildVoiceBody('banana helicopter', sessionId));
  assert(unrelated?.consentPending === true, 'unrelated message should keep consent pending', { unrelated });
  assert(/waiting|say yes|location|ok/i.test(String(unrelated?.reply || '')), 'unrelated message should explain what is missing', { unrelated });
  assert(Array.isArray(unrelated?.toolsUsed) && unrelated.toolsUsed.includes('Jarvis'), 'unrelated consent response should stay on Jarvis', { unrelated });
}

async function caseWebToolDisabled(baseUrl) {
  const sessionId = `failure-web-disabled-${Date.now()}`;
  const first = await postJson(baseUrl, '/api/jarvis/query', buildVoiceBody('nearest coffee shop in Newark', sessionId));
  assert(first?.consentPending === true, 'web-disabled step 1 should await auth', { first });
  const yes = await postJson(baseUrl, '/api/jarvis/query', buildVoiceBody('yes', sessionId));
  assert(yes?.intent === 'local_search', 'web-disabled yes intent mismatch', { yes });
  assert(Array.isArray(yes?.toolsUsed) && yes.toolsUsed.includes('WebTool'), 'web-disabled should still route through WebTool', { yes });
  assert(/disabled/i.test(String(yes?.reply || '')), 'web-disabled response should explicitly disclose disabled mode', { yes });
  const receipts = Array.isArray(yes?.toolReceipts) ? yes.toolReceipts : [];
  assert(receipts.length > 0, 'web-disabled requires receipt', { yes });
}

async function caseHealthEndpointFailure(baseUrl) {
  const health = await fetchJsonAllowStatus(`${baseUrl}/api/market/health?forceFresh=1`, { method: 'GET' }, [500]);
  assert(health.status === 500, 'forced health error should return 500', health);
  assert(String(health.body?.status || '').toUpperCase() === 'STALE', 'forced health error should fail closed as STALE', health);
  assert(/forced_market_health_fetch_error/i.test(String(health.body?.reason || '')), 'forced health reason mismatch', health);

  const sessionId = `failure-health-${Date.now()}`;
  const out = await postJson(baseUrl, '/api/jarvis/query', buildVoiceBody('should i take this setup now', sessionId));
  assert(out?.intent === 'trading_decision', 'health-failure trading intent mismatch', { out });
  assert(/live market data|fresh|stale|isn['’]?t healthy/i.test(String(out?.reply || '')), 'health-failure reply should disclose freshness issue', { out });
  const diag = await fetchJsonAllowStatus(`${baseUrl}/api/jarvis/diag/latest?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' });
  const trace = diag.body?.trace || {};
  assert(
    String(trace?.decisionBlockedBy || '').toLowerCase() === 'health'
      || String(trace?.healthStatusUsed || '').toUpperCase() === 'STALE',
    'health-failure trace missing health block evidence',
    { trace }
  );
}

async function caseLegacyVoiceEndpointGuard(baseUrl) {
  const out = await fetchJsonAllowStatus(`${baseUrl}/api/assistant/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      sessionId: `failure-guard-${Date.now()}`,
    }),
  }, [409]);
  assert(out.status === 409, 'legacy endpoint voice guard should return 409', out);
  assert(String(out.body?.message || '') === 'Voice must use Jarvis endpoint', 'legacy endpoint guard message mismatch', out);
}

async function caseTraceStoreMissing(baseUrl) {
  const sessionId = `missing-trace-${Date.now()}`;
  const out = await fetchJsonAllowStatus(`${baseUrl}/api/jarvis/diag/latest?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'GET',
  }, [404]);
  assert(out.status === 404, 'missing-trace should return 404', out);
  assert(String(out.body?.error || '') === 'jarvis_trace_not_found', 'missing-trace error code mismatch', out);
}

async function run() {
  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };

  const cases = [
    {
      name: '1) missing sessionId/clientId',
      env: {},
      fn: caseMissingSession,
    },
    {
      name: '2) location TTL expired',
      env: { JARVIS_LOCATION_TTL_SECONDS: '1' },
      fn: caseLocationTtlExpired,
    },
    {
      name: '3) consent pending + unrelated phrase',
      env: {},
      fn: caseConsentPendingUnrelated,
    },
    {
      name: '4) web tool disabled',
      env: {
        JARVIS_WEB_ENABLED: 'false',
      },
      fn: caseWebToolDisabled,
    },
    {
      name: '5) health endpoint returns error',
      env: {
        JARVIS_TEST_FORCE_HEALTH_FETCH_ERROR: '1',
      },
      fn: caseHealthEndpointFailure,
    },
    {
      name: '6) voice fallback to legacy endpoint blocked',
      env: {},
      fn: caseLegacyVoiceEndpointGuard,
    },
    {
      name: '7) trace store empty/diag latest missing',
      env: {},
      fn: caseTraceStoreMissing,
    },
  ];

  for (const c of cases) {
    try {
      await runCase(c.name, c.env, c.fn);
    } catch (err) {
      fail(c.name, err);
    }
  }

  if (failures > 0) {
    console.error(`Jarvis failure-injection suite failed with ${failures} case(s).`);
    process.exit(1);
  }
  console.log('All jarvis failure-injection cases passed.');
}

run().catch((err) => {
  console.error('Jarvis failure-injection suite crashed:', err);
  process.exit(1);
});
