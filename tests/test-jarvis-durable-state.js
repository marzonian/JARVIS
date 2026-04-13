#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createJarvisOrchestrator } = require('../server/jarvis-orchestrator');
const { createJarvisDurableStateStore } = require('../server/jarvis-core/durable-state');
const { createVoiceTradingSessionManager } = require('../server/jarvis-core/voice-session');
const {
  configureRiskExplainStore,
  rememberRiskExplain,
  getRiskExplain,
} = require('../server/tools/riskTool');

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-durable-'));
  return path.join(dir, 'state.db');
}

function createDurableBundle(dbPath) {
  const db = new Database(dbPath);
  const store = createJarvisDurableStateStore({
    dbFactory: () => db,
    defaultTtlMs: 10 * 60 * 1000,
  });
  return { db, store };
}

function createWebStubOut(request = {}) {
  return {
    reply: 'Here are the closest options:\n1) Chalet Coffee — 0.3 km — Newark\n2) Maple Bean Cafe — 0.7 km — Newark\n\nWant directions to one of these?',
    intent: request.intent || 'local_search',
    toolsUsed: ['WebTool'],
    routePath: 'jarvis_orchestrator.consent.web.execute',
    web: {
      sources: [
        { title: 'Chalet Coffee', address: 'Newark', url: 'https://example.com/chalet', distanceKm: 0.3 },
        { title: 'Maple Bean Cafe', address: 'Newark', url: 'https://example.com/maple', distanceKm: 0.7 },
      ],
    },
    toolReceipts: [{
      tool: 'WebTool',
      parameters: {
        mode: 'real',
        queryUsed: request.queryUsed || request.message || 'nearest coffee shop',
      },
      result: {
        executed: true,
        resultCount: 2,
      },
    }],
  };
}

function createTestOrchestrator(store) {
  return createJarvisOrchestrator({
    durableStateStore: store,
    runWebQuestion: async (request) => createWebStubOut(request),
    runGeneralChat: async () => ({
      reply: 'general chat',
      toolsUsed: ['Jarvis'],
      routePath: 'jarvis_orchestrator.general_chat',
    }),
  });
}

