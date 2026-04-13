const DEBUG_JARVIS_AUDIT = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG_JARVIS_AUDIT || '').trim());

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function splitSentences(text) {
  const src = normalizeText(text);
  if (!src) return [];
  return src.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function startsWithLoose(text, expectedPrefix) {
  return normalizeLower(String(text || '')).startsWith(normalizeLower(expectedPrefix));
}

function hasLegacyVerdictTokens(text) {
  const src = String(text || '');
  return (
    /\bDON['’]?T TRADE\b/i.test(src)
    || /\bWAIT:\b/i.test(src)
    || /^\s*WAIT[.!:]/i.test(src)
    || /^\s*TRADE[.!:]/i.test(src)
    || /\[(?:\s*WAIT\s*|DON['’]?T TRADE|TRADE)\]/i.test(src)
    || /\bWhy:\b/i.test(src)
    || /\bBest setup\b/i.test(src)
    || /\bSTANCE:\b/i.test(src)
  );
}

function isPreambleOnlyReply(text) {
  const src = normalizeText(text);
  if (!src) return true;
  const preambleStart = /^(let me check|i(?:'|’)ll check|i will check|one moment|hold on|give me a second|let me take a look|let me look|pulling|checking|scanning)/i;
  if (!preambleStart.test(src)) return false;
  return splitSentences(src).length <= 2;
}

function stripEarbudForbiddenTokens(text) {
  let out = String(text || '');
  out = out.replace(/^\s*\[(?:\s*WAIT\s*|DON['’]?T TRADE|TRADE)\]\s*/gi, '');
  out = out.replace(/^\s*DON['’]?T TRADE[.!:]\s*/gi, "I'd sit out for now because ");
  out = out.replace(/^\s*WAIT[.!:]\s*/gi, "I'd wait for now because ");
  out = out.replace(/^\s*TRADE[.!:]\s*/gi, "I'd engage now because ");
  out = out.replace(/\bWAIT:\s*/gi, 'Also, ');
  out = out.replace(/\bDON['’]?T TRADE:\s*/gi, 'Also, ');
  out = out.replace(/\bTRADE:\s*/gi, 'Also, ');
  out = out.replace(/\bWhy:\s*/gi, '');
  out = out.replace(/\bBest setup now:\s*/gi, 'Setup context: ');
  out = out.replace(/\bBest setup:\s*/gi, 'Setup context: ');
  out = out.replace(/\bSTANCE:\s*/gi, '');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

function buildSafeDefaultEarbudReply() {
  return "I'd sit out for now because the response pipeline returned a legacy format. Let's re-check once the data and format are stable. If you say \"explain\", I'll give the full brief.";
}

function isTradingIntent(intent) {
  const id = String(intent || '').trim().toLowerCase();
  return id === 'trend_regime' || id.startsWith('trading_');
}

function validateJarvisResponseInvariants(input = {}) {
  const request = input.request || {};
  const response = input.response || {};
  const context = input.context || {};
  const failedRules = [];
  const checkedRules = [];
  const voiceMode = request.voiceMode === true;
  const briefMode = String(request.voiceBriefMode || '').trim().toLowerCase();
  const intent = String(response.intent || '').trim().toLowerCase();
  const reply = String(response.reply || '');

  checkedRules.push('voice_tools_used_trace');
  if (voiceMode) {
    if (!Array.isArray(response.toolsUsed) || response.toolsUsed.length <= 0) {
      failedRules.push('tools_used_missing');
    }
  }

  if (voiceMode && isTradingIntent(intent) && (briefMode === 'earbud' || briefMode === 'earpiece')) {
    checkedRules.push('earbud_no_legacy_tokens');
    if (hasLegacyVerdictTokens(reply)) failedRules.push('legacy_tokens_present');
    checkedRules.push('earbud_no_preamble_only');
    if (isPreambleOnlyReply(reply)) failedRules.push('preamble_only_reply');

    const sentences = splitSentences(reply);
    checkedRules.push('earbud_3_sentence_template');
    if (sentences.length !== 3) failedRules.push('earbud_sentence_count_not_3');

    checkedRules.push('earbud_char_limit');
    if (reply.length > 420) failedRules.push('earbud_reply_too_long');

    const hasOpenPosition = context.hasOpenPosition === true;
    checkedRules.push('earbud_sentence_1_prefix');
    if (sentences[0]) {
      const okPrefix = hasOpenPosition
        ? (startsWithLoose(sentences[0], "you're currently") || startsWithLoose(sentences[0], 'you are currently'))
        : startsWithLoose(sentences[0], "i'd");
      if (!okPrefix) failedRules.push('earbud_sentence1_prefix_invalid');
    }

    checkedRules.push('earbud_sentence_2_prefix');
    if (sentences[1] && !startsWithLoose(sentences[1], "let's")) failedRules.push('earbud_sentence2_prefix_invalid');

    checkedRules.push('earbud_sentence_3_prefix');
    if (sentences[2] && !startsWithLoose(sentences[2], 'if')) failedRules.push('earbud_sentence3_prefix_invalid');

    const nowMinutes = Number(context.nowMinutesEt);
    const hasORBComplete = context.hasORBComplete === true;
    checkedRules.push('no_pre945_orb_complete_claim');
    if (Number.isFinite(nowMinutes) && nowMinutes < 585 && !hasORBComplete) {
      if (/\b(orb|opening range)\b[\s\S]{0,40}\bcomplete\b/i.test(reply)) {
        failedRules.push('pre945_orb_complete_claim');
      }
      checkedRules.push('no_pre945_orb_final_value_claim');
      if (/\b(?:orb|opening range)\b[\s\S]{0,40}\b(?:is|at)\s*\d+(?:\.\d+)?\s*ticks?\b/i.test(reply)) {
        failedRules.push('pre945_orb_final_value_claim');
      }
    }

    const liveBarsAvailable = context.liveBarsAvailable === true;
    checkedRules.push('no_zero_price_if_live_bars');
    if (liveBarsAvailable && /\b0\.00\b/.test(reply)) {
      failedRules.push('zero_price_with_live_bars');
    }
  }

  checkedRules.push('precedence_order');
  const precedenceMode = String(context.precedenceMode || '').trim().toLowerCase();
  const healthStatus = String(context.healthStatus || '').trim().toUpperCase();
  const riskVerdict = String(context.riskVerdict || '').trim().toUpperCase();
  const hasOpenPosition = context.hasOpenPosition === true;
  const hasTodaySessionBars = context.hasTodaySessionBars;
  const minutesSinceLastBar = Number(context.minutesSinceLastBar);
  const staleThresholdMinutes = Number.isFinite(Number(context.staleThresholdMinutes))
    ? Number(context.staleThresholdMinutes)
    : 5;
  const sessionDateOfData = String(context.sessionDateOfData || '').trim();
  const todayEtDate = String(context.todayEtDate || '').trim();
  const staleFromFreshness = (
    (hasTodaySessionBars === false)
    || (Number.isFinite(minutesSinceLastBar) && minutesSinceLastBar > staleThresholdMinutes)
    || (sessionDateOfData && todayEtDate && sessionDateOfData !== todayEtDate)
  );
  if (hasOpenPosition && precedenceMode && precedenceMode !== 'position') {
    failedRules.push('precedence_violation_position_not_top');
  } else if (!hasOpenPosition && (healthStatus === 'DEGRADED' || healthStatus === 'STALE')) {
    if (precedenceMode && precedenceMode !== 'health_block') failedRules.push('precedence_violation_health_over_risk');
  } else if (!hasOpenPosition && healthStatus === 'OK' && riskVerdict === 'BLOCK') {
    if (precedenceMode && precedenceMode !== 'risk_block') failedRules.push('precedence_violation_risk_mode');
  }
  checkedRules.push('stale_requires_health_block');
  if (!hasOpenPosition && isTradingIntent(intent) && staleFromFreshness) {
    if (precedenceMode && precedenceMode !== 'health_block') {
      failedRules.push('stale_requires_health_block');
    }
    checkedRules.push('stale_no_trend_orb_claims');
    if (/\b(trend|regime|bias|opening range is|orb range is)\b/i.test(reply)) {
      failedRules.push('stale_analysis_claim_present');
    }
  }

  return {
    pass: failedRules.length === 0,
    failedRules,
    checkedRules,
  };
}

function buildEarbudRepairReply(context = {}) {
  const reason = String(context.primaryReason || '').trim();
  if (context.confirmRequired === true) {
    return "I'd hold execution until you explicitly confirm the action. Let's run one guarded step only after you say confirm. If you want to stop instead, say cancel.";
  }
  if (context.hasOpenPosition === true) {
    return "You're currently in a position, so the focus is trade management. Let's protect structure first and avoid adding risk. If structure breaks against the position on a close, we flatten.";
  }
  if (String(context.healthStatus || '').toUpperCase() === 'DEGRADED' || String(context.healthStatus || '').toUpperCase() === 'STALE') {
    return "I'd sit out for now because my live market data is not healthy. Let's re-check once feed health returns to OK. If live bars recover and ORB structure is clean, we can engage.";
  }
  const staleThresholdMinutes = Number.isFinite(Number(context.staleThresholdMinutes))
    ? Number(context.staleThresholdMinutes)
    : 5;
  const staleFromFreshness = (
    context.hasTodaySessionBars === false
    || (Number.isFinite(Number(context.minutesSinceLastBar)) && Number(context.minutesSinceLastBar) > staleThresholdMinutes)
    || (
      String(context.sessionDateOfData || '').trim()
      && String(context.todayEtDate || '').trim()
      && String(context.sessionDateOfData).trim() !== String(context.todayEtDate).trim()
    )
  );
  if (staleFromFreshness) {
    return "I'd sit out for now because I don't have fresh MNQ bars yet. Let's re-check once live data health returns to OK. If bars are current and ORB is complete, we can evaluate entries.";
  }
  if (String(context.riskVerdict || '').toUpperCase() === 'BLOCK') {
    if (String(context.primaryReasonCode || '').toLowerCase() === 'one_trade_per_day') {
      return "I'd sit out for now because that would be trade number two today. Let's protect discipline and wait for the next session. If you want detail, ask explain and I'll break down the block.";
    }
    if (String(context.primaryReasonCode || '').toLowerCase() === 'cooldown_after_loss') {
      const remaining = Number(context.cooldownRemainingMinutes);
      const suffix = Number.isFinite(remaining) && remaining > 0 ? ` for ${Math.ceil(remaining)} more minutes` : '';
      return `I'd sit out for now because you're in cooldown after a loss. Let's reset and protect discipline${suffix}. If structure is clean after cooldown, we can re-check.`;
    }
    if (String(context.primaryReasonCode || '').toLowerCase() === 'outside_entry_window') {
      return "I'd sit out for now because we're outside your entry window. Let's wait for the next planned checkpoint. If we're back inside the window with clean structure, we can engage.";
    }
    if (String(context.primaryReasonCode || '').toLowerCase() === 'daily_loss_limit') {
      return "I'd sit out for now because risk limits are already stressed. Let's protect the account and stop the bleeding. If risk resets tomorrow and structure is clean, we can engage.";
    }
    return "I'd sit out for now because a hard risk guardrail is active. Let's protect discipline before forcing any setup. If the blocker clears and structure confirms, we can engage.";
  }
  const fallbackReason = reason || 'current structure is mixed';
  return `I'd wait for now because ${fallbackReason}. Let's focus on the next 10:15 momentum checkpoint and retest quality. If ORB stays under 220 ticks with one clean retest, we can engage.`;
}

function enforceEarbudFinalGate(input = {}) {
  const request = input.request || {};
  const response = input.response || {};
  const context = input.context || {};
  const intent = String(response.intent || '').trim().toLowerCase();
  const voiceMode = request.voiceMode === true;
  const briefMode = String(request.voiceBriefMode || '').trim().toLowerCase();
  const isEarbudVoice = (
    voiceMode
    && (briefMode === 'earbud' || briefMode === 'earpiece')
  );
  const isEarbudTrading = (
    isEarbudVoice
    && isTradingIntent(intent)
  );
  const shouldEnforceForLegacyLeak = isEarbudVoice && hasLegacyVerdictTokens(String(response.reply || ''));
  const shouldEnforce = isEarbudTrading || shouldEnforceForLegacyLeak;

  if (!shouldEnforce) {
    const invariants = validateJarvisResponseInvariants({ request, response, context });
    return {
      reply: String(response.reply || ''),
      didEarbudFinalize: false,
      usedSafeDefault: false,
      invariants,
    };
  }

  const initialReply = String(response.reply || '');
  let candidate = stripEarbudForbiddenTokens(initialReply);
  let invariants = validateJarvisResponseInvariants({
    request,
    response: { ...response, reply: candidate },
    context,
  });

  let didEarbudFinalize = candidate !== initialReply;
  let usedSafeDefault = false;

  if (!invariants.pass) {
    didEarbudFinalize = true;
    candidate = buildEarbudRepairReply(context);
    candidate = stripEarbudForbiddenTokens(candidate);
    invariants = validateJarvisResponseInvariants({
      request,
      response: { ...response, reply: candidate },
      context,
    });
  }

  if (!invariants.pass) {
    usedSafeDefault = true;
    candidate = buildSafeDefaultEarbudReply();
    invariants = validateJarvisResponseInvariants({
      request,
      response: { ...response, reply: candidate },
      context,
    });
  }

  if (hasLegacyVerdictTokens(candidate)) {
    usedSafeDefault = true;
    candidate = buildSafeDefaultEarbudReply();
    invariants = validateJarvisResponseInvariants({
      request,
      response: { ...response, reply: candidate },
      context,
    });
  }

  return {
    reply: candidate,
    didEarbudFinalize,
    usedSafeDefault,
    invariants,
  };
}

function logJarvisAudit(stage, payload = {}) {
  if (!DEBUG_JARVIS_AUDIT) return;
  const row = {
    at: new Date().toISOString(),
    stage: String(stage || 'unknown'),
    ...payload,
  };
  try {
    console.log(`[DEBUG_JARVIS_AUDIT] ${JSON.stringify(row)}`);
  } catch {
    console.log(`[DEBUG_JARVIS_AUDIT] {"stage":"${String(stage || 'unknown')}"}`);
  }
}

module.exports = {
  DEBUG_JARVIS_AUDIT,
  buildEarbudRepairReply,
  buildSafeDefaultEarbudReply,
  enforceEarbudFinalGate,
  hasLegacyVerdictTokens,
  isTradingIntent,
  logJarvisAudit,
  splitSentences,
  stripEarbudForbiddenTokens,
  validateJarvisResponseInvariants,
};
