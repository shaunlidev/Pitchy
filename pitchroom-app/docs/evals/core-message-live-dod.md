# Core Message live-eval Definition of Done

Scope: one synthetic Apidog core-message generation through the existing Pitchroom DeepSeek Responses integration. This is an engineering and evaluation gate, not customer validation.

## Engineering DoD

1. The frozen input, prompt version, provider configuration, and input hash are recorded before transfer.
2. The DeepSeek path makes exactly one generation request, uses the reviewed provider endpoint and model alias, reserves worst-case cost before dispatch, and records actual usage after response.
3. The provider returns `completed`, the expected model identity, valid JSON matching the proposal schema, and exact evidence quotes found in the frozen source packet.
4. The leading hypothesis has no deterministic hard failure and is eligible for human review. No output is automatically classified as customer-validated.
5. The output recommends exactly one hypothesis, explains why it wins against the alternative, and lists concrete conditions that would reverse the judgment.
6. The immutable output and a review template bound to its SHA-256 hash are written locally. Final state is `awaiting_human_review`.
7. Core-message regression tests and package typecheck pass. Secrets and reasoning content are not written to evidence.

## Human acceptance gate

The user reviews groundedness, mechanism clarity, differentiation, and decision usefulness on a 0–4 scale. A pass requires every dimension to be at least 2, a mean of at least 3, an explicit statement of the preserved core judgment, and no hard failure.

Passing the engineering DoD does not prove that real customers recognize the message or prefer the product. That requires customer interviews or behavioral validation.

## Repair and stop rule

Repair only failures supported by recorded evidence. Run the smallest relevant deterministic checks after each repair. Stop before a third unsuccessful repair of the same defect; do not silently retry an uncertain external request.
