#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  buildEarbudRepairReply,
  enforceEarbudFinalGate,
  hasLegacyVerdictTokens,
  validateJarvisResponseInvariants,
} = require('../server/jarvis-audit');

function run(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

run('legacy token detector catches rigid verdict labels', () => {
  const bad = "DON'T TRADE. WAIT: Outside window. [WAIT]";
  assert.strictEqual(hasLegacyVerdictTokens(bad), true);
  assert.strictEqual(hasLegacyVerdictTokens("I'd wait for cleaner structure."), false);
});

run('earbud invariant checker rejects non-template replies', () => {
  const out = validateJarvisResponseInvariants({
    request: { voiceMode: true, voiceBriefMode: 'earbud' },
    response: {
      intent: 'trading_decision',
      reply: 'WAIT: Too risky right now.',
      toolsUsed: ['Analyst'],
    },
    context: {
      precedenceMode: 'normal',
      healthStatus: 'OK',
      riskVerdict: 'WAIT',
      hasOpenPosition: false,
      nowMinutesEt: 600,
      hasORBComplete: true,
      liveBarsAvailable: true,
    },
  });
  assert.strictEqual(out.pass, false);
  assert.ok(out.failedRules.includes('legacy_tokens_present'));
});

run('repair builder emits valid 3-sentence structure', () => {
  const repaired = buildEarbudRepairReply({
    hasOpenPosition: false,
    healthStatus: 'OK',
    riskVerdict: 'BLOCK',
    primaryReasonCode: 'outside_entry_window',
  });
  const out = validateJarvisResponseInvariants({
    request: { voiceMode: true, voiceBriefMode: 'earbud' },
    response: {
      intent: 'trading_decision',
      reply: repaired,
      toolsUsed: ['Analyst'],
    },
    context: {
      precedenceMode: 'risk_block',
      healthStatus: 'OK',
      riskVerdict: 'BLOCK',
      hasOpenPosition: false,
      nowMinutesEt: 740,
      hasORBComplete: true,
      liveBarsAvailable: true,
    },
  });
  assert.strictEqual(out.pass, true, JSON.stringify(out));
});

run('earbud final gate strips forbidden legacy phrasing and returns invariant-safe output', () => {
  const out = enforceEarbudFinalGate({
    request: { voiceMode: true, voiceBriefMode: 'earbud' },
    response: {
      intent: 'trading_decision',
      reply: "DON'T TRADE. Range is too wide. Best setup now: ORB 10:15. Why: fakeout risk.",
      toolsUsed: ['Analyst'],
    },
    context: {
      precedenceMode: 'risk_block',
      healthStatus: 'OK',
      riskVerdict: 'BLOCK',
      hasOpenPosition: false,
      nowMinutesEt: 610,
      hasORBComplete: true,
      liveBarsAvailable: true,
      primaryReasonCode: 'outside_entry_window',
    },
  });
  assert.strictEqual(out.invariants.pass, true, JSON.stringify(out.invariants));
  assert.strictEqual(hasLegacyVerdictTokens(out.reply), false, out.reply);
  assert.strictEqual(out.didEarbudFinalize, true);
  assert.ok(/^\s*(I'd|I’d|You're currently|You are currently)/i.test(out.reply), out.reply);
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('All jarvis audit invariant tests passed.');
