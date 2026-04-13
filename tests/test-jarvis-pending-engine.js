#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const { createJarvisConsentManager } = require('../server/jarvis-core/consent');
const { createJarvisPendingEngine } = require('../server/jarvis-core/pending-engine');

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

const consent = createJarvisConsentManager({
  ttlMs: 90_000,
  recoveryWindowMs: 60_000,
});
const pendingEngine = createJarvisPendingEngine({
  consentManager: consent,
  recoveryWindowMs: 60_000,
});

runCase('parse pending input supports yes/no/switch/continue', async () => {
  const yes = pendingEngine.parsePendingInput('yes');
  assert.strictEqual(yes.isConfirm, true);
  const no = pendingEngine.parsePendingInput('nope');
  assert.strictEqual(no.isCancel, true);
  const sw = pendingEngine.parsePendingInput('switch topics');
  assert.strictEqual(sw.isSwitchTopic, true);
  const cont = pendingEngine.parsePendingInput('continue');
  assert.strictEqual(cont.isContinuePending, true);
});

runCase('consent pending recovery works across session drift for same client', async () => {
  pendingEngine.setConsentPending('sess-a', {
    kind: 'web_search',
    payload: { parsedIntent: 'local_search', queryUsed: 'coffee shop' },
  }, null, { clientId: 'client-x', sessionKey: 'jarvis:sess-a' });

  const recovered = pendingEngine.getConsentPending('sess-b', {
    message: 'yes',
    clientId: 'client-x',
    sessionKey: 'jarvis:sess-b',
    adopt: true,
  });
  assert(recovered && recovered.state, 'recovered state missing');
  assert.strictEqual(String(recovered.recoveredFromSessionId || ''), 'sess-a');
  assert.strictEqual(String(recovered.state?.kind || ''), 'web_search');
});

runCase('ambiguous recovery is detected when multiple pending items exist', async () => {
  pendingEngine.setConsentPending('ambig-a', {
    kind: 'web_search',
    payload: { parsedIntent: 'local_search', queryUsed: 'coffee shop' },
  }, null, { clientId: 'client-ambig', sessionKey: 'jarvis:ambig-a' });
  pendingEngine.setConsentPending('ambig-b', {
    kind: 'web_directions_select',
    payload: { parsedIntent: 'local_search', queryUsed: 'coffee shop' },
  }, null, { clientId: 'client-ambig', sessionKey: 'jarvis:ambig-b' });

  const out = pendingEngine.getConsentPending('ambig-c', {
    message: 'yes',
    clientId: 'client-ambig',
    sessionKey: 'jarvis:ambig-c',
    adopt: true,
  });
  assert.strictEqual(out.ambiguousRecovery, true);
  assert(Array.isArray(out.recoveryCandidates) && out.recoveryCandidates.length >= 2);
});

runCase('topic-shift guard blocks unrelated input while pending', async () => {
  const unrelated = pendingEngine.shouldTopicShiftGuard('my perfect date would be cupcakes', {
    allowSelection: true,
  });
  assert.strictEqual(unrelated, true);
  const confirm = pendingEngine.shouldTopicShiftGuard('yes', { allowSelection: true });
  assert.strictEqual(confirm, false);
});

runCase('selection matching is strict and deterministic', async () => {
  const sources = [
    { title: 'Chalet Coffee' },
    { title: 'Maple Bean Cafe' },
  ];
  const first = pendingEngine.pickSelection('the first one', sources);
  assert.strictEqual(first.index, 0);
  assert.strictEqual(first.matcher, 'selection:ordinal');

  const byName = pendingEngine.pickSelection('Chalet Coffee', sources);
  assert.strictEqual(byName.index, 0);
  assert.strictEqual(byName.matcher, 'selection:exact_name');

  const unrelated = pendingEngine.pickSelection('my perfect date cupcake', sources);
  assert.strictEqual(unrelated.selected, null);
  assert.strictEqual(unrelated.attemptedSelection, false);
});

runCase('general pending store set/get/clear works', async () => {
  pendingEngine.setGeneralPending('gen-a', {
    type: 'memory_update',
    summary: 'update thursday preference',
  }, 60_000);
  const row = pendingEngine.getGeneralPending('gen-a');
  assert(row && row.type === 'memory_update');
  pendingEngine.clearGeneralPending('gen-a');
  const empty = pendingEngine.getGeneralPending('gen-a');
  assert.strictEqual(empty, null);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log('All pending engine tests passed.');

