#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  SUPPORTED_REGIME_LABELS,
} = require('../server/jarvis-core/regime-detection');
const {
  ensureRegimeConfirmationHistoryTables,
  buildRegimeConfirmationHistorySummary,
} = require('../server/jarvis-core/regime-confirmation-history');
const {
  backfillRegimeConfirmationHistory,
} = require('../server/jarvis-core/regime-confirmation-history-backfill');
const {
  buildRegimeConfirmationDurabilitySummary,
} = require('../server/jarvis-core/regime-confirmation-durability');
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

function makeScorecard(date, sourceType, regimeLabel, opts = {}) {
  return {
    date,
    sourceType,
    regimeLabel,
    postureEvaluation: opts.postureEvaluation || 'correct',
    strategyRecommendationScore: {
      scoreLabel: opts.strategyScoreLabel || 'correct',
    },
    tpRecommendationScore: {
      scoreLabel: opts.tpScoreLabel || 'correct',
    },
    recommendationDelta: Number.isFinite(Number(opts.recommendationDelta))
      ? Number(opts.recommendationDelta)
      : 0,
  };
}

function buildUnitFixtureScorecards() {
  return [
    makeScorecard('2026-01-02', 'backfill', 'trending', { postureEvaluation: 'correct', strategyScoreLabel: 'correct', tpScoreLabel: 'partially_correct', recommendationDelta: 8 }),
    makeScorecard('2026-01-03', 'backfill', 'trending', { postureEvaluation: 'partially_correct', strategyScoreLabel: 'partially_correct', tpScoreLabel: 'correct', recommendationDelta: 3 }),
    makeScorecard('2026-01-04', 'live', 'wide_volatile', { postureEvaluation: 'correct', strategyScoreLabel: 'correct', tpScoreLabel: 'correct', recommendationDelta: 12 }),
    makeScorecard('2026-01-05', 'backfill', 'ranging', { postureEvaluation: 'incorrect', strategyScoreLabel: 'incorrect', tpScoreLabel: 'partially_correct', recommendationDelta: -10 }),
    makeScorecard('2026-01-06', 'live', 'wide_volatile', { postureEvaluation: 'partially_correct', strategyScoreLabel: 'correct', tpScoreLabel: 'correct', recommendationDelta: 5 }),
    makeScorecard('2026-01-07', 'backfill', 'compressed', { postureEvaluation: 'correct', strategyScoreLabel: 'partially_correct', tpScoreLabel: 'partially_correct', recommendationDelta: 1 }),
    makeScorecard('2026-01-08', 'live', 'wide_volatile', { postureEvaluation: 'correct', strategyScoreLabel: 'correct', tpScoreLabel: 'correct', recommendationDelta: 9 }),
    makeScorecard('2026-01-09', 'backfill', 'mixed', { postureEvaluation: 'incorrect', strategyScoreLabel: 'partially_correct', tpScoreLabel: 'incorrect', recommendationDelta: -6 }),
  ];
}

