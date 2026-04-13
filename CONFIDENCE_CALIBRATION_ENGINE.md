# Context-Aware Confidence Calibration Engine

## Purpose
Jarvis confidence should reflect historical recommendation performance, not only static heuristics. This engine calibrates confidence messaging using comparable historical recommendation outcomes.

This layer is advisory-only and never changes execution logic, strategy rules, or order behavior.

## Pipeline Location
The calibration stage runs after `todayRecommendation` generation:

1. strategy analysis  
2. mechanics/context research  
3. `todayRecommendation` (base confidence)  
4. confidence calibration (this engine)  

Calibration only adjusts confidence fields and messaging.

## Evidence Bucketing Model
Primary evidence bucket dimensions:
- `posture`
- `recommendedStrategyKey`
- `recommendedTpMode`
- `weekday`
- `timeBucket`
- `reconstructionPhase`

Fallback chain:
1. `full_context`
2. `drop_weekday`
3. `drop_time_bucket`
4. `global_fallback`

## Calibration Algorithm
Signals combined conservatively:
- posture accuracy
- strategy accuracy
- TP accuracy
- average recommendation delta

Bounds:
- max increase: `+10`
- max decrease: `-15`

Fallback levels and thin samples further reduce magnitude.

## Sample / Overfitting Safeguards
- sample `< 5`: no calibration (`delta=0`)
- sample `< 10`: clamp delta to `[-4, +4]`
- fallback levels reduce adjustment magnitude
- all outputs include sample quality and clamp reason

## Source Labeling Rules
Calibration output includes:
- `evidenceSource` (`live|backfill|all`)
- `evidenceWindow.bucket` (context dimensions)
- `evidenceWindow.fallbackLevel`
- `sampleSize`
- `sampleQuality`

Backfilled evidence remains explicitly retrospective.

## Calibration Integrity Rules
1. No circular feedback: rows on/after current recommendation date are excluded.
2. No overfitting to tiny samples: hard minimum and clamps.
3. Retrospective evidence remains labeled and advisory-only.
4. Calibration cannot mutate strategy selection or execution parameters.
