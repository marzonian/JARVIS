#!/usr/bin/env node

const { runPreflight } = require('../server/preflight');

try {
  runPreflight({ strict: true, log: true });
  process.exit(0);
} catch (err) {
  console.error(`[3130] Preflight failed: ${err.message}`);
  process.exit(1);
}
