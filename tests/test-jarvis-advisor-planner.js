#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const {
  startShoppingFlow,
  startProjectFlow,
} = require('../server/jarvis-core/advisor-planner');

function run() {
  const shoppingStart = startShoppingFlow('I want a new PC for trading');
  assert.strictEqual(shoppingStart.complete, false);
  assert(/budget/i.test(String(shoppingStart.reply || '')));

  const shoppingDone = startShoppingFlow('budget 2400 desktop with 3 monitors for trading');
  assert.strictEqual(shoppingDone.complete, true);
  assert(Array.isArray(shoppingDone.result?.recommendations), 'recommendations expected');
  assert(shoppingDone.result.recommendations.length >= 1, 'at least one recommendation expected');
  assert(/https?:\/\//i.test(String(shoppingDone.reply || '')), 'recommendation links expected in reply');

  const projectStart = startProjectFlow('Design a website for my t-shirt business');
  assert.strictEqual(projectStart.complete, false);
  assert(/audience|main goal/i.test(String(projectStart.reply || '')));

  const projectDone = startProjectFlow(
    'Audience is traders. Goal is sales. Home shop about contact pages.',
    projectStart.profile
  );
  assert.strictEqual(projectDone.complete, true);
  assert(Array.isArray(projectDone.result?.designBrief), 'design brief expected');
  assert(Array.isArray(projectDone.result?.buildPlan), 'build plan expected');
  assert(/project brief ready|build plan/i.test(String(projectDone.reply || '')));

  console.log('All jarvis advisor planner tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`❌ test-jarvis-advisor-planner failed\n   ${err.message}`);
  process.exit(1);
}
