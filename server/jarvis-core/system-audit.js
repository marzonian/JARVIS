'use strict';

const {
  normalizeDate,
  toText,
} = require('./data-foundation-storage');

const VALIDATION_WORKING = 'working';
const VALIDATION_FAILING = 'failing';
const VALIDATION_MISSING = 'missing';
const VALIDATION_UNKNOWN = 'unknown';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueList(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((v) => toText(v)).filter(Boolean)));
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function lowerText(value) {
  return toText(value).toLowerCase();
}

function inferLoadSource(input = {}) {
  const present = input.accessPresent === true || input.present === true;
  if (present !== true) return 'missing';
  if (input.envPresent === true) return 'env';
  if (input.runtimeConfigOnly === true) return 'runtime_config';
  if (input.keychainEligible === true) return 'keychain_or_env_bootstrap';
  return 'runtime_config';
}

function buildProviderRow(input = {}) {
  const accessPresent = input.accessPresent === true;
  const lastSuccessfulValidationAt = toText(input.lastSuccessfulValidationAt || '') || null;
  const jarvisUse = toText(input.jarvisUse || '') || null;
  const absentImpact = toText(input.absentImpact || '') || null;
  return {
    providerName: toText(input.providerName || 'unknown') || 'unknown',
    referencedInCode: input.referencedInCode !== false,
    envVarNames: uniqueList(input.envVarNames),
    accessPresent,
    keyPresent: accessPresent,
    loadedFrom: toText(input.loadedFrom || inferLoadSource(input)) || 'missing',
    validationAttempted: input.validationAttempted === true,
    validationResult: toText(input.validationResult || VALIDATION_UNKNOWN) || VALIDATION_UNKNOWN,
    lastSuccessfulValidationAt,
    lastValidationTimestamp: lastSuccessfulValidationAt,
    jarvisUse,
    purposeInJarvis: jarvisUse,
    absentImpact,
    systemImpactIfMissing: absentImpact,
    advisoryOnly: true,
  };
}

function buildDbFoundationCounts(db) {
  const base = {
    rawBarsRows: 0,
    liveSessionRows: 0,
    derivedFeatureRows: 0,
    scoredOutcomeRows: 0,
    ingestionRunRows: 0,
    ingestionStateRows: 0,
    gapAuditRows: 0,
    gapAuditOpenRows: 0,
    gapAuditDeferredRows: 0,
    gapAuditRetryableRows: 0,
    dailyScoringRunRows: 0,
  };
  if (!db || typeof db.prepare !== 'function') return base;
  const queryValue = (sql, fallback = 0) => {
    try {
      return toNumber(db.prepare(sql).get()?.c, fallback);
    } catch {
      return fallback;
    }
  };
  return {
    rawBarsRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_market_bars_raw'),
    liveSessionRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_live_session_data'),
    derivedFeatureRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_derived_features'),
    scoredOutcomeRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_scored_trade_outcomes'),
    ingestionRunRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_databento_ingestion_runs'),
    ingestionStateRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_databento_ingestion_state'),
    gapAuditRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_databento_gap_audit'),
    gapAuditOpenRows: queryValue("SELECT COUNT(*) AS c FROM jarvis_databento_gap_audit WHERE status = 'open'"),
    gapAuditDeferredRows: queryValue("SELECT COUNT(*) AS c FROM jarvis_databento_gap_audit WHERE status = 'deferred_recent'"),
    gapAuditRetryableRows: queryValue("SELECT COUNT(*) AS c FROM jarvis_databento_gap_audit WHERE status = 'retryable'"),
    dailyScoringRunRows: queryValue('SELECT COUNT(*) AS c FROM jarvis_daily_scoring_runs'),
  };
}

function deriveDatabentoValidation(input = {}) {
  if (input.accessPresent !== true) {
    return { attempted: false, result: VALIDATION_MISSING, lastSuccessfulValidationAt: null };
  }
  const latestRun = Array.isArray(input.databentoIngestionStatus?.latestRuns)
    ? input.databentoIngestionStatus.latestRuns[0] || null
    : null;
  const status = lowerText(latestRun?.status || input.databentoIngestionStatus?.status || '');
  if (!status) return { attempted: false, result: VALIDATION_UNKNOWN, lastSuccessfulValidationAt: null };
  if (status === 'ok' || status === 'partial' || status === 'noop') {
    return {
      attempted: true,
      result: VALIDATION_WORKING,
      lastSuccessfulValidationAt: toText(latestRun?.createdAt || '') || null,
    };
  }
  if (status === 'error') {
    return {
      attempted: true,
      result: VALIDATION_FAILING,
      lastSuccessfulValidationAt: null,
    };
  }
  return { attempted: true, result: VALIDATION_UNKNOWN, lastSuccessfulValidationAt: null };
}

