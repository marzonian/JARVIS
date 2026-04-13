# Recommendation Outcome Scoring

## Purpose
The Recommendation Outcome Scoring Engine is Jarvis's advisory feedback loop. It scores whether `todayRecommendation` guidance aligned with realized outcomes and tracks whether recommendation quality is improving over time.

This layer is analytics-only. It does not execute trades, alter risk limits, or mutate strategy parameters.

## Evaluation Signals
Per scored day, the engine compares recommendation context against realized outcomes from:
- `todayRecommendation` snapshot (posture, strategy recommendation, TP recommendation)
- actual trade outcomes from `trades` (taken/not taken, PnL, direction, timing)
- strategy-layer per-date outcomes (recommended strategy vs best-performing strategy)
- mechanics variant outcomes (`Nearest`, `Skip 1`, `Skip 2`) via replay mechanics tool

## Scoring Metrics
Daily scorecard (`recommendationOutcome`) includes:
- `postureEvaluation`: `correct` | `partially_correct` | `incorrect`
- `strategyRecommendationScore`:
  - `strategyCorrect`
  - `strategyImprovementPotential`
  - `strategyRelativePnL`
  - `scoreLabel`
- `tpRecommendationScore`:
  - `tpCorrect`
  - `tpRelativeTicks`
  - `tpRelativePnL`
  - `scoreLabel`
- realized and counterfactual totals:
  - `actualPnL`
  - `bestPossiblePnL`
  - `recommendationDelta`

## Historical Tracking
Jarvis stores:
- daily recommendation context in `jarvis_recommendation_context`
- daily scored outcomes in `jarvis_recommendation_outcome_daily`

Rolling summaries are produced for 30-day and 90-day windows:
- `postureAccuracy30d`, `strategyAccuracy30d`, `tpAccuracy30d`
- 90d counterparts
- average `recommendationDelta`

## Confidence Recalibration
Recommendation performance is an explicit calibration signal:
- higher sustained rolling accuracy supports higher confidence labels
- low-sample windows raise thin-sample warnings
- negative recommendation deltas indicate recommendation drift and should trigger review

The engine mirrors recommender-system evaluation principles by scoring across multiple objective dimensions (posture, strategy, TP mechanics), not a single indicator.

## Truth-Model Guarantees
- Advisory only: scoring does not auto-apply strategy changes.
- Original Trading Plan remains unchanged baseline.
- Variant and mechanics suggestions remain separate research/advisory layers.
- Output must remain explicit about sample quality and uncertainty.
