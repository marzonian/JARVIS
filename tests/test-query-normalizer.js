#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { normalizeLocalSearchQuery } = require('../server/jarvis-core/query-normalizer');

function runCase(input, expected = {}) {
  const out = normalizeLocalSearchQuery(input);
  if (expected.normalizedQuery != null) {
    assert.strictEqual(out.normalizedQuery, expected.normalizedQuery, `normalizedQuery mismatch for "${input}"`);
  }
  if (expected.entityQuery != null) {
    assert.strictEqual(out.entityQuery, expected.entityQuery, `entityQuery mismatch for "${input}"`);
  }
  if (expected.brandOrTerm != null) {
    assert.strictEqual(out.brandOrTerm, expected.brandOrTerm, `brandOrTerm mismatch for "${input}"`);
  }
  if (expected.categoryHint !== undefined) {
    assert.strictEqual(out.categoryHint, expected.categoryHint, `categoryHint mismatch for "${input}"`);
  }
  assert.strictEqual(typeof out.originalQuery, 'string');
}

function main() {
  runCase("service where's the nearest walmart", {
    normalizedQuery: 'Walmart',
    entityQuery: 'Walmart',
    brandOrTerm: 'Walmart',
    categoryHint: null,
  });
  runCase('target near me', {
    normalizedQuery: 'Target',
    entityQuery: 'Target',
    brandOrTerm: 'Target',
    categoryHint: null,
  });
  runCase('find a target', {
    normalizedQuery: 'Target',
    entityQuery: 'Target',
    brandOrTerm: 'Target',
    categoryHint: null,
  });
  runCase('closest gas station', {
    normalizedQuery: 'Gas Station',
    entityQuery: 'Gas Station',
    brandOrTerm: 'Gas Station',
    categoryHint: 'gas_station',
  });
  runCase('pizza around here', {
    normalizedQuery: 'Pizza',
    entityQuery: 'Pizza',
    brandOrTerm: 'Pizza',
    categoryHint: 'pizza',
  });
  runCase('find me a pizza place', {
    normalizedQuery: 'Pizza',
    entityQuery: 'Pizza',
    brandOrTerm: 'Pizza',
    categoryHint: 'pizza',
  });
  runCase('find cvs', {
    normalizedQuery: 'CVS',
    entityQuery: 'CVS',
    brandOrTerm: 'CVS',
    categoryHint: null,
  });
  runCase('good pizza around here please', {
    normalizedQuery: 'Pizza',
    entityQuery: 'Pizza',
    brandOrTerm: 'Pizza',
    categoryHint: 'pizza',
  });

  console.log('✅ query normalizer tests passed');
}

try {
  main();
} catch (err) {
  console.error(`❌ test-query-normalizer failed\n   ${err.message}`);
  process.exit(1);
}
