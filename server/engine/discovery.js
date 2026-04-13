/**
 * McNair Mindset by 3130
 * Discovery Lab Engine
 *
 * Generates and evaluates non-ORB candidate strategies on intraday data.
 * Uses strict train/validation/test splits and explicit robustness gates.
 */

const { calcMetrics } = require('./stats');
const { pointsToTicks, ticksToDollars } = require('./psych-levels');

const SESSION_CLOSE_TIME = '15:55';

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getTime(candle) {
  if (candle.time) return candle.time.slice(0, 5);
  const t = candle.timestamp.split(' ')[1] || '';
  return t.slice(0, 5);
}

function between(time, start, end) {
  const t = timeToMinutes(time);
  return t >= timeToMinutes(start) && t <= timeToMinutes(end);
}

function getDayIndexFromDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  const day = d.getDay(); // 0=Sun
  return day === 0 ? 6 : day - 1; // Mon=0..Sun=6
}

function deriveSessionProfile(date, session) {
  const highs = session.map(c => c.high);
  const lows = session.map(c => c.low);
  const sessionRangeTicks = pointsToTicks(Math.max(...highs) - Math.min(...lows));

  let vol = 'extreme';
  if (sessionRangeTicks < 200) vol = 'low';
  else if (sessionRangeTicks < 500) vol = 'normal';
  else if (sessionRangeTicks < 800) vol = 'high';

  const orbCandles = session.filter(c => {
    const t = getTime(c);
    return between(t, '09:30', '09:44');
  });
  let orbTicks = 0;
  if (orbCandles.length > 0) {
    orbTicks = pointsToTicks(
      Math.max(...orbCandles.map(c => c.high)) - Math.min(...orbCandles.map(c => c.low))
    );
  }

  return {
    dayIndex: getDayIndexFromDate(date),
    vol,
    orbTicks,
  };
}

function sessionPassesCandidateFilters(candidate, profile) {
  if (!profile) return true;

  if (Array.isArray(candidate.allowedDays) && candidate.allowedDays.length > 0) {
    if (!candidate.allowedDays.includes(profile.dayIndex)) return false;
  }

  if (Array.isArray(candidate.allowedVol) && candidate.allowedVol.length > 0) {
    if (!candidate.allowedVol.includes(profile.vol)) return false;
  }

  if (typeof candidate.minOrbTicks === 'number' && profile.orbTicks < candidate.minOrbTicks) {
    return false;
  }

  if (typeof candidate.maxOrbTicks === 'number' && profile.orbTicks > candidate.maxOrbTicks) {
    return false;
  }

  return true;
}

