# Jarvis System Architecture Map

## 0) Analysis Plan Used (Phase 1)
Before writing this map, the repository was analyzed in this order:
1. Entry points and API surface in `server/index.js`.
2. Voice orchestration path (`/api/jarvis/query` -> orchestrator -> tools -> finalize -> trace).
3. Command-center snapshot composition path (`buildStrategyLayerSnapshotPayload` and cached wrappers).
4. Core engine modules in `server/engine` for strategy mechanics and metrics.
5. Research/governance/recommendation modules in `server/jarvis-core`.
6. Persistent state tables in `server/db/schema.sql` and runtime-created recommendation tables.
7. Test coverage in `tests/test-jarvis-*` suites.

---

## 1) System Overview
Jarvis is a trading research + advisory runtime. It combines:
- deterministic strategy computation,
- research engines (mechanics, discovery, tracking),
- governance/advisory synthesis,
- voice orchestration with consent/pending safety,
- traceable APIs for diagnostics.

Primary runtime responsibilities:
- answer voice requests through `/api/jarvis/query`,
- maintain truth-model boundaries (original plan vs variants vs alternatives vs advisory),
- build command-center intelligence snapshots,
- persist recommendation context/outcome history for scoring/calibration.

---

## 2) Architecture Layers

### Layer A: Data Layer
- Purpose: Store canonical session/bars/trade data + Jarvis durable state.
- Modules:
  - `server/db/database.js`
  - `server/db/schema.sql`
  - `server/jarvis-core/durable-state.js`
  - `server/jarvis-core/location-store.js`
  - `server/jarvis-core/recommendation-outcome.js` (creates recommendation context/outcome tables)
- Responsibilities:
  - `sessions`, `candles`, `trades` baseline market/trade storage.
  - `jarvis_state_kv` TTL/persistent state for pending/consent/preferences/voice continuity.
  - complaint/research/recommendation provenance storage.
- Compute profile: storage and retrieval (not compute-heavy).

### Layer B: Analysis Engines
- Purpose: Deterministic strategy mechanics and stats.
- Modules:
  - `server/engine/orb.js` (`processSession` source-of-truth ORB path)
  - `server/engine/psych-levels.js` (TP/SL level math)
  - `server/engine/stats.js` (`calcMetrics`, `calcDrawdown`)
  - `server/engine/backtest.js`
  - `server/engine/regime.js`
- Responsibilities:
  - generate per-session outcomes,
  - compute PnL/streak/drawdown metrics,
  - provide primitives reused by replay/research/governance.
- Compute profile: medium-heavy when run over many sessions.

### Layer C: Research Engines
- Purpose: Evaluate alternatives/mechanics over bounded historical windows.
- Modules:
  - `server/tools/replayTool.js`
  - `server/tools/tradeMechanicsVariantTool.js`
  - `server/jarvis-core/mechanics-research.js`
  - `server/jarvis-core/contextual-mechanics.js`
  - `server/jarvis-core/strategy-discovery.js`
  - `server/jarvis-core/strategy-tracking.js`
- Responsibilities:
  - replay per-day trade truth,
  - TP mechanics matrix (`Nearest`, `Skip 1`, `Skip 2` with current stop family),
  - rolling mechanics aggregation,
  - contextual mechanics recommendation,
  - bounded discovery candidate evaluation,
  - side-by-side strategy tracking across windows.
- Compute profile: heavy if uncached; bounded by window params + cache.

### Layer D: Governance Engines
- Purpose: Convert research outputs into advisory status lanes.
- Modules:
  - `server/jarvis-core/strategy-portfolio.js`
  - `server/jarvis-core/strategy-experiments.js`
- Responsibilities:
  - portfolio state assignment (`baseline`, `active_candidate`, `watchlist`, etc.),
  - shadow lifecycle labels (`shadow_trial`, `shadow_promising`, `shadow_stable`, etc.),
  - promotion/demotion readiness (advisory only).
- Compute profile: synthesis on top of tracking/discovery outputs.

