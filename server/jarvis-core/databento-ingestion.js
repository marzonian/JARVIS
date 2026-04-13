'use strict';

const {
  ensureDataFoundationTables,
  normalizeDate,
  normalizeTimestamp,
  toNumber,
  toText,
} = require('./data-foundation-storage');

const PROVIDER_DATABENTO = 'databento';
const DEFAULT_DATASET = 'GLBX.MDP3';
const DEFAULT_SCHEMA = 'ohlcv-1m';
const DEFAULT_STYPE_IN = 'continuous';
const DEFAULT_SYMBOLS = ['MNQ.c.0', 'MES.c.0'];
const DEFAULT_LOOKBACK_DAYS = 120;
const DEFAULT_GAP_LOOKBACK_DAYS = 45;
const DEFAULT_MAX_RANGE_DAYS = 7;
const DEFAULT_RECENT_CLAMP_DAYS = 1;
const GAP_STATUS_OPEN = 'open';
const GAP_STATUS_RESOLVED = 'resolved';
const GAP_STATUS_DEFERRED_RECENT = 'deferred_recent';
const GAP_STATUS_RETRYABLE = 'retryable';

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function parseBool(value) {
  const txt = toText(value).toLowerCase();
  if (!txt) return false;
  return ['1', 'true', 'yes', 'on'].includes(txt);
}

function isoNow() {
  return new Date().toISOString();
}

function utcDateParts(isoDate = '') {
  const d = normalizeDate(isoDate);
  if (!d) return null;
  const parts = d.split('-').map((v) => Number(v));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return { y: parts[0], m: parts[1], d: parts[2] };
}

function toUtcMs(isoDate = '') {
  const parts = utcDateParts(isoDate);
  if (!parts) return null;
  return Date.UTC(parts.y, parts.m - 1, parts.d);
}

function addDays(isoDate, days) {
  const ms = toUtcMs(isoDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (Math.round(Number(days || 0)) * 86400000)).toISOString().slice(0, 10);
}

