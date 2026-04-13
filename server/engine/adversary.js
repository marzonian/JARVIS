/**
 * McNair Mindset by 3130
 * The Adversary — Vulnerability Scanner
 * 
 * Systematically searches for market conditions
 * where the ORB 3130 strategy underperforms.
 */

const { calcMetrics } = require('./stats');

const SEVERITY_THRESHOLDS = {
  critical: { wrDrop: 15, pfBelow: 0.8 },
  high:     { wrDrop: 10, pfBelow: 1.0 },
  moderate: { wrDrop: 5,  pfBelow: 1.1 },
  low:      { wrDrop: 0,  pfBelow: 1.2 },
};

const MIN_SAMPLE_SIZE = 5;

/**
 * Run full adversary scan on backtest trades with regime data.
 * 
 * @param {Array} trades - Backtest trade results
 * @param {Object} regimes - { 'YYYY-MM-DD': regimeClassification }
 * @param {Object} baselineMetrics - Baseline strategy metrics
 * @returns {Array} Sorted vulnerability findings
 */
function runAdversaryScan(trades, regimes, baselineMetrics) {
  const findings = [];
  
  // Attach regime data to trades
  const enrichedTrades = trades.map(t => {
    const date = t.date || t.entry_time?.split(' ')[0];
    return { ...t, regime: regimes[date] || null };
  }).filter(t => t.regime);

  if (enrichedTrades.length === 0) return findings;

  // Single dimension scans
  const dimensions = [
    { name: 'day_of_week', label: 'Day of Week', values: { 0: 'Monday', 1: 'Tuesday', 2: 'Wednesday', 3: 'Thursday', 4: 'Friday' } },
    { name: 'regime_trend', label: 'Trend', getter: t => t.regime.regime_trend },
    { name: 'regime_vol', label: 'Volatility', getter: t => t.regime.regime_vol },
    { name: 'regime_gap', label: 'Gap', getter: t => t.regime.regime_gap },
    { name: 'regime_orb_size', label: 'ORB Size', getter: t => t.regime.regime_orb_size },
    {
      name: 'first_15min',
      label: 'First 15min',
      getter: t => t.regime.first_15min,
      values: {
        continuation_up: 'Continued Up After ORB',
        continuation_down: 'Continued Down After ORB',
        inside: 'Stayed Inside ORB',
        unknown: 'Unknown',
      },
    },
    {
      name: 'session_type',
      label: 'Session Type',
      getter: t => t.regime.session_type,
      values: {
        am_dominant: 'Morning-Dominant Session',
        pm_dominant: 'Afternoon-Dominant Session',
        balanced: 'Balanced Session',
        unknown: 'Unknown',
      },
    },
    { name: 'direction', label: 'Direction', getter: t => t.direction },
  ];

  for (const dim of dimensions) {
    const groups = groupTrades(enrichedTrades, dim);
    for (const [value, groupTrades_] of Object.entries(groups)) {
      if (groupTrades_.length < MIN_SAMPLE_SIZE) continue;
      
      const metrics = calcMetrics(groupTrades_);
      const finding = assessVulnerability(
        `${dim.label}: ${dim.values ? dim.values[value] || value : value}`,
        { [dim.name]: value },
        metrics,
        baselineMetrics
      );
      if (finding) findings.push(finding);
    }
  }

  // Cross-dimension scans (pairs)
  const crossPairs = [
    ['day_of_week', 'regime_vol'],
    ['day_of_week', 'regime_orb_size'],
    ['regime_trend', 'regime_vol'],
    ['regime_gap', 'regime_trend'],
    ['regime_orb_size', 'regime_vol'],
    ['direction', 'regime_trend'],
    ['direction', 'day_of_week'],
    ['first_15min', 'regime_trend'],
  ];

  for (const [dim1Name, dim2Name] of crossPairs) {
    const dim1 = dimensions.find(d => d.name === dim1Name);
    const dim2 = dimensions.find(d => d.name === dim2Name);
    if (!dim1 || !dim2) continue;

    const groups = crossGroupTrades(enrichedTrades, dim1, dim2);
    for (const [key, groupTrades_] of Object.entries(groups)) {
      if (groupTrades_.length < MIN_SAMPLE_SIZE) continue;
      
      const metrics = calcMetrics(groupTrades_);
      const finding = assessVulnerability(
        key,
        { cross: key },
        metrics,
        baselineMetrics
      );
      if (finding) findings.push(finding);
    }
  }

  // Sort by severity (critical first) then by win rate deviation
  const severityOrder = { critical: 0, high: 1, moderate: 2, low: 3 };
  findings.sort((a, b) => {
    const sev = severityOrder[a.severity] - severityOrder[b.severity];
    if (sev !== 0) return sev;
    return a.win_rate - b.win_rate;
  });

  return findings;
}

function groupTrades(trades, dim) {
  const groups = {};
  for (const t of trades) {
    let value;
    if (dim.getter) {
      value = dim.getter(t);
    } else if (dim.name === 'day_of_week') {
      value = t.regime?.day_of_week;
    } else {
      value = t.regime?.[dim.name];
    }
    if (value === undefined || value === null) continue;
    if (!groups[value]) groups[value] = [];
    groups[value].push(t);
  }
  return groups;
}

function crossGroupTrades(trades, dim1, dim2) {
  const groups = {};
  for (const t of trades) {
    const v1 = dim1.getter ? dim1.getter(t) : (dim1.name === 'day_of_week' ? t.regime?.day_of_week : t.regime?.[dim1.name]);
    const v2 = dim2.getter ? dim2.getter(t) : (dim2.name === 'day_of_week' ? t.regime?.day_of_week : t.regime?.[dim2.name]);
    if (v1 === undefined || v2 === undefined) continue;
    
    const label1 = dim1.values ? dim1.values[v1] || v1 : v1;
    const label2 = dim2.values ? dim2.values[v2] || v2 : v2;
    const key = `${dim1.label}: ${label1} + ${dim2.label}: ${label2}`;
    
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return groups;
}

function assessVulnerability(description, filter, metrics, baseline) {
  const wrDrop = baseline.winRate - metrics.winRate;
  const pfDiff = baseline.profitFactor - metrics.profitFactor;

  // Determine severity
  let severity = null;
  if (wrDrop >= SEVERITY_THRESHOLDS.critical.wrDrop || metrics.profitFactor < SEVERITY_THRESHOLDS.critical.pfBelow) {
    severity = 'critical';
  } else if (wrDrop >= SEVERITY_THRESHOLDS.high.wrDrop || metrics.profitFactor < SEVERITY_THRESHOLDS.high.pfBelow) {
    severity = 'high';
  } else if (wrDrop >= SEVERITY_THRESHOLDS.moderate.wrDrop || metrics.profitFactor < SEVERITY_THRESHOLDS.moderate.pfBelow) {
    severity = 'moderate';
  }

  // Only report if there's a meaningful vulnerability
  if (!severity) return null;

  return {
    regime_desc: description,
    regime_filter: filter,
    total_trades: metrics.totalTrades,
    wins: metrics.wins,
    losses: metrics.losses,
    win_rate: metrics.winRate,
    profit_factor: metrics.profitFactor,
    severity,
    baseline_wr: baseline.winRate,
    baseline_pf: baseline.profitFactor,
    deviation_wr: Math.round(wrDrop * 10) / 10,
    deviation_pf: Math.round(pfDiff * 100) / 100,
    expectancy: metrics.expectancyDollars,
    pnl: metrics.totalPnlDollars,
  };
}

module.exports = { runAdversaryScan };