function exitTradeFromCandles(postEntryCandles, entry, direction, tpTicks, slTicks) {
  const tpPoints = tpTicks / 4;
  const slPoints = slTicks / 4;
  const tpPrice = direction === 'long' ? entry + tpPoints : entry - tpPoints;
  const slPrice = direction === 'long' ? entry - slPoints : entry + slPoints;

  for (const c of postEntryCandles) {
    const time = getTime(c);
    if (time >= SESSION_CLOSE_TIME) {
      const rawTicks = direction === 'long' ? pointsToTicks(c.close - entry) : pointsToTicks(entry - c.close);
      return {
        result: rawTicks > 0 ? 'win' : rawTicks < 0 ? 'loss' : 'breakeven',
        exit_reason: 'time_close',
        pnl_ticks: rawTicks,
        pnl_dollars: ticksToDollars(rawTicks),
        exit_price: c.close,
        exit_time: c.timestamp,
        tp_price: tpPrice,
        sl_price: slPrice,
      };
    }

    const tpHit = direction === 'long' ? c.high >= tpPrice : c.low <= tpPrice;
    const slHit = direction === 'long' ? c.low <= slPrice : c.high >= slPrice;

    if (tpHit && slHit) {
      const bullish = c.close > c.open;
      const tpFirst = (direction === 'long' && !bullish) || (direction === 'short' && bullish);
      if (tpFirst) {
        return {
          result: 'win',
          exit_reason: 'tp_wick_inferred',
          pnl_ticks: tpTicks,
          pnl_dollars: ticksToDollars(tpTicks),
          exit_price: tpPrice,
          exit_time: c.timestamp,
          tp_price: tpPrice,
          sl_price: slPrice,
        };
      }
      return {
        result: 'loss',
        exit_reason: 'sl_wick_inferred',
        pnl_ticks: -slTicks,
        pnl_dollars: ticksToDollars(-slTicks),
        exit_price: slPrice,
        exit_time: c.timestamp,
        tp_price: tpPrice,
        sl_price: slPrice,
      };
    }

    if (tpHit) {
      return {
        result: 'win',
        exit_reason: 'tp',
        pnl_ticks: tpTicks,
        pnl_dollars: ticksToDollars(tpTicks),
        exit_price: tpPrice,
        exit_time: c.timestamp,
        tp_price: tpPrice,
        sl_price: slPrice,
      };
    }

    if (slHit) {
      return {
        result: 'loss',
        exit_reason: 'sl',
        pnl_ticks: -slTicks,
        pnl_dollars: ticksToDollars(-slTicks),
        exit_price: slPrice,
        exit_time: c.timestamp,
        tp_price: tpPrice,
        sl_price: slPrice,
      };
    }
  }

  const last = postEntryCandles[postEntryCandles.length - 1];
  if (!last) {
    return {
      result: 'no_resolution',
      exit_reason: 'no_data',
      pnl_ticks: 0,
      pnl_dollars: 0,
      exit_price: entry,
      exit_time: null,
      tp_price: tpPrice,
      sl_price: slPrice,
    };
  }
  const rawTicks = direction === 'long' ? pointsToTicks(last.close - entry) : pointsToTicks(entry - last.close);
  return {
    result: rawTicks > 0 ? 'win' : rawTicks < 0 ? 'loss' : 'breakeven',
    exit_reason: 'fallback_close',
    pnl_ticks: rawTicks,
    pnl_dollars: ticksToDollars(rawTicks),
    exit_price: last.close,
    exit_time: last.timestamp,
    tp_price: tpPrice,
    sl_price: slPrice,
  };
}

