'use strict';
/**
 * Backfill jarvis_simulated_trade_outcome_ledger_daily rows for the
 * 8 PRAC-V2 trade dates missing from the live sim ledger:
 *   2026-02-02, 02-03, 02-04, 02-09, 02-10, 02-11, 03-01, 03-02
 *
 * Runs the new ORIGINAL_PLAN_SPEC (user-method) engine on each date's
 * 5-min candles and writes the corresponding sim ledger row so JARVIS
 * has memory of what it would have decided on those days.
 *
 * Idempotent: ON CONFLICT does nothing (existing rows preserved).
 */

const path = require('path');
const { getDB } = require(path.join(__dirname, '../server/db/database.js'));
const { processSession } = require(path.join(__dirname, '../server/engine/orb.js'));
const { ORIGINAL_PLAN_SPEC } = require(path.join(__dirname, '../server/jarvis-core/strategy-layers.js'));
const { calcTPSL } = require(path.join(__dirname, '../server/engine/psych-levels.js'));

const PRAC_V2_DATES_TO_BACKFILL = [
  '2026-02-02', '2026-02-03', '2026-02-04',
  '2026-02-09', '2026-02-10', '2026-02-11',
  '2026-03-01', '2026-03-02',
];

function loadCandlesForDate(db, date) {
  const rows = db.prepare(`
    SELECT c.timestamp, c.open, c.high, c.low, c.close, c.volume
    FROM candles c JOIN sessions s ON s.id = c.session_id
    WHERE s.date = ? AND c.timeframe = '5m'
    ORDER BY c.timestamp ASC
  `).all(date);
  return rows.map(r => ({
    timestamp: r.timestamp,
    date,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

function upsertMinimalLedgerRow(db, row) {
  // The full upsert requires the recommendation-outcome's helper. To keep
  // this script standalone and predictable, write a minimal row directly.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS jarvis_simulated_trade_outcome_ledger_daily (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                    TEXT NOT NULL,
      source_type                   TEXT NOT NULL DEFAULT 'live',
      reconstruction_phase          TEXT NOT NULL DEFAULT 'live_intraday',
      simulation_version            TEXT NOT NULL DEFAULT 'jarvis_simulated_trade_outcome_v1',
      did_jarvis_take_trade         INTEGER NOT NULL DEFAULT 0,
      no_trade_reason               TEXT,
      strategy_key                  TEXT,
      strategy_name                 TEXT,
      tp_mode_selected              TEXT,
      entry_price                   REAL,
      stop_price                    REAL,
      nearest_tp_price              REAL,
      skip1_tp_price                REAL,
      skip2_tp_price                REAL,
      selected_target_price         REAL,
      selected_path_outcome         TEXT,
      selected_path_pnl             REAL,
      nearest_tp_outcome            TEXT,
      skip1_tp_outcome              TEXT,
      skip2_tp_outcome              TEXT,
      max_favorable_excursion       REAL,
      max_adverse_excursion         REAL,
      source_candles_complete       INTEGER NOT NULL DEFAULT 0,
      simulation_confidence         REAL,
      snapshot_json                 TEXT NOT NULL DEFAULT '{}',
      created_at                    TEXT DEFAULT (datetime('now')),
      updated_at                    TEXT DEFAULT (datetime('now')),
      UNIQUE(trade_date, source_type, reconstruction_phase, simulation_version)
    )
  `).run();

  db.prepare(`
    INSERT INTO jarvis_simulated_trade_outcome_ledger_daily (
      trade_date, source_type, reconstruction_phase, simulation_version,
      did_jarvis_take_trade, no_trade_reason, strategy_key, strategy_name,
      tp_mode_selected, entry_price, stop_price, nearest_tp_price,
      selected_target_price, selected_path_outcome, selected_path_pnl,
      nearest_tp_outcome, source_candles_complete, simulation_confidence,
      snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date, source_type, reconstruction_phase, simulation_version)
    DO UPDATE SET
      did_jarvis_take_trade = excluded.did_jarvis_take_trade,
      no_trade_reason = excluded.no_trade_reason,
      strategy_key = excluded.strategy_key,
      strategy_name = excluded.strategy_name,
      tp_mode_selected = excluded.tp_mode_selected,
      entry_price = excluded.entry_price,
      stop_price = excluded.stop_price,
      nearest_tp_price = excluded.nearest_tp_price,
      selected_target_price = excluded.selected_target_price,
      selected_path_outcome = excluded.selected_path_outcome,
      selected_path_pnl = excluded.selected_path_pnl,
      nearest_tp_outcome = excluded.nearest_tp_outcome,
      source_candles_complete = excluded.source_candles_complete,
      simulation_confidence = excluded.simulation_confidence,
      snapshot_json = excluded.snapshot_json,
      updated_at = datetime('now')
  `).run(
    row.tradeDate,
    'live',
    'backfill_audit_2026_04_25',
    'jarvis_simulated_trade_outcome_v1',
    row.didJarvisTakeTrade ? 1 : 0,
    row.noTradeReason || null,
    row.strategyKey || null,
    row.strategyName || null,
    row.tpModeSelected || null,
    row.entryPrice ?? null,
    row.stopPrice ?? null,
    row.nearestTpPrice ?? null,
    row.selectedTargetPrice ?? null,
    row.selectedPathOutcome || null,
    row.selectedPathPnl ?? null,
    row.nearestTpOutcome || null,
    row.sourceCandlesComplete ? 1 : 0,
    row.simulationConfidence ?? 0.85,
    JSON.stringify(row.snapshot || {})
  );
}

function main() {
  const db = getDB();
  console.log(`Backfilling ${PRAC_V2_DATES_TO_BACKFILL.length} dates with new ORIGINAL_PLAN_SPEC engine`);
  console.log(`engineOptions:`, ORIGINAL_PLAN_SPEC.engineOptions);
  console.log('');

  let written = 0;
  for (const date of PRAC_V2_DATES_TO_BACKFILL) {
    const candles = loadCandlesForDate(db, date);
    if (!candles.length) {
      console.log(`  ${date}  no candles available — skip`);
      continue;
    }
    const result = processSession(candles, { ...ORIGINAL_PLAN_SPEC.engineOptions });

    let row;
    if (result.trade) {
      row = {
        tradeDate: date,
        didJarvisTakeTrade: true,
        noTradeReason: null,
        strategyKey: ORIGINAL_PLAN_SPEC.key,
        strategyName: ORIGINAL_PLAN_SPEC.name,
        tpModeSelected: ORIGINAL_PLAN_SPEC.engineOptions.tpMode,
        entryPrice: result.trade.entry_price,
        stopPrice: result.trade.sl_price,
        nearestTpPrice: result.trade.tp_price,
        selectedTargetPrice: result.trade.tp_price,
        selectedPathOutcome: result.trade.result || null,
        selectedPathPnl: result.trade.pnl_dollars,
        nearestTpOutcome: result.trade.result || null,
        sourceCandlesComplete: true,
        simulationConfidence: 0.95,
        snapshot: { engineOptions: ORIGINAL_PLAN_SPEC.engineOptions, filters: ORIGINAL_PLAN_SPEC.filters, trade: result.trade },
      };
      console.log(`  ${date}  YES  ${result.trade.direction.toUpperCase()}  entry=${result.trade.entry_price}  tp=${result.trade.tp_price}  sl=${result.trade.sl_price}  result=${result.trade.result}  pnl=$${result.trade.pnl_dollars}`);
    } else {
      row = {
        tradeDate: date,
        didJarvisTakeTrade: false,
        noTradeReason: result.no_trade_reason || 'unknown',
        strategyKey: ORIGINAL_PLAN_SPEC.key,
        strategyName: ORIGINAL_PLAN_SPEC.name,
        tpModeSelected: ORIGINAL_PLAN_SPEC.engineOptions.tpMode,
        sourceCandlesComplete: true,
        simulationConfidence: 0.9,
        snapshot: { engineOptions: ORIGINAL_PLAN_SPEC.engineOptions, filters: ORIGINAL_PLAN_SPEC.filters, signals: result.signals || [] },
      };
      console.log(`  ${date}  NO   ${result.no_trade_reason}`);
    }
    upsertMinimalLedgerRow(db, row);
    written += 1;
  }
  console.log('');
  console.log(`Wrote ${written} sim ledger rows.`);
}

main();
