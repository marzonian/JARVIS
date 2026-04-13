const { execFile } = require('child_process');
const { URL } = require('url');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const PENDING_TTL_MS = 10 * 60 * 1000;
const AI_INTERPRETER_PROVIDER = String(process.env.DISCORD_INTERPRETER_PROVIDER || 'openai').trim().toLowerCase();
const AI_INTERPRETER_MODEL = process.env.DISCORD_INTERPRETER_MODEL || process.env.OPENAI_CODEX_MODEL || 'gpt-5.3-codex';

function escapeAppleScriptString(input) {
  return String(input || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function isValidHttpUrl(input) {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidOpenHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost') return true;
  if (net.isIP(h)) return true;
  return h.includes('.');
}

function normalizeOpenUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (isValidHttpUrl(raw)) {
    try {
      const u = new URL(raw);
      if (!isValidOpenHost(u.hostname)) return null;
      return raw;
    } catch {
      return null;
    }
  }
  if (/\s/.test(raw)) return null;
  if (isValidHttpUrl(`https://${raw}`)) {
    try {
      const u = new URL(`https://${raw}`);
      if (!isValidOpenHost(u.hostname)) return null;
      return `https://${raw}`;
    } catch {
      return null;
    }
  }
  return null;
}

function openExternalUrl(url) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let cmd = 'open';
    let args = [url];
    if (platform === 'linux') {
      cmd = 'xdg-open';
    } else if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    }
    execFile(cmd, args, (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

function openDesktopApp(appName) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    if (platform === 'darwin') {
      execFile('open', ['-a', appName], (err) => {
        if (err) return reject(err);
        resolve(true);
      });
      return;
    }
    if (platform === 'linux') {
      execFile('xdg-open', [appName], (err) => {
        if (err) return reject(err);
        resolve(true);
      });
      return;
    }
    if (platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', appName], (err) => {
        if (err) return reject(err);
        resolve(true);
      });
      return;
    }
    reject(new Error('Unsupported OS for app launch.'));
  });
}

function closeBrowserTab(target = '') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      return reject(new Error('close tab is currently supported on macOS only.'));
    }
    const parsed = parseCloseTarget(target);
    const hint = escapeAppleScriptString(String(parsed.hint || '').trim().toLowerCase());
    const preferredApp = escapeAppleScriptString(String(parsed.browser || ''));
    const closeCount = Number(parsed.count || 1);
    const script = [
      `set hintText to "${hint}"`,
      `set preferredApp to "${preferredApp}"`,
      `set closeCount to ${closeCount}`,
      'set frontApp to ""',
      'set targetApp to ""',
      'set browserPriority to {"Safari", "Google Chrome", "Arc", "Brave Browser", "Microsoft Edge"}',
      'tell application "System Events"',
      '  set frontApp to name of first application process whose frontmost is true',
      'end tell',
      'if preferredApp is not "" then',
      '  set targetApp to preferredApp',
      'else if browserPriority contains frontApp then',
      '  set targetApp to frontApp',
      'else',
      '  repeat with b in browserPriority',
      '    set appName to b as text',
      '    if application appName is running then',
      '      try',
      '        if appName is "Safari" then',
      '          tell application "Safari" to set hasWindow to ((count of windows) > 0)',
      '        else',
      '          using terms from application "Google Chrome"',
      '            tell application appName to set hasWindow to ((count of windows) > 0)',
      '          end using terms from',
      '        end if',
      '        if hasWindow then',
      '          set targetApp to appName',
      '          exit repeat',
      '        end if',
      '      end try',
      '    end if',
      '  end repeat',
      'end if',
      'if targetApp is "" then return "unsupported:" & frontApp',
      'set closedCount to 0',
      'if targetApp is "Safari" then',
      '  tell application "Safari"',
      '    if (count of windows) is 0 then return "no_windows:Safari"',
      '    repeat with x from 1 to closeCount',
      '      set hitIndex to 0',
      '      set hitWindow to 0',
      '      set tabCount to count of tabs of front window',
      '      if hintText is not "" then',
      '        set winCount to count of windows',
      '        repeat with w from 1 to winCount',
      '          set tabCount to count of tabs of window w',
      '          repeat with i from 1 to tabCount',
      '            set t to tab i of window w',
      '            set u to URL of t',
      '            set n to name of t',
      '            if (u is not missing value and u contains hintText) or (n is not missing value and n contains hintText) then',
      '              set hitWindow to w',
      '              set hitIndex to i',
      '              exit repeat',
      '            end if',
      '          end repeat',
      '          if hitWindow is not 0 then exit repeat',
      '        end repeat',
      '        if hitIndex is 0 then exit repeat',
      '        set index of window hitWindow to 1',
      '        set current tab of front window to tab hitIndex of front window',
      '      end if',
      '      close current tab of front window',
      '      set closedCount to closedCount + 1',
      '    end repeat',
      '    if closedCount is 0 then return "not_found:Safari"',
      '    return "closed:Safari:" & closedCount',
      '  end tell',
      'end if',
      'if targetApp is "Google Chrome" or targetApp is "Brave Browser" or targetApp is "Arc" or targetApp is "Microsoft Edge" then',
      '  using terms from application "Google Chrome"',
      '    tell application targetApp',
      '      if (count of windows) is 0 then return "no_windows:" & targetApp',
      '      repeat with x from 1 to closeCount',
      '        set hitIndex to 0',
      '        set hitWindow to 0',
      '        set tabCount to count of tabs of front window',
      '        if hintText is not "" then',
      '          set winCount to count of windows',
      '          repeat with w from 1 to winCount',
      '            set tabCount to count of tabs of window w',
      '            repeat with i from 1 to tabCount',
      '              set t to tab i of window w',
      '              set u to URL of t',
      '              set n to title of t',
      '              if (u is not missing value and u contains hintText) or (n is not missing value and n contains hintText) then',
      '                set hitWindow to w',
      '                set hitIndex to i',
      '                exit repeat',
      '              end if',
      '            end repeat',
      '            if hitWindow is not 0 then exit repeat',
      '          end repeat',
      '          if hitIndex is 0 then exit repeat',
      '          set index of window hitWindow to 1',
      '          set active tab index of front window to hitIndex',
      '        end if',
      '        if hintText is "" then',
      '          set index of front window to 1',
      '          set active tab index of front window to active tab index of front window',
      '        end if',
      '        close active tab of front window',
      '        set closedCount to closedCount + 1',
      '      end repeat',
      '      if closedCount is 0 then return "not_found:" & targetApp',
      '      return "closed:" & targetApp & ":" & closedCount',
      '    end tell',
      '  end using terms from',
      'end if',
      'return "unsupported:" & targetApp',
    ];
    execFile('osascript', script.flatMap((line) => ['-e', line]), (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'failed to close tab').trim()));
      const out = String(stdout || '').trim();
      if (out.startsWith('closed:')) {
        const parts = out.split(':');
        const app = parts[1] || 'browser';
        const count = Number(parts[2] || 1);
        const displayHint = parsed.hint || target;
        if (displayHint) return resolve(`Closed ${count} tab(s) in ${app} matching "${displayHint}".`);
        return resolve(`Closed ${count} tab(s) in ${app}.`);
      }
      if (out.startsWith('not_found:')) {
        const app = out.slice('not_found:'.length).trim() || 'browser';
        const displayHint = parsed.hint || target;
        return reject(new Error(`No tab matched "${displayHint || 'requested target'}" in ${app}.`));
      }
      if (out.startsWith('no_windows:')) {
        const app = out.slice('no_windows:'.length).trim() || 'browser';
        return reject(new Error(`${app} has no open windows.`));
      }
      if (out.startsWith('unsupported:')) {
        const app = out.slice('unsupported:'.length).trim() || 'unknown app';
        return reject(new Error(`Front app "${app}" is not a supported browser.`));
      }
      resolve('Closed active tab.');
    });
  });
}

function normalizeSiteKey(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.-]+/g, '');
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const dp = Array.from({ length: s.length + 1 }, () => Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

function parseCloseTarget(raw) {
  const input = normalizeUtterance(raw || '');
  const browser = /\bsafari\b/.test(input)
    ? 'Safari'
    : /\b(chrome|google chrome)\b/.test(input)
      ? 'Google Chrome'
      : /\barc\b/.test(input)
        ? 'Arc'
        : /\b(brave|brave browser)\b/.test(input)
          ? 'Brave Browser'
          : /\b(edge|microsoft edge)\b/.test(input)
            ? 'Microsoft Edge'
            : '';
  const n = input.match(/\b(1|one|2|two|3|three|4|four|5|five)\b/);
  const countMap = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const count = Math.min(5, Math.max(1, Number(countMap[n?.[1]] || n?.[1] || 1)));

  let hint = input
    .replace(/\b(close|tab|tabs|in|on|from|the|a|an|please|pls|window|windows)\b/g, ' ')
    .replace(/\b(1|one|2|two|3|three|4|four|5|five)\b/g, ' ')
    .replace(/\b(safari|chrome|google chrome|arc|brave|brave browser|edge|microsoft edge)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = hint.split(' ').filter(Boolean);
  const aliases = ['youtube', 'tradingview', 'databento', 'openai', 'dashboard'];
  for (const w of words) {
    if (w === 'yt' || w.includes('youtu')) {
      hint = 'youtube';
      break;
    }
    for (const a of aliases) {
      if (levenshtein(w, a) <= 2) {
        hint = a;
        break;
      }
    }
    if (aliases.includes(hint)) break;
  }

  return { hint, browser, count };
}

function resolveSiteKey(input, siteMap) {
  if (!siteMap || typeof siteMap.get !== 'function') return null;
  const raw = String(input || '').trim();
  if (!raw) return null;
  const clean = normalizeSiteKey(raw);
  if (!clean) return null;
  const variants = new Set([
    clean,
    clean.replace(/\.(com|net|org|io|ai)$/, ''),
    clean.split('.')[0],
  ]);
  if (clean === 'yt') variants.add('youtube');
  if (clean === 'tv') variants.add('tradingview');
  if (clean === 'db') variants.add('databento');
  for (const key of variants) {
    if (siteMap.has(key)) return key;
  }
  return null;
}

function runDoctor(projectRoot) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['run', 'doctor'], {
      cwd: projectRoot,
      timeout: 8 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error((stderr || stdout || err.message || 'doctor failed').slice(0, 1800)));
      }
      const out = String(stdout || '');
      const lines = out.trim().split('\n').slice(-25).join('\n');
      resolve(lines || 'doctor complete');
    });
  });
}

