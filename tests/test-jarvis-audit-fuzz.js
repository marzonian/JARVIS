#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  assertJarvisInvariants,
  assertNoLegacyTokens,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AUDIT_BASELINE = {
  nowEt: { date: '2026-03-04', time: '09:52' },
  healthStatus: 'STALE',
  healthReason: 'audit_fuzz_stale_guard',
  riskInputs: {
    sessionDateEt: '2026-03-03',
    entryWindowStartEt: '09:30',
    entryWindowEndEt: '10:59',
    tradesTakenToday: 0,
    maxTradesPerDay: 2,
    dailyPnL: 45,
    dailyLossLimit: 500,
    trailingDrawdownDistance: 1000,
    blockedDataStale: false,
    readinessNeedsFreshData: true,
    marketDataFreshness: {
      hasTodaySessionBars: false,
      hasORBComplete: false,
      usedLiveBars: false,
      minutesSinceLastCandle: 20,
      nowEt: { date: '2026-03-04', time: '09:52' },
      sessionDateOfData: '2026-03-03',
    },
  },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomTradingPhrase() {
  const openers = [
    'should i',
    'can i',
    'would you',
    'do you think i should',
    'quick check',
  ];
  const actions = [
    'take this setup now',
    'sit out today',
    'stay out of the market',
    'enter this trade now',
    'trade this right now',
    'wait for a cleaner setup',
  ];
  const qualifiers = [
    'with current mnq conditions',
    'based on live data',
    'using orb rules',
    'before 10:15 momentum',
    'if range is wide',
    'with my risk limits',
    'if volatility is high',
    '',
  ];
  const trendQs = [
    'what trend are we in right now',
    'market regime right now',
    'bias right now',
    'what is the plan today',
    'was it a good day for me not to trade today',
  ];

  if (Math.random() < 0.2) return pick(trendQs);
  const opener = pick(openers);
  const action = pick(actions);
  const qualifier = pick(qualifiers);
  return `${opener} ${action}${qualifier ? ` ${qualifier}` : ''}`.replace(/\s+/g, ' ').trim();
}

async function postJsonWithRetry(baseUrl, endpoint, body, timeoutMs = 30000, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await postJson(baseUrl, endpoint, body, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      await sleep(120 * attempt);
    }
  }
  throw lastErr || new Error('postJsonWithRetry failed');
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3142,
  });

  let failures = 0;
  const TOTAL = 200;

  try {
    for (let i = 0; i < TOTAL; i += 1) {
      const phrase = randomTradingPhrase();
      const body = {
        message: phrase,
        strategy: 'original',
        activeModule: i % 3 === 0 ? 'bridge' : (i % 3 === 1 ? 'analyst' : 'lab'),
        contextHint: i % 3 === 0 ? 'bridge' : (i % 3 === 1 ? 'analyst' : 'lab'),
        voiceMode: true,
        voiceBriefMode: 'earbud',
        includeTrace: true,
        sessionId: `jarvis-fuzz-${i}`,
        clientId: `jarvis-fuzz-${i}`,
        auditMock: AUDIT_BASELINE,
      };

      let out;
      try {
        out = await postJsonWithRetry(server.baseUrl, '/api/jarvis/query', body, 30000, 3);
      } catch (err) {
        failures += 1;
        console.error(`❌ fuzz ${i + 1}/${TOTAL} request failed\n   ${err.message}\n   phrase=${phrase}`);
        continue;
      }

      try {
        assert(out?.success === true, 'response not successful', { phrase, out });
        if (String(out?.intent || '').startsWith('trading_')) {
          assertJarvisInvariants(`fuzz:${i}`, body, out);
          assertNoLegacyTokens(`fuzz:${i}`, out, body);
        }
      } catch (err) {
        failures += 1;
        console.error(`❌ fuzz ${i + 1}/${TOTAL} invariants failed\n   ${err.message}`);
      }
    }
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`\nJarvis fuzz test failed with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log(`\nJarvis fuzz test passed (${TOTAL} phrases).`);
}

run().catch((err) => {
  console.error(`\nJarvis fuzz test crashed: ${err.message}`);
  process.exit(1);
});
