'use strict';

function toEtDate(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return null;
  }
}

function extractEtDateFromText(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  const iso = txt.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return String(iso[1] || '');
  return null;
}

function resolveStaleThresholdMinutes() {
  const raw = Number(process.env.ANALYST_STALE_MINUTES || process.env.ASSISTANT_STALE_MINUTES || 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(3, Math.min(15, Math.round(raw)));
}

function hardenHealthStatus(input = {}) {
  const staleThresholdMinutes = resolveStaleThresholdMinutes();
  let status = String(input.status || 'STALE').trim().toUpperCase() || 'STALE';
  let reason = String(input.reason || '').trim();
  const hasTodaySessionBars = input.hasTodaySessionBars === true;
  const minutesSinceLastBar = Number(input.minutesSinceLastBar);
  const sessionDateOfData = String(input.sessionDateOfData || '').trim() || null;
  const todayEtDate = String(input.todayEtDate || toEtDate() || '').trim() || null;

  if (!hasTodaySessionBars) {
    status = 'STALE';
    reason = 'No fresh MNQ session bars for today.';
  } else if (Number.isFinite(minutesSinceLastBar) && minutesSinceLastBar > staleThresholdMinutes) {
    status = 'STALE';
    reason = `Topstep bars are stale (${Math.round(minutesSinceLastBar)}m old).`;
  } else if (sessionDateOfData && todayEtDate && sessionDateOfData !== todayEtDate) {
    status = 'STALE';
    reason = `Latest bar session date is ${sessionDateOfData}, not today (${todayEtDate}) ET.`;
  }

  return {
    status,
    blocked: status === 'DEGRADED' || status === 'STALE',
    reason: reason || 'market health unavailable',
    staleThresholdMinutes,
    todayEtDate,
    sessionDateOfData,
  };
}

function splitNarrativeLines(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return {
    stance: lines[0] || null,
    trigger: lines[1] || null,
    condition: lines[2] || null,
    details: lines,
  };
}

async function runHealthTool(ctx = {}) {
  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const activeModule = String(ctx.activeModule || 'analyst').trim().toLowerCase() || 'analyst';
  const message = String(ctx.message || '').trim();
  const strategy = String(ctx.strategy || 'original') === 'alt' ? 'alt' : 'original';
  const symbol = String(ctx.symbol || 'MNQ').trim().toUpperCase();
  const auditMock = (ctx.auditMock && typeof ctx.auditMock === 'object') ? ctx.auditMock : null;
  const intents = (ctx.intents && typeof ctx.intents === 'object')
    ? ctx.intents
    : (typeof deps.parseAssistantQuickIntents === 'function'
      ? deps.parseAssistantQuickIntents(message)
      : {});
  const preloadedMarketHealthSnapshot = (ctx.marketHealthSnapshot && typeof ctx.marketHealthSnapshot === 'object')
    ? ctx.marketHealthSnapshot
    : null;

  if (activeModule !== 'analyst') {
    return {
      ok: true,
      toolName: 'HealthTool',
      data: {
        status: 'OK',
        minutesSinceLastBar: null,
        contractIdInUse: null,
        hasTodaySessionBars: true,
        hasORBComplete: false,
        reason: null,
        sourceUsed: 'n/a',
        rollStatus: null,
        healthCtx: null,
        marketHealthSnapshot: null,
      },
      narrative: {},
      warnings: [],
      debug: { bypassed: 'activeModule_not_analyst' },
      metrics: {},
    };
  }

  if (auditMock && Object.prototype.hasOwnProperty.call(auditMock, 'healthStatus')) {
    const baseStatus = String(auditMock.healthStatus || 'OK').trim().toUpperCase() || 'OK';
    const baseBlocked = baseStatus === 'DEGRADED' || baseStatus === 'STALE';
    const reason = String(auditMock.healthReason || (baseBlocked ? 'audit_mock_health_block' : 'audit_mock_health_ok')).trim();
    const rawHasTodaySessionBars = baseStatus === 'DEGRADED' || baseStatus === 'STALE' ? false : true;
    const hasORBComplete = (baseStatus === 'DEGRADED' || baseStatus === 'STALE') ? false : (auditMock?.riskInputs?.orbComplete === true);
    const hardened = hardenHealthStatus({
      status: baseStatus,
      reason,
      hasTodaySessionBars: rawHasTodaySessionBars,
      minutesSinceLastBar: rawHasTodaySessionBars ? 1 : 9,
      sessionDateOfData: rawHasTodaySessionBars ? (auditMock?.riskInputs?.sessionDateEt || toEtDate()) : null,
      todayEtDate: toEtDate(),
    });
    const status = hardened.status;
    const blocked = hardened.blocked;
    const narrativeRaw = blocked
      ? (typeof deps.buildVoiceHealthBlockedReply === 'function'
        ? deps.buildVoiceHealthBlockedReply({ reason: hardened.reason })
        : "I'd sit out for now - my live market data isn't healthy.")
      : '';
    const hasTodaySessionBars = rawHasTodaySessionBars;
    return {
      ok: true,
      toolName: 'HealthTool',
      data: {
        status,
        blocked,
        minutesSinceLastBar: blocked ? 9 : 1,
        contractIdInUse: String(auditMock.contractIdInUse || 'MNQ-MOCK').trim(),
        hasTodaySessionBars,
        hasORBComplete,
        reason: hardened.reason,
        sourceUsed: 'audit_mock',
        rollStatus: 'OK',
        sessionDateOfData: hardened.sessionDateOfData,
        todayEtDate: hardened.todayEtDate,
        staleThresholdMinutes: hardened.staleThresholdMinutes,
        healthCtx: {
          checked: true,
          blocked,
          status,
          health: { status, reason: hardened.reason },
          reply: blocked ? String(narrativeRaw || '').trim() : null,
          intents,
        },
        marketHealthSnapshot: {
          status,
          reason: hardened.reason,
          contractId_in_use: String(auditMock.contractIdInUse || 'MNQ-MOCK').trim(),
          contract_roll_status: 'OK',
          topstep_bars: {
            ok: !blocked,
            bars_returned: hasTodaySessionBars ? 120 : 0,
            minutes_since_last_bar: blocked ? 9 : 1,
            last_close: Number(auditMock.lastClose || 25000.0),
          },
          orb_state: {
            hasORBComplete,
            orbWindow: '09:30-09:45 ET',
            orbBarsRequired: 3,
          },
        },
        nowEt: auditMock?.nowEt || null,
      },
      narrative: splitNarrativeLines(narrativeRaw),
      warnings: blocked ? [hardened.reason || `health_${status.toLowerCase()}`] : [],
      debug: {
        status,
        blocked,
        auditMock: true,
      },
      metrics: {
        minutesSinceLastBar: blocked ? 9 : 1,
        barsReturned: hasTodaySessionBars ? 120 : 0,
        hasORBComplete,
        hasTodaySessionBars,
      },
    };
  }

  if (preloadedMarketHealthSnapshot) {
    const statusRaw = String(preloadedMarketHealthSnapshot?.status || 'STALE').trim().toUpperCase();
    const minutesSinceLastBar = Number(preloadedMarketHealthSnapshot?.topstep_bars?.minutes_since_last_bar);
    const barsReturned = Number(preloadedMarketHealthSnapshot?.topstep_bars?.bars_returned || 0);
    const hasTodaySessionBars = barsReturned > 0;
    const hasORBComplete = preloadedMarketHealthSnapshot?.orb_state?.hasORBComplete === true;
    const reasonRaw = String(preloadedMarketHealthSnapshot?.reason || 'market health unavailable').trim();
    const sessionDateOfData = extractEtDateFromText(preloadedMarketHealthSnapshot?.topstep_bars?.last_bar_ts_et)
      || String(preloadedMarketHealthSnapshot?.db_persist?.sessions_last_date || '').trim()
      || null;
    const nowEtRaw = String(preloadedMarketHealthSnapshot?.now_et || '').trim();
    const todayEtDate = extractEtDateFromText(nowEtRaw) || toEtDate();
    const hardened = hardenHealthStatus({
      status: statusRaw,
      reason: reasonRaw,
      hasTodaySessionBars,
      minutesSinceLastBar,
      sessionDateOfData,
      todayEtDate,
    });
    const status = hardened.status;
    const blocked = hardened.blocked;
    const reason = hardened.reason;
    const sourceUsed = preloadedMarketHealthSnapshot?.topstep_bars?.ok
      ? 'topstep_bars'
      : (preloadedMarketHealthSnapshot?.db_persist ? 'db' : 'cache');
    const rollStatus = String(preloadedMarketHealthSnapshot?.contract_roll_status || '').trim() || null;
    const contractIdInUse = preloadedMarketHealthSnapshot?.contractId_in_use || null;
    const normalizedHealthCtx = {
      checked: true,
      blocked,
      status,
      health: {
        status,
        reason,
      },
      reply: blocked
        ? String((typeof deps.buildVoiceHealthBlockedReply === 'function'
          ? deps.buildVoiceHealthBlockedReply({ reason })
          : "I'd sit out for now - my live market data isn't healthy.")).trim()
        : null,
      intents,
    };
    const narrativeRaw = blocked ? String(normalizedHealthCtx.reply || '') : '';
    return {
      ok: true,
      toolName: 'HealthTool',
      data: {
        status,
        blocked,
        minutesSinceLastBar: Number.isFinite(minutesSinceLastBar) ? minutesSinceLastBar : null,
        contractIdInUse,
        hasTodaySessionBars,
        hasORBComplete,
        reason,
        sourceUsed,
        rollStatus,
        sessionDateOfData: hardened.sessionDateOfData,
        todayEtDate: hardened.todayEtDate,
        staleThresholdMinutes: hardened.staleThresholdMinutes,
        healthCtx: normalizedHealthCtx,
        marketHealthSnapshot: preloadedMarketHealthSnapshot,
        nowEt: preloadedMarketHealthSnapshot?.now_et || null,
      },
      narrative: splitNarrativeLines(narrativeRaw),
      warnings: blocked ? [reason || `health_${status.toLowerCase()}`] : [],
      debug: {
        status,
        blocked,
        preloadedSnapshot: true,
      },
      metrics: {
        minutesSinceLastBar: Number.isFinite(minutesSinceLastBar) ? minutesSinceLastBar : null,
        barsReturned,
        hasORBComplete,
        hasTodaySessionBars,
      },
    };
  }

  const healthCtx = await deps.getAnalystVoiceHealthPreflightBlock({
    activeModule: 'analyst',
    voiceMode: true,
    message,
    strategy,
    intents,
    symbol,
  });

  const marketHealthSnapshot = await deps.getMarketHealthSnapshotCached({
    symbol,
    live: false,
    compareLiveModes: true,
    lookbackMinutes: 120,
    forceFresh: ctx.forceFresh === true,
    triggerSource: 'health_tool',
  }).catch(() => null);

  const statusRaw = String(
    healthCtx?.status
    || marketHealthSnapshot?.status
    || 'STALE'
  ).trim().toUpperCase();
  const minutesSinceLastBar = Number(marketHealthSnapshot?.topstep_bars?.minutes_since_last_bar);
  const barsReturned = Number(marketHealthSnapshot?.topstep_bars?.bars_returned || 0);
  const hasTodaySessionBars = barsReturned > 0;
  const hasORBComplete = marketHealthSnapshot?.orb_state?.hasORBComplete === true;
  const reasonRaw = String(
    marketHealthSnapshot?.reason
    || healthCtx?.health?.reason
    || healthCtx?.reply
    || 'market health unavailable'
  ).trim();
  const sessionDateOfData = extractEtDateFromText(marketHealthSnapshot?.topstep_bars?.last_bar_ts_et)
    || String(marketHealthSnapshot?.db_persist?.sessions_last_date || '').trim()
    || null;
  const nowEtRaw = String(marketHealthSnapshot?.now_et || '').trim();
  const todayEtDate = extractEtDateFromText(nowEtRaw) || toEtDate();
  const hardened = hardenHealthStatus({
    status: statusRaw,
    reason: reasonRaw,
    hasTodaySessionBars,
    minutesSinceLastBar,
    sessionDateOfData,
    todayEtDate,
  });
  const status = hardened.status;
  const blocked = hardened.blocked;
  const reason = hardened.reason;
  const sourceUsed = marketHealthSnapshot?.topstep_bars?.ok
    ? 'topstep_bars'
    : (marketHealthSnapshot?.db_persist ? 'db' : 'cache');
  const rollStatus = String(marketHealthSnapshot?.contract_roll_status || '').trim() || null;
  const contractIdInUse = marketHealthSnapshot?.contractId_in_use || null;
  const normalizedHealthCtx = {
    checked: true,
    blocked,
    status,
    health: {
      ...(healthCtx?.health || {}),
      status,
      reason,
    },
    reply: blocked
      ? String((typeof deps.buildVoiceHealthBlockedReply === 'function'
        ? deps.buildVoiceHealthBlockedReply({ reason })
        : "I'd sit out for now - my live market data isn't healthy.")).trim()
      : null,
    intents,
  };
  const narrativeRaw = blocked
    ? String(normalizedHealthCtx.reply || '')
    : '';

  return {
    ok: true,
    toolName: 'HealthTool',
    data: {
      status,
      blocked,
      minutesSinceLastBar: Number.isFinite(minutesSinceLastBar) ? minutesSinceLastBar : null,
      contractIdInUse,
      hasTodaySessionBars,
      hasORBComplete,
      reason,
      sourceUsed,
      rollStatus,
      sessionDateOfData: hardened.sessionDateOfData,
      todayEtDate: hardened.todayEtDate,
      staleThresholdMinutes: hardened.staleThresholdMinutes,
      healthCtx: normalizedHealthCtx,
      marketHealthSnapshot: marketHealthSnapshot || null,
      nowEt: marketHealthSnapshot?.now_et || null,
    },
    narrative: splitNarrativeLines(narrativeRaw),
    warnings: blocked ? [reason || `health_${status.toLowerCase()}`] : [],
    debug: {
      status,
      blocked,
      healthStatusFromPreflight: healthCtx?.status || null,
      preflightChecked: healthCtx?.checked === true,
      hardened: status !== statusRaw || reason !== reasonRaw,
    },
    metrics: {
      minutesSinceLastBar: Number.isFinite(minutesSinceLastBar) ? minutesSinceLastBar : null,
      barsReturned,
      hasORBComplete,
      hasTodaySessionBars,
    },
  };
}

module.exports = {
  runHealthTool,
};
