#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const BASE_URL = process.env.SIGNAL_BASE_URL || 'http://localhost:3131';
const RETRIES = Number(process.env.SIGNAL_RETRIES || 30);
const RETRY_DELAY_MS = Number(process.env.SIGNAL_RETRY_DELAY_MS || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.SIGNAL_REQUEST_TIMEOUT_MS || 15000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}`);
  }
  return res.json();
}

function tryKickstartServer() {
  if (process.platform !== 'darwin') return false;
  const uid = process.getuid ? process.getuid() : null;
  if (uid == null) return false;
  const label = process.env.SIGNAL_SERVER_LABEL || 'ai.3130.server';
  const cmd = `launchctl kickstart -k gui/${uid}/${label}`;
  try {
    execSync(cmd, { stdio: 'ignore' });
    console.log(`[mcnair_daily_signals] kickstarted ${label}`);
    return true;
  } catch {
    return false;
  }
}

async function ensureApiReady() {
  let lastErr = null;
  let attemptedKickstart = false;
  for (let i = 0; i < RETRIES; i += 1) {
    try {
      const health = await fetchJson('/api/health');
      if (health && health.status === 'ok') return true;
      lastErr = new Error('health endpoint did not return ok');
    } catch (err) {
      lastErr = err;
    }
    if (!attemptedKickstart && i >= 1) {
      attemptedKickstart = true;
      const kicked = tryKickstartServer();
      if (kicked) console.log('[mcnair_daily_signals] API down, attempted server wake-up');
    }
    await sleep(RETRY_DELAY_MS);
  }
  throw lastErr || new Error('API readiness check failed');
}

async function run() {
  const startedAt = new Date().toISOString();
  console.log(`[mcnair_daily_signals] start ${startedAt}`);
  console.log(`[mcnair_daily_signals] base=${BASE_URL}`);

  await ensureApiReady();

  const dailySignals = await fetchJson('/api/signals/daily?force=1');
  const signal = dailySignals?.signal || {};
  let line = signal?.signalLine || '';

  if (!line) {
    const snapshot = await fetchJson('/api/command/snapshot?strategy=original&force=1');
    const decision = snapshot?.snapshot?.decision || {};
    line = decision.signalLine
      || `[${decision.signal || decision.verdict || 'NO-TRADE'}] ${decision.why10Words || 'Signal generated.'}`;
  }

  if (String(process.env.SIGNAL_REFRESH_VERDICT || '').trim() === '1') {
    await fetchJson('/api/verdict/daily?force=1').catch(() => null);
  }

  console.log(`[mcnair_daily_signals] ${line}`);
  console.log('[mcnair_daily_signals] complete');
}

run().catch((err) => {
  console.error(`[mcnair_daily_signals] failed: ${err.message}`);
  process.exit(1);
});
