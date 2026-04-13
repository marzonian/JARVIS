'use strict';

const { runDiscovery } = require('../engine/discovery');
const {
  ORIGINAL_PLAN_SPEC,
  runPlanBacktest,
} = require('./strategy-layers');

const DEFAULT_WINDOW_SESSIONS = 180;
const MIN_WINDOW_SESSIONS = 60;
const MAX_WINDOW_SESSIONS = 500;
const DEFAULT_CANDIDATE_LIMIT = 20;
const MIN_CANDIDATE_LIMIT = 3;
const MAX_CANDIDATE_LIMIT = 120;

const FAMILY_ALIASES = Object.freeze({
  first_hour_momentum: 'first_hour_momentum',
  momentum: 'first_hour_momentum',
  post_orb_continuation: 'compression_breakout',
  compression_breakout: 'compression_breakout',
  continuation: 'compression_breakout',
  lunch_breakout: 'lunch_breakout',
  alt_time_trigger: 'lunch_breakout',
  midday_mean_reversion: 'midday_mean_reversion',
  mean_reversion: 'midday_mean_reversion',
});

const FAMILY_META = Object.freeze({
  first_hour_momentum: {
    family: 'first_hour_momentum',
    familyLabel: 'First-hour momentum variants',
  },
  compression_breakout: {
    family: 'compression_breakout',
    familyLabel: 'Post-ORB continuation variants',
  },
  lunch_breakout: {
    family: 'lunch_breakout',
    familyLabel: 'Alternative time-trigger setups',
  },
  midday_mean_reversion: {
    family: 'midday_mean_reversion',
    familyLabel: 'Mean-reversion countertrend variants',
  },
});

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toLower(value) {
  return toText(value).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeFamilyFilter(value) {
  const key = toLower(value);
  if (!key) return null;
  return FAMILY_ALIASES[key] || null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildWindowedSessions(sessions = {}, windowSessions = DEFAULT_WINDOW_SESSIONS) {
  const dates = Object.keys(sessions || {}).sort();
  const bounded = dates.slice(Math.max(0, dates.length - windowSessions));
  const out = {};
  for (const d of bounded) out[d] = toArray(sessions[d]);
  return {
    sessions: out,
    dates: bounded,
    totalSessions: dates.length,
    windowSessions: bounded.length,
  };
}

function familyMetaFromRules(rules = {}) {
  const raw = toLower(rules?.family || '');
  return FAMILY_META[raw] || {
    family: raw || 'unknown',
    familyLabel: raw ? raw.replace(/_/g, ' ') : 'Unknown family',
  };
}

function inferOriginType(candidate = {}) {
  const key = toLower(candidate?.key || '');
  if (/(_thr|_trg|_rr_|_rng|_s2)/.test(key)) return 'parameterized_variant_family';
  if (toText(candidate?.rules?.family)) return 'derived_from_existing_family';
  return 'discovered_candidate';
}

function buildEntryModel(rules = {}) {
  const family = toLower(rules.family);
  if (family === 'first_hour_momentum') {
    return `Momentum trigger at ${toText(rules.entryTime || '10:00')} with ${toNumber(rules.thresholdTicks, 0)} tick threshold.`;
  }
  if (family === 'midday_mean_reversion') {
    return `Midday stretch reversal at ${toText(rules.entryTime || '11:30')} using ${toNumber(rules.thresholdTicks, 0)} tick displacement.`;
  }
  if (family === 'lunch_breakout') {
    return `Breakout after lunch range with ${toNumber(rules.triggerTicks, 0)} tick trigger.`;
  }
  if (family === 'compression_breakout') {
    return `Breakout from compression range with ${toNumber(rules.triggerTicks, 0)} tick trigger and ${toNumber(rules.maxRangeTicks, 0)} tick cap.`;
  }
  return 'Candidate-defined entry trigger.';
}

function buildTimeModel(rules = {}) {
  const family = toLower(rules.family);
  if (family === 'first_hour_momentum' || family === 'midday_mean_reversion') {
    return `Single trigger candle at ${toText(rules.entryTime || 'unknown')}.`;
  }
  if (family === 'lunch_breakout' || family === 'compression_breakout') {
    return `Range ${toText(rules.rangeStart || 'unknown')}-${toText(rules.rangeEnd || 'unknown')}, scan ${toText(rules.scanStart || 'unknown')}-${toText(rules.scanEnd || 'unknown')}.`;
  }
  return 'Session-window timing model.';
}

function buildExitModel(rules = {}) {
  const tp = toNumber(rules.tpTicks, 0);
  const sl = toNumber(rules.slTicks, 0);
  return `Fixed TP/SL ${tp}t/${sl}t (wick-aware candle resolution).`;
}

function calcDrawdownProxy(metrics = {}) {
  const avgLoss = Math.abs(toNumber(metrics.avgLossDollars, 0));
  const streak = Math.max(1, toNumber(metrics.maxConsecLosses, 0));
  return round2(avgLoss * streak);
}

function buildComparisonVsOriginal(candidateMetrics = {}, baselineMetrics = {}, windowSessionCount = 0) {
  const baselineTrades = toNumber(baselineMetrics.totalTrades, 0);
  const candidateTrades = toNumber(candidateMetrics.totalTrades, 0);
  const baselineFreq = windowSessionCount > 0 ? round2((baselineTrades / windowSessionCount) * 100) : 0;
  const candidateFreq = windowSessionCount > 0 ? round2((candidateTrades / windowSessionCount) * 100) : 0;
  return {
    pnlDifferenceDollars: round2(toNumber(candidateMetrics.totalPnlDollars, 0) - toNumber(baselineMetrics.totalPnlDollars, 0)),
    winRateDifference: round2(toNumber(candidateMetrics.winRate, 0) - toNumber(baselineMetrics.winRate, 0)),
    profitFactorDifference: round2(toNumber(candidateMetrics.profitFactor, 0) - toNumber(baselineMetrics.profitFactor, 0)),
    tradeFrequencyDifference: round2(candidateFreq - baselineFreq),
    candidateTradeFrequencyPct: candidateFreq,
    originalTradeFrequencyPct: baselineFreq,
  };
}

function countComplexitySignals(rules = {}) {
  const keys = [
    'thresholdTicks',
    'triggerTicks',
    'tpTicks',
    'slTicks',
    'entryTime',
    'rangeStart',
    'rangeEnd',
    'scanStart',
    'scanEnd',
    'maxRangeTicks',
    'minOrbTicks',
    'maxOrbTicks',
  ];
  let count = 0;
  for (const key of keys) {
    const value = rules[key];
    if (value !== undefined && value !== null && toText(value) !== '') count += 1;
  }
  if (Array.isArray(rules.allowedDays) && rules.allowedDays.length) count += 1;
  if (Array.isArray(rules.allowedVol) && rules.allowedVol.length) count += 1;
  return count;
}

function buildRobustnessAnalysis(candidate = {}, metrics = {}, sessionWindowCount = 0) {
  const warnings = [];
  let penalty = 0;
  const tradeCount = toNumber(metrics.totalTrades, 0);

  if (tradeCount < 15) {
    penalty += 30;
    warnings.push('very_low_trade_count');
  } else if (tradeCount < 30) {
    penalty += 20;
    warnings.push('low_trade_count');
  } else if (tradeCount < 45) {
    penalty += 10;
    warnings.push('moderate_trade_count');
  }

  if (sessionWindowCount < 90) {
    penalty += 8;
    warnings.push('thin_session_window');
  }

  const train = candidate?.splits?.train || {};
  const test = candidate?.splits?.test || {};
  const trainPf = toNumber(train.profitFactor, 0);
  const testPf = toNumber(test.profitFactor, 0);
  const trainWr = toNumber(train.winRate, 0);
  const testWr = toNumber(test.winRate, 0);

  if (trainPf > 0) {
    const pfDrop = (trainPf - testPf) / trainPf;
    if (pfDrop > 0.35) {
      penalty += 12;
      warnings.push('high_pf_degradation_train_to_test');
    } else if (pfDrop > 0.2) {
      penalty += 6;
      warnings.push('moderate_pf_degradation_train_to_test');
    }
  }

  const wrDrop = trainWr - testWr;
  if (wrDrop > 10) {
    penalty += 10;
    warnings.push('high_wr_degradation_train_to_test');
  } else if (wrDrop > 6) {
    penalty += 5;
    warnings.push('moderate_wr_degradation_train_to_test');
  }

  const complexity = countComplexitySignals(candidate?.rules || {});
  if (complexity > 10) {
    penalty += 8;
    warnings.push('high_rule_complexity');
  } else if (complexity > 8) {
    penalty += 4;
    warnings.push('moderate_rule_complexity');
  }

  const hasNarrowDays = Array.isArray(candidate?.rules?.allowedDays) && candidate.rules.allowedDays.length > 0 && candidate.rules.allowedDays.length <= 2;
  const hasNarrowVol = Array.isArray(candidate?.rules?.allowedVol) && candidate.rules.allowedVol.length > 0 && candidate.rules.allowedVol.length <= 1;
  if (hasNarrowDays || hasNarrowVol) {
    penalty += 6;
    warnings.push('narrow_condition_dependence');
  }

  const baseScore = clamp(toNumber(candidate?.robustnessScore, 0), 0, 100);
  const adjustedScore = clamp(baseScore - penalty, 0, 100);

  return {
    baseScore: round2(baseScore),
    adjustedScore: round2(adjustedScore),
    penalty: round2(penalty),
    warnings,
  };
}

function classifyRobustnessLabel(input = {}) {
  const score = toNumber(input.adjustedScore, 0);
  const tradeCount = toNumber(input.tradeCount, 0);
  const pf = toNumber(input.profitFactor, 0);
  const wr = toNumber(input.winRate, 0);

  if (score >= 78 && tradeCount >= 45 && pf >= 1.15 && wr >= 52) {
    return 'actionable_research_candidate';
  }
  if (score >= 65 && tradeCount >= 30 && pf >= 1.08 && wr >= 49) {
    return 'promising';
  }
  if (score >= 50) return 'interesting';
  return 'low_confidence';
}

function computePracticalityScore(candidate = {}, sessionWindowCount = 0) {
  const metrics = candidate.metrics || {};
  const tradeCount = toNumber(metrics.totalTrades, 0);
  const winRate = toNumber(metrics.winRate, 0);
  const pf = toNumber(metrics.profitFactor, 0);
  const drawdownProxy = toNumber(candidate.drawdownProxy, 0);
  const robustness = toNumber(candidate.robustnessScore, 0);
  const tradeFreq = sessionWindowCount > 0 ? (tradeCount / sessionWindowCount) * 100 : 0;

  const pfScore = clamp((pf - 1) * 55, 0, 100);
  const wrScore = clamp((winRate - 40) * 2, 0, 100);
  const sampleScore = clamp((tradeCount / 80) * 100, 0, 100);
  const freqDistance = Math.abs(tradeFreq - 35);
  const freqScore = clamp(100 - (freqDistance * 2.1), 20, 100);
  const drawdownPenalty = clamp((drawdownProxy / 1800) * 25, 0, 25);
  const fragilityPenalty = clamp((100 - robustness) / 10, 0, 10);

  const score = (pfScore * 0.35)
    + (wrScore * 0.25)
    + (sampleScore * 0.2)
    + (freqScore * 0.12)
    + (robustness * 0.08)
    - drawdownPenalty
    - fragilityPenalty;
  return round2(clamp(score, 0, 100));
}

function normalizeCandidate(candidate = {}, baselineMetrics = {}, sessionWindowCount = 0) {
  const rules = candidate?.rules || {};
  const meta = familyMetaFromRules(rules);
  const testMetrics = candidate?.splits?.test || {};
  const overallMetrics = candidate?.splits?.overall || {};
  const counts = candidate?.splits?.counts || {};

  const robustness = buildRobustnessAnalysis(candidate, overallMetrics, sessionWindowCount);
  const tradeCount = toNumber(overallMetrics.totalTrades, 0);
  const winRate = round2(toNumber(testMetrics.winRate, 0));
  const profitFactor = round2(toNumber(testMetrics.profitFactor, 0));
  const expectancy = round2(toNumber(testMetrics.expectancyDollars, 0));
  const drawdownProxy = calcDrawdownProxy(overallMetrics);

  const normalized = {
    strategyKey: toText(candidate.key),
    strategyName: toText(candidate.name),
    family: meta.family,
    familyLabel: meta.familyLabel,
    originType: inferOriginType(candidate),
    entryModel: buildEntryModel(rules),
    exitModel: buildExitModel(rules),
    timeModel: buildTimeModel(rules),
    sampleSize: toNumber(counts.trainSessions, 0) + toNumber(counts.validSessions, 0) + toNumber(counts.testSessions, 0),
    tradeCount,
    winRate,
    profitFactor,
    expectancy,
    drawdownProxy,
    comparisonVsOriginal: buildComparisonVsOriginal(overallMetrics, baselineMetrics, sessionWindowCount),
    qualityWarnings: Array.from(new Set([
      ...toArray(candidate.failureReasons),
      ...toArray(robustness.warnings),
    ])),
    advisoryOnly: true,
    robustnessLabel: classifyRobustnessLabel({
      adjustedScore: robustness.adjustedScore,
      tradeCount,
      profitFactor,
      winRate,
    }),
    robustnessScore: robustness.adjustedScore,
    robustnessPenalty: robustness.penalty,
    status: toText(candidate.status) || 'unknown',
    confidence: toText(candidate.confidence) || 'low',
    metrics: {
      overall: overallMetrics,
      test: testMetrics,
      train: candidate?.splits?.train || {},
      valid: candidate?.splits?.valid || {},
      counts,
    },
    provenance: {
      discoveryRunMode: 'two_stage',
      familySource: toText(rules.family),
      candidateKey: toText(candidate.key),
    },
  };

  normalized.researchScore = computePracticalityScore(normalized, sessionWindowCount);
  return normalized;
}

function selectBest(items = [], comparator) {
  const rows = toArray(items).filter(Boolean);
  if (!rows.length) return null;
  return rows.slice().sort(comparator)[0] || null;
}

function byOverallScore(a, b) {
  if (toNumber(b.researchScore, 0) !== toNumber(a.researchScore, 0)) {
    return toNumber(b.researchScore, 0) - toNumber(a.researchScore, 0);
  }
  if (toNumber(b.profitFactor, 0) !== toNumber(a.profitFactor, 0)) {
    return toNumber(b.profitFactor, 0) - toNumber(a.profitFactor, 0);
  }
  if (toNumber(b.winRate, 0) !== toNumber(a.winRate, 0)) {
    return toNumber(b.winRate, 0) - toNumber(a.winRate, 0);
  }
  return toNumber(b.tradeCount, 0) - toNumber(a.tradeCount, 0);
}

function byWinRate(a, b) {
  if (toNumber(b.winRate, 0) !== toNumber(a.winRate, 0)) {
    return toNumber(b.winRate, 0) - toNumber(a.winRate, 0);
  }
  if (toNumber(b.tradeCount, 0) !== toNumber(a.tradeCount, 0)) {
    return toNumber(b.tradeCount, 0) - toNumber(a.tradeCount, 0);
  }
  return toNumber(b.profitFactor, 0) - toNumber(a.profitFactor, 0);
}

function byProfitFactor(a, b) {
  if (toNumber(b.profitFactor, 0) !== toNumber(a.profitFactor, 0)) {
    return toNumber(b.profitFactor, 0) - toNumber(a.profitFactor, 0);
  }
  if (toNumber(b.winRate, 0) !== toNumber(a.winRate, 0)) {
    return toNumber(b.winRate, 0) - toNumber(a.winRate, 0);
  }
  return toNumber(b.tradeCount, 0) - toNumber(a.tradeCount, 0);
}

function byPracticality(a, b) {
  if (toNumber(b.researchScore, 0) !== toNumber(a.researchScore, 0)) {
    return toNumber(b.researchScore, 0) - toNumber(a.researchScore, 0);
  }
  if (toNumber(b.tradeCount, 0) !== toNumber(a.tradeCount, 0)) {
    return toNumber(b.tradeCount, 0) - toNumber(a.tradeCount, 0);
  }
  return toNumber(b.robustnessScore, 0) - toNumber(a.robustnessScore, 0);
}

function buildPromotionDecision(bestCandidate = null, dataQuality = {}) {
  if (!bestCandidate) {
    return {
      candidatePromotionDecision: 'research_only',
      promotionReason: 'No candidate passed the current bounded discovery quality checks.',
    };
  }

  const thin = dataQuality?.isThinSample === true;
  if (!thin && bestCandidate.robustnessLabel === 'actionable_research_candidate' && toNumber(bestCandidate.tradeCount, 0) >= 45) {
    return {
      candidatePromotionDecision: 'strong_candidate_for_side_by_side_tracking',
      promotionReason: `${bestCandidate.strategyName} shows robust out-of-sample profile versus baseline and is suitable for side-by-side tracking.`,
    };
  }
  if (bestCandidate.robustnessLabel === 'promising' || bestCandidate.robustnessLabel === 'actionable_research_candidate') {
    return {
      candidatePromotionDecision: 'worth_monitoring',
      promotionReason: `${bestCandidate.strategyName} is promising but remains advisory pending stronger robustness evidence.`,
    };
  }
  return {
    candidatePromotionDecision: 'research_only',
    promotionReason: `${bestCandidate.strategyName} is interesting but still low-confidence for promotion decisions.`,
  };
}

function summarizeCandidate(candidate = null) {
  if (!candidate) return null;
  return {
    strategyKey: candidate.strategyKey,
    strategyName: candidate.strategyName,
    family: candidate.family,
    robustnessLabel: candidate.robustnessLabel,
    researchScore: candidate.researchScore,
    tradeCount: candidate.tradeCount,
    winRate: candidate.winRate,
    profitFactor: candidate.profitFactor,
    comparisonVsOriginal: candidate.comparisonVsOriginal,
    advisoryOnly: true,
  };
}

function buildDataQuality(candidates = [], discoveryMeta = {}, windowSessions = 0) {
  const warnings = [];
  if (windowSessions < 120) warnings.push('window_sessions_below_120');
  if (toNumber(discoveryMeta?.summary?.sessions, 0) < 120) warnings.push('discovery_engine_minimum_context_limited');
  if (!candidates.length) warnings.push('no_ranked_candidates_available');

  const top = candidates[0] || null;
  if (top && toNumber(top.tradeCount, 0) < 20) warnings.push('top_candidate_low_trade_count');
  if (top && toNumber(top.robustnessScore, 0) < 60) warnings.push('top_candidate_low_robustness');

  return {
    isThinSample: warnings.some((w) => /window|low_trade|minimum_context/.test(w)),
    warnings,
    validationMode: 'chronological_split_60_20_20_with_robustness_penalties',
    robustnessNotes: [
      'Discovery candidates are penalized for low trade count, instability, narrow-condition dependence, and complexity.',
      'Current pass is advisory research and not a full walk-forward optimizer.',
    ],
  };
}

function buildStrategyDiscoverySummary(input = {}) {
  const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const windowSessions = clampInt(input.windowSessions, MIN_WINDOW_SESSIONS, MAX_WINDOW_SESSIONS, DEFAULT_WINDOW_SESSIONS);
  const candidateLimit = clampInt(input.candidateLimit, MIN_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT, DEFAULT_CANDIDATE_LIMIT);
  const familyFilter = normalizeFamilyFilter(input.family);

  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  const runDiscoveryImpl = typeof deps.runDiscovery === 'function' ? deps.runDiscovery : runDiscovery;
  const runPlanBacktestImpl = typeof deps.runPlanBacktest === 'function' ? deps.runPlanBacktest : runPlanBacktest;

  const windowed = buildWindowedSessions(sessions, windowSessions);
  const baselineReport = runPlanBacktestImpl(windowed.sessions, ORIGINAL_PLAN_SPEC, { includePerDate: false });
  const baselineMetrics = baselineReport?.metrics || {};

  const discoveryResult = runDiscoveryImpl(windowed.sessions, {
    mode: 'two_stage',
    maxCandidates: Math.max(candidateLimit * 2, 12),
    stage1Budget: Math.max(10, Math.min(100, Math.round(candidateLimit * 1.4))),
    seedTopK: Math.max(3, Math.min(20, Math.round(candidateLimit / 2))),
  }) || {};

  const discoveryCandidatesRaw = toArray(discoveryResult.candidates);
  const normalized = discoveryCandidatesRaw
    .map((candidate) => normalizeCandidate(candidate, baselineMetrics, windowed.windowSessions))
    .filter((candidate) => {
      if (!familyFilter) return true;
      return toLower(candidate.family) === familyFilter;
    })
    .sort(byOverallScore)
    .slice(0, candidateLimit);

  const bestCandidateOverall = selectBest(normalized, byOverallScore);
  const bestCandidateByWinRate = selectBest(normalized, byWinRate);
  const bestCandidateByProfitFactor = selectBest(normalized, byProfitFactor);
  const bestCandidatePractical = selectBest(normalized, byPracticality);

  const dataQuality = buildDataQuality(normalized, discoveryResult, windowed.windowSessions);
  const promotion = buildPromotionDecision(bestCandidateOverall, dataQuality);

  const summary = {
    generatedAt: new Date().toISOString(),
    advisoryOnly: true,
    windowSessions,
    candidateLimit,
    familyFilter: familyFilter || null,
    baseline: {
      strategyKey: ORIGINAL_PLAN_SPEC.key,
      strategyName: ORIGINAL_PLAN_SPEC.name,
      sampleSessions: windowed.windowSessions,
      metrics: {
        tradeCount: toNumber(baselineMetrics.totalTrades, 0),
        winRate: round2(toNumber(baselineMetrics.winRate, 0)),
        profitFactor: round2(toNumber(baselineMetrics.profitFactor, 0)),
        expectancy: round2(toNumber(baselineMetrics.expectancyDollars, 0)),
        totalPnlDollars: round2(toNumber(baselineMetrics.totalPnlDollars, 0)),
      },
    },
    discoveryMeta: {
      status: toText(discoveryResult.status || 'unknown') || 'unknown',
      mode: toText(discoveryResult.mode || 'two_stage') || 'two_stage',
      summary: discoveryResult.summary || null,
      methodology: discoveryResult.methodology || null,
      diagnostics: discoveryResult.diagnostics || { topRejections: [], nextResearchActions: [] },
    },
    bestCandidateOverall: summarizeCandidate(bestCandidateOverall),
    bestCandidateByWinRate: summarizeCandidate(bestCandidateByWinRate),
    bestCandidateByProfitFactor: summarizeCandidate(bestCandidateByProfitFactor),
    bestCandidatePractical: summarizeCandidate(bestCandidatePractical),
    candidatePromotionDecision: promotion.candidatePromotionDecision,
    promotionReason: promotion.promotionReason,
    dataQuality,
    candidates: normalized,
  };

  return summary;
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  DEFAULT_CANDIDATE_LIMIT,
  MIN_CANDIDATE_LIMIT,
  MAX_CANDIDATE_LIMIT,
  normalizeFamilyFilter,
  buildStrategyDiscoverySummary,
};
