#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const {
  hasLegacyVerdictTokens,
  validateJarvisResponseInvariants,
} = require('../server/jarvis-audit');

const REPO_ROOT = path.resolve(__dirname, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveEphemeralPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = Number(addr && addr.port);
      srv.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 45000) {
  const start = Date.now();
  let lastErr = null;
  while ((Date.now() - start) < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return true;
      lastErr = new Error(`health_status_${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(350);
  }
  throw new Error(`server_not_ready: ${String(lastErr?.message || 'unknown')}`);
}

async function startAuditServer(options = {}) {
  const requestedPort = Number(options.port || process.env.JARVIS_AUDIT_PORT || 0);
  const port = Number.isFinite(requestedPort) && requestedPort > 0
    ? requestedPort
    : await reserveEphemeralPort('127.0.0.1');
  const baseUrl = options.baseUrl || `http://127.0.0.1:${port}`;
  const useExisting = !!options.useExisting;
  if (useExisting) {
    await waitForHealth(baseUrl, 15000);
    return {
      baseUrl,
      spawned: false,
      stop: async () => {},
    };
  }

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NETWORK_ACCESS_MODE: 'open',
    DEBUG_JARVIS_AUDIT: '1',
    JARVIS_AUDIT_ALLOW_MOCKS: '1',
    DATABENTO_API_ENABLED: 'false',
    DATABENTO_API_KEY: '',
    DATABENTO_AUTO_INGEST_ENABLED: 'false',
    TOPSTEP_API_ENABLED: 'false',
    TOPSTEP_API_KEY: '',
    JARVIS_AUTO_DAILY_SCORING_ENABLED: 'false',
    NEWS_ENABLED: 'false',
    DISCORD_BOT_TOKEN: '',
    ...(options.env && typeof options.env === 'object' ? options.env : {}),
  };

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (chunk) => {
    const text = String(chunk || '');
    if (text) logs.push(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '');
    if (text) logs.push(text);
  });

  try {
    await waitForHealth(baseUrl, 60000);
  } catch (err) {
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(`${err.message}\nserver_logs:\n${logs.slice(-40).join('')}`);
  }

  return {
    baseUrl,
    spawned: true,
    logs,
    stop: async () => {
      if (child.killed) return;
      try { child.kill('SIGTERM'); } catch {}
      await sleep(600);
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch {}
      }
    },
  };
}

async function postJson(baseUrl, endpoint, body, timeoutMs = 12000) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text || '{}');
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${endpoint} http_${res.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

function assert(condition, message, payload = null) {
  if (condition) return;
  const details = payload ? `\n${JSON.stringify(payload, null, 2)}` : '';
  throw new Error(`${message}${details}`);
}

function extractInvariantContext(response = {}) {
  return {
    precedenceMode: response?.precedenceMode || null,
    healthStatus: response?.healthStatus || null,
    riskVerdict: response?.riskVerdict || response?.riskState?.riskVerdict || null,
    hasOpenPosition: response?.hasOpenPosition === true || response?.riskState?.hasOpenPosition === true,
    nowMinutesEt: response?.nowMinutesEt ?? null,
    hasORBComplete: response?.hasORBComplete === true || response?.riskState?.orbComplete === true,
    liveBarsAvailable: response?.liveBarsAvailable === true || response?.riskState?.marketDataFreshness?.usedLiveBars === true,
    hasTodaySessionBars: response?.hasTodaySessionBars ?? response?.riskState?.marketDataFreshness?.hasTodaySessionBars ?? null,
    minutesSinceLastBar: response?.minutesSinceLastBar ?? null,
    sessionDateOfData: response?.sessionDateOfData || response?.riskState?.marketDataFreshness?.sessionDateOfData || null,
    todayEtDate: response?.todayEtDate || response?.riskState?.marketDataFreshness?.nowEt?.date || null,
    staleThresholdMinutes: response?.staleThresholdMinutes ?? response?.riskState?.marketDataFreshness?.staleThresholdMinutes ?? null,
    primaryReason: response?.primaryReason || null,
    primaryReasonCode: response?.primaryReasonCode || null,
    cooldownRemainingMinutes: response?.cooldownRemainingMinutes ?? response?.riskState?.cooldownRemainingMinutes ?? null,
  };
}

function assertJarvisInvariants(label, requestShape, response) {
  const invariants = validateJarvisResponseInvariants({
    request: requestShape,
    response: {
      intent: response?.intent,
      reply: response?.reply,
      toolsUsed: response?.toolsUsed,
    },
    context: extractInvariantContext(response),
  });
  assert(invariants.pass, `${label} invariants failed`, {
    failedRules: invariants.failedRules,
    checkedRules: invariants.checkedRules,
    phrase: requestShape?.message,
    toolsUsed: response?.toolsUsed,
    routePath: response?.routePath,
    reply: response?.reply,
    trace: Array.isArray(response?.auditTrace) ? response.auditTrace.slice(-8) : null,
  });
}

function assertNoLegacyTokens(label, response, requestShape = {}) {
  const reply = String(response?.reply || '');
  assert(!hasLegacyVerdictTokens(reply), `${label} contains legacy verdict tokens`, {
    phrase: requestShape?.message,
    toolsUsed: response?.toolsUsed,
    routePath: response?.routePath,
    reply,
    trace: Array.isArray(response?.auditTrace) ? response.auditTrace.slice(-8) : null,
  });
}

module.exports = {
  assert,
  assertJarvisInvariants,
  assertNoLegacyTokens,
  postJson,
  startAuditServer,
};
