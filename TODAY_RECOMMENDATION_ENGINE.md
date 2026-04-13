# Today Recommendation Engine

## Purpose
The Today Recommendation Engine synthesizes Jarvis trading intelligence layers into one advisory decision output for the current session.

It answers:
- Is today favorable?
- Trade normally, selectively, wait for news, or stand down?
- Which TP mechanic is best supported today?

## Inputs
- Strategy recommendation layer
- Global mechanics research recommendation
- Contextual mechanics recommendation
- News qualification signal
- Historical day/time resemblance
- Projected win chance
- Session phase

## Decision Layers
1. Posture classification:
   - `trade_normally`
   - `trade_selectively`
   - `wait_for_news`
   - `stand_down`
2. TP mechanics advisory selection:
   - contextual mechanics (if sample + confidence qualify)
   - otherwise global mechanics baseline
3. Unified confidence model:
   - projected edge
   - context sample/confidence
   - historical alignment
   - cross-signal agreement

## Posture Model
Heuristic and transparent:
- High-impact news imminent -> `wait_for_news`
- Very low projected edge -> `stand_down`
- Strong projected edge + favorable historical alignment -> `trade_normally`
- Mixed conditions -> `trade_selectively`

## Confidence Model
Output:
- `confidenceScore` (0..100)
- `confidenceLabel` (`high` / `medium` / `low`)

Factors:
- projected win chance strength
- strategy confidence
- contextual mechanics confidence/sample
- historical context stance
- global/contextual agreement

## Truth-Model Guarantees
1. Original Trading Plan remains unchanged baseline.
2. Variants remain advisory.
3. Mechanics research remains advisory.
4. Contextual mechanics recommendation remains advisory.
5. Today Recommendation is advisory only and does not change execution parameters.

## Output Contract
`todayRecommendation` includes:
- `posture`
- `postureReason`
- `recommendedStrategy`
- `strategyConfidence`
- `recommendedTpMode`
- `recommendationBasis`
- `tpRecommendationReason`
- `projectedWinChance`
- `newsImpactStatus`
- `contextMatchSummary`
- `confidenceScore`
- `confidenceLabel`
- `advisoryOnly`
