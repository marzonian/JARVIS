#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const { createJarvisExecutiveLayer } = require('../server/jarvis-core/executive');

function runCase(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

const executive = createJarvisExecutiveLayer({
  getSessionLocation: ({ sessionId }) => {
    if (String(sessionId) === 'with-location') {
      return { lat: 40.73, lon: -74.17, city: 'Newark, NJ', region: 'NJ', country: 'US' };
    }
    return null;
  },
});

runCase('trading decision phrase maps to TradingDecision skill', () => {
  const plan = executive.plan({
    message: 'am i clear to trade today',
    sessionId: 's1',
    clientId: 'c1',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'trading_decision');
  assert.strictEqual(plan.skillId, 'TradingDecision');
  assert.strictEqual(plan.responseMode, 'invoke_tools');
  assert(Array.isArray(plan.plannedTools) && plan.plannedTools.includes('Analyst'));
  assert.strictEqual(plan.selectedSkill, 'TradingDecision');
  assert.strictEqual(plan.decisionMode, 'invoke_tools');
  assert(plan.consentState && typeof plan.consentState === 'object');
  assert(plan.confirmationState && typeof plan.confirmationState === 'object');
  assert(plan.pendingState && typeof plan.pendingState === 'object');
});

runCase('local search without location asks for missing location input', () => {
  const plan = executive.plan({
    message: 'nearest walmart',
    sessionId: 'no-location',
    clientId: 'no-location',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'local_search');
  assert.strictEqual(plan.skillId, 'LocalSearch');
  assert.strictEqual(plan.responseMode, 'ask_missing_input');
  assert(plan.requiredInputsMissing.includes('location'));
  assert.strictEqual(plan.consentRequired, true);
  assert.strictEqual(plan.consentKind, 'location');
});

runCase('local search with known location waits for search consent', () => {
  const plan = executive.plan({
    message: 'nearest walmart',
    sessionId: 'with-location',
    clientId: 'with-location',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'local_search');
  assert.strictEqual(plan.skillId, 'LocalSearch');
  assert.strictEqual(plan.responseMode, 'wait_for_consent');
  assert.strictEqual(plan.consentRequired, true);
  assert.strictEqual(plan.consentKind, 'web_search');
});

runCase('system diagnostic phrase maps to SystemDiagnostic skill', () => {
  const plan = executive.plan({
    message: 'what endpoint are you using for my voice requests right now?',
    sessionId: 'diag',
    clientId: 'diag',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'system_diag');
  assert.strictEqual(plan.skillId, 'SystemDiagnostic');
  assert.strictEqual(plan.responseMode, 'invoke_tools');
  assert(Array.isArray(plan.plannedTools) && plan.plannedTools.includes('DiagTool'));
});

runCase('preference statement maps to MemoryPreference skill', () => {
  const plan = executive.plan({
    message: 'I hate Thursdays',
    sessionId: 'mem',
    clientId: 'mem',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'memory_query');
  assert.strictEqual(plan.skillId, 'MemoryPreference');
  assert.strictEqual(plan.responseMode, 'invoke_tools');
  assert(plan.preference && plan.preference.key);
});

runCase('risky device action requires confirmation', () => {
  const plan = executive.plan({
    message: 'uninstall telegram',
    sessionId: 'os',
    clientId: 'os',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'device_action');
  assert.strictEqual(plan.skillId, 'DeviceAction');
  assert.strictEqual(plan.confirmationRequired, true);
  assert.strictEqual(plan.responseMode, 'wait_for_confirmation');
});

runCase('unclear input returns clarify mode', () => {
  const plan = executive.plan({
    message: 'hmm maybe',
    sessionId: 'unclear',
    clientId: 'unclear',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'unclear');
  assert.strictEqual(plan.responseMode, 'ask_clarify');
  assert.strictEqual(plan.selectedSkill, 'GeneralConversation');
  assert.strictEqual(plan.skillState, 'clarify');
});

runCase('shopping advisor phrase maps to ShoppingAdvisor skill', () => {
  const plan = executive.plan({
    message: 'I want a new PC for trading',
    sessionId: 'shop',
    clientId: 'shop',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'shopping_advisor');
  assert.strictEqual(plan.skillId, 'ShoppingAdvisor');
  assert.strictEqual(plan.selectedSkill, 'ShoppingAdvisor');
});

runCase('project planner phrase maps to ProjectPlanner skill', () => {
  const plan = executive.plan({
    message: 'Design a website for my t-shirt business',
    sessionId: 'project',
    clientId: 'project',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'project_planner');
  assert.strictEqual(plan.skillId, 'ProjectPlanner');
  assert.strictEqual(plan.selectedSkill, 'ProjectPlanner');
});

runCase('complaint log phrase maps to ComplaintLogging skill', () => {
  const plan = executive.plan({
    message: 'not a good response',
    sessionId: 'complaint',
    clientId: 'complaint',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'complaint_log');
  assert.strictEqual(plan.skillId, 'ComplaintLogging');
  assert.strictEqual(plan.selectedSkill, 'ComplaintLogging');
});

runCase('improvement review phrase maps to ImprovementReview skill', () => {
  const plan = executive.plan({
    message: 'analyze complaints',
    sessionId: 'improvement',
    clientId: 'improvement',
    voiceMode: true,
  });
  assert.strictEqual(plan.intent, 'improvement_review');
  assert.strictEqual(plan.skillId, 'ImprovementReview');
  assert.strictEqual(plan.selectedSkill, 'ImprovementReview');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log('All executive planner tests passed.');
