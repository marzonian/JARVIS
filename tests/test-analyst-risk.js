#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildRiskStateSnapshot,
  buildAnalystRiskGuardrailReply,
  applyAnalystRiskWaitPrefix,
} = require('../server/analyst-risk');

function run(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

function sentenceCount(text = '') {
  return (String(text || '').match(/[.!?](?=\s|$)/g) || []).length;
}

run('one-trade-per-day block produces trade-2 earbud guardrail', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '09:52' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 1,
    maxTradesPerDay: 1,
    dailyPnL: 80,
    hasOpenPosition: false,
    blockedDataStale: false,
  });
  assert.strictEqual(risk.blocked_oneTradePerDay, true);
  assert.strictEqual(risk.riskVerdict, 'BLOCK');
  const reply = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'earbud' });
  assert.ok(/trade #2 today|already traded today/i.test(reply), 'Earbud guardrail should clearly indicate second trade attempt');
  assert.ok(!/take the trade|enter now|buy now|best setup/i.test(reply), 'Blocked reply must not encourage setup entry');
  assert.ok(sentenceCount(reply) <= 3, 'Earbud reply must stay concise');
});

run('outside-entry-window block is enforced', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '12:05' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 0,
    maxTradesPerDay: 1,
    dailyPnL: 0,
    hasOpenPosition: false,
    blockedDataStale: false,
  });
  assert.strictEqual(risk.blocked_outsideEntryWindow, true);
  assert.strictEqual(risk.riskVerdict, 'BLOCK');
  const reply = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'earbud' });
  assert.ok(/outside your entry window/i.test(reply), 'Earbud reply should explain entry window block');
});

run('daily-loss-limit block triggers in earbud and full brief', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '09:40' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 0,
    maxTradesPerDay: 1,
    dailyPnL: -520,
    dailyLossLimit: 500,
    hasOpenPosition: false,
    blockedDataStale: false,
  });
  assert.strictEqual(risk.blocked_dailyLossLimit, true);
  assert.strictEqual(risk.riskVerdict, 'BLOCK');
  const earbud = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'earbud' });
  assert.ok(/risk limit|stop the bleeding/i.test(earbud), 'Earbud reply should emphasize risk stop');
  const full = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'full' });
  assert.ok(/^Blocked:/i.test(full), 'Full brief should start with blocked reason');
  assert.ok(/Daily PnL:/i.test(full), 'Full brief should include daily PnL line');
});

run('blocked earbud replies include explain follow-up clause', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '12:05' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 0,
    maxTradesPerDay: 1,
    dailyPnL: 0,
    hasOpenPosition: false,
    blockedDataStale: false,
  });
  const reply = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'earbud' });
  assert.ok(reply.includes('Say "explain" for details.'), 'Earbud blocked reply should include explain hook');
  assert.ok(sentenceCount(reply) <= 3, 'Earbud blocked reply should stay <= 3 sentences');
  assert.ok(reply.length <= 420, 'Earbud blocked reply should stay compact');
});

run('cooldown-after-loss block includes remaining minutes and loss timestamp in full brief', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '09:45' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 1,
    maxTradesPerDay: 2,
    dailyPnL: -45,
    hasOpenPosition: false,
    blockedDataStale: false,
    lossCooldownEnabled: true,
    lossCooldownMinutes: 10,
    lastRealizedTradePnL: -42,
    lastRealizedTradeTimeEt: '2026-03-03 09:41 ET',
    cooldownRemainingMinutes: 6,
  });
  assert.strictEqual(risk.blocked_cooldown_after_loss, true);
  assert.strictEqual(risk.riskVerdict, 'BLOCK');
  const earbud = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'earbud' });
  assert.ok(/cooldown after a loss/i.test(earbud), 'Earbud reply should identify cooldown block');
  assert.ok(/6 more minutes/i.test(earbud), 'Earbud reply should include remaining cooldown minutes');
  const full = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'full' });
  assert.ok(/Last realized loss:/i.test(full), 'Full brief should include last realized loss time');
  assert.ok(/Cooldown remaining:\s*6 minute/i.test(full), 'Full brief should include cooldown remaining');
});

run('open-position block switches to management language', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '09:50' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 0,
    maxTradesPerDay: 1,
    dailyPnL: 45,
    hasOpenPosition: true,
    openPosition: { side: 'long', qty: 1, avgPrice: 25000, unrealizedPnL: 22 },
    blockedDataStale: false,
  });
  assert.strictEqual(risk.blocked_hasOpenPosition, true);
  assert.strictEqual(risk.riskVerdict, 'BLOCK');
  const reply = buildAnalystRiskGuardrailReply(risk, { voiceBriefMode: 'earbud' });
  assert.ok(/already in a position|manage this trade/i.test(reply), 'Open-position reply should switch to management guidance');
  assert.ok(!/best setup|top setup|take this setup|scan/i.test(reply), 'Open-position mode should avoid setup suggestions');
  const parts = String(reply).split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(parts.length <= 3, 'Open-position earbud reply should be <= 3 sentences');
  assert.ok(/\bif\b/i.test(reply), 'Open-position earbud reply should include an invalidation condition');
});

run('stale-data WAIT applies conservative prefix (non-earbud)', () => {
  const risk = buildRiskStateSnapshot({
    nowEt: { date: '2026-03-03', time: '09:44' },
    sessionDateEt: '2026-03-03',
    tradesTakenToday: 0,
    maxTradesPerDay: 1,
    hasOpenPosition: false,
    blockedDataStale: true,
  });
  assert.strictEqual(risk.riskVerdict, 'WAIT');
  const out = applyAnalystRiskWaitPrefix('Current structure is mixed; wait for cleaner confirmation.', risk, { voiceBriefMode: 'full' });
  assert.ok(/^Conservative stance:/i.test(out), 'WAIT prefix should lead with conservative stance');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('All analyst risk tests passed.');
