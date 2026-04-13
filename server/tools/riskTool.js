'use strict';

const CACHE_TTL_MS = 10 * 60 * 1000;
const explainCache = new Map();
let externalExplainStore = null;
const EXPLAIN_STATE_TYPE = 'risk_explain';

function nowMs() {
  return Date.now();
}

function normalizeSessionKey(input = {}) {
  const direct = String(input.sessionKey || '').trim();
  if (direct) return direct;
  const sid = String(input.sessionId || input.clientId || '').trim();
  if (sid) return sid.startsWith('jarvis:') ? sid : `jarvis:${sid}`;
  return 'jarvis:default';
}

function pruneExplainCache() {
  const now = nowMs();
  for (const [key, row] of explainCache.entries()) {
    if (!row || now > Number(row.expiresAtMs || 0)) {
      explainCache.delete(key);
    }
  }
}

function rememberRiskExplain(sessionKey, payload = {}) {
  const key = normalizeSessionKey({ sessionKey });
  if (externalExplainStore && typeof externalExplainStore.put === 'function') {
    externalExplainStore.put({
      stateType: EXPLAIN_STATE_TYPE,
      stateKey: key,
      sessionId: String(key || '').replace(/^jarvis:/, ''),
      sessionKey: key,
      ttlMs: CACHE_TTL_MS,
      payload: {
        savedAtMs: nowMs(),
        payload,
      },
    });
  } else {
    explainCache.set(key, {
      savedAtMs: nowMs(),
      expiresAtMs: nowMs() + CACHE_TTL_MS,
      payload,
    });
    pruneExplainCache();
  }
  return key;
}

function getRiskExplain(sessionKey) {
  const key = normalizeSessionKey({ sessionKey });
  if (externalExplainStore && typeof externalExplainStore.get === 'function') {
    const row = externalExplainStore.get({
      stateType: EXPLAIN_STATE_TYPE,
      stateKey: key,
    });
    if (!row) return null;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const savedAtMs = Number(payload.savedAtMs || row.updatedAtMs || 0) || 0;
    return {
      key,
      payload: payload.payload || null,
      savedAtMs,
      ageMs: Math.max(0, nowMs() - savedAtMs),
    };
  }
  pruneExplainCache();
  const row = explainCache.get(key);
  if (!row) return null;
  if (nowMs() > Number(row.expiresAtMs || 0)) {
    explainCache.delete(key);
    return null;
  }
  return {
    key,
    payload: row.payload || null,
    savedAtMs: Number(row.savedAtMs || 0),
    ageMs: Math.max(0, nowMs() - Number(row.savedAtMs || 0)),
  };
}

function configureRiskExplainStore(store) {
  externalExplainStore = store && typeof store === 'object' ? store : null;
}

function mapRiskReasonCode(code, precedenceMode, healthCtx = {}) {
  const txt = String(code || '').trim().toLowerCase();
  if (precedenceMode === 'position') return 'open_position';
  if (precedenceMode === 'health_block') {
    const reason = String(healthCtx?.health?.reason || '').toLowerCase();
    if (/stale|fresh|bars|no data|lag/.test(reason)) return 'stale_data';
    return 'health_degraded';
  }
  if (txt === 'one_trade_per_day') return 'trade_cap';
  if (txt === 'cooldown_after_loss') return 'cooldown';
  if (txt === 'outside_entry_window') return 'outside_window';
  if (txt === 'daily_loss_limit') return 'loss_limit';
  if (txt === 'trailing_drawdown') return 'trailing_drawdown';
  if (txt === 'max_contracts') return 'max_contracts';
  if (txt === 'has_open_position') return 'open_position';
  if (txt === 'data_stale') return 'stale_data';
  return txt || 'none';
}

