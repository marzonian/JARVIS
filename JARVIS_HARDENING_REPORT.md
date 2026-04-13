# Jarvis Hardening Report

## Scope
This pass focused on reliability, continuity, and trust only:
- durable cross-restart state
- resilient web/local-search provider fallback
- executive-first response schema visibility
- removal of silent client-side legacy fallback in Voice Copilot

Trading strategy math and ORB entry/exit logic were not modified.

## Phase 1: Durable State

### What moved from process memory to durable storage
Durable backend: `jarvis_state_kv` in SQLite, via `createJarvisDurableStateStore`.

Wired components:
- Consent pending (`state_type=consent_pending`)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/consent.js`
- General pending actions (`state_type=general_pending`)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/pending-engine.js`
- Preference memory (`state_type=preference_memory`)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
- Contradiction prompts (stored in general pending with TTL)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
- Last explain payload (`state_type=risk_explain`)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/tools/riskTool.js`
- Voice session state (`state_type=voice_session`)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/voice-session.js`
- Web result-set selections (stored in consent pending payload for directions-select/confirm)  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`

Global wiring:
- Durable store construction + injection in runtime  
  `/Users/m3130/3130-runtime/mcnair-mindset/server/index.js`

### Reliability fixes completed
- Fixed null-expiry handling in durable state conversion (`null` no longer coerced to `0` expiry).
- Fixed voice session retrieval path to reload durable state after restart (`get()` now hydrates through `ensureState()`).

### Restart-safety validation
Added restart simulation tests:
- pending consent survives restart and `"yes"` resolves
- contradiction prompt survives restart and resolves
- web selection survives restart and `"the first one"` resolves
- voice session survives restart while TTL valid
- risk explain payload survives restart

Test file:
- `/Users/m3130/3130-runtime/mcnair-mindset/tests/test-jarvis-durable-state.js`

## Phase 2: Web Reliability

### Provider fallback chain
`searchPlaces()` now uses multi-provider attempts with structured receipts:
1. Nominatim text query
2. Nominatim structured query
3. Overpass brand/name search
4. Optional web fallback (DuckDuckGo) when enabled and no place hits

Implementation:
- `/Users/m3130/3130-runtime/mcnair-mindset/server/tools/webTool.js`

### Required receipt fields now emitted
- `providerAttempts[]`
- `providerSucceeded[]`
- `providerFailed[]`
- `resultCount`
- `warnings[]`

### Reliability tests added
- provider A error -> provider B success
- provider A zero -> provider B success
- all providers fail -> safe truthful output

Test file:
- `/Users/m3130/3130-runtime/mcnair-mindset/tests/test-webtool-reliability.js`

## Phase 3: Executive-First Routing Visibility

### Top-level response schema (from `/api/jarvis/query`)
Every successful response now carries executive metadata:
- `selectedSkill`
- `skillState`
- `decisionMode`
- `consentState`

Assembly path:
- `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`
- `/Users/m3130/3130-runtime/mcnair-mindset/server/index.js`

### Unclear-intent tightening
Routing updates and tests ensure natural phrases map to available skills where possible, with `general_chat + ask_clarify` used as guarded fallback instead of silent misroute.

Validation coverage:
- `/Users/m3130/3130-runtime/mcnair-mindset/tests/test-jarvis-orchestrator.js`
- `/Users/m3130/3130-runtime/mcnair-mindset/tests/test-jarvis-voice-real-e2e.js`

## Phase 4: Client Legacy Fallback Removal

### What was removed
Voice Copilot no longer silently degrades to legacy quick endpoints when transport errors occur.

Current behavior:
- one safe retry on transient network/abort
- if still failing: explicit unavailable state (`Jarvis unavailable`)
- no automatic route to legacy voice behavior

Implementation:
- `/Users/m3130/3130-runtime/mcnair-mindset/client/src/App.jsx`

Regression test:
- `/Users/m3130/3130-runtime/mcnair-mindset/tests/test-jarvis-voice-client-transport.js`

## Command Validation
This hardening pass was validated with:
- `npm test`
- `npm run build`
- `npm run test:assistant:smoke`
- `npm run test:jarvis:voice:real`
- `npm run test:jarvis:e2e:integrity`
- `npm run test:jarvis:e2e:failure`

## Remaining Known Gaps
P1:
- Intent classification is still heuristic-first (improved, but not semantic-model planned classification). Low-confidence phrasing can still require clarify prompts.

P1:
- Web quality is still dependent on public provider quality/rate limits (fallback chain is resilient, but not guaranteed high-quality results in every geography/time window).

P2:
- Durable state currently uses a shared SQLite file; extreme concurrent write pressure could still produce transient lock contention (fail-safe behavior exists, but no dedicated queue/worker yet).

P2:
- Client transport behavior is now explicit-unavailable (trusted), but there is no offline request queue/replay for temporary disconnects.

## Post-Hardening Extensions (This Pass)

### New capability skills wired into the same executive pipeline
- `shopping_advisor`
- `project_planner`
- `complaint_log`
- `improvement_review`

Files:
- `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/intent.js`
- `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/skill-registry.js`
- `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/executive.js`
- `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-orchestrator.js`

### Complaint + improvement reliability loop
- Added durable complaint table (`jarvis_complaints`) and APIs:
  - `POST /api/jarvis/complaints`
  - `GET /api/jarvis/complaints`
  - `GET /api/jarvis/complaints/export`
- Added improvement suggestion endpoint:
  - `GET /api/jarvis/improvements/suggest`
- Added engine:
  - `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/improvement-engine.js`

### Voice panel trust UX
- Added “Not a good response” capture in Voice Copilot with:
  - prompt/reply/trace/skill/route/tools payload
  - notes
  - copy complaint
  - export complaints JSON/Markdown

File:
- `/Users/m3130/3130-runtime/mcnair-mindset/client/src/App.jsx`
