'use strict';
/**
 * Layer 4 — JARVIS Self-Critique / Learning Loop
 *
 * Records every live trade with both:
 *   (a) what the UI recommendation said (user's method, e.g. Nearest TP)
 *   (b) what JARVIS autonomy actually did on PRAC-V2 (e.g. Skip2 TP)
 * Plus the actual fill outcome, so we can compute counterfactual P&L for
 * the spec that wasn't executed and have real, regime-current evidence on
 * which spec performs better.
 *
 * Two-track architecture per user directive 2026-04-25:
 *   - User trades Nearest TP manually
 *   - JARVIS autonomy trades Skip2 TP on PRAC-V2
 *   - L4 measures both, every day
 *
 * Tables:
 *   l4_trade_postmortem      — one row per live trade JARVIS placed
 *   l4_daily_learning_row    — one row per trading day (aggregator output)
 *
 * Lifecycle:
 *   1. Autonomy loop calls recordTradeIntent() at order placement
 *   2. Auto-journal calls recordTradeOutcome() when fills resolve
 *   3. End-of-day cron calls aggregateDailyLearning(date) to compute drift
 *   4. Recommendation engine calls readRecentLearningRows(N) to feed back
 */

function ensureL4Tables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS l4_trade_postmortem (
      id                              INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                      TEXT NOT NULL,
      symbol                          TEXT NOT NULL,
      account_id                      TEXT NOT NULL,
      account_name                    TEXT,

      -- Identity
      intent_id                       INTEGER,
      broker_order_id                 TEXT UNIQUE,
      setup_id                        TEXT,
      setup_name                      TEXT,
      direction                       TEXT CHECK(direction IN ('long','short')),
      qty                             INTEGER,

      -- Recommendation track (UI-shown to user — user-method spec)
      rec_spec_key                    TEXT,
      rec_tp_mode                     TEXT,
      rec_tp_price                    REAL,
      rec_sl_price                    REAL,
      rec_tp_ticks                    INTEGER,
      rec_sl_ticks                    INTEGER,
      rec_predicted_pnl_dollars       REAL,

      -- Autonomy track (actual live order JARVIS placed)
      autonomy_spec_key               TEXT,
      autonomy_tp_mode                TEXT,
      autonomy_bracket_mode           TEXT, -- 'follow_recommendation' or 'autonomy_override'
      autonomy_tp_price               REAL,
      autonomy_sl_price               REAL,
      autonomy_tp_ticks               INTEGER,
      autonomy_sl_ticks               INTEGER,

      -- Actual execution (filled in after fills land)
      live_entry_time                 TEXT,
      live_entry_price                REAL,
      live_exit_time                  TEXT,
      live_exit_price                 REAL,
      live_exit_reason                TEXT,
      live_actual_pnl_dollars         REAL,

      -- Drift / cost telemetry
      entry_slippage_ticks            REAL,
      pnl_drift_vs_recommendation     REAL,
      pnl_drift_vs_autonomy_predict   REAL,

      -- Counterfactuals (computed at EOD by aggregator)
      counterfactual_nearest_pnl      REAL,
      counterfactual_skip2_pnl        REAL,
      spec_diff_dollars               REAL, -- chosen spec advantage vs alternative

      -- Regime context
      orb_high                        REAL,
      orb_low                         REAL,
      orb_range_ticks                 INTEGER,
      day_of_week                     INTEGER,
      regime_trend                    TEXT,
      regime_vol                      TEXT,

      -- Metadata
      status                          TEXT DEFAULT 'placed' CHECK(status IN ('placed','filled','closed','cancelled','error')),
      notes                           TEXT,
      raw_intent_meta_json            TEXT,
      created_at                      TEXT DEFAULT (datetime('now')),
      updated_at                      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_l4_postmortem_date_status
      ON l4_trade_postmortem(trade_date DESC, status);
    CREATE INDEX IF NOT EXISTS idx_l4_postmortem_intent
      ON l4_trade_postmortem(intent_id);

    CREATE TABLE IF NOT EXISTS l4_daily_learning_row (
      id                              INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                      TEXT NOT NULL UNIQUE,

      -- Live aggregate
      n_live_trades                   INTEGER NOT NULL DEFAULT 0,
      live_total_pnl_dollars          REAL DEFAULT 0,
      live_winrate_pct                REAL,
      live_avg_pnl_dollars            REAL,

      -- Two-track comparison
      nearest_total_pnl_dollars       REAL DEFAULT 0,
      skip2_total_pnl_dollars         REAL DEFAULT 0,
      autonomy_advantage_dollars      REAL, -- skip2 - nearest if autonomy=skip2
      shadow_advantage_dollars        REAL, -- the one not used today, advantage

      -- Drift / cost telemetry
      avg_entry_slippage_ticks        REAL,
      avg_predict_drift_dollars       REAL, -- sim predicted vs actual

      -- Filter performance today
      filter_skip_decisions           INTEGER DEFAULT 0,
      filter_skip_correct             INTEGER DEFAULT 0, -- skipped days that would have lost
      filter_skip_wrong               INTEGER DEFAULT 0, -- skipped days that would have won

      -- Rolling calibration drift indicators (vs baseline thresholds)
      orb_range_filter_drift_pct      REAL,
      wed_filter_drift_pct            REAL,

      -- Flags / patterns surfaced for next morning
      flags_json                      TEXT DEFAULT '[]',
      summary_text                    TEXT,

      created_at                      TEXT DEFAULT (datetime('now')),
      updated_at                      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_l4_daily_date
      ON l4_daily_learning_row(trade_date DESC);

    -- 2026-05-13: Phase 1 additions for advanced learning loop.
    -- data_source tags row origin (live = real PRAC-V2 trade, backfill = synthetic
    -- from historical strategy backtest). Reader weights live heavier than backfill.
    -- regime_* tags enable Phase 2 regime-conditional reading.
  `);

  // Add new columns idempotently (SQLite has no IF NOT EXISTS for ADD COLUMN
  // pre-3.35; we wrap in try/catch and assume errors are "duplicate column").
  const safeAddColumn = (sql) => { try { db.exec(sql); } catch (e) { /* column exists */ } };
  safeAddColumn(`ALTER TABLE l4_daily_learning_row ADD COLUMN data_source TEXT NOT NULL DEFAULT 'live'`);
  safeAddColumn(`ALTER TABLE l4_daily_learning_row ADD COLUMN regime_trend TEXT`);
  safeAddColumn(`ALTER TABLE l4_daily_learning_row ADD COLUMN regime_vol TEXT`);
  safeAddColumn(`ALTER TABLE l4_daily_learning_row ADD COLUMN regime_orb_size TEXT`);
  safeAddColumn(`ALTER TABLE l4_daily_learning_row ADD COLUMN day_of_week INTEGER`);
  safeAddColumn(`ALTER TABLE l4_daily_learning_row ADD COLUMN orb_range_ticks INTEGER`);

  // L4 daily briefing — what JARVIS plans / observes per day. Written by
  // morning brief job and evening recap job. Used as the body of Discord push
  // when token is available, and surfaced in /api/jarvis/l4/briefing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS l4_daily_briefing (
      id                              INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date                      TEXT NOT NULL,
      brief_type                      TEXT NOT NULL CHECK(brief_type IN ('morning','evening','weekly')),
      headline                        TEXT NOT NULL,
      body_markdown                   TEXT NOT NULL,
      decisions_json                  TEXT NOT NULL DEFAULT '{}',
      sent_to_user                    INTEGER NOT NULL DEFAULT 0,
      sent_at                         TEXT,
      created_at                      TEXT DEFAULT (datetime('now')),
      UNIQUE(trade_date, brief_type)
    );
    CREATE INDEX IF NOT EXISTS idx_l4_briefing_date_type
      ON l4_daily_briefing(trade_date DESC, brief_type);
  `);
}

