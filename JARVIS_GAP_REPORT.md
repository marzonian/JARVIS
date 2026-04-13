# Jarvis Gap Report

## Baseline
Audit target: `/Users/m3130/3130-runtime/mcnair-mindset` on live port `3131`.

## Layer Status Matrix

| Layer | Status | Severity | File-level evidence |
|---|---|---|---|
| Executive Layer | **Partially implemented** | P0 | `server/jarvis-core/executive.js`, `server/jarvis-orchestrator.js` |
| Skill Layer | **Implemented with new coverage** | P1 | `server/jarvis-core/skill-registry.js`, `server/jarvis-core/intent.js` |
| Tool Layer | **Implemented with targeted gaps** | P1 | `server/tools/*.js`, `server/jarvis-core/advisor-planner.js`, `server/jarvis-core/improvement-engine.js` |
| State Layer | **Mostly implemented (durable)** | P1 | `server/jarvis-core/durable-state.js`, `server/db/schema.sql`, `server/index.js` |
| Safety Layer | **Implemented with edge risk** | P1 | `server/index.js` (`/api/jarvis/query` guards), `server/jarvis-orchestrator.js` |
| Personality Layer | **Partially implemented** | P2 | `server/jarvis-core/finalize.js`, `server/index.js` reply shaping |

## Gap Details

### P0 — Executive planner not yet exclusive owner of all branch response text
- Root cause:
  - `run()` still contains direct branch text in orchestrator for several intents.
- Evidence:
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
- Fix path:
  - Move remaining branch copy generation into centralized response builders while preserving skill contracts.

### P1 — Skills added, but some downstream tools are still composite wrappers
- Root cause:
  - `ShoppingAdvisor` / `ProjectPlanner` currently rely on `AdvisorPlanner` with deterministic templates rather than dedicated external research providers.
- Evidence:
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/advisor-planner.js`
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
- Fix path:
  - Add optional provider-backed recommendation enrichment (explicitly receipt-tagged).

### P1 — Complaint and improvement channels are implemented but still young
- Root cause:
  - Complaint analytics are pattern-based and do not yet correlate with full trace timeline windows.
- Evidence:
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/index.js` (`/api/jarvis/complaints*`)
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/improvement-engine.js`
- Fix path:
  - Add cross-linking from complaint entries to stored trace snapshots and failure classes.

### P1 — Pending engine now universal for consent + intake, but one route family remains generic
- Root cause:
  - Intake flows (shopping/project) are unified, but OS/trade confirmations still use direct confirm phrases without richer plan summary deltas.
- Evidence:
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
- Fix path:
  - Introduce shared confirmation payload rendering for all risky actions.

### P2 — Personality consistency still depends on branch-level wording quality
- Root cause:
  - Voice style is coherent in most flows, but long-form planning replies can become denser than earbud expectations.
- Evidence:
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/finalize.js`
- Fix path:
  - Add skill-specific formatting policies (planning/advisory concise mode).

## Current Reality
Implemented in this pass:
1. Added new first-class intents and skills for shopping/project/complaint/improvement.
2. Added advisor planner engine for multi-turn intake + deterministic outputs.
3. Added durable complaint storage + list/export APIs.
4. Added improvement engine + suggestions endpoint.
5. Expanded executive output contract with `selectedSkill`, `skillState`, `decisionMode`, `consentState`, `confirmationState`, `pendingState`.

Still not fully “ultimate Jarvis”:
1. OS automation remains gated and mostly stubbed without a live agent.
2. Shopping advisor recommendations are rule-based, not live benchmark + price ranked.
3. Improvement engine is advisory only and still pattern-heuristic driven.
