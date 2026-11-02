# Full-task semantic acceptance contract — v1

Owner: PIT-50 under PIT-49. Sections 1–7 record the schemas, R1 input/oracle and freeze contract. Subsequent delivery adds the `eval:task` CLI; section 8 describes PIT-55's provider budget and its separate engineering verification. Neither a valid contract nor a budget audit is a model-quality result.

## 1. Authority and entry points

Product: v6 PRD MAT/CLR/POS/DCK and X-01. Design: judgment, explicit adoption and allowed uncertainty. Current product schemas remain authoritative for Understanding, Positioning, Story and Deck V2. `src/task-acceptance/schema.ts` imports those schemas; it does not fork their shapes or change the product.

R1: `config/task-acceptance/pitchroom-r1/{case.json,materials.json,task.md,oracle.json}`. JSON is the structured source; task.md explains it to the material owner. Any future CSV/Markdown report is derived. No unique optimal story is prescribed.

The source fixture was absent from canonical main. materials.json imports only the explicitly requested existing five-source requirements fixture, byte for byte from the original local workspace; no historical participant record or raw QA is imported. Record its original path and current hash rather than pretending it existed in main.

## 2. Draft, freeze and permission boundaries

`parseTaskBundle` validates the case/oracle, complete source receipts, exact material package bytes, per-source content hashes, quoted locations and matching versions. All JSON boundary objects are strict where owned here. Source-package parsing reuses the existing fixture contract. Dates without evidence stay unknown.

Draft allows a null audience, decision goal or use context. It cannot be used for generation; missing fields are not filled silently. R1 contains concrete values inferred from material quotes/rationale. Shaun explicitly accepted the three questions on 2026-10-27 (PIT-50 comment 01a17ad5-5704-782c-b163-5d92677d1665); case 1.0.0 is frozen with that evidence. Drafts carry openDecisions; frozen records retain confirmation and binding. task.md preserves the reviewed questions.

`freezeTaskBundle` requires a material/product owner confirmation (actor, timestamp, source evidence pointer) bound to spec, material bytes, oracle and rubric hashes. It returns a new frozen value without modifying its input. A frozen value must have all task context. Revised inputs/oracle/rules require a new version and new confirmation; keep the original case/review. Frozen objects are revalidated at generation gates, so mutating a parsed object cannot preserve old approval.

A recorded actor/evidence reference is an auditable claim, not cryptographic proof that a human consented. The workflow must receive the actual human instruction; it must never fabricate confirmation records or treat elapsed time as consent. PIT-53 supplies that decision boundary.

Local inspection permission is recorded per source. It does not imply external transfer. `requireTaskGenerationInput` requires a frozen case plus a separate live transfer approval bound to exactly the case, source IDs and provider/model. This is an input-release gate, NOT sufficient permission to dispatch: PIT-55 must additionally enforce actual provider-call/time/cost limits. No provider request or credential read exists in this module.

## 3. Oracle isolation

`previewTaskModelInput` constructs an allowlisted payload: task audience, decision goal, use context, original framing, output language; and each source's id/authority/url/material/boundary. It rejects missing task context. The preview is local and may be built for a draft; do not send it.

The model never gets oracle items, reviewer answers, scoring dimensions, approval records, open decisions, hashes or status as answer guidance. Source.boundary is legitimate user material; it is not a private answer key. PIT-52/55 must check actual provider payloads, not merely trust the helper. Importing a whole bundle into a prompt is prohibited.

## 4. Evidence and versions

PIT-51 stores append-only attempts/checkpoints and original bytes. Every future review must bind: case spec/material/oracle/rubric, checkpoint, exact output, source-code fingerprint, prompt fingerprint and model configuration hash. `reviewBindingSchema` and `requireMatchingReviewBinding` reject changed bindings. Model, prompt, case, rubric or code changes cannot inherit a score. Reanalysis of the same output must be identified as reanalysis, never a new successful generation.

