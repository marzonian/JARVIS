#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const DEFAULT_TIMEOUT_MS = 22000;
const TEST_LOCATION_TTL_SECONDS = 12;

function buildBody(message, sessionId) {
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
  };
}

async function getStatus(baseUrl, sessionId) {
  const qs = new URLSearchParams({ sessionId, clientId: sessionId });
  const resp = await fetch(`${baseUrl}/api/jarvis/location/status?${qs.toString()}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`status http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(baseUrl, sessionId, predicate, timeoutMs = 4000) {
  const started = Date.now();
  let last = null;
  while ((Date.now() - started) < timeoutMs) {
    last = await getStatus(baseUrl, sessionId);
    if (predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3151,
    env: {
      JARVIS_LOCATION_TTL_SECONDS: String(TEST_LOCATION_TTL_SECONDS),
      JARVIS_WEB_ENABLED: process.env.JARVIS_WEB_ENABLED || 'true',
      JARVIS_WEB_TOOL_MODE: process.env.JARVIS_WEB_TOOL_MODE || 'stub',
    },
  });

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  const sessionId = `jarvis-location-${Date.now()}`;

  try {
    const before = await getStatus(server.baseUrl, sessionId);
    assert(before?.ok === true, 'status before update should be ok', { before });
    assert(before?.hasLocation === false, 'status before update should be empty', { before });
    pass('location status starts empty');
  } catch (err) {
    fail('location status starts empty', err);
  }

  try {
    const update = await postJson(server.baseUrl, '/api/jarvis/location/update', {
      sessionId,
      clientId: sessionId,
      lat: 40.7357,
      lon: -74.1724,
      accuracy: 24,
      timestamp: new Date().toISOString(),
      source: 'android_web',
      consent: true,
      traceId: `trace-loc-${Date.now()}`,
    }, DEFAULT_TIMEOUT_MS);
    assert(update?.ok === true, 'location update should succeed', { update });
    assert(update?.stored === true, 'location update should be stored', { update });
    pass('location update stores successfully');
  } catch (err) {
    fail('location update stores successfully', err);
  }

  try {
    const after = await waitForStatus(server.baseUrl, sessionId, (row) => row?.hasLocation === true);
    assert(after?.hasLocation === true, 'status after update should show location', { after });
    assert(Number.isFinite(Number(after?.ageSeconds)), 'status should include ageSeconds', { after });
    pass('location status returns connected state');
  } catch (err) {
    fail('location status returns connected state', err);
  }

  try {
    const first = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('nearest coffee shop', sessionId), DEFAULT_TIMEOUT_MS);
    assert(first?.success === true, 'nearest coffee request failed', { first });
    assert(first?.consentPending === true, 'nearest coffee should require consent', { first });
    assert(String(first?.consentKind || '') === 'web_search', 'with GPS present, nearest coffee should move to web_search confirmation', { first });
    assert(/want me to (look|run).+now/i.test(String(first?.reply || '')), 'should ask for web search consent', { first });
    assert(Array.isArray(first?.toolsUsed) && first.toolsUsed.includes('Jarvis'), 'should not execute WebTool before explicit yes', { first });
    pass('nearest coffee requires explicit web consent even with GPS');

    const yes = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('yes run it', sessionId), DEFAULT_TIMEOUT_MS);
    assert(yes?.success === true, 'yes run it failed', { yes });
    assert(Array.isArray(yes?.toolsUsed) && yes.toolsUsed.includes('WebTool'), 'yes should execute WebTool', { yes });
    const reply = String(yes?.reply || '');
    const mode = String(process.env.JARVIS_WEB_TOOL_MODE || 'stub').toLowerCase();
    if (mode !== 'real') {
      assert(/stub mode|did not run a real lookup/i.test(reply), 'stub mode response must explicitly disclaim live execution', { yes });
    }
    pass('web tool executes only after explicit yes and keeps no-hallucination disclaimer in stub mode');
  } catch (err) {
    fail('consent chain executes web lookup correctly', err);
  }

  try {
    await sleep((TEST_LOCATION_TTL_SECONDS * 1000) + 300);
    const expired = await waitForStatus(server.baseUrl, sessionId, (row) => row?.hasLocation === false, 5000);
    assert(expired?.hasLocation === false, 'location should expire after TTL', { expired });
    pass('location TTL expiry clears session location');
  } catch (err) {
    fail('location TTL expiry clears session location', err);
  }

  try {
    const afterExpiry = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('nearest coffee shop', sessionId), DEFAULT_TIMEOUT_MS);
    assert(afterExpiry?.consentPending === true, 'after ttl expiry should request consent again', { afterExpiry });
    assert(String(afterExpiry?.consentKind || '') === 'location', 'after ttl expiry should return to location consent stage', { afterExpiry });
    assert(/use your current location|specific city/i.test(String(afterExpiry?.reply || '')), 'after ttl expiry should ask for location source', { afterExpiry });
    pass('after TTL expiry Jarvis re-asks for phone location or city');
  } catch (err) {
    fail('after TTL expiry Jarvis re-asks for phone location or city', err);
  }

  await server.stop();

  if (failures > 0) {
    console.error(`\nJarvis location bridge test failed with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nJarvis location bridge test passed.');
}

run().catch((err) => {
  console.error(`\nJarvis location bridge test crashed: ${err.message}`);
  process.exit(1);
});
