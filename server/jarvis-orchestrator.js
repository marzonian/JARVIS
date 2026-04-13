const {
  createJarvisConsentManager,
  normalizeCityInput,
  normalizeLocationHint,
  parseConsentReply,
  parseLocationConsentAction,
  parseLocationHintFromText,
  parseWebLookupIntent,
} = require('./jarvis-core/consent');
const {
  createJarvisExecutiveLayer,
  parsePreferenceStatement,
  detectRiskyTradingExecution,
  parseOsActionRequest,
} = require('./jarvis-core/executive');
const {
  DEFAULT_RECOVERY_WINDOW_MS,
  createJarvisPendingEngine,
} = require('./jarvis-core/pending-engine');
const {
  analyzeJarvisIntent,
  classifyJarvisIntent: classifyJarvisIntentCore,
  CLARIFY_PROMPT,
  isDirectTradingResultQuery,
  isTradingPostmortemReviewQuery,
} = require('./jarvis-core/intent');
const { getSkillIdByIntent } = require('./jarvis-core/skill-registry');
const {
  startShoppingFlow,
  startProjectFlow,
} = require('./jarvis-core/advisor-planner');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function inferRegionFromCityLabel(cityText) {
  const text = String(cityText || '').trim();
  if (!text) return null;
  const abbr = text.match(/,\s*([a-z]{2})\b/i);
  if (abbr) return String(abbr[1] || '').toUpperCase();
  const stateWord = text.match(/,\s*(new jersey|new york|delaware)\b/i);
  if (!stateWord) return null;
  const key = String(stateWord[1] || '').toLowerCase();
  if (key === 'new jersey') return 'NJ';
  if (key === 'new york') return 'NY';
  if (key === 'delaware') return 'DE';
  return null;
}

const PENDING_RECOVERY_WINDOW_MS = DEFAULT_RECOVERY_WINDOW_MS;

function buildPendingActionLabel(kind) {
  const key = String(kind || '').trim().toLowerCase();
  if (key === 'location') return 'a location confirmation';
  if (key === 'web_search') return 'a web lookup confirmation';
  if (key === 'web_directions_select') return 'a result selection';
  if (key === 'web_directions_confirm') return 'a directions confirmation';
  if (key === 'trade_execution') return 'a trade execution confirmation';
  if (key === 'os_action') return 'an OS action confirmation';
  return 'a pending action';
}

function resolveLocalSearchSkillState(kind) {
  const key = String(kind || '').trim().toLowerCase();
  if (key === 'location') return 'location_needed';
  if (key === 'web_search') return 'confirm_search';
  if (key === 'web_directions_select') return 'confirm_directions_select';
  if (key === 'web_directions_confirm') return 'confirm_directions_execute';
  return null;
}


function buildPendingDiagnostics(state, item) {
  const pending = item && typeof item === 'object'
    ? {
      kind: String(item.kind || '').trim() || null,
      createdAt: Number(item.requestedAt || 0) || null,
      sessionKey: String(item.sessionKey || '').trim() || null,
      clientId: String(item.clientId || '').trim() || null,
    }
    : null;
  const recoveredFromSessionId = state?.recoveredFromSessionId
    ? String(state.recoveredFromSessionId)
    : null;
  const pendingKind = pending?.kind || null;
  const skillId = (
    pendingKind === 'location'
    || String(pendingKind || '').startsWith('web_')
  ) ? 'LocalSearch' : null;
  return {
    pendingActionKind: pendingKind,
    pendingActionCreatedAt: pending?.createdAt || null,
    pendingActionSessionKey: pending?.sessionKey || null,
    pendingActionClientId: pending?.clientId || null,
    recoveredFromSessionId,
    pendingRecoveryUsed: !!recoveredFromSessionId,
    topicShiftGuardTriggered: false,
    pendingSelectionMatcher: null,
    skillId,
    skillState: skillId ? resolveLocalSearchSkillState(pendingKind) : null,
  };
}

function isConfirmPhrase(message) {
  return parseConsentReply(message) === 'YES';
}

function isCancelPhrase(message) {
  return parseConsentReply(message) === 'NO';
}

function buildToolReceipt(input = {}) {
  const startedAt = String(input.startedAt || new Date().toISOString());
  const completedAt = String(input.completedAt || new Date().toISOString());
  return {
    traceId: input.traceId ? String(input.traceId) : null,
    intent: input.intent ? String(input.intent) : null,
    tool: String(input.tool || 'Jarvis'),
    consent: (input.consent && typeof input.consent === 'object')
      ? {
        kind: input.consent.kind ? String(input.consent.kind) : null,
        granted: input.consent.granted === true,
        timestamp: input.consent.timestamp ? String(input.consent.timestamp) : completedAt,
      }
      : null,
    parameters: input.parameters && typeof input.parameters === 'object' ? input.parameters : {},
    result: input.result && typeof input.result === 'object' ? input.result : {},
    startedAt,
    completedAt,
  };
}

function classifyJarvisIntent(message, options = {}) {
  return classifyJarvisIntentCore(message, options);
}

function classifyJarvisIntentDetailed(message, options = {}) {
  return analyzeJarvisIntent(message, options);
}

function createMemoryStore(options = {}) {
  const stateStore = options.stateStore && typeof options.stateStore === 'object' ? options.stateStore : null;
  const useDurable = !!(stateStore && typeof stateStore.put === 'function');
  const stateType = 'preference_memory';
  const sessions = new Map();
  return {
    get(sessionId, key) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      const prefKey = String(key || '').trim();
      if (!prefKey) return null;
      if (useDurable) {
        const row = stateStore.get({
          stateType,
          stateKey: `${sid}:${prefKey}`,
        });
        if (!row) return null;
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
        return {
          key: String(payload.key || prefKey),
          value: String(payload.value || ''),
          sourceText: String(payload.sourceText || ''),
          updatedAt: String(payload.updatedAt || new Date().toISOString()),
        };
      }
      const row = sessions.get(sid);
      if (!row) return null;
      return row.get(prefKey) || null;
    },
    set(sessionId, key, value, sourceText) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      const prefKey = String(key || '').trim();
      if (!prefKey) return null;
      const record = {
        key: prefKey,
        value: String(value || ''),
        sourceText: String(sourceText || ''),
        updatedAt: new Date().toISOString(),
      };
      if (useDurable) {
        stateStore.put({
          stateType,
          stateKey: `${sid}:${prefKey}`,
          sessionId: sid,
          sessionKey: `jarvis:${sid}`,
          persist: true,
          payload: record,
        });
      } else {
        if (!sessions.has(sid)) sessions.set(sid, new Map());
        const row = sessions.get(sid);
        row.set(record.key, record);
      }
      return record;
    },
    list(sessionId) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      if (useDurable) {
        const rows = stateStore.listBySessionPrefix({
          stateType,
          sessionId: sid,
          stateKeyPrefix: `${sid}:`,
          limit: 100,
        });
        return rows
          .map((row) => row.payload)
          .filter((payload) => payload && typeof payload === 'object')
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      }
      const row = sessions.get(sid);
      if (!row) return [];
      return Array.from(row.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
  };
}

function createPendingStore(options = {}) {
  const stateStore = options.stateStore && typeof options.stateStore === 'object' ? options.stateStore : null;
  const useDurable = !!(stateStore && typeof stateStore.put === 'function');
  const stateType = 'general_pending';
  const pending = new Map();
  return {
    get(sessionId) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      if (useDurable) {
        const row = stateStore.get({
          stateType,
          stateKey: sid,
        });
        if (!row) return null;
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
        return {
          ...payload,
          sessionId: sid,
          createdAt: Number(payload.createdAt || row.createdAtMs || 0) || 0,
          expiresAt: Number(payload.expiresAt || row.expiresAtMs || 0) || 0,
        };
      }
      const item = pending.get(sid);
      if (!item) return null;
      if (Date.now() > Number(item.expiresAt || 0)) {
        pending.delete(sid);
        return null;
      }
      return item;
    },
    set(sessionId, item, ttlMs = 10 * 60 * 1000) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      const next = {
        ...item,
        createdAt: Date.now(),
        expiresAt: Date.now() + Math.max(30_000, Number(ttlMs || 0)),
      };
      if (useDurable) {
        stateStore.put({
          stateType,
          stateKey: sid,
          sessionId: sid,
          sessionKey: `jarvis:${sid}`,
          clientId: String(item?.clientId || '').trim() || null,
          ttlMs: Math.max(30_000, Number(ttlMs || 0)),
          payload: next,
        });
      } else {
        pending.set(sid, next);
      }
      return next;
    },
    clear(sessionId) {
      const sid = String(sessionId || '').trim() || 'jarvis_default';
      if (useDurable) {
        stateStore.remove({
          stateType,
          stateKey: sid,
        });
      } else {
        pending.delete(sid);
      }
    },
  };
}

