/**
 * McNair Mindset by 3130
 * CLI: Import TradingView CSV + Run Backtest
 * 
 * Usage:
 *   node server/cli/import.js <csv-file>
 *   node server/cli/import.js          (imports all CSVs from data/exports/)
 */

const fs = require('fs');
const path = require('path');
const { importTradingViewCSV, parseCSV } = require('../data/ingest');
const { runBacktest } = require('../engine/backtest');
const { calcMetrics } = require('../engine/stats');
const { calcTPSL, pointsToTicks } = require('../engine/psych-levels');
const { getDB, closeDB } = require('../db/database');

const EXPORTS_DIR = path.join(__dirname, '..', '..', 'data', 'exports');

function printHeader() {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  McNAIR MINDSET by 3130');
  console.log('  Data Import & Backtest');
  console.log('═══════════════════════════════════════');
  console.log('');
}

function importFile(filePath) {
  console.log(`📂 Importing: ${path.basename(filePath)}`);

  const raw = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(raw);
  const isTradeBacktestCsv = rows.length > 0 && rows[0]['trade #'] && rows[0].type && rows[0]['date and time'];
  if (isTradeBacktestCsv) {
    return importTradeBacktestFile(filePath, rows);
  }
  
  const result = importTradingViewCSV(filePath);
  
  console.log(`   Rows parsed: ${result.totalRows}`);
  console.log(`   Candles: ${result.stats.totalCandles}`);
  console.log(`   Sessions: ${result.stats.totalSessions} (${result.stats.validSessions} valid, ${result.stats.invalidSessions} invalid)`);
  console.log(`   Date range: ${result.stats.dateRange.first} → ${result.stats.dateRange.last}`);
  
  if (result.invalidSessions.length > 0) {
    console.log(`   ⚠️  Invalid sessions:`);
    for (const inv of result.invalidSessions.slice(0, 5)) {
      console.log(`      ${inv.date}: ${inv.errors.join(', ')}`);
    }
    if (result.invalidSessions.length > 5) {
      console.log(`      ... and ${result.invalidSessions.length - 5} more`);
    }
  }
  
  // Store in database
  const db = getDB();
  
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (date, orb_high, orb_low, candle_count, day_of_week)
    VALUES (?, NULL, NULL, ?, ?)
  `);
  
  const insertCandle = db.prepare(`
    INSERT OR IGNORE INTO candles (session_id, timestamp, timeframe, open, high, low, close, volume)
    VALUES (?, ?, '5m', ?, ?, ?, ?, ?)
  `);
  
  const getSessionId = db.prepare('SELECT id FROM sessions WHERE date = ?');
  
  let sessionsAdded = 0;
  let candlesAdded = 0;
  let skipped = [];
  
  const insertAll = db.transaction(() => {
    for (const date of result.validSessions) {
      const candles = result.sessions[date];
      const d = new Date(date + 'T12:00:00'); // noon to avoid timezone issues
      const dow = d.getDay(); // 0=Sun ... 6=Sat
      const adjDow = dow === 0 ? 6 : dow - 1; // Mon=0, Sun=6
      
      try {
        insertSession.run(date, candles.length, adjDow);
      } catch (e) {
        skipped.push({ date, reason: e.message });
        continue;
      }
      const session = getSessionId.get(date);
      if (!session) {
        skipped.push({ date, reason: 'session not found after insert' });
        continue;
      }
      
      sessionsAdded++;
      
      for (const c of candles) {
        insertCandle.run(session.id, c.timestamp, c.open, c.high, c.low, c.close, c.volume);
        candlesAdded++;
      }
    }
  });
  
  insertAll();
  
  // Log the import
  db.prepare(`
    INSERT INTO imports (filename, total_rows, total_candles, sessions_added, date_range_start, date_range_end, status)
    VALUES (?, ?, ?, ?, ?, ?, 'success')
  `).run(
    path.basename(filePath),
    result.totalRows,
    result.stats.totalCandles,
    sessionsAdded,
    result.stats.dateRange.first,
    result.stats.dateRange.last
  );
  
  console.log(`   ✅ Stored: ${sessionsAdded} sessions, ${candlesAdded} candles`);
  
  return result;
}

function importTradeBacktestFile(filePath, rows) {
  console.log('   Detected TradingView strategy trade export (Entry/Exit rows)');
  const grouped = new Map();

  for (const r of rows) {
    const id = Number(r['trade #']);
    if (!id) continue;
    if (!grouped.has(id)) grouped.set(id, { id, entry: null, exit: null });
    const g = grouped.get(id);
    const type = (r.type || '').toLowerCase();
    if (type.includes('entry')) g.entry = r;
    if (type.includes('exit')) g.exit = r;
  }

  const trades = [];
  for (const g of grouped.values()) {
    if (!g.entry || !g.exit) continue;

    const direction = (g.entry.signal || '').toLowerCase().includes('short') ? 'short' : 'long';
    const entryPrice = parseFloat(g.entry['price usd']);
    const exitPrice = parseFloat(g.exit['price usd']);
    const entryTime = g.entry['date and time'];
    const exitTime = g.exit['date and time'];
    const date = String(entryTime).split(' ')[0];
    const declaredPnl = parseFloat(g.exit['net p&l usd'] || g.entry['net p&l usd'] || '0');

    if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || !entryTime || !exitTime || !date) continue;

    const tpsl = calcTPSL(entryPrice, direction, { tpMode: 'skip2', skipLevels: 2 });
    const pnlPoints = direction === 'long' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnlTicks = pointsToTicks(pnlPoints);
    let result = declaredPnl >= 0 ? 'win' : 'loss';
    if ((g.exit.signal || '').toLowerCase().includes('time')) result = declaredPnl >= 0 ? 'win' : 'loss';
    const exitReason = (g.exit.signal || '').toLowerCase().includes('time') ? 'time_close' : 'tp_sl_export';

    trades.push({
      direction,
      orb_high: entryPrice,
      orb_low: entryPrice,
      entry_price: entryPrice,
      entry_time: entryTime,
      tp_price: tpsl.tp.price,
      tp_distance_ticks: tpsl.tp.distanceTicks,
      sl_price: tpsl.sl.price,
      sl_distance_ticks: tpsl.sl.distanceTicks,
      exit_price: exitPrice,
      exit_time: exitTime,
      exit_reason: exitReason,
      result,
      pnl_ticks: pnlTicks,
      pnl_dollars: Number.isFinite(declaredPnl) ? declaredPnl : 0,
      date,
    });
  }

  const db = getDB();
  db.prepare("DELETE FROM trades WHERE source = 'backtest'").run();
  const insertTrade = db.prepare(`
    INSERT INTO trades (
      source, direction, orb_high, orb_low,
      breakout_time, breakout_candle_high, breakout_candle_low, breakout_candle_close,
      retest_time, confirmation_time,
      entry_price, entry_time, tp_price, tp_distance_ticks, sl_price, sl_distance_ticks,
      exit_price, exit_time, exit_reason, result, pnl_ticks, pnl_dollars, date
    ) VALUES (
      'backtest', ?, ?, ?,
      NULL, NULL, NULL, NULL,
      NULL, NULL,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `);

  db.transaction(() => {
    for (const t of trades) {
      insertTrade.run(
        t.direction, t.orb_high, t.orb_low,
        t.entry_price, t.entry_time, t.tp_price, t.tp_distance_ticks, t.sl_price, t.sl_distance_ticks,
        t.exit_price, t.exit_time, t.exit_reason, t.result, t.pnl_ticks, t.pnl_dollars, t.date
      );
    }
    db.prepare(`
      INSERT INTO imports (filename, total_rows, total_candles, sessions_added, date_range_start, date_range_end, status)
      VALUES (?, ?, 0, 0, ?, ?, 'success')
    `).run(
      path.basename(filePath),
      rows.length,
      trades[0]?.date || null,
      trades[trades.length - 1]?.date || null
    );
  })();

  const m = calcMetrics(trades);
  console.log(`   ✅ Stored ${trades.length} backtest trades (from trade-list export)`);
  console.log(`   WR ${m.winRate}% | PF ${m.profitFactor} | P&L $${m.totalPnlDollars}`);

  return {
    file: path.basename(filePath),
    tradeExport: true,
    totalRows: rows.length,
    trades,
    metrics: m,
    sessions: {},
    stats: {
      totalCandles: 0,
      totalSessions: 0,
      validSessions: 0,
      invalidSessions: 0,
      dateRange: { first: trades[0]?.date || null, last: trades[trades.length - 1]?.date || null },
    },
  };
}

function runFullBacktest(sessions) {
  if (!sessions || Object.keys(sessions).length === 0) {
    console.log('\n───────────────────────────────────────');
    console.log('  No candle sessions in this file.');
    console.log('  Backtest trades were imported directly into trades table.');
    console.log('───────────────────────────────────────\n');
    return null;
  }
  console.log('\n───────────────────────────────────────');
  console.log('  Running ORB 3130 Backtest...');
  console.log('───────────────────────────────────────\n');
  
  const results = runBacktest(sessions);
  const m = results.metrics;
  const dd = results.drawdown;
  const mc = results.monteCarlo;
  
  console.log('  STRATEGY: ORB 3130 × MNQ');
  console.log(`  PERIOD: ${results.summary.dateRange.start} → ${results.summary.dateRange.end}`);
  console.log(`  SESSIONS: ${results.summary.totalSessions} (${results.summary.sessionsWithTrade} with trades)`);
  console.log(`  TRADE FREQUENCY: ${results.summary.tradeFrequency}%`);
  console.log('');
  
  console.log('  ┌─────────────────────────────────┐');
  console.log(`  │  WIN RATE:       ${m.winRate.toFixed(1)}%           │`);
  console.log(`  │  PROFIT FACTOR:  ${m.profitFactor.toFixed(2)}            │`);
  console.log(`  │  SHARPE RATIO:   ${results.sharpe.toFixed(2)}            │`);
  console.log(`  │  SORTINO RATIO:  ${results.sortino.toFixed(2)}            │`);
  console.log('  └─────────────────────────────────┘');
  console.log('');
  
  console.log(`  Total P&L:         $${m.totalPnlDollars.toFixed(2)} (${m.totalPnlTicks} ticks)`);
  console.log(`  Avg Win:           $${m.avgWinDollars.toFixed(2)} (${m.avgWinTicks} ticks)`);
  console.log(`  Avg Loss:          $${m.avgLossDollars.toFixed(2)} (${m.avgLossTicks} ticks)`);
  console.log(`  Expectancy:        $${m.expectancyDollars.toFixed(2)}/trade`);
  console.log(`  Max Consec Wins:   ${m.maxConsecWins}`);
  console.log(`  Max Consec Losses: ${m.maxConsecLosses}`);
  console.log('');
  
  console.log(`  Max Drawdown:      $${dd.maxDrawdownDollars.toFixed(2)} (${dd.maxDrawdownPercent}%)`);
  console.log(`  Longest DD:        ${dd.longestDrawdownTrades} trades`);
  console.log(`  Final Balance:     $${dd.finalBalance.toFixed(2)}`);
  console.log('');
  
  console.log(`  Long Trades:       ${m.longTrades} (${m.longWinRate}% WR)`);
  console.log(`  Short Trades:      ${m.shortTrades} (${m.shortWinRate}% WR)`);
  console.log('');
  
  // Exit reasons
  console.log('  Exit Reasons:');
  for (const [reason, count] of Object.entries(results.exitReasons)) {
    console.log(`    ${reason}: ${count} (${Math.round(count / m.totalTrades * 100)}%)`);
  }
  console.log('');
  
  // No-trade reasons
  console.log('  No-Trade Sessions:');
  for (const [reason, count] of Object.entries(results.noTradeReasons)) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log('');
  
  // Monte Carlo — Topstep
  if (mc.simulations > 0) {
    console.log('  ┌─────────────────────────────────┐');
    console.log('  │  TOPSTEP MONTE CARLO (10K sims) │');
    console.log('  ├─────────────────────────────────┤');
    console.log(`  │  Hit Payout:     ${mc.probabilities.hitPayout}%          │`);
    console.log(`  │  Hit Drawdown:   ${mc.probabilities.hitDrawdown}%          │`);
    console.log(`  │  Survived:       ${mc.probabilities.survived}%          │`);
    console.log('  └─────────────────────────────────┘');
    console.log('');
  }
  
  // Edge Decay
  console.log(`  Edge Decay: ${results.decay.status}`);
  if (results.decay.decayDetected) {
    console.log(`    ⚠️  Win Rate deviation: ${results.decay.deviation.winRate} SD`);
    console.log(`    ⚠️  PF deviation: ${results.decay.deviation.profitFactor} SD`);
  }
  
  // Store backtest trades in database
  const db = getDB();
  const insertTrade = db.prepare(`
    INSERT INTO trades (
      source, direction, orb_high, orb_low,
      breakout_time, breakout_candle_high, breakout_candle_low, breakout_candle_close,
      retest_time, confirmation_time,
      entry_price, entry_time, tp_price, tp_distance_ticks, sl_price, sl_distance_ticks,
      exit_price, exit_time, exit_reason, result, pnl_ticks, pnl_dollars, date
    ) VALUES (
      'backtest', ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `);
  
  // Clear previous backtest trades
  db.prepare("DELETE FROM trades WHERE source = 'backtest'").run();
  
  const storeTrades = db.transaction(() => {
    for (const t of results.trades) {
      insertTrade.run(
        t.direction, t.orb_high, t.orb_low,
        t.breakout_time, t.breakout_candle_high, t.breakout_candle_low, t.breakout_candle_close,
        t.retest_time, t.confirmation_time,
        t.entry_price, t.entry_time, t.tp_price, t.tp_distance_ticks, t.sl_price, t.sl_distance_ticks,
        t.exit_price, t.exit_time, t.exit_reason, t.result, t.pnl_ticks, t.pnl_dollars, t.date
      );
    }
  });
  
  storeTrades();
  console.log(`\n  ✅ ${results.trades.length} backtest trades stored in database`);
  
  return results;
}

// ============================================================
// MAIN
// ============================================================

printHeader();

const args = process.argv.slice(2);

if (args.length > 0) {
  // Import specific file
  const filePath = path.resolve(args[0]);
  if (!fs.existsSync(filePath)) {
    console.log(`❌ File not found: ${filePath}`);
    process.exit(1);
  }
  const result = importFile(filePath);
  runFullBacktest(result.sessions);
} else {
  // Import all CSVs from exports directory
  if (!fs.existsSync(EXPORTS_DIR)) {
    console.log(`❌ Exports directory not found: ${EXPORTS_DIR}`);
    console.log('   Create it and place your TradingView CSV exports there.');
    process.exit(1);
  }
  
  const csvFiles = fs.readdirSync(EXPORTS_DIR).filter(f => f.endsWith('.csv'));
  
  if (csvFiles.length === 0) {
    console.log('📭 No CSV files found in data/exports/');
    console.log('');
    console.log('   How to export from TradingView:');
    console.log('   1. Open MNQ chart (5-minute timeframe)');
    console.log('   2. Right-click chart → Export chart data...');
    console.log('   3. Save CSV to: data/exports/');
    console.log('   4. Run this command again');
    process.exit(0);
  }
  
  console.log(`Found ${csvFiles.length} CSV file(s)\n`);
  
  let allSessions = {};
  
  for (const file of csvFiles) {
    const result = importFile(path.join(EXPORTS_DIR, file));
    // Merge sessions
    Object.assign(allSessions, result.sessions);
    console.log('');
  }
  
  // Run backtest on all imported data
  const sessionCount = Object.keys(allSessions).length;
  if (sessionCount > 0) {
    runFullBacktest(allSessions);
  }
}

closeDB();

console.log('\n═══════════════════════════════════════');
console.log('  3130 — McNair Mindset');
console.log('═══════════════════════════════════════\n');
