#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const { getDB } = require('../server/db/database');
const { ensureDataFoundationTables } = require('../server/jarvis-core/data-foundation-storage');
const {
  buildPreferredOwnerMonitorSummary,
} = require('../server/jarvis-core/preferred-owner-monitor');

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
  const key = String(value || '').trim().toLowerCase();
  if (!key) return fallback;
  return key === '1' || key === 'true' || key === 'yes';
}

function main() {
  const argv = process.argv.slice(2);
  const nowDate = parseArg(argv, '--nowDate', null);
  const pretty = parseBool(parseArg(argv, '--pretty', '1'), true);

  const db = getDB();
  ensureDataFoundationTables(db);
  const monitor = buildPreferredOwnerMonitorSummary({
    db,
    nowDate: nowDate || undefined,
  });
  const operatorSnapshot = (
    monitor?.livePreferredOwnerOperatorSnapshot
    && typeof monitor.livePreferredOwnerOperatorSnapshot === 'object'
  )
    ? monitor.livePreferredOwnerOperatorSnapshot
    : null;

  const report = {
    livePreferredOwnerOperatorSnapshot: operatorSnapshot,
    latestTargetTradingDay: operatorSnapshot?.targetTradingDay || monitor.livePreferredOwnerMonitorLatestTargetTradingDay || null,
    latestSummaryLabel: operatorSnapshot?.monitorSummaryLabel || monitor.livePreferredOwnerMonitorLatestSummaryLabel || 'healthy_waiting_next_day',
    latestRunOrigin: operatorSnapshot?.runOrigin || monitor.livePreferredOwnerMonitorLatestRunOrigin || 'manual',
    latestRuntimeSource: operatorSnapshot?.runtimeSource || monitor.livePreferredOwnerMonitorLatestRuntimeSource || 'manual_api_run',
    latestOwnershipSourceSpecificOutcome: (
      operatorSnapshot?.ownershipSourceSpecificOutcome
      || monitor.livePreferredOwnerMonitorLatestOwnershipSourceSpecificOutcome
      || 'ownership_source_unknown'
    ),
    latestVerifierStatus: operatorSnapshot?.verifierStatus || monitor.livePreferredOwnerMonitorLatestVerifierStatus || 'missing',
    latestVerifierPass: operatorSnapshot ? operatorSnapshot.verifierPass === true : monitor.livePreferredOwnerMonitorLatestVerifierPass === true,
    latestWatcherStatus: operatorSnapshot?.watcherStatus || monitor.livePreferredOwnerMonitorLatestWatcherStatus || 'waiting_for_resolution',
    latestWatcherExecuted: operatorSnapshot ? operatorSnapshot.watcherExecuted === true : monitor.livePreferredOwnerMonitorLatestWatcherExecuted === true,
    latestProofBundleStatus: operatorSnapshot?.proofBundleStatus || monitor.livePreferredOwnerMonitorLatestProofBundleStatus || 'missing',
    latestProofBundlePass: operatorSnapshot ? operatorSnapshot.proofBundlePass === true : monitor.livePreferredOwnerMonitorLatestProofBundlePass === true,
    counters5d: {
      naturalPreferredOwnerWinsLast5d: Number(monitor.naturalPreferredOwnerWinsLast5d || 0),
      naturalPreferredOwnerWinsTotal: Number(monitor.naturalPreferredOwnerWinsTotal || 0),
      naturalPreferredOwnerVerifierPassesLast5d: Number(
        monitor.naturalPreferredOwnerVerifierPassesLast5d || 0
      ),
      naturalPreferredOwnerVerifierFailsLast5d: Number(
        monitor.naturalPreferredOwnerVerifierFailsLast5d || 0
      ),
      lastNaturalPreferredOwnerWinDay: monitor.lastNaturalPreferredOwnerWinDay || null,
    },
    consistency: {
      livePreferredOwnerMonitorConsistent: monitor.livePreferredOwnerMonitorConsistent !== false,
      livePreferredOwnerMonitorMismatchReasons: Array.isArray(
        monitor.livePreferredOwnerMonitorMismatchReasons
      )
        ? monitor.livePreferredOwnerMonitorMismatchReasons
        : [],
    },
    advisoryOnly: true,
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
    error: error?.message || 'preferred_owner_monitor_failed',
  }, null, 2));
  process.exitCode = 1;
}
