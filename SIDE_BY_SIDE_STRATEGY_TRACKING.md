# Side-by-Side Strategy Tracking

## Purpose
The Side-by-Side Strategy Tracking Engine compares three tracked strategy lanes over time:
1. Original Trading Plan (baseline)
2. Best Variant (learned overlay)
3. Best Alternative Discovery Candidate (advisory)

It answers whether alternatives sustain edge or weaken across windows and contexts.

## Tracked Strategy Set
The engine always attempts to track:
- `original_plan`
- `learned_variant`
- `alternative_candidate`

If variant/candidate is unavailable, this is explicitly surfaced as unavailable with reason.

## Rolling Comparison Windows
Minimum rolling windows:
- 20 sessions
- 60 sessions
- 120 sessions

Additional larger window can be included when requested.

Per strategy, each window reports:
- tradeCount
- winRate
- profitFactor
- expectancy
- drawdownProxy
- tradeFrequency
- sampleQuality

## Ranking Logic
Leader selection uses a composite of:
- PF strength
- win-rate strength
- practical frequency
- drawdown penalty
- stability contribution

Ranking is not a single-metric winner-takes-all model.

## Stability Logic
Each tracked strategy includes:
- `stabilityScore`
- `momentumOfPerformance` (`improving`, `stable`, `weakening`, `volatile`)

Momentum is derived from short-window vs long-window composite movement.

## Context Dominance Rules
When enabled, context comparisons are computed by:
- weekday
- time bucket
- regime (if coverage exists)

Engine explicitly distinguishes:
- global strength
- context-specific strength

Fields include:
- `dominantContexts`
- `weakContexts`
- `contextDominanceLabel`

## Tracking Integrity Rules
- Tracking outputs are advisory only.
- Sample-quality warnings are mandatory.
- Weak candidates are flagged, never hidden.
- Context dominance is not treated as global dominance.
- No strategy is presented as superior without explicit comparative evidence.

## Promotion / Demotion Rules
### Promotion labels
- `monitor_closely`: candidate has signal but evidence is mixed.
- `context_specific_alternative`: candidate leads in specific contexts, not globally.
- `strong_alternative`: candidate beats baseline on key metrics with adequate stability/sample.

### Demotion labels
- `weakening_candidate`: momentum degrades and relative edge is negative vs baseline.
- `low_confidence`: sample too thin for trustable conclusions.

### Evidence minimums
- Thin samples are penalized and can block promotion labels.
- Strong labels require robust sample and non-fragile stability profile.

## Recommendation Handoff State
Tracking emits explicit handoff state:
- `keep_original_plan_baseline`
- `alternative_worth_side_by_side_tracking`
- `alternative_context_only`
- `insufficient_evidence_to_shift`

This state informs advisory posture only and does not auto-switch execution.

## Truth-Model Guarantees
- Original plan remains the true baseline.
- Variant and alternative remain advisory layers.
- No auto-adoption or execution mutation occurs.
- Candidate quality and uncertainty are explicitly disclosed.
