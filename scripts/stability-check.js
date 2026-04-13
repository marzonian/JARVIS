#!/usr/bin/env node
/* eslint-disable no-console */
const BASE = process.env.BASE_URL || 'http://localhost:3131';
const STARTUP_WAIT_MS = Math.max(5_000, Number(process.env.STARTUP_WAIT_MS || 45_000));

function shouldRetry(err) {
  const msg = String(err?.message || '').toLowerCase();
  const name = String(err?.name || '').toLowerCase();
  return (
    name.includes('abort')
    || msg.includes('aborted')
    || msg.includes('fetch failed')
    || msg.includes('econnrefused')
    || msg.includes('networkerror')
  );
}

async function jget(path) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(`${BASE}${path}`, { signal: ac.signal });
      const txt = await res.text();
      let json = null;
      try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${txt.slice(0, 300)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < 4 && shouldRetry(err)) {
        const backoffMs = 150 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error(`GET ${path} failed`);
}

async function jpost(path, body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ac.signal,
      });
      const txt = await res.text();
      let json = null;
      try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${txt.slice(0, 300)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < 3 && shouldRetry(err)) {
        const backoffMs = 150 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error(`POST ${path} failed`);
}

async function waitForHealth() {
  const started = Date.now();
  let lastErr = null;
  while ((Date.now() - started) < STARTUP_WAIT_MS) {
    try {
      const health = await jget('/api/health');
      if (health && (health.status === 'ok' || health.status === 'degraded')) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`health_wait_timeout_${STARTUP_WAIT_MS}ms: ${String(lastErr?.message || 'unknown')}`);
}

async function main() {
  const rounds = Number(process.env.ROUNDS || 12);
  console.log(`[stability] base=${BASE} rounds=${rounds}`);
  await waitForHealth();

  const baseChecks = [
    '/api/health',
    '/api/command/snapshot?strategy=original',
    '/api/coach/daily-plan',
    '/api/strategy/portfolio?strategy=original',
    '/api/desk/start-sequence?strategy=original',
    '/api/feedback/trade-outcomes?limit=10',
    '/api/session/control-panel',
    '/api/execution/control',
    '/api/execution/state',
    '/api/discovery/latest',
    '/api/system/self-heal/status',
    '/api/system/logic-guard/status',
    '/api/system/boundary/summary',
    '/api/system/runtime-guard',
    '/api/system/readiness?strategy=original',
    '/api/system/steady-state?strategy=original',
    '/api/data/sync/status',
    '/api/system/model-evals?limit=5',
    '/api/assistant/discord/status',
  ];

  for (let i = 0; i < rounds; i++) {
    console.log(`[stability] round ${i + 1}/${rounds}`);
    for (const p of baseChecks) {
      await jget(p);
    }
    if (i % 5 === 0) {
      const state = await jpost('/api/execution/state', {
        inPosition: i % 10 === 0,
        symbol: 'MNQ',
        side: i % 10 === 0 ? 'long' : null,
        qty: i % 10 === 0 ? 1 : 0,
        pnlTicks: (i - 10) * 2,
        pnlDollars: (i - 10) * 10,
        riskLeftDollars: 350,
        notes: `stability round ${i}`,
      });
      if (!state?.success) throw new Error('execution/state update did not return success');
    }
  }

  // Order intent lifecycle: intentionally blocked by default kill switch/disabled gates.
  let blocked = false;
  try {
    await jpost('/api/execution/order-intent', { side: 'buy', qty: 1, symbol: 'MNQ', source: 'stability' });
  } catch (err) {
    blocked = /Execution blocked/i.test(err.message);
  }
  if (!blocked) {
    throw new Error('Expected execution gate to block order intent during stability test.');
  }

  // Ensure stability checks never leak simulated in-position state into live guidance.
  await jpost('/api/execution/state', {
    inPosition: false,
    symbol: 'MNQ',
    side: null,
    qty: 0,
    pnlTicks: 0,
    pnlDollars: 0,
    riskLeftDollars: 400,
    notes: 'stability_cleanup_flatten',
  });

  console.log('[stability] PASS');
}

main().catch((err) => {
  console.error('[stability] FAIL', err.message);
  process.exit(1);
});
