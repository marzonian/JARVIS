'use strict';

function toText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeDateTime(value) {
  const txt = toText(value);
  if (!txt) return null;
  const dt = new Date(txt.includes(' ') ? txt.replace(' ', 'T') + 'Z' : txt);
  if (!Number.isFinite(dt.getTime())) return txt;
  return dt.toISOString();
}

function safeParseJson(raw) {
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseSqliteDateToMs(value) {
  const txt = toText(value);
  if (!txt) return NaN;
  const dt = new Date(txt.includes(' ') ? `${txt.replace(' ', 'T')}Z` : txt);
  return Number.isFinite(dt.getTime()) ? dt.getTime() : NaN;
}

function addIsoDays(isoDate, deltaDays) {
  const txt = toText(isoDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) return null;
  const dt = new Date(`${txt}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays || 0));
  return dt.toISOString().slice(0, 10);
}

function diffIsoDays(startIso, endIso) {
  const startMs = parseSqliteDateToMs(`${toText(startIso)} 00:00:00`);
  const endMs = parseSqliteDateToMs(`${toText(endIso)} 00:00:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

function pickLatestIsoDate(candidates = []) {
  let best = null;
  for (const item of candidates) {
    const txt = toText(item);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) continue;
    if (!best || txt > best) best = txt;
  }
  return best;
}

function classifyTopstepFailure({
  keyPresent = false,
  latestErrorMessage = '',
  lastFailureMessage = '',
  syncDetails = {},
  credentialDiagnostics = null,
}) {
  const latestErrorTxt = toText(latestErrorMessage || '');
  const lastFailureTxt = toText(lastFailureMessage || '');
  if (!keyPresent) {
    return {
      class: 'missing_env',
      reason: 'Topstep API key is missing in runtime config.',
    };
  }
  const hardIssues = Array.isArray(credentialDiagnostics?.validation?.hardIssues)
    ? credentialDiagnostics.validation.hardIssues
    : [];
  if (hardIssues.length > 0) {
    return {
      class: 'malformed_env',
      reason: `Credential preflight failed: ${hardIssues.join(', ')}.`,
    };
  }
  if (credentialDiagnostics?.runtimeVsEnvFile?.likelyStaleRuntime === true) {
    return {
      class: 'runtime_stale_config',
      reason: 'Runtime Topstep credentials do not match current .env values (reload required).',
    };
  }
  const authError = toText(syncDetails?.authError || '');
  const accountFetchError = toText(syncDetails?.accountFetchError || '');
  const accountsTried = Array.isArray(syncDetails?.accountsTried) ? syncDetails.accountsTried : [];
  const triedStatuses = accountsTried
    .map((row) => Number(row?.status || 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (authError.includes('invalid_credentials') || authError.includes('password_verification_failed')) {
    return {
      class: 'wrong_credentials_or_revoked_access',
      reason: `Auth endpoint rejected credentials (${authError}).`,
    };
  }
  if (authError.includes('api_subscription_not_found') || authError.includes('agreements_not_signed')) {
    return {
      class: 'account_access_mismatch',
      reason: `Auth succeeded but account entitlement is invalid (${authError}).`,
    };
  }
  if (authError.includes('auth_refresh_failed') || authError.includes('token_missing')) {
    return {
      class: 'broken_refresh_logic',
      reason: `Login/refresh token path failed (${authError}).`,
    };
  }
  if (
    triedStatuses.length > 0
    && triedStatuses.every((code) => code === 404 || code === 405)
    && !triedStatuses.includes(200)
  ) {
    return {
      class: 'endpoint_contract_drift',
      reason: 'All account endpoint probes returned 404/405; endpoint contract likely drifted.',
    };
  }
  if (
    accountFetchError === 'http_401'
    || latestErrorTxt.includes('http_401')
    || lastFailureTxt.includes('http_401')
  ) {
    return {
      class: 'account_access_mismatch',
      reason: 'Account fetch is unauthorized (http_401) despite configured credentials.',
    };
  }
  return {
    class: 'unknown',
    reason: toText(latestErrorTxt || lastFailureTxt || 'Topstep failure reason is unclear.'),
  };
}

function buildTopstepRecoveryWindow(db) {
  const latestCheckpoint = (() => {
    try {
      return db.prepare(`
        SELECT MAX(trade_date) AS latest_trade_date
        FROM jarvis_assistant_decision_outcome_checkpoints
      `).get()?.latest_trade_date || null;
    } catch {
      return null;
    }
  })();
  const latestAutoJournal = (() => {
    try {
      return db.prepare(`
        SELECT MAX(trade_date) AS latest_trade_date
        FROM topstep_auto_journal_links
      `).get()?.latest_trade_date || null;
    } catch {
      return null;
    }
  })();
  const latestTopstepFeedback = (() => {
    try {
      return db.prepare(`
        SELECT MAX(trade_date) AS latest_trade_date
        FROM trade_outcome_feedback
        WHERE source = 'topstep_auto'
      `).get()?.latest_trade_date || null;
    } catch {
      return null;
    }
  })();
  const latestTopstepFill = (() => {
    try {
      return db.prepare(`
        SELECT MAX(substr(COALESCE(fill_time, created_at), 1, 10)) AS latest_trade_date
        FROM topstep_fills
      `).get()?.latest_trade_date || null;
    } catch {
      return null;
    }
  })();
  const latestTopstepTruthTradeDate = pickLatestIsoDate([
    latestAutoJournal,
    latestTopstepFeedback,
    latestTopstepFill,
  ]);
  const latestCheckpointTradeDate = pickLatestIsoDate([latestCheckpoint]);
  let staleWindowStartDate = null;
  let staleWindowEndDate = null;
  let staleWindowDays = 0;
  let backfillPending = false;
  if (
    latestTopstepTruthTradeDate
    && latestCheckpointTradeDate
    && latestCheckpointTradeDate > latestTopstepTruthTradeDate
  ) {
    staleWindowStartDate = addIsoDays(latestTopstepTruthTradeDate, 1);
    staleWindowEndDate = latestCheckpointTradeDate;
    staleWindowDays = Number(diffIsoDays(staleWindowStartDate, staleWindowEndDate) || 0);
    backfillPending = staleWindowDays > 0;
  }
  return {
    latestCheckpointTradeDate: latestCheckpointTradeDate || null,
    latestTopstepTruthTradeDate: latestTopstepTruthTradeDate || null,
    staleWindowStartDate,
    staleWindowEndDate,
    staleWindowDays,
    backfillPending,
  };
}

function buildRecoveryChecklist({
  failureClass = 'unknown',
  failureReason = null,
  recoveryWindow = null,
  credentialDiagnostics = null,
}) {
  const mustFix = [];
  if (failureClass == null || failureClass === 'none') {
    // No active Topstep failure class.
  } else if (failureClass === 'missing_env') {
    mustFix.push('Set TOPSTEP_API_KEY (and TOPSTEP_API_USERNAME for TopstepX loginKey auth).');
  } else if (failureClass === 'malformed_env') {
    const hardIssues = Array.isArray(credentialDiagnostics?.validation?.hardIssues)
      ? credentialDiagnostics.validation.hardIssues
      : [];
    mustFix.push(`Fix Topstep credential config validation issues: ${hardIssues.join(', ') || 'unknown_issue'}.`);
  } else if (failureClass === 'runtime_stale_config') {
    mustFix.push('Restart/reload runtime so new .env Topstep credentials are loaded.');
  } else if (failureClass === 'wrong_credentials_or_revoked_access') {
    mustFix.push('Rotate/verify Topstep API credentials and account permissions.');
  } else if (failureClass === 'account_access_mismatch') {
    mustFix.push('Verify Topstep account entitlement/mapping for configured username/account id.');
  } else if (failureClass === 'broken_refresh_logic') {
    mustFix.push('Inspect loginKey token refresh flow and auth endpoint response contract.');
  } else if (failureClass === 'endpoint_contract_drift') {
    mustFix.push('Update Topstep endpoint paths/methods to match current API contract.');
  } else {
    mustFix.push(`Investigate Topstep sync failure details (${toText(failureReason || 'unknown')}).`);
  }
  const staleWindow = recoveryWindow && typeof recoveryWindow === 'object'
    ? {
      backfillPending: recoveryWindow.backfillPending === true,
      staleWindowStartDate: recoveryWindow.staleWindowStartDate || null,
      staleWindowEndDate: recoveryWindow.staleWindowEndDate || null,
      staleWindowDays: Number(recoveryWindow.staleWindowDays || 0),
    }
    : {
      backfillPending: false,
      staleWindowStartDate: null,
      staleWindowEndDate: null,
      staleWindowDays: 0,
    };
  return {
    mustFix: (staleWindow.backfillPending && mustFix.length === 0)
      ? ['Topstep access is healthy, but stale realized-truth window still needs backfill recompute.']
      : mustFix,
    rerunJobs: [
      'POST /api/topstep/sync/run {"force":true}',
      'POST /api/topstep/auto-journal/run',
      'POST /api/jarvis/evidence/daily-scoring/run {"force":true,"finalizationOnly":true,"liveBridgeLookbackDays":21}',
      'GET /api/jarvis/recommendation/performance?force=1',
      'GET /api/jarvis/command-center?force=1',
    ],
    staleWindow,
  };
}

function buildTopstepIntegrationAuditSummary(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      generatedAt: new Date().toISOString(),
      keyStatus: 'missing',
      authStatus: 'failure',
      lastSuccessfulFetchAt: null,
      currentLiveFeedStatus: 'error',
      lastErrorMessage: 'db_unavailable',
      lastFailureMessage: 'db_unavailable',
      lastFailureAt: null,
      isFailureActive: true,
      historicalFailureRetained: false,
      failureClass: 'unknown',
      failureReason: 'db_unavailable',
      syncDetails: {
        authError: null,
        accountFetchError: null,
        authUsed: null,
      },
      credentialDiagnostics: input.credentialDiagnostics || null,
      recoveryWindow: {
        latestCheckpointTradeDate: null,
        latestTopstepTruthTradeDate: null,
        staleWindowStartDate: null,
        staleWindowEndDate: null,
        staleWindowDays: 0,
        backfillPending: false,
      },
      recoveryChecklist: {
        mustFix: ['Restore DB access before Topstep audit can classify recovery actions.'],
        rerunJobs: [
          'POST /api/topstep/sync/run {"force":true}',
          'POST /api/topstep/auto-journal/run',
          'POST /api/jarvis/evidence/daily-scoring/run {"force":true,"finalizationOnly":true,"liveBridgeLookbackDays":21}',
          'GET /api/jarvis/recommendation/performance?force=1',
          'GET /api/jarvis/command-center?force=1',
        ],
        staleWindow: {
          backfillPending: false,
          staleWindowStartDate: null,
          staleWindowEndDate: null,
          staleWindowDays: 0,
        },
      },
      watch: input.syncWatch || null,
      advisoryOnly: true,
    };
  }
  const keyPresent = !!toText(input.apiKey || '');
  const liveSnapshot = input.liveSnapshot && typeof input.liveSnapshot === 'object'
    ? input.liveSnapshot
    : {};
  const latestSync = liveSnapshot.sync && typeof liveSnapshot.sync === 'object'
    ? liveSnapshot.sync
    : (db.prepare(`
      SELECT id, status, error_message, details_json, created_at
      FROM topstep_sync_runs
      ORDER BY id DESC
      LIMIT 1
    `).get() || null);
  const lastSuccessRow = db.prepare(`
    SELECT created_at, status
    FROM topstep_sync_runs
    WHERE status IN ('ok', 'noop', 'partial')
    ORDER BY id DESC
    LIMIT 1
  `).get() || null;
  const lastErrorRow = db.prepare(`
    SELECT created_at, error_message, status
    FROM topstep_sync_runs
    WHERE status IN ('error', 'partial')
      AND COALESCE(TRIM(error_message), '') != ''
    ORDER BY id DESC
    LIMIT 1
  `).get() || null;

  const watch = input.syncWatch && typeof input.syncWatch === 'object' ? input.syncWatch : {};
  const lastFailureMessage = toText(lastErrorRow?.error_message || watch?.lastFailureReason || '') || null;
  const latestErrorMessage = toText(latestSync?.errorMessage || latestSync?.error_message || '') || null;
  const latestStatus = toText(latestSync?.status || latestSync?.status || '').toLowerCase();
  const syncDetails = (
    liveSnapshot?.sync?.details
    && typeof liveSnapshot.sync.details === 'object'
  )
    ? liveSnapshot.sync.details
    : safeParseJson(latestSync?.details_json || null);
  const credentialDiagnostics = input.credentialDiagnostics && typeof input.credentialDiagnostics === 'object'
    ? input.credentialDiagnostics
    : null;
  const hasAuthSuccess = input.hasAuthToken === true
    || (lastSuccessRow && ['ok', 'noop', 'partial'].includes(toText(lastSuccessRow.status).toLowerCase()));
  const authStatus = !keyPresent
    ? 'missing_key'
    : (hasAuthSuccess && latestStatus !== 'error')
      ? 'success'
      : ((lastFailureMessage || latestErrorMessage) ? 'failure' : 'unknown');

  let currentLiveFeedStatus = 'unknown';
  if (!latestSync) currentLiveFeedStatus = 'never_synced';
  else if (latestStatus === 'ok' || latestStatus === 'noop') currentLiveFeedStatus = 'healthy';
  else if (latestStatus === 'partial') currentLiveFeedStatus = 'degraded';
  else if (latestStatus === 'disabled') currentLiveFeedStatus = 'disabled';
  else if (latestStatus === 'error') currentLiveFeedStatus = 'error';

  const nowMs = Date.now();
  const successMs = lastSuccessRow?.created_at
    ? Date.parse(String(lastSuccessRow.created_at).replace(' ', 'T') + 'Z')
    : NaN;
  if (Number.isFinite(successMs)) {
    const ageMinutes = Math.max(0, Math.floor((nowMs - successMs) / 60000));
    if (ageMinutes > 10 && currentLiveFeedStatus === 'healthy') currentLiveFeedStatus = 'stale';
  }

  const isFailureActive = (
    currentLiveFeedStatus === 'error'
    || (currentLiveFeedStatus === 'degraded' && !!latestErrorMessage)
  );
  const historicalFailureRetained = !isFailureActive && !!lastFailureMessage;
  const lastErrorMessage = isFailureActive
    ? (latestErrorMessage || lastFailureMessage || toText(watch?.lastFailureReason || '') || null)
    : null;
  const failure = isFailureActive
    ? classifyTopstepFailure({
      keyPresent,
      latestErrorMessage,
      lastFailureMessage,
      syncDetails,
      credentialDiagnostics,
    })
    : { class: null, reason: null };
  const recoveryWindow = buildTopstepRecoveryWindow(db);
  const recoveryChecklist = buildRecoveryChecklist({
    failureClass: failure.class || 'none',
    failureReason: failure.reason,
    recoveryWindow,
    credentialDiagnostics,
  });

  return {
    generatedAt: new Date().toISOString(),
    keyStatus: keyPresent ? 'present' : 'missing',
    authStatus,
    lastSuccessfulFetchAt: normalizeDateTime(lastSuccessRow?.created_at || latestSync?.createdAt || null),
    currentLiveFeedStatus,
    lastErrorMessage,
    lastFailureMessage,
    lastFailureAt: normalizeDateTime(lastErrorRow?.created_at || watch?.lastFailureAt || null),
    isFailureActive,
    historicalFailureRetained,
    currentHealth: isFailureActive ? 'failing' : (currentLiveFeedStatus === 'healthy' ? 'healthy' : currentLiveFeedStatus),
    failureClass: failure.class,
    failureReason: failure.reason,
    syncDetails: {
      authError: toText(syncDetails?.authError || '') || null,
      accountFetchError: toText(syncDetails?.accountFetchError || '') || null,
      authUsed: toText(syncDetails?.authUsed || '') || null,
    },
    credentialDiagnostics,
    recoveryWindow,
    recoveryChecklist,
    watch: {
      consecutiveFailures: Number(watch?.consecutiveFailures || 0),
      lastFailureAt: normalizeDateTime(watch?.lastFailureAt || null),
      lastFailureReason: toText(watch?.lastFailureReason || '') || null,
    },
    advisoryOnly: true,
  };
}

module.exports = {
  buildTopstepIntegrationAuditSummary,
};