function buildHealthExplainPayload(healthCtx = {}, riskState = {}) {
  const status = String(healthCtx?.status || 'STALE').toUpperCase();
  const reason = String(healthCtx?.health?.reason || 'live market health not OK').trim();
  const lines = [
    `Blocked: market health is ${status.toLowerCase()}.`,
    `Reason: ${reason}.`,
    `Trades taken today: ${Number(riskState?.tradesTakenToday || 0)}/${Number(riskState?.maxTradesPerDay || 1)}.`,
    `Entry window: ${riskState?.inEntryWindow ? 'inside' : 'outside'} (${riskState?.entryWindowStartEt || '09:30'}-${riskState?.entryWindowEndEt || '10:59'} ET).`,
    'Next allowed condition: health status returns to OK with fresh bars flowing.',
  ];
  return lines.join('\n');
}

function splitNarrativeLines(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const first = lines[0] || null;
  const second = lines[1] || null;
  const third = lines[2] || null;
  return {
    stance: first,
    trigger: second,
    condition: third,
    details: lines,
  };
}

async function runRiskTool(ctx = {}) {
  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const message = String(ctx.message || '').trim();
  const activeModule = String(ctx.activeModule || 'analyst').trim().toLowerCase() || 'analyst';
  const strategy = String(ctx.strategy || 'original') === 'alt' ? 'alt' : 'original';
  const voiceBriefMode = String(ctx.voiceBriefMode || 'earbud').trim().toLowerCase() || 'earbud';
  const preferCachedLive = ctx.preferCachedLive === true;
  const sessionKey = normalizeSessionKey({
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    clientId: ctx.clientId,
  });

  const intents = (ctx.intents && typeof ctx.intents === 'object')
    ? ctx.intents
    : (typeof deps.parseAssistantQuickIntents === 'function'
      ? deps.parseAssistantQuickIntents(message)
      : {});

  if (activeModule !== 'analyst') {
    return {
      ok: true,
      toolName: 'RiskTool',
      data: {
        verdict: 'ALLOW',
        blockReason: 'none',
        explainPayload: null,
        allowTrading: true,
        precedenceMode: 'normal',
        riskState: null,
        healthStatus: null,
        hasOpenPosition: false,
        sessionKey,
      },
      narrative: {},
      warnings: [],
      debug: { bypassed: 'activeModule_not_analyst' },
      metrics: {},
    };
  }

  let analystRiskCtx = (ctx.analystRiskCtx && typeof ctx.analystRiskCtx === 'object')
    ? ctx.analystRiskCtx
    : null;
  let healthCtx = (ctx.healthCtx && typeof ctx.healthCtx === 'object')
    ? ctx.healthCtx
    : null;
  if (!analystRiskCtx && ctx.auditMock && typeof deps.buildJarvisMockRiskState === 'function') {
    const mockRisk = (ctx.auditMock.riskState && typeof ctx.auditMock.riskState === 'object')
      ? ctx.auditMock.riskState
      : deps.buildJarvisMockRiskState(ctx.auditMock);
    const mockHealthStatus = String(ctx.auditMock.healthStatus || 'OK').trim().toUpperCase();
    const mockBlocked = mockHealthStatus === 'DEGRADED' || mockHealthStatus === 'STALE';
    analystRiskCtx = {
      enabled: true,
      riskState: mockRisk,
      readiness: null,
      marketDataFreshness: mockRisk?.marketDataFreshness || null,
    };
    healthCtx = healthCtx || {
      checked: true,
      blocked: mockBlocked,
      status: mockHealthStatus,
      health: {
        status: mockHealthStatus,
        reason: String(ctx.auditMock.healthReason || 'audit_mock').trim() || 'audit_mock',
      },
      reply: mockBlocked && typeof deps.buildVoiceHealthBlockedReply === 'function'
        ? deps.buildVoiceHealthBlockedReply({ reason: String(ctx.auditMock.healthReason || 'audit_mock') })
        : null,
      intents,
    };
  } else if (!analystRiskCtx) {
    analystRiskCtx = await deps.buildAnalystRiskStateRuntime({
      activeModule: 'analyst',
      strategy,
      preferCachedLive,
      nowEt: ctx.nowEt || undefined,
      sessionDateEt: ctx.sessionDateEt || undefined,
    });
  }
  if (!healthCtx) {
    healthCtx = await deps.getAnalystVoiceHealthPreflightBlock({
      activeModule: 'analyst',
      voiceMode: true,
      message,
      strategy,
      intents,
      symbol: ctx.symbol,
    });
  }

  const riskState = analystRiskCtx?.riskState || null;
  const precedence = deps.resolveAnalystPrecedence({
    hasOpenPosition: riskState?.hasOpenPosition === true,
    healthStatus: healthCtx?.status || null,
    riskVerdict: riskState?.riskVerdict || null,
  });
  const precedenceMode = String(precedence?.mode || 'normal').trim() || 'normal';
  const primaryRiskCode = String((riskState?.riskReasonCodes || [])[0] || '').trim().toLowerCase() || null;
  const blockReason = mapRiskReasonCode(primaryRiskCode, precedenceMode, healthCtx);
  const blocked = (
    precedenceMode === 'position'
    || (precedenceMode === 'health_block' && healthCtx?.blocked === true)
    || precedenceMode === 'risk_block'
  );
  const verdict = blocked ? 'BLOCK' : 'ALLOW';
  const allowTrading = !blocked;

  let explainPayload = null;
  if (blocked) {
    if (precedenceMode === 'health_block') {
      explainPayload = buildHealthExplainPayload(healthCtx, riskState || {});
    } else if (typeof deps.buildAnalystRiskGuardrailReply === 'function') {
      explainPayload = deps.buildAnalystRiskGuardrailReply(riskState || {}, { voiceBriefMode: 'full' });
    }
    rememberRiskExplain(sessionKey, {
      sessionKey,
      savedAt: new Date().toISOString(),
      precedenceMode,
      blockReason,
      explainPayload,
      riskState: riskState || null,
      health: healthCtx?.health || null,
    });
  }

  let stanceText = null;
  if (blocked) {
    if (precedenceMode === 'health_block') {
      stanceText = String(healthCtx?.reply || '').trim();
    } else if (typeof deps.buildAnalystRiskGuardrailReply === 'function') {
      stanceText = deps.buildAnalystRiskGuardrailReply(riskState || {}, { voiceBriefMode });
    }
  }
  const narrativeParts = splitNarrativeLines(stanceText || '');

  return {
    ok: true,
    toolName: 'RiskTool',
    data: {
      verdict,
      blockReason,
      explainPayload,
      allowTrading,
      precedenceMode,
      riskState: riskState || null,
      healthStatus: healthCtx?.status || null,
      hasOpenPosition: riskState?.hasOpenPosition === true,
      sessionKey,
      primaryRiskCode,
      riskVerdict: riskState?.riskVerdict || null,
      health: healthCtx?.health || null,
      healthBlocked: healthCtx?.blocked === true,
      analystRiskCtx,
      healthCtx,
    },
    narrative: narrativeParts,
    warnings: blocked ? [String(blockReason || 'risk_blocked')] : [],
    debug: {
      intents,
      precedenceMode,
      primaryRiskCode,
      healthStatus: healthCtx?.status || null,
      riskVerdict: riskState?.riskVerdict || null,
    },
    metrics: {
      tradesTakenToday: Number(riskState?.tradesTakenToday || 0),
      maxTradesPerDay: Number(riskState?.maxTradesPerDay || 1),
      inEntryWindow: riskState?.inEntryWindow === true,
      dailyPnL: Number.isFinite(Number(riskState?.dailyPnL)) ? Number(riskState.dailyPnL) : null,
    },
  };
}

module.exports = {
  runRiskTool,
  getRiskExplain,
  rememberRiskExplain,
  configureRiskExplainStore,
};
