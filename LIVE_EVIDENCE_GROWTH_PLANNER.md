# LIVE EVIDENCE GROWTH PLANNER

## Purpose
`liveEvidenceGrowthPlanner` is a bounded advisory planner that turns live-evidence status into an explicit graduation map.

It answers:
- what evidence tier Jarvis is in now,
- what next tier is targeted,
- what exact requirements are satisfied vs missing,
- whether progress is blocked, distant, plausible, or near,
- what the shortest path actions are to move up one tier.

This layer does not change execution behavior.

## Inputs
The planner composes from existing foundation/evidence outputs and lightweight DB facts:
- `liveEvidenceAccumulation`
- `dataCoverage`
- `topstepIntegrationAudit`
- `databentoIngestionStatus`
- `dailyEvidenceScoringStatus`
- `regimePerformanceFeedback`
- `regimePersistenceTrustOverride`
- `regimePersistenceTrustOverrideDelta`
- `regimeLivePersistenceQuality`
- `jarvis_scored_trade_outcomes` (live distinct dates / streak proxy)
- `jarvis_daily_scoring_runs` (stability check)
- `jarvis_live_session_data` (Topstep window depth proxy)

No replay/backtest/discovery recomputation is introduced.

## Tier Model
Bounded tier enum:
- `not_ready`
- `early_live_build`
- `limited_use`
- `intelligence_candidate`
- `intelligence_ready`

Conservative tier intent:
- `not_ready`: live evidence too small, too backfill-dominant, or key controls still weak.
- `early_live_build`: live base exists and infra is mostly healthy, but depth/share/streak still thin.
- `limited_use`: meaningful live evidence with bounded confidence; still not elite.
- `intelligence_candidate`: substantial live depth/share/provenance with reduced suppression pressure.
- `intelligence_ready`: very high bar; requires strong live-dominant depth and stable controls.

## Bounded Enums
### Reachability
- `blocked`
- `distant`
- `plausible`
- `near`

### Distance
- `far`
- `medium`
- `close`

### Time-to-next-tier label
- `unknown`
- `gt_20_days`
- `days_10_20`
- `days_5_10`
- `lt_5_days`

### Requirement / blocker / action pool
- `raise_live_outcomes`
- `raise_live_pct`
- `extend_live_streak`
- `improve_regime_provenance`
- `lift_persistence_from_suppressed`
- `reduce_backfill_dominance`
- `clear_databento_recent_gap`
- `extend_topstep_live_window`
- `maintain_daily_scoring_consistency`
- `maintain_databento_foundation`
- `maintain_topstep_health`
- `improve_live_growth_rate`

### Progress signals
- `live_count_rising`
- `live_pct_rising`
- `daily_scoring_stable`
- `databento_live`
- `topstep_healthy`
- `persistence_improving`
- `regime_provenance_improving`

### Stalled signals
- `live_count_flat`
- `live_pct_flat`
- `persistence_still_suppressed`
- `regime_provenance_thin`
- `databento_recent_gap_present`
- `topstep_window_thin`
- `backfill_still_dominant`

## Guardrails
- Advisory-only output (`advisoryOnly: true`).
- No execution mutation.
- No TP/strategy/routing changes.
- No secret exposure.
- No fake optimism:
  - mixed/backfill-heavy evidence cannot be treated as elite readiness,
  - `intelligence_ready` requires strict live-dominant conditions,
  - blocked infrastructure or suppressed persistence keeps reachability conservative.
- Truth-calibration caps:
  - if `currentEvidenceTier = not_ready` and `liveEvidenceCount < 5`, progress is hard-capped low,
  - if `liveEvidencePct < 15`, progress is strongly capped,
  - if `raise_live_outcomes` / `raise_live_pct` remain hard blockers, progress is aggressively capped,
  - persistence suppression, thin provenance, Topstep thin-window, and Databento recent-gap states add deterministic caps.

## Outputs
Top-level `liveEvidenceGrowthPlanner` includes:
- tier state (`currentEvidenceTier`, `nextTargetTier`)
- reachability and progress (`targetReachabilityLabel`, `readinessProgressPct`)
- evidence counts and live-share breakdown
- core dependency states (regime provenance, persistence policy/label, Topstep health, Databento status)
- requirement map (`requirementsSatisfied`, `requirementsRemaining`)
- blocker/support sets (`hardBlockers`, `softBlockers`, `growthSupports`)
- planning path (`shortestPathActions`, `progressSignals`, `stalledSignals`)
- conservative distance/time labels (`estimatedTierDistance`, `estimatedDaysToNextTierLabel`)
- concise blunt narrative (`plannerInsight`)

## How This Differs From liveEvidenceAccumulation
`liveEvidenceAccumulation` reports evidence truth now (counts, ratios, growth labels, module quality).

`liveEvidenceGrowthPlanner` adds graduation planning semantics:
- next target tier,
- exact remaining requirements,
- shortest bounded path actions,
- conservative reachability and distance-to-next-tier labels.

## Why Advisory-Only
This planner is an evidence governance layer, not a trading policy layer.
It cannot and does not alter execution or strategy behavior.
It exists so future intelligence promotion is explicit, auditable, and evidence-gated.
