#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { runHealthTool } = require('../server/tools/healthTool');

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

function makeDeps(overrides = {}) {
  const todayEt = getTodayEtDate();
  return {
    parseAssistantQuickIntents: () => ({}),
    getAnalystVoiceHealthPreflightBlock: async () => ({
      checked: true,
      blocked: false,
      status: 'OK',
      health: { status: 'OK', reason: null },
      reply: null,
    }),
    getMarketHealthSnapshotCached: async () => ({
      status: 'OK',
      reason: null,
      now_et: { date: todayEt, time: '09:50' },
      contractId_in_use: 'MNQH6',
      contract_roll_status: 'OK',
      topstep_bars: {
        ok: true,
        bars_returned: 120,
        minutes_since_last_bar: 1,
        last_close: 25000.5,
      },
      orb_state: {
        hasORBComplete: true,
        orbWindow: '09:30-09:45 ET',
        orbBarsRequired: 3,
      },
      db_persist: {
        sessions_last_date: todayEt,
      },
    }),
    buildVoiceHealthBlockedReply: ({ reason }) => (
      `I'd sit out for now - my live market data isn't healthy. ${String(reason || '').trim()}`.trim()
    ),
    ...overrides,
  };
}

async function run() {
  {
    const out = await runHealthTool({
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      symbol: 'MNQ',
      deps: makeDeps(),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.toolName, 'HealthTool');
    assert.strictEqual(out.data.status, 'OK');
    assert.strictEqual(out.data.hasTodaySessionBars, true);
    assert.strictEqual(out.data.hasORBComplete, true);
    assert.strictEqual(out.data.contractIdInUse, 'MNQH6');
    assert.strictEqual(out.data.rollStatus, 'OK');
  }

  {
    const out = await runHealthTool({
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      symbol: 'MNQ',
      deps: makeDeps({
        getAnalystVoiceHealthPreflightBlock: async () => ({
          checked: true,
          blocked: true,
          status: 'STALE',
          health: { status: 'STALE', reason: 'Topstep bars are stale (9m old).' },
          reply: "I'd sit out for now - my live market data isn't healthy. Topstep bars are stale (9m old).",
        }),
        getMarketHealthSnapshotCached: async () => ({
          status: 'STALE',
          reason: 'Topstep bars are stale (9m old).',
          contractId_in_use: 'MNQH6',
          contract_roll_status: 'OK',
          topstep_bars: {
            ok: false,
            bars_returned: 0,
            minutes_since_last_bar: 9,
          },
          orb_state: { hasORBComplete: false },
        }),
      }),
    });
    assert.strictEqual(out.data.status, 'STALE');
    assert.strictEqual(out.data.blocked, true);
    assert.strictEqual(out.data.hasTodaySessionBars, false);
    assert.ok(/isn't healthy/i.test(String(out.narrative.stance || '')));
  }

  {
    const out = await runHealthTool({
      message: 'what trend are we in right now',
      strategy: 'original',
      activeModule: 'analyst',
      symbol: 'MNQ',
      deps: makeDeps({
        getMarketHealthSnapshotCached: async () => ({
          status: 'OK',
          reason: null,
          contractId_in_use: 'MNQM6',
          contract_roll_status: 'ROLLED',
          topstep_bars: {
            ok: true,
            bars_returned: 30,
            minutes_since_last_bar: 1,
          },
          orb_state: { hasORBComplete: false, orbWindow: '09:30-09:45 ET', orbBarsRequired: 3 },
        }),
      }),
    });
    assert.strictEqual(out.data.hasORBComplete, false);
    assert.strictEqual(out.data.contractIdInUse, 'MNQM6');
    assert.strictEqual(out.data.rollStatus, 'ROLLED');
    const narrativeText = String((out.narrative.details || []).join(' '));
    assert.ok(!/opening range is complete/i.test(narrativeText));
  }

  console.log('All health tool tests passed.');
}

run().catch((err) => {
  console.error(`\nHealth tool tests failed: ${err.message}`);
  process.exit(1);
});
