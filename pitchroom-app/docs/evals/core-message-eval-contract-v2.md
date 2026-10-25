# Core Message Eval Contract v2

Status: implemented contract; product quality still requires human review and real use.

## Decision under test

Can Pitchroom turn scattered product material into two useful, defensible choices that help a user articulate value they already feel but cannot yet phrase?

The two choices have fixed jobs:

- `mechanism`: lead with a distinctive product behavior and the work it changes.
- `human_tension`: lead with a supported social, emotional, or identity tension, while retaining a credible product mechanism.

They are not two headline styles. The Agent must compare them and recommend exactly one, explain why it wins, and state what evidence would reverse the judgment. The user may edit, reject, preserve the original framing, or Apply exactly one direction.

## Hard gates

1. Exactly one direction per lens.
2. Consequential claims cite exact supplied evidence.
3. The slogan is no more than 12 English words and is separate from the explanatory thesis.
4. No forbidden outcome guarantee or automatic external-system mutation.
5. Preview never mutates the project; Apply is explicit; failure preserves saved work.
6. The Agent gives an explicit comparative recommendation; a list of options without a judgment fails.

## Human rubric

Score each 0–4: recognition, specificity, memorability, truthfulness, and choice usefulness.

Pass requires all hard gates, every dimension at least 2, mean at least 3, and a reviewer who can explain the strategic difference between the two directions. A model precheck cannot award this pass.

## Coverage and baseline

The deterministic matrix covers developer tools, consumer finance, team collaboration, health behavior, creator tools, local services, education, and commerce. The v2.1 baseline often found human tension but ranked the safer functional message first. V2.2 made the comparison explicit. V2.3 also requires the Agent to own a reversible judgment: one recommendation, its comparative reason, and conditions for reconsideration. Model judgment remains decision support; it never crosses the user's Apply boundary.

V2.3 live probes completed for three categories/material sets: Apidog, Splitwise, and Pitchroom self-validation. Every direction was structurally eligible for human review. All three runs produced one explicit recommendation, a comparison against the alternative, and concrete reconsideration conditions. This demonstrates schema and prompt portability, not human-quality acceptance or customer validation.

## Stop rule

After two evidence-led repairs fail the same defect, stop before a third and request a product decision. Never weaken assertions, suppress errors, or count missing human review as success.

## Definition of done

- Contract: deterministic matrix and schema pass.
- Interaction: material → two lenses → strengths and tradeoffs → explicit Agent recommendation → evidence → edit → Apply → downstream status → undo/recovery is usable.
- Engineering: targeted tests, full check, and isolated synthetic browser QA pass.
- AI quality: live outputs pass structural checks and receive a completed human rubric.
- Product evidence: at least three target users use their own material; record selection, edits, time-to-articulation, help needed, and whether the applied message is used in a real downstream artifact.

The first four gates do not substitute for the fifth.
