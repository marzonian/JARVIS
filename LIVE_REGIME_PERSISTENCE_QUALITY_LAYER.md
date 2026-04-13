## Purpose
The Live Regime Persistence Quality layer measures whether live-captured regime history is accumulating reliably enough to support durability interpretation over time.

This layer is advisory-only. It does not change execution behavior, strategy selection, TP behavior, or regime labeling.

## Inputs
This layer composes existing summaries only:
- `regimeConfirmationHistory`
- `regimeConfirmationDurability`
- `liveRegimeConfirmation`
- `regimeTrustConsumption`
- `recommendationPerformance.summary.sourceBreakdown` (context only)
- current runtime snapshot date when available

No replay, discovery, backtest, or hidden recomputation is introduced.

## Cadence Labels
`currentRegimeLiveCadenceLabel` is bounded to:
- `healthy`
- `improving`
- `sparse`
- `stale`

Guidance:
- `healthy`: live capture exists, gap is very small, and live coverage is strong.
- `improving`: live capture exists and is building, but not yet healthy.
- `sparse`: some live capture exists but cadence remains weak.
- `stale`: no live capture for the current regime or capture gap is materially large.

## Persistence Quality Labels
`currentRegimePersistenceQualityLabel` is bounded to:
- `live_ready`
- `partially_live_supported`
- `mostly_reconstructed`
- `insufficient_live_depth`

Guidance:
- `live_ready`: persisted live history is present with meaningful current-regime live tenure.
- `partially_live_supported`: mixed persisted history with real live support.
- `mostly_reconstructed`: reconstructed history still dominates persisted coverage.
- `insufficient_live_depth`: live depth is too thin to support stronger persistence claims.

## Supported Outputs
`regimeLivePersistenceQuality` includes:
- `currentRegimeLabel`
- `recentWindowDays`
- `liveCapturedDays`
- `reconstructedDays`
- `mixedDays`
- `missingExpectedLiveDays`
- `liveCaptureCoveragePct`
- `currentRegimeHasLiveCapturedHistory`
- `currentRegimeLiveCapturedTenureDays`
- `currentRegimeLastLiveCapturedDate`
- `currentRegimeCaptureGapDays`
- `currentRegimeLiveTenureSharePct`
- `currentRegimeLiveCadenceLabel`
- `currentRegimePersistenceQualityLabel`
- `currentRegimeDurabilityConstraint`
- `persistenceQualityInsight`
- `warnings`
- `advisoryOnly: true`

## Thin-Live-History Handling
When live history is thin:
- outputs stay conservative,
- cadence remains `sparse` or `stale`,
- persistence quality remains `mostly_reconstructed` or `insufficient_live_depth`,
- durability interpretation remains conservative.

`missingExpectedLiveDays` is an intentionally conservative estimate based on persisted day coverage only. It does not assume full market-calendar completeness.

## Advisory-Only Constraints
- No execution mutation.
- No baseline strategy rewrite.
- No TP auto-switching.
- No auto-promotion from persistence-quality labels.
- No hidden confidence inflation from sparse live capture.

## Anti-Overfitting Safeguards
- Never fabricate live-captured days.
- Never infer live capture unless ledger provenance marks it.
- Keep all labels bounded and explainable.
- Treat reconstructed persistence as distinct from live persistence.
- Keep weak live cadence explicitly visible.

## Durability Constraint Rules
`currentRegimeDurabilityConstraint` is bounded to:
- `capture_cadence_limited`
- `live_depth_limited`
- `regime_quality_limited`
- `mixed_constraints`

It explains why durability remains weak:
- cadence gaps,
- limited live depth,
- weak regime quality despite live capture,
- or multiple constraints at once.
