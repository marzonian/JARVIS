# Regime Confirmation History Backfill

## Purpose
Bootstrap the persisted regime confirmation ledger with historically reconstructable advisory snapshots so Jarvis can move beyond single-day persistence coverage.

This layer is strictly advisory and provenance-aware. It reconstructs historical rows from real date-stamped evidence already present in Jarvis and does not fabricate live streaks.

## Inputs
- `recommendationPerformance.scorecards`
- `regimeByDate` (for canonical per-date regime normalization when scorecards do not include a regime label)
- Existing `jarvis_regime_confirmation_history` table rows
- Canonical regime labels: `trending`, `ranging`, `wide_volatile`, `compressed`, `mixed`, `unknown`

No new replay/backtest/discovery/tracking recomputation is introduced.

## Backfill Method
1. Select bounded candidate dates from historical scorecards (configurable by `startDate`, `endDate`, `maxDays`, and `windowSessions`).
2. For each candidate date, build a conservative reconstructed snapshot using only scorecards known up to that date.
3. Derive canonical regime-conditioned fields (promotion/trust/usefulness proxies) only when safely reconstructable.
4. Upsert one row per canonical regime label for that date/window/source into the history ledger.
5. Skip dates that do not meet minimum reconstruction integrity (no hidden interpolation across missing dates).

## Provenance Rules
Every persisted row carries explicit provenance metadata:
- `persistence_provenance`: `live_captured` | `reconstructed_from_historical_sources` | `mixed`
- `reconstruction_confidence`: `high` | `medium` | `low`
- `reconstruction_warnings`: serialized warning list

Rules:
- Runtime-captured snapshots remain `live_captured`.
- Historical bootstrap rows are always `reconstructed_from_historical_sources`.
- Rows combining both sources become `mixed`.
- Reconstructed rows are never mislabeled as `live_captured`.

## Supported Outputs
- `GET /api/jarvis/regime/history/backfill` summary:
  - `attemptedDays`
  - `reconstructedDays`
  - `skippedDays`
  - `insertedRows`
  - `updatedRows`
  - `warnings`
  - `advisoryOnly: true`

- `regimeConfirmationHistory` and `regimeConfirmationDurability` include provenance-aware fields:
  - history provenance breakdowns
  - persistence source labels that distinguish live vs reconstructed persistence

## Thin-History Handling
- Dates with insufficient reconstructable evidence are skipped.
- Missing fields remain null/conservative rather than fabricated.
- Reconstructed-only histories remain conservative in durability interpretation.

## Advisory-Only Constraints
- No execution mutation
- No baseline rewrite
- No TP default changes
- No strategy auto-promotion or auto-switching

Backfill affects advisory analytics persistence only.

## Anti-Overfitting Safeguards
- No synthetic interpolation for missing dates
- No fabricated live streaks
- No unsupported regime labels
- Reconstructed-only persistence cannot silently claim live-equivalent confidence
- Durability remains conservative when provenance is reconstructed-heavy or thin

## Durability Integration Rules
`regimeConfirmationDurability.persistenceSource` is provenance-aware:
- `persisted_live_history`
- `persisted_reconstructed_history`
- `mixed_persisted_history`
- `proxy_only`

Durability consumes persisted history streak fields when available, but reconstructed-only persistence is treated more conservatively than live-captured persistence.
