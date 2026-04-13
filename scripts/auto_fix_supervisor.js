#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'mcnair.db');
const BASE_URL = process.env.AUTO_FIX_BASE_URL || process.env.SIGNAL_BASE_URL || 'http://localhost:3131';
const REQUEST_TIMEOUT_MS = Math.max(2500, Number(process.env.AUTO_FIX_TIMEOUT_MS || 6000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTO_FIX_MAX_ATTEMPTS || 2));
const SERVER_LABEL = process.env.AUTO_FIX_SERVER_LABEL || 'ai.3130.server';
const TRIGGER_SOURCE = String(process.env.AUTO_FIX_TRIGGER || 'scheduler');
const LOG_HEALTHY = process.env.AUTO_FIX_LOG_HEALTHY === '1';
const STARTUP_GRACE_RETRIES = Math.max(0, Number(process.env.AUTO_FIX_GRACE_RETRIES || 3));
const STARTUP_GRACE_DELAY_MS = Math.max(200, Number(process.env.AUTO_FIX_GRACE_DELAY_MS || 1200));

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailText(input, max = 500) {
  const txt = String(input || '').trim();
  if (txt.length <= max) return txt;
  return txt.slice(-max);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDB() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_heal_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_source      TEXT NOT NULL DEFAULT 'scheduler',
      status              TEXT NOT NULL CHECK(status IN ('ok', 'remediated', 'failed')),
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      issues_json         TEXT NOT NULL DEFAULT '[]',
      actions_json        TEXT NOT NULL DEFAULT '[]',
      details_json        TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_self_heal_events_created ON self_heal_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_self_heal_events_status ON self_heal_events(status, created_at DESC);
  `);
  return db;
}

function logEvent(event = {}) {
  const db = getDB();
  try {
    db.prepare(`
      INSERT INTO self_heal_events (
        trigger_source, status, attempt_count, issues_json, actions_json, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      String(event.triggerSource || TRIGGER_SOURCE),
      String(event.status || 'failed'),
      Number(event.attemptCount || 0),
      JSON.stringify(Array.isArray(event.issues) ? event.issues : []),
      JSON.stringify(Array.isArray(event.actions) ? event.actions : []),
      JSON.stringify(event.details || {})
    );
  } finally {
    db.close();
  }
}

function runCmd(label, command, timeoutMs = 120000) {
  const startedAt = nowIso();
  try {
    const output = execSync(command, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: '/bin/zsh',
    });
    return {
      label,
      command,
      ok: true,
      startedAt,
      finishedAt: nowIso(),
      output: tailText(output, 800),
    };
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : '';
    const stderr = err?.stderr ? String(err.stderr) : '';
    return {
      label,
      command,
      ok: false,
      startedAt,
      finishedAt: nowIso(),
      output: tailText(`${stdout}\n${stderr}`, 1200),
      error: tailText(err?.message || 'command failed', 400),
    };
  }
}

async function fetchJson(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const txt = await res.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
  return json;
}

async function probeSystem() {
  const checks = [
    {
      key: 'health',
      path: '/api/health',
      isValid: (j) => ['ok', 'degraded'].includes(String(j?.status || '').toLowerCase()),
    },
    {
      key: 'snapshot',
      path: '/api/command/snapshot?strategy=original',
      isValid: (j) => ['ok', 'no_data'].includes(String(j?.status || '').toLowerCase()),
    },
    {
      key: 'intelligence',
      path: '/api/intelligence/unified?limit=1',
      isValid: (j) => String(j?.status || '').toLowerCase() === 'ok',
    },
    {
      key: 'logic_guard',
      path: '/api/system/logic-guard/status',
      isValid: (j) => String(j?.status || '').toLowerCase() === 'ok' && !!j?.summary,
    },
    {
      key: 'boundary_summary',
      path: '/api/system/boundary/summary',
      isValid: (j) => String(j?.status || '').toLowerCase() === 'ok' && !!j?.summary?.directive && !!j?.summary?.line,
    },
  ];
  const issues = [];
  const results = [];
  for (const check of checks) {
    const item = { key: check.key, path: check.path, ok: false };
    try {
      const json = await fetchJson(check.path);
      item.ok = !!check.isValid(json);
      item.status = json?.status || null;
      if (!item.ok) {
        issues.push({
          key: check.key,
          path: check.path,
          reason: `unexpected_status:${item.status}`,
        });
      }
    } catch (err) {
      item.ok = false;
      item.error = tailText(err.message || 'probe failed', 240);
      issues.push({
        key: check.key,
        path: check.path,
        reason: item.error,
      });
    }
    results.push(item);
  }
  return {
    ok: issues.length === 0,
    issues,
    results,
  };
}

function kickstartServerAction() {
  if (process.platform !== 'darwin') {
    return {
      label: 'kickstart_server',
      command: 'skip_non_darwin',
      ok: true,
      output: 'Skipped: non-macOS runtime',
    };
  }
  const uid = process.getuid ? process.getuid() : null;
  if (uid == null) {
    return {
      label: 'kickstart_server',
      command: 'skip_no_uid',
      ok: false,
      error: 'Unable to determine UID for launchctl kickstart',
    };
  }
  return runCmd('kickstart_server', `launchctl kickstart -k gui/${uid}/${SERVER_LABEL}`, 45000);
}

