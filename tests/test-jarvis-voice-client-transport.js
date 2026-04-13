#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function runCase(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n   ${err.message}`);
    process.exitCode = 1;
  }
}

const appPath = path.resolve(__dirname, '../client/src/App.jsx');
const src = fs.readFileSync(appPath, 'utf8');
const voiceSection = (() => {
  const startMarker = 'function VoiceCopilot(';
  const endMarker = 'const applyClientActions = useCallback((actions) => {';
  const start = src.indexOf(startMarker);
  if (start < 0) return src;
  const end = src.indexOf(endMarker, start);
  if (end < 0) return src.slice(start);
  return src.slice(start, end);
})();

runCase('voice transport no longer contains legacy fallback path', () => {
  assert(!/client\.voice\.safe_fallback/.test(src), 'found deprecated client.voice.safe_fallback marker');
  assert(!/status:\s*'legacy'/.test(src), 'found deprecated legacy route status');
  assert(!/Legacy:\s*ON/.test(src), 'found deprecated Legacy: ON badge text');
});

runCase('voice transport uses explicit unavailable state on failure', () => {
  assert(/status:\s*'unavailable'/.test(src), 'missing unavailable route status');
  assert(/client\.voice\.transport_unavailable/.test(src), 'missing transport unavailable route tag');
  assert(/Jarvis unavailable/.test(src), 'missing explicit Jarvis unavailable UI text');
});

runCase('voice query still retries once before marking unavailable', () => {
  assert(/if \(retriable && options\.retryAttempted !== true\)/.test(voiceSection), 'missing one-time retry guard');
  assert(/retryAttempted:\s*true/.test(voiceSection), 'missing retryAttempted toggle');
  assert(!/allowFallback/.test(voiceSection), 'found deprecated allowFallback option in voice transport path');
});

if (process.exitCode) process.exit(process.exitCode);
console.log('All jarvis voice client transport tests passed.');