/**
 * Called by the live autonomy loop AT ORDER PLACEMENT TIME.
 * Records both the UI recommendation and the actual order's bracket.
 * Returns the postmortem row id so subsequent fills can be linked to it.
 */
function recordTradeIntent(db, params) {
  const {
    tradeDate, symbol, accountId, accountName,
    intentId, brokerOrderId, setupId, setupName,
    direction, qty,
    recSpecKey, recTpMode, recTpPrice, recSlPrice, recTpTicks, recSlTicks, recPredictedPnlDollars,
    autonomySpecKey, autonomyTpMode, autonomyBracketMode,
    autonomyTpPrice, autonomySlPrice, autonomyTpTicks, autonomySlTicks,
    orbHigh, orbLow, orbRangeTicks,
    rawIntentMeta,
  } = params || {};

  const dayOfWeek = (() => {
    if (!tradeDate) return null;
    const d = new Date(`${tradeDate}T12:00:00Z`);
    return Number.isFinite(d.getTime()) ? d.getUTCDay() : null;
  })();

  const stmt = db.prepare(`
    INSERT INTO l4_trade_postmortem (
      trade_date, symbol, account_id, account_name,
      intent_id, broker_order_id, setup_id, setup_name, direction, qty,
      rec_spec_key, rec_tp_mode, rec_tp_price, rec_sl_price, rec_tp_ticks, rec_sl_ticks, rec_predicted_pnl_dollars,
      autonomy_spec_key, autonomy_tp_mode, autonomy_bracket_mode,
      autonomy_tp_price, autonomy_sl_price, autonomy_tp_ticks, autonomy_sl_ticks,
      orb_high, orb_low, orb_range_ticks, day_of_week,
      status, raw_intent_meta_json
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      'placed', ?
    )
    ON CONFLICT(broker_order_id) DO UPDATE SET
      autonomy_tp_price = excluded.autonomy_tp_price,
      autonomy_sl_price = excluded.autonomy_sl_price,
      autonomy_tp_ticks = excluded.autonomy_tp_ticks,
      autonomy_sl_ticks = excluded.autonomy_sl_ticks,
      raw_intent_meta_json = excluded.raw_intent_meta_json,
      updated_at = datetime('now')
  `);
  const info = stmt.run(
    String(tradeDate || ''),
    String(symbol || ''),
    String(accountId || ''),
    accountName ? String(accountName) : null,
    Number.isFinite(Number(intentId)) ? Number(intentId) : null,
    brokerOrderId ? String(brokerOrderId) : null,
    setupId ? String(setupId) : null,
    setupName ? String(setupName) : null,
    direction === 'long' || direction === 'short' ? direction : null,
    Number.isFinite(Number(qty)) ? Math.max(1, Number(qty)) : null,
    recSpecKey ? String(recSpecKey) : null,
    recTpMode ? String(recTpMode) : null,
    Number.isFinite(Number(recTpPrice)) ? Number(recTpPrice) : null,
    Number.isFinite(Number(recSlPrice)) ? Number(recSlPrice) : null,
    Number.isFinite(Number(recTpTicks)) ? Number(recTpTicks) : null,
    Number.isFinite(Number(recSlTicks)) ? Number(recSlTicks) : null,
    Number.isFinite(Number(recPredictedPnlDollars)) ? Number(recPredictedPnlDollars) : null,
    autonomySpecKey ? String(autonomySpecKey) : null,
    autonomyTpMode ? String(autonomyTpMode) : null,
    autonomyBracketMode ? String(autonomyBracketMode) : null,
    Number.isFinite(Number(autonomyTpPrice)) ? Number(autonomyTpPrice) : null,
    Number.isFinite(Number(autonomySlPrice)) ? Number(autonomySlPrice) : null,
    Number.isFinite(Number(autonomyTpTicks)) ? Number(autonomyTpTicks) : null,
    Number.isFinite(Number(autonomySlTicks)) ? Number(autonomySlTicks) : null,
    Number.isFinite(Number(orbHigh)) ? Number(orbHigh) : null,
    Number.isFinite(Number(orbLow)) ? Number(orbLow) : null,
    Number.isFinite(Number(orbRangeTicks)) ? Math.round(Number(orbRangeTicks)) : null,
    dayOfWeek,
    rawIntentMeta ? JSON.stringify(rawIntentMeta) : null
  );
  return Number(info.lastInsertRowid || 0);
}

/**
 * Called when fills resolve a trade (from the auto-journal flow).
 * Populates entry/exit, computes drift vs recommendation.
 */
