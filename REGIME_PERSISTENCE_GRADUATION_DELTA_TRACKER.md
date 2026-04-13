# Regime Persistence Graduation Delta Tracker

## Purpose
The Regime Persistence Graduation Delta Tracker is a bounded advisory-only layer that compares the current `regimePersistenceGraduation` state to prior persisted advisory snapshots and reports whether progress is improving, flat, regressing, accelerating, stalled, oscillating, or slipping.

This layer does not change execution behavior, baseline strategy behavior, TP behavior, or strategy promotion behavior.

## Inputs
This layer composes on existing outputs only:
- `regimePersistenceGraduation`
- `regimePersistenceReadiness`
- `regimeLivePersistenceQuality`
- `regimeConfirmationDurability`
- `regimeConfirmationHistory`
- persisted `jarvis_regime_confirmation_history` rows

No replay, backtest, discovery, tracking, or heavy recomputation is introduced.

## Comparison Method
For each canonical regime label (`trending`, `ranging`, `wide_volatile`, `compressed`, `mixed`, `unknown`):
1. Build current graduation state from current bounded summaries.
2. Reconstruct prior comparable state from persisted advisory rows in the same bounded window/source.
3. Compute:
   - `deltaProgressScore = currentGraduationProgressScore - priorGraduationProgressScore`
   - `deltaDirection`: `improving` (`> +5`), `flat` (`-5..+5`), `regressing` (`< -5`)
   - `deltaStrength`: `strong` (`>= 15` abs delta), `moderate` (`>= 7`), else `weak`
4. Compare blockers (`remainingRequirements`) to produce:
   - `blockersAdded`
   - `blockersRemoved`
   - `blockersUnchanged`
5. Compare milestones (`milestoneFrom`, `milestoneTo`, `milestoneChanged`).
6. Classify `momentumLabel` conservatively from delta direction, blocker movement, and milestone movement.

## Bounded Enums
### `deltaDirection`
- `improving`
- `flat`
- `regressing`

### `deltaStrength`
- `strong`
- `moderate`
- `weak`

### `momentumLabel`
- `accelerating`
- `steady_progress`
- `stalled`
- `oscillating`
- `slipping`

### Blocker enum (diff-only)
- `add_live_tenure`
- `increase_live_coverage`
- `reduce_reconstructed_share`
- `improve_durability`
- `improve_persistence_quality`
- `confirm_live_cadence`
- `establish_live_base`

## Supported Outputs
Top-level object fields:
- `generatedAt`
- `windowSessions`
- `performanceSource`
- `currentRegimeLabel`
- `currentGraduationMilestone`
- `currentGraduationProgressScore`
- `priorGraduationProgressScore`
- `deltaProgressScore`
- `deltaDirection`
- `deltaStrength`
- `momentumLabel`
- `blockersAdded`
- `blockersRemoved`
- `blockersUnchanged`
- `milestoneChanged`
- `milestoneFrom`
- `milestoneTo`
- `regimeProgressDeltaInsight`
- `readyForOperationalUse`
- `progressingRegimeLabels`
- `regressingRegimeLabels`
- `stalledRegimeLabels`
- `oscillatingRegimeLabels`
- `graduationDeltaByRegime[]`
- `advisoryOnly: true`

Per-regime rows include bounded current/prior milestone+score fields, delta fields, blocker diffs, and `advisoryOnly: true`.

## Thin-History Handling
If no prior comparable state exists, output is forced conservative:
- `priorGraduationProgressScore = null`
- `deltaDirection = flat`
- `deltaStrength = weak`
- `momentumLabel = stalled`
- warnings include `no_prior_snapshot`

Additional warnings can include:
- `thin_delta_history`
- `reconstructed_dominant_history`
- `mixed_history_only`
- `current_regime_not_live_ready`
- `insufficient_live_capture_depth`

## Command Center Consumption
The command center consumes concise delta fields only:
- `regimePersistenceDeltaDirection`
- `regimePersistenceDeltaStrength`
- `regimePersistenceMomentumLabel`
- `regimePersistenceDeltaScore`
- `regimePersistenceBlockersAdded`
- `regimePersistenceBlockersRemoved`
- `regimePersistenceDeltaInsight`

Decision board and today recommendation receive short pass-through advisory fields; no execution mutation occurs.

## Advisory-Only Integrity Rules
- No execution mutation.
- No baseline rewrite.
- No TP/default mutation.
- No strategy auto-promotion.
- No unbounded enums.
- No overclaiming when history is thin or reconstructed-dominant.
