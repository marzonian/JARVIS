# Jarvis Master Architecture

## Scope
- Runtime: `/Users/m3130/3130-runtime/mcnair-mindset`
- Primary voice endpoint: `POST /api/jarvis/query`
- Objective: one coherent Jarvis brain with deterministic planning, durable state, and trace-backed execution.

## Layer 1 — Executive Layer
**Module**: `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/executive.js`

Executive is mandatory for voice requests and emits a normalized plan contract:

```json
{
  "selectedSkill": "LocalSearch",
  "skillState": "location_needed",
  "decisionMode": "ask_missing_input",
  "requiredInputsMissing": ["location"],
  "consentState": { "pending": false, "kind": "location", "required": true, "needLocation": true },
  "confirmationState": { "pending": false, "required": false, "kind": null },
  "pendingState": { "present": false, "kind": null },
  "plannedTools": ["LocationStore", "ConsentFSM", "WebTool"],
  "responseMode": "ask_missing_input"
}
```

## Layer 2 — Skill Layer
**Registry**: `/Users/m3130/3130-runtime/mcnair-mindset/server/jarvis-core/skill-registry.js`

Registered skills:
1. `TradingDecision`
2. `TradingStatus`
3. `TradingReplay` (hypothetical/replay/review)
4. `LocalSearch`
5. `WebSearch`
6. `DeviceAction`
7. `MemoryPreference`
8. `SystemDiagnostic`
9. `GeneralConversation`
10. `ShoppingAdvisor`
11. `ProjectPlanner`
12. `ComplaintLogging`
13. `ImprovementReview`

Each skill defines: intents, allowed tools, required inputs, state machine, allowed follow-ups.

## Layer 3 — Tool Layer
Core tools:
- `RiskTool`, `HealthTool`, `AnalystTool`, `ReplayTool`
- `WebTool` (provider chain + receipts)
- `AdvisorPlanner` (shopping/project intake + outputs)
- `LocationStore`, `ConsentFSM`, `MemoryStore`
- `ComplaintStore` (DB table + export APIs)
- `ImprovementEngine`
- `TraceStore` and optional `OS Agent`

Rule: tools execute operations; they do not own final voice formatting.

## Layer 4 — State Layer
Durable/active state:
- Voice session state: `voice_session` (`jarvis_state_kv`)
- Pending consent + pending actions (`jarvis_state_kv`)
- Preference memory + contradiction prompts (`jarvis_state_kv`)
- Location state (`jarvis_location_events` + live status cache)
- Complaints (`jarvis_complaints`)
- Last explain payload / guardrail context (durable key-value)

## Layer 5 — Safety Layer
Hard guards:
- Voice endpoint guard (`voiceMode=true` cannot use legacy endpoints)
- Precedence for trading: `position > health > risk > normal`
- Stale-data fail-closed behavior for trading decision/status
- Pending topic-shift firewall (no hijacking unrelated messages)
- General chat content firewall (no trading leakage)
- No hallucinated action claims without receipts (`executed` truth fields)
- Confirmation gates for trade execution / OS actions / directions

## Layer 6 — Personality Layer
Output policy:
- Calm, concise, direct
- No preamble-only filler
- Earbud mode strict when applicable
- Domain-appropriate language (no trading jargon leakage into general chat)
- Honest capability language (stub/disabled/unavailable explicitly disclosed)

## Unified Voice Pipeline
`voice input -> normalization -> executive plan -> skill selection -> pending/consent resolution -> tool execution -> safety validation -> personality formatting -> reply + trace`

No stage is allowed to bypass trace capture or final safety checks.
