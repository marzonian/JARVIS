function normalizeHealthStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function isDegradedOrStale(status) {
  const s = normalizeHealthStatus(status);
  return s === 'DEGRADED' || s === 'STALE';
}

function shouldEmitHealthAudioTransition(prevStatus, nextStatus) {
  const prev = normalizeHealthStatus(prevStatus);
  const next = normalizeHealthStatus(nextStatus);
  if (!next || prev === next) return false;
  if (prev === 'OK' && isDegradedOrStale(next)) return true;
  if (isDegradedOrStale(prev) && next === 'OK') return true;
  return false;
}

function healthAudioToneType(prevStatus, nextStatus) {
  const prev = normalizeHealthStatus(prevStatus);
  const next = normalizeHealthStatus(nextStatus);
  if (prev === 'OK' && isDegradedOrStale(next)) return 'degraded';
  if (isDegradedOrStale(prev) && next === 'OK') return 'recovered';
  return null;
}

module.exports = {
  normalizeHealthStatus,
  shouldEmitHealthAudioTransition,
  healthAudioToneType,
};
