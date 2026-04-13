# Jarvis Data Foundation Layer

## Purpose
This layer provides production-style evidence plumbing so Jarvis can continuously ingest, persist, audit, and score real data without mutating execution behavior.

## Scope
- Databento historical ingestion (full backfill, incremental append, gap recovery, resume from last success).
- Topstep integration health audit (credential presence, auth state, live feed health, latest success/error).
- Canonical persistence separation:
  - raw bars (`jarvis_market_bars_raw`)
  - live session snapshots (`jarvis_live_session_data`)
  - derived features (`jarvis_derived_features`)
  - scored outcomes (`jarvis_scored_trade_outcomes`)
- Automatic daily recommendation outcome scoring with persisted run history.
- Data coverage visibility for symbols/date coverage/missing ranges/live feed/evidence sufficiency.

## Safety / Constraints
- Advisory and infrastructure only.
- No order placement changes.
- No strategy/TP execution mutation.
- No baseline or regime logic rewrite.
- No hidden replay/backtest/discovery/tracking recomputation.
- Reconstructed or missing data is always surfaced as explicit warnings.

## Endpoints
- `GET /api/jarvis/databento/ingestion` (status + optional run with `force=1`)
- `POST /api/jarvis/databento/ingestion/run`
- `GET /api/topstep/live/audit`
- `GET /api/jarvis/evidence/daily-scoring` (status + optional run with `force=1`)
- `POST /api/jarvis/evidence/daily-scoring/run`
- `GET /api/jarvis/data/coverage`

## Command Center Additions
- `dataCoverage` (top-level coverage object)
- `commandCenter.dataCoverageInsight`
- `commandCenter.dataCoverageStatus`
- `commandCenter.dataMissingRanges`
- `commandCenter.liveFeedStatus`
- `commandCenter.evidenceReadiness`
