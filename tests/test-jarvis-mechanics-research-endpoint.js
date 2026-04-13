#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');

const TIMEOUT_MS = 420000;

async function getJson(baseUrl, endpoint) {
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${endpoint} http_${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3167,
  });

  let failures = 0;
  const fail = (name, err) => {
    failures += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  };
  const pass = (name) => console.log(`✅ ${name}`);

  try {
    const out = await getJson(server.baseUrl, '/api/jarvis/mechanics/research?windowTrades=120');
    assert(out?.status === 'ok', 'endpoint must return status=ok', { out });
    const summary = out?.mechanicsResearchSummary || {};
    assert(summary && typeof summary === 'object', 'mechanicsResearchSummary missing', { out });
    assert(Array.isArray(summary.supportedTpModes), 'supportedTpModes missing', { out });
    assert(summary.supportedTpModes.includes('Nearest') && summary.supportedTpModes.includes('Skip 1') && summary.supportedTpModes.includes('Skip 2'), 'all TP modes must be present', { out });
    assert(summary.originalPlanTpMode === 'Skip 2', 'originalPlanTpMode missing or incorrect', { out });
    assert(summary.originalPlanStopMode === 'rr_1_to_1_from_tp', 'originalPlanStopMode missing or incorrect', { out });
    assert(Array.isArray(summary.unsupportedStopFamilies) && summary.unsupportedStopFamilies.includes('structure_stop'), 'unsupportedStopFamilies disclosure missing', { out });
    assert(summary.advisoryOnly === true, 'advisoryOnly flag missing', { out });
    assert(Array.isArray(summary.mechanicsVariantTable) && summary.mechanicsVariantTable.length === 3, 'mechanicsVariantTable should include 3 TP rows', { out });
    assert(out?.contextualRecommendation && typeof out.contextualRecommendation === 'object', 'top-level contextualRecommendation missing', { out });
    const contextual = out.contextualRecommendation || {};
    assert(contextual.contextUsed && typeof contextual.contextUsed === 'object', 'contextual contextUsed missing', { out, contextual });
    assert(['exact_context', 'drop_regime', 'time_bucket_only', 'global'].includes(String(contextual.fallbackLevel || '')), 'contextual fallbackLevel invalid', { out, contextual });
    assert(typeof contextual.contextualRecommendedTpMode === 'string' && contextual.contextualRecommendedTpMode.length > 0, 'contextual recommended TP mode missing', { out, contextual });
    assert(['high', 'medium', 'low'].includes(String(contextual.confidenceLabel || '')), 'contextual confidence label missing', { out, contextual });
    pass('mechanics research endpoint returns expected schema');
  } catch (err) {
    fail('mechanics research endpoint returns expected schema', err);
  }

  try {
    const minClamp = await getJson(server.baseUrl, '/api/jarvis/mechanics/research?windowTrades=5');
    assert(Number(minClamp?.mechanicsResearchSummary?.windowSize) === 20, 'windowTrades must clamp to min=20', { minClamp });
    const maxClamp = await getJson(server.baseUrl, '/api/jarvis/mechanics/research?windowTrades=999');
    assert(Number(maxClamp?.mechanicsResearchSummary?.windowSize) === 500, 'windowTrades must clamp to max=500', { maxClamp });
    pass('windowTrades query parameter clamps correctly');
  } catch (err) {
    fail('windowTrades query parameter clamps correctly', err);
  }

  try {
    const cachedA = await getJson(server.baseUrl, '/api/jarvis/mechanics/research?windowTrades=80');
    const cachedB = await getJson(server.baseUrl, '/api/jarvis/mechanics/research?windowTrades=80');
    assert(
      String(cachedA?.mechanicsResearchSummary?.generatedAt || '') === String(cachedB?.mechanicsResearchSummary?.generatedAt || ''),
      'non-force requests should reuse cached snapshot generatedAt',
      { cachedA, cachedB }
    );
    await sleep(30);
    const forced = await getJson(server.baseUrl, '/api/jarvis/mechanics/research?windowTrades=80&force=1');
    assert(
      String(forced?.mechanicsResearchSummary?.generatedAt || '') !== String(cachedB?.mechanicsResearchSummary?.generatedAt || ''),
      'force=1 should bypass cache and rebuild snapshot',
      { cachedB, forced }
    );
    pass('force query bypasses mechanics research cache');
  } catch (err) {
    fail('force query bypasses mechanics research cache', err);
  }

  try {
    const layers = await getJson(server.baseUrl, '/api/jarvis/strategy/layers?windowTrades=120');
    assert(layers?.status === 'ok', 'strategy layers endpoint should return ok for integration check', { layers });
    const summary = layers?.strategyLayers?.mechanicsSummary || {};
    const requiredKeys = [
      'bestTpModeRecent',
      'bestTpModeByWinRate',
      'bestTpModeByProfitFactor',
      'recommendedTpMode',
      'recommendedTpModeReason',
      'evidenceWindowTrades',
      'tpModeComparisonAvailable',
      'sampleQuality',
      'originalPlanTpMode',
      'originalPlanStopMode',
      'advisoryOnly',
      'contextualTpRecommendation',
      'contextConfidence',
      'contextSampleSize',
    ];
    for (const key of requiredKeys) {
      assert(Object.prototype.hasOwnProperty.call(summary, key), `strategyLayers.mechanicsSummary missing ${key}`, { layers, summary });
    }

    const center = await getJson(server.baseUrl, '/api/jarvis/command-center?windowTrades=120');
    assert(center?.status === 'ok', 'command center endpoint should return ok for integration check', { center });
    assert(center?.mechanicsResearchSummary && typeof center.mechanicsResearchSummary === 'object', 'command center should pass through mechanicsResearchSummary', { center });
    const insight = String(center?.commandCenter?.mechanicsInsight || '');
    assert(insight.length > 0, 'command center should include concise mechanics insight', { center });
    const contextualInsight = String(center?.commandCenter?.contextualMechanicsInsight || '');
    assert(contextualInsight.length > 0, 'command center should include contextual mechanics insight', { center });
    const contextualConfidence = String(center?.commandCenter?.contextualMechanicsConfidence || '').toLowerCase();
    assert(['high', 'medium', 'low'].includes(contextualConfidence), 'command center should expose contextual mechanics confidence label', { center });
    pass('strategy layers and command center expose mechanics research integration contract');
  } catch (err) {
    fail('strategy layers and command center expose mechanics research integration contract', err);
  }

  await server.stop();

  if (failures > 0) {
    console.error(`\nJarvis mechanics research endpoint test failed with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nJarvis mechanics research endpoint test passed.');
}

run().catch((err) => {
  console.error(`\nJarvis mechanics research endpoint test crashed: ${err.message}`);
  process.exit(1);
});
