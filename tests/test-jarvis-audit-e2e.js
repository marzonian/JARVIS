#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  assertJarvisInvariants,
  assertNoLegacyTokens,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const DEFAULT_TIMEOUT_MS = 20000;
const EXACT_FAILING_PHRASE = 'was it a good day for me not to trade today';
const AUDIT_BASELINE = {
  nowEt: { date: '2026-03-04', time: '09:50' },
  healthStatus: 'OK',
  riskInputs: {
    sessionDateEt: '2026-03-04',
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
      nowEt: { date: '2026-03-04', time: '09:50' },
      sessionDateOfData: '2026-03-04',
    },
  },
};

function assertNoForbiddenLeakTokens(label, text, context = {}) {
  const src = String(text || '');
  const blockedPatterns = [
    { token: "DON'T TRADE", re: /\bDON['’]?T TRADE\b/i },
    { token: 'WAIT', re: /(?:^|\s)WAIT(?:\b|[.:\]])/ },
    { token: 'TRADE', re: /^\s*TRADE(?:\b|[.:\]])/m },
    { token: 'Why:', re: /\bWhy:\b/i },
    { token: 'Best setup', re: /\bBest setup\b/i },
  ];
  for (const p of blockedPatterns) {
    assert(!p.re.test(src), `${label} contains forbidden token ${p.token}`, {
      reply: src,
      ...context,
    });
  }
}

function buildJarvisBody(message, options = {}) {
  const hint = String(options.hint || 'bridge');
  return {
    message,
    strategy: String(options.strategy || 'original'),
    activeModule: hint,
    contextHint: hint,
    voiceMode: options.voiceMode !== false,
    voiceBriefMode: String(options.voiceBriefMode || 'earbud'),
    preferCachedLive: options.preferCachedLive === true,
    includeTrace: true,
    sessionId: String(options.sessionId || `jarvis-e2e-${Date.now()}`),
    clientId: String(options.clientId || options.sessionId || `jarvis-e2e-${Date.now()}`),
    ...(options.auditMock ? { auditMock: options.auditMock } : {}),
  };
}

