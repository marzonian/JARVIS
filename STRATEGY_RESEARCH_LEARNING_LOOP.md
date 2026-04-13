# Strategy Research Learning Loop

## Purpose
The Strategy Research Learning Loop is Jarvis's bounded advisory feedback layer that converts historical research + recommendation outcomes into conservative learning signals.

It answers:
- which strategy lanes are improving,
- which are weakening,
- where research attention should increase or decrease,
- whether recommendation patterns are improving over time.

It does **not** change execution logic.

## Learning Inputs
- Recommendation outcome/performance history (`jarvis_recommendation_outcome_*`, summary APIs).
- Mechanics research summaries (global + contextual TP-mode signals).
- Strategy discovery candidates.
- Side-by-side strategy tracking summaries.
- Portfolio governance states.
- Shadow experiment states.

## Learning Outputs
`strategyLearning` (advisory-only):
- `improvingStrategies`
- `weakeningStrategies`
- `researchPriorityList`
- `mechanicsLearningInsights`
- `recommendationLearningInsights`
- `evidenceStrength`
- concise synthesis fields for command center (`learningInsight`, `researchPrioritySummary`, top improving/weakening)

## Feedback Loop Design
1. Aggregate current strategy ecosystem snapshots.
2. Blend recommendation performance evidence strength (live vs backfill + sample size).
3. Detect improving/weakening trajectories from tracking/governance/experiment states.
4. Produce conservative research-priority decisions (`increase_attention`, `maintain_attention`, `reduce_attention`, `retire_research_focus`).
5. Publish concise insights to `/api/jarvis/strategy/learning` and command-center summaries.

## Learning Integrity Rules
- No direct auto-execution changes.
- No automatic mutation of the original trading plan.
- Thin samples reduce certainty and suppress aggressive prioritization.
- Retrospective/backfill evidence must stay labeled.
- Learning outputs must be explainable in plain language.
- Context-only strength must not be presented as global superiority.

## Advisory Learning Boundaries
- Learning is advisory-only and separate from execution.
- Output can influence research focus and messaging confidence, not trade placement.
- Candidate prioritization is not candidate promotion to live usage.

## Anti-Overfitting Safeguards
- Sample-quality guardrails (`very_thin`/`thin` -> lower attention confidence).
- Recommendation evidence strength based on row count + source mix (live/backfill).
- Weakening/deprioritized candidates are explicitly down-ranked.
- Context-specific candidate states are kept in non-global priority lanes.

## Sample-Quality Rules
- `<10` scored rows (or very small 30-day sample): `weak` evidence.
- Mixed live/backfill evidence is labeled; retrospective-only evidence gets explicit warning.
- Learning confidence is capped when sample quality is weak.

## Truth-Model Guarantees
1. Original Trading Plan remains baseline and unchanged.
2. Variants/overlays remain advisory.
3. Discovery candidates remain advisory.
4. Learning outputs remain advisory and explainable.
5. No auto-switching, no auto-promotion, no execution mutation.
