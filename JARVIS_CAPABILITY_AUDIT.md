# Jarvis Capability Audit (Universal Local Search)

## Scope
- Runtime: `/Users/m3130/3130-runtime/mcnair-mindset`
- Focus: intent -> router -> consent FSM -> WebTool -> directions follow-ups -> trace/diag proof
- Out of scope: ORB strategy math, trading logic, RiskTool/AnalystTool internals

## Current State Machine (as implemented)
1. Voice request enters `/api/jarvis/query`
2. Intent classification (`local_search` for nearest/closest/find-location phrases)
3. Consent FSM:
   - `location` pending when location is missing
   - `web_search` pending when location exists but search consent not granted
   - execution on explicit yes
   - optional `web_directions_select` and `web_directions_confirm` stages
4. WebTool executes and emits receipts
5. Finalizer + invariants run before response leaves server
6. Trace record available in `/api/jarvis/diag/latest`

## Original Generic-Entity Risk Points
1. Query normalization could keep filler terms (`find me`, `services`, etc.) and pollute entity query.
2. No explicit skill contract made local search behavior vulnerable to phrase-by-phrase drift.
3. Non-deterministic provider behavior could make E2E coverage flaky.
4. Pending state/session drift could produce “no action pending” despite a recent pending action.
5. Pending flows could hijack unrelated chat if follow-up matching was too broad.

## Hardening Applied
1. Upgraded entity extraction to be filler-resistant and brand-agnostic.
2. Added `LocalSearch` skill registry contract with explicit states and allowed follow-ups.
3. Added deterministic WebTool fixture modes for matrix/failure harnesses (`ok`, `zero`, `error`).
4. Kept session-recovery logic for yes/no/cancel via client-scoped pending recovery.
5. Kept strict topic-shift guard so unrelated text never executes pending actions.

## Verification Strategy
1. Unit: intent routing + query normalization.
2. E2E matrix: 50 entities x 4 phrase styles + full consent/directions/session-drift/topic-shift paths.
3. Failure injection: zero results, provider error, missing location, denied consent, forced pending expiry.
4. Runtime: trace fields inspected through `/api/jarvis/diag/latest`.