function deriveTopstepValidation(input = {}) {
  if (input.accessPresent !== true) {
    return { attempted: false, result: VALIDATION_MISSING, lastSuccessfulValidationAt: null };
  }
  const audit = input.topstepIntegrationAudit && typeof input.topstepIntegrationAudit === 'object'
    ? input.topstepIntegrationAudit
    : null;
  if (!audit) return { attempted: false, result: VALIDATION_UNKNOWN, lastSuccessfulValidationAt: null };
  const auth = lowerText(audit.authStatus);
  const feed = lowerText(audit.currentLiveFeedStatus);
  const activeFailure = audit.isFailureActive === true;
  if (auth === 'success' && ['healthy', 'degraded', 'stale'].includes(feed) && !activeFailure) {
    return {
      attempted: true,
      result: VALIDATION_WORKING,
      lastSuccessfulValidationAt: toText(audit.lastSuccessfulFetchAt || '') || null,
    };
  }
  if (auth === 'failure' || feed === 'error' || activeFailure) {
    return {
      attempted: true,
      result: VALIDATION_FAILING,
      lastSuccessfulValidationAt: toText(audit.lastSuccessfulFetchAt || '') || null,
    };
  }
  return {
    attempted: true,
    result: VALIDATION_UNKNOWN,
    lastSuccessfulValidationAt: toText(audit.lastSuccessfulFetchAt || '') || null,
  };
}

function deriveDiscordValidation(input = {}) {
  if (input.accessPresent !== true) {
    return { attempted: false, result: VALIDATION_MISSING, lastSuccessfulValidationAt: null };
  }
  const runtime = input.discordRuntime && typeof input.discordRuntime === 'object'
    ? input.discordRuntime
    : {};
  const ready = runtime.ready === true || input.discordReady === true;
  const connected = runtime.connected === true;
  const lastReadyAt = toText(runtime.lastReadyAt || '') || null;
  if (ready || connected) {
    return { attempted: true, result: VALIDATION_WORKING, lastSuccessfulValidationAt: lastReadyAt };
  }
  return { attempted: true, result: VALIDATION_FAILING, lastSuccessfulValidationAt: lastReadyAt };
}

function deriveNewsValidation(input = {}) {
  const enabled = input.newsEnabled !== false;
  if (!enabled) return { attempted: false, result: VALIDATION_MISSING, lastSuccessfulValidationAt: null };
  const probe = input.newsValidation && typeof input.newsValidation === 'object'
    ? input.newsValidation
    : null;
  if (!probe) return { attempted: false, result: VALIDATION_UNKNOWN, lastSuccessfulValidationAt: null };
  if (probe.result === VALIDATION_WORKING) {
    return {
      attempted: true,
      result: VALIDATION_WORKING,
      lastSuccessfulValidationAt: toText(probe.lastSuccessfulValidationAt || '') || null,
    };
  }
  if (probe.result === VALIDATION_FAILING) {
    return {
      attempted: true,
      result: VALIDATION_FAILING,
      lastSuccessfulValidationAt: toText(probe.lastSuccessfulValidationAt || '') || null,
    };
  }
  return { attempted: true, result: VALIDATION_UNKNOWN, lastSuccessfulValidationAt: null };
}

function buildEvidenceSnapshot(input = {}) {
  const evidence = input.dataCoverage?.evidenceReadiness && typeof input.dataCoverage.evidenceReadiness === 'object'
    ? input.dataCoverage.evidenceReadiness
    : {};
  return {
    strategyEnoughEvidence: evidence?.strategyModule?.enoughEvidence === true,
    strategySampleSize30d: toNumber(evidence?.strategyModule?.sampleSize30d, 0),
    strategyLiveSampleSize: toNumber(evidence?.strategyModule?.liveSampleSize, 0),
    regimeEnoughEvidence: evidence?.regimeModule?.enoughEvidence === true,
    regimeCoverageWithProvenance: toNumber(evidence?.regimeModule?.coverageWithProvenance, 0),
    persistenceEnoughEvidence: evidence?.persistenceModule?.enoughEvidence === true,
    persistenceConfidencePolicy: toText(evidence?.persistenceModule?.confidencePolicy || '') || 'suppress_confidence',
    persistenceOverrideLabel: toText(evidence?.persistenceModule?.overrideLabel || '') || 'suppressed',
  };
}

