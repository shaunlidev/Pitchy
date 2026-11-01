# Contribution record and personal interview review

This record prevents repository work, assistant output, and personal experience from being treated as interchangeable.

## What can be attributed today

| Statement | Evidence level | Suitable wording |
|---|---|---|
| Shaun directed the current product exploration and portfolio scope | Explicit product and scope decisions | "I directed an AI-assisted prototype around reviewable positioning choices." |
| The repository contains generation, validation, versioning, and review behavior | Source inspection and scoped execution | "The prototype implements these paths with coding-agent assistance." |
| Shaun independently implemented the full architecture | Not established | Do not claim this. Record the specific files and decisions Shaun can personally explain and change. |
| The model succeeds reliably on the first attempt | Not established | Describe the dated failures and bounded follow-up instead. |
| Consultants adopted the product in real client work | Not established in this package | Keep independent use and actual downstream use as unobserved. |
| The application is production ready | Not established | Describe the local prototype and remaining operational gates. |

The existing product-owner self-test is assisted self-validation. It does not become independent consultant validation because it includes Apply or a locally generated Deck.

## Complete one technical review

Choose the [Story response failure](failure-analysis.md). Before reading the explanation, Shaun predicts where a completed response can fail and which saved state must remain unchanged. Record that prediction rather than replacing it with an agent-written answer.

Use this record for the actual session:

| Field | Current state |
|---|---|
| Shaun's initial prediction | Not observed |
| Evidence inspected personally | Not observed |
| Explanation in 90 seconds | Not observed |
| Explanation in five minutes | Not observed |
| Alternative design and its tradeoff | Not observed |
| Related change on an isolated practice branch | Not performed |
| Predicted and observed behavior of that change | Not observed |
| Remaining unknown | Personal engineering depth has not yet been assessed |

The agent can prepare questions, locate code, and record observations. It cannot complete this table on Shaun's behalf. If the session reaches reading comprehension only, record that result.

## Questions the explanation must answer

- Why can HTTP 200 and completed JSON still produce a failed proposal?
- Why express the body constraint in both the response schema and domain validation?
- What would truncating the response risk?
- How are Story-local references different from Understanding references?
- What changes when the user previews, keeps, or explicitly applies a candidate?
- Why does a preserved quotation not prove the generated claim follows from it?
- Which existing check would detect the proposed practice change, and what would remain untested?

## Draft resume wording

Conservative wording before the personal review:

> Directed an AI-assisted positioning prototype that separates generated recommendations from explicit user adoption. Defined product boundaries for source attribution, unknowns, and retained drafts, and assembled a versioned review of model failures and verification limits.

Use "defined" only for decisions Shaun confirms he made. Replace the wording if personal review cannot substantiate it. Add an implementation claim only after identifying the work and demonstrating the relevant understanding. No customer or performance metric is inferred from a synthetic run.

PIT-88 remains incomplete until the required personal observations exist. Preparing this document does not close it.
