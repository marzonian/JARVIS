'use strict';

function normalizeToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.slice(0, 220);
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePayload(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function createJarvisDurableStateStore(options = {}) {
  const dbFactory = typeof options.dbFactory === 'function' ? options.dbFactory : null;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const defaultTtlMs = Math.max(5_000, Number(options.defaultTtlMs || (10 * 60 * 1000)));

  let _initDone = false;
  let _stmtPut = null;
  let _stmtGet = null;
  let _stmtDelete = null;
  let _stmtListClient = null;
  let _stmtListSession = null;
  let _stmtListSessionPrefix = null;
  let _stmtPrune = null;

  function ensureDb() {
    if (!dbFactory) return null;
    const db = dbFactory();
    if (!db) return null;
    if (_initDone) return db;
    _initDone = true;
    db.exec(`
      CREATE TABLE IF NOT EXISTS jarvis_state_kv (
        state_type      TEXT NOT NULL,
        state_key       TEXT NOT NULL,
        session_id      TEXT,
        client_id       TEXT,
        session_key     TEXT,
        payload_json    TEXT NOT NULL DEFAULT '{}',
        created_at_ms   INTEGER NOT NULL,
        updated_at_ms   INTEGER NOT NULL,
        expires_at_ms   INTEGER,
        PRIMARY KEY (state_type, state_key)
      );
      CREATE INDEX IF NOT EXISTS idx_jarvis_state_kv_type_expires
        ON jarvis_state_kv(state_type, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_jarvis_state_kv_client_type
        ON jarvis_state_kv(client_id, state_type, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_jarvis_state_kv_session_type
        ON jarvis_state_kv(session_id, state_type, updated_at_ms DESC);
    `);
    _stmtPut = db.prepare(`
      INSERT INTO jarvis_state_kv (
        state_type, state_key, session_id, client_id, session_key, payload_json, created_at_ms, updated_at_ms, expires_at_ms
      ) VALUES (
        @stateType, @stateKey, @sessionId, @clientId, @sessionKey, @payloadJson, @createdAtMs, @updatedAtMs, @expiresAtMs
      )
      ON CONFLICT(state_type, state_key) DO UPDATE SET
        session_id = excluded.session_id,
        client_id = excluded.client_id,
        session_key = excluded.session_key,
        payload_json = excluded.payload_json,
        updated_at_ms = excluded.updated_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `);
    _stmtGet = db.prepare(`
      SELECT state_type, state_key, session_id, client_id, session_key, payload_json, created_at_ms, updated_at_ms, expires_at_ms
      FROM jarvis_state_kv
      WHERE state_type = ? AND state_key = ?
      LIMIT 1
    `);
    _stmtDelete = db.prepare(`
      DELETE FROM jarvis_state_kv
      WHERE state_type = ? AND state_key = ?
    `);
    _stmtListClient = db.prepare(`
      SELECT state_type, state_key, session_id, client_id, session_key, payload_json, created_at_ms, updated_at_ms, expires_at_ms
      FROM jarvis_state_kv
      WHERE state_type = @stateType
        AND client_id = @clientId
        AND (@excludeStateKey = '' OR state_key <> @excludeStateKey)
        AND (@minUpdatedAtMs <= 0 OR updated_at_ms >= @minUpdatedAtMs)
        AND (expires_at_ms IS NULL OR expires_at_ms > @nowMs)
      ORDER BY updated_at_ms DESC
      LIMIT @limitRows
    `);
    _stmtListSession = db.prepare(`
      SELECT state_type, state_key, session_id, client_id, session_key, payload_json, created_at_ms, updated_at_ms, expires_at_ms
      FROM jarvis_state_kv
      WHERE state_type = @stateType
        AND session_id = @sessionId
        AND (expires_at_ms IS NULL OR expires_at_ms > @nowMs)
      ORDER BY updated_at_ms DESC
      LIMIT @limitRows
    `);
    _stmtListSessionPrefix = db.prepare(`
      SELECT state_type, state_key, session_id, client_id, session_key, payload_json, created_at_ms, updated_at_ms, expires_at_ms
      FROM jarvis_state_kv
      WHERE state_type = @stateType
        AND session_id = @sessionId
        AND state_key LIKE @stateKeyPrefix
        AND (expires_at_ms IS NULL OR expires_at_ms > @nowMs)
      ORDER BY updated_at_ms DESC
      LIMIT @limitRows
    `);
    _stmtPrune = db.prepare(`
      DELETE FROM jarvis_state_kv
      WHERE state_type = @stateType
        AND expires_at_ms IS NOT NULL
        AND expires_at_ms <= @nowMs
    `);
    return db;
  }

  function toRow(raw) {
    if (!raw) return null;
    return {
      stateType: String(raw.state_type || '').trim() || null,
      stateKey: String(raw.state_key || '').trim() || null,
      sessionId: normalizeToken(raw.session_id),
      clientId: normalizeToken(raw.client_id),
      sessionKey: normalizeToken(raw.session_key),
      payload: parsePayload(raw.payload_json) || {},
      createdAtMs: toFiniteNumber(raw.created_at_ms),
      updatedAtMs: toFiniteNumber(raw.updated_at_ms),
      expiresAtMs: toFiniteNumber(raw.expires_at_ms),
    };
  }

  function isExpired(row, nowMs) {
    const expiresAtMs = toFiniteNumber(row?.expiresAtMs);
    if (!Number.isFinite(expiresAtMs)) return false;
    return nowMs >= expiresAtMs;
  }

  function removeExpired(stateType) {
    const db = ensureDb();
    if (!db) return 0;
    const type = normalizeToken(stateType);
    if (!type) return 0;
    const nowMs = nowFn();
    try {
      const info = _stmtPrune.run({
        stateType: type,
        nowMs,
      });
      return Number(info?.changes || 0);
    } catch {
      return 0;
    }
  }

  function put(input = {}) {
    const db = ensureDb();
    if (!db) return null;
    const stateType = normalizeToken(input.stateType);
    const stateKey = normalizeToken(input.stateKey);
    if (!stateType || !stateKey) return null;
    const nowMs = nowFn();
    const ttlMs = Math.max(5_000, Number(input.ttlMs || defaultTtlMs));
    const expiresAtMs = Number.isFinite(Number(input.expiresAtMs))
      ? Number(input.expiresAtMs)
      : (input.persist === true ? null : (nowMs + ttlMs));
    const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
    const createdAtMs = Number.isFinite(Number(input.createdAtMs)) ? Number(input.createdAtMs) : nowMs;
    const updatedAtMs = nowMs;
    try {
      _stmtPut.run({
        stateType,
        stateKey,
        sessionId: normalizeToken(input.sessionId),
        clientId: normalizeToken(input.clientId),
        sessionKey: normalizeToken(input.sessionKey),
        payloadJson: JSON.stringify(payload),
        createdAtMs,
        updatedAtMs,
        expiresAtMs,
      });
      return get({ stateType, stateKey, allowExpired: true });
    } catch {
      return null;
    }
  }

  function get(input = {}) {
    const db = ensureDb();
    if (!db) return null;
    const stateType = normalizeToken(input.stateType);
    const stateKey = normalizeToken(input.stateKey);
    if (!stateType || !stateKey) return null;
    let row = null;
    try {
      row = toRow(_stmtGet.get(stateType, stateKey));
    } catch {
      row = null;
    }
    if (!row) return null;
    const nowMs = nowFn();
    if (input.allowExpired === true) return row;
    if (isExpired(row, nowMs)) {
      remove({ stateType, stateKey });
      return null;
    }
    return row;
  }

  function remove(input = {}) {
    const db = ensureDb();
    if (!db) return false;
    const stateType = normalizeToken(input.stateType);
    const stateKey = normalizeToken(input.stateKey);
    if (!stateType || !stateKey) return false;
    try {
      _stmtDelete.run(stateType, stateKey);
      return true;
    } catch {
      return false;
    }
  }

  function listByClient(input = {}) {
    const db = ensureDb();
    if (!db) return [];
    const stateType = normalizeToken(input.stateType);
    const clientId = normalizeToken(input.clientId);
    if (!stateType || !clientId) return [];
    const nowMs = nowFn();
    const minUpdatedAtMs = Number.isFinite(Number(input.minUpdatedAtMs)) ? Number(input.minUpdatedAtMs) : 0;
    const limitRows = Math.max(1, Math.min(50, Number(input.limit || 10)));
    const rows = _stmtListClient.all({
      stateType,
      clientId,
      excludeStateKey: normalizeToken(input.excludeStateKey) || '',
      minUpdatedAtMs,
      nowMs,
      limitRows,
    });
    return rows.map(toRow).filter(Boolean);
  }

  function listBySession(input = {}) {
    const db = ensureDb();
    if (!db) return [];
    const stateType = normalizeToken(input.stateType);
    const sessionId = normalizeToken(input.sessionId);
    if (!stateType || !sessionId) return [];
    const nowMs = nowFn();
    const limitRows = Math.max(1, Math.min(200, Number(input.limit || 100)));
    const rows = _stmtListSession.all({
      stateType,
      sessionId,
      nowMs,
      limitRows,
    });
    return rows.map(toRow).filter(Boolean);
  }

  function listBySessionPrefix(input = {}) {
    const db = ensureDb();
    if (!db) return [];
    const stateType = normalizeToken(input.stateType);
    const sessionId = normalizeToken(input.sessionId);
    const stateKeyPrefix = String(input.stateKeyPrefix || '').trim();
    if (!stateType || !sessionId || !stateKeyPrefix) return [];
    const nowMs = nowFn();
    const limitRows = Math.max(1, Math.min(200, Number(input.limit || 100)));
    const rows = _stmtListSessionPrefix.all({
      stateType,
      sessionId,
      stateKeyPrefix: `${stateKeyPrefix}%`,
      nowMs,
      limitRows,
    });
    return rows.map(toRow).filter(Boolean);
  }

  return {
    put,
    get,
    remove,
    removeExpired,
    listByClient,
    listBySession,
    listBySessionPrefix,
  };
}

module.exports = {
  createJarvisDurableStateStore,
  normalizeToken,
};