function analyzeSession(session, candidate) {
  if (!session || session.length < 20) return null;
  const open = session[0].open;
  const byTime = {};
  for (const c of session) byTime[getTime(c)] = c;

  if (candidate.family === 'first_hour_momentum') {
    const entryCandle = byTime[candidate.entryTime];
    if (!entryCandle) return null;
    const moveTicks = pointsToTicks(entryCandle.close - open);
    if (Math.abs(moveTicks) < candidate.thresholdTicks) return null;
    const direction = moveTicks > 0 ? 'long' : 'short';
    const entry = entryCandle.close;
    const entryIdx = session.findIndex(c => c.timestamp === entryCandle.timestamp);
    const postEntry = session.slice(entryIdx + 1);
    return { direction, entry, entry_time: entryCandle.timestamp, postEntry };
  }

  if (candidate.family === 'midday_mean_reversion') {
    const entryCandle = byTime[candidate.entryTime];
    if (!entryCandle) return null;
    const moveTicks = pointsToTicks(entryCandle.close - open);
    if (moveTicks >= candidate.thresholdTicks) {
      const entryIdx = session.findIndex(c => c.timestamp === entryCandle.timestamp);
      return { direction: 'short', entry: entryCandle.close, entry_time: entryCandle.timestamp, postEntry: session.slice(entryIdx + 1) };
    }
    if (moveTicks <= -candidate.thresholdTicks) {
      const entryIdx = session.findIndex(c => c.timestamp === entryCandle.timestamp);
      return { direction: 'long', entry: entryCandle.close, entry_time: entryCandle.timestamp, postEntry: session.slice(entryIdx + 1) };
    }
    return null;
  }

  if (candidate.family === 'lunch_breakout') {
    const lunch = session.filter(c => between(getTime(c), candidate.rangeStart, candidate.rangeEnd));
    if (lunch.length < 3) return null;
    const high = Math.max(...lunch.map(c => c.high));
    const low = Math.min(...lunch.map(c => c.low));
    const triggerPts = candidate.triggerTicks / 4;

    const tradeWindow = session.filter(c => between(getTime(c), candidate.scanStart, candidate.scanEnd));
    for (const c of tradeWindow) {
      if (c.close >= high + triggerPts) {
        const idx = session.findIndex(x => x.timestamp === c.timestamp);
        return { direction: 'long', entry: c.close, entry_time: c.timestamp, postEntry: session.slice(idx + 1) };
      }
      if (c.close <= low - triggerPts) {
        const idx = session.findIndex(x => x.timestamp === c.timestamp);
        return { direction: 'short', entry: c.close, entry_time: c.timestamp, postEntry: session.slice(idx + 1) };
      }
    }
    return null;
  }

  if (candidate.family === 'compression_breakout') {
    const refCandles = session.filter(c => between(getTime(c), candidate.rangeStart, candidate.rangeEnd));
    if (refCandles.length < 4) return null;
    const high = Math.max(...refCandles.map(c => c.high));
    const low = Math.min(...refCandles.map(c => c.low));
    const rangeTicks = pointsToTicks(high - low);
    if (rangeTicks > candidate.maxRangeTicks) return null;
    const triggerPts = candidate.triggerTicks / 4;
    const scan = session.filter(c => between(getTime(c), candidate.scanStart, candidate.scanEnd));
    for (const c of scan) {
      if (c.close >= high + triggerPts) {
        const idx = session.findIndex(x => x.timestamp === c.timestamp);
        return { direction: 'long', entry: c.close, entry_time: c.timestamp, postEntry: session.slice(idx + 1) };
      }
      if (c.close <= low - triggerPts) {
        const idx = session.findIndex(x => x.timestamp === c.timestamp);
        return { direction: 'short', entry: c.close, entry_time: c.timestamp, postEntry: session.slice(idx + 1) };
      }
    }
    return null;
  }

  return null;
}

function runCandidateOnDates(dates, sessions, profiles, candidate) {
  const trades = [];
  for (const date of dates) {
    const session = sessions[date];
    const profile = profiles[date];
    if (!sessionPassesCandidateFilters(candidate, profile)) continue;
    const setup = analyzeSession(session, candidate);
    if (!setup) continue;
    const resolution = exitTradeFromCandles(setup.postEntry, setup.entry, setup.direction, candidate.tpTicks, candidate.slTicks);
    trades.push({
      date,
      direction: setup.direction,
      entry_price: setup.entry,
      entry_time: setup.entry_time,
      ...resolution,
      strategy_key: candidate.key,
    });
  }
  return trades;
}

function splitDates(dates) {
  const n = dates.length;
  const trainN = Math.max(1, Math.floor(n * 0.6));
  const validN = Math.max(1, Math.floor(n * 0.2));
  const testN = Math.max(1, n - trainN - validN);
  return {
    train: dates.slice(0, trainN),
    valid: dates.slice(trainN, trainN + validN),
    test: dates.slice(trainN + validN, trainN + validN + testN),
  };
}

