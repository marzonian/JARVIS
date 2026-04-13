#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  ensureRegimeConfirmationHistoryTables,
  appendRegimeConfirmationHistorySnapshot,
  buildRegimeConfirmationHistorySummary,
} = require('../server/jarvis-core/regime-confirmation-history');
const {
  buildRegimeConfirmationDurabilitySummary,
} = require('../server/jarvis-core/regime-confirmation-durability');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');
const {
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 120000;
const ALLOWED_PROMOTION_STATES = [
  'no_live_support',
  'emerging_live_support',
  'near_live_confirmation',
  'live_confirmed',
  'stalled_live_support',
];
const ALLOWED_PERSISTENCE_SOURCES = [
  'persisted_live_history',
  'persisted_reconstructed_history',
  'mixed_persisted_history',
  'proxy_only',
];

function makeLiveRow(regimeLabel, opts = {}) {
  return {
    regimeLabel,
    liveSampleSize: Number(opts.liveSampleSize || 0),
    liveUsefulnessLabel: opts.liveUsefulnessLabel || 'insufficient',
    liveUsefulnessScore: Number.isFinite(Number(opts.liveUsefulnessScore)) ? Number(opts.liveUsefulnessScore) : null,
    liveConfidenceAdjustment: Number.isFinite(Number(opts.liveConfidenceAdjustment)) ? Number(opts.liveConfidenceAdjustment) : 0,
    promotionState: opts.promotionState || 'no_live_support',
    promotionReason: opts.promotionReason || `${regimeLabel} ${opts.promotionState || 'no_live_support'}`,
    requiredSampleForPromotion: Number(opts.requiredSampleForPromotion || ((regimeLabel === 'mixed' || regimeLabel === 'unknown') ? 30 : 15)),
    progressPct: Number.isFinite(Number(opts.progressPct)) ? Number(opts.progressPct) : 0,
    evidenceFreshnessLabel: opts.evidenceFreshnessLabel || 'recent_but_thin',
    warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
    advisoryOnly: true,
  };
}

function makeAllRow(regimeLabel, liveRow = {}) {
  const live = Math.max(0, Number(liveRow.liveSampleSize || 0));
  const allScore = Number.isFinite(Number(liveRow.liveUsefulnessScore)) ? Number(liveRow.liveUsefulnessScore) : null;
  const allLabel = String(liveRow.liveUsefulnessLabel || 'insufficient');
  return {
    regimeLabel,
    usefulnessScore: allScore,
    usefulnessLabel: allLabel,
    confidenceAdjustment: Number.isFinite(Number(liveRow.liveConfidenceAdjustment)) ? Number(liveRow.liveConfidenceAdjustment) : 0,
    directProvenanceSampleSize: live,
    upstreamCoverageSampleSize: live,
    coverageType: live > 0 ? 'mixed_support' : 'no_support',
    provenanceStrengthLabel: live > 0 ? 'direct' : 'absent',
    evidenceSourceBreakdown: { live, backfill: 0, total: live },
    warnings: [],
    advisoryOnly: true,
  };
}

function makeLiveSplitRow(regimeLabel, liveRow = {}) {
  const live = Math.max(0, Number(liveRow.liveSampleSize || 0));
  return {
    regimeLabel,
    usefulnessScore: Number.isFinite(Number(liveRow.liveUsefulnessScore)) ? Number(liveRow.liveUsefulnessScore) : null,
    usefulnessLabel: String(liveRow.liveUsefulnessLabel || 'insufficient'),
    confidenceAdjustment: Number.isFinite(Number(liveRow.liveConfidenceAdjustment)) ? Number(liveRow.liveConfidenceAdjustment) : 0,
    liveDirectSampleSize: live,
    coverageType: live > 0 ? 'direct_provenance' : 'no_support',
    provenanceStrengthLabel: live >= 10 ? 'direct' : (live > 0 ? 'thin_live' : 'absent'),
    evidenceSourceBreakdown: { live, backfill: 0, total: live },
    warnings: [],
    advisoryOnly: true,
  };
}

function defaultRegimeState(regimeLabel) {
  return makeLiveRow(regimeLabel, {
    promotionState: 'no_live_support',
    liveUsefulnessLabel: 'insufficient',
    liveSampleSize: 0,
    liveUsefulnessScore: null,
    progressPct: 0,
    evidenceFreshnessLabel: 'stale_or_sparse',
  });
}

function buildSnapshot(date, currentRegimeLabel, regimeStateByLabel = {}) {
  const rows = SUPPORTED_REGIME_LABELS.map((regimeLabel) => {
    const cfg = regimeStateByLabel[regimeLabel] || {};
    return makeLiveRow(regimeLabel, cfg);
  });
  const byRegime = new Map(rows.map((row) => [row.regimeLabel, row]));
  const currentRow = byRegime.get(currentRegimeLabel) || defaultRegimeState(currentRegimeLabel);
  const weakCurrent = String(currentRow.promotionState || '') === 'no_live_support' || Number(currentRow.liveSampleSize || 0) < 5;

  const allEvidenceByRegime = rows.map((row) => makeAllRow(row.regimeLabel, row));
  const liveOnlyByRegime = rows.map((row) => makeLiveSplitRow(row.regimeLabel, row));

  return {
    date,
    liveRegimeConfirmation: {
      generatedAt: `${date}T14:45:00.000Z`,
      currentRegimeLabel,
      currentRegimePromotionState: currentRow.promotionState,
      currentRegimePromotionReason: currentRow.promotionReason,
      currentRegimeLiveSampleSize: Number(currentRow.liveSampleSize || 0),
      currentRegimeRequiredSampleForPromotion: Number(currentRow.requiredSampleForPromotion || 15),
      currentRegimeConfirmationProgressPct: Number(currentRow.progressPct || 0),
      liveConfirmationByRegime: rows,
      liveConfirmedRegimeLabels: rows.filter((row) => row.promotionState === 'live_confirmed').map((row) => row.regimeLabel),
      emergingLiveSupportRegimeLabels: rows.filter((row) => row.promotionState === 'emerging_live_support').map((row) => row.regimeLabel),
      stalledRegimeLabels: rows.filter((row) => row.promotionState === 'stalled_live_support').map((row) => row.regimeLabel),
      liveConfirmationInsight: `Snapshot ${date}`,
      advisoryOnly: true,
    },
    regimeTrustConsumption: {
      generatedAt: `${date}T14:45:01.000Z`,
      currentRegimeLabel,
      trustBiasLabel: weakCurrent ? 'insufficient_live_confirmation' : 'mixed_support',
      trustBiasReason: weakCurrent ? 'Current live sample is weak.' : 'Current regime has moderate live support.',
      trustConsumptionLabel: weakCurrent ? 'suppress_regime_bias' : 'allow_with_caution',
      trustConsumptionReason: weakCurrent ? 'Suppress regime bias due to insufficient live support.' : 'Allow with caution under moderate live support.',
      confidenceAdjustmentOverride: weakCurrent ? -8 : 0,
      currentRegimeTrustSnapshot: {
        regimeLabel: currentRegimeLabel,
        trustBiasLabel: weakCurrent ? 'insufficient_live_confirmation' : 'mixed_support',
        trustConsumptionLabel: weakCurrent ? 'suppress_regime_bias' : 'allow_with_caution',
        liveOnlyUsefulnessLabel: currentRow.liveUsefulnessLabel,
        allEvidenceUsefulnessLabel: currentRow.liveUsefulnessLabel,
        liveDirectSampleSize: Number(currentRow.liveSampleSize || 0),
        allEvidenceDirectSampleSize: Number(currentRow.liveSampleSize || 0),
        scoreGap: 0,
        provenanceStrengthLabel: Number(currentRow.liveSampleSize || 0) > 0 ? 'direct' : 'absent',
        evidenceQuality: Number(currentRow.liveSampleSize || 0) >= 10 ? 'strong_live' : 'thin',
        advisoryOnly: true,
      },
      advisoryOnly: true,
    },
    regimeEvidenceSplit: {
      generatedAt: `${date}T14:45:02.000Z`,
      currentRegimeLabel,
      allEvidenceByRegime,
      liveOnlyByRegime,
      currentRegimeComparison: {
        regimeLabel: currentRegimeLabel,
        allEvidenceUsefulnessScore: Number.isFinite(Number(currentRow.liveUsefulnessScore)) ? Number(currentRow.liveUsefulnessScore) : null,
        allEvidenceUsefulnessLabel: currentRow.liveUsefulnessLabel,
        liveOnlyUsefulnessScore: Number.isFinite(Number(currentRow.liveUsefulnessScore)) ? Number(currentRow.liveUsefulnessScore) : null,
        liveOnlyUsefulnessLabel: currentRow.liveUsefulnessLabel,
        scoreGap: 0,
        liveDirectSampleSize: Number(currentRow.liveSampleSize || 0),
        allEvidenceDirectSampleSize: Number(currentRow.liveSampleSize || 0),
        trustBiasLabel: weakCurrent ? 'insufficient_live_confirmation' : 'mixed_support',
        trustBiasReason: weakCurrent ? 'Live support is weak.' : 'Live support is moderate.',
      },
      trustBiasLabel: weakCurrent ? 'insufficient_live_confirmation' : 'mixed_support',
      trustBiasReason: weakCurrent ? 'Live support is weak.' : 'Live support is moderate.',
      advisoryOnly: true,
    },
    regimePerformanceFeedback: {
      regimeConfidenceGuidance: {
        regimeLabel: currentRegimeLabel,
        evidenceQuality: Number(currentRow.liveSampleSize || 0) >= 10 ? 'strong_live' : 'thin',
        evidenceSourceBreakdown: {
          live: Number(currentRow.liveSampleSize || 0),
          backfill: 0,
          total: Number(currentRow.liveSampleSize || 0),
        },
      },
      advisoryOnly: true,
    },
  };
}

function runUnitChecks() {
  const db = new Database(':memory:');
  ensureRegimeConfirmationHistoryTables(db);
  ensureRegimeConfirmationHistoryTables(db);

  const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jarvis_regime_confirmation_history'").get();
  assert(tableRow && tableRow.name === 'jarvis_regime_confirmation_history', 'history table should exist after bootstrap');

  const day1 = buildSnapshot('2026-03-01', 'trending', {
    trending: {
      promotionState: 'near_live_confirmation',
      promotionReason: 'trending day-1 near confirmation',
      liveSampleSize: 12,
      liveUsefulnessLabel: 'moderate',
      liveUsefulnessScore: 60,
      progressPct: 56,
      evidenceFreshnessLabel: 'fresh',
    },
    wide_volatile: {
      promotionState: 'live_confirmed',
      promotionReason: 'wide_volatile stable confirmation',
      liveSampleSize: 18,
      liveUsefulnessLabel: 'strong',
      liveUsefulnessScore: 73,
      progressPct: 82,
      evidenceFreshnessLabel: 'fresh',
    },
  });

  const first = appendRegimeConfirmationHistorySnapshot({
    db,
    snapshotDate: day1.date,
    snapshotGeneratedAt: day1.liveRegimeConfirmation.generatedAt,
    windowSessions: 120,
    performanceSource: 'all',
    liveRegimeConfirmation: day1.liveRegimeConfirmation,
    regimeTrustConsumption: day1.regimeTrustConsumption,
    regimeEvidenceSplit: day1.regimeEvidenceSplit,
    regimePerformanceFeedback: day1.regimePerformanceFeedback,
  });
  assert(Number(first.inserted || 0) === SUPPORTED_REGIME_LABELS.length, 'first append should insert one row per regime');
  assert(Number(first.updated || 0) === 0, 'first append should not update existing rows');

  const second = appendRegimeConfirmationHistorySnapshot({
    db,
    snapshotDate: day1.date,
    snapshotGeneratedAt: day1.liveRegimeConfirmation.generatedAt,
    windowSessions: 120,
    performanceSource: 'all',
    liveRegimeConfirmation: day1.liveRegimeConfirmation,
    regimeTrustConsumption: day1.regimeTrustConsumption,
    regimeEvidenceSplit: day1.regimeEvidenceSplit,
    regimePerformanceFeedback: day1.regimePerformanceFeedback,
  });
  assert(Number(second.inserted || 0) === 0, 'idempotent append should not insert duplicates');
  assert(Number(second.updated || 0) === SUPPORTED_REGIME_LABELS.length, 'idempotent append should update existing rows');

  const day1Count = db.prepare('SELECT COUNT(*) AS c FROM jarvis_regime_confirmation_history WHERE snapshot_date = ?').get(day1.date)?.c || 0;
  assert(Number(day1Count) === SUPPORTED_REGIME_LABELS.length, 'idempotent append should keep one row per regime/date');

  const dailyStates = [
    {
      date: '2026-03-02',
      currentRegime: 'trending',
      states: {
        trending: {
          promotionState: 'live_confirmed',
          promotionReason: 'trending day-2 confirmed',
          liveSampleSize: 16,
          liveUsefulnessLabel: 'moderate',
          liveUsefulnessScore: 64,
          progressPct: 74,
          evidenceFreshnessLabel: 'fresh',
        },
        wide_volatile: {
          promotionState: 'live_confirmed',
          promotionReason: 'wide_volatile stable confirmation',
          liveSampleSize: 19,
          liveUsefulnessLabel: 'strong',
          liveUsefulnessScore: 74,
          progressPct: 84,
          evidenceFreshnessLabel: 'fresh',
        },
      },
    },
    {
      date: '2026-03-03',
      currentRegime: 'trending',
      states: {
        trending: {
          promotionState: 'no_live_support',
          promotionReason: 'trending day-3 fell to no support',
          liveSampleSize: 0,
          liveUsefulnessLabel: 'insufficient',
          liveUsefulnessScore: null,
          progressPct: 0,
          evidenceFreshnessLabel: 'stale_or_sparse',
        },
        wide_volatile: {
          promotionState: 'live_confirmed',
          promotionReason: 'wide_volatile stable confirmation',
          liveSampleSize: 20,
          liveUsefulnessLabel: 'strong',
          liveUsefulnessScore: 75,
          progressPct: 86,
          evidenceFreshnessLabel: 'fresh',
        },
      },
    },
    {
      date: '2026-03-04',
      currentRegime: 'trending',
      states: {
        trending: {
          promotionState: 'emerging_live_support',
          promotionReason: 'trending day-4 recovering support',
          liveSampleSize: 8,
          liveUsefulnessLabel: 'noisy',
          liveUsefulnessScore: 53,
          progressPct: 36,
          evidenceFreshnessLabel: 'recent_but_thin',
        },
        wide_volatile: {
          promotionState: 'live_confirmed',
          promotionReason: 'wide_volatile stable confirmation',
          liveSampleSize: 21,
          liveUsefulnessLabel: 'strong',
          liveUsefulnessScore: 76,
          progressPct: 88,
          evidenceFreshnessLabel: 'fresh',
        },
      },
    },
    {
      date: '2026-03-05',
      currentRegime: 'trending',
      states: {
        trending: {
          promotionState: 'near_live_confirmation',
          promotionReason: 'trending day-5 rebuilding toward confirmation',
          liveSampleSize: 11,
          liveUsefulnessLabel: 'moderate',
          liveUsefulnessScore: 62,
          progressPct: 61,
          evidenceFreshnessLabel: 'fresh',
        },
        wide_volatile: {
          promotionState: 'live_confirmed',
          promotionReason: 'wide_volatile stable confirmation',
          liveSampleSize: 22,
          liveUsefulnessLabel: 'strong',
          liveUsefulnessScore: 77,
          progressPct: 90,
          evidenceFreshnessLabel: 'fresh',
        },
      },
    },
  ];

  for (const day of dailyStates) {
    const snapshot = buildSnapshot(day.date, day.currentRegime, day.states);
    const out = appendRegimeConfirmationHistorySnapshot({
      db,
      snapshotDate: snapshot.date,
      snapshotGeneratedAt: snapshot.liveRegimeConfirmation.generatedAt,
      windowSessions: 120,
      performanceSource: 'all',
      liveRegimeConfirmation: snapshot.liveRegimeConfirmation,
      regimeTrustConsumption: snapshot.regimeTrustConsumption,
      regimeEvidenceSplit: snapshot.regimeEvidenceSplit,
      regimePerformanceFeedback: snapshot.regimePerformanceFeedback,
    });
    assert(Number(out.inserted || 0) === SUPPORTED_REGIME_LABELS.length, `expected full insert on ${day.date}`);
  }

  const totalRows = db.prepare('SELECT COUNT(*) AS c FROM jarvis_regime_confirmation_history').get()?.c || 0;
  assert(Number(totalRows) === (5 * SUPPORTED_REGIME_LABELS.length), 'expected five historical snapshots with canonical regime rows');

  const history = buildRegimeConfirmationHistorySummary({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    currentRegimeLabel: 'trending',
  });

  assert(history && typeof history === 'object', 'history summary missing');
  assert(history.advisoryOnly === true, 'history summary must be advisoryOnly');
  assert(Array.isArray(history.byRegime), 'history.byRegime missing');
  assert(Number(history.historyCoverageDays || 0) >= 5, 'history coverage should include persisted window');
  assert(Number(history.currentRegimeConsecutiveQualifiedWindows || 0) >= 2, 'current regime qualified streak should reflect persisted data');
  assert(Number(history.currentRegimeConsecutiveWeakWindows || 0) === 0, 'current regime weak streak should be reset after recovery');
  assert(Number(history.currentRegimeRecoveryCount || 0) >= 1, 'current regime recoveryCount should increase on weak->qualified transition');
  assert(typeof history.currentRegimeHasLiveCapturedHistory === 'boolean', 'currentRegimeHasLiveCapturedHistory missing');
  assert(Number.isFinite(Number(history.currentRegimeLiveCapturedTenureDays)), 'currentRegimeLiveCapturedTenureDays missing');
  assert(history.currentRegimeLastLiveCapturedDate === null || typeof history.currentRegimeLastLiveCapturedDate === 'string', 'currentRegimeLastLiveCapturedDate missing');

  const byLabel = new Map(history.byRegime.map((row) => [String(row.regimeLabel), row]));
  for (const [label, row] of byLabel.entries()) {
    assert(SUPPORTED_REGIME_LABELS.includes(label), `non-canonical regime in summary: ${label}`);
    assert(row.advisoryOnly === true, `byRegime row ${label} must be advisoryOnly`);
    assert(ALLOWED_PROMOTION_STATES.includes(String(row.latestPromotionState || '')), `invalid latestPromotionState for ${label}`);
    assert(typeof row.hasLiveCapturedHistory === 'boolean', `hasLiveCapturedHistory missing for ${label}`);
    assert(Number.isFinite(Number(row.liveCapturedTenureDays || 0)), `liveCapturedTenureDays missing for ${label}`);
  }

  const trendingRow = byLabel.get('trending');
  assert(trendingRow, 'trending row missing');
  assert(Number(trendingRow.consecutiveQualifiedWindows || 0) >= 2, 'trending qualified streak should persist from real snapshots');
  assert(Number(trendingRow.recoveryCount || 0) >= 1, 'trending recoveryCount should increment after weak -> qualified transition');
  assert(Number(trendingRow.decayCount || 0) >= 1, 'trending decayCount should increment after qualified -> weak transition');

  const rangingRow = byLabel.get('ranging');
  assert(rangingRow, 'ranging row missing');
  assert(Number(rangingRow.consecutiveWeakWindows || 0) >= 5, 'ranging weak streak should grow on repeated weak snapshots');

  const wideRow = byLabel.get('wide_volatile');
  assert(wideRow, 'wide_volatile row missing');
  assert(Number(wideRow.liveConfirmedTenureDays || 0) >= 5, 'liveConfirmedTenureDays should grow only under sustained live_confirmed state');

  const latestSnapshot = buildSnapshot('2026-03-05', 'trending', dailyStates[dailyStates.length - 1].states);
  const durabilityWithHistory = buildRegimeConfirmationDurabilitySummary({
    windowSessions: 120,
    liveRegimeConfirmation: latestSnapshot.liveRegimeConfirmation,
    regimeTrustConsumption: latestSnapshot.regimeTrustConsumption,
    regimeEvidenceSplit: latestSnapshot.regimeEvidenceSplit,
    regimePerformanceFeedback: latestSnapshot.regimePerformanceFeedback,
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 50, backfill: 0, total: 50 },
    },
    regimeConfirmationHistory: history,
  });

  assert(String(durabilityWithHistory.persistenceSource || '') === 'persisted_live_history', 'durability should consume persisted live history when available');
  assert(Number(durabilityWithHistory.historyCoverageDays || 0) >= 5, 'durability historyCoverageDays should inherit ledger coverage');
  assert(durabilityWithHistory.historyProvenanceBreakdown && typeof durabilityWithHistory.historyProvenanceBreakdown === 'object', 'durability historyProvenanceBreakdown missing');
  assert(typeof durabilityWithHistory.currentRegimeHasLiveCapturedHistory === 'boolean', 'durability currentRegimeHasLiveCapturedHistory missing');
  assert(Number.isFinite(Number(durabilityWithHistory.currentRegimeLiveCapturedTenureDays)), 'durability currentRegimeLiveCapturedTenureDays missing');
  const durabilityTrending = (durabilityWithHistory.durabilityByRegime || []).find((row) => String(row.regimeLabel) === 'trending');
  assert(durabilityTrending, 'durability trending row missing');
  assert(Number(durabilityTrending.consecutiveQualifiedWindows || 0) >= Number(trendingRow.consecutiveQualifiedWindows || 0), 'durability should reflect persisted qualified streaks');

  const durabilityProxyOnly = buildRegimeConfirmationDurabilitySummary({
    windowSessions: 120,
    liveRegimeConfirmation: latestSnapshot.liveRegimeConfirmation,
    regimeTrustConsumption: latestSnapshot.regimeTrustConsumption,
    regimeEvidenceSplit: latestSnapshot.regimeEvidenceSplit,
    regimePerformanceFeedback: latestSnapshot.regimePerformanceFeedback,
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 5, backfill: 0, total: 5 },
    },
  });
  assert(String(durabilityProxyOnly.persistenceSource || '') === 'proxy_only', 'durability should fallback to proxy_only when no persisted history is provided');
  assert(Array.isArray(durabilityProxyOnly.historyWarnings), 'durability historyWarnings missing for proxy fallback');

  db.close();
}

