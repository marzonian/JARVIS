# Regime Persistence Trust Override Policy

## Purpose
`regimePersistenceTrustOverride` is the final bounded persistence-side advisory policy layer. It translates the existing persistence stack into one explicit confidence-policy answer: whether persistence evidence should suppress, cautiously allow, or more strongly allow advisory confidence right now.

## Inputs
This layer composes only from existing advisory summaries:
- `regimePersistenceOperationalCredibility`
- `regimePersistenceGraduationDelta`
- `regimePersistenceGraduation`
- `regimePersistenceReadiness`
- `regimeLivePersistenceQuality`
- `regimeConfirmationDurability`
- `regimeTrustConsumption`

No replay, backtest, discovery, tracking, or other heavy recomputation is performed.

## Policy Method
For each canonical regime (`trending`, `ranging`, `wide_volatile`, `compressed`, `mixed`, `unknown`), the layer:
1. Builds a conservative per-regime evidence context from existing rows/labels.
2. Computes a bounded `overrideScore` (`0..100`) using credibility, readiness, graduation, delta, quality, durability, and blocker burden.
3. Applies hard guardrails before final policy classification.
4. Emits a bounded policy triplet:
   - `overrideLabel`: `suppressed | cautious | enabled`
   - `confidencePolicy`: `suppress_confidence | allow_cautious_confidence | allow_structured_confidence`
   - `confidenceOverrideAction`: `decrease_confidence | no_material_change | increase_confidence`
5. Emits bounded advisory `confidenceOverridePoints` (`-12..+6`).

## Guardrails
The layer hard-caps optimistic outcomes:
- If `operationalTrustGate === blocked`, result is forced to suppressed policy.
- If `operationalTrustGate === cautious_use`, result cannot exceed cautious policy.
- If `persistenceSource !== persisted_live_history`, structured confidence is disallowed.
- If durability is `unconfirmed`, structured confidence is disallowed.
- If persistence quality is `insufficient_live_depth`, structured confidence is disallowed.
- If readiness is not `ready`, structured confidence is disallowed.
- If graduation state is not `live_persistence_ready`, structured confidence is disallowed.
- If delta is `regressing` or momentum is `slipping`, policy degrades.
- Mixed/reconstructed dominance is explicit in blockers.

## Supported Outputs
Top-level output:
- `overrideScore`, `overrideLabel`, `confidencePolicy`, `confidenceOverrideAction`, `confidenceOverridePoints`
- `policyReason`, `policyBlockers`, `policySupports`, `trustOverrideInsight`
- regime label buckets: `suppressOverrideRegimeLabels`, `cautiousOverrideRegimeLabels`, `enabledOverrideRegimeLabels`
- per-regime rows in `trustOverrideByRegime[]`
- `readyForOperationalUse` passthrough and `advisoryOnly: true`

## Advisory-Only Constraints
- No execution mutation.
- No order-routing changes.
- No baseline strategy rewrite.
- No TP/default behavior change.
- No strategy auto-promotion.
- No silent relaxation of conservative caps.

## Provenance Safety
Reconstructed or mixed persistence cannot silently produce structured confidence. Structured confidence is only allowed when live-dominant persistence and operational credibility conditions are simultaneously satisfied.