function evaluateCandidate(candidate, sessions, profiles, dates) {
  const { train, valid, test } = splitDates(dates);
  const trainTrades = runCandidateOnDates(train, sessions, profiles, candidate);
  const validTrades = runCandidateOnDates(valid, sessions, profiles, candidate);
  const testTrades = runCandidateOnDates(test, sessions, profiles, candidate);
  const allTrades = [...trainTrades, ...validTrades, ...testTrades];

  const trainM = calcMetrics(trainTrades);
  const validM = calcMetrics(validTrades);
  const testM = calcMetrics(testTrades);
  const overall = calcMetrics(allTrades);

  const failure = [];
  const filteredStrategy = Array.isArray(candidate.allowedDays) || Array.isArray(candidate.allowedVol) ||
    typeof candidate.minOrbTicks === 'number' || typeof candidate.maxOrbTicks === 'number';
  const minOverallTrades = filteredStrategy ? 30 : 40;
  const minTestTrades = filteredStrategy ? 8 : 12;

  if (overall.totalTrades < minOverallTrades) failure.push('insufficient_total_trades');
  if (testM.totalTrades < minTestTrades) failure.push('insufficient_test_trades');
  if (testM.profitFactor < 1.03) failure.push('weak_test_pf');
  if (testM.winRate < 48) failure.push('weak_test_wr');

  const pfDeg = trainM.profitFactor > 0 ? ((testM.profitFactor - trainM.profitFactor) / trainM.profitFactor) * 100 : 0;
  if (pfDeg < -30) failure.push('high_degradation_train_to_test');

  const winRateDelta = testM.winRate - trainM.winRate;
  if (winRateDelta < -12) failure.push('win_rate_decay');

  let score = 0;
  score += Math.min(35, Math.max(0, (testM.profitFactor - 0.9) * 35));
  score += Math.min(25, Math.max(0, (testM.winRate - 45) * 1.2));
  score += Math.min(15, Math.max(0, overall.totalTrades / 6));
  score += Math.min(10, Math.max(0, validM.profitFactor * 8));
  score += Math.min(15, Math.max(0, (testM.expectancyDollars + 5) * 1.5));
  score = Math.round(Math.max(0, Math.min(100, score)));

  const status = failure.length === 0
    ? (score >= 70 ? 'live_eligible' : 'watchlist')
    : 'rejected';

  return {
    key: candidate.key,
    name: candidate.name,
    hypothesis: candidate.hypothesis,
    rules: candidate,
    status,
    robustnessScore: score,
    failureReasons: failure,
    splits: {
      train: trainM,
      valid: validM,
      test: testM,
      overall,
      counts: {
        trainSessions: train.length,
        validSessions: valid.length,
        testSessions: test.length,
      },
    },
  };
}

function dedupCandidates(candidates) {
  const dedup = new Map();
  for (const c of candidates) {
    if (!dedup.has(c.key)) dedup.set(c.key, c);
  }
  return Array.from(dedup.values());
}

function buildProfiles(sessions) {
  const profiles = {};
  const dates = Object.keys(sessions || {});
  for (const d of dates) profiles[d] = deriveSessionProfile(d, sessions[d] || []);
  return profiles;
}

