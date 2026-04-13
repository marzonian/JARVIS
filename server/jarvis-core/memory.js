'use strict';

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function createPreferenceMemoryStore() {
  const sessions = new Map();

  function getSessionMap(sessionId) {
    const key = normalizeKey(sessionId) || 'default';
    if (!sessions.has(key)) sessions.set(key, new Map());
    return sessions.get(key);
  }

  return {
    get(sessionId, key) {
      const row = getSessionMap(sessionId);
      return row.get(normalizeKey(key)) || null;
    },
    set(sessionId, key, value, meta = {}) {
      const row = getSessionMap(sessionId);
      const record = {
        key: normalizeKey(key),
        value: String(value || ''),
        updatedAt: new Date().toISOString(),
        meta: meta && typeof meta === 'object' ? meta : {},
      };
      if (!record.key) return null;
      row.set(record.key, record);
      return record;
    },
    list(sessionId) {
      return Array.from(getSessionMap(sessionId).values())
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    detectContradiction(sessionId, key, nextValue) {
      const prev = this.get(sessionId, key);
      if (!prev) return null;
      const next = String(nextValue || '');
      if (String(prev.value) === next) return null;
      return {
        key: normalizeKey(key),
        previous: String(prev.value),
        next,
      };
    },
  };
}

module.exports = {
  createPreferenceMemoryStore,
};

