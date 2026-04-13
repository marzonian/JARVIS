'use strict';

const SUPPORTED_REGIME_LABELS = Object.freeze([
  'trending',
  'ranging',
  'wide_volatile',
  'compressed',
  'mixed',
  'unknown',
]);

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeTrend(value) {
  const raw = toText(value).toLowerCase();
  if (raw === 'trending') return 'trending';
  if (raw === 'ranging') return 'ranging';
  if (raw === 'choppy') return 'choppy';
  if (raw === 'flat') return 'flat';
  return 'unknown';
}

function normalizeVolatility(value) {
  const raw = toText(value).toLowerCase();
  if (raw === 'low' || raw === 'normal' || raw === 'high' || raw === 'extreme') return raw;
  return 'unknown';
}

function normalizeOrbProfile(value) {
  const raw = toText(value).toLowerCase();
  if (raw === 'narrow' || raw === 'normal' || raw === 'wide') return raw;
  return 'unknown';
}

function normalizeFirst15(value) {
  const raw = toText(value).toLowerCase();
  if (!raw) return 'unknown';
  return raw;
}

function normalizeSessionType(value) {
  const raw = toText(value).toLowerCase();
  if (!raw) return 'unknown';
  return raw;
}

function normalizeGap(value) {
  const raw = toText(value).toLowerCase();
  if (!raw) return 'unknown';
  return raw;
}

function deriveSignalScores(signals = {}) {
  const scores = {
    trending: 0,
    ranging: 0,
    wide_volatile: 0,
    compressed: 0,
    mixed: 0,
    unknown: 0,
  };

  const trend = signals.trendProfile;
  const vol = signals.volatilityProfile;
  const orb = signals.orbProfile;
  const sessionRangeTicks = toNumber(signals.sessionRangeTicks, null);
  const orbRangeTicks = toNumber(signals.orbRangeTicks, null);
  const first15 = signals.first15Behavior;
  const sessionType = signals.sessionType;

  if (trend === 'trending') {
    scores.trending += 3;
  } else if (trend === 'ranging' || trend === 'choppy') {
    scores.ranging += 2;
    scores.mixed += 1;
  } else if (trend === 'flat') {
    scores.compressed += 1.5;
    scores.ranging += 1;
  } else {
    scores.unknown += 1;
  }

  if (vol === 'extreme') {
    scores.wide_volatile += 3;
    scores.mixed += 1;
  } else if (vol === 'high') {
    scores.wide_volatile += 2;
    scores.trending += 0.5;
  } else if (vol === 'low') {
    scores.compressed += 2;
    scores.ranging += 1;
  } else if (vol === 'normal') {
    scores.ranging += 0.5;
  } else {
    scores.unknown += 1;
  }

  if (orb === 'wide') {
    scores.wide_volatile += 2;
  } else if (orb === 'narrow') {
    scores.compressed += 2;
    scores.ranging += 0.5;
  } else if (orb === 'normal') {
    scores.trending += 0.5;
    scores.ranging += 0.5;
  } else {
    scores.unknown += 1;
  }

  if (Number.isFinite(sessionRangeTicks)) {
    if (sessionRangeTicks >= 800) {
      scores.wide_volatile += 2;
    } else if (sessionRangeTicks <= 220) {
      scores.compressed += 2;
    } else if (sessionRangeTicks >= 550) {
      scores.wide_volatile += 1;
    }
  }

  if (Number.isFinite(orbRangeTicks)) {
    if (orbRangeTicks >= 240) {
      scores.wide_volatile += 1.5;
    } else if (orbRangeTicks <= 60) {
      scores.compressed += 1.5;
    }
  }

  if (first15 === 'continuation_up' || first15 === 'continuation_down') {
    scores.trending += 1;
  } else if (first15 === 'inside') {
    scores.ranging += 1;
  }

  if (sessionType === 'am_dominant' || sessionType === 'pm_dominant') {
    if (trend === 'trending') scores.trending += 0.5;
    else scores.mixed += 0.5;
  } else if (sessionType === 'balanced') {
    if (trend === 'ranging' || trend === 'choppy') scores.ranging += 0.5;
  }

  return scores;
}

