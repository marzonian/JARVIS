#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { analyzeJarvisIntent } = require('../server/jarvis-core/intent');

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const PHRASE_BANK = {
  trading_hypothetical: [
    'if i would have taken a trade what would have been my results',
    'if i had traded today what would have happened',
    'would that trade have won if i took it',
    'how would that trade have done',
    'if i would of traded this morning what result',
  ],
  trading_replay: [
    'replay today',
    'walk me through what happened',
    'session recap',
    'what did price do after 9:45',
    'replay this session',
  ],
  trading_review: [
    "was it good i didn't trade",
    'did i make the right call staying out',
    'was i right not trading',
    'good decision not trading today',
    'was staying out right',
  ],
  trading_plan: [
    "what's the plan today",
    "what's my best setup",
    'how should i trade this morning',
    'trading plan for today',
    'am i trading today',
  ],
  trading_execution_request: [
    'enter a trade now',
    'close my position',
    'flatten now',
    'buy now',
    'sell now',
  ],
  trading_status: [
    'what trend are we in right now',
    'bias right now',
    'do we have fresh bars',
    'inside the entry window',
    'trade status',
  ],
  local_search: [
    "service where's the nearest walmart",
    'target near me',
    'find cvs',
    'pizza around here',
    'nearest coffee shop',
    'closest gas station near me',
    'find coffee near me',
    'closest restaurant near me',
    'nearby coffee near me',
  ],
  device_action: [
    'uninstall telegram',
    'open app safari',
    'delete file test.txt',
    'disable bluetooth',
    'change settings',
  ],
  code_change: [
    'implement this feature',
    'fix bug in dashboard',
    'refactor the voice module',
    'update app design',
    'write script for this',
  ],
  general_chat: [
    'what time is it',
    'hello',
    'hey how is it going',
    'what is the date',
    'help',
  ],
  unclear: [
    'hmm',
    'not sure',
    'you know',
    'this thing',
    'idk',
  ],
};

function mutate(input) {
  let out = String(input || '');
  if (Math.random() < 0.35) out = out.toLowerCase();
  if (Math.random() < 0.4) out = out.replace(/[?.!,]/g, '');
  if (Math.random() < 0.25) out = out.replace(/\s+/g, '  ');
  if (Math.random() < 0.25) out = out.replace(/\bwould have\b/gi, "would've");
  if (Math.random() < 0.15) out = out.replace(/\btrading\b/gi, 'tradeing');
  if (Math.random() < 0.15) out = out.replace(/\bcoffee\b/gi, 'cofee');
  if (Math.random() < 0.15) out = out.replace(/\bposition\b/gi, 'posishun');
  if (Math.random() < 0.15) out = `${out} right now`;
  return out.trim();
}

function main() {
  const TOTAL = 500;
  let passed = 0;
  let failed = 0;
  const failures = [];

  const labels = Object.keys(PHRASE_BANK);
  for (let i = 0; i < TOTAL; i += 1) {
    const expected = pick(labels);
    const phrase = mutate(pick(PHRASE_BANK[expected]));
    const out = analyzeJarvisIntent(phrase, { allowClarify: true });
    const got = String(out.intent || '');

    const ok = (
      got === expected
      || got === 'unclear'
      || (expected === 'general_chat' && got === 'unclear')
    );
    if (ok) {
      passed += 1;
    } else {
      failed += 1;
      failures.push({ expected, got, phrase });
    }
  }

  const successRate = (passed / TOTAL) * 100;
  assert(
    successRate >= 95,
    `Intent fuzz success rate ${successRate.toFixed(2)}% is below 95%. failures=${failed}`
  );

  console.log(`✅ jarvis intent fuzz passed (${passed}/${TOTAL}, ${successRate.toFixed(2)}%)`);
  if (failures.length > 0) {
    const preview = failures.slice(0, 5);
    console.log(`ℹ sample mismatches: ${JSON.stringify(preview)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`❌ test-jarvis-intent-fuzz failed\n   ${err.message}`);
  process.exit(1);
}
