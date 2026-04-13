#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  assertJarvisInvariants,
  assertNoLegacyTokens,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const INTEGRITY_LOOPS = Math.max(30, Math.min(50, Number(process.env.JARVIS_INTEGRITY_LOOPS || 30)));
const DEFAULT_TIMEOUT_MS = 22000;

function randomPick(list = []) {
  if (!Array.isArray(list) || list.length <= 0) return '';
  return list[Math.floor(Math.random() * list.length)];
}

function buildVoiceBody(message, options = {}) {
  const sessionId = String(options.sessionId || `jarvis-integrity-${Date.now()}`);
  const hint = String(options.hint || 'bridge');
  return {
    message: String(message || ''),
    strategy: 'original',
    activeModule: hint,
    contextHint: hint,
    voiceMode: true,
    voiceBriefMode: String(options.voiceBriefMode || 'earbud'),
    includeTrace: true,
    sessionId,
    clientId: sessionId,
    preferCachedLive: options.preferCachedLive === true,
    ...(options.auditMock && typeof options.auditMock === 'object' ? { auditMock: options.auditMock } : {}),
  };
}

async function jarvisQuery(baseUrl, body) {
  const out = await postJson(baseUrl, '/api/jarvis/query', body, DEFAULT_TIMEOUT_MS);
  assert(out?.success === true, 'jarvis query failed', { body, out });
  assert(out?.didFinalize === true, 'didFinalize must be true', { out });
  return out;
}

async function locationUpdate(baseUrl, body) {
  const out = await postJson(baseUrl, '/api/jarvis/location/update', body, DEFAULT_TIMEOUT_MS);
  assert(out?.ok === true, 'location update failed', { body, out });
  return out;
}

async function getDiagLatest(baseUrl, sessionId) {
  const url = `${baseUrl}/api/jarvis/diag/latest?sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = { raw: text };
  }
  assert(res.ok, 'diag latest failed', { sessionId, status: res.status, body: json });
  assert(json?.success === true, 'diag latest success=false', { sessionId, body: json });
  assert(json?.trace && typeof json.trace === 'object', 'diag latest trace missing', { sessionId, body: json });
  return json.trace;
}

function assertNoPreamble(label, reply, payload = null) {
  const text = String(reply || '').trim();
  const preamble = /^(let me check|i(?:'|’)ll check|i will check|one moment|hold on|give me a second|let me take a look|let me look|pulling|checking|scanning)\b/i;
  assert(!preamble.test(text), `${label} returned preamble-only opener`, {
    reply: text,
    ...(payload || {}),
  });
}

function assertEarbudSentenceShape(label, reply, payload = null) {
  const text = String(reply || '').trim();
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  assert(sentences.length <= 3, `${label} exceeds 3 sentences`, {
    sentenceCount: sentences.length,
    reply: text,
    ...(payload || {}),
  });
  assert(text.length <= 420, `${label} exceeds 420 chars`, {
    length: text.length,
    reply: text,
    ...(payload || {}),
  });
  assert(/^(I['’]d|I'd|You['’]re currently|You are currently)/i.test(sentences[0] || ''), `${label} sentence 1 is not stance-led`, {
    sentence1: sentences[0] || '',
    reply: text,
    ...(payload || {}),
  });
  assert(/^(Let['’]s|Let's)/i.test(sentences[1] || ''), `${label} sentence 2 must start with Let's`, {
    sentence2: sentences[1] || '',
    reply: text,
    ...(payload || {}),
  });
  assert(/^If\b/i.test(sentences[2] || ''), `${label} sentence 3 must start with If`, {
    sentence3: sentences[2] || '',
    reply: text,
    ...(payload || {}),
  });
}