function pickRegimeLabel(signals = {}, scores = {}) {
  const sortable = Object.entries(scores)
    .filter(([label]) => label !== 'mixed' && label !== 'unknown')
    .sort((a, b) => b[1] - a[1]);
  const top = sortable[0] || ['unknown', 0];
  const second = sortable[1] || ['unknown', 0];
  const topLabel = top[0];
  const topScore = Number(top[1] || 0);
  const secondScore = Number(second[1] || 0);

  if (signals.trendProfile === 'unknown' && signals.volatilityProfile === 'unknown' && signals.orbProfile === 'unknown') {
    return {
      regimeLabel: 'unknown',
      topLabel,
      topScore,
      secondScore,
      mixedSignals: true,
      signalAgreement: 'weak',
    };
  }

  let regimeLabel = 'mixed';

  if (
    (topLabel === 'wide_volatile' && topScore >= 4.5)
    || (signals.volatilityProfile === 'extreme' && topScore >= 4)
    || (signals.volatilityProfile === 'high' && (signals.orbProfile === 'wide' || toNumber(signals.sessionRangeTicks, 0) >= 700))
  ) {
    regimeLabel = 'wide_volatile';
  } else if (
    (topLabel === 'compressed' && topScore >= 4.5)
    || (signals.volatilityProfile === 'low' && (signals.orbProfile === 'narrow' || toNumber(signals.sessionRangeTicks, 9999) <= 250))
  ) {
    regimeLabel = 'compressed';
  } else if (topLabel === 'trending' && topScore >= 4 && signals.trendProfile === 'trending') {
    regimeLabel = 'trending';
  } else if (
    topLabel === 'ranging'
    && topScore >= 3.5
    && (signals.trendProfile === 'ranging' || signals.trendProfile === 'choppy' || signals.trendProfile === 'flat')
  ) {
    regimeLabel = 'ranging';
  } else if (topScore < 2.5) {
    regimeLabel = 'unknown';
  } else {
    regimeLabel = 'mixed';
  }

  const scoreGap = topScore - secondScore;
  const mixedSignals = regimeLabel === 'mixed' || scoreGap < 1.1;
  const signalAgreement = regimeLabel === 'unknown'
    ? 'weak'
    : scoreGap >= 2
      ? 'strong'
      : scoreGap >= 1
        ? 'moderate'
        : 'weak';

  return {
    regimeLabel,
    topLabel,
    topScore,
    secondScore,
    mixedSignals,
    signalAgreement,
  };
}

function buildConfidence(selection = {}, signals = {}) {
  const label = selection.regimeLabel;
  const topScore = Number(selection.topScore || 0);
  const gap = Number(selection.topScore || 0) - Number(selection.secondScore || 0);

  if (label === 'unknown') {
    return {
      confidenceScore: 25,
      confidenceLabel: 'low',
    };
  }

  let score = 38;
  score += clamp(topScore * 5, 0, 32);
  score += clamp(gap * 10, 0, 18);

  const alignments = [
    label === 'trending' && signals.trendProfile === 'trending',
    label === 'ranging' && (signals.trendProfile === 'ranging' || signals.trendProfile === 'choppy' || signals.trendProfile === 'flat'),
    label === 'wide_volatile' && (signals.volatilityProfile === 'high' || signals.volatilityProfile === 'extreme'),
    label === 'compressed' && signals.volatilityProfile === 'low',
  ].filter(Boolean).length;
  score += alignments * 4;

  if (selection.mixedSignals) score -= 10;

  score = clamp(round2(score), 15, 95);
  const confidenceLabel = score >= 72 ? 'high' : score >= 50 ? 'medium' : 'low';
  return {
    confidenceScore: score,
    confidenceLabel,
  };
}

function buildRegimeReason(selection = {}, signals = {}) {
  const label = selection.regimeLabel;
  const trend = signals.trendProfile;
  const vol = signals.volatilityProfile;
  const orb = signals.orbProfile;

  if (label === 'wide_volatile') {
    return `Range expansion is elevated (${vol} volatility, ${orb} ORB profile), so conditions are wide and volatile.`;
  }
  if (label === 'compressed') {
    return `Range is compressed (${vol} volatility with ${orb} ORB profile), so directional follow-through is likely limited.`;
  }
  if (label === 'trending') {
    return `Directional persistence is strongest (${trend} profile) with enough expansion to support trend continuation.`;
  }
  if (label === 'ranging') {
    return `Price behavior is mostly rotational (${trend} profile) with limited directional dominance.`;
  }
  if (label === 'mixed') {
    return `Trend, volatility, and ORB signals disagree, so the regime is mixed and should be treated cautiously.`;
  }
  return 'Regime evidence is insufficient right now, so Jarvis cannot classify this session with confidence.';
}

function pickLatestDate(regimeByDate = {}, sessions = {}, latestDateHint = '') {
  const hint = toText(latestDateHint);
  if (hint && regimeByDate[hint]) return hint;
  const keys = Object.keys(regimeByDate).sort();
  if (keys.length > 0) return keys[keys.length - 1];
  const sessionDates = Object.keys(sessions || {}).sort();
  return sessionDates.length > 0 ? sessionDates[sessionDates.length - 1] : '';
}

