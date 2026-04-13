function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXPLAIN_ALIASES = new Set([
  'explain',
  'why',
  'why blocked',
  'details',
  'tell me why',
  'what happened',
  'why not',
  'why cant i',
  'why cant i trade',
  'give me details',
]);

function isExplainFollowup(userMessage) {
  const normalized = normalizeText(userMessage);
  if (!normalized) return false;
  return EXPLAIN_ALIASES.has(normalized);
}

function resolveAnalystPrecedence(input = {}) {
  const hasOpenPosition = input.hasOpenPosition === true;
  if (hasOpenPosition) return { mode: 'position' };

  const healthStatus = String(input.healthStatus || '').trim().toUpperCase();
  if (healthStatus === 'DEGRADED' || healthStatus === 'STALE') {
    return { mode: 'health_block' };
  }

  const riskVerdict = String(input.riskVerdict || '').trim().toUpperCase();
  if (riskVerdict === 'BLOCK') return { mode: 'risk_block' };
  return { mode: 'normal' };
}

module.exports = {
  isExplainFollowup,
  resolveAnalystPrecedence,
};
