#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  normalizeHealthStatus,
  shouldEmitHealthAudioTransition,
  healthAudioToneType,
} = require('../client/src/health-audio-utils.cjs');

function run(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

run('normalize health status trims and uppercases', () => {
  assert.strictEqual(normalizeHealthStatus(' ok '), 'OK');
  assert.strictEqual(normalizeHealthStatus('degraded'), 'DEGRADED');
});

run('alert emits on OK -> STALE and STALE -> OK transitions', () => {
  assert.strictEqual(shouldEmitHealthAudioTransition('OK', 'STALE'), true);
  assert.strictEqual(shouldEmitHealthAudioTransition('DEGRADED', 'OK'), true);
});

run('no alert for unchanged or non-critical transitions', () => {
  assert.strictEqual(shouldEmitHealthAudioTransition('OK', 'OK'), false);
  assert.strictEqual(shouldEmitHealthAudioTransition('UNKNOWN', 'STALE'), false);
  assert.strictEqual(shouldEmitHealthAudioTransition('STALE', 'DEGRADED'), false);
});

run('tone type maps correctly for degraded/recovered transitions', () => {
  assert.strictEqual(healthAudioToneType('OK', 'DEGRADED'), 'degraded');
  assert.strictEqual(healthAudioToneType('STALE', 'OK'), 'recovered');
  assert.strictEqual(healthAudioToneType('OK', 'OK'), null);
});

run('status-change event simulation fires once per transition', () => {
  const seq = ['OK', 'OK', 'DEGRADED', 'DEGRADED', 'STALE', 'OK', 'OK'];
  let prev = seq[0];
  let fired = 0;
  for (let i = 1; i < seq.length; i += 1) {
    const next = seq[i];
    if (shouldEmitHealthAudioTransition(prev, next)) fired += 1;
    prev = next;
  }
  assert.strictEqual(fired, 2, 'Expected exactly two alerts (OK->DEGRADED, STALE->OK)');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('All health audio tests passed.');
