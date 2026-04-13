# Jarvis System Wire Map

This map is the zero-trust inventory for the live Jarvis pipeline. Every required wire below must exist, be reachable, and be test-covered.

## Required Wires

| Wire ID | Stage | File Anchor | Guarantee | Silent Failure if Broken |
|---|---|---|---|---|
| `endpoint.jarvis.query` | entrypoint | `server/index.js:16997` | Voice routes through Jarvis orchestrator | Voice leaks to legacy routes |
| `endpoint.market.health` | health | `server/index.js:24803` | Health snapshot available to voice/UI | Stale bars treated as fresh |
| `endpoint.location.update` | location | `server/index.js:16828` | Phone location update stored | Local search cannot ground results |
| `endpoint.location.status` | location | `server/index.js:16972` | Session location freshness visible | UI assumes location when expired |
| `endpoint.jarvis.diag.latest` | observability | `server/index.js:17825` | Trace retrievable by session/traceId | No root-cause visibility |
| `endpoint.jarvis.complaints.create` | feedback | `server/index.js:18531` | Complaint entries persist with trace metadata | No durable feedback loop |
| `endpoint.jarvis.complaints.list` | feedback | `server/index.js:18570` | Complaint records are queryable/exportable | Improvement engine runs blind |
| `endpoint.jarvis.improvements.suggest` | improvement | `server/index.js:18625` | Improvement suggestions generated from complaints | No structured improvement cycle |
| `client.voice.submit` | client-entry | `client/src/App.jsx:2015` | Voice submit always hits `/api/jarvis/query` | Hidden fallback path |
| `client.voice.route.indicator` | client-observability | `client/src/App.jsx:2591` | Jarvis/Legacy status visible | User cannot detect wrong runtime |
| `orchestrator.intent.classifier` | router | `server/jarvis-orchestrator.js:55` | Intent selected before tools | Wrong tool chain |
| `orchestrator.intent.router` | router | `server/jarvis-orchestrator.js:896` | Intent-driven tool routing | Tool bypass/mismatch |
| `orchestrator.skill.shopping` | skill-routing | `server/jarvis-orchestrator.js:1442` | Shopping prompts enter advisor intake flow | Shopping requests fall into unclear/trading |
| `orchestrator.skill.project` | skill-routing | `server/jarvis-orchestrator.js:1498` | Project prompts enter project planning flow | Project requests return generic clarify |
| `orchestrator.skill.complaint` | skill-routing | `server/jarvis-orchestrator.js:1554` | Complaint intents persist feedback | Bad responses not logged |
| `orchestrator.skill.improvement` | skill-routing | `server/jarvis-orchestrator.js:1589` | Improvement intents run suggestion engine | No action-oriented improvement output |
| `tool.risk` | tools | `server/tools/riskTool.js:103` | Guardrails + explain payload | Blocked state not explainable |
| `tool.health` | tools | `server/tools/healthTool.js:73` | Health hardened against stale/today mismatch | False-live analysis |
| `tool.analyst` | tools | `server/tools/analystTool.js:318` | Analyst narrative from structured snapshots | Preamble/stale claims |
| `tool.web` | tools | `server/tools/webTool.js:283` | Web lookup with explicit mode/provider | Hallucinated search actions |
| `fsm.consent.pending` | consent | `server/jarvis-core/consent.js:175` | Session-scoped consent TTL | Unconfirmed action execution |
| `store.location.ttl` | location | `server/jarvis-core/location-store.js:66` | Location TTL enforced | Old location reused silently |
| `gate.voice.endpoint.guard` | guardrail | `server/index.js:378` | Non-Jarvis voice endpoints hard-reject | Legacy voice bypass |
| `gate.content.firewall` | guardrail | `server/index.js:16435` | `general_chat` cannot leak trading tokens | ORB/Topstep leak in chat |
| `gate.finalize.earbud` | finalization | `server/index.js:17569` | Non-bypassable final gate + invariants | Legacy tokens in spoken replies |
| `trace.store` | observability | `server/jarvis-core/trace.js:94` | Correlated trace persistence | No end-to-end proof |
| `trace.diag.latest` | observability | `server/index.js:17825` | Latest trace fetch by session | Wrong request debug target |

## Source of Truth

- Machine-readable map: [`SYSTEM_WIRE_MAP.json`](/Users/m3130/3130-runtime/mcnair-mindset/SYSTEM_WIRE_MAP.json)
- Verification test: [`tests/test-system-wire-map.js`](/Users/m3130/3130-runtime/mcnair-mindset/tests/test-system-wire-map.js)

## Verification Rule

If any required wire id is missing, file anchor is invalid, or the anchor text cannot be found near the declared line, the wire-map test must fail.
