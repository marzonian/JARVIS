#!/usr/bin/env node
/* eslint-disable no-console */
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://localhost:3131';
const ROUNDS = Math.max(5, Number(process.env.ROUNDS || 40));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));
const TIMEOUT_MS = Math.max(3000, Number(process.env.TIMEOUT_MS || 12000));
const STARTUP_WAIT_MS = Math.max(5_000, Number(process.env.STARTUP_WAIT_MS || 45_000));
const P95_BUDGET_MS = Math.max(800, Number(process.env.P95_BUDGET_MS || 5000));
const MAX_BUDGET_MS = Math.max(P95_BUDGET_MS, Number(process.env.MAX_BUDGET_MS || 12000));
const BUDGET_IGNORE = new Set(
  String(process.env.BUDGET_IGNORE_PATHS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function pctl(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.floor((sortedArr.length - 1) * p);
  return sortedArr[Math.max(0, Math.min(sortedArr.length - 1, idx))];
}

function isRetryableFetchError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const name = String(err?.name || '').toLowerCase();
  return (
    name.includes('abort')
    || msg.includes('fetch failed')
    || msg.includes('econnrefused')
    || msg.includes('networkerror')
  );
}

async function jfetch(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 4 : 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const started = nowMs();
    try {
      const res = await fetch(`${BASE}${path}`, { ...init, signal: ac.signal });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      const elapsed = nowMs() - started;
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 240)}`);
      return { json, elapsed };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryableFetchError(err)) {
        const backoffMs = 150 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error(`fetch_failed_${path}`);
}

async function waitForHealth() {
  const started = Date.now();
  let lastErr = null;
  while ((Date.now() - started) < STARTUP_WAIT_MS) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), Math.min(TIMEOUT_MS, 6000));
      try {
        const res = await fetch(`${BASE}/api/health`, { signal: ac.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`health_http_${res.status}`);
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        if (json && (json.status === 'ok' || json.status === 'degraded')) return;
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`health_wait_timeout_${STARTUP_WAIT_MS}ms: ${String(lastErr?.message || 'unknown')}`);
}

function validateElite(brief) {
  assert(brief && typeof brief === 'object', 'elite brief missing');
  assert(brief.plan && brief.winModel && brief.outcome, 'elite brief shape invalid');
  const p = Number(brief.winModel.point);
  const lo = Number(brief.winModel.rangeLow);
  const hi = Number(brief.winModel.rangeHigh);
  assert(Number.isFinite(p), 'winModel.point not numeric');
  assert(p >= 0 && p <= 100, 'winModel.point out of range');
  assert(lo <= p && p <= hi, 'winModel ranges do not contain point estimate');
  const d = brief.outcome?.distribution || {};
  const p10 = Number(d.p10);
  const p50 = Number(d.p50);
  const p90 = Number(d.p90);
  assert(Number.isFinite(p10) && Number.isFinite(p50) && Number.isFinite(p90), 'outcome distribution invalid');
  assert(p10 <= p50 && p50 <= p90, 'outcome quantiles unordered');
  assert(Array.isArray(brief.focusSetups), 'focusSetups missing');
  assert(Array.isArray(brief.setupProbabilities), 'setupProbabilities missing');
  assert(brief.news && Array.isArray(brief.news.events), 'news events missing');
}

async function runEndpointChecks(latencyMap) {
  const checks = [
    {
      path: '/api/health',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'degraded', 'health status invalid');
        assert(!!j.api?.ok, 'health api not ok');
      },
    },
    {
      path: '/api/coach/daily-plan?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'no_data', 'daily-plan status invalid');
        if (j.status === 'ok') assert(!!j.plan?.action, 'daily-plan missing action');
      },
    },
    {
      path: '/api/coach/elite-brief?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'no_data', 'elite-brief status invalid');
        if (j.status === 'ok') validateElite(j.brief);
      },
    },
    {
      path: '/api/coach/learning-status',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'error', 'learning-status invalid');
        if (j.status === 'ok') assert(!!j.summary, 'learning summary missing');
      },
    },
    {
      path: '/api/command/snapshot?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'no_data', 'command snapshot status invalid');
        if (j.status === 'ok') {
          assert(!!j.snapshot?.plan, 'command snapshot missing plan');
          assert(!!j.snapshot?.elite, 'command snapshot missing elite');
          assert(!!j.snapshot?.panel?.execution, 'command snapshot missing panel execution');
          assert(!!j.snapshot?.decision?.verdict, 'command snapshot missing decision verdict');
        }
      },
    },
    {
      path: '/api/strategy/portfolio?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'no_data', 'strategy portfolio status invalid');
        if (j.status === 'ok') {
          assert(!!j.portfolio?.summary, 'strategy portfolio summary missing');
          assert(Array.isArray(j.portfolio?.rows), 'strategy portfolio rows missing');
        }
      },
    },
    {
      path: '/api/desk/start-sequence?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok' || j.status === 'no_data', 'desk start sequence status invalid');
        if (j.status === 'ok') {
          assert(!!j.sequence?.text, 'desk start sequence text missing');
          assert(Array.isArray(j.sequence?.checklist), 'desk start sequence checklist missing');
        }
      },
    },
    {
      path: '/api/session/control-panel',
      verify: (j) => {
        assert(j.status === 'ok', 'control-panel status invalid');
        assert(!!j.panel?.execution, 'control-panel execution missing');
      },
    },
    {
      path: '/api/execution/autonomy',
      verify: (j) => {
        assert(j.status === 'ok', 'autonomy status invalid');
        assert(!!j.settings, 'autonomy settings missing');
        assert(Array.isArray(j.events), 'autonomy events missing');
      },
    },
    {
      path: '/api/system/self-heal/status',
      verify: (j) => {
        assert(j.status === 'ok', 'self-heal status invalid');
        assert(!!j.summary, 'self-heal summary missing');
      },
    },
    {
      path: '/api/system/logic-guard/status',
      verify: (j) => {
        assert(j.status === 'ok', 'logic-guard status invalid');
        assert(!!j.summary, 'logic-guard summary missing');
      },
    },
    {
      path: '/api/system/boundary/summary',
      verify: (j) => {
        assert(j.status === 'ok', 'boundary summary status invalid');
        assert(!!j.summary?.line, 'boundary summary line missing');
        assert(!!j.summary?.directive, 'boundary summary directive missing');
        assert(Number.isFinite(Number(j.summary?.confidence)), 'boundary summary confidence missing');
      },
    },
    {
      path: '/api/system/runtime-guard',
      verify: (j) => {
        assert(j.status === 'ok', 'runtime-guard status invalid');
        assert(!!j.guard, 'runtime-guard payload missing');
        assert(typeof j.guard.inFlight === 'boolean', 'runtime-guard inflight missing');
      },
    },
    {
      path: '/api/system/readiness?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok', 'system readiness status invalid');
        assert(!!j.summary, 'system readiness summary missing');
        assert(typeof j.summary.readiness === 'string', 'readiness field missing');
        assert(typeof j.summary.line === 'string', 'readiness line missing');
      },
    },
    {
      path: '/api/system/steady-state?strategy=original',
      verify: (j) => {
        assert(j.status === 'ok', 'steady-state status invalid');
        assert(!!j.summary, 'steady-state summary missing');
        assert(typeof j.summary.status === 'string', 'steady-state summary status missing');
        assert(Array.isArray(j.summary.requiredActions), 'steady-state actions missing');
      },
    },
    {
      path: '/api/data/sync/status',
      verify: (j) => {
        assert(j.status === 'ok', 'data sync status invalid');
        assert(!!j.freshness, 'data sync freshness missing');
      },
    },
    {
      path: '/api/system/model-evals?limit=5',
      verify: (j) => {
        assert(j.status === 'ok', 'model eval list status invalid');
        assert(Array.isArray(j.rows), 'model eval rows missing');
      },
    },
    {
      path: '/api/assistant/discord/status',
      verify: (j) => {
        assert(typeof j.enabled === 'boolean', 'discord-status missing enabled flag');
        assert(typeof j.ready === 'boolean', 'discord-status missing readiness flag');
      },
    },
  ];

  await Promise.all(checks.map(async (c) => {
    const { json, elapsed } = await jfetch(c.path);
    c.verify(json);
    if (!latencyMap[c.path]) latencyMap[c.path] = [];
    latencyMap[c.path].push(elapsed);
  }));
}

async function runWritePathChecks() {
  const runTag = `deep_reliability_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const ts = new Date().toISOString();
  const payload = {
    asOf: ts,
    inPosition: false,
    symbol: 'MNQ',
    side: null,
    qty: 0,
    pnlTicks: 0,
    pnlDollars: 0,
    riskLeftDollars: 400,
    notes: runTag,
  };
  const post = await jfetch('/api/execution/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert(post.json?.success === true, 'execution/state write did not return success');
  assert(post.json?.state?.notes === runTag, 'execution/state post payload was not persisted');
  const read = await jfetch('/api/execution/state');
  const readbackMatches = read.json?.state?.notes === runTag;
  if (!readbackMatches) {
    const readAsOf = Date.parse(String(read.json?.state?.asOf || ''));
    const expectedAsOf = Date.parse(ts);
    const concurrentWriteDetected = Number.isFinite(readAsOf) && Number.isFinite(expectedAsOf) && readAsOf >= expectedAsOf;
    assert(concurrentWriteDetected, 'execution/state readback mismatch');
  }

  const feedbackPost = await jfetch('/api/feedback/trade-outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      setupId: `${runTag}_setup`,
      setupName: 'Deep Reliability Probe Setup',
      outcome: 'breakeven',
      notes: runTag,
      source: 'deep_reliability',
    }),
  });
  assert(feedbackPost.json?.success === true, 'trade outcome feedback write did not return success');
  const feedbackRead = await jfetch('/api/feedback/trade-outcomes?limit=20&includeSynthetic=1');
  const found = Array.isArray(feedbackRead.json?.rows) && feedbackRead.json.rows.some((r) => r.setupId === `${runTag}_setup` && r.notes === runTag);
  assert(found, 'trade outcome feedback readback mismatch');
  try {
    execSync(
      `sqlite3 "${process.cwd()}/data/mcnair.db" "DELETE FROM trade_outcome_feedback WHERE setup_id='${runTag}_setup' AND source='deep_reliability';"`,
      { stdio: 'ignore', shell: '/bin/zsh' }
    );
  } catch {
    // best-effort cleanup
  }
}

