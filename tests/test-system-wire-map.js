#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAP_PATH = path.join(REPO_ROOT, 'SYSTEM_WIRE_MAP.json');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function resolveRepoPath(relOrAbs) {
  const src = String(relOrAbs || '').trim();
  if (!src) return null;
  if (path.isAbsolute(src)) return src;
  return path.join(REPO_ROOT, src);
}

function toLines(text) {
  return String(text || '').split(/\r?\n/);
}

function findAnchorNearLine(lines, anchor, line, radius = 160) {
  const needle = String(anchor || '').trim();
  if (!needle) return false;
  const start = Math.max(1, Number(line || 1) - radius);
  const end = Math.min(lines.length, Number(line || 1) + radius);
  for (let i = start; i <= end; i += 1) {
    if (String(lines[i - 1] || '').includes(needle)) return true;
  }
  return false;
}

function run() {
  assert(fs.existsSync(MAP_PATH), 'SYSTEM_WIRE_MAP.json must exist');
  const map = readJson(MAP_PATH);

  assert(Array.isArray(map.requiredWireIds), 'requiredWireIds must be an array');
  assert(Array.isArray(map.wires), 'wires must be an array');
  assert(map.wires.length > 0, 'wires cannot be empty');

  const byId = new Map();
  for (const wire of map.wires) {
    const id = String(wire?.id || '').trim();
    assert(id, 'wire.id is required');
    assert(!byId.has(id), `duplicate wire id: ${id}`);
    byId.set(id, wire);

    const file = String(wire?.file || '').trim();
    const anchor = String(wire?.anchor || '').trim();
    const line = Number(wire?.line);

    assert(file, `wire ${id} missing file`);
    assert(anchor, `wire ${id} missing anchor`);
    assert(Number.isFinite(line) && line > 0, `wire ${id} missing valid line`);

    const resolved = resolveRepoPath(file);
    assert(resolved && fs.existsSync(resolved), `wire ${id} file missing: ${file}`);
    const content = fs.readFileSync(resolved, 'utf8');
    const lines = toLines(content);
    assert(lines.length > 0, `wire ${id} file has no content: ${file}`);

    const anchorPresentNearLine = findAnchorNearLine(lines, anchor, line);
    assert(
      anchorPresentNearLine,
      `wire ${id} anchor not found near line ${line}: ${anchor}`
    );
  }

  for (const reqId of map.requiredWireIds) {
    assert(byId.has(reqId), `required wire missing: ${reqId}`);
  }

  console.log(`✅ wire map validated (${map.wires.length} wires, ${map.requiredWireIds.length} required ids)`);
}

try {
  run();
} catch (err) {
  console.error(`❌ wire map validation failed\n   ${err.message}`);
  process.exit(1);
}