### Layer E: Recommendation Engine
- Purpose: Build daily advisory posture and score historical correctness.
- Modules:
  - `server/jarvis-core/today-recommendation.js`
  - `server/jarvis-core/recommendation-outcome.js`
  - `server/jarvis-core/recommendation-backfill.js`
  - `server/jarvis-core/confidence-calibration.js`
- Responsibilities:
  - synthesize posture (`trade_normally`, `trade_selectively`, `wait_for_news`, `stand_down`),
  - score recommendation correctness against outcomes,
  - backfill retrospective recommendation rows with provenance,
  - calibrate confidence from historical bucketed evidence.
- Compute profile: medium-heavy for backfill/performance windows.

### Layer F: Decision Synthesis Layer
- Purpose: Consolidate high-value decision signal with minimal redundancy.
- Modules:
  - `server/jarvis-core/decision-board.js`
  - `server/jarvis-core/strategy-layers.js` (`buildCommandCenterPanels`)
- Responsibilities:
  - produce concise decision board fields,
  - dedupe and prioritize synthesis lines,
  - keep advisory layers separated in presentation.
- Compute profile: synthesis-only (depends on upstream snapshots).

### Layer G: Command Center Layer
- Purpose: Return consolidated runtime object for UI consumption.
- Modules:
  - `server/index.js` (`buildStrategyLayerSnapshotPayload`, `buildStrategyLayerSnapshotCached`, `/api/jarvis/command-center`)
- Responsibilities:
  - orchestrate full snapshot build in deterministic order,
  - attach recommendation performance + confidence calibration,
  - expose command-center object with sub-summaries.
- Compute profile: orchestrator + cache coordinator; expensive path if forced fresh.

### Layer H: Voice Orchestration + API Layer
- Purpose: Natural language routing, consent/pending safety, tool execution, final gate, trace.
- Modules:
  - `server/index.js` (`/api/jarvis/query`, `/api/jarvis/diag/latest`, endpoint guard)
  - `server/jarvis-orchestrator.js`
  - `server/jarvis-core/executive.js`
  - `server/jarvis-core/intent.js`
  - `server/jarvis-core/pending-engine.js`
  - `server/jarvis-core/consent.js`
  - `server/jarvis-core/skill-registry.js`
  - `server/jarvis-core/finalize.js`
  - `server/jarvis-core/trace.js`
  - `server/jarvis-core/voice-session.js`
  - tools: `riskTool.js`, `healthTool.js`, `analystTool.js`, `webTool.js`, `replayTool.js`
- Responsibilities:
  - enforce voice entrypoint,
  - classify + plan skill execution,
  - enforce consent/confirm/pending topic-shift guard,
  - run tools with receipts,
  - apply content firewall + final invariants,
  - persist trace diagnostics.
- Compute profile: low-medium per request, with optional tool-heavy branches.

### Layer I: Testing Infrastructure
- Purpose: verify routing, invariants, failure modes, and advisory contracts.
- Modules:
  - `tests/test-jarvis-*.js` suites
  - examples: `test-jarvis-voice-real-e2e.js`, `test-jarvis-e2e-integrity.js`, `test-jarvis-failure-injection.js`, `test-jarvis-intent-fuzz.js`, `test-jarvis-strategy-*.js`
- Responsibilities:
  - regression protection,
  - schema/trace parity,
  - safety/fail-closed verification,
  - matrix/fuzz coverage for intent/local-search paths.

---

## 3) Core Module Map