function baseCandidateUniverse() {
  const out = [];

  const momentumTimes = ['10:00', '10:05', '10:15'];
  const momentumThresholds = [70, 90, 110];
  const momentumRisk = [[80, 60], [100, 80], [120, 90]];
  for (const t of momentumTimes) {
    for (const th of momentumThresholds) {
      for (const [tp, sl] of momentumRisk) {
        out.push({
          key: `fhm_${t.replace(':', '')}_${th}_${tp}_${sl}`,
          name: `First-Hour Momentum ${t} (${th}t trigger, ${tp}/${sl})`,
          hypothesis: 'Continuation edge after strong first-hour directional imbalance.',
          family: 'first_hour_momentum',
          entryTime: t,
          thresholdTicks: th,
          tpTicks: tp,
          slTicks: sl,
        });
      }
    }
  }

  const reversionTimes = ['11:00', '11:30', '12:00'];
  const reversionThresholds = [100, 120, 140];
  const reversionRisk = [[80, 80], [100, 90]];
  for (const t of reversionTimes) {
    for (const th of reversionThresholds) {
      for (const [tp, sl] of reversionRisk) {
        out.push({
          key: `mmr_${t.replace(':', '')}_${th}_${tp}_${sl}`,
          name: `Midday Mean Reversion ${t} (${th}t stretch, ${tp}/${sl})`,
          hypothesis: 'Excess morning displacement mean-reverts during midday liquidity.',
          family: 'midday_mean_reversion',
          entryTime: t,
          thresholdTicks: th,
          tpTicks: tp,
          slTicks: sl,
        });
      }
    }
  }

  const lunchTriggers = [6, 8, 10];
  const lunchRisk = [[90, 70], [110, 80]];
  for (const trig of lunchTriggers) {
    for (const [tp, sl] of lunchRisk) {
      out.push({
        key: `lbo_${trig}_${tp}_${sl}`,
        name: `Lunch Range Breakout (${trig}t trigger, ${tp}/${sl})`,
        hypothesis: 'Post-lunch expansion after compression inside lunch range.',
        family: 'lunch_breakout',
        rangeStart: '11:30',
        rangeEnd: '13:00',
        scanStart: '13:05',
        scanEnd: '14:30',
        triggerTicks: trig,
        tpTicks: tp,
        slTicks: sl,
      });
    }
  }

  const compressionWindows = [
    { rangeStart: '09:30', rangeEnd: '10:30', scanStart: '10:35', scanEnd: '12:00' },
    { rangeStart: '09:30', rangeEnd: '11:00', scanStart: '11:05', scanEnd: '14:00' },
  ];
  const maxRanges = [160, 200, 240];
  const triggers = [6, 8, 10];
  const compressionRisk = [[90, 70], [120, 90]];
  for (const w of compressionWindows) {
    for (const mr of maxRanges) {
      for (const trig of triggers) {
        for (const [tp, sl] of compressionRisk) {
          out.push({
            key: `cb_${w.rangeEnd.replace(':', '')}_${mr}_${trig}_${tp}_${sl}`,
            name: `Compression Breakout ${w.rangeEnd} (${mr}t cap, ${trig}t trig, ${tp}/${sl})`,
            hypothesis: 'Compression resolves into directional expansion.',
            family: 'compression_breakout',
            ...w,
            maxRangeTicks: mr,
            triggerTicks: trig,
            tpTicks: tp,
            slTicks: sl,
          });
        }
      }
    }
  }

  return dedupCandidates(out);
}

function withRegimeVariants(base) {
  const regimeVariants = [];
  for (const c of base) {
    regimeVariants.push({
      ...c,
      key: `${c.key}_d_ttw`,
      name: `${c.name} [Tue-Thu]`,
      allowedDays: [1, 2, 3],
    });
    regimeVariants.push({
      ...c,
      key: `${c.key}_v_nh`,
      name: `${c.name} [Vol normal/high]`,
      allowedVol: ['normal', 'high'],
    });
    regimeVariants.push({
      ...c,
      key: `${c.key}_orb_mid`,
      name: `${c.name} [ORB 70-220t]`,
      minOrbTicks: 70,
      maxOrbTicks: 220,
    });
  }
  return regimeVariants;
}

function candidateUniverse() {
  const base = baseCandidateUniverse();
  return dedupCandidates([...base, ...withRegimeVariants(base)]);
}

function tuneNumber(n, delta, min = 1) {
  return Math.max(min, Math.round(n + delta));
}

