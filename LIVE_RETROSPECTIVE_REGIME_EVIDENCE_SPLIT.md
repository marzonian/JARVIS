# Live vs Retrospective Regime Evidence Split

## Purpose
This layer separates regime usefulness into two parallel advisory views:
- all-evidence usefulness (live + backfill),
- live-only usefulness (direct live scorecards only).

It exists to prevent retrospective-heavy regime signals from being interpreted as equally live-confirmed signals.

## Inputs
- `regimePerformanceFeedback.regimeUsefulness` as the all-evidence baseline.
- `recommendationPerformance.scorecards` filtered by `sourceType=live` for live-only confirmation.
- `regimeDetection.regimeLabel` for current regime comparison.
- `regimeByDate` only for conservative scorecard-to-regime normalization when a scorecard lacks a regime label.

## Evaluation Method
For each canonical regime (`trending`, `ranging`, `wide_volatile`, `compressed`, `mixed`, `unknown`):
- Build `allEvidenceByRegime` from existing regime feedback rows.
- Build `liveOnlyByRegime` from live scorecard evidence only.
- Compute `currentRegimeComparison` and derive `trustBiasLabel`:
  - `live_confirmed`
  - `mixed_support`
  - `retrospective_led`
  - `insufficient_live_confirmation`

The layer is bounded and compositional; it does not run replay/backtest/discovery recomputation.

## Supported Outputs
- `allEvidenceByRegime[]`
- `liveOnlyByRegime[]`
- `currentRegimeComparison`
- `trustBiasLabel`
- `trustBiasReason`
- `liveConfirmedRegimeLabels[]`
- `retrospectiveLedRegimeLabels[]`
- `regimeEvidenceSplitInsight`

## Thin-Sample Handling
- Live-only rows with `liveDirectSampleSize < 5` are forced to:
  - `usefulnessLabel=insufficient`
  - `confidenceAdjustment=0`
  - `coverageType=no_support` (or conservative no-strength handling)
- Live-only rows with `5 <= sample < 10` are capped at `noisy` and tightly clamped.
- Thin live buckets can never be treated as strong confirmation.

## Advisory-Only Constraints
This split layer does not:
- mutate execution behavior,
- change baseline strategy,
- auto-switch strategy or TP behavior,
- alter regime label generation.

It only improves confidence honesty and interpretability.

## Anti-Overfitting Safeguards
- Live-only usefulness never inherits strength from backfill.
- `live_confirmed` requires meaningful live sample and bounded divergence from all-evidence score.
- Mixed/unknown regimes require stronger live evidence before live-confirmed trust can be asserted.
- If live evidence is sparse, trust remains conservative by design.

## Live vs Retrospective Integrity Rules
- All-evidence and live-only rows are always both emitted for each canonical regime.
- `allEvidenceByRegime` and `liveOnlyByRegime` are intentionally separate contracts.
- A strong all-evidence signal does not imply live confirmation.
- Retrospective-led conditions are explicitly labeled and surfaced.

## Trust Bias Semantics
- `live_confirmed`: live-only confirmation is adequate and aligned with all-evidence signal.
- `mixed_support`: both live and retrospective evidence exist, but confirmation is not fully decisive.
- `retrospective_led`: all-evidence is materially stronger than live-only confirmation and/or backfill dominates.
- `insufficient_live_confirmation`: live direct sample is too small for reliable confirmation.

This layer keeps the command center truthful about provenance strength, especially when live evidence is sparse.
