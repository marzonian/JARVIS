## Purpose
The Live-Captured Regime Persistence Recorder ensures Jarvis writes genuine same-day runtime regime persistence snapshots as `live_captured`, so persistence can accumulate from real live advisory runs over time.

This layer exists to separate true runtime persistence from historical reconstruction and to make provenance promotion explicit and auditable.

## Inputs
This recorder consumes already-built advisory outputs from the canonical runtime snapshot path:
- `liveRegimeConfirmation`
- `regimeTrustConsumption`
- `regimeEvidenceSplit`
- `regimePerformanceFeedback`
- current snapshot date (`nowEt` / runtime date)

It does not run replay/backtest/discovery/tracking recomputation.

## Live Capture Rules
- A row is eligible for live capture only when written from the current runtime snapshot date.
- Live recording is idempotent for `(snapshot_date, window_sessions, performance_source, regime_label)`.
- Repeated same-day calls update safely without duplicating rows.
- Live capture writes use explicit `persistenceProvenance=live_captured` and `liveCaptureWrite=true`.

## Provenance Promotion Policy
- New historical reconstruction rows remain `reconstructed_from_historical_sources`.
- New runtime live rows are written as `live_captured`.
- Existing reconstructed rows can be promoted by true same-day live capture via explicit merge policy.
- Existing `live_captured` rows are never downgraded to reconstructed.
- `mixed` remains available when both provenance paths are represented.

Additional row-level live metadata is tracked:
- `first_live_captured_at`
- `last_live_captured_at`
- `live_capture_count`

## Supported Outputs
The recorder returns a bounded summary:
- `currentSnapshotDate`
- `liveRowsInserted`
- `liveRowsUpdated`
- `promotedToMixed`
- `promotedToLiveCaptured`
- `skippedRows`
- `warnings`
- `advisoryOnly: true`

## Thin-Live-History Handling
- Sparse live capture remains explicitly visible.
- Thin live history does not imply strong durability.
- Summary fields in history/durability continue to surface when live-captured tenure is low or absent.

## Advisory-Only Constraints
- Advisory-only composition layer.
- No execution mutation.
- No baseline rewrite.
- No strategy/TP auto-switching.
- No auto-promotion into production behavior.

## Anti-Overfitting Safeguards
- No fabricated live rows.
- No inferred filling of missing live dates.
- No retroactive relabeling as live without true same-day runtime capture.
- Reconstructed history is never silently treated as equivalent to live-captured persistence.

## Durability Integration Rules
- Durability continues to consume persisted history conservatively.
- Persistence source remains explicit (`persisted_live_history`, `persisted_reconstructed_history`, `mixed_persisted_history`, `proxy_only`).
- Live-captured tenure fields are exposed so command-center messaging can distinguish reconstructed support from genuine live persistence.
