# Regime Persistence Operational Credibility Gate

## Purpose
The Regime Persistence Operational Credibility Gate is a bounded advisory-only composition layer that answers:

`Is current regime persistence evidence operationally credible enough to trust in advisory messaging right now?`

It does not mutate execution, order routing, strategy selection, TP behavior, or baseline strategy rules.

## Inputs
This layer composes only on existing cached/persisted advisory summaries:
- `regimePersistenceReadiness`
- `regimePersistenceGraduation`
- `regimePersistenceGraduationDelta`
- `regimeLivePersistenceQuality`
- `regimeConfirmationDurability`
- `regimeConfirmationHistory`
- `regimeTrustConsumption`

No replay/backtest/discovery/tracking recomputation is introduced.

## Gate Method
For each canonical regime label (`trending`, `ranging`, `wide_volatile`, `compressed`, `mixed`, `unknown`):
1. Gather source quality and live-depth context:
   - persistence source (`persisted_live_history`, `mixed_persisted_history`, `persisted_reconstructed_history`, `proxy_only`)
   - live-captured tenure
   - live-capture coverage
2. Gather quality/durability/readiness context:
   - durability state
   - persistence quality label
   - readiness label + graduation state
3. Gather momentum context:
   - graduation delta direction/strength
   - momentum label
   - blocker adds/removals
4. Build bounded blocker and supporting-signal sets.
5. Compute a conservative `credibilityScore` (0..100).
6. Classify:
   - `credibilityLabel`
   - `operationalTrustGate`
   - `trustPermissionLevel`

## Conservative Guardrails
- `persisted_reconstructed_history` and `proxy_only` cannot become `operationally_credible`.
- `mixed_persisted_history` is capped to cautious use unless unusually strong and still bounded by blockers.
- `durability_not_confirmed`, `insufficient_live_depth`, and `graduationState = reconstructed_dominant` cap the gate below operationally credible.
- `deltaDirection = regressing` or `momentumLabel = slipping` imposes sharp penalties.
- No single positive signal can override blocker burden.
- Mixed/reconstructed dominance is always visible in blockers/warnings.

## Bounded Enums
### `credibilityLabel`
- `not_credible`
- `limited`
- `credible`

### `operationalTrustGate`
- `blocked`
- `cautious_use`
- `operationally_credible`

### `trustPermissionLevel`
- `suppress_persistence_confidence`
- `allow_persistence_with_caution`
- `allow_persistence_confidence`

### Blockers
- `no_live_base`
- `insufficient_live_tenure`
- `insufficient_live_coverage`
- `reconstructed_history_dominant`
- `mixed_persistence_history`
- `durability_not_confirmed`
- `persistence_quality_not_live_ready`
- `graduation_not_ready`
- `delta_not_progressing`
- `live_capture_depth_too_thin`
- `cadence_not_reliable`

### Supporting signals
- `live_base_present`
- `live_tenure_building`
- `live_coverage_improving`
- `durability_building`
- `durability_confirmed`
- `quality_improving`
- `graduation_progressing`
- `blockers_reducing`
- `cadence_healthy`
- `cadence_improving`

## Supported Outputs
Top-level object:
- `generatedAt`
- `windowSessions`
- `performanceSource`
- `currentRegimeLabel`
- `credibilityScore`
- `credibilityLabel`
- `operationalTrustGate`
- `operationalTrustReason`
- `trustPermissionLevel`
- `primaryBlockers`
- `secondaryBlockers`
- `supportingSignals`
- `credibilityInsight`
- `readyForOperationalUse`
- `credibleRegimeLabels`
- `cautionaryRegimeLabels`
- `blockedRegimeLabels`
- `credibilityByRegime[]`
- `warnings[]`
- `advisoryOnly: true`

Per-regime rows remain bounded and advisory-only with explicit blocker/signal visibility.

## Advisory-Only Integrity Rules
- No execution mutation.
- No baseline rewrite.
- No TP/default mutation.
- No auto strategy promotion.
- No silent relaxation of conservative gates.
- Mixed/reconstructed persistence is never treated as fully operationally credible by default.
