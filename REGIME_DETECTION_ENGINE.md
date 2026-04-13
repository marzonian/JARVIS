# Regime Detection Engine

## Purpose
The Regime Detection Engine provides a bounded, explainable market-context label that Jarvis can reuse across command-center synthesis and advisory research. It is a context input layer only.

## Supported Regime States
The engine only emits these labels:
- `trending`
- `ranging`
- `wide_volatile`
- `compressed`
- `mixed`
- `unknown`

## Input Signals
The engine reuses existing session/regime snapshots rather than introducing heavy recomputation:
- `regime_trend` (`trending`, `ranging`, `choppy`, `flat`)
- `regime_vol` (`low`, `normal`, `high`, `extreme`)
- `regime_orb_size` (`narrow`, `normal`, `wide`)
- session/ORB range ticks from `metrics`
- first 15-minute continuation profile
- session type profile
- optional command-center phase context

## Confidence Rules
The engine emits:
- `confidenceScore` (0-100)
- `confidenceLabel` (`low` | `medium` | `high`)

Confidence is higher when trend/volatility/ORB signals align, and lower when signals conflict. Weak or contradictory evidence degrades to `mixed` or `unknown`.

## Thin-Signal and Mixed Handling
- If signal strength is low or contradictory, label is `mixed`.
- If regime data is unavailable, label is `unknown`.
- Confidence is explicitly reduced under both cases.

## Output Contract
`regimeDetection`:
- `regimeLabel`
- `confidenceLabel`
- `confidenceScore`
- `regimeReason`
- `evidenceSignals` (compact summary)
- `advisoryOnly`

## Regime Integrity Rules
- Regime detection is advisory only.
- Regime labels must be bounded to the supported set.
- The engine must not overclaim certainty.
- When evidence is weak, emit `mixed` or `unknown` instead of forcing a specific label.
- Regime labels are context inputs, not strategy decisions.

## Truth-Model Guarantees
- Regime detection does **not** mutate the original trading plan.
- Regime detection does **not** auto-switch strategies.
- Regime detection does **not** alter execution behavior.
- Regime detection informs advisory layers only (command center, decision board, research context).
