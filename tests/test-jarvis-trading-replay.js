#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  postJson,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 35000;

function buildBody(message, sessionId, auditMock) {
  return {
    message: String(message || ''),
    strategy: 'original',
    activeModule: 'bridge',
    contextHint: 'bridge',
    voiceMode: true,
    voiceBriefMode: 'earbud',
    includeTrace: true,
    sessionId,
    clientId: sessionId,
    auditMock,
  };
}

async function jarvisQuery(baseUrl, body) {
  const out = await postJson(baseUrl, '/api/jarvis/query', body, TIMEOUT_MS);
  assert(out?.success === true, 'jarvis query failed', { body, out });
  return out;
}

function countSentences(text) {
  const src = String(text || '').trim();
  if (!src) return 0;
  return src.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).length;
}

(async () => {
  const server = await startAuditServer({
    useExisting: false,
    env: {
      DEBUG_JARVIS_AUDIT: '1',
      JARVIS_AUDIT_ALLOW_MOCKS: '1',
    },
  });

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  const replayLargeOrbWinMock = {
    healthStatus: 'STALE',
    replay: {
      ok: true,
      data: {
        available: true,
        targetDate: '2026-03-06',
        source: 'db_5m',
        orb: { rangeTicks: 482 },
        replay: {
          wouldTrade: true,
          result: 'win',
          direction: 'long',
          retestTime: '2026-03-06 10:10',
          mfeTicks: 520,
          maeTicks: 710,
        },
      },
      warnings: [],
    },
  };

  const replayValidWinMock = {
    healthStatus: 'STALE',
    replay: {
      ok: true,
      data: {
        available: true,
        targetDate: '2026-03-03',
        source: 'db_5m',
        orb: { rangeTicks: 180 },
        replay: {
          wouldTrade: true,
          result: 'win',
          direction: 'long',
          retestTime: '2026-03-03 10:00',
          mfeTicks: 140,
          maeTicks: 32,
        },
        mechanics: {
          available: true,
          forcedSimulation: false,
          mechanicsVariants: [
            { tpMode: 'Nearest', stopMode: 'rr_1_to_1_from_tp', entryPx: 22100, tpPx: 22125, slPx: 22075, hitOrder: 'tp_first', outcome: 'win', mfe: 128, mae: 30, barsToResolution: 1, warnings: [] },
            { tpMode: 'Skip 1', stopMode: 'rr_1_to_1_from_tp', entryPx: 22100, tpPx: 22150, slPx: 22050, hitOrder: 'sl_first', outcome: 'loss', mfe: 92, mae: 200, barsToResolution: 4, warnings: [] },
            { tpMode: 'Skip 2', stopMode: 'rr_1_to_1_from_tp', entryPx: 22100, tpPx: 22175, slPx: 22025, hitOrder: 'time_close', outcome: 'open', mfe: 130, mae: 220, barsToResolution: null, warnings: [] },
          ],
          originalPlanMechanicsVariant: { tpMode: 'Skip 2', stopMode: 'rr_1_to_1_from_tp', entryPx: 22100, tpPx: 22175, slPx: 22025, hitOrder: 'time_close', outcome: 'open', mfe: 130, mae: 220, barsToResolution: null, warnings: [] },
          bestMechanicsVariant: { tpMode: 'Nearest', stopMode: 'rr_1_to_1_from_tp', entryPx: 22100, tpPx: 22125, slPx: 22075, hitOrder: 'tp_first', outcome: 'win', mfe: 128, mae: 30, barsToResolution: 1, warnings: [] },
          mechanicsComparisonSummary: {
            comparisonAvailable: true,
            forcedSimulation: false,
            summaryLine: 'Nearest resolved best for this replay while original plan mechanics (Skip 2) resolved open.',
            bestTpMode: 'Nearest',
            originalTpMode: 'Skip 2',
            changedVsOriginal: true,
          },
        },
      },
      warnings: [],
    },
  };

  const replayValidLossMock = {
    replay: {
      ok: true,
      data: {
        available: true,
        targetDate: '2026-03-04',
        source: 'db_5m',
        orb: { rangeTicks: 150 },
        replay: {
          wouldTrade: true,
          result: 'loss',
          direction: 'long',
          retestTime: '2026-03-04 09:55',
          mfeTicks: 58,
          maeTicks: 168,
        },
      },
      warnings: [],
    },
  };

  const replayInvalidNoRetestMock = {
    replay: {
      ok: true,
      data: {
        available: true,
        targetDate: '2026-03-05',
        source: 'db_5m',
        orb: { rangeTicks: 140 },
        replay: {
          wouldTrade: false,
          result: 'no_trade',
          noTradeReason: 'no_retest',
        },
      },
      warnings: [],
    },
  };

  const replayInvalidOutsideWindowMock = {
    replay: {
      ok: true,
      data: {
        available: true,
        targetDate: '2026-03-01',
        source: 'db_5m',
        orb: { rangeTicks: 160 },
        replay: {
          wouldTrade: false,
          result: 'no_trade',
          noTradeReason: 'entry_after_max_hour',
        },
      },
      warnings: [],
    },
  };

  const replayMissingMock = {
    replay: {
      ok: false,
      data: {
        available: false,
        targetDate: '2026-03-03',
        source: 'none',
        missingReason: 'insufficient bars for replay',
        replay: {
          wouldTrade: false,
          noTradeReason: 'insufficient_bars_for_replay',
        },
      },
      warnings: ['insufficient bars for replay'],
    },
  };

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'If I would have taken that trade what would my results have been?',
      'replay-proof-route',
      replayLargeOrbWinMock
    ));
    assert(String(out.intent || '') === 'trading_hypothetical', 'intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'selectedSkill mismatch', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'replay routePathTag must be replay-specific', { out });
    assert(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool'), 'toolsUsed must include ReplayTool', { out });
    assert(!Array.isArray(out.toolsUsed) || !out.toolsUsed.includes('RiskTool'), 'replay path must not be decision/risk path', { out });
    assert(/^\s*(I['’]d|I'd)/i.test(String(out.reply || '')), 'earbud replay must start with stance', { out });
    assert(countSentences(out.reply) === 3, 'earbud replay must be 3 sentences', { out });
    const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
    assert(receipt && typeof receipt === 'object', 'missing replay receipt', { out });
    for (const key of ['barsSourceUsed', 'replayDate', 'strategyEligible', 'eligibilityReasons', 'originalPlanEligible', 'originalPlanBlockers', 'originalPlanOutcome', 'overlayEligible', 'overlayBlockers', 'overlayOutcome', 'overlayAssessment', 'blockedByRangeFilter', 'blockedByTimeWindow', 'blockedByRetestRule', 'blockedByDirectionRule', 'blockedByRiskRule', 'marketOutcome', 'strategyOutcome', 'variantAssessment', 'strategyVariantComparison', 'mechanicsVariants', 'originalPlanMechanicsVariant', 'bestMechanicsVariant', 'mechanicsComparisonSummary', 'orbRangeTicks', 'breakDirection', 'retestDetected', 'mfe', 'mae', 'hypotheticalOutcome', 'skipReason', 'warnings']) {
      assert(Object.prototype.hasOwnProperty.call(receipt, key), `replay receipt missing field: ${key}`, { receipt, out });
    }
    assert(Array.isArray(receipt.mechanicsVariants), 'mechanicsVariants must be an array', { receipt, out });
    assert(receipt.marketOutcome === 'win', 'marketOutcome should reflect raw market win', { receipt, out });
    assert(receipt.originalPlanEligible === true, 'original plan should stay eligible when only overlay filters fail', { receipt, out });
    assert(receipt.originalPlanOutcome === 'win', 'original plan outcome should reflect original replay outcome', { receipt, out });
    assert(receipt.overlayEligible === false, 'overlay should downgrade oversized ORB replay', { receipt, out });
    assert(receipt.overlayOutcome === 'no_trade', 'overlay outcome should be no_trade when overlay blocks', { receipt, out });
    assert(receipt.strategyEligible === true, 'legacy strategyEligible alias should mirror original-plan eligibility', { receipt, out });
    assert(receipt.strategyOutcome === 'win', 'legacy strategyOutcome alias should mirror original-plan outcome', { receipt, out });
    assert(receipt.variantAssessment && typeof receipt.variantAssessment === 'object', 'variantAssessment must be present', { receipt, out });
    assert(receipt.strategyVariantComparison && typeof receipt.strategyVariantComparison === 'object', 'strategyVariantComparison must be present', { receipt, out });
    assert(receipt.blockedByRangeFilter === true, 'large ORB should set blockedByRangeFilter', { receipt, out });
    assert(/valid under your original trading plan|learned overlay downgrade/i.test(String(out.reply || '')), 'reply must distinguish original plan from overlay downgrade', { out, receipt });
    pass('replay uses replay route + replay receipt schema');
  } catch (err) {
    fail('replay uses replay route + replay receipt schema', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'replay today for me',
      'replay-proof-degraded-health',
      replayValidWinMock
    ));
    assert(String(out.routePathTag || out.routePath || '') === 'runJarvisTradingReplayTool.execute', 'replay should execute from persisted bars even if live health degraded', { out });
    const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
    assert(String(receipt?.barsSourceUsed || '') === 'db_5m', 'expected persisted bar source for replay', { out, receipt });
    assert(receipt.originalPlanEligible === true, 'valid replay should be original-plan eligible', { out, receipt });
    assert(receipt.overlayEligible === true, 'valid replay should remain overlay eligible', { out, receipt });
    assert(receipt.originalPlanOutcome === 'win', 'valid replay should keep original-plan win outcome', { out, receipt });
    assert(Array.isArray(receipt.mechanicsVariants) && receipt.mechanicsVariants.length === 3, 'valid replay should expose mechanics variants', { out, receipt });
    assert(receipt.bestMechanicsVariant && receipt.bestMechanicsVariant.tpMode === 'Nearest', 'best mechanics variant missing from receipt', { out, receipt });
    assert(/compare exits|mechanics/i.test(String(out.reply || '')), 'earbud replay should mention mechanics comparison when available', { out, receipt });
    pass('replay executes from persisted bars with degraded live health');
  } catch (err) {
    fail('replay executes from persisted bars with degraded live health', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'replay this session',
      'replay-proof-valid-loss',
      replayValidLossMock
    ));
    const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
    assert(receipt?.originalPlanEligible === true, 'valid-loss replay should remain original-plan eligible', { out, receipt });
    assert(String(receipt?.originalPlanOutcome || '') === 'loss', 'valid-loss replay should keep loss outcome', { out, receipt });
    pass('clean valid replay loss remains eligible and reports loss');
  } catch (err) {
    fail('clean valid replay loss remains eligible and reports loss', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'replay no retest case',
      'replay-proof-no-retest',
      replayInvalidNoRetestMock
    ));
    const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
    assert(receipt?.originalPlanEligible === false, 'no-retest replay should be ineligible', { out, receipt });
    assert(receipt?.blockedByRetestRule === true, 'no-retest replay should set retest blocker', { out, receipt });
    assert(receipt?.mechanicsComparisonSummary?.comparisonAvailable === false, 'ineligible replay should not treat mechanics variants as official', { out, receipt });
    pass('invalid replay with no retest is blocked by retest rule');
  } catch (err) {
    fail('invalid replay with no retest is blocked by retest rule', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'replay outside entry window case',
      'replay-proof-time-window',
      replayInvalidOutsideWindowMock
    ));
    const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
    assert(receipt?.originalPlanEligible === false, 'entry-after-hour replay should be ineligible', { out, receipt });
    assert(receipt?.blockedByTimeWindow === true, 'entry-after-hour replay should set time window blocker', { out, receipt });
    assert(receipt?.mechanicsComparisonSummary?.comparisonAvailable === false, 'time-window ineligible replay should not expose official mechanics comparison', { out, receipt });
    pass('invalid replay outside entry window is blocked by time-window rule');
  } catch (err) {
    fail('invalid replay outside entry window is blocked by time-window rule', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'replay that session',
      'replay-proof-missing',
      replayMissingMock
    ));
    assert(String(out.routePathTag || out.routePath || '') === 'runJarvisTradingReplayTool.data_missing', 'missing data should route to replay data_missing path', { out });
    assert(/replay|bars|compute|missing/i.test(String(out.reply || '')), 'missing data reply should explain replay data issue', { out });
    const receipt = Array.isArray(out.toolReceipts) ? out.toolReceipts[0] : null;
    assert(receipt?.executed === false, 'missing data replay should not be marked executed', { out, receipt });
    pass('replay fails safely with explicit missing-data reason');
  } catch (err) {
    fail('replay fails safely with explicit missing-data reason', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'was I right not trading?',
      'replay-proof-review',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'review phrase intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'review phrase should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'review phrase must route to replay path', { out });
    assert(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool'), 'review phrase must use ReplayTool', { out });
    pass('review phrase routes to replay/review logic');
  } catch (err) {
    fail('review phrase routes to replay/review logic', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      "did today's setup lose",
      'replay-proof-direct-result-loss',
      replayValidLossMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'direct result loss intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'direct result loss should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'direct result loss must route to replay path', { out });
    assert(/setup (?:lost|as a loss)/i.test(String(out.reply || '')), 'direct result loss reply should state setup lost', { out });
    pass('direct result prompt (loss) routes to replay and returns compact outcome');
  } catch (err) {
    fail('direct result prompt (loss) routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'would my setup have worked today',
      'replay-proof-direct-result-win',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'direct result win intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'direct result win should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'direct result win must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'direct result win reply should state setup won', { out });
    pass('direct result prompt (worked today) routes to replay and returns compact outcome');
  } catch (err) {
    fail('direct result prompt (worked today) routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did my setup lose today',
      'replay-proof-direct-result-my-setup-loss',
      replayValidLossMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did my setup lose today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did my setup lose today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did my setup lose today must route to replay path', { out });
    assert(/setup (?:lost|as a loss)/i.test(String(out.reply || '')), 'did my setup lose today should answer from persisted replay truth', { out });
    pass('did my setup lose today routes to replay and returns compact outcome');
  } catch (err) {
    fail('did my setup lose today routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did my setup win today',
      'replay-proof-direct-result-my-setup-win',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did my setup win today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did my setup win today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did my setup win today must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'did my setup win today should still answer from persisted replay truth', { out });
    pass('did my setup win today succeeds even with stale health context');
  } catch (err) {
    fail('did my setup win today succeeds even with stale health context', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did we win today',
      'replay-proof-direct-result-we-win',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did we win today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did we win today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did we win today must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'did we win today should answer from persisted replay truth', { out });
    pass('did we win today routes to replay and returns compact outcome');
  } catch (err) {
    fail('did we win today routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did we lose today',
      'replay-proof-direct-result-we-lose',
      replayValidLossMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did we lose today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did we lose today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did we lose today must route to replay path', { out });
    assert(/setup (?:lost|as a loss)/i.test(String(out.reply || '')), 'did we lose today should answer from persisted replay truth', { out });
    pass('did we lose today routes to replay and returns compact outcome');
  } catch (err) {
    fail('did we lose today routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did we make money today',
      'replay-proof-direct-result-we-make-money',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did we make money today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did we make money today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did we make money today must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'did we make money today should answer from persisted replay truth', { out });
    pass('did we make money today routes to replay and returns compact outcome');
  } catch (err) {
    fail('did we make money today routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'how did we do today',
      'replay-proof-direct-result-how-did-we-do',
      replayInvalidNoRetestMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'how did we do today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'how did we do today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'how did we do today must route to replay path', { out });
    assert(/no-trade under your plan|setup (won|lost|finished)/i.test(String(out.reply || '')), 'how did we do today should return compact trading result', { out });
    pass('how did we do today routes to replay and returns compact outcome');
  } catch (err) {
    fail('how did we do today routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did today win',
      'replay-proof-direct-result-did-today-win',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did today win intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did today win should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did today win must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'did today win should answer from persisted replay truth', { out });
    pass('did today win routes to replay and returns compact outcome');
  } catch (err) {
    fail('did today win routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did today lose',
      'replay-proof-direct-result-did-today-lose',
      replayValidLossMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did today lose intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did today lose should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did today lose must route to replay path', { out });
    assert(/setup (?:lost|as a loss)/i.test(String(out.reply || '')), 'did today lose should answer from persisted replay truth', { out });
    pass('did today lose routes to replay and returns compact outcome');
  } catch (err) {
    fail('did today lose routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did today work',
      'replay-proof-direct-result-did-today-work',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did today work intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did today work should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did today work must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'did today work should answer from persisted replay truth', { out });
    pass('did today work routes to replay and returns compact outcome');
  } catch (err) {
    fail('did today work routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'was today a winner',
      'replay-proof-direct-result-was-today-a-winner',
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'was today a winner intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'was today a winner should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'was today a winner must route to replay path', { out });
    assert(/setup (?:won|as a win)/i.test(String(out.reply || '')), 'was today a winner should answer from persisted replay truth', { out });
    pass('was today a winner routes to replay and returns compact outcome');
  } catch (err) {
    fail('was today a winner routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      "why didn't my setup work today",
      'replay-proof-postmortem-why-work',
      replayInvalidNoRetestMock
    ));
    assert(String(out.intent || '') === 'trading_review', "why didn't my setup work today intent mismatch", { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', "why didn't my setup work today should select TradingReplay", { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), "why didn't my setup work today must route to replay path", { out });
    assert(/no-trade|blocked under your original trading plan|original-plan blocker/i.test(String(out.reply || '')), "why didn't my setup work today should explain replay/postmortem truth", { out });
    assert(!/outside your entry window|wait until cleaner confirmation|if it clears/i.test(String(out.reply || '')), "why didn't my setup work today must not return live execution wording", { out });
    pass("why didn't my setup work today routes to replay postmortem path");
  } catch (err) {
    fail("why didn't my setup work today routes to replay postmortem path", err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      "why didn't it work",
      'replay-proof-postmortem-generic-why-work',
      replayInvalidNoRetestMock
    ));
    assert(String(out.intent || '') === 'trading_review', "why didn't it work intent mismatch", { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', "why didn't it work should select TradingReplay", { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), "why didn't it work must route to replay path", { out });
    assert(/no-trade|blocked under your original trading plan|original-plan blocker/i.test(String(out.reply || '')), "why didn't it work should explain replay/postmortem truth", { out });
    pass("why didn't it work routes to replay postmortem path");
  } catch (err) {
    fail("why didn't it work routes to replay postmortem path", err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'why did my setup fail today',
      'replay-proof-postmortem-why-fail',
      replayValidLossMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'why did my setup fail today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'why did my setup fail today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'why did my setup fail today must route to replay path', { out });
    assert(/loss|blocked|no-trade|original-plan/i.test(String(out.reply || '')), 'why did my setup fail today should explain outcome from replay truth', { out });
    pass('why did my setup fail today routes to replay postmortem path');
  } catch (err) {
    fail('why did my setup fail today routes to replay postmortem path', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'why was today a no-trade',
      'replay-proof-postmortem-no-trade',
      replayInvalidNoRetestMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'why was today a no-trade intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'why was today a no-trade should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'why was today a no-trade must route to replay path', { out });
    assert(/no-trade|blocked under your original trading plan|original-plan blocker/i.test(String(out.reply || '')), 'why was today a no-trade should explain no-trade reason', { out });
    pass('why was today a no-trade routes to replay postmortem path');
  } catch (err) {
    fail('why was today a no-trade routes to replay postmortem path', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'how did jarvis do today',
      'replay-proof-direct-result-jarvis',
      replayInvalidNoRetestMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'how did jarvis do today intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'how did jarvis do today should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'how did jarvis do today must route to replay path', { out });
    assert(/no-trade under your plan|setup (won|lost|finished)/i.test(String(out.reply || '')), 'how did jarvis do today reply should return compact trading result', { out });
    pass('direct result prompt (how did jarvis do today) routes to replay and returns compact outcome');
  } catch (err) {
    fail('direct result prompt (how did jarvis do today) routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did jarvis get today right',
      'replay-proof-direct-result-jarvis-right',
      replayInvalidNoRetestMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'did jarvis get today right intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'did jarvis get today right should select TradingReplay', { out });
    assert(String(out.routePathTag || out.routePath || '').startsWith('runJarvisTradingReplayTool.'), 'did jarvis get today right must route to replay path', { out });
    assert(/jarvis|setup|no-trade|won|lost|blocked under your original trading plan/i.test(String(out.reply || '')), 'did jarvis get today right should return compact trading-review result', { out });
    pass('did jarvis get today right routes to replay and returns compact outcome');
  } catch (err) {
    fail('did jarvis get today right routes to replay and returns compact outcome', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      "did today's setup lose",
      'replay-proof-direct-result-missing-truth',
      replayMissingMock
    ));
    assert(String(out.intent || '') === 'trading_review', 'missing truth direct result intent mismatch', { out });
    assert(String(out.selectedSkill || '') === 'TradingReplay', 'missing truth direct result should still select TradingReplay', { out });
    assert(/can't confirm|hold .*setup result/i.test(String(out.reply || '')), 'missing replay truth should return sensible fallback', { out });
    pass('direct result prompt falls back safely when persisted truth is unavailable');
  } catch (err) {
    fail('direct result prompt falls back safely when persisted truth is unavailable', err);
  }

  try {
    const execSessionId = `replay-proof-live-execution-still-safety-gated-${Date.now().toString(36)}`;
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'enter now',
      execSessionId,
      replayValidWinMock
    ));
    assert(String(out.intent || '') === 'trading_execution_request', 'execution phrase intent mismatch', { out });
    assert(out.confirmationState?.required === true || out.consentPending === true, 'execution phrase must remain confirmation-gated', { out });
    assert(String(out.routePathTag || out.routePath || '') === 'jarvis_orchestrator.trading_decision.confirm_gate', 'execution phrase should stay on execution safety gate', { out });
    assert(!(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool')), 'execution phrase should not run replay path', { out });
    pass('live execution request remains safety-gated and does not use review replay path');
  } catch (err) {
    fail('live execution request remains safety-gated and does not use review replay path', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'tell me a joke',
      'replay-proof-direct-result-non-trading-control',
      replayValidWinMock
    ));
    assert(String(out.selectedSkill || '') !== 'TradingReplay', 'non-trading control should not select TradingReplay', { out });
    assert(!(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool')), 'non-trading control should not use ReplayTool', { out });
    pass('non-trading control stays outside replay trading-result path');
  } catch (err) {
    fail('non-trading control stays outside replay trading-result path', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'how did we do with website traffic today',
      'replay-proof-direct-result-non-trading-how-did-we-do-control',
      replayValidWinMock
    ));
    assert(String(out.intent || '') !== 'trading_review', 'non-trading how did we do control should not route to trading_review', { out });
    assert(String(out.selectedSkill || '') !== 'TradingReplay', 'non-trading how did we do control should not select TradingReplay', { out });
    assert(!(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool')), 'non-trading how did we do control should not use ReplayTool', { out });
    pass('non-trading how did we do control stays outside replay trading-result path');
  } catch (err) {
    fail('non-trading how did we do control stays outside replay trading-result path', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did we win today with website traffic',
      'replay-proof-direct-result-non-trading-website-traffic-win-control',
      replayValidWinMock
    ));
    assert(String(out.intent || '') !== 'trading_review', 'non-trading website traffic win control should not route to trading_review', { out });
    assert(String(out.selectedSkill || '') !== 'TradingReplay', 'non-trading website traffic win control should not select TradingReplay', { out });
    assert(!(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool')), 'non-trading website traffic win control should not use ReplayTool', { out });
    pass('non-trading website traffic win control stays outside replay trading-result path');
  } catch (err) {
    fail('non-trading website traffic win control stays outside replay trading-result path', err);
  }

  try {
    const out = await jarvisQuery(server.baseUrl, buildBody(
      'did today win in football',
      'replay-proof-direct-result-non-trading-sports-win-control',
      replayValidWinMock
    ));
    assert(String(out.intent || '') !== 'trading_review', 'non-trading sports win control should not route to trading_review', { out });
    assert(String(out.selectedSkill || '') !== 'TradingReplay', 'non-trading sports win control should not select TradingReplay', { out });
    assert(!(Array.isArray(out.toolsUsed) && out.toolsUsed.includes('ReplayTool')), 'non-trading sports win control should not use ReplayTool', { out });
    pass('non-trading sports win control stays outside replay trading-result path');
  } catch (err) {
    fail('non-trading sports win control stays outside replay trading-result path', err);
  }

  await server.stop();

  if (failures > 0) {
    console.error(`\nJarvis trading replay tests failed with ${failures} case(s).`);
    process.exit(1);
  }
  console.log('\nJarvis trading replay tests passed.');
})();
