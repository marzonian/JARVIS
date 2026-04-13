/**
 * McNair Mindset by 3130
 * AI Analyst — "The person at the command center"
 * 
 * Builds rich context from all strategy data, then routes
 * conversations through Claude for intelligent analysis.
 */

const ANALYST_CONTEXT_MAX_TRADES = Math.max(40, Number(process.env.ANALYST_CONTEXT_MAX_TRADES || 140));
const ANALYST_CONTEXT_RECENT_MONTHS = Math.max(3, Number(process.env.ANALYST_CONTEXT_RECENT_MONTHS || 6));

function tradeSortKey(trade = {}) {
  return `${String(trade.date || '')}T${String(trade.entry_time || trade.exit_time || '')}`;
}

function formatTradeLine(trade = {}) {
  const sl = Number.isFinite(Number(trade.sl_price)) ? Number(trade.sl_price).toFixed(2) : '—';
  const pnlDollars = Number.isFinite(Number(trade.pnl_dollars)) ? Number(trade.pnl_dollars).toFixed(2) : '0.00';
  return [
    trade.date || '—',
    trade.direction || '—',
    trade.entry_price ?? '—',
    trade.tp_price ?? '—',
    sl,
    trade.result || '—',
    trade.exit_reason || '—',
    `${trade.pnl_ticks ?? 0}t`,
    `$${pnlDollars}`,
  ].join(' | ');
}

/**
 * Build a comprehensive context prompt from all strategy data.
 * This is what makes the AI "someone who knows your data."
 */
