## Purpose
The Regime Confirmation History Ledger persists real regime-confirmation snapshots so Jarvis can measure actual confirmation persistence over time instead of relying only on bounded proxy streak indicators.

## Inputs
- `liveRegimeConfirmation`
- `regimeTrustConsumption`
- `regimeEvidenceSplit`
- `regimePerformanceFeedback`
- `recommendationPerformance.scorecards`
- `recommendationPerformance.summary`
- Optional `regimeByDate` only for canonical alignment when needed

## Persistence Method
1. Ensure durable history table exists.
2. On each snapshot cycle, upsert one row per canonical regime for `(snapshot_date, window_sessions, performance_source, regime_label)`.
3. Persist only already-computed summary fields (no replay/backtest/discovery recomputation).
4. Build summary windows from stored rows for requested source/window.

## Supported Outputs
Top-level `regimeConfirmationHistory`:
- `generatedAt`
- `windowSessions`
- `performanceSource`
- `currentRegimeLabel`
- `historyCoverageDays`
- `currentRegimeTenureDays`
- `currentRegimeConsecutiveQualifiedWindows`
- `currentRegimeConsecutiveWeakWindows`
- `currentRegimeRecoveryCount`
- `currentRegimeLastStateTransition`
- `currentRegimeHasRealPersistenceHistory`
- `byRegime[]`
- `advisoryOnly: true`

Per-regime `byRegime[]` includes:
- `regimeLabel`
- `totalSnapshots`
- `firstSeenAt`
- `lastSeenAt`
- `latestPromotionState`
- `latestPromotionReason`
- `consecutiveQualifiedWindows`
- `consecutiveWeakWindows`
- `recoveryCount`
- `decayCount`
- `liveConfirmedTenureDays`
- `latestStateTransition`
- `hasRealPersistenceHistory`
- `warnings[]`
- `advisoryOnly: true`

## Thin-History Handling
- No synthetic backfill of fake streaks.
- `hasRealPersistenceHistory` remains false for insufficient snapshots.
- Thin history emits warnings and keeps downstream durability conservative.

## Advisory-Only Constraints
- Advisory analytics only.
- No execution mutation.
- No baseline rewrite.
- No strategy/TP auto-switching.
- No auto-promotion behavior changes.

## Anti-Overfitting Safeguards
- Canonical labels only.
- Weak/sparse history cannot produce strong persistence claims.
- Mixed/unknown regimes remain conservative unless stronger live evidence exists.
- Persisted history informs messaging/calibration only; it does not alter trade execution.

## State Transition Rules
Qualified window:
- `promotion_state` in `{live_confirmed, near_live_confirmation, emerging_live_support}`
- and not explicitly suppressed by missing live evidence.

Weak window:
- `promotion_state == no_live_support`
- or `trust_consumption_label == suppress_regime_bias`
- or live-only usefulness is insufficient with low live sample.

Recovery transition:
- weak -> qualified.

Decay transition:
- qualified -> weak.

`liveConfirmedTenureDays`:
- latest sustained streak length in `live_confirmed` state.

## Durability Integration Rules
- Durability now consumes persisted history streak fields when available:
  - `consecutiveQualifiedWindows`
  - `consecutiveWeakWindows`
  - `liveConfirmedTenureDays`
  - `recoveryCount`
  - `decayCount`
  - `latestStateTransition`
- If persisted history is unavailable/thin, durability falls back to proxy behavior and labels:
  - `persistenceSource: proxy_only`
  - `historyWarnings` explaining limited real history.

This pass converts persistence from proxy-only approximation toward true historical streak tracking while preserving existing advisory and truth-model boundaries.
