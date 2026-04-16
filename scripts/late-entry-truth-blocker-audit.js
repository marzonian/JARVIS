#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const { getDB } = require('../server/db/database');
const { buildRecommendationPerformance } = require('../server/jarvis-core/recommendation-outcome');

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

function loadSessionsFromDb(db, maxSessions = 2000) {
  const sessionRows = db.prepare(`
    SELECT id, date
    FROM sessions
    WHERE date IS NOT NULL
    ORDER BY date ASC
    LIMIT ?
  `).all(maxSessions);
  const sessionIdToDate = new Map();
  const sessions = {};
  for (const row of sessionRows) {
    const date = String(row?.date || '').trim();
    const sessionId = Number(row?.id || 0);
    if (!date || !Number.isFinite(sessionId) || sessionId <= 0) continue;
    sessionIdToDate.set(sessionId, date);
    sessions[date] = [];
  }
  if (sessionIdToDate.size === 0) return sessions;
  const minSessionId = Math.min(...sessionIdToDate.keys());
  const maxSessionId = Math.max(...sessionIdToDate.keys());
  const candleRows = db.prepare(`
    SELECT session_id, timestamp, open, high, low, close, volume
    FROM candles
    WHERE session_id BETWEEN ? AND ?
    ORDER BY session_id ASC, timestamp ASC
  `).all(minSessionId, maxSessionId);
  for (const row of candleRows) {
    const sessionId = Number(row?.session_id || 0);
    const date = sessionIdToDate.get(sessionId);
    if (!date || !Array.isArray(sessions[date])) continue;
    sessions[date].push({
      timestamp: String(row?.timestamp || ''),
      open: Number(row?.open || 0),
      high: Number(row?.high || 0),
      low: Number(row?.low || 0),
      close: Number(row?.close || 0),
      volume: Number(row?.volume || 0),
    });
  }
  return sessions;
}

function main() {
  const argv = process.argv.slice(2);
  const source = String(parseArg(argv, '--source', 'live') || 'live').trim().toLowerCase();
  const reconstructionPhase = String(parseArg(argv, '--phase', 'live_intraday') || 'live_intraday').trim().toLowerCase();
  const pretty = parseBool(parseArg(argv, '--pretty', '1'), true);
  const quietDbInit = parseBool(parseArg(argv, '--quiet-db-init', '1'), true);
  const maxSessions = Math.max(1, Math.min(5000, Number(parseArg(argv, '--max-sessions', '2000') || 2000)));

  let db = null;
  if (quietDbInit) {
    const originalLog = console.log;
    console.log = () => {};
    try {
      db = getDB();
    } finally {
      console.log = originalLog;
    }
  } else {
    db = getDB();
  }
  const perf = buildRecommendationPerformance({
    db,
    source,
    reconstructionPhase,
    sessions: loadSessionsFromDb(db, maxSessions),
    maxRecords: 500,
  });
  const summary = perf?.summary && typeof perf.summary === 'object' ? perf.summary : {};

  const report = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    source,
    reconstructionPhase,
    lateEntryPolicyTruthFinalizationQueue: summary.lateEntryPolicyTruthFinalizationQueue || null,
    lateEntryPolicyTruthBlockerDiagnostics: summary.lateEntryPolicyTruthBlockerDiagnostics || null,
    lateEntryPolicyTruthBlockerAudit: summary.lateEntryPolicyTruthBlockerAudit || null,
    lateEntryPolicyTruthRepairPlanner: summary.lateEntryPolicyTruthRepairPlanner || null,
    lines: {
      queue: summary.lateEntryPolicyTruthFinalizationQueueLine || null,
      blockerDiagnostics: summary.lateEntryPolicyTruthBlockerDiagnosticsLine || null,
      blockerAudit: summary.lateEntryPolicyTruthBlockerAuditLine || null,
      repairPlanner: summary.lateEntryPolicyTruthRepairPlannerLine || null,
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
    error: error?.message || 'late_entry_truth_blocker_audit_failed',
  }, null, 2));
  process.exitCode = 1;
}