function allowedByPolicy(message, cfg) {
  const allowUsers = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [];
  const allowChannels = Array.isArray(cfg.allowedChannelIds) ? cfg.allowedChannelIds : [];
  if (allowUsers.length > 0 && !allowUsers.includes(message.author.id)) return false;
  const isDirectMessage = message.guildId == null;
  if (isDirectMessage) return true;
  if (allowChannels.length > 0 && !allowChannels.includes(message.channelId)) return false;
  return true;
}

function normalizeOutcomeWord(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (['win', 'won', 'tp', 'takeprofit', 'take_profit', 'profit', 'green'].includes(s)) return 'win';
  if (['loss', 'lose', 'lost', 'sl', 'stoploss', 'stop_loss', 'red'].includes(s)) return 'loss';
  if (['breakeven', 'break-even', 'break_even', 'be', 'b/e', 'flat'].includes(s)) return 'breakeven';
  return null;
}

function extractPnlFromText(input) {
  const m = String(input || '').match(/(?:\$|usd\s*)?([+-]?\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function resolveRole(userId, cfg) {
  const admins = new Set(Array.isArray(cfg.adminUserIds) ? cfg.adminUserIds : []);
  const viewers = new Set(Array.isArray(cfg.viewerUserIds) ? cfg.viewerUserIds : []);
  if (admins.has(userId)) return 'admin';
  if (viewers.has(userId)) return 'viewer';
  return 'operator';
}

function hasPermission(role, action) {
  const matrix = {
    view: ['viewer', 'operator', 'admin'],
    operate: ['operator', 'admin'],
    high_power: ['operator', 'admin'],
    admin_only: ['admin'],
  };
  return (matrix[action] || []).includes(role);
}

function buildSiteMap(cfg) {
  const out = new Map();
  const raw = Array.isArray(cfg.allowedSites) ? cfg.allowedSites : [];
  for (const entry of raw) {
    const txt = String(entry || '').trim();
    if (!txt) continue;
    if (txt.includes('=')) {
      const [keyRaw, urlRaw] = txt.split('=');
      const key = keyRaw.trim().toLowerCase();
      const url = normalizeOpenUrl(urlRaw.trim());
      if (key && url) out.set(key, url);
      continue;
    }
    const asUrl = normalizeOpenUrl(txt);
    if (asUrl) {
      try {
        const host = new URL(asUrl).hostname.replace(/^www\./, '').toLowerCase();
        out.set(host, asUrl);
      } catch {}
      out.set(txt.toLowerCase(), asUrl);
    }
  }
  if (!out.has('dashboard')) out.set('dashboard', 'http://localhost:3131');
  if (!out.has('youtube')) out.set('youtube', 'https://www.youtube.com');
  if (!out.has('openai')) out.set('openai', 'https://platform.openai.com');
  if (!out.has('tradingview')) out.set('tradingview', 'https://www.tradingview.com');
  if (!out.has('databento')) out.set('databento', 'https://databento.com');
  return out;
}

function shortHelp(prefix) {
  return [
    `Commands (${prefix} ...):`,
    'help | capabilities',
    'status | system | opps | plan | tradestate | panel | autonomy | deskstart',
    'outcome <win|loss|breakeven> [pnl_dollars] [notes]',
    'scan [two_stage|full_scan]',
    'mode <manual|paper_auto|live_assist>  (admin)',
    'buy <qty> [symbol] | sell <qty> [symbol]  (two-step)',
    'halt | resume',
    'open <url> | youtube <url|query> | site <key>',
    'closetab [hint]  (close active browser tab)',
    'pcapp <AppName>  (guarded)',
    'workflow <doctor|scan_two_stage|scan_full|open_dashboard>  (guarded)',
    'approve <candidate_id> | reject <candidate_id> [reason]',
    'doctor',
    'confirm <TOKEN> | cancel <TOKEN>',
  ].join('\n');
}

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

function normalizeUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.:/-]/g, '')
    .trim();
}

function tokenSet(text) {
  return new Set(normalizeUtterance(text).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const t of aa) if (bb.has(t)) inter += 1;
  const union = aa.size + bb.size - inter;
  return union > 0 ? inter / union : 0;
}

function stripConversationalPrefix(input) {
  return String(input || '')
    .replace(/^\s*(hey|yo|bro|please|pls|can you|could you|would you|will you|i need you to|my)\s+/i, '')
    .trim();
}

function isGreetingOnlyInput(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return false;
  const hasGreeting = /\b(hi|hey|hello|yo|sup|what'?s up|good morning|good afternoon|good evening|how are you|how'?s it going|how is it going)\b/.test(raw);
  if (!hasGreeting) return false;
  const hasActionOrMarketIntent = /\b(status|plan|outlook|gameplan|sync|refresh|update|trade|setup|signal|market|mnq|price|entry|enter|buy|sell|long|short|position|pnl|opportunit|intel|scan|doctor|system|autonomy|open|close|run|execute)\b/.test(raw);
  return !hasActionOrMarketIntent;
}

