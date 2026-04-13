'use strict';

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleWord(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (/^[a-z]{2,4}$/i.test(raw) && raw === raw.toUpperCase()) return raw;
  if (/^[a-z]{2,4}$/i.test(raw) && /^(cvs|ups|usps|fedex)$/i.test(raw)) return raw.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function toTitlePhrase(value) {
  return collapseWhitespace(value)
    .split(' ')
    .map((part) => toTitleWord(part))
    .filter(Boolean)
    .join(' ');
}

function inferCategoryHint(queryLower = '') {
  const text = String(queryLower || '').toLowerCase();
  const categoryMatchers = [
    { re: /\bcoffee|cafe|espresso\b/, hint: 'coffee' },
    { re: /\bpizza\b/, hint: 'pizza' },
    { re: /\bgas\s+station|fuel|gas\b/, hint: 'gas_station' },
    { re: /\bpharmacy|drug\s+store\b/, hint: 'pharmacy' },
    { re: /\bstore|shop|market|grocery|supermarket\b/, hint: 'store' },
    { re: /\bpost\s+office|ups|fedex|shipping\b/, hint: 'shipping' },
    { re: /\brestaurant|food|eatery|diner\b/, hint: 'restaurant' },
    { re: /\bbank|atm\b/, hint: 'bank' },
    { re: /\bhospital|clinic|urgent\s+care|doctor|medical\b/, hint: 'medical' },
    { re: /\bgym|fitness\b/, hint: 'fitness' },
  ];
  for (const row of categoryMatchers) {
    if (row.re.test(text)) return row.hint;
  }
  return null;
}

const LOCAL_SEARCH_LEAD_PATTERNS = Object.freeze([
  /^(?:service|services)\s+/i,
  /^(?:please\s+)?(?:hey\s+|hi\s+|yo\s+)?jarvis[\s,:-]*/i,
  /^(?:please\s+)?(?:can|could|would)\s+you\s+/i,
  /^(?:please\s+)?(?:show|get|tell)\s+me\s+/i,
  /^(?:please\s+)?(?:find|search(?:\s+for)?|look\s+up|look\s+for|get)\s+me\s+/i,
  /^(?:please\s+)?(?:find|search(?:\s+for)?|look\s+up|look\s+for|get)\s+/i,
  /^(?:please\s+)?where(?:\s+is|['’]s)?\s+(?:the\s+)?/i,
  /^(?:please\s+)?(?:nearest|closest)\s+/i,
  /^(?:please\s+)?(?:a|an|the)\s+/i,
]);

const LOCAL_SEARCH_TRAIL_PATTERNS = Object.freeze([
  /\b(?:near\s+me|nearby|around\s+here|around\s+me|in\s+my\s+area)\b/gi,
  /\b(?:right\s+now|please)\b/gi,
]);

const LOCAL_SEARCH_INLINE_FILLERS = Object.freeze([
  /\b(?:me|my)\b/gi,
]);

const LOCAL_SEARCH_PLACE_KEYWORD_RE = /\b(coffee|cafe|pizza|gas(?:\s+station)?|pharmacy|drugstore|restaurant|food|grocery|supermarket|market|urgent\s+care|clinic|hospital|doctor|atm|bank|ups|usps|fedex|shipping|store|shop|station|walmart|target|cvs)\b/i;
const LOCAL_SEARCH_NEGATIVE_RE = /\b(code|coding|script|file|folder|repo|repository|pull request|pr|commit|bug|issue|ticket|compile|build)\b/i;

function stripLeadingFiller(text) {
  let out = collapseWhitespace(text)
    .replace(/[’]/g, "'")
    .replace(/[?.!,;:]+$/g, '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LOCAL_SEARCH_LEAD_PATTERNS) {
      if (re.test(out)) {
        out = collapseWhitespace(out.replace(re, ' '));
        changed = true;
      }
    }
  }

  out = out
    .replace(/\b(?:around\s+here|around\s+me|near\s+me|nearby|please|service|services)\b/gi, ' ')
    .replace(/\b(?:the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

function sanitizeEntityPhrase(text) {
  let out = collapseWhitespace(text)
    .replace(/[’]/g, "'")
    .replace(/[?.!,;:]+$/g, '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LOCAL_SEARCH_LEAD_PATTERNS) {
      if (re.test(out)) {
        out = collapseWhitespace(out.replace(re, ' '));
        changed = true;
      }
    }
  }

  for (const re of LOCAL_SEARCH_TRAIL_PATTERNS) {
    out = out.replace(re, ' ');
  }
  for (const re of LOCAL_SEARCH_INLINE_FILLERS) {
    out = out.replace(re, ' ');
  }

  out = out
    .replace(/\b(?:in|near|around)\s+[a-z][a-z0-9.'\-]*(?:\s+[a-z0-9.'\-]+){0,6}$/i, ' ')
    .replace(/\b(?:the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^\s*(?:good|best)\s+(.+)$/i.test(out)) {
    out = out.replace(/^\s*(?:good|best)\s+/i, '').trim();
  }

  out = out
    .replace(/\b(pizza)\s+place\b/i, '$1')
    .replace(/\b(coffee)\s+place\b/i, '$1')
    .replace(/\b(?:place|places)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

function looksLikeLocalSearchQuery(rawText) {
  const text = collapseWhitespace(rawText).toLowerCase();
  if (!text) return false;
  if (LOCAL_SEARCH_NEGATIVE_RE.test(text)) return false;
  if (/^(?:search(?: the web)? for|look up|google)\b/.test(text) && !/\b(?:nearest|closest|near me|nearby|around here|around me|in my area)\b/.test(text)) {
    return false;
  }
  if (/\b(?:nearest|closest|nearby|near me|around here|around me|in my area)\b/.test(text)) return true;
  if (/^where(?:\s+is|['’]s)?\s+(?:the\s+)?(?:nearest|closest)?\s+/.test(text)) return true;
  if (/^(?:find|search(?:\s+for)?|look\s+up|look\s+for|get)\s+/.test(text)) {
    if (LOCAL_SEARCH_PLACE_KEYWORD_RE.test(text)) return true;
    return /^find(?: me)?\s+(?:a|an|the)?\s+[a-z0-9][a-z0-9\s.'-]{1,60}$/i.test(text);
  }
  return LOCAL_SEARCH_PLACE_KEYWORD_RE.test(text);
}

function normalizeLocalSearchQuery(rawText) {
  const originalQuery = collapseWhitespace(rawText);
  const stripped = sanitizeEntityPhrase(originalQuery) || stripLeadingFiller(originalQuery);
  const normalizedBase = collapseWhitespace(stripped || originalQuery);
  const normalizedQuery = toTitlePhrase(normalizedBase || originalQuery);
  const queryForCategory = normalizedBase.toLowerCase();
  const entityQuery = normalizedQuery || toTitlePhrase(originalQuery);

  return {
    originalQuery,
    normalizedQuery: entityQuery,
    entityQuery,
    brandOrTerm: entityQuery,
    categoryHint: inferCategoryHint(queryForCategory),
    localSearchLikely: looksLikeLocalSearchQuery(originalQuery),
  };
}

module.exports = {
  looksLikeLocalSearchQuery,
  normalizeLocalSearchQuery,
};
