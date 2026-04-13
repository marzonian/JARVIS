## Purpose
The Live Regime Confirmation Accumulator tracks whether each canonical regime has enough direct live evidence to progress from unconfirmed to genuinely live-confirmed trust. It provides an explicit promotion path for advisory confidence without changing execution behavior.

## Inputs
- `regimeDetection`
- `regimePerformanceFeedback`
- `regimeEvidenceSplit`
- `regimeTrustConsumption`
- `recommendationPerformance.scorecards`
- `recommendationPerformance.summary`
- `regimeByDate` (only for canonical normalization when scorecards lack regime labels)

## Promotion Method
1. Build live-only sample coverage per canonical regime from live scorecards.
2. Reuse `regimeEvidenceSplit.liveOnlyByRegime` for live usefulness quality.
3. Compute required promotion sample per regime (`15` baseline, `30` for mixed/unknown, optional lift to `20` under retrospective-heavy divergence).
4. Assign promotion state:
   - `no_live_support`
   - `emerging_live_support`
   - `near_live_confirmation`
   - `live_confirmed`
   - `stalled_live_support`
5. Compute bounded progress percentage (`0..100`) with trust penalties under weak trust.

## Supported Outputs
Top-level `liveRegimeConfirmation`:
- `generatedAt`
- `windowSessions`
- `currentRegimeLabel`
- `currentRegimePromotionState`
- `currentRegimePromotionReason`
- `currentRegimeLiveSampleSize`
- `currentRegimeRequiredSampleForPromotion`
- `currentRegimeConfirmationProgressPct`
- `liveConfirmationByRegime[]`
- `liveConfirmedRegimeLabels[]`
- `emergingLiveSupportRegimeLabels[]`
- `stalledRegimeLabels[]`
- `liveConfirmationInsight`
- `advisoryOnly`

## Thin-Sample Handling
- `liveSampleSize == 0` always maps to `no_live_support`.
- `1..9` samples stay in `emerging_live_support` unless explicitly stalled by persistent weakness.
- `mixed` and `unknown` require stronger live evidence (`>=30` and high quality) to promote.
- Thin or sparse recent evidence downgrades freshness to `recent_but_thin` or `stale_or_sparse`.

## Advisory-Only Constraints
- No execution mutation.
- No baseline strategy rewrite.
- No TP default changes.
- No strategy auto-promotion.
- No order-routing changes.

This layer is advisory-only progress tracking for trust quality.

## Anti-Overfitting Safeguards
- `live_confirmed` can only come from live-only evidence.
- Retrospective-heavy support can inform monitoring, not live confirmation.
- Progress is penalized when trust remains suppressed or retrospective-led.
- Weak live usefulness across accumulating samples is surfaced as `stalled_live_support`.
- Mixed/unknown regimes remain conservatively capped.

## Live Confirmation Promotion Rules
- `no_live_support`: `liveSampleSize == 0`
- `emerging_live_support`: `liveSampleSize in [1..9]` or live label in `{insufficient,noisy}`
- `near_live_confirmation`: `liveSampleSize >= 10`, live label in `{moderate,strong}`, but full promotion criteria not yet satisfied
- `live_confirmed` only if all are true:
  - `liveSampleSize >= requiredSampleForPromotion`
  - live label in `{moderate,strong}`
  - `liveConfidenceAdjustment >= 0`
  - live provenance is not absent
  - trust bias is not `insufficient_live_confirmation`
  - for `mixed/unknown`: additionally `liveSampleSize >= 30` and `liveUsefulnessScore >= 70`
- `stalled_live_support`:
  - live sample exists, but usefulness remains weak/insufficient/noisy at meaningful sample
  - or current regime trust stays suppressed despite accumulating live sample

## Progress Semantics
`progressPct` is bounded `0..100` and computed from:
- sample progress toward required sample
- usefulness quality weight
- trust penalty under suppressed/retrospective-led conditions

This metric shows confirmation trajectory, not execution readiness.