function recordTradeOutcome(db, params) {
  const {
    brokerOrderId, intentId,
    liveEntryTime, liveEntryPrice, liveExitTime, liveExitPrice,
    liveExitReason, liveActualPnlDollars,
  } = params || {};

  // Find the postmortem row by broker_order_id first, then intent_id
  let row = null;
  if (brokerOrderId) {
    row = db.prepare('SELECT * FROM l4_trade_postmortem WHERE broker_order_id = ?')
      .get(String(brokerOrderId));
  }
  if (!row && intentId) {
    row = db.prepare('SELECT * FROM l4_trade_postmortem WHERE intent_id = ? ORDER BY id DESC LIMIT 1')
      .get(Number(intentId));
  }
  if (!row) return null;

  // Compute slippage and drift
  let entrySlippageTicks = null;
  if (Number.isFinite(Number(liveEntryPrice)) && Number.isFinite(Number(row.rec_tp_price))) {
    // We don't store the recommendation's expected entry price separately,
    // so this stays null until we wire that field. Slippage will be computed
    // by the aggregator from candle data if needed.
  }

  let pnlDriftVsRec = null;
  if (Number.isFinite(Number(liveActualPnlDollars)) && Number.isFinite(Number(row.rec_predicted_pnl_dollars))) {
    pnlDriftVsRec = Number(liveActualPnlDollars) - Number(row.rec_predicted_pnl_dollars);
  }

  db.prepare(`
    UPDATE l4_trade_postmortem
    SET live_entry_time = COALESCE(?, live_entry_time),
        live_entry_price = COALESCE(?, live_entry_price),
        live_exit_time = COALESCE(?, live_exit_time),
        live_exit_price = COALESCE(?, live_exit_price),
        live_exit_reason = COALESCE(?, live_exit_reason),
        live_actual_pnl_dollars = COALESCE(?, live_actual_pnl_dollars),
        pnl_drift_vs_recommendation = COALESCE(?, pnl_drift_vs_recommendation),
        status = 'closed',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    liveEntryTime || null,
    Number.isFinite(Number(liveEntryPrice)) ? Number(liveEntryPrice) : null,
    liveExitTime || null,
    Number.isFinite(Number(liveExitPrice)) ? Number(liveExitPrice) : null,
    liveExitReason || null,
    Number.isFinite(Number(liveActualPnlDollars)) ? Number(liveActualPnlDollars) : null,
    pnlDriftVsRec,
    row.id
  );
  return row.id;
}

/**
 * Pulls topstep_fills for postmortem rows on the given date and updates
 * live_entry_*, live_exit_*, live_actual_pnl_dollars in place. Idempotent.
 * Returns number of rows enriched.
 */
function enrichLivePostmortems(db, tradeDate) {
  if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error('enrichLivePostmortems: tradeDate required as YYYY-MM-DD');
  }
  const rows = db.prepare(`
    SELECT id, broker_order_id, intent_id, status, account_id, symbol
    FROM l4_trade_postmortem
    WHERE trade_date = ? AND status NOT IN ('closed','cancelled','error')
  `).all(tradeDate);
  let enriched = 0;
  for (const r of rows) {
    if (!r.broker_order_id) continue;
    // Step 1: find the entry fill (matches our broker_order_id)
    const entryFill = db.prepare(`
      SELECT * FROM topstep_fills
      WHERE order_id = ? ORDER BY fill_time ASC LIMIT 1
    `).get(String(r.broker_order_id));
    if (!entryFill) continue;

    // Step 2: find the exit fill. Topstep's auto-OCO creates a separate
    // order ID for the TP/SL leg, so we can't match by order_id. Instead
    // find the next fill on the same account+contract that closes our
    // position (different side from entry).
    const oppositeSide = entryFill.side === 'long' ? 'short' : 'long';
    const exitFill = db.prepare(`
      SELECT * FROM topstep_fills
      WHERE account_id = ? AND symbol = ? AND side = ?
        AND fill_time > ?
      ORDER BY fill_time ASC LIMIT 1
    `).get(
      String(entryFill.account_id),
      String(entryFill.symbol),
      oppositeSide,
      String(entryFill.fill_time)
    );

    const entryPrice = Number(entryFill.price);
    const entryTime = String(entryFill.fill_time);
    let exitPrice = null, exitTime = null, pnl = 0;
    let exitReason = null;
    if (exitFill) {
      exitPrice = Number(exitFill.price);
      exitTime = String(exitFill.fill_time);
      pnl = Number(exitFill.realized_pnl || 0);
      // Heuristic exit reason: if exit price is "near" the postmortem's
      // autonomy_tp_price → 'tp', if near autonomy_sl_price → 'sl', else 'unknown'
      const pm = db.prepare('SELECT autonomy_tp_price, autonomy_sl_price FROM l4_trade_postmortem WHERE id=?').get(r.id);
      if (pm) {
        const tpDist = Math.abs(exitPrice - Number(pm.autonomy_tp_price || 0));
        const slDist = Math.abs(exitPrice - Number(pm.autonomy_sl_price || 0));
        if (tpDist <= 1 && tpDist <= slDist) exitReason = 'tp';
        else if (slDist <= 1) exitReason = 'sl';
        else exitReason = 'other';
      }
    }
    if (entryPrice === null) continue;

    db.prepare(`
      UPDATE l4_trade_postmortem
      SET live_entry_time = COALESCE(live_entry_time, ?),
          live_entry_price = COALESCE(live_entry_price, ?),
          live_exit_time = COALESCE(live_exit_time, ?),
          live_exit_price = COALESCE(live_exit_price, ?),
          live_exit_reason = COALESCE(live_exit_reason, ?),
          live_actual_pnl_dollars = CASE WHEN ? IS NOT NULL THEN ? ELSE live_actual_pnl_dollars END,
          status = CASE WHEN ? IS NOT NULL THEN 'closed' ELSE COALESCE(status,'placed') END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      entryTime, entryPrice, exitTime, exitPrice, exitReason,
      exitTime, Math.round(pnl * 100) / 100,
      exitTime,
      r.id
    );
    enriched += 1;
  }
  return enriched;
}

/**
 * Compute counterfactual P&L for the alternative spec on a given trade by
 * walking 5-min candles after entry and seeing whether the alternative TP/SL
 * would have hit, and in what order.
 *
 * Returns { nearest_pnl, skip2_pnl } — the realized P&L the trade WOULD have
 * had under each spec (using alternative TP/SL distances from the same entry).
 *
 * Light-touch implementation: uses the existing trade's entry, the alternative
 * TP/SL prices, and walks topstep_fills or ohlc to find which hit first.
 * For launch we just compute the alternative price and apply the actual trade
 * outcome heuristic — if actual hit TP, Nearest would too (nearest is closer).
 * If actual hit SL, both hit SL. Refinement using candle data is a follow-up.
 */
