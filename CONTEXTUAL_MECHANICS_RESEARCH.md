# Contextual Mechanics Research

## Purpose
Contextual Mechanics Research upgrades global TP-mode research into context-aware decision support. It answers which TP mode has historically performed best in market conditions that resemble "right now."

This layer is advisory and evidence-backed. It does not auto-change the original trading plan.

## Context Segmentation Types
The contextual engine segments mechanics history by:

1. Weekday (`Monday` ... `Friday`)
2. Time bucket
   - `orb_window` (09:30-09:44 ET)
   - `post_orb` (09:45-10:14 ET)
   - `momentum_window` (10:15-10:59 ET)
   - `late_window` (11:00+ ET)
3. Regime (optional)
   - Uses existing regime data only when present and reliable.
   - If absent, `regime` is not forced and fallback logic applies.

## Ranking Logic
Context subsets use the same per-TP-mode metrics and ranking logic as global mechanics research:

- Win-rate leader
- Profit-factor leader
- PF-first recent score (`scoreRecent`)
- Practical recommendation with sample guardrails

## Fallback Logic
If exact context has a thin sample (`< 15` trades), fall back in order:

1. drop regime -> keep weekday + time bucket
2. time bucket only
3. global mechanics sample

Every fallback is explicit in `fallbackLevel`.

## Recommendation Logic
Contextual recommendation fields:

- `contextUsed`
- `fallbackLevel`
- `sampleSize`
- `confidenceScore`
- `confidenceLabel` (`high` / `medium` / `low`)
- `bestTpModeContext`
- `contextualRecommendedTpMode`
- `contextualRecommendationReason`

## Confidence Scoring
Confidence combines:

1. Sample quality (context sample size)
2. Metric stability (gap between leading and runner-up mode)
3. Distance from global profile (context-vs-global drift penalty)

This yields `confidenceScore` (0..100) and `confidenceLabel`.

## Truth-Model Separation
1. Original Trading Plan: unchanged baseline.
2. Mechanics Research (global): advisory.
3. Contextual Recommendation: advisory.

No contextual recommendation is auto-adopted into execution settings.

## Unsupported / Honest Limits
- Supported TP modes: `Nearest`, `Skip 1`, `Skip 2`
- Supported stop family: `rr_1_to_1_from_tp`
- Unsupported stop families remain disclosed:
  - `structure_stop`
  - `orb_opposite_stop`
  - `fixed_tick_stop`
