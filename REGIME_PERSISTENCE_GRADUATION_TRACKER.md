## Purpose
The Regime Persistence Graduation Tracker converts existing readiness, quality, durability, and history summaries into bounded milestone progress.

It tracks how far a regime has progressed from early live persistence accumulation toward operationally credible live persistence.

## Inputs
This layer composes only existing summaries:
- `regimePersistenceReadiness`
- `regimeLivePersistenceQuality`
- `regimeConfirmationDurability`
- `regimeConfirmationHistory`

No replay, backtest, discovery, or hidden recomputation is added.

## Graduation Milestones
`graduationMilestone` is bounded to:
- `no_live_base`
- `live_base_established`
- `live_depth_building`
- `durability_building`
- `nearing_operational_readiness`
- `operationally_ready`

Conservative interpretation:
- reconstructed persistence is not enough for operational graduation,
- mixed persistence cannot silently count as fully ready,
- operational readiness requires persisted live history, depth, coverage, and non-weak durability.

## Progress Direction
`progressDirection` is bounded to:
- `improving`
- `flat`
- `regressing`

If directional evidence is weak, the tracker defaults to `flat` instead of overclaiming trend direction.

## Supported Outputs
`regimePersistenceGraduation` includes:
- `currentRegimeLabel`
- `readinessLabel`
- `graduationState`
- `graduationMilestone`
- `graduationProgressScore`
- `graduationProgressPct`
- `progressDirection`
- `remainingRequirements`
- `graduationInsight`
- `readyForOperationalUse`
- `graduatedRegimeLabels`
- `progressingRegimeLabels`
- `stalledGraduationRegimeLabels`
- `advisoryOnly: true`

## Thin-Live-History Handling
When live tenure, coverage, or cadence are thin:
- milestone remains in early stages,
- requirements remain explicit,
- operational readiness is blocked.

No low-depth live snapshot can silently graduate to operational use.

## Advisory-Only Constraints
- No execution mutation.
- No strategy switching.
- No TP behavior changes.
- No baseline rewrite.
- No automatic execution promotion.

Milestones are advisory progress signals only, not behavior switches.

## Anti-Overfitting Safeguards
- Never infer operational readiness from reconstructed-only persistence.
- Never let mixed persistence silently pass as persisted live readiness.
- Keep milestone and requirement enums strictly bounded.
- Prefer conservative progress interpretation when signals conflict.

## Remaining Requirement Rules
`remainingRequirements` may only include:
- `add_live_tenure`
- `increase_live_coverage`
- `reduce_reconstructed_share`
- `improve_durability`
- `improve_persistence_quality`
- `confirm_live_cadence`
- `establish_live_base`

Requirements remain explicit so graduation blockers are transparent and auditable.
