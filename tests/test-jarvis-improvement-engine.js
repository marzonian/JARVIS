#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const {
  runImprovementEngine,
} = require('../server/jarvis-core/improvement-engine');

function run() {
  const now = new Date().toISOString();
  const complaints = [
    {
      id: 1,
      createdAt: now,
      selectedSkill: 'TradingDecision',
      route_path: 'jarvis_orchestrator.trading_decision',
      reply: "I'm not sure what you want yet.",
      notes: 'unclear routing',
    },
    {
      id: 2,
      createdAt: now,
      selectedSkill: 'LocalSearch',
      route_path: 'jarvis_orchestrator.consent.web.execute',
      reply: 'Web search is in stub mode; I did not run a real lookup.',
      notes: 'stub mode confusion',
    },
    {
      id: 3,
      createdAt: now,
      selectedSkill: 'TradingDecision',
      route_path: 'jarvis_orchestrator.trading_decision',
      reply: 'No action is pending right now.',
      notes: 'pending recovery missed',
    },
  ];

  const out = runImprovementEngine({
    complaints,
    lookbackDays: 30,
    maxItems: 6,
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.complaintCount, 3);
  assert(Array.isArray(out.suggestions) && out.suggestions.length > 0, 'suggestions expected');
  assert(out.requiresPermission === true, 'improvements must require permission');
  const first = out.suggestions[0];
  assert(first && first.id && first.title, 'first suggestion missing fields');
  console.log('All jarvis improvement engine tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`❌ test-jarvis-improvement-engine failed\n   ${err.message}`);
  process.exit(1);
}