function runUnitChecks() {
  const db = new Database(':memory:');
  ensureRegimeConfirmationHistoryTables(db);

  const recommendationPerformance = {
    scorecards: buildUnitFixtureScorecards(),
  };

  const first = backfillRegimeConfirmationHistory({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    maxDays: 8,
    recommendationPerformance,
    regimeByDate: {},
  });

  assert(first && typeof first === 'object', 'backfill result missing');
  assert(first.advisoryOnly === true, 'backfill summary must be advisoryOnly');
  assert(Number(first.attemptedDays || 0) > 0, 'backfill should attempt at least one day');
  assert(Number(first.reconstructedDays || 0) > 0, 'backfill should reconstruct at least one day');
  assert(Number(first.insertedRows || 0) > 0, 'backfill should insert rows on first run');

  const firstCount = Number(db.prepare('SELECT COUNT(*) AS c FROM jarvis_regime_confirmation_history').get()?.c || 0);
  assert(firstCount > 0, 'history ledger should contain rows after first backfill');

  const second = backfillRegimeConfirmationHistory({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    maxDays: 8,
    recommendationPerformance,
    regimeByDate: {},
  });
  assert(Number(second.insertedRows || 0) === 0, 'second backfill should not insert duplicate rows');

  const secondCount = Number(db.prepare('SELECT COUNT(*) AS c FROM jarvis_regime_confirmation_history').get()?.c || 0);
  assert(secondCount === firstCount, 'idempotent backfill should not increase row count');

  const provenanceRows = db.prepare(`
    SELECT DISTINCT persistence_provenance AS p
    FROM jarvis_regime_confirmation_history
  `).all();
  const provenanceValues = new Set(provenanceRows.map((row) => String(row.p || '')));
  assert(provenanceValues.has('reconstructed_from_historical_sources') || provenanceValues.has('mixed'), 'reconstructed provenance should be present after backfill');

  const liveRows = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM jarvis_regime_confirmation_history
    WHERE persistence_provenance = 'live_captured'
  `).get()?.c || 0);
  assert(liveRows === 0, 'reconstructed backfill rows must not be mislabeled as live_captured');

  const history = buildRegimeConfirmationHistorySummary({
    db,
    windowSessions: 120,
    performanceSource: 'all',
    currentRegimeLabel: 'wide_volatile',
  });
  assert(history && typeof history === 'object', 'history summary missing');
  assert(history.advisoryOnly === true, 'history summary must be advisoryOnly');
  assert(Array.isArray(history.byRegime), 'history byRegime missing');
  assert(history.historyProvenanceBreakdown && typeof history.historyProvenanceBreakdown === 'object', 'history provenance breakdown missing');
  assert(Number(history.historyProvenanceBreakdown.reconstructedDays || 0) > 0, 'history provenance breakdown should report reconstructed days');

  const liveRowsFixture = SUPPORTED_REGIME_LABELS.map((label) => ({
    regimeLabel: label,
    promotionState: label === 'wide_volatile' ? 'near_live_confirmation' : 'no_live_support',
    progressPct: label === 'wide_volatile' ? 58 : 0,
    liveSampleSize: label === 'wide_volatile' ? 11 : 0,
    requiredSampleForPromotion: (label === 'mixed' || label === 'unknown') ? 30 : 15,
    liveUsefulnessLabel: label === 'wide_volatile' ? 'moderate' : 'insufficient',
    liveUsefulnessScore: label === 'wide_volatile' ? 61 : null,
    liveConfidenceAdjustment: label === 'wide_volatile' ? 1 : 0,
    advisoryOnly: true,
  }));

  const allRowsFixture = SUPPORTED_REGIME_LABELS.map((label) => ({
    regimeLabel: label,
    usefulnessScore: label === 'wide_volatile' ? 66 : null,
    usefulnessLabel: label === 'wide_volatile' ? 'moderate' : 'insufficient',
    evidenceSourceBreakdown: {
      live: label === 'wide_volatile' ? 11 : 0,
      backfill: label === 'wide_volatile' ? 25 : 0,
      total: label === 'wide_volatile' ? 36 : 0,
    },
    advisoryOnly: true,
  }));

  const splitRowsFixture = SUPPORTED_REGIME_LABELS.map((label) => ({
    regimeLabel: label,
    usefulnessScore: label === 'wide_volatile' ? 61 : null,
    usefulnessLabel: label === 'wide_volatile' ? 'moderate' : 'insufficient',
    liveDirectSampleSize: label === 'wide_volatile' ? 11 : 0,
    advisoryOnly: true,
  }));

  const durability = buildRegimeConfirmationDurabilitySummary({
    windowSessions: 120,
    liveRegimeConfirmation: {
      currentRegimeLabel: 'wide_volatile',
      liveConfirmationByRegime: liveRowsFixture,
    },
    regimeTrustConsumption: {
      currentRegimeLabel: 'wide_volatile',
      trustBiasLabel: 'mixed_support',
      trustConsumptionLabel: 'allow_with_caution',
      currentRegimeTrustSnapshot: {
        evidenceQuality: 'mixed',
      },
    },
    regimeEvidenceSplit: {
      currentRegimeLabel: 'wide_volatile',
      allEvidenceByRegime: allRowsFixture,
      liveOnlyByRegime: splitRowsFixture,
    },
    recommendationPerformanceSummary: {
      sourceBreakdown: { live: 3, backfill: 5, total: 8 },
    },
    regimeConfirmationHistory: history,
  });
  assert(durability && typeof durability === 'object', 'durability summary missing');
  assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(durability.persistenceSource || '')), 'durability persistenceSource invalid');
  assert(durability.persistenceSource === 'persisted_reconstructed_history' || durability.persistenceSource === 'mixed_persisted_history', 'durability should switch away from proxy_only when reconstructed history exists');
  assert(durability.historyProvenanceBreakdown && typeof durability.historyProvenanceBreakdown === 'object', 'durability historyProvenanceBreakdown missing');
  assert(Number.isFinite(Number(durability.historyCoverageDays)), 'durability historyCoverageDays missing');

  for (const row of history.byRegime) {
    assert(SUPPORTED_REGIME_LABELS.includes(String(row?.regimeLabel || '')), `non-canonical regime label in history summary: ${row?.regimeLabel}`);
  }

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
    port: process.env.JARVIS_AUDIT_PORT || 3199,
  });

  try {
    const backfillOut = await getJson(server.baseUrl, '/api/jarvis/regime/history/backfill?windowSessions=120&performanceSource=all&force=1&maxDays=120');
    assert(backfillOut?.status === 'ok', 'history/backfill endpoint should return ok');
    const backfill = backfillOut?.regimeConfirmationHistoryBackfill;
    assert(backfill && typeof backfill === 'object', 'regimeConfirmationHistoryBackfill missing');
    assert(Number.isFinite(Number(backfill.attemptedDays)), 'backfill.attemptedDays missing');
    assert(Number.isFinite(Number(backfill.reconstructedDays)), 'backfill.reconstructedDays missing');
    assert(Number.isFinite(Number(backfill.skippedDays)), 'backfill.skippedDays missing');
    assert(Number.isFinite(Number(backfill.insertedRows)), 'backfill.insertedRows missing');
    assert(Number.isFinite(Number(backfill.updatedRows)), 'backfill.updatedRows missing');
    assert(Array.isArray(backfill.warnings), 'backfill.warnings missing');

    const historyOut = await getJson(server.baseUrl, '/api/jarvis/regime/history?windowSessions=120&performanceSource=all&force=1');
    assert(historyOut?.status === 'ok', 'regime/history should return ok');
    const history = historyOut?.regimeConfirmationHistory;
    assert(history && typeof history === 'object', 'regimeConfirmationHistory missing');
    assert(Number.isFinite(Number(history.historyCoverageDays)), 'historyCoverageDays missing');
    assert(history.historyProvenanceBreakdown && typeof history.historyProvenanceBreakdown === 'object', 'historyProvenanceBreakdown missing');
    assert(typeof history.currentRegimeHasLiveCapturedHistory === 'boolean', 'history.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(history.currentRegimeLiveCapturedTenureDays)), 'history.currentRegimeLiveCapturedTenureDays missing');

    const durabilityOut = await getJson(server.baseUrl, '/api/jarvis/regime/durability?windowSessions=120&performanceSource=all&force=1');
    assert(durabilityOut?.status === 'ok', 'regime/durability should return ok');
    const durability = durabilityOut?.regimeConfirmationDurability;
    assert(durability && typeof durability === 'object', 'regimeConfirmationDurability missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(durability.persistenceSource || '')), 'durability.persistenceSource invalid');
    assert(Number.isFinite(Number(durability.historyCoverageDays)), 'durability.historyCoverageDays missing');
    assert(durability.historyProvenanceBreakdown && typeof durability.historyProvenanceBreakdown === 'object', 'durability.historyProvenanceBreakdown missing');
    assert(Array.isArray(durability.historyWarnings), 'durability.historyWarnings missing');
    assert(typeof durability.currentRegimeHasLiveCapturedHistory === 'boolean', 'durability.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(durability.currentRegimeLiveCapturedTenureDays)), 'durability.currentRegimeLiveCapturedTenureDays missing');

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1');
    assert(centerOut?.status === 'ok', 'command-center should return ok');
    const cc = centerOut?.commandCenter || {};
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.regimePersistenceSource || '')), 'commandCenter.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.regimeHistoryCoverageDays)), 'commandCenter.regimeHistoryCoverageDays missing');
    assert(cc.regimeHistoryProvenance && typeof cc.regimeHistoryProvenance === 'object', 'commandCenter.regimeHistoryProvenance missing');
    assert(Number.isFinite(Number(cc.currentRegimeTenureDays)), 'commandCenter.currentRegimeTenureDays missing');
    assert(Number.isFinite(Number(cc.currentRegimeConsecutiveQualifiedWindows)), 'commandCenter.currentRegimeConsecutiveQualifiedWindows missing');
    assert(typeof cc.currentRegimeHasLiveCapturedHistory === 'boolean', 'commandCenter.currentRegimeHasLiveCapturedHistory missing');
    assert(Number.isFinite(Number(cc.currentRegimeLiveCapturedTenureDays)), 'commandCenter.currentRegimeLiveCapturedTenureDays missing');
    assert(cc.decisionBoard && typeof cc.decisionBoard === 'object', 'commandCenter.decisionBoard missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.decisionBoard.regimePersistenceSource || '')), 'decisionBoard.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.decisionBoard.regimeHistoryCoverageDays)), 'decisionBoard.regimeHistoryCoverageDays missing');
    assert(typeof cc.decisionBoard.regimeHasLiveCapturedHistory === 'boolean', 'decisionBoard.regimeHasLiveCapturedHistory missing');
    assert(cc.todayRecommendation && typeof cc.todayRecommendation === 'object', 'commandCenter.todayRecommendation missing');
    assert(ALLOWED_PERSISTENCE_SOURCES.includes(String(cc.todayRecommendation.regimePersistenceSource || '')), 'todayRecommendation.regimePersistenceSource invalid');
    assert(Number.isFinite(Number(cc.todayRecommendation.regimeHistoryCoverageDays)), 'todayRecommendation.regimeHistoryCoverageDays missing');
    assert(typeof cc.todayRecommendation.regimeHasLiveCapturedHistory === 'boolean', 'todayRecommendation.regimeHasLiveCapturedHistory missing');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime confirmation history backfill tests passed.');
  } catch (err) {
    console.error(`Jarvis regime confirmation history backfill test failed: ${err.message}`);
    process.exit(1);
  }
})();
