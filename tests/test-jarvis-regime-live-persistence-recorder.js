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
  recordLiveRegimePersistenceSnapshot,
} = require('../server/jarvis-core/regime-live-persistence-recorder');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');
const {
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 120000;
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

  const day1 = buildSnapshot('2026-03-08', 'wide_volatile', {
    wide_volatile: {
      promotionState: 'near_live_confirmation',
      promotionReason: 'wide_volatile near confirmation',
      liveSampleSize: 11,
      liveUsefulnessLabel: 'moderate',
      liveUsefulnessScore: 62,
      progressPct: 58,
      evidenceFreshnessLabel: 'fresh',
    },
  });

  appendRegimeConfirmationHistorySnapshot({
    db,
    snapshotDate: day1.date,
    snapshotGeneratedAt: day1.liveRegimeConfirmation.generatedAt,
    windowSessions: 120,
    performanceSource: 'all',
    currentRegimeLabel: day1.liveRegimeConfirmation.currentRegimeLabel,
    liveRegimeConfirmation: day1.liveRegimeConfirmation,
    regimeTrustConsumption: day1.regimeTrustConsumption,
    regimeEvidenceSplit: day1.regimeEvidenceSplit,
    regimePerformanceFeedback: day1.regimePerformanceFeedback,
    persistenceProvenance: 'reconstructed_from_historical_sources',
    reconstructionConfidence: 'medium',
    reconstructionWarnings: ['unit_reconstructed_seed'],
    liveCaptureWrite: false,
  });

  const seeded = db.prepare(`
    SELECT persistence_provenance, live_capture_count
    FROM jarvis_regime_confirmation_history
    WHERE snapshot_date = ? AND regime_label = 'wide_volatile'
    LIMIT 1
  `).get(day1.date);
  assert(String(seeded?.persistence_provenance || '') === 'reconstructed_from_historical_sources', 'seed row should be reconstructed');
  assert(Number(seeded?.live_capture_count || 0) === 0, 'seed row should not have live capture count');

  const firstRecord = recordLiveRegimePersistenceSnapshot({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    snapshotDate: day1.date,
    liveRegimeConfirmation: day1.liveRegimeConfirmation,
    regimeTrustConsumption: day1.regimeTrustConsumption,
    regimeEvidenceSplit: day1.regimeEvidenceSplit,
    regimePerformanceFeedback: day1.regimePerformanceFeedback,
    nowEt: { date: day1.date, time: '14:45' },
  });

  assert(firstRecord?.advisoryOnly === true, 'live recorder summary must be advisoryOnly');
  assert(Number(firstRecord.liveRowsInserted || 0) >= 0, 'liveRowsInserted missing');
  assert(Number(firstRecord.liveRowsUpdated || 0) > 0, 'liveRowsUpdated should be positive on promotion from reconstructed seed');
  assert(Number(firstRecord.promotedToLiveCaptured || 0) >= 0, 'promotedToLiveCaptured missing');

  const promoted = db.prepare(`
    SELECT
      persistence_provenance,
      first_live_captured_at,
      last_live_captured_at,
      live_capture_count
    FROM jarvis_regime_confirmation_history
    WHERE snapshot_date = ? AND regime_label = 'wide_volatile'
    LIMIT 1
  `).get(day1.date);
  assert(String(promoted?.persistence_provenance || '') !== 'reconstructed_from_historical_sources', 'live record should not remain reconstructed-only');
  assert(Number(promoted?.live_capture_count || 0) >= 1, 'live capture count should be recorded');
  assert(String(promoted?.first_live_captured_at || '').startsWith(day1.date), 'first_live_captured_at should be set to snapshot date');
  assert(String(promoted?.last_live_captured_at || '').startsWith(day1.date), 'last_live_captured_at should be set to snapshot date');

  const secondRecord = recordLiveRegimePersistenceSnapshot({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    snapshotDate: day1.date,
    liveRegimeConfirmation: day1.liveRegimeConfirmation,
    regimeTrustConsumption: day1.regimeTrustConsumption,
    regimeEvidenceSplit: day1.regimeEvidenceSplit,
    regimePerformanceFeedback: day1.regimePerformanceFeedback,
    nowEt: { date: day1.date, time: '15:10' },
  });
  assert(Number(secondRecord.liveRowsUpdated || 0) > 0, 'second record should update idempotently');

  const afterSecond = db.prepare(`
    SELECT live_capture_count
    FROM jarvis_regime_confirmation_history
    WHERE snapshot_date = ? AND regime_label = 'wide_volatile'
    LIMIT 1
  `).get(day1.date);
  assert(Number(afterSecond?.live_capture_count || 0) === Number(promoted?.live_capture_count || 0), 'same-day repeated live record must not inflate live_capture_count');

  appendRegimeConfirmationHistorySnapshot({
    db,
    snapshotDate: day1.date,
    snapshotGeneratedAt: day1.liveRegimeConfirmation.generatedAt,
    windowSessions: 120,
    performanceSource: 'all',
    currentRegimeLabel: day1.liveRegimeConfirmation.currentRegimeLabel,
    liveRegimeConfirmation: day1.liveRegimeConfirmation,
    regimeTrustConsumption: day1.regimeTrustConsumption,
    regimeEvidenceSplit: day1.regimeEvidenceSplit,
    regimePerformanceFeedback: day1.regimePerformanceFeedback,
    persistenceProvenance: 'reconstructed_from_historical_sources',
    reconstructionConfidence: 'medium',
    reconstructionWarnings: ['replayed_backfill_attempt'],
    liveCaptureWrite: false,
  });

  const afterBackfillReplay = db.prepare(`
    SELECT persistence_provenance
    FROM jarvis_regime_confirmation_history
    WHERE snapshot_date = ? AND regime_label = 'wide_volatile'
    LIMIT 1
  `).get(day1.date);
  assert(String(afterBackfillReplay?.persistence_provenance || '') !== 'reconstructed_from_historical_sources', 'live-captured row must not downgrade back to reconstructed');

  const day2 = buildSnapshot('2026-03-09', 'wide_volatile', {
    wide_volatile: {
      promotionState: 'live_confirmed',
      promotionReason: 'wide_volatile confirmed',
      liveSampleSize: 17,
      liveUsefulnessLabel: 'moderate',
      liveUsefulnessScore: 66,
      liveConfidenceAdjustment: 1,
      progressPct: 82,
      evidenceFreshnessLabel: 'fresh',
    },
  });

  recordLiveRegimePersistenceSnapshot({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    snapshotDate: day2.date,
    liveRegimeConfirmation: day2.liveRegimeConfirmation,
    regimeTrustConsumption: day2.regimeTrustConsumption,
    regimeEvidenceSplit: day2.regimeEvidenceSplit,
    regimePerformanceFeedback: day2.regimePerformanceFeedback,
    nowEt: { date: day2.date, time: '14:40' },
  });

  const history = buildRegimeConfirmationHistorySummary({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    currentRegimeLabel: 'wide_volatile',
  });

  assert(history && typeof history === 'object', 'history summary missing');
  assert(history.advisoryOnly === true, 'history summary must be advisoryOnly');
  assert(history.currentRegimeHasLiveCapturedHistory === true, 'currentRegimeHasLiveCapturedHistory should be true after live recording');
  assert(Number(history.currentRegimeLiveCapturedTenureDays || 0) >= 1, 'currentRegimeLiveCapturedTenureDays should be positive');
  assert(typeof history.currentRegimeLastLiveCapturedDate === 'string' && history.currentRegimeLastLiveCapturedDate.length > 0, 'currentRegimeLastLiveCapturedDate missing');
  assert(history.historyProvenanceBreakdown && typeof history.historyProvenanceBreakdown === 'object', 'historyProvenanceBreakdown missing');

  const durability = buildRegimeConfirmationDurabilitySummary({
    windowSessions: 120,
    liveRegimeConfirmation: day2.liveRegimeConfirmation,
    regimeTrustConsumption: day2.regimeTrustConsumption,
    regimeEvidenceSplit: day2.regimeEvidenceSplit,
    regimePerformanceFeedback: day2.regimePerformanceFeedback,
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 12, backfill: 4, total: 16 },
    },
    regimeConfirmationHistory: history,
  });

  assert(durability && typeof durability === 'object', 'durability summary missing');
  assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(durability.persistenceSource || '')), 'durability.persistenceSource invalid');
  assert(durability.currentRegimeHasLiveCapturedHistory === true, 'durability should expose currentRegimeHasLiveCapturedHistory');
  assert(Number.isFinite(Number(durability.currentRegimeLiveCapturedTenureDays)), 'durability currentRegimeLiveCapturedTenureDays missing');

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
    port: process.env.JARVIS_AUDIT_PORT || 3202,
  });

  try {
    const liveRecordOut = await getJson(server.baseUrl, '/api/jarvis/regime/history/live-record?windowSessions=120&performanceSource=all&force=1');
    assert(liveRecordOut?.status === 'ok', 'live-record endpoint should return ok');
    const liveRecord = liveRecordOut?.liveRegimePersistenceRecorder;
    assert(liveRecord && typeof liveRecord === 'object', 'liveRegimePersistenceRecorder missing');
    assert(liveRecord.advisoryOnly === true, 'liveRegimePersistenceRecorder must be advisoryOnly');
    assert(Number.isFinite(Number(liveRecord.liveRowsInserted)), 'liveRowsInserted missing');
    assert(Number.isFinite(Number(liveRecord.liveRowsUpdated)), 'liveRowsUpdated missing');
    assert(Number.isFinite(Number(liveRecord.promotedToMixed)), 'promotedToMixed missing');
    assert(Number.isFinite(Number(liveRecord.promotedToLiveCaptured)), 'promotedToLiveCaptured missing');
    assert(Number.isFinite(Number(liveRecord.skippedRows)), 'skippedRows missing');

    const historyOut = await getJson(server.baseUrl, '/api/jarvis/regime/history?windowSessions=120&performanceSource=all&force=1');
    assert(historyOut?.status === 'ok', 'history endpoint should return ok');
    const history = historyOut?.regimeConfirmationHistory;
    assert(history && typeof history === 'object', 'regimeConfirmationHistory missing');
    assert(Number.isFinite(Number(history.historyCoverageDays)), 'historyCoverageDays missing');
    assert(history.historyProvenanceBreakdown && typeof history.historyProvenanceBreakdown === 'object', 'historyProvenanceBreakdown missing');
    assert(typeof history.currentRegimeHasLiveCapturedHistory === 'boolean', 'currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(history.currentRegimeLiveCapturedTenureDays)), 'currentRegimeLiveCapturedTenureDays missing');
    assert(history.currentRegimeLastLiveCapturedDate === null || typeof history.currentRegimeLastLiveCapturedDate === 'string', 'currentRegimeLastLiveCapturedDate missing');

    const durabilityOut = await getJson(server.baseUrl, '/api/jarvis/regime/durability?windowSessions=120&performanceSource=all&force=1');
    assert(durabilityOut?.status === 'ok', 'durability endpoint should return ok');
    const durability = durabilityOut?.regimeConfirmationDurability;
    assert(durability && typeof durability === 'object', 'regimeConfirmationDurability missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(durability.persistenceSource || '')), 'durability.persistenceSource invalid');
    assert(durability.historyProvenanceBreakdown && typeof durability.historyProvenanceBreakdown === 'object', 'durability.historyProvenanceBreakdown missing');
    assert(typeof durability.currentRegimeHasLiveCapturedHistory === 'boolean', 'durability.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(durability.currentRegimeLiveCapturedTenureDays)), 'durability.currentRegimeLiveCapturedTenureDays missing');

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command-center should return ok');
    const cc = centerOut?.commandCenter || {};

    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.regimePersistenceSource || '')), 'commandCenter.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.regimeHistoryCoverageDays)), 'commandCenter.regimeHistoryCoverageDays missing');
    assert(cc.regimeHistoryProvenance && typeof cc.regimeHistoryProvenance === 'object', 'commandCenter.regimeHistoryProvenance missing');
    assert(typeof cc.currentRegimeHasLiveCapturedHistory === 'boolean', 'commandCenter.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(cc.currentRegimeLiveCapturedTenureDays)), 'commandCenter.currentRegimeLiveCapturedTenureDays missing');
    assert(cc.currentRegimeLastLiveCapturedDate === null || typeof cc.currentRegimeLastLiveCapturedDate === 'string', 'commandCenter.currentRegimeLastLiveCapturedDate missing');

    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'decisionBoard missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.decisionBoard.regimePersistenceSource || '')), 'decisionBoard.regimePersistenceSource invalid');
    assert(typeof cc.decisionBoard.regimeHasLiveCapturedHistory === 'boolean', 'decisionBoard.regimeHasLiveCapturedHistory missing');

    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'todayRecommendation missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.todayRecommendation.regimePersistenceSource || '')), 'todayRecommendation.regimePersistenceSource invalid');
    assert(typeof cc.todayRecommendation.regimeHasLiveCapturedHistory === 'boolean', 'todayRecommendation.regimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeLiveCapturedTenureDays)), 'todayRecommendation.regimeLiveCapturedTenureDays missing');

    assert(centerOut?.liveRegimePersistenceRecorder && typeof centerOut.liveRegimePersistenceRecorder === 'object', 'top-level liveRegimePersistenceRecorder missing from command-center response');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis live regime persistence recorder tests passed.');
  } catch (err) {
    console.error(`Jarvis live regime persistence recorder test failed: ${err.message}`);
    process.exit(1);
  }
})();
