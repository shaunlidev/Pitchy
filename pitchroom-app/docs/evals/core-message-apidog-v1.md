# Core-message eval: Apidog v1

Status: designed fixture, not a model-quality result.  
Owner: unassigned.  
Language: English for source analysis, candidate outputs, rubrics, and grader diagnostics.

## Evaluation claim

This fixture asks whether a core-message agent can turn scattered product material into a grounded positioning judgment that:

1. identifies the API specification as the active source of truth;
2. explains change propagation from one specification into dependent API workflow assets;
3. makes the relief from manual synchronization legible;
4. avoids claiming that application code or production systems update automatically;
5. produces a judgment a person can inspect, edit, reject, or apply.

The fixture does not establish Apidog's actual market positioning, customer demand, or product performance. Official product material and aggregated reviews are research inputs. They are not independent proof that the proposed message causes adoption.

## Product judgment under test

> Change the spec once. Keep the entire API workflow in sync.

Expanded golden judgment:

> Apidog turns the API specification into an active source of truth. Change the spec once, and dependent API workflow assets such as documentation, mocks, requests, and tests can stay aligned without manual copying across tools. Human-authored logic may still require review, and external implementations must be validated rather than silently rewritten.

## Authority boundary

The agent recommends positioning directions. The user owns the decision to apply one. A generated direction must remain a reviewable proposal and must not replace the original framing automatically.

## Artifact behavior after a specification change

| Artifact class | Intended behavior | Prohibited inference |
|---|---|---|
| Specification-derived assets | Regenerate or update from the current specification | Every generated result is automatically correct |
| Human-authored dependent assets | Preserve authored logic and mark affected content for review | Assertions or business meaning can be safely rewritten without review |
| External implementation and production behavior | Validate and expose contract drift | Application code or deployed services update automatically |

## Deterministic prechecks

The local grader checks whether a candidate:

- names the specification or API contract;
- connects one change to at least two downstream asset classes;
- expresses propagation or alignment;
- states the manual-synchronization relief;
- avoids universal guarantees and automatic code/production synchronization claims.

These checks are intentionally narrow. Passing them only makes a candidate eligible for human review.

## Human rubric

Score every dimension from 0 to 4.

| Dimension | 0 | 2 | 4 |
|---|---|---|---|
| Groundedness | Contradicts or exceeds the material | Mostly supported, with vague edges | Every consequential claim is supported or bounded |
| Change propagation | Lists features | Mentions a shared source of truth | Clearly connects one spec change to dependent assets |
| Causal clarity | Uses abstract benefit language | Mechanism or outcome is visible | User action, product mechanism, and result form one causal chain |
| Differentiation | Could describe any API tool | Contains an Apidog-relevant mechanism | Establishes a defensible strategic emphasis and exclusion |
| Actionability | Cannot guide a product story | Suggests a general theme | Determines what a demo, homepage, or deck should show |
| Uncertainty honesty | Makes universal promises | Avoids obvious exaggeration | Separates auto-update, review-required, and validation-only behavior |

Hard failures override the numeric score. A candidate is `strong` only when there is no hard failure, every dimension is at least 2, the mean is at least 3, and a human reviewer confirms that the core judgment is worth preserving even if its wording changes.

## Human review questions

1. What should the audience understand now that they would not understand from a feature list?
2. Is the mechanism visible, or is the candidate merely promising efficiency?
3. Which phrase would the user preserve while editing the wording?
4. Does the message imply that code or production systems synchronize automatically?
5. What should the product demo show if this message is truly the positioning lead?

## Current expected regression examples

- `A_FEATURE_LIST`: factually safe but insufficient; it lists capabilities and generic efficiency.
- `B_SHARED_SPEC`: acceptable; it identifies the shared specification and downstream relationship but lacks the human payoff.
- `C_CHANGE_PROPAGATION`: strong subject to human review; it joins action, mechanism, result, and manual-sync relief.
- `D_UNIVERSAL_GUARANTEE`: hard fail; it promises that all code and teams remain synchronized forever.

## Release gate

This fixture may guide prompt or model comparison only after:

- the exact fixture version and tested system version are recorded;
- candidate output is captured without editing;
- deterministic failures are reported separately from human scores;
- at least one reviewer records notes rather than only a number;
- no offline result is promoted to real-user acceptance.

## Prompt contract

The product-independent prompt contract lives in `packages/evals/src/core-message-prompt.ts`. It requires exactly two distinct hypotheses. Each hypothesis separates a complete positioning thesis from a user-recognizable slogan of at most 12 English words, and records the audience, situation, mechanism, payoff, trade-off, exclusions, evidence, counterevidence, and unknowns. It may ask at most one question whose answer could change the positioning decision.

The source packet sent to a model contains English material and its evidence boundary, but not source URLs. A response must pass schema validation and exact-quote validation before deterministic prechecks or human review. No output is applied to product state by this fixture.

Live execution requires an explicit synthetic-data acknowledgment, a reviewed provider configuration, an existing credential, a cost/request budget, immutable run artifacts, and output-bound human review. These controls are implemented by the core-message live runner. A successful model response still remains `awaiting_human_review` and is not customer validation.

