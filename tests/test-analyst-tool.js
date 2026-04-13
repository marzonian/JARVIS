#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { runAnalystTool } = require('../server/tools/analystTool');
const {
  mergeHealthBlockedDecisionReply,
  classifyTradingStatusPromptShape,
  buildTradingStatusReplyFromCanonicalBrief,
} = require('../server/jarvis-core/assistant-decision-brief');

function buildStatusDeps(overrides = {}) {
  return {
    runTopstepReadOnlySync: async () => null,
    buildTradingCommandSnapshot: async () => ({
      decision: {
        orbRangeTicks: 180,
        signalLabel: 'long_bias',
        blockers: ['range_within_limits'],
        topSetupName: 'First-Hour Momentum 10:15',
      },
    }),
    buildAssistantIntelligenceSnapshot: async () => ({
      market: {
        pattern: {
          patternLabel: 'uptrend',
          volatilityRegime: 'normal',
        },
      },
      marketDataFreshness: {
        hasTodaySessionBars: true,
        hasORBComplete: false,
        usedLiveBars: true,
        minutesSinceLastCandle: 1,
        nowEt: { date: '2026-03-03', time: '09:40' },
      },
    }),
    buildJarvisStatusEarbudReply: () => "I'd stay selective for now. Let's watch momentum. If retest is clean, we can engage.",
    parseMinutesFromHHMM: (value, fallback) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
      if (!m) return fallback;
      return (Number(m[1]) * 60) + Number(m[2]);
    },
    ...overrides,
  };
}