function inferPlainEnglishCommand(text, ctx = {}) {
  const raw = stripConversationalPrefix(text);
  if (!raw) return null;
  const appAllow = ctx.appAllow || new Set();
  const siteMap = ctx.siteMap;

  const confirmMatch = raw.match(/\bconfirm\b\s+([A-Za-z0-9]+)/i);
  if (confirmMatch) return `confirm ${confirmMatch[1].toUpperCase()}`;
  const cancelMatch = raw.match(/\bcancel\b\s+([A-Za-z0-9]+)/i);
  if (cancelMatch) return `cancel ${cancelMatch[1].toUpperCase()}`;

  if (/\b(help|what can you do|commands?)\b/i.test(raw)) return 'help';
  if (/\b(capabilities|abilities|what.*control)\b/i.test(raw)) return 'capabilities';
  if (/\b(daily|today).*(plan|setup|guide)\b/i.test(raw) || /\bwhat.*(trade|setup).*(today)\b/i.test(raw)) return 'plan';
  if (/\b(outlook|gameplan|game plan|plan for today|todays outlook|today's outlook|morning outlook|market outlook)\b/i.test(raw)) return 'plan';
  if (/\bhow\b.*\btrade\b.*\b(today|this morning|morning)\b/i.test(raw)) return 'plan';
  if (/\b(how should i trade|how do i trade|what should i do today)\b/i.test(raw)) return 'plan';
  if (/\b(desk start|start sequence|trading checklist|pre[-\s]?market checklist)\b/i.test(raw)) return 'deskstart';
  if (/\b(autonomy|auto mode|execution mode|autotrade mode)\b/i.test(raw)) {
    if (/\bmanual\b/i.test(raw)) return 'mode manual';
    if (/\bpaper\b/i.test(raw)) return 'mode paper_auto';
    if (/\blive assist|assist\b/i.test(raw)) return 'mode live_assist';
    if (/\brun\b|\bcycle\b|\bcheck now\b/i.test(raw)) return 'autonomy run';
    return 'autonomy';
  }
  if (/\b(control panel|session panel|panel)\b/i.test(raw)) return 'panel';
  if (/\b(trade state|position|pnl|in profit|in loss)\b/i.test(raw)) return 'tradestate';
  if (/\b(liveintel|live intel|live intelligence|market intelligence|current conditions)\b/i.test(raw)) return 'liveintel';
  if (/\b(hit tp|tp hit|take profit|trade won|i won|winner|green trade)\b/i.test(raw)) {
    const v = extractPnlFromText(raw);
    return Number.isFinite(v) ? `outcome win ${v}` : 'outcome win';
  }
  if (/\b(hit sl|sl hit|stop loss|stopped out|trade lost|i lost|red trade)\b/i.test(raw)) {
    const v = extractPnlFromText(raw);
    return Number.isFinite(v) ? `outcome loss ${v}` : 'outcome loss';
  }
  if (/\b(breakeven|break even|b\/e|be trade|flat trade)\b/i.test(raw)) {
    const v = extractPnlFromText(raw);
    return Number.isFinite(v) ? `outcome breakeven ${v}` : 'outcome breakeven';
  }
  if (/\b(outcome|result)\b/i.test(raw) && /\b(win|loss|breakeven|break even)\b/i.test(raw)) {
    const status = /\b(win)\b/i.test(raw) ? 'win' : /\b(loss)\b/i.test(raw) ? 'loss' : 'breakeven';
    const v = extractPnlFromText(raw);
    return Number.isFinite(v) ? `outcome ${status} ${v}` : `outcome ${status}`;
  }
  if (/\b(system|cpu|memory|ram|machine)\b/i.test(raw)) return 'system';
  if (/\b(status|health|uptime)\b/i.test(raw)) return 'status';
  if (/\b(opportunit|setups?|ideas?)\b/i.test(raw)) return 'opps';

  if (/\b(run|start|do).*(scan|discovery)\b/i.test(raw) || /\bscan\b/i.test(raw)) {
    if (/\bfull\b/i.test(raw)) return 'scan full_scan';
    return 'scan two_stage';
  }

  if (/\bdoctor\b/i.test(raw) || /\b(check|test).*(scripts?|system)\b/i.test(raw)) return 'doctor';

  const closeTabMatch = raw.match(/\bclose\b\s*(.+?)?\s*\btabs?\b/i);
  if (closeTabMatch) {
    const hint = String(closeTabMatch[1] || '').trim();
    return hint ? `closetab ${hint}` : 'closetab';
  }
  if (/\bclose\s+tabs?\b/i.test(raw)) return 'closetab';
  const closeAnyMatch = raw.match(/\bclose\b\s+(.+)$/i);
  if (closeAnyMatch) {
    const hint = String(closeAnyMatch[1] || '').trim();
    const siteKey = resolveSiteKey(hint, siteMap);
    if (siteKey) return `closetab ${siteKey}`;
    if (hint) return `closetab ${hint}`;
  }

  const approveMatch = raw.match(/\bapprove\b[^\d]*(\d+)/i);
  if (approveMatch) return `approve ${approveMatch[1]}`;
  const rejectMatch = raw.match(/\breject\b[^\d]*(\d+)(.*)$/i);
  if (rejectMatch) {
    const reason = String(rejectMatch[2] || '').trim();
    return reason ? `reject ${rejectMatch[1]} ${reason}` : `reject ${rejectMatch[1]}`;
  }

  const url = extractFirstUrl(raw);
  if (url) {
    if (/youtube\.com|youtu\.be/i.test(url)) return `youtube ${url}`;
    return `open ${url}`;
  }

  if (/\bdashboard\b/i.test(raw)) return 'site dashboard';
  if (/\b(openai)\b/i.test(raw)) return 'site openai';
  if (/^\s*(youtube|yt)\b/i.test(raw)) return 'site youtube';
  if (/\b(open|launch|start)\b.*\b(youtube|yt)\b/i.test(raw)) return 'site youtube';
  if (/\b(play|watch)\b.*\b(youtube|yt)\b/i.test(raw)) {
    const q = raw.replace(/.*\b(youtube|play)\b[:\s-]*/i, '').trim();
    return q ? `youtube ${q}` : 'site youtube';
  }

  const openAppMatch = raw.match(/\b(open|launch|start)\b\s+(.+)/i);
  if (openAppMatch) {
    const target = openAppMatch[2].trim();
    const appCandidate = target.replace(/\b(app|application|for me|please)\b/gi, '').trim();
    if (appAllow.has(appCandidate.toLowerCase())) return `pcapp ${appCandidate}`;
    if (appAllow.has(target.toLowerCase())) return `pcapp ${target}`;
    const siteKey = resolveSiteKey(target, siteMap);
    if (siteKey) return `site ${siteKey}`;
    if (normalizeOpenUrl(target)) return `open ${target}`;
  }

  if (/\bworkflow\b/i.test(raw)) {
    if (/\bdoctor\b/i.test(raw)) return 'workflow doctor';
    if (/\bfull\b/i.test(raw)) return 'workflow scan_full';
    if (/\bscan|discovery|two[\s-]?stage\b/i.test(raw)) return 'workflow scan_two_stage';
    if (/\bdashboard\b/i.test(raw)) return 'workflow open_dashboard';
  }

  const buyMatch = raw.match(/\b(buy|go long)\b[^\d]*(\d+)?\s*([A-Za-z]{1,6})?/i);
  if (buyMatch) return `buy ${buyMatch[2] || 1} ${buyMatch[3] || 'MNQ'}`.trim();
  const sellMatch = raw.match(/\b(sell|go short)\b[^\d]*(\d+)?\s*([A-Za-z]{1,6})?/i);
  if (sellMatch) return `sell ${sellMatch[2] || 1} ${sellMatch[3] || 'MNQ'}`.trim();
  if (/\b(halt|stop trading|kill switch)\b/i.test(raw)) return 'halt';
  if (/\b(resume|enable trading|turn trading on)\b/i.test(raw)) return 'resume';

  return null;
}

function isLearnableInterpreterCommand(command, source = 'unknown') {
  if (source === 'memory') return false;
  const normalized = String(command || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  const cmd = normalized.split(' ')[0].toLowerCase();
  if ([
    'open',
    'youtube',
    'closetab',
    'buy',
    'sell',
    'approve',
    'reject',
    'confirm',
    'cancel',
    'outcome',
    'pcapp',
  ].includes(cmd)) return false;
  if (cmd === 'site') return /^site\s+[a-z0-9.-]+$/i.test(normalized);
  if (cmd === 'scan') return /^(scan\s+(two_stage|full_scan))$/i.test(normalized);
  if (cmd === 'mode') return /^(mode\s+(manual|paper_auto|live_assist))$/i.test(normalized);
  if (cmd === 'workflow') return /^(workflow\s+(doctor|scan_two_stage|scan_full|open_dashboard))$/i.test(normalized);
  return [
    'help',
    'capabilities',
    'status',
    'plan',
    'tradestate',
    'panel',
    'autonomy',
    'deskstart',
    'system',
    'opps',
    'liveintel',
    'doctor',
    'halt',
    'resume',
  ].includes(cmd);
}

function getAllowedCommands() {
  return new Set(['help', 'capabilities', 'status', 'plan', 'tradestate', 'panel', 'autonomy', 'mode', 'deskstart', 'outcome', 'system', 'opps', 'liveintel', 'scan', 'open', 'youtube', 'site', 'closetab', 'pcapp', 'workflow', 'approve', 'reject', 'doctor', 'halt', 'resume', 'buy', 'sell', 'confirm', 'cancel']);
}

function validateInterpretedCommand(raw, ctx = {}) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1).join(' ').trim();
  const allowed = getAllowedCommands();
  if (!allowed.has(cmd)) return null;

  if (cmd === 'open') {
    const url = normalizeOpenUrl(rest);
    return url ? `open ${url}` : null;
  }
  if (cmd === 'site') {
    const key = resolveSiteKey(rest, ctx.siteMap);
    return key ? `site ${key}` : null;
  }
  if (cmd === 'youtube') {
    if (!rest) return null;
    const url = normalizeOpenUrl(rest);
    return url ? `youtube ${url}` : `youtube ${rest}`;
  }
  if (cmd === 'pcapp') {
    const app = rest.trim();
    if (!app) return null;
    const appAllow = ctx.appAllow || new Set();
    if (!appAllow.has(app.toLowerCase())) return null;
    return `pcapp ${app}`;
  }
  if (cmd === 'scan') {
    return /\bfull/i.test(rest) ? 'scan full_scan' : 'scan two_stage';
  }
  if (cmd === 'deskstart') return 'deskstart';
  if (cmd === 'outcome') {
    const toks = rest.split(/\s+/).filter(Boolean);
    const status = normalizeOutcomeWord(toks.shift());
    if (!status) return null;
    let pnl = null;
    if (toks.length && /^[-+]?\$?\d+(\.\d+)?$/.test(toks[0])) {
      pnl = Number(String(toks.shift()).replace('$', ''));
      if (!Number.isFinite(pnl)) pnl = null;
    }
    const notes = toks.join(' ').trim();
    return `outcome ${status}${Number.isFinite(pnl) ? ` ${pnl}` : ''}${notes ? ` ${notes}` : ''}`;
  }
  if (cmd === 'autonomy') {
    if (!rest) return 'autonomy';
    if (/\brun\b/i.test(rest)) return 'autonomy run';
    return 'autonomy';
  }
  if (cmd === 'mode') {
    const mode = String(rest || '').toLowerCase();
    if (!['manual', 'paper_auto', 'live_assist'].includes(mode)) return null;
    return `mode ${mode}`;
  }
  if (cmd === 'workflow') {
    const wf = String(rest || '').toLowerCase();
    if (!['doctor', 'scan_two_stage', 'scan_full', 'open_dashboard'].includes(wf)) return null;
    return `workflow ${wf}`;
  }
  if (cmd === 'buy' || cmd === 'sell') {
    const m = rest.match(/(\d+)?\s*([A-Za-z]{1,6})?/);
    if (!m) return null;
    const qty = Math.max(1, Number(m[1] || 1));
    const symbol = String(m[2] || 'MNQ').toUpperCase();
    return `${cmd} ${qty} ${symbol}`;
  }
  if (cmd === 'approve' || cmd === 'reject') {
    const m = rest.match(/^(\d+)(.*)$/);
    if (!m) return null;
    const id = Number(m[1]);
    if (!id) return null;
    const reason = String(m[2] || '').trim();
    return reason ? `${cmd} ${id} ${reason}` : `${cmd} ${id}`;
  }
  if (cmd === 'confirm' || cmd === 'cancel') {
    const tok = String(rest || '').trim().toUpperCase();
    return tok ? `${cmd} ${tok}` : null;
  }
  if (cmd === 'closetab') return rest ? `closetab ${rest}` : 'closetab';
  return cmd;
}

async function inferPlainEnglishWithAI(text, ctx = {}) {
  const apiKey = String(ctx.openaiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  if (AI_INTERPRETER_PROVIDER !== 'openai') return null;
  const input = String(text || '').trim();
  if (!input) return null;

  const siteKeys = Array.from(ctx.siteMap?.keys?.() || []).slice(0, 40);
  const appKeys = Array.from(ctx.appAllow?.values?.() || []).slice(0, 40);
  const prompt = [
    'You are the natural-language interpreter for a local Discord control bot.',
    'Decide if the user wants executable actions or just a conversational answer.',
    'Return strict JSON only in one of these forms:',
    '{"type":"command","command":"...","confidence":0-1}',
    '{"type":"commands","commands":["...","..."],"confidence":0-1}',
    '{"type":"reply","reply":"...","confidence":0-1}',
    'Allowed commands:',
    'help, capabilities, status, plan, tradestate, panel, autonomy, mode, deskstart, outcome, system, opps, liveintel, doctor, halt, resume',
    'scan two_stage|full_scan',
    'open <https://url>, youtube <url or query>, site <key>, closetab [hint]',
    'pcapp <allowed app>, workflow doctor|scan_two_stage|scan_full|open_dashboard',
    'buy <qty> <symbol>, sell <qty> <symbol>, approve <id>, reject <id> [reason], outcome <win|loss|breakeven> [pnl] [notes], confirm <TOKEN>, cancel <TOKEN>',
    'autonomy [run], mode <manual|paper_auto|live_assist>',
    `Allowed site keys: ${siteKeys.join(', ') || 'dashboard,youtube,openai,tradingview,databento'}`,
    `Allowed app names: ${appKeys.join(', ') || 'Safari,Discord,Notes,Calendar,Music'}`,
    'Rules:',
    '- If user says open a known site by name (youtube/openai/tradingview/databento/dashboard), use site <key>.',
    '- For "close X tab" use closetab X.',
    '- "outlook", "morning outlook", "today plan", "game plan", "how should i trade this morning" should map to: plan',
    '- "hit tp", "stopped out", "i won", "i lost", "breakeven" should map to: outcome ...',
    '- For multi-step requests, use type=commands with 1-4 safe commands in execution order.',
    '- Prefer execution over reply when user clearly asks to do something.',
    '- If user is asking a question (not an action), use type=reply and answer briefly/helpfully.',
    '- Never output shell commands or extra text.',
    '- If unclear, output {"type":"reply","reply":"I am not sure what action you want. Ask in one sentence and I will execute it.","confidence":0.2}.',
    `Message: ${input}`,
  ].join('\n');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_INTERPRETER_MODEL,
        max_tokens: 160,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const msg = data?.choices?.[0]?.message;
    const txt = typeof msg?.content === 'string'
      ? msg.content
      : Array.isArray(msg?.content)
        ? msg.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim()
        : '';
    const parsed = JSON.parse(String(txt || '{}'));
    const confidence = Number(parsed?.confidence || 0);
    if (confidence < 0.25) return null;
    const type = String(parsed?.type || '').toLowerCase();
    if (type === 'reply') {
      const reply = String(parsed?.reply || '').trim();
      if (!reply) return null;
      return { type: 'reply', reply };
    }
    if (type === 'commands') {
      const rawList = Array.isArray(parsed?.commands) ? parsed.commands : [];
      const commands = rawList
        .map((c) => validateInterpretedCommand(c, ctx))
        .filter(Boolean)
        .slice(0, 4);
      if (!commands.length) return null;
      return { type: 'commands', commands };
    }
    const command = validateInterpretedCommand(parsed?.command, ctx);
    if (command) return { type: 'command', command };
    return null;
  } catch {
    return null;
  }
}

function dedupeCommands(commands = []) {
  const out = [];
  const seen = new Set();
  for (const c of commands) {
    const key = String(c || '').trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(c).trim());
  }
  return out.slice(0, 4);
}

