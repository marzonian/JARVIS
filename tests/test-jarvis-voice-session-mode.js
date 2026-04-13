#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  createVoiceTradingSessionManager,
  resolveVoiceTradingTimePhase,
  resolveVoiceHealthPollIntervalMs,
} = require('../server/jarvis-core/voice-session');

function makeNowEt(date = '2026-03-04', time = '09:50:00') {
  return { date, time };
}

async function run() {
  {
    const pre = resolveVoiceTradingTimePhase({ nowEtTime: '09:35:00' });
    const orbSet = resolveVoiceTradingTimePhase({ nowEtTime: '09:50:00' });
    const momentum = resolveVoiceTradingTimePhase({ nowEtTime: '10:22:00' });
    const post = resolveVoiceTradingTimePhase({ nowEtTime: '11:05:00' });
    assert.strictEqual(pre.timePhase, 'preORB');
    assert.strictEqual(pre.inEntryWindow, true);
    assert.strictEqual(orbSet.timePhase, 'orbSet');
    assert.strictEqual(orbSet.inEntryWindow, true);
    assert.strictEqual(momentum.timePhase, 'momentum');
    assert.strictEqual(momentum.inEntryWindow, true);
    assert.strictEqual(post.timePhase, 'postWindow');
    assert.strictEqual(post.inEntryWindow, false);
  }

  {
    assert.strictEqual(resolveVoiceHealthPollIntervalMs({ nowEtTime: '08:25:00' }), 15000);
    assert.strictEqual(resolveVoiceHealthPollIntervalMs({ nowEtTime: '11:59:00' }), 15000);
    assert.strictEqual(resolveVoiceHealthPollIntervalMs({ nowEtTime: '12:20:00' }), 60000);
    assert.strictEqual(resolveVoiceHealthPollIntervalMs({ nowEtTime: '06:45:00' }), 60000);
  }

  {
    let fetchCount = 0;
    const manager = createVoiceTradingSessionManager({
      nowEtProvider: () => makeNowEt('2026-03-04', '09:52:00'),
      fetchHealthSnapshot: async () => {
        fetchCount += 1;
        return {
          now_et: '2026-03-04 09:52:00 ET',
          status: 'OK',
          reason: null,
          topstep_bars: {
            ok: true,
            bars_returned: 120,
            minutes_since_last_bar: 1,
            last_close: 25000.25,
          },
          orb_state: {
            hasORBComplete: true,
            orbWindow: '09:30-09:45 ET',
            orbBarsRequired: 3,
          },
          db_persist: {
            sessions_last_date: '2026-03-04',
          },
          contractId_in_use: 'MNQH6',
          contract_roll_status: 'OK',
        };
      },
      enableBackgroundPolling: false,
      activeTtlMs: 180000,
    });

    const touched = manager.touch({
      sessionId: 'voice-session-unit',
      clientId: 'voice-session-unit',
      voiceMode: true,
      symbol: 'MNQ',
    });
    assert.strictEqual(touched.voiceSessionModeActive, true);
    assert.strictEqual(touched.timePhase, 'orbSet');

    const ensured = await manager.ensureForTrading({
      sessionId: 'voice-session-unit',
      clientId: 'voice-session-unit',
      symbol: 'MNQ',
      intent: 'trading_decision',
    });
    assert.strictEqual(ensured.voiceSessionModeActive, true);
    assert.strictEqual(ensured.healthStatusUsed, 'OK');
    assert.strictEqual(ensured.timePhase, 'orbSet');
    assert.strictEqual(ensured.inEntryWindow, true);
    assert.ok(Number.isFinite(Number(ensured.lastHealthAgeSeconds)));
    assert.strictEqual(fetchCount, 1);

    const state = manager.get({
      sessionId: 'voice-session-unit',
      clientId: 'voice-session-unit',
    });
    assert.strictEqual(state.voiceSessionModeActive, true);
    assert.strictEqual(state.healthStatusUsed, 'OK');
    manager.shutdown();
  }

  {
    const manager = createVoiceTradingSessionManager({
      nowEtProvider: () => makeNowEt('2026-03-04', '10:03:00'),
      fetchHealthSnapshot: async () => {
        throw new Error('market_health_down');
      },
      enableBackgroundPolling: false,
      activeTtlMs: 180000,
    });
    const ensured = await manager.ensureForTrading({
      sessionId: 'voice-session-failure',
      clientId: 'voice-session-failure',
      symbol: 'MNQ',
      intent: 'trading_status',
      forceFresh: true,
    });
    assert.strictEqual(ensured.voiceSessionModeActive, true);
    assert.strictEqual(ensured.healthStatusUsed, 'STALE');
    assert.strictEqual(String(ensured.snapshotUsed?.status || ''), 'STALE');
    assert.ok(/failed/i.test(String(ensured.snapshotUsed?.reason || '')));
    manager.shutdown();
  }

  {
    const manager = createVoiceTradingSessionManager({
      nowEtProvider: () => makeNowEt('2026-03-04', '09:41:00'),
      fetchHealthSnapshot: async () => {
        throw new Error('should_not_be_called_for_audit_mock');
      },
      enableBackgroundPolling: false,
      activeTtlMs: 180000,
    });
    const ensured = await manager.ensureForTrading({
      sessionId: 'voice-session-audit',
      clientId: 'voice-session-audit',
      symbol: 'MNQ',
      intent: 'trading_decision',
      auditMock: {
        nowEt: { date: '2026-03-04', time: '09:41:00' },
        healthStatus: 'OK',
        healthReason: 'audit_mock_health_ok',
        riskInputs: {
          marketDataFreshness: {
            hasTodaySessionBars: true,
            hasORBComplete: false,
            usedLiveBars: true,
            minutesSinceLastCandle: 1,
            nowEt: { date: '2026-03-04', time: '09:41:00' },
            sessionDateOfData: '2026-03-04',
          },
        },
      },
    });
    assert.strictEqual(ensured.healthStatusUsed, 'OK');
    assert.strictEqual(ensured.timePhase, 'preORB');
    assert.strictEqual(ensured.inEntryWindow, true);
    assert.strictEqual(ensured.snapshotUsed?.orb_state?.hasORBComplete, false);
    manager.shutdown();
  }

  console.log('All jarvis voice session mode tests passed.');
}

run().catch((err) => {
  console.error(`\nJarvis voice session mode tests failed: ${err.message}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
