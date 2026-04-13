#!/usr/bin/env node
/* eslint-disable no-console */
const { assert, postJson, startAuditServer } = require('./jarvis-audit-common');

const TIMEOUT_MS = 22000;

function buildVoiceBody(message, sessionId, clientId = sessionId, extra = {}) {
  return {
    message: String(message || ''),
    strategy: 'original',
    activeModule: 'bridge',
    contextHint: 'bridge',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    includeTrace: true,
    sessionId,
    clientId,
    ...extra,
  };
}

async function jarvisQuery(baseUrl, body) {
  const out = await postJson(baseUrl, '/api/jarvis/query', body, TIMEOUT_MS);
  assert(out?.success === true, 'jarvis query failed', { body, out });
  return out;
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

async function caseMissingLocation(baseUrl) {
  const sessionId = `localsearch-fail-missing-location-${Date.now()}`;
  const out = await jarvisQuery(baseUrl, buildVoiceBody('nearest walmart', sessionId));
  assert(String(out.intent || '') === 'local_search', 'missing-location intent mismatch', { out });
  assert(out.consentPending === true, 'missing-location should remain pending', { out });
  assert(String(out.consentKind || '') === 'location', 'missing-location should request location', { out });
  assert(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('Jarvis'), 'missing-location should not execute WebTool', { out });
}

async function caseConsentDenied(baseUrl) {
  const sessionId = `localsearch-fail-consent-denied-${Date.now()}`;
  await jarvisQuery(baseUrl, buildVoiceBody('nearest walmart', sessionId));
  const out = await jarvisQuery(baseUrl, buildVoiceBody('no', sessionId));
  assert(out.consentPending !== true, 'consent-denied should clear pending', { out });
  assert(/no problem|didn['’]?t run|tell me the city/i.test(String(out.reply || '')), 'consent-denied should be explicit', { out });
  const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
  assert(receipt?.result?.executed === false, 'consent-denied receipt should remain unexecuted', { out });
}

async function caseZeroResults(baseUrl) {
  const sessionId = `localsearch-fail-zero-${Date.now()}`;
  await jarvisQuery(baseUrl, buildVoiceBody('nearest coffee shop', sessionId));
  await jarvisQuery(baseUrl, buildVoiceBody('use Newark NJ', sessionId));
  const out = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionId));
  assert(String(out.intent || '') === 'local_search', 'zero-results intent mismatch', { out });
  assert(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('WebTool'), 'zero-results should still run WebTool', { out });
  assert(/couldn't find strong matches|0 results/i.test(String(out.reply || '')), 'zero-results reply should be explicit', { out });
  assert(Array.isArray(out.web?.warnings) && out.web.warnings.includes('provider_returned_zero_results'), 'zero-results warning missing', { out });
  const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
  assert(receipt?.result?.executed === true, 'zero-results should still mark execution true', { out });
  assert(Number(receipt?.result?.resultCount) === 0, 'zero-results resultCount mismatch', { out });
}

async function caseProviderError(baseUrl) {
  const sessionId = `localsearch-fail-provider-error-${Date.now()}`;
  await jarvisQuery(baseUrl, buildVoiceBody('nearest coffee shop', sessionId));
  await jarvisQuery(baseUrl, buildVoiceBody('use Newark NJ', sessionId));
  const out = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionId));
  assert(String(out.intent || '') === 'local_search', 'provider-error intent mismatch', { out });
  assert(/provider request failed|try again/i.test(String(out.reply || '')), 'provider-error reply should be explicit', { out });
  assert(Array.isArray(out.web?.warnings) && out.web.warnings.includes('web_request_failed'), 'provider-error warning missing', { out });
  const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
  assert(receipt?.result?.executed === false, 'provider-error should mark execution false', { out });
}

async function casePendingExpired(baseUrl) {
  const sessionId = `localsearch-fail-expired-${Date.now()}`;
  await jarvisQuery(baseUrl, buildVoiceBody('nearest coffee shop', sessionId));
  const out = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionId));
  assert(/didn['’]?t run it|when you['’]?re ready|no worries/i.test(String(out.reply || '')), 'expired pending should fail closed with explicit copy', { out });
  assert(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('Jarvis'), 'expired pending should not execute WebTool', { out });
}

async function run() {
  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };

  const cases = [
    {
      name: 'missing location',
      env: {
        JARVIS_WEB_ENABLED: 'true',
        JARVIS_WEB_TOOL_MODE: 'real',
        JARVIS_WEB_ALLOW_NETWORK: 'true',
        JARVIS_TEST_PLACE_FIXTURE_MODE: 'ok',
      },
      fn: caseMissingLocation,
    },
    {
      name: 'consent denied',
      env: {
        JARVIS_WEB_ENABLED: 'true',
        JARVIS_WEB_TOOL_MODE: 'real',
        JARVIS_WEB_ALLOW_NETWORK: 'true',
        JARVIS_TEST_PLACE_FIXTURE_MODE: 'ok',
      },
      fn: caseConsentDenied,
    },
    {
      name: 'provider zero results',
      env: {
        JARVIS_WEB_ENABLED: 'true',
        JARVIS_WEB_TOOL_MODE: 'real',
        JARVIS_WEB_ALLOW_NETWORK: 'true',
        JARVIS_TEST_PLACE_FIXTURE_MODE: 'zero',
      },
      fn: caseZeroResults,
    },
    {
      name: 'provider request error',
      env: {
        JARVIS_WEB_ENABLED: 'true',
        JARVIS_WEB_TOOL_MODE: 'real',
        JARVIS_WEB_ALLOW_NETWORK: 'true',
        JARVIS_TEST_PLACE_FIXTURE_MODE: 'error',
      },
      fn: caseProviderError,
    },
    {
      name: 'pending state expired',
      env: {
        JARVIS_WEB_ENABLED: 'true',
        JARVIS_WEB_TOOL_MODE: 'real',
        JARVIS_WEB_ALLOW_NETWORK: 'true',
        JARVIS_TEST_PLACE_FIXTURE_MODE: 'ok',
        JARVIS_TEST_FORCE_PENDING_EXPIRED: '1',
      },
      fn: casePendingExpired,
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
    console.error(`\nJarvis local-search failure suite failed with ${failures} case(s).`);
    process.exit(1);
  }
  console.log('\nJarvis local-search failure suite passed.');
}

run().catch((err) => {
  console.error(`\nJarvis local-search failure suite crashed: ${err.message}`);
  process.exit(1);
});
