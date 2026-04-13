#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const {
  startAuditServer,
} = require('./jarvis-audit-common');
const {
  SUPPORTED_REGIME_LABELS,
  buildRegimeDetection,
} = require('../server/jarvis-core/regime-detection');

const TIMEOUT_MS = 120000;

function buildRow(overrides = {}) {
  return {
    regime_trend: 'ranging',
    regime_vol: 'normal',
    regime_orb_size: 'normal',
    regime_gap: 'flat',
    first_15min: 'inside',
    session_type: 'balanced',
    metrics: {
      session_range_ticks: 420,
      orb_range_ticks: 120,
    },
    ...overrides,
  };
}

function runUnitChecks() {
  const trending = buildRegimeDetection({
    regimeByDate: {
      '2026-03-06': buildRow({
        regime_trend: 'trending',
        regime_vol: 'normal',
        regime_orb_size: 'normal',
        first_15min: 'continuation_up',
        metrics: { session_range_ticks: 560, orb_range_ticks: 110 },
      }),
    },
    latestDate: '2026-03-06',
    sessionPhase: 'entry_window',
  });
  assert(trending.regimeLabel === 'trending', 'trending scenario should classify as trending');
  assert(['medium', 'high'].includes(trending.confidenceLabel), 'trending confidence should be medium/high');

  const wideVol = buildRegimeDetection({
    regimeByDate: {
      '2026-03-06': buildRow({
        regime_trend: 'choppy',
        regime_vol: 'extreme',
        regime_orb_size: 'wide',
        first_15min: 'inside',
        metrics: { session_range_ticks: 1100, orb_range_ticks: 280 },
      }),
    },
    latestDate: '2026-03-06',
    sessionPhase: 'entry_window',
  });
  assert(wideVol.regimeLabel === 'wide_volatile', 'extreme + wide scenario should classify as wide_volatile');

  const compressed = buildRegimeDetection({
    regimeByDate: {
      '2026-03-06': buildRow({
        regime_trend: 'flat',
        regime_vol: 'low',
        regime_orb_size: 'narrow',
        first_15min: 'inside',
        metrics: { session_range_ticks: 170, orb_range_ticks: 42 },
      }),
    },
    latestDate: '2026-03-06',
    sessionPhase: 'pre_open',
  });
  assert(compressed.regimeLabel === 'compressed', 'low + narrow scenario should classify as compressed');

  const mixed = buildRegimeDetection({
    regimeByDate: {
      '2026-03-06': buildRow({
        regime_trend: 'trending',
        regime_vol: 'low',
        regime_orb_size: 'wide',
        first_15min: 'inside',
        metrics: { session_range_ticks: 360, orb_range_ticks: 240 },
      }),
    },
    latestDate: '2026-03-06',
    sessionPhase: 'entry_window',
  });
  assert(mixed.regimeLabel === 'mixed', 'conflicting signals should classify as mixed');

  const unknown = buildRegimeDetection({
    regimeByDate: {},
    latestDate: '2026-03-06',
    includeEvidence: true,
  });
  assert(unknown.regimeLabel === 'unknown', 'missing data should classify as unknown');
  assert(unknown.confidenceLabel === 'low', 'unknown confidence should be low');

  for (const row of [trending, wideVol, compressed, mixed, unknown]) {
    assert(SUPPORTED_REGIME_LABELS.includes(row.regimeLabel), `unsupported regime label emitted: ${row.regimeLabel}`);
    assert(['low', 'medium', 'high'].includes(String(row.confidenceLabel || '')), 'confidenceLabel must be low/medium/high');
    assert(Number.isFinite(Number(row.confidenceScore)), 'confidenceScore must be numeric');
    assert(typeof row.regimeReason === 'string' && row.regimeReason.length > 0, 'regimeReason missing');
    assert(row.advisoryOnly === true, 'regimeDetection must be advisoryOnly');
  }
}

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

async function runIntegrationChecks() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3182,
  });

  try {
    const regimeOut = await getJson(server.baseUrl, '/api/jarvis/regime?force=1');
    assert(regimeOut?.status === 'ok', 'regime endpoint should return ok');
    const regime = regimeOut?.regimeDetection;
    assert(regime && typeof regime === 'object', 'regimeDetection missing from endpoint');
    assert(SUPPORTED_REGIME_LABELS.includes(regime.regimeLabel), `endpoint emitted unsupported regimeLabel: ${regime.regimeLabel}`);
    assert(['low', 'medium', 'high'].includes(String(regime.confidenceLabel || '')), 'endpoint confidenceLabel invalid');
    assert(Number.isFinite(Number(regime.confidenceScore)), 'endpoint confidenceScore invalid');
    assert(typeof regime.regimeReason === 'string' && regime.regimeReason.length > 0, 'endpoint regimeReason missing');
    assert(regime.advisoryOnly === true, 'endpoint advisoryOnly missing');
    assert(regime.evidenceSignals && typeof regime.evidenceSignals === 'object', 'endpoint evidenceSignals should exist by default');

    const noEvidenceOut = await getJson(server.baseUrl, '/api/jarvis/regime?force=1&includeEvidence=0');
    assert(noEvidenceOut?.status === 'ok', 'regime endpoint includeEvidence=0 should return ok');
    assert(noEvidenceOut?.regimeDetection?.evidenceSignals === null, 'includeEvidence=0 should suppress evidenceSignals');

    const centerOut = await getJson(server.baseUrl, '/api/jarvis/command-center?force=1');
    assert(centerOut?.status === 'ok', 'command-center endpoint should return ok');
    assert(centerOut?.regimeDetection && typeof centerOut.regimeDetection === 'object', 'top-level regimeDetection should be present in command-center response');

    const center = centerOut?.commandCenter || {};
    assert(typeof center.regimeLabel === 'string' && center.regimeLabel.length > 0, 'command-center regimeLabel missing');
    assert(['low', 'medium', 'high'].includes(String(center.regimeConfidence || '')), 'command-center regimeConfidence invalid');
    assert(typeof center.regimeReason === 'string' && center.regimeReason.length > 0, 'command-center regimeReason missing');
    assert(typeof center.regimeInsight === 'string' && center.regimeInsight.length > 0, 'command-center regimeInsight missing');
    assert(center.regimeLabel === center?.todayContext?.marketRegime, 'todayContext.marketRegime must match command-center regimeLabel');
    assert(center.regimeLabel === center?.jarvisBrief?.regime, 'jarvisBrief.regime must match command-center regimeLabel');
    assert(center.regimeLabel === center?.decisionBoard?.regimeLabel, 'decisionBoard.regimeLabel must match command-center regimeLabel');
  } finally {
    await server.stop();
  }
}

(async () => {
  try {
    runUnitChecks();
    await runIntegrationChecks();
    console.log('All jarvis regime detection tests passed.');
  } catch (err) {
    console.error(`Jarvis regime detection test failed: ${err.message}`);
    process.exit(1);
  }
})();
