## Purpose
The Regime Trust Consumption Layer converts existing regime trust evidence into bounded advisory guidance for downstream messaging confidence. It answers whether regime-conditioned insights should be trusted now, softened, or suppressed due to weak live confirmation.

## Inputs
- `regimeDetection`
- `regimeAwareLearning`
- `regimePerformanceFeedback`
- `regimeEvidenceSplit`
- `todayRecommendation`
- `recommendationPerformance.summary`

This layer is compositional only and reuses existing summaries. It does not trigger replay, backtest, discovery, or execution recomputation.

## Consumption Method
1. Read current regime trust from `regimeEvidenceSplit.currentRegimeComparison` and `trustBiasLabel`.
2. Apply bounded trust-consumption rules to classify one of:
   - `allow_regime_confidence`
   - `allow_with_caution`
   - `reduce_regime_weight`
   - `suppress_regime_bias`
3. Derive a messaging-only confidence override suggestion.
4. Set suppression flags for regime-derived opportunity phrasing, while keeping risks visible.
5. Publish a compact trust snapshot for command-center and decision-board consumption.

## Supported Outputs
Top-level `regimeTrustConsumption`:
- `generatedAt`
- `windowSessions`
- `currentRegimeLabel`
- `trustBiasLabel`
- `trustBiasReason`
- `trustConsumptionLabel`
- `trustConsumptionReason`
- `confidenceAdjustmentOverride`
- `shouldSuppressRegimeOpportunity`
- `shouldSuppressRegimeRisk`
- `shouldSuppressTopRegimeAlignedStrategy`
- `currentRegimeTrustSnapshot`
- `regimeTrustInsight`
- `advisoryOnly`

## Thin-Sample Handling
- Live sample `<5` forces `suppress_regime_bias` behavior and zero trust inflation.
- Live sample `<10` cannot qualify as live-confirmed regime confidence.
- Thin-sample contexts force conservative non-positive overrides.

## Advisory-Only Constraints
- No execution mutation.
- No order-routing changes.
- No baseline rewrite.
- No TP auto-switching.
- No strategy promotion changes.

All outputs are advisory messaging/confidence guidance only.

## Anti-Overfitting Safeguards
- Live-confirmed trust requires live-only evidence, not all-source strength.
- Retrospective-led strength cannot produce aggressive confidence uplift.
- Mixed/unknown regimes cannot yield positive overrides unless truly live-confirmed with sufficient live sample.
- Large all-vs-live score gaps force trust reduction.

## Regime Trust Consumption Rules
- `allow_regime_confidence`:
  - only when trust bias is `live_confirmed`
  - live direct sample `>=10`
  - live-only label is `strong` or `moderate`
- `allow_with_caution`:
  - mixed-support evidence without clear weakness
- `reduce_regime_weight`:
  - retrospective-led support, materially large score divergence, or retrospective-heavy provenance
- `suppress_regime_bias`:
  - insufficient live confirmation or live sample too thin

Under weak trust, regime-derived opportunities are softened/suppressed first; regime-derived risk visibility is preserved.

## Confidence Override Semantics
`confidenceAdjustmentOverride` is a downstream messaging-confidence suggestion only:
- `allow_regime_confidence`: `0..+5`
- `allow_with_caution`: `-2..+2`
- `reduce_regime_weight`: `-8..-3`
- `suppress_regime_bias`: `-12..-6`

Hard guards:
- `insufficient_live_confirmation` => override `<= -6`
- `retrospective_led` => override `<= 0`
- mixed/unknown regimes cannot produce positive override unless live-confirmed.
