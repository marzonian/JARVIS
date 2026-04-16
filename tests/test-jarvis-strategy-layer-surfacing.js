#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 180000;

async function getJson(baseUrl, endpoint, timeoutMs = TIMEOUT_MS) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getRaw(baseUrl, endpoint, timeoutMs = TIMEOUT_MS) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = { raw: text };
  }
  return {
    status: resp.status,
    ok: resp.ok,
    json,
  };
}

function assertStrategySnapshotShape(label, snapshot) {
  assert(snapshot && typeof snapshot === 'object', `${label} strategyLayerSnapshot missing`, { snapshot });
  assert(snapshot.originalPlan && typeof snapshot.originalPlan === 'object', `${label} originalPlan missing`, { snapshot });
  assert(snapshot.bestVariant && typeof snapshot.bestVariant === 'object', `${label} bestVariant missing`, { snapshot });
  assert(snapshot.bestAlternative && typeof snapshot.bestAlternative === 'object', `${label} bestAlternative missing`, { snapshot });
  assert(snapshot.recommendationBasis && typeof snapshot.recommendationBasis === 'object', `${label} recommendationBasis missing`, { snapshot });
  assert(snapshot.assistantDecisionBrief && typeof snapshot.assistantDecisionBrief === 'object', `${label} assistantDecisionBrief missing`, { snapshot });
  assert(typeof snapshot.executionStance === 'string' && snapshot.executionStance.length > 0, `${label} executionStance missing`, { snapshot });
  assert(Array.isArray(snapshot.strategyStack), `${label} strategyStack missing`, { snapshot });
  assert(snapshot.strategyStack.length >= 1, `${label} strategyStack empty`, { snapshot });
  assert(snapshot.strategyStackCard && typeof snapshot.strategyStackCard === 'object', `${label} strategyStackCard missing`, { snapshot });
  assert(snapshot.strategyWhyRecommended && typeof snapshot.strategyWhyRecommended === 'object', `${label} strategyWhyRecommended missing`, { snapshot });
  assert(typeof snapshot.strategyRecommendationLine === 'string' && snapshot.strategyRecommendationLine.length > 0, `${label} strategyRecommendationLine missing`, { snapshot });
  assert(typeof snapshot.strategyStanceLine === 'string' && snapshot.strategyStanceLine.length > 0, `${label} strategyStanceLine missing`, { snapshot });
  assert(typeof snapshot.strategyVoiceLine === 'string' && snapshot.strategyVoiceLine.length > 0, `${label} strategyVoiceLine missing`, { snapshot });
  assert(snapshot.strategyComparisonReadout && typeof snapshot.strategyComparisonReadout === 'object', `${label} strategyComparisonReadout missing`, { snapshot });
  assert(typeof snapshot.strategyComparisonLine === 'string' && snapshot.strategyComparisonLine.length > 0, `${label} strategyComparisonLine missing`, { snapshot });
  assert(typeof snapshot.strategyComparisonVoiceLine === 'string' && snapshot.strategyComparisonVoiceLine.length > 0, `${label} strategyComparisonVoiceLine missing`, { snapshot });
  assert(snapshot.opportunityScoring && typeof snapshot.opportunityScoring === 'object', `${label} opportunityScoring missing`, { snapshot });
  assert(typeof snapshot.opportunityScoreSummaryLine === 'string' && snapshot.opportunityScoreSummaryLine.length > 0, `${label} opportunityScoreSummaryLine missing`, { snapshot });
  assert(snapshot.heuristicVsOpportunityComparison && typeof snapshot.heuristicVsOpportunityComparison === 'object', `${label} heuristicVsOpportunityComparison missing`, { snapshot });
  assert(snapshot.todayRecommendationMirror && typeof snapshot.todayRecommendationMirror === 'object', `${label} todayRecommendationMirror missing`, { snapshot });
  assert(snapshot.decisionBoardMirror && typeof snapshot.decisionBoardMirror === 'object', `${label} decisionBoardMirror missing`, { snapshot });

  for (const row of snapshot.strategyStack) {
    assert(typeof row.available === 'boolean', `${label} strategy stack row missing available flag`, { row });
    assert(row.pineAccess && typeof row.pineAccess === 'object', `${label} strategy stack row pineAccess missing`, { row });
    assert(typeof row.pineAccess.endpoint === 'string' && row.pineAccess.endpoint.startsWith('/api/jarvis/strategy/pine?'), `${label} pineAccess endpoint missing`, { row });
    assert(String(row.pineAccess.format || '').toLowerCase() === 'pine_v6', `${label} pineAccess format must be pine_v6`, { row });
  }

  const cards = Array.isArray(snapshot?.strategyStackCard?.cards) ? snapshot.strategyStackCard.cards : [];
  assert(cards.length === 3, `${label} strategyStackCard.cards should expose original/variant/alternative`, { cards });
  for (const card of cards) {
    assert(typeof card.title === 'string' && card.title.length > 0, `${label} strategy card title missing`, { card });
    assert(typeof card.key === 'string' && card.key.length > 0, `${label} strategy card key missing`, { card });
    assert(typeof card.layer === 'string' && card.layer.length > 0, `${label} strategy card layer missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'suitability'), `${label} strategy card suitability missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'score'), `${label} strategy card score missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'winRate'), `${label} strategy card winRate missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'profitFactor'), `${label} strategy card profitFactor missing`, { card });
    assert(Object.prototype.hasOwnProperty.call(card, 'maxDrawdownDollars'), `${label} strategy card maxDrawdownDollars missing`, { card });
    assert(typeof card.recommendationStatus === 'string' && card.recommendationStatus.length > 0, `${label} strategy card recommendationStatus missing`, { card });
    assert(card.pineAccess && typeof card.pineAccess === 'object', `${label} strategy card pineAccess missing`, { card });
    assert(typeof card.pineAccess.endpoint === 'string' && card.pineAccess.endpoint.startsWith('/api/jarvis/strategy/pine?'), `${label} strategy card pineAccess endpoint missing`, { card });
    assert(String(card.pineAccess.format || '').toLowerCase() === 'pine_v6', `${label} strategy card pineAccess format invalid`, { card });
    assert(card.pineContractRef === card.pineAccess.endpoint, `${label} strategy card pine contract ref mismatch`, { card });
  }

  const comparisonRows = Array.isArray(snapshot?.strategyComparisonReadout?.comparisonRows)
    ? snapshot.strategyComparisonReadout.comparisonRows
    : [];
  assert(comparisonRows.length >= 3, `${label} strategy comparison rows missing`, { comparisonRows });
  const recommendedRows = comparisonRows.filter((row) => row?.isRecommended === true);
  assert(recommendedRows.length === 1, `${label} strategy comparison should mark exactly one recommended row`, { comparisonRows });
  for (const row of comparisonRows) {
    assert(typeof row.key === 'string' && row.key.length > 0, `${label} strategy comparison row key missing`, { row });
    assert(typeof row.name === 'string' && row.name.length > 0, `${label} strategy comparison row name missing`, { row });
    assert(typeof row.layer === 'string' && row.layer.length > 0, `${label} strategy comparison row layer missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'winRate'), `${label} strategy comparison row winRate missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'profitFactor'), `${label} strategy comparison row profitFactor missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'maxDrawdownDollars'), `${label} strategy comparison row maxDrawdownDollars missing`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'suitability') || Object.prototype.hasOwnProperty.call(row, 'score'), `${label} strategy comparison row score/suitability missing`, { row });
    assert(typeof row.whyChosenOrNot === 'string' && row.whyChosenOrNot.length > 0, `${label} strategy comparison row whyChosenOrNot missing`, { row });
    assert(typeof row.tradeoffLine === 'string' && row.tradeoffLine.length > 0, `${label} strategy comparison row tradeoffLine missing`, { row });
  }
  const nonRecommendedRows = comparisonRows.filter((row) => row?.isRecommended !== true);
  assert(nonRecommendedRows.every((row) => typeof row.whyChosenOrNot === 'string' && row.whyChosenOrNot.length > 0), `${label} non-recommended rows should include whyChosenOrNot`, { nonRecommendedRows });

  const opportunityRows = Array.isArray(snapshot?.opportunityScoring?.comparisonRows)
    ? snapshot.opportunityScoring.comparisonRows
    : [];
  assert(opportunityRows.length >= 1, `${label} opportunity scoring rows missing`, { opportunityRows });
  for (const row of opportunityRows) {
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityWinProb'), `${label} opportunity row missing win prob`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityExpectedValue'), `${label} opportunity row missing EV`, { row });
    assert(typeof row.opportunityCalibrationBand === 'string' && row.opportunityCalibrationBand.length > 0, `${label} opportunity row missing calibration band`, { row });
    assert(row.opportunityFeatureVector && typeof row.opportunityFeatureVector === 'object', `${label} opportunity row missing feature vector`, { row });
    assert(typeof row.opportunityScoreSummaryLine === 'string' && row.opportunityScoreSummaryLine.length > 0, `${label} opportunity row missing summary line`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'heuristicCompositeScore'), `${label} opportunity row missing heuristic score`, { row });
    assert(Object.prototype.hasOwnProperty.call(row, 'opportunityCompositeScore'), `${label} opportunity row missing opportunity score`, { row });
    assert(row.heuristicVsOpportunityComparison && typeof row.heuristicVsOpportunityComparison === 'object', `${label} opportunity row missing comparison object`, { row });
  }
}

(async () => {
  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => {
    console.log(`✅ ${name}`);
  };

  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3186,
    env: {
      DATABENTO_API_ENABLED: 'false',
      DATABENTO_API_KEY: '',
      TOPSTEP_API_ENABLED: 'false',
      TOPSTEP_API_KEY: '',
      NEWS_ENABLED: 'false',
      DISCORD_BOT_TOKEN: '',
    },
  });

  try {
    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1&discovery=1');
    assert(center?.status === 'ok', 'command-center status should be ok', { center });
    assertStrategySnapshotShape('command-center root', center.strategyLayerSnapshot);
    assert(center.originalPlan && typeof center.originalPlan === 'object', 'command-center originalPlan root field missing', { center });
    assert(center.bestVariant && typeof center.bestVariant === 'object', 'command-center bestVariant root field missing', { center });
    assert(center.bestAlternative && typeof center.bestAlternative === 'object', 'command-center bestAlternative root field missing', { center });
    assert(center.recommendationBasis && typeof center.recommendationBasis === 'object', 'command-center recommendationBasis root field missing', { center });
    assert(center.assistantDecisionBrief && typeof center.assistantDecisionBrief === 'object', 'command-center assistantDecisionBrief root field missing', { center });
    assert(typeof center.executionStance === 'string' && center.executionStance.length > 0, 'command-center executionStance root field missing', { center });
    assert(Array.isArray(center.strategyStack), 'command-center strategyStack root field missing', { center });
    assert(center.strategyStackCard && typeof center.strategyStackCard === 'object', 'command-center strategyStackCard root field missing', { center });
    assert(center.strategyWhyRecommended && typeof center.strategyWhyRecommended === 'object', 'command-center strategyWhyRecommended root field missing', { center });
    assert(typeof center.strategyRecommendationLine === 'string' && center.strategyRecommendationLine.length > 0, 'command-center strategyRecommendationLine root field missing', { center });
    assert(typeof center.strategyStanceLine === 'string' && center.strategyStanceLine.length > 0, 'command-center strategyStanceLine root field missing', { center });
    assert(typeof center.strategyVoiceLine === 'string' && center.strategyVoiceLine.length > 0, 'command-center strategyVoiceLine root field missing', { center });
    assert(center.strategyComparisonReadout && typeof center.strategyComparisonReadout === 'object', 'command-center strategyComparisonReadout root field missing', { center });
    assert(typeof center.strategyComparisonLine === 'string' && center.strategyComparisonLine.length > 0, 'command-center strategyComparisonLine root field missing', { center });
    assert(typeof center.strategyComparisonVoiceLine === 'string' && center.strategyComparisonVoiceLine.length > 0, 'command-center strategyComparisonVoiceLine root field missing', { center });
    assert(center.opportunityScoring && typeof center.opportunityScoring === 'object', 'command-center opportunityScoring root field missing', { center });
    assert(typeof center.opportunityScoreSummaryLine === 'string' && center.opportunityScoreSummaryLine.length > 0, 'command-center opportunityScoreSummaryLine root field missing', { center });
    assert(center.heuristicVsOpportunityComparison && typeof center.heuristicVsOpportunityComparison === 'object', 'command-center heuristicVsOpportunityComparison root field missing', { center });
    assert(center.todayRecommendation && typeof center.todayRecommendation === 'object', 'command-center todayRecommendation root mirror missing', { center });
    assert(center.decisionBoard && typeof center.decisionBoard === 'object', 'command-center decisionBoard root mirror missing', { center });

    assert(center.commandCenter && typeof center.commandCenter === 'object', 'commandCenter payload missing', { center });
    assert(center.commandCenter.strategyLayerSnapshot && typeof center.commandCenter.strategyLayerSnapshot === 'object', 'commandCenter.strategyLayerSnapshot missing', { center });
    assert(center.commandCenter.todayRecommendation && typeof center.commandCenter.todayRecommendation === 'object', 'commandCenter.todayRecommendation missing', { center });
    assert(center.commandCenter.decisionBoard && typeof center.commandCenter.decisionBoard === 'object', 'commandCenter.decisionBoard missing', { center });
    assert(center.commandCenter.todayRecommendation.strategyStackCard && typeof center.commandCenter.todayRecommendation.strategyStackCard === 'object', 'todayRecommendation strategyStackCard mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.strategyWhyRecommended && typeof center.commandCenter.todayRecommendation.strategyWhyRecommended === 'object', 'todayRecommendation strategyWhyRecommended mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyStackCard && typeof center.commandCenter.decisionBoard.strategyStackCard === 'object', 'decisionBoard strategyStackCard mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyWhyRecommended && typeof center.commandCenter.decisionBoard.strategyWhyRecommended === 'object', 'decisionBoard strategyWhyRecommended mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.strategyComparisonReadout && typeof center.commandCenter.todayRecommendation.strategyComparisonReadout === 'object', 'todayRecommendation strategyComparisonReadout mirror missing', { center });
    assert(center.commandCenter.decisionBoard.strategyComparisonReadout && typeof center.commandCenter.decisionBoard.strategyComparisonReadout === 'object', 'decisionBoard strategyComparisonReadout mirror missing', { center });
    assert(typeof center.commandCenter.todayRecommendation.strategyComparisonLine === 'string' && center.commandCenter.todayRecommendation.strategyComparisonLine.length > 0, 'todayRecommendation strategyComparisonLine mirror missing', { center });
    assert(typeof center.commandCenter.decisionBoard.strategyComparisonLine === 'string' && center.commandCenter.decisionBoard.strategyComparisonLine.length > 0, 'decisionBoard strategyComparisonLine mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.originalPlan && typeof center.commandCenter.todayRecommendation.originalPlan === 'object', 'todayRecommendation originalPlan mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.bestVariant && typeof center.commandCenter.todayRecommendation.bestVariant === 'object', 'todayRecommendation bestVariant mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.bestAlternative && typeof center.commandCenter.todayRecommendation.bestAlternative === 'object', 'todayRecommendation bestAlternative mirror missing', { center });
    assert(center.commandCenter.decisionBoard.originalPlan && typeof center.commandCenter.decisionBoard.originalPlan === 'object', 'decisionBoard originalPlan mirror missing', { center });
    assert(center.commandCenter.decisionBoard.bestVariant && typeof center.commandCenter.decisionBoard.bestVariant === 'object', 'decisionBoard bestVariant mirror missing', { center });
    assert(center.commandCenter.decisionBoard.bestAlternative && typeof center.commandCenter.decisionBoard.bestAlternative === 'object', 'decisionBoard bestAlternative mirror missing', { center });
    assert(center.commandCenter.todayRecommendation.opportunityScoring && typeof center.commandCenter.todayRecommendation.opportunityScoring === 'object', 'todayRecommendation opportunityScoring mirror missing', { center });
    assert(center.commandCenter.decisionBoard.opportunityScoring && typeof center.commandCenter.decisionBoard.opportunityScoring === 'object', 'decisionBoard opportunityScoring mirror missing', { center });
    pass('command-center strategy-layer snapshot and mirrors');

    const perf = await getJson(server.baseUrl, '/api/jarvis/recommendation/performance?force=1');
    assert(perf?.status === 'ok', 'recommendation/performance status should be ok', { perf });
    assertStrategySnapshotShape('recommendation/performance root', perf.strategyLayerSnapshot);
    assert(perf.recommendationPerformance && typeof perf.recommendationPerformance === 'object', 'recommendationPerformance object missing', { perf });
    assert(perf.recommendationPerformance.strategyLayerSnapshot && typeof perf.recommendationPerformance.strategyLayerSnapshot === 'object', 'recommendationPerformance.strategyLayerSnapshot missing', { perf });
    assert(perf.recommendationPerformance.originalPlan && typeof perf.recommendationPerformance.originalPlan === 'object', 'recommendationPerformance.originalPlan missing', { perf });
    assert(perf.recommendationPerformance.bestVariant && typeof perf.recommendationPerformance.bestVariant === 'object', 'recommendationPerformance.bestVariant missing', { perf });
    assert(perf.recommendationPerformance.bestAlternative && typeof perf.recommendationPerformance.bestAlternative === 'object', 'recommendationPerformance.bestAlternative missing', { perf });
    assert(perf.recommendationPerformance.recommendationBasis && typeof perf.recommendationPerformance.recommendationBasis === 'object', 'recommendationPerformance.recommendationBasis missing', { perf });
    assert(perf.recommendationPerformance.assistantDecisionBrief && typeof perf.recommendationPerformance.assistantDecisionBrief === 'object', 'recommendationPerformance.assistantDecisionBrief missing', { perf });
    assert(typeof perf.recommendationPerformance.executionStance === 'string' && perf.recommendationPerformance.executionStance.length > 0, 'recommendationPerformance.executionStance missing', { perf });
    assert(Array.isArray(perf.recommendationPerformance.strategyStack), 'recommendationPerformance.strategyStack missing', { perf });
    assert(perf.recommendationPerformance.strategyStackCard && typeof perf.recommendationPerformance.strategyStackCard === 'object', 'recommendationPerformance.strategyStackCard missing', { perf });
    assert(perf.recommendationPerformance.strategyWhyRecommended && typeof perf.recommendationPerformance.strategyWhyRecommended === 'object', 'recommendationPerformance.strategyWhyRecommended missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyRecommendationLine === 'string' && perf.recommendationPerformance.strategyRecommendationLine.length > 0, 'recommendationPerformance.strategyRecommendationLine missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyStanceLine === 'string' && perf.recommendationPerformance.strategyStanceLine.length > 0, 'recommendationPerformance.strategyStanceLine missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyVoiceLine === 'string' && perf.recommendationPerformance.strategyVoiceLine.length > 0, 'recommendationPerformance.strategyVoiceLine missing', { perf });
    assert(perf.recommendationPerformance.strategyComparisonReadout && typeof perf.recommendationPerformance.strategyComparisonReadout === 'object', 'recommendationPerformance.strategyComparisonReadout missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyComparisonLine === 'string' && perf.recommendationPerformance.strategyComparisonLine.length > 0, 'recommendationPerformance.strategyComparisonLine missing', { perf });
    assert(typeof perf.recommendationPerformance.strategyComparisonVoiceLine === 'string' && perf.recommendationPerformance.strategyComparisonVoiceLine.length > 0, 'recommendationPerformance.strategyComparisonVoiceLine missing', { perf });
    assert(perf.recommendationPerformance.opportunityScoring && typeof perf.recommendationPerformance.opportunityScoring === 'object', 'recommendationPerformance.opportunityScoring missing', { perf });
    assert(typeof perf.recommendationPerformance.opportunityScoreSummaryLine === 'string' && perf.recommendationPerformance.opportunityScoreSummaryLine.length > 0, 'recommendationPerformance.opportunityScoreSummaryLine missing', { perf });
    assert(perf.recommendationPerformance.heuristicVsOpportunityComparison && typeof perf.recommendationPerformance.heuristicVsOpportunityComparison === 'object', 'recommendationPerformance.heuristicVsOpportunityComparison missing', { perf });
    pass('recommendation/performance strategy-layer snapshot contract');

    const stackRows = Array.isArray(center.strategyLayerSnapshot?.strategyStack)
      ? center.strategyLayerSnapshot.strategyStack.filter((row) => row?.pineAccess?.available === true && row?.key)
      : [];
    assert(stackRows.length >= 1, 'expected at least one pine-exportable strategy row', { center });

    for (const row of stackRows.slice(0, 3)) {
      const pine = await getJson(server.baseUrl, row.pineAccess.endpoint);
      assert(pine?.status === 'ok', 'pine endpoint should return ok', { row, pine });
      assert(String(pine?.strategy?.key || '') === String(row.key), 'pine endpoint returned wrong strategy key', { row, pine });
      assert(String(pine?.strategy?.layer || '').toLowerCase() === String(row.layer || '').toLowerCase(), 'pine endpoint returned wrong layer', { row, pine });
      assert(String(pine?.format || '').toLowerCase() === 'pine_v6', 'pine endpoint format should be pine_v6', { row, pine });
      assert(pine?.copyReady === true, 'pine endpoint should mark copyReady', { row, pine });
      assert(typeof pine?.pineScript === 'string' && pine.pineScript.includes('//@version=6'), 'pine endpoint should return pine v6 text', { row, pine });
    }

    const invalid = await getRaw(server.baseUrl, '/api/jarvis/strategy/pine?key=missing_strategy_key_for_test');
    assert(invalid.status === 404, 'pine endpoint should 404 unknown strategy key', { invalid });
    pass('strategy/pine endpoint behavior and contract compliance');
  } catch (err) {
    fail('strategy layer surfacing integration', err);
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    console.error(`\nJarvis strategy-layer surfacing test failed with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log('\nJarvis strategy-layer surfacing test passed.');
})();
