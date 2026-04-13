# Trading Mechanics Variant Engine

## Purpose
The Trading Mechanics Variant Engine evaluates the same replayed trade under multiple target/stop mechanics so Jarvis can compare trade management outcomes without changing the underlying strategy entry logic.

This layer is additive. It does **not** replace:
- market outcome
- original trading plan outcome
- learned overlay outcome

## Inputs
The engine accepts:
- `candles`: session 5-minute bars
- `entry`: `{ entryTime, entryPrice, direction }`
- `variantSet`: TP/SL mechanics variants to test
- `sourceMeta`: replay date/source context

## Variant Dimensions
### Supported in this pass
- **TP mode**
  - `Nearest`
  - `Skip 1`
  - `Skip 2` (original plan default)
- **Stop mode**
  - `rr_1_to_1_from_tp` (SL distance equals TP distance)

### Future extension points (not fully implemented in this pass)
- `structure_stop`
- `orb_opposite_stop`
- `fixed_tick_stop`

## Output Schema
Per variant:
- `tpMode`
- `stopMode`
- `entryPx`
- `tpPx`
- `slPx`
- `hitOrder`
- `outcome` (`win|loss|breakeven|open|unknown|no_trade`)
- `mfe`
- `mae`
- `barsToResolution`
- `warnings`

Aggregate:
- `mechanicsVariants[]`
- `originalPlanMechanicsVariant`
- `bestMechanicsVariant`
- `mechanicsComparisonSummary`

## Safe Assumptions
- Candle-path resolution reuses existing ORB engine resolution logic (`resolveTrade`) to avoid drift.
- No forced mechanics simulation is treated as official if original plan is not eligible.
- If original plan did not produce a valid entry, mechanics comparison is marked unavailable and explicitly labeled as non-official.

## Current Supported Mechanics Families
- Psych-level TP variants with 1:1 stop distance from TP
- Same entry point/direction as replayed original-plan trade

## Future Research Integration
The engine emits stable fields for strategy research aggregation:
- TP mode effectiveness tracking
- per-variant outcome and excursion fields
- summary contract suitable for rolling win-rate/PF/expectancy comparisons by TP mode