| Area | Primary Modules |
|---|---|
| Runtime entrypoints | `server/index.js` |
| Voice router | `server/jarvis-orchestrator.js`, `server/jarvis-core/executive.js`, `server/jarvis-core/intent.js`, `server/jarvis-core/router.js` |
| Skill contracts | `server/jarvis-core/skill-registry.js` |
| Consent + pending | `server/jarvis-core/consent.js`, `server/jarvis-core/pending-engine.js` |
| Durable state | `server/jarvis-core/durable-state.js`, `server/jarvis-core/location-store.js`, `server/jarvis-core/voice-session.js` |
| Trading mechanics | `server/engine/orb.js`, `server/engine/psych-levels.js`, `server/tools/replayTool.js`, `server/tools/tradeMechanicsVariantTool.js` |
| Performance stats | `server/engine/stats.js`, `server/jarvis-core/recommendation-outcome.js` |
| Strategy layers | `server/jarvis-core/strategy-layers.js` |
| Research engines | `server/jarvis-core/mechanics-research.js`, `server/jarvis-core/contextual-mechanics.js`, `server/jarvis-core/strategy-discovery.js`, `server/jarvis-core/strategy-tracking.js` |
| Governance engines | `server/jarvis-core/strategy-portfolio.js`, `server/jarvis-core/strategy-experiments.js` |
| Recommendation engines | `server/jarvis-core/today-recommendation.js`, `server/jarvis-core/confidence-calibration.js`, `server/jarvis-core/recommendation-backfill.js` |
| Decision synthesis | `server/jarvis-core/decision-board.js`, `server/jarvis-core/finalize.js` |
| Diagnostics | `server/jarvis-core/trace.js`, `/api/jarvis/diag/latest` |

---

## 4) Data Flow

### A) Voice request flow (`/api/jarvis/query`)
1. Ingress in `server/index.js` creates trace/session context.
2. Voice session state touched (`voice-session.js`) and metadata attached.
3. `runJarvisOrchestrator` executes:
   - intent analysis,
   - executive planning,
   - pending/consent resolution,
   - tool routing/execution.
4. Response passes through:
   - content firewall,
   - earbud/final gate invariants,
   - reply normalization.
5. Trace row persisted and served by `/api/jarvis/diag/latest`.

### B) Command center flow (`/api/jarvis/command-center`)
1. `buildStrategyLayerSnapshotCached` resolves cache key and in-flight lock.
2. `buildStrategyLayerSnapshotPayload` builds in order:
   - sessions + regime load,
   - tracking,
   - discovery,
   - mechanics research,
   - strategy layers,
   - portfolio,
   - experiments,
   - command-center panels,
   - recommendation context persistence,
   - recommendation performance + confidence calibration.
3. API returns `commandCenter` plus linked summaries.

### C) Recommendation scoring/backfill flow
1. Recommendation context upserted (`recommendation-outcome.js`).
2. Optional backfill (`recommendation-backfill.js`) reconstructs historical context with provenance labels.
3. Performance endpoint summarizes row windows + provenance accounting.
4. Confidence calibration consumes scorecards and adjusts only confidence messaging.

---

## 5) Source-of-Truth Modules

Authoritative modules (do not duplicate logic elsewhere):
- Strategy eligibility/mechanics baseline: `server/engine/orb.js` (`processSession`).
- TP/SL conversions and tick-dollar math: `server/engine/psych-levels.js`.
- Metric and drawdown math: `server/engine/stats.js`.
- Replay truth payload + narrative: `server/tools/replayTool.js`.
- Mechanics variant simulation matrix: `server/tools/tradeMechanicsVariantTool.js`.
- Rolling mechanics aggregation contract: `server/jarvis-core/mechanics-research.js`.
- Strategy stack and recommendation basis: `server/jarvis-core/strategy-layers.js`.
- Recommendation outcome storage/scoring/provenance: `server/jarvis-core/recommendation-outcome.js`.
- Final decision-board synthesis: `server/jarvis-core/decision-board.js`.

Modules that are synthesis-only (consume upstream outputs, should not recompute core mechanics):
- `strategy-portfolio.js`
- `strategy-experiments.js`
- `today-recommendation.js`
- `confidence-calibration.js`
- `decision-board.js`

---

## 6) Command Center Pipeline (Exact Build Path)
`/api/jarvis/command-center` -> `buildStrategyLayerSnapshotCached(...)` -> `buildStrategyLayerSnapshotPayload(...)` ->
1. `loadAllSessions()` + `loadRegimes(...)`
2. `buildStrategyTrackingSummaryCached(...)`
3. `buildStrategyDiscoverySummaryCached(...)`
4. `buildMechanicsResearchSummaryCached(...)`
5. `buildStrategyLayerSnapshot(...)`
6. `buildStrategyPortfolioSummaryCached(...)`
7. `buildStrategyExperimentsSummaryCached(...)`
8. `buildCommandCenterPanels(...)` (includes `buildTodayRecommendation(...)`, `buildDecisionBoard(...)`)
9. `upsertTodayRecommendationContext(...)`
10. `buildRecommendationPerformanceCached(...)`
11. `applyConfidenceCalibration(...)`

