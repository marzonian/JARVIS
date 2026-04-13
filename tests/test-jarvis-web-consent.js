#!/usr/bin/env node
/* eslint-disable no-console */
const http = require('http');
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');
const { normalizeCityInput } = require('../server/jarvis-core/consent');
const { buildDisplayLocation, runWebTool } = require('../server/tools/webTool');

const DEFAULT_TIMEOUT_MS = 45000;

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

function assertNoPreamble(label, text) {
  const src = String(text || '').trim();
  const preamble = /^(let me check|i(?:'|’)ll check|i will check|one moment|hold on|give me a second|let me take a look|let me look|pulling|checking|scanning)\b/i;
  assert(!preamble.test(src), `${label} returned preamble-only response`, { reply: src });
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3149,
    env: {
      JARVIS_WEB_TOOL_MODE: 'stub',
      JARVIS_WEB_ALLOW_NETWORK: 'false',
      JARVIS_WEB_ENABLED: 'true',
    },
  });

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  try {
    const knownRegionCases = [
      'Use Newark NJ',
      'you can use Newark New Jersey',
      'Newark NJ',
      'Newark, NJ',
      'near Newark NJ',
      'Newark New Jersey',
    ];
    for (const value of knownRegionCases) {
      const out = normalizeCityInput(value);
      assert(out.matched === true, `normalizeCityInput must match "${value}"`, { value, out });
      assert(out.needsClarification !== true, `normalizeCityInput should not ask clarification for "${value}"`, { value, out });
      assert(String(out.locationHint?.city || '') === 'Newark, NJ', `normalizeCityInput canonical city mismatch for "${value}"`, { value, out });
    }

    const ambiguousCases = ['use Newark', 'in Newark', 'my city is Newark', 'just Newark'];
    for (const value of ambiguousCases) {
      const out = normalizeCityInput(value);
      assert(out.matched === true, `normalizeCityInput must match ambiguous "${value}"`, { value, out });
      assert(out.needsClarification === true, `normalizeCityInput should request clarification for "${value}"`, { value, out });
      assert(Array.isArray(out.options) && out.options.includes('NJ') && out.options.includes('DE'), `normalizeCityInput options missing for "${value}"`, { value, out });
    }

    const knownRegionOut = normalizeCityInput('use Newark', { knownRegion: 'NJ' });
    assert(knownRegionOut.needsClarification !== true, 'knownRegion should resolve ambiguous Newark without clarification', { knownRegionOut });
    assert(String(knownRegionOut.locationHint?.city || '') === 'Newark, NJ', 'knownRegion should normalize to Newark, NJ', { knownRegionOut });
    pass('normalizeCityInput handles city formats and ambiguity rules');
  } catch (err) {
    fail('normalizeCityInput unit cases', err);
  }

  try {
    const display = buildDisplayLocation({
      city: 'Newark, NJ',
      region: 'NJ',
      country: 'US',
    });
    assert(display === 'Newark, NJ, US', 'display location should dedupe duplicate region token', { display });
    assert(!/NJ,\s*NJ/i.test(display), 'display location should never duplicate region token', { display });
    pass('buildDisplayLocation dedupes duplicate region tokens');
  } catch (err) {
    fail('buildDisplayLocation dedupe', err);
  }

  try {
    const stubOut = await runWebTool({
      message: 'nearest coffee shop',
      queryUsed: 'nearest coffee shop',
      locationRequired: true,
      userLocationHint: { city: 'Newark, NJ', region: 'NJ', country: 'US' },
      webEnabled: true,
      allowNetwork: true,
      webMode: 'stub',
      maxSources: 5,
    });
    const reply = String(stubOut?.data?.answer || stubOut?.narrative?.stance || '');
    assert(/stub mode/i.test(reply), 'stub reply must explicitly mention stub mode', { stubOut, reply });
    assert(!/\bi ran the lookup\b/i.test(reply), 'stub reply must not claim it ran lookup', { stubOut, reply });
    pass('stub mode is explicit and does not claim live execution');
  } catch (err) {
    fail('stub mode honesty', err);
  }

  try {
    const proxyServer = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const body = JSON.stringify({
          answer: 'Here are nearby coffee shops.',
          sources: [
            {
              title: 'Cafe One',
              snippet: 'Downtown Newark',
              url: 'https://example.com/cafe-one',
              distanceKm: 1.2,
            },
          ],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const addr = proxyServer.address();
    const proxyUrl = `http://127.0.0.1:${addr.port}`;
    const out = await runWebTool({
      message: 'nearest coffee shop',
      queryUsed: 'nearest coffee shop',
      locationRequired: true,
      userLocationHint: { city: 'Newark, NJ', region: 'NJ', country: 'US' },
      webEnabled: true,
      allowNetwork: true,
      webMode: 'real',
      webToolUrl: proxyUrl,
      forceProxy: true,
      maxSources: 5,
    });
    await new Promise((resolve) => proxyServer.close(resolve));
    const warnings = Array.isArray(out?.warnings) ? out.warnings : [];
    const reply = String(out?.data?.answer || out?.narrative?.stance || '');
    assert(warnings.some((w) => /^missing_address:/i.test(String(w))), 'provider missing-address warning should be included in warnings/receipts', { out, warnings });
    assert(!/missing_address:/i.test(reply), 'reply should stay clean without internal warning tokens', { out, reply });
    pass('missing-address provider warnings are recorded without polluting reply');
  } catch (err) {
    fail('missing-address warning path', err);
  }

  try {
    const sessionLocal = `jarvis-web-local-${Date.now()}`;
    try {
      const firstLocal = await postJson(server.baseUrl, '/api/jarvis/query', buildBody("service where's the nearest walmart", sessionLocal), DEFAULT_TIMEOUT_MS);
      assert(firstLocal?.success === true, 'local-search request failed', { firstLocal });
      assert(String(firstLocal.intent || '') === 'local_search', 'local-search intent mismatch', { firstLocal });
      assert(firstLocal?.consentPending === true, 'local-search should require consent', { firstLocal });
      const receipt = Array.isArray(firstLocal?.toolReceipts) ? firstLocal.toolReceipts[0] : null;
      const normalizedInReceipt = String(receipt?.parameters?.query || '').trim();
      assert(/walmart/i.test(normalizedInReceipt), 'local-search should pass normalized query to consent stage', { firstLocal, receipt });
      pass("service where's the nearest walmart routes to local_search consent");
    } catch (err) {
      fail('local_search walmart consent start', err);
    }

    const sessionA = `jarvis-web-consent-a-${Date.now()}`;
    try {
      const first = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('nearest coffee shop', sessionA), DEFAULT_TIMEOUT_MS);
      assert(first?.success === true, 'first request failed', { first });
      assert(String(first.intent || '') === 'local_search', 'intent mismatch on first request', { first });
      assert(first?.consentPending === true, 'web consent should be pending', { first });
      assert(first?.consentKind === 'location', 'consent kind mismatch', { first });
      assert(first?.consentNeedLocation === true, 'location should be required', { first });
      assert(/use your current location|specific city/i.test(String(first.reply || '')), 'first reply should request location', { first });
      assert(Array.isArray(first?.toolReceipts) && first.toolReceipts.length > 0, 'first response should include consent receipt', { first });
      assert(first?.didFinalize === true, 'didFinalize should always be true', { first });
      assertNoPreamble('first request', first.reply);
      pass('nearest coffee shop requests location and sets pending consent');

      const city = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('you can use Newark New Jersey', sessionA), DEFAULT_TIMEOUT_MS);
      assert(city?.success === true, 'city request failed', { city });
      assert(city?.consentPending === true, 'consent should remain pending after city', { city });
      assert(city?.consentKind === 'web_search', 'consent kind should remain web_search', { city });
      assert(city?.consentNeedLocation === false, 'location requirement should be cleared', { city });
      assert(/Newark,\s*NJ/i.test(String(city.reply || '')), 'city reply should show normalized canonical city', { city });
      assert(!/you can use/i.test(String(city.reply || '')), 'city reply must not echo filler prefix', { city });
      assert(/want me to (look that up|run it) now/i.test(String(city.reply || '')), 'city reply should ask for authorization', { city });
      assert(city?.didFinalize === true, 'didFinalize should always be true after city', { city });
      assertNoPreamble('city request', city.reply);
      pass('city follow-up transitions to yes/no authorization step');

      const yes = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('yes', sessionA), DEFAULT_TIMEOUT_MS);
      assert(yes?.success === true, 'yes request failed', { yes });
      assert(String(yes.intent || '') === 'local_search', 'intent mismatch on yes', { yes });
      assert(Array.isArray(yes?.toolsUsed) && yes.toolsUsed.includes('WebTool'), 'yes should execute WebTool', { yes });
      const normalizedCityUsed = String(yes?.web?.locationUsed?.city || yes?.toolReceipts?.[0]?.parameters?.locationUsed?.city || '');
      assert(!normalizedCityUsed || /Newark,\s*NJ/i.test(normalizedCityUsed), 'yes step should use normalized city when available', { yes, normalizedCityUsed });
      const webLocationDisplay = String(yes?.reply || '');
      assert(!/NJ,\s*NJ/i.test(webLocationDisplay), 'yes reply should not contain duplicate region token', { yes });
      const sourceCount = Array.isArray(yes?.web?.sources) ? yes.web.sources.length : 0;
      const warnings = Array.isArray(yes?.web?.warnings) ? yes.web.warnings : [];
      const providerFailed = warnings.includes('web_request_failed');
      const receiptMode = String(yes?.toolReceipts?.[0]?.parameters?.mode || '').toLowerCase();
      if (providerFailed) {
        assert(/request failed|not available|try again/i.test(String(yes?.reply || '')), 'provider failure should be explicit', { yes });
        assert(yes?.consentPending !== true, 'directions selection should not remain pending on provider failure', { yes });
      } else {
        if (receiptMode === 'real' && sourceCount > 0) {
          assert(/want directions to one of these\?/i.test(String(yes?.reply || '')), 'yes response should ask for directions follow-up', { yes });
          assert(/1\)\s+.+\s—\s+[0-9.]+\s+km\s—\s+.+/i.test(String(yes?.reply || '')), 'result formatting should include name, distance, and address', { yes });
        }
        if (sourceCount === 0) {
          assert(warnings.includes('provider_returned_zero_results'), 'real mode low/zero results must include provider warning', { yes, warnings, sourceCount });
          assert(/couldn['’]?t find|no strong matches|try again/i.test(String(yes?.reply || '')), 'zero-result reply should be explicit and honest', { yes });
        }
        if (receiptMode === 'real' && sourceCount > 0) {
          assert(yes?.consentPending === true, 'directions selection should be pending after yes when real results are returned', { yes });
          assert(String(yes?.consentKind || '') === 'web_directions_select', 'directions selection kind mismatch after yes', { yes });
        } else {
          assert(yes?.consentPending !== true, 'directions selection should not be pending in stub/no-result mode', { yes });
        }
      }
      assert(yes?.didFinalize === true, 'didFinalize should always be true after yes', { yes });
      assertNoPreamble('yes request', yes.reply);
      pass('yes executes WebTool and applies mode-aware follow-up stage');

      if (!providerFailed && receiptMode === 'real' && sourceCount > 0) {
        const firstOne = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('the first one', sessionA), DEFAULT_TIMEOUT_MS);
        assert(firstOne?.success === true, 'directions selection request failed', { firstOne });
        assert(String(firstOne.intent || '') === 'local_search', 'directions selection intent mismatch', { firstOne });
        assert(firstOne?.consentPending === true, 'directions selection should require confirmation', { firstOne });
        assert(String(firstOne?.consentKind || '') === 'web_directions_confirm', 'directions selection should move to confirm stage', { firstOne });
        assert(/want me to open directions now/i.test(String(firstOne?.reply || '')), 'directions selection should ask for confirmation', { firstOne });
        const selectReceipt = Array.isArray(firstOne?.toolReceipts) ? firstOne.toolReceipts[0] : null;
        assert(selectReceipt?.result?.executed === false, 'directions selection should not execute before confirm', { firstOne, selectReceipt });
        pass('the first one triggers directions confirm flow without execution');
      }
    } catch (err) {
      fail('web consent happy path', err);
    }

    const sessionD = `jarvis-web-consent-d-${Date.now()}`;
    try {
      await postJson(server.baseUrl, '/api/jarvis/query', buildBody('nearest coffee shop', sessionD), DEFAULT_TIMEOUT_MS);
      await postJson(server.baseUrl, '/api/jarvis/query', buildBody('use Newark New Jersey', sessionD), DEFAULT_TIMEOUT_MS);
      const yesD = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('yes', sessionD), DEFAULT_TIMEOUT_MS);
      const receiptModeD = String(yesD?.toolReceipts?.[0]?.parameters?.mode || '').toLowerCase();
      const sourceCountD = Array.isArray(yesD?.web?.sources) ? yesD.web.sources.length : 0;
      if (receiptModeD === 'real' && sourceCountD > 0) {
        const firstTitle = String(yesD?.web?.sources?.[0]?.title || '').trim();
        const normalizedTitles = (yesD?.web?.sources || []).map((row) => String(row?.title || '')
          .normalize('NFKD')
          .replace(/[^\x00-\x7F]/g, ' ')
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim());
        const firstTitleNorm = String(firstTitle || '')
          .normalize('NFKD')
          .replace(/[^\x00-\x7F]/g, ' ')
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const firstTokens = firstTitleNorm.split(/\s+/).filter((tok) => tok.length >= 4);
        let byNamePrompt = firstTokens.find((tok) => {
          const matches = normalizedTitles.filter((title) => title.split(/\s+/).includes(tok)).length;
          return matches === 1;
        }) || '';
        if (!byNamePrompt) {
          byNamePrompt = firstTitle || 'the first one';
        }
        const byName = await postJson(server.baseUrl, '/api/jarvis/query', buildBody(byNamePrompt, sessionD), DEFAULT_TIMEOUT_MS);
        assert(byName?.success === true, 'name-based directions selection request failed', { byName });
        assert(String(byName.intent || '') === 'local_search', 'name-based directions selection intent mismatch', { byName });
        assert(byName?.consentPending === true, 'name-based directions selection should require confirmation', { byName });
        assert(String(byName?.consentKind || '') === 'web_directions_confirm', 'name-based directions should move to confirm stage', { byName });
        assert(/want me to open directions now/i.test(String(byName?.reply || '')), 'name-based directions selection should ask for confirmation', { byName });
        pass('name-based directions follow-up is accepted');
      } else {
        pass('name-based directions follow-up skipped in stub/no-result mode');
      }
    } catch (err) {
      fail('name-based directions follow-up', err);
    }

    const sessionB = `jarvis-web-consent-b-${Date.now()}`;
    try {
      const first = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('nearest coffee shop', sessionB), DEFAULT_TIMEOUT_MS);
      assert(first?.consentPending === true, 'cancel path should start with pending consent', { first });

      const no = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('no', sessionB), DEFAULT_TIMEOUT_MS);
      assert(no?.success === true, 'no request failed', { no });
      assert(no?.consentPending !== true, 'consent should be cleared after no', { no });
      assert(/no problem|didn['’]?t run|tell me the city/i.test(String(no.reply || '')), 'no response should cancel and acknowledge', { no });
      assertNoPreamble('no request', no.reply);
      pass('no cancels pending web search consent');
    } catch (err) {
      fail('web consent cancel path', err);
    }

    const sessionC = `jarvis-web-consent-c-${Date.now()}`;
    try {
      const first = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('search the web for MNQ liquidity news', sessionC), DEFAULT_TIMEOUT_MS);
      assert(first?.consentPending === true, 'alias path should begin with pending consent', { first });
      const yesAlias = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('go ahead', sessionC), DEFAULT_TIMEOUT_MS);
      assert(Array.isArray(yesAlias?.toolsUsed) && yesAlias.toolsUsed.includes('WebTool'), 'yes alias should execute WebTool', { yesAlias });
      pass('yes alias executes pending web search');

      const secondSession = `${sessionC}-cancel`;
      await postJson(server.baseUrl, '/api/jarvis/query', buildBody('search the web for futures opening bell times', secondSession), DEFAULT_TIMEOUT_MS);
      const noAlias = await postJson(server.baseUrl, '/api/jarvis/query', buildBody('nope', secondSession), DEFAULT_TIMEOUT_MS);
      assert(noAlias?.consentPending !== true, 'no alias should clear consent pending state', { noAlias });
      pass('no alias cancels pending web search');
    } catch (err) {
      fail('web consent yes/no alias path', err);
    }
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`\nJarvis web consent test failed with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nJarvis web consent test passed.');
}

run().catch((err) => {
  console.error(`\nJarvis web consent test crashed: ${err.message}`);
  process.exit(1);
});