function assertNoTradingLeak(label, reply, payload = null) {
  const text = String(reply || '');
  const forbidden = [
    /\borb\b/i,
    /\btopstep\b/i,
    /\b(?:don't trade|dont trade|do not trade)\b/i,
    /\bbest setup\b/i,
    /\bmomentum\s*10:15\b/i,
    /\b10:15\b/i,
    /\bentry window\b/i,
    /\brange is too wide\b/i,
    /\bchance of green day\b/i,
    /\bcontractid\b/i,
    /\bmnq price\b/i,
    /\bmarket pattern\b/i,
  ];
  for (const pattern of forbidden) {
    assert(!pattern.test(text), `${label} leaked forbidden trading token ${String(pattern)}`, {
      reply: text,
      ...(payload || {}),
    });
  }
}

function assertActionClaimHasReceipt(label, response, payload = null) {
  const reply = String(response?.reply || '');
  const toolReceipts = Array.isArray(response?.toolReceipts) ? response.toolReceipts : [];
  const claimsAction = /\b(i ran|i executed|i searched|i looked up|i found|confirmed\.|done\.)\b/i.test(reply);
  if (!claimsAction) return;
  assert(toolReceipts.length > 0, `${label} claimed action without tool receipt`, {
    reply,
    toolsUsed: response?.toolsUsed,
    ...(payload || {}),
  });
}

function buildFreshTradingAuditMock(nowTime = '09:50') {
  const today = '2026-03-04';
  return {
    nowEt: { date: today, time: nowTime },
    healthStatus: 'OK',
    riskInputs: {
      sessionDateEt: today,
      entryWindowStartEt: '09:30',
      entryWindowEndEt: '10:59',
      tradesTakenToday: 0,
      maxTradesPerDay: 2,
      dailyPnL: 50,
      dailyLossLimit: 500,
      trailingDrawdownDistance: 1000,
      blockedDataStale: false,
      readinessNeedsFreshData: false,
      marketDataFreshness: {
        hasTodaySessionBars: true,
        hasORBComplete: true,
        usedLiveBars: true,
        minutesSinceLastCandle: 1,
        nowEt: { date: today, time: nowTime },
        sessionDateOfData: today,
      },
    },
  };
}

async function scenarioCoffeePhoneFlow(baseUrl, loopCount) {
  const prompts = [
    'nearest coffee shop',
    'find coffee near me',
    'what is the nearest coffee shop',
    'nearby coffee shops',
  ];
  const yesPrompts = ['yes', 'go ahead', 'yes run it', 'do it'];
  for (let i = 0; i < loopCount; i += 1) {
    const sessionId = `integrity-coffee-phone-${i}`;
    const first = await jarvisQuery(baseUrl, buildVoiceBody(randomPick(prompts), { sessionId }));
    assert(['local_search', 'web_question'].includes(String(first.intent || '')), 'coffee(phone) intent mismatch', { first });
    assert(first.consentPending === true, 'coffee(phone) must be pending consent', { first });
    assert(['location', 'web_search'].includes(String(first.consentKind || '')), 'coffee(phone) invalid consent kind', { first });
    assertNoPreamble('coffee(phone)-first', first.reply);

    const selectPhone = await jarvisQuery(baseUrl, buildVoiceBody('use my phone location', { sessionId }));
    assert(['local_search', 'web_question'].includes(String(selectPhone.intent || '')), 'coffee(phone) select intent mismatch', { selectPhone });
    assert(selectPhone.consentPending === true, 'coffee(phone) must remain pending after location choice', { selectPhone });
    assertNoPreamble('coffee(phone)-select', selectPhone.reply);

    await locationUpdate(baseUrl, {
      sessionId,
      clientId: sessionId,
      lat: 40.7175,
      lon: -74.21,
      accuracy: 22,
      timestamp: new Date().toISOString(),
      source: 'android_web',
      consent: true,
    });

    const afterShare = await jarvisQuery(baseUrl, buildVoiceBody('yes', { sessionId }));
    let execute = afterShare;
    if (afterShare.consentPending === true) {
      const consentKind = String(afterShare.consentKind || '').trim().toLowerCase();
      if (consentKind === 'web_search') {
        assert(/run it now|look that up now|want me to run/i.test(String(afterShare.reply || '')), 'coffee(phone) missing run-now prompt', { afterShare });
        execute = await jarvisQuery(baseUrl, buildVoiceBody(randomPick(yesPrompts), { sessionId }));
      } else if (consentKind === 'web_directions_select') {
        // Search already executed and moved directly to post-results selection.
        execute = afterShare;
      } else {
        assert(false, 'coffee(phone) expected web_search or web_directions_select stage', { afterShare });
      }
    }
    assert(['local_search', 'web_question'].includes(String(execute.intent || '')), 'coffee(phone) execution intent mismatch', { execute, afterShare });
    assert(Array.isArray(execute.toolsUsed) && execute.toolsUsed.includes('WebTool'), 'coffee(phone) must use WebTool on execution', { execute });
    assertNoPreamble('coffee(phone)-execute', execute.reply);
    assertActionClaimHasReceipt('coffee(phone)-execute', execute);
    const warnings = Array.isArray(execute?.web?.warnings) ? execute.web.warnings : [];
    if (warnings.includes('web_stub_mode') || /stub mode/i.test(String(execute.reply || ''))) {
      assert(/did not run a real lookup|stub mode/i.test(String(execute.reply || '')), 'coffee(phone) stub must explicitly disclose non-live lookup', { execute });
    }
    const trace = await getDiagLatest(baseUrl, sessionId);
    assert(['local_search', 'web_question'].includes(String(trace.intent || '')), 'coffee(phone) trace intent mismatch', { trace });
    assert(Array.isArray(trace.toolsUsed) && trace.toolsUsed.includes('WebTool'), 'coffee(phone) trace missing WebTool', { trace });
  }
}

async function scenarioCoffeeCityFlow(baseUrl, loopCount) {
  const prompts = [
    'nearest coffee shop in Newark',
    'find coffee near Newark NJ',
    'closest coffee in Newark',
    'nearby coffee in Newark',
  ];
  const yesPrompts = ['yes', 'sure', 'go ahead', 'yes run it'];
  for (let i = 0; i < loopCount; i += 1) {
    const sessionId = `integrity-coffee-city-${i}`;
    const first = await jarvisQuery(baseUrl, buildVoiceBody(randomPick(prompts), { sessionId }));
    assert(['local_search', 'web_question'].includes(String(first.intent || '')), 'coffee(city) intent mismatch', { first });
    assert(first.consentPending === true, 'coffee(city) should await authorization', { first });
    assert(String(first.consentKind || '') === 'web_search', 'coffee(city) expected web_search consent', { first });
    assertNoPreamble('coffee(city)-first', first.reply);

    const runNow = await jarvisQuery(baseUrl, buildVoiceBody(randomPick(yesPrompts), { sessionId }));
    assert(['local_search', 'web_question'].includes(String(runNow.intent || '')), 'coffee(city) execution intent mismatch', { runNow });
    assert(Array.isArray(runNow.toolsUsed) && runNow.toolsUsed.includes('WebTool'), 'coffee(city) execution must use WebTool', { runNow });
    assertActionClaimHasReceipt('coffee(city)-execute', runNow);
    const warnings = Array.isArray(runNow?.web?.warnings) ? runNow.web.warnings : [];
    if (warnings.includes('web_stub_mode') || /stub mode/i.test(String(runNow.reply || ''))) {
      assert(/did not run a real lookup|stub mode/i.test(String(runNow.reply || '')), 'coffee(city) stub mode must be explicit', { runNow });
    }
    const trace = await getDiagLatest(baseUrl, sessionId);
    assert(['local_search', 'web_question'].includes(String(trace.intent || '')), 'coffee(city) trace intent mismatch', { trace });
  }
}

async function scenarioTradingInsideOutside(baseUrl, loopCount) {
  const prompts = [
    'should i take this setup now',
    'what should I do right now with my Trading',
    "how's it looking for my trading plan",
    "what's the gameplan today",
  ];
  for (let i = 0; i < loopCount; i += 1) {
    const insideSession = `integrity-trading-inside-${i}`;
    const insideBody = buildVoiceBody(randomPick(prompts), {
      sessionId: insideSession,
      hint: i % 2 === 0 ? 'bridge' : 'analyst',
      auditMock: buildFreshTradingAuditMock('09:50'),
    });
    const inside = await jarvisQuery(baseUrl, insideBody);
    assert(String(inside.intent || '').startsWith('trading_'), 'inside-window intent mismatch', { inside });
    assertNoLegacyTokens('inside-window', inside, insideBody);
    assertJarvisInvariants('inside-window', insideBody, inside);
    assertEarbudSentenceShape('inside-window', inside.reply, { routePath: inside.routePath });
    assert(!/outside (?:your )?entry window/i.test(String(inside.reply || '')), 'inside-window incorrectly flagged outside window', { inside });
    const insideTrace = await getDiagLatest(baseUrl, insideSession);
    assert(String(insideTrace.intent || '').startsWith('trading_'), 'inside-window trace intent mismatch', { insideTrace });

    const outsideSession = `integrity-trading-outside-${i}`;
    const outsideBody = buildVoiceBody(randomPick(prompts), {
      sessionId: outsideSession,
      hint: i % 2 === 0 ? 'lab' : 'bridge',
      auditMock: buildFreshTradingAuditMock('12:20'),
    });
    const outside = await jarvisQuery(baseUrl, outsideBody);
    assert(String(outside.intent || '').startsWith('trading_'), 'outside-window intent mismatch', { outside });
    assertNoLegacyTokens('outside-window', outside, outsideBody);
    assertJarvisInvariants('outside-window', outsideBody, outside);
    assertEarbudSentenceShape('outside-window', outside.reply, { routePath: outside.routePath });
    if (String(outside.precedenceMode || '') === 'health_block') {
      assert(/live market data|fresh (?:mnq )?bars|data (?:isn'?t|is not) healthy|health/i.test(String(outside.reply || '')), 'outside-window health-block path missing freshness reason', { outside });
    } else {
      assert(/outside (?:your )?entry window|outside entry window/i.test(String(outside.reply || '')), 'outside-window did not mention entry-window block', { outside });
    }
    const outsideTrace = await getDiagLatest(baseUrl, outsideSession);
    assert(String(outsideTrace.intent || '').startsWith('trading_'), 'outside-window trace intent mismatch', { outsideTrace });
  }
}

async function scenarioStaleGuard(baseUrl, loopCount) {
  for (let i = 0; i < loopCount; i += 1) {
    const sessionId = `integrity-stale-${i}`;
    const body = buildVoiceBody('should i take this setup now', {
      sessionId,
      hint: 'bridge',
      auditMock: {
        nowEt: { date: '2026-03-04', time: '09:52' },
        healthStatus: 'STALE',
        healthReason: 'Live bars stale in audit mock',
        riskInputs: {
          sessionDateEt: '2026-03-03',
          marketDataFreshness: {
            hasTodaySessionBars: false,
            hasORBComplete: false,
            usedLiveBars: false,
            minutesSinceLastCandle: 16,
            sessionDateOfData: '2026-03-03',
            nowEt: { date: '2026-03-04', time: '09:52' },
          },
        },
      },
    });
    const out = await jarvisQuery(baseUrl, body);
    assertNoLegacyTokens('stale-guard', out, body);
    assertJarvisInvariants('stale-guard', body, out);
    assertEarbudSentenceShape('stale-guard', out.reply, { routePath: out.routePath });
    assert(/fresh|stale|live market data (?:isn['’]?t|is not) healthy|don['’]?t have fresh/i.test(String(out.reply || '')), 'stale-guard missing freshness warning', { out });
    assert(!/\bopening range is\b|\borb range\b.*\d|\btrend:\b|\bmnq\s*(?:is|price)\s*\d/i.test(String(out.reply || '')), 'stale-guard leaked computed market claims', { out });
    assert(String(out?.decisionBlockedBy || '') === 'health' || String(out?.precedenceMode || '') === 'health_block', 'stale-guard should block by health', { out });
    const trace = await getDiagLatest(baseUrl, sessionId);
    assert(String(trace.healthStatusUsed || '').toUpperCase() === 'STALE' || String(trace.decisionBlockedBy || '').toLowerCase() === 'health', 'stale-guard trace missing health block evidence', { trace });
  }
}

async function scenarioGeneralChatFirewall(baseUrl, loopCount) {
  const prompts = [
    'its still dumb it just says anything',
    "its still dumb , it just says anything . I don't think I can win the girls to kids this year...",
    'this is frustrating and not helping me',
    'you are saying random stuff and i am annoyed',
  ];
  for (let i = 0; i < loopCount; i += 1) {
    const sessionId = `integrity-general-${i}`;
    const out = await jarvisQuery(baseUrl, buildVoiceBody(randomPick(prompts), { sessionId, hint: 'bridge' }));
    assert(['general_chat', 'unclear'].includes(String(out.intent || '')), 'general-chat intent mismatch', { out });
    if (String(out.intent || '') === 'general_chat') {
      assert(Array.isArray(out.toolsUsed) && out.toolsUsed.length === 1 && out.toolsUsed[0] === 'Jarvis', 'general-chat must stay on Jarvis tool only', { out });
    } else {
      assert(Array.isArray(out.toolsUsed) && out.toolsUsed.length === 0, 'unclear route should run no tools', { out });
    }
    assertNoTradingLeak('general-chat', out.reply, { routePath: out.routePath });
    assert(/not sure|want to talk about trading|something else|tell me one task/i.test(String(out.reply || '')), 'general-chat should clarify intent', { out });
    const trace = await getDiagLatest(baseUrl, sessionId);
    assert(['general_chat', 'unclear'].includes(String(trace.intent || '')), 'general-chat trace intent mismatch', { trace });
    if (String(trace.intent || '') === 'general_chat') {
      assert(Array.isArray(trace.toolsUsed) && trace.toolsUsed.length === 1 && trace.toolsUsed[0] === 'Jarvis', 'general-chat trace tools mismatch', { trace });
    }
  }
}

async function scenarioOsConfirmGate(baseUrl, loopCount) {
  const prompts = [
    'uninstall telegram',
    'uninstall telegram app',
    'uninstall telegram from my mac',
    'uninstall telegram now',
  ];
  for (let i = 0; i < loopCount; i += 1) {
    const sessionId = `integrity-os-${i}`;
    const body = buildVoiceBody(randomPick(prompts), { sessionId, hint: 'bridge' });
    const out = await jarvisQuery(baseUrl, body);
    assert(String(out.intent || '') === 'device_action', 'os-action intent mismatch', { out });
    assert(out.consentPending === true || out.confirmRequired === true, 'os-action must be confirm-gated', { out });
    assert(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('OS Agent'), 'os-action must route to OS Agent', { out });
    assert(/want me to run it now|confirm|high-risk|say yes|say confirm/i.test(String(out.reply || '')), 'os-action must request explicit confirmation', { out });
    assertActionClaimHasReceipt('os-action', out, { routePath: out.routePath });
    const trace = await getDiagLatest(baseUrl, sessionId);
    assert(String(trace.intent || '') === 'device_action', 'os-action trace intent mismatch', { trace });
  }
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 0,
  });
  let failures = 0;

  const scenarios = [
    { name: 'A) Coffee flow (no location known)', fn: () => scenarioCoffeePhoneFlow(server.baseUrl, INTEGRITY_LOOPS) },
    { name: 'B) Coffee flow (city only)', fn: () => scenarioCoffeeCityFlow(server.baseUrl, INTEGRITY_LOOPS) },
    { name: 'C) Trading decision inside vs outside window', fn: () => scenarioTradingInsideOutside(server.baseUrl, INTEGRITY_LOOPS) },
    { name: 'D) Stale market data guard', fn: () => scenarioStaleGuard(server.baseUrl, INTEGRITY_LOOPS) },
    { name: 'E) General chat firewall', fn: () => scenarioGeneralChatFirewall(server.baseUrl, INTEGRITY_LOOPS) },
    { name: 'F) OS action confirm gating', fn: () => scenarioOsConfirmGate(server.baseUrl, INTEGRITY_LOOPS) },
  ];

  try {
    for (const scenario of scenarios) {
      const started = Date.now();
      try {
        await scenario.fn();
        const ms = Date.now() - started;
        console.log(`✅ ${scenario.name} passed (${INTEGRITY_LOOPS} loops, ${ms}ms)`);
      } catch (err) {
        failures += 1;
        console.error(`❌ ${scenario.name} failed\n   ${err.message}`);
      }
    }
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`Jarvis integrity suite failed with ${failures} scenario group(s).`);
    process.exit(1);
  }
  console.log(`All jarvis integrity scenarios passed at ${INTEGRITY_LOOPS} loops per scenario.`);
}

run().catch((err) => {
  console.error('Jarvis integrity test crashed:', err);
  process.exit(1);
});