This is the canonical composition path. Other endpoints (`/strategy/layers`, `/strategy/tracking`, `/strategy/discovery`, etc.) return slices of the same ecosystem.

---

## 7) Performance-Sensitive Paths

### Heavy paths
- Full command-center rebuild when `force=true`:
  - tracking/discovery/mechanics/portfolio/experiments/recommendation all in one chain.
- Mechanics research aggregation with large `windowTrades`.
- Discovery/tracking windowed candidate evaluation.
- Recommendation backfill across many sessions.

### Reuse + cache points
- `buildStrategyLayerSnapshotCached` (TTL + in-flight dedupe).
- `buildMechanicsResearchSummaryCached`.
- `buildStrategyDiscoverySummaryCached`.
- `buildStrategyTrackingSummaryCached`.
- `buildStrategyPortfolioSummaryCached`.
- `buildStrategyExperimentsSummaryCached`.
- `buildRecommendationPerformanceCached`.

### Paths where recomputation should be avoided
- Re-running ORB/mechanics for the same request branch after snapshot exists.
- Rebuilding full command-center object when only one narrow summary is requested.

---

## 8) Advisory vs Execution Boundaries

Advisory-only layers (must not mutate live execution):
- Strategy discovery/tracking/portfolio/experiments.
- Mechanics research + contextual recommendation.
- Today recommendation and confidence calibration.
- Recommendation outcome/backfill scoring.
- Decision board and command-center narratives.

Execution-affecting paths (gated):
- Only explicit confirm-gated flows (trade execution request or OS action) attempt action handlers.
- If action tool is absent, response remains explicit advisory/failure.
- Voice endpoint guard enforces `voiceMode` requests through `/api/jarvis/query`.

---

## 9) Future Extension Points
- Add new advisory skills via `skill-registry.js` + executive planning + orchestrator route tags.
- Add new research families inside discovery/tracking without changing baseline ORB module.
- Add new stop families by extending `tradeMechanicsVariantTool.js` and mechanics aggregation contracts.
- Add richer regime segmentation by feeding stable regime keys into contextual mechanics + tracking.
- Add UI panels by consuming existing `commandCenter` fields, not recomputing engines client-side.

---

## 10) ASCII Architecture Diagram

```text
Persistent Data (SQLite + jarvis_state_kv + recommendation history)
  |
  v
Core Analysis Engines
  (orb.js, psych-levels.js, stats.js, backtest.js)
  |
  v
Research Engines
  (replay, mechanics variants, mechanics aggregation, discovery, tracking)
  |
  v
Governance Engines
  (portfolio states, experiments shadow lifecycle)
  |
  v
Recommendation Engines
  (today recommendation, outcome scoring/backfill, confidence calibration)
  |
  v
Decision Synthesis
  (decision-board + command-center panel composition)
  |
  v
API Layer
  (/api/jarvis/query, /api/jarvis/command-center, /api/jarvis/* summaries)
  |
  v
Observability + Tests
  (trace store/diag latest, jarvis e2e/failure/fuzz/strategy suites)
```

---

## 11) Known Architectural Inconsistencies / Ambiguities
1. `server/index.js` is a monolith with mixed concerns (routing, caching, analytics orchestration, voice response shaping). This increases coupling and makes dependency boundaries harder to enforce.
2. Some endpoint payloads overlap (`strategy/layers`, `command-center`, `mechanics/research`) with partial duplication in response shaping; this risks schema drift unless contracts are centralized.
3. Backfill/recommendation provenance is robust, but consumers must always inspect source/provenance fields to avoid mixing live and retrospective conclusions.
4. Regime segmentation availability remains conditional; several paths correctly return unavailable/low-confidence, but consumers must respect those flags.

