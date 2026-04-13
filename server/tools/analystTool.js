'use strict';

function toSafeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripLegacyNarrativeTokens(text) {
  let out = String(text || '');
  out = out.replace(/^\s*\[(?:DON'?T TRADE|DONT TRADE|DO NOT TRADE|WAIT|TRADE)\]\s*/i, '');
  out = out.replace(/^\s*(?:DON'?T TRADE|DONT TRADE|DO NOT TRADE|WAIT|TRADE)\.?\s*/i, '');
  out = out.replace(/\b(?:WAIT|DON'?T TRADE|DONT TRADE|DO NOT TRADE|TRADE|WHY|BEST SETUP)\s*:\s*/gi, '');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

function splitNarrative(text) {
  const cleaned = stripLegacyNarrativeTokens(text);
  const sentenceParts = cleaned
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const details = sentenceParts.length > 0 ? sentenceParts : (cleaned ? [cleaned] : []);
  return {
    stance: details[0] || null,
    trigger: details[1] || null,
    condition: details[2] || null,
    details,
  };
}

function normalizeTopSetup(decision = {}, intelligence = {}) {
  const direct = decision?.topSetup || decision?.bestSetup || intelligence?.topSetup || null;
  if (direct && typeof direct === 'object') {
    const name = toSafeText(direct.name || direct.title || direct.setup || direct.id);
    return name ? {
      name,
      trigger: toSafeText(direct.trigger || direct.entry || ''),
      target: toSafeText(direct.target || direct.tp || ''),
      stop: toSafeText(direct.stop || direct.sl || ''),
    } : null;
  }
  const byName = toSafeText(
    decision?.topSetupName
    || decision?.bestSetupName
    || intelligence?.bestSetupName
    || ''
  );
  if (!byName) return null;
  return {
    name: byName,
    trigger: toSafeText(decision?.topSetupTrigger || intelligence?.topSetupTrigger || ''),
    target: toSafeText(decision?.topSetupTarget || intelligence?.topSetupTarget || ''),
    stop: toSafeText(decision?.topSetupStop || intelligence?.topSetupStop || ''),
  };
}

function normalizeBlockers(decision = {}) {
  const raw = Array.isArray(decision?.blockers) ? decision.blockers : [];
  return raw
    .map((b) => {
      if (!b) return null;
      if (typeof b === 'string') return toSafeText(b);
      if (typeof b === 'object') return toSafeText(b.code || b.id || b.title || b.reason || b.message || '');
      return null;
    })
    .filter(Boolean);
}

function deriveTrendSummary(decision = {}, intelligence = {}) {
  const pattern = intelligence?.market?.pattern || {};
  const trend = toSafeText(pattern?.patternLabel || decision?.trend || 'mixed').replace(/_/g, ' ');
  const regime = toSafeText(pattern?.patternLabel || decision?.regime || 'mixed').replace(/_/g, ' ');
  const volatility = toSafeText(pattern?.volatilityRegime || decision?.volatility || 'unknown').replace(/_/g, ' ');
  const bias = toSafeText(decision?.signalLabel || decision?.signal || intelligence?.bias || 'mixed').replace(/_/g, ' ');
  return {
    trend: trend || 'mixed',
    regime: regime || 'mixed',
    volatility: volatility || 'unknown',
    bias: bias || 'mixed',
  };
}

function safeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function getOrbRangeTicks(decision = {}, freshness = {}) {
  if (freshness?.hasORBComplete !== true) return null;
  return safeInt(decision?.orbRangeTicks);
}

function fallbackNowEt() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const pick = (type) => String(parts.find((p) => p.type === type)?.value || '00');
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${pick('hour')}:${pick('minute')}`,
  };
}

function getNowMinutesEt(freshness = {}, deps = {}) {
  const parseMinutesFromHHMM = typeof deps.parseMinutesFromHHMM === 'function'
    ? deps.parseMinutesFromHHMM
    : null;
  const hhmm = toSafeText(freshness?.nowEt?.time || fallbackNowEt().time);
  if (parseMinutesFromHHMM) return parseMinutesFromHHMM(hhmm, null);
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const hour = Number(match[1]);
  const min = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(min)) return null;
  return (hour * 60) + min;
}

function withTimeout(promiseLike, timeoutMs, timeoutMessage) {
  const ms = Math.max(1000, Number(timeoutMs || 0) || 7000);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(String(timeoutMessage || `timeout_${ms}ms`)));
    }, ms);
    Promise.resolve(promiseLike)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function buildStatusReply({ trendSummary, orbRangeTicks }) {
  const orbLine = Number.isFinite(orbRangeTicks)
    ? `ORB range is ${Math.round(orbRangeTicks)} ticks.`
    : 'ORB range is not finalized yet.';

  return [
    `Trend: ${trendSummary.trend}.`,
    `Regime: ${trendSummary.regime}.`,
    `Volatility: ${trendSummary.volatility}.`,
    `Bias: ${trendSummary.bias}.`,
    orbLine,
    'What it means for ORB: stay selective until structure confirms.',
  ].join(' ');
}

function buildAuditMockFreshness(auditMock = {}) {
  const riskInputs = (auditMock.riskInputs && typeof auditMock.riskInputs === 'object')
    ? auditMock.riskInputs
    : {};
  const raw = (riskInputs.marketDataFreshness && typeof riskInputs.marketDataFreshness === 'object')
    ? riskInputs.marketDataFreshness
    : {};
  const nowEt = (auditMock.nowEt && typeof auditMock.nowEt === 'object')
    ? {
      date: String(auditMock.nowEt.date || fallbackNowEt().date).slice(0, 10),
      time: String(auditMock.nowEt.time || fallbackNowEt().time).slice(0, 5),
    }
    : fallbackNowEt();
  const status = String(auditMock.healthStatus || 'OK').trim().toUpperCase();
  return {
    hasTodaySessionBars: raw.hasTodaySessionBars !== false && status !== 'STALE',
    hasORBComplete: raw.hasORBComplete === true,
    usedLiveBars: raw.usedLiveBars !== false && status !== 'STALE',
    minutesSinceLastCandle: Number.isFinite(Number(raw.minutesSinceLastCandle))
      ? Number(raw.minutesSinceLastCandle)
      : (status === 'STALE' ? 15 : 1),
    sessionDateOfData: String(raw.sessionDateOfData || nowEt.date).slice(0, 10),
    nowEt: {
      date: String(raw?.nowEt?.date || nowEt.date).slice(0, 10),
      time: String(raw?.nowEt?.time || nowEt.time).slice(0, 5),
    },
  };
}

function runAuditMockMode(ctx = {}) {
  const mode = String(ctx.mode || 'decision').trim().toLowerCase();
  const auditMock = (ctx.auditMock && typeof ctx.auditMock === 'object') ? ctx.auditMock : {};
  const freshness = buildAuditMockFreshness(auditMock);
  const trendSummary = {
    trend: toSafeText(auditMock.trend || 'mixed'),
    regime: toSafeText(auditMock.regime || 'mixed'),
    volatility: toSafeText(auditMock.volatility || 'normal'),
    bias: toSafeText(auditMock.bias || 'mixed'),
  };
  const orbRangeTicks = freshness.hasORBComplete
    ? safeInt(auditMock.orbRangeTicks ?? auditMock.riskInputs?.orbRangeTicks ?? null)
    : null;
  const nowMinutesEt = getNowMinutesEt(freshness, ctx.deps || {});

  const baseReply = mode === 'status'
    ? buildStatusReply({ trendSummary, orbRangeTicks })
    : "I'd stay selective right now while structure confirms. Let's focus on the next checkpoint and retest quality. If momentum and retest align, we can engage.";
  const reply = enforcePre945OrbGuard(stripLegacyNarrativeTokens(baseReply), freshness, nowMinutesEt);
  const liveBarsAvailable = freshness.usedLiveBars === true
    || (freshness.hasTodaySessionBars === true && Number(freshness.minutesSinceLastCandle) <= 5);
  return {
    ok: true,
    toolName: 'AnalystTool',
    data: {
      mode,
      reply,
      topSetup: null,
      orbRangeTicks,
      trendSummary,
      blockers: [],
      marketDataFreshness: freshness,
      nowMinutesEt,
      hasORBComplete: freshness.hasORBComplete === true,
      liveBarsAvailable,
      source: mode === 'status' ? 'jarvis_trading_status_audit_mock' : 'assistant_query_audit_mock',
      modeSource: 'audit_mock',
      unified: {
        reply,
        source: 'assistant_query_audit_mock',
        mode: 'audit_mock',
        commandsExecuted: [],
        clientActions: [],
      },
      commandsExecuted: [],
      clientActions: [],
      planner: null,
      terminal: null,
      liveSync: null,
      cmdSnapshot: null,
      intelligenceSnapshot: null,
    },
    narrative: splitNarrative(reply),
    warnings: [],
    debug: {
      auditMock: true,
      mode,
    },
    metrics: {
      blockersCount: 0,
      hasORBComplete: freshness.hasORBComplete === true,
      liveBarsAvailable,
    },
  };
}

function enforcePre945OrbGuard(reply, freshness = {}, nowMinutesEt = null) {
  const src = String(reply || '').trim();
  if (!src) return src;
  const pre945 = Number.isFinite(nowMinutesEt) && nowMinutesEt < 585;
  if (!pre945 || freshness?.hasORBComplete === true) return src;
  let out = src
    .replace(/\b(?:ORB|opening range)\b[^.!?]{0,30}\b(?:is|at)\s*\d+(?:\.\d+)?\s*ticks?\b\.?/gi, 'ORB range is not finalized yet.')
    .replace(/\b(?:ORB|opening range)\b[^.!?]{0,30}\bcomplete\b\.?/gi, 'ORB is not complete yet.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!/orb is not complete yet|orb range is not finalized yet/i.test(out)) {
    out = `${out} ORB is not complete yet, so range is not final.`;
  }
  return out;
}

async function runDecisionMode(ctx = {}) {
  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const message = String(ctx.message || '').trim();
  const strategy = String(ctx.strategy || 'original') === 'alt' ? 'alt' : 'original';
  const preferCachedLive = ctx.preferCachedLive === true;
  const unifiedQueryTimeoutMs = Math.max(
    3000,
    Number(process.env.JARVIS_ANALYST_UNIFIED_QUERY_TIMEOUT_MS || 12000)
  );
  let unified = null;
  let unifiedErrorCode = null;
  try {
    unified = await withTimeout(
      deps.runAssistantUnifiedQuery({
        message,
        strategy,
        activeModule: 'analyst',
        traceId: ctx.traceId || null,
        voiceMode: false,
        voiceBriefMode: 'full',
        preferCachedLive,
        forceOrchestrator: false,
      }),
      unifiedQueryTimeoutMs,
      'assistant_unified_query_timeout'
    );
  } catch (err) {
    unifiedErrorCode = /timeout/i.test(String(err?.message || ''))
      ? 'assistant_query_timeout'
      : 'assistant_query_unavailable';
  }
  if (!unified || typeof unified !== 'object') {
    const fallbackStatus = await runStatusMode({
      ...ctx,
      mode: 'status',
      preferCachedLive: true,
    });
    const fallbackReply = stripLegacyNarrativeTokens(String(fallbackStatus?.data?.reply || ''));
    const unifiedFallback = {
      reply: fallbackReply,
      source: 'assistant_query_timeout_fallback',
      mode: 'timeout_fallback',
      commandsExecuted: [],
      clientActions: [],
    };
    return {
      ok: true,
      toolName: 'AnalystTool',
      data: {
        ...(fallbackStatus?.data || {}),
        mode: 'decision',
        reply: fallbackReply,
        unified: unifiedFallback,
        source: 'assistant_query_timeout_fallback',
        modeSource: 'timeout_fallback',
        commandsExecuted: [],
        clientActions: [],
        planner: null,
        terminal: null,
      },
      narrative: splitNarrative(fallbackReply),
      warnings: [unifiedErrorCode || 'assistant_query_unavailable'],
      debug: {
        source: 'assistant_query_timeout_fallback',
        mode: 'timeout_fallback',
      },
      metrics: {
        blockersCount: Number((fallbackStatus?.data?.blockers || []).length || 0),
        hasORBComplete: fallbackStatus?.data?.hasORBComplete === true,
        liveBarsAvailable: fallbackStatus?.data?.liveBarsAvailable === true,
      },
    };
  }

  const cmdSnapshot = (ctx.cmdSnapshot && typeof ctx.cmdSnapshot === 'object')
    ? ctx.cmdSnapshot
    : (typeof deps.buildTradingCommandSnapshot === 'function'
      ? await deps.buildTradingCommandSnapshot(strategy, { forceFresh: false }).catch(() => null)
      : null);
  const intelligenceSnapshot = (ctx.intelligenceSnapshot && typeof ctx.intelligenceSnapshot === 'object')
    ? ctx.intelligenceSnapshot
    : (typeof deps.buildAssistantIntelligenceSnapshot === 'function'
      ? await deps.buildAssistantIntelligenceSnapshot({
        strategy,
        cmdSnapshot,
        liveSync: null,
        preferCachedLive,
        forceFresh: false,
      }).catch(() => null)
      : null);

  const decision = cmdSnapshot?.decision || {};
  const freshness = intelligenceSnapshot?.marketDataFreshness || {};
  const trendSummary = deriveTrendSummary(decision, intelligenceSnapshot || {});
  const orbRangeTicks = getOrbRangeTicks(decision, freshness);
  const topSetup = normalizeTopSetup(decision, intelligenceSnapshot || {});
  const blockers = normalizeBlockers(decision);
  const nowMinutesEt = getNowMinutesEt(freshness, deps);
  let canonicalAssistantDecisionBrief = null;
  if (typeof deps.buildCanonicalAssistantDecisionBrief === 'function') {
    try {
      canonicalAssistantDecisionBrief = await deps.buildCanonicalAssistantDecisionBrief({
        strategy,
        cmdSnapshot,
        intelligenceSnapshot,
        unified,
      });
    } catch {
      canonicalAssistantDecisionBrief = null;
    }
  }
  const canonicalAssistantDecisionBriefText = toSafeText(
    canonicalAssistantDecisionBrief?.assistantText
    || canonicalAssistantDecisionBrief?.assistantDecisionBriefText
    || unified?.assistantDecisionBriefText
    || unified?.assistantDecisionBrief?.assistantText
    || ''
  );
  const reply = enforcePre945OrbGuard(
    canonicalAssistantDecisionBriefText || stripLegacyNarrativeTokens(String(unified?.reply || '')),
    freshness,
    nowMinutesEt
  );

  return {
    ok: true,
    toolName: 'AnalystTool',
    data: {
      mode: 'decision',
      reply,
      assistantDecisionBriefText: canonicalAssistantDecisionBriefText || null,
      assistantDecisionBrief: (
        canonicalAssistantDecisionBrief
        && typeof canonicalAssistantDecisionBrief === 'object'
      ) ? canonicalAssistantDecisionBrief : null,
      unified: unified || null,
      topSetup,
      orbRangeTicks,
      trendSummary,
      blockers,
      marketDataFreshness: freshness,
      nowMinutesEt,
      hasORBComplete: freshness?.hasORBComplete === true,
      liveBarsAvailable: freshness?.usedLiveBars === true
        || (freshness?.hasTodaySessionBars === true && Number(freshness?.minutesSinceLastCandle) <= 5),
      commandsExecuted: Array.isArray(unified?.commandsExecuted) ? unified.commandsExecuted : [],
      clientActions: Array.isArray(unified?.clientActions) ? unified.clientActions : [],
      planner: unified?.planner || null,
      terminal: unified?.terminal || null,
      source: unified?.source || 'assistant_query',
      modeSource: String(unified?.mode || '').toLowerCase() || null,
    },
    narrative: splitNarrative(reply),
    warnings: [],
    debug: {
      source: unified?.source || null,
      mode: unified?.mode || null,
    },
    metrics: {
      blockersCount: blockers.length,
      hasORBComplete: freshness?.hasORBComplete === true,
      liveBarsAvailable: freshness?.usedLiveBars === true
        || (freshness?.hasTodaySessionBars === true && Number(freshness?.minutesSinceLastCandle) <= 5),
    },
  };
}

async function runStatusMode(ctx = {}) {
  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const strategy = String(ctx.strategy || 'original') === 'alt' ? 'alt' : 'original';
  const preferCachedLive = ctx.preferCachedLive === true;
  const topstepSyncTimeoutMs = Math.max(
    1000,
    Number(process.env.JARVIS_ANALYST_TOPSTEP_SYNC_TIMEOUT_MS || 7000)
  );

  let liveSync = null;
  const shouldAttemptLiveSync = (
    typeof deps.runTopstepReadOnlySync === 'function'
    && preferCachedLive !== true
  );
  if (shouldAttemptLiveSync) {
    try {
      liveSync = await withTimeout(
        deps.runTopstepReadOnlySync({
          force: false,
          triggerSource: 'jarvis_trading_status',
        }),
        topstepSyncTimeoutMs,
        'topstep_read_only_sync_timeout'
      );
    } catch {}
  }

  const cmdSnapshot = (ctx.cmdSnapshot && typeof ctx.cmdSnapshot === 'object')
    ? ctx.cmdSnapshot
    : (typeof deps.buildTradingCommandSnapshot === 'function'
      ? await deps.buildTradingCommandSnapshot(strategy, { forceFresh: !!liveSync }).catch(() => null)
      : null);

  const intelligenceSnapshot = (ctx.intelligenceSnapshot && typeof ctx.intelligenceSnapshot === 'object')
    ? ctx.intelligenceSnapshot
    : (typeof deps.buildAssistantIntelligenceSnapshot === 'function'
      ? await deps.buildAssistantIntelligenceSnapshot({
        strategy,
        cmdSnapshot,
        liveSync,
        preferCachedLive,
        forceFresh: !!liveSync,
      }).catch(() => null)
      : null);

  const decision = cmdSnapshot?.decision || {};
  const trendSummary = deriveTrendSummary(decision, intelligenceSnapshot || {});
  const marketFreshness = intelligenceSnapshot?.marketDataFreshness || {};
  const orbRangeTicks = getOrbRangeTicks(decision, marketFreshness);
  const blockers = normalizeBlockers(decision);
  const topSetup = normalizeTopSetup(decision, intelligenceSnapshot || {});
  const nowMinutesEt = getNowMinutesEt(marketFreshness, deps);
  const reply = enforcePre945OrbGuard(stripLegacyNarrativeTokens(buildStatusReply({
    trendSummary,
    orbRangeTicks,
  })), marketFreshness, nowMinutesEt);

  return {
    ok: true,
    toolName: 'AnalystTool',
    data: {
      mode: 'status',
      reply,
      topSetup,
      orbRangeTicks,
      trendSummary,
      blockers,
      marketDataFreshness: marketFreshness,
      nowMinutesEt,
      hasORBComplete: marketFreshness?.hasORBComplete === true,
      liveBarsAvailable: marketFreshness?.usedLiveBars === true
        || (marketFreshness?.hasTodaySessionBars === true && Number(marketFreshness?.minutesSinceLastCandle) <= 5),
      liveSync,
      cmdSnapshot,
      intelligenceSnapshot,
      source: 'jarvis_trading_status',
    },
    narrative: splitNarrative(reply),
    warnings: [],
    debug: {
      hasLiveSync: !!liveSync,
    },
    metrics: {
      blockersCount: blockers.length,
      hasORBComplete: marketFreshness?.hasORBComplete === true,
      liveBarsAvailable: marketFreshness?.usedLiveBars === true
        || (marketFreshness?.hasTodaySessionBars === true && Number(marketFreshness?.minutesSinceLastCandle) <= 5),
    },
  };
}

async function runAnalystTool(ctx = {}) {
  const activeModule = String(ctx.activeModule || 'analyst').trim().toLowerCase() || 'analyst';
  const mode = String(ctx.mode || 'decision').trim().toLowerCase();
  const auditMock = (ctx.auditMock && typeof ctx.auditMock === 'object') ? ctx.auditMock : null;

  if (activeModule !== 'analyst') {
    return {
      ok: true,
      toolName: 'AnalystTool',
      data: {
        mode,
        reply: '',
        topSetup: null,
        orbRangeTicks: null,
        trendSummary: { trend: 'mixed', regime: 'mixed', volatility: 'unknown', bias: 'mixed' },
        blockers: [],
        marketDataFreshness: null,
        nowMinutesEt: null,
        hasORBComplete: false,
        liveBarsAvailable: false,
        source: null,
      },
      narrative: {},
      warnings: [],
      debug: { bypassed: 'activeModule_not_analyst' },
      metrics: {},
    };
  }

  if (auditMock) {
    return runAuditMockMode({ ...ctx, mode, auditMock });
  }

  if (mode === 'status') {
    return runStatusMode(ctx);
  }
  return runDecisionMode(ctx);
}

module.exports = {
  runAnalystTool,
};
