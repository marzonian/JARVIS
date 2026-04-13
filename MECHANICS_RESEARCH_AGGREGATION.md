# Mechanics Research Aggregation

## Purpose
Mechanics Research Aggregation turns per-trade mechanics comparisons into rolling evidence. It evaluates how TP mode variants perform across historical original-plan-eligible trades, then ranks and recommends TP mode candidates as advisory research.

Jarvis uses this layer to answer:
- Which TP mode has the strongest win rate?
- Which TP mode has the strongest profit factor?
- Which TP mode is the best practical recommendation right now?

## Truth Model
1. Original Trading Plan remains unchanged baseline.
2. Learned overlays remain a separate advisory layer.
3. Mechanics research is separate advisory output.

Mechanics research must never silently overwrite original plan mechanics.

## Supported Mechanics Families
- TP modes:
  - Nearest
  - Skip 1
  - Skip 2
- Stop families (supported now):
  - `rr_1_to_1_from_tp`

## Unsupported Stop Families (disclosed, not simulated)
- `structure_stop`
- `orb_opposite_stop`
- `fixed_tick_stop`

## Evidence Window Model
- Window mode: `eligible_trades`
- Default window size: 120 eligible trades
- Bounds: 20 to 500 eligible trades
- Eligibility source: original-plan-eligible trades only (no overlay filters)

## Aggregation Metrics
Per TP mode:
- tradeCount
- winCount
- lossCount
- breakevenCount
- openCount
- winRatePct
- profitFactor
- expectancyTicks
- avgWinTicks
- avgLossTicks
- avgMfeTicks
- avgMaeTicks
- maxConsecLosses
- maxDrawdownDollars
- scoreRecent

Segmentations:
- weekday
- timeBucket
- regime (optional, if available)

## Ranking Logic
- `bestTpModeByWinRate`:
  - highest WR
  - tie-break by trade count
  - then PF
- `bestTpModeByProfitFactor`:
  - highest PF
  - tie-break by WR
  - then trade count
- `bestTpModeRecent`:
  - PF-first
  - WR-second
  - minimum sample guard (15 trades/mode)

## Practical Recommendation Logic
Output fields:
- `recommendedTpMode`
- `recommendedTpModeReason`
- `recommendationBasis`

Recommendation prioritizes:
1. strong PF
2. strong WR
3. sample quality
4. thin-sample safeguards

If sample quality is weak, recommendation is conservative and explicitly warns that results are advisory.

## Output Contract
`mechanicsResearchSummary` includes:
- baseline mechanics (`originalPlanTpMode`, `originalPlanStopMode`)
- mode leaders (`bestTpModeRecent`, `bestTpModeByWinRate`, `bestTpModeByProfitFactor`)
- practical recommendation
- variant table and segmentations
- data quality and warnings
- `advisoryOnly: true`

## Future Extension Points
- Additional stop families once they are formally implemented and validated.
- Regime-first and hybrid weighting models.
- Rolling performance decay detection by TP mode.
- Combined TP/SL family comparison matrix once supported.
