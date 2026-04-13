# 3130 Jarvis Vision Spec (Hard Invariants)

This document defines production non-negotiables. If any invariant fails, the release is blocked.

## 1) Voice -> Jarvis Routing

1. All voice requests must route through `POST /api/jarvis/query`.
2. `activeModule` is context only; routing is selected by Jarvis intent/tool logic.
3. Every voice response must include `toolsUsed` so UI can show a non-spoken trace.
4. Voice pipeline must speak the exact response text (`spokenText === reply` trace parity).

## 2) Earbud Trading Output

Applies when:
- `voiceMode === true`
- `voiceBriefMode === earbud|earpiece`
- intent is trading (`trading_decision` or `trading_status`)

Invariants:
1. No legacy verdict labels/tokens:
   - `DON'T TRADE`, `WAIT:`, `TRADE.`, bracket verdicts, `Why:`, `Best setup`, `STANCE:`
2. Three-sentence template:
   - sentence 1 starts with `I’d` (or `You’re currently` if in position)
   - sentence 2 starts with `Let’s`
   - sentence 3 starts with `If`
3. Length constraints:
   - exactly 3 sentences
   - `<= 420` characters
4. Freshness safety:
   - must not claim ORB is complete before 9:45 ET
   - must not output `0.00` MNQ price when live bars are available

## 3) Precedence Order (Hard)

For trading flows, precedence must resolve in this order:
1. `position`
2. `health_block`
3. `risk_block`
4. `normal`

Meaning:
- Open position management always overrides health/risk/setup analysis.
- Stale/degraded health blocks analysis when not in position.
- Risk guardrails block analysis only when health is OK and no open position.

## 4) Risk / Explain Behavior

1. Trade #2 attempts must block and include explain hook.
2. Cooldown-after-loss blocks must include remaining minutes.
3. Explain aliases (`explain`, `tell me why`, `what happened`, `why not`, `why can't I`, `give me details`) must return full brief from most recent guardrail context.
4. Explain context must persist by session key with TTL and work regardless of active module hint.

## 5) Auditability and Proof

1. `DEBUG_JARVIS_AUDIT=1` must emit structured JSON stage logs for:
   - ingress
   - intent classification
   - tool call start/end
   - precedence resolution
   - formatter choice
   - final reply preview
   - invariants pass/fail
   - voice payload equality check
2. Logs must include:
   - `traceId`, `routePath`, `source`
3. Production readiness requires:
   - e2e audit suite pass
   - fuzz suite pass
   - assistant smoke pass
   - 50 repeated invariant runs pass
