'use strict';

const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');
const {
  appendRegimeConfirmationHistorySnapshot,
} = require('./regime-confirmation-history');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  const txt = toText(value);
  if (!txt) return '';
  if (txt.includes('T')) return txt.slice(0, 10);
  if (txt.includes(' ')) return txt.slice(0, 10);
  return txt.slice(0, 10);
}

function normalizePerformanceSource(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live' || txt === 'backfill') return txt;
  return 'all';
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function buildLiveRegimePersistenceRecorderSummary(input = {}) {
  return {
    currentSnapshotDate: normalizeDate(input.currentSnapshotDate || '') || null,
    liveRowsInserted: Math.max(0, Number(input.liveRowsInserted || 0)),
    liveRowsUpdated: Math.max(0, Number(input.liveRowsUpdated || 0)),
    promotedToMixed: Math.max(0, Number(input.promotedToMixed || 0)),
    promotedToLiveCaptured: Math.max(0, Number(input.promotedToLiveCaptured || 0)),
    skippedRows: Math.max(0, Number(input.skippedRows || 0)),
    warnings: Array.from(new Set((Array.isArray(input.warnings) ? input.warnings : []).filter(Boolean))),
    advisoryOnly: true,
  };
}

function recordLiveRegimePersistenceSnapshot(input = {}) {
  const db = input.db;
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');
  const nowEtDate = normalizeDate(input?.nowEt?.date || input?.context?.nowEt?.date || '');
  const snapshotDate = normalizeDate(
    input.snapshotDate
      || nowEtDate
      || new Date().toISOString()
  );
  const snapshotGeneratedAt = toText(
    input.snapshotGeneratedAt
      || input?.liveRegimeConfirmation?.generatedAt
      || new Date().toISOString()
  ) || new Date().toISOString();

  const warnings = [];
  if (!snapshotDate) warnings.push('invalid_snapshot_date');
  if (!db || typeof db.prepare !== 'function') warnings.push('db_unavailable');

  const liveRegimeConfirmation = input.liveRegimeConfirmation && typeof input.liveRegimeConfirmation === 'object'
    ? input.liveRegimeConfirmation
    : null;
  const hasLiveRows = Array.isArray(liveRegimeConfirmation?.liveConfirmationByRegime)
    && liveRegimeConfirmation.liveConfirmationByRegime.length >= SUPPORTED_REGIME_LABELS.length;

  if (!liveRegimeConfirmation || !hasLiveRows) {
    warnings.push('missing_live_regime_confirmation_snapshot');
    return buildLiveRegimePersistenceRecorderSummary({
      currentSnapshotDate: snapshotDate,
      skippedRows: SUPPORTED_REGIME_LABELS.length,
      warnings,
    });
  }

  if (!db || typeof db.prepare !== 'function' || !snapshotDate) {
    return buildLiveRegimePersistenceRecorderSummary({
      currentSnapshotDate: snapshotDate,
      skippedRows: SUPPORTED_REGIME_LABELS.length,
      warnings,
    });
  }

  const appendResult = appendRegimeConfirmationHistorySnapshot({
    db,
    snapshotDate,
    snapshotGeneratedAt,
    windowSessions,
    performanceSource,
    currentRegimeLabel: input.currentRegimeLabel || liveRegimeConfirmation?.currentRegimeLabel || 'unknown',
    liveRegimeConfirmation,
    regimeTrustConsumption: input.regimeTrustConsumption || null,
    regimeEvidenceSplit: input.regimeEvidenceSplit || null,
    regimePerformanceFeedback: input.regimePerformanceFeedback || null,
    recommendationPerformanceSummary: input.recommendationPerformanceSummary || null,
    context: input.context || null,
    nowEt: input.nowEt || null,
    persistenceProvenance: 'live_captured',
    reconstructionConfidence: 'high',
    reconstructionWarnings: [],
    liveCaptureWrite: true,
    liveCaptureDate: snapshotDate,
    preferLiveCapturedPromotion: true,
  });

  if (Number(appendResult?.inserted || 0) <= 0 && Number(appendResult?.updated || 0) <= 0) {
    warnings.push('no_live_rows_recorded');
  }
  if (nowEtDate && nowEtDate !== snapshotDate) {
    warnings.push('snapshot_date_mismatch_with_nowet');
  }

  return buildLiveRegimePersistenceRecorderSummary({
    currentSnapshotDate: snapshotDate,
    liveRowsInserted: Number(appendResult?.inserted || 0),
    liveRowsUpdated: Number(appendResult?.updated || 0),
    promotedToMixed: Number(appendResult?.promotedToMixed || 0),
    promotedToLiveCaptured: Number(appendResult?.promotedToLiveCaptured || 0),
    skippedRows: 0,
    warnings,
  });
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  recordLiveRegimePersistenceSnapshot,
  buildLiveRegimePersistenceRecorderSummary,
};
