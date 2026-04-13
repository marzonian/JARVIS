#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const { getDB } = require('../server/db/database');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  runNextNaturalDayReadinessWatchdogMonitor,
} = require('../server/jarvis-core/preferred-owner-next-natural-day-readiness-watchdog');

function parseArg(args, key, fallback = null) {
  const withEquals = args.find((arg) => arg.startsWith(`${key}=`));
  if (withEquals) return withEquals.slice(key.length + 1);
  const idx = args.indexOf(key);
  if (idx >= 0 && typeof args[idx + 1] === 'string' && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return fallback;
}

function parseBool(value, fallback = true) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function main() {
  const argv = process.argv.slice(2);
  const baselineDate = parseArg(argv, '--baselineDate', '2026-03-13');
  const pretty = parseBool(parseArg(argv, '--pretty', '1'), true);

  const db = getDB();
  ensureDataFoundationTables(db);

  const monitor = runNextNaturalDayReadinessWatchdogMonitor({
    db,
    baselineDate,
    nowTs: new Date().toISOString(),
  });

  const stateRow = monitor?.watchdogStateRow || monitor?.latestWatchdogStateRow || null;
  const terminalAlertRow = monitor?.watchdogTerminalAlertRow || monitor?.latestWatchdogTerminalAlertRow || null;
  const readiness = monitor?.readiness && typeof monitor.readiness === 'object'
    ? monitor.readiness
    : {};

  const report = {
    baselineDate: monitor?.baselineDate || baselineDate,
    nextTargetDay: monitor?.targetTradingDay || null,
    currentBoundedResult: monitor?.result || 'next_natural_day_not_in_data_yet',
    firstMissingLayer: monitor?.firstMissingLayer || 'none',
    systemWaitingOrBroken: monitor?.actuallyBrokenOnNextDay === true ? 'broken' : 'waiting',
    nextNaturalDayDiscoveredInPersistedData: monitor?.nextNaturalDayDiscoveredInPersistedData === true,
    terminalAlertAlreadyEmitted: monitor?.alertEmitted === true,
    terminalAlertEmittedForDiscoveredDay: monitor?.terminalAlertEmittedForDiscoveredDay === true,
    exactRowsUsedToJustifyState: {
      watchdogStateRow: stateRow,
      watchdogTerminalAlertRow: terminalAlertRow,
      dailyScoringRunForTargetDay: readiness?.runDetails?.latestScoringRun || null,
      ownershipRowForTargetDay: readiness?.runDetails?.ownership || null,
      preferredOwnerProofRowForTargetDay: readiness?.runDetails?.preferredOwnerProof || null,
      verifierRowForTargetDay: readiness?.runDetails?.verifier || null,
      naturalWinRowForTargetDay: readiness?.runDetails?.naturalWin || null,
      deferralRowForTargetDay: readiness?.runDetails?.deferral || null,
      operationalVerdictRowForTargetDay: readiness?.runDetails?.operationalVerdict || null,
      operationalProofBundleRowForTargetDay: readiness?.runDetails?.proofBundle || null,
      naturalDrillWatcherRowForTargetDay: readiness?.runDetails?.watcher || null,
    },
  };

  if (pretty) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify(report));
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    status: 'error',
    error: error?.message || 'preferred_owner_next_natural_day_watchdog_monitor_failed',
  }, null, 2));
  process.exitCode = 1;
}
