const BRIEF_LABELS = [
  'Action now',
  'Why',
  'What I need to see',
  'Current vs clear',
  'Check again',
  'If ignored',
  'If it clears',
  'Confidence',
  'Quick trust check',
];

const BRIEF_LABEL_TO_KEY = {
  'Action now': 'actionNow',
  Why: 'why',
  'What I need to see': 'whatINeedToSee',
  'Current vs clear': 'currentVsClear',
  'Check again': 'checkAgain',
  'If ignored': 'ifIgnored',
  'If it clears': 'ifItClears',
  Confidence: 'confidence',
  'Quick trust check': 'quickTrustCheck',
};

const STATUS_PROMPT_SHAPE_PATTERNS = {
  why_waiting: /\bwhy are we waiting\b/i,
  lean_if_clears: /\b(if it clears what(?:['’]s| is) the lean|what(?:['’]s| is) the lean if (?:this|it) clears|lean if (?:this|it) clears)\b/i,
  take_or_not: /\b(is this a wait or a go|do i take it or not|take it or not)\b/i,
};

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAssistantDecisionBriefSections(briefText = '') {
  const text = String(briefText || '').trim();
  if (!text) return {};
  const labelsPattern = BRIEF_LABELS.map((label) => escapeRegExp(label)).join('|');
  const re = new RegExp(
    `(?:^|\\s)(${labelsPattern}):\\s*([\\s\\S]*?)(?=(?:\\s(?:${labelsPattern}):)|$)`,
    'gi'
  );
  const out = {};
  let match;
  while ((match = re.exec(text)) !== null) {
    const rawLabel = String(match[1] || '').trim();
    const key = BRIEF_LABEL_TO_KEY[rawLabel];
    if (!key) continue;
    const value = String(match[2] || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

function stripTrailingPunctuation(value = '') {
  return String(value || '').replace(/[.?!\s]+$/g, '').trim();
}

function toPlainWhy(whyText = '') {
  const text = String(whyText || '').trim();
  if (!text) return '';
  if (/confidence support is below the line/i.test(text)) return "confidence still isn't high enough yet";
  if (/below threshold/i.test(text)) return "confidence is still below where it needs to be";
  if (/not enough clean confirmation/i.test(text)) return 'confirmation is still too weak';
  return sentenceCaseFromClause(text);
}

function toPlainNeedText(needText = '') {
  const text = String(needText || '').trim();
  if (!text) return 'cleaner confirmation';
  if (/climbs back above the line/i.test(text)) return 'cleaner confirmation and stronger confidence support';
  if (/cleaner confirmation/i.test(text)) return 'cleaner confirmation';
  return sentenceCaseFromClause(text);
}

function isGenericBlockerClearanceText(needText = '') {
  const source = String(needText || '').toLowerCase();
  if (!source) return false;
  const mentionsBlocker = /\bblock(?:ed|ing|er)?\b/.test(source);
  const mentionsClear = /\bclear(?:ed|s|ing)?\b/.test(source);
  const mentionsDecisionCheck = /\bdecision check\b/.test(source);
  const mentionsStandDown = /\bstand down\b/.test(source);
  const mentionsDoNotTrade = /\bdo not trade\b/.test(source);
  return (
    (mentionsBlocker && mentionsClear && mentionsDecisionCheck)
    || (mentionsBlocker && mentionsStandDown)
    || (mentionsBlocker && mentionsDoNotTrade)
  );
}

function toPlainDistanceHint(currentVsClear = '') {
  const text = String(currentVsClear || '').toLowerCase();
  if (!text) return '';
  if (/still far/.test(text)) return "it's still too weak right now";
  if (/getting closer|approaching/.test(text)) return "it's improving, but not there yet";
  if (/almost there|near/.test(text)) return "it's close, but not clear yet";
  if (/clear/.test(text)) return "it's close to clearing";
  return '';
}

function toPlainConfidence(confidenceText = '') {
  const text = String(confidenceText || '').trim();
  if (!text) return '';
  const stripped = text.replace(/\(\s*\d+(?:\.\d+)?\s*\)/g, '').trim();
  return sentenceCaseFromClause(stripped || text);
}

function sentenceCaseFromClause(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function firstSentence(text = '') {
  const src = String(text || '').trim();
  if (!src) return '';
  const parts = src.split(/(?<=[.?!])\s+/).map((item) => item.trim()).filter(Boolean);
  return parts[0] || src;
}

function classifyTradingStatusPromptShape(message = '') {
  const text = String(message || '').trim();
  if (!text) return null;
  for (const [shape, pattern] of Object.entries(STATUS_PROMPT_SHAPE_PATTERNS)) {
    if (pattern.test(text)) return shape;
  }
  return null;
}

function coerceCanonicalBriefFields(input = {}) {
  const briefObject = input?.briefObject && typeof input.briefObject === 'object'
    ? input.briefObject
    : {};
  const parsed = parseAssistantDecisionBriefSections(input?.briefText || '');
  return {
    actionNow: String(briefObject.actionNow || parsed.actionNow || '').trim(),
    why: String(briefObject.why || parsed.why || '').trim(),
    whatINeedToSee: String(briefObject.whatINeedToSee || briefObject.clearanceCondition || parsed.whatINeedToSee || '').trim(),
    ifItClears: String(briefObject.ifItClears || briefObject.leanIfCleared || parsed.ifItClears || '').trim(),
    confidence: String(briefObject.confidence || parsed.confidence || '').trim(),
  };
}

function buildNeedClause(needText = '') {
  const text = stripTrailingPunctuation(String(needText || '').trim());
  if (!text) return 'wait for cleaner confirmation before taking it';
  if (isGenericBlockerClearanceText(text)) {
    return 'wait for this blocker to clear first and check again next decision window';
  }
  return `wait until ${sentenceCaseFromClause(text)} before taking it`;
}

function buildTakeOrNotOpening(actionNow = '') {
  const text = String(actionNow || '').toLowerCase();
  if (/\bdon['’]?t trade|do not trade|skip\b/.test(text)) return "I'd pass on it for now.";
  if (/\btrade\b/.test(text) && !/\bwait\b/.test(text)) return "I'd take it selectively right now.";
  return "I'd wait for now.";
}

function hasBlockSignal(text = '') {
  const source = String(text || '').toLowerCase();
  if (!source) return false;
  return /\bblock(?:ed|ing|er)?\b/.test(source)
    || /\bdo not trade\b/.test(source)
    || /\bstand down\b/.test(source)
    || /\bnot ready\b/.test(source)
    || /\bwait for clearance\b/.test(source);
}

function isActionBlocked(actionNow = '') {
  const text = String(actionNow || '').toLowerCase();
  if (!text) return false;
  return /\bwait\b/.test(text)
    || /\bdon['’]?t trade\b/.test(text)
    || /\bdo not trade\b/.test(text)
    || /\bstand down\b/.test(text)
    || /\bskip\b/.test(text)
    || /\bsit out\b/.test(text);
}

function isBlockedBrief(fields = {}) {
  if (!isActionBlocked(fields?.actionNow || '')) return false;
  return hasBlockSignal(fields?.why || '') || hasBlockSignal(fields?.whatINeedToSee || '');
}

function buildLeanConfidenceSentence(input = {}) {
  const lean = stripTrailingPunctuation(String(input.lean || '').trim());
  const confidence = stripTrailingPunctuation(String(input.confidence || '').trim());
  const blocked = input.blocked === true;
  if (!lean) return '';
  if (blocked) {
    return `If it clears, I'd lean ${sentenceCaseFromClause(lean)}; for now it's still not ready yet.`;
  }
  if (!confidence) {
    return `If it clears, I'd lean ${sentenceCaseFromClause(lean)}.`;
  }
  return `If it clears, I'd lean ${sentenceCaseFromClause(lean)}; confidence is ${sentenceCaseFromClause(confidence)}.`;
}

function buildTradingStatusReplyFromCanonicalBrief(input = {}) {
  const shape = String(input.shape || '').trim();
  if (!shape) return null;
  const fields = coerceCanonicalBriefFields(input);
  const blocked = isBlockedBrief(fields);
  const whyText = stripTrailingPunctuation(toPlainWhy(fields.why || 'the setup still needs cleaner confirmation'));
  const needClause = buildNeedClause(toPlainNeedText(fields.whatINeedToSee || 'cleaner confirmation'));
  const lean = stripTrailingPunctuation(fields.ifItClears || 'Original Trading Plan, nearest target');
  const confidence = stripTrailingPunctuation(toPlainConfidence(fields.confidence || 'medium'));
  if (!lean || !confidence) return null;
  const leanConfidenceSentence = buildLeanConfidenceSentence({ lean, confidence, blocked });
  if (!leanConfidenceSentence) return null;

  if (shape === 'why_waiting') {
    return [
      `I'd wait for now because ${sentenceCaseFromClause(whyText)}.`,
      `Let's ${needClause}.`,
      leanConfidenceSentence,
    ].join(' ');
  }
  if (shape === 'lean_if_clears') {
    return [
      "I'd stay patient for now.",
      `Let's ${needClause}.`,
      leanConfidenceSentence,
    ].join(' ');
  }
  if (shape === 'take_or_not') {
    return [
      buildTakeOrNotOpening(fields.actionNow),
      `Let's ${needClause}.`,
      leanConfidenceSentence,
    ].join(' ');
  }
  return null;
}

function mergeHealthBlockedDecisionReply(input = {}) {
  const healthReply = String(input.healthReply || '').trim();
  const canonicalBriefText = String(input.canonicalBriefText || '').trim();
  if (!canonicalBriefText) return healthReply;

  const sections = parseAssistantDecisionBriefSections(canonicalBriefText);
  const hasStructuredBrief = Boolean(
    sections.why
    || sections.whatINeedToSee
    || sections.ifItClears
    || sections.confidence
    || sections.currentVsClear
  );
  if (!hasStructuredBrief) {
    const fallback = canonicalBriefText
      .replace(/^\s*Action now:\s*[^.?!]+[.?!]?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!fallback) return healthReply;
    return `${healthReply} ${fallback}`.replace(/\s+/g, ' ').trim();
  }

  const baseHealthSentence = firstSentence(healthReply) || "I'd sit out for now because live market data is not healthy.";
  const whyText = stripTrailingPunctuation(toPlainWhy(sections.why));
  const whatNeedText = stripTrailingPunctuation(toPlainNeedText(sections.whatINeedToSee));
  const currentVsClear = stripTrailingPunctuation(sections.currentVsClear);
  const ifClearsText = stripTrailingPunctuation(sections.ifItClears);
  const confidenceText = stripTrailingPunctuation(toPlainConfidence(sections.confidence));
  const distanceHint = stripTrailingPunctuation(toPlainDistanceHint(currentVsClear));

  const sentence1 = whyText
    ? `${stripTrailingPunctuation(baseHealthSentence)} and ${sentenceCaseFromClause(whyText)}.`
    : (baseHealthSentence.endsWith('.') ? baseHealthSentence : `${baseHealthSentence}.`);

  let sentence2 = `Let's ${buildNeedClause(whatNeedText)}.`;
  if (distanceHint) {
    sentence2 = `${stripTrailingPunctuation(sentence2)}; ${distanceHint}.`;
  } else if (currentVsClear) {
    sentence2 = `${stripTrailingPunctuation(sentence2)}; it's not clear yet.`;
  }

  let sentence3 = 'If it clears, we can reassess quickly.';
  if (ifClearsText) {
    sentence3 = `If it clears, lean ${sentenceCaseFromClause(ifClearsText)}; for now it's still not ready yet.`;
  } else if (confidenceText) {
    sentence3 = "For now, confidence still isn't there yet.";
  }

  return [sentence1, sentence2, sentence3].join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  classifyTradingStatusPromptShape,
  buildTradingStatusReplyFromCanonicalBrief,
  parseAssistantDecisionBriefSections,
  mergeHealthBlockedDecisionReply,
};
