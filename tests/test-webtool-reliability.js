#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const { searchPlaces, runWebTool } = require('../server/tools/webTool');

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

const locationUsed = {
  lat: 40.7357,
  lon: -74.1724,
  city: 'Newark, NJ',
  region: 'NJ',
  country: 'US',
};

async function main() {
  await runCase('provider A error falls back to provider B success', async () => {
    const out = await searchPlaces({
      normalizedQuery: 'coffee shop',
      originalQuery: 'nearest coffee shop',
      locationUsed,
      maxResults: 5,
      providerChain: {
        nominatimText: async () => ({ ok: false, error: 'provider_a_down', results: [] }),
        nominatimStructured: async () => ({
          ok: true,
          results: [{ title: 'Fallback Cafe', distanceKm: 0.4, address: 'Newark' }],
        }),
        overpass: async () => ({ ok: true, results: [] }),
      },
    });
    assert.strictEqual(out.ok, true);
    assert.ok(Array.isArray(out.results) && out.results.length >= 1, 'fallback provider should return at least one result');
    const attempts = Array.isArray(out.attempts) ? out.attempts : [];
    assert.strictEqual(attempts[0]?.ok, false, 'primary provider should fail in this test');
    assert.strictEqual(attempts[1]?.ok, true, 'fallback provider should succeed');
  });

  await runCase('provider A zero results falls back to provider B success', async () => {
    const out = await searchPlaces({
      normalizedQuery: 'gas station',
      originalQuery: 'nearest gas station',
      locationUsed,
      maxResults: 5,
      providerChain: {
        nominatimText: async () => ({ ok: true, results: [] }),
        nominatimStructured: async () => ({
          ok: true,
          results: [{ title: 'Second Provider Gas', distanceKm: 0.9, address: 'Market St, Newark' }],
        }),
        overpass: async () => ({ ok: true, results: [] }),
      },
    });
    assert.strictEqual(out.ok, true);
    assert.ok(Array.isArray(out.results) && out.results.length >= 1, 'secondary provider should recover zero-result primary');
    const attempts = Array.isArray(out.attempts) ? out.attempts : [];
    assert.strictEqual(attempts[0]?.ok, true, 'primary provider call should succeed even with zero results');
    assert.strictEqual(Number(attempts[0]?.resultCount || 0), 0, 'primary provider should return zero in this case');
    assert.strictEqual(attempts[1]?.ok, true, 'secondary provider should succeed');
  });

  await runCase('both providers fail returns truthful safe response', async () => {
    const out = await runWebTool({
      message: 'nearest pharmacy',
      intent: 'local_search',
      queryUsed: 'nearest pharmacy',
      normalizedQuery: 'pharmacy',
      originalQuery: 'nearest pharmacy',
      locationRequired: true,
      userLocationHint: locationUsed,
      webEnabled: true,
      allowNetwork: true,
      webMode: 'real',
      maxSources: 5,
      maxResults: 5,
      enableWebFallback: true,
      providerChain: {
        nominatimText: async () => ({ ok: false, error: 'provider_a_failed', results: [] }),
        nominatimStructured: async () => ({ ok: false, error: 'provider_b_failed', results: [] }),
        overpass: async () => ({ ok: false, error: 'provider_c_failed', results: [] }),
        webFallback: async () => ({ ok: false, error: 'provider_d_failed', results: [] }),
      },
    });
    assert.strictEqual(out.ok, true, 'runWebTool should fail closed with a safe response payload');
    const stance = String(out?.narrative?.stance || out?.data?.answer || '').toLowerCase();
    assert(
      /couldn['’]?t find|no strong matches|provider returned 0 results|request failed/.test(stance),
      `safe response should be explicit when all providers fail, got: ${stance}`
    );
    const attempts = Array.isArray(out?.metrics?.providerAttempts) ? out.metrics.providerAttempts : [];
    assert.ok(attempts.length >= 3, 'provider attempts should be recorded in metrics');
    const failedProviders = Array.isArray(out?.metrics?.providerFailed) ? out.metrics.providerFailed : [];
    assert.ok(failedProviders.length >= 1, 'providerFailed list should be populated');
  });

  if (process.exitCode) process.exit(process.exitCode);
  console.log('All web tool reliability tests passed.');
}

main().catch((err) => {
  console.error(`\nWeb tool reliability tests failed: ${err.message}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

