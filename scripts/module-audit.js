#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3131';
const TIMEOUT_MS = Math.max(4000, Number(process.env.MODULE_AUDIT_TIMEOUT_MS || 15000));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function parseTs(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function minutesAgo(when) {
  if (!(when instanceof Date)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
}

async function jget(path) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ac.signal });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function jpost(path, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
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
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function checkEndpoint(path, verifier) {
  const json = await jget(path);
  if (typeof verifier === 'function') verifier(json);
  console.log(`[module-audit] PASS ${path}`);
  return json;
}

async function main() {
  console.log(`[module-audit] start base=${BASE}`);

  const health = await checkEndpoint('/api/health', (j) => {
    assert(j && (j.status === 'ok' || j.status === 'degraded'), 'api health status invalid');
  });
  console.log(`[module-audit] health=${health.status}`);

  const marketHealth = await checkEndpoint('/api/market/health?forceFresh=1&compareLive=1&live=false', (j) => {
    assert(j && typeof j === 'object', 'market health payload missing');
    assert(j.topstep_bars && typeof j.topstep_bars === 'object', 'market health topstep_bars missing');
    assert(j.orb_state && typeof j.orb_state === 'object', 'market health orb_state missing');
  });

  const signalWrap = await checkEndpoint('/api/signals/daily?force=1', (j) => {
    assert(j?.status === 'ok', 'daily signal status invalid');
    assert(j.signal && typeof j.signal === 'object', 'daily signal payload missing');
    assert(String(j.signal.signalLine || '').trim().length > 0, 'daily signal line missing');
  });

  const verdictWrap = await checkEndpoint('/api/verdict/daily?force=1', (j) => {
    assert(j?.status === 'ok', 'daily verdict status invalid');
    assert(j.verdict && typeof j.verdict === 'object', 'daily verdict payload missing');
    assert(String(j.verdict.signalLine || '').trim().length > 0, 'daily verdict line missing');
  });

  const sig = signalWrap.signal;
  const verdict = verdictWrap.verdict;
  assert(String(sig.marketDate || '').trim() === String(verdict.tradeDate || '').trim(), 'daily signal and verdict dates diverged');
  const sigAgeMin = minutesAgo(parseTs(sig.generatedAt));
  const verdictAgeMin = minutesAgo(parseTs(verdict.generatedAt));
  assert(sigAgeMin <= 120, `daily signal stale (${sigAgeMin}m)`);
  assert(verdictAgeMin <= 120, `daily verdict stale (${verdictAgeMin}m)`);
  console.log(`[module-audit] daily freshness signal=${sigAgeMin}m verdict=${verdictAgeMin}m`);

  const cmdWrap = await checkEndpoint('/api/command/snapshot?strategy=original&force=1', (j) => {
    assert(j?.status === 'ok' || j?.status === 'no_data', 'command snapshot status invalid');
    if (j?.status === 'ok') {
      assert(j.snapshot?.plan, 'command plan missing');
      assert(j.snapshot?.decision, 'command decision missing');
      assert(j.snapshot?.panel, 'command panel missing');
      assert(j.snapshot?.elite, 'command elite missing');
    }
  });

  if (cmdWrap?.status === 'ok') {
    const marketDate = String(cmdWrap.snapshot?.marketDate || '').trim();
    assert(marketDate === String(sig.marketDate || '').trim(), 'command snapshot date differs from daily signal date');
  }

  const moduleChecks = [
    '/api/bridge',
    '/api/adversary',
    '/api/journal?source=backtest',
    '/api/sessions',
    '/api/breakdown',
    '/api/conflicts',
    '/api/discovery/latest',
    '/api/discovery/validations',
    '/api/discovery/reminders',
    '/api/assistant/notifications',
    '/api/execution/autonomy',
    '/api/coach/report?strategy=original',
    '/api/coach/daily-plan?strategy=original',
    '/api/coach/elite-brief?strategy=original',
    '/api/strategy/portfolio?strategy=original',
    '/api/session/control-panel',
    '/api/system/status?strategy=original',
    '/api/system/readiness?strategy=original',
    '/api/system/steady-state?strategy=original',
    '/api/system/runtime-guard',
    '/api/system/self-heal/status',
    '/api/system/logic-guard/status',
    '/api/system/boundary/summary',
    '/api/data/sync/status',
    '/api/assistant/voice/status',
    '/api/analyst/status',
    '/api/assistant/discord/status',
  ];

  for (const path of moduleChecks) {
    await checkEndpoint(path, (j) => {
      assert(j && typeof j === 'object', `invalid payload at ${path}`);
      if ('status' in j) {
        const st = String(j.status || '').toLowerCase();
        assert(st !== 'error', `${path} returned status=error`);
      }
    });
  }

  const sessionId = `module_audit_${Date.now()}`;
  const jarvisGeneral = await jpost('/api/jarvis/query', {
    message: 'what endpoint are you using for my voice requests right now?',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId,
    clientId: sessionId,
    activeModule: 'analyst',
    strategy: 'original',
  });
  assert(String(jarvisGeneral.reply || '').trim().length > 0, 'jarvis general reply missing');
  assert(String(jarvisGeneral.traceId || '').trim().length > 0, 'jarvis traceId missing');
  assert(String(jarvisGeneral.endpoint || '').includes('/api/jarvis/query') || /jarvis/i.test(String(jarvisGeneral.reply || '')), 'jarvis endpoint confirmation missing');
  console.log('[module-audit] PASS jarvis general path');

  const jarvisTrading = await jpost('/api/jarvis/query', {
    message: 'should i take this setup now',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId,
    clientId: sessionId,
    activeModule: 'analyst',
    strategy: 'original',
  });
  const reply = String(jarvisTrading.reply || '');
  assert(reply.length > 0, 'jarvis trading reply missing');
  assert(!/DON'T TRADE|WAIT:|\[WAIT\]|Best setup|Why:/i.test(reply), 'jarvis trading reply leaked legacy tokens');
  console.log('[module-audit] PASS jarvis trading path');

  const marketStatus = String(marketHealth?.status || 'unknown').toUpperCase();
  const reason = String(marketHealth?.reason || 'none');
  console.log(`[module-audit] market health=${marketStatus} reason=${reason}`);
  console.log('[module-audit] PASS');
}

main().catch((err) => {
  console.error('[module-audit] FAIL', err.message || err);
  process.exit(1);
});
