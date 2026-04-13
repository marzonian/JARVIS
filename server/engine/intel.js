/**
 * McNair Mindset by 3130
 * Intel Engine — Automated Strategy Analysis
 * 
 * Analyzes backtest results and generates actionable intelligence:
 * - Performance diagnosis
 * - Regime recommendations  
 * - Risk management suggestions
 * - Session-specific warnings
 * - Edge identification
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/**
 * Generate full intelligence report from backtest results.
 */
function generateIntel(bt, regimes, latestDate) {
  const HIGH_VOLATILITY_ROLLING3_LIMIT = 450;
  const HIGH_VOLATILITY_MSG = 'High Volatility Regime Detected: Probability of fakeouts increased. Tighten stops or increase blocker sensitivity.';
  const intel = {
    generated: new Date().toISOString(),
    verdict: null,
    score: 0,
    alerts: [],
    insights: [],
    recommendations: [],
    todayBrief: null,
    edgeMap: { strong: [], weak: [], avoid: [] },
  };

  const m = bt.metrics;
  const trades = bt.trades;
  const recentOrbTicks = (bt.sessionResults || [])
    .map((s) => Number(s?.orb?.range_ticks))
    .filter((n) => Number.isFinite(n));
  const rolling3OrbAvg = recentOrbTicks.length >= 3
    ? (recentOrbTicks.slice(-3).reduce((sum, n) => sum + n, 0) / 3)
    : null;

  if (!trades || trades.length < 10) {
    intel.verdict = 'INSUFFICIENT DATA';
    intel.alerts.push({ level: 'info', msg: 'Need at least 10 trades for meaningful analysis. Keep logging sessions.' });
    return intel;
  }

  // ═══════════════════════════════════════
  // OVERALL HEALTH SCORE (0-100)
  // ═══════════════════════════════════════
  let score = 50; // Start neutral

  // Win rate contribution (-20 to +20)
  if (m.winRate >= 55) score += 15;
  else if (m.winRate >= 50) score += 5;
  else if (m.winRate >= 45) score -= 5;
  else score -= 15;

  // Profit factor (-20 to +20)
  if (m.profitFactor >= 1.5) score += 20;
  else if (m.profitFactor >= 1.2) score += 10;
  else if (m.profitFactor >= 1.0) score += 0;
  else if (m.profitFactor >= 0.8) score -= 10;
  else score -= 20;

  // Expectancy
  if (m.expectancyDollars > 10) score += 10;
  else if (m.expectancyDollars > 0) score += 5;
  else if (m.expectancyDollars > -5) score -= 5;
  else score -= 10;

  // Consistency — streak analysis
  if (m.maxConsecLosses >= 8) score -= 10;
  else if (m.maxConsecLosses >= 6) score -= 5;
  if (m.maxConsecWins >= 6) score += 5;

  intel.score = Math.max(0, Math.min(100, score));

  // Verdict
  if (intel.score >= 75) intel.verdict = 'STRONG EDGE';
  else if (intel.score >= 60) intel.verdict = 'DEVELOPING EDGE';
  else if (intel.score >= 45) intel.verdict = 'MARGINAL';
  else if (intel.score >= 30) intel.verdict = 'WEAK — NEEDS WORK';
  else intel.verdict = 'NO EDGE — DO NOT TRADE LIVE';

  // ═══════════════════════════════════════
  // ALERTS (urgent issues)
  // ═══════════════════════════════════════

  if (m.profitFactor < 1.0) {
    intel.alerts.push({
      level: 'critical',
      msg: `Strategy is net negative (PF ${m.profitFactor}). Losses exceed wins by ${Math.round((1 - m.profitFactor) * 100)}%. Do NOT trade live until resolved.`,
    });
  }

  if (m.totalPnlDollars < -500) {
    intel.alerts.push({
      level: 'critical',
      msg: `Cumulative loss of $${Math.abs(m.totalPnlDollars).toFixed(0)}. On a $50K Topstep account, this is ${(Math.abs(m.totalPnlDollars) / 2000 * 100).toFixed(1)}% of your max drawdown.`,
    });
  }

  if (m.maxConsecLosses >= 6) {
    intel.alerts.push({
      level: 'warning',
      msg: `Max losing streak: ${m.maxConsecLosses} trades in a row. This will test your psychology. Have a daily loss limit.`,
    });
  }
  if (Number.isFinite(rolling3OrbAvg) && rolling3OrbAvg > HIGH_VOLATILITY_ROLLING3_LIMIT) {
    intel.alerts.push({
      level: 'warning',
      msg: HIGH_VOLATILITY_MSG,
    });
  }

  // Check for unresolved conflicts
  const conservativeTrades = trades.filter(t => t.exit_reason === 'sl_conservative');
  if (conservativeTrades.length > 0) {
    intel.alerts.push({
      level: 'action',
      msg: `${conservativeTrades.length} ambiguous trade(s) need your input. Go to ⚡ Conflicts to resolve them — this directly affects your P&L.`,
    });
  }

  // ═══════════════════════════════════════
  // DAY-OF-WEEK ANALYSIS
  // ═══════════════════════════════════════
  const dow = bt.dayOfWeek || [];
  
  for (const d of dow) {
    if (d.totalTrades < 3) continue;

    if (d.winRate <= 25) {
      intel.edgeMap.avoid.push(d.dayName);
      intel.recommendations.push({
        priority: 'high',
        type: 'filter',
        msg: `Skip ${d.dayName}s. ${d.winRate}% WR across ${d.totalTrades} trades = burning money. This alone would save $${Math.abs(d.totalPnlDollars).toFixed(0)}.`,
        impact: Math.abs(d.totalPnlDollars),
      });
    } else if (d.winRate >= 60 && d.profitFactor >= 1.3) {
      intel.edgeMap.strong.push(d.dayName);
      intel.insights.push({
        type: 'edge',
        msg: `${d.dayName} is your best day: ${d.winRate}% WR, PF ${d.profitFactor}, +$${d.totalPnlDollars.toFixed(0)}. Consider sizing up.`,
      });
    } else if (d.winRate < 45 && d.totalPnlDollars < -50) {
      intel.edgeMap.weak.push(d.dayName);
      intel.insights.push({
        type: 'caution',
        msg: `${d.dayName} is underperforming: ${d.winRate}% WR, $${d.totalPnlDollars.toFixed(0)} P&L. Watch for pattern changes.`,
      });
    }
  }

  // ═══════════════════════════════════════
  // RISK:REWARD ANALYSIS
  // ═══════════════════════════════════════
  const avgWinTicks = m.avgWinTicks || 0;
  const avgLossTicks = m.avgLossTicks || 0;
  const rr = avgLossTicks > 0 ? (avgWinTicks / avgLossTicks).toFixed(2) : 'N/A';

  if (avgLossTicks > avgWinTicks * 1.1) {
    intel.insights.push({
      type: 'risk',
      msg: `Avg loss (${avgLossTicks.toFixed(0)}t) exceeds avg win (${avgWinTicks.toFixed(0)}t). R:R is ${rr}. You need >${Math.round(avgLossTicks / (avgWinTicks + avgLossTicks) * 100)}% WR to break even.`,
    });
  }

  // Required WR to break even
  const breakEvenWR = avgLossTicks > 0 ? Math.round(avgLossTicks / (avgWinTicks + avgLossTicks) * 100) : 50;
  intel.insights.push({
    type: 'math',
    msg: `With ${avgWinTicks.toFixed(0)}t wins and ${avgLossTicks.toFixed(0)}t losses, you need ${breakEvenWR}% WR to break even. Current: ${m.winRate}%.`,
  });

  // ═══════════════════════════════════════
  // DIRECTION ANALYSIS
  // ═══════════════════════════════════════
  const longWR = m.longWinRate || 0;
  const shortWR = m.shortWinRate || 0;
  
  if (Math.abs(longWR - shortWR) > 15) {
    const better = longWR > shortWR ? 'long' : 'short';
    const worse = better === 'long' ? 'short' : 'long';
    const betterWR = better === 'long' ? longWR : shortWR;
    const worseWR = better === 'long' ? shortWR : longWR;
    intel.insights.push({
      type: 'direction',
      msg: `Strong ${better} bias: ${betterWR}% vs ${worseWR}% ${worse}. Consider filtering or reducing size on ${worse} trades.`,
    });
  }

  // ═══════════════════════════════════════
  // EXIT REASON ANALYSIS
  // ═══════════════════════════════════════
  const exitReasons = bt.exitReasons || {};
  const tpCount = exitReasons.tp || 0;
  const slCount = exitReasons.sl || 0;
  const tpRate = trades.length > 0 ? Math.round(tpCount / trades.length * 100) : 0;

  if (tpRate < 40) {
    intel.insights.push({
      type: 'exits',
      msg: `Only ${tpRate}% of trades reach TP. Most exits are stops. TP targets may be too aggressive — consider tighter targets on low-conviction setups.`,
    });
  }

  // ═══════════════════════════════════════
  // WHAT-IF SCENARIOS
  // ═══════════════════════════════════════
  
  // What if we skip the worst day?
  const worstDay = [...dow].filter(d => d.totalTrades >= 3).sort((a, b) => a.totalPnlDollars - b.totalPnlDollars)[0];
  if (worstDay && worstDay.totalPnlDollars < -100) {
    const withoutWorst = trades.filter(t => {
      const d = new Date(t.date + 'T12:00:00');
      const dayIdx = d.getDay();
      const adjIdx = dayIdx === 0 ? 6 : dayIdx - 1;
      return DAYS[adjIdx] !== worstDay.dayName;
    });
    const filteredWins = withoutWorst.filter(t => t.result === 'win').length;
    const filteredWR = Math.round(filteredWins / withoutWorst.length * 1000) / 10;
    const filteredPnL = withoutWorst.reduce((s, t) => s + (t.pnl_dollars || 0), 0);

    intel.recommendations.push({
      priority: 'high',
      type: 'what-if',
      msg: `Without ${worstDay.dayName}s: ${filteredWR}% WR, $${filteredPnL.toFixed(0)} P&L across ${withoutWorst.length} trades. That's a $${(filteredPnL - m.totalPnlDollars).toFixed(0)} improvement.`,
      impact: filteredPnL - m.totalPnlDollars,
    });
  }

  // ═══════════════════════════════════════
  // TOPSTEP-SPECIFIC INTEL
  // ═══════════════════════════════════════
  const mc = bt.monteCarlo;
  if (mc) {
    if (mc.probabilities?.hitPayout === 0) {
      intel.alerts.push({
        level: 'critical',
        msg: 'Monte Carlo shows 0% chance of hitting Topstep payout target. Strategy needs fundamental improvement before going live.',
      });
    } else if (mc.probabilities?.hitPayout < 20) {
      intel.alerts.push({
        level: 'warning',
        msg: `Only ${mc.probabilities.hitPayout}% chance of hitting payout. High risk of blowing the account.`,
      });
    }

    if (mc.probabilities?.hitDrawdown > 10) {
      intel.alerts.push({
        level: 'warning',
        msg: `${mc.probabilities.hitDrawdown}% chance of hitting max drawdown ($2,000). Consider smaller position size.`,
      });
    }
  }

  // ═══════════════════════════════════════
  // TODAY'S BRIEF — uses actual current date
  // ═══════════════════════════════════════
  if (latestDate && regimes && regimes[latestDate]) {
    const r = regimes[latestDate]; // latest session regime as reference

    // Use ACTUAL today for day-of-week analysis
    const now = new Date();
    const todayDow = now.getDay(); // 0=Sun
    const todayAdj = todayDow === 0 ? 6 : todayDow - 1; // Mon=0
    const todayName = DAYS[todayAdj] || 'Weekend';
    const todayDate = now.toISOString().split('T')[0];
    const dayStats = dow.find(d => d.dayName === todayName);

    const warnings = [];
    const signals = [];

    if (todayAdj > 4) {
      // Weekend
      intel.todayBrief = {
        date: todayDate,
        dayName: todayName,
        dayStats: null,
        lastSession: latestDate,
        regime: r,
        warnings: ['Markets closed. Review your week.'],
        signals: [],
        action: 'MARKETS CLOSED',
      };
    } else {
      if (intel.edgeMap.avoid.includes(todayName)) {
        warnings.push(`${todayName} is flagged AVOID — sit out today.`);
      } else if (intel.edgeMap.strong.includes(todayName)) {
        signals.push(`${todayName} is your strongest day — full conviction.`);
      }

      // Use latest session regime as proxy for conditions
      if (r.regime_vol === 'extreme') {
        warnings.push('Last session showed extreme volatility. Wider stops, bigger swings. Consider half-size.');
      } else if (r.regime_vol === 'high') {
        warnings.push('Elevated volatility in recent sessions. Stay disciplined on stops.');
      }

      if (r.regime_orb_size === 'wide') {
        warnings.push('Last ORB was wide — if today is similar, SL distance will be higher than normal.');
      }

      if (r.regime_trend === 'choppy') {
        warnings.push('Recent market structure is choppy. False breakouts more likely.');
      }
      if (Number.isFinite(rolling3OrbAvg) && rolling3OrbAvg > HIGH_VOLATILITY_ROLLING3_LIMIT) {
        warnings.push(HIGH_VOLATILITY_MSG);
      }

      // Recent momentum
      const recent5 = trades.slice(-5);
      const recent5Wins = recent5.filter(t => t.result === 'win').length;
      if (recent5Wins <= 1) {
        warnings.push(`Cold streak: only ${recent5Wins}/5 recent wins. Stay small or sit out.`);
      } else if (recent5Wins >= 4) {
        signals.push(`Hot streak: ${recent5Wins}/5 recent wins. Stay disciplined, don't oversize.`);
      }

      intel.todayBrief = {
        date: todayDate,
        dayName: todayName,
        dayStats,
        lastSession: latestDate,
        regime: r,
        warnings,
        signals,
        action: warnings.length > 1 ? 'CAUTION' : warnings.length === 1 ? 'PROCEED WITH CARE' : 'GREEN LIGHT',
      };
    }
  }

  // Sort recommendations by impact
  intel.recommendations.sort((a, b) => (b.impact || 0) - (a.impact || 0));

  return intel;
}

module.exports = { generateIntel };