function compareIsoDate(a, b) {
  const left = normalizeDate(a);
  const right = normalizeDate(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function lowerText(value) {
  return toText(value).toLowerCase();
}

function isRetryableRecentStatus(status = '') {
  const txt = lowerText(status);
  return txt === GAP_STATUS_DEFERRED_RECENT || txt === GAP_STATUS_RETRYABLE;
}

function buildRecentBoundary(input = {}) {
  const requestedEndDate = normalizeDate(input.requestedEndDate || input.endDate || '');
  const nowDate = normalizeDate(input.nowDate || new Date().toISOString());
  const recentClampDays = clampInt(input.recentClampDays, 0, 5, DEFAULT_RECENT_CLAMP_DAYS);
  const fetchableEndDate = addDays(nowDate, -recentClampDays) || nowDate;
  const effectiveEndDate = compareIsoDate(requestedEndDate, fetchableEndDate) > 0
    ? fetchableEndDate
    : requestedEndDate;
  const clampApplied = !!requestedEndDate
    && !!effectiveEndDate
    && compareIsoDate(requestedEndDate, effectiveEndDate) > 0;
  const deferredRecentRange = clampApplied && compareIsoDate(addDays(effectiveEndDate, 1), requestedEndDate) <= 0
    ? {
      startDate: addDays(effectiveEndDate, 1),
      endDate: requestedEndDate,
      reason: 'recent_window_deferred',
      reasonCode: 'deferred_recent_window',
      status: GAP_STATUS_DEFERRED_RECENT,
      retryable: true,
      retryAfterDate: addDays(fetchableEndDate, 1) || requestedEndDate,
    }
    : null;
  return {
    nowDate,
    recentClampDays,
    requestedEndDate,
    fetchableEndDate,
    effectiveEndDate,
    clampApplied,
    deferredRecentRange,
  };
}

function buildGapRange(range = {}, defaults = {}) {
  const startDate = normalizeDate(range.startDate || range.gapStart || '');
  const endDate = normalizeDate(range.endDate || range.gapEnd || '');
  if (!startDate || !endDate || compareIsoDate(startDate, endDate) > 0) return null;
  const status = lowerText(range.status || defaults.status || GAP_STATUS_OPEN) || GAP_STATUS_OPEN;
  return {
    startDate,
    endDate,
    reason: toText(range.reason || defaults.reason || 'missing_range') || 'missing_range',
    reasonCode: toText(range.reasonCode || defaults.reasonCode || 'missing_range') || 'missing_range',
    status,
    retryable: range.retryable === true || defaults.retryable === true,
    retryAfterDate: normalizeDate(range.retryAfterDate || defaults.retryAfterDate || ''),
    details: range.details && typeof range.details === 'object' ? range.details : {},
  };
}

function classifyRangeFetchError(err, input = {}) {
  const statusCode = Number(err?.statusCode || err?.status || 0);
  const message = toText(err?.message || 'databento_range_fetch_failed') || 'databento_range_fetch_failed';
  const rangeEnd = normalizeDate(input?.range?.endDate || '');
  const rangeStart = normalizeDate(input?.range?.startDate || '');
  const fetchableEndDate = normalizeDate(input?.fetchableEndDate || '');
  const nearCurrentBoundary = !!fetchableEndDate
    && (
      (rangeEnd && compareIsoDate(rangeEnd, fetchableEndDate) >= 0)
      || (rangeStart && compareIsoDate(rangeStart, fetchableEndDate) >= 0)
    );
  if (statusCode === 422 && nearCurrentBoundary) {
    return {
      retryable: true,
      activeFailure: false,
      reasonCode: 'retryable_http_422_recent',
      reason: 'recent_window_retryable',
      status: GAP_STATUS_RETRYABLE,
      message,
      statusCode,
    };
  }
  return {
    retryable: false,
    activeFailure: true,
    reasonCode: statusCode === 422 ? 'http_422_range_failed' : 'range_fetch_failed',
    reason: statusCode === 422 ? 'http_422' : 'fetch_error',
    status: GAP_STATUS_OPEN,
    message,
    statusCode,
  };
}

function buildMissingRangeAuditEntry(range = {}, input = {}) {
  const fetchableEndDate = normalizeDate(input.fetchableEndDate || '');
  const endDate = normalizeDate(range?.endDate || '');
  const nearBoundary = !!fetchableEndDate
    && !!endDate
    && compareIsoDate(endDate, fetchableEndDate) >= 0;
  return buildGapRange(range, {
    status: nearBoundary ? GAP_STATUS_DEFERRED_RECENT : GAP_STATUS_OPEN,
    reason: nearBoundary ? 'recent_window_deferred' : 'missing_range',
    reasonCode: nearBoundary ? 'deferred_recent_window' : 'missing_range',
    retryable: nearBoundary,
    retryAfterDate: nearBoundary
      ? (addDays(fetchableEndDate, 1) || addDays(endDate, 1) || endDate)
      : null,
  });
}

function normalizeSymbols(input) {
  if (Array.isArray(input)) {
    return input
      .map((v) => toText(v))
      .filter(Boolean);
  }
  const txt = toText(input);
  if (!txt) return DEFAULT_SYMBOLS.slice();
  return txt.split(',').map((s) => toText(s)).filter(Boolean);
}

function collapseDateRanges(dates = []) {
  const sorted = Array.from(new Set((Array.isArray(dates) ? dates : []).map((d) => normalizeDate(d)).filter(Boolean))).sort();
  const out = [];
  let start = null;
  let prev = null;
  for (const d of sorted) {
    if (!start) {
      start = d;
      prev = d;
      continue;
    }
    const nextExpected = addDays(prev, 1);
    if (nextExpected && compareIsoDate(d, nextExpected) === 0) {
      prev = d;
      continue;
    }
    out.push({ startDate: start, endDate: prev });
    start = d;
    prev = d;
  }
  if (start) out.push({ startDate: start, endDate: prev || start });
  return out;
}

function enumerateWeekdays(startDate, endDate) {
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  if (!start || !end || compareIsoDate(start, end) > 0) return [];
  const out = [];
  let cursor = start;
  let guard = 0;
  while (cursor && compareIsoDate(cursor, end) <= 0 && guard < 2000) {
    const ms = toUtcMs(cursor);
    if (Number.isFinite(ms)) {
      const day = new Date(ms).getUTCDay();
      if (day >= 1 && day <= 5) out.push(cursor);
    }
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}

function splitCsvLine(line = '') {
  const out = [];
  let current = '';
  let quoted = false;
  const txt = String(line || '');
  for (let i = 0; i < txt.length; i += 1) {
    const ch = txt[i];
    if (ch === '"') {
      if (quoted && txt[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseCsvRows(csvText = '') {
  const lines = String(csvText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => toText(line).length > 0);
  if (lines.length <= 1) return [];
  const headers = splitCsvLine(lines[0]).map((h) => toText(h));
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = cells[j] != null ? cells[j] : '';
    }
    rows.push(row);
  }
  return rows;
}

function pickFirstField(row = {}, names = []) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && toText(row[name])) return row[name];
  }
  return '';
}

function normalizeBarRow(row = {}, fallbackSymbol = '') {
  const tsEventRaw = pickFirstField(row, ['ts_event', 'timestamp', 'ts_recv', 'time']);
  const tsEvent = normalizeTimestamp(tsEventRaw);
  if (!tsEvent) return null;
  const symbol = toText(pickFirstField(row, ['symbol', 'raw_symbol', 'ticker']) || fallbackSymbol);
  if (!symbol) return null;
  const out = {
    symbol,
    tsEvent,
    open: toNumber(pickFirstField(row, ['open', 'o']), null),
    high: toNumber(pickFirstField(row, ['high', 'h']), null),
    low: toNumber(pickFirstField(row, ['low', 'l']), null),
    close: toNumber(pickFirstField(row, ['close', 'c']), null),
    volume: toNumber(pickFirstField(row, ['volume', 'v']), null),
    raw: row,
  };
  if (!Number.isFinite(out.open) && !Number.isFinite(out.close)) return null;
  return out;
}

function buildDatabentoAuthHeader(apiKey = '') {
  const token = Buffer.from(`${String(apiKey || '')}:`).toString('base64');
  return `Basic ${token}`;
}

function buildDatabentoUrl(input = {}) {
  const baseUrl = toText(input.baseUrl || 'https://hist.databento.com').replace(/\/+$/, '');
  const endpoint = toText(input.endpoint || '/v0/timeseries.get_range').replace(/^\/+/, '');
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set('dataset', toText(input.dataset || DEFAULT_DATASET));
  url.searchParams.set('schema', toText(input.schemaName || DEFAULT_SCHEMA));
  url.searchParams.set('stype_in', toText(input.stypeIn || DEFAULT_STYPE_IN));
  url.searchParams.set('symbols', toText(input.symbols || 'MNQ.c.0'));
  if (toText(input.start)) url.searchParams.set('start', toText(input.start));
  if (toText(input.end)) url.searchParams.set('end', toText(input.end));
  url.searchParams.set('encoding', toText(input.encoding || 'csv'));
  return url.toString();
}

async function fetchDatabentoCsvRange(input = {}) {
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : fetch;
  const url = buildDatabentoUrl(input);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: buildDatabentoAuthHeader(input.apiKey || ''),
      Accept: 'text/csv',
    },
    signal: AbortSignal.timeout(Math.max(2_000, Number(input.timeoutMs || 30_000))),
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`databento_http_${response.status}`);
    err.statusCode = response.status;
    err.details = text.slice(0, 300);
    throw err;
  }
  return { url, csvText: text };
}