function loadInterpreterMemory(projectRoot) {
  try {
    const filePath = path.join(projectRoot, 'data', 'discord-interpreter-memory.json');
    if (!fs.existsSync(filePath)) return { filePath, entries: [] };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = (Array.isArray(parsed?.entries) ? parsed.entries : []).filter((entry) => {
      const command = String(entry?.command || '').trim().toLowerCase();
      const key = String(entry?.key || '').trim();
      if (!command || !key) return false;
      if (command !== 'status') return true;
      return !isGreetingOnlyInput(key);
    });
    return { filePath, entries };
  } catch {
    return { filePath: path.join(projectRoot, 'data', 'discord-interpreter-memory.json'), entries: [] };
  }
}

function saveInterpreterMemory(memory) {
  try {
    const dir = path.dirname(memory.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), entries: memory.entries.slice(0, 500) };
    fs.writeFileSync(memory.filePath, JSON.stringify(payload, null, 2));
  } catch {}
}

function rememberInterpreterMapping(memory, utterance, command, source = 'unknown') {
  const key = normalizeUtterance(utterance);
  if (!key || key.length < 3) return;
  if (!isLearnableInterpreterCommand(command, source)) return;
  const now = Date.now();
  const found = memory.entries.find(e => e.key === key);
  if (found) {
    found.command = command;
    found.hits = Number(found.hits || 0) + 1;
    found.updatedAt = now;
  } else {
    memory.entries.unshift({ key, command, hits: 1, updatedAt: now });
  }
  memory.entries.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (memory.entries.length > 500) memory.entries.length = 500;
  saveInterpreterMemory(memory);
}

