# Strategy Portfolio Governance

## Purpose
Strategy Portfolio Governance converts tracked strategy signals into a small advisory portfolio with explicit state, ordering, and degradation handling. It prevents ambiguous "interesting" strategy signals from being treated as execution guidance.

## Portfolio Strategy Lanes
The portfolio always keeps these lanes separate:
1. Original Trading Plan (baseline lane)
2. Best Variant (overlay lane)
3. Best Alternative Candidate (discovery lane)
4. Today Recommendation (advisory synthesis lane)

## Governance Integrity Rules
- Governance outputs are advisory only.
- No auto-adoption or execution switching is allowed.
- Weak evidence blocks promotion to stronger portfolio states.
- Degraded candidates must be explicitly deprioritized.
- Context-only edge is never treated as global dominance.
- Portfolio state does not mutate original plan rules.

## Portfolio State Definitions
- `baseline`: original plan baseline reference.
- `active_candidate`: strongest non-baseline advisory candidate with sufficient evidence.
- `context_only_candidate`: candidate with meaningful edge only in bounded contexts.
- `watchlist`: interesting but not yet strong enough for active-candidate status.
- `weakening`: edge deterioration is visible and requires caution.
- `low_confidence`: sample quality too thin to trust.
- `deprioritized`: candidate should not currently influence recommendation weighting.

## Promotion / Demotion Logic
Promotion signals:
- Positive relative PF / WR versus baseline.
- Stable-to-improving momentum.
- Sufficient sample quality (not very thin).
- No low-confidence discovery robustness warnings.

Demotion signals:
- Weakening momentum with negative relative PF and WR.
- Very thin sample.
- Unavailable strategy lane.
- Discovery robustness label is low-confidence.

## Evidence Requirements
- Portfolio state uses tracked windows (20/60/120 sessions).
- Uses tracking status, momentum, stability, and relative-vs-baseline metrics.
- Uses discovery robustness and promotion decisions when available.
- Uses strategy-layer recommendation basis for lane context where useful.

## Priority Ordering
Advisory priority stack:
1. `baseline`
2. `active_candidate`
3. `context_only_candidate`
4. `watchlist`
5. `weakening`
6. `low_confidence`
7. `deprioritized`

Priority is informational and does not control execution.

## Truth-Model Guarantees
- Original plan remains the true baseline.
- Variant and alternative lanes remain advisory.
- Governance does not auto-promote to execution behavior.
- Today recommendation may reference governance state but must not silently replace baseline rules.
