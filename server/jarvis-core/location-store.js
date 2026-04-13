'use strict';

function normalizeToken(value) {
  const txt = String(value || '').trim();
  if (!txt) return null;
  return txt.replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 180) || null;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTimestampMs(input, nowMs) {
  if (input == null || input === '') return nowMs;
  if (typeof input === 'number' && Number.isFinite(input)) {
    // Support seconds or milliseconds epoch.
    if (input > 10_000_000_000) return Math.round(input);
    return Math.round(input * 1000);
  }
  const asNum = Number(input);
  if (Number.isFinite(asNum)) {
    if (asNum > 10_000_000_000) return Math.round(asNum);
    return Math.round(asNum * 1000);
  }
  const parsed = Date.parse(String(input));
  if (Number.isFinite(parsed)) return parsed;
  return NaN;
}

function formatLocationRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    lat: row.lat,
    lon: row.lon,
    accuracy: row.accuracy,
    ts: row.ts,
    source: row.source || null,
    consent: row.consent === true,
  };
}

function createJarvisLocationStore(options = {}) {
  const ttlMs = Math.max(1_000, Number(options.ttlMs || 30 * 60 * 1000));
  const maxBackdateMs = Math.max(60_000, Number(options.maxBackdateMs || 10 * 60 * 1000));
  const maxFutureSkewMs = Math.max(5_000, Number(options.maxFutureSkewMs || 5 * 60 * 1000));
  const dbFactory = typeof options.dbFactory === 'function' ? options.dbFactory : null;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const store = new Map();

  let persistenceReady = false;
  let insertEventStmt = null;

  function ensurePersistence() {
    if (persistenceReady) return;
    persistenceReady = true;
    if (!dbFactory) return;
    try {
      const db = dbFactory();
      if (!db) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS jarvis_location_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          client_id TEXT,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          accuracy REAL,
          ts TEXT NOT NULL,
          source TEXT,
          user_agent TEXT,
          consent INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_jarvis_location_events_session ON jarvis_location_events(session_id, created_at DESC);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_jarvis_location_events_created ON jarvis_location_events(created_at DESC);');
      insertEventStmt = db.prepare(`
        INSERT INTO jarvis_location_events
          (session_id, client_id, lat, lon, accuracy, ts, source, user_agent, consent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch {
      insertEventStmt = null;
    }
  }

  function writeEvent(row) {
    ensurePersistence();
    if (!insertEventStmt) return;
    try {
      insertEventStmt.run(
        row.sessionId,
        row.clientId || null,
        row.lat,
        row.lon,
        row.accuracy,
        row.ts,
        row.source || null,
        row.userAgent || null,
        row.consent === true ? 1 : 0
      );
    } catch {}
  }

  function readRowBySession(sessionId, clientId) {
    const sid = normalizeToken(sessionId);
    const cid = normalizeToken(clientId);
    const now = nowFn();
    const keyCandidates = [];
    if (sid) keyCandidates.push(`sid:${sid}`);
    if (cid) keyCandidates.push(`cid:${cid}`);

    for (const key of keyCandidates) {
      const row = store.get(key);
      if (!row) continue;
      if (now > Number(row.expiresAt || 0)) {
        store.delete(`sid:${row.sessionId}`);
        if (row.clientId) store.delete(`cid:${row.clientId}`);
        continue;
      }
      return row;
    }
    return null;
  }

  function setLocation(input = {}) {
    const now = nowFn();
    const sessionId = normalizeToken(input.sessionId || input.clientId);
    if (!sessionId) {
      return { ok: false, code: 'session_required', status: 400, error: 'sessionId is required.' };
    }
    const clientId = normalizeToken(input.clientId) || sessionId;
    const lat = toFiniteNumber(input.lat);
    const lon = toFiniteNumber(input.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { ok: false, code: 'lat_invalid', status: 400, error: 'lat must be between -90 and 90.' };
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      return { ok: false, code: 'lon_invalid', status: 400, error: 'lon must be between -180 and 180.' };
    }
    const accuracy = toFiniteNumber(input.accuracy);
    const tsMs = parseTimestampMs(input.timestamp || input.ts, now);
    if (!Number.isFinite(tsMs)) {
      return { ok: false, code: 'timestamp_invalid', status: 400, error: 'timestamp is invalid.' };
    }
    const allowOldTimestamp = input.allowStale === true || input.allowOldTimestamp === true;
    if (!allowOldTimestamp && (now - tsMs) > maxBackdateMs) {
      return {
        ok: false,
        code: 'timestamp_too_old',
        status: 400,
        error: `timestamp is older than ${Math.round(maxBackdateMs / 1000)} seconds.`,
      };
    }
    if ((tsMs - now) > maxFutureSkewMs) {
      return {
        ok: false,
        code: 'timestamp_in_future',
        status: 400,
        error: 'timestamp is too far in the future.',
      };
    }

    const row = {
      sessionId,
      clientId,
      lat,
      lon,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
      ts: new Date(tsMs).toISOString(),
      source: String(input.source || 'unknown').trim() || 'unknown',
      userAgent: String(input.userAgent || '').trim() || null,
      consent: input.consent !== false,
      storedAtMs: now,
      expiresAt: now + ttlMs,
    };

    store.set(`sid:${sessionId}`, row);
    if (clientId) store.set(`cid:${clientId}`, row);
    writeEvent(row);

    return {
      ok: true,
      stored: true,
      ttlSeconds: Math.round(ttlMs / 1000),
      lastLocation: formatLocationRow(row),
      sessionId,
      clientId,
    };
  }

  function getStatus(input = {}) {
    const sessionId = normalizeToken(input.sessionId || input.clientId);
    if (!sessionId) {
      return {
        ok: true,
        hasLocation: false,
        ageSeconds: null,
        ttlSecondsRemaining: 0,
        ttlSeconds: Math.round(ttlMs / 1000),
        lastLocation: null,
      };
    }
    const clientId = normalizeToken(input.clientId);
    const row = readRowBySession(sessionId, clientId);
    if (!row) {
      return {
        ok: true,
        hasLocation: false,
        ageSeconds: null,
        ttlSecondsRemaining: 0,
        ttlSeconds: Math.round(ttlMs / 1000),
        lastLocation: null,
      };
    }
    const now = nowFn();
    const tsMs = Date.parse(row.ts);
    const ageSeconds = Number.isFinite(tsMs) ? Math.max(0, Math.floor((now - tsMs) / 1000)) : null;
    const ttlSecondsRemaining = Math.max(0, Math.floor((Number(row.expiresAt || 0) - now) / 1000));
    return {
      ok: true,
      hasLocation: true,
      ageSeconds,
      ttlSecondsRemaining,
      ttlSeconds: Math.round(ttlMs / 1000),
      lastLocation: formatLocationRow(row),
    };
  }

  function getLocation(input = {}) {
    const status = getStatus(input);
    if (!status.hasLocation) return null;
    return status.lastLocation;
  }

  function clear(input = {}) {
    const sid = normalizeToken(input.sessionId || input.clientId);
    const cid = normalizeToken(input.clientId);
    if (sid) store.delete(`sid:${sid}`);
    if (cid) store.delete(`cid:${cid}`);
  }

  return {
    setLocation,
    getStatus,
    getLocation,
    clear,
    normalizeToken,
  };
}

module.exports = {
  createJarvisLocationStore,
};
