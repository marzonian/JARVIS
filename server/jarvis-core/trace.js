'use strict';

const crypto = require('crypto');

const TRACE_SCHEMA_FIELDS = Object.freeze([
  'traceId',
  'endpoint',
  'intent',
  'toolsUsed',
  'precedenceMode',
  'voiceMode',
  'voiceBriefMode',
  'routePathTag',
  'source',
  'formatterUsed',
  'didFinalize',
  'contentFirewallApplied',
  'detectedForbiddenTokens',
  'invariantsPass',
  'failedRules',
  'replyPreview',
  'spokenTextPreview',
  'serverEqualsReply',
  'voiceSessionModeActive',
  'lastHealthAgeSeconds',
  'healthStatusUsed',
  'timePhase',
  'decisionBlockedBy',
  'pendingActionKind',
  'pendingActionCreatedAt',
  'pendingActionSessionKey',
  'pendingActionClientId',
  'recoveredFromSessionId',
  'pendingRecoveryUsed',
  'topicShiftGuardTriggered',
  'pendingSelectionMatcher',
]);

function previewText(input, maxChars = 180) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

function createTraceId(prefix = 'jarvis') {
  const p = String(prefix || 'jarvis')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12) || 'jarvis';
  return `${p}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean).map((v) => String(v)) : [];
}

function buildTraceRecord(payload = {}) {
  return {
    at: new Date().toISOString(),
    stage: String(payload.stage || 'unknown'),
    traceId: String(payload.traceId || '').trim() || null,
    endpoint: String(payload.endpoint || '').trim() || null,
    intent: payload.intent == null ? null : String(payload.intent),
    toolsUsed: normalizeList(payload.toolsUsed),
    precedenceMode: payload.precedenceMode == null ? null : String(payload.precedenceMode),
    voiceMode: payload.voiceMode === true,
    voiceBriefMode: payload.voiceBriefMode == null ? null : String(payload.voiceBriefMode),
    routePathTag: payload.routePathTag == null ? null : String(payload.routePathTag),
    source: payload.source == null ? null : String(payload.source),
    formatterUsed: payload.formatterUsed == null ? null : String(payload.formatterUsed),
    didFinalize: payload.didFinalize === true ? true : (payload.didFinalize === false ? false : null),
    contentFirewallApplied: payload.contentFirewallApplied === true,
    detectedForbiddenTokens: normalizeList(payload.detectedForbiddenTokens),
    invariantsPass: payload.invariantsPass === true ? true : (payload.invariantsPass === false ? false : null),
    failedRules: normalizeList(payload.failedRules),
    replyPreview: previewText(payload.replyPreview || '', 180),
    spokenTextPreview: previewText(payload.spokenTextPreview || '', 180),
    serverEqualsReply: payload.serverEqualsReply === true ? true : (payload.serverEqualsReply === false ? false : null),
    voiceSessionModeActive: payload.voiceSessionModeActive === true ? true : (payload.voiceSessionModeActive === false ? false : null),
    lastHealthAgeSeconds: Number.isFinite(Number(payload.lastHealthAgeSeconds))
      ? Number(payload.lastHealthAgeSeconds)
      : null,
    healthStatusUsed: payload.healthStatusUsed == null ? null : String(payload.healthStatusUsed),
    timePhase: payload.timePhase == null ? null : String(payload.timePhase),
    decisionBlockedBy: payload.decisionBlockedBy == null ? null : String(payload.decisionBlockedBy),
    pendingActionKind: payload.pendingActionKind == null ? null : String(payload.pendingActionKind),
    pendingActionCreatedAt: Number.isFinite(Number(payload.pendingActionCreatedAt))
      ? Number(payload.pendingActionCreatedAt)
      : null,
    pendingActionSessionKey: payload.pendingActionSessionKey == null ? null : String(payload.pendingActionSessionKey),
    pendingActionClientId: payload.pendingActionClientId == null ? null : String(payload.pendingActionClientId),
    recoveredFromSessionId: payload.recoveredFromSessionId == null ? null : String(payload.recoveredFromSessionId),
    pendingRecoveryUsed: payload.pendingRecoveryUsed === true ? true : (payload.pendingRecoveryUsed === false ? false : null),
    topicShiftGuardTriggered: payload.topicShiftGuardTriggered === true ? true : (payload.topicShiftGuardTriggered === false ? false : null),
    pendingSelectionMatcher: payload.pendingSelectionMatcher == null ? null : String(payload.pendingSelectionMatcher),
    routePath: payload.routePath == null ? null : String(payload.routePath),
    mode: payload.mode == null ? null : String(payload.mode),
    sessionId: payload.sessionId == null ? null : String(payload.sessionId),
    sessionKey: payload.sessionKey == null ? null : String(payload.sessionKey),
  };
}

function sanitizeTraceForDiag(record) {
  if (!record || typeof record !== 'object') return null;
  const safe = {};
  for (const key of ['at', 'stage', ...TRACE_SCHEMA_FIELDS, 'mode', 'routePath', 'sessionId', 'sessionKey']) {
    safe[key] = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;
  }
  return safe;
}

function createTraceStore(options = {}) {
  const maxItems = Math.max(50, Number(options.maxItems || 800));
  const byTraceId = new Map();
  const bySession = new Map();
  const queue = [];

  function touch(key) {
    queue.push(String(key || ''));
    while (queue.length > maxItems) {
      const oldest = queue.shift();
      if (oldest && byTraceId.has(oldest)) byTraceId.delete(oldest);
    }
  }

  function set(record, refs = {}) {
    if (!record || typeof record !== 'object') return null;
    const traceId = String(record.traceId || '').trim();
    if (!traceId) return null;
    const merged = {
      ...(byTraceId.get(traceId) || {}),
      ...record,
    };
    byTraceId.set(traceId, merged);
    touch(traceId);
    const sessionId = String(refs.sessionId || record.sessionId || '').trim();
    const sessionKey = String(refs.sessionKey || record.sessionKey || '').trim();
    if (sessionId) bySession.set(`id:${sessionId}`, traceId);
    if (sessionKey) bySession.set(`key:${sessionKey}`, traceId);
    return merged;
  }

  function patch(traceId, patchPayload = {}) {
    const id = String(traceId || '').trim();
    if (!id || !byTraceId.has(id)) return null;
    const existing = byTraceId.get(id);
    const merged = {
      ...existing,
      ...patchPayload,
    };
    byTraceId.set(id, merged);
    return merged;
  }

  function getLatest(query = {}) {
    const byId = String(query.traceId || '').trim();
    if (byId && byTraceId.has(byId)) return byTraceId.get(byId);
    const sessionId = String(query.sessionId || '').trim();
    if (sessionId) {
      const key = bySession.get(`id:${sessionId}`);
      if (key && byTraceId.has(key)) return byTraceId.get(key);
    }
    const sessionKey = String(query.sessionKey || '').trim();
    if (sessionKey) {
      const key = bySession.get(`key:${sessionKey}`);
      if (key && byTraceId.has(key)) return byTraceId.get(key);
    }
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const key = queue[i];
      if (byTraceId.has(key)) return byTraceId.get(key);
    }
    return null;
  }

  return {
    set,
    patch,
    getLatest,
  };
}

module.exports = {
  TRACE_SCHEMA_FIELDS,
  buildTraceRecord,
  createTraceId,
  createTraceStore,
  previewText,
  sanitizeTraceForDiag,
};