function getSymbolCoverage(db, input = {}) {
  ensureDataFoundationTables(db);
  const provider = toText(input.provider || PROVIDER_DATABENTO);
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const symbol = toText(input.symbol || 'MNQ.c.0');
  const row = db.prepare(`
    SELECT
      MIN(substr(ts_event, 1, 10)) AS first_date,
      MAX(substr(ts_event, 1, 10)) AS last_date,
      MAX(ts_event) AS last_ts,
      COUNT(*) AS bar_count
    FROM jarvis_market_bars_raw
    WHERE provider = ? AND dataset = ? AND schema_name = ? AND symbol = ?
  `).get(provider, dataset, schemaName, symbol) || {};
  const dateRows = db.prepare(`
    SELECT DISTINCT substr(ts_event, 1, 10) AS d
    FROM jarvis_market_bars_raw
    WHERE provider = ? AND dataset = ? AND schema_name = ? AND symbol = ?
    ORDER BY d ASC
  `).all(provider, dataset, schemaName, symbol);
  return {
    firstDate: normalizeDate(row.first_date),
    lastDate: normalizeDate(row.last_date),
    lastTs: toText(row.last_ts) || null,
    barCount: Number(row.bar_count || 0),
    coveredDates: dateRows.map((r) => normalizeDate(r.d)).filter(Boolean),
  };
}

function getIngestionState(db, input = {}) {
  ensureDataFoundationTables(db);
  const provider = toText(input.provider || PROVIDER_DATABENTO);
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const symbol = toText(input.symbol || 'MNQ.c.0');
  const row = db.prepare(`
    SELECT *
    FROM jarvis_databento_ingestion_state
    WHERE provider = ? AND dataset = ? AND schema_name = ? AND symbol = ?
    LIMIT 1
  `).get(provider, dataset, schemaName, symbol);
  if (!row) return null;
  return {
    provider,
    dataset,
    schemaName,
    symbol,
    lastSuccessTs: toText(row.last_success_ts) || null,
    lastSuccessDate: normalizeDate(row.last_success_date),
    lastAttemptAt: toText(row.last_attempt_at) || null,
    lastStatus: toText(row.last_status) || null,
    lastErrorMessage: toText(row.last_error_message) || null,
    updatedAt: toText(row.updated_at) || null,
  };
}

function detectMissingRanges(coveredDates = [], startDate = '', endDate = '') {
  const covered = new Set((Array.isArray(coveredDates) ? coveredDates : []).map((d) => normalizeDate(d)).filter(Boolean));
  const expected = enumerateWeekdays(startDate, endDate);
  const missingDates = expected.filter((d) => !covered.has(d));
  return collapseDateRanges(missingDates);
}

function splitRangesByMaxDays(ranges = [], maxDays = DEFAULT_MAX_RANGE_DAYS) {
  const out = [];
  const safeMax = Math.max(1, Math.min(31, Number(maxDays || DEFAULT_MAX_RANGE_DAYS)));
  for (const range of ranges) {
    const start = normalizeDate(range?.startDate || '');
    const end = normalizeDate(range?.endDate || '');
    if (!start || !end || compareIsoDate(start, end) > 0) continue;
    let cursor = start;
    let guard = 0;
    while (cursor && compareIsoDate(cursor, end) <= 0 && guard < 500) {
      const chunkEnd = addDays(cursor, safeMax - 1) || cursor;
      const boundedEnd = compareIsoDate(chunkEnd, end) > 0 ? end : chunkEnd;
      out.push({
        startDate: cursor,
        endDate: boundedEnd,
        reason: toText(range.reason || 'missing_range') || 'missing_range',
      });
      cursor = addDays(boundedEnd, 1);
      guard += 1;
    }
  }
  return out;
}