function remediationPlan(attempt) {
  if (attempt === 1) {
    return [
      () => runCmd('runtime_enforce', 'zsh scripts/runtime-manager.sh enforce', 180000),
      () => kickstartServerAction(),
      () => runCmd('pm2_resurrect', 'pm2 resurrect', 45000),
    ];
  }
  return [
    () => runCmd('preflight', 'npm run preflight', 120000),
    () => kickstartServerAction(),
    () => runCmd('stability_quick', 'ROUNDS=3 npm run test:stability', 180000),
  ];
}

function writeIncidentFile(payload) {
  ensureDataDir();
  const stamp = nowIso().replace(/[:.]/g, '-');
  const incidentPath = path.join(DATA_DIR, `auto-fix-incident-${stamp}.json`);
  fs.writeFileSync(incidentPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return incidentPath;
}

async function main() {
  const startedAt = nowIso();
  console.log(`[auto-fix] start ${startedAt}`);
  console.log(`[auto-fix] base=${BASE_URL} trigger=${TRIGGER_SOURCE}`);

  const initial = await probeSystem();
  if (initial.ok) {
    console.log('[auto-fix] probe healthy; no remediation required');
    if (LOG_HEALTHY) {
      logEvent({
        status: 'ok',
        triggerSource: TRIGGER_SOURCE,
        attemptCount: 0,
        issues: [],
        actions: [],
        details: {
          startedAt,
          finishedAt: nowIso(),
          probe: initial.results,
        },
      });
    }
    return;
  }

  for (let graceTry = 1; graceTry <= STARTUP_GRACE_RETRIES; graceTry += 1) {
    console.log(`[auto-fix] grace recheck ${graceTry}/${STARTUP_GRACE_RETRIES}`);
    await sleep(STARTUP_GRACE_DELAY_MS);
    const grace = await probeSystem();
    if (grace.ok) {
      console.log('[auto-fix] recovered during grace window; remediation skipped');
      logEvent({
        status: 'ok',
        triggerSource: TRIGGER_SOURCE,
        attemptCount: 0,
        issues: initial.issues,
        actions: [{ label: 'grace_recheck', attempt: graceTry, ok: true }],
        details: {
          startedAt,
          finishedAt: nowIso(),
          probeBefore: initial.results,
          probeAfter: grace.results,
          graceRecovered: true,
          graceTry,
        },
      });
      return;
    }
  }

  const allActions = [];
  let lastProbe = initial;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`[auto-fix] remediation attempt ${attempt}/${MAX_ATTEMPTS}`);
    const plan = remediationPlan(attempt);
    for (const step of plan) {
      const action = step();
      allActions.push({ ...action, attempt });
      const state = action.ok ? 'ok' : 'failed';
      console.log(`[auto-fix] ${action.label}: ${state}`);
    }

    await sleep(attempt === 1 ? 3000 : 5000);
    lastProbe = await probeSystem();
    if (lastProbe.ok) {
      console.log(`[auto-fix] remediated after attempt ${attempt}`);
      logEvent({
        status: 'remediated',
        triggerSource: TRIGGER_SOURCE,
        attemptCount: attempt,
        issues: initial.issues,
        actions: allActions,
        details: {
          startedAt,
          finishedAt: nowIso(),
          probeBefore: initial.results,
          probeAfter: lastProbe.results,
        },
      });
      return;
    }
  }

  const incident = {
    startedAt,
    finishedAt: nowIso(),
    triggerSource: TRIGGER_SOURCE,
    baseUrl: BASE_URL,
    maxAttempts: MAX_ATTEMPTS,
    initialProbe: initial,
    finalProbe: lastProbe,
    actions: allActions,
  };
  const incidentPath = writeIncidentFile(incident);
  console.error(`[auto-fix] failed after ${MAX_ATTEMPTS} attempts`);
  console.error(`[auto-fix] incident: ${incidentPath}`);
  logEvent({
    status: 'failed',
    triggerSource: TRIGGER_SOURCE,
    attemptCount: MAX_ATTEMPTS,
    issues: lastProbe.issues || initial.issues,
    actions: allActions,
    details: {
      startedAt,
      finishedAt: nowIso(),
      incidentPath,
    },
  });
  process.exit(1);
}

main().catch((err) => {
  const fatal = tailText(err?.message || 'fatal error', 500);
  console.error(`[auto-fix] fatal: ${fatal}`);
  try {
    logEvent({
      status: 'failed',
      triggerSource: TRIGGER_SOURCE,
      attemptCount: 0,
      issues: [{ reason: fatal }],
      actions: [],
      details: {
        startedAt: nowIso(),
        finishedAt: nowIso(),
        fatal,
      },
    });
  } catch {}
  process.exit(1);
});
