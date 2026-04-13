'use strict';

const { getSkillByIntent } = require('./skill-registry');

const INTENT_TO_TOOLS = Object.freeze({
  trading_decision: ['Analyst', 'Risk'],
  trading_hypothetical: ['ReplayTool', 'Analyst', 'Risk'],
  trading_replay: ['ReplayTool', 'Analyst', 'Risk'],
  trading_review: ['ReplayTool', 'Analyst', 'Risk'],
  trading_plan: ['Analyst', 'Risk', 'Health'],
  trading_execution_request: ['Execution', 'Risk', 'Health'],
  trading_status: ['Bridge', 'Analyst', 'Health'],
  code_change: ['Codex', 'RepoOps'],
  system_diag: ['DiagTool'],
  shopping_advisor: ['AdvisorPlanner', 'MemoryStore'],
  project_planner: ['AdvisorPlanner', 'MemoryStore'],
  complaint_log: ['ComplaintStore', 'TraceStore'],
  improvement_review: ['ImprovementEngine', 'ComplaintStore', 'TraceStore'],
  web_question: ['WebTool'],
  local_search: ['WebTool'],
  web_local_search: ['WebTool'],
  os_action: ['OS Agent'],
  device_action: ['OS Agent'],
  unclear: [],
  general_chat: ['Jarvis'],
});

function selectToolsForIntent(intent) {
  const key = String(intent || 'general_chat').trim().toLowerCase();
  const skill = getSkillByIntent(key);
  if (skill && Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0) {
    return skill.allowedTools.slice();
  }
  return INTENT_TO_TOOLS[key] ? INTENT_TO_TOOLS[key].slice() : ['Jarvis'];
}

module.exports = {
  INTENT_TO_TOOLS,
  selectToolsForIntent,
};
