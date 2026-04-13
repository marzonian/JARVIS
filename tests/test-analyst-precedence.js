#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  isExplainFollowup,
  resolveAnalystPrecedence,
} = require('../server/analyst-precedence');

function run(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

run('position overrides health + risk', () => {
  const out = resolveAnalystPrecedence({
    hasOpenPosition: true,
    healthStatus: 'STALE',
    riskVerdict: 'BLOCK',
  });
  assert.strictEqual(out.mode, 'position');
});

run('health overrides risk when no open position', () => {
  const out = resolveAnalystPrecedence({
    hasOpenPosition: false,
    healthStatus: 'DEGRADED',
    riskVerdict: 'BLOCK',
  });
  assert.strictEqual(out.mode, 'health_block');
});

run('risk block applies only when health is OK and no position', () => {
  const out = resolveAnalystPrecedence({
    hasOpenPosition: false,
    healthStatus: 'OK',
    riskVerdict: 'BLOCK',
  });
  assert.strictEqual(out.mode, 'risk_block');
});

run('normal mode when no position, health OK, and risk not blocked', () => {
  const out = resolveAnalystPrecedence({
    hasOpenPosition: false,
    healthStatus: 'OK',
    riskVerdict: 'WAIT',
  });
  assert.strictEqual(out.mode, 'normal');
});

run('explain aliases match exactly with punctuation/case normalization', () => {
  const aliases = [
    'explain',
    'Explain!',
    'WHY',
    'why blocked',
    'details.',
    'tell me why',
    'what happened?',
    'why not',
    "why can't I",
    'give me details',
  ];
  for (const phrase of aliases) {
    assert.strictEqual(isExplainFollowup(phrase), true, `Alias should match: ${phrase}`);
  }
});

run('non-matching longer sentences do not trigger explain follow-up', () => {
  const negatives = [
    'can you explain this setup',
    'tell me why this happened today',
    'what happened to the market today',
    "why can't I trade right now exactly",
    'give me details on setup quality',
  ];
  for (const phrase of negatives) {
    assert.strictEqual(isExplainFollowup(phrase), false, `Should not match: ${phrase}`);
  }
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('All analyst precedence tests passed.');
