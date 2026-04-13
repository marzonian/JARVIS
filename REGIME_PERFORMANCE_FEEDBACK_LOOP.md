# Regime Performance Feedback Loop

## Purpose
The Regime Performance Feedback Loop scores whether Jarvis regime labels are practically useful for advisory decision support. It evaluates regime usefulness against realized recommendation/strategy/TP outcomes and returns bounded confidence guidance.

This layer is advisory analytics only.

## Inputs
- Canonical regime context from `regime-detection`.
- Regime-segmented learning summaries from `regime-aware-learning`:
  - strategy-by-regime
  - TP-by-regime
  - recommendation-accuracy-by-regime
- Recommendation outcome history from `recommendation-outcome`:
  - scorecards (date, sourceType, posture/strategy/TP labels, recommendation delta)
  - provenance warnings and sample warnings.
- Coverage is split into two explicit channels per regime row:
  - `upstreamCoverageSampleSize`: analytical bucket coverage from regime-aware-learning.
  - `directProvenanceSampleSize`: scorecard-backed coverage from direct recommendation provenance.

## Evaluation Method
For each supported regime label (`trending`, `ranging`, `wide_volatile`, `compressed`, `mixed`, `unknown`):
- Build per-regime provenance counts from scorecards:
  - `evidenceSourceBreakdown = { live, backfill, total }`
- Compute usefulness score using conservative weighted components:
  - recommendation-accuracy component
  - strategy-selection component
  - TP usefulness component
  - recommendation-delta component
- Assign usefulness labels:
  - `strong`, `moderate`, `weak`, `noisy`, `insufficient`
- Produce bounded confidence adjustment guidance (`-15..+10`) with strict thin-sample clamps.

## Supported Feedback Outputs
- `regimeUsefulness[]` rows with per-regime usefulness and provenance.
- `regimeConfidenceGuidance` for the current regime.
- `strategySelectionUsefulnessByRegime[]`.
- `tpUsefulnessByRegime[]`.
- `strongRegimeLabels[]` and `weakRegimeLabels[]`.
- `regimeFeedbackInsight` concise narrative.
- Each regime row exposes:
  - `coverageType`: `direct_provenance` | `upstream_only` | `mixed_support` | `no_support`
  - `provenanceStrengthLabel`: `direct` | `retrospective_heavy` | `mixed` | `inferred_only` | `absent`

## Regime Feedback Integrity Rules
- Advisory only: feedback never changes execution behavior.
- No baseline rewrite: original trading plan remains untouched.
- No auto strategy/TP switching from regime feedback.
- No unsupported labels: output is always within canonical supported regimes.
- No synthetic provenance: source counts come from real scorecard provenance.
- Weak evidence is explicit: thin/noisy/retrospective-heavy states are surfaced in output.
- Inferred-only rows (upstream coverage without direct scorecard support) are explicitly capped:
  - cannot be `strong`
  - cannot increase trust
  - cannot receive positive confidence adjustment.
- Rows with `no_support` are forced to `insufficient` with zero adjustment.

## Thin-Sample Handling
- `sampleSize < 5` => `insufficient`, confidence adjustment forced to `0`.
- `sampleSize < 10` => `noisy`, adjustment tightly clamped.
- `mixed`/`unknown` regimes cannot receive positive confidence guidance unless evidence is unusually strong.
- Retrospective-heavy evidence is downgraded in guidance messaging.
- `directProvenanceSampleSize < 5` is treated as thin direct evidence:
  - label cannot exceed `noisy`
  - confidence adjustment is tightly conservative.

## Anti-Overfitting Safeguards
- `sampleSize < 5` => `insufficient`, confidence adjustment forced to `0`.
- `sampleSize < 10` => `noisy`, adjustment tightly clamped.
- `mixed`/`unknown` regimes cannot receive positive confidence guidance unless evidence is unusually strong.
- Retrospective-heavy evidence is downgraded in guidance messaging.

## Provenance Strength Semantics
`regimeConfidenceGuidance.evidenceQuality` is first-class and bounded to:
- `strong_live`
- `mixed`
- `retrospective_heavy`
- `thin`

`regimeUsefulness[].provenanceStrengthLabel` is also first-class and bounded to:
- `direct`
- `retrospective_heavy`
- `mixed`
- `inferred_only`
- `absent`

Rules:
- `thin`: total < 10
- `retrospective_heavy`: backfill >= 2*live and backfill >= 10
- `strong_live`: live >= 20 and live >= 1.5*backfill
- otherwise `mixed`

Interpretation:
- It is valid for a regime to have upstream analytical support but zero direct provenance (`upstream_only`).
- Those rows are informative but cannot justify confidence increases.
- Provenance strength is always explicit in row fields, never hidden only in warnings.

## Advisory-Only Constraints
This loop is analytics and calibration context for explanation quality. It does not:
- mutate execution parameters,
- modify strategy rules,
- auto-promote candidates,
- auto-change canonical regime labels.