Execution, integrity, engineering, semantic and user-task outcomes use independent discriminated unions. `outcome_unknown` is an execution state with command/attempt identity, not a retry instruction. Invalid evidence cannot support a passing assessment. A schema-valid PASS receipt is only a shape, not proof the checks happened: PIT-54 computes decisions from complete receipts.

Product checkpoint payloads import product schemas. Materials, Clarify and actual-use payloads/envelopes remain PIT-51/53 design work, not placeholder unknown objects accepted as verified output.

## 5. Semantic review contract

Review all key claims in every required content stage: generated sentence → attributed source → original text → direct support / bounded inference / insufficient support / contradiction. Preserve conditions, time, attribution and certainty. Confirm full field coverage; use a separate oracle coverage table for omitted limitations. Missing/partial review is pending, not pass.

Hard failures: fabricated/distorted key fact; certainty/attribution upgrade; material unknown/conflict hidden; real citation backing an unsupported key claim; critical limitation omitted; silent adoption or adopted Story/Deck mismatch. One confirmed critical failure causes failure, irrespective of averages. An ordinary stylistic weakness uses rubric scores; do not call every weak phrase a critical fact error. Unresolved key factual disputes remain disputed with both reasons and material-owner decision. Keep reviewer identity/role, assistance, calibration controls and exact output binding.

Positioning reuses Core Message v2: recognition, specificity, memorability, truthfulness, choice_usefulness; 0–4, every dimension ≥2, average ≥3, explain direction differences, recommendation, comparison and reversal conditions. Historical live four-dimensional reviews retain their old purpose; do not relabel them.

Story/Deck dimensions accepted for this case: faithfulness_and_boundaries, required_coverage, judgment_and_narrative, feedback_response, discussion_readiness. 0 unusable/key error; 1 redo; 2 substantive changes; 3 usable with minor changes; 4 directly usable within task scope. Every dimension ≥3 AND no hard failures. Shaun accepted this threshold for R1; it is not retrospective acceptance of historical outputs. Initial output and revision are reviewed separately; feedback_response for the full task evaluates the actual revision pair, never invented initial feedback.

Semantic decision precedence: confirmed hard failure → fail; unresolved key dispute → disputed; missing required output → incomplete; missing review/coverage/score → awaiting_review; unmet thresholds → fail; all complete and satisfied → pass. Tool/integrity failures are recorded separately from model semantic failures. No single overall PASS.

## 6. User observation and scope

R1 is assisted self-validation. Separate operator Shaun, intended prospective-consultant audience, and that consultant's future client. No target consultant, scheduled meeting, pilot agreement, downstream use or customer research is invented. HTTP execution does not establish independent UI use. A valid local Apply alone is not real downstream use.

Keep userTask awaiting_observation until actual evidence exists. A pass is explicitly scoped to assisted_self_test or observed_external; it never becomes a cohort product pass. Original product gate remains 3–5 participants, ≥3 observed, ≥2 independent Apply, zero preview/Apply confusion, ≥1 actual downstream use. R1/R2 two cases cannot establish it. Record assistance, edits, abandonment, active review time and waiting separately.

## 7. Delivery and acceptance for PIT-50

Required: parse the committed R1 draft, verify five source receipts and all oracle quotes; reject mismatched bytes/versions, missing frozen task context, duplicate IDs, stale approvals and score bindings; prove allowlisted model preview excludes private oracle/confirmation; preserve source boundary/original words. Unit tests are offline and make no provider requests. Package typecheck and existing eval tests are appropriate; app build/database/browser are unaffected and not claims of this task.

Case freeze and engineering completion are separate. R1 1.0.0 is owner-confirmed and frozen. PIT-50 engineering completion still follows current project integration policy (review, QA, approved merge and integration checks); no task is marked done solely because local tests passed. A future draft must not be falsely frozen to close an issue. No installation, private data access, model call, recording or deployment is implied. Preserve original dirty workspace and evidence; scoped work starts from fixed integrated main in its own worktree. Future tasks must consume the accepted artifact, not merely an issue status or stage number.

## 8. Isolated provider budget — PIT-55