function inferFromInterpreterMemory(memory, text, ctx = {}) {
  const key = normalizeUtterance(text);
  if (!key) return null;
  const exact = memory.entries.find(e => e.key === key);
  if (exact) return validateInterpretedCommand(exact.command, ctx);

  let best = null;
  let bestScore = 0;
  for (const e of memory.entries.slice(0, 200)) {
    const score = jaccard(e.key, key);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (best && bestScore >= 0.82) return validateInterpretedCommand(best.command, ctx);
  return null;
}

function slashDefs(siteKeys) {
  const siteChoices = Array.from(siteKeys).slice(0, 25).map(k => ({ name: k, value: k }));
  return [
    { name: 'help', description: 'Show available 3130 assistant commands' },
    { name: 'capabilities', description: 'List what this assistant can control on your PC' },
    { name: 'status', description: 'Get current 3130 system status' },
    { name: 'plan', description: 'Get daily trading plan (ORB/day-of-week/performance)' },
    { name: 'tradestate', description: 'Get live trade state and PnL snapshot' },
    { name: 'panel', description: 'Get full session control panel status' },
    { name: 'autonomy', description: 'Show autonomy mode/status and recent autonomous events' },
    { name: 'deskstart', description: 'Run the desk start sequence (decision + checklist)' },
    {
      name: 'outcome',
      description: 'Log today trade outcome for learning loop',
      options: [
        { type: 3, name: 'status', description: 'win | loss | breakeven', required: true, choices: [{ name: 'win', value: 'win' }, { name: 'loss', value: 'loss' }, { name: 'breakeven', value: 'breakeven' }] },
        { type: 3, name: 'pnl', description: 'Optional pnl dollars (e.g. 125.5 or -90)', required: false },
        { type: 3, name: 'notes', description: 'Optional notes', required: false },
      ],
    },
    { name: 'system', description: 'Get local machine telemetry snapshot' },
    {
      name: 'scan',
      description: 'Run discovery scan',
      options: [{ type: 3, name: 'mode', description: 'two_stage or full_scan', required: false, choices: [{ name: 'two_stage', value: 'two_stage' }, { name: 'full_scan', value: 'full_scan' }] }],
    },
    { name: 'opps', description: 'List top live-eligible opportunities' },
    { name: 'open', description: 'Open a URL in browser on this PC', options: [{ type: 3, name: 'url', description: 'https://...', required: true }] },
    { name: 'youtube', description: 'Open YouTube URL or search on this PC', options: [{ type: 3, name: 'query', description: 'URL or search text', required: true }] },
    { name: 'site', description: 'Open an allowlisted site by key', options: [{ type: 3, name: 'key', description: 'site key', required: true, choices: siteChoices.length ? siteChoices : undefined }] },
    { name: 'closetab', description: 'Close the active tab in the frontmost supported browser', options: [{ type: 3, name: 'hint', description: 'Optional tab/site hint', required: false }] },
    { name: 'pcapp', description: 'Guarded: open an allowed desktop app', options: [{ type: 3, name: 'name', description: 'Safari, Notes, Discord, etc.', required: true }] },
    { name: 'workflow', description: 'Guarded: run a predefined workflow', options: [{ type: 3, name: 'name', description: 'workflow name', required: true, choices: [{ name: 'doctor', value: 'doctor' }, { name: 'scan_two_stage', value: 'scan_two_stage' }, { name: 'scan_full', value: 'scan_full' }, { name: 'open_dashboard', value: 'open_dashboard' }] }] },
    { name: 'approve', description: 'Approve promotion for a candidate', options: [{ type: 4, name: 'candidate_id', description: 'Discovery candidate id', required: true }] },
    { name: 'reject', description: 'Reject promotion for a candidate', options: [{ type: 4, name: 'candidate_id', description: 'Discovery candidate id', required: true }, { type: 3, name: 'reason', description: 'Reason (optional)', required: false }] },
    { name: 'buy', description: 'Create guarded BUY order intent', options: [{ type: 4, name: 'qty', description: 'Quantity', required: true }, { type: 3, name: 'symbol', description: 'Symbol', required: false }] },
    { name: 'sell', description: 'Create guarded SELL order intent', options: [{ type: 4, name: 'qty', description: 'Quantity', required: true }, { type: 3, name: 'symbol', description: 'Symbol', required: false }] },
    { name: 'halt', description: 'Admin: activate execution kill switch' },
    { name: 'resume', description: 'Admin: clear execution kill switch' },
    { name: 'doctor', description: 'Run full doctor checks (preflight/tests/build)' },
  ].map((d) => {
    if (Array.isArray(d.options)) d.options = d.options.filter(Boolean);
    return d;
  });
}

function createDiscordControlBot({ config, projectRoot, handlers }) {
  const token = config?.botToken || null;
  const prefix = config?.commandPrefix || '!3130';
  if (!token) {
    return {
      enabled: false,
      start: async () => null,
      stop: async () => null,
      restart: async () => null,
      getStatus: () => ({
        connected: false,
        ready: false,
        lastReadyAt: null,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        loginAttempts: 0,
        reconnects: 0,
      }),
    };
  }

  const siteMap = buildSiteMap(config);
  const appAllow = new Set((Array.isArray(config.allowedApps) ? config.allowedApps : []).map(a => String(a).toLowerCase()));
  const plainEnglishMode = config?.plainEnglishMode !== false;
  const openaiKey = process.env.OPENAI_API_KEY || null;
  const interpreterMemory = loadInterpreterMemory(projectRoot);
  const pendingActions = new Map();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });
  const runtime = {
    connected: false,
    ready: false,
    lastReadyAt: null,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    loginAttempts: 0,
    reconnects: 0,
  };

  const getCapabilitiesText = (role) => {
    const sites = Array.from(siteMap.keys()).slice(0, 12).join(', ');
    const apps = Array.from(appAllow.values()).slice(0, 12).join(', ');
    return [
      `Role: ${role}`,
      'Core: status, plan, system, opps, tradestate, panel, scan, doctor',
      'Desk start: one-command morning sequence (decision + checklist)',
      'Learning loop: outcome win/loss/breakeven [pnl] from DM or /outcome',
      'Autonomy: autonomy status, mode switch (admin), paper cycle trigger',
      'Execution: buy/sell intents (two-step), halt/resume (admin)',
      `Sites (allowlisted): ${sites || 'none'}`,
      `Apps (allowlisted): ${apps || 'none'}`,
      'High-power guarded: pcapp, workflow (confirm/cancel required)',
      'Approval actions: approve/reject candidates',
    ].join('\n');
  };

  const machineSummary = async () => {
    const total = os.totalmem();
    const free = os.freemem();
    const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
    const load = os.loadavg().map(v => v.toFixed(2)).join(', ');
    return `Host: ${os.hostname()} | OS: ${os.platform()} ${os.release()} | CPU cores: ${os.cpus().length} | Load(1/5/15): ${load} | Mem used: ${usedPct}%`;
  };

  const registerGuardedAction = ({ userId, channelId, description, execute }) => {
    const tokenId = crypto.randomBytes(3).toString('hex').toUpperCase();
    pendingActions.set(tokenId, { userId, channelId, description, execute, expiresAt: Date.now() + PENDING_TTL_MS });
    return tokenId;
  };

  const cleanupPending = () => {
    const now = Date.now();
    for (const [tokenId, action] of pendingActions.entries()) if (now > action.expiresAt) pendingActions.delete(tokenId);
  };

  const confirmGuarded = async (tokenId, userId) => {
    cleanupPending();
    const action = pendingActions.get(tokenId);
    if (!action) throw new Error('Token not found or expired.');
    if (action.userId !== userId) throw new Error('Only requesting user can confirm.');
    pendingActions.delete(tokenId);
    return action.execute();
  };

  const cancelGuarded = (tokenId, userId) => {
    cleanupPending();
    const action = pendingActions.get(tokenId);
    if (!action || action.userId !== userId) return false;
    pendingActions.delete(tokenId);
    return true;
  };

  const createGuardButtons = (tokenId) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`guard:run:${tokenId}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`guard:cancel:${tokenId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );

  const runWorkflow = async (name) => {
    if (name === 'doctor') return `Workflow doctor complete:\n${await runDoctor(projectRoot)}`;
    if (name === 'scan_two_stage') {
      const r = await handlers.runDiscovery('two_stage');
      return `Workflow scan_two_stage complete: ${r?.summary?.recommended || 0}/${r?.summary?.candidates || 0} live-eligible.`;
    }
    if (name === 'scan_full') {
      const r = await handlers.runDiscovery('full_scan');
      return `Workflow scan_full complete: ${r?.summary?.recommended || 0}/${r?.summary?.candidates || 0} live-eligible.`;
    }
    if (name === 'open_dashboard') {
      await openExternalUrl('http://localhost:3131');
      return 'Workflow open_dashboard complete: opened http://localhost:3131';
    }
    throw new Error('Unknown workflow.');
  };

  const proposeGuardedAction = async ({ replyFn, userId, channelId, description, execute }) => {
    const tokenId = registerGuardedAction({ userId, channelId, description, execute });
    await replyFn({ content: `Guarded action pending: ${description}\nToken: ${tokenId} (expires in 10 min)`, components: [createGuardButtons(tokenId)] });
  };

  const sendToPrimaryChannel = async (payload) => {
    const channelId = Array.isArray(config.allowedChannelIds) ? config.allowedChannelIds[0] : null;
    if (!channelId) return null;
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') return null;
    return channel.send(payload);
  };

  const replyTextOpportunities = async () => {
    const opps = await handlers.getOpportunities();
    if (!opps.length) return 'No live-eligible opportunities found in latest run.';
    return `\`\`\`\n${opps.slice(0, 5).map((o, i) => `${i + 1}. ${o.name} | score ${o.score} | WR ${o.testWR}% | PF ${o.testPF} | ${o.frequency}`).join('\n')}\n\`\`\``;
  };

  const formatTradeState = async () => {
    const snap = await handlers.getTradeState();
    const s = snap?.state || {};
    const symbol = s.symbol || 'MNQ';
    const qty = Number(s.qty || 0);
    const side = String(s.side || '').toUpperCase();
    const inPositionLine = s.inPosition
      ? `You are in a ${side} ${qty} ${symbol} position from ${s.entryPrice ?? 'an unknown entry'}.`
      : 'You are flat right now with no open position.';
    const markLine = s.inPosition
      ? `Current mark is ${s.lastPrice ?? 'not available'} and open PnL is ${s.pnlTicks ?? 0} ticks ($${Number(s.pnlDollars || 0).toFixed(2)}).`
      : `Latest tracked ${symbol} price is ${s.lastPrice ?? 'not available'}.`;
    const riskLine = s.inPosition
      ? `Risk left before daily guardrails: ${s.riskLeftDollars ?? 'not available'}.`
      : null;
    return [
      inPositionLine,
      markLine,
      `Realized PnL today is $${Number(snap?.realizedPnlDollars || 0).toFixed(2)}.`,
      riskLine,
    ].filter(Boolean).join('\n');
  };

  const formatPanel = async () => {
    const panel = await handlers.getSessionControlPanel();
    const p = panel?.panel || {};
    const plan = p.plan || {};
    const ex = p.execution || {};
    const blocked = (ex.blockedReasons || []).join(', ') || 'none';
    return [
      `Action: ${plan.action || 'not available'} | Setup: ${plan.setupQuality?.score || 0}/${plan.setupQuality?.grade || 'D'}`,
      `Regime: ORB ${plan.regime?.orbSize || 'not available'} | Vol ${plan.regime?.volatility || 'not available'} | Trend ${plan.regime?.trend || 'not available'}`,
      `Execution: ${ex.canActNow ? 'ACTIVE' : 'BLOCKED'} | KillSwitch: ${ex.controls?.killSwitch ? 'ON' : 'OFF'}`,
      `Max Size: ${ex.controls?.maxPositionSize || 1} | MaxDailyLoss: $${ex.controls?.maxDailyLossDollars || 0}`,
      `Blocked: ${blocked}`,
      `Allowed Actions: ${(ex.allowedActions || []).join(', ') || 'none'}`,
    ].join('\n');
  };

  const formatAutonomy = async () => {
    const snap = await handlers.getAutonomyState();
    const s = snap?.settings || {};
    const events = Array.isArray(snap?.recentEvents) ? snap.recentEvents : [];
    const last = events[0];
    const lastLine = last
      ? `${last.eventDate} ${last.eventTime} ${last.eventType} (${last.status})`
      : 'none';
    return [
      `Mode: ${s.mode || 'manual'}`,
      `Morning autopilot: ${s.proactiveMorningEnabled ? 'ON' : 'OFF'} @ ${s.proactiveMorningTime || '08:50'} (${s.proactiveTimezone || 'America/New_York'})`,
      `Paper auto: ${s.paperAutoEnabled ? 'ON' : 'OFF'} | Window ${s.paperAutoWindowStart || '09:45'}-${s.paperAutoWindowEnd || '11:00'}`,
      `Thresholds: setup>=${s.minSetupProbability || 55}% | confidence>=${s.minConfidencePct || 60}% | open-risk-clear=${s.requireOpenRiskClear ? 'yes' : 'no'}`,
      `Daily paper cap: ${s.maxPaperActionsPerDay || 2} | used today: ${s.lastPaperActionCount || 0}`,
      `Last event: ${lastLine}`,
    ].join('\n');
  };

  const requireRole = (role, action) => {
    if (!hasPermission(role, action)) throw new Error(`Permission denied for role ${role} on ${action}.`);
  };

  const handleCommand = async (message, text) => {
    const role = resolveRole(message.author.id, config);
    const args = text.trim().split(/\s+/).filter(Boolean);
    const cmd = (args.shift() || '').toLowerCase();
    const raw = text.slice(cmd.length).trim();

    if (!cmd || cmd === 'help') return message.reply(`\`\`\`\n${shortHelp(prefix)}\n\`\`\``);
    if (cmd === 'capabilities') return message.reply(`\`\`\`\n${getCapabilitiesText(role)}\n\`\`\``);
    if (cmd === 'status') { requireRole(role, 'view'); return message.reply(await handlers.getStatusSummary()); }
    if (cmd === 'plan') { requireRole(role, 'view'); return message.reply(`\`\`\`\n${await handlers.getDailyPlanText('original')}\n\`\`\``); }
    if (cmd === 'tradestate') { requireRole(role, 'view'); return message.reply(`\`\`\`\n${await formatTradeState()}\n\`\`\``); }
    if (cmd === 'panel') { requireRole(role, 'view'); return message.reply(`\`\`\`\n${await formatPanel()}\n\`\`\``); }
    if (cmd === 'deskstart') { requireRole(role, 'view'); return message.reply(`\`\`\`\n${await handlers.getDeskStartSequenceText('original')}\n\`\`\``); }
    if (cmd === 'outcome') {
      requireRole(role, 'operate');
      const status = normalizeOutcomeWord(args[0]);
      if (!status) return message.reply('Usage: `!3130 outcome <win|loss|breakeven> [pnl_dollars] [notes]`');
      let idx = 1;
      let pnlDollars = null;
      if (args[idx] && /^[-+]?\$?\d+(\.\d+)?$/.test(args[idx])) {
        pnlDollars = Number(String(args[idx]).replace('$', ''));
        idx += 1;
      }
      const notes = args.slice(idx).join(' ').trim() || null;
      const out = await handlers.logTradeOutcome({
        outcome: status,
        pnlDollars: Number.isFinite(pnlDollars) ? pnlDollars : null,
        notes,
        source: `discord:${message.author.username}`,
      });
      return message.reply(`Outcome logged: ${status.toUpperCase()}${Number.isFinite(out?.pnlDollars) ? ` $${out.pnlDollars}` : ''} | setup ${out?.setupName || out?.setupId || 'unlabeled setup'} (${out?.tradeDate || 'today'})`);
    }
    if (cmd === 'autonomy') {
      requireRole(role, 'view');
      if ((args[0] || '').toLowerCase() === 'run') {
        requireRole(role, 'operate');
        const out = await handlers.runAutonomyCycle({ force: true });
        return message.reply(`Autonomy paper cycle: ${out?.status || 'unavailable'}${out?.reason ? ` (${out.reason})` : ''}`);
      }
      return message.reply(`\`\`\`\n${await formatAutonomy()}\n\`\`\``);
    }
    if (cmd === 'mode') {
      requireRole(role, 'admin_only');
      const nextMode = String(args[0] || '').toLowerCase();
      if (!['manual', 'paper_auto', 'live_assist'].includes(nextMode)) {
        return message.reply('Usage: `!3130 mode <manual|paper_auto|live_assist>`');
      }
      const next = await handlers.updateAutonomySettings({ mode: nextMode, paperAutoEnabled: nextMode === 'paper_auto' ? true : undefined });
      return message.reply(`Autonomy mode set to ${next.mode}.`);
    }
    if (cmd === 'system') { requireRole(role, 'view'); return message.reply(await machineSummary()); }
    if (cmd === 'opps') { requireRole(role, 'view'); return message.reply(await replyTextOpportunities()); }

    if (cmd === 'scan') {
      requireRole(role, 'operate');
      const mode = (args[0] || 'two_stage').toLowerCase() === 'full_scan' ? 'full_scan' : 'two_stage';
      await message.reply(`Running discovery scan (${mode})...`);
      const result = await handlers.runDiscovery(mode);
      const cmp = result?.companionRecommendation;
      const cmpText = cmp ? `\nCompanion: ${cmp.name} (${String(cmp.frequency?.bucket || 'mid').toUpperCase()}, ~${cmp.frequency?.annualizedTrades || '?'} /yr)` : '';
      return message.reply(`Discovery complete. Live eligible: ${result?.summary?.recommended || 0}/${result?.summary?.candidates || 0}.${cmpText}`);
    }

    if (cmd === 'open') { requireRole(role, 'operate'); const url = normalizeOpenUrl(raw); if (!url) return message.reply('Invalid URL.'); await openExternalUrl(url); return message.reply(`Opened browser: ${url}`); }
    if (cmd === 'youtube') { requireRole(role, 'operate'); if (!raw) return message.reply('Usage: `!3130 youtube <url or query>`'); const url = normalizeOpenUrl(raw) || `https://www.youtube.com/results?search_query=${encodeURIComponent(raw)}`; await openExternalUrl(url); return message.reply(`Opened YouTube: ${url}`); }

    if (cmd === 'site') {
      requireRole(role, 'operate');
      const key = String(args[0] || '').toLowerCase();
      const url = siteMap.get(key);
      if (!url) return message.reply(`Unknown site key. Allowed: ${Array.from(siteMap.keys()).join(', ')}`);
      await openExternalUrl(url);
      return message.reply(`Opened site [${key}]: ${url}`);
    }
    if (cmd === 'closetab') { requireRole(role, 'operate'); return message.reply(await closeBrowserTab(raw)); }
    if (cmd === 'close' && String(args[0] || '').toLowerCase() === 'tab') { requireRole(role, 'operate'); return message.reply(await closeBrowserTab(args.slice(1).join(' '))); }
    if (cmd === 'close') { requireRole(role, 'operate'); return message.reply(await closeBrowserTab(raw)); }

    if (cmd === 'approve') { requireRole(role, 'operate'); const id = Number(args[0]); if (!id) return message.reply('Usage: `!3130 approve <candidate_id>`'); const p = await handlers.promoteCandidate(id, `discord:${message.author.username}`); return message.reply(`Promotion approved: #${id} (${p?.status || 'approved'})`); }
    if (cmd === 'reject') { requireRole(role, 'admin_only'); const id = Number(args[0]); if (!id) return message.reply('Usage: `!3130 reject <candidate_id> [reason]`'); const reason = args.slice(1).join(' ') || 'Rejected via Discord command.'; const r = await handlers.rejectCandidate(id, `discord:${message.author.username}`, reason); return message.reply(`Promotion rejected: #${id} (${r?.status || 'rejected'})`); }
    if (cmd === 'doctor') { requireRole(role, 'operate'); await message.reply('Running doctor check...'); return message.reply(`\`\`\`\n${await runDoctor(projectRoot)}\n\`\`\``); }
    if (cmd === 'halt') { requireRole(role, 'admin_only'); const c = await handlers.updateExecutionControls({ killSwitch: true, enabled: true }); return message.reply(`Kill switch ACTIVATED. Execution blocked. (${JSON.stringify(c)})`); }
    if (cmd === 'resume') { requireRole(role, 'admin_only'); const c = await handlers.updateExecutionControls({ killSwitch: false, enabled: true }); return message.reply(`Kill switch CLEARED. Execution can proceed when other gates pass. (${JSON.stringify(c)})`); }

    if (cmd === 'buy' || cmd === 'sell') {
      requireRole(role, 'high_power');
      const qty = Math.max(1, Number(args[0] || 1));
      const symbol = String(args[1] || 'MNQ').toUpperCase();
      const side = cmd;
      const intentOut = await handlers.createOrderIntent({ side, qty, symbol, source: 'discord', requestedBy: `discord:${message.author.username}` });
      const intentId = intentOut?.intent?.id;
      return proposeGuardedAction({
        replyFn: (payload) => message.reply(payload),
        userId: message.author.id,
        channelId: message.channelId,
        description: `${side.toUpperCase()} ${qty} ${symbol} (intent #${intentId})`,
        execute: async () => {
          const conf = await handlers.confirmOrderIntent(intentId, `discord:${message.author.username}`);
          return `Order confirmed: ${conf?.intent?.side?.toUpperCase()} ${conf?.intent?.qty} ${conf?.intent?.symbol} (#${intentId})`;
        },
      });
    }

    if (cmd === 'pcapp') {
      requireRole(role, 'high_power');
      const appName = raw;
      if (!appName) return message.reply('Usage: `!3130 pcapp <AppName>`');
      if (!appAllow.has(appName.toLowerCase())) return message.reply(`App not allowlisted. Allowed: ${Array.from(appAllow).join(', ')}`);
      return proposeGuardedAction({
        replyFn: (payload) => message.reply(payload),
        userId: message.author.id,
        channelId: message.channelId,
        description: `Open desktop app: ${appName}`,
        execute: async () => { await openDesktopApp(appName); return `Opened app: ${appName}`; },
      });
    }

    if (cmd === 'workflow') {
      requireRole(role, 'high_power');
      const wf = (args[0] || '').toLowerCase();
      if (!wf) return message.reply('Usage: `!3130 workflow <doctor|scan_two_stage|scan_full|open_dashboard>`');
      return proposeGuardedAction({
        replyFn: (payload) => message.reply(payload),
        userId: message.author.id,
        channelId: message.channelId,
        description: `Run workflow: ${wf}`,
        execute: async () => runWorkflow(wf),
      });
    }

    if (cmd === 'confirm') { const tokenId = String(args[0] || '').toUpperCase(); if (!tokenId) return message.reply('Usage: `!3130 confirm <TOKEN>`'); return message.reply(String(await confirmGuarded(tokenId, message.author.id) || 'Action confirmed.')); }
    if (cmd === 'cancel') { const tokenId = String(args[0] || '').toUpperCase(); if (!tokenId) return message.reply('Usage: `!3130 cancel <TOKEN>`'); return message.reply(cancelGuarded(tokenId, message.author.id) ? `Cancelled ${tokenId}.` : 'Token not found/expired.'); }

    return message.reply('Unknown command. Use `!3130 help`.');
  };

  const handleInteraction = async (interaction) => {
    if (interaction.isButton()) {
      const parts = String(interaction.customId || '').split(':');
      if (parts[0] === 'guard' && (parts[1] === 'run' || parts[1] === 'cancel')) {
        const tokenId = String(parts[2] || '').toUpperCase();
        if (!tokenId) return;
        if (parts[1] === 'cancel') return interaction.reply({ content: cancelGuarded(tokenId, interaction.user.id) ? `Cancelled ${tokenId}.` : 'Token not found/expired.', ephemeral: true });
        return interaction.reply({ content: String(await confirmGuarded(tokenId, interaction.user.id) || 'Guarded action complete.'), ephemeral: true });
      }
      if (parts[0] === 'promotion' && (parts[1] === 'approve' || parts[1] === 'reject')) {
        const candidateId = Number(parts[2]);
        if (!candidateId) return;
        if (!allowedByPolicy({ author: { id: interaction.user?.id }, channelId: interaction.channelId, guildId: interaction.guildId }, config)) return interaction.reply({ content: 'Not authorized.', ephemeral: true });
        const role = resolveRole(interaction.user?.id, config);
        if (parts[1] === 'approve') {
          requireRole(role, 'operate');
          const promoted = await handlers.promoteCandidate(candidateId, `discord:${interaction.user?.username || 'user'}`);
          return interaction.reply({ content: `Approved candidate #${candidateId} (${promoted?.status || 'approved'})`, ephemeral: false });
        }
        requireRole(role, 'admin_only');
        const rejected = await handlers.rejectCandidate(candidateId, `discord:${interaction.user?.username || 'user'}`, 'Rejected via Discord button.');
        return interaction.reply({ content: `Rejected candidate #${candidateId} (${rejected?.status || 'rejected'})`, ephemeral: false });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!allowedByPolicy({ author: { id: interaction.user?.id }, channelId: interaction.channelId, guildId: interaction.guildId }, config)) {
      await interaction.reply({ content: 'Not authorized for this command channel/account.', ephemeral: true });
      return;
    }

    const role = resolveRole(interaction.user?.id, config);
    const cmd = interaction.commandName;

    if (cmd === 'help') return interaction.reply({ content: `\`\`\`\n${shortHelp(prefix)}\n\`\`\``, ephemeral: true });
    if (cmd === 'capabilities') return interaction.reply({ content: `\`\`\`\n${getCapabilitiesText(role)}\n\`\`\``, ephemeral: true });
    if (cmd === 'status') { requireRole(role, 'view'); return interaction.reply(await handlers.getStatusSummary()); }
    if (cmd === 'plan') { requireRole(role, 'view'); return interaction.reply(`\`\`\`\n${await handlers.getDailyPlanText('original')}\n\`\`\``); }
    if (cmd === 'tradestate') { requireRole(role, 'view'); return interaction.reply(`\`\`\`\n${await formatTradeState()}\n\`\`\``); }
    if (cmd === 'panel') { requireRole(role, 'view'); return interaction.reply(`\`\`\`\n${await formatPanel()}\n\`\`\``); }
    if (cmd === 'deskstart') { requireRole(role, 'view'); return interaction.reply(`\`\`\`\n${await handlers.getDeskStartSequenceText('original')}\n\`\`\``); }
    if (cmd === 'outcome') {
      requireRole(role, 'operate');
      const status = normalizeOutcomeWord(interaction.options.getString('status'));
      if (!status) return interaction.reply({ content: 'status must be win/loss/breakeven', ephemeral: true });
      const pnlRaw = interaction.options.getString('pnl') || '';
      const pnlDollars = pnlRaw && /^[-+]?\$?\d+(\.\d+)?$/.test(pnlRaw) ? Number(String(pnlRaw).replace('$', '')) : null;
      const notes = interaction.options.getString('notes') || null;
      const out = await handlers.logTradeOutcome({
        outcome: status,
        pnlDollars: Number.isFinite(pnlDollars) ? pnlDollars : null,
        notes,
        source: `discord:${interaction.user?.username || 'user'}`,
      });
      return interaction.reply(`Outcome logged: ${status.toUpperCase()}${Number.isFinite(out?.pnlDollars) ? ` $${out.pnlDollars}` : ''} | setup ${out?.setupName || out?.setupId || 'unlabeled setup'} (${out?.tradeDate || 'today'})`);
    }
    if (cmd === 'autonomy') { requireRole(role, 'view'); return interaction.reply(`\`\`\`\n${await formatAutonomy()}\n\`\`\``); }
    if (cmd === 'system') { requireRole(role, 'view'); return interaction.reply(await machineSummary()); }
    if (cmd === 'opps') { requireRole(role, 'view'); return interaction.reply(await replyTextOpportunities()); }

    if (cmd === 'scan') {
      requireRole(role, 'operate');
      const mode = (interaction.options.getString('mode') || 'two_stage').toLowerCase() === 'full_scan' ? 'full_scan' : 'two_stage';
      await interaction.deferReply();
      const result = await handlers.runDiscovery(mode);
      const cmp = result?.companionRecommendation;
      const cmpText = cmp ? `\nCompanion: ${cmp.name} (${String(cmp.frequency?.bucket || 'mid').toUpperCase()}, ~${cmp.frequency?.annualizedTrades || '?'} /yr)` : '';
      return interaction.editReply(`Discovery complete. Live eligible: ${result?.summary?.recommended || 0}/${result?.summary?.candidates || 0}.${cmpText}`);
    }

    if (cmd === 'open') { requireRole(role, 'operate'); const url = normalizeOpenUrl(interaction.options.getString('url')); if (!url) return interaction.reply({ content: 'Invalid URL.', ephemeral: true }); await openExternalUrl(url); return interaction.reply(`Opened browser: ${url}`); }
    if (cmd === 'youtube') { requireRole(role, 'operate'); const raw = interaction.options.getString('query'); const url = normalizeOpenUrl(raw) || `https://www.youtube.com/results?search_query=${encodeURIComponent(raw)}`; await openExternalUrl(url); return interaction.reply(`Opened YouTube: ${url}`); }

    if (cmd === 'site') {
      requireRole(role, 'operate');
      const key = String(interaction.options.getString('key') || '').toLowerCase();
      const url = siteMap.get(key);
      if (!url) return interaction.reply({ content: `Unknown site key. Allowed: ${Array.from(siteMap.keys()).join(', ')}`, ephemeral: true });
      await openExternalUrl(url);
      return interaction.reply(`Opened site [${key}]: ${url}`);
    }
    if (cmd === 'closetab') { requireRole(role, 'operate'); const hint = interaction.options.getString('hint') || ''; return interaction.reply(await closeBrowserTab(hint)); }

    if (cmd === 'approve') { requireRole(role, 'operate'); const id = Number(interaction.options.getInteger('candidate_id')); const p = await handlers.promoteCandidate(id, `discord:${interaction.user?.username || 'user'}`); return interaction.reply(`Promotion approved: #${id} (${p?.status || 'approved'})`); }
    if (cmd === 'reject') { requireRole(role, 'admin_only'); const id = Number(interaction.options.getInteger('candidate_id')); const reason = interaction.options.getString('reason') || 'Rejected via Discord slash command.'; const r = await handlers.rejectCandidate(id, `discord:${interaction.user?.username || 'user'}`, reason); return interaction.reply(`Promotion rejected: #${id} (${r?.status || 'rejected'})`); }
    if (cmd === 'halt') { requireRole(role, 'admin_only'); const c = await handlers.updateExecutionControls({ killSwitch: true, enabled: true }); return interaction.reply(`Kill switch ACTIVATED. ${JSON.stringify(c)}`); }
    if (cmd === 'resume') { requireRole(role, 'admin_only'); const c = await handlers.updateExecutionControls({ killSwitch: false, enabled: true }); return interaction.reply(`Kill switch CLEARED. ${JSON.stringify(c)}`); }
    if (cmd === 'doctor') { requireRole(role, 'operate'); await interaction.deferReply(); return interaction.editReply(`\`\`\`\n${await runDoctor(projectRoot)}\n\`\`\``); }

    if (cmd === 'buy' || cmd === 'sell') {
      requireRole(role, 'high_power');
      const side = cmd;
      const qty = Math.max(1, Number(interaction.options.getInteger('qty') || 1));
      const symbol = String(interaction.options.getString('symbol') || 'MNQ').toUpperCase();
      const intentOut = await handlers.createOrderIntent({ side, qty, symbol, source: 'discord', requestedBy: `discord:${interaction.user?.username || 'user'}` });
      const intentId = intentOut?.intent?.id;
      return proposeGuardedAction({
        replyFn: (payload) => interaction.reply({ ...payload, ephemeral: true }),
        userId: interaction.user.id,
        channelId: interaction.channelId,
        description: `${side.toUpperCase()} ${qty} ${symbol} (intent #${intentId})`,
        execute: async () => {
          const conf = await handlers.confirmOrderIntent(intentId, `discord:${interaction.user?.username || 'user'}`);
          return `Order confirmed: ${conf?.intent?.side?.toUpperCase()} ${conf?.intent?.qty} ${conf?.intent?.symbol} (#${intentId})`;
        },
      });
    }

    if (cmd === 'pcapp') {
      requireRole(role, 'high_power');
      const appName = interaction.options.getString('name');
      if (!appAllow.has(String(appName || '').toLowerCase())) return interaction.reply({ content: `App not allowlisted. Allowed: ${Array.from(appAllow).join(', ')}`, ephemeral: true });
      return proposeGuardedAction({
        replyFn: (payload) => interaction.reply({ ...payload, ephemeral: true }),
        userId: interaction.user.id,
        channelId: interaction.channelId,
        description: `Open desktop app: ${appName}`,
        execute: async () => { await openDesktopApp(appName); return `Opened app: ${appName}`; },
      });
    }

    if (cmd === 'workflow') {
      requireRole(role, 'high_power');
      const wf = interaction.options.getString('name');
      return proposeGuardedAction({
        replyFn: (payload) => interaction.reply({ ...payload, ephemeral: true }),
        userId: interaction.user.id,
        channelId: interaction.channelId,
        description: `Run workflow: ${wf}`,
        execute: async () => runWorkflow(wf),
      });
    }
  };

  client.on('ready', () => {
    runtime.connected = true;
    runtime.ready = true;
    runtime.lastReadyAt = new Date().toISOString();
    runtime.lastError = null;
    console.log(`[Discord Bot] Connected as ${client.user?.tag || 'unknown-user'}`);
    const defs = slashDefs(siteMap.keys());
    for (const guild of client.guilds.cache.values()) {
      guild.commands.set(defs)
        .then(() => console.log(`[Discord Bot] Slash commands synced in guild ${guild.id}`))
        .catch((err) => console.error('[Discord Bot] Slash sync error:', err.message));
    }
  });

  client.on('error', (err) => {
    runtime.lastError = err?.message || 'discord_client_error';
  });
  client.on('shardError', (err) => {
    runtime.lastError = err?.message || 'discord_shard_error';
  });
  client.on('shardDisconnect', () => {
    runtime.connected = false;
    runtime.ready = false;
    runtime.reconnects += 1;
  });
  client.on('shardResume', () => {
    runtime.connected = true;
    runtime.ready = true;
  });
  client.on('invalidated', () => {
    runtime.connected = false;
    runtime.ready = false;
  });

  client.on('messageCreate', async (message) => {
    try {
      if (!message || message.author?.bot) return;
      if (!allowedByPolicy(message, config)) return;
      const content = String(message.content || '').trim();
      if (!content) return;

      if (content.toLowerCase().startsWith(prefix.toLowerCase())) {
        const body = content.slice(prefix.length).trim();
        if (!body) return message.reply(`Try \`${prefix} help\``);
        await handleCommand(message, body);
        return;
      }

      if (!plainEnglishMode) return;
      if (isGreetingOnlyInput(content)) {
        await message.reply('Doing well and fully online. If you want market guidance, ask: "what is today\'s stance?"');
        return;
      }
      let commands = [];
      let commandSource = 'none';
      const parsedCmd = inferPlainEnglishCommand(content, { appAllow, siteMap });
      if (parsedCmd) {
        commands = [parsedCmd];
        commandSource = 'rule';
      }
      if (!commands.length) {
        const memoryCmd = inferFromInterpreterMemory(interpreterMemory, content, { appAllow, siteMap });
        if (memoryCmd) {
          commands = [memoryCmd];
          commandSource = 'memory';
        }
      }
      if (!commands.length) {
        const ai = await inferPlainEnglishWithAI(content, { appAllow, siteMap, openaiKey });
        if (ai?.type === 'reply' && ai.reply) {
          await message.reply(ai.reply);
          return;
        }
        if (ai?.type === 'commands' && Array.isArray(ai.commands)) {
          commands = dedupeCommands(ai.commands);
          if (commands.length) commandSource = 'ai';
        }
        if (!commands.length && ai?.type === 'command' && ai.command) {
          commands = [ai.command];
          commandSource = 'ai';
        }
      }
      if (!commands.length) {
        await message.reply('I could not execute that safely yet. Try one sentence with action + target, for example: "show today outlook", "open youtube.com", "close two YouTube tabs in Safari", or "hit tp today +120".');
        return;
      }

      if (commands.length > 1) {
        await message.reply(`Executing ${commands.length} actions: ${commands.join(' -> ')}`);
      }
      let allSucceeded = true;
      for (const cmdText of commands) {
        try {
          await handleCommand(message, cmdText);
        } catch (err) {
          allSucceeded = false;
          throw err;
        }
      }
      if (allSucceeded && commands.length === 1) {
        rememberInterpreterMapping(interpreterMemory, content, commands[0], commandSource);
      }
    } catch (err) {
      try { await message.reply(`Command failed: ${err.message}`); } catch {}
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (err) {
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(`Command failed: ${err.message}`);
        else await interaction.reply({ content: `Command failed: ${err.message}`, ephemeral: true });
      } catch {}
    }
  });

  return {
    enabled: true,
    start: async () => {
      if (typeof client.isReady === 'function' && client.isReady()) {
        runtime.connected = true;
        runtime.ready = true;
        return true;
      }
      runtime.loginAttempts += 1;
      runtime.lastStartAt = new Date().toISOString();
      await client.login(token);
      runtime.connected = true;
      runtime.ready = true;
      return true;
    },
    stop: async () => {
      runtime.lastStopAt = new Date().toISOString();
      runtime.connected = false;
      runtime.ready = false;
      await client.destroy();
    },
    restart: async () => {
      runtime.lastStopAt = new Date().toISOString();
      runtime.connected = false;
      runtime.ready = false;
      await client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 250));
      runtime.loginAttempts += 1;
      runtime.lastStartAt = new Date().toISOString();
      await client.login(token);
      runtime.connected = true;
      runtime.ready = true;
      return true;
    },
    getStatus: () => ({
      connected: runtime.connected,
      ready: runtime.ready || (typeof client.isReady === 'function' ? client.isReady() : false),
      lastReadyAt: runtime.lastReadyAt,
      lastStartAt: runtime.lastStartAt,
      lastStopAt: runtime.lastStopAt,
      lastError: runtime.lastError,
      loginAttempts: runtime.loginAttempts,
      reconnects: runtime.reconnects,
    }),
    postPromotionDecision: async ({ id, candidateName, sampleSize, target, winRate, profitFactor, pnl }) => {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`promotion:approve:${id}`).setLabel(`Approve #${id}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`promotion:reject:${id}`).setLabel(`Reject #${id}`).setStyle(ButtonStyle.Danger)
      );
      return sendToPrimaryChannel({
        content: `Promotion Decision Required\nCandidate: ${candidateName}\nSample: ${sampleSize}/${target}\nWR: ${winRate}% | PF: ${profitFactor} | PnL: $${pnl}`,
        components: [row],
      });
    },
    sendDailyBriefing: async (text) => {
      const allowUsers = Array.isArray(config.allowedUserIds) ? config.allowedUserIds : [];
      for (const userId of allowUsers) {
        try {
          const user = await client.users.fetch(userId);
          if (!user) continue;
          await user.send(`\`\`\`\n${text}\n\`\`\``);
        } catch (err) {
          console.error(`[Discord Bot] Failed DM to ${userId}:`, err.message);
        }
      }
      return true;
    },
    sendMessageToAllowedUsers: async (text) => {
      const allowUsers = Array.isArray(config.allowedUserIds) ? config.allowedUserIds : [];
      for (const userId of allowUsers) {
        try {
          const user = await client.users.fetch(userId);
          if (!user) continue;
          await user.send(`\`\`\`\n${text}\n\`\`\``);
        } catch (err) {
          console.error(`[Discord Bot] Failed DM to ${userId}:`, err.message);
        }
      }
      return true;
    },
  };
}

module.exports = {
  createDiscordControlBot,
  __test: {
    normalizeUtterance,
    normalizeOpenUrl,
    resolveSiteKey,
    parseCloseTarget,
    inferPlainEnglishCommand,
    validateInterpretedCommand,
    isLearnableInterpreterCommand,
    stripConversationalPrefix,
    escapeAppleScriptString,
  },
};