function buildEvidenceSignals(row = {}, options = {}) {
  const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  return {
    sourceDate: toText(options.sourceDate || null) || null,
    sessionPhase: toText(options.sessionPhase || null) || null,
    trendProfile: normalizeTrend(row?.regime_trend),
    volatilityProfile: normalizeVolatility(row?.regime_vol),
    orbProfile: normalizeOrbProfile(row?.regime_orb_size),
    sessionRangeTicks: toNumber(metrics.session_range_ticks, null),
    orbRangeTicks: toNumber(metrics.orb_range_ticks, null),
    first15Behavior: normalizeFirst15(row?.first_15min),
    sessionType: normalizeSessionType(row?.session_type),
    gapProfile: normalizeGap(row?.regime_gap),
  };
}

function buildUnknownRegime(options = {}) {
  const sessionPhase = toText(options.sessionPhase || null) || null;
  return {
    regimeLabel: 'unknown',
    confidenceLabel: 'low',
    confidenceScore: 20,
    regimeReason: 'Regime data is unavailable for the current session context.',
    evidenceSignals: {
      sourceDate: toText(options.sourceDate || null) || null,
      sessionPhase,
      trendProfile: 'unknown',
      volatilityProfile: 'unknown',
      orbProfile: 'unknown',
      sessionRangeTicks: null,
      orbRangeTicks: null,
      first15Behavior: 'unknown',
      sessionType: 'unknown',
      gapProfile: 'unknown',
      signalAgreement: 'weak',
      conflictingSignals: true,
    },
    advisoryOnly: true,
  };
}

function sanitizeRegimeDetection(regimeDetection = {}, options = {}) {
  const includeEvidence = options.includeEvidence !== false;
  if (!regimeDetection || typeof regimeDetection !== 'object') return null;
  const label = SUPPORTED_REGIME_LABELS.includes(regimeDetection.regimeLabel)
    ? regimeDetection.regimeLabel
    : 'unknown';
  const confidenceLabelRaw = toText(regimeDetection.confidenceLabel).toLowerCase();
  const confidenceLabel = confidenceLabelRaw === 'high' || confidenceLabelRaw === 'medium'
    ? confidenceLabelRaw
    : 'low';
  return {
    regimeLabel: label,
    confidenceLabel,
    confidenceScore: clamp(toNumber(regimeDetection.confidenceScore, 20), 0, 100),
    regimeReason: toText(regimeDetection.regimeReason || 'Regime evidence is unavailable.'),
    evidenceSignals: includeEvidence
      ? (regimeDetection.evidenceSignals && typeof regimeDetection.evidenceSignals === 'object'
        ? regimeDetection.evidenceSignals
        : null)
      : null,
    advisoryOnly: true,
  };
}

function buildRegimeDetection(input = {}) {
  const regimeByDate = input.regimeByDate && typeof input.regimeByDate === 'object'
    ? input.regimeByDate
    : {};
  const sessions = input.sessions && typeof input.sessions === 'object'
    ? input.sessions
    : {};
  const latestDate = pickLatestDate(regimeByDate, sessions, input.latestDate || '');
  const row = latestDate ? regimeByDate[latestDate] : null;
  const sessionPhase = toText(input.sessionPhase || null) || null;

  if (!row || typeof row !== 'object') {
    return sanitizeRegimeDetection(buildUnknownRegime({ sourceDate: latestDate || null, sessionPhase }), {
      includeEvidence: input.includeEvidence !== false,
    });
  }

  const signals = buildEvidenceSignals(row, {
    sourceDate: latestDate,
    sessionPhase,
  });
  const scores = deriveSignalScores(signals);
  const selection = pickRegimeLabel(signals, scores);
  const confidence = buildConfidence(selection, signals);

  const regimeDetection = {
    regimeLabel: selection.regimeLabel,
    confidenceLabel: confidence.confidenceLabel,
    confidenceScore: confidence.confidenceScore,
    regimeReason: buildRegimeReason(selection, signals),
    evidenceSignals: {
      ...signals,
      signalAgreement: selection.signalAgreement,
      conflictingSignals: selection.mixedSignals,
    },
    advisoryOnly: true,
  };

  return sanitizeRegimeDetection(regimeDetection, {
    includeEvidence: input.includeEvidence !== false,
  });
}

module.exports = {
  SUPPORTED_REGIME_LABELS,
  buildRegimeDetection,
  sanitizeRegimeDetection,
};