function mergeRanges(ranges = []) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({
      startDate: normalizeDate(r?.startDate || ''),
      endDate: normalizeDate(r?.endDate || ''),
      reason: toText(r?.reason || '') || 'missing_range',
    }))
    .filter((r) => r.startDate && r.endDate && compareIsoDate(r.startDate, r.endDate) <= 0)
    .sort((a, b) => compareIsoDate(a.startDate, b.startDate));

  const out = [];
  for (const range of normalized) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...range });
      continue;
    }
    const prevNext = addDays(prev.endDate, 1);
    if (prevNext && compareIsoDate(range.startDate, prevNext) <= 0) {
      if (compareIsoDate(range.endDate, prev.endDate) > 0) prev.endDate = range.endDate;
      if (prev.reason !== range.reason) prev.reason = 'mixed';
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

function buildAutoStartDate(input = {}) {
  const endDate = normalizeDate(input.endDate);
  const lookbackDays = clampInt(input.lookbackDays, 20, 720, DEFAULT_LOOKBACK_DAYS);
  if (!endDate) return '';
  return addDays(endDate, -Math.max(1, lookbackDays - 1));
}

function buildIngestionPlanForSymbol(db, input = {}) {
  const modeRaw = toText(input.mode || 'auto').toLowerCase();
  const mode = modeRaw === 'full_backfill' || modeRaw === 'incremental' ? modeRaw : 'auto';
  const provider = toText(input.provider || PROVIDER_DATABENTO);
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const symbol = toText(input.symbol || 'MNQ.c.0');
  const requestedEndDate = normalizeDate(input.endDate || new Date().toISOString());
  const recentBoundary = buildRecentBoundary({
    requestedEndDate,
    nowDate: input.nowDate,
    recentClampDays: input.recentClampDays,
  });
  const endDate = normalizeDate(recentBoundary.effectiveEndDate || requestedEndDate);
  const explicitStartDate = normalizeDate(input.startDate || '');
  const autoStartDate = buildAutoStartDate({ endDate, lookbackDays: input.lookbackDays });
  const startDate = explicitStartDate || autoStartDate;
  const gapLookbackDays = clampInt(input.gapLookbackDays, 5, 180, DEFAULT_GAP_LOOKBACK_DAYS);

  const coverage = getSymbolCoverage(db, { provider, dataset, schemaName, symbol });
  const state = getIngestionState(db, { provider, dataset, schemaName, symbol });
  const lookbackStart = addDays(endDate, -Math.max(1, gapLookbackDays - 1)) || startDate;
  const gapStart = coverage.firstDate
    ? (compareIsoDate(coverage.firstDate, lookbackStart) > 0 ? coverage.firstDate : lookbackStart)
    : lookbackStart;
  const missingRanges = endDate && gapStart && compareIsoDate(gapStart, endDate) <= 0
    ? detectMissingRanges(coverage.coveredDates, gapStart, endDate)
    : [];

  const planned = [];
  if (mode === 'full_backfill') {
    if (startDate && endDate && compareIsoDate(startDate, endDate) <= 0) {
      planned.push({ startDate, endDate, reason: 'full_backfill' });
    }
  } else {
    let resumeStartDate = '';
    const stateDate = normalizeDate(state?.lastSuccessTs || state?.lastSuccessDate || '');
    if (stateDate) resumeStartDate = stateDate;
    else if (coverage.lastDate) resumeStartDate = addDays(coverage.lastDate, 1);
    else resumeStartDate = startDate;

    if (resumeStartDate && endDate && compareIsoDate(resumeStartDate, endDate) <= 0) {
      planned.push({ startDate: resumeStartDate, endDate, reason: 'incremental_append' });
    }
    if (mode === 'auto' || mode === 'incremental') {
      for (const gap of missingRanges) {
        planned.push({
          startDate: gap.startDate,
          endDate: gap.endDate,
          reason: 'gap_recovery',
        });
      }
    }
  }

  const merged = mergeRanges(planned);
  const split = splitRangesByMaxDays(merged, input.maxRangeDays);
  const deferredRanges = [];
  if (recentBoundary.deferredRecentRange) {
    deferredRanges.push(buildGapRange(recentBoundary.deferredRecentRange, {
      status: GAP_STATUS_DEFERRED_RECENT,
      reason: 'recent_window_deferred',
      reasonCode: 'deferred_recent_window',
      retryable: true,
    }));
  }
  return {
    mode,
    provider,
    dataset,
    schemaName,
    stypeIn: toText(input.stypeIn || DEFAULT_STYPE_IN),
    symbol,
    startDate,
    endDate,
    requestedEndDate,
    fetchableEndDate: normalizeDate(recentBoundary.fetchableEndDate || ''),
    clampApplied: recentBoundary.clampApplied === true,
    recentClampDays: recentBoundary.recentClampDays,
    deferredRanges: deferredRanges.filter(Boolean),
    coverage,
    state,
    missingRanges,
    plannedRanges: split,
  };
}

function upsertIngestionState(db, input = {}) {
  ensureDataFoundationTables(db);
  db.prepare(`
    INSERT INTO jarvis_databento_ingestion_state (
      provider,
      dataset,
      schema_name,
      stype_in,
      symbol,
      last_success_ts,
      last_success_date,
      last_attempt_at,
      last_status,
      last_error_message,
      updated_at
    ) VALUES (
      @provider,
      @dataset,
      @schema_name,
      @stype_in,
      @symbol,
      @last_success_ts,
      @last_success_date,
      @last_attempt_at,
      @last_status,
      @last_error_message,
      datetime('now')
    )
    ON CONFLICT(provider, dataset, schema_name, symbol) DO UPDATE SET
      stype_in = excluded.stype_in,
      last_success_ts = COALESCE(excluded.last_success_ts, jarvis_databento_ingestion_state.last_success_ts),
      last_success_date = COALESCE(excluded.last_success_date, jarvis_databento_ingestion_state.last_success_date),
      last_attempt_at = excluded.last_attempt_at,
      last_status = excluded.last_status,
      last_error_message = excluded.last_error_message,
      updated_at = datetime('now')
  `).run({
    provider: toText(input.provider || PROVIDER_DATABENTO),
    dataset: toText(input.dataset || DEFAULT_DATASET),
    schema_name: toText(input.schemaName || DEFAULT_SCHEMA),
    stype_in: toText(input.stypeIn || DEFAULT_STYPE_IN),
    symbol: toText(input.symbol || 'MNQ.c.0'),
    last_success_ts: toText(input.lastSuccessTs || '') || null,
    last_success_date: normalizeDate(input.lastSuccessDate || ''),
    last_attempt_at: toText(input.lastAttemptAt || isoNow()) || isoNow(),
    last_status: toText(input.lastStatus || ''),
    last_error_message: toText(input.lastErrorMessage || '') || null,
  });
}

function syncGapAudit(db, input = {}) {
  ensureDataFoundationTables(db);
  const provider = toText(input.provider || PROVIDER_DATABENTO);
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const symbol = toText(input.symbol || 'MNQ.c.0');
  const ranges = Array.isArray(input.missingRanges) ? input.missingRanges : [];
  const keys = new Set();
  const upsert = db.prepare(`
    INSERT INTO jarvis_databento_gap_audit (
      provider, dataset, schema_name, symbol, gap_start, gap_end, status, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, dataset, schema_name, symbol, gap_start, gap_end) DO UPDATE SET
      status = excluded.status,
      details_json = excluded.details_json,
      resolved_at = CASE
        WHEN excluded.status = '${GAP_STATUS_RESOLVED}' THEN datetime('now')
        ELSE NULL
      END
  `);
  for (const range of ranges) {
    const normalized = buildGapRange(range, { status: GAP_STATUS_OPEN });
    if (!normalized) continue;
    const startDate = normalized.startDate;
    const endDate = normalized.endDate;
    const key = `${startDate}|${endDate}`;
    keys.add(key);
    const details = {
      source: 'coverage_scan',
      generatedAt: isoNow(),
      reason: normalized.reason,
      reasonCode: normalized.reasonCode,
      retryable: normalized.retryable === true,
      retryAfterDate: normalized.retryAfterDate || null,
      ...(normalized.details && typeof normalized.details === 'object' ? normalized.details : {}),
    };
    upsert.run(
      provider,
      dataset,
      schemaName,
      symbol,
      startDate,
      endDate,
      normalized.status,
      JSON.stringify(details)
    );
  }

  const unresolvedRows = db.prepare(`
    SELECT id, gap_start, gap_end
    FROM jarvis_databento_gap_audit
    WHERE provider = ? AND dataset = ? AND schema_name = ? AND symbol = ? AND status != '${GAP_STATUS_RESOLVED}'
  `).all(provider, dataset, schemaName, symbol);
  for (const row of unresolvedRows) {
    const key = `${normalizeDate(row.gap_start)}|${normalizeDate(row.gap_end)}`;
    if (keys.has(key)) continue;
    db.prepare(`
      UPDATE jarvis_databento_gap_audit
      SET status = '${GAP_STATUS_RESOLVED}', resolved_at = datetime('now')
      WHERE id = ?
    `).run(row.id);
  }
}

function insertBarsForRange(db, input = {}) {
  ensureDataFoundationTables(db);
  const provider = toText(input.provider || PROVIDER_DATABENTO);
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const stypeIn = toText(input.stypeIn || DEFAULT_STYPE_IN);
  const symbol = toText(input.symbol || 'MNQ.c.0');
  const sourceType = toText(input.sourceType || 'historical') || 'historical';
  const sourceRunId = toNumber(input.sourceRunId, null);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jarvis_market_bars_raw (
      provider, dataset, schema_name, stype_in, symbol, ts_event,
      open, high, low, close, volume, raw_json, source_type, source_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  let maxTs = null;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeBarRow(row, symbol);
      if (!normalized) continue;
      const result = insert.run(
        provider,
        dataset,
        schemaName,
        stypeIn,
        normalized.symbol || symbol,
        normalized.tsEvent,
        normalized.open,
        normalized.high,
        normalized.low,
        normalized.close,
        normalized.volume,
        JSON.stringify(normalized.raw || {}),
        sourceType,
        sourceRunId
      );
      if (Number(result.changes || 0) > 0) inserted += 1;
      if (!maxTs || String(normalized.tsEvent) > String(maxTs)) maxTs = normalized.tsEvent;
    }
  });
  tx();
  return { inserted, maxTs };
}

