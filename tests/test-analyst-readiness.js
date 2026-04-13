#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  evaluateMarketDataFreshnessGate,
  buildFreshDataUnavailableReply,
  buildTrendRegimeReply,
} = require('../server/analyst-readiness');
const { buildEarbudCoachBrief } = require('../server/earbud-brief');

function run(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

function assertEarbudCoachConstraints(reply, opts = {}) {
  const positionMode = opts.positionMode === true;
  if (positionMode) {
    assert.ok(/^(?:We're in a position here|You['’]re currently (?:long|short))\b/i.test(reply), 'Position mode should start with current-position stance');
  } else {
    assert.ok(/^I['’]d\b/.test(reply), 'Earbud brief must start with "I\'d"');
  }
  const sentenceCount = (String(reply || '').match(/[.!?](?=\s|$)/g) || []).length;
  assert.ok(sentenceCount <= 3, `Earbud brief must be <= 3 sentences (got ${sentenceCount})`);
  assert.ok(String(reply || '').length <= 420, 'Earbud brief must be <= 420 chars');
  assert.ok(!/\bDON['’]?T TRADE\b/i.test(reply), 'Must not include DON\'T TRADE label');
  assert.ok(!/^WAIT[.!:\s]/i.test(reply) && !/\bWAIT:\s*/i.test(reply), 'Must not include WAIT label');
  assert.ok(!/\bTRADE\b/i.test(reply), 'Must not include TRADE label');
  assert.ok(!/\[[^\]]+\]/.test(reply), 'Must not include bracket verdict labels');
  assert.ok(!/%/.test(reply), 'Must not include percentages');
  assert.ok(!/\b(score|win rate|setup quality|confidence)\b/i.test(reply), 'Must not include score/confidence/win-rate terms');
  assert.ok(!/which keeps risk controlled|with disciplined timing and one clean confirmation|so execution stays selective instead of reactive|while protecting capital until structure confirms/i.test(reply), 'Must not include filler padding phrases');
  const parts = String(reply || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length >= 2) {
    assert.ok(/^Let['’]s\b/i.test(parts[1]), 'Sentence 2 should start with "Let\'s"');
    if (!positionMode) {
      assert.ok(/^Let['’]s\s+(?:see|focus)\b/i.test(parts[1]), 'Sentence 2 should start with "Let\'s see" or "Let\'s focus"');
      assert.ok(!/^Let['’]s\s+wait\b/i.test(parts[1]), 'Sentence 2 should not start with "Let\'s wait"');
    }
  }
  if (parts.length >= 3) assert.ok(/^If\b/i.test(parts[2]), 'Sentence 3 should start with "If"');
  if (!positionMode) assert.ok(/\b(9:45|10:15|orb)\b/i.test(reply), 'Must include at least one time/ORB anchor');
}

function extractSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
}

run('stale/no-bars gate blocks ORB claims', () => {
  const readiness = evaluateMarketDataFreshnessGate({
    nowEt: { date: '2026-03-03', time: '10:10' },
    marketDataFreshness: {
      hasTodaySessionBars: false,
      hasORBComplete: false,
      sessionDateOfData: '2026-03-02',
      minutesSinceLastCandle: 40,
      staleThresholdMinutes: 5,
    },
    lastPrice: 0,
    staleThresholdMinutes: 5,
  });
  assert.strictEqual(readiness.needsFreshData, true);
  const reply = buildFreshDataUnavailableReply({
    readiness,
    lastUpdateText: '10:02 AM ET on 2026-03-02',
  });
  assert.ok(/don't have fresh mnq session data/i.test(reply));
  assert.ok(!/opening range is/i.test(reply));
});

run('pre-9:45 guidance explicitly says ORB is not complete', () => {
  const readiness = evaluateMarketDataFreshnessGate({
    nowEt: { date: '2026-03-03', time: '09:41' },
    marketDataFreshness: {
      hasTodaySessionBars: true,
      hasORBComplete: false,
      sessionDateOfData: '2026-03-03',
      minutesSinceLastCandle: 1,
      staleThresholdMinutes: 5,
    },
    lastPrice: 24910.5,
    staleThresholdMinutes: 5,
  });
  assert.strictEqual(readiness.needsFreshData, false);
  assert.strictEqual(readiness.orbPre945, true);
  const reply = buildTrendRegimeReply({
    readiness,
    decision: { orbRangeTicks: 150 },
    pattern: {
      patternLabel: 'balance',
      volatilityRegime: 'normal',
      momentumLabel: 'neutral',
      trendTicks30: 6,
    },
    lastUpdateText: '09:40 AM ET',
  });
  assert.ok(/not complete until 9:45 et/i.test(reply));
});

run('fresh live-bars readiness avoids stale-data warning copy', () => {
  const readiness = evaluateMarketDataFreshnessGate({
    nowEt: { date: '2026-03-03', time: '09:52' },
    marketDataFreshness: {
      hasTodaySessionBars: true,
      hasORBComplete: true,
      sessionDateOfData: '2026-03-03',
      minutesSinceLastCandle: 1,
      staleThresholdMinutes: 5,
    },
    lastPrice: 24410.75,
    staleThresholdMinutes: 5,
  });
  assert.strictEqual(readiness.needsFreshData, false);
  const reply = buildTrendRegimeReply({
    readiness,
    decision: { orbRangeTicks: 168 },
    pattern: {
      patternLabel: 'bullish_continuation',
      volatilityRegime: 'normal',
      momentumLabel: 'bullish',
      trendTicks30: 36,
    },
    lastUpdateText: '09:51 AM ET',
  });
  assert.ok(!/don't have fresh mnq session data/i.test(reply));
  assert.ok(/Trend:/i.test(reply));
  assert.ok(/Regime:/i.test(reply));
});

run('earbud brief: OR too big -> sit out + trigger + single condition', () => {
  const reply = buildEarbudCoachBrief({
    replyText: [
      'Right now the better move is to wait for cleaner structure.',
      'The first 15-minute opening range is 635 ticks, which is historically overextended and prone to fakeouts.',
      'Main blockers right now: Range too wide for safe entries, Chance of green day is below threshold.',
      'Primary setup focus: First-Hour Momentum 10:15.',
    ].join(' '),
    decision: {
      signal: 'WAIT',
      orbRangeTicks: 635,
      blockers: ['RANGE_OVEREXTENDED', 'SETUP_QUALITY_BELOW_50'],
    },
    marketDataFreshness: {
      hasTodaySessionBars: true,
      hasORBComplete: true,
    },
    nowEtTime: '09:32',
  });
  assertEarbudCoachConstraints(reply);
  const parts = extractSentences(reply);
  assert.ok(/too big|overextended|fakeout risk/i.test(reply), 'Should mention large-range blocker');
  assert.ok(/see how the 9:45 ORB prints/i.test(parts[1] || ''), 'Before 9:45, sentence 2 should anchor to 9:45 ORB first with active phrasing');
  assert.ok(/220 ticks/i.test(reply), 'Should include one condition using 220-tick compression');
});

run('earbud brief: OR in range/tradable -> selective engage language', () => {
  const reply = buildEarbudCoachBrief({
    replyText: [
      'Conditions look tradable, but only if your trigger confirms cleanly.',
      'The first 15-minute opening range is 150 ticks, inside your strongest historical zone.',
      'Best current setup: First-Hour Momentum 10:15.',
    ].join(' '),
    decision: {
      signal: 'GO',
      orbRangeTicks: 150,
      blockers: [],
    },
    marketDataFreshness: {
      hasTodaySessionBars: true,
      hasORBComplete: true,
    },
    nowEtTime: '09:58',
  });
  assertEarbudCoachConstraints(reply);
  const parts = extractSentences(reply);
  assert.ok(/\bengage\b/i.test(reply), 'Should use engage wording for tradable case');
  assert.ok(/10:15 momentum checkpoint/i.test(parts[1] || ''), 'Between 9:45 and 10:15, sentence 2 should focus on 10:15 checkpoint');
});

run('earbud brief: stale data after 10:15 -> momentum leg wording + data-sync condition', () => {
  const reply = buildEarbudCoachBrief({
    replyText: "I don't have fresh MNQ session data for today yet.",
    decision: {
      signal: 'WAIT',
      blockers: ['STALE_SESSION_DATA'],
    },
    marketDataFreshness: {
      hasTodaySessionBars: false,
      hasORBComplete: false,
    },
    nowEtTime: '10:32',
  });
  assertEarbudCoachConstraints(reply);
  const parts = extractSentences(reply);
  assert.ok(/don't have fresh mnq bars yet/i.test(reply), 'Should use stale-data stance');
  assert.ok(/next momentum leg/i.test(parts[1] || ''), 'After 10:15, sentence 2 should focus on next momentum leg');
  assert.ok(/retest quality/i.test(parts[1] || ''), 'After 10:15, sentence 2 should mention retest quality');
  assert.ok(!/wait for|after 9:45|10:15 momentum checkpoint/i.test(parts[1] || ''), 'After 10:15, sentence 2 should avoid future-time wording');
  assert.ok(/^If data sync is live/i.test(parts[2] || ''), 'Stale-data condition should begin with "If data sync is live"');
});

run('earbud brief: outside entry window blocker -> entry-window condition', () => {
  const reply = buildEarbudCoachBrief({
    replyText: 'Right now the better move is to stand down. Main blockers right now: Outside your primary entry window.',
    decision: {
      signal: 'WAIT',
      orbRangeTicks: 180,
      blockers: ['ENTRY_WINDOW_CLOSED'],
    },
    marketDataFreshness: {
      hasTodaySessionBars: true,
      hasORBComplete: true,
    },
    nowEtTime: '10:40',
  });
  assertEarbudCoachConstraints(reply);
  const parts = extractSentences(reply);
  assert.ok(/^If we're inside the entry window and get/i.test(parts[2] || ''), 'Outside-entry-window condition should reflect entry-window recovery');
});

run('earbud brief: in-position long switches to trade management guidance', () => {
  const reply = buildEarbudCoachBrief({
    replyText: 'Best current setup: First-Hour Momentum 10:15. Main blockers right now: none.',
    nowEtTime: '09:50',
    positionState: {
      hasOpenPosition: true,
      side: 'long',
      qty: 1,
      unrealizedPnl: 85,
      volatilityExpanding: false,
    },
  });
  assertEarbudCoachConstraints(reply, { positionMode: true });
  const parts = extractSentences(reply);
  assert.ok(/currently long|position/i.test(parts[0] || ''), 'Sentence 1 should reference current position');
  assert.ok(!/setup|10:15|9:45|checkpoint|best current/i.test(reply), 'Position mode should not include setup guidance language');
  assert.ok(/^If\b/.test(parts[2] || ''), 'Sentence 3 should start with If');
});

run('earbud brief: in-position short + expanding volatility uses risk-tight directive', () => {
  const reply = buildEarbudCoachBrief({
    replyText: 'volatility is high and expanding',
    nowEtTime: '10:34',
    positionState: {
      hasOpenPosition: true,
      side: 'short',
      qty: 1,
      unrealizedPnl: -22,
      volatilityExpanding: true,
    },
  });
  assertEarbudCoachConstraints(reply, { positionMode: true });
  const parts = extractSentences(reply);
  assert.ok(/currently short|position/i.test(parts[0] || ''), 'Sentence 1 should reference short position');
  assert.ok(/reduce size if momentum stalls/i.test(parts[1] || ''), 'Sentence 2 should give volatility-expansion management directive');
  assert.ok(/^If\b/.test(parts[2] || ''), 'Sentence 3 should start with If');
  assert.ok(!/setup|10:15|9:45|checkpoint/i.test(reply), 'Position mode should avoid setup suggestions');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('All analyst readiness tests passed.');