async function worker(workerId, rounds, latencyMap, failures) {
  for (let i = 0; i < rounds; i += 1) {
    try {
      await runEndpointChecks(latencyMap);
    } catch (err) {
      failures.push({ workerId, round: i + 1, error: err.message });
    }
  }
}

async function main() {
  console.log(`[deep-reliability] base=${BASE} rounds=${ROUNDS} concurrency=${CONCURRENCY}`);
  await waitForHealth();
  const latencyMap = {};
  const failures = [];

  const baseRounds = Math.floor(ROUNDS / CONCURRENCY);
  const remainder = ROUNDS % CONCURRENCY;
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const rounds = baseRounds + (i < remainder ? 1 : 0);
    workers.push(worker(i + 1, rounds, latencyMap, failures));
  }
  await Promise.all(workers);
  await runWritePathChecks().catch((err) => failures.push({ workerId: 0, round: 0, error: err.message }));

  const endpointSummaries = Object.entries(latencyMap).map(([path, arr]) => {
    const vals = [...arr].sort((a, b) => a - b);
    return {
      path,
      calls: vals.length,
      p50: pctl(vals, 0.5),
      p95: pctl(vals, 0.95),
      max: vals[vals.length - 1] || 0,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  console.log('[deep-reliability] latency summary (ms)');
  for (const s of endpointSummaries) {
    console.log(`  ${s.path} -> calls=${s.calls} p50=${s.p50} p95=${s.p95} max=${s.max}`);
  }

  const budgetBreaches = endpointSummaries.filter((s) => {
    if (BUDGET_IGNORE.has(s.path)) return false;
    return s.p95 > P95_BUDGET_MS || s.max > MAX_BUDGET_MS;
  });
  if (budgetBreaches.length > 0) {
    for (const b of budgetBreaches) {
      failures.push({
        workerId: -1,
        round: -1,
        error: `latency_budget_exceeded path=${b.path} p95=${b.p95} max=${b.max} budget(p95<=${P95_BUDGET_MS},max<=${MAX_BUDGET_MS})`,
      });
    }
  }

  if (failures.length > 0) {
    console.error(`[deep-reliability] FAIL (${failures.length} issue(s))`);
    for (const f of failures.slice(0, 20)) {
      console.error(`  worker=${f.workerId} round=${f.round} err=${f.error}`);
    }
    process.exit(1);
  }

  console.log('[deep-reliability] PASS');
}

main().catch((err) => {
  console.error('[deep-reliability] FATAL', err.message);
  process.exit(1);
});
