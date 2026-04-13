# Regime-Aware Strategy Learning

## Purpose
Regime-Aware Strategy Learning extends Jarvis learning from global insights to regime-specific advisory insights. It explains where strategies, TP mechanics, and recommendation patterns are stronger or weaker under bounded regime states.

## Learning Inputs
- Canonical regime labels from `regime-detection`
- Strategy tracking summaries (`trackedStrategies`, `contextPerformance.regime`)
- Mechanics research summaries (`segmentations.regime`)
- Recommendation performance scorecards (posture/strategy/TP scoring)
- Existing strategy learning outputs for context alignment

## Regime Segmentation Logic
The layer uses canonical regime labels:
- `trending`
- `ranging`
- `wide_volatile`
- `compressed`
- `mixed`
- `unknown`

Historical records are normalized into these labels. When upstream buckets are coarse, the layer degrades confidence and emits warnings.

## Supported Regime Comparisons
- Strategy by regime (which tracked strategy has stronger regime-aligned metrics)
- TP mode by regime (which TP mode performs better inside regime buckets)
- Recommendation accuracy by regime (posture/strategy/TP score labels by regime)

## Regime-Specific Outputs
`regimeAwareLearning` exposes:
- `strategyByRegime`
- `tpModeByRegime`
- `recommendationAccuracyByRegime`
- `regimeSpecificOpportunities`
- `regimeSpecificRisks`
- `topRegimeAlignedStrategy`
- `topRegimeMisalignedStrategy`
- `advisoryOnly`

## Anti-Overfitting Safeguards
- Minimum bucket sample checks before strong claims
- Thin-sample buckets are labeled low-confidence
- Retrospective-only evidence triggers warnings
- Mixed/unknown regime contexts reduce confidence
- Context-only edges are not treated as global superiority

## Regime Learning Integrity Rules
- Regime-aware learning is advisory-only.
- It cannot mutate execution behavior.
- It cannot rewrite the original trading plan.
- It cannot auto-promote strategies based on regime segmentation alone.
- Weak or partial regime coverage must be surfaced as warnings.
- If evidence is weak, outputs must remain conservative.

## Truth-Model Guarantees
- Original plan remains the baseline source of truth.
- Regime-aware learning is a separate advisory layer.
- Strategy/governance/experiment states remain independent.
- No hidden fallback should mask weak confidence or missing regime coverage.
