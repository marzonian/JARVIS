## Purpose
The Regime Confirmation Durability layer measures whether live regime confirmation is stable, fragile, improving, or decaying over time-like proxy windows. It sits above `liveRegimeConfirmation` and does not change execution, strategy selection, or TP behavior.

## Inputs
- `liveRegimeConfirmation`
- `regimeTrustConsumption`
- `regimeEvidenceSplit`
- `regimePerformanceFeedback`
- `recommendationPerformance.scorecards`
- `recommendationPerformance.summary`
- Optional `regimeByDate` only for canonical alignment when needed

## Durability Method
1. Reuse current live-confirmation state/progress per canonical regime.
2. Reuse trust-consumption and evidence-split divergence context.
3. Compute bounded durability score (`0..100`) from:
   - confirmation progress depth
   - live sample depth vs required promotion sample
   - trust-consumption posture
   - evidence quality and all-vs-live divergence penalties
4. Compute bounded durability progress (`0..100`) as a persistence-oriented progress metric separate from confirmation progress.
5. Classify durability state conservatively.

## Supported Outputs
Top-level `regimeConfirmationDurability`:
- `generatedAt`
- `windowSessions`
- `currentRegimeLabel`
- `currentRegimeDurabilityState`
- `currentRegimeDurabilityReason`
- `currentRegimeDurabilityScore`
- `currentRegimeDurabilityProgressPct`
- `durabilityByRegime[]`
- `durableConfirmedRegimeLabels[]`
- `fragileRegimeLabels[]`
- `decayingRegimeLabels[]`
- `recoveringRegimeLabels[]`
- `regimeDurabilityInsight`
- `advisoryOnly: true`

Per-row `durabilityByRegime[]` includes:
- `regimeLabel`
- `latestPromotionState`
- `latestConfirmationProgressPct`
- `latestLiveSampleSize`
- `durabilityScore`
- `durabilityState`
- `durabilityReason`
- `durabilityProgressPct`
- `persistenceWindowCount`
- `consecutiveQualifiedWindows`
- `consecutiveWeakWindows`
- `warnings[]`
- `advisoryOnly: true`

## Thin-Sample Handling
- `liveSampleSize == 0` is always treated as unconfirmed durability.
- Small live samples are capped conservatively and flagged.
- Strong all-evidence scores cannot substitute for live durability.
- Mixed/unknown regimes require materially stronger live evidence before durability can be considered strong.

## Advisory-Only Constraints
- Advisory-only layer.
- No execution mutation.
- No baseline strategy rewrite.
- No TP auto-switching.
- No strategy auto-promotion.
- No order-routing changes.

## Anti-Overfitting Safeguards
- `durable_confirmed` cannot be granted without current `live_confirmed` promotion state.
- Retrospective-heavy conditions penalize durability.
- Large all-vs-live divergence penalizes durability.
- Fragile and decaying conditions are explicit, not hidden.
- Mixed/unknown regimes are conservatively capped unless stronger live thresholds are met.

## Durability State Rules
Allowed durability states:
- `unconfirmed`
- `building_durability`
- `durable_confirmed`
- `fragile_confirmation`
- `decaying_confirmation`
- `recovering_confirmation`

Core constraints:
- `durable_confirmed` requires current live confirmation, sufficient live sample depth, acceptable trust-consumption posture, and non-retrospective-heavy evidence.
- `fragile_confirmation` captures confirmed-but-not-stable conditions.
- `decaying_confirmation` captures suppression/divergence deterioration.
- `recovering_confirmation` captures improving persistence conditions that are not yet durable.

## Proxy Persistence Semantics
`persistenceWindowCount`, `consecutiveQualifiedWindows`, and `consecutiveWeakWindows` are bounded proxy indicators in this pass. They are derived from current sample depth, trust posture, and divergence conditions. They are not literal persisted historical streak counters and should be interpreted as conservative persistence-quality estimates.
