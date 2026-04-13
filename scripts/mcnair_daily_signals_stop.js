#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const TZ = process.env.TZ || 'America/New_York';

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function nowHHMMInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}`;
}

function main() {
  const startedAt = new Date().toISOString();
  console.log(`[mcnair_daily_signals_stop] start ${startedAt}`);
  const nowHHMM = nowHHMMInTimezone(TZ);
  if (nowHHMM !== '10:45' && process.env.FORCE_STOP !== '1') {
    console.log(`[mcnair_daily_signals_stop] skip at ${nowHHMM} ${TZ}`);
    console.log('[mcnair_daily_signals_stop] complete');
    return;
  }
  try {
    run('pm2 stop mcnair-daily-signals');
    console.log('[mcnair_daily_signals_stop] stopped mcnair-daily-signals');
  } catch (err) {
    // Keep this as non-fatal: if the process is already stopped, scheduler should continue.
    console.log('[mcnair_daily_signals_stop] stop skipped (already stopped or not found)');
  }
  console.log('[mcnair_daily_signals_stop] complete');
}

main();
