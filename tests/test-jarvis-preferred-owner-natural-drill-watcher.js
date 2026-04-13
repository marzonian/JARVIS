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
  buildDailyScoringStatus,
  PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM,
} = require('../server/jarvis-core/daily-evidence-scoring');
const {
  runPreferredOwnerNaturalDrillWatcher,
} = require('../server/jarvis-core/preferred-owner-natural-drill-watcher');

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

function runNaturalFinalization(db, sessions, targetDay, nowTime, sweepSource = 'close_complete_checkpoint') {
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
    finalizationSweepSource: sweepSource,
    checkpointTargetTradingDay: targetDay,
  });
}

function countWatchRows(db, targetDay) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_preferred_owner_natural_drill_watch_runs
    WHERE target_trading_day = ?
  `).get(targetDay)?.c || 0);
}

function runTests() {
  {
    const db = makeDb();
    const date = '2026-03-13';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 20) };
    const run = runNaturalFinalization(db, sessions, date, '18:02');

    const watcher = runPreferredOwnerNaturalDrillWatcher({
      db,
      sessions,
      currentRun: run,
      nowDate: date,
      nowTime: '18:03',
      windowDays: 5,
      runtimeTriggered: true,
      force: false,
    });

    assert.strictEqual(watcher.status, 'waiting_for_resolution', 'unresolved day should remain waiting');
    assert.strictEqual(countWatchRows(db, date), 0, 'unresolved day must not persist watch row');
  }

  {
    const db = makeDb();
    const date = '2026-03-11';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 90) };
    const run = runNaturalFinalization(db, sessions, date, '18:10', 'close_complete_checkpoint');

    const watcher = runPreferredOwnerNaturalDrillWatcher({
      db,
      sessions,
      currentRun: run,
      nowDate: date,
      nowTime: '18:11',
      windowDays: 5,
      runtimeTriggered: true,
      force: false,
    });

    assert.strictEqual(watcher.status, 'triggered_and_executed', 'first resolved close-complete run should trigger watcher');
    assert.strictEqual(watcher.executed, true, 'watcher should mark executed on trigger');
    assert.strictEqual(countWatchRows(db, date), 1, 'watcher must persist one row for target day');

    const status = buildDailyScoringStatus({ db, sessions, nowDate: date, windowDays: 5 });
    assert(
      PREFERRED_OWNER_NATURAL_DRILL_WATCHER_OUTCOME_ENUM.includes(
        String(status.livePreferredOwnerNaturalDrillWatcherStatus || '')
      ),
      'daily scoring status should expose bounded livePreferredOwnerNaturalDrillWatcherStatus'
    );
    assert.strictEqual(
      status.livePreferredOwnerNaturalDrillWatcherStatus,
      'already_executed_for_target_day',
      'status endpoint should report already_executed_for_target_day after trigger'
    );

    const rerun = runPreferredOwnerNaturalDrillWatcher({
      db,
      sessions,
      currentRun: run,
      nowDate: date,
      nowTime: '18:12',
      windowDays: 5,
      runtimeTriggered: true,
      force: false,
    });
    assert.strictEqual(rerun.status, 'already_executed_for_target_day', 'rerun should dedupe by target day');
    assert.strictEqual(countWatchRows(db, date), 1, 'rerun must not duplicate watch rows');
  }

  {
    const db = makeDb();
    const date = '2026-03-10';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 90) };
    runNaturalFinalization(db, sessions, date, '18:10', 'close_complete_checkpoint');
    const run = runNaturalFinalization(db, sessions, date, '19:05', 'late_data_recovery');

    const watcher = runPreferredOwnerNaturalDrillWatcher({
      db,
      sessions,
      currentRun: run,
      nowDate: date,
      nowTime: '19:06',
      windowDays: 5,
      runtimeTriggered: true,
      force: false,
    });

    assert.strictEqual(
      watcher.status,
      'resolved_but_not_close_complete_source',
      'resolved natural run with non-close-complete source should be classified accordingly'
    );
    assert.strictEqual(watcher.executed, false, 'wrong source should not execute drill');
    assert.strictEqual(countWatchRows(db, date), 1, 'wrong-source resolution should persist one deduped watch row');
  }

  {
    const db = makeDb();
    const date = '2026-03-09';
    seedRecommendationContext(db, date);
    const sessions = { [date]: buildSessionCandles(date, 90) };
    const run = runNaturalFinalization(db, sessions, date, '18:10', 'close_complete_checkpoint');

    const watcher = runPreferredOwnerNaturalDrillWatcher({
      db,
      sessions,
      currentRun: run,
      nowDate: date,
      nowTime: '18:11',
      windowDays: 5,
      runtimeTriggered: true,
      force: false,
      forceDrillFailure: true,
    });

    assert.strictEqual(
      watcher.status,
      'resolved_but_drill_failed',
      'forced drill failure should classify as resolved_but_drill_failed'
    );
    assert.strictEqual(watcher.executed, true, 'forced drill failure should still persist executed watch row');
    assert.strictEqual(countWatchRows(db, date), 1, 'forced failure should still persist exactly one watch row');
  }

  console.log('✅ preferred-owner natural drill watcher deterministic tests passed');
}

runTests();