function stage2CandidatesFromSeeds(seedCandidates) {
  const out = [];

  for (const s of seedCandidates) {
    const base = { ...s };
    const add = (clone, suffix, nameSuffix) => {
      out.push({
        ...clone,
        key: `${clone.key}${suffix}`,
        name: `${clone.name} ${nameSuffix}`,
      });
    };

    if (typeof base.thresholdTicks === 'number') {
      for (const d of [-20, -10, 10, 20]) {
        const c = { ...base, thresholdTicks: tuneNumber(base.thresholdTicks, d, 20) };
        add(c, `_thr${d > 0 ? 'p' : 'm'}${Math.abs(d)}`, `[thr ${d > 0 ? '+' : ''}${d}]`);
      }
    }

    if (typeof base.triggerTicks === 'number') {
      for (const d of [-2, -1, 1, 2]) {
        const c = { ...base, triggerTicks: tuneNumber(base.triggerTicks, d, 2) };
        add(c, `_trg${d > 0 ? 'p' : 'm'}${Math.abs(d)}`, `[trg ${d > 0 ? '+' : ''}${d}]`);
      }
    }

    if (typeof base.maxRangeTicks === 'number') {
      for (const d of [-40, -20, 20, 40]) {
        const c = { ...base, maxRangeTicks: tuneNumber(base.maxRangeTicks, d, 80) };
        add(c, `_rng${d > 0 ? 'p' : 'm'}${Math.abs(d)}`, `[range ${d > 0 ? '+' : ''}${d}]`);
      }
    }

    if (typeof base.tpTicks === 'number' && typeof base.slTicks === 'number') {
      const rrTweaks = [
        [20, 10],
        [10, 0],
        [0, 10],
        [-10, -10],
      ];
      for (const [tpd, sld] of rrTweaks) {
        const c = {
          ...base,
          tpTicks: tuneNumber(base.tpTicks, tpd, 30),
          slTicks: tuneNumber(base.slTicks, sld, 30),
        };
        add(c, `_rr_t${tpd >= 0 ? 'p' : 'm'}${Math.abs(tpd)}s${sld >= 0 ? 'p' : 'm'}${Math.abs(sld)}`, `[rr tp${tpd >= 0 ? '+' : ''}${tpd}/sl${sld >= 0 ? '+' : ''}${sld}]`);
      }
    }

    add({ ...base, allowedDays: [1, 2, 3] }, '_d_ttw_s2', '[Tue-Thu]');
    add({ ...base, allowedVol: ['normal', 'high'] }, '_v_nh_s2', '[vol normal/high]');
    add({ ...base, minOrbTicks: 80, maxOrbTicks: 220 }, '_orb_mid_s2', '[ORB 80-220]');
  }

  return dedupCandidates(out);
}

function deriveConfidence(status, testM, overallM, failures) {
  if (status === 'rejected') return 'low';
  if (failures.length > 0) return 'low';
  if (testM.totalTrades >= 40 && testM.profitFactor >= 1.15 && testM.winRate >= 52 && overallM.totalTrades >= 100) return 'high';
  if (testM.totalTrades >= 20 && testM.profitFactor >= 1.08 && testM.winRate >= 50) return 'moderate';
  return 'low';
}

