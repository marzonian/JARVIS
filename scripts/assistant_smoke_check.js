#!/usr/bin/env node
'use strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3131';
const ANALYST_FASTPATH_BUDGET_MS = Math.max(4000, Number(process.env.ASSISTANT_SMOKE_ANALYST_FAST_MS || 12000));
const ASSISTANT_QUERY_BUDGET_MS = Math.max(3000, Number(process.env.ASSISTANT_SMOKE_QUERY_BUDGET_MS || 5500));
const HEALTH_TIMEOUT_MS = Math.max(7000, Number(process.env.ASSISTANT_SMOKE_HEALTH_TIMEOUT_MS || 9000));
const MARKET_HEALTH_TIMEOUT_MS = Math.max(9000, Number(process.env.ASSISTANT_SMOKE_MARKET_HEALTH_TIMEOUT_MS || 15000));
const QUICK_MARKET_STATE_BUDGET_MS = Math.max(3500, Number(process.env.ASSISTANT_SMOKE_QUICK_MARKET_BUDGET_MS || 9000));
const ORCHESTRATE_TIMEOUT_MS = Math.max(45000, Number(process.env.ASSISTANT_SMOKE_ORCHESTRATE_TIMEOUT_MS || 120000));
const { sanitizeAnalystReply } = require('../server/analyst-sanitizer');

function fail(msg) {
  console.error(`[assistant-smoke] FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`[assistant-smoke] PASS: ${msg}`);
}

function assertNoRigidAnalystLabels(reply, contextLabel) {
  const text = String(reply || '');
  if (!text.trim()) fail(`${contextLabel} reply empty`);
  if (/DON'T TRADE|WAIT:|TRADE\.|\[/.test(text)) {
    fail(`${contextLabel} still contains rigid analyst labels`);
  }
}

function isRiskBlockedResponse(payload) {
  const source = String(payload?.source || '').trim().toLowerCase();
  const mode = String(payload?.mode || '').trim().toLowerCase();
  return source === 'assistant_risk_guardrail'
    || source === 'analyst_risk_guardrail'
    || source === 'assistant_voice_health_preflight'
    || source === 'jarvis_health_block'
    || mode === 'risk_block'
    || mode === 'health_block'
    || payload?.blocked === true;
}

function assertRiskGuardrailNarrative(reply, contextLabel) {
  const text = String(reply || '').trim();
  if (!text) fail(`${contextLabel} risk guardrail reply empty`);
  if (!/(I['’]d sit out|we(?:'|’)re already in a position|blocked:)/i.test(text)) {
    fail(`${contextLabel} risk guardrail wording missing clear blocked stance`);
  }
  assertNoRigidAnalystLabels(text, contextLabel);
}

async function getJson(pathname, timeoutMs = HEALTH_TIMEOUT_MS) {
  const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  const txt = await res.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}`);
  return json;
}

