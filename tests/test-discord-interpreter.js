#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { __test } = require('../server/assistant/discord-bot');

function run(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

const siteMap = new Map([
  ['dashboard', 'http://localhost:3131'],
  ['youtube', 'https://www.youtube.com'],
  ['openai', 'https://platform.openai.com'],
  ['tradingview', 'https://www.tradingview.com'],
]);

const ctx = {
  appAllow: new Set(['safari', 'discord']),
  siteMap,
};

run('maps morning outlook to plan', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand("what's the morning outlook", ctx), 'plan');
});

run('maps trade guidance question to plan', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand('how should i trade this morning', ctx), 'plan');
});

run('does not map greeting chit-chat to trading status', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand("hey how's it going", ctx), null);
});

run('maps current conditions question to liveintel', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand('sync current conditions and show live intelligence', ctx), 'liveintel');
});

run('maps open youtube to allowlisted site key', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand('open youtube', ctx), 'site youtube');
});

run('maps close youtube phrase to close tab command', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand('my close youtube', ctx), 'closetab youtube');
});

run('parses close target count/browser/hint correctly', () => {
  const out = __test.parseCloseTarget('close the two youtube tabs in safari');
  assert.strictEqual(out.count, 2);
  assert.strictEqual(out.browser, 'Safari');
  assert.strictEqual(out.hint, 'youtube');
});

run('supports outcome logging phrase', () => {
  assert.strictEqual(__test.inferPlainEnglishCommand('the trade hit tp today +120', ctx), 'outcome win 120');
});

run('prevents dynamic command memory poisoning', () => {
  assert.strictEqual(__test.isLearnableInterpreterCommand('youtube lofi beats', 'ai'), false);
  assert.strictEqual(__test.isLearnableInterpreterCommand('open https://youtube.com', 'ai'), false);
  assert.strictEqual(__test.isLearnableInterpreterCommand('plan', 'rule'), true);
  assert.strictEqual(__test.isLearnableInterpreterCommand('site youtube', 'rule'), true);
});

run('sanitizes applescript strings safely', () => {
  const out = __test.escapeAppleScriptString('a"b\\c\nnext');
  assert.strictEqual(out, 'a\\"b\\\\c next');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('All discord interpreter tests passed.');