function buildMajorBlockers(input = {}) {
  const out = [];
  const counts = input.foundationCounts || {};
  const dataCoverage = input.dataCoverage && typeof input.dataCoverage === 'object' ? input.dataCoverage : {};
  const topstepAudit = input.topstepIntegrationAudit && typeof input.topstepIntegrationAudit === 'object'
    ? input.topstepIntegrationAudit
    : {};
  const evidence = input.evidenceSnapshot && typeof input.evidenceSnapshot === 'object'
    ? input.evidenceSnapshot
    : {};

  if (input.providerValidation?.databento === VALIDATION_MISSING) out.push('databento_key_missing');
  if (input.providerValidation?.databento === VALIDATION_FAILING) out.push('databento_validation_failing');
  if (toNumber(counts.gapAuditOpenRows, 0) > 0) out.push('databento_open_gaps_present');
  if (toNumber(counts.gapAuditDeferredRows, 0) > 0) out.push('databento_recent_ranges_deferred');
  if (input.providerValidation?.topstep === VALIDATION_MISSING) out.push('topstep_key_missing');
  if (input.providerValidation?.topstep === VALIDATION_FAILING) out.push('topstep_live_feed_unhealthy');
  if (topstepAudit.historicalFailureRetained === true) out.push('topstep_historical_failures_retained');
  if (toNumber(counts.rawBarsRows, 0) <= 0) out.push('raw_market_bars_missing');
  if (toNumber(counts.scoredOutcomeRows, 0) <= 0) out.push('scored_outcomes_missing');
  if (toNumber(counts.dailyScoringRunRows, 0) <= 0) out.push('daily_scoring_not_running');
  if (evidence.strategyEnoughEvidence !== true) out.push('strategy_evidence_thin');
  if (evidence.regimeEnoughEvidence !== true) out.push('regime_evidence_thin');
  if (evidence.persistenceEnoughEvidence !== true) out.push('persistence_evidence_thin');
  if (Array.isArray(dataCoverage.warnings) && dataCoverage.warnings.includes('historical_gaps_detected')) {
    if (!out.includes('databento_open_gaps_present')) out.push('historical_coverage_gaps_detected');
  }
  return uniqueList(out).slice(0, 12);
}

function buildFoundationSummary(input = {}) {
  const counts = input.foundationCounts || {};
  const dataCoverage = input.dataCoverage && typeof input.dataCoverage === 'object' ? input.dataCoverage : {};
  const scoring = input.dailyEvidenceScoringStatus && typeof input.dailyEvidenceScoringStatus === 'object'
    ? input.dailyEvidenceScoringStatus
    : {};
  const topstepAudit = input.topstepIntegrationAudit && typeof input.topstepIntegrationAudit === 'object'
    ? input.topstepIntegrationAudit
    : {};
  const databentoStatus = input.databentoIngestionStatus && typeof input.databentoIngestionStatus === 'object'
    ? input.databentoIngestionStatus
    : {};
  const latestDatabentoRun = Array.isArray(databentoStatus.latestRuns) ? (databentoStatus.latestRuns[0] || null) : null;
  const latestDailyRun = scoring?.latestRun && typeof scoring.latestRun === 'object' ? scoring.latestRun : null;
  const symbolsCovered = Array.isArray(dataCoverage.symbols) ? dataCoverage.symbols : [];

  return {
    rowCounts: {
      rawMarketBars: toNumber(counts.rawBarsRows, 0),
      liveSessionRows: toNumber(counts.liveSessionRows, 0),
      derivedFeatureRows: toNumber(counts.derivedFeatureRows, 0),
      scoredTradeOutcomes: toNumber(counts.scoredOutcomeRows, 0),
      databentoIngestionRuns: toNumber(counts.ingestionRunRows, 0),
      databentoGapAuditRows: toNumber(counts.gapAuditRows, 0),
      databentoGapAuditOpen: toNumber(counts.gapAuditOpenRows, 0),
      databentoGapAuditDeferredRecent: toNumber(counts.gapAuditDeferredRows, 0),
      dailyScoringRuns: toNumber(counts.dailyScoringRunRows, 0),
    },
    databento: {
      latestRunStatus: toText(latestDatabentoRun?.status || '') || 'unknown',
      latestRunAt: toText(latestDatabentoRun?.createdAt || '') || null,
      latestRunError: toText(latestDatabentoRun?.errorMessage || '') || null,
      ingestionLive: ['ok', 'partial', 'noop'].includes(lowerText(latestDatabentoRun?.status || '')),
      symbolsCovered,
      missingRangesCount: Array.isArray(dataCoverage?.missingDateRanges) ? dataCoverage.missingDateRanges.length : 0,
    },
    topstep: {
      currentLiveFeedStatus: toText(topstepAudit.currentLiveFeedStatus || '') || 'unknown',
      authStatus: toText(topstepAudit.authStatus || '') || 'unknown',
      lastSuccessfulFetchAt: toText(topstepAudit.lastSuccessfulFetchAt || '') || null,
      isFailureActive: topstepAudit.isFailureActive === true,
      historicalFailureRetained: topstepAudit.historicalFailureRetained === true,
    },
    dailyScoring: {
      latestRunStatus: toText(latestDailyRun?.status || '') || 'unknown',
      latestRunDate: normalizeDate(latestDailyRun?.runDate || ''),
      latestRunAt: toText(latestDailyRun?.createdAt || '') || null,
      latestScoredRows: toNumber(latestDailyRun?.scoredRows, 0),
      running: !!latestDailyRun,
    },
    advisoryOnly: true,
  };
}