async function getJson(baseUrl, endpoint) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3194,
  });

  try {
    const historyOut = await getJson(server.baseUrl, '/api/jarvis/regime/history?windowSessions=120&performanceSource=all&force=1');
    assert(historyOut?.status === 'ok', 'regime/history should return ok');
    const history = historyOut?.regimeConfirmationHistory;
    assert(history && typeof history === 'object', 'regimeConfirmationHistory payload missing');
    assert(history.advisoryOnly === true, 'regimeConfirmationHistory must be advisoryOnly');
    assert(SUPPORTED_REGIME_LABELS.includes(String(history.currentRegimeLabel || '')), 'history currentRegimeLabel must be canonical');
    assert(Number.isFinite(Number(history.historyCoverageDays)), 'historyCoverageDays missing');
    assert(Number.isFinite(Number(history.currentRegimeTenureDays)), 'currentRegimeTenureDays missing');
    assert(Number.isFinite(Number(history.currentRegimeConsecutiveQualifiedWindows)), 'currentRegimeConsecutiveQualifiedWindows missing');
    assert(Number.isFinite(Number(history.currentRegimeConsecutiveWeakWindows)), 'currentRegimeConsecutiveWeakWindows missing');
    assert(Number.isFinite(Number(history.currentRegimeRecoveryCount)), 'currentRegimeRecoveryCount missing');
    assert(typeof history.currentRegimeHasLiveCapturedHistory === 'boolean', 'currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(history.currentRegimeLiveCapturedTenureDays)), 'currentRegimeLiveCapturedTenureDays missing');
    assert(history.currentRegimeLastLiveCapturedDate === null || typeof history.currentRegimeLastLiveCapturedDate === 'string', 'currentRegimeLastLiveCapturedDate missing');
    assert(Array.isArray(history.byRegime), 'history.byRegime missing');

    const durabilityOut = await getJson(server.baseUrl, '/api/jarvis/regime/durability?windowSessions=120&performanceSource=all&force=1');
    assert(durabilityOut?.status === 'ok', 'regime/durability should return ok');
    const durability = durabilityOut?.regimeConfirmationDurability;
    assert(durability && typeof durability === 'object', 'regimeConfirmationDurability missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(durability.persistenceSource || '')), 'durability.persistenceSource missing or invalid');
    assert(Number.isFinite(Number(durability.historyCoverageDays)), 'durability.historyCoverageDays missing');
    assert(durability.historyProvenanceBreakdown && typeof durability.historyProvenanceBreakdown === 'object', 'durability.historyProvenanceBreakdown missing');
    assert(Array.isArray(durability.historyWarnings), 'durability.historyWarnings missing');
    assert(typeof durability.currentRegimeHasLiveCapturedHistory === 'boolean', 'durability.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(durability.currentRegimeLiveCapturedTenureDays)), 'durability.currentRegimeLiveCapturedTenureDays missing');

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command-center should return ok');
    assert(centerOut?.regimeConfirmationHistory && typeof centerOut.regimeConfirmationHistory === 'object', 'top-level regimeConfirmationHistory missing from command-center response');
    const cc = centerOut?.commandCenter || {};
    assert(Number.isFinite(Number(cc.currentRegimeTenureDays)), 'commandCenter.currentRegimeTenureDays missing');
    assert(Number.isFinite(Number(cc.currentRegimeConsecutiveQualifiedWindows)), 'commandCenter.currentRegimeConsecutiveQualifiedWindows missing');
    assert(Number.isFinite(Number(cc.currentRegimeConsecutiveWeakWindows)), 'commandCenter.currentRegimeConsecutiveWeakWindows missing');
    assert(Number.isFinite(Number(cc.currentRegimeRecoveryCount)), 'commandCenter.currentRegimeRecoveryCount missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.regimePersistenceSource || '')), 'commandCenter.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.regimeHistoryCoverageDays)), 'commandCenter.regimeHistoryCoverageDays missing');
    assert(cc.regimeHistoryProvenance && typeof cc.regimeHistoryProvenance === 'object', 'commandCenter.regimeHistoryProvenance missing');
    assert(cc.currentRegimeLastStateTransition === null || typeof cc.currentRegimeLastStateTransition === 'object', 'commandCenter.currentRegimeLastStateTransition should be object or null');
    assert(typeof cc.currentRegimeHasLiveCapturedHistory === 'boolean', 'commandCenter.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(cc.currentRegimeLiveCapturedTenureDays)), 'commandCenter.currentRegimeLiveCapturedTenureDays missing');
    assert(cc.currentRegimeLastLiveCapturedDate === null || typeof cc.currentRegimeLastLiveCapturedDate === 'string', 'commandCenter.currentRegimeLastLiveCapturedDate missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'commandCenter.decisionBoard missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.decisionBoard.regimePersistenceSource || '')), 'decisionBoard.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.decisionBoard.regimeHistoryCoverageDays || 0)), 'decisionBoard.regimeHistoryCoverageDays missing');
    assert(Number.isFinite(Number(cc.decisionBoard.regimeTenureDays || 0)), 'decisionBoard.regimeTenureDays missing');
    assert(typeof cc.decisionBoard.regimeHasLiveCapturedHistory === 'boolean', 'decisionBoard.regimeHasLiveCapturedHistory missing');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'commandCenter.todayRecommendation missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.todayRecommendation.regimePersistenceSource || '')), 'todayRecommendation.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeHistoryCoverageDays || 0)), 'todayRecommendation.regimeHistoryCoverageDays missing');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeTenureDays || 0)), 'todayRecommendation.regimeTenureDays missing');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeConsecutiveQualifiedWindows || 0)), 'todayRecommendation.regimeConsecutiveQualifiedWindows missing');
    assert(typeof cc.todayRecommendation.regimeHasLiveCapturedHistory === 'boolean', 'todayRecommendation.regimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeLiveCapturedTenureDays || 0)), 'todayRecommendation.regimeLiveCapturedTenureDays missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime confirmation history tests passed.');
  } catch (err) {
    console.error(`Jarvis regime confirmation history test failed: ${err.message}`);
    process.exit(1);
  }
})();