async function run() {
  {
    const out = await runAnalystTool({
      mode: 'status',
      message: 'what trend are we in right now',
      strategy: 'original',
      activeModule: 'analyst',
      voiceBriefMode: 'full',
      deps: buildStatusDeps(),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.toolName, 'AnalystTool');
    assert.strictEqual(out.data.hasORBComplete, false, 'pre-9:45 should not mark ORB complete');
    assert.strictEqual(out.data.orbRangeTicks, null, 'pre-9:45 should not expose final ORB range ticks');
    assert.ok(/Trend:/i.test(String(out.data.reply || '')), 'trend summary should be direct');
    assert.ok(/ORB range is not finalized yet\./i.test(String(out.data.reply || '')), 'pre-9:45 reply should avoid final ORB range claim');
    assert.ok(!/ORB range is 180 ticks\./i.test(String(out.data.reply || '')), 'pre-9:45 reply must not claim final ORB range');
    assert.ok(!/(Let me|Pulling|Checking)/i.test(String(out.data.reply || '')), 'trend reply should not use preamble copy');
  }

  {
    const out = await runAnalystTool({
      mode: 'status',
      message: 'what trend are we in right now',
      strategy: 'original',
      activeModule: 'analyst',
      voiceBriefMode: 'full',
      deps: buildStatusDeps({
        buildAssistantIntelligenceSnapshot: async () => ({
          market: {
            pattern: {
              patternLabel: 'uptrend',
              volatilityRegime: 'expanding',
            },
          },
          marketDataFreshness: {
            hasTodaySessionBars: true,
            hasORBComplete: true,
            usedLiveBars: true,
            minutesSinceLastCandle: 1,
            nowEt: { date: '2026-03-03', time: '09:50' },
          },
        }),
      }),
    });
    assert.strictEqual(out.data.hasORBComplete, true, 'post-9:45 should mark ORB complete');
    assert.strictEqual(out.data.orbRangeTicks, 180, 'post-9:45 should expose ORB range ticks');
    assert.ok(/ORB range is 180 ticks\./i.test(String(out.data.reply || '')), 'post-9:45 should allow ORB range claim');
  }

  {
    const out = await runAnalystTool({
      mode: 'decision',
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      deps: {
        runAssistantUnifiedQuery: async () => ({
          reply: "I'd wait for cleaner structure. Let's watch the 10:15 momentum checkpoint. If we get compression under 220 ticks, we can engage.",
          source: 'assistant_query',
          mode: 'quick',
          commandsExecuted: [],
          clientActions: [],
        }),
        buildTradingCommandSnapshot: async () => ({
          decision: {
            orbRangeTicks: 170,
            signalLabel: 'long_bias',
            blockers: ['range_overextended'],
            topSetupName: 'First-Hour Momentum 10:15',
            topSetupTrigger: '70t breakout',
            topSetupTarget: '120/90',
            topSetupStop: '1:1',
          },
        }),
        buildAssistantIntelligenceSnapshot: async () => ({
          market: {
            pattern: {
              patternLabel: 'uptrend',
              volatilityRegime: 'normal',
            },
          },
          marketDataFreshness: {
            hasTodaySessionBars: true,
            hasORBComplete: true,
            usedLiveBars: true,
            minutesSinceLastCandle: 1,
            nowEt: { date: '2026-03-03', time: '09:55' },
          },
        }),
        parseMinutesFromHHMM: (value, fallback) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
          if (!m) return fallback;
          return (Number(m[1]) * 60) + Number(m[2]);
        },
      },
    });

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.toolName, 'AnalystTool');
    assert.ok(out.narrative && out.narrative.stance, 'decision narrative stance missing');
    assert.ok(out.narrative && out.narrative.trigger, 'decision narrative trigger missing');
    assert.ok(out.narrative && out.narrative.condition, 'decision narrative condition missing');
    assert.ok(!/(DON'T TRADE|WAIT:|TRADE\.|\[)/i.test(String((out.narrative.details || []).join(' '))), 'decision narrative should not include legacy rigid tokens');
    assert.strictEqual(out.data.orbRangeTicks, 170);
    assert.ok(out.data.topSetup && /First-Hour Momentum 10:15/i.test(String(out.data.topSetup.name || '')));
    assert.ok(Array.isArray(out.data.blockers), 'decision blockers should be array');
  }

  {
    const canonicalBrief = [
      'Action now: Wait for clearance.',
      "Why: Confidence isn't high enough yet.",
      'What I need to see: Cleaner confirmation.',
      'If it clears: Original Trading Plan, nearest target.',
      'Confidence: Medium (66).',
    ].join(' ');
    const out = await runAnalystTool({
      mode: 'decision',
      message: 'should i take this setup now',
      strategy: 'original',
      activeModule: 'analyst',
      voiceMode: true,
      voiceBriefMode: 'earbud',
      deps: {
        runAssistantUnifiedQuery: async () => ({
          reply: "I'd wait for cleaner structure and maybe look for a momentum re-test.",
          source: 'assistant_query',
          mode: 'quick',
          commandsExecuted: [],
          clientActions: [],
        }),
        buildCanonicalAssistantDecisionBrief: async () => ({
          assistantText: canonicalBrief,
        }),
        buildTradingCommandSnapshot: async () => ({
          decision: {
            orbRangeTicks: 170,
            signalLabel: 'WAIT',
            blockers: ['prob_green_below_50'],
            topSetupName: 'First-Hour Momentum 10:15',
          },
        }),
        buildAssistantIntelligenceSnapshot: async () => ({
          marketDataFreshness: {
            hasTodaySessionBars: true,
            hasORBComplete: true,
            usedLiveBars: true,
            minutesSinceLastCandle: 1,
            nowEt: { date: '2026-03-03', time: '10:02' },
          },
        }),
        parseMinutesFromHHMM: (value, fallback) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
          if (!m) return fallback;
          return (Number(m[1]) * 60) + Number(m[2]);
        },
      },
    });
    assert.strictEqual(out.data.reply, canonicalBrief, 'decision reply should use canonical assistant brief when available');
    assert.strictEqual(out.data.assistantDecisionBriefText, canonicalBrief, 'assistantDecisionBriefText should mirror canonical brief');
  }

  {
    const healthReply = "I'd sit out for now - my live market data isn't healthy. I'll re-check automatically; ask again once health is OK.";
    const canonicalBrief = [
      'Action now: Wait for clearance.',
      'Why: Something is still blocking this setup: RANGE OVEREXTENDED.',
      'What I need to see: Do not trade until this blocker is cleared on the next decision check.',
      'If it clears: Original Trading Plan, nearest target.',
      'Confidence: High (74.24).',
    ].join(' ');
    const merged = mergeHealthBlockedDecisionReply({
      healthReply,
      canonicalBriefText: canonicalBrief,
    });
    assert(merged.includes("I'd sit out for now - my live market data isn't healthy"), 'merged reply should preserve safety block line');
    assert(merged.includes('something is still blocking this setup'), 'merged reply should include blocker reason');
    assert(merged.includes('wait for this blocker to clear first and check again next decision window'), 'merged reply should include normalized unknown-blocker guidance');
    assert(!/stand down until/i.test(merged), 'merged reply should avoid clunky unknown-blocker fallback wording');
    assert(merged.includes('If it clears, lean original Trading Plan, nearest target'), 'merged reply should include lean if cleared');
    assert(merged.includes("for now it's still not ready yet"), 'merged reply should keep blocked-safe confidence wording');
    assert(!/confidence is high/i.test(merged), 'merged reply should avoid strong-go confidence phrasing while blocked');
    assert(!/current vs clear|need \+/i.test(merged), 'merged reply should avoid technical quant-style wording');
    const sentences = merged.split(/(?<=[.?!])\s+/).filter(Boolean);
    assert.strictEqual(sentences.length, 3, 'merged health-block reply should stay compact for earbud final gate');
  }

  {
    const healthReply = "I'd sit out for now - my live market data isn't healthy. I'll re-check automatically; ask again once health is OK.";
    const merged = mergeHealthBlockedDecisionReply({
      healthReply,
      canonicalBriefText: '',
    });
    assert.strictEqual(merged, healthReply, 'health block fallback should remain unchanged when canonical brief is unavailable');
  }

  {
    const briefObject = {
      actionNow: 'Wait for clearance.',
      why: 'Confidence support is below the line right now.',
      whatINeedToSee: 'Confidence support climbs back above the line with cleaner confirmation.',
      ifItClears: 'Original Trading Plan, nearest target.',
      confidence: 'Medium (66.41)',
    };
    const shape = classifyTradingStatusPromptShape('why are we waiting');
    assert.strictEqual(shape, 'why_waiting', 'should classify why-waiting shape');
    const out = buildTradingStatusReplyFromCanonicalBrief({ shape, briefObject });
    assert(out && out.includes("I'd wait for now because"), 'why_waiting should build canonical brief-derived answer');
    assert(out.includes("Let's wait until"), 'why_waiting should include plain guidance');
    assert(out.includes('cleaner confirmation and stronger confidence support'), 'known blocker guidance should remain intact');
    assert(out.includes("If it clears, I'd lean original Trading Plan, nearest target"), 'why_waiting should include lean from canonical brief');
  }

  {
    const briefObject = {
      actionNow: 'Wait for clearance.',
      why: 'Confidence support is below the line right now.',
      whatINeedToSee: 'Confidence support climbs back above the line with cleaner confirmation.',
      ifItClears: 'Original Trading Plan, nearest target.',
      confidence: 'Medium (66.41)',
    };
    const shape = classifyTradingStatusPromptShape('if it clears what is the lean');
    assert.strictEqual(shape, 'lean_if_clears', 'should classify lean-if-clears shape');
    const out = buildTradingStatusReplyFromCanonicalBrief({ shape, briefObject });
    assert(out && out.startsWith("I'd stay patient for now."), 'lean_if_clears should start with compact patience guidance');
    assert(out.includes("If it clears, I'd lean original Trading Plan, nearest target"), 'lean_if_clears should include canonical lean');
  }

  {
    const briefObject = {
      actionNow: 'Wait for clearance.',
      why: 'Confidence support is below the line right now.',
      whatINeedToSee: 'Confidence support climbs back above the line with cleaner confirmation.',
      ifItClears: 'Original Trading Plan, nearest target.',
      confidence: 'Medium (66.41)',
    };
    const shape = classifyTradingStatusPromptShape('do i take it or not');
    assert.strictEqual(shape, 'take_or_not', 'should classify take-or-not shape');
    const out = buildTradingStatusReplyFromCanonicalBrief({ shape, briefObject });
    assert(out && out.startsWith("I'd wait for now."), 'take_or_not should respect action-now truth');
    assert(out.includes("If it clears, I'd lean original Trading Plan, nearest target"), 'take_or_not should include canonical lean');
  }

  {
    const briefObject = {
      actionNow: 'Wait for clearance.',
      why: 'Something is still blocking this setup: RANGE OVEREXTENDED.',
      whatINeedToSee: 'Do not trade until this blocker is cleared on the next decision check.',
      ifItClears: 'Original Trading Plan, nearest target.',
      confidence: 'High (74.24)',
    };
    const shape = classifyTradingStatusPromptShape('why are we waiting');
    const out = buildTradingStatusReplyFromCanonicalBrief({ shape, briefObject });
    assert(out && out.includes('wait for this blocker to clear first and check again next decision window'), 'unknown blocker should use normalized fallback wording');
    assert(out && out.includes("for now it's still not ready yet"), 'blocked status reply should use blocked-safe confidence wording');
    assert(!/stand down until/i.test(out), 'blocked status reply should avoid clunky fallback wording');
    assert(!/confidence is high/i.test(out), 'blocked status reply should avoid strong-go confidence wording');
  }

  {
    const briefObject = {
      actionNow: 'Trade selectively.',
      why: 'Momentum and confirmation are aligned.',
      whatINeedToSee: 'Keep confirmation steady through the entry window.',
      ifItClears: 'Original Trading Plan, skip 1 target.',
      confidence: 'High (78.40)',
    };
    const shape = classifyTradingStatusPromptShape('do i take it or not');
    const out = buildTradingStatusReplyFromCanonicalBrief({ shape, briefObject });
    assert(out && out.startsWith("I'd take it selectively right now."), 'non-blocked reply should remain unchanged');
    assert(out.includes('confidence is high.'), 'non-blocked reply should preserve regular confidence wording');
  }

  {
    const shape = classifyTradingStatusPromptShape('what should i do right now about dinner');
    assert.strictEqual(shape, null, 'non-trading phrase should stay outside status shape mapper');
  }

  console.log('All analyst tool tests passed.');
}

run().catch((err) => {
  console.error(`\nAnalyst tool tests failed: ${err.message}`);
  process.exit(1);
});