async function jarvisQuery(baseUrl, message, options = {}) {
  const body = buildJarvisBody(message, options);
  const out = await postJson(baseUrl, '/api/jarvis/query', body, DEFAULT_TIMEOUT_MS);
  assert(out?.success === true, 'jarvis query did not return success', { message, out });
  assert(Array.isArray(out?.toolsUsed) && out.toolsUsed.length > 0, 'toolsUsed missing', { message, out });
  return { body, out };
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3141,
  });

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  try {
    const scenarios = [
      { message: 'was it a good day for me not to trade today', expectedIntent: 'trading_review', hint: 'bridge' },
      { message: 'was today a good day to stay out of the market', expectedIntent: 'trading_decision', hint: 'analyst' },
      { message: 'should i take this setup now', expectedIntent: 'trading_decision', hint: 'lab' },
      { message: 'should i sit out today', expectedIntent: 'trading_decision', hint: 'bridge' },
      { message: 'what trend are we in right now', expectedIntent: 'trading_status', hint: 'bridge' },
      { message: "what's the plan today", expectedIntent: 'trading_plan', hint: 'bridge' },
      { message: "how's it looking for my trading plan", expectedIntent: 'trading_plan', hint: 'bridge' },
      { message: 'what should I do right now with my Trading', expectedIntent: 'trading_plan', hint: 'bridge' },
      { message: 'am i trading today', expectedIntent: 'trading_plan', hint: 'bridge' },
      { message: 'the last two times i was told to wait and not trade, if i would have traded i would have won', expectedIntent: 'trading_hypothetical', hint: 'bridge' },
    ];

    for (let i = 0; i < scenarios.length; i += 1) {
      const s = scenarios[i];
      const sessionId = `jarvis-matrix-${i}`;
      try {
        const { body, out } = await jarvisQuery(server.baseUrl, s.message, {
          sessionId,
          hint: s.hint,
          voiceBriefMode: 'earbud',
        });
        assert(String(out.intent || '') === s.expectedIntent, 'intent mismatch', {
          expectedIntent: s.expectedIntent,
          gotIntent: out.intent,
          message: s.message,
          routePath: out.routePath,
          trace: out.auditTrace,
        });
        assertJarvisInvariants(`matrix:${s.message}`, body, out);
        if (String(out.intent).startsWith('trading_')) {
          assertNoLegacyTokens(`matrix:${s.message}`, out, body);
        }
        pass(`matrix ${i + 1}/${scenarios.length}: ${s.message}`);
      } catch (err) {
        fail(`matrix ${i + 1}/${scenarios.length}: ${s.message}`, err);
      }
    }

    const explainAliases = ['tell me why', 'what happened', "why can't I", 'give me details'];
    for (let i = 0; i < explainAliases.length; i += 1) {
      const alias = explainAliases[i];
      const sessionId = `jarvis-explain-${i}`;
      try {
        await jarvisQuery(server.baseUrl, 'should i take this setup now', {
          sessionId,
          hint: 'bridge',
          voiceBriefMode: 'earbud',
          auditMock: {
            healthStatus: 'OK',
            riskInputs: {
              nowEt: { date: '2026-03-03', time: '09:44' },
              tradesTakenToday: 1,
              maxTradesPerDay: 1,
              entryWindowStartEt: '09:30',
              entryWindowEndEt: '10:59',
              dailyPnL: 10,
              dailyLossLimit: 500,
            },
          },
        });
        const { out } = await jarvisQuery(server.baseUrl, alias, {
          sessionId,
          hint: 'bridge',
          voiceBriefMode: 'earbud',
        });
        assert(/Blocked:/i.test(String(out.reply || '')), 'explain alias did not return full brief', {
          alias,
          reply: out.reply,
          routePath: out.routePath,
          trace: out.auditTrace,
        });
        pass(`explain alias: ${alias}`);
      } catch (err) {
        fail(`explain alias: ${alias}`, err);
      }
    }

    const riskCases = [
      {
        name: 'position_overrides_health_and_risk',
        expectedMode: 'position',
        auditMock: {
          healthStatus: 'STALE',
          healthReason: 'stale bars',
          riskInputs: {
            nowEt: { date: '2026-03-03', time: '09:50' },
            openPosition: { side: 'long', qty: 1, avgPrice: 25000, unrealizedPnL: 32 },
            hasOpenPosition: true,
            tradesTakenToday: 2,
            maxTradesPerDay: 1,
            dailyPnL: -800,
            dailyLossLimit: 500,
          },
        },
      },
      {
        name: 'health_overrides_risk',
        expectedMode: 'health_block',
        auditMock: {
          healthStatus: 'STALE',
          healthReason: 'live bars stale',
          riskInputs: {
            nowEt: { date: '2026-03-03', time: '09:40' },
            tradesTakenToday: 1,
            maxTradesPerDay: 1,
            dailyPnL: 15,
            dailyLossLimit: 500,
          },
        },
      },
      {
        name: 'trade_cap_block',
        expectedMode: 'risk_block',
        auditMock: {
          healthStatus: 'OK',
          riskInputs: {
            nowEt: { date: '2026-03-03', time: '09:42' },
            tradesTakenToday: 1,
            maxTradesPerDay: 1,
            dailyPnL: 15,
            dailyLossLimit: 500,
          },
        },
      },
      {
        name: 'cooldown_after_loss_block',
        expectedMode: 'risk_block',
        auditMock: {
          healthStatus: 'OK',
          riskInputs: {
            nowEt: { date: '2026-03-03', time: '09:47' },
            tradesTakenToday: 1,
            maxTradesPerDay: 2,
            lastRealizedTradePnL: -35,
            lastRealizedTradeTimeEt: '2026-03-03 09:42 ET',
            cooldownRemainingMinutes: 5,
            blockedCooldownAfterLoss: true,
            dailyPnL: -35,
            dailyLossLimit: 500,
          },
        },
      },
      {
        name: 'outside_entry_window_block',
        expectedMode: 'risk_block',
        auditMock: {
          healthStatus: 'OK',
          riskInputs: {
            nowEt: { date: '2026-03-03', time: '12:20' },
            tradesTakenToday: 0,
            maxTradesPerDay: 1,
            dailyPnL: 0,
            dailyLossLimit: 500,
          },
        },
      },
      {
        name: 'daily_loss_limit_block',
        expectedMode: 'risk_block',
        auditMock: {
          healthStatus: 'OK',
          riskInputs: {
            nowEt: { date: '2026-03-03', time: '09:41' },
            tradesTakenToday: 0,
            maxTradesPerDay: 2,
            dailyPnL: -620,
            dailyLossLimit: 500,
          },
        },
      },
    ];

    for (let i = 0; i < riskCases.length; i += 1) {
      const c = riskCases[i];
      try {
        const { body, out } = await jarvisQuery(server.baseUrl, 'should i take this setup now', {
          sessionId: `jarvis-risk-${i}`,
          hint: i % 2 === 0 ? 'bridge' : 'lab',
          voiceBriefMode: 'earbud',
          auditMock: c.auditMock,
        });
        assert(String(out.precedenceMode || '') === c.expectedMode, 'precedence mode mismatch', {
          case: c.name,
          expectedMode: c.expectedMode,
          got: out.precedenceMode,
          routePath: out.routePath,
          trace: out.auditTrace,
        });
        assertJarvisInvariants(`risk:${c.name}`, body, out);
        assertNoLegacyTokens(`risk:${c.name}`, out, body);
        pass(`risk case: ${c.name}`);
      } catch (err) {
        fail(`risk case: ${c.name}`, err);
      }
    }

    try {
      const fixedSessionId = 'jarvis-exact-phrase-fixed-session';
      const strictRuns = 50;
      for (let i = 0; i < strictRuns; i += 1) {
        const { body, out } = await jarvisQuery(server.baseUrl, EXACT_FAILING_PHRASE, {
          sessionId: fixedSessionId,
          hint: 'bridge',
          voiceBriefMode: 'earbud',
          auditMock: AUDIT_BASELINE,
        });
        assertJarvisInvariants(`exact_phrase:${i}`, body, out);
        assertNoLegacyTokens(`exact_phrase:${i}`, out, body);
        assertNoForbiddenLeakTokens(`exact_phrase:${i}`, out?.reply, {
          phrase: EXACT_FAILING_PHRASE,
          routePath: out?.routePath,
          trace: out?.auditTrace,
        });
        assert(/^\s*(I’d|I'd|You['’]?re currently|You are currently)/i.test(String(out?.reply || '')), 'exact phrase does not start with stance prefix', {
          reply: out?.reply,
          routePath: out?.routePath,
          trace: out?.auditTrace,
        });
      }
      pass(`exact phrase guard: ${strictRuns}/${strictRuns} passes`);
    } catch (err) {
      fail('exact phrase guard', err);
    }

    try {
      const { body: fullReq, out: fullOut } = await jarvisQuery(server.baseUrl, 'what trend are we in right now', {
        sessionId: 'jarvis-mode-full',
        hint: 'lab',
        voiceBriefMode: 'full',
      });
      assert(fullOut.intent === 'trading_status', 'full mode intent mismatch', { out: fullOut });
      assert(Array.isArray(fullOut.toolsUsed) && fullOut.toolsUsed.length > 0, 'full mode tools missing', { out: fullOut });
      assertJarvisInvariants('mode:full', fullReq, fullOut);
      pass('mode variation: full brief');
    } catch (err) {
      fail('mode variation: full brief', err);
    }

    try {
      const { body: earbudReq, out: earbudOut } = await jarvisQuery(server.baseUrl, 'should i take this setup now', {
        sessionId: 'jarvis-mode-earbud',
        hint: 'lab',
        voiceBriefMode: 'earbud',
      });
      assertJarvisInvariants('mode:earbud', earbudReq, earbudOut);
      assertNoLegacyTokens('mode:earbud', earbudOut, earbudReq);
      pass('mode variation: earbud');
    } catch (err) {
      fail('mode variation: earbud', err);
    }

    let repeatedFailures = 0;
    for (let i = 0; i < 50; i += 1) {
      try {
        const { body, out } = await jarvisQuery(server.baseUrl, EXACT_FAILING_PHRASE, {
          sessionId: `jarvis-repeat-${i}`,
          hint: i % 2 === 0 ? 'bridge' : 'analyst',
          voiceBriefMode: 'earbud',
          auditMock: AUDIT_BASELINE,
        });
        assertJarvisInvariants(`repeat:${i}`, body, out);
        assertNoLegacyTokens(`repeat:${i}`, out, body);
      } catch (err) {
        repeatedFailures += 1;
        fail(`repeat run ${i + 1}/50`, err);
      }
    }
    if (repeatedFailures === 0) pass('50 repeated runs invariant gate');

  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`\nJarvis audit e2e failed with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log('\nJarvis audit e2e passed.');
}

run().catch((err) => {
  console.error(`\nJarvis audit e2e crashed: ${err.message}`);
  process.exit(1);
});
