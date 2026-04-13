#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3145,
  });
  try {
    const sessionId = `jarvis-finalize-telemetry-${Date.now()}`;
    const out = await postJson(server.baseUrl, '/api/jarvis/query', {
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      contextHint: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      includeTrace: true,
      sessionId,
      clientId: sessionId,
      auditMock: {
        nowEt: { date: '2026-03-06', time: '09:50' },
        healthStatus: 'OK',
        riskInputs: {
          sessionDateEt: '2026-03-06',
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
            nowEt: { date: '2026-03-06', time: '09:50' },
            sessionDateOfData: '2026-03-06',
          },
        },
      },
    }, 45000);

    assert(out?.success === true, 'jarvis query did not succeed', { out });
    assert(out?.didFinalize === true, 'didFinalize must be true when finalize gate runs', {
      didFinalize: out?.didFinalize,
      formatterUsed: out?.formatterUsed,
      trace: out?.trace,
      out,
    });
    assert(String(out?.formatterUsed || '') === 'earbud', 'formatterUsed must be earbud for earbud voice mode', {
      formatterUsed: out?.formatterUsed,
      out,
    });
    assert(out?.invariantsPass === true, 'invariantsPass should be true for normal phrase', {
      invariantsPass: out?.invariantsPass,
      failedRules: out?.invariants?.failedRules,
      out,
    });

    assert(out?.trace && typeof out.trace === 'object', 'trace object missing from response', { out });
    assert(out.trace.didFinalize === true, 'trace.didFinalize must be true', { trace: out.trace });
    assert(String(out.trace.formatterUsed || '') === 'earbud', 'trace.formatterUsed must be earbud', { trace: out.trace });
    assert(out.trace.invariantsPass === true, 'trace.invariantsPass must be true', { trace: out.trace });

    console.log('✅ jarvis finalize telemetry test passed');
  } finally {
    await server.stop();
  }
}

run().catch((err) => {
  console.error(`\nJarvis finalize telemetry test failed: ${err.message}`);
  process.exit(1);
});
