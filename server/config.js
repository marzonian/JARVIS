/**
 * McNair Mindset by 3130
 * Server Configuration
 */

require('dotenv/config');
const { execSync } = require('child_process');

function readKeyFromKeychain(serviceName) {
  try {
    return execSync(
      `security find-generic-password -w -s "${serviceName}" -a "${process.env.USER || ''}" 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
}

const anthropicKey = process.env.ANTHROPIC_API_KEY || readKeyFromKeychain('3130_anthropic_api_key') || null;
const topstepApiKey = process.env.TOPSTEP_API_KEY || readKeyFromKeychain('3130_topstep_api_key') || null;
const databentoApiKey = process.env.DATABENTO_API_KEY || readKeyFromKeychain('3130_databento_api_key') || null;

module.exports = {
  port: parseInt(process.env.PORT || '3131'),
  host: process.env.HOST || 'localhost',
  
  topstep: {
    startingBalance: parseFloat(process.env.TOPSTEP_STARTING_BALANCE || '50000'),
    maxDrawdown: parseFloat(process.env.TOPSTEP_MAX_DRAWDOWN || '2000'),
    profitTarget: parseFloat(process.env.TOPSTEP_PROFIT_TARGET || '3000'),
    api: {
      enabled: process.env.TOPSTEP_API_ENABLED === 'true',
      key: topstepApiKey,
      username: process.env.TOPSTEP_API_USERNAME || null,
      baseUrl: process.env.TOPSTEP_API_BASE_URL || 'https://api.topstepx.com',
      altBaseUrls: (process.env.TOPSTEP_API_ALT_BASE_URLS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      accountId: process.env.TOPSTEP_API_ACCOUNT_ID || null,
      tradeLookbackDays: parseInt(process.env.TOPSTEP_API_TRADE_LOOKBACK_DAYS || '365', 10),
      mode: ['read_only', 'execution_assist'].includes(String(process.env.TOPSTEP_API_MODE || '').toLowerCase())
        ? String(process.env.TOPSTEP_API_MODE).toLowerCase()
        : 'read_only',
      timeoutMs: parseInt(process.env.TOPSTEP_API_TIMEOUT_MS || '10000', 10),
      methods: (process.env.TOPSTEP_API_HTTP_METHODS || 'POST,GET')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      paths: {
        authLoginKey: process.env.TOPSTEP_API_AUTH_LOGIN_KEY_PATH || '/api/Auth/loginKey',
        accounts: process.env.TOPSTEP_API_ACCOUNTS_PATH || '/api/Account/search',
        positions: process.env.TOPSTEP_API_POSITIONS_PATH || '/api/Position/searchOpen',
        fills: process.env.TOPSTEP_API_FILLS_PATH || '/api/Trade/search',
      },
    },
    compliance: {
      strictMode: process.env.TOPSTEP_COMPLIANCE_MODE !== 'off',
      requireManualConfirm: process.env.TOPSTEP_REQUIRE_MANUAL_CONFIRM !== 'false',
      allowAutomation: process.env.TOPSTEP_ALLOW_AUTOMATION === 'true',
      requireLocalRuntime: process.env.TOPSTEP_REQUIRE_LOCAL_RUNTIME !== 'false',
      orderEntryCutoffCT: process.env.TOPSTEP_ORDER_ENTRY_CUTOFF_CT || '15:00',
      flatByCutoffCT: process.env.TOPSTEP_FLAT_BY_CUTOFF_CT || '15:10',
      minDrawdownBufferDollars: parseFloat(process.env.TOPSTEP_MIN_DRAWDOWN_BUFFER_DOLLARS || '250'),
    },
    autoJournal: {
      enabled: process.env.TOPSTEP_AUTO_JOURNAL_ENABLED !== 'false',
      setupId: process.env.TOPSTEP_AUTO_JOURNAL_SETUP_ID || 'topstep_live',
      setupName: process.env.TOPSTEP_AUTO_JOURNAL_SETUP_NAME || 'Topstep Live Auto Journal',
      minAbsPnlDollars: parseFloat(process.env.TOPSTEP_AUTO_JOURNAL_MIN_ABS_PNL || '0'),
      lookbackDays: parseInt(process.env.TOPSTEP_AUTO_JOURNAL_LOOKBACK_DAYS || '14', 10),
      includeBreakeven: process.env.TOPSTEP_AUTO_JOURNAL_INCLUDE_BREAKEVEN === 'true',
    },
    autonomy: {
      liveEnabled: process.env.TOPSTEP_AUTONOMY_LIVE_ENABLED === 'true',
      requirePracticeAccount: process.env.TOPSTEP_AUTONOMY_REQUIRE_PRACTICE_ACCOUNT !== 'false',
      allowedAccountRegex: process.env.TOPSTEP_AUTONOMY_ALLOWED_ACCOUNT_REGEX || '^(PRAC|50KTC)-',
      signalMaxAgeMinutes: Math.max(1, Math.min(30, parseInt(process.env.TOPSTEP_AUTONOMY_SIGNAL_MAX_AGE_MINUTES || '8', 10))),
      barLookbackDays: Math.max(1, Math.min(7, parseInt(process.env.TOPSTEP_AUTONOMY_BAR_LOOKBACK_DAYS || '3', 10))),
      defaultSymbol: String(process.env.TOPSTEP_AUTONOMY_SYMBOL || 'MNQ').toUpperCase(),
      testOverrideEnabled: process.env.TOPSTEP_AUTONOMY_TEST_OVERRIDE_ENABLED === 'true',
      testOverrideDate: process.env.TOPSTEP_AUTONOMY_TEST_OVERRIDE_DATE || null,
    },
  },

  databento: {
    api: {
      enabled: process.env.DATABENTO_API_ENABLED !== 'false',
      key: databentoApiKey,
      baseUrl: process.env.DATABENTO_API_BASE_URL || 'https://hist.databento.com',
      endpoint: process.env.DATABENTO_API_ENDPOINT || '/v0/timeseries.get_range',
      dataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3',
      schemaName: process.env.DATABENTO_SCHEMA || 'ohlcv-1m',
      stypeIn: process.env.DATABENTO_STYPE_IN || 'continuous',
      symbols: (process.env.DATABENTO_SYMBOLS || 'MNQ.c.0,MES.c.0')
        .split(',')
        .map((s) => String(s || '').trim())
        .filter(Boolean),
      timeoutMs: parseInt(process.env.DATABENTO_TIMEOUT_MS || '30000', 10),
      lookbackDays: parseInt(process.env.DATABENTO_LOOKBACK_DAYS || '120', 10),
      gapLookbackDays: parseInt(process.env.DATABENTO_GAP_LOOKBACK_DAYS || '45', 10),
      maxRangeDays: parseInt(process.env.DATABENTO_MAX_RANGE_DAYS || '7', 10),
      recentClampDays: Math.max(0, Math.min(5, parseInt(process.env.DATABENTO_RECENT_CLAMP_DAYS || '1', 10))),
    },
  },

  dataFoundation: {
    autoDatabentoIngestionEnabled: process.env.DATABENTO_AUTO_INGEST_ENABLED !== 'false',
    autoDailyScoringEnabled: process.env.JARVIS_AUTO_DAILY_SCORING_ENABLED !== 'false',
    dailyScoringWindowDays: parseInt(process.env.JARVIS_DAILY_SCORING_WINDOW_DAYS || '3', 10),
  },

  anthropicKey,

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    commandPrefix: process.env.DISCORD_COMMAND_PREFIX || '!3130',
    allowedUserIds: (process.env.DISCORD_ALLOWED_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    allowedChannelIds: (process.env.DISCORD_ALLOWED_CHANNEL_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    adminUserIds: (process.env.DISCORD_ADMIN_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    viewerUserIds: (process.env.DISCORD_VIEWER_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    allowedSites: (process.env.DISCORD_ALLOWED_SITES || 'dashboard,https://localhost:3131,openai,https://openai.com,youtube,https://www.youtube.com')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    allowedApps: (process.env.DISCORD_ALLOWED_APPS || 'Safari,Discord,Notes,Calendar,Music')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    plainEnglishMode: process.env.DISCORD_PLAIN_ENGLISH_MODE !== 'false',
  },

  news: {
    enabled: process.env.NEWS_ENABLED !== 'false',
    calendarUrl: process.env.NEWS_CALENDAR_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
    focusCurrencies: (process.env.NEWS_FOCUS_CURRENCIES || 'USD')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean),
    minImpact: process.env.NEWS_MIN_IMPACT || 'Medium',
    timeoutMs: parseInt(process.env.NEWS_TIMEOUT_MS || '9000', 10),
  },

  monteCarloSims: 10000,
};
