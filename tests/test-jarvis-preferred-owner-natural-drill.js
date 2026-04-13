#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  ensureRecommendationOutcomeSchema,
  upsertTodayRecommendationContext,
} = require('../server/jarvis-core/recommendation-outcome');
const {
  ensureDataFoundationTables,
} = require('../server/jarvis-core/data-foundation-storage');
const {
  runAutomaticDailyScoring,
} = require('../server/jarvis-core/daily-evidence-scoring');
const {
  runPreferredOwnerNaturalDrill,
  resolveDrillOutcome,
} = require('../server/jarvis-core/preferred-owner-natural-drill');

function makeDb() {
  const db = new Database(':memory:');
  ensureRecommendationOutcomeSchema(db);
  ensureDataFoundationTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      direction TEXT,
      entry_price REAL,
      entry_time TEXT,
      exit_time TEXT,
      result TEXT,
      pnl_ticks REAL,
      pnl_dollars REAL
    );
  `);
  return db;
}

function buildSessionCandles(date, count = 90) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const totalMinutes = (9 * 60) + 30 + (i * 5);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    const time = `${hh}:${mm}:00`;
    const timestamp = `${date} ${time}`;
    const open = price;
    const close = price + 0.4;
    const high = close + 0.2;
    const low = open - 0.2;
    candles.push({
      timestamp,
      date,
      time,
      open,
      high,
      low,
      close,
      volume: 1000 + i,
    });
    price = close;
  }
  return candles;
}

function seedRecommendationContext(db, date) {
  upsertTodayRecommendationContext({
    db,
    recDate: date,
    sourceType: 'live',
    reconstructionPhase: 'live_intraday',
    reconstructionVersion: 'test_live_v1',
    generatedAt: `${date}T09:25:00.000Z`,
    todayRecommendation: {
      posture: 'trade_selectively',
      recommendedStrategy: 'ORB 3130 Core',
      recommendedTpMode: 'Skip 2',
      confidenceLabel: 'medium',
      confidenceScore: 58,
    },
    strategyLayers: {
      recommendationBasis: {
        recommendedStrategyKey: 'original_plan_orb_3130',
        recommendedStrategyName: 'ORB 3130 Core',
      },
    },
    mechanicsResearchSummary: {
      recommendedTpMode: 'Skip 2',
    },
    context: {
      nowEt: { date, time: '09:25' },
      sessionPhase: 'pre_open',
    },
  });
}

function runNaturalCloseComplete(db, sessions, targetDay, nowTime = '18:10') {
  return runAutomaticDailyScoring({
    db,
    sessions,
    nowDate: targetDay,
    nowTime,
    mode: 'scheduled_live_finalization_close_window',
    windowDays: 5,
    finalizationOnly: true,
    runOrigin: 'natural',
    runtimeTriggered: true,
    finalizationSweepSource: 'close_complete_checkpoint',
    checkpointTargetTradingDay: targetDay,
  });
}

function runManualFinalization(db, sessions, targetDay, nowTime = '18:05') {
  return runAutomaticDailyScoring({
    db,
    sessions,
    nowDate: targetDay,
    nowTime,
    mode: 'manual_live_finalization',
    windowDays: 5,
    finalizationOnly: true,
    runOrigin: 'manual',
    runtimeTriggered: false,
    finalizationSweepSource: 'manual_api_run',
    checkpointTargetTradingDay: targetDay,
  });
}

function getBundleCount(db, targetDay) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
  `).get(targetDay)?.c || 0);
}

function deleteBundle(db, targetDay) {
  db.prepare(`
    DELETE FROM jarvis_preferred_owner_operational_proof_bundles
    WHERE target_trading_day = ?
  `).run(targetDay);
}

function runTests() {
  {
    const db = makeDb();
    const date = '2026-03-13';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 20) };
    runNaturalCloseComplete(db, sessions, date, '18:02');

    const drill = runPreferredOwnerNaturalDrill({
      db,
      sessions,
      nowDate: date,
      nowTime: '18:03',
    });
    assert.strictEqual(
      drill.drillOutcome,
      'not_ready_checkpoint_unresolved',
      'unresolved natural day should return not_ready_checkpoint_unresolved'
    );
    assert.strictEqual(
      getBundleCount(db, date),
      0,
      'unresolved natural day must not create proof bundle rows'
    );
  }

  {
    const db = makeDb();
    const date = '2026-03-11';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 90) };
    runNaturalCloseComplete(db, sessions, date, '18:10');
    deleteBundle(db, date);

    const drill = runPreferredOwnerNaturalDrill({
      db,
      sessions,
      nowDate: date,
      nowTime: '18:11',
    });
    assert.strictEqual(
      drill.drillOutcome,
      'resolved_and_captured',
      'resolved natural preferred-owner win should capture proof bundle'
    );
    assert.strictEqual(
      drill.verifier.verifierPass,
      true,
      'resolved natural win drill should preserve verifier pass'
    );
    assert.strictEqual(
      getBundleCount(db, date),
      1,
      'resolved natural win drill should create exactly one proof bundle row'
    );
  }

  {
    const db = makeDb();
    const date = '2026-03-10';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 90) };
    runManualFinalization(db, sessions, date, '18:05');
    runNaturalCloseComplete(db, sessions, date, '18:10');
    deleteBundle(db, date);

    const drill = runPreferredOwnerNaturalDrill({
      db,
      sessions,
      nowDate: date,
      nowTime: '18:11',
    });
    assert.strictEqual(
      drill.drillOutcome,
      'resolved_but_verifier_failed',
      'resolved natural preferred-owner loss should capture fail bundle with resolved_but_verifier_failed'
    );
    assert.strictEqual(
      drill.verifier.verifierPass,
      false,
      'resolved natural loss drill should preserve verifier fail'
    );
    assert.strictEqual(
      getBundleCount(db, date),
      1,
      'resolved natural loss drill should create exactly one proof bundle row'
    );
  }

  {
    const db = makeDb();
    const date = '2026-03-09';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 90) };
    runNaturalCloseComplete(db, sessions, date, '18:10');

    const first = runPreferredOwnerNaturalDrill({
      db,
      sessions,
      nowDate: date,
      nowTime: '18:11',
    });
    const second = runPreferredOwnerNaturalDrill({
      db,
      sessions,
      nowDate: date,
      nowTime: '18:12',
    });
    assert.strictEqual(
      first.drillOutcome,
      'resolved_already_captured',
      'first rerun after capture should classify as already captured'
    );
    assert.strictEqual(
      second.drillOutcome,
      'resolved_already_captured',
      'second rerun should remain resolved_already_captured without duplicates'
    );
    assert.strictEqual(
      getBundleCount(db, date),
      1,
      'rerunning same resolved day must not duplicate proof bundle rows'
    );
  }

  {
    const outcome = resolveDrillOutcome({
      resolved: true,
      bundleExistsBefore: false,
      bundleExistsAfter: false,
      verifierPass: true,
    });
    assert.strictEqual(
      outcome,
      'resolved_but_bundle_missing_bug',
      'resolved day with missing proof bundle must classify as resolved_but_bundle_missing_bug'
    );
  }

  console.log('✅ preferred-owner natural drill deterministic tests passed');
}

runTests();
