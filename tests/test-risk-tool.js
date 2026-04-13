#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  runRiskTool,
} = require('../server/tools/riskTool');
const {
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

function buildRiskState(code) {
  return {
    riskVerdict: code ? 'BLOCK' : 'ALLOW',
    riskReasonCodes: code ? [code] : [],
    riskReasons: code ? [code.replace(/_/g, ' ')] : [],
    hasOpenPosition: false,
    inEntryWindow: true,
    tradesTakenToday: code === 'one_trade_per_day' ? 1 : 0,
    maxTradesPerDay: 1,
    dailyPnL: code === 'daily_loss_limit' ? -600 : 25,
    dailyLossLimit: 500,
    entryWindowStartEt: '09:30',
    entryWindowEndEt: '10:59',
    cooldownRemainingMinutes: code === 'cooldown_after_loss' ? 7 : 0,
    marketDataFreshness: {
      hasTodaySessionBars: true,
      hasORBComplete: true,
      usedLiveBars: true,
      minutesSinceLastCandle: 1,
      nowEt: { date: '2026-03-03', time: '09:50' },
    },
  };
}

async function runUnitCase(name, opts = {}) {
  const code = opts.code || null;
  const precedenceMode = opts.precedenceMode || (code ? 'risk_block' : 'normal');
  const healthBlocked = opts.healthBlocked === true;
  const out = await runRiskTool({
    message: 'should i take this setup now',
    strategy: 'original',
    activeModule: 'analyst',
    voiceBriefMode: 'earbud',
    sessionId: `risk-tool-${name}`,
    clientId: `risk-tool-${name}`,
    deps: {
      parseAssistantQuickIntents: () => ({}),
      buildAnalystRiskStateRuntime: async () => ({ riskState: buildRiskState(code) }),
      getAnalystVoiceHealthPreflightBlock: async () => ({
        checked: true,
        blocked: healthBlocked,
        status: healthBlocked ? 'STALE' : 'OK',
        health: healthBlocked ? { status: 'STALE', reason: 'bars stale' } : { status: 'OK' },
        reply: healthBlocked ? "I'd sit out for now - my live market data isn't healthy." : null,
      }),
      resolveAnalystPrecedence: () => ({ mode: precedenceMode }),
      buildAnalystRiskGuardrailReply: (riskState, options) => (
        options?.voiceBriefMode === 'full'
          ? `Blocked: ${String((riskState.riskReasonCodes || [])[0] || 'risk_block')}. Trades taken today: ${riskState.tradesTakenToday}/${riskState.maxTradesPerDay}.`
          : "I'd sit out for now because risk controls are active."
      ),
      buildVoiceHealthBlockedReply: () => "I'd sit out for now - my live market data isn't healthy.",
    },
  });
  assert.strictEqual(out.ok, true, `${name}: tool should return ok=true`);
  assert.strictEqual(out.toolName, 'RiskTool', `${name}: toolName mismatch`);
  return out;
}

async function run() {
  {
    const out = await runUnitCase('trade_cap', { code: 'one_trade_per_day', precedenceMode: 'risk_block' });
    assert.strictEqual(out.data.verdict, 'BLOCK');
    assert.strictEqual(out.data.blockReason, 'trade_cap');
    assert.strictEqual(out.data.allowTrading, false);
  }
  {
    const out = await runUnitCase('cooldown', { code: 'cooldown_after_loss', precedenceMode: 'risk_block' });
    assert.strictEqual(out.data.verdict, 'BLOCK');
    assert.strictEqual(out.data.blockReason, 'cooldown');
  }
  {
    const out = await runUnitCase('outside_window', { code: 'outside_entry_window', precedenceMode: 'risk_block' });
    assert.strictEqual(out.data.verdict, 'BLOCK');
    assert.strictEqual(out.data.blockReason, 'outside_window');
  }
  {
    const out = await runUnitCase('loss_limit', { code: 'daily_loss_limit', precedenceMode: 'risk_block' });
    assert.strictEqual(out.data.verdict, 'BLOCK');
    assert.strictEqual(out.data.blockReason, 'loss_limit');
  }
  {
    const out = await runUnitCase('allow', { code: null, precedenceMode: 'normal' });
    assert.strictEqual(out.data.verdict, 'ALLOW');
    assert.strictEqual(out.data.blockReason, 'none');
    assert.strictEqual(out.data.allowTrading, true);
  }

  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3146,
  });
  try {
    const sessionId = `risk-tool-explain-${Date.now()}`;
    const blocked = await postJson(server.baseUrl, '/api/jarvis/query', {
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      contextHint: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      sessionId,
      clientId: sessionId,
      includeTrace: true,
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
    }, 20000);
    assert.strictEqual(blocked.success, true);
    assert.strictEqual(blocked.precedenceMode, 'risk_block');
    assert.ok(Array.isArray(blocked.toolsUsed) && blocked.toolsUsed.includes('RiskTool'), 'blocked response must include RiskTool');

    const explain = await postJson(server.baseUrl, '/api/jarvis/query', {
      message: 'why blocked',
      strategy: 'original',
      activeModule: 'analyst',
      contextHint: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      sessionId,
      clientId: sessionId,
      includeTrace: true,
    }, 20000);
    assert.strictEqual(explain.success, true);
    assert.ok(/^Blocked:/i.test(String(explain.reply || '')), 'explain follow-up should return full brief');
    assert.ok(/Trades taken today:/i.test(String(explain.reply || '')), 'explain full brief should include trade counters');
  } finally {
    await server.stop();
  }

  console.log('All risk tool tests passed.');
}

run().catch((err) => {
  console.error(`\nRisk tool tests failed: ${err.message}`);
  process.exit(1);
});

