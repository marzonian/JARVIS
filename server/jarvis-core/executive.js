'use strict';

const { analyzeJarvisIntent } = require('./intent');
const { parseConsentReply, parseWebLookupIntent } = require('./consent');
const { getSkillByIntent, getSkillIdByIntent } = require('./skill-registry');
const { selectToolsForIntent } = require('./router');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeTopicKey(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function parsePreferenceStatement(message) {
  const src = String(message || '').trim();
  if (!src) return null;
  const hateLove = src.match(/^i\s+(hate|love)\s+([a-z0-9][a-z0-9\s'’_-]*)[.!?]*$/i);
  if (hateLove) {
    const value = String(hateLove[1] || '').toLowerCase();
    const topicRaw = String(hateLove[2] || '').trim();
    const topicKey = sanitizeTopicKey(topicRaw);
    if (!topicKey) return null;
    return {
      key: `sentiment:${topicKey}`,
      value,
      topicLabel: topicRaw,
      humanValue: `${value} ${topicRaw}`,
    };
  }
  const prefer = src.match(/^i\s+prefer\s+([a-z0-9].+?)[.!?]*$/i);
  if (prefer) {
    const valueRaw = String(prefer[1] || '').trim();
    const valueKey = sanitizeTopicKey(valueRaw);
    if (!valueKey) return null;
    return {
      key: `preference:${valueKey}`,
      value: valueRaw.toLowerCase(),
      topicLabel: valueRaw,
      humanValue: `prefer ${valueRaw}`,
    };
  }
  return null;
}

function detectRiskyTradingExecution(message) {
  const t = normalizeText(message);
  return /\b(press buy|press sell|place (a )?trade|execute (the )?trade|take the trade for me|buy now|sell now|autonomously take|enter now|enter (a )?trade now|close (my )?position|close position|flatten (my )?position)\b/.test(t);
}

function parseOsActionRequest(message) {
  const t = normalizeText(message);
  const extractTarget = (re) => {
    const m = String(message || '').match(re);
    return m ? String(m[1] || '').trim() : '';
  };
  if (/\b(uninstall|remove)\b/.test(t)) {
    return { actionType: 'uninstall_app', target: extractTarget(/(?:uninstall|remove)\s+(.+)$/i), risky: true };
  }
  if (/\b(delete|erase|trash)\b/.test(t)) {
    return { actionType: 'delete_file', target: extractTarget(/(?:delete|erase|trash)\s+(.+)$/i), risky: true };
  }
  if (/\b(settings|turn off|disable|enable)\b/.test(t)) {
    return { actionType: 'change_settings', target: extractTarget(/(?:settings?|turn off|disable|enable)\s+(.+)$/i), risky: true };
  }
  if (/\b(open|launch|start)\b/.test(t)) {
    return { actionType: 'open_app', target: extractTarget(/(?:open|launch|start)\s+(.+)$/i), risky: false };
  }
  if (/\b(close|quit)\b/.test(t)) {
    return { actionType: 'close_app', target: extractTarget(/(?:close|quit)\s+(.+)$/i), risky: false };
  }
  return { actionType: 'os_action_unknown', target: '', risky: true };
}

function resolveDomain(intent) {
  const key = String(intent || '').trim().toLowerCase();
  if (key.startsWith('trading_')) return 'trading';
  if (key === 'local_search' || key === 'web_local_search') return 'local_search';
  if (key === 'web_question') return 'web';
  if (key === 'device_action' || key === 'os_action') return 'device';
  if (key === 'code_change') return 'code';
  if (key === 'system_diag') return 'diagnostic';
  if (key === 'shopping_advisor') return 'advisory';
  if (key === 'project_planner') return 'planning';
  if (key === 'complaint_log') return 'feedback';
  if (key === 'improvement_review') return 'improvement';
  if (key === 'memory_query') return 'memory';
  if (key === 'unclear') return 'clarify';
  return 'general';
}

function deriveSkillState(skillId, responseMode, options = {}) {
  const id = String(skillId || '').trim();
  const mode = String(responseMode || '').trim();
  const hasLocationMissing = Array.isArray(options.requiredInputsMissing)
    && options.requiredInputsMissing.includes('location');
  if (id === 'GeneralConversation') return mode === 'ask_clarify' ? 'clarify' : 'converse';
  if (id === 'LocalSearch') {
    if (hasLocationMissing) return 'location_needed';
    if (mode === 'wait_for_consent') return 'confirm_search';
    if (mode === 'resolve_pending') return 'confirm_directions_select';
    return 'results_presented';
  }
  if (id === 'ShoppingAdvisor' || id === 'ProjectPlanner') {
    return mode === 'invoke_tools' ? 'plan_ready' : 'needs_followup';
  }
  if (id === 'ComplaintLogging') return 'capture';
  if (id === 'ImprovementReview') return 'analyze';
  if (id === 'MemoryPreference') return 'capture';
  if (id === 'SystemDiagnostic') return 'report';
  if (id === 'TradingReplay') return 'replay_requested';
  if (id === 'TradingStatus') return 'status_ready';
  if (id === 'TradingDecision') return mode === 'wait_for_confirmation' ? 'blocked_risk' : 'decision_ready';
  return null;
}

function createJarvisExecutiveLayer(options = {}) {
  const classifyIntentDetailed = typeof options.classifyIntentDetailed === 'function'
    ? options.classifyIntentDetailed
    : analyzeJarvisIntent;
  const parseWebIntent = typeof options.parseWebIntent === 'function'
    ? options.parseWebIntent
    : parseWebLookupIntent;
  const getSessionLocation = typeof options.getSessionLocation === 'function'
    ? options.getSessionLocation
    : (() => null);

  function plan(input = {}) {
    const message = String(input.message || '').trim();
    const sessionId = String(input.sessionId || input.clientId || '').trim() || 'jarvis_default';
    const clientId = String(input.clientId || sessionId).trim() || sessionId;
    const contextHint = String(input.contextHint || input.activeModule || 'bridge').trim() || 'bridge';
    const voiceMode = input.voiceMode === true;
    const voiceBriefMode = String(input.voiceBriefMode || 'earbud').trim().toLowerCase() || 'earbud';
    const normalizedMessage = normalizeText(message);
    const consentReply = parseConsentReply(message);
    const pendingAction = input.pendingAction && typeof input.pendingAction === 'object'
      ? input.pendingAction
      : null;

    const preference = parsePreferenceStatement(message);
    if (preference) {
      const selectedSkill = 'MemoryPreference';
      const decisionMode = 'invoke_tools';
      const requiredInputsMissing = [];
      const consentState = {
        pending: false,
        kind: null,
        required: false,
        needLocation: false,
      };
      const confirmationState = {
        pending: false,
        required: false,
        kind: null,
      };
      return {
        domain: 'memory',
        intent: 'memory_query',
        skillId: selectedSkill,
        skill: getSkillByIntent('memory_query'),
        requiredInputsMissing,
        consentRequired: false,
        consentKind: null,
        confirmationRequired: false,
        plannedTools: selectToolsForIntent('memory_query'),
        responseMode: decisionMode,
        traceTags: ['executive', 'domain:memory', 'skill:MemoryPreference'],
        contextHint,
        voiceMode,
        voiceBriefMode,
        sessionId,
        clientId,
        pendingActionKind: pendingAction?.kind || null,
        intentDetails: {
          intent: 'memory_query',
          layer: 'executive',
          confidence: 0.92,
          routeGroup: 'memory',
        },
        preference,
        selectedSkill,
        skillState: deriveSkillState(selectedSkill, decisionMode, { requiredInputsMissing }),
        decisionMode,
        consentState,
        confirmationState,
        pendingState: {
          present: !!pendingAction,
          kind: pendingAction?.kind || null,
        },
      };
    }

    const intentDetails = classifyIntentDetailed(message, { allowClarify: true });
    const intent = String(intentDetails?.intent || 'general_chat').trim().toLowerCase() || 'general_chat';
    const domain = resolveDomain(intent);
    const skillId = getSkillIdByIntent(intent);
    const skill = getSkillByIntent(intent);
    const requiredInputsMissing = [];
    let consentRequired = false;
    let consentKind = null;
    let confirmationRequired = false;
    let responseMode = 'invoke_tools';

    const sessionLocation = getSessionLocation({ sessionId, clientId });
    const webIntent = (
      intent === 'local_search'
      || intent === 'web_local_search'
      || intent === 'web_question'
    )
      ? parseWebIntent(message, input.userLocationHint || sessionLocation || null, { intent })
      : null;

    if (intent === 'unclear') {
      responseMode = 'ask_clarify';
    }
    if (consentReply && pendingAction) {
      responseMode = 'resolve_pending';
    } else if (consentReply && !pendingAction) {
      responseMode = 'answer_now';
    }
    if (pendingAction && !consentReply) {
      responseMode = 'pending_topic_shift_guard';
    }

    if (webIntent) {
      consentRequired = true;
      consentKind = webIntent.locationRequired && !webIntent.locationHint ? 'location' : 'web_search';
      if (webIntent.locationRequired && !webIntent.locationHint) {
        requiredInputsMissing.push('location');
        responseMode = 'ask_missing_input';
      } else if (!pendingAction && responseMode === 'invoke_tools') {
        responseMode = 'wait_for_consent';
      }
    }

    if (intent === 'trading_execution_request' || detectRiskyTradingExecution(message)) {
      confirmationRequired = true;
      if (!pendingAction && responseMode === 'invoke_tools') responseMode = 'wait_for_confirmation';
    }

    if (intent === 'device_action' || intent === 'os_action') {
      confirmationRequired = true;
      if (!pendingAction && responseMode === 'invoke_tools') responseMode = 'wait_for_confirmation';
    }
    const selectedSkill = skillId || null;
    const decisionMode = responseMode;
    const consentState = {
      pending: false,
      kind: consentKind,
      required: consentRequired === true,
      needLocation: requiredInputsMissing.includes('location'),
    };
    const confirmationState = {
      pending: false,
      required: confirmationRequired === true,
      kind: (
        intent === 'trading_execution_request'
        || detectRiskyTradingExecution(message)
      ) ? 'trade_execution' : (
        intent === 'os_action' || intent === 'device_action'
      ) ? 'os_action' : null,
    };

    return {
      domain,
      intent,
      skillId,
      skill,
      requiredInputsMissing,
      consentRequired,
      consentKind,
      confirmationRequired,
      plannedTools: selectToolsForIntent(intent),
      responseMode,
      traceTags: [
        'executive',
        `domain:${domain}`,
        `intent:${intent}`,
        skillId ? `skill:${skillId}` : 'skill:none',
      ],
      contextHint,
      voiceMode,
      voiceBriefMode,
      sessionId,
      clientId,
      pendingActionKind: pendingAction?.kind || null,
      intentDetails,
      webIntent,
      preference,
      selectedSkill,
      skillState: deriveSkillState(selectedSkill, decisionMode, { requiredInputsMissing }),
      decisionMode,
      consentState,
      confirmationState,
      pendingState: {
        present: !!pendingAction,
        kind: pendingAction?.kind || null,
      },
    };
  }

  return {
    plan,
    parsePreferenceStatement,
    detectRiskyTradingExecution,
    parseOsActionRequest,
  };
}

module.exports = {
  createJarvisExecutiveLayer,
  parsePreferenceStatement,
  detectRiskyTradingExecution,
  parseOsActionRequest,
};
