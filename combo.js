const { getDB } = require('./server/db/database');
const { runBacktest } = require('./server/engine/backtest');
const { calcMetrics, monteCarlo } = require('./server/engine/stats');
const { buildAltStrategy } = require('./server/engine/alt-strategy');
const db = getDB();
const rows = db.prepare('SELECT * FROM sessions ORDER BY date').all();
const result = {};
for (const s of rows) {
  const candles = db.prepare("SELECT * FROM candles WHERE session_id = ? AND timeframe = '5m' ORDER BY timestamp").all(s.id);
  if (candles.length > 0) {
    result[s.date] = candles.map(function(c) { return { timestamp: c.timestamp, date: c.timestamp.split(' ')[0], time: c.timestamp.split(' ')[1], open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; });
  }
}
var bt = runBacktest(result);
var alt = buildAltStrategy(bt.trades, result, { startingBalance: 50000, topstepMaxDD: 2000, topstepTarget: 3000, monteCarloSims: 10000 });
var dayList = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function getDay(d) { var p = d.split('-').map(Number); return dayList[new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay()]; }
function run(trades, label) {
  if (trades.length === 0) return;
  var m = calcMetrics(trades);
  var mc = monteCarlo(trades, 10000, { balance: 50000, maxDrawdown: 2000, payoutTarget: 3000 });
  console.log(label);
  console.log('  Trades: ' + trades.length + ' | WR: ' + m.winRate + '% | PF: ' + m.profitFactor + ' | PnL: $' + m.totalPnlDollars.toFixed(2));
  console.log('  MC Payout: ' + mc.probabilities.hitPayout + '% | DD: ' + mc.probabilities.hitDrawdown + '%');
  console.log('');
}
console.log('');
run(bt.trades, '1. ORIGINAL - ALL DAYS');
run(bt.trades.filter(function(t) { return getDay(t.date) !== 'Thursday'; }), '2. ORIGINAL - SKIP THURSDAY');
run(alt.trades, '3. CLOSER TP - ALL DAYS');
run(alt.trades.filter(function(t) { return getDay(t.date) !== 'Thursday'; }), '4. CLOSER TP - SKIP THURSDAY');
run(bt.trades.filter(function(t) { return ['Tuesday','Wednesday','Friday'].indexOf(getDay(t.date)) >= 0; }), '5. ORIGINAL - TUE/WED/FRI ONLY');
run(alt.trades.filter(function(t) { return ['Tuesday','Wednesday','Friday'].indexOf(getDay(t.date)) >= 0; }), '6. CLOSER TP - TUE/WED/FRI ONLY');
