## Purpose
The Regime Persistence Readiness layer converts existing persistence, durability, and live-capture summaries into a bounded readiness and graduation judgment.

It answers whether a regime is operationally credible for live persistence interpretation, or whether reconstructed history still dominates.

## Inputs
This layer composes existing summaries only:
- `regimeConfirmationHistory`
- `regimeConfirmationDurability`
- `regimeLivePersistenceQuality`
- `liveRegimeConfirmation`
- `regimeTrustConsumption`

No replay, backtest, discovery, or hidden recomputation is added.

## Readiness Labels
`readinessLabel` is bounded to:
- `ready`
- `near_ready`
- `early`
- `not_ready`

Interpretation:
- `ready`: strong live persistence depth and coverage with non-weak durability and persisted live history.
- `near_ready`: meaningful live accumulation exists but blockers still remain.
- `early`: live accumulation has started but is still shallow.
- `not_ready`: live persistence support is missing or too weak.

## Graduation States
`graduationState` is bounded to:
- `live_persistence_ready`
- `nearing_live_persistence`
- `accumulating_live_depth`
- `reconstructed_dominant`

Interpretation:
- `live_persistence_ready`: genuinely live-ready persistence evidence.
- `nearing_live_persistence`: close to live-ready but still constrained.
- `accumulating_live_depth`: live evidence exists but needs more accumulation.
- `reconstructed_dominant`: reconstructed history still outweighs live persistence support.

## Supported Outputs
`regimePersistenceReadiness` includes:
- `currentRegimeLabel`
- `persistenceSource`
- `currentRegimeHasLiveCapturedHistory`
- `currentRegimeLiveCapturedTenureDays`
- `currentRegimeLiveCaptureCoveragePct`
- `currentRegimeDurabilityState`
- `currentRegimePersistenceQualityLabel`
- `readinessScore`
- `readinessLabel`
- `graduationState`
- `blockers`
- `readinessInsight`
- `liveReadyRegimeLabels`
- `nearReadyRegimeLabels`
- `notReadyRegimeLabels`
- `advisoryOnly: true`

## Thin-Live-History Handling
When live tenure or coverage is thin:
- readiness is capped conservatively,
- graduation stays in `accumulating_live_depth` or `reconstructed_dominant`,
- blockers remain explicit.

Reconstructed-dominant history cannot silently appear as live-ready persistence.

## Advisory-Only Constraints
- No execution mutation.
- No strategy switching.
- No TP behavior changes.
- No baseline rewrite.
- No automatic promotion into live execution behavior.

## Anti-Overfitting Safeguards
- Never infer readiness from reconstructed history alone.
- Mixed/reconstructed persistence cannot silently graduate to `ready`.
- Low live tenure, low coverage, and unconfirmed durability force conservative labels.
- All labels and blockers remain bounded enums.

## Graduation Blocker Rules
`blockers` may only include:
- `insufficient_live_tenure`
- `insufficient_live_coverage`
- `reconstructed_history_dominant`
- `durability_not_confirmed`
- `cadence_too_sparse`
- `live_depth_too_thin`
- `mixed_constraints`
- `no_live_history`

Rules are conservative and compositional:
- no live history adds `no_live_history`,
- low tenure and coverage add explicit blockers,
- reconstructed dominance remains explicit,
- weak durability and mixed constraints block stronger graduation.
