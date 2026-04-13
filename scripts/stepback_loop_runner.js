#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3131';
const LOOPS = Math.max(1, Math.min(500, Number(process.env.STEPBACK_LOOPS || 50)));
const DELAY_MS = Math.max(0, Math.min(5000, Number(process.env.STEPBACK_DELAY_MS || 80)));
const APPLY_GUARD = process.env.STEPBACK_APPLY_GUARD !== '0';
const FETCH_RETRIES = Math.max(1, Math.min(5, Number(process.env.STEPBACK_FETCH_RETRIES || 3)));
const FETCH_RETRY_DELAY_MS = Math.max(50, Math.min(5000, Number(process.env.STEPBACK_FETCH_RETRY_DELAY_MS || 180)));
const STARTUP_WAIT_SECONDS = Math.max(1, Math.min(90, Number(process.env.STEPBACK_STARTUP_WAIT_SECONDS || 20)));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, max = 320) {
  const str = String(text || '').trim();
  if (str.length <= max) return str;
  return str.slice(-max);
}

async function fetchJson(pathname) {
  let lastErr = null;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}${pathname}`, { signal: AbortSignal.timeout(7000) });
      const txt = await res.text();
      let json = null;
      try {
        json = JSON.parse(txt);
      } catch {
        json = { raw: txt };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAY_MS);
    }
  }
  throw lastErr || new Error(`fetch failed ${pathname}`);
}

function runGuard() {
  try {
    const out = execSync('node scripts/logic_guardian.js', {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 120000,
      shell: '/bin/zsh',
    });
    let parsed = null;
    try {
      parsed = JSON.parse(String(out).trim().split('\n').filter(Boolean).pop() || '{}');
    } catch {
      parsed = null;
    }
    return { ok: true, parsed, output: tail(out, 400) };
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : '';
    const stderr = err?.stderr ? String(err.stderr) : '';
    return {
      ok: false,
      error: tail(err?.message || 'logic_guard_failed', 260),
      output: tail(`${stdout}\n${stderr}`, 400),
    };
  }
}

function classify({ health, boundary, logic }) {
  if (String(health?.status || '').toLowerCase() !== 'ok') return 'critical';
  if (String(boundary?.status || '').toLowerCase() !== 'ok') return 'critical';
  if (String(logic?.status || '').toLowerCase() !== 'ok') return 'critical';

  const directive = String(boundary?.summary?.directive || '').toUpperCase();
  const mode = String(boundary?.summary?.boundaryMode || '').toUpperCase();
  if (directive.includes("DON'T TRADE") || mode === 'ALERT') return 'critical';
  if (directive === 'WAIT' || mode === 'CALIBRATING' || mode === 'DEFENSIVE') return 'caution';
  return 'stable';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function main() {
  console.log(`[stepback-loop] start loops=${LOOPS} base=${BASE_URL} applyGuard=${APPLY_GUARD}`);
  const startedAt = new Date().toISOString();
  const loops = [];
  const directives = { TRADE: 0, WAIT: 0, DONT_TRADE: 0, UNKNOWN: 0 };

  let warmupOk = false;
  for (let i = 1; i <= STARTUP_WAIT_SECONDS; i += 1) {
    try {
      const h = await fetchJson('/api/health');
      if (String(h?.status || '').toLowerCase() === 'ok') {
        warmupOk = true;
        break;
      }
    } catch (_) {
      // keep waiting
    }
    await sleep(1000);
  }
  if (!warmupOk) {
    throw new Error(`health_not_ready_within_${STARTUP_WAIT_SECONDS}s`);
  }

  for (let i = 1; i <= LOOPS; i += 1) {
    const row = {
      loop: i,
      at: new Date().toISOString(),
      guardRun: null,
      class: 'critical',
      notes: [],
    };
    try {
      if (APPLY_GUARD) {
        row.guardRun = runGuard();
        if (!row.guardRun.ok) row.notes.push('logic_guard_failed');
      }
      const [health, logic, boundary] = await Promise.all([
        fetchJson('/api/health'),
        fetchJson('/api/system/logic-guard/status'),
        fetchJson('/api/system/boundary/summary'),
      ]);
      row.health = { status: health?.status || null };
      row.logic = {
        status: logic?.status || null,
        latestStatus: logic?.summary?.latest?.status || null,
        errors: Number(logic?.summary?.errors || 0),
      };
      row.boundary = {
        status: boundary?.status || null,
        mode: boundary?.summary?.boundaryMode || null,
        directive: boundary?.summary?.directive || null,
        confidence: boundary?.summary?.confidence ?? null,
        line: boundary?.summary?.line || null,
      };
      row.class = classify({ health, logic, boundary });
      const directiveKey = String(boundary?.summary?.directive || '').toUpperCase();
      if (directiveKey === 'TRADE') directives.TRADE += 1;
      else if (directiveKey === 'WAIT') directives.WAIT += 1;
      else if (directiveKey.includes("DON'T TRADE")) directives.DONT_TRADE += 1;
      else directives.UNKNOWN += 1;
      if (row.class === 'critical') row.notes.push('boundary_critical');
      if (row.class === 'caution') row.notes.push('boundary_caution');
    } catch (err) {
      row.class = 'critical';
      row.error = tail(err?.message || 'loop_failed', 260);
      row.notes.push('probe_failed');
    }
    loops.push(row);
    if (DELAY_MS > 0 && i < LOOPS) await sleep(DELAY_MS);
  }

  const counts = loops.reduce((acc, item) => {
    acc[item.class] = (acc[item.class] || 0) + 1;
    return acc;
  }, { stable: 0, caution: 0, critical: 0 });

  const summary = {
    startedAt,
    endedAt: new Date().toISOString(),
    loops: LOOPS,
    applyGuard: APPLY_GUARD,
    counts,
    directives,
    stableRate: Math.round(((counts.stable || 0) / LOOPS) * 10000) / 100,
    cautionRate: Math.round(((counts.caution || 0) / LOOPS) * 10000) / 100,
    criticalRate: Math.round(((counts.critical || 0) / LOOPS) * 10000) / 100,
  };

  ensureDataDir();
  const stamp = summary.endedAt.replace(/[:.]/g, '-');
  const outPath = path.join(DATA_DIR, `stepback-loop-report-${stamp}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify({ summary, loops }, null, 2)}\n`, 'utf8');

  console.log(`[stepback-loop] report=${outPath}`);
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(`[stepback-loop] fatal ${String(err?.message || err)}`);
  process.exit(1);
});
