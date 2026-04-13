'use strict';

const {
  SOURCE_BACKFILL,
  PHASE_PRE_ORB,
  VERSION_BACKFILL,
} = require('./recommendation-outcome');

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
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

function listSessionDates(sessions = {}) {
  return Object.keys(sessions || {})
    .map((d) => normalizeDate(d))
    .filter(Boolean)
    .sort();
}

function buildSessionSubset(sessions = {}, cutoffDate = '') {
  const out = {};
  const cutoff = normalizeDate(cutoffDate);
  for (const date of listSessionDates(sessions)) {
    if (cutoff && date >= cutoff) break;
    out[date] = Array.isArray(sessions[date]) ? sessions[date] : [];
  }
  return out;
}

async function runRecommendationBackfill(input = {}) {
  const db = input.db;
  const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  const sourceType = SOURCE_BACKFILL;
  const reconstructionPhase = toText(input.reconstructionPhase || PHASE_PRE_ORB) || PHASE_PRE_ORB;
  const reconstructionVersion = toText(input.reconstructionVersion || VERSION_BACKFILL) || VERSION_BACKFILL;
  const force = input.force === true;
  const windowSessions = clampInt(input.windowSessions, 20, 500, 90);

  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'error',
      error: 'db_unavailable',
      processed: 0,
      inserted: 0,
      updated: 0,
      reusedExisting: 0,
      alreadyPresent: 0,
      skipped: 0,
      scored: 0,
      failed: 0,
      warnings: ['db_unavailable'],
      sourceType,
      reconstructionPhase,
      reconstructionVersion,
      windowSessions,
    };
  }

  const requiredFns = [
    'getRecommendationContextRow',
    'upsertTodayRecommendationContext',
    'evaluateRecommendationOutcomeDay',
    'reconstructForDate',
  ];
  const missingFns = requiredFns.filter((key) => typeof deps[key] !== 'function');
  if (missingFns.length) {
    return {
      status: 'error',
      error: 'missing_deps',
      missingDeps: missingFns,
      processed: 0,
      inserted: 0,
      updated: 0,
      reusedExisting: 0,
      alreadyPresent: 0,
      skipped: 0,
      scored: 0,
      failed: 0,
      warnings: [`missing_deps:${missingFns.join(',')}`],
      sourceType,
      reconstructionPhase,
      reconstructionVersion,
      windowSessions,
    };
  }

  const allDates = listSessionDates(sessions);
  const targetDates = allDates.slice(-windowSessions);
  const warnings = [];
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let reusedExisting = 0;
  let alreadyPresent = 0;
  let skipped = 0;
  let scored = 0;
  let failed = 0;

  for (const date of targetDates) {
    processed += 1;
    try {
      const existing = deps.getRecommendationContextRow(db, {
        recDate: date,
        sourceType,
        reconstructionPhase,
      });
      if (existing) alreadyPresent += 1;
      if (existing && !force) {
        reusedExisting += 1;
        continue;
      }

      const sessionsBeforeDate = buildSessionSubset(sessions, date);
      const reconstruction = await Promise.resolve(deps.reconstructForDate({
        date,
        allDates,
        sessions,
        sessionsBeforeDate,
        reconstructionPhase,
        reconstructionVersion,
        sourceType,
      }));

      if (!reconstruction || typeof reconstruction !== 'object' || !reconstruction.todayRecommendation) {
        skipped += 1;
        warnings.push(`missing_reconstruction:${date}`);
        continue;
      }

      const contextWarnings = Array.isArray(reconstruction.warnings) ? reconstruction.warnings : [];
      const integrity = reconstruction.integrity && typeof reconstruction.integrity === 'object'
        ? reconstruction.integrity
        : {};

      deps.upsertTodayRecommendationContext({
        db,
        recDate: date,
        sourceType,
        reconstructionPhase,
        reconstructionVersion,
        generatedAt: reconstruction.generatedAt || new Date().toISOString(),
        todayRecommendation: reconstruction.todayRecommendation,
        strategyLayers: reconstruction.strategyLayers || {},
        mechanicsResearchSummary: reconstruction.mechanicsResearchSummary || {},
        context: {
          ...(reconstruction.context || {}),
          sourceLabels: {
            sourceType,
            reconstructionPhase,
            reconstructionVersion,
            retrospective: true,
          },
          integrity,
          warnings: contextWarnings,
        },
      });

      if (existing) updated += 1;
      else inserted += 1;

      const contextRow = deps.getRecommendationContextRow(db, {
        recDate: date,
        sourceType,
        reconstructionPhase,
      });

      const dayScore = deps.evaluateRecommendationOutcomeDay({
        db,
        date,
        contextRow,
        sessions,
        strategySnapshot: reconstruction.strategySnapshotForScoring || reconstruction.strategyLayers || {},
        runTradeMechanicsVariantTool: deps.runTradeMechanicsVariantTool,
        sourceType,
        reconstructionPhase,
        reconstructionVersion,
      });
      if (dayScore) scored += 1;

      for (const warning of contextWarnings) {
        warnings.push(`${date}:${toText(warning)}`);
      }
    } catch (err) {
      failed += 1;
      warnings.push(`failed:${date}:${toText(err?.message || 'unknown_error')}`);
    }
  }

  return {
    status: 'ok',
    processed,
    inserted,
    updated,
    reusedExisting,
    alreadyPresent,
    skipped,
    scored,
    failed,
    warnings,
    sourceType,
    reconstructionPhase,
    reconstructionVersion,
    windowSessions,
    forceRebuild: force,
    idempotentReuse: !force && reusedExisting > 0 && inserted === 0 && updated === 0 && scored === 0,
  };
}

module.exports = {
  SOURCE_BACKFILL,
  PHASE_PRE_ORB,
  VERSION_BACKFILL,
  runRecommendationBackfill,
};
