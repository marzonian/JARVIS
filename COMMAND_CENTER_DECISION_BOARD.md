# Command Center Decision Board

## Purpose
The Decision Board is a concise advisory synthesis for the current trading session. It consolidates existing Jarvis strategy intelligence into one operational view so the user can quickly decide whether to engage normally, selectively, wait, or stand down.

It does not change execution behavior and does not mutate the original trading plan.

## Decision Board Priority Rules
1. Preserve truth model order:
   - Original Trading Plan baseline first.
   - Candidate strategy state second.
   - Today recommendation posture and TP mechanics third.
2. Prefer already-computed snapshot outputs over new computation.
3. Prioritize risk clarity before opportunity framing.
4. Keep recommendation confidence explicit with reason text.
5. Keep all strategy candidate guidance advisory-only.

## Deduplication Rules
1. Do not repeat the same caution text across `newsCaution`, `keyRisk`, and `summaryLine`.
2. Do not repeat baseline/top-candidate labels if they refer to the same strategy.
3. Prefer one concise `summaryLine` over multiple near-identical sentences.
4. Suppress empty/unknown placeholders instead of emitting noisy filler text.

## Performance Safety Rules
1. Decision Board must run on the same command-center snapshot payload and never trigger heavy recomputation.
2. Reuse existing strategy layers, tracking, portfolio, experiments, recommendation, and context objects.
3. No additional backtests, discovery runs, or replay passes in Decision Board synthesis.
4. Keep synthesis deterministic and bounded to string/field selection.

## Truth-Model Labeling
- `baseline` is the user’s original plan reference lane.
- `topCandidate` is advisory candidate state from governance/experiments.
- `todayRecommendation`, `posture`, `tpRecommendation`, and `confidence` are advisory guidance.
- `advisoryOnly` is always `true`.
