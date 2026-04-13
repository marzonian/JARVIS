'use strict';

const {
  SUPPORTED_REGIME_LABELS,
} = require('./regime-detection');
const {
  normalizeRegimeLabel,
} = require('./regime-aware-learning');

const DEFAULT_WINDOW_SESSIONS = 120;
const MIN_WINDOW_SESSIONS = 20;
const MAX_WINDOW_SESSIONS = 500;

const QUALIFIED_PROMOTION_STATES = new Set([
  'live_confirmed',
  'near_live_confirmation',
  'emerging_live_support',
]);

const PERSISTENCE_PROVENANCE_VALUES = new Set([
  'live_captured',
  'reconstructed_from_historical_sources',
  'mixed',
]);

const RECONSTRUCTION_CONFIDENCE_VALUES = new Set([
  'high',
  'medium',
  'low',
]);

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback = null) {
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

function normalizePromotionState(value) {
  const txt = toText(value).toLowerCase();
  if (
    txt === 'no_live_support'
    || txt === 'emerging_live_support'
    || txt === 'near_live_confirmation'
    || txt === 'live_confirmed'
    || txt === 'stalled_live_support'
  ) {
    return txt;
  }
  return 'no_live_support';
}

function normalizeTrustBiasLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'live_confirmed') return 'live_confirmed';
  if (txt === 'mixed_support') return 'mixed_support';
  if (txt === 'retrospective_led') return 'retrospective_led';
  return 'insufficient_live_confirmation';
}

function normalizeTrustConsumptionLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'allow_regime_confidence') return 'allow_regime_confidence';
  if (txt === 'allow_with_caution') return 'allow_with_caution';
  if (txt === 'reduce_regime_weight') return 'reduce_regime_weight';
  return 'suppress_regime_bias';
}

function normalizeUsefulnessLabel(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong' || txt === 'moderate' || txt === 'weak' || txt === 'noisy') return txt;
  return 'insufficient';
}

function parseEvidenceQuality(value) {
  const txt = toText(value).toLowerCase();
  if (txt === 'strong_live' || txt === 'mixed' || txt === 'retrospective_heavy' || txt === 'thin') return txt;
  return 'thin';
}

function normalizePersistenceProvenance(value) {
  const txt = toText(value).toLowerCase();
  if (PERSISTENCE_PROVENANCE_VALUES.has(txt)) return txt;
  return 'live_captured';
}

function normalizeReconstructionConfidence(value) {
  const txt = toText(value).toLowerCase();
  if (RECONSTRUCTION_CONFIDENCE_VALUES.has(txt)) return txt;
  return 'high';
}

function parseWarningsArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => toText(v)).filter(Boolean);
  }
  if (typeof value === 'string') {
    const txt = value.trim();
    if (!txt) return [];
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) return parsed.map((v) => toText(v)).filter(Boolean);
    } catch {}
    return [txt];
  }
  return [];
}

function mergePersistenceProvenance(existingValue = '', incomingValue = '', options = {}) {
  const existing = normalizePersistenceProvenance(existingValue || 'live_captured');
  const incoming = normalizePersistenceProvenance(incomingValue || 'live_captured');
  const preferLiveCapturedPromotion = options.preferLiveCapturedPromotion === true;
  if (existing === 'live_captured' && incoming !== 'live_captured') return 'live_captured';
  if (incoming === 'live_captured' && preferLiveCapturedPromotion && existing !== 'live_captured') {
    return 'live_captured';
  }
  if (existing === incoming) return existing;
  if (existing === 'mixed' || incoming === 'mixed') return 'mixed';
  if (
    (existing === 'live_captured' && incoming === 'reconstructed_from_historical_sources')
    || (existing === 'reconstructed_from_historical_sources' && incoming === 'live_captured')
  ) {
    return 'mixed';
  }
  return incoming;
}

function confidenceRank(value = '') {
  const normalized = normalizeReconstructionConfidence(value || 'low');
  if (normalized === 'high') return 3;
  if (normalized === 'medium') return 2;
  return 1;
}

function mergeReconstructionConfidence(existingValue = '', incomingValue = '', mergedProvenance = '') {
  const existing = normalizeReconstructionConfidence(existingValue || 'low');
  const incoming = normalizeReconstructionConfidence(incomingValue || 'low');
  const provenance = normalizePersistenceProvenance(mergedProvenance || incoming);
  if (provenance === 'live_captured') return 'high';
  if (provenance === 'mixed') {
    return confidenceRank(existing) >= confidenceRank(incoming) ? incoming : existing;
  }
  return confidenceRank(existing) >= confidenceRank(incoming) ? existing : incoming;
}

function mergeReconstructionWarnings(existingValue = null, incomingValue = null, mergedProvenance = '') {
  const existing = parseWarningsArray(existingValue);
  const incoming = parseWarningsArray(incomingValue);
  const warnings = new Set([...existing, ...incoming]);
  const provenance = normalizePersistenceProvenance(mergedProvenance || 'live_captured');
  if (provenance === 'mixed') warnings.add('mixed_persistence_sources');
  return Array.from(warnings).filter(Boolean);
}

