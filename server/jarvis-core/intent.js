'use strict';

const { parseConsentReply } = require('./consent');
const { looksLikeLocalSearchQuery } = require('./query-normalizer');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRADING_EXECUTION_RE = /\b(enter (?:a )?trade now|enter now|take (?:the )?trade for me|place (?:a )?trade|buy now|sell now|close (?:my )?position|close now|flatten|press buy|press sell|execute (?:the )?trade)\b/i;
const TRADING_HYPOTHETICAL_RE = /\b(if i (?:would|had|would['’]?ve|could['’]?ve|could have).*(?:take|taken|took|trade|traded)|if i would have taken a trade|what would have happened|how would (?:that|this|it) trade have done|would (?:it|that|this) have won|would (?:that|this|it) trade have won if i (?:take|took)(?: it| that)?|would have been my results?|if i traded.*(?:result|outcome|would (?:it|that|this) have (?:won|worked))|if i had traded|if i would of traded|if i would've traded|looking back.*(?:trade|result|outcome|won|loss|lose))\b/i;
const TRADING_REPLAY_RE = /(^replay\b|\b(replay (?:today|session|this|that)|give me (?:a )?replay (?:of )?(?:today|session|this|that)|walk me through (?:today|session|what happened)|session recap|what did price do after 9:45|how did price move after 9:45|recap today(?:'s)? session|replay\b.*\b(trade|session|today|yesterday|orb|entry|window|setup|case)\b))\b/i;
const TRADING_REVIEW_RE = /\b(was it good i didn['’]?t trade|was it a good day (?:for me )?to not trade|was it a good day (?:for me )?not to trade|was today a good day (?:for me )?(?:to not trade|not to trade)|did i make the right call staying out|right call to stay out|good decision not trading|was staying out right|should i have stayed out|should i have traded|was not trading the right move|was i right not trading|did i do right by sitting out|was sitting out the better decision|i didn['’]?t take a trade today.*good decision)\b/i;
const TRADING_RESULT_RE = /\b(did today(?:['’]s)? setup (?:lose|win|work)|did the call work today|how did today(?:['’]s)? setup do|was today(?:['’]s)? setup a winner|did the strategy lose today|would my setup have worked today|how did jarvis do today|did today(?:['’]s)? setup (?:win|lose)|did (?:my|this) setup (?:win|lose) today|did we (?:win|lose) today|did we make money today|did we have a (?:winner|loser) today|did we do well today|how did we do today|did today (?:win|lose|work|fail|make money)|was today a (?:winner|loser))\b/i;
const TRADING_POSTMORTEM_RE = /\b(why (?:didn['’]?t|did not) my setup work today|why (?:didn['’]?t|did not) (?:the|this|today(?:['’]s)?) setup work today|why did my setup fail today|why did (?:the|this|today(?:['’]s)?) setup fail today|why did (?:the|this|today(?:['’]s)?) setup lose today|what made (?:the )?setup fail|what went wrong today|why was today a no[- ]trade|why (?:didn['’]?t|did not) jarvis like (?:the )?setup|why did jarvis not like (?:the )?setup|why did jarvis skip (?:the )?setup)\b/i;
const TRADING_PLAN_RE = /\b(what(?:'|’)s|what is|whats)\s+(?:the\s+)?(?:plan|game ?plan|outlook)(?:\s+today|\s+this morning)?|what(?:'|’)s today outlook|trading plan|trade plan|best setup|plan for today|what should i do right now with my trading|am i trading today|how(?:'|’)s it looking for my trading plan|how is it looking for my trading plan|how should i trade\b|morning outlook\b|game plan\b|gameplan\b/i;
const TRADING_STATUS_RE = /\b(what trend are we in|trend right now|market trend|regime right now|market regime|bias right now|do we have fresh bars|inside the entry window|entry window|in profit|pnl|position status|trade status|open positions?|current mnq|mnq now|price now|market state|(i['’]?m|im|i am)\s+(long|short)\b|why are we waiting|if it clears what(?:['’]s| is) the lean|what(?:['’]s| is) the lean if (?:this|it) clears|lean if (?:this|it) clears)\b/i;
const TRADING_DECISION_RE = /\b(should i trade|should i take|should i enter|is this a good setup|long or short|buy or sell|take this setup|should i stay out|should i sit out|stand down|avoid the market|wait or trade|what should i do with my trading|am i clear to trade(?: today)?|clear to trade(?: today)?|is this a wait or a go|do i take it or not|take it or not)\b|^\s*what should i do right now\??\s*$/i;
const TRADING_KEYWORD_RE = /\b(trade|trading|setup|entry|exit|orb|market|trend|bias|take this trade|should i trade|position|long|short|tp|sl|stay out|sit out|stand down)\b/i;
const TRADING_STRONG_CONTEXT_RE = /\b(trade|trading|setup|entry|exit|orb|market|trend|bias|position|long|short|tp|sl|jarvis|strategy|posture|blocker|signal|call)\b/i;
const NON_TRADING_CONTEXT_RE = /\b(website|traffic|seo|marketing|campaign|launch|sales|crm|project|code|coding|build|deploy|design|meeting|calendar|email|homework|school|class|gym|workout|diet|recipe|dinner|lunch|movie|music|weather|football|basketball|baseball|soccer|hockey|tennis|game|match|team|nfl|nba|mlb|nhl)\b/i;
const AMBIGUOUS_TRADING_RESULT_RE = /\b(did we (?:win|lose) today|did we make money today|did we have a (?:winner|loser) today|did we do well today|how did we do today|did today (?:win|lose|work|fail|make money)|was today a (?:winner|loser))\b/i;

const LOCAL_SEARCH_RE = /\b(nearest|closest|nearby|near me|around here|around me|in my area|where(?:'s| is)\s+(?:the\s+)?(?:nearest|closest)|find\s+.*\b(?:store|shop|station|coffee|pizza|pharmacy|restaurant|gas|target|walmart|cvs)\b)\b/i;
const WEB_QUESTION_RE = /\b(search the web|look up|google|who is|where is|weather|news|search for)\b/i;
const DEVICE_ACTION_RE = /\b(uninstall|remove app|delete file|erase|trash|change settings|turn off|disable|enable|open app|launch app|launch [a-z0-9._-]+|open safari|open chrome)\b/i;
const CODE_CHANGE_RE = /\b(code|implement|refactor|fix bug|update app|change design|modify file|build feature|write script|code me|build me)\b/i;
const SYSTEM_DIAG_RE = /\b((?:what|which)\s+(?:endpoint|route|api endpoint)(?:\s+are|\s+is)?\s+(?:you|my voice requests?)?(?:\s+using|\s+going to)?|are you using (?:jarvis|legacy)|are my voice requests using (?:jarvis|legacy)|jarvis\s+or\s+legacy|what route are my voice requests going to|which route are my voice requests going to|what module are you answering from right now|what module are you answering from)\b|^or legacy$/i;
const SHOPPING_ADVISOR_RE = /\b(i want (?:a|an|to buy|to build)?\s*(?:new\s+)?(?:pc|computer|desktop|laptop)\b.*\b(trading|day trading|futures|gaming)?|i need (?:a|an)?\s*(?:new\s+)?(?:pc|computer|desktop|laptop)\b.*\b(trading|futures|gaming)?|recommend (?:a|an)?\s*(?:pc|computer|desktop|laptop)|suggest (?:a|an)?\s*(?:pc|computer|desktop|laptop)|best (?:pc|computer|desktop|laptop)\b|help me (?:buy|build)\s+(?:a\s+)?(?:pc|computer|desktop|laptop)|shopping list(?: for)?\s+(?:pc|computer|trading setup)|new (?:pc|computer) for trading)\b/i;
const PROJECT_PLANNER_RE = /\b(design (?:a|my)\s+(?:website|site|landing page|store)|build (?:a|my)\s+(?:website|site|landing page|store)|website for (?:my|a)\s+[a-z0-9][a-z0-9\s-]*business|project plan(?: for)?\s+(?:website|app|store)|create (?:a|my)\s+(?:website|brand site|portfolio site)|help me plan (?:a|my)\s+(?:website|project|site)|plan my (?:website|site)\s+build)\b/i;
const COMPLAINT_LOG_RE = /\b(not a good response|bad response|log complaint|report (?:this )?response|flag (?:this )?reply|that answer was wrong|this response was bad)\b/i;
const IMPROVEMENT_REVIEW_RE = /\b(improvement suggestions?|what should we improve|analy[sz]e complaints?|review complaints?|review failures?|system improvements?|how do we improve jarvis|jarvis improvement report|improvement report)\b/i;

const MEMORY_RE = /\b(forget that|forget this|remember that|remember this|you said|what did i say|update preference)\b/i;
const GENERAL_TIME_RE = /\b(what time is it|what(?:'|’)s the time|current time|time right now|tell me the time)\b/i;
const GENERAL_DATE_RE = /\b(what day is it|today(?:'|’)s date|what(?:'|’)s the date|what is the date|current date)\b/i;
const GENERAL_CHAT_RE = /\b(hi|hello|hey|yo|sup|how(?:'|’)s it going|hows it going|help|what can you do|what do you do|still dumb|not working|useless|frustrating|annoying)\b/i;

const CLARIFY_PROMPT = "I'm not sure what you want me to help with yet. Do you want trading help, a web search, or something else?";

const TRADING_LANGUAGE_LIBRARY = Object.freeze({
  live_action_questions: [
    /\bshould we take (?:it|this|the setup)\b/i,
    /\bwhat do you think (?:here|right now|about this|about it)\b/i,
    /\bare we (?:good to go|clear to go|ready to go)\b/i,
    /\bcan we (?:take it|go|trade this)\b/i,
    /\bdo we have a go\b/i,
  ],
  wait_or_blocked_questions: [
    /\bwhy are we waiting\b/i,
    /\bwhy (?:are we|is this) blocked\b/i,
    /\bwhat(?:'s| is) blocking (?:us|this|the setup|the trade)\b/i,
    /\bwhat(?:'s| is) the blocker\b/i,
    /\bwhy not now\b/i,
  ],
  if_it_clears_lean_questions: [
    /\bif (?:it|this) clears(?:[, ]+)?(?:what(?:'s| is)|what)\s+(?:the )?lean\b/i,
    /\bwhat(?:'s| is) the lean if (?:it|this) clears\b/i,
    /\blean if (?:it|this) clears\b/i,
    /\bif (?:it|this) clears(?:[, ]+)?how should we play it\b/i,
  ],
  result_review_questions: [
    /\bdid today(?:['’]s)? setup (?:lose|win|work)\b/i,
    /\bdid (?:my|this) setup (?:win|lose|work) today\b/i,
    /\bdid we (?:win|lose) today\b/i,
    /\bdid we make money today\b/i,
    /\bdid we have a (?:winner|loser) today\b/i,
    /\bdid we do well today\b/i,
    /\bdid today (?:win|lose|work|fail|make money)\b/i,
    /\bwas today a (?:winner|loser)\b/i,
    /\bdid the call work today\b/i,
    /\bwas today(?:['’]s)? setup a winner\b/i,
    /\bdid the strategy lose today\b/i,
    /\bdid jarvis get today right\b/i,
    /\bwas jarvis right today\b/i,
  ],
  post_mortem_questions: [
    /\bwhy (?:didn['’]?t|did not) (?:my setup|the setup|this setup|today(?:['’]s)? setup) work(?: today)?\b/i,
    /\bwhy (?:didn['’]?t|did not) it work(?: today)?\b/i,
    /\bwhy did (?:my setup|the setup|this setup|today(?:['’]s)? setup) fail today\b/i,
    /\bwhy did (?:the setup|this setup|today(?:['’]s)? setup) lose today\b/i,
    /\bwhat made (?:the )?setup fail\b/i,
    /\bwhat went wrong today\b/i,
    /\bwhy was today a no[- ]trade\b/i,
    /\bwhy (?:didn['’]?t|did not) jarvis like (?:the )?setup\b/i,
    /\bwhy did jarvis not like (?:the )?setup\b/i,
    /\bwhy did jarvis skip (?:the )?setup\b/i,
  ],
  performance_summary_questions: [
    /\bhow did we do today\b/i,
    /\bhow did today(?:['’]s)? setup do\b/i,
    /\bhow did jarvis do today\b/i,
  ],
});

function matchesTradingLanguageFamily(text, familyName) {
  const patterns = TRADING_LANGUAGE_LIBRARY[familyName];
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((pattern) => pattern.test(text));
}

function isLikelyNonTradingContext(text) {
  if (!text) return false;
  if (!NON_TRADING_CONTEXT_RE.test(text)) return false;
  return !TRADING_STRONG_CONTEXT_RE.test(text);
}

function classifyTradingLanguageFamilyIntent(text) {
  if (!text || isLikelyNonTradingContext(text)) {
    return null;
  }

  if (
    matchesTradingLanguageFamily(text, 'result_review_questions')
    || matchesTradingLanguageFamily(text, 'post_mortem_questions')
    || matchesTradingLanguageFamily(text, 'performance_summary_questions')
  ) {
    return {
      intent: 'trading_review',
      confidence: 0.93,
      family: 'trading_review_family',
    };
  }

  if (
    matchesTradingLanguageFamily(text, 'wait_or_blocked_questions')
    || matchesTradingLanguageFamily(text, 'if_it_clears_lean_questions')
  ) {
    return {
      intent: 'trading_status',
      confidence: 0.92,
      family: 'trading_status_family',
    };
  }

  if (matchesTradingLanguageFamily(text, 'live_action_questions')) {
    return {
      intent: 'trading_decision',
      confidence: 0.9,
      family: 'trading_live_action_family',
    };
  }

  return null;
}

function isDirectTradingResultQuery(message, options = {}) {
  const text = options.normalized === true
    ? String(message || '')
    : normalizeText(message);
  if (!text) return false;
  if (!TRADING_RESULT_RE.test(text)) return false;
  if (AMBIGUOUS_TRADING_RESULT_RE.test(text) && isLikelyNonTradingContext(text)) {
    return false;
  }
  return true;
}

function isTradingPostmortemReviewQuery(message, options = {}) {
  const text = options.normalized === true
    ? String(message || '')
    : normalizeText(message);
  if (!text) return false;
  if (!TRADING_POSTMORTEM_RE.test(text)) return false;
  return !isLikelyNonTradingContext(text);
}

function keywordScore(text, words) {
  let score = 0;
  for (const w of words) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(text)) score += 1;
  }
  return score;
}

function inferFromHeuristics(text) {
  const tradingScore = keywordScore(text, ['trade', 'trading', 'setup', 'entry', 'exit', 'orb', 'market', 'trend', 'position', 'long', 'short', 'tp', 'sl']);
  const webScore = keywordScore(text, ['search', 'web', 'look', 'nearest', 'closest', 'nearby', 'news', 'weather', 'google']);
  const deviceScore = keywordScore(text, ['uninstall', 'remove', 'delete', 'open', 'launch', 'disable', 'enable', 'settings']);
  const codeScore = keywordScore(text, ['code', 'implement', 'refactor', 'bug', 'feature', 'script']);
  const shoppingScore = keywordScore(text, ['pc', 'computer', 'laptop', 'desktop', 'buy', 'build', 'setup']);
  const projectScore = keywordScore(text, ['website', 'site', 'landing', 'project', 'design', 'business']);

  if (shoppingScore >= 2 && shoppingScore >= projectScore && shoppingScore >= codeScore) {
    return { intent: 'shopping_advisor', confidence: 0.62, layer: 'heuristic' };
  }
  if (projectScore >= 2 && projectScore >= shoppingScore && projectScore >= codeScore) {
    return { intent: 'project_planner', confidence: 0.62, layer: 'heuristic' };
  }
  if (tradingScore >= 2 && tradingScore >= webScore && tradingScore >= deviceScore && tradingScore >= codeScore) {
    return { intent: 'trading_plan', confidence: 0.62, layer: 'heuristic' };
  }
  if (webScore >= 2 && webScore >= deviceScore && webScore >= codeScore) {
    return { intent: LOCAL_SEARCH_RE.test(text) ? 'local_search' : 'web_question', confidence: 0.62, layer: 'heuristic' };
  }
  if (deviceScore >= 2 && deviceScore >= codeScore) {
    return { intent: 'device_action', confidence: 0.62, layer: 'heuristic' };
  }
  if (codeScore >= 2) {
    return { intent: 'code_change', confidence: 0.62, layer: 'heuristic' };
  }
  return null;
}

function analyzeJarvisIntent(message, options = {}) {
  const text = normalizeText(message);
  const allowClarify = options.allowClarify !== false;

  if (!text) {
    return {
      intent: 'general_chat',
      confidence: 0.8,
      layer: 'fast',
      requiresClarification: false,
      clarifyPrompt: null,
      routeGroup: 'general',
    };
  }

  const consent = parseConsentReply(text);
  if (consent === 'YES' || consent === 'NO') {
    return {
      intent: 'consent_reply',
      confidence: 0.99,
      layer: 'fast',
      requiresClarification: false,
      clarifyPrompt: null,
      routeGroup: 'consent',
    };
  }

  if (TRADING_EXECUTION_RE.test(text)) {
    return { intent: 'trading_execution_request', confidence: 0.98, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (TRADING_HYPOTHETICAL_RE.test(text)) {
    return { intent: 'trading_hypothetical', confidence: 0.96, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (TRADING_REPLAY_RE.test(text)) {
    return { intent: 'trading_replay', confidence: 0.96, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (TRADING_REVIEW_RE.test(text)) {
    return { intent: 'trading_review', confidence: 0.94, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (isDirectTradingResultQuery(text, { normalized: true })) {
    return { intent: 'trading_review', confidence: 0.95, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (isTradingPostmortemReviewQuery(text, { normalized: true })) {
    return { intent: 'trading_review', confidence: 0.95, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  const familyIntent = classifyTradingLanguageFamilyIntent(text);
  if (familyIntent) {
    return {
      intent: familyIntent.intent,
      confidence: familyIntent.confidence,
      layer: 'fast_family',
      requiresClarification: false,
      clarifyPrompt: null,
      routeGroup: 'trading',
      family: familyIntent.family,
    };
  }
  if (TRADING_PLAN_RE.test(text)) {
    return { intent: 'trading_plan', confidence: 0.93, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (TRADING_STATUS_RE.test(text)) {
    return { intent: 'trading_status', confidence: 0.93, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (SHOPPING_ADVISOR_RE.test(text)) {
    return { intent: 'shopping_advisor', confidence: 0.93, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'advisory' };
  }
  if (PROJECT_PLANNER_RE.test(text)) {
    return { intent: 'project_planner', confidence: 0.93, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'planning' };
  }
  if (COMPLAINT_LOG_RE.test(text)) {
    return { intent: 'complaint_log', confidence: 0.95, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'feedback' };
  }
  if (IMPROVEMENT_REVIEW_RE.test(text)) {
    return { intent: 'improvement_review', confidence: 0.92, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'diagnostic' };
  }
  if (TRADING_DECISION_RE.test(text) || TRADING_KEYWORD_RE.test(text)) {
    return { intent: 'trading_decision', confidence: 0.9, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'trading' };
  }
  if (LOCAL_SEARCH_RE.test(text) || looksLikeLocalSearchQuery(text)) {
    return { intent: 'local_search', confidence: 0.95, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'web' };
  }
  if (WEB_QUESTION_RE.test(text)) {
    return { intent: 'web_question', confidence: 0.9, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'web' };
  }
  if (DEVICE_ACTION_RE.test(text)) {
    return { intent: 'device_action', confidence: 0.92, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'device' };
  }
  if (CODE_CHANGE_RE.test(text)) {
    return { intent: 'code_change', confidence: 0.92, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'code' };
  }
  if (SYSTEM_DIAG_RE.test(text)) {
    return { intent: 'system_diag', confidence: 0.96, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'diag' };
  }
  if (MEMORY_RE.test(text)) {
    return { intent: 'memory_query', confidence: 0.88, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'memory' };
  }
  if (GENERAL_TIME_RE.test(text) || GENERAL_DATE_RE.test(text) || GENERAL_CHAT_RE.test(text)) {
    return { intent: 'general_chat', confidence: 0.87, layer: 'fast', requiresClarification: false, clarifyPrompt: null, routeGroup: 'general' };
  }

  const inferred = inferFromHeuristics(text);
  if (inferred) {
    return {
      ...inferred,
      requiresClarification: false,
      clarifyPrompt: null,
      routeGroup: inferred.intent.startsWith('trading_')
        ? 'trading'
        : inferred.intent === 'shopping_advisor'
          ? 'advisory'
          : inferred.intent === 'project_planner'
            ? 'planning'
        : (inferred.intent === 'local_search' || inferred.intent.startsWith('web'))
          ? 'web'
          : inferred.intent === 'device_action'
            ? 'device'
            : (inferred.intent === 'code_change' ? 'code' : 'general'),
    };
  }

  if (allowClarify) {
    return {
      intent: 'unclear',
      confidence: 0.3,
      layer: 'clarify',
      requiresClarification: true,
      clarifyPrompt: CLARIFY_PROMPT,
      routeGroup: 'clarify',
    };
  }

  return {
    intent: 'general_chat',
    confidence: 0.5,
    layer: 'fallback',
    requiresClarification: false,
    clarifyPrompt: null,
    routeGroup: 'general',
  };
}

function classifyJarvisIntent(message, options = {}) {
  return analyzeJarvisIntent(message, options).intent;
}

module.exports = {
  analyzeJarvisIntent,
  classifyJarvisIntent,
  isDirectTradingResultQuery,
  isTradingPostmortemReviewQuery,
  normalizeText,
  CLARIFY_PROMPT,
};