function runDiscovery(sessions, options = {}) {
  const dates = Object.keys(sessions).sort();
  if (dates.length < 120) {
    return {
      generatedAt: new Date().toISOString(),
      status: 'insufficient_data',
      message: 'Need at least ~120 sessions for robust discovery.',
      summary: { sessions: dates.length, candidates: 0, recommended: 0 },
      candidates: [],
      methodology: {
        split: '60/20/20 chronological (train/validation/test)',
        gates: ['min trades', 'test PF/WR', 'degradation constraints'],
      },
    };
  }

  const profiles = buildProfiles(sessions);
  const mode = options.mode === 'two_stage' ? 'two_stage' : 'full_scan';
  const fullUniverse = candidateUniverse();
  const maxCandidates = Math.min(fullUniverse.length, Math.max(1, Number(options.maxCandidates || fullUniverse.length)));

  let evaluated = [];
  let stage = null;

  if (mode === 'two_stage') {
    const baseUniverse = baseCandidateUniverse();
    const stage1Budget = Math.max(10, Math.min(baseUniverse.length, Number(options.stage1Budget || Math.ceil(maxCandidates * 0.5))));
    const stage1Universe = baseUniverse.slice(0, stage1Budget);
    const stage1 = stage1Universe.map(c => evaluateCandidate(c, sessions, profiles, dates));
    stage1.sort((a, b) => b.robustnessScore - a.robustnessScore);

    const seedTopK = Math.max(3, Math.min(20, Number(options.seedTopK || 10)));
    const seeds = stage1.slice(0, seedTopK).map(c => c.rules);
    const stage2Pool = stage2CandidatesFromSeeds(seeds);
    const stage2Budget = Math.max(0, Math.min(stage2Pool.length, maxCandidates - stage1.length));
    const stage2Universe = stage2Pool.slice(0, stage2Budget);
    const stage2 = stage2Universe.map(c => evaluateCandidate(c, sessions, profiles, dates));
    stage2.sort((a, b) => b.robustnessScore - a.robustnessScore);

    evaluated = [...stage1, ...stage2];
    stage = {
      mode: 'two_stage',
      stage1: { scanned: stage1.length, budget: stage1Budget, seedTopK },
      stage2: { scanned: stage2.length, budget: stage2Budget },
    };
  } else {
    const scan = fullUniverse.slice(0, maxCandidates);
    evaluated = scan.map(c => evaluateCandidate(c, sessions, profiles, dates));
  }

  for (const c of evaluated) {
    c.confidence = deriveConfidence(c.status, c.splits.test || {}, c.splits.overall || {}, c.failureReasons || []);
  }

  evaluated.sort((a, b) => b.robustnessScore - a.robustnessScore);
  const recommended = evaluated.filter(c => c.status === 'live_eligible');
  const watchlist = evaluated.filter(c => c.status === 'watchlist');
  const rejected = evaluated.filter(c => c.status === 'rejected');

  const rejectionCounts = {};
  for (const c of rejected) {
    for (const r of c.failureReasons || []) {
      rejectionCounts[r] = (rejectionCounts[r] || 0) + 1;
    }
  }
  const topRejections = Object.entries(rejectionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  const nextResearchActions = [];
  if (recommended.length === 0) {
    if ((rejectionCounts.insufficient_test_trades || 0) > 0) {
      nextResearchActions.push('Prioritize higher-frequency templates to raise out-of-sample trade count.');
    }
    if ((rejectionCounts.weak_test_wr || 0) > 0) {
      nextResearchActions.push('Introduce direction/regime filters to stabilize test win-rate.');
    }
    if ((rejectionCounts.high_degradation_train_to_test || 0) > 0) {
      nextResearchActions.push('Reduce parameter sensitivity and tighten robustness penalties.');
    }
  } else {
    nextResearchActions.push('Run paper-forward validation on live-eligible candidates before deployment.');
  }

  return {
    generatedAt: new Date().toISOString(),
    status: 'ok',
    mode,
    summary: {
      sessions: dates.length,
      candidates: evaluated.length,
      recommended: recommended.length,
      watchlist: watchlist.length,
      rejected: rejected.length,
    },
    stage,
    methodology: {
      split: '60/20/20 chronological (train/validation/test)',
      gates: [
        'overall trades >= 40 (>=30 for filtered variants)',
        'test trades >= 12 (>=8 for filtered variants)',
        'test PF >= 1.03',
        'test WR >= 48%',
        'degradation constraints train->test',
      ],
      note: 'Research output only. No strategy is auto-applied.',
    },
    diagnostics: {
      topRejections,
      nextResearchActions,
    },
    topRecommendations: recommended.slice(0, 5),
    candidates: evaluated,
  };
}

function evaluateCandidateWindow(sessions, candidateRules, options = {}) {
  const dates = Object.keys(sessions || {}).sort();
  const startDate = options.startDate || dates[0] || null;
  const endDate = options.endDate || dates[dates.length - 1] || null;
  const selected = dates.filter(d => (!startDate || d >= startDate) && (!endDate || d <= endDate));
  const profiles = buildProfiles(sessions);
  const trades = runCandidateOnDates(selected, sessions, profiles, candidateRules);
  const metrics = calcMetrics(trades);
  return {
    startDate,
    endDate,
    sessions: selected.length,
    trades,
    metrics,
  };
}

module.exports = {
  runDiscovery,
  evaluateCandidateWindow,
  analyzeSession,
  deriveSessionProfile,
  sessionPassesCandidateFilters,
};
