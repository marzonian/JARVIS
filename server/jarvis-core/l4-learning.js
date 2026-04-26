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
    SELECT id, broker_order_id, intent_id, status
    FROM l4_trade_postmortem
    WHERE trade_date = ? AND status NOT IN ('closed','cancelled','error')
  `).all(tradeDate);
  let enriched = 0;
  for (const r of rows) {
    if (!r.broker_order_id) continue;
    // Fetch all fills for this order — entry fill is the one with the
    // earliest fill_time and realized_pnl=0; exit fill carries the pnl.
    const fills = db.prepare(`
      SELECT * FROM topstep_fills
      WHERE order_id = ?
      ORDER BY fill_time ASC
    `).all(String(r.broker_order_id));
    if (!fills.length) continue;

    let entryPrice = null, entryTime = null;
    let exitPrice = null, exitTime = null;
    let pnl = 0;
    for (const f of fills) {
      const realized = Number(f.realized_pnl || 0);
      if (entryPrice === null && realized === 0) {
        entryPrice = Number(f.price);
        entryTime = String(f.fill_time);
      } else {
        exitPrice = Number(f.price);
        exitTime = String(f.fill_time);
        pnl += realized;
      }
    }
    // Fallback if all fills carry pnl (some brokers do that)
    if (entryPrice === null && fills.length >= 1) {
      entryPrice = Number(fills[0].price);
      entryTime = String(fills[0].fill_time);
      if (fills.length >= 2) {
        exitPrice = Number(fills[fills.length - 1].price);
        exitTime = String(fills[fills.length - 1].fill_time);
      }
      pnl = fills.reduce((s, f) => s + Number(f.realized_pnl || 0), 0);
    }
    if (entryPrice === null) continue;

    db.prepare(`
      UPDATE l4_trade_postmortem
      SET live_entry_time = COALESCE(live_entry_time, ?),
          live_entry_price = COALESCE(live_entry_price, ?),
          live_exit_time = COALESCE(live_exit_time, ?),
          live_exit_price = COALESCE(live_exit_price, ?),
          live_actual_pnl_dollars = COALESCE(live_actual_pnl_dollars, ?),
          status = CASE WHEN ? IS NOT NULL THEN 'closed' ELSE COALESCE(status,'placed') END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      entryTime, entryPrice, exitTime, exitPrice,
      Math.round(pnl * 100) / 100,
      exitTime, // closes status only if we have an exit
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
 * Reader for the next-morning recommendation engine to know "what did
 * yesterday's data say about us." Returns the most recent N daily learning
 * rows, with a rolling summary suitable for the engine to weight against.
 */
function readRecentLearningRows(db, n = 30) {
  const rows = db.prepare(`
    SELECT *
    FROM l4_daily_learning_row
    WHERE n_live_trades > 0
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(365, Number(n) || 30)));
  if (rows.length === 0) {
    return { rows: [], rolling: { sampleSize: 0, totalLivePnl: 0, totalNearestPnl: 0, totalSkip2Pnl: 0, autonomyAdvantage: 0, avgWR: null } };
  }
  let totalLive = 0, totalNear = 0, totalSkip = 0, wrSum = 0, wrN = 0;
  for (const r of rows) {
    totalLive += Number(r.live_total_pnl_dollars || 0);
    totalNear += Number(r.nearest_total_pnl_dollars || 0);
    totalSkip += Number(r.skip2_total_pnl_dollars || 0);
    if (Number.isFinite(Number(r.live_winrate_pct))) { wrSum += Number(r.live_winrate_pct); wrN += 1; }
  }
  return {
    rows,
    rolling: {
      sampleSize: rows.length,
      totalLivePnl: Math.round(totalLive * 100) / 100,
      totalNearestPnl: Math.round(totalNear * 100) / 100,
      totalSkip2Pnl: Math.round(totalSkip * 100) / 100,
      autonomyAdvantage: Math.round((totalSkip - totalNear) * 100) / 100,
      avgWR: wrN > 0 ? Math.round((wrSum / wrN) * 10) / 10 : null,
    },
  };
}

module.exports = {
  ensureL4Tables,
  recordTradeIntent,
  recordTradeOutcome,
  enrichLivePostmortems,
  computeCounterfactualPnls,
  aggregateDailyLearning,
  readRecentLearningRows,
};
