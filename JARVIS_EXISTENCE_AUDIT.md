# Jarvis Existence Audit

Date: 2026-03-04
Runtime: `/Users/m3130/3130-runtime/mcnair-mindset`

## Capability Dependency Checklist

| Capability | Dependency Chain | Status | Evidence |
|---|---|---|---|
| Voice trading guidance (earbud) | Voice UI -> `/api/jarvis/query` -> intent -> precedence (position > health > risk > normal) -> Analyst/Risk/Health tools -> finalizer -> invariant gate | PASS | `tests/test-jarvis-voice-real-e2e.js`, `tests/test-jarvis-audit-e2e.js` |
| Trading hypothetical / replay | Intent `trading_hypothetical` -> ReplayTool snapshot -> data availability check -> "would have" narrative -> tool receipt/trace | PASS | `server/tools/replayTool.js`, `tests/test-jarvis-voice-real-e2e.js` (phrase 32), `tests/test-jarvis-intent-routing.js` |
| Stale-data fail-closed | Trading intent -> health snapshot -> stale/degraded block -> no ORB/trend claims | PASS | `tests/test-jarvis-voice-real-e2e.js` (stale gate), `tests/test-jarvis-e2e-integrity.js` scenario D |
| General chat firewall | Intent `general_chat/unclear` -> no trading tools -> content firewall -> neutral clarification | PASS | `tests/test-jarvis-voice-guard.js`, `tests/test-jarvis-e2e-integrity.js` scenario E |
| Web local search consent | `web_local_search` -> location consent -> optional phone link -> web consent -> WebTool execute/stub disclosure | PASS | `tests/test-jarvis-web-consent.js`, `tests/test-jarvis-location-bridge.js`, `tests/test-jarvis-e2e-integrity.js` scenarios A/B |
| Android phone location bridge | `/jarvis/link` -> browser geolocation -> `/api/jarvis/location/update` -> TTL store -> `/api/jarvis/location/status` | PASS | `tests/test-jarvis-location-bridge.js`, `server/jarvis-core/location-store.js` |
| OS/device action safety | Intent `device_action` -> allow-list parse -> confirm gate -> execution only after explicit confirm | PASS | `tests/test-jarvis-orchestrator.js`, `tests/test-jarvis-e2e-integrity.js` scenario F, `tests/test-jarvis-failure-injection.js` |
| Explain follow-up memory | Risk block response cache (session TTL) -> aliases (`explain/why/details/...`) -> full brief | PASS | `tests/test-analyst-risk.js`, `tests/test-analyst-precedence.js`, `tests/test-jarvis-voice-real-e2e.js` |
| Voice endpoint exclusivity | voiceMode on legacy endpoints -> 409 reject | PASS | `tests/test-jarvis-voice-guard.js`, `tests/test-jarvis-failure-injection.js` case 6 |
| Trace observability | ingress -> classify -> tool call -> precedence -> formatter -> invariants -> final response, retrievable via `/api/jarvis/diag/latest` | PASS | `tests/test-jarvis-trace-schema.js`, `tests/test-jarvis-failure-injection.js` case 7 |

## Known Gaps

| Priority | Gap | Impact | Fix Path |
|---|---|---|---|
| P1 | `tests/test-jarvis-audit-fuzz.js` is runtime-heavy when not mocked | Slow CI/local cycles | Keep audit mocks enabled for fuzz; add progress logging every 25 cases |
| P1 | WebTool real provider quality varies by external provider/network | Non-deterministic result quality (not safety) | Keep explicit stub/disabled disclosure + provider-specific integration tests |
| P2 | Device actions require OS agent connection to execute beyond confirm-gated planning | Limited automation breadth | Implement hardened local OS agent with signed allow-list and command receipts |

## Final Reliability Position

- Core safety invariants are enforced at final response gate.
- Precedence ordering is deterministic and test-covered.
- Consent/authorization chains are explicit, session-scoped, and traceable.
- Trading replay/hypothetical responses are non-hallucinatory ("would have" only with data-backed simulation).
- Failures are mostly closed with explicit user feedback and trace artifacts.
