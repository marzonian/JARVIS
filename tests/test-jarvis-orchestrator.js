#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { createJarvisOrchestrator } = require('../server/jarvis-orchestrator');

async function run(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  await run('voice query from Bridge routes to Analyst trading decision tool', async () => {
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => ({
        reply: 'Right now the better move is to wait for cleaner structure.',
        toolsUsed: ['Analyst'],
        activeModule: 'analyst',
      }),
    });

    const out = await orchestrator.run({
      message: 'should i take this setup now',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-1',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_decision');
    assert.ok(String(out.reply).toLowerCase().includes('wait for cleaner structure'));
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('Analyst'));
    assert.strictEqual(out.activeModule, 'analyst');
  });

  await run('natural live-action phrase family routes to trading_decision tool', async () => {
    const decisionPhrases = [
      'should we take it',
      'what do you think here',
      'are we good to go',
    ];
    let decisionCalls = 0;
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => {
        decisionCalls += 1;
        return {
          reply: "I'd wait for cleaner structure before taking it.",
          toolsUsed: ['Analyst'],
          activeModule: 'analyst',
          routePath: 'runJarvisTradingDecisionTool.execute',
        };
      },
    });

    for (const phrase of decisionPhrases) {
      const out = await orchestrator.run({
        message: phrase,
        activeModule: 'bridge',
        contextHint: 'bridge',
        sessionId: `jarvis-test-live-action-family-${phrase.replace(/\s+/g, '-').toLowerCase()}`,
        voiceBriefMode: 'earbud',
      });
      assert.strictEqual(out.intent, 'trading_decision', `phrase should map to trading_decision: ${phrase}`);
      assert.strictEqual(out.selectedSkill, 'TradingDecision', `phrase should select TradingDecision: ${phrase}`);
      assert.strictEqual(out.routePath, 'runJarvisTradingDecisionTool.execute', `phrase should stay on decision route: ${phrase}`);
    }
    assert.strictEqual(decisionCalls, decisionPhrases.length, 'all live-action family phrases should execute trading decision tool');
  });

  await run('legacy-style phrase routes to trading_decision', async () => {
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => ({
        reply: "I'd sit out for now because structure is mixed.",
        toolsUsed: ['Analyst'],
        activeModule: 'analyst',
      }),
    });

    const out = await orchestrator.run({
      message: "DON'T TRADE. Best setup now. Why?",
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-legacy-route',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_plan');
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('Analyst'));
  });

  await run('trading-plan phrasing routes to trading_decision', async () => {
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => ({
        reply: "I’d wait for cleaner structure before taking the next setup.",
        toolsUsed: ['Analyst'],
        activeModule: 'analyst',
      }),
    });

    const out = await orchestrator.run({
      message: "how's it looking for my trading plan",
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-trading-plan-route',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_plan');
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('Analyst'));
  });

  await run('what-should-i-do-with-my-trading routes to trading_plan', async () => {
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => ({
        reply: "I’d wait for the next clean setup instead of forcing a trade.",
        toolsUsed: ['Analyst'],
        activeModule: 'analyst',
      }),
    });

    const out = await orchestrator.run({
      message: 'what should I do right now with my Trading',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-what-should-i-do-trading',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_plan');
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('Analyst'));
  });

  await run('wait-but-would-win review phrase routes to trading_hypothetical', async () => {
    const orchestrator = createJarvisOrchestrator({
      runTradingReplay: async () => ({
        reply: "I'd score that replay as a valid review candidate.",
        toolsUsed: ['ReplayTool'],
        activeModule: 'analyst',
        routePath: 'runJarvisTradingReplayTool.execute',
      }),
    });

    const out = await orchestrator.run({
      message: 'the last two times i was told to wait and not trade, if i would have traded i would have won',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-wait-review-route',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_hypothetical');
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool'));
    assert.strictEqual(out.routePath, 'runJarvisTradingReplayTool.execute');
  });

  await run('direct result phrase stays on trading review path even if executive intent drifts', async () => {
    let replayCalls = 0;
    let decisionCalls = 0;
    const orchestrator = createJarvisOrchestrator({
      executiveLayer: {
        plan: (input = {}) => ({
          domain: 'trading',
          intent: 'trading_decision',
          skillId: 'TradingDecision',
          skill: null,
          requiredInputsMissing: [],
          consentRequired: false,
          consentKind: null,
          confirmationRequired: false,
          plannedTools: ['Analyst', 'RiskTool'],
          responseMode: 'invoke_tools',
          traceTags: ['executive', 'intent:trading_decision'],
          contextHint: String(input.contextHint || input.activeModule || 'bridge'),
          voiceMode: input.voiceMode === true,
          voiceBriefMode: String(input.voiceBriefMode || 'earbud'),
          sessionId: String(input.sessionId || input.clientId || 'jarvis-test-direct-result-override'),
          clientId: String(input.clientId || input.sessionId || 'jarvis-test-direct-result-override'),
          pendingActionKind: null,
          intentDetails: {
            intent: 'trading_decision',
            layer: 'executive_stub',
            confidence: 0.9,
            routeGroup: 'trading',
          },
          webIntent: null,
          preference: null,
          selectedSkill: 'TradingDecision',
          skillState: 'decision_ready',
          decisionMode: 'invoke_tools',
          consentState: { pending: false, kind: null, required: false, needLocation: false },
          confirmationState: { pending: false, required: false, kind: null },
          pendingState: { present: false, kind: null },
        }),
      },
      runTradingReplay: async () => {
        replayCalls += 1;
        return {
          reply: "I'd mark today's setup as a win.",
          toolsUsed: ['ReplayTool'],
          activeModule: 'analyst',
          routePath: 'runJarvisTradingReplayTool.execute',
        };
      },
      runTradingDecision: async () => {
        decisionCalls += 1;
        return {
          reply: "I'd wait for cleaner structure.",
          toolsUsed: ['Analyst'],
          activeModule: 'analyst',
          routePath: 'runJarvisTradingDecisionTool.execute',
        };
      },
    });

    const out = await orchestrator.run({
      message: 'did my setup win today',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-direct-result-override',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_review');
    assert.strictEqual(out.selectedSkill, 'TradingReplay');
    assert.strictEqual(out.routePath, 'runJarvisTradingReplayTool.execute');
    assert.strictEqual(replayCalls, 1, 'Replay tool should be invoked once for direct-result review');
    assert.strictEqual(decisionCalls, 0, 'Decision tool must not run for direct-result review');
  });

  await run('postmortem phrase stays on trading review path even if executive intent drifts', async () => {
    let replayCalls = 0;
    let decisionCalls = 0;
    const orchestrator = createJarvisOrchestrator({
      executiveLayer: {
        plan: (input = {}) => ({
          domain: 'trading',
          intent: 'trading_decision',
          skillId: 'TradingDecision',
          skill: null,
          requiredInputsMissing: [],
          consentRequired: false,
          consentKind: null,
          confirmationRequired: false,
          plannedTools: ['Analyst', 'RiskTool'],
          responseMode: 'invoke_tools',
          traceTags: ['executive', 'intent:trading_decision'],
          contextHint: String(input.contextHint || input.activeModule || 'bridge'),
          voiceMode: input.voiceMode === true,
          voiceBriefMode: String(input.voiceBriefMode || 'earbud'),
          sessionId: String(input.sessionId || input.clientId || 'jarvis-test-postmortem-override'),
          clientId: String(input.clientId || input.sessionId || 'jarvis-test-postmortem-override'),
          pendingActionKind: null,
          intentDetails: {
            intent: 'trading_decision',
            layer: 'executive_stub',
            confidence: 0.9,
            routeGroup: 'trading',
          },
          webIntent: null,
          preference: null,
          selectedSkill: 'TradingDecision',
          skillState: 'decision_ready',
          decisionMode: 'invoke_tools',
          consentState: { pending: false, kind: null, required: false, needLocation: false },
          confirmationState: { pending: false, required: false, kind: null },
          pendingState: { present: false, kind: null },
        }),
      },
      runTradingReplay: async () => {
        replayCalls += 1;
        return {
          reply: "I'd mark this as a no-trade under your original plan.",
          toolsUsed: ['ReplayTool'],
          activeModule: 'analyst',
          routePath: 'runJarvisTradingReplayTool.execute',
        };
      },
      runTradingDecision: async () => {
        decisionCalls += 1;
        return {
          reply: "I'd wait for cleaner structure.",
          toolsUsed: ['Analyst'],
          activeModule: 'analyst',
          routePath: 'runJarvisTradingDecisionTool.execute',
        };
      },
    });

    const out = await orchestrator.run({
      message: "why didn't my setup work today",
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-postmortem-override',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'trading_review');
    assert.strictEqual(out.selectedSkill, 'TradingReplay');
    assert.strictEqual(out.routePath, 'runJarvisTradingReplayTool.execute');
    assert.strictEqual(replayCalls, 1, 'Replay tool should be invoked once for postmortem review');
    assert.strictEqual(decisionCalls, 0, 'Decision tool must not run for postmortem review');
  });

  await run('time question stays in general_chat and avoids trading tools', async () => {
    let tradingCalls = 0;
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => {
        tradingCalls += 1;
        return {
          reply: "I'd wait for cleaner structure.",
          toolsUsed: ['Analyst'],
          activeModule: 'analyst',
        };
      },
      runGeneralChat: async () => ({
        reply: 'It is 09:40 ET.',
        toolsUsed: ['Jarvis'],
        activeModule: 'bridge',
      }),
    });

    const out = await orchestrator.run({
      message: 'what time is it',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-time-general-chat',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'general_chat');
    assert.strictEqual(tradingCalls, 0, 'time question must not execute trading tool');
    assert.deepStrictEqual(out.toolsUsed, ['Jarvis']);
  });

  await run('endpoint question routes to system_diag with DiagTool', async () => {
    const orchestrator = createJarvisOrchestrator({
      runSystemDiag: async () => ({
        reply: 'Voice requests are using /api/jarvis/query. Jarvis routing is ON and legacy fallback is OFF.',
        toolsUsed: ['DiagTool'],
        routePath: 'jarvis_orchestrator.system_diag',
        source: 'jarvis_diag',
      }),
      runGeneralChat: async () => ({
        reply: 'general fallback',
        toolsUsed: ['Jarvis'],
      }),
    });

    const out = await orchestrator.run({
      message: 'what endpoint are you using for my voice requests right now?',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-system-diag',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'system_diag');
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('DiagTool'));
    assert.strictEqual(out.routePath, 'jarvis_orchestrator.system_diag');
    assert.ok(/\/api\/jarvis\/query/i.test(String(out.reply || '')));
  });

  await run('web question requires consent before execution', async () => {
    const orchestrator = createJarvisOrchestrator({
      runWebQuestion: async () => ({
        reply: 'Found nearby coffee options.',
        toolsUsed: ['WebTool'],
        activeModule: 'bridge',
      }),
    });

    const first = await orchestrator.run({
      message: 'nearest coffee shop',
      sessionId: 'jarvis-test-2',
    });
    assert.strictEqual(first.intent, 'local_search');
    assert.strictEqual(first.consentPending, true);
    assert.ok(/use your current location|specific city|look that up now/i.test(String(first.reply)));

    const city = await orchestrator.run({
      message: 'Newark NJ',
      sessionId: 'jarvis-test-2',
    });
    assert.strictEqual(city.intent, 'local_search');
    assert.strictEqual(city.consentPending, true);
    assert.ok(/want me to (look that up|run it) now/i.test(String(city.reply)));

    const out = await orchestrator.run({
      message: 'yes',
      sessionId: 'jarvis-test-2',
    });
    assert.strictEqual(out.intent, 'local_search');
    assert.ok(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('WebTool'));
  });

  await run('yes/no recovery adopts recent pending action for same client', async () => {
    const sharedClientId = `jarvis-client-${Date.now()}`;
    let webRuns = 0;
    const orchestrator = createJarvisOrchestrator({
      runWebQuestion: async () => {
        webRuns += 1;
        return {
          reply: 'Here are nearby options.',
          toolsUsed: ['WebTool'],
          routePath: 'jarvis_orchestrator.consent.web.execute',
          web: { sources: [] },
          toolReceipts: [{
            tool: 'WebTool',
            parameters: { mode: 'stub' },
            result: { executed: false },
          }],
        };
      },
    });

    const first = await orchestrator.run({
      message: 'nearest coffee shop in Newark NJ',
      sessionId: 'jarvis-recovery-a',
      clientId: sharedClientId,
    });
    assert.strictEqual(first.consentPending, true, 'first request should set pending consent', { first });

    const recovered = await orchestrator.run({
      message: 'yes',
      sessionId: 'jarvis-recovery-b',
      clientId: sharedClientId,
    });
    assert.strictEqual(recovered.intent, 'local_search', 'recovered flow intent mismatch', { recovered });
    assert.ok(Array.isArray(recovered.toolsUsed) && recovered.toolsUsed.includes('WebTool'), 'recovered flow should execute WebTool', { recovered });
    assert.strictEqual(webRuns, 1, 'recovered flow should execute web tool once', { recovered });
    assert.strictEqual(String(recovered.recoveredFromSessionId || ''), 'jarvis-recovery-a', 'recovered flow should expose source session', { recovered });
  });

  await run('pending web flow does not hijack unrelated general chat', async () => {
    const orchestrator = createJarvisOrchestrator({
      runWebQuestion: async () => ({
        reply: 'Closest options:\n1) Flor de Maria\n2) Cafe Rio',
        toolsUsed: ['WebTool'],
        routePath: 'jarvis_orchestrator.consent.web.execute',
        web: {
          sources: [
            { title: 'Flor de Maria', address: 'Newark' },
            { title: 'Cafe Rio', address: 'Newark' },
          ],
        },
        toolReceipts: [{
          tool: 'WebTool',
          parameters: { mode: 'real' },
          result: { executed: true },
        }],
      }),
    });

    const first = await orchestrator.run({
      message: 'nearest coffee shop in Newark NJ',
      sessionId: 'jarvis-topic-shift',
      clientId: 'jarvis-topic-shift-client',
    });
    assert.strictEqual(first.consentPending, true, 'first request should set consent pending', { first });

    const yes = await orchestrator.run({
      message: 'yes',
      sessionId: 'jarvis-topic-shift',
      clientId: 'jarvis-topic-shift-client',
    });
    assert.strictEqual(yes.consentPending, true, 'yes should advance into directions selection stage', { yes });
    assert.strictEqual(String(yes.consentKind || ''), 'web_directions_select', 'yes should set directions selection pending', { yes });

    const unrelated = await orchestrator.run({
      message: 'my perfect date would have been me and my date cupcake',
      sessionId: 'jarvis-topic-shift',
      clientId: 'jarvis-topic-shift-client',
    });
    assert.strictEqual(unrelated.intent, 'general_chat', 'unrelated phrase must route to general_chat under pending flow', { unrelated });
    assert.strictEqual(unrelated.topicShiftGuardTriggered, true, 'topic-shift guard should trigger for unrelated phrase', { unrelated });
    assert.ok(Array.isArray(unrelated.toolsUsed) && unrelated.toolsUsed.includes('Jarvis'), 'unrelated phrase must not execute web tool', { unrelated });
    assert.ok(/continue, or switch topics\?/i.test(String(unrelated.reply || '')), 'unrelated phrase should prompt continue/switch', { unrelated });
    assert.ok(!/\b(coffee|directions|flor de maria)\b/i.test(String(unrelated.reply || '')), 'unrelated phrase should not leak coffee/directions details', { unrelated });
  });

  await run('location consent pending does not parse unrelated sentence as city', async () => {
    const orchestrator = createJarvisOrchestrator({});
    const first = await orchestrator.run({
      message: 'nearest coffee shop',
      sessionId: 'jarvis-topic-shift-location',
      clientId: 'jarvis-topic-shift-location-client',
    });
    assert.strictEqual(first.consentPending, true, 'location flow should start pending', { first });
    assert.strictEqual(String(first.consentKind || ''), 'location', 'location flow should require location stage', { first });

    const unrelated = await orchestrator.run({
      message: 'my perfect date would have been me and my date cupcake',
      sessionId: 'jarvis-topic-shift-location',
      clientId: 'jarvis-topic-shift-location-client',
    });
    assert.strictEqual(unrelated.intent, 'general_chat', 'unrelated sentence must route to general_chat while pending location', { unrelated });
    assert.strictEqual(unrelated.topicShiftGuardTriggered, true, 'topic shift guard must trigger for unrelated location sentence', { unrelated });
    assert.ok(!/want me to run it now/i.test(String(unrelated.reply || '')), 'unrelated sentence must not be treated as location capture', { unrelated });
  });

  await run('risky OS action requires confirm and does not execute immediately', async () => {
    let osRuns = 0;
    const orchestrator = createJarvisOrchestrator({
      osAllowList: 'open_app,uninstall_app',
      executeOsAction: async () => {
        osRuns += 1;
        return { ok: true, message: 'uninstalled' };
      },
    });

    const first = await orchestrator.run({
      message: 'uninstall Telegram',
      sessionId: 'jarvis-test-3',
    });
    assert.strictEqual(first.intent, 'device_action');
    assert.strictEqual(first.consentPending, true);
    assert.ok(/want me to run it now|explicit confirmation/i.test(String(first.reply)));
    assert.strictEqual(osRuns, 0, 'OS action should not execute before confirm');
  });

  await run('preference contradiction prompts once for update', async () => {
    const orchestrator = createJarvisOrchestrator({});

    const a = await orchestrator.run({
      message: 'I hate Thursdays',
      sessionId: 'jarvis-test-4',
    });
    assert.ok(/saved that preference/i.test(String(a.reply)));

    const b = await orchestrator.run({
      message: 'I love Thursdays',
      sessionId: 'jarvis-test-4',
    });

    assert.ok(/Last time you said/i.test(String(b.reply)));
    assert.ok(/should I update that/i.test(String(b.reply)));
    assert.ok(b.memory && b.memory.contradiction === true);
  });

  await run('unclear/general phrase stays in general_chat and never runs trading tool', async () => {
    let tradingCalls = 0;
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => {
        tradingCalls += 1;
        return {
          reply: "I'd sit out for now because test trading path ran.",
          toolsUsed: ['Analyst'],
          activeModule: 'analyst',
        };
      },
      runGeneralChat: async () => ({
        reply: "I'm not sure what you want me to help with yet. Do you want trading help, a web search, or something else?",
        toolsUsed: ['Jarvis'],
        activeModule: 'bridge',
      }),
    });

    const out = await orchestrator.run({
      message: 'its still dumb it just says anything',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-general-chat-firewall',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'general_chat');
    assert.strictEqual(tradingCalls, 0, 'trading tool must not execute for unrelated phrase');
    assert.deepStrictEqual(out.toolsUsed, ['Jarvis']);
    assert.ok(/not sure what you want/i.test(String(out.reply || '')));
  });

  await run('unclear phrase maps to general_chat clarify and executes no trading tools', async () => {
    let tradingCalls = 0;
    const orchestrator = createJarvisOrchestrator({
      runTradingDecision: async () => {
        tradingCalls += 1;
        return {
          reply: "I'd sit out for now because test trading path ran.",
          toolsUsed: ['Analyst'],
          activeModule: 'analyst',
        };
      },
      runGeneralChat: async () => ({
        reply: 'fallback general chat',
        toolsUsed: ['Jarvis'],
        activeModule: 'bridge',
      }),
    });

    const out = await orchestrator.run({
      message: 'you know what i mean',
      activeModule: 'bridge',
      contextHint: 'bridge',
      sessionId: 'jarvis-test-unclear-classifier',
      voiceBriefMode: 'earbud',
    });

    assert.strictEqual(out.intent, 'general_chat');
    assert.strictEqual(tradingCalls, 0, 'trading tool must not execute for unclear phrase');
    assert.deepStrictEqual(out.toolsUsed, ['Jarvis']);
    assert.ok(/not sure what you want/i.test(String(out.reply || '')));
    assert.strictEqual(String(out.decisionMode || ''), 'ask_clarify');
  });

  await run('shopping advisor opens intake then completes plan', async () => {
    const orchestrator = createJarvisOrchestrator({
      runShoppingAdvisor: async ({ profile }) => ({
        reply: `Shopping plan ready for ${profile?.formFactor || 'desktop'}.`,
        toolsUsed: ['AdvisorPlanner'],
        routePath: 'jarvis_orchestrator.shopping.completed',
      }),
    });
    const first = await orchestrator.run({
      message: 'I want a new PC for trading',
      sessionId: 'jarvis-shop-1',
      clientId: 'jarvis-shop-1',
    });
    assert.strictEqual(first.intent, 'shopping_advisor');
    assert.ok(/budget/i.test(String(first.reply || '')));

    const second = await orchestrator.run({
      message: 'my budget is 2500 desktop with 3 monitors',
      sessionId: 'jarvis-shop-1',
      clientId: 'jarvis-shop-1',
    });
    assert.strictEqual(second.intent, 'shopping_advisor');
    assert.ok(Array.isArray(second.toolsUsed) && second.toolsUsed.includes('AdvisorPlanner'));
    assert.ok(/shopping plan ready/i.test(String(second.reply || '')));
  });

  await run('project planner opens intake then returns a brief', async () => {
    const orchestrator = createJarvisOrchestrator({});
    const first = await orchestrator.run({
      message: 'Design a website for my t-shirt business',
      sessionId: 'jarvis-project-1',
      clientId: 'jarvis-project-1',
    });
    assert.strictEqual(first.intent, 'project_planner');
    assert.ok(/audience|main goal/i.test(String(first.reply || '')));

    const second = await orchestrator.run({
      message: 'Audience is traders and goal is sales with home shop about contact pages',
      sessionId: 'jarvis-project-1',
      clientId: 'jarvis-project-1',
    });
    assert.strictEqual(second.intent, 'project_planner');
    assert.ok(/project brief ready|build plan/i.test(String(second.reply || '')));
  });

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
  console.log('All jarvis orchestrator tests passed.');
})();
