#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3131';
const MAX_LOOPS = Math.max(1, Math.min(80, Number(process.env.ELITE_LOOP_MAX || 20)));
const LOOP_DELAY_MS = Math.max(0, Math.min(8000, Number(process.env.ELITE_LOOP_DELAY_MS || 150)));
const FETCH_RETRIES = Math.max(1, Math.min(5, Number(process.env.ELITE_FETCH_RETRIES || 3)));
const FETCH_RETRY_DELAY_MS = Math.max(50, Math.min(5000, Number(process.env.ELITE_FETCH_RETRY_DELAY_MS || 200)));
const ELITE_ALLOW_WORKAROUNDS = String(process.env.ELITE_ALLOW_WORKAROUNDS || 'true').toLowerCase() !== 'false';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(value, max = 600) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function runShell(command, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  const out = spawnSync('/bin/zsh', ['-lc', command], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  return {
    ok: out.status === 0 && !out.error,
    status: Number.isFinite(out.status) ? out.status : null,
    signal: out.signal || null,
    durationMs,
    stdout: tail(out.stdout || ''),
    stderr: tail(out.stderr || (out.error ? out.error.message : '')),
    error: out.error ? String(out.error.message || out.error) : null,
  };
}

async function fetchJson(pathname, init = null) {
  let lastError = null;
  for (let i = 1; i <= FETCH_RETRIES; i += 1) {
    try {
      const res = await fetch(`${BASE_URL}${pathname}`, {
        ...(init || {}),
        headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
        signal: AbortSignal.timeout(8_000),
      });
      const txt = await res.text();
      let payload = null;
      try {
        payload = JSON.parse(txt);
      } catch {
        payload = { raw: txt };
      }
      if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
      return payload;
    } catch (err) {
      lastError = err;
      if (i < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error(`fetch_failed:${pathname}`);
}

function looksGoodAssistantReply(reply) {
  const text = String(reply || '').trim();
  if (!text || text.length < 24) return false;
  if (/I understood, but no safe action was selected/i.test(text)) return false;
  if (/could not map that/i.test(text)) return false;
  if (/Command failed/i.test(text)) return false;
  return true;
}

async function collectSnapshot() {
  const out = {
    healthOk: false,
    quickOutlookOk: false,
    quickLiveIntelOk: false,
    codexPlannerOk: false,
    orchestratorOperational: false,
    assistantOperational: false,
    openaiConfigured: false,
    openaiBlocked: false,
    openaiBlockReason: null,
    notes: [],
  };
  try {
    const health = await fetchJson('/api/health');
    out.health = health;
    out.healthOk = String(health?.status || '').toLowerCase() === 'ok' && !!health?.database?.ok;
    if (!out.healthOk) out.notes.push('health_not_ok');
  } catch (err) {
    out.notes.push(`health_probe_failed:${tail(err?.message || err, 180)}`);
  }

  try {
    const status = await fetchJson('/api/system/status');
    out.systemStatus = status;
    const planner = status?.brain?.planner || {};
    out.openaiConfigured = !!status?.brain?.configured;
    out.openaiBlockReason = planner?.openaiBlockReason || null;
    const blockedUntil = planner?.openaiBlockedUntil ? Date.parse(planner.openaiBlockedUntil) : NaN;
    out.openaiBlocked = Number.isFinite(blockedUntil) && blockedUntil > Date.now();
    if (out.openaiBlocked) out.notes.push('openai_quota_or_rate_block_active');
  } catch (err) {
    out.notes.push(`system_status_failed:${tail(err?.message || err, 180)}`);
  }

  try {
    const q = await fetchJson('/api/assistant/quick', {
      method: 'POST',
      body: JSON.stringify({ message: 'what is todays outlook', strategy: 'original', activeModule: 'analyst' }),
    });
    out.quickOutlook = q;
    out.quickOutlookOk = q?.success === true && q?.handled === true && looksGoodAssistantReply(q?.reply);
    if (!out.quickOutlookOk) out.notes.push('quick_outlook_not_good');
  } catch (err) {
    out.notes.push(`quick_outlook_failed:${tail(err?.message || err, 180)}`);
  }

  try {
    const q = await fetchJson('/api/assistant/quick', {
      method: 'POST',
      body: JSON.stringify({ message: 'show live intelligence', strategy: 'original', activeModule: 'analyst' }),
    });
    out.quickLiveIntel = q;
    out.quickLiveIntelOk = q?.success === true && q?.handled === true && looksGoodAssistantReply(q?.reply);
    if (!out.quickLiveIntelOk) out.notes.push('quick_liveintel_not_good');
  } catch (err) {
    out.notes.push(`quick_liveintel_failed:${tail(err?.message || err, 180)}`);
  }

  try {
    const o = await fetchJson('/api/assistant/orchestrate', {
      method: 'POST',
      body: JSON.stringify({ message: 'status', strategy: 'original', activeModule: 'analyst' }),
    });
    out.orchestrateProbe = o;
    out.codexPlannerOk = o?.success === true && String(o?.planner?.provider || '').toLowerCase() === 'openai';
    const hasReply = looksGoodAssistantReply(o?.reply);
    const hasExecuted = Array.isArray(o?.commandsExecuted) && o.commandsExecuted.some((x) => !!x?.ok);
    out.orchestratorOperational = o?.success === true && (hasReply || hasExecuted);
    out.assistantOperational = out.quickOutlookOk && out.quickLiveIntelOk && out.orchestratorOperational;
    if (!out.codexPlannerOk) {
      out.notes.push('codex_planner_not_active');
      if (/quota|429|rate limit|insufficient/i.test(String(o?.reply || ''))) {
        out.notes.push('codex_quota_reply_detected');
      }
    }
    if (out.assistantOperational && !out.codexPlannerOk) {
      out.notes.push('workaround_mode_operational');
    }
  } catch (err) {
    out.notes.push(`orchestrate_probe_failed:${tail(err?.message || err, 180)}`);
  }
  return out;
}

function computeScore(state, snap) {
  let score = 0;
  if (snap.healthOk) score += 15;
  if (snap.quickOutlookOk) score += 10;
  if (snap.quickLiveIntelOk) score += 10;
  if (state.testsPassed) score += 10;
  if (state.buildPassed) score += 10;
  if (state.stabilityPassed) score += 10;
  if (state.deepReliabilityPassed) score += 10;
  if (state.assistantSmokePassed) score += 10;
  if (state.runtimeDoctorPassed) score += 10;
  if (state.ultimatePassed) score += 10;
  if (ELITE_ALLOW_WORKAROUNDS ? snap.assistantOperational : snap.codexPlannerOk) score += 15;
  return Math.max(0, Math.min(100, score));
}

function decideNextAction(state, snap) {
  const question = 'What should I do next?';
  if (!snap.healthOk) {
    return {
      question,
      answer: 'Stabilize runtime first: enforce launcher/runtime guards and recover health.',
      action: 'RUN_RUNTIME_ENFORCE',
      command: 'npm run runtime:enforce',
    };
  }
  if (!state.testsPassed) {
    return {
      question,
      answer: 'Validate core logic integrity by running the test suite now.',
      action: 'RUN_TESTS',
      command: 'npm test',
    };
  }
  if (!state.buildPassed) {
    return {
      question,
      answer: 'Build the client for production to ensure UI compile safety.',
      action: 'RUN_BUILD',
      command: 'npm run build',
    };
  }
  if (!state.stabilityPassed) {
    return {
      question,
      answer: 'Run stability checks to confirm no crash/restart behavior under repeated calls.',
      action: 'RUN_STABILITY',
      command: 'npm run test:stability',
    };
  }
  if (!state.deepReliabilityPassed) {
    return {
      question,
      answer: 'Run deep reliability checks to verify endpoint consistency and latency.',
      action: 'RUN_DEEP_RELIABILITY',
      command: 'npm run test:reliability:deep',
    };
  }
  if (!state.assistantSmokePassed) {
    return {
      question,
      answer: 'Run assistant smoke checks to validate next-step and strategic fallback behavior.',
      action: 'RUN_ASSISTANT_SMOKE',
      command: 'npm run test:assistant:smoke',
    };
  }
  if (!state.runtimeDoctorPassed) {
    return {
      question,
      answer: 'Run runtime doctor to verify launchers, desktop icon sync, and service health.',
      action: 'RUN_RUNTIME_DOCTOR',
      command: 'npm run runtime:doctor',
    };
  }
  if (!state.ultimatePassed) {
    return {
      question,
      answer: 'Run the ultimate certification pass to validate full production readiness.',
      action: 'RUN_ULTIMATE',
      command: 'npm run test:ultimate',
    };
  }
  if (!snap.codexPlannerOk && !state.plannerRecoveryTried) {
    return {
      question,
      answer: 'Codex planner is not active; run runtime enforcement once to recover service-level routing.',
      action: 'RUN_RUNTIME_ENFORCE',
      command: 'npm run runtime:enforce',
    };
  }
  if (!snap.quickOutlookOk || !snap.quickLiveIntelOk) {
    return {
      question,
      answer: 'Assistant quality checks are weak; enforce runtime and re-evaluate quick-response behavior.',
      action: 'RUN_RUNTIME_ENFORCE',
      command: 'npm run runtime:enforce',
    };
  }
  if (ELITE_ALLOW_WORKAROUNDS && snap.assistantOperational) {
    return {
      question,
      answer: 'Workaround mode is stable and all production checks pass; mark as elite-ready under workaround policy.',
      action: 'DONE',
      command: null,
    };
  }
  if (!snap.codexPlannerOk || !snap.openaiConfigured || snap.openaiBlocked) {
    return {
      question,
      answer: 'All internal checks pass, but Codex planner is blocked. Resolve OpenAI quota/billing to unlock full intelligence quality.',
      action: 'MANUAL_OPENAI_BILLING',
      command: null,
    };
  }
  return {
    question,
    answer: 'All gates are green. Dashboard qualifies as elite production-ready.',
    action: 'DONE',
    command: null,
  };
}

function applyActionResult(state, action, result) {
  if (!result) return;
  if (action === 'RUN_RUNTIME_ENFORCE') state.plannerRecoveryTried = true;
  if (action === 'RUN_TESTS') state.testsPassed = !!result.ok;
  if (action === 'RUN_BUILD') state.buildPassed = !!result.ok;
  if (action === 'RUN_STABILITY') state.stabilityPassed = !!result.ok;
  if (action === 'RUN_DEEP_RELIABILITY') state.deepReliabilityPassed = !!result.ok;
  if (action === 'RUN_ASSISTANT_SMOKE') state.assistantSmokePassed = !!result.ok;
  if (action === 'RUN_RUNTIME_DOCTOR') state.runtimeDoctorPassed = !!result.ok;
  if (action === 'RUN_ULTIMATE') {
    state.ultimatePassed = !!result.ok;
    if (result.ok) {
      state.testsPassed = true;
      state.buildPassed = true;
      state.stabilityPassed = true;
      state.deepReliabilityPassed = true;
      state.assistantSmokePassed = true;
      state.runtimeDoctorPassed = true;
    }
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function main() {
  console.log(`[elite-loop] start loops=${MAX_LOOPS} base=${BASE_URL}`);
  const startedAt = new Date().toISOString();
  const state = {
    testsPassed: false,
    buildPassed: false,
    stabilityPassed: false,
    deepReliabilityPassed: false,
    assistantSmokePassed: false,
    runtimeDoctorPassed: false,
    ultimatePassed: false,
    plannerRecoveryTried: false,
  };
  const loops = [];
  let finalSnapshot = null;
  let finalDecision = null;
  let eliteReady = false;

  for (let i = 1; i <= MAX_LOOPS; i += 1) {
    const snap = await collectSnapshot();
    const scoreBefore = computeScore(state, snap);
    const decision = decideNextAction(state, snap);
    finalSnapshot = snap;
    finalDecision = decision;

    const row = {
      loop: i,
      at: new Date().toISOString(),
      question: decision.question,
      answer: decision.answer,
      action: decision.action,
      scoreBefore,
      snapshot: {
        healthOk: snap.healthOk,
        quickOutlookOk: snap.quickOutlookOk,
        quickLiveIntelOk: snap.quickLiveIntelOk,
        codexPlannerOk: snap.codexPlannerOk,
        orchestratorOperational: snap.orchestratorOperational,
        assistantOperational: snap.assistantOperational,
        openaiConfigured: snap.openaiConfigured,
        openaiBlocked: snap.openaiBlocked,
        openaiBlockReason: snap.openaiBlockReason ? tail(snap.openaiBlockReason, 240) : null,
        notes: snap.notes,
      },
      result: null,
      scoreAfter: null,
      stateAfter: null,
    };

    if (decision.command) {
      const result = runShell(decision.command);
      row.result = {
        ok: result.ok,
        status: result.status,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
      applyActionResult(state, decision.action, result);
      const snapAfter = await collectSnapshot();
      row.scoreAfter = computeScore(state, snapAfter);
      row.stateAfter = { ...state };
      finalSnapshot = snapAfter;
    } else {
      row.result = { ok: true, note: 'no_command_required' };
      row.scoreAfter = scoreBefore;
      row.stateAfter = { ...state };
    }

    loops.push(row);
    console.log(`[elite-loop] #${i} ${row.action} score ${row.scoreBefore} -> ${row.scoreAfter}`);

    if (decision.action === 'DONE') {
      eliteReady = true;
      break;
    }
    if (decision.action === 'MANUAL_OPENAI_BILLING') {
      eliteReady = false;
      break;
    }
    if (LOOP_DELAY_MS > 0 && i < MAX_LOOPS) await sleep(LOOP_DELAY_MS);
  }

  const finalScore = computeScore(state, finalSnapshot || (await collectSnapshot()));
  const summary = {
    startedAt,
    endedAt: new Date().toISOString(),
    loopsExecuted: loops.length,
    maxLoops: MAX_LOOPS,
    allowWorkarounds: ELITE_ALLOW_WORKAROUNDS,
    eliteReady,
    finalScore,
    finalState: state,
    finalDecision: finalDecision ? { action: finalDecision.action, answer: finalDecision.answer } : null,
    blockers: (() => {
      const rows = [];
      if (!eliteReady && finalSnapshot?.openaiBlocked && !ELITE_ALLOW_WORKAROUNDS) {
        rows.push({
          id: 'OPENAI_QUOTA_BLOCKED',
          message: tail(finalSnapshot.openaiBlockReason || 'OpenAI quota/rate blocker is active.', 260),
        });
      }
      if (!eliteReady && !finalSnapshot?.assistantOperational) {
        rows.push({
          id: 'ASSISTANT_OPERABILITY_DEGRADED',
          message: 'Assistant quick/orchestrator operational checks did not all pass.',
        });
      }
      return rows;
    })(),
  };

  ensureDataDir();
  const stamp = summary.endedAt.replace(/[:.]/g, '-');
  const outPath = path.join(DATA_DIR, `elite-finish-loop-report-${stamp}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify({ summary, loops }, null, 2)}\n`, 'utf8');

  console.log(`[elite-loop] report=${outPath}`);
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(`[elite-loop] fatal ${String(err?.message || err)}`);
  process.exit(1);
});