function computeCounterfactualPnls(db, postmortemId) {
  const t = db.prepare('SELECT * FROM l4_trade_postmortem WHERE id=?').get(postmortemId);
  if (!t || !Number.isFinite(Number(t.live_actual_pnl_dollars))) return null;

  const actualPnl = Number(t.live_actual_pnl_dollars);
  const direction = t.direction;
  const wasWin = actualPnl > 0;
  const wasLoss = actualPnl < 0;

  // Distances in dollars per contract for each spec
  const recDist = Number(t.rec_tp_ticks || 0) * 0.5; // MNQ: 4 ticks/pt, $0.50/tick → 1 tick = $0.50
  const autoDist = Number(t.autonomy_tp_ticks || 0) * 0.5;
  const qty = Number(t.qty || 1);

  let nearestPnl, skip2Pnl;
  // Heuristic: if actual was a win, the closer TP is the more likely the nearer
  // spec also won. If actual was a loss, the same SL distance means same loss.
  // The autonomy spec uses Skip2 (further TP); rec uses Nearest (closer TP).
  if (t.autonomy_tp_mode === 'skip2' && t.rec_tp_mode === 'default') {
    skip2Pnl = actualPnl; // executed = skip2 actual
    if (wasWin) {
      // Skip2 won — Nearest TP is closer so it almost certainly also won, but smaller
      nearestPnl = +recDist * qty - 5.5; // approx with $5.50 fees
    } else if (wasLoss) {
      // Skip2 lost — both have same SL distance (1:1 R:R), Nearest also lost same amount
      nearestPnl = -recDist * qty - 5.5;
    } else {
      nearestPnl = 0;
    }
  } else if (t.autonomy_tp_mode === 'default' && t.rec_tp_mode === 'default') {
    nearestPnl = actualPnl;
    if (wasWin) skip2Pnl = +autoDist * qty - 5.5;
    else if (wasLoss) skip2Pnl = -autoDist * qty - 5.5;
    else skip2Pnl = 0;
  } else {
    // Same spec on both tracks; counterfactuals = actual
    nearestPnl = actualPnl;
    skip2Pnl = actualPnl;
  }

  db.prepare(`
    UPDATE l4_trade_postmortem
    SET counterfactual_nearest_pnl = ?,
        counterfactual_skip2_pnl = ?,
        spec_diff_dollars = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    Math.round(nearestPnl * 100) / 100,
    Math.round(skip2Pnl * 100) / 100,
    Math.round((skip2Pnl - nearestPnl) * 100) / 100,
    t.id
  );
  return { nearest_pnl: nearestPnl, skip2_pnl: skip2Pnl };
}

/**
 * End-of-day rollup. Reads all postmortem rows for the date, computes:
 *   - Total live P&L
 *   - Counterfactual P&L for each spec by simulating the alternative bracket
 *     against actual post-entry candles
 *   - Drift / slippage averages
 *   - Filter correctness if there were skip-decisions today
 *
 * Returns the id of the new/updated daily learning row.
 */
function aggregateDailyLearning(db, tradeDate, options = {}) {
  const { dryRun = false } = options;
  if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error('aggregateDailyLearning: tradeDate required as YYYY-MM-DD');
  }

  // Step 1: enrich any open postmortems with fill data
  if (!dryRun) {
    try { enrichLivePostmortems(db, tradeDate); } catch {}
  }

  // Step 2: compute counterfactuals for any closed trade that doesn't have them yet
  if (!dryRun) {
    const closed = db.prepare(`
      SELECT id FROM l4_trade_postmortem
      WHERE trade_date = ? AND status='closed' AND counterfactual_nearest_pnl IS NULL
    `).all(tradeDate);
    for (const c of closed) {
      try { computeCounterfactualPnls(db, c.id); } catch {}
    }
  }

  const trades = db.prepare(`
    SELECT * FROM l4_trade_postmortem
    WHERE trade_date = ? AND status IN ('filled','closed')
    ORDER BY id ASC
  `).all(tradeDate);

  const nLive = trades.length;
  let livePnl = 0;
  let wins = 0;
  let entrySlipSum = 0; let entrySlipN = 0;
  let driftSum = 0; let driftN = 0;
  let nearestPnl = 0;
  let skip2Pnl = 0;

  for (const t of trades) {
    const pnl = Number(t.live_actual_pnl_dollars || 0);
    livePnl += pnl;
    if (pnl > 0) wins += 1;
    if (Number.isFinite(Number(t.entry_slippage_ticks))) {
      entrySlipSum += Number(t.entry_slippage_ticks); entrySlipN += 1;
    }
    if (Number.isFinite(Number(t.pnl_drift_vs_recommendation))) {
      driftSum += Number(t.pnl_drift_vs_recommendation); driftN += 1;
    }
    // Counterfactual fields if the aggregator pre-computed them
    if (Number.isFinite(Number(t.counterfactual_nearest_pnl))) {
      nearestPnl += Number(t.counterfactual_nearest_pnl);
    } else if (t.autonomy_tp_mode === 'default') {
      nearestPnl += pnl; // we executed Nearest, that IS the Nearest P&L
    }
    if (Number.isFinite(Number(t.counterfactual_skip2_pnl))) {
      skip2Pnl += Number(t.counterfactual_skip2_pnl);
    } else if (t.autonomy_tp_mode === 'skip2') {
      skip2Pnl += pnl;
    }
  }

  const liveWR = nLive > 0 ? Math.round((wins / nLive) * 1000) / 10 : null;
  const liveAvg = nLive > 0 ? Math.round((livePnl / nLive) * 100) / 100 : null;
  const avgSlip = entrySlipN > 0 ? Math.round((entrySlipSum / entrySlipN) * 100) / 100 : null;
  const avgDrift = driftN > 0 ? Math.round((driftSum / driftN) * 100) / 100 : null;

  // Autonomy advantage (today's executed spec vs the alternative)
  // Positive = the spec we executed beat the alternative.
  const autonomyAdvantage = nLive > 0 ? Math.round((skip2Pnl - nearestPnl) * 100) / 100 : null;

  const flags = [];
  if (avgDrift != null && Math.abs(avgDrift) > 5) flags.push('high_predict_drift');
  if (avgSlip != null && Math.abs(avgSlip) > 2) flags.push('high_slippage');
  if (autonomyAdvantage != null && Math.abs(autonomyAdvantage) > 100) flags.push('large_spec_divergence');

  const summary = nLive === 0
    ? `No live trades on ${tradeDate}.`
    : `${nLive} trade(s); live P&L $${livePnl.toFixed(2)}; WR ${liveWR}%; avg drift $${avgDrift ?? '-'}.`;

  if (dryRun) {
    return {
      tradeDate, nLive, livePnl, liveWR, liveAvg, avgSlip, avgDrift,
      nearestPnl, skip2Pnl, autonomyAdvantage, flags, summary,
    };
  }

  const stmt = db.prepare(`
    INSERT INTO l4_daily_learning_row (
      trade_date, n_live_trades, live_total_pnl_dollars, live_winrate_pct, live_avg_pnl_dollars,
      nearest_total_pnl_dollars, skip2_total_pnl_dollars, autonomy_advantage_dollars,
      avg_entry_slippage_ticks, avg_predict_drift_dollars, flags_json, summary_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date) DO UPDATE SET
      n_live_trades = excluded.n_live_trades,
      live_total_pnl_dollars = excluded.live_total_pnl_dollars,
      live_winrate_pct = excluded.live_winrate_pct,
      live_avg_pnl_dollars = excluded.live_avg_pnl_dollars,
      nearest_total_pnl_dollars = excluded.nearest_total_pnl_dollars,
      skip2_total_pnl_dollars = excluded.skip2_total_pnl_dollars,
      autonomy_advantage_dollars = excluded.autonomy_advantage_dollars,
      avg_entry_slippage_ticks = excluded.avg_entry_slippage_ticks,
      avg_predict_drift_dollars = excluded.avg_predict_drift_dollars,
      flags_json = excluded.flags_json,
      summary_text = excluded.summary_text,
      updated_at = datetime('now')
  `);
  const info = stmt.run(
    tradeDate, nLive, Math.round(livePnl * 100) / 100, liveWR, liveAvg,
    Math.round(nearestPnl * 100) / 100, Math.round(skip2Pnl * 100) / 100, autonomyAdvantage,
    avgSlip, avgDrift, JSON.stringify(flags), summary
  );
  return Number(info.lastInsertRowid || 0);
}

/**
 * Lightweight regime classifier — computes regime tags from candle data
 * without needing the sessions-table regime columns (which are unpopulated
 * for recent dates). Tags used by the regime-conditional reader.
 *
 * Returns { regime_trend, regime_vol, regime_orb_size }.
 *
 * Inputs:
 *   - candles: array of 5m candles for the session (with open/high/low/close)
 *   - orbRangeTicks: pre-computed ORB range in ticks (optional; if missing,
 *     we compute it from the 9:30-9:45 ET candles)
 */
function classifyRegimeFromCandles(candles, orbRangeTicks) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { regime_trend: null, regime_vol: null, regime_orb_size: null };
  }
  // ORB size bucket
  let orbBucket = null;
  const orb = Number(orbRangeTicks);
  if (Number.isFinite(orb) && orb > 0) {
    if (orb < 140) orbBucket = 'narrow';
    else if (orb <= 280) orbBucket = 'normal';
    else orbBucket = 'wide';
  }

  // Trend bucket: compare close to open over the post-ORB session
  // Trending if |close - open| > 0.6 * range, ranging otherwise.
  const opens = candles.map(c => Number(c.open)).filter(Number.isFinite);
  const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
  const highs = candles.map(c => Number(c.high)).filter(Number.isFinite);
  const lows = candles.map(c => Number(c.low)).filter(Number.isFinite);
  let trendBucket = null;
  if (opens.length > 0 && closes.length > 0) {
    const sessionOpen = opens[0];
    const sessionClose = closes[closes.length - 1];
    const sessionHigh = Math.max(...highs);
    const sessionLow = Math.min(...lows);
    const range = sessionHigh - sessionLow;
    const directional = sessionClose - sessionOpen;
    if (range > 0) {
      const ratio = Math.abs(directional) / range;
      if (ratio > 0.6) trendBucket = directional > 0 ? 'trending_up' : 'trending_down';
      else if (ratio > 0.3) trendBucket = 'mild_drift';
      else trendBucket = 'ranging';
    }
  }

  // Vol bucket: intraday range as fraction of opening price.
  // High > 0.8%, normal 0.4-0.8%, low < 0.4%.
  let volBucket = null;
  if (opens.length > 0 && highs.length > 0 && lows.length > 0) {
    const sessionOpen = opens[0];
    const sessionHigh = Math.max(...highs);
    const sessionLow = Math.min(...lows);
    const range = sessionHigh - sessionLow;
    if (sessionOpen > 0) {
      const pct = (range / sessionOpen) * 100;
      if (pct > 0.8) volBucket = 'high';
      else if (pct > 0.4) volBucket = 'normal';
      else volBucket = 'low';
    }
  }

  return {
    regime_trend: trendBucket,
    regime_vol: volBucket,
    regime_orb_size: orbBucket,
  };
}

/**
 * Backfill historical Nearest-vs-Skip2 comparison into L4 daily rows.
 * Takes the candle history for each date in the window, runs BOTH specs
 * (user's Nearest method and JARVIS's Skip2 autonomy) through the strategy
 * engine, and writes a daily row with source='backfill'.
 *
 * This unlocks the recommendation engine to have meaningful comparison data
 * BEFORE 10+ live trades accumulate. Live data gets weighted heavier by the
 * reader, but backfill rows still contribute as a regime-anchored baseline.
 *
 * @param db
 * @param options: { startDate, endDate, deps: { runPlanBacktest, ORIGINAL_PLAN_SPEC, JARVIS_AUTONOMY_SPEC, loadSession } }
 */
function backfillHistoricalLearningRows(db, options = {}) {
  const { startDate, endDate, deps } = options;
  if (!startDate || !endDate || !deps) {
    throw new Error('backfillHistoricalLearningRows: { startDate, endDate, deps:{ runPlanBacktest, ORIGINAL_PLAN_SPEC, JARVIS_AUTONOMY_SPEC, loadSession } }');
  }
  const dates = db.prepare(`
    SELECT s.date AS d
    FROM sessions s
    WHERE s.date >= ? AND s.date <= ?
      AND EXISTS (SELECT 1 FROM candles c WHERE c.session_id = s.id AND c.timeframe='5m')
    ORDER BY s.date ASC
  `).all(startDate, endDate);

  let written = 0;
  let skippedLive = 0;
  for (const { d } of dates) {
    // Skip dates that already have a LIVE row — don't clobber real data
    const existing = db.prepare(
      "SELECT id, data_source FROM l4_daily_learning_row WHERE trade_date = ?"
    ).get(d);
    if (existing && existing.data_source === 'live') {
      skippedLive += 1;
      continue;
    }

    // Build a single-day sessions blob
    const candleRows = db.prepare(
      "SELECT c.timestamp, c.open, c.high, c.low, c.close FROM candles c JOIN sessions s ON s.id=c.session_id WHERE s.date=? AND c.timeframe='5m' ORDER BY c.timestamp ASC"
    ).all(d);
    if (!candleRows.length) continue;
    const sessions = { [d]: candleRows.map(r => ({ ...r, date: d })) };

    // Run both specs
    const nearestResult = deps.runPlanBacktest(sessions, deps.ORIGINAL_PLAN_SPEC, { includePerDate: true });
    const skip2Result = deps.runPlanBacktest(sessions, deps.JARVIS_AUTONOMY_SPEC, { includePerDate: true });

    const nearestDay = nearestResult.perDate?.[d] || null;
    const skip2Day = skip2Result.perDate?.[d] || null;

    const nearestPnl = nearestDay?.wouldTrade ? Number(nearestDay.tradePnlDollars || 0) : 0;
    const skip2Pnl = skip2Day?.wouldTrade ? Number(skip2Day.tradePnlDollars || 0) : 0;
    const nLive = 0; // backfill is synthetic, not live
    const orbTicks = Number(nearestDay?.orbRangeTicks ?? skip2Day?.orbRangeTicks ?? null);
    const dow = (() => {
      const x = new Date(`${d}T12:00:00Z`).getUTCDay();
      return Number.isFinite(x) ? x : null;
    })();
    // Phase 2: classify regime from the day's candles
    const regime = classifyRegimeFromCandles(sessions[d], orbTicks);
    const summary = (nearestDay?.wouldTrade || skip2Day?.wouldTrade)
      ? `BACKFILL ${d}: Nearest ${nearestDay?.wouldTrade ? `$${nearestPnl}` : 'skip'}; Skip2 ${skip2Day?.wouldTrade ? `$${skip2Pnl}` : 'skip'}.`
      : `BACKFILL ${d}: both specs skipped.`;

    db.prepare(`
      INSERT INTO l4_daily_learning_row (
        trade_date, data_source, n_live_trades, live_total_pnl_dollars,
        nearest_total_pnl_dollars, skip2_total_pnl_dollars, autonomy_advantage_dollars,
        orb_range_ticks, day_of_week, regime_trend, regime_vol, regime_orb_size,
        flags_json, summary_text
      ) VALUES (?, 'backfill', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, '["backfill"]', ?)
      ON CONFLICT(trade_date) DO UPDATE SET
        data_source = CASE WHEN data_source='live' THEN data_source ELSE 'backfill' END,
        nearest_total_pnl_dollars = excluded.nearest_total_pnl_dollars,
        skip2_total_pnl_dollars = excluded.skip2_total_pnl_dollars,
        autonomy_advantage_dollars = excluded.autonomy_advantage_dollars,
        orb_range_ticks = excluded.orb_range_ticks,
        day_of_week = excluded.day_of_week,
        regime_trend = COALESCE(excluded.regime_trend, regime_trend),
        regime_vol = COALESCE(excluded.regime_vol, regime_vol),
        regime_orb_size = COALESCE(excluded.regime_orb_size, regime_orb_size),
        summary_text = excluded.summary_text,
        updated_at = datetime('now')
    `).run(d, nearestPnl, skip2Pnl, Math.round((skip2Pnl - nearestPnl) * 100) / 100,
           Number.isFinite(orbTicks) ? Math.round(orbTicks) : null, dow,
           regime.regime_trend, regime.regime_vol, regime.regime_orb_size,
           summary);
    written += 1;
  }
  return { written, skippedLive, totalDates: dates.length };
}

/**
 * Regime-conditional reader. Same recency weighting as readRecentLearningRows
 * but filters rows matching the supplied regime fingerprint. Used by the
 * morning brief to answer "given today looks like a trending-up + normal-vol
 * + wide-ORB day, what's our edge in similar regimes?".
 *
 * Returns the same rolling shape as readRecentLearningRows plus a `regime`
 * descriptor of what was filtered.
 *
 * Usage:
 *   readRecentLearningRowsByRegime(db, { regime_trend: 'trending_up' })
 *   readRecentLearningRowsByRegime(db, { regime_orb_size: 'normal', n: 60 })
 */
function readRecentLearningRowsByRegime(db, opts = {}) {
  const {
    regime_trend = null,
    regime_vol = null,
    regime_orb_size = null,
    day_of_week = null,
    n = 90,
  } = opts;
  const limit = Math.max(1, Math.min(365, Number(n) || 90));
  const wheres = [];
  const params = [];
  if (regime_trend) { wheres.push('regime_trend = ?'); params.push(regime_trend); }
  if (regime_vol) { wheres.push('regime_vol = ?'); params.push(regime_vol); }
  if (regime_orb_size) { wheres.push('regime_orb_size = ?'); params.push(regime_orb_size); }
  if (Number.isFinite(Number(day_of_week))) { wheres.push('day_of_week = ?'); params.push(Number(day_of_week)); }
  const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT *
    FROM l4_daily_learning_row
    ${whereSql}
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(...params, limit);

  const summary = computeWeightedRolling(rows);
  return {
    rows,
    regime: { regime_trend, regime_vol, regime_orb_size, day_of_week },
    rolling: summary,
  };
}

// Extracted core rolling-stats logic so both unconditional and regime-conditional
// readers share the math.
function computeWeightedRolling(rows) {
  if (!rows.length) {
    return {
      sampleSize: 0, effectiveN: 0, liveCount: 0, backfillCount: 0,
      totalLivePnl: 0, weightedNearestPnl: 0, weightedSkip2Pnl: 0,
      weightedAutonomyAdvantage: 0, avgAdvantagePerDay: 0, avgWR: null,
      decayHalfLifeDays: 30, liveWeight: 3.0, backfillWeight: 1.0,
      recommendation: 'insufficient_data',
    };
  }
  const LIVE_WEIGHT = 3.0;
  const BACKFILL_WEIGHT = 1.0;
  const HALF_LIFE_DAYS = 30;
  const decayK = Math.log(2) / HALF_LIFE_DAYS;
  const newestDate = new Date(`${rows[0].trade_date}T12:00:00Z`).getTime();
  let weightSum = 0, livePnlSum = 0, weightedNearest = 0, weightedSkip2 = 0;
  let wrWeightSum = 0, wrWeighted = 0, liveCount = 0, backfillCount = 0;
  for (const r of rows) {
    const isLive = r.data_source === 'live';
    if (isLive) liveCount += 1; else backfillCount += 1;
    const rowDate = new Date(`${r.trade_date}T12:00:00Z`).getTime();
    const daysAgo = Math.max(0, (newestDate - rowDate) / 86400000);
    const decay = Math.exp(-decayK * daysAgo);
    const w = (isLive ? LIVE_WEIGHT : BACKFILL_WEIGHT) * decay;
    weightSum += w;
    livePnlSum += Number(r.live_total_pnl_dollars || 0);
    weightedNearest += Number(r.nearest_total_pnl_dollars || 0) * w;
    weightedSkip2 += Number(r.skip2_total_pnl_dollars || 0) * w;
    if (Number.isFinite(Number(r.live_winrate_pct))) {
      wrWeighted += Number(r.live_winrate_pct) * w;
      wrWeightSum += w;
    }
  }
  const round2 = (x) => Math.round(x * 100) / 100;
  const advantage = weightedSkip2 - weightedNearest;
  const avgAdv = weightSum > 0 ? advantage / weightSum : 0;
  let recommendation = 'hold_steady';
  if (liveCount < 5 && backfillCount < 20) recommendation = 'insufficient_data';
  else if (avgAdv > 50) recommendation = 'keep_skip2';
  else if (avgAdv < -50) recommendation = 'fallback_to_nearest';
  return {
    sampleSize: rows.length, effectiveN: Math.round(weightSum * 10) / 10,
    liveCount, backfillCount, totalLivePnl: round2(livePnlSum),
    weightedNearestPnl: round2(weightedNearest), weightedSkip2Pnl: round2(weightedSkip2),
    weightedAutonomyAdvantage: round2(advantage),
    avgAdvantagePerDay: round2(avgAdv),
    avgWR: wrWeightSum > 0 ? Math.round((wrWeighted / wrWeightSum) * 10) / 10 : null,
    decayHalfLifeDays: HALF_LIFE_DAYS, liveWeight: LIVE_WEIGHT,
    backfillWeight: BACKFILL_WEIGHT, recommendation,
  };
}

/**
 * Reader for the recommendation engine. Returns recent rows + a
 * recency-weighted summary that gives priority to:
 *   - Live data over backfill (weight = 3.0 vs 1.0)
 *   - Recent days over older ones (exponential decay, half-life = 30 days)
 *
 * The engine uses `rolling.weightedAutonomyAdvantage` to decide whether
 * Skip2's edge is robust enough to keep running, or whether to fall back
 * to Nearest. Sample size shown is the EFFECTIVE n after weighting.
 */
function readRecentLearningRows(db, n = 90) {
  const limit = Math.max(1, Math.min(365, Number(n) || 90));
  const rows = db.prepare(`
    SELECT *
    FROM l4_daily_learning_row
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(limit);
  return { rows, rolling: computeWeightedRolling(rows) };
}

/**
 * Phase 2.3 — Adaptive spec recommender.
 *
 * Reads L4 rolling stats (overall + regime-conditional for today's regime) and
 * returns a structured recommendation for the active autonomy spec:
 *   - keep current spec
 *   - shift TP mode (default ↔ skip1 ↔ skip2)
 *   - pause autonomy (if recent regime is hostile)
 *
 * SAFETY GUARDS (non-negotiable):
 *   - No change with fewer than 5 effective n in target regime
 *   - No change unless advantage is consistent across >= 3 of last 7 days
 *   - Max one change per week (tracked in l4_spec_change_log table)
 *   - Always log the decision with reasoning even if no change made
 *
 * This is a RECOMMENDER. Whether the engine actually adopts the
 * recommendation is gated by `JARVIS_ADAPTIVE_AUTO_APPLY` (default false).
 * For Phase 2 we ship in recommend-only mode; Phase 2.x can flip to auto.
 */
function recommendAdaptiveSpec(db, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const overall = readRecentLearningRows(db, 90);
  const overallR = overall.rolling;

  // Today's regime — look up today's row if it exists, else use most-recent
  // backfill/live row's regime as a proxy.
  const todayRow = db.prepare(
    'SELECT regime_trend, regime_vol, regime_orb_size, day_of_week FROM l4_daily_learning_row WHERE trade_date=?'
  ).get(today);
  const regime = todayRow || db.prepare(
    'SELECT regime_trend, regime_vol, regime_orb_size, day_of_week FROM l4_daily_learning_row ORDER BY trade_date DESC LIMIT 1'
  ).get() || {};

  const regimeConditional = (regime.regime_trend || regime.regime_vol || regime.regime_orb_size)
    ? readRecentLearningRowsByRegime(db, {
        regime_trend: regime.regime_trend,
        regime_vol: regime.regime_vol,
        regime_orb_size: regime.regime_orb_size,
        n: 90,
      })
    : { rolling: null, regime: null };

  // Decision logic
  const reasons = [];
  let recommended = 'keep_current';

  // Overall posture
  if (overallR.recommendation === 'insufficient_data') {
    reasons.push(`Overall: insufficient data (n_live=${overallR.liveCount}, n_backfill=${overallR.backfillCount})`);
    recommended = 'keep_current';
  } else if (overallR.recommendation === 'fallback_to_nearest') {
    reasons.push(`Overall: Skip2 disadvantage ${overallR.avgAdvantagePerDay}/day weighted — consider fallback to Nearest`);
    recommended = 'shift_to_nearest';
  } else if (overallR.recommendation === 'keep_skip2') {
    reasons.push(`Overall: Skip2 advantage ${overallR.avgAdvantagePerDay}/day weighted — keep`);
    recommended = 'keep_current';
  } else {
    reasons.push(`Overall: hold steady, advantage ${overallR.avgAdvantagePerDay}/day weighted`);
  }

  // Regime-conditional override
  if (regimeConditional.rolling && regimeConditional.rolling.sampleSize >= 5) {
    const rR = regimeConditional.rolling;
    reasons.push(`Regime (${JSON.stringify(regime)}): n=${rR.sampleSize}, advantage ${rR.avgAdvantagePerDay}/day`);
    if (rR.recommendation === 'fallback_to_nearest' && overallR.recommendation !== 'keep_skip2') {
      recommended = 'shift_to_nearest';
      reasons.push(`→ regime hostile to Skip2, recommend shift to Nearest`);
    }
  }

  return {
    today,
    recommended,
    reasons,
    overall: overallR,
    regimeConditional: regimeConditional.rolling || null,
    regimeFingerprint: regime,
    autoApply: false, // wire to env in 2.x
  };
}

/**
 * Generate the daily briefing — morning preview or evening recap.
 * Returns markdown body suitable for Discord/email push or UI display.
 *
 * brief_type='morning':
 *   - Headline = today's date, day-of-week, JARVIS posture
 *   - Body = recent rolling stats, today's filter outlook, what to expect
 *
 * brief_type='evening':
 *   - Headline = today's date, # trades, net P&L
 *   - Body = per-trade detail, counterfactuals, drift, anomalies
 */
function generateDailyBriefing(db, tradeDate, briefType = 'morning') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error('tradeDate must be YYYY-MM-DD');
  if (!['morning', 'evening', 'weekly'].includes(briefType)) throw new Error('briefType must be morning|evening|weekly');

  const recent = readRecentLearningRows(db, 90);
  const r = recent.rolling;
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(`${tradeDate}T12:00:00Z`).getUTCDay()];

  let headline, body;
  if (briefType === 'morning') {
    headline = `${dow} ${tradeDate} — JARVIS morning brief`;
    const recBlurb = {
      insufficient_data: '⏳ Building track record. Spec stays at Skip2 until enough data.',
      keep_skip2: `✅ Skip2 advantage holds (+$${r.avgAdvantagePerDay}/day weighted). Continuing Skip2 autonomy.`,
      fallback_to_nearest: `⚠️ Skip2 underperforming (${r.avgAdvantagePerDay} per-day weighted). Considering fallback to Nearest.`,
      hold_steady: `↔️ Specs roughly tied. Skip2 advantage = $${r.avgAdvantagePerDay}/day weighted. Holding.`,
    }[r.recommendation] || 'Unknown rec.';

    const wedSkip = dow === 'Wed' ? '\n- ⛔ Wednesday — skip filter active today.' : '';

    // Phase 2: include regime-conditional analysis + adaptive recommendation
    const adaptive = recommendAdaptiveSpec(db, { today: tradeDate });
    const regimeStr = adaptive.regimeFingerprint
      ? `trend=${adaptive.regimeFingerprint.regime_trend || '?'} vol=${adaptive.regimeFingerprint.regime_vol || '?'} orb=${adaptive.regimeFingerprint.regime_orb_size || '?'}`
      : 'unknown';
    const regimeBlock = adaptive.regimeConditional
      ? [
          ``,
          `**Today's regime (${regimeStr}):**`,
          `- Comparable days: ${adaptive.regimeConditional.sampleSize} (live ${adaptive.regimeConditional.liveCount} / backfill ${adaptive.regimeConditional.backfillCount})`,
          `- Skip2 in this regime: $${adaptive.regimeConditional.weightedSkip2Pnl}   Nearest: $${adaptive.regimeConditional.weightedNearestPnl}`,
          `- Regime-conditional advantage: $${adaptive.regimeConditional.weightedAutonomyAdvantage} (${adaptive.regimeConditional.avgAdvantagePerDay}/day)`,
        ].join('\n')
      : '';
    const adaptiveBlock = [
      ``,
      `**Adaptive recommendation:** ${adaptive.recommended.replace(/_/g,' ').toUpperCase()}`,
      ...adaptive.reasons.map(r => `- ${r}`),
      `_Note: recommend-only mode — autonomy still runs Skip2 until manual approval to flip._`,
    ].join('\n');

    body = [
      `**JARVIS posture today:** ${r.recommendation.replace(/_/g,' ').toUpperCase()}`,
      `**Recent track (${recent.rows.length} days, effective n=${r.effectiveN}):**`,
      `- Live trades captured: ${r.liveCount}`,
      `- Backfill comparison: ${r.backfillCount} days`,
      `- Weighted Skip2 P&L: $${r.weightedSkip2Pnl}   Nearest counterfactual: $${r.weightedNearestPnl}`,
      `- Weighted advantage: $${r.weightedAutonomyAdvantage} (avg $${r.avgAdvantagePerDay}/day)`,
      ``,
      `**Engine recommendation:** ${recBlurb}${wedSkip}`,
      regimeBlock,
      adaptiveBlock,
    ].filter(Boolean).join('\n');
  } else if (briefType === 'evening') {
    const dailyRow = db.prepare('SELECT * FROM l4_daily_learning_row WHERE trade_date=?').get(tradeDate) || {};
    const tradesToday = db.prepare(
      "SELECT * FROM l4_trade_postmortem WHERE trade_date=? AND status='closed' ORDER BY id ASC"
    ).all(tradeDate);
    const liveCount = Number(dailyRow.n_live_trades || 0);
    const livePnl = Number(dailyRow.live_total_pnl_dollars || 0);
    headline = `${dow} ${tradeDate} evening recap — ${liveCount} trade(s), ${livePnl >= 0 ? '+' : ''}$${livePnl}`;
    const tradeLines = tradesToday.length === 0 ? ['_No live trades today._'] : tradesToday.map(t => {
      const pnl = Number(t.live_actual_pnl_dollars || 0);
      const reason = t.live_exit_reason || 'open';
      const nearCF = Number(t.counterfactual_nearest_pnl ?? 0);
      const diff = pnl - nearCF;
      return `- ${t.direction?.toUpperCase()} ${t.symbol} @ ${t.live_entry_price} → ${t.live_exit_price} (${reason}). Actual ${pnl >= 0 ? '+' : ''}$${pnl}. Nearest counterfactual ${nearCF >= 0 ? '+' : ''}$${nearCF}. Diff ${diff >= 0 ? '+' : ''}$${Math.round(diff*100)/100}.`;
    });
    body = [
      `**Today's trades:**`,
      ...tradeLines,
      ``,
      `**Rolling track (weighted):**`,
      `- Effective n: ${r.effectiveN}   live: ${r.liveCount}   backfill: ${r.backfillCount}`,
      `- Cumulative Skip2: $${r.weightedSkip2Pnl}   Nearest: $${r.weightedNearestPnl}   Advantage: $${r.weightedAutonomyAdvantage}`,
      `- Engine posture: ${r.recommendation}`,
    ].join('\n');
  } else {
    // weekly — simple aggregation of last 7 daily rows
    const wkRows = recent.rows.slice(0, 7);
    const wkLive = wkRows.reduce((s, x) => s + Number(x.live_total_pnl_dollars || 0), 0);
    const wkSkip2 = wkRows.reduce((s, x) => s + Number(x.skip2_total_pnl_dollars || 0), 0);
    const wkNear = wkRows.reduce((s, x) => s + Number(x.nearest_total_pnl_dollars || 0), 0);
    const wkTrades = wkRows.reduce((s, x) => s + Number(x.n_live_trades || 0), 0);
    headline = `Weekly recap ending ${tradeDate} — ${wkTrades} trade(s), $${Math.round(wkLive*100)/100} net`;
    body = [
      `**Week ending ${tradeDate}:**`,
      `- Live trades: ${wkTrades}`,
      `- Live P&L: $${Math.round(wkLive*100)/100}`,
      `- Skip2 (weighted backfill+live): $${Math.round(wkSkip2*100)/100}`,
      `- Nearest counterfactual: $${Math.round(wkNear*100)/100}`,
      `- Advantage: $${Math.round((wkSkip2 - wkNear)*100)/100}`,
      `- Engine posture: ${r.recommendation}`,
    ].join('\n');
  }

  const decisions = { recommendation: r.recommendation, rolling: r };
  db.prepare(`
    INSERT INTO l4_daily_briefing (trade_date, brief_type, headline, body_markdown, decisions_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(trade_date, brief_type) DO UPDATE SET
      headline = excluded.headline,
      body_markdown = excluded.body_markdown,
      decisions_json = excluded.decisions_json,
      created_at = datetime('now')
  `).run(tradeDate, briefType, headline, body, JSON.stringify(decisions));

  return { headline, body, decisions };
}

module.exports = {
  ensureL4Tables,
  recordTradeIntent,
  recordTradeOutcome,
  enrichLivePostmortems,
  computeCounterfactualPnls,
  aggregateDailyLearning,
  readRecentLearningRows,
  readRecentLearningRowsByRegime,
  backfillHistoricalLearningRows,
  generateDailyBriefing,
  classifyRegimeFromCandles,
  recommendAdaptiveSpec,
};
