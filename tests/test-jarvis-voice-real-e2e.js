#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  assertJarvisInvariants,
  assertNoLegacyTokens,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const DEFAULT_TIMEOUT_MS = 22000;

function getTodayEtDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return '2026-03-03';
  }
}

const TEST_ET_DATE = getTodayEtDate();

function buildBaseBody(message, opts = {}) {
  const sessionId = String(opts.sessionId || `jarvis-real-${Date.now()}`);
  const clientId = String(opts.clientId || sessionId);
  return {
    message,
    strategy: 'original',
    activeModule: String(opts.hint || 'bridge'),
    contextHint: String(opts.hint || 'bridge'),
    voiceMode: true,
    voiceBriefMode: 'earbud',
    includeTrace: true,
    preferCachedLive: false,
    sessionId,
    clientId,
    ...(opts.auditMock ? { auditMock: opts.auditMock } : {}),
  };
}

function isTradingIntent(intent) {
  const id = String(intent || '').trim().toLowerCase();
  return id.startsWith('trading_') || id === 'trend_regime';
}

function assertNoPreamble(label, reply, payload = null) {
  const text = String(reply || '').trim();
  const preamble = /^(let me check|i(?:'|’)ll check|i will check|one moment|hold on|give me a second|let me take a look|let me look|pulling|checking|scanning)\b/i;
  assert(!preamble.test(text), `${label} has preamble-only opener`, {
    reply: text,
    ...(payload || {}),
  });
}

function assertNoPre945FinalOrb(label, reply, payload = null) {
  const text = String(reply || '');
  const finalOrbPattern = /\b(?:orb|opening range)\b[\s\S]{0,40}\b(?:is|at)\s*\d+(?:\.\d+)?\s*ticks?\b/i;
  assert(!finalOrbPattern.test(text), `${label} claims final ORB range before 9:45`, {
    reply: text,
    ...(payload || {}),
  });
}

function assertEarbudCompact(label, reply, payload = null) {
  const text = String(reply || '').trim();
  const sentences = text ? text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean) : [];
  assert(text.length <= 420, `${label} exceeds 420 chars`, {
    length: text.length,
    reply: text,
    ...(payload || {}),
  });
  assert(sentences.length <= 3, `${label} exceeds 3 sentences`, {
    sentenceCount: sentences.length,
    reply: text,
    ...(payload || {}),
  });
}

function assertNoGeneralChatTradingTokens(label, reply, payload = null) {
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
  for (const re of forbidden) {
    assert(!re.test(text), `${label} leaked trading token ${re}`, {
      reply: text,
      ...(payload || {}),
    });
  }
}

async function jarvisQuery(baseUrl, body) {
  const out = await postJson(baseUrl, '/api/jarvis/query', body, DEFAULT_TIMEOUT_MS);
  assert(out?.success === true, 'jarvis query failed', { body, out });
  return out;
}

function normalAllowAuditMock(nowTime = '09:50', extra = {}) {
  return {
    nowEt: { date: TEST_ET_DATE, time: nowTime },
    healthStatus: 'OK',
    riskInputs: {
      sessionDateEt: TEST_ET_DATE,
      entryWindowStartEt: '09:30',
      entryWindowEndEt: '10:59',
      tradesTakenToday: 0,
      maxTradesPerDay: 2,
      dailyPnL: 100,
      dailyLossLimit: 500,
      trailingDrawdownDistance: 1000,
      minDrawdownBufferDollars: 250,
      blockedDataStale: false,
      readinessNeedsFreshData: false,
      marketDataFreshness: {
        hasTodaySessionBars: true,
        hasORBComplete: true,
        usedLiveBars: true,
        minutesSinceLastCandle: 1,
        nowEt: { date: TEST_ET_DATE, time: nowTime },
        sessionDateOfData: TEST_ET_DATE,
      },
      ...extra,
    },
  };
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3148,
  });

  const cases = [
    { message: 'was it a good day for me not to trade today', intent: 'trading_review', hint: 'bridge' },
    { message: 'I didn’t take a trade today was that a good decision', intent: 'trading_review', hint: 'analyst' },
    { message: 'should I take a trade tomorrow or sit out tomorrow', intent: 'trading_decision', hint: 'lab' },
    { message: 'what trend are we in right now', intent: 'trading_status', hint: 'bridge' },
    { message: 'what’s the gameplan today', intent: 'trading_plan', hint: 'bridge' },
    { message: "how's it looking for my trading plan", intent: 'trading_plan', hint: 'bridge' },
    { message: 'what should I do right now with my Trading', intent: 'trading_plan', hint: 'bridge' },
    { message: 'am i trading today', intent: 'trading_plan', hint: 'bridge' },
    { message: 'am i clear to trade today', intent: 'trading_decision', hint: 'bridge' },
    { message: 'should i be looking to take a trade today or sit out', intent: 'trading_decision', hint: 'bridge' },
    { message: 'was today a good day for me to not trade and stay out of the market', intent: 'trading_review', hint: 'analyst' },
    { message: "what's the morning outlook", intent: 'trading_plan', hint: 'bridge' },
    { message: 'how should i trade this morning', intent: 'trading_plan', hint: 'bridge' },
    { message: 'do we have fresh bars', intent: 'trading_status', hint: 'bridge' },
    { message: 'are we inside the entry window', intent: 'trading_status', hint: 'analyst' },
    { message: 'should i stay out today', intent: 'trading_decision', hint: 'bridge' },
    { message: 'should i sit out today', intent: 'trading_decision', hint: 'lab' },
    { message: 'should i take this setup now', intent: 'trading_decision', hint: 'bridge' },
    { message: 'should i enter now', intent: 'trading_execution_request', hint: 'bridge', confirmGate: true },
    { message: 'long or short right now', intent: 'trading_decision', hint: 'analyst' },
    { message: 'should i avoid the market today', intent: 'trading_decision', hint: 'lab' },
    { message: "what's today outlook", intent: 'trading_plan', hint: 'bridge' },
    { message: 'is this a good setup', intent: 'trading_decision', hint: 'bridge' },
    { message: "I'm long, what should I do", intent: 'trading_status', hint: 'bridge' },
    { message: "I'm short, what should I do", intent: 'trading_status', hint: 'bridge' },
    { message: 'what endpoint are you using for my voice requests right now?', intent: 'system_diag', hint: 'bridge', expectReplyContains: '/api/jarvis/query' },
    { message: 'enter a trade now', intent: 'trading_execution_request', hint: 'bridge', confirmGate: true },
    { message: 'close my position', intent: 'trading_execution_request', hint: 'bridge', confirmGate: true },
    { message: 'uninstall telegram', intent: 'device_action', hint: 'bridge', confirmGate: true },
    { message: "service where's the nearest walmart", intent: 'local_search', hint: 'bridge', webConsent: true },
    { message: 'nearest coffee shop', intent: 'local_search', hint: 'bridge', webConsent: true },
    { message: 'what time is it', intent: 'general_chat', hint: 'bridge', expectPattern: /\b(?:it is|current time|et)\b/i },
    { message: 'its still dumb it just says anything', intent: 'general_chat', hint: 'bridge' },
    { message: "its still dumb , it just says anything . I don't think I can win the girls to kids this year...", intent: 'general_chat', hint: 'bridge' },
    { message: 'the last two times , i was told to wait and not trade , if i would of traded i would have won.', intent: 'trading_hypothetical', hint: 'bridge' },
  ];

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  try {
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      const body = buildBaseBody(c.message, {
        hint: c.hint,
        sessionId: `jarvis-real-case-${i}`,
        auditMock: normalAllowAuditMock('09:50'),
      });
      try {
        const out = await jarvisQuery(server.baseUrl, body);
        assert(String(out.intent || '') === c.intent, 'intent mismatch', { expected: c.intent, got: out.intent, out });
        assert(out?.didFinalize === true, 'didFinalize must be true on every voice response', { out });
        assert(String(out?.selectedSkill || '').trim().length > 0, 'selectedSkill must be present', { out });
        assert(String(out?.decisionMode || '').trim().length > 0, 'decisionMode must be present', { out });
        assert(out?.consentState && typeof out.consentState === 'object', 'consentState must be present', { out });
        assert(Object.prototype.hasOwnProperty.call(out, 'skillState'), 'skillState key must be present', { out });
        assertNoPreamble(`real-case:${i}`, out.reply, { routePath: out.routePath, intent: out.intent });

        if (String(out.intent || '') !== 'general_chat') {
          assertEarbudCompact(`real-case:${i}`, out.reply, { routePath: out.routePath, intent: out.intent });
        }

        if (c.expectReplyContains) {
          assert(String(out.reply || '').toLowerCase().includes(String(c.expectReplyContains).toLowerCase()), 'expected reply substring missing', {
            expected: c.expectReplyContains,
            out,
          });
        }

        if (isTradingIntent(out.intent)) {
          assertJarvisInvariants(`real-case:${i}`, body, out);
          assertNoLegacyTokens(`real-case:${i}`, out, body);
        }
        if (String(out.intent || '') === 'general_chat') {
          assert(
            Array.isArray(out.toolsUsed)
              && out.toolsUsed.length === 1
              && out.toolsUsed[0] === 'Jarvis',
            'general chat should stay on Jarvis tool only',
            { out }
          );
          assertNoGeneralChatTradingTokens(`real-case:${i}`, out.reply, { routePath: out.routePath, intent: out.intent });
          if (c.expectPattern) {
            assert(c.expectPattern.test(String(out.reply || '')), 'general chat expected pattern missing', { out, expectPattern: String(c.expectPattern) });
          } else {
            assert(/not sure what you want|want to talk about trading|something else/i.test(String(out.reply || '')), 'general chat should ask for clarification', { out });
          }
        }

        if (c.confirmGate) {
          const txt = String(out.reply || '').toLowerCase();
          assert(out?.consentPending === true, 'confirm-gated action must remain pending', { out });
          assert(/\bconfirm\b/.test(txt) || /want me to/.test(txt), 'confirm-gated action must request authorization', { out });
        }

        if (c.webConsent) {
          assert(out?.consentPending === true, 'web question should require consent before execution', { out });
          assert(['location', 'web_search'].includes(String(out?.consentKind || '')), 'web consent kind mismatch', { out });
          assert(/location|look that up now|want me to look|want me to run it now/i.test(String(out?.reply || '')), 'web consent prompt missing', { out });
        }

        pass(`phrase ${i + 1}/${cases.length}: ${c.message}`);
      } catch (err) {
        fail(`phrase ${i + 1}/${cases.length}: ${c.message}`, err);
      }
    }

    const explainAliases = ['explain', 'why', 'details', 'what happened', "why can't i trade"];
    for (let i = 0; i < explainAliases.length; i += 1) {
      const sessionId = `jarvis-real-explain-${i}`;
      try {
        await jarvisQuery(server.baseUrl, buildBaseBody('should i take this setup now', {
          hint: 'bridge',
          sessionId,
          auditMock: {
            nowEt: { date: TEST_ET_DATE, time: '09:44' },
            healthStatus: 'OK',
            riskInputs: {
              sessionDateEt: TEST_ET_DATE,
              tradesTakenToday: 1,
              maxTradesPerDay: 1,
              dailyPnL: 10,
              dailyLossLimit: 500,
              trailingDrawdownDistance: 1000,
              blockedDataStale: false,
              readinessNeedsFreshData: false,
              marketDataFreshness: {
                hasTodaySessionBars: true,
                hasORBComplete: true,
                usedLiveBars: true,
                minutesSinceLastCandle: 1,
                nowEt: { date: TEST_ET_DATE, time: '09:44' },
                sessionDateOfData: TEST_ET_DATE,
              },
            },
          },
        }));

        const out = await jarvisQuery(server.baseUrl, buildBaseBody(explainAliases[i], {
          hint: 'bridge',
          sessionId,
          auditMock: normalAllowAuditMock('09:50'),
        }));

        assert(/blocked:/i.test(String(out.reply || '')), 'explain follow-up must return full blocked brief', { alias: explainAliases[i], out });
        pass(`explain alias: ${explainAliases[i]}`);
      } catch (err) {
        fail(`explain alias: ${explainAliases[i]}`, err);
      }
    }

    try {
      const sessionId = 'jarvis-real-web-consent-flow';
      const first = await jarvisQuery(server.baseUrl, buildBaseBody('nearest coffee shop', {
        hint: 'bridge',
        sessionId,
      }));
      assert(String(first.intent || '') === 'local_search', 'web consent flow first intent mismatch', { first });
      assert(first?.consentPending === true, 'web consent flow should start pending', { first });
      assertNoPreamble('web-consent-first', first.reply, { routePath: first.routePath });

      const city = await jarvisQuery(server.baseUrl, buildBaseBody('you can use Newark New Jersey', {
        hint: 'bridge',
        sessionId,
      }));
      assert(city?.consentPending === true, 'web consent flow city step should remain pending', { city });
      assert(city?.consentNeedLocation !== true, 'web consent flow city step should clear location-required', { city });
      assert(/Newark,\s*NJ/i.test(String(city?.reply || '')), 'web consent flow city step should normalize city', { city });
      assert(!/you can use/i.test(String(city?.reply || '')), 'web consent flow city step should not echo filler phrase', { city });
      assertNoPreamble('web-consent-city', city.reply, { routePath: city.routePath });

      const yes = await jarvisQuery(server.baseUrl, buildBaseBody('yes', {
        hint: 'bridge',
        sessionId,
      }));
      assert(String(yes.intent || '') === 'local_search', 'web consent flow yes intent mismatch', { yes });
      assert(Array.isArray(yes.toolsUsed) && yes.toolsUsed.includes('WebTool'), 'web consent flow yes must execute WebTool', { yes });
      assert(yes?.didFinalize === true, 'web consent flow yes must keep didFinalize true', { yes });
      assert(!/NJ,\s*NJ/i.test(String(yes?.reply || '')), 'web consent flow yes reply must not duplicate region token', { yes });
      const sourceCount = Array.isArray(yes?.web?.sources) ? yes.web.sources.length : 0;
      const receiptMode = String(yes?.toolReceipts?.[0]?.parameters?.mode || '').toLowerCase();
      if (sourceCount === 0) {
        const warnings = Array.isArray(yes?.web?.warnings) ? yes.web.warnings : [];
        const hasZeroResultsWarning = warnings.includes('provider_returned_zero_results');
        const hasProviderFailureWarning = warnings.includes('web_request_failed');
        assert(
          hasZeroResultsWarning || hasProviderFailureWarning,
          'web consent flow low/zero results must include provider warning',
          { yes, warnings, sourceCount }
        );
        if (hasZeroResultsWarning) {
          assert(/\b0 results\b/i.test(String(yes?.reply || '')), 'web consent flow low/zero results must be explicit', { yes, sourceCount });
        } else {
          assert(/provider request failed|try again/i.test(String(yes?.reply || '')), 'web consent provider failure must be explicit', { yes, sourceCount });
        }
      }
      assertNoPreamble('web-consent-yes', yes.reply, { routePath: yes.routePath });
      if (receiptMode === 'real' && sourceCount > 0) {
        assert(/want directions to one of these\?/i.test(String(yes?.reply || '')), 'web consent flow yes should offer directions follow-up in real mode', { yes });
        const firstOne = await jarvisQuery(server.baseUrl, buildBaseBody('the first one', {
          hint: 'bridge',
          sessionId,
        }));
        assert(String(firstOne.intent || '') === 'local_search', 'web directions selection intent mismatch', { firstOne });
        assert(firstOne?.consentPending === true, 'web directions selection should require confirmation', { firstOne });
        assert(String(firstOne?.consentKind || '') === 'web_directions_confirm', 'web directions selection should move to confirm stage', { firstOne });
        assert(/want me to open directions now/i.test(String(firstOne?.reply || '')), 'web directions selection should ask for confirmation', { firstOne });
        assertNoPreamble('web-consent-first-one', firstOne.reply, { routePath: firstOne.routePath });
      }
      pass('web consent 3-turn flow executes only after YES and keeps mode-aware follow-up');
    } catch (err) {
      fail('web consent 3-turn flow', err);
    }

    try {
      const sessionId = 'jarvis-real-web-consent-cancel';
      await jarvisQuery(server.baseUrl, buildBaseBody('nearest coffee shop', {
        hint: 'bridge',
        sessionId,
      }));
      const no = await jarvisQuery(server.baseUrl, buildBaseBody('no', {
        hint: 'bridge',
        sessionId,
      }));
      assert(no?.consentPending !== true, 'web cancel should clear pending state', { no });
      assert(/no problem|didn['’]?t run|ask again/i.test(String(no?.reply || '')), 'web cancel reply should acknowledge cancellation', { no });
      pass('web consent cancel flow works');
    } catch (err) {
      fail('web consent cancel flow', err);
    }

    try {
      const sharedClient = 'jarvis-real-recovery-client';
      await jarvisQuery(server.baseUrl, buildBaseBody('nearest coffee shop in Newark NJ', {
        hint: 'bridge',
        sessionId: 'jarvis-real-recovery-a',
        clientId: sharedClient,
      }));
      const recovered = await jarvisQuery(server.baseUrl, buildBaseBody('yes', {
        hint: 'bridge',
        sessionId: 'jarvis-real-recovery-b',
        clientId: sharedClient,
      }));
      assert(String(recovered.intent || '') === 'local_search', 'pending recovery intent mismatch', { recovered });
      assert(Array.isArray(recovered.toolsUsed) && recovered.toolsUsed.includes('WebTool'), 'pending recovery should execute web lookup', { recovered });
      assert(String(recovered.recoveredFromSessionId || '') === 'jarvis-real-recovery-a', 'pending recovery should disclose recovered session', { recovered });
      pass('pending-action recovery executes yes/no using same client');
    } catch (err) {
      fail('pending-action recovery yes/no', err);
    }

    try {
      const sessionId = 'jarvis-real-topic-shift-guard';
      const first = await jarvisQuery(server.baseUrl, buildBaseBody('nearest coffee shop in Newark NJ', {
        hint: 'bridge',
        sessionId,
      }));
      assert(first?.consentPending === true, 'topic-shift test should start with pending consent', { first });
      const yes = await jarvisQuery(server.baseUrl, buildBaseBody('yes', {
        hint: 'bridge',
        sessionId,
      }));
      if (String(yes?.consentKind || '') === 'web_directions_select') {
        const unrelated = await jarvisQuery(server.baseUrl, buildBaseBody('my perfect date would have been me and my date cupcake', {
          hint: 'bridge',
          sessionId,
        }));
        assert(String(unrelated.intent || '') === 'general_chat', 'topic-shift unrelated phrase should route to general_chat', { unrelated });
        assert(unrelated.topicShiftGuardTriggered === true, 'topic-shift guard flag should be true', { unrelated });
        assertNoGeneralChatTradingTokens('topic-shift-guard', unrelated.reply, { unrelated });
        assert(!/\b(coffee|directions|flor de maria)\b/i.test(String(unrelated?.reply || '')), 'topic-shift guard should not leak coffee/directions content', { unrelated });
      }
      pass('pending-flow firewall prevents unrelated chat hijack');
    } catch (err) {
      fail('pending-flow firewall unrelated chat', err);
    }

    try {
      const staleBody = buildBaseBody('what trend are we in right now', {
        hint: 'bridge',
        sessionId: 'jarvis-real-stale',
        auditMock: {
          nowEt: { date: TEST_ET_DATE, time: '09:52' },
          healthStatus: 'STALE',
          healthReason: 'Topstep bars are stale (12m old).',
          riskInputs: {
            tradesTakenToday: 0,
            maxTradesPerDay: 2,
            dailyPnL: 5,
            dailyLossLimit: 500,
            trailingDrawdownDistance: 1000,
          },
        },
      });
      const staleOut = await jarvisQuery(server.baseUrl, staleBody);
      assert(String(staleOut.precedenceMode || '') === 'health_block', 'stale case must force health_block', { staleOut });
      assertNoPreamble('stale-case', staleOut.reply, { routePath: staleOut.routePath });
      assert(!/\b(Trend:|Regime:|opening range is|ORB range is)\b/i.test(String(staleOut.reply || '')), 'stale case must not claim trend/ORB analysis', { staleOut });
      assert(String(staleOut.healthStatusUsed || staleOut.healthStatus || '').toUpperCase() === 'STALE', 'stale case must report stale health status used', { staleOut });
      assert(String(staleOut.decisionBlockedBy || '').toLowerCase() === 'health', 'stale case must be blocked by health', { staleOut });
      pass('stale-data gate: health_block + no stale claims');
    } catch (err) {
      fail('stale-data gate', err);
    }

    try {
      const preBody = buildBaseBody("what's the gameplan today", {
        hint: 'bridge',
        sessionId: 'jarvis-real-pre945',
        auditMock: {
          nowEt: { date: TEST_ET_DATE, time: '09:35' },
          healthStatus: 'OK',
          riskInputs: {
            sessionDateEt: TEST_ET_DATE,
            tradesTakenToday: 0,
            maxTradesPerDay: 2,
            dailyPnL: 100,
            dailyLossLimit: 500,
            trailingDrawdownDistance: 1000,
            blockedDataStale: false,
            readinessNeedsFreshData: false,
            marketDataFreshness: {
              hasTodaySessionBars: true,
              hasORBComplete: false,
              usedLiveBars: true,
              minutesSinceLastCandle: 1,
              nowEt: { date: TEST_ET_DATE, time: '09:35' },
              sessionDateOfData: TEST_ET_DATE,
            },
          },
        },
      });
      const preOut = await jarvisQuery(server.baseUrl, preBody);
      assertJarvisInvariants('pre945-case', preBody, preOut);
      assertNoPre945FinalOrb('pre945-case', preOut.reply, { out: preOut });
      pass('pre-9:45 gate: no final ORB claim');
    } catch (err) {
      fail('pre-9:45 gate', err);
    }

    try {
      const insideBody = buildBaseBody('should i take this setup now', {
        hint: 'bridge',
        sessionId: 'jarvis-real-inside-window',
        auditMock: normalAllowAuditMock('09:52', {
          sessionDateEt: TEST_ET_DATE,
          tradesTakenToday: 0,
          maxTradesPerDay: 2,
          dailyPnL: 120,
          dailyLossLimit: 500,
          blockedDataStale: false,
          readinessNeedsFreshData: false,
          marketDataFreshness: {
            hasTodaySessionBars: true,
            hasORBComplete: true,
            usedLiveBars: true,
            minutesSinceLastCandle: 1,
            nowEt: { date: TEST_ET_DATE, time: '09:52' },
            sessionDateOfData: TEST_ET_DATE,
          },
        }),
      });
      const insideOut = await jarvisQuery(server.baseUrl, insideBody);
      assertNoPreamble('inside-window-case', insideOut.reply, { routePath: insideOut.routePath });
      assert(!/\boutside\b[\s\S]{0,40}\bentry window\b/i.test(String(insideOut.reply || '')), 'inside-window case must not claim outside entry window', { insideOut });
      assert(String(insideOut.timePhase || '').trim().length > 0, 'inside-window case should expose timePhase', { insideOut });
      pass('inside-window gate: no outside-window leak');
    } catch (err) {
      fail('inside-window gate', err);
    }

    try {
      const outsideBody = buildBaseBody('should i take this setup now', {
        hint: 'bridge',
        sessionId: 'jarvis-real-outside-window',
        auditMock: {
          nowEt: { date: TEST_ET_DATE, time: '11:12' },
          healthStatus: 'OK',
          riskInputs: {
            sessionDateEt: TEST_ET_DATE,
            entryWindowStartEt: '09:30',
            entryWindowEndEt: '10:59',
            tradesTakenToday: 0,
            maxTradesPerDay: 2,
            dailyPnL: 20,
            dailyLossLimit: 500,
            trailingDrawdownDistance: 1000,
            blockedDataStale: false,
            readinessNeedsFreshData: false,
            marketDataFreshness: {
              hasTodaySessionBars: true,
              hasORBComplete: true,
              usedLiveBars: true,
              minutesSinceLastCandle: 1,
              nowEt: { date: TEST_ET_DATE, time: '11:12' },
              sessionDateOfData: TEST_ET_DATE,
            },
          },
        },
      });
      const outsideOut = await jarvisQuery(server.baseUrl, outsideBody);
      assertNoPreamble('outside-window-case', outsideOut.reply, { routePath: outsideOut.routePath });
      assert(/\boutside\b[\s\S]{0,40}\bentry window\b/i.test(String(outsideOut.reply || '')), 'outside-window case should mention outside entry window', { outsideOut });
      assert(
        String(outsideOut.decisionBlockedBy || '').toLowerCase() === 'risk'
        || String(outsideOut.precedenceMode || '').toLowerCase() === 'risk_block',
        'outside-window case should be risk-blocked',
        { outsideOut }
      );
      pass('outside-window gate: allowed only when actually outside');
    } catch (err) {
      fail('outside-window gate', err);
    }

    if (failures > 0) {
      console.error(`\nJarvis real voice e2e failed with ${failures} failure(s).`);
      process.exit(1);
    }

    console.log('\nJarvis real voice e2e passed (Phase 3A).');
  } finally {
    await server.stop();
  }
}

run().catch((err) => {
  console.error(`\nJarvis real voice e2e crashed: ${err.message}`);
  process.exit(1);
});
