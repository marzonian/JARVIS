#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 24000;

const ENTITIES = [
  'walmart', 'target', 'cvs', 'walgreens', 'costco', 'sam club', 'whole foods', 'trader joes', 'aldi', 'kroger',
  'gas station', 'shell', 'exxon', 'bp', 'chevron', 'pizza', 'coffee shop', 'cafe', 'bakery', 'restaurant',
  'taco', 'burger', 'sushi', 'pharmacy', 'urgent care', 'clinic', 'hospital', 'grocery', 'supermarket', 'bank',
  'atm', 'ups store', 'usps', 'fedex', 'post office', 'gym', 'fitness center', 'hardware store', 'home depot', 'lowes',
  'pet store', 'vet', 'car wash', 'auto parts', 'movie theater', 'bookstore', 'electronics store', 'furniture store', 'hotel', 'laundry',
];

const PHRASE_STYLES = [
  (entity) => `nearest ${entity}`,
  (entity) => `closest ${entity}`,
  (entity) => `find ${entity} near me`,
  (entity) => `where's the nearest ${entity}`,
];

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
  assert(out?.didFinalize === true, 'jarvis response must be finalized', { out });
  return out;
}

async function diagLatest(baseUrl, sessionId) {
  const url = `${baseUrl}/api/jarvis/diag/latest?sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  const json = await res.json().catch(() => ({}));
  assert(res.ok, 'diag latest failed', { sessionId, status: res.status, json });
  assert(json?.success === true && json?.trace, 'diag latest missing trace', { sessionId, json });
  return json.trace;
}

function assertNoTradingLeak(reply, payload = null) {
  const text = String(reply || '');
  const forbidden = [/\borb\b/i, /\btopstep\b/i, /\bentry window\b/i, /\bbest setup\b/i, /\bmomentum\s*10:15\b/i];
  for (const re of forbidden) {
    assert(!re.test(text), `unexpected trading token leak (${String(re)})`, { reply: text, ...(payload || {}) });
  }
}

async function runMatrixSurface(baseUrl) {
  let checked = 0;
  for (let i = 0; i < ENTITIES.length; i += 1) {
    const entity = ENTITIES[i];
    for (let j = 0; j < PHRASE_STYLES.length; j += 1) {
      const phrase = PHRASE_STYLES[j](entity);
      const sessionId = `localsearch-matrix-${i}-${j}`;
      const out = await jarvisQuery(baseUrl, buildVoiceBody(phrase, sessionId));
      assert(String(out.intent || '') === 'local_search', 'matrix intent mismatch', { phrase, out });
      assert(out?.consentPending === true, 'matrix should require consent', { phrase, out });
      assert(String(out?.consentKind || '') === 'location', 'matrix should request location first', { phrase, out });
      assert(Array.isArray(out?.toolsUsed) && out.toolsUsed.includes('Jarvis'), 'matrix should stay in Jarvis consent stage', { phrase, out });
      assert(/location|specific city|current location/i.test(String(out?.reply || '')), 'matrix location prompt missing', { phrase, out });
      checked += 1;
    }
  }
  assert(checked >= 200, 'matrix did not execute expected phrase volume', { checked });
  return checked;
}

async function runWalmartFlow(baseUrl) {
  const sessionId = 'localsearch-walmart-flow';
  const step1 = await jarvisQuery(baseUrl, buildVoiceBody("service where's the nearest Walmart", sessionId));
  assert(step1.consentPending === true && step1.consentKind === 'location', 'walmart step1 should ask location', { step1 });

  const step2 = await jarvisQuery(baseUrl, buildVoiceBody('you can use Newark New Jersey', sessionId));
  assert(step2.consentPending === true && step2.consentKind === 'web_search', 'walmart step2 should ask web confirm', { step2 });
  assert(/Newark,\s*NJ/i.test(String(step2.reply || '')), 'walmart step2 should normalize city', { step2 });

  const step3 = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionId));
  assert(String(step3.intent || '') === 'local_search', 'walmart step3 intent mismatch', { step3 });
  assert(Array.isArray(step3.toolsUsed) && step3.toolsUsed.includes('WebTool'), 'walmart step3 should run WebTool', { step3 });
  assert(/Here are the closest options/i.test(String(step3.reply || '')), 'walmart step3 should list options', { step3 });
  assert(step3.consentPending === true && step3.consentKind === 'web_directions_select', 'walmart step3 should move to selection', { step3 });
  assert(Array.isArray(step3.toolReceipts) && step3.toolReceipts.length > 0, 'walmart step3 should include receipt', { step3 });
  assert(step3.toolReceipts[0]?.result?.executed === true, 'walmart step3 receipt must show execution', { step3 });

  const step4 = await jarvisQuery(baseUrl, buildVoiceBody('the first one', sessionId));
  assert(step4.consentPending === true && step4.consentKind === 'web_directions_confirm', 'walmart step4 should ask directions confirm', { step4 });

  const step5 = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionId));
  assert(/google\.com\/maps\/search/i.test(String(step5.reply || '')), 'walmart step5 should provide directions link', { step5 });
  assert(step5.consentPending !== true, 'walmart step5 should clear pending state', { step5 });
}

async function runGasFlow(baseUrl) {
  const sessionId = 'localsearch-gas-flow';
  await jarvisQuery(baseUrl, buildVoiceBody('nearest gas station', sessionId));
  const step2 = await jarvisQuery(baseUrl, buildVoiceBody('use Newark NJ', sessionId));
  assert(step2.consentPending === true && step2.consentKind === 'web_search', 'gas step2 should ask web confirm', { step2 });
  const step3 = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionId));
  assert(Array.isArray(step3.toolsUsed) && step3.toolsUsed.includes('WebTool'), 'gas step3 should run web tool', { step3 });
  assert(/Here are the closest options/i.test(String(step3.reply || '')), 'gas step3 should return result list', { step3 });
}

async function runTopicShiftGuard(baseUrl) {
  const sessionId = 'localsearch-topic-shift';
  await jarvisQuery(baseUrl, buildVoiceBody('nearest coffee shop', sessionId));
  const unrelated = await jarvisQuery(baseUrl, buildVoiceBody('my perfect date would have been me and my date cupcake', sessionId));
  assert(String(unrelated.intent || '') === 'general_chat', 'topic shift should route to general_chat', { unrelated });
  assert(unrelated.topicShiftGuardTriggered === true, 'topic shift guard flag should be true', { unrelated });
  assert(/continue|switch topics/i.test(String(unrelated.reply || '')), 'topic shift message should ask continue/switch', { unrelated });
  assertNoTradingLeak(unrelated.reply, { unrelated });
}

async function runSessionDriftRecovery(baseUrl) {
  const clientId = 'localsearch-drift-client';
  const sessionA = 'localsearch-drift-a';
  const sessionB = 'localsearch-drift-b';

  await jarvisQuery(baseUrl, buildVoiceBody('nearest target in Newark NJ', sessionA, clientId));
  const recovered = await jarvisQuery(baseUrl, buildVoiceBody('yes', sessionB, clientId));
  assert(String(recovered.intent || '') === 'local_search', 'session drift intent mismatch', { recovered });
  assert(Array.isArray(recovered.toolsUsed) && recovered.toolsUsed.includes('WebTool'), 'session drift should execute WebTool', { recovered });
  assert(String(recovered.recoveredFromSessionId || '') === sessionA, 'session drift should recover previous session', { recovered });
  assert(recovered.pendingRecoveryUsed === true, 'session drift recovery flag missing', { recovered });

  const diag = await diagLatest(baseUrl, sessionB);
  assert(String(diag.intent || '') === 'local_search', 'diag intent mismatch for session drift', { diag });
  assert(Array.isArray(diag.toolsUsed) && diag.toolsUsed.includes('WebTool'), 'diag toolsUsed missing WebTool', { diag });
  assert(String(diag.recoveredFromSessionId || '') === sessionA, 'diag recoveredFromSessionId mismatch', { diag });
}

async function run() {
  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  const server = await startAuditServer({
    useExisting: false,
    env: {
      JARVIS_WEB_ENABLED: 'true',
      JARVIS_WEB_TOOL_MODE: 'real',
      JARVIS_WEB_ALLOW_NETWORK: 'true',
      JARVIS_TEST_PLACE_FIXTURE_MODE: 'ok',
    },
  });

  try {
    try {
      const checked = await runMatrixSurface(server.baseUrl);
      pass(`matrix entity coverage (${checked} phrases, ${ENTITIES.length} entities x ${PHRASE_STYLES.length} styles)`);
    } catch (err) {
      fail('matrix entity coverage', err);
    }

    try {
      await runWalmartFlow(server.baseUrl);
      pass('walmart local-search flow (location -> confirm -> results -> directions)');
    } catch (err) {
      fail('walmart local-search flow', err);
    }

    try {
      await runGasFlow(server.baseUrl);
      pass('gas station local-search flow (city -> confirm -> results)');
    } catch (err) {
      fail('gas station local-search flow', err);
    }

    try {
      await runTopicShiftGuard(server.baseUrl);
      pass('topic-shift guard prevents pending-flow hijack');
    } catch (err) {
      fail('topic-shift guard', err);
    }

    try {
      await runSessionDriftRecovery(server.baseUrl);
      pass('session drift recovery (session A pending -> session B yes)');
    } catch (err) {
      fail('session drift recovery', err);
    }
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`\nJarvis local-search matrix failed with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nJarvis local-search matrix passed.');
}

run().catch((err) => {
  console.error(`\nJarvis local-search matrix crashed: ${err.message}`);
  process.exit(1);
});
