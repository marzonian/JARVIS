#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  TRACE_SCHEMA_FIELDS,
} = require('../server/jarvis-core/trace');

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3143,
  });
  try {
    const sessionId = `jarvis-trace-schema-${Date.now()}`;
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
    assert(out?.success === true, 'jarvis trace schema smoke failed (success!=true)', { out });
    assert(out?.trace && typeof out.trace === 'object', 'jarvis response missing trace object', { out });
    for (const field of TRACE_SCHEMA_FIELDS) {
      assert(Object.prototype.hasOwnProperty.call(out.trace, field), `jarvis response trace missing field: ${field}`, {
        field,
        trace: out.trace,
      });
    }
    assert(String(out.trace.traceId || '') === String(out.traceId || ''), 'response traceId mismatch', {
      traceId: out.traceId,
      trace: out.trace,
    });

    const diagRes = await fetch(`${server.baseUrl}/api/jarvis/diag/latest?sessionId=${encodeURIComponent(sessionId)}`, {
      // Full-suite runs can transiently delay diagnostics fetch; keep this test deterministic.
      signal: AbortSignal.timeout(20000),
    });
    const diagText = await diagRes.text();
    let diag = {};
    try {
      diag = JSON.parse(diagText || '{}');
    } catch {
      diag = { raw: diagText };
    }
    assert(diagRes.ok, `/api/jarvis/diag/latest returned HTTP ${diagRes.status}`, { diag });
    assert(diag?.success === true, 'jarvis diag did not return success=true', { diag });
    assert(diag?.trace && typeof diag.trace === 'object', 'jarvis diag missing trace payload', { diag });
    for (const field of TRACE_SCHEMA_FIELDS) {
      assert(Object.prototype.hasOwnProperty.call(diag.trace, field), `jarvis diag trace missing field: ${field}`, {
        field,
        trace: diag.trace,
      });
    }
    assert(String(diag.trace.traceId || '') === String(out.traceId || ''), 'jarvis diag traceId mismatch', {
      expected: out.traceId,
      got: diag.trace.traceId,
      diagTrace: diag.trace,
    });

    console.log('✅ jarvis trace schema test passed');
  } finally {
    await server.stop();
  }
}

run().catch((err) => {
  console.error(`\nJarvis trace schema test failed: ${err.message}`);
  process.exit(1);
});
