# Strategy Discovery Engine

## Purpose
The Strategy Discovery Engine is an advisory research layer that searches a bounded historical strategy space for **alternative strategy candidates** that may outperform the current baseline. It does not change execution behavior.

## Bounded Search Space
This pass uses a bounded candidate universe from `server/engine/discovery.js` and keeps search constrained to explicit families:
- `first_hour_momentum`
- `compression_breakout` (post-ORB continuation style)
- `lunch_breakout` (alternative time trigger)
- `midday_mean_reversion`

The engine supports optional family filtering at query time and bounded historical windows (`windowSessions`, `candidateLimit`).

## Candidate Strategy Schema
Each candidate exposes:
- `strategyKey`, `strategyName`, `family`, `originType`
- `entryModel`, `exitModel`, `timeModel`
- `sampleSize`, `tradeCount`, `winRate`, `profitFactor`, `expectancy`, `drawdownProxy`
- `comparisonVsOriginal`
- `qualityWarnings`
- `advisoryOnly`
- `robustnessLabel`

## Discovery Integrity Rules
- Candidate strategies are never auto-approved.
- Every candidate is compared against the **Original Trading Plan** baseline.
- Thin samples are penalized.
- Low trade-count candidates are penalized.
- No cherry-picked reporting: best/worst views and quality warnings are always included.
- Sample-quality warnings are mandatory when data is thin.
- Candidates are labeled by robustness (`interesting`, `promising`, `actionable_research_candidate`, `low_confidence`), not just one metric.

## Discovery Validation Rules
- Current validation mode: chronological split evaluation from discovery engine (`train/valid/test`) plus robustness penalties.
- A full walk-forward optimizer is **not** implemented in this pass.
- Candidate quality is scored using out-of-sample style metrics, robustness penalties, and baseline comparison.
- If holdout evidence is weak, confidence is downgraded and warnings are surfaced.

## Anti-Overfitting Rules
Penalties are applied for:
- low trade count
- thin sample windows
- train-to-test instability
- narrow condition dependence
- excessive rule complexity

## Ranking Logic
Candidate ranking prioritizes:
1. strong profit factor
2. high win rate
3. practical sample quality
4. reasonable trade frequency
5. drawdown sanity
6. robustness/fragility penalties

Views produced:
- `bestCandidateOverall`
- `bestCandidateByWinRate`
- `bestCandidateByProfitFactor`
- `bestCandidatePractical`

## Promotion/Governance Labels
Top-level recommendation outputs:
- `candidatePromotionDecision`: `research_only` | `worth_monitoring` | `strong_candidate_for_side_by_side_tracking`
- `promotionReason`

All outputs remain advisory.

## Truth-Model Guarantees
- Original Trading Plan remains unchanged baseline.
- Learned overlays remain separate advisory layer.
- Discovery candidates are separate advisory alternatives.
- Today recommendations may reference candidates but never auto-adopt them.

## Current Limits and Extension Points
- This pass does not auto-execute discovered strategies.
- This pass does not replace the baseline strategy.
- Future extensions: walk-forward validation, richer family set, regime-aware candidate synthesis, and candidate lifecycle governance tied to paper-forward outcomes.