function compareDateIso(left = '', right = '') {
  const a = normalizeDate(left);
  const b = normalizeDate(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function earlierDateIso(left = '', right = '') {
  if (!normalizeDate(left)) return normalizeDate(right) || null;
  if (!normalizeDate(right)) return normalizeDate(left) || null;
  return compareDateIso(left, right) <= 0
    ? normalizeDate(left)
    : normalizeDate(right);
}

function laterDateIso(left = '', right = '') {
  if (!normalizeDate(left)) return normalizeDate(right) || null;
  if (!normalizeDate(right)) return normalizeDate(left) || null;
  return compareDateIso(left, right) >= 0
    ? normalizeDate(left)
    : normalizeDate(right);
}

function mergeLiveCaptureMeta(input = {}) {
  const existingFirst = normalizeDate(input.existingFirstLiveCapturedAt || '');
  const existingLast = normalizeDate(input.existingLastLiveCapturedAt || '');
  const existingCount = Math.max(0, Number(input.existingLiveCaptureCount || 0));
  const incomingLiveCaptureWrite = input.incomingLiveCaptureWrite === true;
  const incomingLiveCaptureDate = normalizeDate(input.incomingLiveCaptureDate || '');
  const mergedProvenance = normalizePersistenceProvenance(input.mergedProvenance || 'live_captured');

  let firstLiveCapturedAt = existingFirst || null;
  let lastLiveCapturedAt = existingLast || null;
  let liveCaptureCount = existingCount;

  if (incomingLiveCaptureWrite && incomingLiveCaptureDate) {
    const alreadyRecordedForDate = existingLast && existingLast === incomingLiveCaptureDate && existingCount > 0;
    if (!alreadyRecordedForDate) {
      liveCaptureCount += 1;
    }
    firstLiveCapturedAt = earlierDateIso(firstLiveCapturedAt, incomingLiveCaptureDate);
    lastLiveCapturedAt = laterDateIso(lastLiveCapturedAt, incomingLiveCaptureDate);
  }

  if (mergedProvenance === 'live_captured' && liveCaptureCount <= 0) {
    const fallbackLiveDate = incomingLiveCaptureDate || existingLast || existingFirst || null;
    if (fallbackLiveDate) {
      firstLiveCapturedAt = earlierDateIso(firstLiveCapturedAt, fallbackLiveDate);
      lastLiveCapturedAt = laterDateIso(lastLiveCapturedAt, fallbackLiveDate);
      liveCaptureCount = Math.max(1, liveCaptureCount);
    }
  }

  if (liveCaptureCount <= 0) {
    return {
      firstLiveCapturedAt: null,
      lastLiveCapturedAt: null,
      liveCaptureCount: 0,
    };
  }

  return {
    firstLiveCapturedAt: firstLiveCapturedAt || null,
    lastLiveCapturedAt: lastLiveCapturedAt || null,
    liveCaptureCount,
  };
}

function rowHasLiveCapturedEvidence(row = {}) {
  const count = Math.max(0, Number(row?.live_capture_count != null ? row.live_capture_count : row?.liveCaptureCount || 0));
  if (count > 0) return true;
  const provenance = normalizePersistenceProvenance(
    row?.persistence_provenance || row?.persistenceProvenance || 'reconstructed_from_historical_sources'
  );
  return provenance === 'live_captured' || provenance === 'mixed';
}

function safeCanonicalRegimeLabel(value) {
  const label = normalizeRegimeLabel(value || 'unknown');
  return SUPPORTED_REGIME_LABELS.includes(label) ? label : 'unknown';
}

function findByRegime(rows = [], regimeLabel = '') {
  const safe = safeCanonicalRegimeLabel(regimeLabel);
  return (Array.isArray(rows) ? rows : []).find((row) => (
    safeCanonicalRegimeLabel(row?.regimeLabel || row?.regime || 'unknown') === safe
  )) || null;
}

function classifyEvidenceQualityFromBreakdown(breakdown = {}) {
  const live = Math.max(0, Number(breakdown.live || 0));
  const backfill = Math.max(0, Number(breakdown.backfill || 0));
  const total = Math.max(0, Number(breakdown.total || (live + backfill)));
  if (total < 10) return 'thin';
  if (backfill >= (live * 2) && backfill >= 10) return 'retrospective_heavy';
  if (live >= 20 && live >= (backfill * 1.5)) return 'strong_live';
  return 'mixed';
}

function deriveTrustBiasLabelForRegime(regimeLabel = '', allRow = {}, liveRow = {}) {
  const safe = safeCanonicalRegimeLabel(regimeLabel);
  const allLabel = normalizeUsefulnessLabel(allRow?.usefulnessLabel || 'insufficient');
  const liveLabel = normalizeUsefulnessLabel(liveRow?.usefulnessLabel || liveRow?.liveUsefulnessLabel || 'insufficient');
  const liveSample = Math.max(0, Number(liveRow?.liveDirectSampleSize != null ? liveRow.liveDirectSampleSize : liveRow?.liveSampleSize || 0));
  const allScore = toNumber(allRow?.usefulnessScore, null);
  const liveScore = toNumber(liveRow?.usefulnessScore != null ? liveRow.usefulnessScore : liveRow?.liveUsefulnessScore, null);
  const scoreGap = (
    Number.isFinite(allScore) && Number.isFinite(liveScore)
      ? round2(allScore - liveScore)
      : null
  );
  const breakdown = allRow?.evidenceSourceBreakdown && typeof allRow.evidenceSourceBreakdown === 'object'
    ? allRow.evidenceSourceBreakdown
    : { live: 0, backfill: 0, total: 0 };
  const backfillDominant = Number(breakdown.backfill || 0) >= (Number(breakdown.live || 0) * 2)
    && Number(breakdown.backfill || 0) >= 10;

  if (liveSample < 5 || liveLabel === 'insufficient' || toText(liveRow?.coverageType).toLowerCase() === 'no_support') {
    return 'insufficient_live_confirmation';
  }
  if (
    liveSample >= 10
    && (liveLabel === 'strong' || liveLabel === 'moderate')
    && (!Number.isFinite(scoreGap) || Math.abs(scoreGap) <= 8)
  ) {
    if ((safe === 'mixed' || safe === 'unknown') && !(liveSample >= 20 && Number(liveScore || 0) >= 70)) {
      return 'mixed_support';
    }
    return 'live_confirmed';
  }
  if (
    (allLabel === 'strong' || allLabel === 'moderate')
    && (
      liveLabel === 'weak'
      || liveLabel === 'noisy'
      || (Number.isFinite(scoreGap) && scoreGap >= 12)
      || backfillDominant
    )
  ) {
    return 'retrospective_led';
  }
  return 'mixed_support';
}

function deriveTrustConsumptionLabel(input = {}) {
  const trustBiasLabel = normalizeTrustBiasLabel(input.trustBiasLabel);
  const liveSample = Math.max(0, Number(input.liveSampleSize || 0));
  const liveUsefulnessLabel = normalizeUsefulnessLabel(input.liveOnlyUsefulnessLabel || 'insufficient');
  const scoreGap = toNumber(input.scoreGap, null);
  const provenanceStrengthLabel = toText(input.provenanceStrengthLabel).toLowerCase();
  const materiallyLargeGap = Number.isFinite(scoreGap) && Math.abs(scoreGap) >= 12;

  if (trustBiasLabel === 'insufficient_live_confirmation' || liveSample < 5 || liveUsefulnessLabel === 'insufficient') {
    return 'suppress_regime_bias';
  }
  if (
    trustBiasLabel === 'live_confirmed'
    && liveSample >= 10
    && (liveUsefulnessLabel === 'strong' || liveUsefulnessLabel === 'moderate')
  ) {
    return 'allow_regime_confidence';
  }
  if (
    trustBiasLabel === 'retrospective_led'
    || materiallyLargeGap
    || provenanceStrengthLabel === 'retrospective_heavy'
  ) {
    return 'reduce_regime_weight';
  }
  return 'allow_with_caution';
}

function isQualifiedWindow(row = {}) {
  const promotionState = normalizePromotionState(row?.promotion_state || row?.promotionState || 'no_live_support');
  const liveSample = Math.max(0, Number(row?.live_sample_size != null ? row.live_sample_size : row?.liveSampleSize || 0));
  const liveLabel = normalizeUsefulnessLabel(row?.live_only_usefulness_label || row?.liveOnlyUsefulnessLabel || 'insufficient');
  const trustLabel = normalizeTrustConsumptionLabel(row?.trust_consumption_label || row?.trustConsumptionLabel || 'suppress_regime_bias');
  if (!QUALIFIED_PROMOTION_STATES.has(promotionState)) return false;
  if (trustLabel === 'suppress_regime_bias' && liveSample < 5 && liveLabel === 'insufficient') return false;
  return true;
}

function isWeakWindow(row = {}) {
  const promotionState = normalizePromotionState(row?.promotion_state || row?.promotionState || 'no_live_support');
  const trustLabel = normalizeTrustConsumptionLabel(row?.trust_consumption_label || row?.trustConsumptionLabel || 'suppress_regime_bias');
  const liveLabel = normalizeUsefulnessLabel(row?.live_only_usefulness_label || row?.liveOnlyUsefulnessLabel || 'insufficient');
  const liveSample = Math.max(0, Number(row?.live_sample_size != null ? row.live_sample_size : row?.liveSampleSize || 0));
  if (promotionState === 'no_live_support') return true;
  if (trustLabel === 'suppress_regime_bias') return true;
  if (liveLabel === 'insufficient' && liveSample < 5) return true;
  return false;
}

function parseUtcDay(dateIso = '') {
  const date = normalizeDate(dateIso);
  if (!date) return null;
  const [y, m, d] = date.split('-').map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return Date.UTC(y, m - 1, d);
}

function daysDiffInclusive(startDate = '', endDate = '') {
  const s = parseUtcDay(startDate);
  const e = parseUtcDay(endDate);
  if (s == null || e == null) return 0;
  if (e < s) return 0;
  return Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
}

function ensureRegimeConfirmationHistoryTables(db) {
  if (!db || typeof db.exec !== 'function') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS jarvis_regime_confirmation_history (
      id                                INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date                     TEXT NOT NULL,
      snapshot_generated_at             TEXT,
      window_sessions                   INTEGER NOT NULL,
      performance_source                TEXT NOT NULL DEFAULT 'all',
      regime_label                      TEXT NOT NULL,
      promotion_state                   TEXT NOT NULL,
      promotion_reason                  TEXT,
      confirmation_progress_pct         REAL,
      live_sample_size                  INTEGER,
      required_sample_for_promotion     INTEGER,
      trust_bias_label                  TEXT,
      trust_consumption_label           TEXT,
      confidence_adjustment_override    REAL,
      all_evidence_usefulness_label     TEXT,
      live_only_usefulness_label        TEXT,
      score_gap                         REAL,
      provenance_strength_label         TEXT,
      evidence_quality                  TEXT,
      persistence_provenance            TEXT NOT NULL DEFAULT 'live_captured',
      reconstruction_confidence         TEXT NOT NULL DEFAULT 'high',
      reconstruction_warnings           TEXT,
      first_live_captured_at            TEXT,
      last_live_captured_at             TEXT,
      live_capture_count                INTEGER NOT NULL DEFAULT 0,
      advisory_only                     INTEGER NOT NULL DEFAULT 1,
      created_at                        TEXT DEFAULT (datetime('now')),
      updated_at                        TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, window_sessions, performance_source, regime_label)
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_regime_conf_hist_date
      ON jarvis_regime_confirmation_history(snapshot_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_regime_conf_hist_source
      ON jarvis_regime_confirmation_history(performance_source, window_sessions, snapshot_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jarvis_regime_conf_hist_regime
      ON jarvis_regime_confirmation_history(regime_label, snapshot_date DESC);
  `);

  if (typeof db.prepare === 'function') {
    const columns = new Set(
      db.prepare(`PRAGMA table_info('jarvis_regime_confirmation_history')`)
        .all()
        .map((row) => String(row?.name || '').trim())
        .filter(Boolean)
    );
    if (!columns.has('persistence_provenance')) {
      db.exec(`ALTER TABLE jarvis_regime_confirmation_history ADD COLUMN persistence_provenance TEXT NOT NULL DEFAULT 'live_captured'`);
    }
    if (!columns.has('reconstruction_confidence')) {
      db.exec(`ALTER TABLE jarvis_regime_confirmation_history ADD COLUMN reconstruction_confidence TEXT NOT NULL DEFAULT 'high'`);
    }
    if (!columns.has('reconstruction_warnings')) {
      db.exec(`ALTER TABLE jarvis_regime_confirmation_history ADD COLUMN reconstruction_warnings TEXT`);
    }
    if (!columns.has('first_live_captured_at')) {
      db.exec(`ALTER TABLE jarvis_regime_confirmation_history ADD COLUMN first_live_captured_at TEXT`);
    }
    if (!columns.has('last_live_captured_at')) {
      db.exec(`ALTER TABLE jarvis_regime_confirmation_history ADD COLUMN last_live_captured_at TEXT`);
    }
    if (!columns.has('live_capture_count')) {
      db.exec(`ALTER TABLE jarvis_regime_confirmation_history ADD COLUMN live_capture_count INTEGER NOT NULL DEFAULT 0`);
    }
  }
}

function appendRegimeConfirmationHistorySnapshot(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      appended: 0,
      inserted: 0,
      updated: 0,
      snapshotDate: null,
    };
  }
  ensureRegimeConfirmationHistoryTables(db);

  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');
  const snapshotDate = normalizeDate(
    input.snapshotDate
      || input?.context?.nowEt?.date
      || input?.nowEt?.date
      || new Date().toISOString()
  );
  const snapshotGeneratedAt = toText(
    input.snapshotGeneratedAt
      || input?.liveRegimeConfirmation?.generatedAt
      || input?.regimeTrustConsumption?.generatedAt
      || new Date().toISOString()
  ) || new Date().toISOString();

  const live = input.liveRegimeConfirmation && typeof input.liveRegimeConfirmation === 'object'
    ? input.liveRegimeConfirmation
    : {};
  const trust = input.regimeTrustConsumption && typeof input.regimeTrustConsumption === 'object'
    ? input.regimeTrustConsumption
    : {};
  const split = input.regimeEvidenceSplit && typeof input.regimeEvidenceSplit === 'object'
    ? input.regimeEvidenceSplit
    : {};
  const currentRegimeLabel = safeCanonicalRegimeLabel(
    live?.currentRegimeLabel
      || trust?.currentRegimeLabel
      || split?.currentRegimeLabel
      || input?.currentRegimeLabel
      || 'unknown'
  );

  const liveRows = Array.isArray(live?.liveConfirmationByRegime) ? live.liveConfirmationByRegime : [];
  const allRows = Array.isArray(split?.allEvidenceByRegime) ? split.allEvidenceByRegime : [];
  const splitLiveRows = Array.isArray(split?.liveOnlyByRegime) ? split.liveOnlyByRegime : [];
  const currentComparison = split?.currentRegimeComparison && typeof split.currentRegimeComparison === 'object'
    ? split.currentRegimeComparison
    : {};
  const rowMetaByRegime = input.reconstructionMetaByRegime && typeof input.reconstructionMetaByRegime === 'object'
    ? input.reconstructionMetaByRegime
    : {};
  const defaultPersistenceProvenance = normalizePersistenceProvenance(
    input.persistenceProvenance || 'live_captured'
  );
  const incomingLiveCaptureWrite = input.liveCaptureWrite === true || defaultPersistenceProvenance === 'live_captured';
  const preferLiveCapturedPromotion = input.preferLiveCapturedPromotion === true;
  const incomingLiveCaptureDate = normalizeDate(input.liveCaptureDate || snapshotDate || '');
  const defaultReconstructionConfidence = normalizeReconstructionConfidence(
    input.reconstructionConfidence || (defaultPersistenceProvenance === 'live_captured' ? 'high' : 'medium')
  );
  const defaultReconstructionWarnings = parseWarningsArray(input.reconstructionWarnings);

  const upsert = db.prepare(`
    INSERT INTO jarvis_regime_confirmation_history (
      snapshot_date,
      snapshot_generated_at,
      window_sessions,
      performance_source,
      regime_label,
      promotion_state,
      promotion_reason,
      confirmation_progress_pct,
      live_sample_size,
      required_sample_for_promotion,
      trust_bias_label,
      trust_consumption_label,
      confidence_adjustment_override,
      all_evidence_usefulness_label,
      live_only_usefulness_label,
      score_gap,
      provenance_strength_label,
      evidence_quality,
      persistence_provenance,
      reconstruction_confidence,
      reconstruction_warnings,
      first_live_captured_at,
      last_live_captured_at,
      live_capture_count,
      advisory_only,
      updated_at
    ) VALUES (
      @snapshot_date,
      @snapshot_generated_at,
      @window_sessions,
      @performance_source,
      @regime_label,
      @promotion_state,
      @promotion_reason,
      @confirmation_progress_pct,
      @live_sample_size,
      @required_sample_for_promotion,
      @trust_bias_label,
      @trust_consumption_label,
      @confidence_adjustment_override,
      @all_evidence_usefulness_label,
      @live_only_usefulness_label,
      @score_gap,
      @provenance_strength_label,
      @evidence_quality,
      @persistence_provenance,
      @reconstruction_confidence,
      @reconstruction_warnings,
      @first_live_captured_at,
      @last_live_captured_at,
      @live_capture_count,
      @advisory_only,
      datetime('now')
    )
    ON CONFLICT(snapshot_date, window_sessions, performance_source, regime_label) DO UPDATE SET
      snapshot_generated_at = excluded.snapshot_generated_at,
      promotion_state = excluded.promotion_state,
      promotion_reason = excluded.promotion_reason,
      confirmation_progress_pct = excluded.confirmation_progress_pct,
      live_sample_size = excluded.live_sample_size,
      required_sample_for_promotion = excluded.required_sample_for_promotion,
      trust_bias_label = excluded.trust_bias_label,
      trust_consumption_label = excluded.trust_consumption_label,
      confidence_adjustment_override = excluded.confidence_adjustment_override,
      all_evidence_usefulness_label = excluded.all_evidence_usefulness_label,
      live_only_usefulness_label = excluded.live_only_usefulness_label,
      score_gap = excluded.score_gap,
      provenance_strength_label = excluded.provenance_strength_label,
      evidence_quality = excluded.evidence_quality,
      persistence_provenance = excluded.persistence_provenance,
      reconstruction_confidence = excluded.reconstruction_confidence,
      reconstruction_warnings = excluded.reconstruction_warnings,
      first_live_captured_at = excluded.first_live_captured_at,
      last_live_captured_at = excluded.last_live_captured_at,
      live_capture_count = excluded.live_capture_count,
      advisory_only = excluded.advisory_only,
      updated_at = datetime('now')
  `);
  const existsStmt = db.prepare(`
    SELECT
      id,
      persistence_provenance,
      reconstruction_confidence,
      reconstruction_warnings,
      first_live_captured_at,
      last_live_captured_at,
      live_capture_count
    FROM jarvis_regime_confirmation_history
    WHERE snapshot_date = ? AND window_sessions = ? AND performance_source = ? AND regime_label = ?
    LIMIT 1
  `);

  let inserted = 0;
  let updated = 0;
  let promotedToMixed = 0;
  let promotedToLiveCaptured = 0;
  const tx = db.transaction(() => {
    for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
      const safeLabel = safeCanonicalRegimeLabel(regimeLabel);
      const liveRow = findByRegime(liveRows, safeLabel) || {};
      const allRow = findByRegime(allRows, safeLabel) || {};
      const splitLiveRow = findByRegime(splitLiveRows, safeLabel) || {};

      const allScore = toNumber(allRow?.usefulnessScore, null);
      const liveScore = toNumber(
        splitLiveRow?.usefulnessScore != null
          ? splitLiveRow.usefulnessScore
          : liveRow?.liveUsefulnessScore,
        null
      );
      let scoreGap = (
        Number.isFinite(allScore) && Number.isFinite(liveScore)
          ? round2(allScore - liveScore)
          : null
      );
      if (
        safeLabel === currentRegimeLabel
        && Number.isFinite(toNumber(currentComparison?.scoreGap, null))
      ) {
        scoreGap = round2(Number(currentComparison.scoreGap));
      }

      const liveSampleSize = Math.max(0, Number(
        liveRow?.liveSampleSize != null
          ? liveRow.liveSampleSize
          : splitLiveRow?.liveDirectSampleSize || 0
      ));
      const promotionState = normalizePromotionState(liveRow?.promotionState || 'no_live_support');
      const promotionReason = toText(liveRow?.promotionReason || `${safeLabel} state ${promotionState}.`) || `${safeLabel} state ${promotionState}.`;
      const requiredSample = Math.max(
        1,
        Math.round(Number(
          liveRow?.requiredSampleForPromotion != null
            ? liveRow.requiredSampleForPromotion
            : ((safeLabel === 'mixed' || safeLabel === 'unknown') ? 30 : 15)
        ))
      );
      const allUsefulnessLabel = normalizeUsefulnessLabel(allRow?.usefulnessLabel || 'insufficient');
      const liveOnlyUsefulnessLabel = normalizeUsefulnessLabel(
        splitLiveRow?.usefulnessLabel || liveRow?.liveUsefulnessLabel || 'insufficient'
      );
      const trustBiasLabel = safeLabel === currentRegimeLabel
        ? normalizeTrustBiasLabel(trust?.trustBiasLabel || trust?.currentRegimeTrustSnapshot?.trustBiasLabel)
        : deriveTrustBiasLabelForRegime(safeLabel, allRow, splitLiveRow);
      const trustConsumptionLabel = safeLabel === currentRegimeLabel
        ? normalizeTrustConsumptionLabel(trust?.trustConsumptionLabel)
        : deriveTrustConsumptionLabel({
          trustBiasLabel,
          liveSampleSize,
          liveOnlyUsefulnessLabel,
          scoreGap,
          provenanceStrengthLabel: allRow?.provenanceStrengthLabel || 'absent',
        });
      const confidenceAdjustmentOverride = safeLabel === currentRegimeLabel
        ? toNumber(trust?.confidenceAdjustmentOverride, null)
        : null;
      const evidenceQuality = safeLabel === currentRegimeLabel
        ? parseEvidenceQuality(
          trust?.currentRegimeTrustSnapshot?.evidenceQuality
            || input?.regimePerformanceFeedback?.regimeConfidenceGuidance?.evidenceQuality
            || classifyEvidenceQualityFromBreakdown(allRow?.evidenceSourceBreakdown || {})
        )
        : parseEvidenceQuality(classifyEvidenceQualityFromBreakdown(allRow?.evidenceSourceBreakdown || {}));
      const perRowMeta = rowMetaByRegime[safeLabel] && typeof rowMetaByRegime[safeLabel] === 'object'
        ? rowMetaByRegime[safeLabel]
        : {};

      const existed = existsStmt.get(snapshotDate, windowSessions, performanceSource, safeLabel);
      const mergedPersistenceProvenance = mergePersistenceProvenance(
        existed?.persistence_provenance || defaultPersistenceProvenance,
        perRowMeta?.persistenceProvenance || defaultPersistenceProvenance,
        { preferLiveCapturedPromotion }
      );
      const mergedReconstructionConfidence = mergeReconstructionConfidence(
        existed?.reconstruction_confidence || defaultReconstructionConfidence,
        perRowMeta?.reconstructionConfidence || defaultReconstructionConfidence,
        mergedPersistenceProvenance
      );
      const mergedReconstructionWarnings = mergeReconstructionWarnings(
        existed?.reconstruction_warnings || null,
        perRowMeta?.reconstructionWarnings || defaultReconstructionWarnings,
        mergedPersistenceProvenance
      );
      const mergedLiveCaptureMeta = mergeLiveCaptureMeta({
        existingFirstLiveCapturedAt: existed?.first_live_captured_at || null,
        existingLastLiveCapturedAt: existed?.last_live_captured_at || null,
        existingLiveCaptureCount: existed?.live_capture_count || 0,
        incomingLiveCaptureWrite,
        incomingLiveCaptureDate,
        mergedProvenance: mergedPersistenceProvenance,
      });

      const params = {
        snapshot_date: snapshotDate,
        snapshot_generated_at: snapshotGeneratedAt,
        window_sessions: windowSessions,
        performance_source: performanceSource,
        regime_label: safeLabel,
        promotion_state: promotionState,
        promotion_reason: promotionReason,
        confirmation_progress_pct: round2(Number(liveRow?.progressPct || 0)),
        live_sample_size: liveSampleSize,
        required_sample_for_promotion: requiredSample,
        trust_bias_label: trustBiasLabel,
        trust_consumption_label: trustConsumptionLabel,
        confidence_adjustment_override: Number.isFinite(Number(confidenceAdjustmentOverride)) ? Number(confidenceAdjustmentOverride) : null,
        all_evidence_usefulness_label: allUsefulnessLabel,
        live_only_usefulness_label: liveOnlyUsefulnessLabel,
        score_gap: Number.isFinite(Number(scoreGap)) ? round2(Number(scoreGap)) : null,
        provenance_strength_label: toText(allRow?.provenanceStrengthLabel || '').toLowerCase() || 'absent',
        evidence_quality: evidenceQuality,
        persistence_provenance: mergedPersistenceProvenance,
        reconstruction_confidence: mergedReconstructionConfidence,
        reconstruction_warnings: mergedReconstructionWarnings.length
          ? JSON.stringify(mergedReconstructionWarnings)
          : null,
        first_live_captured_at: mergedLiveCaptureMeta.firstLiveCapturedAt || null,
        last_live_captured_at: mergedLiveCaptureMeta.lastLiveCapturedAt || null,
        live_capture_count: Math.max(0, Number(mergedLiveCaptureMeta.liveCaptureCount || 0)),
        advisory_only: 1,
      };

      upsert.run(params);
      if (existed) {
        updated += 1;
        const priorProvenance = normalizePersistenceProvenance(existed?.persistence_provenance || 'live_captured');
        if (priorProvenance !== 'mixed' && mergedPersistenceProvenance === 'mixed') promotedToMixed += 1;
        if (priorProvenance !== 'live_captured' && mergedPersistenceProvenance === 'live_captured') {
          promotedToLiveCaptured += 1;
        }
      } else {
        inserted += 1;
      }
    }
  });
  tx();

  return {
    appended: inserted + updated,
    inserted,
    updated,
    promotedToMixed,
    promotedToLiveCaptured,
    snapshotDate,
    windowSessions,
    performanceSource,
  };
}

function emptyRow(regimeLabel = 'unknown') {
  const safe = safeCanonicalRegimeLabel(regimeLabel);
  return {
    regimeLabel: safe,
    totalSnapshots: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    latestPromotionState: 'no_live_support',
    latestPromotionReason: `No historical snapshots yet for ${safe}.`,
    consecutiveQualifiedWindows: 0,
    consecutiveWeakWindows: 0,
    recoveryCount: 0,
    decayCount: 0,
    liveConfirmedTenureDays: 0,
    latestStateTransition: null,
    currentStateTenureDays: 0,
    liveCapturedTenureDays: 0,
    firstLiveCapturedAt: null,
    lastLiveCapturedAt: null,
    liveCapturedSnapshotCount: 0,
    hasLiveCapturedHistory: false,
    latestPersistenceProvenance: 'live_captured',
    latestReconstructionConfidence: 'high',
    latestReconstructionWarnings: [],
    provenanceBreakdown: {
      liveCapturedDays: 0,
      reconstructedDays: 0,
      mixedDays: 0,
    },
    hasRealPersistenceHistory: false,
    warnings: ['insufficient_history'],
    advisoryOnly: true,
  };
}

function buildByRegimeRows(rows = []) {
  const groups = new Map();
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) groups.set(regimeLabel, []);
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const label = safeCanonicalRegimeLabel(row?.regime_label || row?.regimeLabel || 'unknown');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => normalizeDate(a?.snapshot_date || '').localeCompare(normalizeDate(b?.snapshot_date || '')));
  }

  const out = [];
  for (const regimeLabel of SUPPORTED_REGIME_LABELS) {
    const list = groups.get(regimeLabel) || [];
    if (!list.length) {
      out.push(emptyRow(regimeLabel));
      continue;
    }

    const first = list[0];
    const latest = list[list.length - 1];
    const totalSnapshots = list.length;
    let liveCapturedDays = 0;
    let reconstructedDays = 0;
    let mixedDays = 0;
    let liveCapturedSnapshotCount = 0;
    let firstLiveCapturedAt = null;
    let lastLiveCapturedAt = null;
    for (const row of list) {
      const provenance = normalizePersistenceProvenance(row?.persistence_provenance || 'live_captured');
      if (provenance === 'live_captured') liveCapturedDays += 1;
      else if (provenance === 'reconstructed_from_historical_sources') reconstructedDays += 1;
      else mixedDays += 1;
      if (rowHasLiveCapturedEvidence(row)) {
        liveCapturedSnapshotCount += 1;
        const rowFirstLive = normalizeDate(row?.first_live_captured_at || row?.firstLiveCapturedAt || '');
        const rowLastLive = normalizeDate(row?.last_live_captured_at || row?.lastLiveCapturedAt || '');
        const fallbackDate = normalizeDate(row?.snapshot_date || row?.snapshotDate || '');
        firstLiveCapturedAt = earlierDateIso(firstLiveCapturedAt, rowFirstLive || fallbackDate);
        lastLiveCapturedAt = laterDateIso(lastLiveCapturedAt, rowLastLive || fallbackDate);
      }
    }
    let consecutiveQualifiedWindows = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (isQualifiedWindow(list[i])) consecutiveQualifiedWindows += 1;
      else break;
    }
    let consecutiveWeakWindows = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (isWeakWindow(list[i])) consecutiveWeakWindows += 1;
      else break;
    }
    let liveConfirmedTenureDays = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (normalizePromotionState(list[i]?.promotion_state || '') === 'live_confirmed') liveConfirmedTenureDays += 1;
      else break;
    }
    let currentStateTenureDays = 0;
    const latestState = normalizePromotionState(latest?.promotion_state || 'no_live_support');
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (normalizePromotionState(list[i]?.promotion_state || 'no_live_support') === latestState) currentStateTenureDays += 1;
      else break;
    }
    let liveCapturedTenureDays = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (rowHasLiveCapturedEvidence(list[i])) liveCapturedTenureDays += 1;
      else break;
    }

    let recoveryCount = 0;
    let decayCount = 0;
    let latestStateTransition = null;
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const curr = list[i];
      const prevQualified = isQualifiedWindow(prev);
      const currQualified = isQualifiedWindow(curr);
      const prevWeak = isWeakWindow(prev);
      const currWeak = isWeakWindow(curr);
      const prevState = normalizePromotionState(prev?.promotion_state || 'no_live_support');
      const currState = normalizePromotionState(curr?.promotion_state || 'no_live_support');
      if (prevWeak && currQualified) {
        recoveryCount += 1;
        latestStateTransition = {
          type: 'recovery',
          from: prevState,
          to: currState,
          date: normalizeDate(curr?.snapshot_date || ''),
        };
      } else if (prevQualified && currWeak) {
        decayCount += 1;
        latestStateTransition = {
          type: 'decay',
          from: prevState,
          to: currState,
          date: normalizeDate(curr?.snapshot_date || ''),
        };
      } else if (prevState !== currState) {
        latestStateTransition = {
          type: 'state_shift',
          from: prevState,
          to: currState,
          date: normalizeDate(curr?.snapshot_date || ''),
        };
      }
    }

    const warnings = [];
    if (totalSnapshots < 2) warnings.push('insufficient_history');
    if (totalSnapshots < 5) warnings.push('thin_history');
    if (consecutiveWeakWindows > 0) warnings.push('recent_weak_streak');
    if (decayCount > recoveryCount) warnings.push('decay_dominant_history');
    if (recoveryCount > 0 && decayCount === 0) warnings.push('recovering_history');
    if (reconstructedDays > 0 && liveCapturedDays === 0 && mixedDays === 0) warnings.push('reconstructed_history_only');
    if (mixedDays > 0 || (reconstructedDays > 0 && liveCapturedDays > 0)) warnings.push('mixed_history_provenance');
    if (liveCapturedDays > 0 && reconstructedDays === 0 && mixedDays === 0) warnings.push('live_captured_history_only');
    if (liveCapturedSnapshotCount <= 0) warnings.push('no_live_captured_history');

    const latestPersistenceProvenance = normalizePersistenceProvenance(latest?.persistence_provenance || 'live_captured');
    const latestReconstructionConfidence = normalizeReconstructionConfidence(
      latest?.reconstruction_confidence || (latestPersistenceProvenance === 'live_captured' ? 'high' : 'medium')
    );
    const latestReconstructionWarnings = parseWarningsArray(latest?.reconstruction_warnings);

    out.push({
      regimeLabel,
      totalSnapshots,
      firstSeenAt: normalizeDate(first?.snapshot_date || '') || null,
      lastSeenAt: normalizeDate(latest?.snapshot_date || '') || null,
      latestPromotionState: latestState,
      latestPromotionReason: toText(latest?.promotion_reason || '') || null,
      consecutiveQualifiedWindows,
      consecutiveWeakWindows,
      recoveryCount,
      decayCount,
      liveConfirmedTenureDays,
      latestStateTransition,
      currentStateTenureDays,
      liveCapturedTenureDays,
      firstLiveCapturedAt: firstLiveCapturedAt || null,
      lastLiveCapturedAt: lastLiveCapturedAt || null,
      liveCapturedSnapshotCount,
      hasLiveCapturedHistory: liveCapturedSnapshotCount > 0,
      latestPersistenceProvenance,
      latestReconstructionConfidence,
      latestReconstructionWarnings,
      provenanceBreakdown: {
        liveCapturedDays,
        reconstructedDays,
        mixedDays,
      },
      hasRealPersistenceHistory: totalSnapshots >= 2,
      warnings: Array.from(new Set(warnings)),
      advisoryOnly: true,
    });
  }
  return out;
}

function buildHistoryProvenanceBreakdown(rows = []) {
  const grouped = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const date = normalizeDate(row?.snapshot_date || '');
    if (!date) continue;
    if (!grouped.has(date)) {
      grouped.set(date, {
        hasLive: false,
        hasReconstructed: false,
        hasMixed: false,
      });
    }
    const bucket = grouped.get(date);
    const provenance = normalizePersistenceProvenance(row?.persistence_provenance || 'live_captured');
    if (provenance === 'live_captured') bucket.hasLive = true;
    else if (provenance === 'reconstructed_from_historical_sources') bucket.hasReconstructed = true;
    else bucket.hasMixed = true;
  }

  let liveCapturedDays = 0;
  let reconstructedDays = 0;
  let mixedDays = 0;
  for (const meta of grouped.values()) {
    if (meta.hasMixed || (meta.hasLive && meta.hasReconstructed)) mixedDays += 1;
    else if (meta.hasLive) liveCapturedDays += 1;
    else if (meta.hasReconstructed) reconstructedDays += 1;
  }

  return {
    liveCapturedDays,
    reconstructedDays,
    mixedDays,
  };
}

function buildRegimeConfirmationHistorySummary(input = {}) {
  const db = input.db;
  const windowSessions = clampInt(
    input.windowSessions,
    MIN_WINDOW_SESSIONS,
    MAX_WINDOW_SESSIONS,
    DEFAULT_WINDOW_SESSIONS
  );
  const performanceSource = normalizePerformanceSource(input.performanceSource || input.source || 'all');
  const currentRegimeLabel = safeCanonicalRegimeLabel(
    input.currentRegimeLabel
      || input?.liveRegimeConfirmation?.currentRegimeLabel
      || input?.regimeTrustConsumption?.currentRegimeLabel
      || input?.regimeEvidenceSplit?.currentRegimeLabel
      || 'unknown'
  );

  if (!db || typeof db.prepare !== 'function') {
    const byRegime = SUPPORTED_REGIME_LABELS.map((label) => emptyRow(label));
    const current = findByRegime(byRegime, currentRegimeLabel) || emptyRow(currentRegimeLabel);
    return {
      generatedAt: new Date().toISOString(),
      windowSessions,
      performanceSource,
      currentRegimeLabel,
      historyCoverageDays: 0,
      currentRegimeTenureDays: current.currentStateTenureDays,
      currentRegimeConsecutiveQualifiedWindows: current.consecutiveQualifiedWindows,
      currentRegimeConsecutiveWeakWindows: current.consecutiveWeakWindows,
      currentRegimeRecoveryCount: current.recoveryCount,
      currentRegimeLastStateTransition: current.latestStateTransition,
      currentRegimeHasRealPersistenceHistory: false,
      currentRegimeHasLiveCapturedHistory: false,
      currentRegimeLiveCapturedTenureDays: 0,
      currentRegimeLastLiveCapturedDate: null,
      historyProvenanceBreakdown: {
        liveCapturedDays: 0,
        reconstructedDays: 0,
        mixedDays: 0,
      },
      currentRegimeHistoryProvenance: current.provenanceBreakdown,
      byRegime,
      advisoryOnly: true,
    };
  }

  ensureRegimeConfirmationHistoryTables(db);
  const dateRows = db.prepare(`
    SELECT DISTINCT snapshot_date
    FROM jarvis_regime_confirmation_history
    WHERE performance_source = ?
      AND window_sessions = ?
    ORDER BY snapshot_date DESC
    LIMIT ?
  `).all(performanceSource, windowSessions, windowSessions);
  const dates = dateRows.map((row) => normalizeDate(row.snapshot_date)).filter(Boolean);

  let rows = [];
  if (dates.length) {
    const placeholders = dates.map(() => '?').join(', ');
    rows = db.prepare(`
      SELECT *
      FROM jarvis_regime_confirmation_history
      WHERE performance_source = ?
        AND window_sessions = ?
        AND snapshot_date IN (${placeholders})
      ORDER BY snapshot_date ASC, regime_label ASC
    `).all(performanceSource, windowSessions, ...dates);
  }

  const byRegime = buildByRegimeRows(rows);
  const current = findByRegime(byRegime, currentRegimeLabel) || emptyRow(currentRegimeLabel);
  const minDate = dates.length ? dates[dates.length - 1] : null;
  const maxDate = dates.length ? dates[0] : null;
  const historyCoverageDays = dates.length ? daysDiffInclusive(minDate, maxDate) : 0;
  const historyProvenanceBreakdown = buildHistoryProvenanceBreakdown(rows);

  return {
    generatedAt: new Date().toISOString(),
    windowSessions,
    performanceSource,
    currentRegimeLabel,
    historyCoverageDays,
    currentRegimeTenureDays: Number(current.currentStateTenureDays || 0),
    currentRegimeConsecutiveQualifiedWindows: Number(current.consecutiveQualifiedWindows || 0),
    currentRegimeConsecutiveWeakWindows: Number(current.consecutiveWeakWindows || 0),
    currentRegimeRecoveryCount: Number(current.recoveryCount || 0),
    currentRegimeLastStateTransition: current.latestStateTransition || null,
    currentRegimeHasRealPersistenceHistory: current.hasRealPersistenceHistory === true,
    currentRegimeHasLiveCapturedHistory: current.hasLiveCapturedHistory === true,
    currentRegimeLiveCapturedTenureDays: Number(current.liveCapturedTenureDays || 0),
    currentRegimeLastLiveCapturedDate: normalizeDate(current.lastLiveCapturedAt || '') || null,
    historyProvenanceBreakdown,
    currentRegimeHistoryProvenance: current.provenanceBreakdown || {
      liveCapturedDays: 0,
      reconstructedDays: 0,
      mixedDays: 0,
    },
    byRegime,
    advisoryOnly: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_SESSIONS,
  MIN_WINDOW_SESSIONS,
  MAX_WINDOW_SESSIONS,
  ensureRegimeConfirmationHistoryTables,
  appendRegimeConfirmationHistorySnapshot,
  buildRegimeConfirmationHistorySummary,
};