async function main() {
  await runCase('pending web consent survives restart and yes still executes', async () => {
    const dbPath = createTempDbPath();
    const bundleA = createDurableBundle(dbPath);
    const orchestratorA = createTestOrchestrator(bundleA.store);
    const sessionId = `durable-consent-${Date.now()}`;
    const clientId = `${sessionId}-client`;

    const step1 = await orchestratorA.run({
      message: 'nearest coffee shop',
      sessionId,
      clientId,
      voiceMode: true,
      voiceBriefMode: 'earbud',
    });
    assert.strictEqual(step1.consentPending, true, 'first turn should create consent pending');

    const step2 = await orchestratorA.run({
      message: 'use Newark New Jersey',
      sessionId,
      clientId,
      voiceMode: true,
      voiceBriefMode: 'earbud',
    });
    assert.strictEqual(step2.consentPending, true, 'city turn should keep pending');
    assert.strictEqual(String(step2.consentKind || ''), 'web_search', 'city turn should advance to web_search confirm');

    bundleA.db.close();

    const bundleB = createDurableBundle(dbPath);
    const orchestratorB = createTestOrchestrator(bundleB.store);
    const step3 = await orchestratorB.run({
      message: 'yes',
      sessionId,
      clientId,
      voiceMode: true,
      voiceBriefMode: 'earbud',
    });
    assert.strictEqual(step3.intent, 'local_search');
    assert.ok(Array.isArray(step3.toolsUsed) && step3.toolsUsed.includes('WebTool'), 'yes after restart should execute WebTool');
    assert.strictEqual(step3.consentPending, true, 'post-search should hold directions selection pending');
    assert.strictEqual(String(step3.consentKind || ''), 'web_directions_select');
    bundleB.db.close();
  });

  await runCase('contradiction pending prompt survives restart', async () => {
    const dbPath = createTempDbPath();
    const bundleA = createDurableBundle(dbPath);
    const orchestratorA = createTestOrchestrator(bundleA.store);
    const sessionId = `durable-memory-${Date.now()}`;
    const clientId = `${sessionId}-client`;

    const first = await orchestratorA.run({ message: 'I hate Thursdays', sessionId, clientId });
    assert(/saved that preference/i.test(String(first.reply || '')));
    const second = await orchestratorA.run({ message: 'I love Thursdays', sessionId, clientId });
    assert(/Last time you said/i.test(String(second.reply || '')), 'should produce contradiction prompt');

    bundleA.db.close();

    const bundleB = createDurableBundle(dbPath);
    const orchestratorB = createTestOrchestrator(bundleB.store);
    const confirm = await orchestratorB.run({ message: 'yes', sessionId, clientId });
    assert(/updated/i.test(String(confirm.reply || '')), 'yes after restart should resolve contradiction pending');
    const stored = bundleB.store.get({
      stateType: 'preference_memory',
      stateKey: `${sessionId}:sentiment:thursdays`,
    });
    assert(stored && stored.payload && stored.payload.value === 'love', 'updated preference should be persisted');
    bundleB.db.close();
  });

  await runCase('last results survive restart and "the first one" still resolves', async () => {
    const dbPath = createTempDbPath();
    const bundleA = createDurableBundle(dbPath);
    const orchestratorA = createTestOrchestrator(bundleA.store);
    const sessionId = `durable-results-${Date.now()}`;
    const clientId = `${sessionId}-client`;

    await orchestratorA.run({ message: 'nearest coffee shop', sessionId, clientId });
    await orchestratorA.run({ message: 'use Newark NJ', sessionId, clientId });
    const yes = await orchestratorA.run({ message: 'yes', sessionId, clientId });
    assert.strictEqual(String(yes.consentKind || ''), 'web_directions_select');
    bundleA.db.close();

    const bundleB = createDurableBundle(dbPath);
    const orchestratorB = createTestOrchestrator(bundleB.store);
    const pick = await orchestratorB.run({ message: 'the first one', sessionId, clientId });
    assert.strictEqual(pick.intent, 'local_search');
    assert.strictEqual(String(pick.consentKind || ''), 'web_directions_confirm', 'selection should resolve to confirm after restart');
    assert.ok(String(pick.pendingSelectionMatcher || '').startsWith('selection:'), 'selection matcher should be traced');
    bundleB.db.close();
  });

  await runCase('voice session state remains restart-safe while TTL is valid', async () => {
    const dbPath = createTempDbPath();
    const bundleA = createDurableBundle(dbPath);
    const nowEtProvider = () => ({ date: '2026-03-06', time: '09:40:00' });
    const managerA = createVoiceTradingSessionManager({
      stateStore: bundleA.store,
      nowEtProvider,
      fetchHealthSnapshot: async () => ({
        status: 'OK',
        topstep_bars: { ok: true, bars_returned: 100, minutes_since_last_bar: 1 },
        orb_state: { hasORBComplete: false, orbWindow: '09:30-09:45 ET', orbBarsRequired: 3 },
      }),
      enableBackgroundPolling: false,
      activeTtlMs: 5 * 60 * 1000,
    });

    managerA.touch({
      sessionId: 'voice-durable',
      clientId: 'voice-durable',
      voiceMode: true,
      symbol: 'MNQ',
    });
    managerA.shutdown();
    bundleA.db.close();

    const bundleB = createDurableBundle(dbPath);
    const managerB = createVoiceTradingSessionManager({
      stateStore: bundleB.store,
      nowEtProvider,
      fetchHealthSnapshot: async () => ({
        status: 'OK',
        topstep_bars: { ok: true, bars_returned: 100, minutes_since_last_bar: 1 },
        orb_state: { hasORBComplete: false, orbWindow: '09:30-09:45 ET', orbBarsRequired: 3 },
      }),
      enableBackgroundPolling: false,
      activeTtlMs: 5 * 60 * 1000,
    });
    const resumed = managerB.get({
      sessionId: 'voice-durable',
      clientId: 'voice-durable',
      symbol: 'MNQ',
    });
    assert.strictEqual(resumed.voiceSessionModeActive, true, 'voice session should still be active after restart');
    assert.strictEqual(resumed.timePhase, 'preORB');
    managerB.shutdown();
    bundleB.db.close();
  });

  await runCase('last explain payload survives restart via durable risk explain store', async () => {
    const dbPath = createTempDbPath();
    const bundleA = createDurableBundle(dbPath);
    configureRiskExplainStore(bundleA.store);
    rememberRiskExplain('jarvis:durable-explain', {
      blockReason: 'trade_cap',
      explainPayload: 'Blocked: one trade per day already used.',
    });
    bundleA.db.close();

    const bundleB = createDurableBundle(dbPath);
    configureRiskExplainStore(bundleB.store);
    const restored = getRiskExplain('jarvis:durable-explain');
    assert(restored && restored.payload, 'risk explain payload should restore from durable store');
    assert.strictEqual(String(restored.payload?.blockReason || ''), 'trade_cap');
    assert(/one trade per day/i.test(String(restored.payload?.explainPayload || '')));
    bundleB.db.close();
  });

  if (process.exitCode) process.exit(process.exitCode);
  console.log('All jarvis durable state tests passed.');
}

main().catch((err) => {
  console.error(`\nJarvis durable state tests failed: ${err.message}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
