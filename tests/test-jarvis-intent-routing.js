#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { analyzeJarvisIntent } = require('../server/jarvis-core/intent');

function runCaseGroup(name, expectedIntent, phrases) {
  for (const phrase of phrases) {
    const out = analyzeJarvisIntent(phrase);
    assert.strictEqual(
      out.intent,
      expectedIntent,
      `${name}: phrase misrouted -> "${phrase}" (got ${out.intent})`
    );
  }
  console.log(`✅ ${name} (${phrases.length})`);
}

function run() {
  runCaseGroup('trading_hypothetical variants', 'trading_hypothetical', [
    'jarvis if i would have taken a trade what would have been my results',
    'if i would have taken a trade what would have been my results',
    'if i had traded today what would have happened',
    'what would have happened if i took that setup',
    'how would that trade have done',
    'would that have won if i traded it',
    'if i would of traded this morning what was outcome',
    "if i would've traded the open what would it be",
    'if i traded right there would it have won',
    'looking back if i took that trade what result',
    'if i had taken the setup would i be green',
  ]);

  runCaseGroup('trading_replay variants', 'trading_replay', [
    'replay today',
    'replay this session',
    'walk me through what happened',
    'walk me through today session',
    'session recap',
    'what did price do after 9:45',
    'how did price move after 9:45',
    'recap today session for me',
    'replay that morning',
    'give me a replay of today',
  ]);

  runCaseGroup('trading_review variants', 'trading_review', [
    "was it good i didn't trade",
    'did i make the right call staying out',
    'right call to stay out today',
    'was staying out right',
    'good decision not trading today',
    'was i right not trading',
    'was not trading the right move',
    'did i do right by sitting out',
    "was it a good day for me to not trade",
    'was sitting out the better decision',
  ]);

  runCaseGroup('trading_result review variants', 'trading_review', [
    'did my setup win today',
    'did my setup lose today',
    "did today's setup lose",
    "did today's setup win",
    'would my setup have worked today',
    'did we win today',
    'did we lose today',
    'did we make money today',
    'did we have a winner today',
    'did we have a loser today',
    'did we do well today',
    'how did we do today',
    'did today win',
    'did today lose',
    'did today work',
    'did today fail',
    'did today make money',
    'was today a winner',
    'was today a loser',
    'how did today setup do',
    'did the call work today',
    'was today setup a winner',
    'did the strategy lose today',
    'how did jarvis do today',
    'did jarvis get today right',
    'was jarvis right today',
    "why didn't my setup work today",
    "why didn't it work",
    'why did my setup fail today',
    'why did the setup lose today',
    'what made the setup fail',
    'what went wrong today',
    'why was today a no-trade',
    "why didn't jarvis like the setup",
  ]);

  runCaseGroup('trading_plan variants', 'trading_plan', [
    "what's the plan today",
    "what's my best setup",
    'what is my gameplan today',
    'how should i trade this morning',
    'trading plan for today',
    'trade plan right now',
    'what should i do right now with my trading',
    'am i trading today',
    "how's it looking for my trading plan",
    'morning outlook for trading',
  ]);

  runCaseGroup('trading_execution_request variants', 'trading_execution_request', [
    'enter now',
    'enter a trade now',
    'close my position',
    'flatten',
    'buy now',
    'sell now',
    'execute the trade',
    'take the trade for me',
    'press buy now',
    'press sell now',
  ]);

  runCaseGroup('trading_decision clear-to-trade variants', 'trading_decision', [
    'am i clear to trade today',
    'am i clear to trade',
    'clear to trade today?',
  ]);

  runCaseGroup('trading decision natural language variants', 'trading_decision', [
    'what should i do right now',
    'is this a wait or a go',
    'do i take it or not',
    'should we take it',
    'what do you think here',
    'are we good to go',
  ]);

  runCaseGroup('trading status natural language variants', 'trading_status', [
    'why are we waiting',
    'if it clears what is the lean',
    "what's the lean if this clears",
  ]);

  runCaseGroup('local_search variants', 'local_search', [
    "service where's the nearest walmart",
    'nearest walmart',
    'walmart near me',
    'closest target',
    'find a target',
    'target near me',
    'where is the nearest pharmacy',
    'find cvs',
    'pizza around here',
    'find me a pizza place',
    'nearest coffee shop',
    'closest gas station near me',
    'find coffee near me',
    'nearby coffee near me',
    'closest restaurant near me',
    'nearest store near me',
    'find a station near me',
    'what is the closest coffee place',
    'coffee near me right now',
    'nearest coffee shop in newark',
    'services where is the nearest ups store',
    'find urgent care near me',
    'where is nearest grocery store',
  ]);

  runCaseGroup('device_action variants', 'device_action', [
    'uninstall telegram',
    'remove app telegram',
    'delete file test.txt',
    'erase this folder',
    'open app safari',
    'launch chrome',
    'change settings for audio',
    'disable bluetooth',
    'enable wifi',
    'turn off notifications',
  ]);

  runCaseGroup('system_diag variants', 'system_diag', [
    'what endpoint are you using for my voice requests right now?',
    'what endpoint are you using?',
    'which endpoint are my voice requests going to?',
    'what route are my voice requests going to?',
    'are you using jarvis or legacy?',
    'jarvis or legacy',
    'what module are you answering from right now?',
    'what api endpoint are you using for voice',
    'which route are you answering from',
    'are my voice requests using jarvis',
  ]);

  runCaseGroup('shopping_advisor variants', 'shopping_advisor', [
    'I want a new PC for trading',
    'recommend a desktop for day trading',
    'help me buy a laptop for trading',
    'best pc for futures trading',
    'build me a new computer for trading',
    'shopping list for trading setup pc',
    'new computer for trading',
    'i need a laptop for trading',
    'suggest a pc for trading',
    'i want to build a pc',
  ]);

  runCaseGroup('project_planner variants', 'project_planner', [
    'design a website for my t-shirt business',
    'build my website for a clothing business',
    'project plan for my website',
    'help me plan a website',
    'create a landing page for my business',
    'design my store website',
    'build a site for my local business',
    'website for my t-shirt business',
    'help me plan my site build',
    'design a portfolio site for my business',
  ]);

  runCaseGroup('complaint_log variants', 'complaint_log', [
    'not a good response',
    'log complaint',
    'report this response',
    'flag this reply',
    'that answer was wrong',
    'this response was bad',
  ]);

  runCaseGroup('improvement_review variants', 'improvement_review', [
    'improvement suggestions',
    'what should we improve',
    'analyze complaints',
    'review failures',
    'jarvis improvement report',
    'review complaints and suggest fixes',
  ]);

  runCaseGroup('general_chat utility variants', 'general_chat', [
    'what time is it',
    'what day is it',
    'hey how is it going',
    'help',
    'what can you do',
    'hello',
    'yo',
    'hows it going',
    'what is the date',
    "what's the time right now",
  ]);

  runCaseGroup('unclear intent variants', 'unclear', [
    'its still',
    'and then that one thing happened',
    'uhmmm maybe yeah',
    'you know what i mean',
    'something is off',
    'anyway',
    'hmm',
    'this is weird',
    'not sure',
    'idk',
  ]);

  {
    const out = analyzeJarvisIntent('what should i do right now about dinner');
    assert.notStrictEqual(out.intent, 'trading_decision', 'non-trading phrase should not route to trading_decision');
    assert.notStrictEqual(out.intent, 'trading_status', 'non-trading phrase should not route to trading_status');
    assert.notStrictEqual(out.intent, 'trading_plan', 'non-trading phrase should not route to trading_plan');
    console.log('✅ non-trading phrase stays outside trading path');
  }

  {
    const out = analyzeJarvisIntent('did we win today with website traffic');
    assert.notStrictEqual(out.intent, 'trading_review', 'non-trading performance phrase should not route to trading_review');
    console.log('✅ ambiguous non-trading performance phrase stays outside trading review path');
  }

  {
    const out = analyzeJarvisIntent('did today win in football');
    assert.notStrictEqual(out.intent, 'trading_review', 'non-trading sports phrase should not route to trading_review');
    console.log('✅ compressed non-trading sports phrase stays outside trading review path');
  }

  console.log('All jarvis intent routing tests passed.');
}

try {
  run();
} catch (err) {
  console.error(`❌ test-jarvis-intent-routing failed\n   ${err.message}`);
  process.exit(1);
}
