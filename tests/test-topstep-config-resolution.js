#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function runConfigProbe(envPatch = {}) {
  const script = `
    const cfg = require('./server/config');
    const out = {
      enabled: cfg.topstep && cfg.topstep.api ? cfg.topstep.api.enabled : null,
      keyPresent: !!(cfg.topstep && cfg.topstep.api && cfg.topstep.api.key),
      envHydration: cfg.envHydration && typeof cfg.envHydration === 'object'
        ? {
          topstepDiagnosticEnvFilePath: cfg.envHydration.topstepDiagnosticEnvFilePath || null,
          topstepKeySources: cfg.envHydration.topstepKeySources || null,
          loadedFiles: Array.isArray(cfg.envHydration.loadedFiles) ? cfg.envHydration.loadedFiles.length : null,
        }
        : null,
    };
    console.log(JSON.stringify(out));
  `;
  const env = {
    ...process.env,
    TOPSTEP_API_KEY: '',
    TOPSTEP_API_USERNAME: '',
    TOPSTEP_API_ENABLED: '',
    JARVIS_RUNTIME_ENV_PATH: '',
    ...envPatch,
  };
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`config probe failed: ${result.stderr || result.stdout || 'unknown_error'}`);
  }
  return JSON.parse(String(result.stdout || '{}').trim() || '{}');
}

function run() {
  const explicitTrue = runConfigProbe({
    TOPSTEP_API_ENABLED: 'TRUE',
    TOPSTEP_API_KEY: 'topstep_test_key_true',
    TOPSTEP_API_USERNAME: 'tester',
  });
  assert(explicitTrue.enabled === true, 'TOPSTEP_API_ENABLED=TRUE should resolve enabled=true');

  const explicitFalse = runConfigProbe({
    TOPSTEP_API_ENABLED: 'false',
    TOPSTEP_API_KEY: 'topstep_test_key_false',
    TOPSTEP_API_USERNAME: 'tester',
  });
  assert(explicitFalse.enabled === false, 'TOPSTEP_API_ENABLED=false should resolve enabled=false');

  const implicitFromKey = runConfigProbe({
    TOPSTEP_API_ENABLED: '',
    TOPSTEP_API_KEY: 'topstep_test_key_implicit',
    TOPSTEP_API_USERNAME: 'tester',
  });
  assert(implicitFromKey.enabled === true, 'missing TOPSTEP_API_ENABLED with key present should resolve enabled=true');
  assert(implicitFromKey.envHydration && typeof implicitFromKey.envHydration === 'object', 'envHydration metadata should exist');
  assert(
    typeof implicitFromKey.envHydration.topstepDiagnosticEnvFilePath === 'string' || implicitFromKey.envHydration.topstepDiagnosticEnvFilePath === null,
    'topstepDiagnosticEnvFilePath should be surfaced'
  );
  assert(
    implicitFromKey.envHydration.topstepKeySources && typeof implicitFromKey.envHydration.topstepKeySources === 'object',
    'topstepKeySources should be surfaced'
  );
}

try {
  run();
  console.log('✅ topstep config resolution checks passed');
} catch (err) {
  console.error('❌ topstep config resolution checks failed');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