function createJarvisOrchestrator(deps = {}) {
  const durableStateStore = deps.durableStateStore && typeof deps.durableStateStore === 'object'
    ? deps.durableStateStore
    : null;
  const memory = deps.memoryStore || createMemoryStore({
    stateStore: durableStateStore,
  });
  const consent = deps.consentManager || createJarvisConsentManager({
    ttlMs: Math.max(30_000, Number(deps.consentTtlMs || 90_000)),
    stateStore: durableStateStore,
  });
  const pendingEngine = deps.pendingEngine || createJarvisPendingEngine({
    consentManager: consent,
    recoveryWindowMs: PENDING_RECOVERY_WINDOW_MS,
    generalStore: deps.pendingStore || createPendingStore({
      stateStore: durableStateStore,
    }),
  });
  const executive = deps.executiveLayer || createJarvisExecutiveLayer({
    classifyIntentDetailed: analyzeJarvisIntent,
    parseWebIntent: parseWebLookupIntent,
    getSessionLocation: ({ sessionId, clientId } = {}) => (
      deps.getSessionLocation
        ? deps.getSessionLocation({ sessionId, clientId })
        : null
    ),
  });
  const osAllowList = new Set(
    String(deps.osAllowList || 'open_app,open_url,close_app,uninstall_app')
      .split(',')
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean)
  );

  function deriveSkillState(intent, payload = {}, plan = null) {
    if (payload && typeof payload.skillState === 'string' && payload.skillState.trim()) {
      return String(payload.skillState).trim();
    }
    const selectedSkill = payload?.selectedSkill || payload?.skillId || plan?.skillId || getSkillIdByIntent(intent) || null;
    const decisionMode = payload?.decisionMode || plan?.responseMode || null;
    if (selectedSkill === 'GeneralConversation') {
      return decisionMode === 'ask_clarify' ? 'clarify' : 'converse';
    }
    if (selectedSkill === 'LocalSearch') {
      if (payload?.consentKind) {
        const mapped = resolveLocalSearchSkillState(payload.consentKind);
        if (mapped) return mapped;
      }
      const sourceCount = Array.isArray(payload?.web?.sources) ? payload.web.sources.length : 0;
      if (sourceCount > 0) return 'results_presented';
    }
    return null;
  }

  function buildConsentState(payload = {}, plan = null) {
    return {
      pending: payload?.consentPending === true,
      kind: payload?.consentKind || plan?.consentKind || null,
      required: plan?.consentRequired === true,
      needLocation: payload?.consentNeedLocation === true || (Array.isArray(plan?.requiredInputsMissing) && plan.requiredInputsMissing.includes('location')),
    };
  }

  function applyExecutiveMeta(payload = {}, plan = null, extras = {}) {
    const response = payload && typeof payload === 'object' ? { ...payload } : {};
    const intent = String(response.intent || extras.intent || plan?.intent || 'general_chat').trim().toLowerCase() || 'general_chat';
    const selectedSkill = response.selectedSkill || response.skillId || extras.selectedSkill || plan?.skillId || getSkillIdByIntent(intent) || null;
    const decisionMode = response.decisionMode || extras.decisionMode || plan?.responseMode || 'invoke_tools';
    const consentState = (
      response?.consentState && typeof response.consentState === 'object'
    ) ? response.consentState : buildConsentState(response, plan);
    const confirmationState = (
      response?.confirmationState && typeof response.confirmationState === 'object'
    ) ? response.confirmationState : (
      (plan?.confirmationState && typeof plan.confirmationState === 'object')
        ? plan.confirmationState
        : {
          pending: false,
          required: plan?.confirmationRequired === true,
          kind: null,
        }
    );
    const pendingState = (
      response?.pendingState && typeof response.pendingState === 'object'
    ) ? response.pendingState : (
      (plan?.pendingState && typeof plan.pendingState === 'object')
        ? plan.pendingState
        : {
          present: !!response?.pendingActionKind || !!plan?.pendingActionKind,
          kind: response?.pendingActionKind || plan?.pendingActionKind || null,
        }
    );
    return {
      ...response,
      intent,
      selectedSkill,
      skillId: response.skillId || selectedSkill,
      skillState: deriveSkillState(intent, response, plan),
      decisionMode,
      consentState,
      confirmationState,
      pendingState,
      executivePlan: response.executivePlan || plan || null,
    };
  }

  function withToolPayload(base = {}, out = {}) {
    return {
      ...base,
      traceId: out?.traceId || base.traceId || null,
      source: out?.source || base.source || 'jarvis_orchestrator',
      routePath: out?.routePath || base.routePath || null,
      routePathTag: out?.routePathTag || out?.routePath || out?.source || base.routePathTag || base.routePath || base.source || 'jarvis_orchestrator',
      activeModule: out?.activeModule || base.activeModule || null,
      commandsExecuted: Array.isArray(out?.commandsExecuted) ? out.commandsExecuted : [],
      clientActions: Array.isArray(out?.clientActions) ? out.clientActions : [],
      planner: out?.planner || null,
      terminal: out?.terminal || null,
      riskState: out?.riskState || null,
      marketHealth: out?.marketHealth || null,
      precedenceMode: out?.precedenceMode || null,
      healthStatus: out?.healthStatus || null,
      riskVerdict: out?.riskVerdict || null,
      hasOpenPosition: out?.hasOpenPosition === true,
      voiceSessionModeActive: out?.voiceSessionModeActive === true,
      lastHealthAgeSeconds: Number.isFinite(Number(out?.lastHealthAgeSeconds))
        ? Number(out.lastHealthAgeSeconds)
        : null,
      healthStatusUsed: out?.healthStatusUsed || null,
      timePhase: out?.timePhase || null,
      decisionBlockedBy: out?.decisionBlockedBy || null,
      nowMinutesEt: out?.nowMinutesEt ?? null,
      hasORBComplete: out?.hasORBComplete === true,
      liveBarsAvailable: out?.liveBarsAvailable === true,
      primaryReason: out?.primaryReason || null,
      primaryReasonCode: out?.primaryReasonCode || null,
      cooldownRemainingMinutes: out?.cooldownRemainingMinutes ?? null,
      consentPending: out?.consentPending === true,
      consentKind: out?.consentKind || null,
      consentNeedLocation: out?.consentNeedLocation === true,
      web: out?.web || null,
      toolReceipts: Array.isArray(out?.toolReceipts) ? out.toolReceipts : [],
      pendingActionKind: out?.pendingActionKind || null,
      pendingActionCreatedAt: Number.isFinite(Number(out?.pendingActionCreatedAt))
        ? Number(out.pendingActionCreatedAt)
        : null,
      pendingActionSessionKey: out?.pendingActionSessionKey || null,
      pendingActionClientId: out?.pendingActionClientId || null,
      recoveredFromSessionId: out?.recoveredFromSessionId || null,
      pendingRecoveryUsed: out?.pendingRecoveryUsed === true,
      topicShiftGuardTriggered: out?.topicShiftGuardTriggered === true,
      pendingSelectionMatcher: out?.pendingSelectionMatcher || null,
      skillId: out?.skillId || null,
      skillState: out?.skillState || null,
      executivePlan: out?.executivePlan || base.executivePlan || null,
      raw: out || null,
    };
  }

  async function handlePending(sessionId, message) {
    const item = pendingEngine.getGeneralPending(sessionId);
    if (!item) return null;
    if (isCancelPhrase(message)) {
      pendingEngine.clearGeneralPending(sessionId);
      return {
        reply: 'Canceled. I did not execute that action.',
        toolsUsed: ['Memory'],
        intent: 'general_chat',
        routePath: 'jarvis_orchestrator.pending.cancel',
      };
    }
    if (!isConfirmPhrase(message)) {
      return {
        reply: `Pending action: ${item.summary}. Say "confirm" to proceed or "cancel".`,
        toolsUsed: ['Memory'],
        intent: item.intent || 'general_chat',
        routePath: 'jarvis_orchestrator.pending.await_confirm',
      };
    }

    pendingEngine.clearGeneralPending(sessionId);
    if (item.type === 'memory_update') {
      memory.set(sessionId, item.key, item.value, item.sourceText || '');
      return {
        reply: `Updated. I will use your new preference: ${item.valueLabel}.`,
        toolsUsed: ['Memory'],
        intent: 'general_chat',
        routePath: 'jarvis_orchestrator.pending.memory_update',
      };
    }
    if (item.type === 'trading_execution') {
      const out = deps.executeTradingAction
        ? await deps.executeTradingAction(item.payload || {})
        : { ok: false, stub: true, message: 'Trading execution tool is not enabled yet.' };
      const msg = out?.ok
        ? `Confirmed. Execution action completed: ${out.message || 'trade submitted'}.`
        : `Execution not run: ${out?.message || out?.error || 'tool unavailable'}.`;
      return {
        reply: msg,
        toolsUsed: ['Execution'],
        intent: 'trading_decision',
        routePath: 'jarvis_orchestrator.pending.trading_execution',
      };
    }
    if (item.type === 'os_action') {
      const out = deps.executeOsAction
        ? await deps.executeOsAction(item.payload || {})
        : { ok: false, stub: true, message: 'Local OS agent is not enabled yet.' };
      const msg = out?.ok
        ? `Confirmed. OS action completed: ${out.message || 'done'}.`
        : `OS action not run: ${out?.message || out?.error || 'tool unavailable'}.`;
      return {
        reply: msg,
        toolsUsed: ['OS Agent'],
        intent: 'os_action',
        routePath: 'jarvis_orchestrator.pending.os_action',
      };
    }
    return {
      reply: 'Pending action expired or unsupported. Ask again and I will re-plan it.',
      toolsUsed: ['Memory'],
      intent: 'general_chat',
      routePath: 'jarvis_orchestrator.pending.expired',
    };
  }

  async function handleConsentPending(sessionId, message, request = {}) {
    const pendingInput = pendingEngine.parsePendingInput(message);
    const parsedReply = pendingInput.confirmation;
    const isReplyToken = pendingInput.isConfirm || pendingInput.isCancel;
    const clientId = String(request.clientId || sessionId || '').trim() || sessionId;
    const sessionKey = String(request.sessionKey || `jarvis:${sessionId}`).trim() || `jarvis:${sessionId}`;
    const state = pendingEngine.getConsentPending(sessionId, {
      message,
      clientId,
      sessionKey,
      recoveryWindowMs: PENDING_RECOVERY_WINDOW_MS,
      adopt: true,
    });
    if (state.ambiguousRecovery === true) {
      return {
        reply: 'I found more than one pending action. Say "continue web lookup" or "continue directions", or say "cancel".',
        toolsUsed: ['Jarvis'],
        intent: 'general_chat',
        routePath: 'jarvis_orchestrator.consent.recovery_ambiguous',
        pendingActionKind: null,
        pendingActionCreatedAt: null,
        pendingActionSessionKey: null,
        pendingActionClientId: clientId,
        recoveredFromSessionId: null,
        pendingRecoveryUsed: false,
        topicShiftGuardTriggered: false,
        pendingSelectionMatcher: null,
      };
    }
    if (state.expired) {
      return {
        reply: "No worries - I didn't run it. Ask again when you're ready.",
        toolsUsed: ['Jarvis'],
        intent: 'general_chat',
        routePath: 'jarvis_orchestrator.consent.expired',
        pendingActionKind: null,
        pendingActionCreatedAt: null,
        pendingActionSessionKey: null,
        pendingActionClientId: clientId,
        recoveredFromSessionId: state.recoveredFromSessionId || null,
        pendingRecoveryUsed: !!state.recoveredFromSessionId,
        topicShiftGuardTriggered: false,
        pendingSelectionMatcher: null,
      };
    }
    const item = state.state;
    if (!item) return null;
    const pendingWebIntent = String(item?.payload?.parsedIntent || '').trim()
      || ((item.kind === 'location' || String(item.kind || '').startsWith('web_')) ? 'local_search' : 'web_question');
    const pendingDiagnostics = buildPendingDiagnostics(state, item);
    const withPending = (payload, extras = {}) => ({
      ...payload,
      ...pendingDiagnostics,
      ...extras,
    });
    const setPendingForRequest = (nextPayload, overrideTtlMs = null) => pendingEngine.setConsentPending(
      sessionId,
      nextPayload,
      overrideTtlMs,
      { clientId, sessionKey }
    );

    if (pendingInput.isSwitchTopic) {
      pendingEngine.clearConsentPending(sessionId);
      return withPending({
        reply: 'Switched topics. I cleared the pending action.',
        toolsUsed: ['Jarvis'],
        intent: 'general_chat',
        routePath: 'jarvis_orchestrator.consent.topic_switch_clear',
      }, {
        topicShiftGuardTriggered: true,
      });
    }

    if (pendingInput.isContinuePending) {
      return withPending({
        reply: pendingEngine.buildAwaitReply(item.kind),
        toolsUsed: ['Jarvis'],
        intent: item.kind === 'trade_execution' ? 'trading_decision' : pendingWebIntent,
        consentPending: true,
        consentKind: item.kind,
        routePath: 'jarvis_orchestrator.consent.topic_continue',
      }, {
        topicShiftGuardTriggered: true,
      });
    }

    const locationAction = parseLocationConsentAction(message);
    const locationFromClient = normalizeLocationHint(request.userLocationHint);
    const locationFromSession = deps.getSessionLocation
      ? deps.getSessionLocation({ sessionId, clientId })
      : null;
    const knownRegion = (
      locationFromSession?.region
      || inferRegionFromCityLabel(locationFromSession?.city)
      || locationFromClient?.region
      || inferRegionFromCityLabel(locationFromClient?.city)
      || item?.payload?.locationHint?.region
      || inferRegionFromCityLabel(item?.payload?.locationHint?.city)
      || null
    );
    const normalizedCity = normalizeCityInput(message, { knownRegion });
    const locationFromText = normalizedCity?.locationHint || parseLocationHintFromText(message);
    const mergedLocation = locationFromText || locationFromClient || locationFromSession || item?.payload?.locationHint || null;

    if (parsedReply === 'NO') {
      pendingEngine.clearConsentPending(sessionId);
      if (item.kind === 'web_directions_select' || item.kind === 'web_directions_confirm') {
        return withPending({
          reply: "Okay - no problem. I won't open directions.",
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: item.kind, granted: false },
            parameters: { message: String(message || '') },
            result: { executed: false, reason: 'user_cancelled' },
          })],
          intent: pendingWebIntent,
          routePath: 'jarvis_orchestrator.consent.web_directions.cancel',
        });
      }
      return withPending({
        reply: "Okay - no problem. If you want, tell me the city and I'll look it up.",
        toolsUsed: ['Jarvis'],
        toolReceipts: [buildToolReceipt({
          traceId: request.traceId || null,
          intent: item.kind === 'web_search' ? pendingWebIntent : (item.kind || 'general_chat'),
          tool: 'Consent',
          consent: { kind: item.kind || 'general', granted: false },
          parameters: { message: String(message || '') },
          result: { executed: false, reason: 'user_cancelled' },
        })],
        intent: item.kind === 'web_search' ? pendingWebIntent : (item.kind || 'general_chat'),
        routePath: 'jarvis_orchestrator.consent.cancel',
      });
    }

    if (item.kind === 'location') {
      const locationApplicable = (
        isReplyToken
        || !!locationAction
        || normalizedCity?.needsClarification === true
        || !!locationFromText
      );
      if (!locationApplicable) {
        return withPending({
          reply: `We were in the middle of ${pendingEngine.buildPendingActionLabel(item.kind)}. Continue, or switch topics?`,
          toolsUsed: ['Jarvis'],
          intent: 'general_chat',
          consentPending: true,
          consentKind: item.kind,
          consentNeedLocation: true,
          routePath: 'jarvis_orchestrator.consent.topic_shift_guard',
        }, {
          topicShiftGuardTriggered: true,
        });
      }
      if (normalizedCity?.needsClarification === true) {
        return withPending({
          reply: String(
            normalizedCity.clarificationPrompt
            || 'I need the state for that city before I run the lookup.'
          ),
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: 'location', granted: false },
            parameters: { city: normalizedCity.city || null, options: normalizedCity.options || [] },
            result: { executed: false, reason: 'city_state_clarification_required' },
          })],
          intent: pendingWebIntent,
          consentPending: true,
          consentKind: 'location',
          consentNeedLocation: true,
          routePath: 'jarvis_orchestrator.consent.location.await_state',
        });
      }
      if (locationFromText) {
        setPendingForRequest({
          kind: 'web_search',
          payload: {
            ...item.payload,
            locationHint: locationFromText,
            locationRequired: true,
            needLocation: false,
          },
        });
        const cityLabel = String(locationFromText.city || '').trim() || 'that city';
        return withPending({
          reply: `Got it - ${cityLabel}. I haven't run the search yet. Want me to run it now?`,
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: 'location', granted: true },
            parameters: { city: cityLabel },
            result: { executed: false, reason: 'await_web_confirmation' },
          })],
          intent: pendingWebIntent,
          consentPending: true,
          consentKind: 'web_search',
          consentNeedLocation: false,
          routePath: 'jarvis_orchestrator.consent.location.city_ready',
        });
      }
      if (locationAction === 'USE_CITY') {
        return withPending({
          reply: 'Perfect. Tell me the city now, like "Newark NJ".',
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: 'location', granted: true },
            parameters: { mode: 'city' },
            result: { executed: false, reason: 'await_city' },
          })],
          intent: pendingWebIntent,
          consentPending: true,
          consentKind: 'location',
          consentNeedLocation: true,
          routePath: 'jarvis_orchestrator.consent.location.await_city',
        });
      }
      if (locationAction === 'USE_PHONE' || parsedReply === 'YES') {
        const phoneLocation = locationFromSession || locationFromClient || null;
        if (phoneLocation) {
          setPendingForRequest({
            kind: 'web_search',
            payload: {
              ...item.payload,
              locationHint: phoneLocation,
              locationRequired: true,
              needLocation: false,
            },
          });
          return withPending({
            reply: "Got your phone location. I haven't run the search yet. Want me to run it now?",
            toolsUsed: ['Jarvis'],
            toolReceipts: [buildToolReceipt({
              traceId: request.traceId || null,
              intent: pendingWebIntent,
              tool: 'Consent',
              consent: { kind: 'location', granted: true },
              parameters: { mode: 'phone_location' },
              result: { executed: false, reason: 'await_web_confirmation' },
            })],
            intent: pendingWebIntent,
            consentPending: true,
            consentKind: 'web_search',
            consentNeedLocation: false,
            routePath: 'jarvis_orchestrator.consent.location.phone_ready',
          });
        }
        const shareLink = String(request.phoneLinkUrl || item.payload?.phoneLinkUrl || '').trim();
        const linkLine = shareLink ? ` Open this on your phone: ${shareLink}` : '';
        return withPending({
          reply: `I don't have your phone GPS yet.${linkLine} Tap Share Location, then say "yes".`,
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: 'location', granted: true },
            parameters: { mode: 'phone_location' },
            result: { executed: false, reason: 'await_phone_share' },
          })],
          intent: pendingWebIntent,
          consentPending: true,
          consentKind: 'location',
          consentNeedLocation: true,
          routePath: 'jarvis_orchestrator.consent.location.await_phone_share',
        });
      }
      return withPending({
        reply: 'Say "use my phone location" or tell me a specific city.',
        toolsUsed: ['Jarvis'],
        toolReceipts: [buildToolReceipt({
          traceId: request.traceId || null,
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          tool: 'Consent',
          consent: { kind: 'location', granted: false },
          parameters: { message: String(message || '') },
          result: { executed: false, reason: 'await_location_choice' },
        })],
        intent: String(item?.payload?.parsedIntent || 'web_question'),
        consentPending: true,
        consentKind: 'location',
        consentNeedLocation: true,
        routePath: 'jarvis_orchestrator.consent.location.await_choice',
      });
    }

    if (item.kind === 'web_search') {
      const effectiveIntent = String(item?.payload?.parsedIntent || 'web_question').trim() || 'web_question';
      const webSearchApplicable = (
        isReplyToken
        || !!locationFromText
        || normalizedCity?.needsClarification === true
        || !!locationAction
      );
      if (!webSearchApplicable) {
        return withPending({
          reply: `We were in the middle of ${pendingEngine.buildPendingActionLabel(item.kind)}. Continue, or switch topics?`,
          toolsUsed: ['Jarvis'],
          intent: 'general_chat',
          consentPending: true,
          consentKind: item.kind,
          consentNeedLocation: item.payload?.needLocation === true,
          routePath: 'jarvis_orchestrator.consent.topic_shift_guard',
        }, {
          topicShiftGuardTriggered: true,
        });
      }
      if (item.payload?.needLocation === true) {
        if (normalizedCity?.needsClarification === true) {
          return withPending({
            reply: String(
              normalizedCity.clarificationPrompt
              || 'I need the state for that city before I run the lookup.'
            ),
            toolsUsed: ['Jarvis'],
            toolReceipts: [buildToolReceipt({
              traceId: request.traceId || null,
              intent: effectiveIntent,
              tool: 'Consent',
              consent: { kind: 'web_search', granted: false },
              parameters: { city: normalizedCity.city || null, options: normalizedCity.options || [] },
              result: { executed: false, reason: 'city_state_clarification_required' },
            })],
            intent: effectiveIntent,
            consentPending: true,
            consentKind: 'web_search',
            consentNeedLocation: true,
            routePath: 'jarvis_orchestrator.consent.web.await_state',
          });
        }
        if (mergedLocation) {
          setPendingForRequest({
            kind: 'web_search',
            payload: {
              ...item.payload,
              locationHint: mergedLocation,
              needLocation: false,
            },
          });
          const label = String(mergedLocation?.city || '').trim() || 'that location';
          return withPending({
            reply: `Got it - ${label}. Want me to look that up now?`,
            toolsUsed: ['Jarvis'],
            toolReceipts: [buildToolReceipt({
              traceId: request.traceId || null,
              intent: effectiveIntent,
              tool: 'Consent',
              consent: { kind: 'web_search', granted: true },
              parameters: { location: mergedLocation },
              result: { executed: false, reason: 'await_web_confirmation' },
            })],
            intent: effectiveIntent,
            consentPending: true,
            consentKind: 'web_search',
            consentNeedLocation: false,
            routePath: 'jarvis_orchestrator.consent.web.await_yes',
          });
        }
        return withPending({
          reply: 'I still need a location for that. Say a city like "Newark NJ" or turn on location sharing, then say yes.',
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: 'web_search', granted: false },
            parameters: { locationRequired: true },
            result: { executed: false, reason: 'location_required' },
          })],
          intent: effectiveIntent,
          consentPending: true,
          consentKind: 'web_search',
          consentNeedLocation: true,
          routePath: 'jarvis_orchestrator.consent.web.await_location',
        });
      }

      if (parsedReply !== 'YES') {
        return withPending({
          reply: "Jarvis is waiting for your OK to search the web. I haven't run it yet. Say yes or no.",
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: effectiveIntent,
            tool: 'Consent',
            consent: { kind: 'web_search', granted: false },
            parameters: { message: String(message || '') },
            result: { executed: false, reason: 'await_yes_no' },
          })],
          intent: effectiveIntent,
          consentPending: true,
          consentKind: 'web_search',
          consentNeedLocation: false,
          routePath: 'jarvis_orchestrator.consent.web.await_yes',
        });
      }

      pendingEngine.clearConsentPending(sessionId);
      const out = deps.runWebQuestion
        ? await deps.runWebQuestion({
          message: item.payload?.originalMessage || item.payload?.queryUsed || message,
          queryUsed: item.payload?.queryUsed || item.payload?.originalMessage || message,
          originalQuery: item.payload?.originalQuery || item.payload?.originalMessage || message,
          normalizedQuery: item.payload?.normalizedQuery || item.payload?.queryUsed || item.payload?.originalMessage || message,
          categoryHint: item.payload?.categoryHint || null,
          intent: effectiveIntent,
          strategy: String(request.strategy || 'original') === 'alt' ? 'alt' : 'original',
          traceId: request.traceId || null,
          contextHint: request.contextHint || request.activeModule || 'bridge',
          activeModule: request.activeModule || 'bridge',
          sessionId: request.sessionId || sessionId,
          clientId,
          userLocationHint: mergedLocation || item.payload?.locationHint || null,
          locationRequired: item.payload?.locationRequired === true,
          authorizedWeb: true,
          trace: request.trace,
        })
        : { reply: 'Web tool is unavailable right now.', toolsUsed: ['WebTool'], routePath: 'jarvis_orchestrator.consent.web.missing_tool' };
      const resultSources = Array.isArray(out?.web?.sources)
        ? out.web.sources
        : [];
      const webMode = String(out?.toolReceipts?.[0]?.parameters?.mode || '').trim().toLowerCase();
      const canOfferDirections = resultSources.length > 0 && webMode !== 'stub';
      if (canOfferDirections) {
        setPendingForRequest({
          kind: 'web_directions_select',
          payload: {
            parsedIntent: effectiveIntent,
            queryUsed: item.payload?.queryUsed || item.payload?.originalMessage || message,
            locationHint: mergedLocation || item.payload?.locationHint || null,
            sources: resultSources.slice(0, 5).map((s) => ({
              title: String(s?.title || '').trim() || 'Place',
              address: String(s?.address || s?.snippet || '').trim(),
              url: String(s?.url || '').trim(),
              distanceKm: Number.isFinite(Number(s?.distanceKm)) ? Number(s.distanceKm) : null,
            })),
          },
        });
      }
      let replyText = String(out?.reply || '').trim() || 'I could not complete that web lookup.';
      if (canOfferDirections && !/want directions to one of these/i.test(replyText)) {
        replyText = `${replyText} Want directions to one of these?`;
      }
      return withToolPayload({
        reply: replyText,
        intent: effectiveIntent,
        toolsUsed: out?.toolsUsed || ['WebTool'],
        toolReceipts: Array.isArray(out?.toolReceipts) && out.toolReceipts.length > 0
          ? out.toolReceipts
          : [buildToolReceipt({
            traceId: request.traceId || null,
            intent: effectiveIntent,
            tool: 'WebTool',
            consent: { kind: 'web_search', granted: true },
            parameters: { query: item.payload?.queryUsed || item.payload?.originalMessage || message },
            result: { executed: false, reason: 'web_tool_unavailable' },
          })],
        routePath: out?.routePath || 'jarvis_orchestrator.consent.web.execute',
      }, {
        ...(out || {}),
        consentPending: canOfferDirections,
        consentKind: canOfferDirections ? 'web_directions_select' : null,
        consentNeedLocation: false,
        skillId: 'LocalSearch',
        skillState: canOfferDirections ? 'results_presented' : 'confirm_search',
        ...pendingDiagnostics,
      });
    }

    if (item.kind === 'web_directions_select') {
      const sources = Array.isArray(item.payload?.sources) ? item.payload.sources : [];
      if (!sources.length) {
        pendingEngine.clearConsentPending(sessionId);
        return withPending({
          reply: "I don't have the result list anymore. Ask again and I'll run a fresh search.",
          toolsUsed: ['Jarvis'],
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          routePath: 'jarvis_orchestrator.consent.web_directions.missing_sources',
        });
      }
      if (parsedReply === 'YES') {
        return withPending({
          reply: 'Tell me which one, like "the first one" or the place name.',
          toolsUsed: ['Jarvis'],
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          consentPending: true,
          consentKind: 'web_directions_select',
          routePath: 'jarvis_orchestrator.consent.web_directions.await_selection',
        });
      }
      const picked = pendingEngine.pickSelection(message, sources);
      if (!picked?.selected) {
        if (!picked?.attemptedSelection) {
          return withPending({
            reply: `We were in the middle of ${pendingEngine.buildPendingActionLabel(item.kind)}. Continue, or switch topics?`,
            toolsUsed: ['Jarvis'],
            intent: 'general_chat',
            consentPending: true,
            consentKind: item.kind,
            routePath: 'jarvis_orchestrator.consent.topic_shift_guard',
          }, {
            topicShiftGuardTriggered: true,
          });
        }
        const labels = sources.slice(0, 5).map((s, i) => `${i + 1}) ${String(s?.title || 'Place').trim()}`).join('; ');
        return withPending({
          reply: `I can route directions once you pick one: ${labels}.`,
          toolsUsed: ['Jarvis'],
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          consentPending: true,
          consentKind: 'web_directions_select',
          toolReceipts: [buildToolReceipt({
            traceId: request.traceId || null,
            intent: pendingWebIntent,
            tool: 'Consent',
            consent: { kind: 'web_directions_select', granted: false },
            parameters: { message: String(message || '') },
            result: { executed: false, reason: 'await_result_selection' },
          })],
          routePath: 'jarvis_orchestrator.consent.web_directions.await_selection',
        }, {
          pendingSelectionMatcher: picked?.matcher || null,
        });
      }
      setPendingForRequest({
        kind: 'web_directions_confirm',
        payload: {
          ...item.payload,
          selected: picked.selected,
          selectedIndex: picked.index,
        },
      });
      return withPending({
        reply: `Got it - ${String(picked.selected?.title || 'that option').trim()}. Want me to open directions now?`,
        toolsUsed: ['Jarvis'],
        intent: pendingWebIntent,
        consentPending: true,
        consentKind: 'web_directions_confirm',
        toolReceipts: [buildToolReceipt({
          traceId: request.traceId || null,
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          tool: 'Consent',
          consent: { kind: 'web_directions_select', granted: true },
          parameters: { selectedIndex: picked.index, selectedTitle: String(picked.selected?.title || '').trim() },
          result: { executed: false, reason: 'await_directions_confirmation' },
        })],
        routePath: 'jarvis_orchestrator.consent.web_directions.await_confirm',
      }, {
        pendingSelectionMatcher: picked?.matcher || null,
      });
    }

    if (item.kind === 'web_directions_confirm') {
      if (parsedReply !== 'YES') {
        if (!isReplyToken) {
          return withPending({
            reply: `We were in the middle of ${pendingEngine.buildPendingActionLabel(item.kind)}. Continue, or switch topics?`,
            toolsUsed: ['Jarvis'],
            intent: 'general_chat',
            consentPending: true,
            consentKind: item.kind,
            routePath: 'jarvis_orchestrator.consent.topic_shift_guard',
          }, {
            topicShiftGuardTriggered: true,
          });
        }
        return withPending({
          reply: 'Say yes to open directions, or no to skip.',
          toolsUsed: ['Jarvis'],
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          consentPending: true,
          consentKind: 'web_directions_confirm',
          routePath: 'jarvis_orchestrator.consent.web_directions.await_confirm',
        });
      }
      pendingEngine.clearConsentPending(sessionId);
      const selected = item.payload?.selected || {};
      const destinationLabel = String(selected.address || selected.title || '').trim();
      const mapsQuery = destinationLabel || String(selected.title || 'destination').trim();
      const directionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;
      return withPending({
        reply: `I prepared directions to ${String(selected.title || 'that place').trim()}: ${directionsUrl}`,
        toolsUsed: ['WebTool'],
        intent: String(item?.payload?.parsedIntent || 'web_question'),
        toolReceipts: [buildToolReceipt({
          traceId: request.traceId || null,
          intent: String(item?.payload?.parsedIntent || 'web_question'),
          tool: 'WebTool',
          consent: { kind: 'web_directions_confirm', granted: true },
          parameters: { selectedTitle: String(selected.title || '').trim(), selectedAddress: String(selected.address || '').trim() },
          result: { executed: false, reason: 'directions_link_prepared' },
        })],
        routePath: 'jarvis_orchestrator.consent.web_directions.confirmed',
      });
    }

    if (parsedReply !== 'YES') {
      if (!isReplyToken) {
        return withPending({
          reply: `We were in the middle of ${pendingEngine.buildPendingActionLabel(item.kind)}. Continue, or switch topics?`,
          toolsUsed: ['Jarvis'],
          intent: 'general_chat',
          consentPending: true,
          consentKind: item.kind,
          routePath: 'jarvis_orchestrator.consent.topic_shift_guard',
        }, {
          topicShiftGuardTriggered: true,
        });
      }
      return withPending({
        reply: 'Jarvis is waiting for your OK. Say yes to continue or no to cancel.',
        toolsUsed: ['Jarvis'],
        intent: item.kind === 'trade_execution' ? 'trading_decision' : 'os_action',
        consentPending: true,
        consentKind: item.kind,
        routePath: 'jarvis_orchestrator.consent.await_yes',
      });
    }

    pendingEngine.clearConsentPending(sessionId);
    if (item.kind === 'trade_execution') {
      const out = deps.executeTradingAction
        ? await deps.executeTradingAction(item.payload || {})
        : { ok: false, stub: true, message: 'Trading execution tool is not enabled yet.' };
      return withPending({
        reply: out?.ok
          ? `Confirmed. Execution action completed: ${out.message || 'trade submitted'}.`
          : `Execution not run: ${out?.message || out?.error || 'tool unavailable'}.`,
        toolsUsed: ['Execution'],
        intent: 'trading_decision',
        routePath: 'jarvis_orchestrator.consent.trade_execution',
      });
    }
    if (item.kind === 'os_action') {
      const out = deps.executeOsAction
        ? await deps.executeOsAction(item.payload || {})
        : { ok: false, stub: true, message: 'Local OS agent is not enabled yet.' };
      return withPending({
        reply: out?.ok
          ? `Confirmed. OS action completed: ${out.message || 'done'}.`
          : `OS action not run: ${out?.message || out?.error || 'tool unavailable'}.`,
        toolsUsed: ['OS Agent'],
        intent: 'os_action',
        routePath: 'jarvis_orchestrator.consent.os_action',
      });
    }
    return null;
  }

  async function run(request = {}) {
    const trace = typeof request.trace === 'function' ? request.trace : () => {};
    const traceId = String(request.traceId || '').trim() || null;
    const message = String(request.message || '').trim();
    const sessionId = String(request.sessionId || request.clientId || 'jarvis_default');
    const clientId = String(request.clientId || sessionId || '').trim() || sessionId;
    const sessionKey = String(request.sessionKey || `jarvis:${sessionId}`).trim() || `jarvis:${sessionId}`;
    const strategy = String(request.strategy || 'original') === 'alt' ? 'alt' : 'original';
    const voiceBriefMode = String(request.voiceBriefMode || 'earbud').trim().toLowerCase();
    const contextHint = String(request.contextHint || request.activeModule || '').trim() || 'bridge';
    const setConsentPendingForRun = (payload, overrideTtlMs = null) => pendingEngine.setConsentPending(
      sessionId,
      payload,
      overrideTtlMs,
      { clientId, sessionKey }
    );

    const pendingPreviewForPlan = pendingEngine.getConsentPending(sessionId, {
      message,
      clientId,
      sessionKey,
      adopt: false,
      consume: false,
    });
    const generalPendingPreviewForPlan = pendingEngine.getGeneralPending(sessionId);
    const executivePlan = executive.plan({
      message,
      strategy,
      activeModule: request.activeModule,
      contextHint,
      voiceMode: request.voiceMode === true,
      voiceBriefMode,
      sessionId,
      clientId,
      userLocationHint: request.userLocationHint || null,
      pendingAction: pendingPreviewForPlan?.state || generalPendingPreviewForPlan || null,
    });
    const finish = (payload, extras = {}) => applyExecutiveMeta(payload, executivePlan, extras);

    if (!message) {
      return finish({
        reply: 'I am online. Ask anything and I will route it through the right tool.',
        intent: 'general_chat',
        toolsUsed: ['Jarvis'],
      }, {
        decisionMode: 'answer_now',
      });
    }

    const consentOut = await handleConsentPending(sessionId, message, {
      ...request,
      clientId,
      sessionKey,
    });
    if (consentOut) return finish(consentOut, {
      decisionMode: 'resolve_pending',
    });

    const intakePending = pendingEngine.getGeneralPending(sessionId);
    if (intakePending && (intakePending.type === 'shopping_intake' || intakePending.type === 'project_intake')) {
      const pendingInput = pendingEngine.parsePendingInput(message);
      if (pendingInput.isCancel || pendingInput.isSwitchTopic) {
        pendingEngine.clearGeneralPending(sessionId);
        return finish({
          reply: 'Canceled. I cleared that planning flow.',
          intent: 'general_chat',
          toolsUsed: ['Jarvis'],
          routePath: 'jarvis_orchestrator.intake.cancel',
          topicShiftGuardTriggered: pendingInput.isSwitchTopic,
        }, {
          selectedSkill: 'GeneralConversation',
          decisionMode: 'resolve_pending',
        });
      }
      if (pendingInput.isContinuePending) {
        return finish({
          reply: String(intakePending?.summary || 'Continue with the last answer and I will finish the plan.'),
          intent: intakePending.type === 'shopping_intake' ? 'shopping_advisor' : 'project_planner',
          toolsUsed: ['AdvisorPlanner'],
          routePath: 'jarvis_orchestrator.intake.continue',
        }, {
          selectedSkill: intakePending.type === 'shopping_intake' ? 'ShoppingAdvisor' : 'ProjectPlanner',
          decisionMode: 'resolve_pending',
        });
      }
      const existingProfile = intakePending && typeof intakePending.profile === 'object'
        ? intakePending.profile
        : {};
      const flow = intakePending.type === 'shopping_intake'
        ? startShoppingFlow(message, existingProfile)
        : startProjectFlow(message, existingProfile);
      const changed = JSON.stringify(flow.profile || {}) !== JSON.stringify(existingProfile || {});
      if (!changed && !flow.complete) {
        return finish({
          reply: `We were in the middle of ${intakePending.type === 'shopping_intake' ? 'a shopping plan' : 'a project plan'}. Continue, or switch topics?`,
          intent: 'general_chat',
          toolsUsed: ['Jarvis'],
          routePath: 'jarvis_orchestrator.intake.topic_shift_guard',
          topicShiftGuardTriggered: true,
        }, {
          selectedSkill: 'GeneralConversation',
          decisionMode: 'pending_topic_shift_guard',
        });
      }
      if (!flow.complete) {
        pendingEngine.setGeneralPending(sessionId, {
          type: intakePending.type,
          intent: intakePending.type === 'shopping_intake' ? 'shopping_advisor' : 'project_planner',
          profile: flow.profile || existingProfile,
          summary: flow.reply,
          clientId,
          sessionKey,
        }, 20 * 60 * 1000);
        return finish({
          reply: flow.reply,
          intent: intakePending.type === 'shopping_intake' ? 'shopping_advisor' : 'project_planner',
          toolsUsed: ['AdvisorPlanner'],
          routePath: 'jarvis_orchestrator.intake.await_more',
        }, {
          selectedSkill: intakePending.type === 'shopping_intake' ? 'ShoppingAdvisor' : 'ProjectPlanner',
          decisionMode: 'resolve_pending',
        });
      }
      pendingEngine.clearGeneralPending(sessionId);
      if (intakePending.type === 'shopping_intake' && deps.runShoppingAdvisor) {
        const out = await deps.runShoppingAdvisor({
          message,
          profile: flow.profile || {},
          recommendation: flow.result || null,
          traceId,
          sessionId,
          clientId,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || flow.reply || '').trim(),
          intent: 'shopping_advisor',
          toolsUsed: out?.toolsUsed || ['AdvisorPlanner'],
          routePath: out?.routePath || 'jarvis_orchestrator.intake.completed',
          traceId,
        }, out), {
          selectedSkill: 'ShoppingAdvisor',
          decisionMode: 'invoke_tools',
        });
      }
      if (intakePending.type === 'project_intake' && deps.runProjectPlanner) {
        const out = await deps.runProjectPlanner({
          message,
          profile: flow.profile || {},
          plan: flow.result || null,
          traceId,
          sessionId,
          clientId,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || flow.reply || '').trim(),
          intent: 'project_planner',
          toolsUsed: out?.toolsUsed || ['AdvisorPlanner'],
          routePath: out?.routePath || 'jarvis_orchestrator.intake.completed',
          traceId,
        }, out), {
          selectedSkill: 'ProjectPlanner',
          decisionMode: 'invoke_tools',
        });
      }
      return finish({
        reply: flow.reply,
        intent: intakePending.type === 'shopping_intake' ? 'shopping_advisor' : 'project_planner',
        toolsUsed: ['AdvisorPlanner'],
        routePath: 'jarvis_orchestrator.intake.completed',
        planner: {
          profile: flow.profile || {},
          result: flow.result || null,
        },
      }, {
        selectedSkill: intakePending.type === 'shopping_intake' ? 'ShoppingAdvisor' : 'ProjectPlanner',
        decisionMode: 'invoke_tools',
      });
    }

    const pendingOut = await handlePending(sessionId, message);
    if (pendingOut) return finish(pendingOut, {
      decisionMode: 'resolve_pending',
    });

    const pref = parsePreferenceStatement(message);
    if (pref) {
      const prev = memory.get(sessionId, pref.key);
      if (prev && String(prev.value) !== String(pref.value)) {
        pendingEngine.setGeneralPending(sessionId, {
          type: 'memory_update',
          intent: 'general_chat',
          key: pref.key,
          value: pref.value,
          valueLabel: pref.humanValue,
          sourceText: message,
          summary: `update preference from "${prev.value}" to "${pref.value}"`,
        });
        return finish({
          reply: `Last time you said "${prev.value}", now you said "${pref.value}"—should I update that? Say "confirm" to update or "cancel".`,
          intent: 'general_chat',
          toolsUsed: ['Memory'],
          memory: { contradiction: true, key: pref.key, previous: prev.value, next: pref.value },
          routePath: 'jarvis_orchestrator.memory.contradiction',
        }, {
          selectedSkill: 'MemoryPreference',
          decisionMode: 'wait_for_confirmation',
        });
      }
      memory.set(sessionId, pref.key, pref.value, message);
      return finish({
        reply: `Understood. I saved that preference: ${pref.humanValue}.`,
        intent: 'general_chat',
        toolsUsed: ['Memory'],
        routePath: 'jarvis_orchestrator.memory.saved',
      }, {
        selectedSkill: 'MemoryPreference',
        decisionMode: 'invoke_tools',
      });
    }

    const intentDetails = executivePlan.intentDetails && typeof executivePlan.intentDetails === 'object'
      ? executivePlan.intentDetails
      : classifyJarvisIntentDetailed(message, { allowClarify: true });
    const classifiedIntent = String(executivePlan.intent || intentDetails?.intent || 'general_chat').trim().toLowerCase() || 'general_chat';
    let intent = classifiedIntent;
    const directTradingResultReview = (
      classifiedIntent !== 'trading_review'
      && (
        isDirectTradingResultQuery(message)
        || isTradingPostmortemReviewQuery(message)
      )
    );
    if (directTradingResultReview) {
      intent = 'trading_review';
      trace('jarvis_intent_override', {
        routePath: 'jarvis_orchestrator.classify.override',
        source: 'jarvis_orchestrator',
        fromIntent: classifiedIntent,
        intent,
        reason: isDirectTradingResultQuery(message)
          ? 'direct_trading_result_phrase'
          : 'trading_postmortem_phrase',
      });
    }
    trace('jarvis_intent_classified', {
      routePath: 'jarvis_orchestrator.classify',
      source: 'jarvis_orchestrator',
      intent: classifiedIntent,
      resolvedIntent: intent,
      intentLayer: intentDetails?.layer || null,
      intentConfidence: Number.isFinite(Number(intentDetails?.confidence))
        ? Number(intentDetails.confidence)
        : null,
      routeGroup: intentDetails?.routeGroup || null,
      contextHint,
      executiveSkillId: executivePlan.skillId || null,
      executiveResponseMode: executivePlan.responseMode || null,
      executivePlannedTools: Array.isArray(executivePlan.plannedTools) ? executivePlan.plannedTools : [],
      executiveMissingInputs: Array.isArray(executivePlan.requiredInputsMissing) ? executivePlan.requiredInputsMissing : [],
    });

    if (intent === 'unclear') {
      return finish({
        reply: String(intentDetails?.clarifyPrompt || CLARIFY_PROMPT),
        intent: 'general_chat',
        toolsUsed: ['Jarvis'],
        routePath: 'jarvis_orchestrator.intent_clarify',
      }, {
        selectedSkill: 'GeneralConversation',
        decisionMode: 'ask_clarify',
      });
    }

    if (intent === 'consent_reply') {
      return finish({
        reply: 'No action is pending right now. Ask me for trading help, a web lookup, or a desktop task.',
        intent: 'general_chat',
        toolsUsed: ['Jarvis'],
        routePath: 'jarvis_orchestrator.consent_reply_without_pending',
      }, {
        selectedSkill: 'GeneralConversation',
        decisionMode: 'answer_now',
      });
    }

    if (intent === 'system_diag') {
      if (deps.runSystemDiag) {
        trace('jarvis_tool_call_start', {
          routePath: 'jarvis_orchestrator.system_diag',
          source: 'jarvis_orchestrator',
          tool: 'DiagTool',
        });
        const startedAt = Date.now();
        const out = await deps.runSystemDiag({
          message,
          traceId,
          contextHint,
          sessionId,
          clientId: request.clientId,
          req: request.req || null,
        });
        trace('jarvis_tool_call_end', {
          routePath: 'jarvis_orchestrator.system_diag',
          source: out?.source || 'jarvis_orchestrator',
          tool: 'DiagTool',
          durationMs: Date.now() - startedAt,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'Voice requests are using /api/jarvis/query.',
          intent: 'system_diag',
          toolsUsed: out?.toolsUsed || ['DiagTool'],
          routePath: 'jarvis_orchestrator.system_diag',
          traceId,
        }, {
          ...(out || {}),
          routePath: 'jarvis_orchestrator.system_diag',
        }), {
          selectedSkill: 'SystemDiagnostic',
          decisionMode: 'invoke_tools',
        });
      }
      return finish({
        reply: 'Voice requests are using /api/jarvis/query. Legacy fallback is OFF on this server.',
        intent: 'system_diag',
        toolsUsed: ['DiagTool'],
        routePath: 'jarvis_orchestrator.system_diag',
      }, {
        selectedSkill: 'SystemDiagnostic',
        decisionMode: 'answer_now',
      });
    }

    if (intent === 'shopping_advisor') {
      const flow = startShoppingFlow(message, {});
      if (!flow.complete) {
        pendingEngine.setGeneralPending(sessionId, {
          type: 'shopping_intake',
          intent: 'shopping_advisor',
          profile: flow.profile || {},
          summary: flow.reply,
          clientId,
          sessionKey,
        }, 20 * 60 * 1000);
        return finish({
          reply: flow.reply,
          intent,
          toolsUsed: ['AdvisorPlanner'],
          routePath: 'jarvis_orchestrator.shopping.await_more',
        }, {
          selectedSkill: 'ShoppingAdvisor',
          decisionMode: 'ask_missing_input',
        });
      }
      if (deps.runShoppingAdvisor) {
        const out = await deps.runShoppingAdvisor({
          message,
          profile: flow.profile || {},
          recommendation: flow.result || null,
          traceId,
          sessionId,
          clientId,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || flow.reply || '').trim(),
          intent,
          toolsUsed: out?.toolsUsed || ['AdvisorPlanner'],
          routePath: out?.routePath || 'jarvis_orchestrator.shopping.completed',
          traceId,
        }, out), {
          selectedSkill: 'ShoppingAdvisor',
          decisionMode: 'invoke_tools',
        });
      }
      return finish({
        reply: flow.reply,
        intent,
        toolsUsed: ['AdvisorPlanner'],
        planner: {
          profile: flow.profile || {},
          result: flow.result || null,
        },
        routePath: 'jarvis_orchestrator.shopping.completed',
      }, {
        selectedSkill: 'ShoppingAdvisor',
        decisionMode: 'invoke_tools',
      });
    }

    if (intent === 'project_planner') {
      const flow = startProjectFlow(message, {});
      if (!flow.complete) {
        pendingEngine.setGeneralPending(sessionId, {
          type: 'project_intake',
          intent: 'project_planner',
          profile: flow.profile || {},
          summary: flow.reply,
          clientId,
          sessionKey,
        }, 20 * 60 * 1000);
        return finish({
          reply: flow.reply,
          intent,
          toolsUsed: ['AdvisorPlanner'],
          routePath: 'jarvis_orchestrator.project.await_more',
        }, {
          selectedSkill: 'ProjectPlanner',
          decisionMode: 'ask_missing_input',
        });
      }
      if (deps.runProjectPlanner) {
        const out = await deps.runProjectPlanner({
          message,
          profile: flow.profile || {},
          plan: flow.result || null,
          traceId,
          sessionId,
          clientId,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || flow.reply || '').trim(),
          intent,
          toolsUsed: out?.toolsUsed || ['AdvisorPlanner'],
          routePath: out?.routePath || 'jarvis_orchestrator.project.completed',
          traceId,
        }, out), {
          selectedSkill: 'ProjectPlanner',
          decisionMode: 'invoke_tools',
        });
      }
      return finish({
        reply: flow.reply,
        intent,
        toolsUsed: ['AdvisorPlanner'],
        planner: {
          profile: flow.profile || {},
          result: flow.result || null,
        },
        routePath: 'jarvis_orchestrator.project.completed',
      }, {
        selectedSkill: 'ProjectPlanner',
        decisionMode: 'invoke_tools',
      });
    }

    if (intent === 'complaint_log') {
      if (deps.runComplaintLog) {
        const out = await deps.runComplaintLog({
          message,
          traceId,
          sessionId,
          clientId,
          routePathTag: request.routePathTag || null,
          toolsUsed: request.toolsUsed || [],
          req: request.req || null,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'Complaint logged.',
          intent,
          toolsUsed: out?.toolsUsed || ['ComplaintStore'],
          routePath: out?.routePath || 'jarvis_orchestrator.complaint.saved',
          traceId,
        }, out), {
          selectedSkill: 'ComplaintLogging',
          decisionMode: 'invoke_tools',
        });
      }
      return finish({
        reply: 'I logged that complaint. If you want, I can also suggest system improvements based on recent patterns.',
        intent,
        toolsUsed: ['ComplaintStore'],
        routePath: 'jarvis_orchestrator.complaint.saved',
      }, {
        selectedSkill: 'ComplaintLogging',
        decisionMode: 'invoke_tools',
      });
    }

    if (intent === 'improvement_review') {
      if (deps.runImprovementReview) {
        const out = await deps.runImprovementReview({
          message,
          traceId,
          sessionId,
          clientId,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'I generated improvement suggestions from recent failures.',
          intent,
          toolsUsed: out?.toolsUsed || ['ImprovementEngine'],
          routePath: out?.routePath || 'jarvis_orchestrator.improvement.review',
          traceId,
        }, out), {
          selectedSkill: 'ImprovementReview',
          decisionMode: 'invoke_tools',
        });
      }
      return finish({
        reply: 'I can review recent complaints and trace failures, then propose improvements before we apply anything.',
        intent,
        toolsUsed: ['ImprovementEngine'],
        routePath: 'jarvis_orchestrator.improvement.review',
      }, {
        selectedSkill: 'ImprovementReview',
        decisionMode: 'invoke_tools',
      });
    }

    if (
      intent === 'trading_execution_request'
      || (intent === 'trading_decision' && detectRiskyTradingExecution(message))
    ) {
      setConsentPendingForRun({
        kind: 'trade_execution',
        payload: {
          tool: 'Execution',
          originalMessage: message,
          parsedIntent: intent,
          message,
          strategy,
          contextHint,
        },
      });
      return finish({
        reply: "I can do that, but it's a high-risk action. Want me to execute it now?",
        intent,
        toolsUsed: ['Execution', 'Health', 'Analyst'],
        confirmRequired: true,
        consentPending: true,
        consentKind: 'trade_execution',
        routePath: 'jarvis_orchestrator.trading_decision.confirm_gate',
      }, {
        decisionMode: 'wait_for_confirmation',
      });
    }

    if (intent === 'os_action' || intent === 'device_action') {
      const osAction = parseOsActionRequest(message);
      const actionAllowed = osAllowList.has(String(osAction.actionType || '').toLowerCase());
      const actionLabel = `${osAction.actionType}${osAction.target ? ` (${osAction.target})` : ''}`;
      if (!actionAllowed) {
        return finish({
          reply: `I blocked that OS action because "${osAction.actionType}" is not in the allow-list yet. I can only run allow-listed actions for safety.`,
          intent,
          toolsUsed: ['OS Agent'],
          routePath: 'jarvis_orchestrator.os_action.allowlist_block',
        }, {
          decisionMode: 'answer_now',
        });
      }
      if (osAction.risky) {
        setConsentPendingForRun({
          kind: 'os_action',
          payload: {
            tool: 'OS Agent',
            parsedIntent: intent,
            summary: actionLabel,
            ...osAction,
            contextHint,
          },
        });
        return finish({
          reply: `I can do that OS action: ${actionLabel}. Want me to run it now?`,
          intent,
          toolsUsed: ['OS Agent'],
          confirmRequired: true,
          consentPending: true,
          consentKind: 'os_action',
          routePath: 'jarvis_orchestrator.os_action.confirm_gate',
        }, {
          decisionMode: 'wait_for_confirmation',
        });
      }
      trace('jarvis_tool_call_start', {
        routePath: 'jarvis_orchestrator.os_action.execute',
        source: 'jarvis_orchestrator',
        tool: 'OS Agent',
      });
      const startedAt = Date.now();
      const osOut = deps.executeOsAction
        ? await deps.executeOsAction({ ...osAction, contextHint })
        : { ok: false, stub: true, message: 'Local OS agent is not enabled yet.' };
      trace('jarvis_tool_call_end', {
        routePath: 'jarvis_orchestrator.os_action.execute',
        source: 'jarvis_orchestrator',
        tool: 'OS Agent',
        ok: osOut?.ok === true,
        durationMs: Date.now() - startedAt,
      });
      return finish({
        reply: osOut?.ok
          ? `Done. ${osOut.message || `Executed ${actionLabel}.`}`
          : `OS action not run: ${osOut?.message || osOut?.error || 'local agent unavailable'}.`,
        intent,
        toolsUsed: ['OS Agent'],
        routePath: 'jarvis_orchestrator.os_action.execute',
      }, {
        decisionMode: 'invoke_tools',
      });
    }

    if (
      intent === 'trading_hypothetical'
      || intent === 'trading_replay'
      || intent === 'trading_review'
    ) {
      if (deps.runTradingReplay) {
        trace('jarvis_tool_call_start', {
          routePath: 'jarvis_orchestrator.trading_replay',
          source: 'jarvis_orchestrator',
          tool: 'ReplayTool',
        });
        const startedAt = Date.now();
        const out = await deps.runTradingReplay({
          message,
          strategy,
          traceId,
          intent,
          intentLayer: intentDetails?.layer || null,
          intentConfidence: Number.isFinite(Number(intentDetails?.confidence))
            ? Number(intentDetails.confidence)
            : null,
          voiceMode: request.voiceMode === true,
          voiceBriefMode,
          contextHint,
          sessionId,
          clientId: request.clientId,
          voiceSessionState: request.voiceSessionState || null,
          ensureVoiceSessionHealth: request.ensureVoiceSessionHealth,
          getVoiceSessionState: request.getVoiceSessionState,
          auditMock: request.auditMock || null,
          trace,
        });
        trace('jarvis_tool_call_end', {
          routePath: out?.routePath || 'jarvis_orchestrator.trading_replay',
          source: out?.source || 'jarvis_orchestrator',
          tool: 'ReplayTool',
          durationMs: Date.now() - startedAt,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'I could not produce a replay result right now.',
          intent,
          toolsUsed: out?.toolsUsed || ['ReplayTool'],
          routePath: out?.routePath || 'jarvis_orchestrator.trading_replay',
          traceId,
        }, out), {
          selectedSkill: 'TradingReplay',
          decisionMode: 'invoke_tools',
        });
      }
    }

    if (
      intent === 'trading_decision'
      || intent === 'trading_plan'
      || intent === 'trading_execution_request'
    ) {
      if (deps.runTradingDecision) {
        trace('jarvis_tool_call_start', {
          routePath: 'jarvis_orchestrator.trading_decision',
          source: 'jarvis_orchestrator',
          tool: 'Analyst',
        });
        const startedAt = Date.now();
        const out = await deps.runTradingDecision({
          message,
          strategy,
          traceId,
          intent,
          intentLayer: intentDetails?.layer || null,
          intentConfidence: Number.isFinite(Number(intentDetails?.confidence))
            ? Number(intentDetails.confidence)
            : null,
          voiceMode: request.voiceMode === true,
          voiceBriefMode,
          contextHint,
          sessionId,
          clientId: request.clientId,
          voiceSessionState: request.voiceSessionState || null,
          ensureVoiceSessionHealth: request.ensureVoiceSessionHealth,
          getVoiceSessionState: request.getVoiceSessionState,
          auditMock: request.auditMock || null,
          trace,
        });
        trace('jarvis_tool_call_end', {
          routePath: out?.routePath || 'jarvis_orchestrator.trading_decision',
          source: out?.source || 'jarvis_orchestrator',
          tool: 'Analyst',
          durationMs: Date.now() - startedAt,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'I could not produce a trading decision right now.',
          intent,
          toolsUsed: out?.toolsUsed || ['Analyst'],
          routePath: out?.routePath || 'jarvis_orchestrator.trading_decision',
          traceId,
        }, out), {
          decisionMode: 'invoke_tools',
        });
      }
    }

    if (intent === 'trading_status') {
      if (deps.runTradingStatus) {
        trace('jarvis_tool_call_start', {
          routePath: 'jarvis_orchestrator.trading_status',
          source: 'jarvis_orchestrator',
          tool: 'Bridge',
        });
        const startedAt = Date.now();
        const out = await deps.runTradingStatus({
          message,
          strategy,
          traceId,
          voiceMode: request.voiceMode === true,
          contextHint,
          sessionId,
          clientId: request.clientId,
          voiceSessionState: request.voiceSessionState || null,
          ensureVoiceSessionHealth: request.ensureVoiceSessionHealth,
          getVoiceSessionState: request.getVoiceSessionState,
          auditMock: request.auditMock || null,
          trace,
          voiceBriefMode,
          preferCachedLive: request.preferCachedLive === true,
        });
        trace('jarvis_tool_call_end', {
          routePath: out?.routePath || 'jarvis_orchestrator.trading_status',
          source: out?.source || 'jarvis_orchestrator',
          tool: 'Bridge',
          durationMs: Date.now() - startedAt,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'I could not load your trading status right now.',
          intent,
          toolsUsed: out?.toolsUsed || ['Bridge', 'Analyst'],
          routePath: out?.routePath || 'jarvis_orchestrator.trading_status',
          traceId,
        }, out), {
          decisionMode: 'invoke_tools',
        });
      }
    }

  if (intent === 'code_change') {
      if (deps.runCodeChange) {
        trace('jarvis_tool_call_start', {
          routePath: 'jarvis_orchestrator.code_change',
          source: 'jarvis_orchestrator',
          tool: 'Codex',
        });
        const startedAt = Date.now();
        const out = await deps.runCodeChange({
          message,
          strategy,
          traceId,
          contextHint,
          sessionId,
          trace,
        });
        trace('jarvis_tool_call_end', {
          routePath: out?.routePath || 'jarvis_orchestrator.code_change',
          source: out?.source || 'jarvis_orchestrator',
          tool: 'Codex',
          durationMs: Date.now() - startedAt,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'I could not run the code-change tool right now.',
          intent,
          toolsUsed: out?.toolsUsed || ['Codex', 'RepoOps'],
          routePath: out?.routePath || 'jarvis_orchestrator.code_change',
          traceId,
        }, out), {
          decisionMode: 'invoke_tools',
        });
      }
    }

    if (intent === 'web_question' || intent === 'web_local_search' || intent === 'local_search') {
      const sessionLocationHint = deps.getSessionLocation
        ? deps.getSessionLocation({ sessionId, clientId })
        : null;
      const webIntent = parseWebLookupIntent(
        message,
        request.userLocationHint || sessionLocationHint || null,
        { intent }
      );
      if (webIntent.likelyOfflineKnowledge && intent !== 'local_search' && deps.runGeneralChat) {
        trace('jarvis_tool_call_start', {
          routePath: 'jarvis_orchestrator.web_question.offline',
          source: 'jarvis_orchestrator',
          tool: 'Jarvis',
        });
        const startedAt = Date.now();
        const out = await deps.runGeneralChat({
          message,
          strategy,
          traceId,
          contextHint,
          sessionId,
          trace,
        });
        trace('jarvis_tool_call_end', {
          routePath: out?.routePath || 'jarvis_orchestrator.web_question.offline',
          source: out?.source || 'jarvis_orchestrator',
          tool: 'Jarvis',
          durationMs: Date.now() - startedAt,
        });
        return finish(withToolPayload({
          reply: String(out?.reply || '').trim() || 'I could not answer that offline question right now.',
          intent: 'general_chat',
          toolsUsed: out?.toolsUsed || ['Jarvis'],
          routePath: out?.routePath || 'jarvis_orchestrator.web_question.offline',
          traceId,
        }, out), {
          selectedSkill: 'GeneralConversation',
          decisionMode: 'invoke_tools',
        });
      }

      if (webIntent.locationRequired && !webIntent.locationHint) {
        setConsentPendingForRun({
          kind: 'location',
          payload: {
            tool: 'WebTool',
            parsedIntent: intent,
            originalMessage: message,
            queryUsed: webIntent.queryUsed || message,
            originalQuery: webIntent.originalQuery || message,
            normalizedQuery: webIntent.normalizedQuery || webIntent.queryUsed || message,
            brandOrTerm: webIntent.brandOrTerm || null,
            categoryHint: webIntent.categoryHint || null,
            locationRequired: true,
            needLocation: true,
            locationHint: null,
            phoneLinkUrl: request.phoneLinkUrl || null,
          },
        });
        return finish({
          reply: "I can do that, and I haven't run the search yet. Want me to use your phone's current location, or use a specific city?",
          intent,
          toolsUsed: ['Jarvis'],
          toolReceipts: [buildToolReceipt({
            traceId,
            intent,
            tool: 'Consent',
            consent: { kind: 'location', granted: false },
            parameters: { query: webIntent.queryUsed || message },
            result: { executed: false, reason: 'await_location_choice' },
          })],
          consentPending: true,
          consentKind: 'location',
          consentNeedLocation: true,
          routePath: 'jarvis_orchestrator.web_question.await_location',
          skillId: getSkillIdByIntent(intent),
          skillState: 'location_needed',
        }, {
          decisionMode: 'wait_for_consent',
        });
      }

      setConsentPendingForRun({
        kind: 'web_search',
        payload: {
          tool: 'WebTool',
          parsedIntent: intent,
          originalMessage: message,
          queryUsed: webIntent.queryUsed || message,
          originalQuery: webIntent.originalQuery || message,
          normalizedQuery: webIntent.normalizedQuery || webIntent.queryUsed || message,
          brandOrTerm: webIntent.brandOrTerm || null,
          categoryHint: webIntent.categoryHint || null,
          locationRequired: webIntent.locationRequired === true,
          needLocation: false,
          locationHint: webIntent.locationHint || null,
        },
      });
      return finish({
        reply: "I haven't run that search yet. Want me to look it up now?",
        intent,
        toolsUsed: ['Jarvis'],
        toolReceipts: [buildToolReceipt({
          traceId,
          intent,
          tool: 'Consent',
          consent: { kind: 'web_search', granted: false },
          parameters: {
            query: webIntent.queryUsed || message,
            normalizedQuery: webIntent.normalizedQuery || webIntent.queryUsed || message,
            originalQuery: webIntent.originalQuery || message,
            locationHint: webIntent.locationHint || null,
          },
          result: { executed: false, reason: 'await_web_confirmation' },
        })],
        consentPending: true,
        consentKind: 'web_search',
        consentNeedLocation: false,
        routePath: 'jarvis_orchestrator.web_question.await_authorization',
        skillId: getSkillIdByIntent(intent),
        skillState: 'confirm_search',
      }, {
        decisionMode: 'wait_for_consent',
      });
    }

    if (deps.runGeneralChat) {
      trace('jarvis_tool_call_start', {
        routePath: 'jarvis_orchestrator.general_chat',
        source: 'jarvis_orchestrator',
        tool: 'Jarvis',
      });
      const startedAt = Date.now();
      const out = await deps.runGeneralChat({
        message,
        strategy,
        traceId,
        contextHint,
        sessionId,
        trace,
      });
      trace('jarvis_tool_call_end', {
        routePath: out?.routePath || 'jarvis_orchestrator.general_chat',
        source: out?.source || 'jarvis_orchestrator',
        tool: 'Jarvis',
        durationMs: Date.now() - startedAt,
      });
      return finish(withToolPayload({
        reply: String(out?.reply || '').trim() || 'I am online and ready.',
        intent,
        toolsUsed: out?.toolsUsed || ['Jarvis'],
        routePath: out?.routePath || 'jarvis_orchestrator.general_chat',
        traceId,
      }, out), {
        selectedSkill: 'GeneralConversation',
        decisionMode: 'invoke_tools',
      });
    }

    return finish({
      reply: 'I am online and ready. Ask me what you want to do next.',
      intent,
      toolsUsed: ['Jarvis'],
      routePath: 'jarvis_orchestrator.default',
      traceId,
    }, {
      selectedSkill: 'GeneralConversation',
      decisionMode: 'answer_now',
    });
  }

  return {
    run,
    classifyJarvisIntent,
  };
}

module.exports = {
  createJarvisOrchestrator,
  classifyJarvisIntent,
  isConfirmPhrase,
  isCancelPhrase,
};
