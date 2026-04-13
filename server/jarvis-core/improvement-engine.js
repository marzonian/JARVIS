'use strict';

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function toList(value) {
  if (Array.isArray(value)) return value.map((row) => String(row || '').trim()).filter(Boolean);
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed.map((row) => String(row || '').trim()).filter(Boolean) : [];
}

function buildPatternSummary(rows = []) {
  const bySkill = new Map();
  const byRoute = new Map();
  const byReason = new Map();

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const row of rows) {
    const skill = normalizeText(row.skill || 'unknown_skill') || 'unknown_skill';
    const route = normalizeText(row.route_path || row.route || 'unknown_route') || 'unknown_route';
    const notes = normalizeText(row.notes || '').toLowerCase();
    const reply = normalizeText(row.reply || '').toLowerCase();
    bump(bySkill, skill);
    bump(byRoute, route);

    if (notes.includes('stale') || reply.includes('stale')) bump(byReason, 'stale_data');
    if (notes.includes('unclear') || reply.includes("not sure what you want")) bump(byReason, 'intent_unclear');
    if (notes.includes('timeout') || notes.includes('slow') || reply.includes('delay')) bump(byReason, 'latency_or_timeout');
    if (reply.includes('stub mode')) bump(byReason, 'provider_stub_mode');
    if (reply.includes('no action is pending')) bump(byReason, 'pending_recovery_gap');
  }

  const sortMap = (map) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));

  return {
    bySkill: sortMap(bySkill),
    byRoute: sortMap(byRoute),
    byReason: sortMap(byReason),
  };
}

function buildImprovementSuggestions(summary = {}, options = {}) {
  const maxItems = Math.max(1, Math.min(12, Number(options.maxItems || 6)));
  const items = [];
  const add = (id, severity, title, rationale, proposedAction) => {
    if (items.length >= maxItems) return;
    items.push({
      id,
      severity,
      title,
      rationale,
      proposedAction,
      requiresPermission: true,
    });
  };

  const topReason = summary.byReason?.[0];
  const topSkill = summary.bySkill?.[0];
  const topRoute = summary.byRoute?.[0];

  if (topReason?.key === 'intent_unclear') {
    add(
      'intent_router_coverage',
      'P0',
      'Expand intent coverage for low-confidence phrases',
      'Complaint patterns show ambiguous routing to unclear intent.',
      'Add phrase clusters and confidence backoff prompts for top unclear categories.'
    );
  }
  if (topReason?.key === 'pending_recovery_gap') {
    add(
      'pending_recovery_guard',
      'P0',
      'Harden pending follow-up recovery',
      'Users are hitting pending actions that fail to recover on follow-up.',
      'Increase pending recovery window and improve session/client cross-turn matching diagnostics.'
    );
  }
  if (topReason?.key === 'latency_or_timeout') {
    add(
      'latency_budgeting',
      'P1',
      'Tighten timeout strategy for voice query path',
      'Users reported delayed responses and aborted checks.',
      'Add provider-specific timeout tiers and partial-response strategy before fallback.'
    );
  }
  if (topReason?.key === 'provider_stub_mode') {
    add(
      'provider_live_readiness',
      'P1',
      'Promote web provider readiness visibility',
      'Web/local search complaints indicate stub mode confusion.',
      'Expose provider mode in UI header and offer one-step health check for live provider.'
    );
  }
  if (topSkill && topSkill.key !== 'unknown_skill') {
    add(
      `skill_tuning_${topSkill.key.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      'P2',
      `Tune ${topSkill.key} response quality`,
      `${topSkill.count} complaints were associated with this skill.`,
      `Review top transcripts for ${topSkill.key} and tighten its prompt/output contract.`
    );
  }
  if (topRoute && topRoute.key !== 'unknown_route') {
    add(
      `route_tuning_${topRoute.key.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      'P2',
      'Route-level reliability check',
      `${topRoute.count} complaints flowed through ${topRoute.key}.`,
      'Add targeted regression tests and trace assertions for this route.'
    );
  }

  if (items.length <= 0) {
    add(
      'baseline_observability',
      'P2',
      'No dominant failure pattern detected',
      'Complaint volume is low or evenly distributed.',
      'Continue monitoring and collect additional complaint samples before changing behavior.'
    );
  }

  return items.slice(0, maxItems);
}

function runImprovementEngine(input = {}) {
  const rows = Array.isArray(input.complaints) ? input.complaints : [];
  const lookbackDays = Math.max(1, Math.min(120, Number(input.lookbackDays || 30)));
  const summary = buildPatternSummary(rows);
  const suggestions = buildImprovementSuggestions(summary, {
    maxItems: input.maxItems || 6,
  });
  return {
    ok: true,
    lookbackDays,
    complaintCount: rows.length,
    summary,
    suggestions,
    requiresPermission: true,
    applied: false,
    note: 'Suggestions are advisory only. Jarvis does not auto-apply changes without explicit approval.',
  };
}

module.exports = {
  runImprovementEngine,
  buildPatternSummary,
  buildImprovementSuggestions,
  toList,
};