async function postJson(pathname, body, timeoutMs = 25000) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await res.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}`);
  return json;
}

async function postJsonAllowStatus(pathname, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const allowedStatuses = Array.isArray(options.allowedStatuses) ? options.allowedStatuses : [];
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await res.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  if (!res.ok && !allowedStatuses.includes(res.status)) {
    throw new Error(`${pathname} HTTP ${res.status}`);
  }
  return { status: res.status, body: json };
}

async function main() {
  const mockedReply = "DON'T TRADE. Conditions are weak.\nWAIT: Outside your primary 9:30-10:59 entry window.\n[WAIT] Keep risk minimal.";
  const mockedSanitized = sanitizeAnalystReply(mockedReply);
  if (/DON'T TRADE|WAIT:|\[/.test(mockedSanitized)) {
    fail('mocked analyst sanitizer test failed to strip rigid labels');
  }
  pass('mocked analyst sanitizer strips rigid labels');

  const health = await getJson('/api/health').catch((err) => fail(`health unreachable (${err.message})`));
  if (String(health?.status || '').toLowerCase() !== 'ok') fail('health status not ok');
  pass('health is ok');

  const marketHealth = await getJson('/api/market/health?forceFresh=1&compareLive=1&live=false', MARKET_HEALTH_TIMEOUT_MS)
    .catch((err) => fail(`market health endpoint failed (${err.message})`));
  if (!marketHealth || typeof marketHealth !== 'object') fail('market health payload missing');
  if (!marketHealth?.topstep_bars || typeof marketHealth.topstep_bars !== 'object') fail('market health topstep_bars missing');
  if (!marketHealth?.orb_state || typeof marketHealth.orb_state !== 'object') fail('market health orb_state missing');
  if (!('contractId_in_use' in marketHealth)) fail('market health contractId_in_use missing');
  pass('market health endpoint payload is available');

  const voiceStatus = await getJson('/api/assistant/voice/status').catch((err) => fail(`voice status failed (${err.message})`));
  if (typeof voiceStatus?.provider !== 'string' || !voiceStatus.provider.trim()) fail('voice status provider missing');
  if (!voiceStatus?.providers || typeof voiceStatus.providers !== 'object') fail('voice providers block missing');
  pass('voice provider status is available');

  const analystStatus = await getJson('/api/analyst/status').catch((err) => fail(`analyst status failed (${err.message})`));
  if (typeof analystStatus?.configured !== 'boolean') fail('analyst configured flag missing');
  if (!analystStatus?.context || typeof analystStatus.context !== 'object') fail('analyst context status missing');
  pass('analyst status endpoint is available');

  const voiceGuardCheck = await postJsonAllowStatus('/api/assistant/query', {
    message: 'should i take this setup now',
    strategy: 'original',
    activeModule: 'analyst',
    voiceMode: true,
    voiceBriefMode: 'earbud',
  }, { allowedStatuses: [409] }).catch((err) => fail(`voice endpoint guard check failed (${err.message})`));
  if (voiceGuardCheck.status !== 409) fail(`voice endpoint guard expected 409, got ${voiceGuardCheck.status}`);
  if (String(voiceGuardCheck?.body?.message || '') !== 'Voice must use Jarvis endpoint') {
    fail('voice endpoint guard message mismatch');
  }
  if (!String(voiceGuardCheck?.body?.traceId || '').trim()) fail('voice endpoint guard traceId missing');
  pass('non-Jarvis voice requests are rejected with 409 guard');

  const webConsentSession = `smoke_web_${Date.now()}`;
  const webConsentStart = await postJson('/api/jarvis/query', {
    message: 'nearest coffee shop',
    strategy: 'original',
    activeModule: 'bridge',
    contextHint: 'bridge',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId: webConsentSession,
    clientId: webConsentSession,
  }).catch((err) => fail(`jarvis web consent start failed (${err.message})`));
  if (webConsentStart?.consentPending !== true || !['location', 'web_search'].includes(String(webConsentStart?.consentKind || ''))) {
    fail('jarvis web consent start did not set pending location/web_search');
  }
  const webConsentCancel = await postJson('/api/jarvis/query', {
    message: 'no',
    strategy: 'original',
    activeModule: 'bridge',
    contextHint: 'bridge',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId: webConsentSession,
    clientId: webConsentSession,
  }).catch((err) => fail(`jarvis web consent cancel failed (${err.message})`));
  if (webConsentCancel?.consentPending === true) fail('jarvis web consent cancel did not clear pending state');
  pass('jarvis web consent pending/cancel flow is healthy');

  const tradingAfterWeb = await postJson('/api/jarvis/query', {
    message: 'should i take this setup now',
    strategy: 'original',
    activeModule: 'analyst',
    contextHint: 'analyst',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId: webConsentSession,
    clientId: webConsentSession,
    preferCachedLive: true,
  }, Math.max(30000, ASSISTANT_QUERY_BUDGET_MS + 15000)).catch((err) => fail(`jarvis trading-after-web flow failed (${err.message})`));
  if (!/^trading_/i.test(String(tradingAfterWeb?.intent || ''))) {
    fail('jarvis trading flow did not recover after web consent interaction');
  }
  pass('jarvis web consent state does not break trading flow');

  // Warm-up to avoid cold-start noise in latency assertions.
  await postJson('/api/analyst/chat', {
    message: 'what is todays outlook',
    strategy: 'original',
  }).catch(() => null);

  const fastStart = Date.now();
  const fastAnalyst = await postJson('/api/analyst/chat', {
    message: 'what is todays outlook',
    strategy: 'original',
  }).catch((err) => fail(`analyst chat failed (${err.message})`));
  const fastMs = Date.now() - fastStart;
  const fastReply = String(fastAnalyst?.response || '').trim();
  if (!fastReply) fail('analyst fast path returned empty response');
  const fastSource = String(fastAnalyst?.source || '');
  if (fastMs > ANALYST_FASTPATH_BUDGET_MS) fail(`analyst fast path too slow (${fastMs}ms)`);
  if (isRiskBlockedResponse(fastAnalyst)) {
    assertRiskGuardrailNarrative(fastReply, 'analyst fast path');
    pass(`analyst risk guardrail latency acceptable (${fastMs}ms)`);
  } else {
    if (!/^analyst_fastpath/.test(fastSource)) fail(`analyst fast path source mismatch (${fastSource || 'missing'})`);
    pass(`analyst fast path latency acceptable (${fastMs}ms)`);
  }

  const next = await postJson('/api/assistant/quick', {
    message: 'what should i do next',
    strategy: 'original',
    activeModule: 'analyst',
  }).catch((err) => fail(`quick endpoint failed (${err.message})`));
  if (next?.success !== true || next?.handled !== true) fail('quick next-step request not handled');
  const nextReply = String(next?.reply || '');
  if (isRiskBlockedResponse(next)) {
    assertRiskGuardrailNarrative(nextReply, 'quick next-step');
    pass('quick next-step request is guardrail-protected');
  } else {
    if (!/next step:/i.test(nextReply)) fail('quick next-step reply is missing "Next step:" guidance');
    pass('quick next-step guidance is actionable');
  }

  const queryStart = Date.now();
  const unified = await postJson('/api/assistant/query', {
    message: 'what is todays outlook and top setup right now',
    strategy: 'original',
    activeModule: 'analyst',
    preferCachedLive: true,
  }).catch((err) => fail(`assistant query endpoint failed (${err.message})`));
  const queryMs = Date.now() - queryStart;
  if (unified?.success === false || unified?.handled !== true) fail('assistant query did not return handled=true');
  const unifiedReply = String(unified?.reply || '').trim();
  if (!unifiedReply) fail('assistant query reply empty');
  if (/Completed:\s*$/i.test(unifiedReply)) fail('assistant query reply ended with completion artifact');
  if (queryMs > ASSISTANT_QUERY_BUDGET_MS) fail(`assistant query too slow (${queryMs}ms)`);
  pass(`assistant query latency acceptable (${queryMs}ms)`);

  const unifiedCached = await postJson('/api/assistant/query', {
    message: 'what is todays outlook and top setup right now',
    strategy: 'original',
    activeModule: 'analyst',
    preferCachedLive: true,
  }).catch((err) => fail(`assistant query cache-check failed (${err.message})`));
  if (isRiskBlockedResponse(unifiedCached)) {
    pass('assistant query risk guardrail path is active (cache bypass expected)');
  } else {
    if (unifiedCached?.cached !== true) fail('assistant query cache did not return cached=true on immediate repeat');
    pass('assistant query short-lived cache is active');
    if (String(unifiedCached?.mode || '').toLowerCase() === 'timeout') fail('assistant query entered timeout mode unexpectedly');
  }

  const orchestratedAnalyst = await postJson('/api/assistant/query', {
    message: 'was today a good day for me to not trade and stay out of the market',
    strategy: 'original',
    activeModule: 'analyst',
    preferCachedLive: true,
    forceOrchestrator: true,
  }, 15000).catch((err) => fail(`assistant orchestrator analyst check failed (${err.message})`));
  const orchestratedReply = String(orchestratedAnalyst?.reply || '').trim();
  if (!orchestratedReply) fail('assistant orchestrator analyst reply empty');
  if (isRiskBlockedResponse(orchestratedAnalyst)) {
    assertRiskGuardrailNarrative(orchestratedReply, 'assistant orchestrator analyst');
    pass('assistant orchestrator analyst request is guardrail-protected');
  } else {
    if (String(orchestratedAnalyst?.mode || '').toLowerCase() !== 'orchestrator') {
      fail(`assistant orchestrator analyst check did not stay in orchestrator mode (${orchestratedAnalyst?.mode || 'missing'})`);
    }
    if (/let me check|i(?:'|’)ll check|one moment|hold on|give me a second|let me take a look/i.test(orchestratedReply)) {
      fail('assistant orchestrator analyst reply leaked preamble-only content');
    }
    assertNoRigidAnalystLabels(orchestratedReply, 'assistant orchestrator analyst');
    if (!/\b(wait|stand down|stay out|trade|tradable|preserving capital|do not trade|don't trade)\b/i.test(orchestratedReply)) {
      fail('assistant orchestrator analyst reply missing clear stance language');
    }
    if (!/\b(range|blocker|score|confidence|golden zone|exhaust|volatility|risk|setup)\b/i.test(orchestratedReply)) {
      fail('assistant orchestrator analyst reply missing decision factors');
    }
    pass('assistant orchestrator analyst reply is decisive and preamble-free');
  }

  const quickNarrative = await postJson('/api/assistant/query', {
    message: 'should i stay out today',
    strategy: 'original',
    activeModule: 'analyst',
    preferCachedLive: true,
  }).catch((err) => fail(`assistant quick-intent narrative check failed (${err.message})`));
  const quickNarrativeReply = String(quickNarrative?.reply || '').trim();
  if (!quickNarrativeReply) fail('assistant quick-intent narrative reply empty');
  if (isRiskBlockedResponse(quickNarrative)) {
    assertRiskGuardrailNarrative(quickNarrativeReply, 'assistant quick-intent narrative');
    pass('assistant quick-intent narrative is guardrail-protected');
  } else {
    if (/let me check|i(?:'|’)ll check|one moment|hold on/i.test(quickNarrativeReply)) {
      fail('assistant quick-intent narrative reply leaked preamble text');
    }
    assertNoRigidAnalystLabels(quickNarrativeReply, 'assistant quick-intent narrative');
    if (!/\b(wait|stand down|stay out|trade|tradable|preserving capital|do not trade|don't trade)\b/i.test(quickNarrativeReply)) {
      fail('assistant quick-intent narrative reply missing stance language');
    }
    pass('assistant quick-intent narrative still returns natural guidance');
  }

  const trendReplyOut = await postJson('/api/assistant/query', {
    message: 'what trend are we in right now',
    strategy: 'original',
    activeModule: 'analyst',
    preferCachedLive: false,
  }, 15000).catch((err) => fail(`assistant trend/regime quick-intent check failed (${err.message})`));
  const trendReply = String(trendReplyOut?.reply || '').trim();
  if (!trendReply) fail('assistant trend/regime quick-intent reply empty');
  if (isRiskBlockedResponse(trendReplyOut)) {
    assertRiskGuardrailNarrative(trendReply, 'assistant trend/regime quick-intent');
    pass('assistant trend/regime request is guardrail-protected');
  } else {
    if (/pulling|checking|scanning|let me/i.test(trendReply)) {
      fail('assistant trend/regime quick-intent leaked preamble text');
    }
    if (!/(?:^|\n)\s*(Trend:|Regime:)/i.test(trendReply)) {
      fail('assistant trend/regime quick-intent missing Trend:/Regime: structure');
    }
    pass('assistant trend/regime quick-intent is direct and preamble-free');
  }

  const voiceSessionId = `smoke_voice_${Date.now()}`;
  const voiceFormatted = await postJson('/api/jarvis/query', {
    message: 'what is todays outlook and top setup right now',
    strategy: 'original',
    activeModule: 'analyst',
    contextHint: 'analyst',
    preferCachedLive: true,
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId: voiceSessionId,
    clientId: voiceSessionId,
  }).catch((err) => fail(`assistant voice-format endpoint failed (${err.message})`));
  const voiceReply = String(voiceFormatted?.reply || '').trim();
  if (!voiceReply) fail('assistant voice-format reply empty');
  if (/\n/.test(voiceReply)) fail('assistant voice-format reply should be single-line');
  if (/:\./.test(voiceReply)) fail('assistant voice-format reply has punctuation artifact');
  if (/[\[\]]/.test(voiceReply)) fail('assistant voice-format reply should not include raw bracket signals');
  if (/\b[1-4]\)\s/.test(voiceReply)) fail('assistant voice-format reply should convert numbered setup markers');
  pass('assistant voice-format reply is speech-friendly');

  const marketStart = Date.now();
  const marketState = await postJson('/api/assistant/quick', {
    message: 'what is current mnq price and market state right now',
    strategy: 'original',
    activeModule: 'analyst',
  }).catch((err) => fail(`quick market-state endpoint failed (${err.message})`));
  const marketMs = Date.now() - marketStart;
  const marketReply = String(marketState?.reply || '').trim();
  if (!marketReply) fail('quick market-state reply empty');
  if (!isRiskBlockedResponse(marketState)) {
    if (/around 0\.00/i.test(marketReply)) fail('quick market-state reported invalid 0.00 quote');
    if (!/mnq/i.test(marketReply)) fail('quick market-state missing MNQ context');
  } else {
    assertRiskGuardrailNarrative(marketReply, 'quick market-state');
  }
  if (marketMs > QUICK_MARKET_STATE_BUDGET_MS) fail(`quick market-state too slow (${marketMs}ms)`);
  pass('quick market-state reply is sane');

  const explainSessionId = `smoke_explain_${Date.now()}`;
  const blockedProbe = await postJson('/api/jarvis/query', {
    message: 'should i take this setup now',
    strategy: 'original',
    activeModule: 'analyst',
    contextHint: 'analyst',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    sessionId: explainSessionId,
    clientId: explainSessionId,
    preferCachedLive: false,
  }).catch((err) => fail(`assistant blocked-probe failed (${err.message})`));
  if (isRiskBlockedResponse(blockedProbe)) {
    const blockedProbeReply = String(blockedProbe?.reply || '');
    if (!/Say "explain" for details\./.test(blockedProbeReply)) {
      fail('blocked earbud reply missing explain follow-up hook');
    }
    const aliasChecks = [
      { endpoint: '/api/jarvis/query', message: 'tell me why', field: 'reply' },
      { endpoint: '/api/jarvis/query', message: 'what happened', field: 'reply' },
      { endpoint: '/api/jarvis/query', message: "why can't I", field: 'reply' },
      { endpoint: '/api/jarvis/query', message: 'give me details', field: 'reply' },
      { endpoint: '/api/jarvis/query', message: 'why not', field: 'reply' },
    ];
    for (const row of aliasChecks) {
      const body = {
        message: row.message,
        strategy: 'original',
        activeModule: 'analyst',
        contextHint: 'analyst',
        voiceMode: true,
        voiceBriefMode: 'earbud',
        sessionId: explainSessionId,
        clientId: explainSessionId,
        preferCachedLive: true,
      };
      const out = await postJson(row.endpoint, body)
        .catch((err) => fail(`assistant explain alias failed (${row.message} @ ${row.endpoint}): ${err.message}`));
      const reply = String(out?.[row.field] || '').trim();
      if (!/^Blocked:/i.test(reply)) fail(`explain alias did not return full brief (${row.message})`);
      if (!/Trades taken today:/i.test(reply)) fail(`explain alias missing trades count (${row.message})`);
      if (/Say "explain" for details\./.test(reply)) fail(`explain alias stayed in earbud mode (${row.message})`);
    }
    const nonMatchOut = await postJson('/api/jarvis/query', {
      message: 'tell me why this setup failed today',
      strategy: 'original',
      activeModule: 'analyst',
      contextHint: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      sessionId: explainSessionId,
      clientId: explainSessionId,
      preferCachedLive: true,
    }).catch((err) => fail(`assistant explain non-match failed (${err.message})`));
    const nonMatchReply = String(nonMatchOut?.reply || '').trim();
    if (/^Blocked:/i.test(nonMatchReply) && !/health/i.test(String(nonMatchOut?.source || ''))) {
      fail('non-matching explain sentence incorrectly triggered full-brief explain override');
    }
    pass('blocked earbud explain aliases return full brief; non-matching sentence does not');
  } else {
    pass('blocked earbud explain follow-up check skipped (no active risk block)');
  }

  const marketHealthStatus = String(marketHealth?.status || '').toUpperCase();
  if (marketHealthStatus !== 'OK') {
    const voiceHealthBlocked = await postJson('/api/jarvis/query', {
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      contextHint: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      preferCachedLive: false,
    }).catch((err) => fail(`voice health preflight probe failed (${err.message})`));
    const reply = String(voiceHealthBlocked?.reply || '').trim();
    const healthSource = String(voiceHealthBlocked?.source || '').trim().toLowerCase();
    const blockedByHealth = String(voiceHealthBlocked?.decisionBlockedBy || '').trim().toLowerCase() === 'health';
    if (
      healthSource !== 'assistant_voice_health_preflight'
      && healthSource !== 'jarvis_health_block'
      && !/health/.test(healthSource)
      && !blockedByHealth
    ) {
      fail(`voice health preflight source mismatch (${voiceHealthBlocked?.source || 'missing'})`);
    }
    if (!/^I'd sit out for now\b/i.test(reply) || !/live market data/i.test(reply)) {
      fail('voice health preflight reply missing required stance prefix');
    }
    pass('voice health preflight blocks decision flow when market health is not OK');
  } else {
    pass('voice health preflight block check skipped (market health currently OK)');
  }

  const systemStatus = await getJson('/api/system/status?strategy=original').catch((err) => fail(`system status failed (${err.message})`));
  if (!Number.isFinite(Number(systemStatus?.cacheStats?.assistantQueryInFlight))) fail('assistant query in-flight stat missing');
  const queryRuntime = systemStatus?.cacheStats?.assistantQueryRuntime;
  if (!queryRuntime || typeof queryRuntime !== 'object') fail('assistant query runtime stats missing from system status');
  if (!Number.isFinite(Number(queryRuntime.total))) fail('assistant query runtime total is not numeric');
  if (!Number.isFinite(Number(queryRuntime.cacheHitRatePct))) fail('assistant query runtime cacheHitRatePct missing');
  if (!Number.isFinite(Number(queryRuntime.inFlightJoined))) fail('assistant query runtime inFlightJoined missing');
  pass('assistant query runtime telemetry is exposed');

  let fallback = null;
  let fallbackError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      fallback = await postJson('/api/assistant/orchestrate', {
        message: 'do the quantum thing with all the vibes',
        strategy: 'original',
        activeModule: 'analyst',
      }, ORCHESTRATE_TIMEOUT_MS);
      fallbackError = null;
      break;
    } catch (err) {
      fallbackError = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  if (!fallback) {
    fail(`orchestrate endpoint failed (${fallbackError?.message || 'unknown_error'})`);
  }
  if (fallback?.success !== true) fail('orchestrate request did not succeed');
  const fallbackReply = String(fallback?.reply || '');
  if (fallbackReply.length < 80) fail('orchestrate fallback reply is too short');
  if (/I understood, but no safe action was selected/i.test(fallbackReply)) {
    fail('orchestrate fallback returned deprecated generic response');
  }
  pass('orchestrate fallback reply is strategic/non-generic');

  console.log('[assistant-smoke] COMPLETE');
}

main().catch((err) => fail(err?.message || 'unexpected_error'));
