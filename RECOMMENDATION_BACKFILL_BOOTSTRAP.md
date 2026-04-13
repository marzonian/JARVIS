# Recommendation Backfill & Calibration Bootstrap

## Purpose
Jarvis recommendation scoring needs statistically useful sample depth. This backfill pass reconstructs historical `todayRecommendation` records and scores them against realized outcomes to bootstrap calibration metrics.

This is retrospective analytics only. It does not modify execution behavior, trading settings, or the original trading plan.

## What Is Being Reconstructed
For each historical session date, Jarvis reconstructs a recommendation snapshot at a fixed phase:
- `reconstructionPhase: pre_orb_recommendation`

The reconstruction persists:
- recommendation context payload
- strategy/mechanics context used to form recommendation
- scored outcome payload against realized trade/strategy/mechanics outcomes

## What Is Not Safely Reconstructable
Some live intraday signals are not available in a leak-safe historical pre-ORB reconstruction:
- same-day ORB completion and ORB outcome
- same-day post-ORB momentum behavior
- same-day final trade outcome as an input signal
- same-day intraday health state that depended on future bars

When unavailable, Jarvis marks them unavailable and degrades confidence.

## Historical Reconstruction Integrity Rules
### Pre-session (before market open)
Allowed:
- historical sessions up to prior date
- rolling strategy/mechanics research from prior-known data
- prior-known regime history
- known phase metadata (`pre_open`, date, ET clock)

Not allowed:
- any same-day post-open candles
- same-day outcome labels

### Pre-ORB (current implemented phase)
Allowed:
- all pre-session allowed signals
- scheduled context available before ORB start

Not allowed:
- ORB range/outcome for current date
- breakout/retest/confirmation outcome for current date
- same-day realized PnL as recommendation input

### During ORB (future extension)
Allowed (future):
- only candles printed up to current ORB minute

Not allowed:
- post-ORB price path
- same-day final result

### After session ends
Allowed for scoring (not recommendation generation):
- actual trade outcomes
- strategy/mechanics realized comparisons

## No-Future-Leakage Rules
1. Recommendation context for date `D` is generated using only sessions `< D`.
2. Same-day outcomes are never used as recommendation inputs.
3. If a signal cannot be reconstructed leak-safely, it is omitted and tracked in `unavailableSignals`.
4. Backfill rows include integrity metadata:
- `noFutureLeakage: true`
- `knowledgeCutoffDate`
- `usedSessionRange`

## Source Labels
Backfilled and live rows are explicitly separated:
- `sourceType: live | backfill`
- `reconstructionPhase`
- `reconstructionVersion`
- `scoreVersion` (outcome scoring engine version)
- durable provenance timestamps: `createdAt`, `updatedAt`, `generatedAt`

Backfill rows are never presented as live-origin recommendations.

## Backfill Accounting Contract
`POST /api/jarvis/recommendation/backfill` reports auditable counters:
- `processed`
- `inserted`
- `updated`
- `reusedExisting`
- `alreadyPresent`
- `skipped` (true skip cases only)
- `scored`
- `failed`

Idempotence is explicit:
- `idempotentReuse: true` when existing rows were reused with no insert/update/rescore.

## Confidence Degradation Rules
Confidence is reduced when reconstruction fidelity is constrained:
- limited prior sample window
- thin mechanics sample
- missing phase-specific intraday features

Confidence label and score are degraded and annotated with reconstruction warnings.

## Calibration Goals
Backfill enables stable rolling metrics:
- posture accuracy
- strategy recommendation accuracy
- TP recommendation accuracy
- recommendation delta trend

Outputs must remain transparent about:
- source type breakdown (live vs backfill)
- reconstruction phase
- sample quality warnings
- calibration warnings
