'use strict';

function freezeSkill(def) {
  return Object.freeze({
    ...def,
    intents: Object.freeze([...(def.intents || [])]),
    allowedTools: Object.freeze([...(def.allowedTools || [])]),
    inputs: Object.freeze([...(def.inputs || [])]),
    states: Object.freeze([...(def.states || [])]),
    allowedFollowups: Object.freeze([...(def.allowedFollowups || [])]),
  });
}

const TRADING_DECISION_SKILL = freezeSkill({
  id: 'TradingDecision',
  intents: ['trading_decision', 'trading_plan', 'trading_execution_request'],
  allowedTools: ['RiskTool', 'Health', 'Analyst'],
  inputs: ['message', 'marketDataFreshness', 'riskState'],
  states: ['evaluate', 'blocked_health', 'blocked_risk', 'decision_ready'],
  allowedFollowups: ['explain', 'why', 'details', 'what happened'],
});

const TRADING_STATUS_SKILL = freezeSkill({
  id: 'TradingStatus',
  intents: ['trading_status'],
  allowedTools: ['Health', 'Analyst'],
  inputs: ['message', 'marketDataFreshness'],
  states: ['evaluate', 'status_ready', 'blocked_health'],
  allowedFollowups: ['trend', 'regime', 'bias', 'explain'],
});

const TRADING_REPLAY_SKILL = freezeSkill({
  id: 'TradingReplay',
  intents: ['trading_hypothetical', 'trading_replay', 'trading_review'],
  allowedTools: ['ReplayTool', 'Health', 'RiskTool', 'Analyst'],
  inputs: ['message', 'barsData', 'strategyProfile'],
  states: ['replay_requested', 'replay_ready', 'replay_missing_data'],
  allowedFollowups: ['explain', 'details', 'replay another'],
});

const LOCAL_SEARCH_SKILL = freezeSkill({
  id: 'LocalSearch',
  intents: ['local_search', 'web_local_search'],
  allowedTools: ['LocationStore', 'ConsentFSM', 'WebTool'],
  inputs: ['entityQuery', 'locationHint', 'locationRequired'],
  states: [
    'location_needed',
    'confirm_search',
    'results_presented',
    'confirm_directions_select',
    'confirm_directions_execute',
  ],
  allowedFollowups: [
    'yes',
    'no',
    'cancel',
    'not now',
    'city_text',
    'selection_text',
    'switch topics',
    'continue',
  ],
});

const WEB_SEARCH_SKILL = freezeSkill({
  id: 'WebSearch',
  intents: ['web_question'],
  allowedTools: ['ConsentFSM', 'WebTool'],
  inputs: ['query', 'webConsent'],
  states: ['confirm_search', 'search_executed', 'search_disabled'],
  allowedFollowups: ['yes', 'no', 'cancel', 'details'],
});

const DEVICE_ACTION_SKILL = freezeSkill({
  id: 'DeviceAction',
  intents: ['device_action', 'os_action'],
  allowedTools: ['ConsentFSM', 'OS Agent'],
  inputs: ['actionType', 'target', 'confirmation'],
  states: ['confirm_required', 'executed', 'agent_unavailable', 'blocked_allowlist'],
  allowedFollowups: ['yes', 'no', 'cancel', 'confirm'],
});

const MEMORY_PREFERENCE_SKILL = freezeSkill({
  id: 'MemoryPreference',
  intents: ['memory_query'],
  allowedTools: ['MemoryStore', 'ConsentFSM'],
  inputs: ['preferenceStatement', 'confirmation'],
  states: ['capture', 'contradiction_prompt', 'updated', 'ignored'],
  allowedFollowups: ['yes', 'no', 'forget that', 'update'],
});

const SHOPPING_ADVISOR_SKILL = freezeSkill({
  id: 'ShoppingAdvisor',
  intents: ['shopping_advisor'],
  allowedTools: ['AdvisorPlanner', 'MemoryStore', 'WebTool'],
  inputs: ['goal', 'budget', 'formFactor', 'constraints'],
  states: ['intake', 'plan_ready', 'needs_followup'],
  allowedFollowups: ['yes', 'no', 'cancel', 'details', 'continue', 'switch topics'],
});

