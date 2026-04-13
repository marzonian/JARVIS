#!/usr/bin/env node
/* eslint-disable no-console */
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://localhost:3131';

function runStep(label, cmd, timeout = 8 * 60 * 1000) {
  const started = Date.now();
  try {
    execSync(cmd, {
      stdio: 'inherit',
      shell: '/bin/zsh',
      timeout,
      env: process.env,
    });
    const ms = Date.now() - started;
    console.log(`[ultimate-check] ${label}: PASS (${ms}ms)`);
    return { label, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`[ultimate-check] ${label}: FAIL (${ms}ms) -> ${err.message}`);
    return { label, ok: false, ms, error: err.message };
  }
}

async function checkReadiness() {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/system/readiness?strategy=original`, {
      signal: AbortSignal.timeout(12000),
    });
    const txt = await res.text();
    let json = {};
    try { json = JSON.parse(txt); } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json.status !== 'ok' || !json.summary) throw new Error('invalid_readiness_payload');
    const ms = Date.now() - started;
    console.log(`[ultimate-check] readiness: PASS (${ms}ms) -> ${json.summary.line}`);
    return { label: 'readiness', ok: true, ms, line: json.summary.line, readiness: json.summary.readiness };
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`[ultimate-check] readiness: FAIL (${ms}ms) -> ${err.message}`);
    return { label: 'readiness', ok: false, ms, error: err.message };
  }
}

async function main() {
  console.log(`[ultimate-check] start base=${BASE}`);
  const steps = [
    runStep('doctor', 'npm run doctor', 10 * 60 * 1000),
    runStep('stability', 'npm run test:stability', 6 * 60 * 1000),
    runStep('deep_reliability', 'npm run test:reliability:deep', 8 * 60 * 1000),
    runStep('runtime_doctor', 'npm run runtime:doctor', 3 * 60 * 1000),
    runStep('runtime_enforce', 'npm run runtime:enforce', 3 * 60 * 1000),
  ];
  const readiness = await checkReadiness();
  const all = [...steps, readiness];
  const failed = all.filter((s) => !s.ok);

  console.log('[ultimate-check] summary');
  for (const s of all) {
    console.log(`  - ${s.label}: ${s.ok ? 'PASS' : 'FAIL'} (${s.ms}ms)`);
  }
  if (failed.length > 0) {
    console.error(`[ultimate-check] FAIL (${failed.length} failing checks)`);
    process.exit(1);
  }
  console.log('[ultimate-check] PASS');
}

main().catch((err) => {
  console.error('[ultimate-check] FATAL', err.message);
  process.exit(1);
});