function buildAnalystContext(bt, intel, tpSensitivity, regimes, latestDate, options = {}) {
  const m = bt.metrics;
  const dow = bt.dayOfWeek || [];
  const trades = (bt.trades || []).slice().sort((a, b) => tradeSortKey(a).localeCompare(tradeSortKey(b)));
  const recentTrades = trades.slice(-ANALYST_CONTEXT_MAX_TRADES);
  const tp = tpSensitivity;
  const command = options.commandSnapshot || null;
  const dailyVerdict = options.dailyVerdict || null;
  const dataFreshness = options.dataFreshness || null;

  let ctx = `You are the AI analyst for the McNair Mindset trading system (ORB 3130 strategy).
You are embedded in a command center dashboard. The trader relies on you for intelligent, data-driven analysis.

YOUR ROLE:
- You are the "person at the command center" — proactive, direct, analytical.
- Speak like a senior quant analyst / trading coach hybrid. Be direct, no fluff.
- Always reference specific data points from the trader's actual performance.
- When you see patterns, call them out immediately. Don't wait to be asked.
- Use the trader's actual numbers, dates, and trade details in your answers.
- If the trader asks about a specific date, look it up in the trade data below.

STRATEGY: ORB 3130
- Instrument: MNQ (Micro E-mini Nasdaq-100), $0.50/tick
- Timeframe: 5-minute candles
- Opening Range: First 3 candles (9:30-9:45 ET)
- Signal: Breakout → Retest → Confirmation → Entry
- TP: Next psychological level ≥110 ticks from entry (multiples of 25 points)
- SL: Symmetric to TP distance
- Account: Topstep $50K, max DD $2,000, profit target $3,000

CURRENT PERFORMANCE:
- Date Range: ${bt.summary?.dateRange?.start} → ${bt.summary?.dateRange?.end}
- Total Sessions: ${bt.summary?.totalSessions} | Trades: ${m.totalTrades} (${bt.summary?.tradeFrequency}% frequency)
- Win Rate: ${m.winRate}% | Profit Factor: ${m.profitFactor}
- Total P&L: $${m.totalPnlDollars} (${m.totalPnlTicks} ticks)
- Expectancy: $${m.expectancyDollars}/trade
- Avg Win: $${m.avgWinDollars} (${m.avgWinTicks}t) | Avg Loss: $${m.avgLossDollars} (${m.avgLossTicks}t)
- Max Consecutive Wins: ${m.maxConsecWins} | Losses: ${m.maxConsecLosses}
- Sharpe: ${bt.sharpe} | Sortino: ${bt.sortino}
- Max Drawdown: $${bt.drawdown?.maxDrawdownDollars}

INTEL VERDICT: ${intel.verdict} (Score: ${intel.score}/100)

DAY-OF-WEEK BREAKDOWN:
${dow.map(d => `  ${d.dayName}: ${d.totalTrades}t, ${d.winRate}% WR, PF ${d.profitFactor}, $${d.totalPnlDollars}`).join('\n')}

EDGE MAP:
  Strong: ${(intel.edgeMap?.strong || []).join(', ') || 'None'}
  Weak: ${(intel.edgeMap?.weak || []).join(', ') || 'None'}
  Avoid: ${(intel.edgeMap?.avoid || []).join(', ') || 'None'}

EXIT REASONS:
${Object.entries(bt.exitReasons || {}).map(([k, v]) => `  ${k}: ${v} (${Math.round(v / m.totalTrades * 100)}%)`).join('\n')}

DIRECTION BREAKDOWN:
  Long: ${bt.directionBreakdown?.long?.totalTrades || 0} trades, ${bt.directionBreakdown?.long?.winRate || 0}% WR
  Short: ${bt.directionBreakdown?.short?.totalTrades || 0} trades, ${bt.directionBreakdown?.short?.winRate || 0}% WR

MONTE CARLO (10K sims, Topstep rules):
  Hit Payout: ${bt.monteCarlo?.probabilities?.hitPayout || 0}%
  Hit Max DD: ${bt.monteCarlo?.probabilities?.hitDrawdown || 0}%
  Survived: ${bt.monteCarlo?.probabilities?.survived || 0}%
`;

  if (command) {
    const decision = command.decision || {};
    const plan = command.plan || {};
    const topSetup = decision.topSetups?.[0] || null;
    const blockers = Array.isArray(decision.blockers) && decision.blockers.length > 0
      ? decision.blockers.join(', ')
      : 'None';
    const why = decision.why10Words || 'No short reason available.';
    const feedback = command.feedback || {};
    const autonomy = command.autonomy || {};

    ctx += `\nREAL-TIME COMMAND SNAPSHOT:
  Snapshot Generated: ${command.generatedAt || 'n/a'}
  Market Date: ${command.marketDate || latestDate || 'n/a'}
  Signal: ${decision.signalLabel || decision.verdict || 'NO-TRADE'}
  Why: ${why}
  Confidence: ${decision.confidence ?? 'n/a'}%
  Plan Action: ${plan.action || 'n/a'}
  Setup Quality: ${plan.setupQuality?.score ?? 'n/a'}
  Top Setup: ${topSetup ? `${topSetup.name} (setupProb ${topSetup.setupProbability ?? 'n/a'}%, EV $${topSetup.expectedValueDollars ?? 'n/a'})` : 'None'}
  Blockers: ${blockers}
  Autonomy Mode: ${autonomy.mode || 'manual'}
  Feedback Samples: ${feedback.totalSamples || 0}
  Feedback Win Rate: ${feedback.totalWinRate ?? 0}%
`;
  }

  if (dailyVerdict) {
    ctx += `\nLATEST DAILY VERDICT:
  Trade Date: ${dailyVerdict.tradeDate || 'n/a'}
  Signal: ${dailyVerdict.signalLabel || dailyVerdict.signal || 'n/a'}
  Why: ${dailyVerdict.why10Words || 'n/a'}
  Performance: ${dailyVerdict.performanceLine || 'n/a'}
  Final Result: ${dailyVerdict.finalResultLine || 'n/a'}
`;
  }

  if (dataFreshness) {
    ctx += `\nDATA FRESHNESS:
  Today: ${dataFreshness.today || 'n/a'}
  Last Session Date: ${dataFreshness.lastSessionDate || 'n/a'}
  Stale Days: ${dataFreshness.staleDays ?? 'n/a'}
  Is Stale: ${dataFreshness.isStale ? 'yes' : 'no'}
`;
  }

  // TP Sensitivity
  if (tp && tp.offset_analysis) {
    ctx += `\nTP SENSITIVITY ANALYSIS:
  Total Losses: ${tp.total_losses}
  Losses that flip to WIN at 1 psych level closer: ${tp.flips_at_one_closer} (${tp.flip_rate}%)
${tp.offset_analysis.map(o => `  At ${o.levels_closer} level(s) closer: ${o.would_flip}/${o.losses_checked} flip (${o.flip_rate}%), $${o.total_dollar_impact.toFixed(0)} impact`).join('\n')}
`;
  }

  // Monthly
  if (bt.monthly && bt.monthly.length > 0) {
    ctx += `\nRECENT MONTHLY BREAKDOWN:\n`;
    bt.monthly.slice(-ANALYST_CONTEXT_RECENT_MONTHS).forEach(m => {
      ctx += `  ${m.month}: ${m.totalTrades}t, ${m.winRate}% WR, PF ${m.profitFactor}, $${m.totalPnlDollars}\n`;
    });
  }

  // Context is intentionally capped for low-latency analyst replies.
  ctx += `\nRECENT TRADE TAPE (${recentTrades.length}/${trades.length} newest trades):\n`;
  ctx += `Date | Dir | Entry | TP | SL | Result | Exit | Ticks | $PnL\n`;
  ctx += `${'—'.repeat(80)}\n`;
  for (const t of recentTrades) {
    ctx += `${formatTradeLine(t)}\n`;
  }

  // No-trade sessions
  ctx += `\nNO-TRADE REASONS:\n`;
  Object.entries(bt.noTradeReasons || {}).forEach(([reason, count]) => {
    ctx += `  ${reason}: ${count}\n`;
  });

  // Decay status
  if (bt.decay) {
    ctx += `\nEDGE DECAY: ${bt.decay.status || 'unknown'}`;
    if (bt.decay.recentWR !== undefined) {
      ctx += ` (Recent ${bt.decay.window || 30}: ${bt.decay.recentWR}% WR vs Overall ${m.winRate}%)`;
    }
    ctx += '\n';
  }

  // Latest session regime
  if (latestDate && regimes && regimes[latestDate]) {
    const r = regimes[latestDate];
    ctx += `\nLATEST SESSION REGIME (${latestDate}):
  Trend: ${r.regime_trend} | Vol: ${r.regime_vol} | ORB: ${r.regime_orb_size} | Gap: ${r.regime_gap}\n`;
  }

  ctx += `\nIMPORTANT INSTRUCTIONS:
- Be concise but specific. Use numbers from the data above.
- If asked about a specific date, use the trade tape above when available.
- If the requested date is not in this capped tape, state that clearly and answer from the available data without inventing details.
- Proactively identify patterns the trader might not see.
- When suggesting changes, quantify the expected impact.
- Reference the TP sensitivity data when discussing targets.
- Don't hedge or disclaim — give your analysis with conviction.
- If you don't have data to answer, say so directly.
- Format numbers for readability ($X, X%, Xt).
- Prioritize the newest command snapshot and daily verdict when discussing "today".
`;

  return ctx;
}

module.exports = { buildAnalystContext };