function persistIngestionRun(db, input = {}) {
  ensureDataFoundationTables(db);
  const row = db.prepare(`
    INSERT INTO jarvis_databento_ingestion_runs (
      provider,
      mode,
      dataset,
      schema_name,
      stype_in,
      symbol,
      range_start,
      range_end,
      rows_fetched,
      rows_inserted,
      missing_ranges_json,
      status,
      error_message,
      details_json,
      started_at,
      finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    toText(input.provider || PROVIDER_DATABENTO),
    toText(input.mode || 'auto') || 'auto',
    toText(input.dataset || DEFAULT_DATASET),
    toText(input.schemaName || DEFAULT_SCHEMA),
    toText(input.stypeIn || DEFAULT_STYPE_IN),
    toText(input.symbol || 'MNQ.c.0'),
    normalizeDate(input.rangeStart || ''),
    normalizeDate(input.rangeEnd || ''),
    Number(input.rowsFetched || 0),
    Number(input.rowsInserted || 0),
    JSON.stringify(Array.isArray(input.missingRanges) ? input.missingRanges : []),
    toText(input.status || 'noop') || 'noop',
    toText(input.errorMessage || '') || null,
    JSON.stringify(input.details || {}),
    toText(input.startedAt || isoNow()),
    toText(input.finishedAt || isoNow())
  );
  return Number(row.lastInsertRowid || 0) || 0;
}

async function runDatabentoIngestion(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'error',
      error: 'db_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDataFoundationTables(db);
  const apiKey = toText(input.apiKey || '');
  const modeRaw = toText(input.mode || 'auto').toLowerCase();
  const mode = modeRaw === 'full_backfill' || modeRaw === 'incremental' ? modeRaw : 'auto';
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const stypeIn = toText(input.stypeIn || DEFAULT_STYPE_IN);
  const symbols = normalizeSymbols(input.symbols || input.symbol || DEFAULT_SYMBOLS);
  const startDate = normalizeDate(input.startDate || '');
  const nowDate = normalizeDate(input.nowDate || new Date().toISOString());
  const endDate = normalizeDate(input.endDate || nowDate);
  const recentClampDays = clampInt(input.recentClampDays, 0, 5, DEFAULT_RECENT_CLAMP_DAYS);
  const force = parseBool(input.force) || input.force === true;
  const warnings = [];
  const startedAt = isoNow();
  const perSymbol = [];
  let totalFetched = 0;
  let totalInserted = 0;
  let status = 'noop';

  if (!apiKey) {
    warnings.push('databento_api_key_missing');
  }

  for (const symbol of symbols) {
    const plan = buildIngestionPlanForSymbol(db, {
      provider: PROVIDER_DATABENTO,
      mode,
      dataset,
      schemaName,
      stypeIn,
      symbol,
      startDate,
      endDate,
      nowDate,
      recentClampDays,
      lookbackDays: input.lookbackDays,
      gapLookbackDays: input.gapLookbackDays,
      maxRangeDays: input.maxRangeDays,
    });
    const symbolSummary = {
      symbol,
      mode: plan.mode,
      rangeStart: plan.startDate,
      rangeEnd: plan.endDate,
      requestedRangeEnd: plan.requestedEndDate || plan.endDate,
      fetchableEndDate: plan.fetchableEndDate || plan.endDate,
      rangeClampApplied: plan.clampApplied === true,
      recentClampDays: plan.recentClampDays,
      missingRangesBefore: plan.missingRanges,
      plannedRanges: plan.plannedRanges,
      fetchedRanges: [],
      deferredRanges: Array.isArray(plan.deferredRanges) ? plan.deferredRanges : [],
      retryableRanges: [],
      hardErrorRanges: [],
      rowsFetched: 0,
      rowsInserted: 0,
      status: 'noop',
      error: null,
      coverageBefore: plan.coverage,
      coverageAfter: null,
      stateBefore: plan.state,
      stateAfter: null,
    };

    if (!apiKey) {
      symbolSummary.status = 'disabled';
      perSymbol.push(symbolSummary);
      continue;
    }

    const ranges = force
      ? splitRangesByMaxDays(
        (plan.startDate && plan.endDate && compareIsoDate(plan.startDate, plan.endDate) <= 0)
          ? [{ startDate: plan.startDate, endDate: plan.endDate, reason: 'forced_refresh' }]
          : [],
        input.maxRangeDays
      )
      : plan.plannedRanges;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      const coverageAfterNoop = getSymbolCoverage(db, {
        provider: PROVIDER_DATABENTO,
        dataset,
        schemaName,
        symbol,
      });
      const missingAfterNoop = plan.startDate && plan.endDate && compareIsoDate(plan.startDate, plan.endDate) <= 0
        ? detectMissingRanges(coverageAfterNoop.coveredDates, plan.startDate, plan.endDate)
        : [];
      const gapRanges = [
        ...missingAfterNoop
          .map((r) => buildMissingRangeAuditEntry(r, {
            fetchableEndDate: plan.fetchableEndDate,
          }))
          .filter(Boolean),
        ...(Array.isArray(plan.deferredRanges) ? plan.deferredRanges : []),
      ];
      syncGapAudit(db, {
        provider: PROVIDER_DATABENTO,
        dataset,
        schemaName,
        symbol,
        missingRanges: gapRanges,
      });
      if (Array.isArray(plan.deferredRanges) && plan.deferredRanges.length > 0) {
        warnings.push(`${symbol}:deferred_recent_window`);
      }
      symbolSummary.coverageAfter = coverageAfterNoop;
      symbolSummary.missingRangesAfter = missingAfterNoop;
      symbolSummary.retryableRanges = [];
      symbolSummary.hardErrorRanges = [];
      symbolSummary.stateAfter = getIngestionState(db, {
        provider: PROVIDER_DATABENTO,
        dataset,
        schemaName,
        symbol,
      });
      perSymbol.push(symbolSummary);
      continue;
    }

    let latestTs = null;
    let hasHardErrors = false;
    const retryableRanges = [];
    const hardErrorRanges = [];
    for (const range of ranges) {
      try {
        const rangeStartIso = normalizeDate(range.startDate);
        const rangeEndIso = normalizeDate(range.endDate);
        const start = `${rangeStartIso}T00:00:00Z`;
        const end = `${rangeEndIso}T23:59:59Z`;
        const fetched = typeof input.fetchRangeFn === 'function'
          ? await Promise.resolve(input.fetchRangeFn({
            symbol,
            dataset,
            schemaName,
            stypeIn,
            start,
            end,
            range,
          }))
          : await fetchDatabentoCsvRange({
            apiKey,
            baseUrl: input.baseUrl,
            endpoint: input.endpoint,
            dataset,
            schemaName,
            stypeIn,
            symbols: symbol,
            start,
            end,
            timeoutMs: input.timeoutMs,
            fetchImpl: input.fetchImpl,
          });
        const csvText = String(fetched?.csvText || '').trim();
        const parsedRows = csvText ? parseCsvRows(csvText) : [];
        const inserted = insertBarsForRange(db, {
          provider: PROVIDER_DATABENTO,
          dataset,
          schemaName,
          stypeIn,
          symbol,
          sourceType: 'historical',
          rows: parsedRows,
        });
        symbolSummary.rowsFetched += parsedRows.length;
        symbolSummary.rowsInserted += inserted.inserted;
        if (inserted.maxTs && (!latestTs || String(inserted.maxTs) > String(latestTs))) latestTs = inserted.maxTs;
        symbolSummary.fetchedRanges.push({
          startDate: range.startDate,
          endDate: range.endDate,
          reason: range.reason,
          reasonCode: toText(range.reasonCode || range.reason || 'fetch_success') || 'fetch_success',
          outcome: 'fetched',
          rowsFetched: parsedRows.length,
          rowsInserted: inserted.inserted,
        });
      } catch (err) {
        const classified = classifyRangeFetchError(err, {
          range,
          fetchableEndDate: plan.fetchableEndDate,
        });
        const message = classified.message;
        const gapRange = buildGapRange(range, {
          status: classified.status,
          reason: classified.reason,
          reasonCode: classified.reasonCode,
          retryable: classified.retryable,
          retryAfterDate: classified.retryable
            ? (addDays(plan.fetchableEndDate, 1) || plan.requestedEndDate || plan.endDate)
            : null,
          details: {
            source: 'range_fetch_error',
            errorMessage: message,
            statusCode: classified.statusCode || null,
          },
        });
        if (classified.activeFailure) hasHardErrors = true;
        if (gapRange) {
          if (classified.retryable) retryableRanges.push(gapRange);
          else hardErrorRanges.push(gapRange);
        }
        symbolSummary.fetchedRanges.push({
          startDate: range.startDate,
          endDate: range.endDate,
          reason: range.reason,
          reasonCode: classified.reasonCode,
          outcome: classified.retryable ? 'retryable' : 'error',
          rowsFetched: 0,
          rowsInserted: 0,
          error: message,
        });
        warnings.push(`${symbol}:${range.startDate}:${classified.reasonCode}`);
      }
    }

    const coverageAfter = getSymbolCoverage(db, {
      provider: PROVIDER_DATABENTO,
      dataset,
      schemaName,
      symbol,
    });
    const missingAfter = plan.startDate && plan.endDate && compareIsoDate(plan.startDate, plan.endDate) <= 0
      ? detectMissingRanges(coverageAfter.coveredDates, plan.startDate, plan.endDate)
      : [];
    const missingGapRanges = missingAfter
      .map((r) => buildMissingRangeAuditEntry(r, {
        fetchableEndDate: plan.fetchableEndDate,
      }))
      .filter(Boolean);
    const deferredRanges = Array.isArray(plan.deferredRanges) ? plan.deferredRanges : [];
    syncGapAudit(db, {
      provider: PROVIDER_DATABENTO,
      dataset,
      schemaName,
      symbol,
      missingRanges: [
        ...missingGapRanges,
        ...deferredRanges,
        ...retryableRanges,
        ...hardErrorRanges,
      ],
    });

    const symbolStatus = hasHardErrors
      ? (symbolSummary.rowsInserted > 0 ? 'partial' : 'error')
      : (symbolSummary.rowsInserted > 0 ? 'ok' : 'noop');
    symbolSummary.status = symbolStatus;
    symbolSummary.coverageAfter = coverageAfter;
    symbolSummary.missingRangesAfter = missingAfter;
    symbolSummary.retryableRanges = retryableRanges;
    symbolSummary.hardErrorRanges = hardErrorRanges;

    upsertIngestionState(db, {
      provider: PROVIDER_DATABENTO,
      dataset,
      schemaName,
      stypeIn,
      symbol,
      lastSuccessTs: latestTs || coverageAfter.lastTs || null,
      lastSuccessDate: normalizeDate(latestTs || coverageAfter.lastDate || ''),
      lastAttemptAt: isoNow(),
      lastStatus: symbolStatus,
      lastErrorMessage: hasHardErrors ? warnings[warnings.length - 1] || null : null,
    });

    const runId = persistIngestionRun(db, {
      provider: PROVIDER_DATABENTO,
      mode,
      dataset,
      schemaName,
      stypeIn,
      symbol,
      rangeStart: plan.startDate,
      rangeEnd: plan.requestedEndDate || plan.endDate,
      rowsFetched: symbolSummary.rowsFetched,
      rowsInserted: symbolSummary.rowsInserted,
      missingRanges: [
        ...missingGapRanges,
        ...deferredRanges,
        ...retryableRanges,
        ...hardErrorRanges,
      ],
      status: symbolStatus,
      errorMessage: hasHardErrors ? toText(warnings[warnings.length - 1] || '') || null : null,
      details: {
        requestedEndDate: plan.requestedEndDate || plan.endDate,
        fetchableEndDate: plan.fetchableEndDate || plan.endDate,
        rangeClampApplied: plan.clampApplied === true,
        recentClampDays: plan.recentClampDays,
        plannedRanges: ranges,
        deferredRanges,
        retryableRanges,
        hardErrorRanges,
        fetchedRanges: symbolSummary.fetchedRanges,
        coverageBefore: plan.coverage,
        coverageAfter,
      },
      startedAt,
      finishedAt: isoNow(),
    });
    symbolSummary.runId = runId;
    symbolSummary.stateAfter = getIngestionState(db, {
      provider: PROVIDER_DATABENTO,
      dataset,
      schemaName,
      symbol,
    });

    perSymbol.push(symbolSummary);
    totalFetched += symbolSummary.rowsFetched;
    totalInserted += symbolSummary.rowsInserted;
  }

  if (perSymbol.some((s) => s.status === 'error')) status = 'partial';
  if (perSymbol.every((s) => s.status === 'error')) status = 'error';
  if (perSymbol.some((s) => s.status === 'ok')) status = (status === 'error' ? 'partial' : 'ok');
  if (perSymbol.every((s) => s.status === 'disabled')) status = 'disabled';
  if (perSymbol.length === 0) status = 'noop';
  if (status === 'noop' && totalInserted > 0) status = 'ok';

  return {
    generatedAt: isoNow(),
    provider: PROVIDER_DATABENTO,
    mode,
    dataset,
    schemaName,
    stypeIn,
    symbols,
    startDate: startDate || null,
    endDate,
    nowDate,
    recentClampDays,
    totalFetched,
    totalInserted,
    perSymbol,
    warnings,
    status,
    advisoryOnly: true,
  };
}

function buildDatabentoIngestionStatus(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    return {
      status: 'error',
      error: 'db_unavailable',
      advisoryOnly: true,
    };
  }
  ensureDataFoundationTables(db);
  const dataset = toText(input.dataset || DEFAULT_DATASET);
  const schemaName = toText(input.schemaName || DEFAULT_SCHEMA);
  const symbols = normalizeSymbols(input.symbols || input.symbol || DEFAULT_SYMBOLS);
  const startDate = normalizeDate(input.startDate || '');
  const nowDate = normalizeDate(input.nowDate || new Date().toISOString());
  const endDate = normalizeDate(input.endDate || nowDate);
  const recentClampDays = clampInt(input.recentClampDays, 0, 5, DEFAULT_RECENT_CLAMP_DAYS);
  const rows = [];
  for (const symbol of symbols) {
    const plan = buildIngestionPlanForSymbol(db, {
      provider: PROVIDER_DATABENTO,
      mode: input.mode || 'auto',
      dataset,
      schemaName,
      stypeIn: input.stypeIn || DEFAULT_STYPE_IN,
      symbol,
      startDate,
      endDate,
      nowDate,
      recentClampDays,
      lookbackDays: input.lookbackDays,
      gapLookbackDays: input.gapLookbackDays,
      maxRangeDays: input.maxRangeDays,
    });
    rows.push({
      symbol,
      coverage: plan.coverage,
      state: plan.state,
      missingRanges: plan.missingRanges,
      plannedRanges: plan.plannedRanges,
      requestedEndDate: plan.requestedEndDate || plan.endDate,
      fetchableEndDate: plan.fetchableEndDate || plan.endDate,
      rangeClampApplied: plan.clampApplied === true,
      deferredRanges: Array.isArray(plan.deferredRanges) ? plan.deferredRanges : [],
      advisoryOnly: true,
    });
  }
  const latestRuns = db.prepare(`
    SELECT *
    FROM jarvis_databento_ingestion_runs
    ORDER BY id DESC
    LIMIT 12
  `).all().map((row) => ({
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    dataset: row.dataset,
    schemaName: row.schema_name,
    symbol: row.symbol,
    rangeStart: normalizeDate(row.range_start),
    rangeEnd: normalizeDate(row.range_end),
    rowsFetched: Number(row.rows_fetched || 0),
    rowsInserted: Number(row.rows_inserted || 0),
    status: toText(row.status || '') || 'noop',
    errorMessage: toText(row.error_message || '') || null,
    createdAt: toText(row.created_at || '') || null,
  }));
  return {
    generatedAt: isoNow(),
    provider: PROVIDER_DATABENTO,
    dataset,
    schemaName,
    symbols,
    startDate: startDate || null,
    endDate,
    nowDate,
    recentClampDays,
    symbolsStatus: rows,
    latestRuns,
    advisoryOnly: true,
  };
}

module.exports = {
  PROVIDER_DATABENTO,
  DEFAULT_DATASET,
  DEFAULT_SCHEMA,
  DEFAULT_STYPE_IN,
  DEFAULT_SYMBOLS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_GAP_LOOKBACK_DAYS,
  DEFAULT_MAX_RANGE_DAYS,
  DEFAULT_RECENT_CLAMP_DAYS,
  parseCsvRows,
  normalizeBarRow,
  detectMissingRanges,
  buildIngestionPlanForSymbol,
  runDatabentoIngestion,
  buildDatabentoIngestionStatus,
  fetchDatabentoCsvRange,
};