const PROJECT_PLANNER_SKILL = freezeSkill({
  id: 'ProjectPlanner',
  intents: ['project_planner'],
  allowedTools: ['AdvisorPlanner', 'MemoryStore'],
  inputs: ['projectGoal', 'audience', 'brandTone', 'scope'],
  states: ['intake', 'brief_ready', 'needs_followup'],
  allowedFollowups: ['yes', 'no', 'cancel', 'details', 'continue', 'switch topics'],
});

const COMPLAINT_LOGGING_SKILL = freezeSkill({
  id: 'ComplaintLogging',
  intents: ['complaint_log'],
  allowedTools: ['ComplaintStore', 'TraceStore'],
  inputs: ['prompt', 'reply', 'traceId', 'notes'],
  states: ['capture', 'saved'],
  allowedFollowups: ['details', 'export', 'cancel'],
});

const IMPROVEMENT_REVIEW_SKILL = freezeSkill({
  id: 'ImprovementReview',
  intents: ['improvement_review'],
  allowedTools: ['ImprovementEngine', 'ComplaintStore', 'TraceStore'],
  inputs: ['scope'],
  states: ['analyze', 'propose'],
  allowedFollowups: ['apply', 'details', 'cancel'],
});

const SYSTEM_DIAG_SKILL = freezeSkill({
  id: 'SystemDiagnostic',
  intents: ['system_diag'],
  allowedTools: ['DiagTool', 'TraceStore'],
  inputs: ['message'],
  states: ['diagnose', 'report'],
  allowedFollowups: ['show trace', 'show status'],
});

const GENERAL_CONVERSATION_SKILL = freezeSkill({
  id: 'GeneralConversation',
  intents: ['general_chat', 'unclear'],
  allowedTools: ['Jarvis'],
  inputs: ['message'],
  states: ['converse', 'clarify'],
  allowedFollowups: ['clarify', 'switch topics'],
});

const SKILL_REGISTRY = Object.freeze({
  trading_decision: TRADING_DECISION_SKILL,
  trading_plan: TRADING_DECISION_SKILL,
  trading_execution_request: TRADING_DECISION_SKILL,
  trading_status: TRADING_STATUS_SKILL,
  trading_hypothetical: TRADING_REPLAY_SKILL,
  trading_replay: TRADING_REPLAY_SKILL,
  trading_review: TRADING_REPLAY_SKILL,
  local_search: LOCAL_SEARCH_SKILL,
  web_local_search: LOCAL_SEARCH_SKILL,
  web_question: WEB_SEARCH_SKILL,
  device_action: DEVICE_ACTION_SKILL,
  os_action: DEVICE_ACTION_SKILL,
  memory_query: MEMORY_PREFERENCE_SKILL,
  shopping_advisor: SHOPPING_ADVISOR_SKILL,
  project_planner: PROJECT_PLANNER_SKILL,
  complaint_log: COMPLAINT_LOGGING_SKILL,
  improvement_review: IMPROVEMENT_REVIEW_SKILL,
  system_diag: SYSTEM_DIAG_SKILL,
  general_chat: GENERAL_CONVERSATION_SKILL,
  unclear: GENERAL_CONVERSATION_SKILL,
});

function getSkillByIntent(intent) {
  const key = String(intent || '').trim().toLowerCase();
  return SKILL_REGISTRY[key] || null;
}

function getSkillIdByIntent(intent) {
  const skill = getSkillByIntent(intent);
  return skill ? skill.id : null;
}

function listAllSkills() {
  const out = new Map();
  for (const skill of Object.values(SKILL_REGISTRY)) {
    if (!skill || !skill.id) continue;
    if (!out.has(skill.id)) out.set(skill.id, skill);
  }
  return Array.from(out.values());
}

module.exports = {
  TRADING_DECISION_SKILL,
  TRADING_STATUS_SKILL,
  TRADING_REPLAY_SKILL,
  LOCAL_SEARCH_SKILL,
  WEB_SEARCH_SKILL,
  DEVICE_ACTION_SKILL,
  MEMORY_PREFERENCE_SKILL,
  SHOPPING_ADVISOR_SKILL,
  PROJECT_PLANNER_SKILL,
  COMPLAINT_LOGGING_SKILL,
  IMPROVEMENT_REVIEW_SKILL,
  SYSTEM_DIAG_SKILL,
  GENERAL_CONVERSATION_SKILL,
  SKILL_REGISTRY,
  getSkillByIntent,
  getSkillIdByIntent,
  listAllSkills,
};
