# Strategy Experiment / Shadow Tracking

## Purpose
The Strategy Experiment / Shadow Tracking layer adds a controlled lifecycle for non-baseline strategy candidates. It prevents short-lived or unstable performance bursts from being treated as strong alternatives.

## Why Shadow Tracking Exists
- Keep discovery candidates in a research lane before they influence recommendations.
- Require evidence over rolling windows instead of one recent stretch.
- Surface degradation early and retire weak candidates explicitly.

## Shadow Tracking Integrity Rules
- Shadow tracking is advisory only.
- No auto-adoption into execution logic.
- Original Trading Plan remains baseline.
- Thin evidence blocks promotion readiness.
- Weakening candidates are explicitly flagged and deprioritized.
- Context-only strength is not treated as global leadership.
- Experiment output is auditable via endpoint payload fields.

## Experiment Lifecycle States
- `new_candidate`: recently surfaced candidate with very limited shadow evidence.
- `shadow_trial`: candidate under initial observation with limited confidence.
- `shadow_promising`: candidate showing improving evidence but still needs duration.
- `shadow_stable`: candidate has sustained consistent shadow performance; still advisory.
- `shadow_weakening`: candidate was stronger earlier but has degraded recently.
- `retired_candidate`: candidate no longer shows useful evidence or is unavailable.

## Promotion Eligibility Rules
Promotion readiness must use:
- sample quality (not thin),
- stability and momentum,
- relative performance vs baseline,
- context-vs-global interpretation.

A candidate can be marked promotion-ready only for advisory side-by-side monitoring, not execution switching.

## Retirement Rules
Candidates move toward retirement when:
- momentum weakens with negative relative metrics,
- sample quality remains weak over longer windows,
- strategy lane becomes unavailable,
- demotion risk remains high.

Retirement status is explicit and visible in experiment summaries.

## Evidence Requirements
- Rolling windows are required (default 20/60/120 via tracking source).
- Relative metrics vs baseline are required.
- Sample-quality labels are required.
- Context-dominance labels are included when available.

## Overfitting Safeguards
- Penalize thin samples (`very_thin` / `thin`).
- Penalize unstable or weakening momentum.
- Prevent context-only candidates from global promotion.
- Keep readiness bounded to descriptive states (`none` / `low` / `medium` / `high`).

## Truth-Model Guarantees
- Baseline, overlays, discovery, portfolio governance, experiments, and today recommendation remain separate layers.
- Shadow candidates are research-only and must never mutate execution parameters automatically.