`initializeProviderBudget` creates one private, append-only ledger for an acceptance ID. Its policy pins project, case/code hashes, provider/model/observed version, endpoint, approval and price evidence, the documented model input ceiling, and request/token/cost/time/byte limits. Each actual provider request reserves its worst permitted consumption before transport. Internal tool rounds and failed requests count separately. Missing usage or an unknown result retains the full reservation and blocks further calls. A monotonic clock measures model activity; human review and paused time do not consume active time.

The separate high-water anchor detects journal truncation and partial rollback. It does not defend against an administrator restoring or rewriting every local record. Keep both ledger and anchor. `ready` means no unresolved request; the next atomic reservation still checks remaining allowances. Never clear a pending/unknown record to make a run continue.

Both Web and Clarify worker consume an explicit private `PITCHROOM_EVAL_BUDGET_FILE`. Its reference contains the ledger directory/policy hash, session and instance IDs, case/code hashes, and `targetFingerprint`. The target must be a numeric-loopback PostgreSQL database named `pit55_<32 hex characters>`. Derive its fingerprint with `evaluationProviderTargetFingerprint`; pin the parsed reference with `evaluationProviderReferenceHash` in `PITCHROOM_EVAL_REFERENCE_HASH`. All evaluation identity fields must agree. Partial configuration, another target, or a replaced reference fails closed. These are operator-owned launch bindings, not authentication, build attestation, or independent proof of user consent.

Health exposes this configuration as `evaluationBudgetInstance`. Requests must carry the matching `x-pitchroom-eval-instance`, `x-pitchroom-eval-source`, `x-pitchroom-eval-target`, and `x-pitchroom-eval-budget` headers. The existing formal task client continues to accept only fixture/postgres-fake `evaluationInstance` identities. A budgeted runtime does not grant formal live workflow admission or a semantic pass.

The worker validates the same target before connecting and checks for unresolved provider calls before claiming work. An already admitted polling worker waits while a Web request holds a pending reservation; it does not resend a provider request. Startup with unresolved consumption or any unknown outcome still fails closed. Each reservation records the active attempt's command, task and attempt IDs, including an explicit retry. A new session requires a new pinned reference and runtime launch but uses the same acceptance directory and policy hash. Audit the original budget before continuing; changing session IDs does not refund consumption.

Read the cumulative balance and every actual request without dispatching anything:

```sh
# From pitchroom-app/packages/evals, with the existing supported Node runtime.
node --import tsx src/task-acceptance/cli.ts provider-budget-audit \
  --budget-directory /absolute/private/acceptance-directory \
  --policy-hash <sha256>
```

The result is `provider_budget_integrity_only`; `liveAdmission` remains `not_granted`. Actual model execution additionally needs the existing exact material-transfer approval, current official provider pricing/context evidence, a human-approved execution budget, and the formal workflow's separate admission path. This implementation supplies no production/global rate limiter.

`scripts/qa-provider-budget.ts` verifies the actual Web routes, PostgreSQL persistence and separate live-runner worker using a test-only preloaded synthetic transport. It requires an existing Docker image and Chrome; it installs neither. It creates only a new owned database, rejects unexpected transport destinations, proves durable reservation precedes each fake provider response, and records bounded metadata without browser recordings. Run only after reserving its evidence allowance:

```sh
# From pitchroom-app; PIT55_EVIDENCE_DIRECTORY must be a new absolute directory.
PIT55_EVIDENCE_DIRECTORY=/absolute/private/new-run \
  node --import tsx scripts/qa-provider-budget.ts
```

The scenario covers the actual Understanding tool loop, malformed Clarify output, browser/runtime restart with unchanged cumulative balance, explicit retry attribution, and missing-usage holds across worker restart. Synthetic prices, usage, keys and response bodies are engineering fixtures. The run does not establish real-provider compatibility, model quality, user acceptance, or oracle isolation for a real material package. Existing isolated primitive tests separately cover process competition, deadlines, byte/token/cost limits and killed-process reservations.