function buildSystemAuditSummary(input = {}) {
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const envPresence = input.envPresence && typeof input.envPresence === 'object' ? input.envPresence : {};
  const topstepIntegrationAudit = input.topstepIntegrationAudit && typeof input.topstepIntegrationAudit === 'object'
    ? input.topstepIntegrationAudit
    : {};
  const databentoIngestionStatus = input.databentoIngestionStatus && typeof input.databentoIngestionStatus === 'object'
    ? input.databentoIngestionStatus
    : {};
  const dailyEvidenceScoringStatus = input.dailyEvidenceScoringStatus && typeof input.dailyEvidenceScoringStatus === 'object'
    ? input.dailyEvidenceScoringStatus
    : {};
  const dataCoverage = input.dataCoverage && typeof input.dataCoverage === 'object'
    ? input.dataCoverage
    : {};
  const foundationCounts = buildDbFoundationCounts(input.db);
  const evidenceSnapshot = buildEvidenceSnapshot({ dataCoverage });

  const openaiPresent = input.openaiKeyPresent === true;
  const anthropicPresent = !!toText(config.anthropicKey || '');
  const databentoPresent = !!toText(config.databento?.api?.key || '');
  const topstepPresent = !!toText(config.topstep?.api?.key || '');
  const discordPresent = !!toText(config.discord?.botToken || '');
  const newsEnabled = config.news?.enabled !== false;
  const newsConfigured = newsEnabled && !!toText(config.news?.calendarUrl || '');

  const databentoValidation = deriveDatabentoValidation({
    accessPresent: databentoPresent,
    databentoIngestionStatus,
  });
  const topstepValidation = deriveTopstepValidation({
    accessPresent: topstepPresent,
    topstepIntegrationAudit,
  });
  const discordValidation = deriveDiscordValidation({
    accessPresent: discordPresent,
    discordRuntime: input.discordRuntime,
    discordReady: input.discordReady === true,
  });
  const newsValidation = deriveNewsValidation({
    newsEnabled: newsConfigured,
    newsValidation: input.newsValidation,
  });

  const providers = [
    buildProviderRow({
      providerName: 'OpenAI',
      referencedInCode: true,
      envVarNames: ['OPENAI_API_KEY'],
      accessPresent: openaiPresent,
      envPresent: envPresence.OPENAI_API_KEY === true,
      keychainEligible: false,
      validationAttempted: false,
      validationResult: openaiPresent ? VALIDATION_UNKNOWN : VALIDATION_MISSING,
      lastSuccessfulValidationAt: null,
      jarvisUse: 'Assistant/analyst model calls and Codex-backed responses.',
      absentImpact: 'OpenAI-backed assistant/analyst paths are unavailable or fallback-only.',
    }),
    buildProviderRow({
      providerName: 'Anthropic',
      referencedInCode: true,
      envVarNames: ['ANTHROPIC_API_KEY'],
      accessPresent: anthropicPresent,
      envPresent: envPresence.ANTHROPIC_API_KEY === true,
      keychainEligible: true,
      validationAttempted: false,
      validationResult: anthropicPresent ? VALIDATION_UNKNOWN : VALIDATION_MISSING,
      lastSuccessfulValidationAt: null,
      jarvisUse: 'Fallback/alternate analyst model provider.',
      absentImpact: 'Anthropic fallback paths are unavailable.',
    }),
    buildProviderRow({
      providerName: 'Databento',
      referencedInCode: true,
      envVarNames: ['DATABENTO_API_KEY', 'DATABENTO_API_ENABLED'],
      accessPresent: databentoPresent,
      envPresent: envPresence.DATABENTO_API_KEY === true,
      keychainEligible: true,
      validationAttempted: databentoValidation.attempted,
      validationResult: databentoValidation.result,
      lastSuccessfulValidationAt: databentoValidation.lastSuccessfulValidationAt,
      jarvisUse: 'Historical market bar ingestion, gap recovery, and evidence-scoring inputs.',
      absentImpact: 'Automated historical bar intake, gap-fill, and evidence growth stall.',
    }),
    buildProviderRow({
      providerName: 'Topstep',
      referencedInCode: true,
      envVarNames: ['TOPSTEP_API_KEY', 'TOPSTEP_API_ENABLED', 'TOPSTEP_API_USERNAME'],
      accessPresent: topstepPresent,
      envPresent: envPresence.TOPSTEP_API_KEY === true,
      keychainEligible: true,
      validationAttempted: topstepValidation.attempted,
      validationResult: topstepValidation.result,
      lastSuccessfulValidationAt: topstepValidation.lastSuccessfulValidationAt,
      jarvisUse: 'Live account/auth validation, live feed snapshots, and sync health.',
      absentImpact: 'Live feed/audit visibility and account sync become unavailable.',
    }),
    buildProviderRow({
      providerName: 'Discord',
      referencedInCode: true,
      envVarNames: ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USER_IDS', 'DISCORD_ALLOWED_CHANNEL_IDS'],
      accessPresent: discordPresent,
      envPresent: envPresence.DISCORD_BOT_TOKEN === true,
      runtimeConfigOnly: false,
      validationAttempted: discordValidation.attempted,
      validationResult: discordValidation.result,
      lastSuccessfulValidationAt: discordValidation.lastSuccessfulValidationAt,
      jarvisUse: 'Control-bot notifications, approvals, and operational alerts.',
      absentImpact: 'Discord command/control and push notifications are disabled.',
    }),
    buildProviderRow({
      providerName: 'News Calendar Feed',
      referencedInCode: true,
      envVarNames: ['NEWS_ENABLED', 'NEWS_CALENDAR_URL'],
      accessPresent: newsConfigured,
      runtimeConfigOnly: true,
      validationAttempted: newsValidation.attempted,
      validationResult: newsValidation.result,
      lastSuccessfulValidationAt: newsValidation.lastSuccessfulValidationAt,
      jarvisUse: 'News lockout windows and scheduled macro-event context.',
      absentImpact: 'News risk gating degrades and macro-aware timing signals are weaker.',
    }),
  ];

  const providerValidation = {
    databento: databentoValidation.result,
    topstep: topstepValidation.result,
    discord: discordValidation.result,
    news: newsValidation.result,
  };
  const foundationState = buildFoundationSummary({
    foundationCounts,
    topstepIntegrationAudit,
    databentoIngestionStatus,
    dailyEvidenceScoringStatus,
    dataCoverage,
  });
  const majorBlockers = buildMajorBlockers({
    providerValidation,
    foundationCounts,
    topstepIntegrationAudit,
    dataCoverage,
    evidenceSnapshot,
  });
  const healthyProviders = providers
    .filter((p) => p.validationResult === VALIDATION_WORKING)
    .map((p) => p.providerName);
  const missingProviders = providers
    .filter((p) => p.validationResult === VALIDATION_MISSING)
    .map((p) => p.providerName);
  const providerHealthScore = round2(
    providers.length > 0
      ? (healthyProviders.length / providers.length) * 100
      : 0
  );

  return {
    generatedAt: new Date().toISOString(),
    currentRegimeLabel: toText(input.currentRegimeLabel || '') || null,
    providerInventory: providers,
    providerSummary: {
      totalProviders: providers.length,
      healthyProviders,
      missingProviders,
      healthScorePct: providerHealthScore,
    },
    dataFoundationState: foundationState,
    evidenceReadiness: evidenceSnapshot,
    evidenceReadinessSnapshot: evidenceSnapshot,
    majorBlockers,
    highestPriorityBlocker: majorBlockers[0] || null,
    warnings: uniqueList(input.warnings),
    advisoryOnly: true,
  };
}

module.exports = {
  buildSystemAuditSummary,
};
