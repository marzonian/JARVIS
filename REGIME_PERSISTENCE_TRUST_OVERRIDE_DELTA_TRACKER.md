# Regime Persistence Trust Override Delta Tracker

## Purpose
`regimePersistenceTrustOverrideDelta` is an advisory-only monitor that compares the final persistence trust-override policy against prior persisted advisory snapshots. It answers whether policy posture is improving, flat, regressing, oscillating, or deteriorating over time.

## Inputs
This layer composes from existing advisory outputs only:
- `regimePersistenceTrustOverride`
- `regimePersistenceOperationalCredibility`
- `regimePersistenceGraduationDelta`
- `regimePersistenceGraduation`
- `regimePersistenceReadiness`
- `regimeLivePersistenceQuality`
- `regimeConfirmationHistory`
- persisted `jarvis_regime_confirmation_history` rows when explicit override-history rows are unavailable

No replay, backtest, discovery, tracking, or other heavy recomputation is performed.

## Comparison Method
1. Read current final trust-override state from `regimePersistenceTrustOverride`.
2. Resolve prior comparable state from persisted advisory history.
3. If explicit override-history snapshots are unavailable, reconstruct conservative prior trust-override posture from persisted confirmation-history rows.
4. Compare current vs prior for score, points, label/policy, blockers, and supports.
5. Classify bounded movement outputs:
- `deltaDirection`: `improving | flat | regressing`
- `deltaStrength`: `strong | moderate | weak`
- `momentumLabel`: `accelerating | steady_improvement | stalled | oscillating | deteriorating`

## Guardrails
- This layer does not generate a new trust policy.
- It only monitors movement of the already-final trust-override policy.
- If no prior comparable snapshot exists, output is forced conservative (`flat`, `weak`, `stalled`) with `no_prior_override_snapshot`.
- Reconstructed-dominant or thin history suppresses acceleration claims.
- Suppressed current policy may still show improvement, but output remains operationally conservative.

## Supported Outputs
Top-level output includes:
- current/prior policy labels and scores
- score and points deltas
- blocker/support diffs
- label/policy change flags
- bounded regime momentum buckets
- per-regime detail rows in `trustOverrideDeltaByRegime`
- warnings and advisory-only marker

## Advisory-Only Constraints
- No execution mutation
- No order-routing changes
- No strategy/TP behavior changes
- No baseline rewrites
- No auto-promotion
- No hidden policy relaxation

## Provenance Safety
- Prior-state comparison uses persisted advisory evidence only.
- Reconstructed history is kept conservative and cannot silently claim operational optimism.
- No fabricated prior policy rows are injected.
