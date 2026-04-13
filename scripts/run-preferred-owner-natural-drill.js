#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const { getDB } = require('../server/db/database');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  runPreferredOwnerNaturalDrill,
  readPreferredOwnerPostCloseVerifierRow,
  readPreferredOwnerNaturalWinRow,
  countPreferredOwnerDeferralsByTargetDay,
  readPreferredOwnerOperationalVerdictRow,
  readPreferredOwnerOperationalProofBundleRow,
  readNaturalPreferredOwnerCounterSnapshot,
} = require('../server/jarvis-core/preferred-owner-natural-drill');

function parseBool(argValue, fallback = false) {
  const value = String(argValue || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function parseArg(args, key, fallback = null) {
  const withEquals = args.find((arg) => arg.startsWith(`${key}=`));
  if (withEquals) return withEquals.slice(key.length + 1);
  const idx = args.indexOf(key);
  if (idx >= 0 && typeof args[idx + 1] === 'string' && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return fallback;
}

function loadAllSessionsFromDb(db) {
  if (!db || typeof db.prepare !== 'function') return {};
  const rows = db.prepare(`
    SELECT
      s.date AS session_date,
      c.timestamp,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume
    FROM candles c
    JOIN sessions s ON s.id = c.session_id
    WHERE c.timeframe = '5m'
    ORDER BY s.date ASC, c.timestamp ASC
  `).all();
  const out = {};
  for (const row of rows) {
    const date = String(row.session_date || '').trim();
    if (!date) continue;
    if (!out[date]) out[date] = [];
    const ts = String(row.timestamp || '');
    let datePart = date;
    let timePart = '00:00:00';
    if (ts.includes(' ')) {
      const split = ts.split(' ');
      datePart = split[0] || date;
      timePart = split[1] || '00:00:00';
    } else if (ts.includes('T')) {
      const split = ts.split('T');
      datePart = split[0] || date;
      const trimmed = String(split[1] || '')
        .replace(/Z$/i, '')
        .replace(/[+-]\d{2}:?\d{2}$/i, '');
      timePart = (trimmed || '00:00:00').split('.')[0] || '00:00:00';
    }
    out[date].push({
      timestamp: ts,
      date: datePart,
      time: timePart,
      open: Number(row.open || 0),
      high: Number(row.high || 0),
      low: Number(row.low || 0),
      close: Number(row.close || 0),
      volume: Number(row.volume || 0),
    });
  }
  return out;
}

async function tryFetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function makeCompactReport(drill = {}, commandCenter = null) {
  const targetTradingDay = drill?.checkpoint?.targetTradingDay || drill?.targetTradingDay || null;
  const dbVerifierRow = drill?.verifierRow || null;
  const dbNaturalWinRow = drill?.naturalWinRow || null;
  const dbOperationalVerdictRow = drill?.operationalVerdictRow || null;
  const dbOperationalProofBundleRow = drill?.operationalProofBundleRow || null;
  const deferralCount = Number(drill?.deferralCount || 0);
  const counters = drill?.counters || readNaturalPreferredOwnerCounterSnapshot(null, targetTradingDay);

  return {
    drillOutcome: drill?.drillOutcome || 'resolved_but_bundle_missing_bug',
    checkpoint: {
      targetTradingDay,
      checkpointStatus: drill?.checkpoint?.checkpointStatus || 'waiting_valid',
      checkpointReason: drill?.checkpoint?.checkpointReason || 'unknown_checkpoint_state',
      runtimeCheckpointSource: drill?.checkpoint?.runtimeCheckpointSource || 'manual_api_run',
      runtimeCheckpointWasAutonomous: drill?.checkpoint?.runtimeCheckpointWasAutonomous === true,
    },
    ownership: {
      liveInsertionOwnershipOutcome: drill?.ownership?.liveInsertionOwnershipOutcome || 'target_day_not_inserted_yet',
      liveInsertionOwnershipSourceSpecificOutcome: drill?.ownership?.liveInsertionOwnershipSourceSpecificOutcome || 'ownership_source_unknown',
      preferredOwnerExpectedSource: drill?.ownership?.preferredOwnerExpectedSource || 'close_complete_checkpoint',
      preferredOwnerActualSource: drill?.ownership?.preferredOwnerActualSource || null,
      preferredOwnerWon: drill?.ownership?.preferredOwnerWon === true,
      preferredOwnerFailureReason: drill?.ownership?.preferredOwnerFailureReason || 'none',
    },
    verifier: {
      verifierStatus: drill?.verifier?.verifierStatus || 'fail',
      verifierPass: drill?.verifier?.verifierPass === true,
      verifierFailureReasons: Array.isArray(drill?.verifier?.verifierFailureReasons)
        ? drill.verifier.verifierFailureReasons
        : [],
      verifierRunOrigin: drill?.verifier?.verifierRunOrigin || 'manual',
      verifierResolvedNaturally: drill?.verifier?.verifierResolvedNaturally === true,
      verifierVerifiedAt: drill?.verifier?.verifierVerifiedAt || null,
    },
    operationalArtifacts: {
      naturalWinRowCreated: drill?.operationalArtifacts?.naturalWinRowCreated === true,
      deferralRowCreated: drill?.operationalArtifacts?.deferralRowCreated === true,
      operationalVerdictRowCreated: drill?.operationalArtifacts?.operationalVerdictRowCreated === true,
      operationalProofBundleRowCreated: drill?.operationalArtifacts?.operationalProofBundleRowCreated === true,
      proofBundleCapturedThisRun: drill?.operationalArtifacts?.proofBundleCapturedThisRun === true,
      proofBundleSkipReason: drill?.operationalArtifacts?.proofBundleSkipReason || null,
    },
    counters: {
      naturalPreferredOwnerWinsLast5d: Number(counters.naturalPreferredOwnerWinsLast5d || 0),
      naturalPreferredOwnerWinsTotal: Number(counters.naturalPreferredOwnerWinsTotal || 0),
      naturalPreferredOwnerVerifierPassesLast5d: Number(counters.naturalPreferredOwnerVerifierPassesLast5d || 0),
      naturalPreferredOwnerVerifierFailsLast5d: Number(counters.naturalPreferredOwnerVerifierFailsLast5d || 0),
      lastNaturalPreferredOwnerWinDay: counters.lastNaturalPreferredOwnerWinDay || null,
    },
    persistedRows: {
      verifierRow: dbVerifierRow,
      naturalWinRow: dbNaturalWinRow,
      deferralCount,
      operationalVerdictRow: dbOperationalVerdictRow,
      operationalProofBundleRow: dbOperationalProofBundleRow,
    },
    commandCenter: commandCenter?.commandCenter && typeof commandCenter.commandCenter === 'object'
      ? {
        liveInsertionOwnershipSourceSpecificOutcome: commandCenter.commandCenter.liveInsertionOwnershipSourceSpecificOutcome || null,
        naturalPreferredOwnerWinsLast5d: Number(commandCenter.commandCenter.naturalPreferredOwnerWinsLast5d || 0),
        naturalPreferredOwnerWinsTotal: Number(commandCenter.commandCenter.naturalPreferredOwnerWinsTotal || 0),
        naturalPreferredOwnerVerifierPassesLast5d: Number(commandCenter.commandCenter.naturalPreferredOwnerVerifierPassesLast5d || 0),
        naturalPreferredOwnerVerifierFailsLast5d: Number(commandCenter.commandCenter.naturalPreferredOwnerVerifierFailsLast5d || 0),
        lastNaturalPreferredOwnerWinDay: commandCenter.commandCenter.lastNaturalPreferredOwnerWinDay || null,
      }
      : null,
    advisoryOnly: true,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const nowDate = parseArg(argv, '--nowDate', null);
  const nowTime = parseArg(argv, '--nowTime', null);
  const force = parseBool(parseArg(argv, '--force', '0'), false);
  const windowDays = Number(parseArg(argv, '--windowDays', '5')) || 5;
  const liveBridgeLookbackDays = Number(parseArg(argv, '--liveBridgeLookbackDays', '21')) || 21;
  const baseUrl = parseArg(argv, '--baseUrl', 'http://127.0.0.1:3131');
  const printPretty = parseBool(parseArg(argv, '--pretty', '1'), true);

  const db = getDB();
  ensureDataFoundationTables(db);
  const sessions = loadAllSessionsFromDb(db);
  const drill = runPreferredOwnerNaturalDrill({
    db,
    sessions,
    nowDate: nowDate || undefined,
    nowTime: nowTime || undefined,
    force,
    windowDays,
    liveBridgeLookbackDays,
  });

  const targetTradingDay = drill?.checkpoint?.targetTradingDay || drill?.targetTradingDay || null;
  const verifierRow = readPreferredOwnerPostCloseVerifierRow(db, targetTradingDay);
  const naturalWinRow = readPreferredOwnerNaturalWinRow(db, targetTradingDay);
  const deferralCount = countPreferredOwnerDeferralsByTargetDay(db, targetTradingDay);
  const operationalVerdictRow = readPreferredOwnerOperationalVerdictRow(db, targetTradingDay);
  const operationalProofBundleRow = readPreferredOwnerOperationalProofBundleRow(db, targetTradingDay);
  const counters = readNaturalPreferredOwnerCounterSnapshot(db, targetTradingDay || nowDate || '');

  drill.verifierRow = verifierRow;
  drill.naturalWinRow = naturalWinRow;
  drill.deferralCount = deferralCount;
  drill.operationalVerdictRow = operationalVerdictRow;
  drill.operationalProofBundleRow = operationalProofBundleRow;
  drill.counters = counters;

  const commandCenter = await tryFetchJson(
    `${baseUrl}/api/jarvis/command-center?windowSessions=120&performanceSource=all&force=1`
  );
  const dailyScoringStatus = await tryFetchJson(
    `${baseUrl}/api/jarvis/evidence/daily-scoring?windowDays=${encodeURIComponent(String(windowDays))}&force=1`
  );

  const report = makeCompactReport(drill, commandCenter);
  report.dailyScoringStatus = dailyScoringStatus?.dailyEvidenceScoringStatus
    && typeof dailyScoringStatus.dailyEvidenceScoringStatus === 'object'
    ? {
      liveCheckpointStatus: dailyScoringStatus.dailyEvidenceScoringStatus.liveCheckpointStatus
        || dailyScoringStatus.dailyEvidenceScoringStatus.liveCheckpoint?.checkpointStatus
        || null,
      liveCheckpointReason: dailyScoringStatus.dailyEvidenceScoringStatus.liveCheckpointReason
        || dailyScoringStatus.dailyEvidenceScoringStatus.liveCheckpoint?.checkpointReason
        || null,
      liveInsertionOwnershipSourceSpecificOutcome: dailyScoringStatus.dailyEvidenceScoringStatus.liveInsertionOwnershipSourceSpecificOutcome || null,
      livePreferredOwnerPostCloseProofVerifierStatus: dailyScoringStatus.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierStatus || null,
      livePreferredOwnerPostCloseProofVerifierPass: dailyScoringStatus.dailyEvidenceScoringStatus.livePreferredOwnerPostCloseProofVerifierPass === true,
      livePreferredOwnerOperationalProofBundleTargetTradingDay: dailyScoringStatus.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleTargetTradingDay || null,
      livePreferredOwnerOperationalProofBundleVerifierStatus: dailyScoringStatus.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierStatus || null,
      livePreferredOwnerOperationalProofBundleVerifierPass: dailyScoringStatus.dailyEvidenceScoringStatus.livePreferredOwnerOperationalProofBundleVerifierPass === true,
    }
    : null;

  if (printPretty) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify(report));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    status: 'error',
    error: err?.message || 'preferred_owner_natural_drill_failed',
  }, null, 2));
  process.exitCode = 1;
});
